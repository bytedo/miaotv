const assert = require('node:assert/strict');
const test = require('node:test');
const { createComponentLoader } = require('./component-test-loader.cjs');
const { createHookHost } = require('./playback-test-helpers.cjs');

function renderCard(t, cached) {
  const host = createHookHost();
  t.after(() => host.unmount());
  const reads = [];
  const writes = [];
  const requests = [];
  t.mock.method(global, 'fetch', async (url) => {
    requests.push(url);
    return Response.json({ totalEpisodes: 12 });
  });
  const ShortDramaCard = createComponentLoader({
    react: { ...host.React, memo: (component) => component },
    '@tanstack/react-query': { useQueryClient: () => ({ prefetchQuery() {} }) },
    'next/navigation': { useRouter: () => ({ push() {} }) },
    '@/hooks/useLongPress': { useLongPress: () => ({}) },
    '@/hooks/useFavoritesMutations': { useToggleFavoriteMutation: () => ({ isPending: false, mutate() {} }) },
    '@/hooks/useFavoritesQuery': { useIsFavoritedQuery: () => ({ data: false }) },
    '@/lib/imageCache': { loadedImageUrls: new Set() },
    '@/components/MobileActionSheet': () => null,
    '@/lib/shortdrama-cache': {
      SHORTDRAMA_CACHE_EXPIRE: { episodes: 86400 },
      getCacheKey: (kind, { id }) => `${kind}:${id}`,
      getCache: async (key) => { reads.push(key); return cached; },
      setCache: async (...args) => { writes.push(args); },
    },
  })('components/ShortDramaCard.tsx').default;
  host.render(() => ShortDramaCard({ drama: {
    id: 123, name: '测试短剧', episode_count: 1, cover: '/cover.jpg',
  } }));
  return { reads, writes, requests };
}

for (const count of [0, 1, 12]) {
  test(`short-drama cards reuse a cached numeric episode count of ${count}`, async (t) => {
    const card = renderCard(t, count);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(card.reads, ['episodes:123']);
    assert.deepEqual(card.requests, [], 'a cached zero suppresses repeated failed parse requests');
    assert.deepEqual(card.writes, []);
  });
}

test('short-drama cards still resolve and cache episode counts when no cache exists', async (t) => {
  const card = renderCard(t, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(card.requests.length, 1);
  assert.deepEqual(card.writes, [['episodes:123', 12, 86400]]);
});
