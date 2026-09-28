const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./storage-test-loader.cjs');
const { runNumericIdentityCases } = require('./numeric-identity-cases.cjs');
const { SqliteStorage } = loadSource('sqlite.db.ts');
const { createIdentityStorage } = loadSource('identity-facade.ts');
const { isUserUid, isNumericUserUid, isLegacyUserUid } = loadSource('user-identity.ts');

test('UID validation distinguishes canonical decimal IDs from permanent legacy UUID aliases', () => {
  for (const uid of ['1', '42', '9007199254740993']) {
    assert.equal(isNumericUserUid(uid), true);
    assert.equal(isLegacyUserUid(uid), false);
    assert.equal(isUserUid(uid), true);
  }
  const legacy = '10000000-0000-4000-8000-000000000001';
  assert.equal(isLegacyUserUid(legacy), true);
  assert.equal(isNumericUserUid(legacy), false);
  assert.equal(isUserUid(legacy), true);
  for (const uid of ['', '0', '00', '01', '-1', '1.0', '1e3', ' 1', 1, null, undefined])
    assert.equal(isUserUid(uid), false);
});

test('numeric UID contract with real in-memory SQLite', async t => {
  await runNumericIdentityCases(t, async t => {
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
    const wrap = () => createIdentityStorage(raw, () => 'admin');
    return {
      raw, wrap,
      seed: async values => {
        for (const [field, value] of Object.entries(values))
          raw.db.prepare('INSERT INTO user_identity_registry (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(field, value);
      },
      snapshot: async () => Object.fromEntries(raw.db.prepare('SELECT key, value FROM user_identity_registry').all().map(row => [row.key, row.value])),
    };
  });
});
