const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createComponentLoader } = require('./component-test-loader.cjs');
const { createIdentityFixture } = require('./user-identity-fixture.cjs');

const emptyComponent = () => null;
const passthrough = ({ children }) => React.createElement('div', null, children);
const nextResponse = { json: (body, init) => ({ status: init?.status || 200, json: async () => body }) };

function loadActualLiveFunction(name, context) {
  const file = path.resolve(__dirname, '../../app/live/page.tsx');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) callback = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback, `the live player must implement ${name}`);
  const script = ts.transpileModule(`(() => { const callback = ${callback.getText(source)}; return callback; })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return vm.runInNewContext(script, context, { filename: `actual-live-page-${name}.js` });
}

function environment(t) {
  const values = { NEXT_PUBLIC_STORAGE_TYPE: 'sqlite', USERNAME: 'live-test-owner' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const requests = t.mock.method(global, 'fetch', async () => {
    throw new Error('Live configuration tests must not access external services');
  });
  t.after(() => assert.equal(requests.mock.callCount(), 0));
}

function configValue(siteConfig = {}) {
  return {
    ConfigFile: '{}',
    ConfigSubscribtion: { URL: '', AutoUpdate: false, LastCheck: '' },
    SiteConfig: { SiteName: 'Live fixture', ...siteConfig },
    UserConfig: { AllowRegister: true, Users: [] },
    SourceConfig: [],
    CustomCategories: [],
    LiveConfig: [{ key: 'fixture', name: 'Fixture', url: 'https://live.example.test/list.m3u', from: 'custom', disabled: false }],
  };
}

test('new and pre-toggle configurations keep ordinary web live enabled', async t => {
  environment(t);
  for (const stored of [null, configValue(), configValue({ EnableWebLive: true }), configValue({ EnableWebLive: false })]) {
    const writes = [];
    const originalSources = stored && structuredClone(stored.LiveConfig);
    const load = createSourceLoader({
      'next/cache': { unstable_noStore() {} },
      '@/lib/db': { db: {
        ...createIdentityFixture(() => []),
        getAdminConfig: async () => structuredClone(stored),
        getAllUsers: async () => [],
        saveAdminConfig: async config => writes.push(config),
      } },
    });
    const config = await load('config.ts').getConfig();
    assert.equal(config.SiteConfig.EnableWebLive, stored?.SiteConfig.EnableWebLive !== false);
    assert.equal(Object.hasOwn(config, 'WatchRoomConfig'), false);
    assert.equal(Object.hasOwn(config.SiteConfig, 'EnableWatchRoomLive'), false);
    assert.equal(Object.hasOwn(config.SiteConfig, 'EnableWatchRoomScreen'), false);
    assert.equal(writes.length, stored ? 0 : 1);
    if (stored) assert.deepEqual(config.LiveConfig, originalSources);
  }
});

function siteRoute(config) {
  const state = { config, writes: [], invalidations: 0, revalidations: [], auth: { username: 'live-test-owner' } };
  const load = createSourceLoader({
    'next/server': { NextResponse: nextResponse },
    'next/cache': { revalidatePath: (...args) => state.revalidations.push(args) },
    '@/lib/auth.server': { getVerifiedAuthInfo: async () => state.auth },
    '@/lib/config': {
      getConfig: async () => state.config,
      clearConfigCache: () => { state.invalidations++; },
    },
    '@/lib/db': { db: { saveAdminConfig: async value => state.writes.push(structuredClone(value)) } },
  });
  const route = load('../app/api/admin/site/route.ts');
  const body = {
    SiteName: 'Live fixture', Announcement: '', SearchDownstreamMaxPage: 5,
    SiteInterfaceCacheTime: 7200, DoubanProxyType: 'direct', DoubanProxy: '',
    DoubanImageProxyType: 'server', DoubanImageProxy: '', DisableYellowFilter: false,
    FluidSearch: true, EnablePuppeteer: false,
  };
  return { state, post: change => route.POST({ json: async () => ({ ...body, ...change }) }) };
}

test('saving unrelated site settings preserves the live switch and legacy omission defaults to enabled', async t => {
  environment(t);
  for (const value of [undefined, true, false]) {
    const config = configValue({ EnableWebLive: value });
    const { state, post } = siteRoute(config);
    assert.equal((await post({})).status, 200);
    assert.equal(state.writes[0].SiteConfig.EnableWebLive, value !== false);
    assert.equal(Object.hasOwn(state.writes[0].SiteConfig, 'EnableWatchRoomLive'), false);
    assert.equal(Object.hasOwn(state.writes[0].SiteConfig, 'EnableWatchRoomScreen'), false);
    assert.deepEqual(state.writes[0].LiveConfig, config.LiveConfig);
    assert.equal(state.invalidations, 1);
    assert.deepEqual(state.revalidations, [['/', 'layout']]);
  }
});

test('administrators can explicitly enable and disable ordinary live without changing sources', async t => {
  environment(t);
  const config = configValue({ EnableWebLive: false });
  const { state, post } = siteRoute(config);
  for (const enabled of [true, false]) {
    assert.equal((await post({ EnableWebLive: enabled })).status, 200);
    assert.equal(state.writes.at(-1).SiteConfig.EnableWebLive, enabled);
    assert.deepEqual(state.writes.at(-1).LiveConfig, config.LiveConfig);
  }
});

test('malformed live switches and unauthorized updates cannot write site settings', async t => {
  environment(t);
  const { state, post } = siteRoute(configValue({ EnableWebLive: false }));
  for (const value of [null, 'true', 'false', 1, {}, []]) {
    assert.equal((await post({ EnableWebLive: value })).status, 400);
  }
  state.auth = null;
  assert.equal((await post({ EnableWebLive: true })).status, 401);
  state.auth = { username: 'ordinary-member' };
  assert.equal((await post({ EnableWebLive: true })).status, 401);
  assert.equal(state.config.SiteConfig.EnableWebLive, false);
  assert.deepEqual(state.writes, []);
  assert.equal(state.invalidations, 0);
});

test('ordinary live channel controls stay selectable and only lock while switching sources', async t => {
  environment(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createLivePlaybackSession } = createSourceLoader()('live-playback-session.ts');
  const selected = [];
  const urls = [];
  const scrolled = [];
  let cleanups = 0;
  let playbackRevision = 0;
  const channel = { id: 'fixture', name: 'Fixture', group: 'Test', logo: '', tvgId: '', url: 'https://live.example.test/channel.m3u8' };
  const context = {
    React,
    useInView: () => ({ ref: null, isInView: false }),
    useEffect() {},
    currentChannel: null,
    currentChannelRef: { current: null },
    currentSource: null,
    epgRequestRef: { current: null },
    createLivePlaybackSession,
    isSwitchingSource: false,
    expandedChannels: new Set(),
    channelHealthMap: { fixture: { type: 'm3u8', status: 'healthy' } },
    getTypeBadgeStyle: () => '',
    getHealthBadgeStyle: () => '',
    Tv: emptyComponent,
    ChevronDown: emptyComponent,
    cleanupPlayer: () => { cleanups++; },
    setUnsupportedType() {},
    setCurrentChannel: value => selected.push(value),
    setVideoUrl: value => urls.push(value),
    setPlaybackRevision: update => { playbackRevision = update(playbackRevision); },
    setEpgData() {},
    setIsEpgLoading() {},
    scrollToChannel: value => scrolled.push(value),
  };
  t.after(() => context.epgRequestRef.current?.dispose());
  context.handleChannelChange = loadActualLiveFunction('handleChannelChange', context);
  const renderChannel = loadActualLiveFunction('ChannelItem', context);
  const button = renderChannel({ channel });
  assert.equal(button.type, 'button');
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  t.mock.timers.tick(100);
  assert.deepEqual(selected, [channel]);
  assert.deepEqual(urls, [channel.url]);
  assert.deepEqual(scrolled, [channel]);
  assert.equal(cleanups, 1);
  assert.equal(context.currentChannelRef.current, channel);
  assert.equal(playbackRevision, 1);
  // Per-stream HLS/FLV retry-budget reset is exercised in live-playback.test.cjs.

  context.isSwitchingSource = true;
  assert.equal(renderChannel({ channel }).props.disabled, true);
  await context.handleChannelChange({ ...channel, id: 'blocked', url: 'blocked.m3u8' });
  assert.equal(cleanups, 1);
  assert.equal(selected.length, 1);
  assert.equal(playbackRevision, 1);
});

test('the server layout exposes the same live setting without retired room extensions', async t => {
  environment(t);
  let config = configValue();
  const overrides = {
    './globals.css': {},
    'next/dynamic': () => emptyComponent,
    'next/font/local': () => ({ className: 'test-font' }),
    'next/headers': { cookies: async () => ({}), headers: async () => new Headers() },
    sonner: { Toaster: emptyComponent },
    '@/lib/config': { getConfig: async () => config },
    '../components/NavigationShell': passthrough,
    '../components/QueryProvider': passthrough,
  };
  for (const name of ['ChunkErrorGuard', 'PageLoading', 'DOMErrorBoundary', 'GlobalDOMErrorHandler', 'GlobalErrorIndicator', 'SiteProvider', 'ThemeProvider']) {
    overrides[`../components/${name}`] = { [name]: passthrough };
  }
  overrides['../contexts/DownloadContext'] = { DownloadProvider: passthrough };
  overrides['../contexts/GlobalCacheContext'] = { GlobalCacheProvider: passthrough };
  const Layout = createComponentLoader(overrides)('app/layout.tsx').default;
  for (const [storage, setting, expected] of [
    ['sqlite', undefined, true], ['sqlite', true, true], ['sqlite', false, false], ['localstorage', undefined, true],
  ]) {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = storage;
    config = configValue({ EnableWebLive: setting });
    const root = await Layout({ children: null });
    const head = React.Children.toArray(root.props.children).find(child => child.type === 'head');
    const script = React.Children.toArray(head.props.children).find(child => child.type === 'script');
    const serialized = script.props.dangerouslySetInnerHTML.__html;
    const runtime = JSON.parse(serialized.slice('window.RUNTIME_CONFIG = '.length, -1));
    assert.equal(runtime.ENABLE_WEB_LIVE, expected);
    assert.equal(Object.hasOwn(runtime, 'WATCH_ROOM_ENABLED'), false);
    assert.equal(Object.hasOwn(runtime, 'WATCH_ROOM_LIVE_ENABLED'), false);
    assert.equal(Object.hasOwn(runtime, 'WATCH_ROOM_SCREEN_ENABLED'), false);
  }
});

test('all navigation layouts and the live page use the same enabled, disabled and legacy runtime behavior', t => {
  environment(t);
  const previous = { window: global.window, localStorage: global.localStorage };
  global.window = { RUNTIME_CONFIG: {} };
  global.localStorage = { getItem: () => null };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });
  let serverRender = false;
  const Link = ({ children, prefetch: _prefetch, ...props }) => React.createElement('a', props, children);
  const overrides = {
    react: { ...React, Suspense: passthrough, useSyncExternalStore: (_subscribe, snapshot, serverSnapshot) => serverRender ? serverSnapshot() : snapshot() },
    'next/navigation': { usePathname: () => '/live', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {} }) },
    'next/link': Link,
    '@tanstack/react-query': { useQuery: () => ({}) },
    '@/hooks/useUserMenuQueries': { embyConfigQueryOptions: {}, publicEmbySourcesQueryOptions: {} },
    './SiteProvider': { useSite: () => ({ siteName: 'Live fixture' }) },
    './ThemeToggle': { ThemeToggle: emptyComponent },
    './UserMenu': { UserMenu: emptyComponent },
    '@/components/PageLayout': passthrough,
    '@/components/EpgScrollableRow': emptyComponent,
    '@/lib/db.client': {},
    '@/lib/utils': {},
    '@/hooks/useTabsDragScroll': { useTabsDragScroll: () => ({}) },
    '@/hooks/useInView': { useInView: () => ({}) },
    'hls.js': { DefaultConfig: { loader: class {} } },
    '@mui/material': {},
  };
  overrides['./FastLink'] = { FastLink: createComponentLoader(overrides)('components/FastLink.tsx').FastLink };
  const load = createComponentLoader(overrides);
  const navigations = ['ModernNav', 'Sidebar', 'MobileBottomNav'].map(name => load(`components/${name}.tsx`).default);
  const LivePage = load('app/live/page.tsx').default;
  for (const enabled of [undefined, true, false]) {
    global.window.RUNTIME_CONFIG = { ENABLE_WEB_LIVE: enabled };
    for (const Component of navigations) {
      const html = renderToStaticMarkup(React.createElement(Component));
      assert.equal(html.includes('href="/live"'), enabled !== false, `${Component.name}: ${enabled}`);
      if (enabled !== false) assert.match(html, /<a[^>]+href="\/live"[^>]+aria-current="page"/);
    }
    const page = renderToStaticMarkup(React.createElement(LivePage));
    if (enabled === false) assert.match(page, /直播功能未开启/);
    else {
      assert.match(page, /正在加载直播源/);
      assert.doesNotMatch(page, /直播功能未开启/);
    }
  }
  serverRender = true;
  for (const Component of navigations) assert.doesNotMatch(renderToStaticMarkup(React.createElement(Component)), /href="\/live"/);
  assert.match(renderToStaticMarkup(React.createElement(LivePage)), /Loading/);
});
