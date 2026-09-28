// These tests load the actual backup handlers with an in-memory SQLite facade.
// Application database constructors, .env files and external services never load.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { test } = require('node:test');
const { loadSource, createSourceLoader } = require('./storage-test-loader.cjs');
const {
  accountProfile,
  readAccountBackup,
  prepareAccountRestore,
  assignAccountRestoreUids,
} = loadSource('account-backup.ts');
const { encodeStoredCredential } = loadSource('password.ts');
const { isNumericUserUid } = loadSource('user-identity.ts');
const { SqliteStorage } = loadSource('sqlite.db.ts');
const { createIdentityStorage } = loadSource('identity-facade.ts');
const { SimpleCrypto } = loadSource('crypto.ts');

const backupPassword = 'offline-backup-fixture';
const encodedCredential = encodeStoredCredential('original-fixture-password');
const account = (uid, profile = {}, extra = {}) => ({
  version: 1,
  credential: encodedCredential,
  email: null,
  profile: { ...(uid === undefined ? {} : { uid }), role: 'user', ...profile },
  ...extra,
});
const modernUser = (uid, username, profile = {}, extra = {}) => ({
  uid,
  username,
  account: account(uid, profile),
  ...extra,
});
const document = (userData, users = [], schemaVersion = 3) => ({
  schemaVersion,
  timestamp: '2026-09-22T00:00:00.000Z',
  data: { adminConfig: { UserConfig: { Users: users } }, userData },
});
const record = {
  title: 'backup-fixture',
  source_name: 'fixture-source',
  cover: '',
  year: '2026',
  index: 1,
  total_episodes: 2,
  play_time: 45,
  total_time: 300,
  save_time: 123456,
  search_title: 'backup-fixture',
};

function encodeDocument(value) {
  return SimpleCrypto.encrypt(
    gzipSync(JSON.stringify(value)).toString('base64'),
    backupPassword,
  );
}
function decodeDocument(value) {
  return JSON.parse(
    gunzipSync(
      Buffer.from(SimpleCrypto.decrypt(value, backupPassword), 'base64'),
    ).toString(),
  );
}
function importRequest(value) {
  const encrypted = encodeDocument(value);
  return {
    formData: async () =>
      new Map([
        ['password', backupPassword],
        ['file', { text: async () => encrypted }],
      ]),
  };
}

function memoryFixture(t, hooks = {}) {
  const previous = Object.fromEntries(
    ['IS_BUILD_PHASE', 'NEXT_PUBLIC_STORAGE_TYPE', 'USERNAME'].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.IS_BUILD_PHASE = 'true';
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'sqlite';
  process.env.USERNAME = 'admin';
  const raw = new SqliteStorage();
  t.after(() => {
    raw.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const storage = createIdentityStorage(raw, () => 'admin');
  const events = [];
  const db = new Proxy(storage, {
    get(target, property) {
      if (property === 'storage') return storage;
      if (property === 'getAllPlayRecords')
        return async (uid) => {
          if (hooks.beforeRead) await hooks.beforeRead(uid, storage);
          return storage.getAllPlayRecords(uid);
        };
      if (property === 'saveAdminConfig')
        return (value) => storage.setAdminConfig(value);
      if (property === 'clearAllData')
        return async () => {
          events.push(['clear']);
          return storage.clearAllData();
        };
      if (property === 'createUserV2')
        return async (...args) => {
          events.push(['create', args[0], args[7]]);
          return storage.createUserV2(...args);
        };
      return Reflect.get(target, property);
    },
  });
  const load = createSourceLoader({
    '@/lib/db': { db },
    '@/lib/auth.server': {
      getVerifiedAuthInfo: async () => storage.getUserIdentity('admin'),
    },
    '@/lib/config': {
      configSelfCheck: async (config) => config,
      setCachedConfig: async () => {
        events.push(['cache']);
      },
    },
    'next/server': { NextResponse: Response },
  });
  return {
    raw,
    storage,
    events,
    importRoute: load('../app/api/admin/data_migration/import/route.ts'),
    exportRoute: load('../app/api/admin/data_migration/export/route.ts'),
  };
}

test('schema 3 preserves the same numeric UID in the index, user row, account profile and configuration', () => {
  const uid = '42';
  const profile = {
    uid,
    role: 'admin',
    pending: true,
    tags: ['group'],
    createdAt: 42,
  };
  const user = modernUser(uid, '新名字', profile);
  const accounts = prepareAccountRestore({ [uid]: user }, 3, [
    { username: '新名字', ...profile },
  ]);
  assert.equal(accounts.size, 1);
  assert.equal(accounts.get('新名字').profile.uid, uid);
  assert.equal(accounts.get('新名字').credential, encodedCredential);
  assert.equal(accounts.get('新名字').profile.pending, true);
  assert.equal(readAccountBackup(user, 3).profile.uid, uid);
  assert.equal(accountProfile(profile).uid, uid);
});

test('legacy backups receive distinct numeric IDs after validation without mutating the input', async (t) => {
  const { storage } = memoryFixture(t);
  for (const schemaVersion of [undefined, 1, 2]) {
    const values =
      schemaVersion === 2
        ? {
            first: { account: account(undefined) },
            second: { account: account(undefined) },
          }
        : {
            first: { password: 'first-password' },
            second: { password: 'second-password' },
          };
    const before = JSON.stringify(values);
    const accounts = prepareAccountRestore(values, schemaVersion, []);
    assert.ok(
      [...accounts.values()].every((entry) => entry.profile.uid === undefined),
    );
    await assignAccountRestoreUids(accounts, (uid) =>
      storage.allocateUserUid(uid),
    );
    const ids = [...accounts.values()].map((entry) => entry.profile.uid);
    assert.ok(ids.every(isNumericUserUid));
    assert.equal(new Set(ids).size, 2);
    assert.equal(JSON.stringify(values), before);
  }
  const uid = randomUUID();
  assert.equal(
    prepareAccountRestore({ legacy: { password: 'fixture-password' } }, 1, [
      { username: 'legacy', uid, role: 'user' },
    ]).get('legacy').profile.uid,
    uid,
  );
  assert.equal(
    prepareAccountRestore({ legacy: { account: account(uid) } }, 2, []).get(
      'legacy',
    ).profile.uid,
    uid,
  );
});

test('mixed backups reserve supplied numbers before allocating UUID aliases and missing IDs', async (t) => {
  const { storage } = memoryFixture(t);
  const oldUid = randomUUID();
  const values = {
    missing: { account: account(undefined) },
    legacy: { account: account(oldUid) },
    numbered: { account: account('600') },
  };
  const accounts = prepareAccountRestore(values, 2, []);
  await assignAccountRestoreUids(accounts, (uid) =>
    storage.allocateUserUid(uid),
  );
  assert.equal(accounts.get('numbered').profile.uid, '600');
  const legacyUid = accounts.get('legacy').profile.uid;
  const missingUid = accounts.get('missing').profile.uid;
  assert.ok(BigInt(legacyUid) > 600n);
  assert.ok(BigInt(missingUid) > BigInt(legacyUid));
  assert.equal(await storage.allocateUserUid(oldUid), legacyUid);
  assert.equal(await storage.getUserIdentity('missing'), null);
  assert.equal(await storage.getUserIdentityByUid(legacyUid), null);
});

test('schema 3 rejects malformed or conflicting UID fields and duplicate usernames', () => {
  const one = randomUUID();
  const two = randomUUID();
  const cases = [
    { [one]: { ...modernUser(one, 'person'), uid: two } },
    { [one]: { ...modernUser(one, 'person'), uid: undefined } },
    { [one]: { ...modernUser(one, 'person'), account: account(two) } },
    { [one]: { ...modernUser(one, 'person'), account: account(undefined) } },
    { 'not-a-uid': modernUser(one, 'person') },
    {
      [one]: modernUser(one, 'same_name'),
      [two]: modernUser(two, 'same_name'),
    },
  ];
  for (const values of cases)
    assert.throws(() => prepareAccountRestore(values, 3, []));
  assert.throws(
    () =>
      prepareAccountRestore({ [one]: modernUser(one, 'person') }, 3, [
        { username: 'person', uid: two, role: 'user' },
      ]),
    /UID 不一致/,
  );
});

test('duplicate UIDs in legacy accounts or configured profiles are rejected', () => {
  const uid = randomUUID();
  assert.throws(
    () =>
      prepareAccountRestore(
        {
          first: { account: account(uid) },
          second: { account: account(uid) },
        },
        2,
        [],
      ),
    /重复 UID/,
  );
  assert.throws(
    () =>
      prepareAccountRestore({}, 3, [
        { username: 'first', uid, role: 'user' },
        { username: 'second', uid, role: 'user' },
      ]),
    /重复 UID/,
  );
});

test('the current owner UID cannot be assigned to another name and only the configured owner keeps owner role', () => {
  const ownerUid = randomUUID();
  assert.throws(
    () =>
      prepareAccountRestore(
        {
          [ownerUid]: modernUser(ownerUid, 'intruder'),
        },
        3,
        [],
        'admin',
        ownerUid,
      ),
    /不能使用站长 UID/,
  );
  const foreignUid = randomUUID();
  const foreign = prepareAccountRestore(
    {
      [foreignUid]: modernUser(foreignUid, 'foreign_owner', { role: 'owner' }),
    },
    3,
    [],
    'admin',
    ownerUid,
  ).get('foreign_owner');
  assert.equal(foreign.profile.role, 'user');
  const owner = prepareAccountRestore(
    { admin: { password: 'fixture-password' } },
    1,
    [],
    'admin',
    ownerUid,
  ).get('admin');
  assert.equal(
    owner.profile.role,
    'owner',
    'legacy owner without a role must remain restorable',
  );
});

test('actual import rejects every UID conflict before clearing an existing in-memory account', async (t) => {
  const { storage, importRoute, events } = memoryFixture(t);
  await storage.registerUser('sentinel', 'original-fixture-password');
  const sentinel = await storage.getUserIdentity('sentinel');
  await storage.setPlayRecord(sentinel.uid, 'source+movie', record);
  const owner = await storage.getUserIdentity('admin');
  const one = randomUUID();
  const two = randomUUID();
  const invalidDocuments = [
    document({ [one]: { ...modernUser(one, 'person'), uid: two } }),
    document({
      [one]: { ...modernUser(one, 'person'), account: account(two) },
    }),
    document({ [one]: modernUser(one, 'person') }, [
      { username: 'person', uid: two, role: 'user' },
    ]),
    document(
      { first: { account: account(one) }, second: { account: account(one) } },
      [],
      2,
    ),
    document({
      [one]: modernUser(one, 'same_name'),
      [two]: modernUser(two, 'same_name'),
    }),
    document({ [owner.uid]: modernUser(owner.uid, 'intruder') }),
    document({ [one]: modernUser(one, '') }),
  ];
  for (const value of invalidDocuments) {
    const response = await importRoute.POST(importRequest(value));
    assert.equal(response.status, 400, JSON.stringify(await response.json()));
    assert.equal(
      events.some(([event]) => event === 'clear'),
      false,
    );
    assert.deepEqual(
      await storage.getUserIdentityByUid(sentinel.uid),
      sentinel,
    );
    assert.equal(
      (await storage.getPlayRecord(sentinel.uid, 'source+movie')).title,
      record.title,
    );
  }
});

test('canonical alias collisions are rejected before clearing, even after the original account was deleted', async (t) => {
  for (const deleted of [false, true]) {
    await t.test(deleted ? 'retired alias' : 'active alias', async (t) => {
      const { storage, importRoute, events } = memoryFixture(t);
      await storage.registerUser('sentinel', 'fixture-password');
      const sentinel = await storage.getUserIdentity('sentinel');
      await storage.setPlayRecord(sentinel.uid, 'source+movie', record);
      const oldUid = randomUUID();
      await storage.createUserV2(
        'alias_member',
        'fixture-password',
        'user',
        undefined,
        undefined,
        undefined,
        undefined,
        { uid: oldUid },
      );
      const original = await storage.getUserIdentity('alias_member');
      if (deleted) await storage.deleteUser(original.uid);
      const response = await importRoute.POST(
        importRequest(
          document({
            [oldUid]: modernUser(oldUid, 'first'),
            [original.uid]: modernUser(original.uid, 'second'),
          }),
        ),
      );
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /重复 UID/);
      assert.equal(
        events.some(([event]) => event === 'clear'),
        false,
      );
      assert.equal(
        (await storage.getPlayRecord(sentinel.uid, 'source+movie')).title,
        record.title,
      );
      assert.equal(await storage.allocateUserUid(oldUid), original.uid);
    });
  }
});

test('the owner legacy UUID cannot be reassigned to a different name by importing an old backup', async (t) => {
  const { storage, importRoute, events } = memoryFixture(t);
  const oldUid = randomUUID();
  await storage.createUserV2(
    'admin',
    'fixture-owner-password',
    'owner',
    undefined,
    undefined,
    undefined,
    undefined,
    { uid: oldUid },
  );
  const owner = await storage.getUserIdentity('admin');
  const response = await importRoute.POST(
    importRequest(document({ [oldUid]: modernUser(oldUid, 'intruder') })),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /不能使用站长 UID/);
  assert.equal(
    events.some(([event]) => event === 'clear'),
    false,
  );
  assert.equal((await storage.getUserIdentity('admin')).uid, owner.uid);
});

test('an old UUID backup restores to the permanent numeric ID and advances subsequent registrations', async (t) => {
  const { storage, importRoute } = memoryFixture(t);
  const owner = await storage.getUserIdentity('admin');
  const oldUid = randomUUID();
  await storage.createUserV2(
    'legacy_member',
    'fixture-password',
    'user',
    undefined,
    undefined,
    undefined,
    undefined,
    { uid: oldUid },
  );
  const original = await storage.getUserIdentity('legacy_member');
  const response = await importRoute.POST(
    importRequest(
      document({
        [owner.uid]: modernUser(owner.uid, 'admin', { role: 'owner' }),
        [oldUid]: modernUser(
          oldUid,
          'restored_member',
          {},
          { playRecords: { 'source+movie': record } },
        ),
        900: modernUser('900', 'numbered_member'),
      }),
    ),
  );
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  const restored = await storage.getUserIdentity('restored_member');
  assert.equal(restored.uid, original.uid);
  assert.ok(isNumericUserUid(restored.uid));
  assert.ok(restored.legacyUids.includes(oldUid));
  assert.equal((await storage.getUserIdentityByUid(oldUid)).uid, restored.uid);
  assert.equal(
    (await storage.getPlayRecord(restored.uid, 'source+movie')).play_time,
    record.play_time,
  );
  assert.equal(
    await storage.verifyUser(restored.uid, 'original-fixture-password'),
    true,
  );
  await storage.registerUser('next_member', 'fixture-password');
  assert.ok(BigInt((await storage.getUserIdentity('next_member')).uid) > 900n);
});

test('actual schema 3 export and import preserve UID, renamed profiles and data through the real storage facade', async (t) => {
  const { raw, storage, events, importRoute, exportRoute } = memoryFixture(t);
  await raw.createUserV2(
    'old_name',
    'original-fixture-password',
    'admin',
    ['group'],
    'fixture-sub',
    ['source'],
    'member@example.com',
  );
  const original = await storage.getUserIdentity('old_name');
  const owner = await storage.getUserIdentity('admin');
  await storage.renameUser(original.uid, '新的名字');
  const current = await storage.getUserIdentityByUid(original.uid);
  await storage.setAdminConfig({
    UserConfig: {
      Users: [
        { uid: owner.uid, username: 'admin', role: 'owner' },
        {
          uid: current.uid,
          username: current.username,
          role: 'admin',
          tags: ['group'],
          tvboxToken: 'fixture-tvbox-token',
        },
      ],
    },
  });
  await storage.setPlayRecord(current.uid, 'source+movie', record);
  await storage.setFavorite(current.uid, 'source+movie', record);
  await storage.setReminder(current.uid, 'source+movie', {
    ...record,
    releaseDate: '2026-10-01',
  });
  await storage.addSearchHistory(current.uid, 'first');
  await storage.addSearchHistory(current.uid, 'second');
  await storage.setSkipConfig(current.uid, 'source', 'movie', {
    start: 5,
    end: 9,
  });
  const credential = await storage.getUserCredential(current.uid);
  const response = await exportRoute.POST({
    json: async () => ({ password: backupPassword }),
  });
  assert.equal(response.status, 200);
  const exported = decodeDocument(await response.text());
  assert.equal(exported.schemaVersion, 3);
  assert.deepEqual(
    Object.keys(exported.data.userData).sort(),
    [current.uid, owner.uid].sort(),
  );
  assert.equal(exported.data.userData[current.uid].uid, current.uid);
  assert.equal(exported.data.userData[current.uid].username, '新的名字');
  assert.equal(
    exported.data.userData[current.uid].account.profile.uid,
    current.uid,
  );
  assert.equal(
    exported.data.userData[current.uid].account.credential,
    credential,
  );
  await storage.registerUser('discard_restore', 'fixture-password');
  const result = await importRoute.POST(importRequest(exported));
  assert.equal(result.status, 200, JSON.stringify(await result.json()));
  assert.equal(events.filter(([event]) => event === 'clear').length, 1);
  assert.ok(
    events
      .filter(([event]) => event === 'create')
      .every(([, , metadata]) => metadata.allowLegacyUsername === true),
  );
  const restored = await storage.getUserIdentity('新的名字');
  assert.equal(restored.uid, current.uid);
  assert.ok(restored.sessionVersion > current.sessionVersion);
  assert.notEqual(restored.storageKey, current.storageKey);
  assert.equal((await storage.getUserIdentity('admin')).uid, owner.uid);
  assert.equal(await storage.getUserIdentity('discard_restore'), null);
  assert.equal(await storage.getUserCredential(restored.uid), credential);
  assert.equal(
    await storage.verifyUser(restored.uid, 'original-fixture-password'),
    true,
  );
  assert.equal(
    await storage.getUsernameByEmail('member@example.com'),
    '新的名字',
  );
  assert.equal(await storage.getUserByOidcSub('fixture-sub'), '新的名字');
  assert.equal(
    (await storage.getPlayRecord(restored.uid, 'source+movie')).play_time,
    45,
  );
  assert.equal(
    (await storage.getFavorite(restored.uid, 'source+movie')).title,
    record.title,
  );
  assert.equal(
    (await storage.getReminder(restored.uid, 'source+movie')).releaseDate,
    '2026-10-01',
  );
  assert.deepEqual((await storage.getSearchHistory(restored.uid)).sort(), [
    'first',
    'second',
  ]);
  assert.deepEqual(
    await storage.getSkipConfig(restored.uid, 'source', 'movie'),
    { start: 5, end: 9 },
  );
  const profile = (await storage.getAdminConfig()).UserConfig.Users.find(
    (user) => user.uid === restored.uid,
  );
  assert.equal(profile.role, 'admin');
  assert.equal(profile.tvboxToken, 'fixture-tvbox-token');
});

test('actual legacy import restores unusual historical usernames and an owner without explicit role', async (t) => {
  const { storage, importRoute } = memoryFixture(t);
  const values = {
    admin: { password: 'owner-fixture-password' },
    'legacy[1]': {
      password: 'original-fixture-password',
      playRecords: { 'source+movie': record },
    },
    x: { password: 'short-name-password' },
    'with-hyphen': { password: 'hyphen-password' },
  };
  const response = await importRoute.POST(
    importRequest(document(values, [], 1)),
  );
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  const identities = await Promise.all(
    Object.keys(values).map((name) => storage.getUserIdentity(name)),
  );
  assert.ok(identities.every((identity) => isNumericUserUid(identity?.uid)));
  assert.equal(
    new Set(identities.map((identity) => identity.uid)).size,
    identities.length,
  );
  const legacy = await storage.getUserIdentity('legacy[1]');
  assert.equal(
    await storage.verifyUser(legacy.uid, 'original-fixture-password'),
    true,
  );
  assert.equal(
    (await storage.getPlayRecord(legacy.uid, 'source+movie')).title,
    record.title,
  );
  await assert.rejects(
    storage.registerUser('new[1]', 'fixture-password'),
    (error) => error.code === 'INVALID_USERNAME',
  );
  await assert.rejects(
    storage.createUserV2(
      'new[2]',
      'fixture-password',
      'user',
      [],
      undefined,
      [],
      undefined,
      { uid: randomUUID() },
    ),
    (error) => error.code === 'INVALID_USERNAME',
    'a supplied UID alone must not bypass username validation',
  );
  await assert.rejects(
    storage.renameUser(legacy.uid, 'another[1]'),
    (error) => error.code === 'INVALID_USERNAME',
  );
});

test('export rejects an account rename and old-name reuse while its UID snapshot is being read', async (t) => {
  let original;
  let changed = false;
  const { storage, exportRoute } = memoryFixture(t, {
    beforeRead: async (uid, currentStorage) => {
      if (uid !== original.uid || changed) return;
      changed = true;
      await currentStorage.renameUser(original.uid, 'renamed');
      await currentStorage.registerUser('member', 'replacement-password');
    },
  });
  await storage.registerUser('member', 'fixture-password');
  original = await storage.getUserIdentity('member');
  await storage.setAdminConfig({
    UserConfig: {
      Users: [{ uid: original.uid, username: 'member', role: 'user' }],
    },
  });
  await storage.setPlayRecord(original.uid, 'source+movie', record);
  const response = await exportRoute.POST({
    json: async () => ({ password: backupPassword }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /重新导出/);
  const replacement = await storage.getUserIdentity('member');
  assert.notEqual(replacement.uid, original.uid);
  assert.deepEqual(await storage.getAllPlayRecords(replacement.uid), {});
  assert.equal(
    (await storage.getPlayRecord(original.uid, 'source+movie')).title,
    record.title,
  );
});
