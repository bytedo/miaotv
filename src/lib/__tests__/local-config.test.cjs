const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
const { createSourceLoader } = require('./storage-test-loader.cjs');

function fixture(t, storageType) {
  const environment = {
    NEXT_PUBLIC_STORAGE_TYPE: storageType,
    NEXT_PUBLIC_SITE_NAME: undefined,
    NEXT_PUBLIC_SUB_URL: undefined,
    USERNAME: 'local-owner',
    EDGEONE_PAGES: undefined,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map(key => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const state = { constructors: [], queries: 0, writes: [], cacheCalls: [], requests: [] };
  class StorageStub {
    constructor() {
      state.constructors.push(storageType);
    }
    async getAllUsers() { return ['stored-user']; }
    async getAdminConfig() { return { fixture: 'stored-config' }; }
    async setAdminConfig(config) { state.writes.push(config); }
    async getCache(key) {
      state.cacheCalls.push(['get', key]);
      return { fixture: 'stored-cache' };
    }
    async setCache(key, data, expireSeconds) { state.cacheCalls.push(['set', key, data, expireSeconds]); }
    async deleteCache(key) { state.cacheCalls.push(['delete', key]); }
    async clearExpiredCache(prefix) { state.cacheCalls.push(['clear', prefix]); }
  }
  const dependencies = {
    './identity-facade': { createIdentityStorage: storage => storage },
    './redis.db': { RedisStorage: StorageStub },
    './upstash.db': { UpstashRedisStorage: StorageStub },
    './kvrocks.db': { KvrocksStorage: StorageStub },
    './sqlite.db': { SqliteStorage: StorageStub },
    './performance-monitor': { incrementDbQuery: () => { state.queries++; } },
  };
  const filename = path.resolve(__dirname, '../db.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const databaseModule = { exports: {} };
  // Execute the real manager, but never import a real storage adapter or .env.
  vm.runInNewContext(compiled.outputText, {
    module: databaseModule,
    exports: databaseModule.exports,
    process: { env: { ...environment } },
    require(request) {
      assert.ok(Object.hasOwn(dependencies, request), `Unexpected database dependency: ${request}`);
      return dependencies[request];
    },
  }, { filename });
  const load = createSourceLoader({
    '@/lib/db': databaseModule.exports,
    'next/cache': { unstable_noStore() {} },
    'next/server': { NextResponse: { json: (body, init) => ({ status: init?.status || 200, json: async () => body }) } },
  });
  t.mock.method(global, 'fetch', async (...args) => {
    state.requests.push(args);
    throw new Error('Local configuration must not issue network requests');
  });
  t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  return { db: databaseModule.exports.db, config: load('config.ts'), load, state, errors };
}

for (const storageType of [undefined, 'localstorage']) {
  test(`${storageType || 'default'} configuration cold-starts without server storage`, async t => {
    const { db, config, load, state, errors } = fixture(t, storageType);
    assert.equal((await db.getAllUsers()).length, 0);
    assert.equal(await db.getAdminConfig(), null);
    await db.saveAdminConfig({ fixture: 'unused-local-write' });

    const results = await Promise.all(Array.from({ length: 6 }, () => config.getConfig()));
    const initialized = results[0];
    for (const result of results) assert.deepEqual(result, initialized);
    assert.equal(new Set(results).size, results.length, 'each reader owns an editable snapshot');
    results[1].SiteConfig.SiteName = 'unsaved-local-name';
    results[1].UserConfig.Users[0].role = 'user';
    assert.deepEqual(await config.getConfig(), initialized, 'nested draft edits cannot mutate cached defaults');
    assert.equal(initialized.SiteConfig.SiteName, 'MiaoTV');
    assert.deepEqual(initialized.SourceConfig, []);
    assert.deepEqual(initialized.CustomCategories, []);
    assert.deepEqual(initialized.LiveConfig, []);
    assert.equal(initialized.UserConfig.Users[0].username, 'local-owner');
    assert.equal(initialized.UserConfig.Users[0].role, 'owner');
    assert.equal(initialized.SiteConfig.EnableWebLive, true);
    for (const key of ['AIRecommendConfig', 'YouTubeConfig', 'BilibiliConfig', 'TelegramAuthConfig', 'WatchRoomConfig'])
      assert.equal(Object.hasOwn(initialized, key), false);
    assert.equal(Object.hasOwn(initialized.SiteConfig, 'EnableBilibili'), false);
    assert.equal(Object.hasOwn(initialized.SiteConfig, 'EnableYouTube'), false);
    assert.equal(Object.hasOwn(initialized.SiteConfig, 'EnableWatchRoomScreen'), false);
    assert.equal(Object.hasOwn(initialized.SiteConfig, 'EnableWatchRoomLive'), false);
    assert.equal(await config.getCacheTime(), initialized.SiteConfig.SiteInterfaceCacheTime);
    assert.deepEqual(await config.getAvailableApiSites(), []);

    config.clearConfigCache();
    assert.equal((await config.getConfig()).SiteConfig.SiteName, 'MiaoTV');
    await config.resetConfig();
    assert.equal((await config.getConfig()).SiteConfig.SiteName, 'MiaoTV');

    // Exercise the actual shared cache route used by the short-drama client.
    const route = load('../app/api/cache/route.ts');
    const entry = { key: 'shortdrama-local', data: ['fixture'], expireSeconds: 60 };
    const write = await route.POST({ json: async () => entry });
    assert.equal(write.status, 200);
    const keyedRequest = { url: `https://site.test/api/cache?key=${entry.key}` };
    const read = await route.GET(keyedRequest);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { data: null });
    assert.equal((await route.DELETE(keyedRequest)).status, 200);
    assert.equal((await route.DELETE({ url: 'https://site.test/api/cache?prefix=shortdrama-' })).status, 200);
    assert.deepEqual(state, { constructors: [], queries: 0, writes: [], cacheCalls: [], requests: [] });
    assert.equal(errors.mock.callCount(), 0);
  });
}

for (const storageType of ['redis', 'upstash', 'kvrocks', 'sqlite']) {
  test(`${storageType} still delegates configuration and cache operations to its storage adapter`, async t => {
    const { db, state } = fixture(t, storageType);
    assert.deepEqual(await db.getAllUsers(), ['stored-user']);
    assert.deepEqual(await db.getAdminConfig(), { fixture: 'stored-config' });
    const updated = { fixture: 'updated-config' };
    await db.saveAdminConfig(updated);
    const cacheKey = 'shortdrama-fixture';
    assert.deepEqual(await db.getCache(cacheKey), { fixture: 'stored-cache' });
    await db.setCache(cacheKey, 'cached-data', 60);
    await db.deleteCache(cacheKey);
    await db.clearExpiredCache('shortdrama-');
    assert.deepEqual(state.constructors, [storageType]);
    assert.deepEqual(state.writes, [updated]);
    assert.deepEqual(state.cacheCalls, [
      ['get', cacheKey],
      ['set', cacheKey, 'cached-data', 60],
      ['delete', cacheKey],
      ['clear', 'shortdrama-'],
    ]);
    assert.equal(state.queries, 7);
    assert.deepEqual(state.requests, []);
  });
}
