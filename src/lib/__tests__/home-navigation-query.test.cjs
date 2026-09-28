const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MutationObserver, QueryClient, QueryObserver } = require(
  process.env.MIAOTV_REACT_QUERY_PATH || '@tanstack/react-query',
);
const { createSourceLoader } = require('./storage-test-loader.cjs');

const navigation = createSourceLoader()('navigation.ts');

test('home, favorites and reminders follow the current URL through history changes', () => {
  const history = ['/', '/?tab=favorites', '/?tab=reminders', '/?tab=favorites', '/'];
  assert.deepEqual(
    history.map((href) => navigation.getHomeTab(new URL(href, 'https://example.test').searchParams.get('tab'))),
    ['home', 'favorites', 'reminders', 'favorites', 'home'],
  );
  assert.equal(navigation.getHomeTab('unknown'), 'home');
  assert.equal(navigation.isNavigationItemActive('/?tab=favorites&sort=recent', '/?tab=favorites'), true);
  assert.equal(navigation.isNavigationItemActive('/?tab=favorites', '/'), false);
  assert.equal(navigation.isNavigationItemActive('/?tab=reminders', '/?tab=favorites'), false);
  assert.equal(navigation.isNavigationItemActive('/?tab=unknown', '/'), true);
});

test('navigation compares query values exactly and tolerates malformed search text', () => {
  assert.equal(navigation.isNavigationItemActive('/douban?type=tv_animation', '/douban?type=tv'), false);
  assert.equal(navigation.isNavigationItemActive('/douban?other=x&type=anime', '/douban?type=anime'), true);
  assert.equal(navigation.isNavigationItemActive('/search?q=%E0%A4%A', '/search'), true);
  assert.equal(navigation.isNavigationItemActive('http://[', '/'), false);
});

function createQueryFixture(data = {}) {
  const reads = { favorites: 0, playRecords: 0, reminders: 0 };
  const load = createSourceLoader({
    '@tanstack/react-query': {
      queryOptions: (options) => options,
      useQuery: (options) => options,
      useMutation: (options) => options,
      useQueryClient: () => ({ invalidateQueries() {} }),
    },
    '@/lib/db.client': {
      getAllFavorites: async () => {
        reads.favorites += 1;
        return data.favorites || {};
      },
      getAllPlayRecords: async () => {
        reads.playRecords += 1;
        return data.playRecords || {};
      },
      getAllReminders: async () => {
        reads.reminders += 1;
        return data.reminders || {};
      },
    },
    '@/lib/version_check': { checkForUpdates: async () => 'NO_UPDATE' },
  });
  return { load, reads };
}

test('favorite lists and heart states update from one Record cache without refetching', async (t) => {
  const fixture = createQueryFixture({
    favorites: {
      'source+older': { title: 'Older', save_time: 10 },
      'source+newer': { title: 'Newer', save_time: 20 },
    },
  });
  const hooks = fixture.load('../hooks/useFavoritesQuery.ts');
  const client = new QueryClient();
  const list = new QueryObserver(client, hooks.useFavoritesArrayQuery());
  const heart = new QueryObserver(client, hooks.useIsFavoritedQuery('source', 'added'));
  const unsubscribeList = list.subscribe(() => {});
  const unsubscribeHeart = heart.subscribe(() => {});
  t.after(() => {
    unsubscribeList();
    unsubscribeHeart();
    client.clear();
  });

  await client.ensureQueryData(hooks.favoritesQueryOptions);
  assert.equal(fixture.reads.favorites, 1);
  assert.equal(client.getQueryCache().getAll().length, 1);
  assert.deepEqual(list.getCurrentResult().data.map((item) => item.title), ['Newer', 'Older']);
  assert.equal(heart.getCurrentResult().data, false);

  client.setQueryData(['favorites'], (previous) => ({
    ...previous,
    'source+added': { title: 'Added', save_time: 30 },
  }));
  assert.equal(heart.getCurrentResult().data, true);
  assert.equal(list.getCurrentResult().data[0].title, 'Added');
  assert.equal(Array.isArray(client.getQueryData(['favorites'])), false);

  client.setQueryData(['favorites'], {});
  assert.equal(heart.getCurrentResult().data, false);
  assert.deepEqual(list.getCurrentResult().data, []);
  assert.equal(fixture.reads.favorites, 1);
});

test('play-record arrays and individual resume points share the root Record cache', async (t) => {
  const fixture = createQueryFixture({
    playRecords: {
      'source+video': { title: 'Video', save_time: 10, play_time: 120 },
    },
  });
  const hooks = fixture.load('../hooks/usePlayRecordsQuery.ts');
  const client = new QueryClient();
  const list = new QueryObserver(client, hooks.usePlayRecordsArrayQuery());
  const record = new QueryObserver(client, hooks.usePlayRecordQuery('source', 'video'));
  const unsubscribeList = list.subscribe(() => {});
  const unsubscribeRecord = record.subscribe(() => {});
  t.after(() => {
    unsubscribeList();
    unsubscribeRecord();
    client.clear();
  });

  await client.ensureQueryData(hooks.playRecordsQueryOptions);
  assert.equal(fixture.reads.playRecords, 1);
  assert.equal(client.getQueryCache().getAll().length, 1);
  assert.equal(record.getCurrentResult().data.play_time, 120);

  client.setQueryData(['playRecords'], {
    'source+video': { title: 'Video', save_time: 20, play_time: 300 },
  });
  assert.equal(record.getCurrentResult().data.play_time, 300);
  assert.equal(list.getCurrentResult().data[0].play_time, 300);
  client.setQueryData(['playRecords'], {});
  assert.equal(record.getCurrentResult().data, null);
  assert.deepEqual(list.getCurrentResult().data, []);
  assert.equal(fixture.reads.playRecords, 1);
});

test('reminder dates and saved states share one Record cache and storage adapter', async (t) => {
  const fixture = createQueryFixture({
    reminders: {
      'source+later': { title: 'Later', releaseDate: '2026-12-02' },
      'source+sooner': { title: 'Sooner', releaseDate: '2026-10-01' },
    },
  });
  const hooks = fixture.load('../hooks/useRemindersQuery.ts');
  const client = new QueryClient();
  const list = new QueryObserver(client, hooks.useRemindersArrayQuery());
  const saved = new QueryObserver(client, hooks.useIsRemindedQuery('source', 'added'));
  const unsubscribeList = list.subscribe(() => {});
  const unsubscribeSaved = saved.subscribe(() => {});
  t.after(() => {
    unsubscribeList();
    unsubscribeSaved();
    client.clear();
  });

  await client.ensureQueryData(hooks.remindersQueryOptions);
  assert.equal(fixture.reads.reminders, 1);
  assert.equal(client.getQueryCache().getAll().length, 1);
  assert.deepEqual(list.getCurrentResult().data.map((item) => item.title), ['Sooner', 'Later']);
  assert.equal(saved.getCurrentResult().data, false);

  client.setQueryData(['reminders'], (previous) => ({
    ...previous,
    'source+added': { title: 'Added', releaseDate: '2026-09-25' },
  }));
  assert.equal(saved.getCurrentResult().data, true);
  assert.equal(list.getCurrentResult().data[0].title, 'Added');
  assert.equal(Array.isArray(client.getQueryData(['reminders'])), false);
  client.setQueryData(['reminders'], {});
  assert.equal(saved.getCurrentResult().data, false);
  assert.deepEqual(list.getCurrentResult().data, []);
  assert.equal(fixture.reads.reminders, 1);
});

test('user-menu filtering observes canonical records and favorites without another request', async (t) => {
  const fixture = createQueryFixture({
    playRecords: {
      'source+eligible': { title: 'Eligible', save_time: 20, play_time: 300, total_time: 1000 },
      'source+short': { title: 'Short', save_time: 30, play_time: 60, total_time: 1000 },
      'source+complete': { title: 'Complete', save_time: 40, play_time: 980, total_time: 1000 },
    },
    favorites: { 'source+video': { title: 'Favorite', save_time: 10 } },
  });
  const hooks = fixture.load('../hooks/useUserMenuQueries.ts');
  const records = fixture.load('../hooks/usePlayRecordsQuery.ts');
  const favorites = fixture.load('../hooks/useFavoritesQuery.ts');
  const client = new QueryClient();
  const filtered = new QueryObserver(client, hooks.usePlayRecordsQuery({
    enabled: true, enableFilter: true, minProgress: 10, maxProgress: 90,
  }));
  const menuFavorites = new QueryObserver(client, hooks.useFavoritesQuery({ enabled: true }));
  const unsubscribeFiltered = filtered.subscribe(() => {});
  const unsubscribeFavorites = menuFavorites.subscribe(() => {});
  t.after(() => {
    unsubscribeFiltered();
    unsubscribeFavorites();
    client.clear();
  });

  await client.ensureQueryData(records.playRecordsQueryOptions);
  await client.ensureQueryData(favorites.favoritesQueryOptions);
  assert.equal(fixture.reads.playRecords, 1);
  assert.equal(fixture.reads.favorites, 1);
  assert.equal(client.getQueryCache().getAll().length, 2);
  assert.deepEqual(filtered.getCurrentResult().data.map((item) => item.title), ['Eligible']);
  assert.equal(menuFavorites.getCurrentResult().data[0].title, 'Favorite');
  client.setQueryData(['playRecords'], {});
  client.setQueryData(['favorites'], {});
  assert.deepEqual(filtered.getCurrentResult().data, []);
  assert.deepEqual(menuFavorites.getCurrentResult().data, []);
});

test('disabled Emby menu queries remain offline even after manual refetch', async (t) => {
  const originalWindow = global.window;
  global.window = { RUNTIME_CONFIG: {} };
  const requests = [];
  t.mock.method(global, 'fetch', async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => url.includes('public-sources')
        ? { sources: [{ key: 'public', name: 'Public', isPublic: true }] }
        : { success: true, config: { sources: [{ key: 'private', name: 'Private' }] } },
    };
  });
  const fixture = createQueryFixture();
  const hooks = fixture.load('../hooks/useUserMenuQueries.ts');
  const client = new QueryClient();
  const privateSources = new QueryObserver(client, hooks.useEmbyConfigQuery(true));
  const publicSources = new QueryObserver(client, {
    ...hooks.publicEmbySourcesQueryOptions, enabled: false,
  });
  const unsubscribePrivate = privateSources.subscribe(() => {});
  const unsubscribePublic = publicSources.subscribe(() => {});
  t.after(() => {
    unsubscribePrivate();
    unsubscribePublic();
    client.clear();
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  });

  assert.equal(hooks.useEmbyConfigQuery(true).enabled, false);
  for (const config of [{}, { PRIVATE_LIBRARY_ENABLED: false, EMBY_ENABLED: false }]) {
    global.window.RUNTIME_CONFIG = config;
    await privateSources.refetch();
    await publicSources.refetch();
    assert.deepEqual(requests, []);
    assert.deepEqual(privateSources.getCurrentResult().data, { sources: [] });
    assert.deepEqual(publicSources.getCurrentResult().data, { sources: [] });
  }
  await assert.rejects(
    hooks.useSaveEmbyConfigMutation().mutationFn({ sources: [] }),
    /Emby 功能未启用/,
  );
  assert.deepEqual(requests, []);

  global.window.RUNTIME_CONFIG = { PRIVATE_LIBRARY_ENABLED: true };
  assert.equal(hooks.useEmbyConfigQuery(true).enabled, true);
  await privateSources.refetch();
  await publicSources.refetch();
  assert.deepEqual(requests, ['/api/user/emby-config', '/api/emby/public-sources']);
  assert.equal(privateSources.getCurrentResult().data.sources[0].key, 'private');
  assert.equal(publicSources.getCurrentResult().data.sources[0].key, 'public');
});

test('home manual refresh leaves disabled modules idle and reports separate loading states', () => {
  let queries;
  const refreshCounts = Array(6).fill(0);
  const load = createSourceLoader({
    react: { useMemo: (factory) => factory(), useCallback: (callback) => callback },
    '@tanstack/react-query': {
      useQueries: (options) => {
        queries = options.queries;
        return options.combine(queries.map((query, index) => ({
          data: undefined,
          isLoading: query.enabled && index === 0,
          isFetching: query.enabled && index === 0,
          error: null,
          refetch: () => { refreshCounts[index] += 1; },
        })));
      },
    },
    '@/lib/bangumi.client': { GetBangumiCalendarData: async () => [] },
    '@/lib/douban.client': { getDoubanCategories: async () => ({ code: 200, list: [] }) },
    '@/lib/shortdrama.client': { getRecommendedShortDramas: async () => [] },
  });
  const { useHomePageQueries } = load('../hooks/useHomePageQueries.ts');
  const result = useHomePageQueries({
    showHotMovies: true,
    showHotTvShows: false,
    showHotVariety: false,
    showNewAnime: false,
    showHotShortDramas: false,
  });
  assert.deepEqual(queries.map((query) => query.enabled), [true, false, false, false, false, false]);
  assert.equal(result.loadingBySection.hotMovies, true);
  assert.equal(result.loadingBySection.hotShortDramas, false);
  result.refetch();
  assert.deepEqual(refreshCounts, [1, 0, 0, 0, 0, 0]);
});

const nextTick = () => new Promise(resolve => setImmediate(resolve));

for (const kind of [
  { root: 'favorites', hook: 'useFavoritesMutations', add: 'useAddFavoriteMutation', save: 'saveFavorite', item: 'favorite' },
  { root: 'reminders', hook: 'useRemindersMutations', add: 'useAddReminderMutation', save: 'saveReminder', item: 'reminder' },
  { root: 'playRecords', hook: 'usePlayRecordsMutations', add: 'useSavePlayRecordMutation', save: 'savePlayRecord', item: 'record' },
]) {
  test(`${kind.root}: a failed write rolls back only its own entry, including an initially empty cache`, async (t) => {
    const client = new QueryClient();
    t.after(() => client.clear());
    t.mock.method(console, 'error', () => {});
    let rejectWrite;
    const failedWrite = new Promise((_, reject) => { rejectWrite = reject; });
    const load = createSourceLoader({
      '@tanstack/react-query': { useMutation: options => options, useQueryClient: () => client },
      '@/lib/db.client': { [kind.save]: async (_source, id) => id === 'failed' ? failedWrite : undefined },
    });
    const hooks = load(`../hooks/${kind.hook}.ts`);
    const failed = new MutationObserver(client, hooks[kind.add]());
    const succeeded = new MutationObserver(client, hooks[kind.add]());
    const result = failed.mutate({ source: 'source', id: 'failed', [kind.item]: { title: 'Failed' } });
    const rejection = assert.rejects(result, /offline/);
    await nextTick();
    assert.equal(client.getQueryData([kind.root])['source+failed'].title, 'Failed');

    await succeeded.mutate({ source: 'source', id: 'saved', [kind.item]: { title: 'Saved' } });
    rejectWrite(new Error('offline'));
    await rejection;
    assert.deepEqual(client.getQueryData([kind.root]), { 'source+saved': { title: 'Saved' } });
  });
}

test('clearing continue watching updates its canonical cache and preserves new records on rollback', async (t) => {
  const client = new QueryClient();
  t.after(() => client.clear());
  t.mock.method(console, 'error', () => {});
  client.setQueryData(['playRecords'], { 'source+original': { title: 'Original' } });
  let rejectClear;
  const load = createSourceLoader({
    '@tanstack/react-query': { useMutation: options => options, useQueryClient: () => client },
    '@/lib/db.client': { clearAllPlayRecords: () => new Promise((_, reject) => { rejectClear = reject; }) },
  });
  const hooks = load('../hooks/usePlayRecordsMutations.ts');
  const mutation = new MutationObserver(client, hooks.useClearPlayRecordsMutation());
  const result = mutation.mutate();
  const rejection = assert.rejects(result, /offline/);
  await nextTick();
  assert.deepEqual(client.getQueryData(['playRecords']), {});
  assert.equal(client.getQueryCache().getAll().length, 1);
  client.setQueryData(['playRecords'], { 'source+new': { title: 'New' } });
  rejectClear(new Error('offline'));
  await rejection;
  assert.deepEqual(client.getQueryData(['playRecords']), {
    'source+original': { title: 'Original' }, 'source+new': { title: 'New' },
  });
});

test('search suggestions abort obsolete requests and stay offline while hidden or empty', async (t) => {
  const requests = [];
  t.mock.method(global, 'fetch', (url, { signal }) => new Promise((resolve, reject) => {
    requests.push({ url, signal, resolve });
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const load = createSourceLoader({
    '@tanstack/react-query': { queryOptions: options => options, useQuery: options => options },
  });
  const { useSearchSuggestionsQuery } = load('../hooks/useSearchSuggestionsQuery.ts');
  const client = new QueryClient();
  const observer = new QueryObserver(client, useSearchSuggestionsQuery(' first ', true));
  const unsubscribe = observer.subscribe(() => {});
  t.after(() => { unsubscribe(); client.clear(); });
  assert.equal(requests[0].url, '/api/search/suggestions?q=first');
  observer.setOptions(useSearchSuggestionsQuery('first', false));
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests.length, 1);
  await observer.refetch();
  assert.equal(requests.length, 1);
  observer.setOptions(useSearchSuggestionsQuery('  ', true));
  assert.equal(requests.length, 1);
  observer.setOptions(useSearchSuggestionsQuery('新 片', true));
  assert.equal(requests.length, 2);
  requests[1].resolve({ ok: true, json: async () => ({ suggestions: [{ text: 'New' }, null, {}] }) });
  await nextTick();
  assert.deepEqual(observer.getCurrentResult().data, [{ text: 'New', type: 'related' }]);
});
