const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');

const ids = {
  owner: '1',
  admin: '2',
  member: '12',
  other: '13',
};

function fixture(t, operator = 'owner') {
  const previous = {
    USERNAME: process.env.USERNAME,
    NEXT_PUBLIC_STORAGE_TYPE: process.env.NEXT_PUBLIC_STORAGE_TYPE,
  };
  process.env.USERNAME = 'owner';
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'kvrocks';
  t.after(() =>
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }),
  );
  const state = {
    config: {
      UserConfig: {
        Users: [
          { uid: ids.owner, username: 'owner', role: 'owner' },
          { uid: ids.admin, username: 'manager', role: 'admin' },
          {
            uid: ids.member,
            username: 'member',
            role: 'user',
            email: 'member@example.test',
            tags: ['friends'],
          },
          { uid: ids.other, username: 'second', role: 'user' },
        ],
      },
    },
    renamed: [],
    writes: [],
    saved: 0,
    cleared: 0,
    counter: 13,
    aliases: new Map(),
  };
  const principals = {
    owner: { uid: ids.owner, username: 'owner' },
    admin: { uid: ids.admin, username: 'manager' },
    member: { uid: ids.member, username: 'member' },
  };
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const load = createSourceLoader({
    'next/server': {
      NextResponse: {
        json(body, init) {
          return {
            status: init?.status || 200,
            json: async () => body,
            deletedCookies: [],
            cookies: {
              delete(name) {
                this.deleted.push(name);
              },
              deleted: [],
            },
          };
        },
      },
    },
    '@/lib/auth.server': {
      getVerifiedAuthInfo: async () => principals[operator] || null,
    },
    '@/lib/admin-auth': {
      getAdminRoleFromRequest: async () =>
        ['owner', 'admin'].includes(operator) ? operator : null,
    },
    '@/lib/config': {
      getConfig: async () => structuredClone(state.config),
      clearConfigCache() {
        state.cleared++;
      },
    },
    '@/lib/emailService': {
      sendApprovalEmail: async () => {},
      sendRejectionEmail: async () => {},
    },
    '@/lib/db': {
      db: {
        allocateUserUid: async () => String(++state.counter),
        getUserIdentity: async (username) =>
          state.config.UserConfig.Users.find(
            (user) => user.username === username,
          ) || null,
        getUserIdentityByUid: async (uid) =>
          state.config.UserConfig.Users.find(
            (user) => user.uid === (state.aliases.get(uid) || uid),
          ) || null,
        changePassword: async (uid) => state.writes.push(['password', uid]),
        deleteUser: async (uid) => state.writes.push(['delete', uid]),
        registerUser: async (name) => state.writes.push(['register', name]),
        createUserV2: async (
          name,
          password,
          role,
          tags,
          oidcSub,
          enabledApis,
          email,
          metadata,
        ) => {
          state.writes.push(['create', name, metadata.uid, tags]);
        },
        saveAdminConfig: async (config) => {
          state.saved++;
          state.config = structuredClone(config);
        },
        renameUser: async (uid, name, expected) => {
          const user = state.config.UserConfig.Users.find(
            (user) => user.uid === uid,
          );
          if (!user) throw fail('USER_NOT_FOUND', '用户不存在');
          if (user.username !== expected)
            throw fail('STALE_USERNAME', '用户名已发生变化');
          if (
            state.config.UserConfig.Users.some((user) => user.username === name)
          )
            throw fail('USERNAME_EXISTS', '该用户名已被注册');
          state.renamed.push({ uid, from: user.username, to: name });
          user.username = name;
          return { uid, username: name, storageKey: 'unchanged-namespace' };
        },
      },
    },
  });
  const { POST } = load('../app/api/admin/user/route.ts');
  return { state, post: (body) => POST({ json: async () => body }) };
}

test('rename targets the UID and preserves the same profile without a stale full-config write', async (t) => {
  const f = fixture(t);
  const response = await f.post({
    action: 'changeUsername',
    targetUid: ids.member,
    newUsername: '新用户',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    uid: ids.member,
    username: '新用户',
    requiresRelogin: false,
  });
  assert.deepEqual(f.state.renamed, [
    { uid: ids.member, from: 'member', to: '新用户' },
  ]);
  const member = f.state.config.UserConfig.Users.find(
    (user) => user.uid === ids.member,
  );
  assert.equal(member.email, 'member@example.test');
  assert.deepEqual(member.tags, ['friends']);
  assert.equal(f.state.saved, 0);
  assert.equal(f.state.cleared, 1);
});

test('admin creation assigns the same UID to storage and the configured profile when a name is reused', async (t) => {
  const f = fixture(t);
  f.state.config.UserConfig.Users.find(
    (user) => user.uid === ids.member,
  ).username = 'renamed';
  const response = await f.post({
    action: 'add',
    targetUsername: 'member',
    targetPassword: 'fixture-password',
    userGroup: 'friends',
  });
  assert.equal(response.status, 200);
  const created = f.state.config.UserConfig.Users.find(
    (user) => user.username === 'member',
  );
  assert.equal(created.uid, '14');
  assert.notEqual(created.uid, ids.member);
  assert.deepEqual(f.state.writes, [
    ['create', 'member', created.uid, ['friends']],
  ]);
  assert.deepEqual(created.tags, ['friends']);
  assert.equal(
    f.state.config.UserConfig.Users.find((user) => user.uid === ids.member)
      .username,
    'renamed',
  );
});

test('a reused display name cannot redirect UID-targeted rename, password or delete operations', async (t) => {
  const f = fixture(t);
  f.state.config.UserConfig.Users.find(
    (user) => user.uid === ids.member,
  ).username = 'renamed';
  f.state.config.UserConfig.Users.find(
    (user) => user.uid === ids.other,
  ).username = 'member';
  assert.equal(
    (
      await f.post({
        action: 'changeUsername',
        targetUid: ids.member,
        targetUsername: 'member',
        newUsername: 'finalName',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.post({
        action: 'changePassword',
        targetUid: ids.member,
        targetPassword: 'new-password',
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.post({ action: 'deleteUser', targetUid: ids.member })).status,
    200,
  );
  assert.deepEqual(f.state.writes, [
    ['password', ids.member],
    ['delete', ids.member],
  ]);
  assert.equal(
    f.state.config.UserConfig.Users.find((user) => user.uid === ids.other)
      .username,
    'member',
  );
});

test('UID-targeted group changes affect exactly the selected identities', async (t) => {
  const f = fixture(t);
  const response = await f.post({
    action: 'batchUpdateUserGroups',
    userUids: [ids.member, ids.other],
    userGroups: ['new-group'],
  });
  assert.equal(response.status, 200);
  for (const uid of [ids.member, ids.other])
    assert.deepEqual(
      f.state.config.UserConfig.Users.find((user) => user.uid === uid).tags,
      ['new-group'],
    );
  assert.equal(
    f.state.config.UserConfig.Users.find((user) => user.uid === ids.admin).tags,
    undefined,
  );
});

test('an administrator may rename their own account and must sign in again', async (t) => {
  const f = fixture(t, 'admin');
  const response = await f.post({
    action: 'changeUsername',
    targetUid: ids.admin,
    newUsername: 'manager2',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).requiresRelogin, true);
  assert.deepEqual(response.cookies.deleted, ['user_auth', 'auth']);
});

test('ordinary users, unauthenticated requests and protected owner identities cannot rename accounts', async (t) => {
  for (const operator of ['member', 'anonymous']) {
    await t.test(operator, async (t) => {
      const f = fixture(t, operator);
      assert.equal(
        (
          await f.post({
            action: 'changeUsername',
            targetUid: ids.other,
            newUsername: 'changed',
          })
        ).status,
        401,
      );
      assert.equal(f.state.renamed.length, 0);
    });
  }
  await t.test('owner is immutable', async (t) => {
    const f = fixture(t);
    assert.ok(
      [400, 403].includes(
        (
          await f.post({
            action: 'changeUsername',
            targetUid: ids.owner,
            newUsername: 'changed',
          })
        ).status,
      ),
    );
    assert.equal(f.state.renamed.length, 0);
  });
});

test('administrators cannot rename other administrators or assign owner groups', async (t) => {
  const f = fixture(t, 'admin');
  f.state.config.UserConfig.Users.find((user) => user.uid === ids.other).role =
    'admin';
  assert.equal(
    (
      await f.post({
        action: 'changeUsername',
        targetUid: ids.other,
        newUsername: 'changed',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.post({
        action: 'batchUpdateUserGroups',
        userUids: [ids.owner],
        userGroups: ['changed'],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.post({
        action: 'updateUserGroups',
        targetUid: ids.owner,
        userGroups: ['changed'],
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.post({
        action: 'updateUserApis',
        targetUid: ids.owner,
        enabledApis: ['restricted'],
      })
    ).status,
    403,
  );
  assert.equal(f.state.saved, 0);
});

test('duplicate, invalid and unchanged names leave the identity untouched', async (t) => {
  const f = fixture(t);
  for (const name of [
    '',
    'a',
    'bad:name',
    'bad*name',
    'a'.repeat(21),
    {},
    null,
    'member',
  ]) {
    assert.equal(
      (
        await f.post({
          action: 'changeUsername',
          targetUid: ids.member,
          newUsername: name,
        })
      ).status,
      400,
    );
  }
  for (const name of ['owner', 'second']) {
    assert.equal(
      (
        await f.post({
          action: 'changeUsername',
          targetUid: ids.member,
          newUsername: name,
        })
      ).status,
      409,
    );
  }
  assert.equal(f.state.renamed.length, 0);
});

test('unknown UIDs cannot fall back to a supplied username', async (t) => {
  const f = fixture(t);
  const response = await f.post({
    action: 'changeUsername',
    targetUid: '10000000-0000-4000-8000-000000000099',
    targetUsername: 'member',
    newUsername: 'changed',
  });
  assert.equal(response.status, 404);
  assert.equal(f.state.renamed.length, 0);
});

test('a numeric username is created independently of the existing matching UID', async (t) => {
  const f = fixture(t);
  const response = await f.post({
    action: 'add',
    targetUsername: ids.member,
    targetPassword: 'fixture-password',
  });
  assert.equal(response.status, 200);
  const created = f.state.config.UserConfig.Users.find(
    (user) => user.username === ids.member,
  );
  assert.equal(created.uid, '14');
  assert.equal(
    f.state.config.UserConfig.Users.find((user) => user.uid === ids.member)
      .username,
    'member',
  );
  assert.equal(
    (
      await f.post({
        action: 'add',
        targetUsername: ids.member,
        targetPassword: 'fixture-password',
      })
    ).status,
    400,
  );
});

test('requests from an already open UUID user list resolve aliases to canonical numeric targets', async (t) => {
  const f = fixture(t);
  const oldUid = '10000000-0000-4000-8000-000000000003';
  f.state.aliases.set(oldUid, ids.member);
  assert.equal(
    (
      await f.post({
        action: 'changePassword',
        targetUid: oldUid,
        targetPassword: 'fixture-password',
      })
    ).status,
    200,
  );
  assert.deepEqual(f.state.writes, [['password', ids.member]]);
  assert.equal(
    (
      await f.post({
        action: 'batchUpdateUserGroups',
        userUids: [oldUid, ids.other],
        userGroups: ['migrated'],
      })
    ).status,
    200,
  );
  for (const uid of [ids.member, ids.other]) {
    assert.deepEqual(
      f.state.config.UserConfig.Users.find((user) => user.uid === uid).tags,
      ['migrated'],
    );
  }
});
