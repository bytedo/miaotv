const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const {
  createHookHost,
  installBrowser,
} = require('./playback-test-helpers.cjs');

const cacheKey = '测试影片_2024_12345_1';
const unifiedKey = `danmu-cache-${cacheKey}`;
const legacyKey = 'lunatv_danmu_cache';
const comments = [
  { text: '正常测试弹幕', time: 12.5, color: '#FFFFFF', mode: 0 },
];

function createDanmuHarness(t, responses = []) {
  const storage = installBrowser(t);
  storage.set('enable_external_danmu', 'true');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const method of ['log', 'warn', 'error'])
    t.mock.method(console, method, () => {});

  const cache = new Map();
  const writes = [];
  const requests = [];
  const pendingResponses = [...responses];
  t.mock.method(global, 'fetch', async (input) => {
    requests.push(String(input));
    assert.ok(pendingResponses.length > 0, 'unexpected network request');
    return Response.json(pendingResponses.shift());
  });
  const host = createHookHost();
  t.after(() => host.unmount());
  const { useDanmu } = createSourceLoader({
    react: host.React,
    '@/lib/client-cache': {
      ClientCache: {
        get: async (key) => cache.get(key) ?? null,
        set: async (key, data, ttl) => {
          writes.push({ key, data, ttl });
          cache.set(key, data);
        },
      },
    },
  })('../hooks/useDanmu.ts');
  const options = {
    videoTitle: '测试影片',
    videoYear: '2024',
    videoDoubanId: 12345,
    currentEpisodeIndex: 0,
    currentSource: 'test-source',
    artPlayerRef: { current: null },
  };
  const render = () => host.render(() => useDanmu(options));
  const flushCacheWrites = async () => {
    t.mock.timers.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const seed = (store, item) => {
    if (store === 'unified') cache.set(unifiedKey, item);
    else storage.set(legacyKey, JSON.stringify({ [cacheKey]: item }));
  };
  return { storage, cache, writes, requests, render, seed, flushCacheWrites };
}

for (const store of ['unified', 'legacy', 'both']) {
  test(`ordinary danmu loading bypasses a fresh empty ${store} cache`, async (t) => {
    const harness = createDanmuHarness(t, [
      { danmu: comments, total: comments.length },
    ]);
    const empty = { data: [], timestamp: Date.now() };
    if (store !== 'legacy') harness.seed('unified', empty);
    if (store !== 'unified') harness.seed('legacy', empty);

    const result = await harness.render().loadExternalDanmu();

    assert.deepEqual(result, { count: comments.length, data: comments });
    assert.equal(
      harness.requests.length,
      1,
      'repairing the API must not require force reload',
    );
    assert.equal(harness.render().loadMeta.source, 'network');
    assert.equal(harness.render().error, null);
    await harness.flushCacheWrites();
    assert.deepEqual(harness.cache.get(unifiedKey).data, comments);
    assert.deepEqual(
      JSON.parse(harness.storage.get(legacyKey))[cacheKey].data,
      comments,
    );
  });
}

for (const store of ['unified', 'legacy']) {
  for (const [label, makeItem] of [
    ['missing data', () => ({ timestamp: Date.now() })],
    ['non-array data', () => ({ data: { length: 1 }, timestamp: Date.now() })],
    ['invalid comment', () => ({ data: [null], timestamp: Date.now() })],
    [
      'invalid comment time',
      () => ({ data: [{ text: 'bad', time: '12' }], timestamp: Date.now() }),
    ],
    ['invalid timestamp', () => ({ data: comments, timestamp: 'not-a-time' })],
    [
      'expired data',
      () => ({ data: comments, timestamp: Date.now() - 31 * 60 * 1000 }),
    ],
  ]) {
    test(`danmu loading bypasses ${store} cache with ${label}`, async (t) => {
      const harness = createDanmuHarness(t, [
        { danmu: comments, total: comments.length },
      ]);
      harness.seed(store, makeItem());

      const result = await harness.render().loadExternalDanmu();

      assert.deepEqual(result.data, comments);
      assert.equal(harness.requests.length, 1);
      assert.equal(harness.render().error, null);
      assert.equal(harness.render().loadMeta.source, 'network');
    });
  }

  test(`fresh nonempty ${store} danmu cache still avoids the network`, async (t) => {
    const harness = createDanmuHarness(t);
    const item = { data: comments, timestamp: Date.now() };
    harness.seed(store, item);

    const result = await harness.render().loadExternalDanmu();

    assert.deepEqual(result, { count: comments.length, data: comments });
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.writes.length, 0);
    assert.deepEqual(harness.render().loadMeta, {
      source: 'cache',
      loadedAt: item.timestamp,
      count: comments.length,
    });
  });
}

test('an invalid unified cache can fall back to a valid legacy danmu cache', async (t) => {
  const harness = createDanmuHarness(t);
  harness.seed('unified', { data: [], timestamp: Date.now() });
  harness.seed('legacy', { data: comments, timestamp: Date.now() });

  assert.deepEqual((await harness.render().loadExternalDanmu()).data, comments);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.render().loadMeta.source, 'cache');
});

test('an empty danmu response is not persisted and the next ordinary load recovers', async (t) => {
  const harness = createDanmuHarness(t, [
    { danmu: [], total: 0 },
    { danmu: comments, total: comments.length },
  ]);

  assert.deepEqual(await harness.render().loadExternalDanmu(), {
    count: 0,
    data: [],
  });
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.storage.has(legacyKey), false);
  assert.equal(harness.render().error, null);
  assert.equal(harness.render().loading, false);

  assert.deepEqual(await harness.render().loadExternalDanmu(), {
    count: comments.length,
    data: comments,
  });
  assert.equal(harness.requests.length, 2);
  await harness.flushCacheWrites();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.render().error, null);
});

test('normal API responses without a code remain cacheable and accept zero-time comments', async (t) => {
  const data = [{ text: '片头弹幕', time: 0 }, ...comments];
  const harness = createDanmuHarness(t, [{ danmu: data, total: data.length }]);

  assert.deepEqual(await harness.render().loadExternalDanmu(), {
    count: data.length,
    data,
  });
  assert.equal(harness.render().loadMeta.source, 'network');
  await harness.flushCacheWrites();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].key, unifiedKey);
  assert.equal(harness.writes[0].ttl, 30 * 60);
  assert.deepEqual(
    JSON.parse(harness.storage.get(legacyKey))[cacheKey].data,
    data,
  );

  assert.deepEqual((await harness.render().loadExternalDanmu()).data, data);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.render().loadMeta.source, 'cache');
});

test('manual matching passes the episode URL intact alongside its numeric ID', async (t) => {
  const episodeUrl =
    'https://video.example/watch/节目?token=a%2Fb%26c&source=one+two#episode=1';
  const harness = createDanmuHarness(t, [
    { danmu: comments, total: comments.length },
  ]);

  const result = await harness.render().loadExternalDanmu({
    manualOverride: { animeId: 42, episodeId: 7, episodeUrl },
  });

  const request = new URL(harness.requests[0], 'https://site.test');
  assert.equal(request.pathname, '/api/danmu-external');
  assert.equal(request.searchParams.get('episode_id'), '7');
  assert.equal(request.searchParams.get('episode_url'), episodeUrl);
  assert.equal(
    request.searchParams.has('source'),
    false,
    'nested URL parameters stay inside episode_url',
  );
  assert.deepEqual(result.data, comments);
});

test('manual caches distinguish different episode URLs that reuse the same numeric ID', async (t) => {
  const first = {
    animeId: 42,
    episodeId: 7,
    episodeUrl: 'https://video.example/first',
  };
  const second = { ...first, episodeUrl: 'https://video.example/second' };
  const otherComments = [{ text: '另一部影片的弹幕', time: 5 }];
  const legacyComments = [{ text: '旧版手动匹配弹幕', time: 10 }];
  const idOnlyKey = `${cacheKey}__manual_42_7`;
  const harness = createDanmuHarness(t, [
    { danmu: comments, total: comments.length },
    { danmu: otherComments, total: otherComments.length },
  ]);
  harness.storage.set(
    legacyKey,
    JSON.stringify({
      [idOnlyKey]: { data: legacyComments, timestamp: Date.now() },
    }),
  );

  assert.deepEqual(
    (await harness.render().loadExternalDanmu({ manualOverride: first })).data,
    comments,
  );
  assert.deepEqual(
    (await harness.render().loadExternalDanmu({ manualOverride: second })).data,
    otherComments,
  );
  assert.equal(harness.requests.length, 2);
  await harness.flushCacheWrites();
  assert.notEqual(harness.writes[0].key, harness.writes[1].key);

  assert.deepEqual(
    (await harness.render().loadExternalDanmu({ manualOverride: first })).data,
    comments,
  );
  assert.deepEqual(
    (await harness.render().loadExternalDanmu({ manualOverride: second })).data,
    otherComments,
  );
  assert.equal(
    harness.requests.length,
    2,
    'both URL-specific unified caches remain reusable',
  );

  harness.cache.clear();
  assert.deepEqual(
    (await harness.render().loadExternalDanmu({ manualOverride: first })).data,
    comments,
  );
  assert.deepEqual(
    (await harness.render().loadExternalDanmu({ manualOverride: second })).data,
    otherComments,
  );
  assert.deepEqual(
    (
      await harness.render().loadExternalDanmu({
        manualOverride: { animeId: 42, episodeId: 7 },
      })
    ).data,
    legacyComments,
  );
  assert.equal(
    harness.requests.length,
    2,
    'legacy caches preserve URL separation and old ID-only keys',
  );
});

test('danmu retry survives cancellation while the initial request is loading', async (t) => {
  const harness = createDanmuHarness(t, [
    { danmu: [], total: 0 },
    { danmu: comments, total: comments.length },
  ]);
  const firstRequest = harness.render().loadExternalDanmu();
  assert.equal(harness.render().loading, true);
  await firstRequest;
  harness.render();

  t.mock.timers.tick(899);
  assert.equal(harness.requests.length, 1);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.render().danmuList, comments);
  assert.equal(harness.render().loadMeta.source, 'network-retry');
});

test('an executed empty danmu retry is limited to one attempt for the episode', async (t) => {
  const harness = createDanmuHarness(t, [{ danmu: [] }, { danmu: [] }]);
  const firstRequest = harness.render().loadExternalDanmu();
  harness.render();
  await firstRequest;
  harness.render();

  t.mock.timers.tick(900);
  await new Promise((resolve) => setImmediate(resolve));
  harness.render();
  assert.equal(harness.requests.length, 2);

  t.mock.timers.tick(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.requests.length, 2);
});

test('turning danmu off before a retry fires does not consume that retry', async (t) => {
  const harness = createDanmuHarness(t, [
    { danmu: [] },
    { danmu: [] },
    { danmu: comments },
  ]);
  await harness.render().loadExternalDanmu();
  harness.render();
  harness.render().setExternalDanmuEnabled(false);
  harness.render();
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.requests.length, 1);

  harness.render().handleDanmuOperationOptimized(true);
  await new Promise((resolve) => setImmediate(resolve));
  harness.render();
  t.mock.timers.tick(900);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.requests.length, 3);
  assert.deepEqual(harness.render().danmuList, comments);
});

for (const [label, body, expectedMessage] of [
  [
    'failed business code',
    { code: 503, message: '上游不可用', danmu: [] },
    /上游不可用/,
  ],
  ['explicit error', { error: '弹幕接口未配置', danmu: [] }, /弹幕接口未配置/],
  [
    'false success flag',
    { success: false, message: '加载失败', danmu: [] },
    /加载失败/,
  ],
  ['null body', null, /格式无效/],
  ['missing danmu array', {}, /格式无效/],
  ['object instead of array', { code: 200, danmu: {} }, /格式无效/],
  ['string instead of array', { danmu: 'unavailable' }, /格式无效/],
  ['invalid array item', { danmu: [null] }, /格式无效/],
  [
    'invalid comment mode',
    { danmu: [{ text: 'bad', time: 1, mode: '0' }] },
    /格式无效/,
  ],
]) {
  test(`HTTP 200 with ${label} is an error and cannot poison the danmu cache`, async (t) => {
    const harness = createDanmuHarness(t, [body]);

    const result = await harness.render().loadExternalDanmu();
    const state = harness.render();
    assert.deepEqual(result, { count: 0, data: [], error: state.error });
    assert.match(state.error?.message ?? '', expectedMessage);
    assert.equal(state.loadMeta.source, 'error');
    assert.equal(state.loading, false);
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.storage.has(legacyKey), false);
  });
}
