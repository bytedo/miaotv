const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');

// All state is in memory. The source loader rejects an unmocked application DB.
process.env.PASSWORD = 'uid-auth-test-secret';
process.env.USERNAME = 'fixture-owner';
process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
const FIRST = '101';
const SECOND = '202';
const OWNER = '1';
const LEGACY_FIRST = '00000000-0000-4000-8000-000000000001';
const LEGACY_SECOND = '00000000-0000-4000-8000-000000000002';

class TestRequest extends Request {
  constructor(input, init) {
    super(input, init);
    this.nextUrl = new URL(this.url);
    this.cookies = {
      get: (name) => {
        const cookie = (this.headers.get('cookie') || '')
          .split(';')
          .map((item) => item.trim())
          .find((item) => item.startsWith(name + '='));
        return cookie ? { value: cookie.slice(name.length + 1) } : undefined;
      },
    };
  }
}

class TestResponse extends Response {
  constructor(body, init) {
    super(body, init);
    const cookies = new Map();
    this.cookies = {
      set: (name, value, options) => cookies.set(name, { value, ...options }),
      get: (name) => cookies.get(name),
    };
  }
  static next(init = {}) {
    const response = new TestResponse();
    response.forwarded = init.request?.headers;
    return response;
  }
  static rewrite(url, init) {
    const response = TestResponse.next(init);
    response.headers.set('x-rewrite', String(url));
    return response;
  }
  static redirect(url) {
    return new TestResponse(null, {
      status: 307,
      headers: { location: String(url) },
    });
  }
}

function request(
  cookie,
  body,
  url = '/api/searchhistory',
  method = body ? 'POST' : 'GET',
) {
  return new TestRequest(new URL(url, 'https://miaotv.test'), {
    method,
    headers: cookie ? { cookie: 'preference=keep; user_auth=' + cookie } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function legacyCookie(username) {
  return encodeURIComponent(
    JSON.stringify({
      username,
      role: 'owner',
      trustedNetwork: true,
      signature: createHmac('sha256', process.env.PASSWORD)
        .update(username)
        .digest('hex'),
    }),
  );
}

function fixture() {
  const state = {
    identities: new Map(),
    aliases: new Map(),
    users: new Map(),
    retired: new Set(),
    calls: [],
    cache: new Map(),
    history: new Map(),
    beforeConfig: null,
    savedConfigs: [],
    embyCacheClears: 0,
  };
  const config = {
    UserConfig: { Users: [] },
    SiteConfig: {},
    SourceConfig: [],
  };
  function add(uid, username) {
    const identity = { uid, username, storageKey: uid, sessionVersion: 100 };
    state.identities.set(uid, identity);
    state.users.set(uid, {
      uid,
      username,
      role: 'user',
      email: 'alice@example.com',
      credential: 'fixture-credential',
    });
    config.UserConfig.Users.push({ uid, username, role: 'user' });
    return { ...identity };
  }
  function rename(uid, username) {
    const identity = state.identities.get(uid);
    state.retired.add(identity.username);
    identity.username = username;
    identity.sessionVersion++;
    state.users.get(uid).username = username;
    config.UserConfig.Users.find((user) => user.uid === uid).username =
      username;
  }
  const copy = (value) => (value ? { ...value } : null);
  const db = {
    saveAdminConfig: async (value) => state.savedConfigs.push(structuredClone(value)),
    getAllUserIdentities: async () => [...state.identities.values()].map(copy),
    getUserIdentity: async (username) =>
      copy(
        [...state.identities.values()].find(
          (identity) => identity.username === username,
        ),
      ),
    getUserIdentityByUid: async (uid) => copy(state.identities.get(state.aliases.get(uid) || uid)),
    isLegacyUsernameRetired: async (username) => state.retired.has(username),
    getUserInfoV2: async (uid) => copy(state.users.get(uid)),
    checkUserExist: async (uid) => state.users.has(uid),
    getUserCredential: async (uid) => state.users.get(uid)?.credential || null,
    getUserEmail: async (uid) => state.users.get(uid)?.email || null,
    setCache: async (key, value) => state.cache.set(key, value),
    getCache: async (key) => state.cache.get(key) ?? null,
    consumeCache: async (key) => {
      const value = state.cache.get(key);
      state.cache.delete(key);
      return value ?? null;
    },
    changePassword: async (uid, password) =>
      state.calls.push(['changePassword', uid, password]),
    getSearchHistory: async (uid) => {
      state.calls.push(['getSearchHistory', uid]);
      return state.history.get(uid) || [];
    },
    addSearchHistory: async (uid, keyword) => {
      state.calls.push(['addSearchHistory', uid, keyword]);
      state.history.set(uid, [keyword]);
    },
    isStatsSupported: () => false,
  };
  for (const method of [
    'getAllPlayRecords',
    'getAllFavorites',
    'getAllReminders',
    'getAllEpisodeSkipConfigs',
    'getAllSkipConfigs',
  ]) {
    db[method] = async (uid) => {
      state.calls.push([method, uid]);
      return {};
    };
  }
  db.getPlayRecord = async (uid) => {
    state.calls.push(['getPlayRecord', uid]);
    return null;
  };
  for (const method of [
    'savePlayRecord',
    'deletePlayRecord',
    'saveFavorite',
    'deleteFavorite',
    'saveReminder',
    'deleteReminder',
    'setSkipConfig',
    'deleteSkipConfig',
  ]) {
    db[method] = async (uid, ...args) => {
      state.calls.push([method, uid, ...args]);
    };
  }
  const cfg = {
    clearConfigCache() {},
    getConfig: async () => {
      if (state.beforeConfig) {
        const run = state.beforeConfig;
        state.beforeConfig = null;
        await run();
      }
      return config;
    },
  };
  const load = createSourceLoader({
    './db': { db },
    '@/lib/db': { db },
    './config': cfg,
    '@/lib/config': cfg,
    '@/lib/emby-cache': {
      clearEmbyCache: () => { state.embyCacheClears++; return { cleared: 2 }; },
    },
    'next/server': { NextRequest: TestRequest, NextResponse: TestResponse },
    '@/lib/performance-monitor': {
      getDbQueryCount: () => 0,
      resetDbQueryCount() {},
      recordRequest() {},
    },
  });
  add(OWNER, process.env.USERNAME);
  const first = add(FIRST, 'alice');
  const auth = load('auth.server.ts');
  return {
    state,
    config,
    db,
    add,
    rename,
    first,
    auth,
    load,
    cookie: () => auth.createSignedAuthCookie(state.identities.get(FIRST)),
    route: (name) => load(path.resolve(__dirname, '..', name, 'route.ts')),
  };
}

test('UID signatures reject tampering, renamed sessions, and reused usernames', async () => {
  const f = fixture();
  const cookie = f.cookie();
  assert.deepEqual(await f.auth.getVerifiedAuthInfo(request(cookie)), {
    uid: FIRST,
    username: 'alice',
    sessionVersion: 100,
  });
  const claims = JSON.parse(decodeURIComponent(cookie));
  for (const change of [
    { uid: SECOND },
    { username: 'fixture-owner' },
    { authVersion: 1 },
    { sessionVersion: 101 },
    { sessionVersion: -1 },
    { sessionVersion: 0.5 },
    { uid: undefined },
  ]) {
    assert.equal(
      await f.auth.getVerifiedAuthInfo(
        request(encodeURIComponent(JSON.stringify({ ...claims, ...change }))),
      ),
      null,
    );
  }
  f.rename(FIRST, 'renamed');
  f.add(SECOND, 'alice');
  assert.equal(await f.auth.getVerifiedAuthInfo(request(cookie)), null);
  assert.equal(
    await f.auth.getVerifiedAuthInfo(request(legacyCookie('alice'))),
    null,
  );
  assert.deepEqual(await f.auth.getVerifiedAuthInfo(request(f.cookie())), {
    uid: FIRST,
    username: 'renamed',
    sessionVersion: 101,
  });
  assert.deepEqual(
    await f.auth.getVerifiedAuthInfo(
      request(
        f.auth.createSignedAuthCookie({
          uid: SECOND,
          username: 'alice',
          sessionVersion: 100,
        }),
      ),
    ),
    { uid: SECOND, username: 'alice', sessionVersion: 100 },
  );
});

test('Proxy upgrades a legacy cookie to a verifiable UID cookie for both downstream and browser', async () => {
  const f = fixture();
  const proxy = f.load(path.resolve(__dirname, '../../../proxy.ts')).proxy;
  const response = await proxy(request(legacyCookie('alice')));
  assert.equal(response.status, 200);
  const forwarded = new TestRequest('https://miaotv.test/api/searchhistory', {
    headers: response.forwarded,
  });
  assert.deepEqual(await f.auth.getVerifiedAuthInfo(forwarded), {
    uid: FIRST,
    username: 'alice',
    sessionVersion: 100,
  });
  assert.ok(response.forwarded.get('cookie').includes('preference=keep'));
  const claims = JSON.parse(
    decodeURIComponent(response.cookies.get('user_auth').value),
  );
  assert.equal(claims.uid, FIRST);
  assert.equal(claims.role, 'user');
  assert.equal(claims.trustedNetwork, false);
  assert.equal(claims.authVersion, 2);
  assert.equal(claims.sessionVersion, 100);
});

test('renaming back or restoring the same UID never revives an older session version', async () => {
  const f = fixture();
  const beforeRename = f.cookie();
  f.rename(FIRST, 'renamed');
  f.rename(FIRST, 'alice');
  assert.equal(await f.auth.getVerifiedAuthInfo(request(beforeRename)), null);
  const afterRename = f.cookie();
  assert.equal(
    (await f.auth.getVerifiedAuthInfo(request(afterRename))).sessionVersion,
    102,
  );
  f.state.identities.get(FIRST).sessionVersion = 200;
  assert.equal(await f.auth.getVerifiedAuthInfo(request(afterRename)), null);
  assert.equal(
    (await f.auth.getVerifiedAuthInfo(request(f.cookie()))).sessionVersion,
    200,
  );
});

test('a request already authenticated by UID cannot write into a reused username after awaiting config', async () => {
  const f = fixture();
  const cookie = f.cookie();
  f.state.beforeConfig = () => {
    f.rename(FIRST, 'renamed');
    f.add(SECOND, 'alice');
  };
  const response = await f
    .route('searchhistory')
    .POST(request(cookie, { keyword: 'uid-owned-history' }));
  assert.equal(response.status, 200);
  assert.deepEqual(f.state.calls, [
    ['addSearchHistory', FIRST, 'uid-owned-history'],
    ['getSearchHistory', FIRST],
  ]);
  assert.equal(f.state.history.has(SECOND), false);
});

test('record, favorite and reminder reads, writes and deletes always pass a verified UID', async () => {
  for (const [route, singular, record] of [
    [
      'playrecords',
      'record',
      { title: 'Fixture', source_name: 'Source', index: 1, total_episodes: 1 },
    ],
    ['favorites', 'favorite', { title: 'Fixture', source_name: 'Source' }],
    [
      'reminders',
      'reminder',
      { title: 'Fixture', source_name: 'Source', releaseDate: '2027-01-01' },
    ],
  ]) {
    const f = fixture();
    const endpoint = f.route(route);
    assert.equal(
      (await endpoint.GET(request(f.cookie(), undefined, '/api/' + route)))
        .status,
      200,
      route,
    );
    assert.equal(
      (
        await endpoint.POST(
          request(
            f.cookie(),
            { key: 'source+1', [singular]: record },
            '/api/' + route,
          ),
        )
      ).status,
      200,
      route,
    );
    assert.equal(
      (
        await endpoint.DELETE(
          request(
            f.cookie(),
            undefined,
            '/api/' + route + '?key=source%2B1',
            'DELETE',
          ),
        )
      ).status,
      200,
      route,
    );
    assert.ok(f.state.calls.length >= 3);
    for (const call of f.state.calls)
      assert.equal(call[1], FIRST, route + ': ' + call[0]);
  }
});

test('skip configuration ignores body.username and rejects unsigned account selectors', async () => {
  const f = fixture();
  const endpoint = f.route('skipconfigs');
  const body = {
    action: 'set',
    username: 'fixture-owner',
    key: 'source+1',
    config: { source: 'source', id: '1', title: 'Fixture', segments: [] },
  };
  assert.equal((await endpoint.POST(request(undefined, body))).status, 401);
  assert.equal(f.state.calls.length, 0);
  assert.equal((await endpoint.POST(request(f.cookie(), body))).status, 200);
  assert.equal(f.state.calls[0][0], 'setSkipConfig');
  assert.equal(f.state.calls[0][1], FIRST);
});

test('password reset links retain their UID across rename and never reset a replacement account', async () => {
  const f = fixture();
  const tokens = f.load('password-reset-tokens.ts');
  const token = await tokens.generatePasswordResetToken(
    FIRST,
    'alice@example.com',
  );
  f.rename(FIRST, 'renamed');
  f.add(SECOND, 'alice');
  assert.equal(
    (
      await f
        .route('reset-password')
        .POST(request(undefined, { token, password: 'replacement-password' }))
    ).status,
    200,
  );
  assert.deepEqual(f.state.calls, [
    ['changePassword', FIRST, 'replacement-password'],
  ]);

  const removedToken = await tokens.generatePasswordResetToken(
    FIRST,
    'alice@example.com',
  );
  f.state.identities.delete(FIRST);
  f.state.users.delete(FIRST);
  assert.equal(
    (
      await f.route('reset-password').POST(
        request(undefined, {
          token: removedToken,
          password: 'replacement-password',
        }),
      )
    ).status,
    400,
  );
  assert.equal(f.state.calls.length, 1);
  const legacy = 'f'.repeat(64);
  f.state.cache.set(`password_reset:${legacy}`, {
    username: 'alice',
    email: 'alice@example.com',
    expiresAt: Date.now() + 10000,
    credentialVersion:
      tokens.getPasswordResetCredentialVersion('fixture-credential'),
  });
  assert.equal(await tokens.verifyAndConsumePasswordResetToken(legacy), null);
});

test('local owner cookies are bound to the configured owner and never consult remote identity state', async (t) => {
  const f = fixture();
  const previous = process.env.NEXT_PUBLIC_STORAGE_TYPE;
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'localstorage';
  t.after(() => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = previous;
  });
  f.db.getUserIdentityByUid = async () => {
    throw new Error('Local mode accessed DB');
  };
  const owner = f.auth.getLocalOwnerIdentity();
  assert.deepEqual(
    await f.auth.getVerifiedAuthInfo(
      request(f.auth.createSignedAuthCookie(owner)),
    ),
    owner,
  );
  assert.equal(
    await f.auth.getVerifiedAuthInfo(
      request(
        f.auth.createSignedAuthCookie({ uid: FIRST, username: owner.username }),
      ),
    ),
    null,
  );
  assert.deepEqual(
    await f.auth.getVerifiedAuthInfo(
      request(
        encodeURIComponent(
          JSON.stringify({
            password: process.env.PASSWORD,
            username: 'forged',
          }),
        ),
      ),
    ),
    owner,
  );
});


test('an existing UUID session resolves to its canonical numeric UID without changing its session epoch', async () => {
  const f = fixture();
  const previousIdentity = { ...f.first, uid: LEGACY_FIRST };
  const oldCookie = f.auth.createSignedAuthCookie(previousIdentity);
  f.state.aliases.set(LEGACY_FIRST, FIRST);
  assert.deepEqual(await f.auth.getVerifiedAuthInfo(request(oldCookie)), {
    uid: FIRST,
    username: 'alice',
    sessionVersion: 100,
  });

  // Replacing a signed UUID with its numeric UID still changes the signed payload.
  const claims = JSON.parse(decodeURIComponent(oldCookie));
  assert.equal(await f.auth.getVerifiedAuthInfo(request(encodeURIComponent(JSON.stringify({ ...claims, uid: FIRST })))), null);
  assert.equal(await f.auth.getVerifiedAuthInfo(request(encodeURIComponent(JSON.stringify({ ...claims, uid: Number(FIRST) })))), null);
  const unknownAlias = f.auth.createSignedAuthCookie({ ...previousIdentity, uid: LEGACY_SECOND });
  assert.equal(await f.auth.getVerifiedAuthInfo(request(unknownAlias)), null);
});

test('Proxy replaces a version-2 UUID cookie with a numeric cookie for both browser and downstream requests', async () => {
  const f = fixture();
  f.state.aliases.set(LEGACY_FIRST, FIRST);
  const oldCookie = f.auth.createSignedAuthCookie(
    { ...f.first, uid: LEGACY_FIRST },
    { role: 'owner', loginTime: 12345 },
  );
  const proxy = f.load(path.resolve(__dirname, '../../../proxy.ts')).proxy;
  const response = await proxy(request(oldCookie));
  assert.equal(response.status, 200);
  const upgraded = response.cookies.get('user_auth');
  assert.ok(upgraded);
  const claims = JSON.parse(decodeURIComponent(upgraded.value));
  assert.equal(claims.uid, FIRST);
  assert.match(claims.uid, /^[1-9][0-9]*$/);
  assert.equal(claims.sessionVersion, 100);
  assert.equal(claims.role, 'user');
  assert.equal(claims.loginTime, 12345);
  assert.equal(claims.authVersion, 2);
  const forwarded = new TestRequest('https://miaotv.test/api/searchhistory', { headers: response.forwarded });
  assert.equal((await f.auth.getVerifiedAuthInfo(forwarded)).uid, FIRST);
  assert.equal((await f.auth.getVerifiedAuthInfo(request(upgraded.value))).uid, FIRST);
  assert.ok(response.forwarded.get('cookie').includes('preference=keep'));
  assert.equal((await proxy(request(upgraded.value))).cookies.get('user_auth'), undefined);
});

test('UUID aliases do not revive sessions after rename, username reuse, deletion or restored session epochs', async () => {
  const f = fixture();
  f.state.aliases.set(LEGACY_FIRST, FIRST);
  const oldCookie = f.auth.createSignedAuthCookie({ ...f.first, uid: LEGACY_FIRST });
  f.rename(FIRST, 'renamed');
  f.add(SECOND, 'alice');
  assert.equal(await f.auth.getVerifiedAuthInfo(request(oldCookie)), null);
  f.rename(FIRST, 'renamed_again');
  const renamedCookie = f.auth.createSignedAuthCookie({ ...f.state.identities.get(FIRST), uid: LEGACY_FIRST });
  assert.equal((await f.auth.getVerifiedAuthInfo(request(renamedCookie))).uid, FIRST);

  f.state.identities.delete(FIRST);
  f.state.users.delete(FIRST);
  assert.equal(await f.auth.getVerifiedAuthInfo(request(renamedCookie)), null);
  assert.equal(await f.auth.getVerifiedAuthInfo(request(oldCookie)), null);
  assert.equal((await f.auth.getVerifiedAuthInfo(request(f.auth.createSignedAuthCookie(f.state.identities.get(SECOND))))).uid, SECOND);

  f.add(FIRST, 'renamed_again');
  f.state.identities.get(FIRST).sessionVersion = 200;
  assert.equal(await f.auth.getVerifiedAuthInfo(request(renamedCookie)), null);
  assert.equal((await f.auth.getVerifiedAuthInfo(request(f.cookie()))).sessionVersion, 200);
});

test('password-reset generation requires a captured UID and never falls back to a numeric username', async () => {
  const f = fixture();
  f.rename(FIRST, SECOND);
  const tokens = f.load('password-reset-tokens.ts');
  await assert.rejects(tokens.generatePasswordResetToken(SECOND, 'alice@example.com'), /identity is unavailable/);
  assert.equal(f.state.cache.size, 0);
  const token = await tokens.generatePasswordResetToken(FIRST, 'alice@example.com');
  assert.equal(f.state.cache.get(`password_reset:${token}`).uid, FIRST);
});

test('a pre-migration UUID reset link follows only its original numeric identity', async () => {
  const f = fixture();
  const tokens = f.load('password-reset-tokens.ts');
  const token = await tokens.generatePasswordResetToken(FIRST, 'alice@example.com');
  // Simulate the token minted before numeric migration, with unchanged credentials.
  f.state.cache.get(`password_reset:${token}`).uid = LEGACY_FIRST;
  f.state.aliases.set(LEGACY_FIRST, FIRST);
  f.rename(FIRST, 'renamed');
  f.add(SECOND, 'alice');
  const response = await f.route('reset-password').POST(request(undefined, { token, password: 'new-fixture-password' }));
  assert.equal(response.status, 200);
  assert.deepEqual(f.state.calls, [['changePassword', FIRST, 'new-fixture-password']]);
});


test('favorite statistics count each UID once and do not read another account through a numeric username', async () => {
  const f = fixture();
  f.rename(FIRST, SECOND);
  f.add(SECOND, 'other_user');
  f.config.UserConfig.Users.push({ uid: OWNER, username: process.env.USERNAME, role: 'owner' });
  const counts = new Map([[OWNER, 1], [FIRST, 2], [SECOND, 3]]);
  f.db.getAllFavorites = async uid => {
    f.state.calls.push(['getAllFavorites', uid]);
    assert.ok(counts.has(uid), 'favorite statistics must query a captured UID');
    return Object.fromEntries(Array.from({ length: counts.get(uid) }, (_, index) => ['source+' + index, {}]));
  };
  const ownerCookie = f.auth.createSignedAuthCookie(f.state.identities.get(OWNER));
  const endpoint = f.route('favorites/stats');
  const response = await endpoint.GET(request(ownerCookie, undefined, '/api/favorites/stats'));
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(stats.summary.total_users, 3);
  assert.equal(stats.summary.total_favorites, 6);
  assert.equal(stats.users.find(user => user.uid === FIRST).count, 2);
  assert.equal(stats.users.find(user => user.uid === FIRST).username, SECOND);
  assert.equal(f.state.calls.filter(([, uid]) => uid === OWNER).length, 1);

  f.state.calls.length = 0;
  f.config.UserConfig.Users.find(user => user.uid === SECOND).banned = true;
  const filtered = await (await endpoint.GET(request(ownerCookie))).json();
  assert.equal(filtered.summary.total_users, 2);
  assert.equal(filtered.summary.total_favorites, 3);
  assert.equal(f.state.calls.some(([, uid]) => uid === SECOND), false);
});


test('admin Emby actions use the verified numeric UID and cannot borrow another account role through a numeric username', async () => {
  const f = fixture();
  f.config.SiteConfig.EnableEmby = true;
  f.rename(FIRST, SECOND);
  f.add(SECOND, 'other_user');
  const userProfile = f.config.UserConfig.Users.find(user => user.uid === FIRST);
  const otherProfile = f.config.UserConfig.Users.find(user => user.uid === SECOND);
  userProfile.role = 'admin';
  f.state.users.get(FIRST).role = 'admin';
  const endpoint = f.route('admin/emby');
  const unsigned = encodeURIComponent(JSON.stringify({ username: process.env.USERNAME, role: 'owner' }));
  assert.equal((await endpoint.POST(request(unsigned, { action: 'clearCache' }))).status, 401);
  assert.equal(f.state.embyCacheClears, 0);
  assert.equal((await endpoint.POST(request(f.cookie(), { action: 'clearCache' }))).status, 200);
  assert.equal(f.state.embyCacheClears, 1);

  userProfile.role = 'user';
  f.state.users.get(FIRST).role = 'user';
  otherProfile.role = 'admin';
  f.state.users.get(SECOND).role = 'admin';
  assert.equal((await endpoint.POST(request(f.cookie(), { action: 'clearCache' }))).status, 401);
  assert.equal(f.state.embyCacheClears, 1);
});

test('TVBox token edits resolve old UUID targets and never fall back from an unknown UID to a username', async () => {
  const f = fixture();
  f.state.aliases.set(LEGACY_FIRST, FIRST);
  const ownerCookie = f.auth.createSignedAuthCookie(f.state.identities.get(OWNER));
  const endpoint = f.route('admin/user-tvbox-token');
  const profile = f.config.UserConfig.Users.find(user => user.uid === FIRST);
  const updated = await endpoint.POST(request(ownerCookie, { targetUid: LEGACY_FIRST, regenerateToken: true, tvboxEnabledSources: ['source'] }));
  assert.equal(updated.status, 200);
  assert.equal(profile.tvboxToken, (await updated.json()).token);
  assert.deepEqual(profile.tvboxEnabledSources, ['source']);
  assert.equal(f.state.savedConfigs.length, 1);

  assert.equal((await endpoint.POST(request(ownerCookie, { targetUid: LEGACY_SECOND, username: 'alice', regenerateToken: true }))).status, 404);
  assert.equal((await endpoint.DELETE(request(ownerCookie, undefined, '/api/admin/user-tvbox-token?targetUid=' + LEGACY_SECOND + '&username=alice', 'DELETE'))).status, 404);
  assert.equal((await endpoint.POST(request(ownerCookie, { targetUid: '', username: 'alice' }))).status, 400);
  assert.equal(f.state.savedConfigs.length, 1);

  assert.equal((await endpoint.DELETE(request(ownerCookie, undefined, '/api/admin/user-tvbox-token?targetUid=' + LEGACY_FIRST, 'DELETE'))).status, 200);
  assert.equal(profile.tvboxToken, undefined);
  assert.equal(f.state.savedConfigs.length, 2);
});

test('an administrator can edit their own token through a UUID alias but cannot edit another administrator', async () => {
  const f = fixture();
  f.state.aliases.set(LEGACY_FIRST, FIRST);
  f.state.aliases.set(LEGACY_SECOND, SECOND);
  f.add(SECOND, 'other_admin');
  for (const uid of [FIRST, SECOND]) {
    f.config.UserConfig.Users.find(user => user.uid === uid).role = 'admin';
    f.state.users.get(uid).role = 'admin';
  }
  const endpoint = f.route('admin/user-tvbox-token');
  assert.equal((await endpoint.POST(request(f.cookie(), { targetUid: LEGACY_FIRST, regenerateToken: true }))).status, 200);
  assert.equal((await endpoint.POST(request(f.cookie(), { targetUid: LEGACY_SECOND, regenerateToken: true }))).status, 403);
  assert.equal(f.state.savedConfigs.length, 1);
});
