const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createIdentityFixture } = require('./user-identity-fixture.cjs');

function fixture(t, options = {}) {
  const environment = { PASSWORD: 'isolated-owner-secret', USERNAME: 'owner', NEXT_PUBLIC_STORAGE_TYPE: 'redis' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const config = { UserConfig: { Users: [
    { username: 'owner', role: 'owner' },
    { username: 'admin', role: 'admin' },
    { username: 'applicant', role: 'user', pending: true, email: 'applicant@example.test' },
    { username: 'member', role: 'user', pending: false },
  ] } };
  const state = { saved: null, created: [], deleted: [], notified: [], accounts: new Map(config.UserConfig.Users.map(user => [user.username, { ...user }])) };
  state.accounts.set('info-only', { username: 'info-only', role: 'user' });
  const identities = createIdentityFixture(() => [...state.accounts.values()]);
  const db = {
    ...identities,
    checkUserExist: async reference => reference === 'info-only' || !!identities.findUser(reference),
    getUserInfoV2: async reference => identities.findUser(reference) || null,
    registerUser: async name => state.created.push(name),
    deleteUser: async reference => state.deleted.push(reference),
    saveAdminConfig: async value => { state.saved = structuredClone(value); },
  };
  const load = createSourceLoader({
    'next/server': { NextResponse: { json: (body, init) => ({ status: init?.status || 200, json: async () => body }) } },
    '@/lib/config': { getConfig: async () => structuredClone(state.saved || config), clearConfigCache() {} },
    '@/lib/db': { db },
    './db': { db },
    '@/lib/emailService': {
      sendApprovalEmail: async () => {
        assert.ok(state.saved, 'Approval must be saved before notifying');
        state.notified.push('approved');
        if (options.mailDelivery) await options.mailDelivery();
        if (options.mailFailure) throw new Error('Isolated simulated mail failure');
      },
      sendRejectionEmail: async () => { assert.ok(state.saved); state.notified.push('rejected'); },
    },
  });
  const { POST } = load('../app/api/admin/user/route.ts');
  const request = (action, targetUsername, operator = 'owner', signed = true) => ({
    json: async () => ({ action, targetUsername, targetPassword: 'isolated-password' }),
    cookies: { get: () => ({ value: JSON.stringify({ username: operator,
      ...(signed ? { signature: createHmac('sha256', environment.PASSWORD).update(operator).digest('hex') } : { role: 'owner', trustedNetwork: true }),
    }) }) },
  });
  return { POST, request, state };
}

test('approval persists false so stored pending creation metadata cannot block login', async t => {
  const { POST, request, state } = fixture(t);
  const result = await POST(request('approve', 'applicant'));
  assert.equal(result.status, 200);
  assert.equal(state.saved.UserConfig.Users.find(user => user.username === 'applicant').pending, false);
  assert.deepEqual(state.notified, ['approved']);
});

test('a notification failure does not undo a saved approval', async t => {
  const { POST, request, state } = fixture(t, { mailFailure: true });
  assert.equal((await POST(request('approve', 'applicant'))).status, 200);
  assert.equal(state.saved.UserConfig.Users.find(user => user.username === 'applicant').pending, false);
});

test('unsigned cookies cannot create accounts even when they claim owner and trusted network', async t => {
  const { POST, request, state } = fixture(t);
  assert.equal((await POST(request('add', 'new-user', 'owner', false))).status, 401);
  assert.deepEqual(state.created, []);
  assert.equal(state.saved, null);
});

test('admin creation does not overwrite an info-only account missing from the cached config', async t => {
  const { POST, request, state } = fixture(t);
  assert.equal((await POST(request('add', 'info-only'))).status, 400);
  assert.deepEqual(state.created, []);
});

test('reject cannot be used as a second deletion endpoint for an approved account', async t => {
  const { POST, request, state } = fixture(t);
  assert.equal((await POST(request('reject', 'member', 'admin'))).status, 400);
  assert.deepEqual(state.deleted, []);
});

for (const stateChange of ['deleted', 'pending', 'banned']) {
  test(`a ${stateChange} administrator cannot use stale cached configuration to create accounts`, async t => {
    const { POST, request, state } = fixture(t);
    if (stateChange === 'deleted') state.accounts.delete('admin');
    else state.accounts.get('admin')[stateChange] = true;
    assert.equal((await POST(request('add', 'new-user', 'admin'))).status, 401);
    assert.deepEqual(state.created, []);
    assert.equal(state.saved, null);
  });
}

test('concurrent approval requests persist one decision and send one notification', async t => {
  const { POST, request, state } = fixture(t);
  const results = await Promise.all([
    POST(request('approve', 'applicant')),
    POST(request('approve', 'applicant')),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.deepEqual(state.notified, ['approved']);
  assert.equal(state.saved.UserConfig.Users.find(user => user.username === 'applicant').pending, false);
});

test('concurrent account changes preserve both the approval and the ban', async t => {
  const { POST, request, state } = fixture(t);
  const results = await Promise.all([
    POST(request('approve', 'applicant')),
    POST(request('ban', 'member')),
  ]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(state.saved.UserConfig.Users.find(user => user.username === 'applicant').pending, false);
  assert.equal(state.saved.UserConfig.Users.find(user => user.username === 'member').banned, true);
  assert.deepEqual(state.notified, ['approved']);
});

test('slow approval delivery does not hold the account write lock', { timeout: 5000 }, async t => {
  let markMailStarted;
  let releaseMail;
  const started = new Promise(resolve => { markMailStarted = resolve; });
  const delivery = new Promise(resolve => { releaseMail = resolve; });
  t.after(() => releaseMail());
  const { POST, request, state } = fixture(t, {
    mailDelivery: async () => { markMailStarted(); await delivery; },
  });
  let approvalFinished = false;
  const approval = POST(request('approve', 'applicant')).then(result => {
    approvalFinished = true;
    return result;
  });
  await started;
  let banResponse;
  const ban = POST(request('ban', 'member')).then(result => { banResponse = result; return result; });

  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(approvalFinished, false, 'the simulated notification is still waiting');
    assert.equal(banResponse?.status, 200, 'unrelated account writes must finish before mail delivery');
    assert.equal(state.saved.UserConfig.Users.find(user => user.username === 'applicant').pending, false);
    assert.equal(state.saved.UserConfig.Users.find(user => user.username === 'member').banned, true);
    assert.deepEqual(state.notified, ['approved']);
  } finally {
    releaseMail();
    await Promise.all([approval, ban]);
  }
});
