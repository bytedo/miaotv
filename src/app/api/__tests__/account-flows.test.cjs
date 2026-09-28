const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');

// Run without Next configuration, .env, databases, or network access.
process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
process.env.PASSWORD = 'account-test-signing-key';
process.env.USERNAME = 'fixture-owner';
process.env.SITE_BASE = 'https://miaotv.test';
global.fetch = async () => {
  throw new Error('Unexpected network request in account test');
};

class TestResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    const values = new Map();
    this.cookies = {
      set(name, value, options) {
        values.set(name, { name, value, ...options });
      },
      get(name) {
        return values.get(name);
      },
      delete(name) {
        values.delete(name);
      },
      getAll() {
        return [...values.values()];
      },
    };
  }
  static json(data, init) {
    const response = new TestResponse(JSON.stringify(data), init);
    response.data = data;
    return response;
  }
  static redirect(url) {
    return new TestResponse(null, {
      status: 307,
      headers: { location: String(url) },
    });
  }
}

function request(body, { pathname = '/', cookies = {}, headers = {} } = {}) {
  const url = new URL(pathname, 'https://miaotv.test');
  return {
    url: url.href,
    nextUrl: url,
    headers: new Headers(headers),
    cookies: {
      get: (name) =>
        cookies[name] === undefined ? undefined : { value: cookies[name] },
    },
    json: async () => body,
  };
}

function fixture() {
  const state = {
    users: new Map(),
    cache: new Map(),
    events: [],
    created: [],
    changed: [],
    reserved: [],
    released: [],
    notifications: [],
    config: {
      SiteConfig: { SiteName: 'MiaoTV', DefaultUserTags: ['default-group'] },
      UserConfig: {
        AllowRegister: true,
        RequireApproval: false,
        RequireInviteCode: false,
        Users: [],
      },
      OIDCAuthConfig: {
        enabled: true,
        enableRegistration: true,
        issuer: 'https://id.test',
        minTrustLevel: 0,
        clientId: 'fixture-client',
        clientSecret: 'fixture-secret',
        authorizationEndpoint: 'https://id.test/authorize',
        tokenEndpoint: 'https://id.test/token',
        userInfoEndpoint: 'https://id.test/user',
      },
    },
  };
  let lastUid = 1n; // The environment owner keeps UID 1.
  function allocateUid() {
    for (const user of state.users.values()) {
      if (/^[1-9][0-9]*$/.test(user.uid) && BigInt(user.uid) > lastUid) lastUid = BigInt(user.uid);
    }
    return String(++lastUid);
  }
  function addUser(username = 'alice', fields = {}) {
    const user = {
      uid: allocateUid(),
      sessionVersion: 100,
      username,
      role: 'user',
      email: `${username}@example.com`,
      rawPassword: 'old-password',
      credential: `plain:v1:${Buffer.from('old-password').toString('base64')}`,
      ...fields,
    };
    state.users.set(username, user);
    state.config.UserConfig.Users.push({ ...user });
    return user;
  }
  function resolveUsername(ref) {
    const user = [...state.users.values()].find((entry) => entry.uid === ref || entry.legacyUids?.includes(ref));
    if (user) return user.username;
    return /^[1-9][0-9]*$/.test(ref) || /^[0-9a-f-]{36}$/i.test(ref) ? null : ref;
  }
  function getIdentity(username) {
    if (username === process.env.USERNAME) return { uid: '1', username, storageKey: username, sessionVersion: 300 };
    const user = state.users.get(username);
    return user ? { uid: user.uid, username: user.username, storageKey: user.username, sessionVersion: user.sessionVersion ?? 0, legacyUids: user.legacyUids } : null;
  }
  const db = {
    allocateUserUid: async () => allocateUid(),
    getAllUserIdentities: async () => [getIdentity(process.env.USERNAME), ...[...state.users.keys()].map(getIdentity)],
    getUserIdentity: async (name) => getIdentity(name),
    getUserIdentityByUid: async (uid) => {
      if (uid === '1') return getIdentity(process.env.USERNAME);
      const username = resolveUsername(uid);
      const identity = username && getIdentity(username);
      return identity && (identity.uid === uid || identity.legacyUids?.includes(uid)) ? identity : null;
    },
    isLegacyUsernameRetired: async () => false,
    getCache: async (key) => state.cache.get(key) ?? null,
    setCache: async (key, value) => {
      state.cache.set(key, value);
    },
    deleteCache: async (key) => {
      state.cache.delete(key);
    },
    consumeCache: async (key) => {
      const value = state.cache.get(key) ?? null;
      state.cache.delete(key);
      return value;
    },
    checkUserExist: async (username) => state.users.has(resolveUsername(username)),
    checkUserExistV2: async (username) => state.users.has(resolveUsername(username)),
    getUserInfoV2: async (username) => state.users.get(resolveUsername(username)) ?? null,
    getUserCredential: async (username) =>
      state.users.get(resolveUsername(username))?.credential ?? null,
    getUserByOidcSub: async (sub) =>
      [...state.users.values()].find((user) => user.oidcSub === sub)
        ?.username ?? null,
    getUserEmail: async (username) => state.users.get(resolveUsername(username))?.email ?? null,
    setUserEmail: async (username, email) => {
      state.users.get(resolveUsername(username)).email = email;
    },
    getUsernameByEmail: async (email) =>
      [...state.users.values()].find(
        (user) =>
          user.email?.trim().toLowerCase() === email.trim().toLowerCase(),
      )?.username ?? null,
    verifyUser: async (username, password) =>
      state.users.get(resolveUsername(username))?.rawPassword === password,
    changePassword: async (username, password, expected) => {
      const user = state.users.get(resolveUsername(username));
      if (
        state.failConditionalChange ||
        expected?.credential !== user?.credential ||
        (expected?.email && expected.email !== user?.email)
      ) {
        const error = new Error('Account changed');
        error.code = 'ACCOUNT_CHANGED';
        throw error;
      }
      state.changed.push(user.username);
      user.rawPassword = password;
      user.credential = `plain:v1:${Buffer.from(password).toString('base64')}`;
    },
    createUserV2: async (...args) => {
      state.events.push('create');
      if (state.failCreate)
        throw new Error('Concurrent username already exists');
      const [
        username,
        password,
        role,
        tags,
        oidcSub,
        enabledApis,
        email,
        metadata,
      ] = args;
      if (state.users.has(username)) throw new Error('User already exists');
      state.created.push(args);
      state.users.set(username, {
        uid: metadata?.uid || allocateUid(),
        sessionVersion: 200,
        username,
        rawPassword: password,
        credential: `new:${username}`,
        role,
        tags,
        oidcSub,
        enabledApis,
        email,
        ...metadata,
      });
    },
    registerUser: async () => {
      throw new Error('New accounts must use atomic V2 creation');
    },
    deleteUser: async (username) => {
      state.events.push('delete');
      state.users.delete(resolveUsername(username));
      state.config.UserConfig.Users = state.config.UserConfig.Users.filter(
        (user) => user.username !== username && user.uid !== username,
      );
    },
    saveAdminConfig: async (config) => {
      state.events.push('profile');
      if (state.failProfile) throw new Error('Profile write failed');
      state.config = config;
    },
    updateUserLoginStats: async () => {},
  };
  const configModule = {
    getConfig: async () => state.config,
    clearConfigCache() {},
  };
  const inviteModule = {
    useInviteCode: async (...args) => {
      state.events.push('reserve');
      if (state.failInvite) throw new Error('邀请码已达到最大使用次数');
      state.reserved.push(args);
      return true;
    },
    releaseInviteCode: async (...args) => {
      state.events.push('release');
      state.released.push(args);
      return true;
    },
  };
  const emailModule = {
    sendRegistrationPendingEmail: async (...args) => {
      state.notifications.push(['email', ...args]);
      return { success: true };
    },
    sendPasswordResetEmail: async () => ({ success: true }),
  };
  const webhookModule = {
    sendNewRegistrationWebhook: async (...args) => {
      state.notifications.push(['webhook', ...args]);
      return { success: true };
    },
  };
  const load = createSourceLoader({
    'next/server': { NextResponse: TestResponse },
    './db': { db },
    '@/lib/db': { db },
    './config': configModule,
    '@/lib/config': configModule,
    './invite-code': inviteModule,
    '@/lib/invite-code': inviteModule,
    './emailService': emailModule,
    '@/lib/emailService': emailModule,
    './webhookService': webhookModule,
    '@/lib/webhookService': webhookModule,
  });
  return {
    state,
    db,
    addUser,
    load,
    route: (name) => load(path.resolve(__dirname, '..', name, 'route.ts')),
  };
}

function signedCookie(username = 'alice') {
  const signature = createHmac('sha256', process.env.PASSWORD)
    .update(username)
    .digest('hex');
  return encodeURIComponent(
    JSON.stringify({ username, signature, timestamp: Date.now() }),
  );
}

function registrationRequest(f, endpoint, fields) {
  const body = {
    username: 'matrix_user',
    password: 'new-password',
    confirmPassword: 'new-password',
    ...fields,
  };
  if (endpoint === 'register') return request(body);
  const sessions = f.load('oidc-registration-session.ts');
  const cookie = sessions.encodeOIDCRegistrationSession({
    sub: 'matrix-subject',
    providerId: 'default',
    providerKey: sessions.getOIDCProviderKey(f.state.config.OIDCAuthConfig, 'default'),
    timestamp: Date.now(),
  });
  return request(body, { cookies: { oidc_session: cookie } });
}

for (const endpoint of ['register', 'auth/oidc/complete-register']) {
  test(`${endpoint}: all registration switch combinations enforce invitation exemption`, async (t) => {
    for (const allow of [false, true]) {
      for (const approval of [false, true]) {
        for (const requiredInvite of [false, true]) {
          for (const hasInvite of [false, true]) {
            await t.test(`allow=${allow}, approval=${approval}, requiredInvite=${requiredInvite}, hasInvite=${hasInvite}`, async () => {
              const f = fixture();
              Object.assign(f.state.config.UserConfig, {
                AllowRegister: allow,
                RequireApproval: approval,
                RequireInviteCode: requiredInvite,
              });
              const fields = hasInvite
                ? { inviteCode: ' abcd2345 ' }
                : approval ? { email: ' New@Example.COM ', source: ' friend ' } : {};
              const response = await f.route(endpoint).POST(registrationRequest(f, endpoint, fields));
              const status = !allow ? 403 : requiredInvite && !hasInvite ? 400 : 200;
              assert.equal(response.status, status);
              if (status !== 200) {
                assert.equal(f.state.created.length, 0);
                assert.equal(f.state.reserved.length, 0);
                assert.equal(response.cookies.get('user_auth'), undefined);
                assert.deepEqual(f.state.notifications, []);
                return;
              }
              const pending = approval && !hasInvite;
              assert.equal(response.data.pending, pending);
              assert.equal(Boolean(response.cookies.get('user_auth')), !pending);
              assert.equal(f.state.created[0][7].pending, pending);
              assert.equal(f.state.config.UserConfig.Users[0].pending, pending);
              assert.equal(f.state.notifications.length, pending ? 2 : 0);
              assert.equal(f.state.reserved.length, hasInvite ? 1 : 0);
              if (hasInvite) {
                assert.equal(f.state.reserved[0][0], 'ABCD2345');
                assert.equal(f.state.created[0][6], undefined, 'invited accounts do not require an email');
                assert.deepEqual(f.state.events, ['reserve', 'create', 'profile']);
              } else if (pending) {
                assert.equal(f.state.created[0][6], 'new@example.com');
                assert.equal(f.state.created[0][7].source, 'friend');
              }
            });
          }
        }
      }
    }
  });

  test(`${endpoint}: approval requires email and source, and an invalid optional invitation never bypasses it`, async () => {
    const f = fixture();
    f.state.config.UserConfig.RequireApproval = true;
    const route = f.route(endpoint);
    for (const fields of [
      {},
      { email: 'new@example.com' },
      { inviteCode: '   ' },
      { inviteCode: { code: 'ABCD2345' } },
      { email: 'new@example.com', source: ' '.repeat(20) },
      { email: 'new@example.com', source: 'x'.repeat(501) },
    ]) {
      assert.equal((await route.POST(registrationRequest(f, endpoint, fields))).status, 400);
    }
    f.state.failInvite = true;
    const rejected = await route.POST(registrationRequest(f, endpoint, { inviteCode: 'EXPIRED' }));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.cookies.get('user_auth'), undefined);
    assert.equal(f.state.created.length, 0);
    assert.deepEqual(f.state.notifications, []);
  });

  test(`${endpoint}: optional invitation reservations are refunded if saving the new account fails`, async () => {
    const f = fixture();
    f.state.config.UserConfig.RequireApproval = true;
    f.state.failProfile = true;
    const response = await f.route(endpoint).POST(registrationRequest(f, endpoint, { inviteCode: 'ABCD2345' }));
    assert.equal(response.status, 500);
    assert.equal(response.cookies.get('user_auth'), undefined);
    assert.equal(f.state.users.size, 0);
    assert.deepEqual(f.state.events, ['reserve', 'create', 'profile', 'delete', 'release']);
    assert.deepEqual(f.state.released, f.state.reserved);
    assert.deepEqual(f.state.notifications, []);
  });
}

test('closing approval or registration preserves the access restriction on existing pending accounts', async () => {
  const f = fixture();
  f.state.config.UserConfig.RequireApproval = true;
  const registered = await f.route('register').POST(registrationRequest(f, 'register', {
    email: 'pending@example.com', source: 'friend',
  }));
  assert.equal(registered.data.pending, true);
  f.state.config.UserConfig.RequireApproval = false;
  f.state.config.UserConfig.AllowRegister = false;
  const login = await f.route('login').POST(request({ username: 'matrix_user', password: 'new-password' }));
  assert.equal(login.status, 401);
  assert.match(login.data.error, /等待管理员审核/);
  assert.equal(login.cookies.get('user_auth'), undefined);
  assert.equal(f.state.config.UserConfig.Users[0].pending, true);
});

test('required invitations and supplied profile fields are validated on the server', async () => {
  const f = fixture();
  f.state.config.UserConfig.RequireApproval = true;
  f.state.config.UserConfig.RequireInviteCode = true;
  const endpoint = f.route('register');
  const input = {
    username: 'new-user'.replace('-', '_'),
    password: 'new-password',
    confirmPassword: 'new-password',
  };
  for (const fields of [
    {},
    { email: 'person@example.com' },
    { email: 'person@example.com', source: 'friend' },
    { email: 'invalid', source: 'friend', inviteCode: 'CODE' },
    { email: 'first,second@example.com', source: 'friend', inviteCode: 'CODE' },
    { email: '<person@example.com>', source: 'friend', inviteCode: 'CODE' },
    { email: 'first;second@example.com', source: 'friend', inviteCode: 'CODE' },
    { email: 'person\u0000@example.com', source: 'friend', inviteCode: 'CODE' },
  ]) {
    const response = await endpoint.POST(request({ ...input, ...fields }));
    assert.equal(response.status, 400);
  }
  assert.equal(f.state.created.length, 0);
  assert.equal(f.state.reserved.length, 0);
});

test('invited signup normalizes profile fields, reserves first, and skips approval', async () => {
  const f = fixture();
  f.state.config.UserConfig.RequireApproval = true;
  f.state.config.UserConfig.RequireInviteCode = true;
  const response = await f
    .route('register')
    .POST(
      request({
        username: 'new_user',
        password: 'new-password',
        confirmPassword: 'new-password',
        email: ' New@Example.COM ',
        source: ' friend ',
        inviteCode: ' abcd2345 ',
      }),
    );
  assert.equal(response.status, 200);
  assert.equal(response.data.pending, false);
  assert.ok(response.cookies.get('user_auth'));
  assert.deepEqual(f.state.notifications, []);
  assert.equal(f.state.created[0][6], 'new@example.com');
  const createdUid = f.state.created[0][7].uid;
  assert.match(createdUid, /^[1-9][0-9]*$/);
  assert.deepEqual(f.state.created[0][7], { uid: createdUid, pending: false, source: 'friend' });
  assert.deepEqual(f.state.reserved[0].slice(0, 2), ['ABCD2345', createdUid]);
  assert.match(f.state.reserved[0][2], /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.state.events, ['reserve', 'create', 'profile']);
});

test('ordinary signup allows no email, while closed signup and duplicate normalized email do not create users', async () => {
  const f = fixture();
  const endpoint = f.route('register');
  const body = {
    username: 'new_user',
    password: 'new-password',
    confirmPassword: 'new-password',
  };
  f.state.config.UserConfig.AllowRegister = false;
  assert.equal((await endpoint.POST(request(body))).status, 403);
  f.state.config.UserConfig.AllowRegister = true;
  f.addUser('alice', { email: 'Alice@Example.COM' });
  assert.equal(
    (await endpoint.POST(request({ ...body, email: ' alice@example.com ' })))
      .status,
    409,
  );
  const response = await endpoint.POST(request(body));
  assert.equal(response.status, 200);
  assert.equal(response.data.pending, false);
  assert.ok(response.cookies.get('user_auth'));
});

test('failed invitation never creates an account and failed create refunds only its own attempt', async () => {
  const f = fixture();
  f.state.config.UserConfig.RequireInviteCode = true;
  const body = {
    username: 'new_user',
    password: 'new-password',
    confirmPassword: 'new-password',
    inviteCode: 'ABCD2345',
  };
  f.state.failInvite = true;
  assert.equal((await f.route('register').POST(request(body))).status, 400);
  assert.equal(f.state.created.length, 0);
  f.state.failInvite = false;
  f.state.failCreate = true;
  assert.equal((await f.route('register').POST(request(body))).status, 500);
  assert.deepEqual(f.state.released, f.state.reserved);
  assert.equal(f.state.events.includes('delete'), false);
});

test('profile failure removes only the newly created account before refunding its invitation', async () => {
  const f = fixture();
  f.state.config.UserConfig.RequireInviteCode = true;
  f.state.failProfile = true;
  const response = await f
    .route('register')
    .POST(
      request({
        username: 'new_user',
        password: 'new-password',
        confirmPassword: 'new-password',
        inviteCode: 'ABCD2345',
      }),
    );
  assert.equal(response.status, 500);
  assert.equal(f.state.users.has('new_user'), false);
  assert.deepEqual(f.state.events, [
    'reserve',
    'create',
    'profile',
    'delete',
    'release',
  ]);
  assert.deepEqual(f.state.released, f.state.reserved);
});

test('username and normalized email login reject pending or banned state in either source', async () => {
  const f = fixture();
  const stored = f.addUser('alice');
  const configured = f.state.config.UserConfig.Users[0];
  const endpoint = f.route('login');
  assert.equal(
    (
      await endpoint.POST(
        request({ username: ' ALICE@EXAMPLE.COM ', password: 'old-password' }),
      )
    ).status,
    200,
  );
  for (const source of [stored, configured]) {
    for (const key of ['pending', 'banned']) {
      source[key] = true;
      const response = await endpoint.POST(
        request({ username: 'alice', password: 'old-password' }),
      );
      assert.equal(response.status, 401);
      assert.equal(response.cookies.get('user_auth'), undefined);
      source[key] = false;
    }
  }
});

test('unknown email failures participate in the upstream login rate limit', async () => {
  const f = fixture();
  const endpoint = f.route('login');
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(
      (
        await endpoint.POST(
          request({ username: 'missing@example.com', password: 'bad' }),
        )
      ).status,
      401,
    );
  }
  assert.equal(
    (
      await endpoint.POST(
        request({ username: 'missing@example.com', password: 'bad' }),
      )
    ).status,
    429,
  );
});

test('approval and unban in admin config override stored creation flags', async (t) => {
  const f = fixture();
  f.addUser('alice', { pending: true, banned: true, oidcSub: 'existing-sub' });
  Object.assign(f.state.config.UserConfig.Users[0], {
    pending: false,
    banned: false,
  });
  const login = await f
    .route('login')
    .POST(request({ username: 'alice', password: 'old-password' }));
  assert.equal(login.status, 200);
  assert.ok(login.cookies.get('user_auth'));
  t.mock.method(global, 'fetch', async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).endsWith('/token')
        ? { access_token: 'fixture-access-token', id_token: 'fixture-id-token' }
        : { sub: 'existing-sub' },
  }));
  const oidc = await f
    .route('auth/oidc/callback')
    .GET(
      request(undefined, {
        pathname:
          '/api/auth/oidc/callback?code=fixture-code&state=fixture-state',
        cookies: {
          oidc_state: JSON.stringify({
            state: 'fixture-state',
            providerId: 'default',
          }),
        },
      }),
    );
  assert.equal(oidc.status, 307);
  assert.equal(oidc.headers.get('location'), 'https://miaotv.test/');
  assert.ok(oidc.cookies.get('user_auth'));
});

test('password change rejects unsigned and network-only cookies, then accepts the original signed format', async () => {
  const f = fixture();
  f.addUser();
  const endpoint = f.route('change-password');
  const body = { oldPassword: 'old-password', newPassword: 'new-password' };
  for (const cookie of [
    JSON.stringify({ username: 'alice' }),
    JSON.stringify({ username: 'alice', trustedNetwork: true }),
  ]) {
    assert.equal(
      (await endpoint.POST(request(body, { cookies: { user_auth: cookie } })))
        .status,
      401,
    );
  }
  assert.equal(f.state.changed.length, 0);
  assert.equal(
    (
      await endpoint.POST(
        request(body, { cookies: { user_auth: signedCookie() } }),
      )
    ).status,
    200,
  );
  assert.deepEqual(f.state.changed, ['alice']);
});

test('password reset is consumed once under concurrent requests', async () => {
  const f = fixture();
  const user = f.addUser();
  const tokens = f.load('password-reset-tokens.ts');
  const token = await tokens.generatePasswordResetToken(
    user.uid,
    'alice@example.com',
  );
  const endpoint = f.route('reset-password');
  const responses = await Promise.all([
    endpoint.POST(request({ token, password: 'new-password' })),
    endpoint.POST(request({ token, password: 'new-password' })),
  ]);
  assert.deepEqual(responses.map((value) => value.status).sort(), [200, 400]);
  assert.deepEqual(f.state.changed, ['alice']);
});

test('password reset rejects changed email, recreated credentials, and old unversioned links', async () => {
  const f = fixture();
  const user = f.addUser();
  const tokens = f.load('password-reset-tokens.ts');
  const endpoint = f.route('reset-password');
  let token = await tokens.generatePasswordResetToken(user.uid, user.email);
  user.email = 'new@example.com';
  assert.equal(
    (await endpoint.POST(request({ token, password: 'new-password' }))).status,
    400,
  );
  token = await tokens.generatePasswordResetToken(user.uid, user.email);
  user.credential = 'same-name-recreated-account-credential';
  assert.equal(
    (await endpoint.POST(request({ token, password: 'new-password' }))).status,
    400,
  );
  token = 'f'.repeat(64);
  f.state.cache.set(`password_reset:${token}`, {
    username: 'alice',
    email: user.email,
    expiresAt: Date.now() + 10000,
  });
  assert.equal(
    (await endpoint.POST(request({ token, password: 'new-password' }))).status,
    400,
  );
  assert.equal(f.state.changed.length, 0);
});

test('conditional password writes reject account changes after verification', async () => {
  const f = fixture();
  const user = f.addUser();
  f.state.failConditionalChange = true;
  const token = await f
    .load('password-reset-tokens.ts')
    .generatePasswordResetToken(user.uid, 'alice@example.com');
  const reset = await f
    .route('reset-password')
    .POST(request({ token, password: 'new-password' }));
  assert.equal(reset.status, 400);
  assert.match(reset.data.error, /账户信息已变化/);
  const change = await f
    .route('change-password')
    .POST(
      request(
        { oldPassword: 'old-password', newPassword: 'new-password' },
        { cookies: { user_auth: signedCookie() } },
      ),
    );
  assert.equal(change.status, 409);
  assert.equal(f.state.changed.length, 0);
});

test('OIDC registration cookie rejects unsigned, tampered, expired, and future claims', () => {
  const f = fixture();
  const sessions = f.load('oidc-registration-session.ts');
  const now = Date.now();
  const claims = {
    sub: 'oidc-sub',
    providerId: 'default',
    providerKey: sessions.getOIDCProviderKey(f.state.config.OIDCAuthConfig, 'default'),
    email: 'alice@example.com',
    timestamp: now,
  };
  const cookie = sessions.encodeOIDCRegistrationSession(claims);
  assert.equal(sessions.decodeOIDCRegistrationSession(cookie).sub, 'oidc-sub');
  assert.equal(
    sessions.decodeOIDCRegistrationSession(JSON.stringify(claims)),
    null,
  );
  const segments = cookie.split('.');
  segments[1] = Buffer.from(
    JSON.stringify({ ...claims, sub: 'victim-sub' }),
  ).toString('base64url');
  assert.equal(
    sessions.decodeOIDCRegistrationSession(segments.join('.')),
    null,
  );
  assert.equal(
    sessions.decodeOIDCRegistrationSession(
      sessions.encodeOIDCRegistrationSession({
        ...claims,
        timestamp: now - 600000,
      }),
    ),
    null,
  );
  assert.equal(
    sessions.decodeOIDCRegistrationSession(
      sessions.encodeOIDCRegistrationSession({
        ...claims,
        timestamp: now + 600000,
      }),
    ),
    null,
  );
});

test('OIDC registration requires the configured invitation and skips approval after consuming it', async () => {
  const f = fixture();
  f.state.config.UserConfig.RequireApproval = true;
  f.state.config.UserConfig.RequireInviteCode = true;
  const sessions = f.load('oidc-registration-session.ts');
  const providerKey = sessions.getOIDCProviderKey(f.state.config.OIDCAuthConfig, 'default');
  const cookie = sessions.encodeOIDCRegistrationSession({
    sub: 'new-sub',
    providerId: 'default',
    providerKey,
    email: 'new@example.com',
    timestamp: Date.now(),
  });
  const endpoint = f.route('auth/oidc/complete-register');
  const options = { cookies: { oidc_session: cookie } };
  assert.equal(
    (
      await endpoint.POST(
        request({ username: 'new_user', source: 'friend' }, options),
      )
    ).status,
    400,
  );
  const response = await endpoint.POST(
    request(
      { username: 'new_user', source: 'friend', inviteCode: 'ABCD2345' },
      options,
    ),
  );
  assert.equal(response.data.pending, false);
  assert.ok(response.cookies.get('user_auth'));
  assert.deepEqual(f.state.notifications, []);
  assert.equal(f.state.created[0][4], sessions.getOIDCAccountSubject(providerKey, 'new-sub'));
  assert.equal(f.state.created[0][6], 'new@example.com');
});

test('existing OIDC identity cannot bypass pending review on callback', async (t) => {
  const f = fixture();
  f.addUser('alice', { oidcSub: 'existing-sub' });
  f.state.config.UserConfig.Users[0].pending = true;
  t.mock.method(global, 'fetch', async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).endsWith('/token')
        ? { access_token: 'fixture-access-token', id_token: 'fixture-id-token' }
        : { sub: 'existing-sub', email: 'alice@example.com' },
  }));
  const response = await f
    .route('auth/oidc/callback')
    .GET(
      request(undefined, {
        pathname:
          '/api/auth/oidc/callback?code=fixture-code&state=fixture-state',
        cookies: {
          oidc_state: JSON.stringify({
            state: 'fixture-state',
            providerId: 'default',
          }),
        },
      }),
    );
  assert.equal(response.status, 307);
  assert.match(
    decodeURIComponent(response.headers.get('location')),
    /等待管理员审核/,
  );
  assert.equal(response.cookies.get('user_auth'), undefined);
});

function oidcCallbackRequest(providerId = 'default') {
  return request(undefined, {
    pathname: '/api/auth/oidc/callback?code=fixture-code&state=fixture-state',
    cookies: {
      oidc_state: JSON.stringify({ state: 'fixture-state', providerId }),
    },
  });
}

function mockOIDCSubject(t, subject, issuer) {
  t.mock.method(global, 'fetch', async (url) => ({
    ok: true,
    status: 200,
    json: async () => String(url).endsWith('/token')
      ? { access_token: 'fixture-access-token', id_token: 'fixture-id-token' }
      : { sub: subject, ...(issuer ? { iss: issuer } : {}) },
  }));
}

test('OIDC identities with the same subject remain isolated by provider and issuer', async (t) => {
  const f = fixture();
  const base = f.state.config.OIDCAuthConfig;
  f.state.config.OIDCProviders = [
    { ...base, id: 'first' },
    { ...base, id: 'second', issuer: 'https://second-id.test' },
  ];
  const sessions = f.load('oidc-registration-session.ts');
  const firstKey = sessions.getOIDCProviderKey(f.state.config.OIDCProviders[0], 'first');
  const secondKey = sessions.getOIDCProviderKey(f.state.config.OIDCProviders[1], 'second');
  assert.notEqual(firstKey, secondKey);
  f.addUser('alice', { oidcSub: sessions.getOIDCAccountSubject(firstKey, 'same-subject') });
  mockOIDCSubject(t, 'same-subject');
  const callback = f.route('auth/oidc/callback');
  const second = await callback.GET(oidcCallbackRequest('second'));
  assert.match(second.headers.get('location'), /\/oidc-register$/);
  assert.equal(second.cookies.get('user_auth'), undefined);
  assert.equal(sessions.decodeOIDCRegistrationSession(second.cookies.get('oidc_session').value).providerKey, secondKey);

  const first = await callback.GET(oidcCallbackRequest('first'));
  assert.equal(first.headers.get('location'), 'https://miaotv.test/');
  assert.equal(JSON.parse(decodeURIComponent(first.cookies.get('user_auth').value)).username, 'alice');

  f.state.config.OIDCProviders[0].issuer = 'https://replacement-id.test';
  const replacement = await callback.GET(oidcCallbackRequest('first'));
  assert.equal(replacement.cookies.get('user_auth'), undefined);
  assert.match(replacement.headers.get('location'), /\/oidc-register$/);
});

test('legacy OIDC bindings are retained for one provider and never guessed among multiple providers', async (t) => {
  const f = fixture();
  f.addUser('alice', { oidcSub: 'old-subject' });
  mockOIDCSubject(t, 'old-subject');
  const callback = f.route('auth/oidc/callback');
  const legacy = await callback.GET(oidcCallbackRequest());
  assert.ok(legacy.cookies.get('user_auth'));
  f.state.config.OIDCProviders = [
    { ...f.state.config.OIDCAuthConfig, id: 'first' },
    { ...f.state.config.OIDCAuthConfig, id: 'second', issuer: 'https://second-id.test' },
  ];
  const ambiguous = await callback.GET(oidcCallbackRequest('second'));
  assert.equal(ambiguous.cookies.get('user_auth'), undefined);
  assert.match(decodeURIComponent(ambiguous.headers.get('location')), /旧OIDC绑定无法确定/);
});

test('stale OIDC indexes and configuration cannot authenticate a recreated V2 account', async (t) => {
  const f = fixture();
  f.addUser('alice');
  f.state.config.UserConfig.Users[0].oidcSub = 'deleted-binding';
  f.db.getUserByOidcSub = async () => 'alice';
  mockOIDCSubject(t, 'deleted-binding');
  const response = await f.route('auth/oidc/callback').GET(oidcCallbackRequest());
  assert.equal(response.cookies.get('user_auth'), undefined);
  assert.match(response.headers.get('location'), /\/oidc-register$/);
});

test('OIDC registration rejects a changed provider authority and mismatched issuer', async (t) => {
  const f = fixture();
  const sessions = f.load('oidc-registration-session.ts');
  const cookie = sessions.encodeOIDCRegistrationSession({
    sub: 'new-subject',
    providerId: 'default',
    providerKey: sessions.getOIDCProviderKey(f.state.config.OIDCAuthConfig, 'default'),
    timestamp: Date.now(),
  });
  f.state.config.OIDCAuthConfig.issuer = 'https://replacement-id.test';
  const options = { cookies: { oidc_session: cookie } };
  assert.equal((await f.route('auth/oidc/session-info').GET(request(undefined, options))).status, 400);
  assert.equal((await f.route('auth/oidc/complete-register').POST(request({ username: 'new_user' }, options))).status, 400);
  assert.equal(f.state.created.length, 0);

  mockOIDCSubject(t, 'new-subject', 'https://wrong-id.test');
  const response = await f.route('auth/oidc/callback').GET(oidcCallbackRequest());
  assert.match(decodeURIComponent(response.headers.get('location')), /用户信息无效/);
  assert.equal(response.cookies.get('user_auth'), undefined);
  assert.equal(response.cookies.get('oidc_session'), undefined);
});

test('OIDC default provider keeps its OAuth parameters and callback cookie transport', async () => {
  const f = fixture();
  f.state.config.OIDCProviders = [{ ...f.state.config.OIDCAuthConfig, id: 'github' }];
  const endpoint = f.route('auth/oidc/login');
  const github = await endpoint.GET(request());
  assert.equal(new URL(github.headers.get('location')).searchParams.get('scope'), 'read:user user:email');
  assert.equal(JSON.parse(github.cookies.get('oidc_state').value).providerId, 'github');
  assert.equal(github.cookies.get('oidc_state').secure, true);
  f.state.config.OIDCProviders[0].id = 'apple';
  const apple = await endpoint.GET(request());
  assert.equal(apple.cookies.get('oidc_state').sameSite, 'none');
  assert.equal(new URL(apple.headers.get('location')).searchParams.get('response_mode'), 'form_post');
});

test('legacy Telegram settings are not advertised while OIDC login remains available', async () => {
  const f = fixture();
  f.state.config.TelegramAuthConfig = {
    enabled: true,
    autoRegister: true,
    botToken: 'unused-legacy-token',
    botUsername: 'legacy_bot',
  };
  const oidc = f.state.config.OIDCAuthConfig;
  f.state.config.OIDCProviders = [
    {
      ...oidc,
      id: 'active',
      name: 'Active identity',
      buttonText: 'Continue with identity',
    },
    { ...oidc, id: 'disabled', enabled: false },
  ];
  const endpoint = f.route('server-config');
  const response = await endpoint.GET(request());
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(response.data, 'TelegramAuthConfig'), false);
  assert.deepEqual(response.data.OIDCProviders, [
    {
      id: 'active',
      name: 'Active identity',
      buttonText: 'Continue with identity',
      issuer: oidc.issuer,
    },
  ]);
  assert.equal(
    JSON.stringify(response.data).includes('unused-legacy-token'),
    false,
  );
  assert.equal(JSON.stringify(response.data).includes(oidc.clientSecret), false);
  f.state.config.OIDCProviders = [];
  const legacyOIDC = await endpoint.GET(request());
  assert.equal(legacyOIDC.data.OIDCConfig.enabled, true);
  assert.equal(legacyOIDC.data.OIDCConfig.issuer, oidc.issuer);
  assert.equal(Object.hasOwn(legacyOIDC.data, 'TelegramAuthConfig'), false);
  assert.deepEqual(f.state.events, []);
});

test('existing Telegram-created accounts retain password and email login', async () => {
  const f = fixture();
  const user = f.addUser('tg_alice');
  const endpoint = f.route('login');
  for (const identity of [user.username, ' TG_ALICE@EXAMPLE.COM ']) {
    const response = await endpoint.POST(
      request({ username: identity, password: 'old-password' }),
    );
    assert.equal(response.status, 200);
    const auth = JSON.parse(
      decodeURIComponent(response.cookies.get('user_auth').value),
    );
    assert.equal(auth.username, user.username);
    assert.equal(auth.uid, user.uid);
    assert.equal(auth.sessionVersion, user.sessionVersion);
    assert.equal(auth.authVersion, 2);
    assert.equal(auth.password, undefined);
  }
  assert.equal(f.state.users.get(user.username), user);
  assert.deepEqual(f.state.created, []);
  assert.deepEqual(f.state.changed, []);
  assert.deepEqual(f.state.events, []);
});

test('password login and signup emit the authenticated UID and current session version', async () => {
  const f = fixture();
  const user = f.addUser();
  const login = await f.route('login').POST(request({ username: user.username, password: 'old-password' }));
  const auth = JSON.parse(decodeURIComponent(login.cookies.get('user_auth').value));
  assert.equal(auth.uid, user.uid);
  assert.equal(auth.sessionVersion, 100);
  assert.equal(auth.authVersion, 2);
  assert.equal(auth.password, undefined);
  const verified = await f.load('auth.server.ts').getVerifiedAuthInfo(request(undefined, { cookies: { user_auth: login.cookies.get('user_auth').value } }));
  assert.equal(verified.uid, user.uid);

  const signup = await f.route('register').POST(request({ username: 'new_user', password: 'new-password', confirmPassword: 'new-password' }));
  assert.equal(signup.status, 200);
  const signedUp = JSON.parse(decodeURIComponent(signup.cookies.get('user_auth').value));
  assert.equal(signedUp.uid, f.state.created[0][7].uid);
  assert.equal(signedUp.sessionVersion, 200);

  const owner = await f.route('login').POST(request({ username: process.env.USERNAME, password: process.env.PASSWORD }));
  const ownerAuth = JSON.parse(decodeURIComponent(owner.cookies.get('user_auth').value));
  assert.equal(ownerAuth.uid, '1');
  assert.equal(ownerAuth.sessionVersion, 300);
  assert.equal(ownerAuth.role, 'owner');
});


test('numeric usernames are resolved by name before password authentication even when another account has that UID', async () => {
  const f = fixture();
  const other = f.addUser('other_user', { uid: '202', rawPassword: 'other-password' });
  const numeric = f.addUser('202', { rawPassword: 'numeric-password' });
  const login = f.route('login');
  const accepted = await login.POST(request({ username: numeric.username, password: numeric.rawPassword }));
  assert.equal(accepted.status, 200);
  const claims = JSON.parse(decodeURIComponent(accepted.cookies.get('user_auth').value));
  assert.equal(claims.uid, numeric.uid);
  assert.notEqual(claims.uid, other.uid);
  const wrongAccountPassword = await login.POST(request({ username: numeric.username, password: other.rawPassword }));
  assert.equal(wrongAccountPassword.status, 401);
  assert.equal(wrongAccountPassword.cookies.get('user_auth'), undefined);
});

test('registering a numeric username does not conflict with a different account whose UID has the same value', async () => {
  const f = fixture();
  const other = f.addUser('other_user', { uid: '202' });
  const response = await f.route('register').POST(request({ username: '202', password: 'numeric-password', confirmPassword: 'numeric-password' }));
  assert.equal(response.status, 200);
  const claims = JSON.parse(decodeURIComponent(response.cookies.get('user_auth').value));
  assert.equal(claims.username, '202');
  assert.notEqual(claims.uid, other.uid);
  assert.match(claims.uid, /^[1-9][0-9]*$/);
  assert.equal(f.state.users.get('other_user'), other);
});

test('OIDC binding of a numeric username cannot sign in the account whose UID equals that username', async (t) => {
  const f = fixture();
  f.addUser('other_user', { uid: '202', oidcSub: 'other-subject' });
  const numeric = f.addUser('202', { oidcSub: 'numeric-subject' });
  mockOIDCSubject(t, 'numeric-subject');
  const response = await f.route('auth/oidc/callback').GET(oidcCallbackRequest());
  assert.equal(response.headers.get('location'), 'https://miaotv.test/');
  const claims = JSON.parse(decodeURIComponent(response.cookies.get('user_auth').value));
  assert.equal(claims.username, numeric.username);
  assert.equal(claims.uid, numeric.uid);
});

test('email password recovery keeps numeric usernames distinct from unrelated numeric UIDs', async () => {
  const f = fixture();
  const other = f.addUser('other_user', { uid: '202', email: 'other@example.com' });
  const numeric = f.addUser('202', { email: 'numeric@example.com' });
  const issued = await f.route('forgot-password').POST(request({ email: numeric.email }));
  assert.equal(issued.status, 200);
  const entry = [...f.state.cache.entries()].find(([key]) => key.startsWith('password_reset:'));
  assert.ok(entry);
  assert.equal(entry[1].uid, numeric.uid);
  assert.equal(entry[1].username, numeric.username);
  const reset = await f.route('reset-password').POST(request({ token: entry[0].slice('password_reset:'.length), password: 'updated-number-password' }));
  assert.equal(reset.status, 200);
  assert.deepEqual(f.state.changed, [numeric.username]);
  assert.equal(numeric.rawPassword, 'updated-number-password');
  assert.equal(other.rawPassword, 'old-password');
});
