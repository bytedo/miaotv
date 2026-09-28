const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createIdentityFixture } = require('./user-identity-fixture.cjs');

function configValue(requireApproval = false, requireInviteCode = false) {
  return {
    ConfigFile: '{}',
    ConfigSubscribtion: { URL: '', AutoUpdate: false, LastCheck: '' },
    SiteConfig: { SiteName: 'isolated-cache-fixture' },
    UserConfig: {
      AllowRegister: true,
      RequireApproval: requireApproval,
      RequireInviteCode: requireInviteCode,
      Users: [],
    },
    SourceConfig: [],
    CustomCategories: [],
    LiveConfig: [],
  };
}

function requirements(config) {
  return {
    approval: config.UserConfig.RequireApproval,
    invite: config.UserConfig.RequireInviteCode,
  };
}

function fixture(t, extraOverrides = {}) {
  const state = { stored: configValue(), nextRead: null, readError: null };
  const identities = createIdentityFixture(() => state.stored.UserConfig.Users);
  const db = {
    ...identities,
    async getAdminConfig() {
      // A storage read owns its snapshot even when its response is delayed.
      const snapshot = structuredClone(state.stored);
      const error = state.readError;
      const gate = state.nextRead;
      state.nextRead = null;
      if (gate) {
        gate.started();
        await gate.ready;
      }
      if (error) throw error;
      return snapshot;
    },
    async saveAdminConfig(config) {
      state.stored = structuredClone(config);
    },
    async getAllUsers() {
      return state.stored.UserConfig.Users.map(user => user.username);
    },
    async getUserEmail(reference) {
      return identities.findUser(reference)?.email || null;
    },
    async getUserInfoV2(reference) {
      return identities.findUser(reference) || null;
    },
  };
  const overrides = {
    '@/lib/db': { db },
    './db': { db },
    'next/cache': { unstable_noStore() {} },
    ...extraOverrides,
  };
  // Separate loaders reproduce separately bundled API and SSR module copies.
  const load = createSourceLoader(overrides);
  const api = load('config.ts');
  const serverPage = createSourceLoader(overrides)('config.ts');
  const requests = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Configuration cache tests must not access the network');
  });
  t.mock.method(console, 'error', () => {});
  t.after(() => assert.equal(requests.mock.callCount(), 0));

  function holdNextRead() {
    let started;
    let release;
    const began = new Promise((resolve) => {
      started = resolve;
    });
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    state.nextRead = { started, ready };
    t.after(release);
    return { began, release };
  }

  async function warmBoth() {
    for (const config of await Promise.all([
      api.getConfig(),
      serverPage.getConfig(),
    ])) {
      assert.deepEqual(requirements(config), {
        approval: false,
        invite: false,
      });
    }
  }

  return { api, serverPage, db, state, holdNextRead, warmBoth, load };
}

test('configuration drafts cannot change cached account policy or source settings before persistence', async t => {
  const { api, state } = fixture(t);
  state.stored.UserConfig.Users = [{ username: 'applicant', role: 'user', pending: true }];
  state.stored.SourceConfig = [{ key: 'films', api: 'https://media.example.test', disabled: true }];
  const draft = await api.getConfig();
  draft.UserConfig.Users.find(user => user.username === 'applicant').pending = false;
  draft.SourceConfig[0].disabled = false;

  const current = await api.getConfig();
  assert.equal(current.UserConfig.Users.find(user => user.username === 'applicant').pending, true);
  assert.equal(current.SourceConfig[0].disabled, true);
  current.UserConfig.AllowRegister = false;
  assert.equal((await api.getConfig()).UserConfig.AllowRegister, true);
  assert.equal(state.stored.UserConfig.Users[0].pending, true);
});

test('callers sharing an in-flight configuration read receive independent editable snapshots', async t => {
  const { api, holdNextRead } = fixture(t);
  const gate = holdNextRead();
  const first = api.getConfig();
  await gate.began;
  const second = api.getConfig();
  gate.release();
  const [one, two] = await Promise.all([first, second]);
  one.UserConfig.RequireApproval = true;
  assert.equal(two.UserConfig.RequireApproval, false);
  assert.equal((await api.getConfig()).UserConfig.RequireApproval, false);
});

test('failed approval persistence leaves the cached account pending and sends no email', async t => {
  const previousOwner = process.env.USERNAME;
  const previousStorage = process.env.NEXT_PUBLIC_STORAGE_TYPE;
  process.env.USERNAME = 'review-owner';
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = previousOwner;
    if (previousStorage === undefined) delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
    else process.env.NEXT_PUBLIC_STORAGE_TYPE = previousStorage;
  });
  let notifications = 0;
  const { api, state, db, load } = fixture(t, {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/auth.server': { getVerifiedAuthInfo: async () => ({ username: 'review-owner' }) },
    '@/lib/emailService': {
      sendApprovalEmail: async () => { notifications++; },
      sendRejectionEmail: async () => { notifications++; },
    },
  });
  state.stored.UserConfig.Users = [{ username: 'applicant', role: 'user', pending: true, email: 'applicant@example.test' }];
  await api.getConfig();
  t.mock.method(db, 'saveAdminConfig', async () => { throw new Error('Isolated failed write'); });
  const response = await load('../app/api/admin/user/route.ts').POST({
    json: async () => ({ action: 'approve', targetUsername: 'applicant' }),
  });
  assert.equal(response.status, 500);
  assert.equal((await api.getConfig()).UserConfig.Users.find(user => user.username === 'applicant').pending, true);
  assert.equal(state.stored.UserConfig.Users[0].pending, true);
  assert.equal(notifications, 0);
});

test('configuration upgrades retain the environment owner profile even without a stored password row', async t => {
  const previousOwner = process.env.USERNAME;
  process.env.USERNAME = 'review-owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = previousOwner;
  });
  const { api, state, db } = fixture(t);
  const owner = {
    username: 'review-owner', role: 'owner', banned: false,
    email: 'owner@example.test', createdAt: 123, source: 'legacy-profile',
    enabledApis: ['films'], tags: ['limited'], tvboxToken: 'fixture-owner-token',
    tvboxEnabledSources: ['films'], showAdultContent: false,
    embyConfig: { sources: [{ key: 'fixture-emby', enabled: false, ServerURL: 'https://media.example.test' }] },
  };
  state.stored.UserConfig.Users = [owner, { username: 'member', role: 'user' }];
  t.mock.method(db, 'getAllUsers', async () => ['member']);
  const upgraded = await api.getConfig();
  const restored = upgraded.UserConfig.Users.find(user => user.username === 'review-owner');
  for (const [key, value] of Object.entries(owner)) assert.deepEqual(restored[key], value, key);
  assert.deepEqual(state.stored.UserConfig.Users[0], owner);
});

test('loading retired settings omits their credentials without rewriting storage or widening source access', async t => {
  const { api, state } = fixture(t);
  Object.assign(state.stored, {
    AIRecommendConfig: { enabled: true, apiKey: 'retired-fixture-ai-key' },
    YouTubeConfig: { enabled: true, apiKey: 'retired-fixture-video-key' },
    BilibiliConfig: { enabled: true, sessdata: 'retired-fixture-cookie' },
    TelegramAuthConfig: { enabled: true, botToken: 'retired-fixture-bot-key' },
    WatchRoomConfig: { enabled: true, serverUrl: 'https://room.example.test', authKey: 'retired-fixture-room-key' },
    EmailConfig: { enabled: false, smtpPass: 'retained-fixture-password' },
    WebhookConfig: { enabled: false, secret: 'retained-fixture-signing-key' },
    SourceConfig: [{ key: 'films', name: 'Films', api: 'https://media.example.test', from: 'custom' }],
  });
  Object.assign(state.stored.SiteConfig, { EnableWebLive: false, EnableEmby: true, EnableBilibili: true, EnableYouTube: true, EnableWatchRoomScreen: true, EnableWatchRoomLive: true });
  state.stored.UserConfig.Users = [
    { username: 'legacy-restricted', role: 'user', enabledApis: ['ai-recommend'] },
    { username: 'tag-restricted', role: 'user', tags: ['old-group'] },
  ];
  state.stored.UserConfig.Tags = [{ name: 'old-group', enabledApis: ['youtube-search'] }];
  const before = structuredClone(state.stored);
  const active = await api.getConfig();
  for (const key of ['AIRecommendConfig', 'YouTubeConfig', 'BilibiliConfig', 'TelegramAuthConfig', 'WatchRoomConfig'])
    assert.equal(Object.hasOwn(active, key), false);
  assert.equal(Object.hasOwn(active.SiteConfig, 'EnableBilibili'), false);
  assert.equal(Object.hasOwn(active.SiteConfig, 'EnableYouTube'), false);
  assert.equal(Object.hasOwn(active.SiteConfig, 'EnableWatchRoomScreen'), false);
  assert.equal(Object.hasOwn(active.SiteConfig, 'EnableWatchRoomLive'), false);
  assert.equal(JSON.stringify(active).includes('retired-fixture-room-key'), false);
  assert.equal(active.SiteConfig.EnableWebLive, false);
  assert.equal(active.SiteConfig.EnableEmby, true);
  assert.equal(active.EmailConfig.smtpPass, 'retained-fixture-password');
  assert.equal(active.WebhookConfig.secret, 'retained-fixture-signing-key');
  assert.deepEqual(await api.getAvailableApiSites('legacy-restricted'), []);
  assert.deepEqual(await api.getAvailableApiSites('tag-restricted'), []);
  assert.deepEqual(state.stored, before);
});

test('clearing the API configuration cache immediately refreshes a separately loaded server page', async (t) => {
  const { api, serverPage, db, warmBoth } = fixture(t);
  await warmBoth();
  await db.saveAdminConfig(configValue(true, true));

  api.clearConfigCache();

  assert.deepEqual(requirements(await serverPage.getConfig()), {
    approval: true,
    invite: true,
  });
  assert.deepEqual(requirements(await api.getConfig()), {
    approval: true,
    invite: true,
  });
});

test('publishing persisted configuration immediately refreshes other module copies', async (t) => {
  const { api, serverPage, db, warmBoth } = fixture(t);
  await warmBoth();
  const updated = configValue(true, true);
  await db.saveAdminConfig(updated);

  await api.setCachedConfig(updated);

  assert.deepEqual(requirements(await serverPage.getConfig()), {
    approval: true,
    invite: true,
  });
  assert.deepEqual(requirements(await api.getConfig()), {
    approval: true,
    invite: true,
  });
});

test('a delayed save receipt cannot republish an older snapshot over newer persisted registration rules', async (t) => {
  const { api, serverPage, db, warmBoth } = fixture(t);
  await warmBoth();

  let acknowledge;
  let markCommitted;
  const receipt = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const committed = new Promise((resolve) => {
    markCommitted = resolve;
  });
  const save = db.saveAdminConfig;
  let delayFirstReceipt = true;
  t.mock.method(db, 'saveAdminConfig', async (config) => {
    const delayReceipt = delayFirstReceipt;
    delayFirstReceipt = false;
    await save(config);
    if (delayReceipt) {
      markCommitted();
      await receipt;
    }
  });

  const older = configValue(true, false);
  const olderWrite = (async () => {
    await db.saveAdminConfig(older);
    await api.setCachedConfig(older);
  })();
  await committed;

  try {
    await db.saveAdminConfig(configValue(true, true));
    serverPage.clearConfigCache();
    for (const config of await Promise.all([
      api.getConfig(),
      serverPage.getConfig(),
    ])) {
      assert.deepEqual(requirements(config), {
        approval: true,
        invite: true,
      });
    }

    // The old write was persisted first but acknowledged after the newer write.
    acknowledge();
    await olderWrite;

    for (const config of await Promise.all([
      api.getConfig(),
      serverPage.getConfig(),
    ])) {
      assert.deepEqual(requirements(config), {
        approval: true,
        invite: true,
      });
    }
  } finally {
    acknowledge();
    await Promise.allSettled([olderWrite]);
  }
});

for (const publish of ['clearConfigCache', 'setCachedConfig']) {
  test(`${publish} prevents an older in-flight read from returning or restoring stale registration rules`, async (t) => {
    const { api, serverPage, db, holdNextRead, warmBoth } = fixture(t);
    await warmBoth();
    serverPage.clearConfigCache();
    const gate = holdNextRead();
    const oldRead = serverPage.getConfig();
    await gate.began;
    let nextRead;
    try {
      const updated = configValue(true, true);
      await db.saveAdminConfig(updated);
      if (publish === 'setCachedConfig') await api.setCachedConfig(updated);
      else api.clearConfigCache();

      // A current result is already available before the old response arrives.
      assert.deepEqual(requirements(await api.getConfig()), {
        approval: true,
        invite: true,
      });
      nextRead = serverPage.getConfig();
      gate.release();

      for (const config of await Promise.all([oldRead, nextRead])) {
        assert.deepEqual(requirements(config), {
          approval: true,
          invite: true,
        });
      }
      for (const config of await Promise.all([
        api.getConfig(),
        serverPage.getConfig(),
      ])) {
        assert.deepEqual(requirements(config), {
          approval: true,
          invite: true,
        });
      }
    } finally {
      gate.release();
      await Promise.allSettled([oldRead, nextRead]);
    }
  });
}

test('a failed read after cross-module invalidation never falls back to superseded registration rules', async (t) => {
  const { api, serverPage, db, state, warmBoth } = fixture(t);
  await warmBoth();
  await db.saveAdminConfig(configValue(true, true));
  api.clearConfigCache();
  state.readError = new Error('isolated configuration store unavailable');

  await assert.rejects(
    serverPage.getConfig(),
    /isolated configuration store unavailable/,
  );

  state.readError = null;
  assert.deepEqual(requirements(await serverPage.getConfig()), {
    approval: true,
    invite: true,
  });
  assert.deepEqual(requirements(await api.getConfig()), {
    approval: true,
    invite: true,
  });
});


test('config normalization preserves account restrictions when an old UUID profile resolves to a numeric identity', async t => {
  const { api, db, state } = fixture(t);
  const oldUid = '00000000-0000-4000-8000-000000000042';
  state.stored.UserConfig.Users = [{ uid: oldUid, username: 'restricted', role: 'admin', banned: true, pending: true, enabledApis: ['limited'], tags: ['review'] }];
  const getIdentity = db.getUserIdentity;
  t.mock.method(db, 'getUserIdentity', async username => username === 'restricted'
    ? { uid: '42', username, storageKey: username, sessionVersion: 7, legacyUids: [oldUid] }
    : getIdentity(username));
  const config = await api.getConfig();
  const user = config.UserConfig.Users.find(user => user.username === 'restricted');
  assert.equal(user.uid, '42');
  assert.equal(user.role, 'admin');
  assert.equal(user.banned, true);
  assert.equal(user.pending, true);
  assert.deepEqual(user.enabledApis, ['limited']);
  assert.deepEqual(user.tags, ['review']);
  assert.equal(state.stored.UserConfig.Users[0].uid, oldUid, 'normalization is read-only');
});

test('cached UUID configuration snapshots reload as numeric UIDs before policy readers reuse them', async t => {
  const { api, serverPage, db, state } = fixture(t);
  const oldUid = '00000000-0000-4000-8000-000000000042';
  state.stored.UserConfig.Users = [{ uid: oldUid, username: 'restricted', role: 'user', banned: true, enabledApis: ['limited'] }];
  const reads = t.mock.method(db, 'getAdminConfig', db.getAdminConfig);
  for (const config of await Promise.all([api.getConfig(), serverPage.getConfig()])) {
    assert.equal(config.UserConfig.Users.find(user => user.username === 'restricted').uid, oldUid);
  }
  // Another storage client performed the migration without a process cache hook.
  Object.assign(state.stored.UserConfig.Users[0], { uid: '42', legacyUids: [oldUid] });
  for (const config of await Promise.all([api.getConfig(), serverPage.getConfig()])) {
    const user = config.UserConfig.Users.find(user => user.username === 'restricted');
    assert.equal(user.uid, '42');
    assert.equal(user.banned, true);
    assert.deepEqual(user.enabledApis, ['limited']);
  }
  const count = reads.mock.callCount();
  await api.getConfig();
  await serverPage.getConfig();
  assert.equal(reads.mock.callCount(), count, 'canonical numeric cache hits do not query storage again');
});

test('an obsolete UUID cache is not used as a fallback when the canonical storage reload fails', async t => {
  const { api, state } = fixture(t);
  const oldUid = '00000000-0000-4000-8000-000000000042';
  state.stored.UserConfig.Users = [{ uid: oldUid, username: 'restricted', role: 'user', banned: true }];
  await api.getConfig();
  state.readError = new Error('Fixture canonical reload unavailable');
  await assert.rejects(api.getConfig(), /canonical reload unavailable/);
});

test('a vanished numeric username is never used to read another account by UID during config synchronization', async t => {
  const { api, db, state } = fixture(t);
  state.stored.UserConfig.Users = [
    { uid: '202', username: 'other_user', role: 'user', email: 'other@example.test' },
    { username: '202', role: 'user' },
  ];
  const getIdentity = db.getUserIdentity;
  t.mock.method(db, 'getUserIdentity', async username => username === '202' ? null : getIdentity(username));
  const emailReads = t.mock.method(db, 'getUserEmail', db.getUserEmail);
  const config = await api.getConfig();
  assert.equal(config.UserConfig.Users.some(user => user.username === '202'), false);
  assert.equal(config.UserConfig.Users.find(user => user.username === 'other_user').email, 'other@example.test');
  assert.equal(emailReads.mock.callCount(), 1, 'only the resolved account should be read');
  assert.equal(emailReads.mock.calls[0].arguments[0], '202');
});
