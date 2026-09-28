const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const React = require('react');
const jsxRuntime = require('react/jsx-runtime');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
const { createHookHost } = require('./playback-test-helpers.cjs');
const { createSourceLoader } = require('./storage-test-loader.cjs');

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

function textContent(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return React.isValidElement(node) ? textContent(node.props.children) : '';
}

function loadHomeClient(overrides) {
  const filename = path.resolve(__dirname, '../../app/HomeClient.tsx');
  // The worker URL is browser-only. Resolve import.meta for this CommonJS host.
  const source = fs
    .readFileSync(filename, 'utf8')
    .replace(
      /import\.meta\.url/g,
      JSON.stringify(pathToFileURL(filename).href),
    );
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  instance.require = (request) => {
    if (Object.hasOwn(overrides, request)) return overrides[request];
    throw new Error(`Unexpected HomeClient dependency: ${request}`);
  };
  instance._compile(compiled.outputText, filename);
  return instance.exports.default;
}

function homeFixture(t, config = {}) {
  const host = createHookHost();
  let activeHost = host;
  let deferLists = false;
  const previousWindow = global.window;
  const previousStorage = global.localStorage;
  const events = new EventTarget();
  const storage = new Map();
  global.window = {
    RUNTIME_CONFIG: { STORAGE_TYPE: 'redis' },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  global.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  t.after(() => {
    host.unmount();
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousStorage === undefined) delete global.localStorage;
    else global.localStorage = previousStorage;
  });

  const emptyComponent = () => null;
  const VideoCard = () => null;
  const AnnouncementDialog = () => null;
  const data = { favorites: {}, playRecords: {}, reminders: {} };
  const queries = new Map();
  const backgroundOptions = [];
  let currentUrl = new URL('https://example.test/');
  let auth = null;
  let announcement = '';
  let constructedCards = 0;
  const homeData = {
    hotMovies: [{ id: 'movie', title: 'Movie', poster: '/poster.jpg' }],
    hotTvShows: [],
    hotVarietyShows: [],
    hotAnime: [],
    hotShortDramas: [],
    bangumiCalendar: [],
  };
  const loadingBySection = Object.fromEntries(
    Object.keys(homeData).map((key) => [key, false]),
  );
  const initialConfig = {
    showHeroBanner: false,
    showContinueWatching: true,
    showUpcomingReleases: false,
    showHotMovies: true,
    showHotTvShows: false,
    showNewAnime: false,
    showHotVariety: false,
    showHotShortDramas: false,
    ...config,
  };
  const useMemo = (factory, deps) => {
    const cache = activeHost.React.useRef();
    if (
      !cache.current ||
      deps.some((value, index) => !Object.is(value, cache.current.deps[index]))
    ) {
      cache.current = { value: factory(), deps };
    }
    return cache.current.value;
  };
  const wrapJsx =
    (render) =>
    (type, props, ...args) => {
      if (type === VideoCard) constructedCards++;
      return render(type, props, ...args);
    };
  const overrides = {
    react: {
      ...React,
      useState: (...args) => activeHost.React.useState(...args),
      useEffect: (...args) => activeHost.React.useEffect(...args),
      useMemo,
      useDeferredValue(value) {
        const deferred = activeHost.React.useRef(value);
        if (!deferLists) deferred.current = value;
        return deferred.current;
      },
    },
    'react/jsx-runtime': {
      ...jsxRuntime,
      jsx: wrapJsx(jsxRuntime.jsx),
      jsxs: wrapJsx(jsxRuntime.jsxs),
    },
    'lucide-react': Object.fromEntries(
      [
        'Calendar',
        'ChevronRight',
        'Film',
        'Play',
        'Sparkles',
        'Trash2',
        'Tv',
      ].map((name) => [name, emptyComponent]),
    ),
    'next/dynamic': () => AnnouncementDialog,
    'next/link': emptyComponent,
    'next/navigation': { useSearchParams: () => currentUrl.searchParams },
    '@tanstack/react-query': {
      useQuery(options) {
        queries.set(options.queryKey[0], options);
        return { data: data[options.queryKey[0]] };
      },
      useQueries(options) {
        return useMemo(
          () =>
            options.combine(options.queries.map(() => ({ data: undefined }))),
          [options.combine, options.queries.length],
        );
      },
    },
    '@/lib/auth': { getAuthInfoFromBrowserCookie: () => auth },
    '@/lib/douban.client': { getDoubanDetails: async () => ({}) },
    '@/lib/navigation': createSourceLoader()('navigation.ts'),
    '@/lib/shortdrama-cache': { cleanExpiredCache: async () => {} },
    '@/hooks/useFavoritesMutations': {
      useClearFavoritesMutation: () => ({ mutate() {} }),
    },
    '@/hooks/useFavoritesQuery': {
      favoritesQueryOptions: { queryKey: ['favorites'] },
    },
    '@/hooks/usePlayRecordsQuery': {
      playRecordsQueryOptions: { queryKey: ['playRecords'] },
    },
    '@/hooks/useRemindersMutations': {
      useClearRemindersMutation: () => ({ mutate() {} }),
    },
    '@/hooks/useRemindersQuery': {
      remindersQueryOptions: { queryKey: ['reminders'] },
    },
    '@/hooks/useHomePageQueries': {
      useHomePageQueries: () => ({ data: homeData, loadingBySection }),
    },
    '@/hooks/useTMDBLogo': { useTMDBLogos: () => EMPTY_LOGOS },
    '@/hooks/useWatchingUpdates': {
      useWatchingUpdatesQuery: (options) => backgroundOptions.push(options),
    },
    '@/components/ConfirmDialog': { ConfirmDialog: emptyComponent },
    '@/components/ContinueWatching': emptyComponent,
    '@/components/HeroBanner': emptyComponent,
    '@/components/PageLayout': emptyComponent,
    '@/components/ScrollableRow': emptyComponent,
    '@/components/SectionTitle': emptyComponent,
    '@/components/ShortDramaCard': emptyComponent,
    '@/components/SiteProvider': {
      useSite: () => ({ announcement, siteName: 'Test' }),
    },
    '@/components/SkeletonCard': emptyComponent,
    '@/components/VideoCard': VideoCard,
  };
  const HomeClient = loadHomeClient(overrides);
  const render = () => host.render(() => HomeClient({ initialConfig }));
  return {
    data,
    queries,
    storage,
    render,
    VideoCard,
    AnnouncementDialog,
    backgroundOptions,
    get constructedCards() {
      return constructedCards;
    },
    setUrl(url) {
      currentUrl = new URL(url, 'https://example.test');
    },
    setAnnouncement(value) {
      announcement = value;
    },
    setDeferred(value) {
      deferLists = value;
    },
    renderBackground(tree, nextAuth) {
      auth = nextAuth;
      const observer = elements(tree).find(
        (element) => element.type?.type?.name === 'BackgroundWatchingUpdates',
      );
      assert.ok(observer);
      const observerHost = createHookHost();
      activeHost = observerHost;
      try {
        observerHost.render(() => observer.type.type({}));
      } finally {
        observerHost.unmount();
        activeHost = host;
      }
    },
  };
}

const EMPTY_LOGOS = {};
const savedItem = (title, extra = {}) => ({
  title,
  save_time: 1,
  total_episodes: 1,
  cover: '/poster.jpg',
  source_name: 'Source',
  ...extra,
});

test('home does not inspect cached saved lists or subscribe to whole collections', (t) => {
  const fixture = homeFixture(t);
  const unreadable = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('Hidden list was traversed');
      },
    },
  );
  fixture.data.favorites = unreadable;
  fixture.data.playRecords = unreadable;
  fixture.data.reminders = unreadable;
  fixture.render();
  for (const key of ['favorites', 'playRecords', 'reminders']) {
    assert.equal(fixture.queries.get(key).enabled, false, key);
    assert.equal(fixture.queries.get(key).subscribed, false, key);
  }
  assert.equal(fixture.constructedCards, 1);
});

test('switching saved views reads their latest cached data and keeps resume positions', (t) => {
  const fixture = homeFixture(t);
  fixture.data.favorites = { 'source+video+part': savedItem('Favorite') };
  fixture.data.playRecords = { 'source+video+part': { index: 4 } };
  fixture.data.reminders = {
    'source+later': savedItem('Reminder', { releaseDate: '2099-01-01' }),
  };
  fixture.render();
  fixture.setUrl('/?tab=favorites');
  let cards = elements(fixture.render()).filter(
    (element) => element.type === fixture.VideoCard,
  );
  assert.equal(fixture.queries.get('favorites').subscribed, true);
  assert.equal(fixture.queries.get('playRecords').subscribed, true);
  assert.equal(fixture.queries.get('reminders').subscribed, false);
  assert.equal(cards[0].props.id, 'video+part');
  assert.equal(cards[0].props.currentEpisode, 4);

  fixture.setUrl('/?tab=reminders');
  cards = elements(fixture.render()).filter(
    (element) => element.type === fixture.VideoCard,
  );
  assert.equal(cards[0].props.title, 'Reminder');
  assert.equal(fixture.queries.get('favorites').subscribed, false);
  assert.equal(fixture.queries.get('reminders').subscribed, true);
  fixture.data.favorites = { 'source+new': savedItem('New cached favorite') };
  fixture.setUrl('/?tab=favorites');
  cards = elements(fixture.render()).filter(
    (element) => element.type === fixture.VideoCard,
  );
  assert.equal(cards[0].props.title, 'New cached favorite');
});

test('filter feedback renders before rebuilding a large saved grid', (t) => {
  const fixture = homeFixture(t);
  fixture.setUrl('/?tab=favorites');
  fixture.data.favorites = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [
      `source+${index}`,
      savedItem(`Video ${index}`, { type: index % 2 ? 'movie' : 'tv' }),
    ]),
  );
  let tree = fixture.render();
  const initialCards = fixture.constructedCards;
  fixture.setDeferred(true);
  const movieButton = elements(tree).find(
    (element) =>
      element.type === 'button' && textContent(element).includes('电影'),
  );
  movieButton.props.onClick();
  tree = fixture.render();
  const selected = elements(tree).find(
    (element) =>
      element.type === 'button' &&
      element.props['aria-pressed'] &&
      textContent(element).includes('电影'),
  );
  assert.ok(selected);
  assert.equal(fixture.constructedCards, initialCards);
  assert.ok(
    elements(tree).some((element) => element.props['aria-busy'] === true),
  );

  fixture.setDeferred(false);
  tree = fixture.render();
  assert.equal(
    elements(tree).filter((element) => element.type === fixture.VideoCard)
      .length,
    500,
  );
  assert.equal(fixture.constructedCards, initialCards + 500);
});

test('saved cards keep unique identities through sorting, removal and view changes', (t) => {
  const fixture = homeFixture(t);
  fixture.setUrl('/?tab=favorites');
  fixture.data.favorites = {
    's+01': savedItem('Zulu', { save_time: 2 }),
    '1s+0': savedItem('Alpha', { save_time: 1 }),
  };
  const cardsIn = (tree) =>
    elements(tree).filter(
      (element) => element.props.children?.type === fixture.VideoCard,
    );
  let tree = fixture.render();
  assert.deepEqual(
    cardsIn(tree).map((card) => card.key),
    ['s+01', '1s+0'],
  );
  const initialCards = fixture.constructedCards;
  const titleButton = elements(tree).find(
    (element) =>
      element.type === 'button' && textContent(element) === '标题 A-Z',
  );
  fixture.setDeferred(true);
  titleButton.props.onClick();
  tree = fixture.render();
  assert.equal(fixture.constructedCards, initialCards);
  assert.ok(
    elements(tree).some(
      (element) =>
        element.type === 'button' &&
        element.props['aria-pressed'] &&
        textContent(element) === '标题 A-Z',
    ),
  );
  fixture.setDeferred(false);
  tree = fixture.render();
  assert.deepEqual(
    cardsIn(tree).map((card) => card.key),
    ['1s+0', 's+01'],
  );

  fixture.data.favorites = { 's+01': fixture.data.favorites['s+01'] };
  assert.deepEqual(
    cardsIn(fixture.render()).map((card) => card.key),
    ['s+01'],
  );
  fixture.data.reminders = {
    's+01': savedItem('Zulu', { save_time: 2, releaseDate: '2099-01-01' }),
    '1s+0': savedItem('Alpha', { save_time: 1, releaseDate: '2099-01-01' }),
  };
  fixture.setUrl('/?tab=reminders');
  assert.deepEqual(
    cardsIn(fixture.render()).map((card) => card.key),
    ['s+01', '1s+0'],
  );
});

test('pending play records do not invalidate settled favorite cards on dialog updates', (t) => {
  const fixture = homeFixture(t);
  fixture.setUrl('/?tab=favorites');
  fixture.data.favorites = { 'source+video': savedItem('Favorite') };
  fixture.data.playRecords = undefined;
  fixture.render();
  const initialCards = fixture.constructedCards;
  fixture.setAnnouncement('New announcement');
  fixture.render();
  fixture.render();
  assert.equal(fixture.constructedCards, initialCards);

  fixture.data.playRecords = { 'source+video': { index: 3 } };
  const card = elements(fixture.render()).find(
    (element) => element.type === fixture.VideoCard,
  );
  assert.equal(card.props.currentEpisode, 3);
});

test('release calendar pauses offscreen and processes the latest cache when returning home', (t) => {
  const fixture = homeFixture(t, { showUpcomingReleases: true });
  const previousWorker = global.Worker;
  const workers = [];
  global.Worker = class {
    constructor() {
      workers.push(this);
    }
    postMessage(message) {
      this.message = message;
    }
    terminate() {
      this.terminated = true;
    }
  };
  global.window.Worker = global.Worker;
  t.after(() => {
    if (previousWorker === undefined) delete global.Worker;
    else global.Worker = previousWorker;
  });
  fixture.data.releaseCalendar = [
    {
      id: 'old',
      title: 'Older release',
      type: 'movie',
      releaseDate: '2099-01-01',
    },
  ];
  fixture.render();
  assert.equal(fixture.queries.get('releaseCalendar').enabled, true);
  assert.equal(fixture.queries.get('releaseCalendar').subscribed, true);
  assert.equal(workers.length, 1);
  workers[0].onmessage({
    data: { selectedItems: fixture.data.releaseCalendar },
  });
  fixture.render();

  fixture.setUrl('/?tab=favorites');
  fixture.render();
  assert.equal(fixture.queries.get('releaseCalendar').enabled, false);
  assert.equal(fixture.queries.get('releaseCalendar').subscribed, false);
  assert.equal(workers[0].terminated, true);
  fixture.data.releaseCalendar = [
    {
      id: 'new',
      title: 'Latest release',
      type: 'tv',
      releaseDate: '2099-01-02',
    },
  ];
  fixture.render();
  assert.equal(workers.length, 1);

  fixture.setUrl('/');
  fixture.render();
  assert.equal(fixture.queries.get('releaseCalendar').subscribed, true);
  assert.equal(workers.length, 2);
  assert.equal(workers[1].message.releases[0].id, 'new');
  workers[1].onmessage({
    data: { selectedItems: workers[1].message.releases },
  });
  const section = elements(fixture.render()).find(
    (element) => element.type?.type?.name === 'UpcomingReleasesSection',
  );
  assert.equal(section.props.releases[0].id, 'new');
});

test('showing and dismissing the announcement reuses the settled home rows', (t) => {
  const fixture = homeFixture(t);
  fixture.setAnnouncement('Announcement');
  fixture.render();
  const initialCards = fixture.constructedCards;
  const tree = fixture.render();
  const dialog = elements(tree).find(
    (element) => element.type === fixture.AnnouncementDialog,
  );
  assert.ok(dialog);
  dialog.props.onClose();
  fixture.render();
  assert.equal(fixture.constructedCards, initialCards);
});

test('background updates stay enabled only for signed-in database users', (t) => {
  const fixture = homeFixture(t);
  const tree = fixture.render();
  fixture.renderBackground(tree, null);
  assert.equal(fixture.backgroundOptions.at(-1).enabled, false);
  fixture.renderBackground(tree, { username: 'viewer' });
  assert.equal(fixture.backgroundOptions.at(-1).enabled, true);
  global.window.RUNTIME_CONFIG.STORAGE_TYPE = 'localstorage';
  fixture.renderBackground(tree, { username: 'viewer' });
  assert.equal(fixture.backgroundOptions.at(-1).enabled, false);
});

test('hidden home feeds release their query subscription until a module is shown', () => {
  let options;
  const load = createSourceLoader({
    react: {
      useMemo: (factory) => factory(),
      useCallback: (callback) => callback,
    },
    '@tanstack/react-query': {
      useQueries: (value) => {
        options = value;
        return {};
      },
    },
    '@/lib/bangumi.client': { GetBangumiCalendarData: async () => [] },
    '@/lib/douban.client': {
      getDoubanCategories: async () => ({ code: 200, list: [] }),
    },
    '@/lib/shortdrama.client': { getRecommendedShortDramas: async () => [] },
  });
  const { useHomePageQueries } = load('../hooks/useHomePageQueries.ts');
  const hidden = {
    showHotMovies: false,
    showHotTvShows: false,
    showHotVariety: false,
    showNewAnime: false,
    showHotShortDramas: false,
  };
  useHomePageQueries(hidden);
  assert.equal(options.subscribed, false);
  assert.ok(options.queries.every((query) => query.enabled === false));
  useHomePageQueries({ ...hidden, showHotMovies: true });
  assert.equal(options.subscribed, true);
  assert.deepEqual(
    options.queries.map((query) => query.enabled),
    [true, false, false, false, false, false],
  );
});
