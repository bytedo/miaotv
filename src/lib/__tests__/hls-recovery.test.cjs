const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Hls = require('hls.js');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
const { createSourceLoader } = require('./storage-test-loader.cjs');

const {
  createHlsRecoveryBudget,
  destroyVideoHls,
  getVideoHlsRecovery,
  resetVideoHlsRecovery,
} = createSourceLoader()('hls-recovery.ts');
const { waitForPlaybackSwitch, PlaybackSwitchError } =
  createSourceLoader()('playback-switch.ts');
const file = path.resolve(__dirname, '../../app/play/page.tsx');
const source = ts.createSourceFile(
  file,
  fs.readFileSync(file, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let callback;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'm3u8')
    callback = node.initializer;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback, 'the page must register an HLS callback');
const callbackScript = ts.transpileModule(`(${callback.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

class Emitter {
  handlers = new Map();
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
  }
  off(event, handler) {
    this.handlers.get(event)?.delete(handler);
  }
  emit(event, ...args) {
    for (const handler of [...(this.handlers.get(event) || [])])
      handler(...args);
  }
}

class FakeVideo extends EventTarget {
  currentTime = 37;
  readyState = 4;
  paused = false;
  seeking = false;
  loads = 0;
  srcRemoved = false;
  progressListeners = new Set();
  pause() {
    this.paused = true;
  }
  removeAttribute(name) {
    if (name === 'src') this.srcRemoved = true;
  }
  load() {
    this.loads++;
  }
  addEventListener(event, handler) {
    super.addEventListener(event, handler);
    if (event === 'timeupdate') this.progressListeners.add(handler);
  }
  removeEventListener(event, handler) {
    super.removeEventListener(event, handler);
    if (event === 'timeupdate') this.progressListeners.delete(handler);
  }
}

function createPlayerHarness({ fallback = () => null, onLoad } = {}) {
  const instances = [];
  class FakeHls extends Emitter {
    static DefaultConfig = { loader: class {} };
    static Events = Hls.Events;
    static ErrorTypes = Hls.ErrorTypes;
    static ErrorDetails = Hls.ErrorDetails;
    sources = [];
    restarts = [];
    recoveries = 0;
    destroys = 0;
    attachments = 0;
    constructor(config) {
      super();
      this.config = config;
      instances.push(this);
    }
    loadSource(url) {
      this.sources.push(url);
      onLoad?.(this, url);
    }
    attachMedia() {
      this.attachments++;
    }
    destroy() {
      this.destroys++;
      this.emit(Hls.Events.DESTROYING);
      this.handlers.clear();
    }
    startLoad(position) {
      this.restarts.push(position);
    }
    recoverMediaError() {
      this.recoveries++;
    }
    error(data) {
      this.emit(Hls.Events.ERROR, Hls.Events.ERROR, data);
    }
    fragment() {
      this.emit(Hls.Events.FRAG_LOADED);
    }
  }
  const player = new Emitter();
  const video = new FakeVideo();
  const failures = [];
  const finished = [];
  const loading = [];
  const sources = [];
  const playerFailures = [];
  player.on('playback:error', (error) => playerFailures.push(error.message));
  let clock = 0;
  const controlledBudgets = new WeakSet();
  const context = {
    Hls: FakeHls,
    episodeSwitchRef: { current: { index: 0 } },
    artPlayerRef: { current: player },
    isSourceChangingRef: { current: true },
    isEpisodeChangingRef: { current: true },
    isSourceSwitchingRef: { current: true },
    isIOS13: false,
    isMobile: false,
    isIOS: false,
    getHlsBufferConfig: () => ({}),
    blockAdEnabledRef: { current: false },
    ensureVideoSource: (_video, url) => sources.push(url),
    getNextHlsFallbackUrl: fallback,
    finishEpisodeSwitch: (ticket) => finished.push(ticket),
    setIsVideoLoading: (value) => loading.push(value),
    setError: (error) => failures.push(error),
    destroyVideoHls,
    getVideoHlsRecovery: (targetVideo, url) => {
      const session = getVideoHlsRecovery(targetVideo, url);
      if (!controlledBudgets.has(session.budget)) {
        const record = session.budget.recordPlaybackProgress;
        session.budget.recordPlaybackProgress = (position) =>
          record(position, clock);
        controlledBudgets.add(session.budget);
      }
      return session;
    },
    console: { log() {}, warn() {}, error() {} },
  };
  const load = vm.runInNewContext(callbackScript, context);
  return {
    context,
    player,
    video,
    instances,
    failures,
    finished,
    loading,
    sources,
    playerFailures,
    load(url) {
      load(video, url, player);
      return video.hls;
    },
    playFor(seconds) {
      video.dispatchEvent(new Event('timeupdate'));
      for (let index = 0; index < seconds; index++) {
        clock += 1_000;
        video.currentTime++;
        video.dispatchEvent(new Event('timeupdate'));
      }
    },
  };
}

const fatalNetwork = {
  fatal: true,
  type: Hls.ErrorTypes.NETWORK_ERROR,
  details: Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
};
const fatalMedia = {
  fatal: true,
  type: Hls.ErrorTypes.MEDIA_ERROR,
  details: Hls.ErrorDetails.BUFFER_APPEND_ERROR,
};

test('actual HLS callback stops after the last transport and clears loading and episode locks', () => {
  const worker = 'https://worker.test/m3u8?url=fixture';
  const direct = 'https://cdn.test/fixture.m3u8';
  const site = '/api/proxy/m3u8?url=fixture';
  const next = new Map([
    [worker, direct],
    [direct, site],
  ]);
  const harness = createPlayerHarness({
    fallback: (url) => next.get(url) || null,
  });
  const hls = harness.load(worker);
  const staleErrorHandler = [...hls.handlers.get(Hls.Events.ERROR)][0];
  hls.error(fatalNetwork);
  hls.error(fatalNetwork);
  hls.error(fatalNetwork);
  assert.deepEqual(hls.sources, [worker, direct, site]);
  assert.equal(
    hls.config.startPosition,
    37,
    'transport changes retain the watched position',
  );
  assert.equal(
    hls.restarts.length,
    0,
    'exhausted network failures must not restart',
  );
  assert.equal(hls.destroys, 1);
  assert.equal(harness.video.hls, undefined);
  assert.equal(harness.video.progressListeners.size, 0);
  assert.equal(harness.video.paused, true);
  assert.equal(harness.video.srcRemoved, true);
  assert.equal(harness.video.loads, 1);
  assert.deepEqual(harness.finished, [
    harness.context.episodeSwitchRef.current,
  ]);
  assert.deepEqual(harness.loading, [false]);
  assert.equal(harness.failures.length, 1);
  assert.match(harness.failures[0], /重新尝试/);
  assert.deepEqual(harness.playerFailures, harness.failures);
  for (const name of [
    'isSourceChangingRef',
    'isEpisodeChangingRef',
    'isSourceSwitchingRef',
  ]) {
    assert.equal(harness.context[name].current, false, name);
  }
  for (let index = 0; index < 10; index++)
    staleErrorHandler(Hls.Events.ERROR, fatalNetwork);
  assert.equal(
    harness.failures.length,
    1,
    'late events cannot report the terminal state again',
  );
  harness.load(worker);
  assert.equal(
    harness.instances.length,
    1,
    'queued ArtPlayer reconnection cannot start another retry cycle',
  );
});

test('fatal parsing, append and media failures have finite active recovery budgets', () => {
  for (const details of [
    Hls.ErrorDetails.FRAG_PARSING_ERROR,
    Hls.ErrorDetails.BUFFER_APPEND_ERROR,
    Hls.ErrorDetails.BUFFER_APPENDING_ERROR,
    Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET,
  ]) {
    const harness = createPlayerHarness();
    const hls = harness.load('/api/proxy/m3u8?url=fixture');
    const error = {
      fatal: true,
      type: Hls.ErrorTypes.MEDIA_ERROR,
      details,
      error: new Error('timestamp'),
      err: new Error('timestamp'),
    };
    for (let index = 0; index < 20; index++) {
      hls.fragment();
      hls.error(error);
    }
    if (details === Hls.ErrorDetails.FRAG_PARSING_ERROR)
      assert.deepEqual(hls.restarts, [37, 37]);
    else assert.equal(hls.recoveries, 2);
    assert.equal(hls.destroys, 1, details);
    assert.equal(harness.failures.length, 1, details);
  }
});

test('persistent nonfatal corrupt fragments do not reset on a successful download', () => {
  const harness = createPlayerHarness();
  const hls = harness.load('/api/proxy/m3u8?url=fixture');
  const error = {
    fatal: false,
    type: Hls.ErrorTypes.MEDIA_ERROR,
    details: Hls.ErrorDetails.FRAG_PARSING_ERROR,
  };
  for (let index = 0; index < 20; index++)
    hls.error({ ...error, frag: { gap: true } });
  assert.equal(
    hls.destroys,
    0,
    'declared HLS gaps remain under the library policy',
  );
  for (let index = 0; index < 8; index++) {
    hls.fragment();
    hls.error(error);
  }
  assert.equal(
    hls.restarts.length,
    0,
    'nonfatal errors do not bypass hls.js retry limits',
  );
  assert.equal(hls.recoveries, 0);
  assert.equal(hls.destroys, 1);
});

test('media recovery remains bounded across every transport fallback', () => {
  const worker = 'https://worker.test/m3u8?url=fixture';
  const direct = 'https://cdn.test/fixture.m3u8';
  const site = '/api/proxy/m3u8?url=fixture';
  const next = new Map([
    [worker, direct],
    [direct, site],
  ]);
  const harness = createPlayerHarness({
    fallback: (url) => next.get(url) || null,
  });
  const hls = harness.load(worker);
  for (let index = 0; index < 20; index++) hls.error(fatalMedia);
  assert.deepEqual(hls.sources, [worker, direct, site]);
  assert.equal(hls.recoveries, 6);
  assert.equal(hls.destroys, 1);
  assert.equal(harness.failures.length, 1);
});

test('persistent nonfatal fragment and key failures terminate after fallback exhaustion', () => {
  for (const details of [
    Hls.ErrorDetails.FRAG_LOAD_ERROR,
    Hls.ErrorDetails.KEY_LOAD_TIMEOUT,
  ]) {
    const harness = createPlayerHarness();
    const hls = harness.load('/api/proxy/m3u8?url=fixture');
    const error = { fatal: false, type: Hls.ErrorTypes.NETWORK_ERROR, details };
    for (let index = 0; index < 7; index++) hls.error(error);
    hls.fragment();
    hls.error(error);
    assert.equal(
      hls.destroys,
      0,
      'one successful fragment breaks consecutive network failures',
    );
    for (let index = 0; index < 7; index++) hls.error(error);
    assert.equal(hls.destroys, 1);
    assert.equal(hls.restarts.length, 0);
  }
});

test('a cyclic fallback cannot reload an already attempted transport', () => {
  const harness = createPlayerHarness({ fallback: (url) => url });
  const hls = harness.load('https://cdn.test/fixture.m3u8');
  hls.error(fatalNetwork);
  assert.equal(hls.sources.length, 1);
  assert.equal(hls.destroys, 1);
});

test('same-URL ArtPlayer reconnections cannot replenish the recovery budget', () => {
  const harness = createPlayerHarness();
  const url = 'https://cdn.test/fixture.m3u8';
  const first = harness.load(url);
  first.error(fatalMedia);
  const second = harness.load(url);
  second.error(fatalMedia);
  const third = harness.load(url);
  third.error(fatalMedia);
  assert.equal(first.recoveries + second.recoveries + third.recoveries, 2);
  assert.equal(third.destroys, 1);
  harness.load(url);
  assert.equal(harness.instances.length, 3);
  resetVideoHlsRecovery(harness.video);
  const retried = harness.load(url);
  retried.error(fatalMedia);
  assert.equal(retried.recoveries, 1, 'an explicit retry gets a new budget');
  assert.equal(retried.destroys, 0);
});

test('same-URL reconnections retain the current fallback transport', () => {
  const worker = 'https://worker.test/m3u8?url=fixture';
  const direct = 'https://cdn.test/fixture.m3u8';
  const site = '/api/proxy/m3u8?url=fixture';
  const next = new Map([
    [worker, direct],
    [direct, site],
  ]);
  const harness = createPlayerHarness({
    fallback: (url) => next.get(url) || null,
  });
  harness.load(worker).error(fatalNetwork);
  const second = harness.load(worker);
  assert.deepEqual(second.sources, [direct]);
  second.error(fatalNetwork);
  const third = harness.load(worker);
  assert.deepEqual(third.sources, [site]);
  third.error(fatalNetwork);
  assert.equal(third.destroys, 1);
});

test('automatic reconnections retain watched progress while a new episode starts fresh', () => {
  const harness = createPlayerHarness();
  const url = 'https://cdn.test/fixture.m3u8';
  harness.load(url);
  harness.playFor(3);
  const reconnected = harness.load(url);
  assert.equal(reconnected.config.startPosition, 40);
  const nextEpisode = harness.load('https://cdn.test/next.m3u8');
  assert.equal(nextEpisode.config.startPosition, -1);
});

test('an explicit switch invalidates previous recovery callbacks immediately', () => {
  const harness = createPlayerHarness();
  const url = 'https://cdn.test/fixture.m3u8';
  const previous = harness.load(url);
  resetVideoHlsRecovery(harness.video);
  previous.error(fatalNetwork);
  assert.equal(harness.failures.length, 0);
  assert.equal(harness.finished.length, 0);
  const current = harness.load(url);
  assert.equal(previous.destroys, 1);
  current.error(fatalMedia);
  assert.equal(current.recoveries, 1);
});

test('the actual terminal HLS event settles the pending playback switch', async () => {
  const harness = createPlayerHarness();
  const switching = waitForPlaybackSwitch(
    harness.player,
    () => {
      harness.load('/api/proxy/m3u8?url=fixture');
      return new Promise(() => {});
    },
    new AbortController().signal,
  );
  const rejected = assert.rejects(switching, PlaybackSwitchError);
  harness.video.hls.error(fatalNetwork);
  await rejected;
  assert.equal(
    harness.player.handlers.get('playback:error').size,
    1,
    'the switch failure listener is removed',
  );
});

test('successful playback restores short-term recovery, while a session-wide ceiling prevents loops', () => {
  const harness = createPlayerHarness();
  const hls = harness.load('/api/proxy/m3u8?url=fixture');
  for (let index = 0; index < 6; index++) {
    hls.error(fatalMedia);
    harness.playFor(30);
    assert.equal(hls.destroys, 0);
  }
  assert.equal(hls.recoveries, 6);
  hls.error(fatalMedia);
  assert.equal(hls.recoveries, 6);
  assert.equal(hls.destroys, 1);
});

test('seeks and repeated fragment downloads cannot count as healthy playback', () => {
  const budget = createHlsRecoveryBudget();
  assert.equal(budget.takeRecovery(), true);
  assert.equal(budget.takeRecovery(), true);
  budget.recordPlaybackProgress(10, 0);
  budget.recordPlaybackProgress(3_000, 1_000);
  budget.recordPlaybackProgress(3_000, 31_000);
  assert.equal(budget.takeRecovery(), false);
  budget.resetAfterFallback();
  assert.equal(
    budget.takeRecovery(),
    true,
    'the next transport gets a short recovery budget',
  );
});

test('HLS replacement and native switching release ownership before stale events can run', () => {
  const harness = createPlayerHarness();
  const old = harness.load('https://cdn.test/first.m3u8');
  const staleErrorHandler = [...old.handlers.get(Hls.Events.ERROR)][0];
  harness.context.episodeSwitchRef.current = { index: 1 };
  const next = harness.load('https://cdn.test/second.m3u8');
  assert.equal(old.destroys, 1);
  assert.equal(harness.video.progressListeners.size, 1);
  staleErrorHandler(Hls.Events.ERROR, fatalNetwork);
  destroyVideoHls(harness.video, old);
  assert.equal(
    next.destroys,
    0,
    'an old disposer cannot destroy the replacement',
  );
  let ownerDuringDestroy = next;
  next.on(Hls.Events.DESTROYING, () => {
    ownerDuringDestroy = harness.video.hls;
  });
  destroyVideoHls(harness.video);
  assert.equal(ownerDuringDestroy, undefined);
  assert.equal(next.destroys, 1);
  assert.equal(harness.video.progressListeners.size, 0);
  assert.equal(harness.finished.length, 0);
  assert.equal(harness.failures.length, 0);
});

test('AirPlay alternative sources cannot prevent HLS MediaSource cleanup', () => {
  let alternative = 'https://cdn.test/fixture.m3u8';
  let detached = false;
  const video = {
    querySelectorAll: () => [
      {
        remove() {
          alternative = null;
        },
      },
    ],
    hls: {
      destroy() {
        // Match hls.js: an alternative source would make it skip blob cleanup.
        if (alternative === null) detached = true;
        assert.equal(video.hls, undefined);
      },
    },
  };
  destroyVideoHls(video);
  assert.equal(detached, true);
});

test('player destruction removes the HLS session and delayed callbacks cannot recreate it', () => {
  const harness = createPlayerHarness();
  const hls = harness.load('https://cdn.test/first.m3u8');
  harness.player.isDestroy = true;
  harness.player.emit('destroy');
  harness.load('https://cdn.test/second.m3u8');
  assert.equal(hls.destroys, 1);
  assert.equal(harness.instances.length, 1);
  assert.equal(harness.video.progressListeners.size, 0);
});

test('synchronous HLS load failures reach the same terminal state', () => {
  const harness = createPlayerHarness({
    onLoad() {
      throw new Error('loader unavailable');
    },
  });
  harness.load('/api/proxy/m3u8?url=fixture');
  assert.equal(harness.instances[0].attachments, 0);
  assert.equal(harness.instances[0].destroys, 1);
  assert.equal(harness.failures.length, 1);
  assert.deepEqual(harness.loading, [false]);
});

test('a synchronous manifest failure is handled before media attachment', () => {
  const direct = 'https://cdn.test/first.m3u8';
  const site = '/api/proxy/m3u8?url=fixture';
  const harness = createPlayerHarness({
    fallback: (url) => (url === direct ? site : null),
    onLoad(hls, url) {
      if (url === direct) hls.error(fatalNetwork);
    },
  });
  const hls = harness.load(direct);
  assert.deepEqual(hls.sources, [direct, site]);
  assert.equal(hls.attachments, 1);
  assert.equal(harness.sources.at(-1), site);
  assert.equal(harness.failures.length, 0);
});
