// Real identity facade and HMAC verification with an in-memory SQLite backend.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource, createSourceLoader } = require('./storage-test-loader.cjs');
const { SqliteStorage } = loadSource('sqlite.db.ts');
const { createIdentityStorage } = loadSource('identity-facade.ts');

function fixture(t) {
  const environment = {
    IS_BUILD_PHASE: 'true', NEXT_PUBLIC_STORAGE_TYPE: 'sqlite', USERNAME: 'admin',
    PASSWORD: 'offline-admin-access-fixture',
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const raw = new SqliteStorage();
  t.after(() => {
    raw.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(console, 'log', () => {});
  const storage = createIdentityStorage(raw, () => 'admin');
  const state = {
    calls: [], beforeDataRead: null, afterIdentityLookup: null,
    config: {
      UserConfig: { Users: [] },
      TVBoxSecurityConfig: { enableAuth: true, token: 'global-fixture-token' },
    },
  };
  const db = new Proxy(storage, {
    get(target, property) {
      if (property === 'getUserIdentity') return async username => {
        state.calls.push([property, username]);
        const identity = await storage.getUserIdentity(username);
        if (state.afterIdentityLookup) await state.afterIdentityLookup(username, identity);
        return identity;
      };
      if (['getUserInfoV2', 'checkUserExist', 'getUserPlayStat', 'getAllPlayRecords'].includes(property)) {
        return async (...args) => {
          state.calls.push([property, args[0]]);
          if (state.beforeDataRead) await state.beforeDataRead(property, args[0]);
          return storage[property](...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
  const load = createSourceLoader({
    './db': { db }, '@/lib/db': { db },
    './config': { getConfig: async () => state.config },
    '@/lib/config': { getConfig: async () => state.config },
    '@/lib/blobStorage': { getSpiderJarFromBlob: async () => null, uploadSpiderJarToBlob: async () => null },
    '@/lib/spiderJar': {
      getCandidates: () => [],
      getSpiderJar: async () => ({ buffer: Buffer.alloc(0), md5: 'fixture-md5', size: 0, success: false, cached: true, source: 'fallback', tried: 0 }),
    },
    'next/server': { NextResponse: Response },
  });
  const auth = load('auth.server.ts');
  const tvbox = load('proxy-tvbox.ts');
  const stats = load('../app/api/admin/play-stats/route.ts');
  const request = cookie => ({
    cookies: { get: name => name === 'user_auth' && cookie ? { value: cookie } : undefined },
  });
  const signed = identity => request(auth.createSignedAuthCookie(identity));
  const profile = (identity, extra = {}) => ({ uid: identity.uid, username: identity.username, role: 'user', ...extra });
  const tvboxRequest = token => new Request(`https://miaotv.test/api/tvbox?token=${encodeURIComponent(token)}`);
  const create = async (username, role = 'user', metadata) => {
    await storage.createUserV2(username, 'fixture-password', role, [], undefined, [], undefined, metadata);
    return storage.getUserIdentity(username);
  };
  return { raw, storage, state, request, signed, profile, tvboxRequest, create, load, ...tvbox, stats };
}

const record = (title, playTime) => ({
  title, source_name: 'fixture-source', cover: '', year: '2026', index: 1,
  total_episodes: 1, play_time: playTime, total_time: 1000, save_time: Date.now(), search_title: title,
});
const denied = error => error?.status === 403;

test('TVBox token follows its UID after a rename even when the cached username belongs to somebody else', async t => {
  const { storage, state, create, profile, tvboxRequest, authorizeTVBoxRequest } = fixture(t);
  const original = await create('shared_name');
  state.config.UserConfig.Users = [profile(original, { tvboxToken: 'original-token', tvboxEnabledSources: ['private-source'] })];
  await storage.renameUser(original.uid, 'renamed');
  const replacement = await create('shared_name');
  state.calls = [];
  const result = await authorizeTVBoxRequest(tvboxRequest('original-token'));
  assert.equal(result.currentUser.uid, original.uid);
  assert.equal(result.currentUser.username, 'renamed');
  assert.deepEqual(result.currentUser.tvboxEnabledSources, ['private-source']);
  assert.ok(state.calls.some(([method, uid]) => method === 'getUserInfoV2' && uid === original.uid));
  assert.ok(state.calls.some(([method, uid]) => method === 'checkUserExist' && uid === original.uid));
  assert.ok(!state.calls.some(([, uid]) => uid === replacement.uid || uid === 'shared_name'));
});

test('TVBox cannot use a replacement account to bypass a banned or deleted UID', async t => {
  const { storage, state, create, profile, tvboxRequest, authorizeTVBoxRequest } = fixture(t);
  const original = await create('shared_name', 'user', { banned: true });
  state.config.UserConfig.Users = [profile(original, { tvboxToken: 'original-token' })];
  await storage.renameUser(original.uid, 'renamed');
  const replacement = await create('shared_name');
  await assert.rejects(authorizeTVBoxRequest(tvboxRequest('original-token')), denied);
  await storage.deleteUser(original.uid);
  state.calls = [];
  await assert.rejects(authorizeTVBoxRequest(tvboxRequest('original-token')), denied);
  assert.ok(!state.calls.some(([, uid]) => uid === replacement.uid || uid === 'shared_name'));
});

test('TVBox subscription keeps the verified UID group permissions when cached usernames cross after renames', async t => {
  const { storage, state, create, profile, load } = fixture(t);
  const requests = [];
  t.mock.method(global, 'fetch', async url => {
    requests.push(String(url));
    return Response.json({ class: [] });
  });
  const original = await create('alpha');
  const other = await create('beta');
  const originalProfile = profile(original, { tags: ['deny'], tvboxToken: 'alpha-token' });
  state.config.UserConfig.Users = [
    originalProfile,
    profile(other, { tags: ['allow'], tvboxToken: 'beta-token' }),
  ];
  state.config.UserConfig.Tags = [
    { name: 'deny', showAdultContent: false },
    { name: 'allow', showAdultContent: true },
  ];
  state.config.SiteConfig = { ShowAdultContent: false };
  state.config.SourceConfig = [
    { key: 'public_source', name: 'Public', api: 'https://public.fixture.test/api.php' },
    { key: 'restricted_source', name: 'Restricted', api: 'https://restricted.fixture.test/api.php', is_adult: true },
  ];
  await storage.renameUser(other.uid, 'gamma');
  await storage.renameUser(original.uid, 'beta');
  const subscription = load('../app/api/tvbox/route.ts');
  const sourceKeys = async token => {
    const response = await subscription.GET(new Request(`https://miaotv.test/api/tvbox?token=${token}&mode=min`));
    assert.equal(response.status, 200);
    return (await response.json()).sites.map(site => site.key);
  };

  assert.deepEqual(await sourceKeys('alpha-token'), ['public_source']);
  assert.deepEqual(await sourceKeys('beta-token'), ['public_source', 'restricted_source']);
  // The existing user > group > global precedence still applies after renames.
  originalProfile.showAdultContent = true;
  assert.deepEqual(await sourceKeys('alpha-token'), ['public_source', 'restricted_source']);
  originalProfile.showAdultContent = false;
  originalProfile.tags = ['allow'];
  assert.deepEqual(await sourceKeys('alpha-token'), ['public_source']);
  assert.equal(requests.length, 6);
});

test('legacy TVBox profiles resolve to UID once and retired names never acquire replacement accounts', async t => {
  const { storage, state, create, tvboxRequest, authorizeTVBoxRequest } = fixture(t);
  const original = await create('legacy_name');
  state.config.UserConfig.Users = [{ username: 'legacy_name', role: 'user', tvboxToken: 'legacy-token' }];
  state.calls = [];
  assert.equal((await authorizeTVBoxRequest(tvboxRequest('legacy-token'))).currentUser.uid, original.uid);
  assert.equal(state.calls.filter(([method]) => method === 'getUserIdentity').length, 1);
  assert.ok(state.calls.some(([method, uid]) => method === 'getUserInfoV2' && uid === original.uid));
  await storage.renameUser(original.uid, 'renamed');
  await create('legacy_name');
  state.calls = [];
  await assert.rejects(authorizeTVBoxRequest(tvboxRequest('legacy-token')), denied);
  assert.equal(state.calls.filter(([method]) => method === 'getUserInfoV2' || method === 'checkUserExist').length, 0);
});

test('legacy TVBox resolution detects a rename and reuse during identity lookup', async t => {
  const { storage, state, create, tvboxRequest, authorizeTVBoxRequest } = fixture(t);
  const original = await create('legacy_name');
  state.config.UserConfig.Users = [{ username: 'legacy_name', role: 'user', tvboxToken: 'legacy-token' }];
  state.afterIdentityLookup = async () => {
    state.afterIdentityLookup = null;
    await storage.renameUser(original.uid, 'renamed');
    await create('legacy_name');
  };
  await assert.rejects(authorizeTVBoxRequest(tvboxRequest('legacy-token')), denied);
  assert.equal(state.calls.filter(([method]) => method === 'getUserInfoV2').length, 0);
});

test('admin statistics reject unsigned owner claims and signed ordinary-user role forgeries', async t => {
  const { storage, state, create, profile, request, signed, stats } = fixture(t);
  const member = await create('member');
  state.config.UserConfig.Users = [profile(member)];
  for (const cookie of [
    { username: 'admin', role: 'owner', trustedNetwork: true },
    { uid: member.uid, username: 'admin', role: 'owner', authVersion: 2, signature: '0'.repeat(64) },
  ]) {
    assert.equal((await stats.GET(request(JSON.stringify(cookie)))).status, 401);
  }
  assert.equal((await stats.GET(signed(member))).status, 401);
  assert.equal(state.calls.filter(([method]) => ['getAllPlayRecords', 'getUserPlayStat'].includes(method)).length, 0);
  const owner = await storage.getUserIdentity('admin');
  assert.equal((await stats.GET(signed(owner))).status, 200);
});

test('admin statistics reject banned, pending and deleted administrator identities', async t => {
  const { storage, state, create, profile, signed, stats } = fixture(t);
  const admin = await create('manager', 'admin');
  const entry = profile(admin, { role: 'admin' });
  state.config.UserConfig.Users = [entry];
  for (const flag of ['banned', 'pending']) {
    entry[flag] = true;
    assert.equal((await stats.GET(signed(admin))).status, 401);
    delete entry[flag];
  }
  const stale = signed(admin);
  await storage.deleteUser(admin.uid);
  await create('manager', 'admin');
  assert.equal((await stats.GET(stale)).status, 401);
  assert.equal(state.calls.filter(([method]) => ['getAllPlayRecords', 'getUserPlayStat'].includes(method)).length, 0);
});

test('statistics label and read each current UID while a cached name has been reused', async t => {
  const { storage, state, create, profile, signed, stats } = fixture(t);
  const original = await create('shared_name');
  const originalProfile = profile(original);
  await storage.setPlayRecord(original.uid, 'source+old', record('original', 100));
  await storage.renameUser(original.uid, 'renamed');
  const replacement = await create('shared_name');
  await storage.setPlayRecord(replacement.uid, 'source+new', record('replacement', 700));
  state.config.UserConfig.Users = [originalProfile, profile(replacement)];
  const owner = await storage.getUserIdentity('admin');
  state.calls = [];
  const response = await stats.GET(signed(owner));
  assert.equal(response.status, 200);
  const result = await response.json();
  const old = result.userStats.find(user => user.uid === original.uid);
  const next = result.userStats.find(user => user.uid === replacement.uid);
  assert.equal(old.username, 'renamed');
  assert.equal(old.totalWatchTime, 100);
  assert.equal(next.username, 'shared_name');
  assert.equal(next.totalWatchTime, 700);
  assert.equal(result.totalUsers, 2);
  for (const [method, ref] of state.calls.filter(([method]) => ['getAllPlayRecords', 'getUserPlayStat'].includes(method))) {
    assert.ok([original.uid, replacement.uid].includes(ref), `${method} must use its captured UID`);
  }
});

test('statistics keep captured UIDs when a rename and name reuse occur immediately before their queries', async t => {
  const { storage, state, create, profile, signed, stats } = fixture(t);
  const original = await create('shared_name');
  await storage.setPlayRecord(original.uid, 'source+old', record('original', 100));
  state.config.UserConfig.Users = [profile(original)];
  const owner = await storage.getUserIdentity('admin');
  let mutation;
  state.beforeDataRead = async method => {
    if (!['getAllPlayRecords', 'getUserPlayStat'].includes(method)) return;
    mutation ??= (async () => {
      await storage.renameUser(original.uid, 'renamed');
      const replacement = await create('shared_name');
      await storage.setPlayRecord(replacement.uid, 'source+new', record('replacement', 900));
    })();
    await mutation;
  };
  const response = await stats.GET(signed(owner));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.userStats[0].uid, original.uid);
  assert.equal(result.userStats[0].totalWatchTime, 100);
  assert.equal(result.userStats[0].recentRecords[0].title, 'original');
});

test('statistics discard deleted UID rows and ambiguous legacy profiles without following recycled names', async t => {
  const { storage, state, create, profile, signed, stats } = fixture(t);
  const original = await create('shared_name');
  const originalProfile = profile(original);
  await storage.deleteUser(original.uid);
  const replacement = await create('shared_name');
  await storage.setPlayRecord(replacement.uid, 'source+new', record('replacement', 900));
  const owner = await storage.getUserIdentity('admin');
  state.config.UserConfig.Users = [originalProfile, { username: 'shared_name', role: 'user' }];
  state.calls = [];
  const response = await stats.GET(signed(owner));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.totalUsers, 0);
  assert.deepEqual(result.userStats, []);
  assert.equal(state.calls.filter(([method]) => ['getAllPlayRecords', 'getUserPlayStat'].includes(method)).length, 0);
});
