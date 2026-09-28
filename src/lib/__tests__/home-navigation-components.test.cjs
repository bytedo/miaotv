const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { createComponentLoader } = require('./component-test-loader.cjs');

const passthrough = ({ children }) => React.createElement('div', null, children);
const emptyComponent = () => null;

test('navigation links preserve modified clicks and canceled navigation', () => {
  let link;
  const pushes = [];
  const load = createComponentLoader({
    'next/navigation': { useRouter: () => ({ push: href => pushes.push(href) }) },
    'next/link': props => { link = props; return null; },
  });
  const { FastLink } = load('components/FastLink.tsx');
  renderToStaticMarkup(React.createElement(FastLink, { href: '/?tab=favorites' }, '收藏'));
  const event = { preventDefault() { this.defaultPrevented = true; } };
  link.onClick({ ...event, ctrlKey: true });
  assert.deepEqual(pushes, []);
  link.onClick({ ...event });
  assert.deepEqual(pushes, ['/?tab=favorites']);
  renderToStaticMarkup(React.createElement(FastLink, { href: '/search', onClick: e => e.preventDefault() }, '搜索'));
  link.onClick({ ...event });
  assert.deepEqual(pushes, ['/?tab=favorites']);
});

test('modern and legacy navigation render the actual URL selection before effects run', () => {
  let current = new URL('/', 'https://example.test');
  const Link = ({ children, prefetch: _prefetch, ...props }) => React.createElement('a', props, children);
  const overrides = {
    'next/navigation': {
      usePathname: () => current.pathname,
      useSearchParams: () => current.searchParams,
      useRouter: () => ({ push() {} }),
    },
    'next/link': Link,
    '@tanstack/react-query': { useQuery: () => ({}) },
    '@/hooks/useUserMenuQueries': { embyConfigQueryOptions: {}, publicEmbySourcesQueryOptions: {} },
    './SiteProvider': { useSite: () => ({ siteName: 'MiaoTV' }) },
    './ThemeToggle': { ThemeToggle: emptyComponent },
    './UserMenu': { UserMenu: emptyComponent },
  };
  const FastLink = createComponentLoader(overrides)('components/FastLink.tsx').FastLink;
  const load = createComponentLoader({ ...overrides, './FastLink': { FastLink } });
  const ModernNav = load('components/ModernNav.tsx').default;
  const Sidebar = load('components/Sidebar.tsx').default;
  const MobileBottomNav = load('components/MobileBottomNav.tsx').default;

  for (const url of ['/douban?type=tv', '/douban?type=anime', '/douban?type=tv', '/', '/search?q=%E0%A4%A']) {
    current = new URL(url, 'https://example.test');
    const expected = url.startsWith('/search') ? '/search' : url;
    for (const Component of [ModernNav, Sidebar]) {
      const html = renderToStaticMarkup(React.createElement(Component));
      const selected = [...html.matchAll(/<a\b[^>]*>/g)]
        .filter(([tag]) => tag.includes('aria-current="page"'))
        .map(([tag]) => tag.match(/href="([^"]*)"/)[1]);
      assert.ok(selected.length > 0, `${Component.name}: ${url}`);
      assert.ok(selected.every(href => href === expected), `${Component.name}: ${selected}`);
      assert.match(html, /MiaoTV/);
    }
  }

  current = new URL('/?tab=favorites', 'https://example.test');
  const mobile = renderToStaticMarkup(React.createElement(MobileBottomNav));
  assert.match(mobile, /<a[^>]+href="\/\?tab=favorites"[^>]+aria-current="page"/);
  assert.match(mobile, /href="\/source-browser"/);
  const modern = renderToStaticMarkup(React.createElement(ModernNav));
  assert.doesNotMatch(modern, /href="\/source-browser"/);
  assert.match(modern, /href="\/\?tab=favorites"/);
});

test('saved cards render directly from the query cache and act on their own collection', (t) => {
  const client = new QueryClient();
  t.after(() => client.clear());
  const actions = [];
  const mutations = [];
  const load = createComponentLoader({
    'next/navigation': { useRouter: () => ({ push() {}, prefetch() {} }) },
    'next/image': ({ src, alt }) => React.createElement('img', { src, alt }),
    '@/components/ImagePlaceholder': { ImagePlaceholder: emptyComponent },
    '@/components/MobileActionSheet': props => { actions.push(props.actions); return null; },
    '@/hooks/useLongPress': { useLongPress: () => ({}) },
    '@/hooks/useFavoritesMutations': { useToggleFavoriteMutation: () => ({ isPending: false, mutate: value => mutations.push(['favorite', value]) }) },
    '@/hooks/useRemindersMutations': { useToggleReminderMutation: () => ({ isPending: false, mutate: value => mutations.push(['reminder', value]) }) },
    '@/hooks/usePlayRecordsMutations': { useDeletePlayRecordMutation: () => ({ mutate() {} }) },
    '@/lib/db.client': { getAllFavorites: async () => ({}), getAllReminders: async () => ({}) },
    '@/lib/utils': { processImageUrl: value => value, isSeriesCompleted: () => false },
    '@/lib/imageCache': { loadedImageUrls: new Set() },
  });
  const VideoCard = load('components/VideoCard.tsx').default;
  const render = props => {
    actions.length = 0;
    renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(VideoCard, { id: 'video', source: 'source', title: 'Video', poster: '/poster.jpg', ...props }),
    ));
    return actions[0].find(action => action.id === 'favorite');
  };

  client.setQueryData(['favorites'], { 'source+video': { title: 'Video' } });
  client.setQueryData(['reminders'], {});
  assert.equal(render({ from: 'search' }).label, '取消收藏');
  client.setQueryData(['favorites'], {});
  assert.equal(render({ from: 'search' }).label, '添加收藏');

  client.setQueryData(['favorites'], { 'source+video': { title: 'Video' } });
  const legacyFavorite = render({ from: 'favorite', remarks: '已上映30天' });
  assert.equal(legacyFavorite.label, '取消收藏');
  legacyFavorite.onClick();
  assert.equal(mutations[0][0], 'favorite');
  assert.equal(mutations[0][1].isFavorited, true);

  client.setQueryData(['reminders'], { 'source+video': { title: 'Video' } });
  const reminder = render({ from: 'reminder' });
  assert.equal(reminder.label, '取消想看');
  reminder.onClick();
  assert.equal(mutations[1][0], 'reminder');
  assert.equal(mutations[1][1].isReminded, true);
});

test('continue watching preserves plus signs inside stored video IDs', (t) => {
  const client = new QueryClient();
  t.after(() => client.clear());
  client.setQueryData(['playRecords'], {
    'source+video+part': { title: 'Video', save_time: 1, total_time: 120, play_time: 60, total_episodes: 1 },
  });
  let card;
  const load = createComponentLoader({
    '@/components/ConfirmDialog': { ConfirmDialog: emptyComponent },
    '@/components/ScrollableRow': passthrough,
    '@/components/SectionTitle': emptyComponent,
    '@/components/VideoCard': props => { card = props; return null; },
    '@/hooks/useContinueWatchingQueries': { useWatchingUpdatesQuery: () => ({ data: null }) },
    '@/hooks/usePlayRecordsMutations': { useClearPlayRecordsMutation: () => ({ mutate() {} }) },
    '@/lib/db.client': { getAllPlayRecords: async () => ({}) },
  });
  const ContinueWatching = load('components/ContinueWatching.tsx').default;
  renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(ContinueWatching)));
  assert.equal(card.source, 'source');
  assert.equal(card.id, 'video+part');
  assert.equal(card.progress, 50);
});
