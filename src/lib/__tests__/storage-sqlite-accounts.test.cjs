const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { loadSource } = require('./storage-test-loader.cjs');
const { SqliteStorage } = loadSource('sqlite.db.ts');
const { hashPassword, encodeStoredCredential } = loadSource('password.ts');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function memoryStorage(t) {
  // Use the explicit in-memory constructor path. Never read a production path.
  const previous = process.env.IS_BUILD_PHASE;
  process.env.IS_BUILD_PHASE = 'true';
  let storage;
  try {
    storage = new SqliteStorage();
  } finally {
    if (previous === undefined) delete process.env.IS_BUILD_PHASE;
    else process.env.IS_BUILD_PHASE = previous;
  }
  t.after(() => storage.close());
  return storage;
}

function seedV1(storage, username, value, createdAt = 100) {
  storage.db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, value, createdAt);
}

function seedV2(storage, username, value, sub = null, createdAt = 100) {
  storage.db.prepare('INSERT INTO users_v2 (username, password, role, banned, tags, enabled_apis, oidc_sub, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
    .run(username, value, 'user', '["group-one"]', '["source-one"]', sub, createdAt);
}

test('SQLite new V1 and V2 accounts share one scrypt credential and both verification APIs', async t => {
  const storage = memoryStorage(t);
  await storage.registerUser('v1', 'one-secret', ' One@Example.COM ');
  await storage.createUserV2('v2', 'two-secret', 'admin', ['group'], 'oidc-2', ['source'], ' Two@Example.COM ');
  for (const [username, password] of [['v1', 'one-secret'], ['v2', 'two-secret']]) {
    assert.equal(await storage.verifyUser(username, password), true);
    assert.equal(await storage.verifyUserV2(username, password), true);
    assert.match(await storage.getUserCredential(username), /^scrypt:v1:/);
    assert.equal(await storage.checkUserExist(username), true);
    assert.equal(await storage.checkUserExistV2(username), true);
  }
  assert.equal(storage.db.prepare('SELECT password FROM users_v2 WHERE username = ?').get('v2').password, '');
  assert.equal(await storage.getUserEmail('v1'), 'one@example.com');
  assert.equal(await storage.getUsernameByEmail(' TWO@EXAMPLE.COM '), 'v2');
  assert.deepEqual((await storage.getUserInfoV2('v2')).tags, ['group']);
  assert.equal(await storage.getUserByOidcSub('oidc-2'), 'v2');
});

test('SQLite info-only users are existing accounts and upgrade only after correct authentication', async t => {
  const storage = memoryStorage(t);
  seedV2(storage, 'legacy', sha256('legacy-secret'), 'legacy-sub', 42);
  assert.equal(await storage.checkUserExist('legacy'), true);
  assert.deepEqual(await storage.getAllUsers(), ['legacy']);
  await assert.rejects(storage.registerUser('legacy', 'attacker-secret'), /已被注册/);
  await assert.rejects(storage.createUserV2('legacy', 'attacker-secret'), /已被注册/);
  assert.equal(await storage.verifyUser('legacy', sha256('legacy-secret')), false);
  assert.equal(storage.db.prepare('SELECT 1 FROM users WHERE username = ?').get('legacy'), undefined);
  assert.equal(await storage.verifyUserV2('legacy', 'legacy-secret'), true);
  const canonical = storage.db.prepare('SELECT password_hash, created_at FROM users WHERE username = ?').get('legacy');
  assert.match(canonical.password_hash, /^scrypt:v1:/);
  assert.equal(canonical.created_at, 42);
  assert.equal(storage.db.prepare('SELECT password FROM users_v2 WHERE username = ?').get('legacy').password, '');
  assert.equal(await storage.getUserByOidcSub('legacy-sub'), 'legacy');
});

test('SQLite mixed enumeration never drops V1 users when any V2 users exist', async t => {
  const storage = memoryStorage(t);
  seedV1(storage, 'v1-only', 'secret', 1);
  seedV2(storage, 'v2-only', sha256('secret'), null, 2);
  seedV1(storage, 'both', 'secret', 3);
  seedV2(storage, 'both', sha256('secret'), null, 3);
  assert.deepEqual(await storage.getAllUsers(), ['v1-only', 'v2-only', 'both']);
});

test('SQLite canonical precedence and password reset invalidate stale info credentials', async t => {
  const storage = memoryStorage(t);
  seedV1(storage, 'mixed', hashPassword('current-secret'));
  seedV2(storage, 'mixed', sha256('old-secret'));
  assert.equal(await storage.verifyUserV2('mixed', 'old-secret'), false);
  await storage.changePassword('mixed', 'reset-secret');
  assert.equal(await storage.verifyUser('mixed', 'current-secret'), false);
  assert.equal(await storage.verifyUserV2('mixed', 'old-secret'), false);
  assert.equal(await storage.verifyUserV2('mixed', 'reset-secret'), true);
  assert.equal(storage.db.prepare('SELECT password FROM users_v2 WHERE username = ?').get('mixed').password, '');
});

test('SQLite conditional password changes accept canonical legacy credentials and clear stale info passwords', async t => {
  const storage = memoryStorage(t);
  seedV1(storage, 'conditional', 'original-secret');
  seedV2(storage, 'conditional', sha256('stale-secret'));
  storage.db.prepare('INSERT INTO user_emails (username, email) VALUES (?, ?)')
    .run('conditional', ' Owner@Example.COM ');
  const credential = await storage.getUserCredential('conditional');
  assert.equal(credential, encodeStoredCredential('original-secret'));
  await storage.changePassword('conditional', 'replacement-secret', { credential, email: 'owner@example.com' });
  assert.match(await storage.getUserCredential('conditional'), /^scrypt:v1:/);
  assert.equal(await storage.verifyUser('conditional', 'replacement-secret'), true);
  assert.equal(await storage.verifyUser('conditional', 'original-secret'), false);
  assert.equal(await storage.verifyUserV2('conditional', 'stale-secret'), false);
  assert.equal(storage.db.prepare('SELECT password FROM users_v2 WHERE username = ?').get('conditional').password, '');
});

test('SQLite allows only one password change for the same expected credential', async t => {
  const storage = memoryStorage(t);
  await storage.registerUser('conditional-race', 'original-secret');
  const expected = { credential: await storage.getUserCredential('conditional-race') };
  const results = await Promise.allSettled([
    storage.changePassword('conditional-race', 'first-secret', expected),
    storage.changePassword('conditional-race', 'second-secret', expected),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'ACCOUNT_CHANGED');
  const accepted = await storage.getUserCredential('conditional-race');
  await assert.rejects(storage.changePassword('conditional-race', 'third-secret', expected), { code: 'ACCOUNT_CHANGED' });
  assert.equal(await storage.getUserCredential('conditional-race'), accepted);
  assert.equal(await storage.verifyUser('conditional-race', 'first-secret'), true);
  assert.equal(await storage.verifyUser('conditional-race', 'second-secret'), false);
});

test('SQLite rejects a changed email without promoting or clearing a legacy credential', async t => {
  const storage = memoryStorage(t);
  const legacy = sha256('original-secret');
  seedV2(storage, 'email-race', legacy);
  await storage.setUserEmail('email-race', 'old@example.com');
  const expected = { credential: await storage.getUserCredential('email-race'), email: 'old@example.com' };
  await storage.setUserEmail('email-race', 'new@example.com');
  await assert.rejects(storage.changePassword('email-race', 'rejected-secret', expected), { code: 'ACCOUNT_CHANGED' });
  assert.equal(storage.db.prepare('SELECT 1 FROM users WHERE username = ?').get('email-race'), undefined);
  assert.equal(storage.db.prepare('SELECT password FROM users_v2 WHERE username = ?').get('email-race').password, legacy);
  assert.equal(await storage.getUserEmail('email-race'), 'new@example.com');
  // Credential-only callers deliberately do not bind the operation to an email.
  await storage.changePassword('email-race', 'accepted-secret', { credential: expected.credential });
  assert.equal(await storage.verifyUser('email-race', 'accepted-secret'), true);
});

test('SQLite conditional changes reject deleted and recreated accounts, including missing null credentials', async t => {
  const storage = memoryStorage(t);
  seedV2(storage, 'oidc-only', '', 'sub');
  await storage.changePassword('oidc-only', 'first-secret', { credential: null, email: '' });
  assert.equal(await storage.verifyUser('oidc-only', 'first-secret'), true);
  await assert.rejects(storage.changePassword('missing', 'replacement-secret', { credential: null }), {
    code: 'ACCOUNT_CHANGED',
  });
  assert.equal(await storage.checkUserExist('missing'), false);

  await storage.registerUser('recreated', 'same-secret', 'same@example.com');
  const expected = { credential: await storage.getUserCredential('recreated'), email: 'same@example.com' };
  await storage.deleteUser('recreated');
  await assert.rejects(storage.changePassword('recreated', 'replacement-secret', expected), { code: 'ACCOUNT_CHANGED' });
  assert.equal(await storage.checkUserExist('recreated'), false);
  await storage.registerUser('recreated', 'same-secret', 'same@example.com');
  const recreatedCredential = await storage.getUserCredential('recreated');
  await assert.rejects(storage.changePassword('recreated', 'replacement-secret', expected), { code: 'ACCOUNT_CHANGED' });
  assert.equal(await storage.getUserCredential('recreated'), recreatedCredential);
});

test('SQLite reset and deletion win over in-flight login upgrades', async t => {
  const storage = memoryStorage(t);
  seedV1(storage, 'reset-race', sha256('old-secret'));
  const pendingLogin = storage.verifyUser('reset-race', 'old-secret');
  await storage.changePassword('reset-race', 'new-secret');
  assert.equal(await pendingLogin, false);
  assert.equal(await storage.verifyUser('reset-race', 'new-secret'), true);

  seedV2(storage, 'delete-race', sha256('old-secret'));
  const deletedLogin = storage.verifyUser('delete-race', 'old-secret');
  await storage.deleteUser('delete-race');
  assert.equal(await deletedLogin, false);
  assert.equal(await storage.checkUserExist('delete-race'), false);
});

test('SQLite creation atomically includes pending/source and restored account state', async t => {
  const storage = memoryStorage(t);
  await storage.createUserV2('pending', 'temporary-secret', 'admin', ['group'], 'pending-sub', ['api'],
    'pending@example.com', { pending: true, source: 'invited by a friend', banned: true, createdAt: 12345 });
  const info = await storage.getUserInfoV2('pending');
  assert.equal(info.pending, true);
  assert.equal(info.banned, true);
  assert.equal(info.source, 'invited by a friend');
  assert.equal(info.createdAt, 12345);
  assert.equal(info.email, 'pending@example.com');
  assert.equal(storage.db.prepare('SELECT created_at FROM users WHERE username = ?').get('pending').created_at, 12345);
});

test('SQLite duplicate email and OIDC identities roll back the entire attempted account', async t => {
  const storage = memoryStorage(t);
  await storage.createUserV2('original', 'original-secret', 'user', undefined, 'shared-sub', undefined, 'same@example.com');
  await assert.rejects(storage.createUserV2('email-duplicate', 'another-secret', 'user', undefined, undefined, undefined,
    ' SAME@EXAMPLE.COM ', { pending: true }));
  await assert.rejects(storage.createUserV2('oidc-duplicate', 'another-secret', 'user', undefined, 'shared-sub'), /绑定其他账号/);
  assert.equal(await storage.checkUserExist('email-duplicate'), false);
  assert.equal(await storage.checkUserExist('oidc-duplicate'), false);
  assert.deepEqual(await storage.getAllUsers(), ['original']);
  assert.equal(await storage.verifyUser('original', 'original-secret'), true);
});

test('SQLite legacy email normalization and duplicate identity lookup fail closed', async t => {
  const storage = memoryStorage(t);
  seedV2(storage, 'legacy', sha256('legacy-secret'), 'legacy-sub');
  storage.db.prepare('INSERT INTO user_emails (username, email) VALUES (?, ?)')
    .run('legacy', ' Legacy@Example.COM ');
  assert.equal(await storage.getUserEmail('legacy'), 'legacy@example.com');
  assert.equal(await storage.getUsernameByEmail('legacy@example.com'), 'legacy');
  await assert.rejects(storage.registerUser('collision', 'new-secret', 'legacy@example.com'), /其他账号/);
  assert.equal(await storage.checkUserExist('collision'), false);
  seedV2(storage, 'duplicate', sha256('duplicate-secret'), 'legacy-sub');
  storage.db.prepare('INSERT INTO user_emails (username, email) VALUES (?, ?)')
    .run('duplicate', 'legacy@example.com');
  await assert.rejects(storage.getUsernameByEmail('legacy@example.com'), /多个账号/);
  await assert.rejects(storage.getUserByOidcSub('legacy-sub'), /多个账号/);
});

test('SQLite does not attach orphan email attributes to a newly created username', async t => {
  const storage = memoryStorage(t);
  storage.db.prepare('INSERT INTO user_emails (username, email) VALUES (?, ?)')
    .run('recreated', 'old@example.com');
  assert.equal(await storage.getUsernameByEmail('old@example.com'), null);
  await storage.registerUser('recreated', 'new-secret');
  assert.equal(await storage.getUserEmail('recreated'), null);
  assert.equal(await storage.getUsernameByEmail('old@example.com'), null);
});

test('SQLite deleting and recreating a username clears email/OIDC and changes its credential fingerprint', async t => {
  const storage = memoryStorage(t);
  await storage.createUserV2('reused', 'same-secret', 'user', undefined, 'old-sub', undefined, 'old@example.com');
  const previous = sha256(await storage.getUserCredential('reused'));
  await storage.deleteUser('reused');
  assert.equal(await storage.getUsernameByEmail('old@example.com'), null);
  assert.equal(await storage.getUserByOidcSub('old-sub'), null);
  await storage.createUserV2('reused', 'same-secret', 'user', undefined, 'new-sub', undefined, 'old@example.com');
  assert.notEqual(sha256(await storage.getUserCredential('reused')), previous);
  assert.equal(await storage.getUserByOidcSub('old-sub'), null);
  assert.equal(await storage.getUserByOidcSub('new-sub'), 'reused');
});

test('SQLite restores encoded credentials without double hashing', async t => {
  const storage = memoryStorage(t);
  await storage.createUserV2('restored', 'temporary-secret');
  const encoded = hashPassword('original-secret');
  await storage.restoreUserCredential('restored', encoded);
  assert.equal(await storage.getUserCredential('restored'), encoded);
  assert.equal(await storage.verifyUser('restored', 'original-secret'), true);
  assert.equal(await storage.verifyUser('restored', encoded), false);

  const legacy = encodeStoredCredential(sha256('legacy-secret'), 'info');
  await storage.restoreUserCredential('restored', legacy);
  assert.equal(await storage.getUserCredential('restored'), legacy);
  assert.equal(await storage.verifyUser('restored', 'legacy-secret'), true);
  assert.match(await storage.getUserCredential('restored'), /^scrypt:v1:/);
  await assert.rejects(storage.restoreUserCredential('restored', 'untyped-password'));
  await assert.rejects(storage.restoreUserCredential('missing', encoded), /用户不存在/);
  assert.equal(await storage.checkUserExist('missing'), false);
});

test('SQLite empty OIDC-only credentials never authenticate with an empty password', async t => {
  const storage = memoryStorage(t);
  seedV2(storage, 'oidc-only', '', 'oidc-only-sub');
  assert.equal(await storage.getUserCredential('oidc-only'), null);
  assert.equal(await storage.verifyUser('oidc-only', ''), false);
  assert.equal(await storage.verifyUser('oidc-only', 'any-secret'), false);
  assert.equal(await storage.getUserByOidcSub('oidc-only-sub'), 'oidc-only');
});

test('SQLite cache tokens are consumed once under concurrent requests and honor expiration', async t => {
  const storage = memoryStorage(t);
  await storage.setCache('password_reset:one', { username: 'alice', expiresAt: Date.now() + 1000 }, 60);
  const results = await Promise.all(Array.from({ length: 20 }, () => storage.consumeCache('password_reset:one')));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean).username, 'alice');
  assert.equal(await storage.getCache('password_reset:one'), null);

  await storage.setCache('password_reset:expired', { username: 'alice' }, -1);
  assert.equal(await storage.consumeCache('password_reset:expired'), null);
  assert.equal(storage.db.prepare('SELECT 1 FROM cache WHERE key = ?').get('password_reset:expired'), undefined);
  await storage.setCache('false-value', false);
  assert.equal(await storage.consumeCache('false-value'), false);
  assert.equal(await storage.consumeCache('false-value'), null);
});

test('SQLite account schema upgrade is additive and leaves old passwords untouched until login', async t => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE users_v2 (username TEXT PRIMARY KEY, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT \'user\', banned INTEGER NOT NULL DEFAULT 0, tags TEXT, enabled_apis TEXT, oidc_sub TEXT, created_at INTEGER NOT NULL)');
  database.prepare('INSERT INTO users_v2 (username, password, created_at) VALUES (?, ?, ?)')
    .run('old-schema', sha256('old-secret'), 7);
  const storage = Object.create(SqliteStorage.prototype);
  storage.db = database;
  storage.cleanupTimer = null;
  t.after(() => storage.close());
  storage.initTables();
  const row = database.prepare('SELECT password, pending, source FROM users_v2 WHERE username = ?').get('old-schema');
  assert.equal(row.password, sha256('old-secret'));
  assert.equal(row.pending, 0);
  assert.equal(row.source, null);
  assert.equal(await storage.verifyUser('old-schema', 'old-secret'), true);
});

test('SQLite full clear includes its account email table', async t => {
  const storage = memoryStorage(t);
  await storage.registerUser('cleared', 'clear-secret', 'clear@example.com');
  await storage.clearAllData();
  assert.deepEqual(await storage.getAllUsers(), []);
  assert.equal(await storage.getUsernameByEmail('clear@example.com'), null);
});
