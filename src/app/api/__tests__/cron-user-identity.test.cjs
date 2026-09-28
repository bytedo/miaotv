const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');

// Execute the route with in-memory dependencies only. Never load .env or the DB.
process.env.USERNAME = 'fixture-owner';
const FIRST = '00000000-0000-4000-8000-000000000001';
const SECOND = '00000000-0000-4000-8000-000000000002';
const OWNER = '00000000-0000-4000-8000-000000000003';
const MISSING = '00000000-0000-4000-8000-000000000004';
const oldLogin = Date.now() - 30 * 24 * 60 * 60 * 1000;
const clone = (value) => structuredClone(value);

function fixture(t, { cleanup = false, refresh = true } = {}) {
  const state = {
    config: {
      UserConfig: {
        Users: [],
        AutoCleanupInactiveUsers: cleanup,
        InactiveUserDays: 7,
      },
      SiteConfig: { SiteName: 'fixture' },
      ConfigSubscribtion: { URL: '', AutoUpdate: false, LastCheck: '' },
      ConfigFile: '',
      SourceConfig: [],
      LiveConfig: [],
      CronConfig: {
        enableAutoRefresh: refresh,
        onlyRefreshRecent: false,
        onlyRefreshOngoing: false,
        recentDays: 7,
        maxRecordsPerRun: 100,
      },
    },
    identities: new Map(),
    records: new Map(),
    favorites: new Map(),
    stats: new Map(),
    calls: [],
    cacheKeys: [],
    savedConfigs: [],
    errors: [],
    identitySnapshots: 0,
    configInvalidations: 0,
    afterSnapshot: null,
    beforeDetail: null,
    beforeStats: null,
    beforeDelete: null,
    beforeLive: null,
    fetch: null,
  };
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', (...args) => state.errors.push(args));
  t.mock.method(globalThis, 'fetch', (...args) => {
    if (state.fetch) return state.fetch(...args);
    throw new Error('Network requests are forbidden in cron identity tests');
  });
  function add(uid, username, role = 'user') {
    state.identities.set(uid, { uid, username, storageKey: uid });
    state.config.UserConfig.Users.push({ uid, username, role });
    state.stats.set(uid, { lastLoginTime: Date.now(), loginCount: 2 });
  }
  function rename(uid, username) {
    state.identities.get(uid).username = username;
    for (const user of state.config.UserConfig.Users) {
      if (user.uid === uid) user.username = username;
    }
  }
  function uidCall(method, uid, ...args) {
    assert.match(uid, /^[0-9a-f-]{36}$/, `${method} must use UID`);
    state.calls.push([method, uid, ...clone(args)]);
  }
  const db = {
    getAllUserIdentities: async () => {
      state.identitySnapshots++;
      const users = clone([...state.identities.values()]);
      if (state.afterSnapshot) {
        const run = state.afterSnapshot;
        state.afterSnapshot = null;
        await run();
      }
      return users;
    },
    getAllUsers: async () => {
      throw new Error('Cron must enumerate identities, not mutable usernames');
    },
    getUserIdentity: async () => {
      throw new Error('Cron must not re-resolve a captured identity by username');
    },
    getUserIdentityByUid: async (uid) => {
      uidCall('getUserIdentityByUid', uid);
      return clone(state.identities.get(uid) || null);
    },
    checkUserExist: async (uid) => {
      uidCall('checkUserExist', uid);
      return state.identities.has(uid);
    },
    getAllPlayRecords: async (uid) => {
      uidCall('getAllPlayRecords', uid);
      return clone(state.records.get(uid) || {});
    },
    getAllFavorites: async (uid) => {
      uidCall('getAllFavorites', uid);
      return clone(state.favorites.get(uid) || {});
    },
    savePlayRecordsBatch: async (uid, updates) => {
      uidCall('savePlayRecordsBatch', uid, updates);
      assert.ok(state.identities.has(uid));
      const records = state.records.get(uid) || {};
      for (const { source, id, record } of updates) {
        records[`${source}+${id}`] = clone(record);
      }
      state.records.set(uid, records);
    },
    saveFavoritesBatch: async (uid, updates) => {
      uidCall('saveFavoritesBatch', uid, updates);
      assert.ok(state.identities.has(uid));
      const favorites = state.favorites.get(uid) || {};
      for (const { source, id, favorite } of updates) {
        favorites[`${source}+${id}`] = clone(favorite);
      }
      state.favorites.set(uid, favorites);
    },
    getUserPlayStat: async (uid) => {
      uidCall('getUserPlayStat', uid);
      const stats = clone(state.stats.get(uid));
      if (state.beforeStats) {
        const run = state.beforeStats;
        state.beforeStats = null;
        await run(uid);
      }
      return stats;
    },
    deleteUser: async (uid) => {
      uidCall('deleteUser', uid);
      if (state.beforeDelete) await state.beforeDelete(uid);
      state.identities.delete(uid);
      state.records.delete(uid);
      state.favorites.delete(uid);
      state.stats.delete(uid);
      // Account deletion does not mutate the separately persisted admin config.
    },
    saveAdminConfig: async (config) => {
      state.savedConfigs.push(clone(config));
      state.config = clone(config);
    },
  };
  const cacheValues = new Map();
  const cronCache = {
    clear: () => cacheValues.clear(),
    delete: (key) => cacheValues.delete(key),
    set: (key, value) => cacheValues.set(key, clone(value)),
    wrap: async (key, fetcher) => {
      state.cacheKeys.push(key);
      if (cacheValues.has(key)) return clone(cacheValues.get(key));
      const value = await fetcher();
      cacheValues.set(key, clone(value));
      return clone(value);
    },
  };
  const load = createSourceLoader({
    '@/lib/db': { db },
    '@/lib/config': {
      getConfig: async () => clone(state.config),
      clearConfigCache: () => state.configInvalidations++,
      refineConfig: (config) => config,
    },
    'next/server': { NextRequest: Request, NextResponse: Response },
    '@/lib/server-cache': { cronCache },
    '@/lib/blobStorage': {
      getSpiderJarFromBlob: async () => {
        throw new Error('Blob access is forbidden in cron identity tests');
      },
      uploadSpiderJarToBlob: async () => {
        throw new Error('Blob upload is forbidden in cron identity tests');
      },
    },
    '@/lib/spiderJar': { getSpiderJar: async () => ({ success: false }) },
    '@/lib/live': {
      refreshLiveChannels: async (live) => {
        if (state.beforeLive) await state.beforeLive(live);
        return 7;
      },
    },
    '@/lib/fetchVideoDetail': {
      fetchVideoDetail: async ({ source, id, fallbackTitle }) => {
        if (state.beforeDetail) {
          const run = state.beforeDetail;
          state.beforeDetail = null;
          await run();
        }
        return {
          source,
          id,
          title: fallbackTitle,
          episodes: ['fixture-episode-1', 'fixture-episode-2'],
        };
      },
    },
    '@/lib/performance-monitor': {
      recordRequest() {},
      resetDbQueryCount() {},
      getDbQueryCount: () => 0,
    },
    '@/lib/video-cache': {
      cleanupExpiredCache: async () => {},
      validateCacheSize: async () => {},
    },
  });
  add(OWNER, process.env.USERNAME, 'owner');
  add(FIRST, 'alice');
  const route = load(path.resolve(__dirname, '..', 'cron', 'route.ts'));
  return {
    state,
    add,
    rename,
    async run() {
      const response = await route.GET(new Request('https://offline.test/api/cron'));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).success, true);
      return clone(global.currentCronStats);
    },
  };
}

function media(totalEpisodes = 1) {
  return {
    title: 'Fixture series',
    source_name: 'fixture',
    cover: '',
    year: '2026',
    index: 1,
    total_episodes: totalEpisodes,
    play_time: 10,
    total_time: 100,
    save_time: Date.now(),
    search_title: 'Fixture series',
  };
}

function assertUidCacheKeys(state) {
  const perUserKeys = state.cacheKeys.filter((key) => key !== 'cron:all_users');
  assert.ok(perUserKeys.length > 0);
  for (const key of perUserKeys) {
    assert.match(key, /^cron:(user_exists|user_stats|play_records|favorites):[0-9a-f-]{36}$/);
  }
}

test('record and favorite refresh stay on UID after rename and username reuse during detail fetch', async (t) => {
  const f = fixture(t);
  f.state.records.set(FIRST, { 'source+record': media() });
  f.state.favorites.set(FIRST, { 'source+favorite': media() });
  f.state.beforeDetail = async () => {
    f.rename(FIRST, 'renamed');
    f.add(SECOND, 'alice');
    f.state.records.set(SECOND, { 'source+record': media(99) });
    f.state.favorites.set(SECOND, { 'source+favorite': media(99) });
  };

  const stats = await f.run();
  assert.equal(f.state.records.get(FIRST)['source+record'].total_episodes, 2);
  assert.equal(f.state.favorites.get(FIRST)['source+favorite'].total_episodes, 2);
  assert.equal(f.state.records.get(SECOND)['source+record'].total_episodes, 99);
  assert.equal(f.state.favorites.get(SECOND)['source+favorite'].total_episodes, 99);
  assert.deepEqual(
    f.state.calls.filter(([method]) => method.startsWith('save')).map(([method, uid]) => [method, uid]),
    [['savePlayRecordsBatch', FIRST], ['saveFavoritesBatch', FIRST]],
  );
  assert.equal(f.state.calls.some(([, uid]) => uid === SECOND), false);
  assert.equal(f.state.identitySnapshots, 1);
  assert.equal(stats.tasks.recordsAndFavorites.recordsErrors, 0);
  assert.equal(stats.tasks.recordsAndFavorites.favoritesErrors, 0);
  assertUidCacheKeys(f.state);
  assert.deepEqual(f.state.errors, []);
});

test('a deleted identity in the snapshot never falls through to a newly registered username', async (t) => {
  const f = fixture(t);
  f.state.afterSnapshot = async () => {
    f.state.identities.delete(FIRST);
    f.add(SECOND, 'alice');
    f.state.records.set(SECOND, { 'source+record': media() });
  };
  await f.run();
  assert.equal(f.state.calls.some(([method]) => method.startsWith('save')), false);
  assert.equal(f.state.calls.some(([, uid]) => uid === SECOND), false);
  assert.equal(f.state.calls.some(([method, uid]) => method === 'getAllPlayRecords' && uid === FIRST), false);
  assert.equal(f.state.records.get(SECOND)['source+record'].total_episodes, 1);
  assert.deepEqual(f.state.errors, []);
});

test('inactive cleanup deletes a captured UID once and preserves a reused username and its config', async (t) => {
  const f = fixture(t, { cleanup: true });
  f.state.stats.set(FIRST, { lastLoginTime: oldLogin, loginCount: 2 });
  f.state.config.UserConfig.Users.push({ uid: FIRST, username: 'alice', role: 'user' });
  f.state.beforeStats = async (uid) => {
    assert.equal(uid, FIRST);
    f.rename(FIRST, 'renamed');
    f.add(SECOND, 'alice');
    f.state.config.SiteConfig.SiteName = 'concurrent-update';
  };

  const stats = await f.run();
  assert.deepEqual(f.state.calls.filter(([method]) => method === 'deleteUser'), [['deleteUser', FIRST]]);
  assert.equal(f.state.identities.has(FIRST), false);
  assert.equal(f.state.identities.has(SECOND), true);
  assert.deepEqual(
    f.state.config.UserConfig.Users.map(({ uid, username }) => ({ uid, username })),
    [{ uid: OWNER, username: process.env.USERNAME }, { uid: SECOND, username: 'alice' }],
  );
  assert.equal(f.state.config.SiteConfig.SiteName, 'concurrent-update');
  assert.equal(stats.tasks.userCleanup.deleted, 1);
  assert.equal(stats.tasks.userCleanup.errors, 0);
  assert.equal(f.state.calls.some(([method, uid]) => method === 'getAllPlayRecords' && uid === FIRST), false);
  assert.equal(f.state.calls.some(([, uid]) => uid === SECOND), false);
  assertUidCacheKeys(f.state);
  assert.deepEqual(f.state.errors, []);
});

test('cleanup leaves unresolved config rows untouched instead of looking up a reused name', async (t) => {
  const f = fixture(t, { cleanup: true, refresh: false });
  f.state.stats.set(FIRST, { lastLoginTime: oldLogin, loginCount: 2 });
  f.state.config.UserConfig.Users = [
    { uid: OWNER, username: process.env.USERNAME, role: 'owner' },
    { username: 'alice', role: 'user' },
    { uid: MISSING, username: 'ghost', role: 'user' },
  ];
  const stats = await f.run();
  assert.equal(f.state.calls.some(([method]) => method === 'deleteUser'), false);
  assert.equal(f.state.identities.has(FIRST), true);
  assert.equal(f.state.savedConfigs.length, 0);
  assert.equal(stats.tasks.userCleanup.deleted, 0);
  assert.equal(stats.tasks.userCleanup.errors, 0);
  assert.deepEqual(f.state.errors, []);
});

test('cleanup removes only successfully deleted UIDs from the latest config', async (t) => {
  const f = fixture(t, { cleanup: true, refresh: false });
  f.add(SECOND, 'bob');
  f.state.stats.set(FIRST, { lastLoginTime: oldLogin, loginCount: 2 });
  f.state.stats.set(SECOND, { lastLoginTime: oldLogin, loginCount: 2 });
  f.state.beforeDelete = async (uid) => {
    if (uid === FIRST) throw new Error('Fixture deletion failed');
  };
  const stats = await f.run();
  assert.equal(f.state.identities.has(FIRST), true);
  assert.equal(f.state.identities.has(SECOND), false);
  assert.deepEqual(f.state.config.UserConfig.Users.map(({ uid }) => uid), [OWNER, FIRST]);
  assert.equal(stats.tasks.userCleanup.deleted, 1);
  assert.equal(stats.tasks.userCleanup.errors, 1);
});

test('live refresh merges channel counts into the config updated while upstream work was pending', async (t) => {
  const f = fixture(t, { refresh: false });
  f.state.config.LiveConfig = [{ key: 'fixture-live', name: 'Fixture', url: 'https://live.test/list', channelNumber: 1 }];
  f.state.beforeLive = async () => {
    f.rename(FIRST, 'renamed');
    f.add(SECOND, 'alice');
    f.state.config.SiteConfig.SiteName = 'new-site-name';
  };
  await f.run();
  assert.deepEqual(f.state.config.UserConfig.Users.map(({ uid }) => uid), [OWNER, FIRST, SECOND]);
  assert.equal(f.state.config.UserConfig.Users.find(({ uid }) => uid === FIRST).username, 'renamed');
  assert.equal(f.state.config.SiteConfig.SiteName, 'new-site-name');
  assert.equal(f.state.config.LiveConfig[0].channelNumber, 7);
  assert.equal(f.state.savedConfigs.length, 1);
  assert.equal(f.state.configInvalidations, 1);
  assert.deepEqual(f.state.errors, []);
});

test('subscription refresh preserves concurrent UID and user configuration changes', async (t) => {
  const f = fixture(t, { refresh: false });
  const content = JSON.stringify({ api_site: {} });
  f.state.config.ConfigSubscribtion = { URL: 'https://subscription.test/config', AutoUpdate: true, LastCheck: '' };
  f.state.fetch = async (url) => {
    assert.equal(url, 'https://subscription.test/config');
    f.rename(FIRST, 'renamed');
    f.add(SECOND, 'alice');
    const bs58 = require('bs58').default;
    return new Response(bs58.encode(Buffer.from(content)));
  };
  await f.run();
  assert.deepEqual(f.state.config.UserConfig.Users.map(({ uid }) => uid), [OWNER, FIRST, SECOND]);
  assert.equal(f.state.config.UserConfig.Users.find(({ uid }) => uid === FIRST).username, 'renamed');
  assert.equal(f.state.config.ConfigFile, content);
  assert.ok(f.state.config.ConfigSubscribtion.LastCheck);
  assert.equal(f.state.savedConfigs.length, 1);
  assert.equal(f.state.configInvalidations, 1);
  assert.deepEqual(f.state.errors, []);
});
