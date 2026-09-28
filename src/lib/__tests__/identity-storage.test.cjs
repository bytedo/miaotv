const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { loadSource } = require('./storage-test-loader.cjs');
const { SqliteStorage } = loadSource('sqlite.db.ts');
const { createIdentityStorage } = loadSource('identity-facade.ts');
const { isUserUid, isNumericUserUid, validateUsername } = loadSource('user-identity.ts');

function fixture(t, initialOwner) {
  const previous = process.env.IS_BUILD_PHASE;
  process.env.IS_BUILD_PHASE = 'true';
  let raw;
  try { raw = new SqliteStorage(); }
  finally {
    if (previous === undefined) delete process.env.IS_BUILD_PHASE;
    else process.env.IS_BUILD_PHASE = previous;
  }
  t.after(() => raw.close());
  t.mock.method(console, 'log', () => {});
  let owner = initialOwner;
  const wrap = () => createIdentityStorage(raw, () => owner);
  return { raw, storage: wrap(), wrap, setOwner(value) { owner = value; } };
}

const record = {
  title: 'fixture', source_name: 'source', cover: '', year: '2026', index: 1,
  total_episodes: 1, play_time: 60, total_time: 600, save_time: 100000, search_title: 'fixture',
};
const config = users => ({ UserConfig: { Users: users } });
const hasCode = code => error => error?.code === code;

test('UID adoption persists across facades and concurrent V1/V2 enumeration without rewriting credentials', async t => {
  const { raw, storage, wrap } = fixture(t);
  await raw.registerUser('旧用户', 'fixture-password', 'legacy@example.com');
  await raw.createUserV2('v2_user', 'fixture-password', 'admin', ['group'], 'oidc-sub');
  const credential = await raw.getUserCredential('旧用户');
  const attempts = await Promise.all(Array.from({ length: 10 }, () => wrap().getUserIdentity('旧用户')));
  assert.ok(isUserUid(attempts[0].uid));
  assert.equal(new Set(attempts.map(identity => identity.uid)).size, 1);
  assert.equal(attempts[0].storageKey, '旧用户');
  assert.deepEqual(await wrap().getUserIdentityByUid(attempts[0].uid), attempts[0]);
  assert.deepEqual((await storage.getAllUsers()).sort(), ['v2_user', '旧用户'].sort());
  assert.equal((await storage.getUserIdentity('v2_user')).storageKey, 'v2_user');
  assert.equal(await raw.getUserCredential('旧用户'), credential);
  assert.equal(await raw.getUserInfoV2('旧用户'), null, 'UID adoption must not fabricate a V2 profile');
});

test('renaming preserves every per-user collection, bindings, stats and the exact credential', async t => {
  const { raw, storage } = fixture(t);
  await raw.createUserV2('before', 'fixture-password', 'admin', ['group'], 'oidc-sub', ['source'], 'mail@example.com');
  await raw.setPlayRecord('before', 'source+movie', record);
  await raw.setFavorite('before', 'source+movie', record);
  await raw.setReminder('before', 'source+movie', record);
  await raw.addSearchHistory('before', 'query');
  await raw.setSkipConfig('before', 'source', 'movie', { start: 10 });
  await raw.saveEpisodeSkipConfig('before', 'source', 'movie', { segments: [{ start: 1, end: 2 }] });
  await raw.saveUserEmbyConfig('before', { sources: [{ key: 'private-source' }] });
  await raw.updateUserLoginStats('before', 100000, true, { ip: '127.0.0.1' });
  await raw.setAdminConfig(config([{ username: 'before', role: 'admin', tags: ['group'], tvboxToken: 'fixture-token' }]));
  const identity = await storage.getUserIdentity('before');
  const credential = await storage.getUserCredential(identity.uid);
  const renamed = await storage.renameUser(identity.uid, '新名字', 'before');
  assert.deepEqual(renamed, { ...identity, username: '新名字', sessionVersion: identity.sessionVersion + 1 });
  assert.equal(await storage.getUserIdentity('before'), null);
  assert.equal(await storage.isLegacyUsernameRetired('before'), true);
  assert.equal(await storage.verifyUser('新名字', 'fixture-password'), true);
  assert.equal(await storage.verifyUser(identity.uid, 'fixture-password'), true);
  assert.equal(await storage.getUserCredential(identity.uid), credential);
  assert.equal(await storage.getUsernameByEmail('mail@example.com'), '新名字');
  assert.equal(await storage.getUserByOidcSub('oidc-sub'), '新名字');
  for (const getter of ['getAllPlayRecords', 'getAllFavorites', 'getAllReminders']) {
    assert.deepEqual(await storage[getter](identity.uid), { 'source+movie': record });
  }
  assert.deepEqual(await storage.getSearchHistory(identity.uid), ['query']);
  assert.deepEqual(await storage.getSkipConfig(identity.uid, 'source', 'movie'), { start: 10 });
  assert.deepEqual(await storage.getEpisodeSkipConfig(identity.uid, 'source', 'movie'), { segments: [{ start: 1, end: 2 }] });
  assert.deepEqual(await storage.getUserEmbyConfig(identity.uid), { sources: [{ key: 'private-source' }] });
  const stat = await storage.getUserPlayStat(identity.uid);
  assert.equal(stat.uid, identity.uid);
  assert.equal(stat.username, '新名字');
  assert.equal(stat.loginCount, 1);
  assert.equal((await storage.getPlayStats()).userStats[0].username, '新名字');
  const profile = (await storage.getAdminConfig()).UserConfig.Users[0];
  assert.equal(profile.uid, identity.uid);
  assert.equal(profile.role, 'admin');
  assert.equal(profile.tvboxToken, 'fixture-token');
});

test('reusing a retired username creates a fresh UID and cannot inherit or redirect former data', async t => {
  const { raw, storage, wrap } = fixture(t);
  await raw.registerUser('alice', 'original-password');
  await raw.setPlayRecord('alice', 'source+movie', record);
  const original = await storage.getUserIdentity('alice');
  await storage.renameUser(original.uid, 'renamed');
  await storage.registerUser('alice', 'new-password');
  const replacement = await storage.getUserIdentity('alice');
  assert.notEqual(replacement.uid, original.uid);
  assert.equal(replacement.storageKey, `uid:${replacement.uid}`);
  assert.equal(await storage.verifyUser('alice', 'original-password'), false);
  assert.deepEqual(await storage.getAllPlayRecords(replacement.uid), {});
  await storage.setPlayRecord(original.uid, 'source+later', { ...record, title: 'in-flight original request' });
  assert.equal(Object.keys(await storage.getAllPlayRecords(original.uid)).length, 2);
  assert.deepEqual(await storage.getAllPlayRecords(replacement.uid), {});
  assert.deepEqual((await wrap().getAllUsers()).sort(), ['alice', 'renamed']);
  assert.equal(await storage.isLegacyUsernameRetired('alice'), true);
});

test('rename collision and stale-name checks do not change either identity', async t => {
  const { storage } = fixture(t);
  await storage.registerUser('first', 'fixture-password');
  await storage.registerUser('second', 'fixture-password');
  const first = await storage.getUserIdentity('first');
  await assert.rejects(storage.renameUser(first.uid, 'second'), hasCode('USERNAME_EXISTS'));
  await assert.rejects(storage.renameUser(first.uid, 'third', 'outdated'), hasCode('STALE_USERNAME'));
  assert.deepEqual(await storage.getUserIdentity('first'), first);
  assert.equal(await storage.getUserIdentity('third'), null);
  assert.equal(await storage.isLegacyUsernameRetired('first'), false);
  await assert.rejects(storage.renameUser('not-a-uid', 'valid'), hasCode('INVALID_UID'));
});

test('config reconciliation preserves legacy profiles, canonicalizes stale names, and rejects forged UID pairs', async t => {
  const { raw, storage } = fixture(t);
  await raw.registerUser('alice', 'fixture-password');
  await raw.setAdminConfig(config([{ username: 'alice', role: 'admin', tvboxToken: 'keep-me', tags: ['group'] }]));
  const stale = await storage.getAdminConfig();
  const original = await storage.getUserIdentity('alice');
  await storage.renameUser(original.uid, 'renamed');
  await storage.registerUser('alice', 'replacement-password');
  const replacement = await storage.getUserIdentity('alice');
  const loaded = (await storage.getAdminConfig()).UserConfig.Users[0];
  assert.equal(loaded.username, 'renamed');
  assert.equal(loaded.uid, original.uid);
  assert.equal(loaded.tvboxToken, 'keep-me');
  await storage.setAdminConfig(stale);
  assert.equal(stale.UserConfig.Users[0].username, 'renamed');
  await assert.rejects(storage.setAdminConfig(config([
    { username: 'renamed', uid: replacement.uid, role: 'admin' },
  ])), hasCode('IDENTITY_CONFLICT'));
  await assert.rejects(storage.setAdminConfig(config([
    { username: 'alice', uid: randomUUID(), role: 'owner' },
  ])), hasCode('IDENTITY_CONFLICT'));
  assert.equal((await storage.getAdminConfig()).UserConfig.Users[0].uid, original.uid);
});

test('owner identity persists without a credential and follows configured owner name without moving data', async t => {
  const { raw, storage, wrap, setOwner } = fixture(t, 'admin');
  const owner = await storage.getUserIdentity('admin');
  assert.ok(isUserUid(owner.uid));
  assert.equal(await raw.checkUserExist('admin'), false);
  assert.deepEqual(await wrap().getUserIdentity('admin'), owner);
  await storage.setFavorite(owner.uid, 'source+movie', record);
  await assert.rejects(storage.renameUser(owner.uid, 'someone'), hasCode('OWNER_PROTECTED'));
  setOwner('new_admin');
  const changed = await storage.getUserIdentity('new_admin');
  assert.equal(changed.uid, owner.uid);
  assert.equal(changed.storageKey, owner.storageKey);
  assert.deepEqual(await storage.getAllFavorites(changed.uid), { 'source+movie': record });
  assert.equal(await storage.getUserIdentity('admin'), null);
  await assert.rejects(storage.deleteUser(changed.uid), hasCode('OWNER_PROTECTED'));
});

test('deleted and cleared identities never reappear from orphan namespaces; owner data is also removed', async t => {
  const { raw, storage, wrap } = fixture(t, 'admin');
  await raw.registerUser('legacy', 'fixture-password');
  const original = await storage.getUserIdentity('legacy');
  const deleteUser = raw.deleteUser.bind(raw);
  raw.deleteUser = async () => { throw new Error('simulated deletion failure'); };
  await assert.rejects(storage.deleteUser(original.uid), /simulated deletion failure/);
  raw.deleteUser = deleteUser;
  assert.equal(await wrap().getUserIdentityByUid(original.uid), null);
  assert.equal(await wrap().getUserIdentity('legacy'), null);
  assert.ok(!(await wrap().getAllUsers()).includes('legacy'));
  await storage.registerUser('legacy', 'replacement-password');
  const replacement = await storage.getUserIdentity('legacy');
  assert.notEqual(replacement.uid, original.uid);
  const owner = await storage.getUserIdentity('admin');
  await storage.setFavorite(owner.uid, 'source+movie', record);
  await storage.clearAllData();
  assert.equal(await storage.getUserIdentityByUid(replacement.uid), null);
  assert.equal(await storage.getUserIdentityByUid(owner.uid), null);
  assert.equal(await raw.getFavorite(owner.storageKey, 'source+movie'), null);
  assert.deepEqual(await raw.getAllUsers(), []);
  const nextOwner = await wrap().getUserIdentity('admin');
  assert.notEqual(nextOwner.uid, owner.uid);
  assert.notEqual(nextOwner.storageKey, owner.storageKey);
  assert.equal(await storage.isLegacyUsernameRetired('legacy'), true);
});

test('concurrent creation has one winner and trusted backup UID is preserved with a unique namespace', async t => {
  const { raw, storage, wrap } = fixture(t);
  const created = await Promise.allSettled(Array.from({ length: 4 }, () => wrap().registerUser('parallel', 'fixture-password')));
  assert.equal(created.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await storage.getAllUsers()).length, 1);
  const uid = randomUUID();
  await storage.createUserV2('restored', 'fixture-password', 'user', [], 'restore-sub', [], 'restore@example.com', { uid, createdAt: 42 });
  const restored = await wrap().getUserIdentity('restored');
  assert.ok(isNumericUserUid(restored.uid));
  assert.deepEqual(restored.legacyUids, [uid]);
  assert.equal((await storage.getUserIdentityByUid(uid)).uid, restored.uid);
  assert.equal((await storage.getUserInfoV2(uid)).createdAt, 42);
  assert.equal(await raw.checkUserExist(restored.storageKey), true);
  await assert.rejects(storage.createUserV2('conflict', 'fixture-password', 'user', [], undefined, [], undefined, { uid }));
  assert.equal(await storage.getUserIdentity('conflict'), null);
  assert.equal((await storage.getUserIdentityByUid(uid)).username, 'restored');
});

test('new names accept the shared Chinese policy while unusual existing usernames remain adoptable', async t => {
  const { raw, storage } = fixture(t);
  assert.equal(validateUsername('中文_2'), '中文_2');
  assert.equal(validateUsername('ab'), 'ab');
  assert.throws(() => validateUsername('a'), hasCode('INVALID_USERNAME'));
  assert.throws(() => validateUsername('with space'), hasCode('INVALID_USERNAME'));
  await raw.registerUser('legacy[1]', 'fixture-password');
  const legacy = await storage.getUserIdentity('legacy[1]');
  assert.equal(legacy.storageKey, 'legacy[1]');
  assert.equal(await storage.verifyUser(legacy.uid, 'fixture-password'), true);
});

test('repeated backup restoration preserves UID while retired namespaces remain inaccessible', async t => {
  const { raw, storage } = fixture(t);
  const uid = randomUUID();
  const restore = () => storage.createUserV2('restored', 'fixture-password', 'user', [], undefined, [], undefined, { uid });
  await restore();
  const original = await storage.getUserIdentity('restored');
  await storage.setFavorite(uid, 'source+old', record);
  await storage.clearAllData();
  // Simulate a delayed request arriving in the retired namespace after clear.
  await raw.setFavorite(original.storageKey, 'source+late', record);
  await restore();
  const restored = await storage.getUserIdentity('restored');
  assert.equal(restored.uid, original.uid);
  assert.deepEqual(restored.legacyUids, [uid]);
  assert.notEqual(restored.storageKey, original.storageKey);
  assert.ok(restored.sessionVersion > original.sessionVersion);
  assert.deepEqual(await storage.getAllFavorites(uid), {});
  assert.deepEqual(await storage.getAllUsers(), ['restored']);
  await storage.clearAllData();
  await restore();
  assert.equal((await storage.getUserIdentity('restored')).uid, original.uid);
  assert.notEqual((await storage.getUserIdentity('restored')).storageKey, restored.storageKey);
  assert.ok((await storage.getUserIdentity('restored')).sessionVersion > restored.sessionVersion);
});

test('renaming away and back cannot revive an old session version', async t => {
  const { storage } = fixture(t);
  await storage.registerUser('first_name', 'fixture-password');
  const original = await storage.getUserIdentity('first_name');
  await storage.renameUser(original.uid, 'second_name');
  const returned = await storage.renameUser(original.uid, 'first_name');
  assert.equal(returned.uid, original.uid);
  assert.equal(returned.username, original.username);
  assert.equal(returned.sessionVersion, original.sessionVersion + 2);
  assert.equal((await storage.renameUser(original.uid, 'first_name')).sessionVersion, returned.sessionVersion);
});

test('owner backup restores the original UID after clear and invalidates its former session epoch', async t => {
  const { raw, storage } = fixture(t, 'admin');
  const owner = await storage.getUserIdentity('admin');
  await storage.setPlayRecord(owner.uid, 'source+movie', record);
  await storage.clearAllData();
  await storage.createUserV2('other_user', 'fixture-password', 'user');
  await storage.createUserV2('admin', 'fixture-password', 'owner', [], undefined, [], undefined, { uid: owner.uid });
  const restored = await storage.getUserIdentity('admin');
  assert.equal(restored.uid, owner.uid);
  assert.ok(restored.sessionVersion > owner.sessionVersion);
  assert.notEqual(restored.storageKey, owner.storageKey);
  assert.deepEqual(await storage.getAllPlayRecords(owner.uid), {});
  assert.equal(await raw.checkUserExist(restored.storageKey), true);
  await assert.rejects(storage.renameUser(owner.uid, 'not_owner'), hasCode('OWNER_PROTECTED'));
  await storage.clearExpiredCache('');
  assert.deepEqual(await storage.getUserIdentityByUid(owner.uid), restored);
});
