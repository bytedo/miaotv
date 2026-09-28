const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');

function fixture(t, pathname = '/shortdrama') {
  const local = new Map();
  const server = new Map();
  const requests = [];
  const browser = {
    window: { location: { pathname, origin: 'https://site.test' } },
    document: { cookie: '' },
    localStorage: {
      get length() { return local.size; },
      key: index => [...local.keys()][index] ?? null,
      getItem: key => local.get(key) ?? null,
      setItem: (key, value) => local.set(key, String(value)),
      removeItem: key => local.delete(key),
    },
  };
  const previous = Object.fromEntries(Object.keys(browser).map(key => [key, global[key]]));
  Object.assign(global, browser);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });
  const intervals = t.mock.method(global, 'setInterval', () => 1);
  t.mock.method(console, 'log', () => {});
  const categories = [{ type_id: 1, type_name: 'Fixture category' }];
  const items = [{ vod_id: 1, vod_name: 'Fixture drama' }];
  const response = data => ({ ok: true, json: async () => structuredClone(data) });
  t.mock.method(global, 'fetch', async (input, init = {}) => {
    const url = new URL(input, browser.window.location.origin);
    const method = init.method || 'GET';
    requests.push({ path: url.pathname, query: url.search, method });
    if (url.pathname === '/api/cache') {
      const key = url.searchParams.get('key');
      if (method === 'GET') {
        const cached = server.get(key);
        return response({ data: cached && cached.expire > Date.now() ? cached.data : null });
      }
      if (method === 'POST') {
        const { key: writeKey, data, expireSeconds } = JSON.parse(init.body);
        server.set(writeKey, { data, expire: Date.now() + expireSeconds * 1000 });
        return response({ success: true });
      }
      if (method === 'DELETE') {
        const prefix = url.searchParams.get('prefix');
        for (const cacheKey of server.keys()) {
          if (cacheKey === key || (prefix && cacheKey.startsWith(prefix))) {
            server.delete(cacheKey);
          }
        }
        return response({ success: true });
      }
    }
    if (url.pathname === '/api/shortdrama/categories') return response(categories);
    if (url.pathname === '/api/shortdrama/recommend') return response(items);
    if (url.pathname === '/api/shortdrama/list') return response({ list: items, hasMore: false });
    assert.fail(`Unexpected network request: ${method} ${url.pathname}`);
  });
  const load = createSourceLoader();
  return { load, local, server, requests, intervals, categories, items };
}

for (const pathname of ['/login', '/download']) {
  test(`importing the short-drama client on anonymous ${pathname} performs no maintenance`, async t => {
    const { load, requests, intervals } = fixture(t, pathname);
    load('shortdrama.client.ts');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, []);
    assert.equal(intervals.mock.callCount(), 0);
  });
}

test('explicit short-drama requests still populate and reuse their caches', async t => {
  const { load, requests, intervals, server, local, categories, items } = fixture(t);
  const client = load('shortdrama.client.ts');
  const cache = load('shortdrama-cache.ts');
  assert.deepEqual(await client.getShortDramaCategories(), categories);
  assert.deepEqual(await client.getShortDramaCategories(), categories);
  assert.deepEqual(await client.getRecommendedShortDramas(undefined, 8), items);
  assert.deepEqual(await client.getRecommendedShortDramas(undefined, 8), items);
  assert.deepEqual(await client.getShortDramaList(1), { list: items, hasMore: false });
  assert.deepEqual(await client.getShortDramaList(1), { list: items, hasMore: false });
  for (const endpoint of ['categories', 'recommend', 'list']) {
    assert.equal(requests.filter(request => request.path === `/api/shortdrama/${endpoint}`).length, 1);
  }
  assert.equal(requests.filter(request => request.method === 'POST').length, 3);
  assert.equal(requests.filter(request => request.method === 'DELETE').length, 0);
  assert.equal(server.size, 3);
  assert.equal(local.size, 3);
  assert.equal(intervals.mock.callCount(), 0);

  // The local fallback remains usable when the server cache has expired.
  server.clear();
  const categoryKey = cache.getCacheKey('categories', {});
  assert.deepEqual(await cache.getCache(categoryKey), categories);
});

test('a cached zero episode count is returned when only the unified cache has it', async t => {
  const { load, server, local, requests } = fixture(t);
  const cache = load('shortdrama-cache.ts');
  const key = cache.getCacheKey('episodes', { id: 123 });
  server.set(key, { data: 0, expire: Date.now() + 60_000 });

  assert.equal(await cache.getCache(key), 0);
  assert.equal(local.size, 0);
  assert.deepEqual(requests, [{
    path: '/api/cache', query: `?key=${encodeURIComponent(key)}`, method: 'GET',
  }]);
});

test('explicit maintenance requests prefix cleanup and prunes only expired local entries', async t => {
  const { load, local, server, requests } = fixture(t);
  const entries = {
    'shortdrama-expired': { data: 'old', expire: Date.now() - 1000 },
    'shortdrama-live': { data: 'live', expire: Date.now() + 60_000 },
    'unrelated-expired': { data: 'other', expire: Date.now() - 1000 },
  };
  for (const [key, value] of Object.entries(entries)) {
    local.set(key, JSON.stringify(value));
    server.set(key, value);
  }
  local.set('shortdrama-invalid', '{');
  const { cleanExpiredCache } = load('shortdrama-cache.ts');
  await cleanExpiredCache();
  assert.deepEqual([...server.keys()], ['unrelated-expired']);
  assert.deepEqual([...local.keys()], ['shortdrama-live', 'unrelated-expired']);
  assert.deepEqual(requests, [{ path: '/api/cache', query: '?prefix=shortdrama-', method: 'DELETE' }]);
});
