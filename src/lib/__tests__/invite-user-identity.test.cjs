const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');

const CREATOR_UID = '1';
const REPLACEMENT_UID = '2';
const MEMBER_UID = '3';
const REMOVED_UID = '4';
const LEGACY_CREATOR_UID = '11111111-1111-4111-8111-111111111111';
const LEGACY_REPLACEMENT_UID = '22222222-2222-4222-8222-222222222222';
const LEGACY_MEMBER_UID = '33333333-3333-4333-8333-333333333333';
const LEGACY_REMOVED_UID = '44444444-4444-4444-8444-444444444444';

// This fixture loads the real invite implementation and Redis compatibility
// adapter. Its only storage is these maps; db.ts and environment files stay unloaded.
function createFixture(t) {
  const hashes = new Map();
  const sets = new Map();
  const lists = new Map();
  const identities = new Map();
  const calls = [];
  const identityReads = [];
  const client = {
    // Creation protocol fixture only. Actual Lua collision and concurrency
    // behavior is exercised against the opt-in server below.
    eval: async (_script, { keys, arguments: args }) => {
      assert.equal(keys.length, 4);
      const [key, activeKey, creatorKey, historyKey] = keys;
      const [code, createdBy, createdByUid, createdAt, maxUses, expiresAt] =
        args;
      if (
        hashes.has(key) ||
        lists.has(historyKey) ||
        sets.get(activeKey)?.has(code) ||
        sets.get(creatorKey)?.has(code)
      ) {
        return [0, 'ALREADY_EXISTS'];
      }
      hashes.set(key, {
        code,
        createdBy,
        createdByUid,
        createdAt,
        maxUses,
        expiresAt,
        currentUses: '0',
        disabled: 'false',
      });
      for (const index of [activeKey, creatorKey]) {
        if (!sets.has(index)) sets.set(index, new Set());
        sets.get(index).add(code);
      }
      return [1];
    },
    hSet: async (key, fieldOrRecord, value) => {
      const record =
        typeof fieldOrRecord === 'string'
          ? { [fieldOrRecord]: value }
          : fieldOrRecord;
      hashes.set(key, { ...hashes.get(key), ...structuredClone(record) });
      return Object.keys(record).length;
    },
    hGetAll: async (key) => structuredClone(hashes.get(key) || {}),
    sAdd: async (key, ...members) => {
      const values = sets.get(key) || new Set();
      members.flat().forEach((member) => values.add(member));
      sets.set(key, values);
      return members.flat().length;
    },
    sIsMember: async (key, member) => sets.get(key)?.has(member) || false,
    sMembers: async (key) => {
      calls.push(['sMembers', key]);
      return [...(sets.get(key) || [])];
    },
    sRem: async (key, ...members) => {
      calls.push(['sRem', key, ...members]);
      let removed = 0;
      members.flat().forEach((member) => {
        if (sets.get(key)?.delete(member)) removed += 1;
      });
      return removed;
    },
    lRange: async (key, start, end) =>
      (lists.get(key) || []).slice(start, end === -1 ? undefined : end + 1),
    del: async (...keys) => {
      calls.push(['del', ...keys]);
      let removed = 0;
      for (const key of keys.flat()) {
        for (const entries of [hashes, sets, lists]) {
          if (entries.delete(key)) removed += 1;
        }
      }
      return removed;
    },
    keys: async (pattern) => {
      assert.equal(pattern, 'invite:*');
      return [
        ...new Set([...hashes.keys(), ...sets.keys(), ...lists.keys()]),
      ].filter((key) => key.startsWith('invite:'));
    },
  };
  const db = {
    storage: { client },
    getUserIdentity: async (username) => {
      identityReads.push(['username', username]);
      return structuredClone(
        [...identities.values()].find(
          (identity) => identity.username === username,
        ) || null,
      );
    },
    getUserIdentityByUid: async (uid) => {
      identityReads.push(['uid', uid]);
      return structuredClone(
        identities.get(uid) ||
          [...identities.values()].find((identity) =>
            identity.legacyUids?.includes(uid),
          ) ||
          null,
      );
    },
    getAllUsers: async () =>
      [...identities.values()].map((identity) => identity.username),
  };
  const generatedCodes = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ', '23456789'];
  const load = createSourceLoader({
    './db': { db },
    nanoid: {
      customAlphabet: () => () => {
        assert.ok(generatedCodes.length, 'Unexpected extra invite creation');
        return generatedCodes.shift();
      },
    },
  });
  const invites = load('invite-code.ts');
  t.mock.method(console, 'log', () => {});
  return {
    invites,
    client,
    hashes,
    sets,
    lists,
    identities,
    calls,
    identityReads,
    generatedCodes,
    addIdentity(uid, username, storageKey = `uid:${uid}`, legacyUids = []) {
      const identity = {
        uid,
        username,
        storageKey,
        legacyUids,
        sessionVersion: 0,
      };
      identities.set(uid, identity);
      return identity;
    },
    rename(uid, username) {
      identities.set(uid, { ...identities.get(uid), username });
    },
    seedInvite(
      code,
      createdBy,
      createdByUid,
      index,
      createdAt = Date.now() - 1000,
    ) {
      hashes.set(`invite:${code}`, {
        code,
        createdBy,
        ...(createdByUid ? { createdByUid } : {}),
        createdAt: String(createdAt),
        maxUses: '5',
        currentUses: '0',
        expiresAt: String(Date.now() + 60000),
        disabled: 'false',
      });
      if (!sets.has('invites:active')) sets.set('invites:active', new Set());
      sets.get('invites:active').add(code);
      if (!sets.has(index)) sets.set(index, new Set());
      sets.get(index).add(code);
    },
  };
}

test('new invites bind the canonical creator UID and marked index for numeric and legacy UUID callers', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin_before', 'admin_before', [
    LEGACY_CREATOR_UID,
  ]);
  const byUid = await f.invites.createInviteCode(CREATOR_UID, 4, 600);
  const byAlias = await f.invites.createInviteCode(LEGACY_CREATOR_UID, 7, 1200);
  for (const code of [byUid, byAlias]) {
    assert.equal(f.hashes.get(`invite:${code}`).createdByUid, CREATOR_UID);
    assert.equal(f.hashes.get(`invite:${code}`).createdBy, 'admin_before');
    assert.equal(
      f.sets.get(`admin:uid:${CREATOR_UID}:invites`).has(code),
      true,
    );
    assert.equal(f.sets.get('invites:active').has(code), true);
  }
  assert.equal(f.hashes.get(`invite:${byUid}`).maxUses, '4');
  assert.equal(f.hashes.get(`invite:${byAlias}`).maxUses, '7');
  assert.equal(f.sets.has('admin:admin_before:invites'), false);
  assert.equal(f.sets.has(`admin:${CREATOR_UID}:invites`), false);
  assert.deepEqual(f.identityReads.slice(0, 2), [
    ['uid', CREATOR_UID],
    ['uid', LEGACY_CREATOR_UID],
  ]);
  await assert.rejects(
    f.invites.createInviteCode(REMOVED_UID),
    (error) => error.code === 'USER_NOT_FOUND',
  );
  await assert.rejects(
    f.invites.createInviteCode('admin_before'),
    (error) => error.code === 'USER_NOT_FOUND',
  );
  assert.equal(f.hashes.size, 2);
});

test('custom creation normalizes input, preserves limits and rejects case-insensitive duplicates', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin');
  assert.equal(
    await f.invites.createInviteCode(CREATOR_UID, 7, 600, '  miao-2026_vip  '),
    'MIAO-2026_VIP',
  );
  const saved = structuredClone(f.hashes.get('invite:MIAO-2026_VIP'));
  assert.equal(saved.maxUses, '7');
  assert.equal(Number(saved.expiresAt) - Number(saved.createdAt), 600000);
  await assert.rejects(
    f.invites.createInviteCode(CREATOR_UID, 99, 86400, 'Miao-2026_Vip'),
    (error) => error.code === 'ALREADY_EXISTS',
  );
  assert.deepEqual(f.hashes.get('invite:MIAO-2026_VIP'), saved);
  assert.equal(
    f.generatedCodes.length,
    4,
    'custom creation does not generate random names',
  );
  assert.equal(
    await f.invites.createInviteCode(CREATOR_UID, 10, 600, '  '),
    'ABCDEFGH',
  );
});

test('custom creation validates its format before accessing account or invitation storage', async (t) => {
  const f = createFixture(t);
  for (const code of [
    null,
    1234,
    [],
    {},
    'abc',
    'A'.repeat(33),
    'some code',
    'a/bc',
    'abßc',
    '邀请码',
  ]) {
    await assert.rejects(
      f.invites.createInviteCode(CREATOR_UID, 10, 600, code),
      (error) => error.code === 'INVALID_CODE',
    );
  }
  assert.deepEqual(f.identityReads, []);
  assert.equal(f.hashes.size, 0);
  f.addIdentity(CREATOR_UID, 'admin');
  for (const code of ['abcd', 'A'.repeat(32), '0123-_']) {
    assert.equal(
      await f.invites.createInviteCode(CREATOR_UID, 10, 600, code),
      code.toUpperCase(),
    );
  }
});

test('random generation retries inactive collisions and stops after ten confirmed conflicts', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin');
  f.seedInvite(
    'ABCDEFGH',
    'admin',
    CREATOR_UID,
    `admin:uid:${CREATOR_UID}:invites`,
  );
  f.sets.get('invites:active').delete('ABCDEFGH');
  const original = structuredClone(f.hashes.get('invite:ABCDEFGH'));
  assert.equal(await f.invites.createInviteCode(CREATOR_UID), 'JKLMNPQR');
  assert.deepEqual(f.hashes.get('invite:ABCDEFGH'), original);
  f.generatedCodes.splice(
    0,
    f.generatedCodes.length,
    ...Array(10).fill('ABCDEFGH'),
  );
  await assert.rejects(
    f.invites.createInviteCode(CREATOR_UID),
    (error) => error.code === 'GENERATION_FAILED',
  );
  assert.equal(f.generatedCodes.length, 0);
  assert.equal(f.hashes.size, 2);
});

test('ambiguous creation failures are not retried with a second code', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin');
  let evaluations = 0;
  f.client.eval = async () => {
    evaluations++;
    throw new Error('reply lost after write');
  };
  await assert.rejects(f.invites.createInviteCode(CREATOR_UID), /reply lost/);
  assert.equal(evaluations, 1);
  assert.equal(f.generatedCodes.length, 3);
  f.client.eval = async () => {
    evaluations++;
    return ['unexpected'];
  };
  await assert.rejects(
    f.invites.createInviteCode(CREATOR_UID),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  assert.equal(evaluations, 2);
});

test('creator rename updates direct stats and lists while a reused name belongs to a new UID', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin_before', 'admin_before', [
    LEGACY_CREATOR_UID,
  ]);
  const code = await f.invites.createInviteCode(CREATOR_UID);
  f.rename(CREATOR_UID, 'admin_after');
  f.addIdentity(REPLACEMENT_UID, 'admin_before');
  assert.equal(
    (await f.invites.getInviteCodeStats(code)).createdBy,
    'admin_after',
  );
  for (const reference of [CREATOR_UID, LEGACY_CREATOR_UID]) {
    const [invite] = await f.invites.getAdminInviteCodes(reference);
    assert.equal(invite.code, code);
    assert.equal(invite.createdBy, 'admin_after');
    assert.equal(invite.createdByUid, CREATOR_UID);
  }
  const all = await f.invites.getAllInviteCodes();
  assert.equal(all.length, 1);
  assert.equal(all[0].createdBy, 'admin_after');
  assert.deepEqual(await f.invites.getAdminInviteCodes('admin_before'), []);
  assert.deepEqual(await f.invites.getAdminInviteCodes(REPLACEMENT_UID), []);
  // Historical metadata is not rewritten to make a presentation-only name change.
  assert.equal(f.hashes.get(`invite:${code}`).createdBy, 'admin_before');
});

test('legacy storage indexes and UID indexes remain with their original creator after name reuse', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin_after', 'admin_before', [
    LEGACY_CREATOR_UID,
  ]);
  f.addIdentity(REPLACEMENT_UID, 'admin_before', undefined, [
    LEGACY_REPLACEMENT_UID,
  ]);
  const oldDate = Date.now() - 5000;
  f.seedInvite(
    'LEGACYAA',
    'admin_before',
    undefined,
    'admin:admin_before:invites',
    oldDate,
  );
  const originalCode = await f.invites.createInviteCode(CREATOR_UID);
  const replacementCode = await f.invites.createInviteCode(REPLACEMENT_UID);
  const original = await f.invites.getAdminInviteCodes(CREATOR_UID);
  assert.deepEqual(
    original.map((invite) => invite.code),
    [originalCode, 'LEGACYAA'],
  );
  assert.deepEqual(
    (await f.invites.getAdminInviteCodes(LEGACY_CREATOR_UID)).map(
      (invite) => invite.code,
    ),
    [originalCode, 'LEGACYAA'],
  );
  for (const reference of [REPLACEMENT_UID, LEGACY_REPLACEMENT_UID]) {
    assert.deepEqual(
      (await f.invites.getAdminInviteCodes(reference)).map(
        (invite) => invite.code,
      ),
      [replacementCode],
    );
  }
  assert.deepEqual(await f.invites.getAdminInviteCodes('removed_admin'), []);
});

test('legacy invites retain their historical creator snapshot without assigning a reused-name UID', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin_after', 'admin_before');
  f.addIdentity(REPLACEMENT_UID, 'admin_before');
  f.seedInvite(
    'LEGACYAA',
    'admin_before',
    undefined,
    'admin:admin_before:invites',
  );
  const [listed] = await f.invites.getAdminInviteCodes(CREATOR_UID);
  assert.equal(listed.createdBy, 'admin_before');
  assert.equal(listed.createdByUid, undefined);
  const direct = await f.invites.getInviteCodeStats('LEGACYAA');
  assert.equal(direct.createdBy, 'admin_before');
  assert.equal(direct.createdByUid, undefined);
  assert.equal(
    f.identityReads.some(
      ([kind, name]) => kind === 'username' && name === 'admin_before',
    ),
    false,
  );
  assert.deepEqual(await f.invites.getAdminInviteCodes(REPLACEMENT_UID), []);
});

test('usage references resolve current UID names without reassigning legacy or deleted users', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin', 'admin');
  f.addIdentity(MEMBER_UID, 'member_before', 'member_before');
  const code = await f.invites.createInviteCode(CREATOR_UID);
  f.lists.set(`invite:${code}:users`, [
    `uid:${MEMBER_UID}`,
    'legacy_member',
    `uid:${REMOVED_UID}`,
  ]);
  f.hashes.get(`invite:${code}`).currentUses = '3';
  f.rename(MEMBER_UID, 'member_after');
  f.addIdentity(REPLACEMENT_UID, 'member_before');
  const stats = await f.invites.getInviteCodeStats(code);
  assert.deepEqual(stats.users, ['member_after', 'legacy_member', REMOVED_UID]);
  assert.deepEqual(stats.userUids, [MEMBER_UID, REMOVED_UID]);
  assert.equal(stats.currentUses, 3);
  assert.equal(stats.remainingUses, 7);
  assert.deepEqual(f.lists.get(`invite:${code}:users`), [
    `uid:${MEMBER_UID}`,
    'legacy_member',
    `uid:${REMOVED_UID}`,
  ]);
  assert.equal(
    f.identityReads.some(
      ([kind, name]) => kind === 'username' && name === 'legacy_member',
    ),
    false,
  );
});

test('deleting a UID invite after creator rename clears the original UID index only', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin_before', 'admin_before');
  const originalCode = await f.invites.createInviteCode(CREATOR_UID);
  f.lists.set(`invite:${originalCode}:users`, [MEMBER_UID]);
  f.rename(CREATOR_UID, 'admin_after');
  f.addIdentity(REPLACEMENT_UID, 'admin_before');
  const replacementCode = await f.invites.createInviteCode(REPLACEMENT_UID);
  assert.equal(await f.invites.removeInviteCode(originalCode), true);
  assert.equal(
    f.sets.get(`admin:uid:${CREATOR_UID}:invites`).has(originalCode),
    false,
  );
  assert.deepEqual(
    [...f.sets.get(`admin:uid:${REPLACEMENT_UID}:invites`)],
    [replacementCode],
  );
  assert.equal(f.sets.get('invites:active').has(originalCode), false);
  assert.equal(f.hashes.has(`invite:${originalCode}`), false);
  assert.equal(f.lists.has(`invite:${originalCode}:users`), false);
  assert.ok(
    f.calls.some(
      (call) =>
        call[0] === 'sRem' &&
        call[1] === `admin:uid:${CREATOR_UID}:invites` &&
        call[2] === originalCode,
    ),
  );
  assert.equal(
    f.calls.some(
      (call) =>
        call[0] === 'sRem' &&
        call[1] === `admin:uid:${REPLACEMENT_UID}:invites`,
    ),
    false,
  );
  assert.equal(await f.invites.removeInviteCode(originalCode), false);
});

test('deleting a legacy invite cleans its original storage index after username reuse', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin_after', 'admin_before');
  f.addIdentity(REPLACEMENT_UID, 'admin_before');
  f.seedInvite(
    'LEGACYAA',
    'admin_before',
    undefined,
    'admin:admin_before:invites',
  );
  const currentCode = await f.invites.createInviteCode(CREATOR_UID);
  const replacementCode = await f.invites.createInviteCode(REPLACEMENT_UID);
  f.lists.set('invite:LEGACYAA:users', ['legacy_member']);
  assert.equal(await f.invites.removeInviteCode('LEGACYAA'), true);
  assert.equal(f.sets.get('admin:admin_before:invites').has('LEGACYAA'), false);
  assert.deepEqual(
    [...f.sets.get(`admin:uid:${CREATOR_UID}:invites`)],
    [currentCode],
  );
  assert.deepEqual(
    [...f.sets.get(`admin:uid:${REPLACEMENT_UID}:invites`)],
    [replacementCode],
  );
  assert.equal(f.hashes.has('invite:LEGACYAA'), false);
  assert.equal(f.lists.has('invite:LEGACYAA:users'), false);
  assert.deepEqual(
    (await f.invites.getAdminInviteCodes(CREATOR_UID)).map(
      (invite) => invite.code,
    ),
    [currentCode],
  );
});

test('administrator lists merge numeric, every UUID alias and original storage indexes without duplicates', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin_after', 'admin_before', [
    LEGACY_CREATOR_UID,
    LEGACY_REPLACEMENT_UID,
  ]);
  f.seedInvite(
    'STORAGEA',
    'admin_before',
    undefined,
    'admin:admin_before:invites',
  );
  f.seedInvite(
    'UUIDAAAA',
    'admin_before',
    LEGACY_CREATOR_UID,
    `admin:${LEGACY_CREATOR_UID}:invites`,
  );
  f.seedInvite(
    'UUIDBBBB',
    'admin_before',
    LEGACY_REPLACEMENT_UID,
    `admin:${LEGACY_REPLACEMENT_UID}:invites`,
  );
  const current = await f.invites.createInviteCode(CREATOR_UID);
  f.sets.get(`admin:${LEGACY_CREATOR_UID}:invites`).add(current);
  const listed = await f.invites.getAdminInviteCodes(LEGACY_CREATOR_UID);
  assert.deepEqual(
    new Set(listed.map((invite) => invite.code)),
    new Set(['STORAGEA', 'UUIDAAAA', 'UUIDBBBB', current]),
  );
  assert.equal(listed.length, 4);
  for (const invite of listed.filter((invite) => invite.code !== 'STORAGEA')) {
    assert.equal(invite.createdByUid, CREATOR_UID);
    assert.equal(invite.createdBy, 'admin_after');
  }
  assert.deepEqual(
    f.calls.filter((call) => call[0] === 'sMembers').map((call) => call[1]),
    [
      `admin:uid:${CREATOR_UID}:invites`,
      'admin:admin_before:invites',
      `admin:${LEGACY_CREATOR_UID}:invites`,
      `admin:${LEGACY_REPLACEMENT_UID}:invites`,
    ],
  );
});

test('numeric creator IDs never read or overwrite an unrelated historical numeric username index', async (t) => {
  const f = createFixture(t);
  f.addIdentity('12', 'new_admin', 'new_admin');
  f.addIdentity('13', 'renamed_admin', '12');
  f.seedInvite('OLDNAMEA', '12', undefined, 'admin:12:invites');
  const current = await f.invites.createInviteCode('12');
  assert.deepEqual([...f.sets.get('admin:12:invites')], ['OLDNAMEA']);
  assert.deepEqual([...f.sets.get('admin:uid:12:invites')], [current]);
  assert.deepEqual(
    (await f.invites.getAdminInviteCodes('12')).map((invite) => invite.code),
    [current],
  );
  assert.equal(
    f.calls.some(
      (call) => call[0] === 'sMembers' && call[1] === 'admin:12:invites',
    ),
    false,
  );
  assert.deepEqual(
    (await f.invites.getAdminInviteCodes('13')).map((invite) => invite.code),
    ['OLDNAMEA'],
  );
  assert.equal(
    (await f.invites.getInviteCodeStats('OLDNAMEA')).createdBy,
    '12',
  );
  assert.equal(
    (await f.invites.getInviteCodeStats('OLDNAMEA')).createdByUid,
    undefined,
  );
  await f.invites.removeInviteCode(current);
  assert.deepEqual([...f.sets.get('admin:12:invites')], ['OLDNAMEA']);
});

test('unknown numeric UID callers cannot fall back to a namesake username', async (t) => {
  const f = createFixture(t);
  f.addIdentity('20', '99', '99');
  f.seedInvite('OLDNAMEA', '99', undefined, 'admin:99:invites');
  await assert.rejects(
    f.invites.createInviteCode('99'),
    (error) => error.code === 'USER_NOT_FOUND',
  );
  assert.deepEqual(await f.invites.getAdminInviteCodes('99'), []);
  assert.deepEqual(f.identityReads, [
    ['uid', '99'],
    ['uid', '99'],
  ]);
});

test('usage resolves UUID aliases and explicitly marked numeric UIDs while preserving unmarked numeric username snapshots', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin', 'admin', [LEGACY_CREATOR_UID]);
  f.addIdentity(MEMBER_UID, 'member_after', 'member_before', [
    LEGACY_MEMBER_UID,
  ]);
  f.addIdentity('12', 'unrelated_numeric_id');
  const code = await f.invites.createInviteCode(CREATOR_UID);
  f.lists.set(`invite:${code}:users`, [
    LEGACY_MEMBER_UID,
    '12',
    `uid:${MEMBER_UID}`,
    LEGACY_REMOVED_UID,
    `uid:${REMOVED_UID}`,
    'legacy_member',
  ]);
  const stats = await f.invites.getInviteCodeStats(code);
  assert.deepEqual(stats.users, [
    'member_after',
    '12',
    'member_after',
    LEGACY_REMOVED_UID,
    REMOVED_UID,
    'legacy_member',
  ]);
  assert.deepEqual(stats.userUids, [
    MEMBER_UID,
    MEMBER_UID,
    LEGACY_REMOVED_UID,
    REMOVED_UID,
  ]);
  assert.equal(
    f.identityReads.some(
      ([, reference]) => reference === '12' || reference === 'legacy_member',
    ),
    false,
  );
});

test('deserialized numeric metadata and legacy username list values remain string identities', async (t) => {
  const f = createFixture(t);
  f.addIdentity('12', 'current_admin', 'old_admin');
  const code = await f.invites.createInviteCode('12');
  const data = f.hashes.get(`invite:${code}`);
  data.createdByUid = 12;
  data.createdBy = 99;
  f.lists.set(`invite:${code}:users`, [99, 'uid:12']);
  const stats = await f.invites.getInviteCodeStats(code);
  assert.equal(stats.createdByUid, '12');
  assert.equal(stats.createdBy, 'current_admin');
  assert.deepEqual(stats.users, ['99', 'current_admin']);
  assert.deepEqual(stats.userUids, ['12']);
  assert.deepEqual(
    (await f.invites.getAdminInviteCodes('12')).map((invite) => invite.code),
    [code],
  );
  assert.equal(await f.invites.removeInviteCode(code), true);
  assert.deepEqual([...f.sets.get('admin:uid:12:invites')], []);
});

test('deleting an old UUID invite removes its original alias and duplicate canonical indexes after migration', async (t) => {
  const f = createFixture(t);
  f.addIdentity(CREATOR_UID, 'admin_after', 'admin_before', [
    LEGACY_CREATOR_UID,
  ]);
  f.seedInvite(
    'UUIDAAAA',
    'admin_before',
    LEGACY_CREATOR_UID,
    `admin:${LEGACY_CREATOR_UID}:invites`,
  );
  f.sets.set(
    `admin:uid:${CREATOR_UID}:invites`,
    new Set(['UUIDAAAA', 'KEEPMINE']),
  );
  f.sets.set('admin:admin_before:invites', new Set(['UUIDAAAA', 'KEEPOLD']));
  f.sets.set('admin:uid:12:invites', new Set(['KEEPOTHER']));
  assert.equal(await f.invites.removeInviteCode('UUIDAAAA'), true);
  assert.deepEqual([...f.sets.get(`admin:${LEGACY_CREATOR_UID}:invites`)], []);
  assert.deepEqual(
    [...f.sets.get(`admin:uid:${CREATOR_UID}:invites`)],
    ['KEEPMINE'],
  );
  assert.deepEqual([...f.sets.get('admin:admin_before:invites')], ['KEEPOLD']);
  assert.deepEqual([...f.sets.get('admin:uid:12:invites')], ['KEEPOTHER']);
});

test('UID reservations include an explicit identity argument and reject mismatched metadata before Redis', async (t) => {
  const f = createFixture(t);
  const evaluations = [];
  f.client.eval = async (_script, options) => {
    evaluations.push(options);
    return [1, 1, 3];
  };
  assert.equal(
    await f.invites.useInviteCode('ABCDEFGH', '12', 'attempt', {
      userUid: '12',
    }),
    true,
  );
  assert.equal(
    await f.invites.releaseInviteCode('ABCDEFGH', '12', 'attempt', {
      userUid: '12',
    }),
    true,
  );
  assert.deepEqual(
    evaluations.map((options) => options.arguments),
    [
      ['ABCDEFGH', '12', 'attempt', '12'],
      ['ABCDEFGH', '12', 'attempt', '12'],
    ],
  );
  for (const identity of [
    { userUid: '13' },
    { userUid: '' },
    { userUid: 'malformed' },
    null,
  ]) {
    await assert.rejects(
      f.invites.useInviteCode('ABCDEFGH', '12', 'attempt', identity),
      (error) => error.code === 'INVALID_RESERVATION',
    );
    await assert.rejects(
      f.invites.releaseInviteCode('ABCDEFGH', '12', 'attempt', identity),
      (error) => error.code === 'INVALID_RESERVATION',
    );
  }
  assert.equal(evaluations.length, 2);
});

// Opt in with MIAOTV_REDIS_LUA_TESTS=1 and the same test-only Python
// fakeredis[lua] dependencies as storage-redis-lua.test.cjs. Only loopback is used.
test(
  'numeric invite reservations execute atomically without conflating legacy username or UUID receipts',
  {
    skip: process.env.MIAOTV_REDIS_LUA_TESTS !== '1',
    timeout: 30000,
  },
  async (t) => {
    const { spawn } = require('node:child_process');
    const path = require('node:path');
    const readline = require('node:readline');
    const python = spawn(
      process.env.MIAOTV_LUA_PYTHON || 'python',
      ['-u', path.join(__dirname, 'redis-lua-test-server.py')],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stderr = '';
    python.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    t.after(() => {
      python.stdin.end();
      python.kill();
    });
    const lines = readline.createInterface({ input: python.stdout });
    t.after(() => lines.close());
    const startup = new Promise((resolve, reject) => {
      lines.once('line', (line) => resolve(JSON.parse(line)));
      python.once('error', reject);
      python.once('exit', (code) =>
        reject(new Error(`Lua emulator exited (${code}): ${stderr}`)),
      );
    });
    const timeout = setTimeout(() => python.kill(), 15000);
    const address = await startup.finally(() => clearTimeout(timeout));
    const raw = require('redis').createClient({
      url: `redis://127.0.0.1:${address.port}`,
      socket: { reconnectStrategy: false },
    });
    raw.on('error', () => {});
    await raw.connect();
    t.after(() => {
      if (raw.isOpen) raw.disconnect();
    });
    const f = createFixture(t);
    f.addIdentity('12', 'current_member', 'old_member', [LEGACY_MEMBER_UID]);
    f.addIdentity('13', 'custom_creator');
    f.addIdentity('14', 'other_creator');
    f.addIdentity('15', 'invalid_index_creator');
    const identityDb = {
      storage: { client: raw },
      getUserIdentityByUid: async (uid) =>
        [...f.identities.values()].find(
          (identity) =>
            identity.uid === uid || identity.legacyUids.includes(uid),
        ) || null,
    };
    const invites = createSourceLoader({
      './db': { db: identityDb },
      nanoid: { customAlphabet: () => () => 'UNUSED00' },
    })('invite-code.ts');
    async function seed(code, currentUses, maxUses = 3) {
      await raw.hSet(`invite:${code}`, {
        code,
        createdBy: 'admin',
        createdAt: String(Date.now()),
        maxUses: String(maxUses),
        currentUses: String(currentUses),
        expiresAt: String(Date.now() + 60000),
        disabled: 'false',
      });
      await raw.sAdd('invites:active', code);
    }

    await t.test(
      'custom codes retain metadata and can be consumed with lowercase input',
      async () => {
        const code = await invites.createInviteCode(
          '13',
          2,
          600,
          ' miao-2026_vip ',
        );
        assert.equal(code, 'MIAO-2026_VIP');
        const saved = await raw.hGetAll(`invite:${code}`);
        assert.equal(saved.createdByUid, '13');
        assert.equal(saved.createdBy, 'custom_creator');
        assert.equal(saved.maxUses, '2');
        assert.equal(Number(saved.expiresAt) - Number(saved.createdAt), 600000);
        assert.equal(await raw.ttl(`invite:${code}`), -1);
        assert.equal(await raw.sIsMember('invites:active', code), true);
        assert.equal(await raw.sIsMember('admin:uid:13:invites', code), true);
        assert.equal(
          await invites.useInviteCode('miao-2026_vip', '12', 'custom-attempt', {
            userUid: '12',
          }),
          true,
        );
        assert.equal(await raw.hGet(`invite:${code}`, 'currentUses'), '1');
        assert.deepEqual(await raw.lRange(`invite:${code}:users`, 0, -1), [
          'uid:12',
        ]);
      },
    );

    await t.test(
      'existing codes keep their owners and history in every lifecycle state',
      async () => {
        for (const state of ['active', 'disabled', 'expired', 'exhausted']) {
          const code = `HISTORY-${state.toUpperCase()}`;
          await invites.createInviteCode('13', 1, 600, code);
          if (state === 'disabled')
            await raw.hSet(`invite:${code}`, 'disabled', 'true');
          if (state === 'expired')
            await raw.hSet(`invite:${code}`, 'expiresAt', '1');
          if (state === 'exhausted')
            await raw.hSet(`invite:${code}`, 'currentUses', '1');
          if (state !== 'active') await raw.sRem('invites:active', code);
          await raw.lPush(`invite:${code}:users`, 'historical-user');
          const before = await raw.hGetAll(`invite:${code}`);
          await assert.rejects(
            invites.createInviteCode('14', 99, 86400, code.toLowerCase()),
            (error) => error.code === 'ALREADY_EXISTS',
          );
          assert.deepEqual(await raw.hGetAll(`invite:${code}`), before);
          assert.deepEqual(await raw.lRange(`invite:${code}:users`, 0, -1), [
            'historical-user',
          ]);
          assert.equal(
            await raw.sIsMember('admin:uid:14:invites', code),
            false,
          );
          assert.equal(
            await raw.sIsMember('invites:active', code),
            state === 'active',
          );
        }
        await raw.lPush('invite:ORPHAN-CODE:users', 'preserved-user');
        await assert.rejects(
          invites.createInviteCode('14', 1, 600, 'ORPHAN-CODE'),
          (error) => error.code === 'ALREADY_EXISTS',
        );
        assert.equal(await raw.exists('invite:ORPHAN-CODE'), 0);
        assert.deepEqual(await raw.lRange('invite:ORPHAN-CODE:users', 0, -1), [
          'preserved-user',
        ]);
      },
    );

    await t.test(
      'concurrent custom creation has one winner and one consistent creator index',
      async () => {
        const results = await Promise.allSettled(
          Array.from({ length: 12 }, (_, index) =>
            invites.createInviteCode(
              index % 2 ? '13' : '14',
              index + 1,
              600,
              'SHARED-CODE',
            ),
          ),
        );
        assert.equal(
          results.filter((result) => result.status === 'fulfilled').length,
          1,
        );
        assert.ok(
          results
            .filter((result) => result.status === 'rejected')
            .every((result) => result.reason.code === 'ALREADY_EXISTS'),
        );
        const saved = await raw.hGetAll('invite:SHARED-CODE');
        for (const uid of ['13', '14']) {
          assert.equal(
            await raw.sIsMember(`admin:uid:${uid}:invites`, 'SHARED-CODE'),
            saved.createdByUid === uid,
          );
        }
        assert.equal(
          await raw.sIsMember('invites:active', 'SHARED-CODE'),
          true,
        );
        assert.equal(saved.currentUses, '0');
      },
    );

    await t.test(
      'invalid index types fail before writing invitation metadata or the active index',
      async () => {
        await raw.set('admin:uid:15:invites', 'wrong-type');
        await assert.rejects(
          invites.createInviteCode('15', 1, 600, 'INVALID-INDEX'),
          (error) => error.code === 'INVALID_DATA',
        );
        assert.equal(await raw.exists('invite:INVALID-INDEX'), 0);
        assert.equal(
          await raw.sIsMember('invites:active', 'INVALID-INDEX'),
          false,
        );
        assert.equal(await raw.get('admin:uid:15:invites'), 'wrong-type');
      },
    );

    await t.test(
      'new UID and old numeric username reservations with the same text retain separate receipts and list entries',
      async () => {
        await seed('NUMERIC1', 1);
        await raw.lPush('invite:NUMERIC1:users', '12');
        await raw.hSet(
          'invite:NUMERIC1',
          '__reservation:legacy-attempt',
          JSON.stringify({ username: '12', status: 'reserved' }),
        );
        assert.equal(
          await invites.useInviteCode('NUMERIC1', '12', 'uid-attempt', {
            userUid: '12',
          }),
          true,
        );
        assert.equal(
          await invites.useInviteCode('NUMERIC1', '12', 'uid-attempt', {
            userUid: '12',
          }),
          true,
        );
        assert.equal(await raw.hGet('invite:NUMERIC1', 'currentUses'), '2');
        assert.deepEqual(await raw.lRange('invite:NUMERIC1:users', 0, -1), [
          'uid:12',
          '12',
        ]);
        assert.deepEqual(
          JSON.parse(
            await raw.hGet('invite:NUMERIC1', '__reservation:uid-attempt'),
          ),
          {
            username: '12',
            uid: '12',
            listEntry: 'uid:12',
            status: 'reserved',
          },
        );
        const stats = await invites.getInviteCodeStats('NUMERIC1');
        assert.deepEqual(stats.users, ['current_member', '12']);
        assert.deepEqual(stats.userUids, ['12']);
        assert.equal(
          await invites.releaseInviteCode('NUMERIC1', '12', 'legacy-attempt', {
            userUid: '12',
          }),
          false,
        );
        await assert.rejects(
          invites.useInviteCode('NUMERIC1', '12', 'legacy-attempt', {
            userUid: '12',
          }),
          (error) => error.code === 'ATTEMPT_CONFLICT',
        );
        assert.equal(
          await invites.releaseInviteCode('NUMERIC1', '12', 'uid-attempt'),
          false,
        );
        await assert.rejects(
          invites.useInviteCode('NUMERIC1', '12', 'uid-attempt'),
          (error) => error.code === 'ATTEMPT_CONFLICT',
        );
        assert.equal(
          await invites.releaseInviteCode('NUMERIC1', '12', 'uid-attempt', {
            userUid: '12',
          }),
          true,
        );
        assert.equal(
          await invites.releaseInviteCode('NUMERIC1', '12', 'uid-attempt', {
            userUid: '12',
          }),
          false,
        );
        assert.deepEqual(await raw.lRange('invite:NUMERIC1:users', 0, -1), [
          '12',
        ]);
        assert.equal(await raw.hGet('invite:NUMERIC1', 'currentUses'), '1');
        await assert.rejects(
          invites.useInviteCode('NUMERIC1', '12', 'uid-attempt', {
            userUid: '12',
          }),
          (error) => error.code === 'ATTEMPT_RELEASED',
        );
        assert.equal(
          await invites.releaseInviteCode('NUMERIC1', '12', 'legacy-attempt'),
          true,
        );
        assert.equal(await raw.hGet('invite:NUMERIC1', 'currentUses'), '0');
        assert.deepEqual(await raw.lRange('invite:NUMERIC1:users', 0, -1), []);
      },
    );

    await t.test(
      'old unmarked UUID reservations remain idempotent and refundable by the exact UUID receipt',
      async () => {
        await seed('UUIDAAAA', 1);
        await raw.lPush('invite:UUIDAAAA:users', LEGACY_MEMBER_UID);
        await raw.hSet(
          'invite:UUIDAAAA',
          '__reservation:old-uuid',
          JSON.stringify({ username: LEGACY_MEMBER_UID, status: 'reserved' }),
        );
        assert.equal(
          await invites.useInviteCode(
            'UUIDAAAA',
            LEGACY_MEMBER_UID,
            'old-uuid',
            { userUid: LEGACY_MEMBER_UID },
          ),
          true,
        );
        assert.equal(await raw.hGet('invite:UUIDAAAA', 'currentUses'), '1');
        assert.deepEqual(
          (await invites.getInviteCodeStats('UUIDAAAA')).userUids,
          ['12'],
        );
        assert.equal(
          await invites.releaseInviteCode('UUIDAAAA', '12', 'old-uuid', {
            userUid: '12',
          }),
          false,
        );
        assert.equal(
          await invites.releaseInviteCode(
            'UUIDAAAA',
            LEGACY_MEMBER_UID,
            'old-uuid',
            { userUid: LEGACY_MEMBER_UID },
          ),
          true,
        );
        assert.deepEqual(await raw.lRange('invite:UUIDAAAA:users', 0, -1), []);
        assert.equal(await raw.hGet('invite:UUIDAAAA', 'currentUses'), '0');
      },
    );

    await t.test(
      'concurrent numeric reservations cannot exceed the available slots',
      async () => {
        await seed('ATOMICAA', 0, 2);
        const results = await Promise.allSettled(
          Array.from({ length: 10 }, (_, index) => {
            const uid = String(index + 101);
            return invites.useInviteCode('ATOMICAA', uid, `attempt-${index}`, {
              userUid: uid,
            });
          }),
        );
        assert.equal(
          results.filter((result) => result.status === 'fulfilled').length,
          2,
        );
        assert.ok(
          results
            .filter((result) => result.status === 'rejected')
            .every((result) => result.reason.code === 'USED_UP'),
        );
        assert.equal(await raw.hGet('invite:ATOMICAA', 'currentUses'), '2');
        assert.equal(
          (await raw.lRange('invite:ATOMICAA:users', 0, -1)).length,
          2,
        );
        assert.equal(await raw.sIsMember('invites:active', 'ATOMICAA'), false);
      },
    );

    await t.test(
      'the real Upstash client preserves numeric creator IDs, historical numeric usernames and explicit UID reservations',
      async () => {
        const http = require('node:http');
        const { once } = require('node:events');
        const encode = (value) =>
          typeof value === 'string' && value !== 'OK'
            ? Buffer.from(value).toString('base64')
            : Array.isArray(value)
              ? value.map(encode)
              : value;
        const server = http.createServer(async (request, response) => {
          let body = '';
          for await (const chunk of request) body += chunk;
          const execute = async (command) => {
            try {
              const result = await raw.sendCommand(command.map(String));
              return {
                result:
                  request.headers['upstash-encoding'] === 'base64'
                    ? encode(result)
                    : result,
              };
            } catch (error) {
              return { error: error.message };
            }
          };
          const command = JSON.parse(body);
          const result = Array.isArray(command[0])
            ? await Promise.all(command.map(execute))
            : await execute(command);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(result));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        t.after(() => {
          server.closeAllConnections();
          server.close();
        });
        const { Redis } = require('@upstash/redis');
        identityDb.storage.client = new Redis({
          url: `http://127.0.0.1:${server.address().port}`,
          token: 'isolated-test',
          retry: { retries: 0 },
          enableAutoPipelining: true,
        });
        const code = await invites.createInviteCode('12');
        await raw.lPush(`invite:${code}:users`, '99');
        await raw.hSet(`invite:${code}`, 'currentUses', '1');
        assert.equal(
          await invites.useInviteCode(code, '12', 'upstash-uid', {
            userUid: '12',
          }),
          true,
        );
        const stats = await invites.getInviteCodeStats(code);
        assert.equal(stats.createdByUid, '12');
        assert.deepEqual(stats.users, ['current_member', '99']);
        assert.deepEqual(stats.userUids, ['12']);
        assert.deepEqual(
          (await invites.getAdminInviteCodes('12')).map(
            (invite) => invite.code,
          ),
          [code],
        );
        assert.equal(
          await invites.releaseInviteCode(code, '12', 'upstash-uid', {
            userUid: '12',
          }),
          true,
        );
        assert.deepEqual(await raw.lRange(`invite:${code}:users`, 0, -1), [
          '99',
        ]);
        assert.equal(await invites.removeInviteCode(code), true);
        assert.deepEqual(await raw.sMembers('admin:uid:12:invites'), []);
        const custom = await invites.createInviteCode(
          '12',
          3,
          600,
          'upstash-2026',
        );
        assert.equal(custom, 'UPSTASH-2026');
        await assert.rejects(
          invites.createInviteCode('12', 9, 600, custom),
          (error) => error.code === 'ALREADY_EXISTS',
        );
        assert.equal(
          await invites.useInviteCode(
            custom.toLowerCase(),
            '12',
            'upstash-custom',
            { userUid: '12' },
          ),
          true,
        );
        assert.equal(await raw.hGet(`invite:${custom}`, 'maxUses'), '3');
        assert.equal(await raw.hGet(`invite:${custom}`, 'currentUses'), '1');
      },
    );
  },
);
