const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { loadSource } = require('./storage-test-loader.cjs');
const {
  hashPassword, verifyPassword, isHashed, isCurrentCredential,
  encodeStoredCredential, credentialForRestore, isValidEncodedCredential,
  verifyAndUpgradePassword,
} = loadSource('password.ts');
const {
  RedisAccountStorage, decodeCacheValue, ACCOUNT_SNAPSHOT_LUA, ACCOUNT_COMPARE_AND_SET_LUA,
} = loadSource('password-storage.ts');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function memoryCredentials(current, legacy = null) {
  const state = { current, legacy };
  let writes = 0;
  return {
    state,
    get writes() { return writes; },
    read: async () => ({ ...state }),
    compare: async (snapshot, credential) => {
      if (state.current !== snapshot.current || state.legacy !== snapshot.legacy) return false;
      if (state.current === null && state.legacy === null) return false;
      state.current = credential;
      state.legacy = null;
      writes++;
      return true;
    },
  };
}

test('new credentials have a version, independent salts, and verify the original password', () => {
  const one = hashPassword('密碼-with:punctuation');
  const two = hashPassword('密碼-with:punctuation');
  assert.match(one, /^scrypt:v1:[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.notEqual(one, two);
  assert.equal(verifyPassword('密碼-with:punctuation', one), true);
  assert.equal(verifyPassword('wrong-password', one), false);
  assert.equal(isHashed(one), true);
  assert.equal(isCurrentCredential(one), true);
});

test('legacy plaintext, both SHA256 forms, and upstream scrypt remain readable', () => {
  const password = 'legacy-secret';
  const digest = sha256(password);
  const upstream = hashPassword(password).replace('scrypt:v1:', '');
  for (const stored of [password, digest, `sha256:${digest}`, `sha256:${digest.toUpperCase()}`, upstream]) {
    assert.equal(verifyPassword(password, stored), true);
    assert.equal(verifyPassword('incorrect', stored), false);
  }
  assert.equal(isHashed(upstream), true);
  assert.equal(isCurrentCredential(upstream), false);
});

test('a digest cannot be used directly as the account password', () => {
  const digest = sha256('actual-secret');
  for (const stored of [digest, `sha256:${digest}`, `sha256:v1:${digest}`]) {
    assert.equal(verifyPassword(digest, stored), false);
    assert.equal(verifyPassword('actual-secret', stored), true);
  }
});

test('64-hex plaintext is supported for new passwords or explicit legacy metadata', () => {
  const password = 'a'.repeat(64);
  assert.equal(verifyPassword(password, hashPassword(password)), true);
  assert.equal(verifyPassword(password, password), false);
  const explicitPlain = `plain:v1:${Buffer.from(password).toString('base64')}`;
  assert.equal(verifyPassword(password, explicitPlain), true);
});

test('malformed typed hashes fail closed without timingSafeEqual length exceptions', () => {
  for (const value of [
    'scrypt:v1:short:broken', `scrypt:v1:${'a'.repeat(32)}:${'g'.repeat(128)}`,
    `${'a'.repeat(32)}:${'g'.repeat(128)}`, 'sha256:broken', 'sha256:v1:broken',
    'plain:v1:not-base64!', 'plain:v1:/w==', 'plain:v2:secret',
  ]) {
    assert.equal(verifyPassword(value, value), false);
    assert.equal(isValidEncodedCredential(value), false);
    assert.throws(() => credentialForRestore(value));
  }
});

test('empty credentials do not create a known empty-password login', () => {
  assert.throws(() => hashPassword(''));
  for (const value of ['', sha256(''), 'plain:v1:']) {
    assert.equal(verifyPassword('', value), false);
  }
});

test('backup encoding preserves credential semantics without rehashing', () => {
  const secret = 'backup-secret';
  const digest = sha256(secret);
  assert.equal(encodeStoredCredential(digest, 'info'), `sha256:v1:${digest}`);
  for (const value of [secret, digest, `sha256:${digest}`, hashPassword(secret)]) {
    const exported = encodeStoredCredential(value, 'pwd');
    assert.equal(isValidEncodedCredential(exported), true);
    assert.equal(credentialForRestore(exported), exported);
    assert.equal(verifyPassword(secret, exported), true);
  }
  assert.throws(() => credentialForRestore(secret));
});

test('failed legacy verification never writes or upgrades anything', async () => {
  const memory = memoryCredentials(sha256('secret'), null);
  assert.equal(await verifyAndUpgradePassword('wrong', memory.read, memory.compare), false);
  assert.equal(await verifyAndUpgradePassword(memory.state.current, memory.read, memory.compare), false);
  assert.equal(memory.writes, 0);
  assert.equal(memory.state.current, sha256('secret'));
});

test('successful verification upgrades every legacy shape and removes the old field', async () => {
  const secret = 'upgrade-secret';
  for (const [current, legacy] of [
    [secret, null], [sha256(secret), null], [`sha256:${sha256(secret)}`, null],
    [hashPassword(secret).replace('scrypt:v1:', ''), null], [null, sha256(secret)],
  ]) {
    const memory = memoryCredentials(current, legacy);
    assert.equal(await verifyAndUpgradePassword(secret, memory.read, memory.compare), true);
    assert.equal(isCurrentCredential(memory.state.current), true);
    assert.equal(memory.state.legacy, null);
    assert.equal(verifyPassword(secret, memory.state.current), true);
  }
});

test('the canonical credential takes precedence over a conflicting info password', async () => {
  const memory = memoryCredentials(hashPassword('current-secret'), sha256('old-secret'));
  assert.equal(await verifyAndUpgradePassword('old-secret', memory.read, memory.compare), false);
  assert.equal(memory.writes, 0);
  assert.equal(await verifyAndUpgradePassword('current-secret', memory.read, memory.compare), true);
  assert.equal(memory.state.legacy, null);
});

test('a concurrent reset wins over an in-flight legacy login upgrade', async () => {
  const memory = memoryCredentials(sha256('old-secret'));
  let raced = false;
  const compare = async (snapshot, credential) => {
    if (!raced) {
      raced = true;
      memory.state.current = hashPassword('new-secret');
    }
    return memory.compare(snapshot, credential);
  };
  assert.equal(await verifyAndUpgradePassword('old-secret', memory.read, compare), false);
  assert.equal(verifyPassword('new-secret', memory.state.current), true);
  assert.equal(verifyPassword('old-secret', memory.state.current), false);
});

test('an in-flight login cannot recreate a deleted account', async () => {
  const memory = memoryCredentials(null, sha256('old-secret'));
  const compare = async (snapshot, credential) => {
    memory.state.current = null;
    memory.state.legacy = null;
    return memory.compare(snapshot, credential);
  };
  assert.equal(await verifyAndUpgradePassword('old-secret', memory.read, compare), false);
  assert.deepEqual(memory.state, { current: null, legacy: null });
});

test('Redis conditional password updates compare canonical credentials and pass the same raw snapshot to CAS', async () => {
  const snapshot = { current: null, legacy: sha256('legacy-secret'), email: ' Owner@Example.COM ' };
  for (const response of [JSON.stringify(snapshot), snapshot]) {
    const writes = [];
    const account = new RedisAccountStorage({
      eval: async (script, keys, args) => {
        if (script === ACCOUNT_SNAPSHOT_LUA) {
          assert.deepEqual(keys, ['u:conditional:pwd', 'u:conditional:info', 'u:conditional:email']);
          return response;
        }
        assert.equal(script, ACCOUNT_COMPARE_AND_SET_LUA);
        writes.push({ keys, args });
        return 1;
      },
    });
    const credential = await account.getUserCredential('conditional');
    assert.equal(credential, `sha256:v1:${snapshot.legacy}`);
    await account.changePassword('conditional', 'replacement-secret', { credential, email: 'owner@example.com' });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].keys, ['u:conditional:pwd', 'u:conditional:info', 'users:list', 'u:conditional:email']);
    assert.deepEqual(writes[0].args.slice(0, 4), ['0', '', '1', snapshot.legacy]);
    assert.equal(isCurrentCredential(writes[0].args[4]), true);
    assert.equal(verifyPassword('replacement-secret', writes[0].args[4]), true);
    assert.deepEqual(writes[0].args.slice(6), ['conditional', '1', '1', snapshot.email]);
  }
});

test('Redis rejects stale credentials, changed emails, and unreadable replacements before any write', async () => {
  const credential = encodeStoredCredential(sha256('original-secret'));
  for (const snapshot of [
    { current: sha256('changed-secret'), legacy: null, email: 'owner@example.com' },
    { current: credential, legacy: null, email: 'new@example.com' },
    { current: 'scrypt:v1:broken', legacy: null, email: 'owner@example.com' },
    { current: null, legacy: null, email: null },
  ]) {
    let reads = 0;
    const account = new RedisAccountStorage({
      eval: async script => {
        assert.equal(script, ACCOUNT_SNAPSHOT_LUA, 'a rejected expectation must never attempt a write');
        reads++;
        return snapshot;
      },
    });
    await assert.rejects(account.changePassword('conditional', 'replacement-secret', {
      credential, email: 'owner@example.com',
    }), { code: 'ACCOUNT_CHANGED' });
    assert.equal(reads, 1);
  }
});

test('Redis surfaces a lost conditional CAS without retrying against a newer account snapshot', async () => {
  const credential = hashPassword('original-secret');
  const calls = [];
  const account = new RedisAccountStorage({
    eval: async (script, _keys, args) => {
      calls.push(script);
      if (script === ACCOUNT_SNAPSHOT_LUA) return { current: credential, legacy: null, email: 'new@example.com' };
      assert.equal(script, ACCOUNT_COMPARE_AND_SET_LUA);
      assert.equal(args[7], '0', 'email is only part of the condition when supplied');
      return 0; // The atomic write found a concurrent credential/email change or deletion.
    },
  });
  await assert.rejects(account.changePassword('conditional', 'replacement-secret', { credential }), {
    code: 'ACCOUNT_CHANGED',
  });
  assert.deepEqual(calls, [ACCOUNT_SNAPSHOT_LUA, ACCOUNT_COMPARE_AND_SET_LUA]);
});

test('mixed Redis enumeration keeps real V1/V2 accounts and rejects stale list-only entries', async () => {
  const account = new RedisAccountStorage({
    list: async () => ['listed', 'both', 'deleted'],
    scan: async pattern => pattern === 'u:*:pwd' ? ['u:pwd-only:pwd', 'u:both:pwd'] : ['u:info-only:info', 'u:both:info'],
    eval: async (_script, keys) => keys[0] === 'u:deleted:pwd' ? 0 : 1,
  });
  assert.deepEqual(new Set(await account.getAllUsers()), new Set(['listed', 'both', 'pwd-only', 'info-only']));
});

test('stale OIDC reverse mappings are rejected when the target binding is gone', async () => {
  let info = null;
  const account = new RedisAccountStorage({ get: async () => 'same-name', getInfo: async () => info, scan: async () => [] });
  assert.equal(await account.getUserByOidcSub('old-sub'), null);
  info = { oidcSub: 'new-sub' };
  assert.equal(await account.getUserByOidcSub('old-sub'), null);
  info = { oidcSub: 'old-sub' };
  assert.equal(await account.getUserByOidcSub('old-sub'), 'same-name');
});

test('Redis OIDC lookup recovers an unindexed legacy binding and rejects duplicate subjects', async () => {
  const users = { legacy: { oidcSub: 'bare-sub' } };
  const account = new RedisAccountStorage({
    get: async () => null,
    scan: async () => Object.keys(users).map(user => `u:${user}:info`),
    getInfo: async key => users[key.slice(2, -5)],
  });
  assert.equal(await account.getUserByOidcSub('bare-sub'), 'legacy');
  users.duplicate = { oidcSub: 'bare-sub' };
  await assert.rejects(account.getUserByOidcSub('bare-sub'), /多个账号/);
});

test('Redis legacy info emails stay readable, while standalone email takes precedence', async () => {
  const info = { email: ' Info@Example.COM ' };
  let standalone = null;
  const account = new RedisAccountStorage({
    get: async () => standalone,
    getInfo: async () => info,
    scan: async pattern => pattern === 'u:*:info' ? ['u:legacy:info'] : [],
    eval: async () => 1,
  });
  assert.equal(await account.getUserEmail('legacy'), 'info@example.com');
  assert.equal(await account.getUsernameByEmail(' INFO@EXAMPLE.COM '), 'legacy');
  standalone = ' New@Example.COM ';
  assert.equal(await account.getUserEmail('legacy'), 'new@example.com');
  assert.equal(await account.getUsernameByEmail('info@example.com'), null);
});

test('cache decoding preserves false, zero, objects, strings, and null', () => {
  assert.deepEqual(decodeCacheValue('{"username":"alice"}'), { username: 'alice' });
  assert.equal(decodeCacheValue('false'), false);
  assert.equal(decodeCacheValue(false), false);
  assert.equal(decodeCacheValue('0'), 0);
  assert.equal(decodeCacheValue('unencoded'), 'unencoded');
  assert.equal(decodeCacheValue(null), null);
});
