const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createHookHost, installBrowser } = require('./playback-test-helpers.cjs');

const proxyFlags = { VIDEO_PROXY_ENABLED: true, VIDEO_PROXY_URL: 'https://worker.test/base' };
const loadUtilities = () => createSourceLoader({ 'hls.js': {} })('utils.ts');

test('Worker wrapper round-trips signed URLs and rejects lookalike hosts and paths', (t) => {
  installBrowser(t, { ...proxyFlags });
  const utils = loadUtilities();
  const original = 'https://cdn.test/show%2Fpart.M3U8?token=abc%252F%26%2B&percent=%25#fragment';
  const wrapped = utils.applyVideoPlayProxy(original);
  assert.equal(new URL(wrapped).pathname, '/base/m3u8');
  assert.equal(utils.stripVideoPlayProxy(wrapped), original);
  assert.equal(utils.getVideoPlaybackType(wrapped), 'm3u8');
  assert.equal(utils.applyVideoPlayProxy(wrapped), wrapped);
  assert.equal(utils.stripVideoPlayProxy('https://worker.test.evil.test/base/m3u8?url=' + encodeURIComponent(original)), null);
  assert.equal(utils.stripVideoPlayProxy('https://worker.test/base-other/m3u8?url=' + encodeURIComponent(original)), null);
  assert.equal(utils.stripVideoPlayProxy('https://worker.test/base/m3u8-other?url=' + encodeURIComponent(original)), null);
  assert.equal(utils.stripVideoPlayProxy('https://worker.test/base/m3u8?url=javascript%3Aalert(1)'), null);
  assert.equal(utils.getVideoPlaybackType(utils.applyVideoPlayProxy('https://cdn.test/a.MP4?hint=.m3u8')), 'mp4');
  window.RUNTIME_CONFIG.VIDEO_PROXY_URL = 'not a url';
  assert.equal(utils.applyVideoPlayProxy(original), original);
});

test('HLS fallback is Worker to direct to site once, including absolute site URLs', (t) => {
  installBrowser(t, { ...proxyFlags });
  const utils = loadUtilities();
  const original = 'https://cdn.test/video.m3u8?signature=a%2Bb';
  const wrapped = utils.applyVideoPlayProxy(original);
  const direct = utils.getNextHlsFallbackUrl(wrapped);
  const site = utils.getNextHlsFallbackUrl(direct);
  assert.equal(direct, original);
  assert.equal(new URL(site, window.location.origin).searchParams.get('url'), original);
  assert.equal(utils.getVideoPlaybackType(site), 'm3u8');
  assert.equal(utils.getNextHlsFallbackUrl(site), null);
  assert.equal(utils.getNextHlsFallbackUrl(new URL(site, window.location.origin).href), null);
  assert.equal(utils.getNextHlsFallbackUrl('/api/emby/local-video'), null);
  assert.equal(utils.getVideoPlaybackType('https://worker.test/base/m3u8?url=' + encodeURIComponent('https://cdn.test/extensionless')), 'm3u8');
});

test('WebSR requires explicit boolean site configuration even with a saved browser preference', (t) => {
  const storage = installBrowser(t);
  storage.set('websr_enabled', 'true');
  const { isPlaybackFeatureEnabled } = createSourceLoader()('playback-features.ts');
  for (const flag of [undefined, false, 'true', 'false', 1, {}, []]) {
    window.RUNTIME_CONFIG.WEBSR_ENABLED = flag;
    assert.equal(isPlaybackFeatureEnabled('WEBSR_ENABLED'), false);
  }
  window.RUNTIME_CONFIG.WEBSR_ENABLED = true;
  assert.equal(isPlaybackFeatureEnabled('WEBSR_ENABLED'), true);
  delete global.window;
  assert.equal(isPlaybackFeatureEnabled('WEBSR_ENABLED'), false, 'server rendering never enables browser playback features');
});

test('live source settings preserve the saved direct preference and remain editable', (t) => {
  const storage = installBrowser(t);
  storage.set('live-direct-playback-enabled', 'true');
  storage.set('liveDirectConnect', 'true');
  const host = createHookHost();
  t.after(() => host.unmount());
  const { useLivePlaybackPreference } = createSourceLoader({ react: host.React })('../hooks/useLivePlaybackPreference.ts');
  const render = () => host.render(useLivePlaybackPreference);
  assert.equal(render().directPlaybackEnabled, true);
  assert.equal(storage.get('live-direct-playback-enabled'), 'true', 'mounting must not erase the existing preference');
  render().setDirectPlaybackEnabled(false);
  assert.equal(render().directPlaybackEnabled, false);
  assert.equal(storage.get('live-direct-playback-enabled'), 'false');
  assert.equal(storage.get('liveDirectConnect'), 'true', 'the unrelated legacy loader key is not rewritten');
  const remount = createHookHost();
  t.after(() => remount.unmount());
  const remountedHook = createSourceLoader({ react: remount.React })('../hooks/useLivePlaybackPreference.ts').useLivePlaybackPreference;
  assert.equal(remount.render(remountedHook).directPlaybackEnabled, false);
});

test('invalid or unavailable browser storage cannot break live playback settings', (t) => {
  const storage = installBrowser(t);
  storage.set('live-direct-playback-enabled', '{broken');
  const host = createHookHost();
  t.after(() => host.unmount());
  const { useLivePlaybackPreference } = createSourceLoader({ react: host.React })('../hooks/useLivePlaybackPreference.ts');
  const render = () => host.render(useLivePlaybackPreference);
  assert.equal(render().directPlaybackEnabled, false);
  global.localStorage = { getItem() { throw new Error('storage unavailable'); }, setItem() { throw new Error('storage unavailable'); } };
  render().setDirectPlaybackEnabled(true);
  assert.equal(render().directPlaybackEnabled, true);
  const remount = createHookHost();
  t.after(() => remount.unmount());
  const remountedHook = createSourceLoader({ react: remount.React })('../hooks/useLivePlaybackPreference.ts').useLivePlaybackPreference;
  assert.equal(remount.render(remountedHook).directPlaybackEnabled, false);
});

test('episode lock takes effect synchronously and releases on completion, failure, cancellation and timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = createHookHost();
  t.after(() => host.unmount());
  const { useEpisodeSwitch } = createSourceLoader({ react: host.React })('../hooks/useEpisodeSwitch.ts');
  const render = () => host.render(() => useEpisodeSwitch(1000));
  const control = render();
  const first = control.beginEpisodeSwitch(0);
  assert.ok(first);
  assert.equal(control.beginEpisodeSwitch(1), null, 'a second click before rerender must be ignored');
  assert.equal(render().switchingEpisodeIndex, 0);
  render().finishEpisodeSwitch(first);
  assert.equal(render().switchingEpisodeIndex, null);
  const failed = render().beginEpisodeSwitch(1);
  render().finishEpisodeSwitch(failed);
  assert.equal(render().switchingEpisodeIndex, null);
  const cancelled = render().beginEpisodeSwitch(2);
  render().cancelEpisodeSwitch();
  const newer = render().beginEpisodeSwitch(3);
  render().finishEpisodeSwitch(cancelled);
  assert.equal(render().switchingEpisodeIndex, 3, 'a late completion cannot release the newer lock');
  t.mock.timers.tick(1000);
  assert.equal(render().switchingEpisodeIndex, null);
  assert.equal(render().episodeSwitchRef.current, null);
  assert.ok(render().beginEpisodeSwitch(4), 'the player is still usable after timeout');
  render().finishEpisodeSwitch(newer);
  assert.equal(render().switchingEpisodeIndex, 4);
});

function loadActualHlsCallback(context) {
  const file = path.resolve(__dirname, '../../app/play/page.tsx');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'm3u8' && ts.isFunctionExpression(node.initializer)) callback = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback, 'the player must register an HLS callback');
  const script = ts.transpileModule(`const callback = ${callback.getText(source)}; callback;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(script, context, { filename: 'actual-play-page-hls-callback.js' });
}

function loadActualPlayFunction(name, context) {
  const file = path.resolve(__dirname, '../../app/play/page.tsx');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) callback = node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) callback = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback, `the player must implement ${name}`);
  const script = ts.transpileModule(`const callback = ${callback.getText(source)}; callback;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return vm.runInNewContext(script, context, { filename: `actual-play-page-${name}.js` });
}

test('ordinary source navigation remounts the player while old room flags cannot restart playback', () => {
  let query = new URLSearchParams('source=first&id=video&index=0');
  const render = loadActualPlayFunction('PlayPageClientWrapper', {
    React: require('react'),
    useSearchParams: () => query,
    PlayPageClient: () => null,
  });
  const initialKey = render().key;
  query.set('index', '1');
  query.set('_reload', 'legacy-room-request');
  query.set('t', '100');
  query.set('time', '200');
  assert.equal(render().key, initialKey);
  query.set('source', 'second');
  assert.notEqual(render().key, initialKey);
  const sourceKey = render().key;
  query.set('id', 'another-video');
  assert.notEqual(render().key, sourceKey);
});

test('manual episode selection keeps local history restoration, URL updates and the source-switch lock', async () => {
  const selections = [];
  const urls = [];
  let savedProgress = 0;
  const context = {
    detailRef: { current: { episodes: ['first.m3u8', 'second.m3u8'] } },
    currentEpisodeIndexRef: { current: 0 },
    isSourceChangingRef: { current: false },
    isEpisodeChangingRef: { current: false },
    isSkipControllerTriggeredRef: { current: false },
    autoPlayNextEpisodeRef: { current: false },
    episodeSwitchRef: { current: null },
    beginEpisodeSwitch(index) {
      if (context.episodeSwitchRef.current) return null;
      return context.episodeSwitchRef.current = { index };
    },
    artPlayerRef: { current: { paused: true } },
    saveCurrentPlayProgress: () => { savedProgress++; },
    getAllPlayRecords: async () => ({ 'first/video': { index: 2, play_time: 42 } }),
    generateStorageKey: (source, id) => `${source}/${id}`,
    currentSourceRef: { current: 'first' },
    currentIdRef: { current: 'video' },
    resumeTimeRef: { current: null },
    setCurrentPlayTime() {},
    setVideoDuration() {},
    setCurrentEpisodeIndex: index => selections.push(index),
    URL,
    window: {
      location: { href: 'https://site.test/play?source=first&id=video&index=0' },
      history: { replaceState: (_state, _title, url) => urls.push(new URL(url)) },
    },
    console: { log() {}, warn() {} },
  };
  const selectEpisode = loadActualPlayFunction('handleEpisodeChange', context);
  await selectEpisode(1);
  assert.equal(context.resumeTimeRef.current, 42);
  assert.equal(savedProgress, 1);
  assert.deepEqual(selections, [1]);
  assert.equal(urls[0].searchParams.get('index'), '1');
  assert.equal(urls[0].searchParams.get('source'), 'first');
  assert.equal(urls[0].searchParams.get('id'), 'video');

  context.currentEpisodeIndexRef.current = 1;
  context.episodeSwitchRef.current = null;
  context.isSourceChangingRef.current = true;
  await selectEpisode(0);
  assert.deepEqual(selections, [1]);
  context.isSourceChangingRef.current = false;
  await selectEpisode(0);
  assert.equal(context.resumeTimeRef.current, 0, 'another episode does not inherit the prior episode time');
  assert.deepEqual(selections, [1, 0]);
  await selectEpisode(-1);
  await selectEpisode(2);
  assert.deepEqual(selections, [1, 0]);
});

test('manual source switching preserves progress for the same episode and clears it when the new source is shorter', async () => {
  for (const currentEpisodeIndex of [1, 3]) {
    const stored = new Map();
    const changes = {};
    const target = { source: 'mirror', id: 'video', title: 'Fixture', year: '2026', poster: '/poster', episodes: ['first.m3u8', 'second.m3u8'] };
    let finalUrl;
    const context = {
      isSourceChangingRef: { current: false },
      autoPlayNextEpisodeRef: { current: false },
      cancelEpisodeSwitch() {},
      videoUrlRequestRef: { current: null },
      setVideoLoadingStage() {},
      setIsVideoLoading() {},
      cancelExternalDanmuLoad() {},
      clearPlayerDanmu() {},
      artPlayerRef: { current: { currentTime: 58 } },
      currentEpisodeIndex,
      sessionStorage: { setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
      currentSourceRef: { current: 'old-source' },
      currentIdRef: { current: 'old-video' },
      deletePlayRecord: async () => {},
      availableSources: [target],
      setError: error => { throw new Error(error); },
      videoDoubanIdRef: { current: 0 },
      URL,
      window: {
        location: { href: `https://site.test/play?source=old-source&id=old-video&index=${currentEpisodeIndex}` },
        history: { replaceState: (_state, _title, url) => { finalUrl = new URL(url); } },
      },
      console: { log() {}, warn() {}, error() {} },
    };
    for (const field of ['VideoTitle', 'VideoYear', 'VideoCover', 'VideoDoubanId', 'CurrentSource', 'CurrentId', 'Detail', 'CurrentEpisodeIndex']) {
      context[`set${field}`] = value => { changes[field] = value; };
    }
    await loadActualPlayFunction('handleSourceChange', context)('mirror', 'video', 'Fixture');
    assert.equal(changes.CurrentSource, 'mirror');
    assert.equal(changes.CurrentId, 'video');
    assert.equal(changes.Detail, target);
    assert.equal(finalUrl.searchParams.get('index'), '1');
    if (currentEpisodeIndex === 1) {
      assert.equal(stored.get('temp_progress_mirror_video_1'), '58');
      assert.equal(changes.CurrentEpisodeIndex, undefined, 'same episode does not get reset');
    } else {
      assert.equal(stored.size, 0, 'progress from a missing episode is discarded');
      assert.equal(changes.CurrentEpisodeIndex, 1);
    }
  }
});

class FakeHls {
  static DefaultConfig = { loader: class {} };
  static Events = { ERROR: 'error', DESTROYING: 'destroying', AUDIO_TRACKS_UPDATED: 'audio-updated', AUDIO_TRACK_SWITCHED: 'audio-switched', FRAG_LOADED: 'frag-loaded' };
  static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
  static ErrorDetails = { FRAG_PARSING_ERROR: 'frag-parsing', BUFFER_APPEND_ERROR: 'buffer-append', FRAG_LOAD_ERROR: 'frag-load', FRAG_LOAD_TIMEOUT: 'frag-timeout', LEVEL_LOAD_ERROR: 'level-load', LEVEL_LOAD_TIMEOUT: 'level-timeout' };
  sources = [];
  handlers = new Map();
  destroyed = false;
  restarts = 0;
  recoveries = 0;
  constructor(config) { this.config = config; }
  loadSource(url) { this.sources.push(url); }
  attachMedia(video) { this.video = video; }
  destroy() { this.destroyed = true; this.handlers.get('destroying')?.(); }
  on(event, callback) { this.handlers.set(event, callback); }
  startLoad() { this.restarts++; }
  recoverMediaError() { this.recoveries++; }
  error(fatal = true) { this.handlers.get('error')('error', { fatal, type: 'network', details: fatal ? 'manifest-load' : 'frag-load' }); }
}

test('the actual player HLS callback falls back on initial and switched URLs and ignores stale errors', (t) => {
  installBrowser(t, { ...proxyFlags });
  const utils = loadUtilities();
  const released = [];
  const failures = [];
  const loading = [];
  const { getVideoHlsRecovery, destroyVideoHls } = createSourceLoader()('hls-recovery.ts');
  const ticketRef = { current: { index: 0 } };
  const context = {
    Hls: FakeHls, episodeSwitchRef: ticketRef, isIOS13: false, isMobile: false, isIOS: false,
    getHlsBufferConfig: () => ({}), blockAdEnabledRef: { current: false },
    ensureVideoSource: () => {}, getNextHlsFallbackUrl: utils.getNextHlsFallbackUrl,
    getVideoHlsRecovery, destroyVideoHls,
    isSourceChangingRef: { current: true }, isEpisodeChangingRef: { current: true }, isSourceSwitchingRef: { current: true },
    setIsVideoLoading: value => loading.push(value), setError: error => failures.push(error),
    finishEpisodeSwitch: (ticket) => released.push(ticket), console: { log() {}, warn() {}, error() {} },
  };
  const callback = loadActualHlsCallback(context);
  const video = Object.assign(new EventTarget(), { currentTime: 0, paused: false, seeking: false, readyState: 4, pause() {}, removeAttribute() {}, load() {} });
  const firstUrl = 'https://cdn.test/first.m3u8?token=%252F';
  callback(video, utils.applyVideoPlayProxy(firstUrl));
  const first = video.hls;
  first.error();
  first.error();
  first.error();
  assert.deepEqual(first.sources, [utils.applyVideoPlayProxy(firstUrl), firstUrl, utils.applyFirstPartyM3u8Proxy(firstUrl)]);
  assert.equal(released[0], ticketRef.current);
  assert.equal(video.hls, undefined, 'terminal failures release the media engine');
  assert.equal(first.restarts, 0, 'exhausted network errors cannot restart loading');
  assert.equal(failures.length, 1);
  assert.deepEqual(loading, [false]);
  ticketRef.current = { index: 1 };
  context.cancelled = true; // The old creation effect has ended when ArtPlayer switches URLs.
  const secondUrl = 'https://cdn.test/second.m3u8';
  callback(video, utils.applyVideoPlayProxy(secondUrl));
  assert.equal(first.destroyed, true);
  const second = video.hls;
  first.error();
  assert.equal(released.length, 1, 'old HLS errors must not release the new episode lock');
  for (let i = 0; i < 7; i++) second.error(false);
  second.handlers.get('frag-loaded')();
  second.error(false);
  assert.equal(second.sources.length, 1, 'a successful fragment resets consecutive errors');
  for (let i = 0; i < 7; i++) second.error(false);
  second.error();
  assert.deepEqual(second.sources, [utils.applyVideoPlayProxy(secondUrl), secondUrl, utils.applyFirstPartyM3u8Proxy(secondUrl)]);
});
