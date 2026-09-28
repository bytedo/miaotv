const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createHookHost } = require('./playback-test-helpers.cjs');

const { createLivePlaybackSession } = createSourceLoader()('live-playback-session.ts');
const file = path.resolve(__dirname, '../../app/live/page.tsx');
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const quietConsole = { log() {}, warn() {}, error() {} };

function findNode(predicate) {
  let found;
  function visit(node) {
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, 'the live page must retain the behavior under test');
  return found;
}

function compile(text) {
  return new vm.Script(ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText);
}

function loadPageFunction(name, context) {
  const node = findNode((item) =>
    (ts.isFunctionDeclaration(item) && item.name?.text === name) ||
    (ts.isVariableDeclaration(item) && item.name.getText(source) === name));
  const callback = ts.isVariableDeclaration(node) ? node.initializer : node;
  return compile(`(${callback.getText(source)});`).runInNewContext(context);
}

const playbackEffect = findNode((node) => ts.isCallExpression(node) &&
  node.expression.getText(source) === 'useEffect' &&
  node.arguments[0]?.getText(source).includes('const initPlayer ='));
const effectScript = compile(playbackEffect.getText(source));
const drain = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createPlayerFixture(t, overrides = {}) {
  const players = [];
  const state = {};
  const host = createHookHost();
  t.after(() => host.unmount());
  const props = {
    videoUrl: 'https://live.test/a.m3u8',
    currentChannel: { id: 'a', url: 'https://live.test/a.m3u8', logo: 'a.png' },
    currentSource: { key: 'source-a' },
    loading: false,
    isSwitchingSource: false,
    directPlaybackEnabled: false,
    enableDvrMode: false,
    playbackRevision: 0,
  };
  class MockArtplayer {
    constructor(options) {
      this.options = options;
      this.events = new Map();
      this.destroyCount = 0;
      this.video = { seekable: { length: 1, start: () => 0, end: () => 180 } };
      players.push(this);
    }
    on(event, callback) {
      const callbacks = this.events.get(event) || [];
      callbacks.push(callback);
      this.events.set(event, callbacks);
    }
    emit(event, data) { this.events.get(event)?.forEach((callback) => callback(data)); }
    destroy() {
      this.destroyCount++;
      this.isDestroy = true;
      this.emit('destroy');
      // Retain callbacks to exercise events already queued before destruction.
    }
  }
  const setState = (key) => (value) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  const context = {
    createLivePlaybackSession,
    console: quietConsole,
    artRef: { current: {} },
    artPlayerRef: { current: null },
    playbackSessionRef: { current: null },
    currentChannelRef: { current: props.currentChannel },
    setUnsupportedType: setState('unsupported'),
    setIsVideoLoading: setState('loading'),
    setError: setState('error'),
    setDvrDetected: setState('dvr'),
    setDvrSeekableRange: setState('range'),
    setPlaybackRevision: (update) => { props.playbackRevision = update(props.playbackRevision); },
    ensureVideoSource(video, url) { video.source = url; },
    m3u8Loader: () => () => {},
    flvLoader: () => () => {},
    require(name) {
      if (name === 'artplayer') return { default: MockArtplayer };
      if (name === 'flv.js') return { default: {} };
      throw new Error(`Unexpected module: ${name}`);
    },
    ...overrides,
  };
  const snapshot = () => ({
    ...context,
    ...props,
    shouldUseDirectPlayback: overrides.shouldUseDirectPlayback || (async () => props.directPlaybackEnabled),
  });
  context.cleanupPlayer = loadPageFunction('cleanupPlayer', context);
  return {
    state, props, players, context,
    render(next = {}) {
      Object.assign(props, next);
      context.currentChannelRef.current = props.currentChannel;
      host.render(() => effectScript.runInNewContext({ ...snapshot(), useEffect: host.React.useEffect }));
    },
    callback: (name) => loadPageFunction(name, snapshot()),
    unmount: () => host.unmount(),
  };
}

test('disposing a live session cancels timers, aborts requests and releases every resource once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = createLivePlaybackSession();
  let callbacks = 0;
  let releases = 0;
  session.schedule(() => callbacks++, 100);
  session.addCleanup(() => { throw new Error('already closed'); });
  session.addCleanup(() => releases++);
  session.dispose();
  session.dispose();
  session.addCleanup(() => releases++);
  session.schedule(() => callbacks++, 100);
  t.mock.timers.tick(1000);
  assert.equal(session.isActive(), false);
  assert.equal(session.signal.aborted, true);
  assert.equal(callbacks, 0);
  assert.equal(releases, 2);
});

test('selecting the current live channel keeps its player; explicit retry rebuilds exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = createPlayerFixture(t);
  fixture.render();
  await drain();
  const first = fixture.players[0];
  assert.ok(first);
  await fixture.callback('handleChannelChange')({ ...fixture.props.currentChannel });
  fixture.render();
  await drain();
  assert.equal(first.destroyCount, 0);
  assert.equal(fixture.players.length, 1);
  fixture.callback('retryPlayback')();
  fixture.render();
  await drain();
  t.mock.timers.tick(500);
  fixture.render();
  await drain();
  assert.equal(first.destroyCount, 1);
  assert.equal(fixture.players.length, 2);
  assert.equal(fixture.props.videoUrl, 'https://live.test/a.m3u8');
});

test('late CORS completion from channel A cannot replace channel B or destroy its player', async (t) => {
  const a = deferred();
  const b = deferred();
  const fixture = createPlayerFixture(t, {
    shouldUseDirectPlayback: (url) => url.includes('/a.') ? a.promise : b.promise,
  });
  fixture.render();
  await drain();
  const oldSession = fixture.context.playbackSessionRef.current;
  fixture.render({
    videoUrl: 'https://live.test/b.m3u8',
    currentChannel: { id: 'b', url: 'https://live.test/b.m3u8', logo: 'b.png' },
    currentSource: { key: 'source-b' },
  });
  await drain();
  b.resolve(false);
  await drain();
  const current = fixture.players[0];
  assert.equal(new URL(current.options.url, 'https://site.test').searchParams.get('moontv-source'), 'source-b');
  a.resolve(true);
  await drain();
  oldSession.dispose();
  assert.equal(fixture.players.length, 1);
  assert.equal(fixture.context.artPlayerRef.current, current);
  assert.equal(current.destroyCount, 0);
});

test('unmounting during module loading prevents player construction and late state changes', async (t) => {
  const importedModules = deferred();
  let imports = 0;
  const fixture = createPlayerFixture(t, { require() { imports++; return importedModules.promise; } });
  fixture.render();
  await drain();
  assert.equal(imports, 2);
  fixture.unmount();
  const previousState = { ...fixture.state };
  importedModules.resolve({ default: class { constructor() { throw new Error('must not construct'); } } });
  await drain();
  assert.equal(fixture.context.artPlayerRef.current, null);
  assert.deepEqual(fixture.state, previousState);
});

test('playback preference changes apply immediately and old native events and DVR timers are ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = createPlayerFixture(t);
  fixture.render();
  await drain();
  const first = fixture.players[0];
  first.emit('ready');
  first.emit('video:waiting');
  assert.equal(fixture.state.loading, true);
  first.emit('video:canplay');
  assert.equal(fixture.state.loading, false);
  first.emit('video:waiting');
  first.emit('video:playing');
  assert.equal(fixture.state.loading, false);
  fixture.render({ directPlaybackEnabled: true });
  await drain();
  const current = fixture.players[1];
  assert.equal(first.destroyCount, 1);
  assert.equal(current.options.url, fixture.props.videoUrl);
  current.emit('video:loadeddata');
  first.emit('video:waiting');
  first.video.error = { code: 4 };
  first.emit('video:error', new Error('stale error'));
  t.mock.timers.tick(3000);
  assert.equal(fixture.state.loading, false);
  assert.equal(fixture.state.unsupported, null);
  assert.equal(fixture.state.dvr, false);
  current.video.error = { code: 4 };
  current.emit('video:error', new Error('current format error'));
  assert.equal(fixture.state.unsupported, 'format-not-supported');
});

test('cancelled CORS probes abort without caching a false result or overwriting playback mode', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const cache = new Map();
  const writes = [];
  let signal;
  const context = {
    console: quietConsole,
    AbortController,
    window: { location: { protocol: 'https:' } },
    btoa: (value) => Buffer.from(value).toString('base64'),
    localStorage: { getItem: () => null, setItem: (...args) => writes.push(args) },
    corsSupportRef: { current: cache },
    setCorsSupport: () => { throw new Error('stale cache update'); },
    setCorsStats: () => { throw new Error('stale statistics update'); },
    directPlaybackEnabled: true,
    setPlaybackMode: () => { throw new Error('stale mode update'); },
    fetch(_url, options) { signal = options.signal; return pending.promise; },
  };
  context.testCORSSupport = loadPageFunction('testCORSSupport', context);
  const chooseMode = loadPageFunction('shouldUseDirectPlayback', context);
  const session = createLivePlaybackSession();
  const request = chooseMode('https://live.test/a.m3u8', session);
  session.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve({ ok: true });
  assert.equal(await request, false);
  t.mock.timers.tick(3000);
  assert.equal(cache.size, 0);
  assert.equal(writes.length, 0);
});

test('switching live sources ignores stale channel JSON and only the latest request releases the switch lock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstJson = deferred();
  const secondJson = deferred();
  const state = { sources: [] };
  const setState = (key) => (value) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  const context = {
    createLivePlaybackSession,
    console: quietConsole,
    channelRequestRef: { current: null },
    epgRequestRef: { current: null },
    sourceSwitchRevisionRef: { current: 0 },
    currentSourceRef: { current: null },
    currentChannelRef: { current: null },
    needLoadChannel: null,
    cleanupPlayer() {},
    scrollToChannel() {},
    simulateGroupClick() {},
    setIsVideoLoading: setState('loading'),
    setCurrentChannels: setState('channels'),
    setGroupedChannels: setState('groups'),
    setFilteredChannels: setState('filtered'),
    setLiveSources: setState('sources'),
    setCurrentSource: setState('source'),
    setCurrentChannel: setState('channel'),
    setVideoUrl: setState('url'),
    setActiveTab: setState('tab'),
    setIsSwitchingSource: setState('switching'),
    setUnsupportedType: setState('error'),
    setEpgData: setState('epg'),
    setIsEpgLoading: setState('epgLoading'),
    fetch: async (url) => ({ ok: true, json: () => url.endsWith('first') ? firstJson.promise : secondJson.promise }),
  };
  context.fetchChannels = loadPageFunction('fetchChannels', context);
  const changeSource = loadPageFunction('handleSourceChange', context);
  t.after(() => context.channelRequestRef.current?.dispose());
  const first = changeSource({ key: 'first' });
  await drain();
  const oldRequest = context.channelRequestRef.current;
  const second = changeSource({ key: 'second' });
  await drain();
  assert.equal(oldRequest.signal.aborted, true);
  firstJson.resolve({ success: true, data: [{ id: 'stale', url: 'stale.m3u8' }] });
  await first;
  assert.equal(state.switching, true);
  assert.equal(state.channel, null);
  secondJson.resolve({ success: true, data: [{ id: 'current', url: 'current.m3u8' }] });
  await second;
  assert.equal(state.channel.id, 'current');
  assert.equal(state.url, 'current.m3u8');
  assert.equal(state.source.key, 'second');
  assert.equal(state.switching, false);
  context.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: [] }) });
  await changeSource({ key: 'empty' });
  assert.equal(state.channel, null);
  assert.equal(state.url, '');
});

test('late EPG results cannot overwrite the newly selected channel or clear its loading state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstJson = deferred();
  const secondJson = deferred();
  const state = {};
  const context = {
    createLivePlaybackSession,
    console: quietConsole,
    isSwitchingSource: false,
    currentSource: { key: 'source' },
    currentChannelRef: { current: null },
    epgRequestRef: { current: null },
    cleanupPlayer() {},
    scrollToChannel() {},
    setUnsupportedType() {},
    setCurrentChannel() {},
    setVideoUrl() {},
    setPlaybackRevision() {},
    setIsEpgLoading(value) { state.loading = value; },
    setEpgData(value) { state.epg = value; },
    cleanEpgData: (programs) => programs,
    fetch: async (url) => ({ ok: true, json: () => url.endsWith('first') ? firstJson.promise : secondJson.promise }),
  };
  const changeChannel = loadPageFunction('handleChannelChange', context);
  t.after(() => context.epgRequestRef.current?.dispose());
  const first = changeChannel({ id: 'first', tvgId: 'first', url: 'first.m3u8' });
  await drain();
  const second = changeChannel({ id: 'second', tvgId: 'second', url: 'second.m3u8' });
  await drain();
  firstJson.resolve({ success: true, data: { title: 'stale', programs: [] } });
  await first;
  assert.equal(state.loading, true);
  assert.equal(state.epg, undefined);
  secondJson.resolve({ success: true, data: { title: 'current', programs: [] } });
  await second;
  assert.equal(state.epg.title, 'current');
  assert.equal(state.loading, false);
});

function createMockHls() {
  class MockHls {
    constructor(config) {
      this.config = config;
      this.events = new Map();
      this.loads = [];
      this.starts = 0;
      this.recoveries = 0;
      this.swaps = 0;
      this.destroys = 0;
    }
    on(event, callback) {
      const callbacks = this.events.get(event) || [];
      callbacks.push(callback);
      this.events.set(event, callbacks);
    }
    trigger(event, data) { this.events.get(event)?.slice().forEach((callback) => callback(event, data)); }
    loadSource(url) { this.loads.push(url); }
    attachMedia(video) { this.video = video; }
    startLoad() { this.starts++; }
    recoverMediaError() { this.recoveries++; }
    swapAudioCodec() { this.swaps++; }
    destroy() { this.destroys++; this.trigger(MockHls.Events.DESTROYING); }
  }
  MockHls.DefaultConfig = { loader: class { load() {} } };
  MockHls.Events = Object.fromEntries(['ERROR', 'DESTROYING', 'FRAG_LOADED', 'LEVEL_SWITCHED', 'BUFFER_FLUSHED', 'BUFFER_RESET'].map((key) => [key, key]));
  MockHls.ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
  MockHls.ErrorDetails = Object.fromEntries(['KEY_LOAD_ERROR', 'FRAG_PARSING_ERROR', 'BUFFER_APPEND_ERROR', 'BUFFER_INCOMPATIBLE_CODECS_ERROR', 'PLAYLIST_UNCHANGED_ERROR', 'MANIFEST_LOAD_ERROR', 'BUFFER_STALLED_ERROR', 'BUFFER_SEEK_OVER_HOLE'].map((key) => [key, key]));
  return MockHls;
}

function createStreamContext() {
  const state = {};
  return {
    state,
    context: {
      createLivePlaybackSession,
      console: quietConsole,
      process: { env: { NODE_ENV: 'test' } },
      isMobile: false,
      isSafari: false,
      devicePerformance: 'medium',
      setUnsupportedType: (value) => { state.error = value; },
      setIsVideoLoading: (value) => { state.loading = value; },
    },
  };
}

test('persistent HLS media failures stop after two recoveries and cancel pending key retries', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const Hls = createMockHls();
  const { context, state } = createStreamContext();
  const load = loadPageFunction('m3u8Loader', { ...context, Hls });
  const session = createLivePlaybackSession();
  t.after(() => session.dispose());
  const video = {};
  load(video, '/api/proxy/m3u8', session, 'source-a');
  const hls = video.hls;
  hls.trigger(Hls.Events.ERROR, { details: Hls.ErrorDetails.KEY_LOAD_ERROR });
  for (let index = 0; index < 4; index++) {
    hls.trigger(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'mediaDecodeError' });
  }
  t.mock.timers.tick(10000);
  assert.equal(hls.recoveries, 2);
  assert.equal(hls.swaps, 1);
  assert.equal(hls.destroys, 1);
  assert.equal(hls.starts, 0);
  assert.equal(video.hls, null);
  assert.deepEqual(state, { error: 'media-error', loading: false });
});

test('HLS replacement cancels old manifest retries and stale errors cannot end the new stream', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const Hls = createMockHls();
  const { context, state } = createStreamContext();
  const load = loadPageFunction('m3u8Loader', { ...context, Hls });
  const session = createLivePlaybackSession();
  t.after(() => session.dispose());
  const video = {};
  const closeFirst = load(video, 'first.m3u8', session, 'source-a');
  const first = video.hls;
  first.trigger(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.MANIFEST_LOAD_ERROR });
  closeFirst();
  load(video, 'second.m3u8', session, 'source-b');
  const second = video.hls;
  first.trigger(Hls.Events.ERROR, { details: Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR });
  t.mock.timers.tick(10000);
  assert.deepEqual(first.loads, ['first.m3u8']);
  assert.equal(video.hls, second);
  assert.equal(second.destroys, 0);
  assert.equal(session.isActive(), true);
  assert.equal(state.error, undefined);
});

test('nonfatal HLS parsing errors use internal recovery; persistent fatal parsing errors are bounded', (t) => {
  const Hls = createMockHls();
  const { context, state } = createStreamContext();
  const load = loadPageFunction('m3u8Loader', { ...context, Hls });
  const session = createLivePlaybackSession();
  t.after(() => session.dispose());
  const video = {};
  load(video, 'first.m3u8', session, 'source-a');
  const hls = video.hls;
  hls.trigger(Hls.Events.ERROR, { fatal: false, details: Hls.ErrorDetails.FRAG_PARSING_ERROR });
  assert.equal(hls.starts, 0);
  for (let index = 0; index < 3; index++) {
    hls.trigger(Hls.Events.ERROR, { fatal: true, details: Hls.ErrorDetails.FRAG_PARSING_ERROR });
  }
  assert.equal(hls.starts, 2);
  assert.equal(hls.destroys, 1);
  assert.equal(state.error, 'media-error');
});

test('FLV session cleanup cancels pending reloads and ignores late errors', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { context, state } = createStreamContext();
  let onError;
  const calls = { load: 0, unload: 0, detach: 0, destroy: 0 };
  const player = {
    attachMediaElement() {},
    load() { calls.load++; },
    unload() { calls.unload++; },
    detachMediaElement() { calls.detach++; },
    destroy() { calls.destroy++; },
    on(_event, callback) { onError = callback; },
  };
  const flvjs = {
    isSupported: () => true,
    createPlayer: () => player,
    Events: { ERROR: 'error' },
    ErrorTypes: { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' },
  };
  const load = loadPageFunction('flvLoader', context);
  const session = createLivePlaybackSession();
  const video = {};
  load(video, 'stream.flv', session, flvjs);
  onError('network', 'failed');
  session.dispose();
  onError('media', 'stale failure');
  t.mock.timers.tick(10000);
  assert.deepEqual(calls, { load: 1, unload: 1, detach: 1, destroy: 1 });
  assert.equal(video.flv, null);
  assert.equal(state.error, undefined);
});

test('new HLS and FLV stream instances receive a full network retry budget after switching channels', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const type of ['hls', 'flv']) {
    const { context, state } = createStreamContext();
    const session = createLivePlaybackSession();
    t.after(() => session.dispose());
    const video = {};
    let load;
    let emitNetworkError;
    if (type === 'hls') {
      const Hls = createMockHls();
      const loader = loadPageFunction('m3u8Loader', { ...context, Hls });
      load = (url) => loader(video, url, session, 'fixture');
      emitNetworkError = () => video.hls.trigger(Hls.Events.ERROR, {
        fatal: true,
        type: Hls.ErrorTypes.NETWORK_ERROR,
        details: Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
      });
    } else {
      const flvjs = {
        isSupported: () => true,
        Events: { ERROR: 'error' },
        ErrorTypes: { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' },
        createPlayer: () => ({
          on(_event, callback) { this.error = callback; },
          attachMediaElement() {},
          load() {},
          unload() {},
          detachMediaElement() {},
          destroy() {},
        }),
      };
      const loader = loadPageFunction('flvLoader', context);
      load = (url) => loader(video, url, session, flvjs);
      emitNetworkError = () => video.flv.error('network', 'failed');
    }
    const closeFirst = load(`first.${type}`);
    emitNetworkError();
    emitNetworkError();
    assert.equal(session.isActive(), true, `${type}: two failures still allow recovery`);
    closeFirst();
    load(`second.${type}`);
    emitNetworkError();
    emitNetworkError();
    assert.equal(session.isActive(), true, `${type}: the new channel must not inherit the old failure count`);
    assert.equal(state.error, undefined);
    emitNetworkError();
    assert.equal(session.isActive(), false, `${type}: the new channel still has a finite budget`);
    assert.equal(state.error, 'network-error');
  }
  t.mock.timers.tick(10000);
});
