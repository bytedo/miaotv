const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createComponentLoader } = require('./component-test-loader.cjs');

process.env.NODE_ENV = 'test';
process.env.PASSWORD = 'warning-fixture-signing-secret';
process.env.USERNAME = 'warning-fixture-owner';
process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
process.env.NEXT_PUBLIC_SITE_NAME = 'Warning fixture';
delete process.env.MIAOTV_ALLOW_WEAK_DEV_PASSWORD;

const { WARNING_PAGE_HEADER } = createSourceLoader()('request-context.ts');

class TestRequest extends Request {
  constructor(pathname, headers = {}) {
    super(new URL(pathname, 'https://warning.example.test'), { headers });
    this.nextUrl = new URL(this.url);
  }
}

class TestResponse extends Response {
  constructor(body, init) {
    super(body, init);
    this.cookies = { set() {} };
  }
  static next(init = {}) {
    const response = new TestResponse();
    response.forwarded = init.request?.headers;
    return response;
  }
  static rewrite(url, init) {
    const response = this.next(init);
    response.rewritten = String(url);
    return response;
  }
  static redirect(url) {
    return new TestResponse(null, {
      status: 307,
      headers: { location: String(url) },
    });
  }
  static json(body, init) {
    return new TestResponse(JSON.stringify(body), init);
  }
}

function fixture(t) {
  const fetch = t.mock.method(global, 'fetch', async () => {
    throw new Error('Warning page tests must not access a database or network');
  });
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
  const collision = Object.assign(new Error('该用户名已被注册'), {
    name: 'UserIdentityError',
    code: 'USERNAME_EXISTS',
  });
  const state = {
    imports: { config: 0, db: 0, auth: 0 },
    configReads: 0,
    identityReads: 0,
    providerRenders: 0,
    failImports: false,
    configError: null,
    identity: null,
    trusted: false,
    requestHeaders: new Headers(),
  };
  const config = {
    SiteConfig: { SiteName: 'Configured fixture' },
    UserConfig: {
      Users: [{ uid: 'member-uid', username: 'member', role: 'user' }],
    },
    CustomCategories: [],
  };
  const guardedProvider = ({ children }) => {
    state.providerRenders++;
    return React.createElement('div', null, children);
  };
  const overrides = {
    'next/server': { NextRequest: TestRequest, NextResponse: TestResponse },
    'next/headers': {
      cookies: async () => ({}),
      headers: async () => state.requestHeaders,
    },
    'next/dynamic': () => guardedProvider,
    'next/font/local': () => ({ className: 'test-font' }),
    './globals.css': {},
    sonner: { Toaster: guardedProvider },
    '@/lib/auth': { getAuthInfoFromCookie: () => null },
    '@/lib/trusted-network': {
      isRequestFromTrustedNetwork: () => state.trusted,
    },
    '../components/NavigationShell': guardedProvider,
    '../components/QueryProvider': guardedProvider,
  };
  const modules = {
    config: {
      getConfig: async () => {
        state.configReads++;
        if (state.configError) throw state.configError;
        return config;
      },
    },
    db: {
      db: {
        getUserInfoV2: async () => {
          state.identityReads++;
          return { role: 'user' };
        },
        checkUserExist: async () => true,
      },
    },
    auth: {
      getVerifiedAuthInfo: async () => state.identity,
      createSignedAuthCookie: () => 'fixture-signed-cookie',
    },
  };
  for (const [key, modulePath] of [
    ['config', '@/lib/config'],
    ['db', '@/lib/db'],
    ['auth', '@/lib/auth.server'],
  ]) {
    Object.defineProperty(overrides, modulePath, {
      enumerable: true,
      get() {
        state.imports[key]++;
        if (state.failImports)
          throw new Error('Database-dependent module initialization failed');
        return modules[key];
      },
    });
  }
  for (const name of [
    'ChunkErrorGuard',
    'PageLoading',
    'DOMErrorBoundary',
    'GlobalDOMErrorHandler',
    'GlobalErrorIndicator',
    'SiteProvider',
    'ThemeProvider',
  ]) {
    overrides[`../components/${name}`] = { [name]: guardedProvider };
  }
  overrides['../contexts/DownloadContext'] = {
    DownloadProvider: guardedProvider,
  };
  overrides['../contexts/GlobalCacheContext'] = {
    GlobalCacheProvider: guardedProvider,
  };
  const proxy = createSourceLoader(overrides)('../proxy.ts').proxy;
  const layout = createComponentLoader(overrides)('app/layout.tsx');
  const WarningPage = createComponentLoader()('app/warning/page.tsx').default;
  return {
    state,
    collision,
    proxy,
    layout,
    WarningPage,
    async warning(pathname = '/warning?reason=weak-password') {
      const response = await proxy(new TestRequest(pathname));
      state.requestHeaders = response.forwarded;
      const reason =
        new URL(pathname, 'https://warning.example.test').searchParams.get(
          'reason',
        ) || undefined;
      const page = await WarningPage({
        searchParams: Promise.resolve({ reason }),
      });
      return { response, root: await layout.default({ children: page }) };
    },
  };
}

test('the actual warning page and root metadata do not read configuration or initialize storage', async (t) => {
  const f = fixture(t);
  f.state.configError = f.collision;
  const { response, root } = await f.warning();
  const metadata = await f.layout.generateMetadata();
  assert.equal(response.status, 200);
  assert.equal(response.forwarded.get(WARNING_PAGE_HEADER), '1');
  assert.equal(
    response.headers.has(WARNING_PAGE_HEADER),
    false,
    'the marker is request-side only',
  );
  assert.match(renderToStaticMarkup(root), /常见弱密码/);
  assert.equal(root.type, 'html');
  assert.equal(React.Children.only(root.props.children).type, 'body');
  assert.equal(metadata.title, 'Warning fixture');
  assert.equal(f.state.configReads, 0);
  assert.equal(f.state.identityReads, 0);
  assert.equal(
    f.state.providerRenders,
    0,
    'the safety page does not mount trackers or providers',
  );
  assert.deepEqual(f.state.imports, { config: 0, db: 0, auth: 0 });
});

test('the warning remains renderable even when importing a database-dependent module would fail', async (t) => {
  const f = fixture(t);
  f.state.failImports = true;
  const { root } = await f.warning();
  await f.layout.generateMetadata();
  assert.match(renderToStaticMarkup(root), /安全合规配置警告/);
  assert.deepEqual(f.state.imports, { config: 0, db: 0, auth: 0 });
  assert.equal(f.state.configReads, 0);
});

test('missing and weak passwords redirect to a renderable warning without touching storage', async (t) => {
  const f = fixture(t);
  f.state.failImports = true;
  t.after(() => {
    process.env.PASSWORD = 'warning-fixture-signing-secret';
  });
  for (const password of ['', 'admin']) {
    process.env.PASSWORD = password;
    const redirect = await f.proxy(
      new TestRequest('/play', { [WARNING_PAGE_HEADER]: '1' }),
    );
    const target = new URL(redirect.headers.get('location'));
    assert.equal(redirect.status, 307);
    assert.equal(target.pathname, '/warning');
    assert.equal(
      target.searchParams.get('reason'),
      password ? 'weak-password' : null,
    );
    const { root } = await f.warning(target.pathname + target.search);
    await f.layout.generateMetadata();
    assert.match(
      renderToStaticMarkup(root),
      password ? /常见弱密码/ : /未配置访问控制/,
    );
  }
  assert.deepEqual(f.state.imports, { config: 0, db: 0, auth: 0 });
});

test('public and auth-page forwarding overwrites forged warning markers', async (t) => {
  const f = fixture(t);
  for (const pathname of [
    '/download',
    '/register',
    '/login',
    '/warning/not-a-route',
    '/adult/download',
  ]) {
    const response = await f.proxy(
      new TestRequest(pathname, {
        [WARNING_PAGE_HEADER]: '1',
        'x-fixture': 'preserved',
      }),
    );
    assert.equal(response.status, 200, pathname);
    assert.equal(response.forwarded.has(WARNING_PAGE_HEADER), false, pathname);
    assert.equal(response.forwarded.get('x-fixture'), 'preserved');
    f.state.requestHeaders = response.forwarded;
    f.state.configError = f.collision;
    await assert.rejects(
      f.layout.default({ children: null }),
      (error) => error === f.collision,
    );
    await assert.rejects(
      f.layout.generateMetadata(),
      (error) => error === f.collision,
    );
    f.state.configError = null;
  }
  const genuine = await f.proxy(
    new TestRequest('/warning', { [WARNING_PAGE_HEADER]: 'forged' }),
  );
  assert.equal(genuine.forwarded.get(WARNING_PAGE_HEADER), '1');
  const rewritten = await f.proxy(new TestRequest('/adult/warning'));
  assert.equal(new URL(rewritten.rewritten).pathname, '/warning');
  assert.equal(rewritten.forwarded.get(WARNING_PAGE_HEADER), '1');
});

test('weak-password auth-page forwarding also strips the client marker', async (t) => {
  const f = fixture(t);
  process.env.PASSWORD = 'admin';
  t.after(() => {
    process.env.PASSWORD = 'warning-fixture-signing-secret';
  });
  for (const pathname of ['/login', '/register']) {
    const response = await f.proxy(
      new TestRequest(pathname, { [WARNING_PAGE_HEADER]: '1' }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.forwarded.has(WARNING_PAGE_HEADER), false);
  }
  assert.equal(f.state.configReads, 0);
});

test('authenticated and trusted-network forwarding cannot preserve a forged warning marker', async (t) => {
  const f = fixture(t);
  f.state.identity = { uid: 'member-uid', username: 'member' };
  let response = await f.proxy(
    new TestRequest('/play', { [WARNING_PAGE_HEADER]: '1' }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.forwarded.has(WARNING_PAGE_HEADER), false);
  assert.equal(f.state.configReads, 1);
  assert.equal(f.state.identityReads, 1);
  f.state.requestHeaders = response.forwarded;
  const root = await f.layout.default({
    children: React.createElement('p', null, 'Ordinary page'),
  });
  const metadata = await f.layout.generateMetadata();
  assert.match(renderToStaticMarkup(root), /window.RUNTIME_CONFIG/);
  assert.equal(metadata.title, 'Configured fixture');
  assert.equal(f.state.configReads, 3);
  f.state.identity = null;
  f.state.trusted = true;
  response = await f.proxy(
    new TestRequest('/play', { [WARNING_PAGE_HEADER]: '1' }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.forwarded.has(WARNING_PAGE_HEADER), false);
});

test('forged warning markers do not bypass authentication, roles or identity conflicts', async (t) => {
  const f = fixture(t);
  const forged = { [WARNING_PAGE_HEADER]: '1' };
  assert.equal(
    (await f.proxy(new TestRequest('/api/admin/site', forged))).status,
    401,
  );
  const redirect = await f.proxy(new TestRequest('/play', forged));
  assert.equal(new URL(redirect.headers.get('location')).pathname, '/login');
  f.state.identity = { uid: 'member-uid', username: 'member' };
  assert.equal(
    (await f.proxy(new TestRequest('/api/admin/site', forged))).status,
    403,
  );
  f.state.configError = f.collision;
  assert.equal((await f.proxy(new TestRequest('/play', forged))).status, 503);
  assert.equal(
    (await f.proxy(new TestRequest('/api/admin/site', forged))).status,
    503,
  );
  f.state.requestHeaders = new Headers();
  await assert.rejects(
    f.layout.default({ children: null }),
    (error) => error.code === 'USERNAME_EXISTS',
  );
  await assert.rejects(
    f.layout.generateMetadata(),
    (error) => error.code === 'USERNAME_EXISTS',
  );
});
