const assert = require('node:assert/strict');

const ids = {
  owner: 'f0000000-0000-4000-8000-000000000001',
  alpha: '10000000-0000-4000-8000-000000000002',
  beta: '20000000-0000-4000-8000-000000000003',
  retired: '30000000-0000-4000-8000-000000000004',
  race: '05000000-0000-4000-8000-000000000005',
};

function identityFields(identity, owner = false) {
  return {
    [`u:${identity.uid}`]: JSON.stringify(identity),
    [`n:${identity.username}`]: identity.uid,
    [`s:${identity.storageKey}`]: identity.uid,
    [`v:${identity.uid}`]: String(identity.sessionVersion ?? 0),
    ...(owner ? { owner: identity.uid } : {}),
  };
}

const oldOwner = { uid: ids.owner, username: 'admin', storageKey: 'admin', sessionVersion: 3 };
const oldAlpha = { uid: ids.alpha, username: 'alpha_renamed', storageKey: 'legacy_alpha', sessionVersion: 7 };
const oldBeta = { uid: ids.beta, username: 'beta', storageKey: `uid:${ids.beta}`, sessionVersion: 11 };
const hasCode = code => error => error?.code === code;

async function runNumericIdentityCases(t, fixture) {
  await t.test('atomically migrates UUIDs owner-first without moving credentials, collections or session epochs', async t => {
    const { raw, wrap, seed, snapshot } = await fixture(t);
    await raw.createUserV2(oldAlpha.storageKey, 'fixture-password', 'admin', ['group'], 'fixture-sub', ['source'], 'alpha@example.test');
    await raw.registerUser(oldBeta.storageKey, 'fixture-password');
    await raw.setFavorite(oldAlpha.storageKey, 'source+movie', { title: 'alpha favorite' });
    await raw.setFavorite(oldOwner.storageKey, 'source+owner', { title: 'owner favorite' });
    await raw.setAdminConfig({ UserConfig: { Users: [{ uid: ids.alpha, username: oldAlpha.username, role: 'admin', tags: ['group'], tvboxToken: 'fixture-token' }] } });
    const credential = await raw.getUserCredential(oldAlpha.storageKey);
    await seed({
      ...identityFields(oldAlpha), ...identityFields(oldBeta), ...identityFields(oldOwner, true),
      'r:alpha_before': ids.alpha, 'r:deleted': ids.retired,
      'd:deleted_namespace': ids.retired, [`v:${ids.retired}`]: '17',
    });

    const attempts = await Promise.all(Array.from({ length: 8 }, () => wrap().getUserIdentityByUid(ids.owner)));
    assert.deepEqual(attempts[0], { ...oldOwner, uid: '1', legacyUids: [ids.owner] });
    assert.ok(attempts.every(identity => identity.uid === '1'));
    const storage = wrap();
    const alpha = await storage.getUserIdentityByUid(ids.alpha);
    assert.deepEqual(alpha, { ...oldAlpha, uid: '2', legacyUids: [ids.alpha] });
    assert.deepEqual(await storage.getUserIdentityByUid('2'), alpha);
    assert.equal((await storage.getUserIdentityByUid(ids.beta)).uid, '3');
    assert.equal(await storage.allocateUserUid(ids.retired), '4');
    assert.equal(await storage.getUserIdentityByUid(ids.retired), null);
    assert.equal(await raw.getUserCredential(oldAlpha.storageKey), credential);
    assert.deepEqual({ ...await storage.getAllFavorites(ids.alpha) }, { 'source+movie': { title: 'alpha favorite' } });
    assert.deepEqual({ ...await storage.getAllFavorites('1') }, { 'source+owner': { title: 'owner favorite' } });
    assert.equal((await storage.getUserInfoV2('2')).email, 'alpha@example.test');
    assert.equal(await storage.getUsernameByEmail('alpha@example.test'), oldAlpha.username);
    assert.equal(await storage.getUserByOidcSub('fixture-sub'), oldAlpha.username);
    const all = await storage.getAllUserIdentities();
    assert.equal(all.length, 3);
    assert.ok(all.every(identity => /^[1-9][0-9]*$/.test(identity.uid) && identity.legacyUids.length === 1));
    const migrated = await snapshot();
    assert.equal(migrated[`u:${ids.alpha}`], undefined);
    assert.equal(migrated[`a:${ids.alpha}`], '2');
    assert.equal(migrated['r:alpha_before'], '2');
    assert.equal(migrated['d:deleted_namespace'], '4');
    assert.equal(migrated['v:4'], '17');
    assert.equal(migrated.counter, '4');
    assert.equal(migrated.owner, '1');

    const renamed = await storage.renameUser(ids.alpha, 'alpha_final', oldAlpha.username);
    assert.equal(renamed.uid, '2');
    assert.equal(renamed.sessionVersion, 8);
    assert.equal((await storage.getUserIdentityByUid(ids.alpha)).username, 'alpha_final');
    const profile = (await storage.getAdminConfig()).UserConfig.Users[0];
    assert.equal(profile.uid, '2');
    assert.equal(profile.tvboxToken, 'fixture-token');
    assert.deepEqual(profile.tags, ['group']);
  });

  await t.test('allocates unique decimal IDs atomically and preserves the exact counter across delete, clear and large restores', async t => {
    const { raw, wrap, snapshot } = await fixture(t);
    const storage = wrap();
    assert.equal((await storage.getUserIdentity('admin')).uid, '1');
    const allocated = await Promise.all(Array.from({ length: 24 }, () => wrap().allocateUserUid()));
    assert.deepEqual(allocated.slice().sort((a, b) => Number(a) - Number(b)), Array.from({ length: 24 }, (_, i) => String(i + 2)));
    assert.equal((await storage.getAllUserIdentities()).length, 1, 'allocation must not create empty user identities');
    await storage.createUserV2('first_user', 'fixture-password', 'user', [], undefined, [], undefined, { uid: allocated[0] });
    assert.equal((await storage.getUserIdentity('first_user')).uid, allocated[0]);
    await storage.deleteUser(allocated[0]);
    assert.equal(await storage.allocateUserUid(), '26');
    const large = '9007199254740993';
    assert.equal(await storage.allocateUserUid(large), large);
    assert.equal(await storage.getUserIdentityByUid(large), null);
    assert.equal(await storage.allocateUserUid(), '9007199254740994');
    await storage.createUserV2('large_user', 'fixture-password', 'user', [], undefined, [], undefined, { uid: large });
    assert.equal((await storage.getUserIdentity('large_user')).uid, large);
    assert.equal(await raw.checkUserExist(`uid:${large}`), true);
    await storage.clearAllData();
    assert.equal(await wrap().allocateUserUid(), '9007199254740995');
    assert.equal((await snapshot()).counter, '9007199254740995');
    for (const invalid of ['0', '01', '-1', '1e3', '', ' 1'])
      await assert.rejects(storage.allocateUserUid(invalid), hasCode('INVALID_UID'));
  });

  await t.test('reserved UUID aliases survive deletion and clear, restore canonical numeric IDs and never bind recycled names', async t => {
    const { wrap } = await fixture(t);
    const storage = wrap();
    await storage.getUserIdentity('admin');
    const uid = await storage.allocateUserUid(ids.alpha);
    assert.equal(uid, '2');
    assert.equal(await storage.allocateUserUid(ids.alpha), uid);
    assert.equal(await storage.getUserIdentityByUid(ids.alpha), null);
    await storage.createUserV2('shared_name', 'fixture-password', 'user', [], undefined, [], undefined, { uid });
    const original = await storage.getUserIdentity('shared_name');
    assert.deepEqual(original.legacyUids, [ids.alpha]);
    await storage.setFavorite(ids.alpha, 'source+old', { title: 'old' });
    await storage.deleteUser(ids.alpha);
    await storage.registerUser('shared_name', 'replacement-password');
    const replacement = await storage.getUserIdentity('shared_name');
    assert.notEqual(replacement.uid, uid);
    assert.equal(await storage.getUserIdentityByUid(ids.alpha), null);
    await storage.createUserV2('restored_user', 'fixture-password', 'user', [], undefined, [], undefined, { uid: ids.alpha });
    const restored = await storage.getUserIdentityByUid(ids.alpha);
    assert.equal(restored.uid, uid);
    assert.deepEqual(restored.legacyUids, [ids.alpha]);
    assert.notEqual(restored.storageKey, original.storageKey);
    assert.ok(restored.sessionVersion > original.sessionVersion);
    assert.deepEqual({ ...await storage.getAllFavorites(ids.alpha) }, {});
    await storage.clearAllData();
    assert.equal(await storage.allocateUserUid(ids.alpha), uid);
    await storage.createUserV2('restored_again', 'fixture-password', 'user', [], undefined, [], undefined, { uid });
    const again = await storage.getUserIdentityByUid(ids.alpha);
    assert.equal(again.uid, uid);
    assert.deepEqual(again.legacyUids, [ids.alpha]);
    assert.ok(again.sessionVersion > restored.sessionVersion);
    assert.notEqual(again.storageKey, restored.storageKey);

    const otherUid = await storage.allocateUserUid(ids.beta);
    await assert.rejects(storage.createUserV2('alias_conflict', 'fixture-password', 'user', [], undefined, [], undefined, { uid: '99', legacyUids: [ids.beta] }), hasCode('IDENTITY_CONFLICT'));
    assert.equal(await storage.allocateUserUid(ids.beta), otherUid);
    assert.equal(await storage.getUserIdentity('alias_conflict'), null);
  });

  await t.test('numeric and UUID-shaped usernames only resolve through the explicit username lookup', async t => {
    const { raw, wrap } = await fixture(t);
    const storage = wrap();
    await storage.getUserIdentity('admin');
    await storage.createUserV2('uid_owner', 'uid-password', 'user', [], undefined, [], undefined, { uid: '22' });
    await storage.registerUser('22', 'numeric-name-password');
    const named = await storage.getUserIdentity('22');
    assert.notEqual(named.uid, '22');
    assert.equal((await storage.getUserIdentityByUid('22')).username, 'uid_owner');
    await storage.setFavorite('22', 'source+identity', { title: 'identity owner' });
    await storage.setFavorite(named.uid, 'source+name', { title: 'numeric username' });
    assert.deepEqual({ ...await storage.getAllFavorites('22') }, { 'source+identity': { title: 'identity owner' } });
    assert.deepEqual({ ...await storage.getAllFavorites(named.uid) }, { 'source+name': { title: 'numeric username' } });
    await storage.deleteUser('22');
    assert.equal((await storage.getUserIdentity('22')).uid, named.uid);
    assert.equal(await storage.getUserIdentityByUid('22'), null);
    assert.deepEqual({ ...await storage.getAllFavorites('22') }, {});
    assert.equal(await storage.verifyUser('22', 'numeric-name-password'), false);
    await assert.rejects(storage.setFavorite('22', 'source+wrong', {}), hasCode('USER_NOT_FOUND'));
    await storage.registerUser('01', 'leading-zero-password');
    assert.ok(await storage.getUserIdentity('01'));
    assert.equal(await storage.verifyUser('01', 'leading-zero-password'), false);
    await raw.registerUser(ids.beta, 'legacy-name-password');
    const uuidName = await storage.getUserIdentity(ids.beta);
    assert.ok(/^[1-9][0-9]*$/.test(uuidName.uid));
    assert.equal(await storage.getUserIdentityByUid(ids.beta), null);
    assert.equal(await storage.verifyUser(ids.beta, 'legacy-name-password'), false);
    assert.equal(await storage.verifyUser(uuidName.uid, 'legacy-name-password'), true);
  });

  await t.test('retries a migration snapshot changed by a concurrent registry writer without losing either identity', async t => {
    const { raw, seed, snapshot } = await fixture(t);
    await seed({ ...identityFields(oldOwner, true), ...identityFields(oldAlpha) });
    const registry = raw.getIdentityRegistry();
    const mutate = registry.mutate.bind(registry);
    let attempts = 0;
    registry.mutate = async (operation, input) => {
      if (operation === 'migrate' && attempts++ === 0) {
        await seed(identityFields({ uid: ids.race, username: 'concurrent_user', storageKey: 'concurrent_user', sessionVersion: 19 }));
      }
      return mutate(operation, input);
    };
    assert.equal((await registry.getByUid(ids.alpha)).uid, '3');
    assert.ok(attempts >= 2);
    assert.equal((await registry.getByUid(ids.race)).uid, '2');
    assert.equal((await registry.getByUid(ids.owner)).uid, '1');
    assert.equal((await snapshot()).counter, '3');
  });

  await t.test('keeps a conflicting migration snapshot untouched rather than merging two accounts', async t => {
    const { raw, seed, snapshot } = await fixture(t);
    await seed({
      ...identityFields(oldAlpha),
      ...identityFields({ uid: '5', username: 'numeric_user', storageKey: 'numeric_user', sessionVersion: 23 }),
      [`a:${ids.alpha}`]: '5',
    });
    const before = await snapshot();
    await assert.rejects(raw.getIdentityRegistry().getByUid(ids.alpha), hasCode('IDENTITY_CONFLICT'));
    assert.deepEqual(await snapshot(), before);
  });
}

module.exports = { runNumericIdentityCases };
