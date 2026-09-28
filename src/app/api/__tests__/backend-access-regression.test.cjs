const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createSourceLoader } = require('../../../lib/__tests__/storage-test-loader.cjs');
const { createIdentityFixture } = require('../../../lib/__tests__/user-identity-fixture.cjs');

const GLOBAL_TOKEN = 'fixture-global-tvbox-token';
const USER_TOKEN = 'fixture-alice-tvbox-token';

class TestRequest extends Request {
  constructor(input, init) {
    super(input, init);
    this.nextUrl = new URL(this.url);
    this.cookies = { get: (name) => {
      const value = (this.headers.get('cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(name + '='));
      return value ? { value: value.slice(name.length + 1) } : undefined;
    } };
  }
}

function request(route, params = {}, { username, headers = {}, ip } = {}) {
  const url = new URL(`https://miaotv.test/api/${route}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const result = new TestRequest(url, { headers: {
    ...(username ? { cookie: 'user_auth=' + encodeURIComponent(JSON.stringify({ username, role: 'owner' })) } : {}),
    ...headers,
  } });
  if (ip) result.ip = ip;
  return result;
}

function fixture(t) {
  const oldOwner = process.env.USERNAME;
  const oldTrustedProxy = process.env.TRUST_PROXY_HEADERS;
  const oldTrustedNetworks = process.env.TRUSTED_NETWORK_IPS;
  process.env.USERNAME = 'fixture-owner';
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.TRUSTED_NETWORK_IPS;
  t.after(() => {
    if (oldOwner === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = oldOwner;
    if (oldTrustedProxy === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = oldTrustedProxy;
    if (oldTrustedNetworks === undefined) delete process.env.TRUSTED_NETWORK_IPS;
    else process.env.TRUSTED_NETWORK_IPS = oldTrustedNetworks;
  });
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
  const config = {
    SiteConfig: { SiteName: 'Fixture' },
    UserConfig: { Users: [
      { username: 'alice', role: 'user', tvboxToken: USER_TOKEN, tvboxEnabledSources: ['allowed'] },
      { username: 'manager', role: 'admin' },
    ] },
    SourceConfig: [
      { key: 'allowed', name: 'Allowed', api: 'https://allowed.fixture.test/api.php' },
      { key: 'restricted', name: 'Restricted', api: 'https://restricted.fixture.test/api.php' },
      { key: 'disabled', name: 'Disabled', api: 'https://disabled.fixture.test/api.php', disabled: true },
    ],
    TVBoxSecurityConfig: {
      enableAuth: true, token: GLOBAL_TOKEN,
      enableIpWhitelist: false, allowedIPs: ['192.168.5.0/24'],
      enableRateLimit: false, rateLimit: 60,
    },
    TrustedNetworkConfig: { enabled: true, trustedIPs: ['10.42.0.0/16'], blockAdminAccess: true },
  };
  const state = {
    config, identity: null, upstream: [], network: [],
    users: new Map(config.UserConfig.Users.map((user) => [user.username, { ...user }])),
    cache: new Map(),
  };
  t.mock.method(global, 'fetch', async (url, init) => {
    state.network.push({ url: String(url), init });
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '100' } });
    return Response.json({ class: [], list: [] });
  });
  const cfg = { getConfig: async () => config, getCacheTime: async () => 10, getAvailableApiSites: async () => config.SourceConfig.filter((site) => !site.disabled) };
  const identities = createIdentityFixture(() => [...state.users.values()]);
  const db = {
    ...identities,
    getUserInfoV2: async (reference) => identities.findUser(reference) || null,
    checkUserExist: async (reference) => !!identities.findUser(reference),
    getCache: async (key) => state.cache.get(key),
    setCache: async (key, value) => state.cache.set(key, value),
  };
  const auth = { getVerifiedAuthInfo: async () => state.identity ? identities.getUserIdentity(state.identity) : null };
  const load = createSourceLoader({
    'next/server': { NextRequest: TestRequest, NextResponse: Response },
    '@/lib/config': cfg, './config': cfg,
    '@/lib/db': { db }, './db': { db },
    '@/lib/auth.server': auth, './auth.server': auth,
    './emby-source': { getEmbyTargetPolicy: () => ({}) },
    '@/lib/blobStorage': { getSpiderJarFromBlob: async () => null, uploadSpiderJarToBlob: async () => null },
    '@/lib/spiderJar': {
      getCandidates: () => [],
      getSpiderJar: async () => ({ buffer: Buffer.from('fixture'), md5: 'fixture-md5', size: 7, success: true, cached: true, source: 'https://jar.fixture.test/fixture.jar' }),
    },
    '@/lib/networkDetection': { getUserRegion: () => 'domestic' },
    '@/lib/downstream': {
      searchFromApi: async (source, query) => { state.upstream.push({ source, query }); return [{ id: '1', title: 'Fixture', episodes: ['https://media.fixture.test/1.m3u8'] }]; },
      getDetailFromApi: async (source, id) => { state.upstream.push({ source, id }); return { id, title: 'Fixture', episodes: ['https://media.fixture.test/1.m3u8'] }; },
    },
    '@/lib/search-ranking': { rankSearchResults: (items) => items },
    '@/lib/video-quality': { buildResolutionFilterFromSearchParams: () => ({ minLevel: 0 }), filterSearchResultsByResolution: (items) => items },
  });
  return { state, load, route: (name) => load(path.resolve(__dirname, '..', name, 'route.ts')) };
}

test('public server config cannot expose network policy through a forged internal header', async (t) => {
  const f = fixture(t);
  const response = await f.route('server-config').GET(request('server-config', { key: 'TrustedNetworkConfig' }, { headers: { 'x-internal-request': 'true' } }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.SiteName, 'Fixture');
  assert.equal(Object.hasOwn(body, 'TrustedNetworkConfig'), false);
  assert.ok(!JSON.stringify(body).includes('10.42.'));
});

test('ordinary users receive only their own TVBox token and source choices', async (t) => {
  const f = fixture(t);
  f.state.identity = 'alice';
  const response = await f.route('tvbox-config').GET(request('tvbox-config', {}, { username: 'alice' }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.userToken, USER_TOKEN);
  assert.equal(body.securityConfig.token, '');
  assert.deepEqual(body.securityConfig.allowedIPs, []);
  assert.deepEqual(body.allSources.map((site) => site.key), ['allowed']);
  assert.ok(!JSON.stringify(body).includes(GLOBAL_TOKEN));
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
});

test('TVBox configuration still exposes administrative settings to verified administrators', async (t) => {
  const f = fixture(t);
  f.state.identity = 'manager';
  const response = await f.route('tvbox-config').GET(request('tvbox-config', {}, { username: 'manager' }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.securityConfig.token, GLOBAL_TOKEN);
  assert.equal(body.allSources.length, 2);
});

test('a forged cookie cannot retrieve TVBox configuration without a verified identity', async (t) => {
  const f = fixture(t);
  const response = await f.route('tvbox-config').GET(request('tvbox-config', {}, { username: 'fixture-owner' }));
  assert.equal(response.status, 401);
});

test('TVBox search and detail enforce the same token and per-user source limits', async (t) => {
  for (const params of [
    { source: 'allowed', wd: 'Fixture' },
    { source: 'allowed', ac: 'detail', ids: '1' },
    { source: 'restricted', wd: 'Fixture', token: USER_TOKEN },
    { source: 'restricted', ac: 'detail', ids: '1', token: USER_TOKEN },
  ]) {
    await t.test(JSON.stringify({ source: params.source, detail: !!params.ac }), async (subtest) => {
      const f = fixture(subtest);
      const response = await f.route('tvbox/search').GET(request('tvbox/search', params));
      assert.equal(response.status, params.token ? 403 : 401);
      assert.equal(f.state.upstream.length, 0);
    });
  }
});

test('valid personal and global tokens keep authorized TVBox search working', async (t) => {
  for (const [token, source] of [[USER_TOKEN, 'allowed'], [GLOBAL_TOKEN, 'restricted']]) {
    await t.test(source, async (subtest) => {
      const f = fixture(subtest);
      const response = await f.route('tvbox/search').GET(request('tvbox/search', { token, source, wd: 'Fixture' }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).list.length, 1);
      assert.equal(f.state.upstream.length, 1);
      assert.match(response.headers.get('cache-control'), /private.*no-store/);
    });
  }
});

test('banned, pending and deleted users cannot keep using previously issued TVBox tokens', async (t) => {
  for (const flag of ['banned', 'pending', 'deleted']) {
    for (const route of ['tvbox', 'tvbox/search']) {
      await t.test(`${route} ${flag}`, async (subtest) => {
        const f = fixture(subtest);
        if (flag === 'deleted') f.state.users.delete('alice');
        else f.state.config.UserConfig.Users[0][flag] = true;
        const response = await f.route(route).GET(request(route, { token: USER_TOKEN, source: 'allowed', wd: 'Fixture', mode: 'min' }));
        assert.equal(response.status, 403);
        assert.equal(f.state.upstream.length, 0);
        assert.equal(f.state.network.length, 0);
      });
    }
  }
});

test('authorized subscriptions and details preserve source restrictions and support an environment owner without a stored account', async (t) => {
  const f = fixture(t);
  const subscription = await f.route('tvbox').GET(request('tvbox', { token: USER_TOKEN, mode: 'min' }));
  assert.equal(subscription.status, 200);
  assert.deepEqual((await subscription.json()).sites.map((site) => site.key), ['allowed']);

  const detail = await f.route('tvbox/search').GET(request('tvbox/search', { token: USER_TOKEN, source: 'allowed', ac: 'detail', ids: '1' }));
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).list[0].vod_play_url, '第1集$https://media.fixture.test/1.m3u8');
  assert.match(detail.headers.get('cache-control'), /private.*no-store/);

  f.state.config.UserConfig.Users.push({ username: 'fixture-owner', role: 'owner', tvboxToken: 'fixture-owner-token' });
  const owner = await f.route('tvbox').GET(request('tvbox', { token: 'fixture-owner-token', mode: 'min' }));
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).sites.length, 2);
  f.state.identity = 'fixture-owner';
  const ownConfig = await f.route('tvbox-config').GET(request('tvbox-config', {}, { username: 'fixture-owner' }));
  assert.equal(ownConfig.status, 200);
  assert.equal((await ownConfig.json()).securityConfig.token, GLOBAL_TOKEN);
});

test('stored account restrictions apply to personal TVBox tokens until explicitly cleared in configuration', async (t) => {
  const f = fixture(t);
  const endpoint = f.route('tvbox/search');
  const params = { token: USER_TOKEN, source: 'allowed', wd: 'Fixture' };
  for (const flag of ['pending', 'banned']) {
    f.state.users.get('alice')[flag] = true;
    assert.equal((await endpoint.GET(request('tvbox/search', params))).status, 403);
    f.state.config.UserConfig.Users[0][flag] = false;
    assert.equal((await endpoint.GET(request('tvbox/search', params))).status, 200);
  }
});

test('TVBox IP rules reject spoofed ingress headers while allowing explicitly trusted ingress', async (t) => {
  const f = fixture(t);
  f.state.config.TVBoxSecurityConfig.enableIpWhitelist = true;
  const params = { token: GLOBAL_TOKEN, source: 'allowed', wd: 'Fixture', mode: 'min' };
  for (const name of ['tvbox', 'tvbox/search']) {
    const denied = await f.route(name).GET(request(name, params, { headers: { 'x-forwarded-for': '192.168.5.8' } }));
    assert.equal(denied.status, 403);
  }
  assert.equal(f.state.network.length, 0);
  assert.equal(f.state.upstream.length, 0);
  process.env.TRUST_PROXY_HEADERS = 'true';
  const allowed = await f.route('tvbox/search').GET(request('tvbox/search', params, { headers: { 'x-forwarded-for': '192.168.5.8' } }));
  assert.equal(allowed.status, 200);
});

test('TVBox search honors rate limiting before requesting upstream data', async (t) => {
  const f = fixture(t);
  Object.assign(f.state.config.TVBoxSecurityConfig, { enableRateLimit: true, rateLimit: 1 });
  const endpoint = f.route('tvbox/search');
  const params = { token: USER_TOKEN, source: 'allowed', wd: 'Fixture' };
  assert.equal((await endpoint.GET(request('tvbox/search', params, { ip: '192.0.2.8' }))).status, 200);
  assert.equal((await endpoint.GET(request('tvbox/search', params, { ip: '192.0.2.8' }))).status, 429);
  assert.equal(f.state.upstream.length, 1);
});

test('TVBox IP rules use the peer address first, support IPv6 and ignore the browsing trust override', async (t) => {
  const f = fixture(t);
  Object.assign(f.state.config.TVBoxSecurityConfig, { enableIpWhitelist: true, allowedIPs: ['192.168.5.0/24', '2001:db8:1::/48'] });
  process.env.TRUST_PROXY_HEADERS = 'true';
  process.env.TRUSTED_NETWORK_IPS = '*';
  const endpoint = f.route('tvbox/search');
  const params = { token: GLOBAL_TOKEN, source: 'allowed', wd: 'Fixture' };
  assert.equal((await endpoint.GET(request('tvbox/search', params, { ip: '192.0.2.10', headers: { 'x-forwarded-for': '192.168.5.8' } }))).status, 403);
  assert.equal((await endpoint.GET(request('tvbox/search', params, { ip: '::ffff:192.168.5.8' }))).status, 200);
  assert.equal((await endpoint.GET(request('tvbox/search', params, { ip: '2001:db8:1::8' }))).status, 200);
  assert.equal((await endpoint.GET(request('tvbox/search', params, { ip: '2001:db8:2::8' }))).status, 403);
});

test('TVBox strict search treats query punctuation as literal text', async (t) => {
  const f = fixture(t);
  const endpoint = f.route('tvbox/search');
  for (const wd of ['[', '.*']) {
    const response = await endpoint.GET(request('tvbox/search', { token: USER_TOKEN, source: 'allowed', wd, strict: '1' }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).list, []);
  }
});

test('public mode and explicit account approval remain compatible', async (t) => {
  const f = fixture(t);
  f.state.config.TVBoxSecurityConfig.enableAuth = false;
  assert.equal((await f.route('tvbox/search').GET(request('tvbox/search', { source: 'allowed', wd: 'Fixture' }))).status, 200);
  f.state.config.TVBoxSecurityConfig.enableAuth = true;
  f.state.config.UserConfig.Users[0].pending = false;
  f.state.users.get('alice').pending = true;
  assert.equal((await f.route('tvbox/search').GET(request('tvbox/search', { token: USER_TOKEN, source: 'allowed', wd: 'Fixture' }))).status, 200);
});

test('TVBox JAR diagnostics require an administrator before issuing network probes', async (t) => {
  const f = fixture(t);
  const endpoint = f.route('tvbox/jar-fix');
  assert.equal((await endpoint.GET(request('tvbox/jar-fix'))).status, 401);
  f.state.identity = 'alice';
  assert.equal((await endpoint.GET(request('tvbox/jar-fix', {}, { username: 'alice' }))).status, 403);
  assert.equal(f.state.network.length, 0);
  f.state.identity = 'manager';
  assert.equal((await endpoint.GET(request('tvbox/jar-fix', {}, { username: 'manager' }))).status, 200);
  assert.equal(f.state.network.length, 6);
});
