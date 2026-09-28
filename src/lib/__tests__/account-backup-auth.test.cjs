const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { test } = require('node:test');
const { loadSource, createSourceLoader } = require('./storage-test-loader.cjs');
const { accountProfile, readAccountBackup, prepareAccountRestore } = loadSource('account-backup.ts');
const { encodeStoredCredential, hashPassword, verifyPassword } = loadSource('password.ts');
const { getVerifiedAuthInfo } = createSourceLoader({
  './db': { db: {
    getUserIdentity: async (username) => ({ uid: `uid:${username}`, username, storageKey: username }),
    isLegacyUsernameRetired: async () => false,
  } },
})('auth.server.ts');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const backup = (overrides = {}) => ({
  account: {
    version: 1,
    credential: encodeStoredCredential('legacy-password'),
    email: null,
    profile: { role: 'user' },
    ...overrides,
  },
});

test('old backups restore canonical pwd instead of reviving an older info password', () => {
  const account = readAccountBackup({
    password: 'new-password',
    userInfoV2: { password: digest('old-password'), role: 'user', oidcSub: 'old-sub' },
  });
  assert.equal(verifyPassword('new-password', account.credential), true);
  assert.equal(verifyPassword('old-password', account.credential), false);
  assert.equal(account.profile.oidcSub, 'old-sub');
});

test('info-only legacy backup credentials remain verifiable without a double hash', () => {
  const account = readAccountBackup({ userInfoV2: { password: digest('secret'), role: 'admin' } });
  assert.equal(account.credential, `sha256:v1:${digest('secret')}`);
  assert.equal(verifyPassword('secret', account.credential), true);
  assert.equal(verifyPassword(digest('secret'), account.credential), false);
});

test('backup profile preserves approval, bans, bindings and timestamps without password fields', () => {
  const profile = accountProfile({
    username: 'person', password: 'do-not-copy', role: 'admin', pending: true,
    banned: 'true', source: 'application', createdAt: 42, oidcSub: 'sub',
    tags: ['group'], enabledApis: ['source'],
  });
  assert.equal(profile.pending, true);
  assert.equal(profile.banned, true);
  assert.equal(profile.createdAt, 42);
  assert.equal(profile.source, 'application');
  assert.equal(profile.password, undefined);
  assert.equal(profile.username, undefined);
});

test('new backup round trips an encoded credential without changing it', () => {
  const credential = hashPassword('original-password');
  const account = readAccountBackup(backup({ credential, email: ' Person@Example.COM ' }), 2);
  assert.equal(account.credential, credential);
  assert.equal(account.email, 'person@example.com');
  assert.equal(verifyPassword('original-password', account.credential), true);
});

test('preflight rejects malformed credentials and invalid versions, even for an empty file', () => {
  for (const credential of ['plain-password', 'scrypt:v1:broken', undefined, 42]) {
    assert.throws(() => prepareAccountRestore({ user: backup({ credential }) }, 2, []));
  }
  assert.throws(() => prepareAccountRestore({}, 999, []), /版本/);
  assert.throws(() => prepareAccountRestore([], 2, []), /格式/);
});

test('preflight rejects duplicate or invalid emails before starting restoration', () => {
  assert.throws(() => prepareAccountRestore({
    one: backup({ email: 'One@Example.com' }),
    two: backup({ email: ' one@example.COM ' }),
  }, 2, []), /重复邮箱/);
  assert.throws(() => prepareAccountRestore({ user: backup({ email: 'invalid-address' }) }, 2, []), /邮箱/);
});

test('preflight rejects duplicate OIDC bindings and missing non-owner credentials', () => {
  const profile = { role: 'user', oidcSub: 'same-sub' };
  assert.throws(() => prepareAccountRestore({ one: backup({ profile }), two: backup({ profile }) }, 2, []), /重复 OIDC/);
  assert.throws(() => prepareAccountRestore({ user: backup({ credential: null }) }, 2, []), /缺少可恢复/);
  const accounts = prepareAccountRestore({
    oidc: backup({ credential: null, profile }),
    owner: backup({ credential: null }),
  }, 2, [], 'owner');
  assert.equal(accounts.size, 2);
});

test('legacy configured approval and email fields survive account restoration', () => {
  const accounts = prepareAccountRestore({ user: { password: 'secret' } }, undefined, [{
    username: 'user', role: 'user', pending: true, banned: true,
    createdAt: 123, source: 'friend', email: 'user@example.com',
  }]);
  assert.equal(accounts.get('user').profile.pending, true);
  assert.equal(accounts.get('user').profile.banned, true);
  assert.equal(accounts.get('user').profile.createdAt, 123);
  assert.equal(accounts.get('user').email, 'user@example.com');
});

function request(cookie) {
  return { cookies: { get: (name) => name === 'user_auth' ? { value: JSON.stringify(cookie) } : undefined } };
}

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('sensitive account actions reject forged role and trusted-network flags', async (t) => {
  environment(t, { PASSWORD: 'test-server-secret', NEXT_PUBLIC_STORAGE_TYPE: 'redis' });
  assert.equal(await getVerifiedAuthInfo(request({ username: 'owner', role: 'owner', trustedNetwork: true })), null);
  assert.equal(await getVerifiedAuthInfo(request({ username: 'owner', signature: 'not-hex' })), null);
});

test('existing signed sessions remain valid and client roles are not trusted', async (t) => {
  environment(t, { PASSWORD: 'test-server-secret', NEXT_PUBLIC_STORAGE_TYPE: 'redis' });
  const signature = createHmac('sha256', 'test-server-secret').update('member').digest('hex');
  assert.deepEqual(await getVerifiedAuthInfo(request({ username: 'member', signature, role: 'owner' })), { uid: 'uid:member', username: 'member', sessionVersion: 0 });
  assert.equal(await getVerifiedAuthInfo(request({ username: 'other', signature })), null);
});

test('localstorage verification uses the configured owner and rejects a different password', async (t) => {
  environment(t, { PASSWORD: 'test-server-secret', NEXT_PUBLIC_STORAGE_TYPE: 'localstorage', USERNAME: 'configured-owner' });
  assert.deepEqual(await getVerifiedAuthInfo(request({ password: 'test-server-secret', username: 'forged' })), { uid: 'local-owner', username: 'configured-owner', sessionVersion: 0 });
  assert.equal(await getVerifiedAuthInfo(request({ password: 'incorrect' })), null);
});
