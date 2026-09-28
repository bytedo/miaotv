const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');
process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';

function managerFixture() {
  const config = {
    SiteConfig: { EnableEmby: true },
    UserConfig: { Users: [{ uid: '2', username: 'alice', role: 'user' }, { uid: '3', username: 'manager', role: 'admin' }] },
    EmbyConfig: { Sources: [
      { key: 'private', name: 'Administrator only', enabled: true, ServerURL: 'http://192.168.5.2:8096', isPublic: false },
      { key: 'public', name: 'Shared source', enabled: true, ServerURL: 'http://192.168.5.3:8096', isPublic: true },
    ] },
  };
  const personal = new Map();
  const identities = new Map(config.UserConfig.Users.map((user) => [user.uid, { uid: user.uid, username: user.username }]));
  const aliases = new Map();
  let reads = 0;
  class Client {
    constructor(source, policy) { this.source = { ...source }; this.policy = policy; }
  }
  const load = createSourceLoader({
    './config': { getConfig: async () => config },
    './db': { dbManager: {
      getUserIdentityByUid: async (uid) => identities.get(aliases.get(uid) || uid) || null,
      getUserIdentity: async (name) => [...identities.values()].find((identity) => identity.username === name) || null,
      getUserEmbyConfig: async (uid) => { reads++; return personal.get(uid) || null; },
    } },
    './emby.client': { EmbyClient: Client },
  });
  return { config, personal, identities, aliases, manager: load('emby-manager.ts').embyManager, reads: () => reads };
}

test('Emby users see their personal and explicitly public sources without a global-source fallback', async () => {
  const f = managerFixture();
  assert.deepEqual((await f.manager.getEnabledSourcesForUser('2')).map(source => source.key), ['public']);
  assert.deepEqual((await f.manager.getEnabledSourcesForUser('3')).map(source => source.key), ['private', 'public']);
  f.config.EmbyConfig.Sources[1].isPublic = false;
  assert.deepEqual(await f.manager.getEnabledSourcesForUser('2'), []);
  await assert.rejects(f.manager.getClientForUser('2', 'private'), /未配置/);
});

test('a personal Emby URL cannot grant private access and cached clients lose revoked grants and disabled sources', async () => {
  const f = managerFixture();
  const source = { key: 'personal', name: 'Personal', enabled: true, ServerURL: 'http://192.168.5.3:8096' };
  f.personal.set('2', { sources: [source] });
  const first = await f.manager.getClientForUser('2', 'personal');
  assert.deepEqual(first.policy.allowedPrivateOrigins, ['http://192.168.5.3:8096']);
  f.config.EmbyConfig.Sources[1].isPublic = false;
  const revoked = await f.manager.getClientForUser('2', 'personal');
  assert.notEqual(revoked, first);
  assert.deepEqual(revoked.policy.allowedPrivateOrigins, []);
  source.ServerURL = 'http://192.168.8.8:8096';
  const changed = await f.manager.getClientForUser('2', 'personal');
  assert.notEqual(changed, revoked);
  assert.deepEqual(changed.policy.allowedPrivateOrigins, []);
  source.enabled = false;
  await assert.rejects(f.manager.getClientForUser('2', 'personal'), /已禁用/);
});

test('global Emby client caches recheck changed sources and the feature gate before reuse', async () => {
  const f = managerFixture();
  const original = await f.manager.getClient('private');
  f.config.EmbyConfig.Sources[0].ServerURL = 'http://192.168.5.4:8096';
  const changed = await f.manager.getClient('private');
  assert.notEqual(changed, original);
  assert.deepEqual(changed.policy.allowedPrivateOrigins, ['http://192.168.5.4:8096']);
  f.config.EmbyConfig.Sources[0].enabled = false;
  await assert.rejects(f.manager.getClient('private'), /已禁用/);
  f.config.SiteConfig.EnableEmby = false;
  assert.deepEqual(await f.manager.getEnabledSourcesForUser('2'), []);
  assert.equal(f.reads(), 0);
  await assert.rejects(f.manager.getClient('public'), /未配置/);
});

test('Emby private configurations and authenticated clients keep their UID through a rename', async () => {
  const f = managerFixture();
  const source = { key: 'personal', name: 'Private', enabled: true, ServerURL: 'https://emby.test', AuthToken: 'first-user-token' };
  f.personal.set('2', { sources: [source] });
  const first = await f.manager.getClientForUser('2', 'personal');
  f.identities.get('2').username = 'renamed';
  f.config.UserConfig.Users[0].username = 'renamed';
  assert.equal(await f.manager.getClientForUser('2', 'personal'), first);

  f.identities.set('4', { uid: '4', username: 'alice' });
  f.config.UserConfig.Users.push({ uid: '4', username: 'alice', role: 'user' });
  f.personal.set('4', { sources: [{ ...source, AuthToken: 'second-user-token' }] });
  const second = await f.manager.getClientForUser('4', 'personal');
  assert.notEqual(second, first);
  assert.equal(second.source.AuthToken, 'second-user-token');
  f.manager.clearUserCache('2');
  assert.notEqual(await f.manager.getClientForUser('2', 'personal'), first);
  assert.equal(await f.manager.getClientForUser('4', 'personal'), second);
});

test('Emby metadata and streams use validated targets, with same-origin metadata redirects and explicit private grants', async () => {
  const security = createSourceLoader({ 'cacheable-lookup': class { async lookupAsync() { return [{ address: '8.8.8.8', family: 4 }]; } } })('proxy-security.ts');
  const calls = [];
  const load = createSourceLoader({ './proxy-security': {
    ...security,
    fetchWithValidatedRedirects: async (url, init, policy) => {
      await security.validateProxyTargetUrl(url, policy);
      calls.push({ url, init, policy });
      return Response.json([{ Id: 'one', Name: 'Fixture' }]);
    },
  } });
  const { EmbyClient } = load('emby.client.ts');
  const config = { ServerURL: 'http://192.168.5.2:8096', ApiKey: 'fixture' };
  await assert.rejects(new EmbyClient(config).getCurrentUser(), error => error.status === 403);
  assert.equal(calls.length, 0);
  const client = new EmbyClient(config, { allowedPrivateOrigins: ['http://192.168.5.2:8096'] });
  assert.equal((await client.getCurrentUser()).Id, 'one');
  assert.equal(calls[0].policy.allowCrossOriginRedirects, false);
  await assert.rejects(client.fetchStream('http://192.168.5.3:8096/media'), error => error.status === 403);
  await client.fetchStream('https://cdn.test/media', { headers: { Range: 'bytes=0-2' } });
  assert.equal(calls[1].init.headers.Range, 'bytes=0-2');
  assert.equal(calls[1].policy.timeoutMs, 30000);
});


test('a missing numeric Emby UID never falls back to another account with that numeric username', async () => {
  const f = managerFixture();
  const source = { key: 'personal', name: 'Other account private source', enabled: true, ServerURL: 'https://emby.test', AuthToken: 'private-fixture-token' };
  f.identities.set('4', { uid: '4', username: '202' });
  f.config.UserConfig.Users.push({ uid: '4', username: '202', role: 'user' });
  f.personal.set('4', { sources: [source] });
  await assert.rejects(f.manager.getClientForUser('202', 'personal'), /身份已失效/);
  await assert.rejects(f.manager.getEnabledSourcesForUser('202'), /身份已失效/);
  await assert.rejects(f.manager.hasEmbyForUser('202'), /身份已失效/);
  assert.equal(f.reads(), 0);
  assert.equal((await f.manager.getClientForUser('4', 'personal')).source.AuthToken, source.AuthToken);
});

test('legacy UUID Emby access resolves to the canonical UID cache and disappears with that account', async () => {
  const f = managerFixture();
  const oldUid = '00000000-0000-4000-8000-000000000002';
  f.aliases.set(oldUid, '2');
  f.personal.set('2', { sources: [{ key: 'personal', name: 'Original', enabled: true, ServerURL: 'https://emby.test' }] });
  const original = await f.manager.getClientForUser(oldUid, 'personal');
  assert.equal(await f.manager.getClientForUser('2', 'personal'), original);
  f.manager.clearUserCache('2');
  assert.notEqual(await f.manager.getClientForUser(oldUid, 'personal'), original);
  f.identities.delete('2');
  f.identities.set('4', { uid: '4', username: 'alice' });
  await assert.rejects(f.manager.getClientForUser(oldUid, 'personal'), /身份已失效/);
});
