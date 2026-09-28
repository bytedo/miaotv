const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createIdentityFixture } = require('./user-identity-fixture.cjs');

function fixture(t, storageType = 'redis') {
  const environment = {
    PASSWORD: 'isolated-admin-secret',
    USERNAME: 'owner',
    NEXT_PUBLIC_STORAGE_TYPE: storageType,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const config = {
    UserConfig: {
      Users: [
        { username: 'owner', role: 'owner' },
        { username: 'admin', role: 'admin' },
        { username: 'member', role: 'user' },
      ],
    },
  };
  const stored = new Map([
    ['admin', { role: 'admin' }],
    ['member', { role: 'user' }],
  ]);
  const calls = [];
  let creationError;
  class InviteCodeError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const identities = createIdentityFixture(() =>
    [...stored].map(([username, user]) => ({ ...user, username })),
  );
  const db = {
    ...identities,
    checkUserExist: async (reference) => !!identities.findUser(reference),
    getUserInfoV2: async (reference) => identities.findUser(reference) || null,
  };
  const load = createSourceLoader({
    'next/server': {
      NextResponse: {
        json: (body, init) => ({
          status: init?.status || 200,
          json: async () => body,
        }),
      },
    },
    '@/lib/config': { getConfig: async () => config },
    '@/lib/db': { db },
    './db': { db },
    '@/lib/invite-code': {
      InviteCodeError,
      createInviteCode: async (...args) => {
        calls.push(['create', ...args]);
        if (creationError) throw creationError;
        return args[3] || 'ABCDEFGH';
      },
      getAllInviteCodes: async () => {
        calls.push(['list']);
        return [];
      },
      removeInviteCode: async (code) => {
        calls.push(['delete', code]);
        return true;
      },
      toggleInviteCode: async (...args) => {
        calls.push(['toggle', ...args]);
        return true;
      },
    },
  });
  const request = (cookie, body = {}) => ({
    url: 'https://miaotv.test/api/admin/invites?code=ABCDEFGH',
    json: async () => body,
    cookies: {
      get: (name) =>
        name === 'user_auth' ? { value: JSON.stringify(cookie) } : undefined,
    },
  });
  const signed = (username, extra = {}) => ({
    username,
    signature: createHmac('sha256', environment.PASSWORD)
      .update(username)
      .digest('hex'),
    ...extra,
  });
  return {
    config,
    stored,
    calls,
    request,
    signed,
    identities,
    InviteCodeError,
    failCreation(error) {
      creationError = error;
    },
    ...load('admin-auth.ts'),
    routes: load('../app/api/admin/invites/route.ts'),
  };
}

test('admin authorization verifies signed identity before trusting owner or configured roles', async (t) => {
  const { request, signed, getAdminRoleFromRequest, ensureAdmin } = fixture(t);
  for (const cookie of [
    { username: 'owner', role: 'owner', trustedNetwork: true },
    { username: 'admin', role: 'admin' },
    signed('member', { username: 'owner' }),
    signed('member', { role: 'owner', trustedNetwork: true }),
  ]) {
    assert.equal(await getAdminRoleFromRequest(request(cookie)), null);
    await assert.rejects(ensureAdmin(request(cookie)), /UNAUTHORIZED/);
  }
  assert.equal(await ensureAdmin(request(signed('owner'))), 'owner');
  assert.equal(
    await ensureAdmin(request(signed('admin', { role: 'user' }))),
    'admin',
  );
});

test('admin authorization rejects pending, banned and deleted accounts while retaining explicit approvals', async (t) => {
  const { request, signed, config, stored, getAdminRoleFromRequest } =
    fixture(t);
  const configured = config.UserConfig.Users.find(
    (user) => user.username === 'admin',
  );
  for (const flag of ['pending', 'banned']) {
    stored.get('admin')[flag] = true;
    assert.equal(await getAdminRoleFromRequest(request(signed('admin'))), null);
    configured[flag] = false;
    assert.equal(
      await getAdminRoleFromRequest(request(signed('admin'))),
      'admin',
    );
    configured[flag] = true;
    stored.get('admin')[flag] = false;
    assert.equal(await getAdminRoleFromRequest(request(signed('admin'))), null);
    delete configured[flag];
    delete stored.get('admin')[flag];
  }
  stored.delete('admin');
  assert.equal(await getAdminRoleFromRequest(request(signed('admin'))), null);
});

test('all invitation administration methods reject unsigned and unapproved callers before touching storage', async (t) => {
  const { request, signed, stored, calls, routes } = fixture(t);
  stored.get('admin').pending = true;
  for (const cookie of [
    { username: 'owner', trustedNetwork: true },
    signed('admin'),
  ]) {
    for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
      assert.equal(
        (await routes[method](request(cookie, { disabled: true }))).status,
        401,
      );
    }
  }
  assert.deepEqual(calls, []);
});

test('invitation creator uses the verified localstorage owner instead of a cookie username', async (t) => {
  const { request, getAdminRoleFromRequest, routes, calls } = fixture(
    t,
    'localstorage',
  );
  const valid = request({
    password: 'isolated-admin-secret',
    username: 'forged-name',
  });
  assert.equal(await getAdminRoleFromRequest(valid), 'owner');
  assert.equal((await routes.POST(valid)).status, 200);
  assert.deepEqual(calls, [['create', 'local-owner', 10, 604800, undefined]]);
  assert.equal(
    await getAdminRoleFromRequest(
      request({ password: 'wrong', username: 'owner' }),
    ),
    null,
  );
});

test('invitation limits require bounded integers before creating a code', async (t) => {
  const { request, signed, routes, calls, identities } = fixture(t);
  for (const body of [
    { maxUses: '10' },
    { maxUses: 1.5 },
    { maxUses: null },
    { maxUses: {} },
    { maxUses: 0 },
    { maxUses: 1001 },
    { expiresIn: '3600' },
    { expiresIn: 3600.5 },
    { expiresIn: null },
    { expiresIn: {} },
    { expiresIn: 3599 },
    { expiresIn: 31536001 },
  ]) {
    assert.equal(
      (await routes.POST(request(signed('owner'), body))).status,
      400,
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(
    (
      await routes.POST(
        request(signed('admin'), { maxUses: 1, expiresIn: 3600 }),
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, [
    [
      'create',
      (await identities.getUserIdentity('admin')).uid,
      1,
      3600,
      undefined,
    ],
  ]);
});

test('custom invitation API normalizes codes and keeps blank input on the random path', async (t) => {
  const f = fixture(t);
  const response = await f.routes.POST(
    f.request(f.signed('admin'), {
      code: '  miao-2026_vip  ',
      maxUses: 3,
      expiresIn: 86400,
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, 'MIAO-2026_VIP');
  assert.deepEqual(f.calls[0], [
    'create',
    (await f.identities.getUserIdentity('admin')).uid,
    3,
    86400,
    'MIAO-2026_VIP',
  ]);
  for (const code of [undefined, '', '   ']) {
    assert.equal(
      (await f.routes.POST(f.request(f.signed('owner'), { code }))).status,
      200,
    );
    assert.equal(f.calls.at(-1)[4], undefined);
  }
});

test('malformed invitation requests are rejected before any creation', async (t) => {
  const f = fixture(t);
  for (const code of [
    null,
    1234,
    true,
    [],
    {},
    'abc',
    'A'.repeat(33),
    'some code',
    'a/bc',
    '邀请码',
    'abßc',
  ]) {
    const response = await f.routes.POST(
      f.request(f.signed('owner'), { code }),
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /4–32/);
  }
  for (const body of [null, [], 'invite', 7, true]) {
    assert.equal(
      (await f.routes.POST(f.request(f.signed('owner'), body))).status,
      400,
    );
  }
  const invalidJson = f.request(f.signed('owner'));
  invalidJson.json = async () => {
    throw new SyntaxError('bad json');
  };
  assert.equal((await f.routes.POST(invalidJson)).status, 400);
  assert.deepEqual(f.calls, []);
});

test('an existing custom invitation returns a conflict without reporting success', async (t) => {
  const f = fixture(t);
  f.failCreation(
    new f.InviteCodeError('ALREADY_EXISTS', '邀请码已存在，请更换一个'),
  );
  const response = await f.routes.POST(
    f.request(f.signed('owner'), { code: 'miao-2026' }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: '邀请码已存在，请更换一个',
  });
});
