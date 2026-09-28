const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { test } = require('node:test');
const { createSourceLoader } = require('../../../lib/__tests__/storage-test-loader.cjs');

function legacyBackup() {
  return {
    data: {
      adminConfig: {
        ConfigFile: '{}',
        SiteConfig: { SiteName: 'Backup fixture' },
        UserConfig: { Users: [{ username: 'legacy', role: 'user', pending: true, email: 'legacy@example.test' }] },
        SourceConfig: [{ key: 'retained', name: 'Retained source', api: 'https://media.example.test', from: 'custom' }],
        CustomCategories: [],
        LiveConfig: [],
      },
      userData: { legacy: { password: 'fixture-password', playRecords: {}, favorites: {}, reminders: {}, skipConfigs: {}, searchHistory: [] } },
    },
  };
}

function fixture(t, backup) {
  const environment = { USERNAME: 'restore-owner', NEXT_PUBLIC_STORAGE_TYPE: 'redis' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  t.mock.method(console, 'error', () => {});
  t.mock.method(global, 'fetch', async () => { throw new Error('Migration tests cannot access the network'); });
  const state = { cleared: 0, writes: 0, created: [], restored: [], config: null, counter: 1, reservations: [] };
  const load = createSourceLoader({
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/auth.server': { getVerifiedAuthInfo: async () => ({ uid: '1', username: environment.USERNAME }) },
    '@/lib/crypto': { SimpleCrypto: { decrypt: () => gzipSync(JSON.stringify(backup)).toString('base64') } },
    '@/lib/config': { configSelfCheck: async config => config, setCachedConfig: async () => { state.writes++; } },
    '@/lib/db': { db: {
      allocateUserUid: async (preferredUid) => { state.reservations.push(preferredUid); return preferredUid || String(++state.counter); },
      clearAllData: async () => { state.cleared++; },
      createUserV2: async (...args) => { state.writes++; state.created.push(args); },
      restoreUserCredential: async (...args) => { state.writes++; state.restored.push(args); },
      saveAdminConfig: async config => { state.writes++; state.config = structuredClone(config); },
      storage: {
        setPlayRecord: async () => { state.writes++; },
        setFavorite: async () => { state.writes++; },
        setReminder: async () => { state.writes++; },
      },
      addSearchHistory: async () => { state.writes++; },
      setSkipConfig: async () => { state.writes++; },
    } },
  });
  const request = {
    formData: async () => ({ get: name => name === 'file' ? { text: async () => 'encrypted-fixture' } : 'fixture-backup-password' }),
  };
  return { state, run: () => load('../app/api/admin/data_migration/import/route.ts').POST(request) };
}

for (const [name, damage] of [
  ['non-object administrator configuration', backup => { backup.data.adminConfig = 'damaged'; }],
  ['non-object site settings', backup => { backup.data.adminConfig.SiteConfig = 'damaged'; }],
  ['non-object legacy OIDC configuration', backup => { backup.data.adminConfig.OIDCAuthConfig = 'damaged'; }],
  ['array legacy OIDC configuration', backup => { backup.data.adminConfig.OIDCAuthConfig = []; }],
  ['non-string legacy OIDC issuer', backup => { backup.data.adminConfig.OIDCAuthConfig = { issuer: 42 }; }],
  ['null source entry', backup => { backup.data.adminConfig.SourceConfig.push(null); }],
  ['null playback record', backup => { backup.data.userData.legacy.playRecords['source+video'] = null; }],
  ['array favorite instead of a record', backup => { backup.data.userData.legacy.favorites['source+video'] = []; }],
  ['invalid history container', backup => { backup.data.userData.legacy.searchHistory = 'lost history'; }],
]) {
  test(`import rejects ${name} before clearing or creating any account`, async t => {
    const backup = legacyBackup();
    damage(backup);
    const { run, state } = fixture(t, backup);
    assert.equal((await run()).status, 400);
    assert.equal(state.cleared, 0);
    assert.equal(state.writes, 0);
    assert.deepEqual(state.created, []);
    assert.deepEqual(state.reservations, []);
    assert.deepEqual(state.restored, []);
    assert.equal(state.config, null);
  });
}

test('a valid legacy backup retains its account metadata and configured sources', async t => {
  const backup = legacyBackup();
  const { run, state } = fixture(t, backup);
  assert.equal((await run()).status, 200);
  assert.equal(state.cleared, 1);
  assert.equal(state.created[0][0], 'legacy');
  assert.equal(state.created[0][6], 'legacy@example.test');
  assert.equal(state.created[0][7].pending, true);
  assert.equal(state.created[0][7].uid, '2');
  assert.equal(state.restored[0][0], '2');
  assert.deepEqual(state.config.SourceConfig, backup.data.adminConfig.SourceConfig);
  assert.equal(state.config.UserConfig.Users[0].pending, true);
  const { verifyPassword } = createSourceLoader()('password.ts');
  assert.equal(verifyPassword('fixture-password', state.restored[0][1]), true);
});

test('a valid legacy OIDC configuration is preserved during import', async t => {
  const backup = legacyBackup();
  backup.data.adminConfig.OIDCAuthConfig = {
    enabled: true,
    issuer: 'https://identity.example.test',
    clientId: 'fixture-client',
    buttonText: 'Sign in',
  };
  const { run, state } = fixture(t, backup);
  assert.equal((await run()).status, 200);
  assert.equal(state.cleared, 1);
  assert.deepEqual(state.config.OIDCAuthConfig, backup.data.adminConfig.OIDCAuthConfig);
});
