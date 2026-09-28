const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const jsxRuntime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { createComponentLoader } = require('./component-test-loader.cjs');
const { createHookHost } = require('./playback-test-helpers.cjs');

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

function userMenuFixture(t, size = 1500) {
  const previousGlobals = Object.fromEntries(
    ['window', 'document', 'localStorage'].map((key) => [key, global[key]]),
  );
  const host = createHookHost();
  const storage = new Map();
  const events = new EventTarget();
  global.window = {
    RUNTIME_CONFIG: { STORAGE_TYPE: 'redis' },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  global.document = {
    body: { style: { overflow: 'auto' } },
    documentElement: { style: { overflow: 'visible' } },
  };
  global.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  t.after(() => {
    host.unmount();
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });

  const reads = { favorites: 0, records: 0, updates: 0 };
  const imports = { settings: 0, cards: 0 };
  let constructedCards = 0;
  let refreshes = 0;
  const withTrackedTitle = (type, value, fields) =>
    Object.defineProperty(fields, 'title', {
      enumerable: true,
      get() {
        reads[type]++;
        return value;
      },
    });
  const data = {
    favorites: Object.fromEntries(
      Array.from({ length: size }, (_, index) => [
        `source+${index}`,
        withTrackedTitle('favorites', `Favorite ${index}`, {
          save_time: index,
          cover: '/poster.jpg',
          year: '2026',
          total_episodes: 1,
        }),
      ]),
    ),
    records: Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `source+${index}`,
        withTrackedTitle('records', `Record ${index}`, {
          save_time: index,
          cover: '/poster.jpg',
          year: '2026',
          total_episodes: 10,
          total_time: 1000,
          play_time: index === 19 ? 100 : 500,
          index: 2,
        }),
      ]),
    ),
    updates: {
      hasUpdates: true,
      updatedCount: 1,
      updatedSeries: [
        withTrackedTitle('updates', 'New episode', {
          sourceKey: 'source',
          videoId: '18',
          cover: '/poster.jpg',
          year: '2026',
          totalEpisodes: 11,
          currentEpisode: 2,
          hasNewEpisode: true,
          hasNewRelease: false,
          newEpisodes: 1,
        }),
      ],
    },
  };

  let LazyVideoCard;
  const wrapJsx =
    (render) =>
    (type, props, ...args) => {
      if (type === LazyVideoCard) constructedCards++;
      return render(type, props, ...args);
    };
  const overrides = {
    react: {
      ...React,
      ...host.React,
      useMemo(factory, deps) {
        const cache = host.React.useRef();
        if (
          !cache.current ||
          deps.some(
            (value, index) => !Object.is(value, cache.current.deps[index]),
          )
        ) {
          cache.current = { value: factory(), deps };
        }
        return cache.current.value;
      },
    },
    'react-dom': { createPortal: (node) => node },
    'react/jsx-runtime': {
      ...jsxRuntime,
      jsx: wrapJsx(jsxRuntime.jsx),
      jsxs: wrapJsx(jsxRuntime.jsxs),
    },
    'next/navigation': { useRouter: () => ({ push() {} }) },
    'next/dynamic': (loader) => {
      let loading;
      LazyVideoCard = (props) => {
        loading ||= loader();
        return React.createElement('article', null, props.title);
      };
      return LazyVideoCard;
    },
    '@tanstack/react-query': {
      useQuery: ({ queryKey }) => ({
        data: queryKey[0] === 'favorites' ? data.favorites : data.records,
      }),
    },
    '@/contexts/DownloadContext': {
      useDownload: () => ({ tasks: [], setShowDownloadPanel() {} }),
    },
    '@/hooks/useFavoritesQuery': {
      favoritesQueryOptions: { queryKey: ['favorites'] },
    },
    '@/hooks/usePlayRecordsQuery': {
      playRecordsQueryOptions: { queryKey: ['playRecords'] },
    },
    '@/hooks/useUserMenuQueries': {
      useChangePasswordMutation: () => ({}),
      useServerConfigQuery: () => ({ data: { downloadEnabled: true } }),
    },
    '@/hooks/useWatchingUpdates': {
      useWatchingUpdatesQuery: () => ({ data: data.updates }),
      useRefreshWatchingUpdates: () => () => refreshes++,
    },
    '@/lib/auth': {
      getAuthInfoFromBrowserCookie: () => ({
        username: 'fixture',
        role: 'user',
      }),
    },
  };
  Object.defineProperties(overrides, {
    './SettingsPanel': {
      get() {
        imports.settings++;
        return {
          SettingsPanel: () =>
            React.createElement('section', null, 'Settings ready'),
        };
      },
    },
    './VideoCard': {
      get() {
        imports.cards++;
        return () => null;
      },
    },
  });
  const UserMenu = createComponentLoader(overrides)(
    'components/UserMenu.tsx',
  ).UserMenu;
  let tree;
  const render = () => (tree = host.render(UserMenu));
  render();
  render();
  const click = (label) => {
    const button = elements(tree).find(
      (node) =>
        node.type === 'button' &&
        (node.props['aria-label'] === label || textContent(node) === label),
    );
    assert.ok(button, `button exists: ${label}`);
    button.props.onClick();
    return render();
  };
  return {
    reads,
    imports,
    data,
    render,
    click,
    close() {
      const backdrop = elements(tree).find(
        (node) =>
          node.type === 'div' &&
          node.props.className?.includes('fixed inset-0'),
      );
      assert.ok(backdrop, 'the open panel has a closable backdrop');
      backdrop.props.onClick();
      return render();
    },
    get tree() {
      return tree;
    },
    get refreshes() {
      return refreshes;
    },
    get constructedCards() {
      return constructedCards;
    },
    cards: () => elements(tree).filter((node) => node.type === LazyVideoCard),
  };
}

test('closed menus and menu counts avoid constructing or importing 1500 saved cards', (t) => {
  const fixture = userMenuFixture(t);
  assert.deepEqual(fixture.reads, { favorites: 0, records: 0, updates: 0 });
  assert.deepEqual(fixture.imports, { settings: 0, cards: 0 });
  assert.equal(fixture.constructedCards, 0);

  fixture.click('User Menu');
  assert.match(textContent(fixture.tree), /我的收藏1500/);
  assert.match(textContent(fixture.tree), /继续观看12/);
  assert.deepEqual(fixture.reads, { favorites: 0, records: 0, updates: 0 });
  assert.deepEqual(fixture.imports, { settings: 0, cards: 0 });
  assert.equal(fixture.constructedCards, 0);
  assert.equal(
    fixture.refreshes,
    0,
    'ordinary menu clicks do not force unrelated network refreshes',
  );
  fixture.click('User Menu');
  assert.equal(fixture.constructedCards, 0);
  assert.equal(
    elements(fixture.tree).find((node) => node.type === 'button').props[
      'aria-expanded'
    ],
    false,
  );
});

test('menu counts stop inspecting a large history after twelve eligible records', (t) => {
  const fixture = userMenuFixture(t, 0);
  let progressReads = 0;
  let sortReads = 0;
  fixture.data.records = Object.fromEntries(
    Array.from({ length: 10000 }, (_, index) => [
      `source+${index}`,
      {
        title: `Record ${index}`,
        total_time: 1000,
        get play_time() {
          progressReads++;
          return 500;
        },
        get save_time() {
          sortReads++;
          return index;
        },
      },
    ]),
  );
  fixture.click('User Menu');
  assert.match(textContent(fixture.tree), /继续观看12/);
  assert.ok(progressReads > 0 && progressReads <= 24);
  assert.equal(sortReads, 0, 'a menu count does not sort the entire history');
  assert.equal(fixture.constructedCards, 0);
});

test('favorites prepare only the first batch in saved order and reopen with current cache data', async (t) => {
  const fixture = userMenuFixture(t);
  fixture.click('User Menu');
  fixture.click('我的收藏1500');
  assert.equal(fixture.cards().length, 24);
  assert.equal(fixture.reads.favorites, 24);
  assert.equal(fixture.cards()[0].props.id, '1499');
  assert.equal(fixture.cards().at(-1).props.id, '1476');
  assert.equal(fixture.cards()[0].props.from, 'favorite');
  assert.deepEqual(fixture.imports, { settings: 0, cards: 0 });
  renderToStaticMarkup(fixture.tree);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.imports, { settings: 0, cards: 1 });
  assert.equal(fixture.reads.records, 0);
  assert.equal(fixture.reads.updates, 0);

  fixture.close();
  const readsAfterClose = fixture.reads.favorites;
  fixture.render();
  assert.equal(fixture.reads.favorites, readsAfterClose);
  assert.equal(fixture.cards().length, 0);

  fixture.data.favorites = {
    ...fixture.data.favorites,
    'source+new': { title: 'Just saved', total_episodes: 1, save_time: 2000 },
  };
  fixture.render();
  assert.equal(fixture.reads.favorites, readsAfterClose);
  fixture.click('User Menu');
  fixture.click('我的收藏1501');
  assert.equal(fixture.cards().length, 24);
  assert.equal(fixture.cards()[0].props.title, 'Just saved');
});

test('all favorite batches remain reachable and follow cache additions and removals', (t) => {
  const fixture = userMenuFixture(t, 53);
  const originalKeys = Object.keys(fixture.data.favorites);
  fixture.click('User Menu');
  fixture.click('我的收藏53');
  assert.equal(fixture.cards().length, 24);
  assert.match(textContent(fixture.tree), /已显示 24 \/ 53 部收藏/);
  assert.match(textContent(fixture.tree), /剩余 29 部/);
  fixture.click('加载更多收藏');
  assert.equal(fixture.cards().length, 48);
  fixture.click('加载更多收藏');
  assert.deepEqual(
    fixture.cards().map((card) => card.props.id),
    Array.from({ length: 53 }, (_, index) => String(52 - index)),
    'loading additional batches does not skip or duplicate saved favorites',
  );
  assert.deepEqual(Object.keys(fixture.data.favorites), originalKeys);
  assert.equal(
    elements(fixture.tree).some(
      (node) => node.props['aria-label'] === '加载更多收藏',
    ),
    false,
  );

  const { 'source+52': _removed, ...remaining } = fixture.data.favorites;
  fixture.data.favorites = {
    ...remaining,
    'source+episode+special': {
      title: 'New special',
      save_time: 100,
      total_episodes: 2,
      search_title: 'Special search',
      source_name: 'Fixture source',
      remarks: 'Special episode',
    },
  };
  fixture.render();
  assert.equal(fixture.cards().length, 53);
  assert.equal(fixture.cards()[0].props.id, 'episode+special');
  assert.equal(fixture.cards()[0].props.source, 'source');
  assert.equal(fixture.cards()[0].props.query, 'Special search');
  assert.equal(fixture.cards()[0].props.source_name, 'Fixture source');
  assert.equal(fixture.cards()[0].props.remarks, 'Special episode');
  assert.equal(
    fixture.cards().some((card) => card.props.id === '52'),
    false,
  );

  fixture.close();
  fixture.click('User Menu');
  fixture.click('我的收藏53');
  assert.equal(
    fixture.cards().length,
    24,
    'reopening resets the visible batch',
  );
  assert.equal(fixture.cards()[0].props.title, 'New special');
  fixture.data.favorites = {};
  fixture.render();
  assert.equal(fixture.cards().length, 0);
  assert.match(textContent(fixture.tree), /暂无收藏/);
});

test('continue watching and update buttons only prepare their selected collection', (t) => {
  const fixture = userMenuFixture(t);
  fixture.click('User Menu');
  fixture.click('继续观看12');
  assert.equal(fixture.cards().length, 12);
  assert.equal(
    fixture.cards()[0].props.id,
    '18',
    'newest record under two minutes stays excluded',
  );
  assert.equal(fixture.cards()[0].props.from, 'playrecord');
  assert.equal(fixture.reads.favorites, 0);
  assert.equal(fixture.reads.updates, 0);
  const backdrop = elements(fixture.tree).find(
    (node) =>
      node.type === 'div' && node.props.className?.includes('fixed inset-0'),
  );
  backdrop.props.onClick();
  fixture.render();
  fixture.click('User Menu');
  fixture.click('更新提醒1');
  assert.equal(fixture.cards().length, 1);
  assert.equal(fixture.cards()[0].props.title, 'New episode');
  assert.equal(
    fixture.refreshes,
    1,
    'explicit update checks still refresh their dependencies',
  );
  assert.equal(fixture.reads.favorites, 0);
});

test('continue watching applies live progress settings and cache updates before sorting', (t) => {
  const fixture = userMenuFixture(t, 1);
  const record = (title, save_time, play_time, total_time = 1000) => ({
    title,
    save_time,
    play_time,
    total_time,
    total_episodes: 10,
    index: 2,
  });
  fixture.data.records = {
    'source+too-short': record('Too short', 50, 119),
    'source+finished': record('Finished', 40, 950),
    'source+middle+part': {
      ...record('Halfway', 30, 500),
      search_title: 'Search for halfway',
    },
    'source+boundary': record('Two minutes', 20, 120),
    'source+unknown': record('Unknown duration', 10, 120, 0),
  };
  localStorage.setItem('enableContinueWatchingFilter', 'true');
  localStorage.setItem('continueWatchingMinProgress', '12');
  localStorage.setItem('continueWatchingMaxProgress', '50');
  window.dispatchEvent(new Event('localStorageChanged'));
  fixture.click('User Menu');
  fixture.click('继续观看2');
  assert.deepEqual(
    fixture.cards().map((card) => card.props.id),
    ['middle+part', 'boundary'],
  );
  assert.equal(fixture.cards()[0].props.query, 'Search for halfway');
  assert.equal(fixture.cards()[0].props.progress, 50);
  assert.equal(fixture.cards()[1].props.progress, 12);

  const { 'source+middle+part': _removed, ...remaining } = fixture.data.records;
  fixture.data.records = {
    ...remaining,
    'source+new': record('Just watched', 100, 300),
  };
  fixture.render();
  assert.deepEqual(
    fixture.cards().map((card) => card.props.id),
    ['new', 'boundary'],
  );

  localStorage.setItem('continueWatchingMaxProgress', '15');
  window.dispatchEvent(new Event('storage'));
  fixture.render();
  assert.deepEqual(
    fixture.cards().map((card) => card.props.id),
    ['boundary'],
  );

  localStorage.setItem('enableContinueWatchingFilter', 'false');
  window.dispatchEvent(new Event('localStorageChanged'));
  fixture.render();
  assert.deepEqual(
    fixture.cards().map((card) => card.props.id),
    ['new', 'finished', 'boundary', 'unknown'],
    'disabling the range filter still excludes records shorter than two minutes',
  );
  assert.equal(fixture.reads.favorites, 0);
  fixture.close();
  fixture.click('User Menu');
  fixture.click('继续观看4');
  assert.equal(fixture.cards().length, 4);
});

test('settings show a closable loading dialog and stay closed when their import finishes later', async (t) => {
  const fixture = userMenuFixture(t);
  fixture.click('User Menu');
  fixture.click('设置');
  const suspense = elements(fixture.tree).find(
    (node) => node.type === React.Suspense,
  );
  assert.ok(suspense);
  const fallback = suspense.props.fallback.type(suspense.props.fallback.props);
  assert.match(textContent(fallback), /正在加载设置/);
  assert.equal(global.document.body.style.overflow, 'hidden');
  renderToStaticMarkup(fixture.tree);
  const close = elements(fallback).find(
    (node) => node.type === 'button' && node.props['aria-label'] === '关闭设置',
  );
  close.props.onClick();
  fixture.render();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.render();

  assert.deepEqual(fixture.imports, { settings: 1, cards: 0 });
  assert.deepEqual(fixture.reads, { favorites: 0, records: 0, updates: 0 });
  assert.equal(fixture.constructedCards, 0);
  assert.equal(
    elements(fixture.tree).some((node) => node.type === React.Suspense),
    false,
  );
  assert.equal(global.document.body.style.overflow, 'auto');
  assert.equal(global.document.documentElement.style.overflow, 'visible');

  fixture.click('User Menu');
  fixture.click('设置');
  assert.match(renderToStaticMarkup(fixture.tree), /Settings ready/);
  assert.equal(
    fixture.imports.settings,
    1,
    'reopening reuses the loaded module',
  );
  const reopened = elements(fixture.tree).find(
    (node) => node.type === React.Suspense,
  );
  reopened.props.children.props.onClose();
  fixture.render();
  assert.equal(global.document.body.style.overflow, 'auto');
  assert.equal(global.document.documentElement.style.overflow, 'visible');
});
