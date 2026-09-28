const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
const { createHookHost } = require('./playback-test-helpers.cjs');
const { createSourceLoader } = require('./storage-test-loader.cjs');

// Exercise the real page callbacks without mounting Next, touching storage, or
// connecting to a video source. Only their browser/player dependencies are fake.
const pageFile = path.resolve(__dirname, '../../app/play/page.tsx');
const page = ts.createSourceFile(
  pageFile,
  fs.readFileSync(pageFile, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const skipFile = path.resolve(__dirname, '../../components/SkipController.tsx');
const skipController = ts.createSourceFile(
  skipFile,
  fs.readFileSync(skipFile, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function findNode(predicate, label, source = page) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1, `expected one actual ${label}`);
  return matches[0];
}

function evaluate(node, context, source = page) {
  const script = ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return vm.runInNewContext(script, context, { filename: 'actual-playback-callback.js' });
}

function loadFunction(name, context) {
  const declaration = findNode(
    node => ts.isVariableDeclaration(node) && node.name.getText(page) === name,
    name,
  );
  return evaluate(declaration.initializer, context);
}

function loadSkipFunction(name, context) {
  const declaration = findNode(
    node => ts.isVariableDeclaration(node) && node.name.getText(skipController) === name,
    name,
    skipController,
  );
  const callback = declaration.initializer.arguments[0];
  return evaluate(callback, context, skipController);
}

function loadPlayerEvent(name, context) {
  const registration = findNode(
    node => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'on'
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === name,
    `${name} listener`,
  );
  return evaluate(registration.arguments[1], context);
}

function loadSwitchPromiseChain(context) {
  const assignment = findNode(
    node => ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
      && node.left.text === 'switchPromise'
      && ts.isCallExpression(node.right)
      && ts.isPropertyAccessExpression(node.right.expression)
      && node.right.expression.name.text === 'catch',
    'switchUrl completion chain',
  );
  return evaluate(assignment, context);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  // The actual saver crosses history, per-record queue, and mutation promises.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const quietConsole = { log() {}, warn() {}, error() {} };
const copy = value => JSON.parse(JSON.stringify(value));

function createProgressFixture(overrides = {}) {
  const writes = [];
  const context = {
    artPlayerRef: { current: {
      currentTime: 90, duration: 900, paused: false, isDestroy: false, video: { ended: false },
    } },
    currentSourceRef: { current: 'fixture' },
    currentIdRef: { current: 'video' },
    videoTitleRef: { current: 'Original title' },
    videoDoubanIdRef: { current: 1234567 },
    currentEpisodeIndexRef: { current: 0 },
    detailRef: { current: {
      source_name: 'Original source', year: '2026', poster: '/original.jpg',
      episodes: ['first.m3u8', 'second.m3u8'], remarks: 'Original remarks',
    } },
    availableSourcesRef: { current: [] },
    lastSaveTimeRef: { current: 0 },
    progressSaveVersionsRef: { current: new Map() },
    progressSaveQueuesRef: { current: new Map() },
    isSourceChangingRef: { current: false },
    isEpisodeChangingRef: { current: false },
    isSourceSwitchingRef: { current: false },
    isSkipControllerTriggeredRef: { current: false },
    getAllPlayRecords: async () => ({}),
    generateStorageKey: (source, id) => `${source}/${id}`,
    savePlayRecordMutation: {
      mutate: value => writes.push(copy(value)),
      mutateAsync: async value => { writes.push(copy(value)); },
    },
    searchTitle: 'Original search', searchType: 'tv',
    console: quietConsole,
    ...overrides,
  };
  context.errorPlayer = context.artPlayerRef.current;
  context.saveCurrentPlayProgress = loadFunction('saveCurrentPlayProgress', context);
  return { context, writes, save: context.saveCurrentPlayProgress };
}

test('saving progress keeps the original episode and metadata while history is pending', async () => {
  const history = deferred();
  const { context, writes, save } = createProgressFixture({ getAllPlayRecords: () => history.promise });
  const pending = save();

  context.currentSourceRef.current = 'another-source';
  context.currentIdRef.current = 'another-video';
  context.currentEpisodeIndexRef.current = 3;
  context.videoTitleRef.current = 'Another title';
  context.videoDoubanIdRef.current = 7654321;
  context.detailRef.current = {
    source_name: 'Another source', year: '2025', poster: '/another.jpg',
    episodes: ['a', 'b', 'c', 'd'], remarks: 'Another remarks',
  };
  context.artPlayerRef.current.currentTime = 0;
  history.resolve({
    'fixture/video': { original_episodes: 2 },
    'another-source/another-video': { original_episodes: 4 },
  });
  await pending;

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    source: 'fixture', id: 'video',
    record: {
      title: 'Original title', source_name: 'Original source', year: '2026',
      cover: '/original.jpg', index: 1, total_episodes: 2, original_episodes: 2,
      play_time: 90, total_time: 900, save_time: writes[0].record.save_time,
      search_title: 'Original search', remarks: 'Original remarks',
      douban_id: 1234567, type: 'tv',
    },
  });
});

test('an older history lookup cannot overwrite a newer progress snapshot', async () => {
  const histories = [];
  const { context, writes, save } = createProgressFixture({
    getAllPlayRecords: () => {
      const result = deferred();
      histories.push(result);
      return result.promise;
    },
  });
  context.artPlayerRef.current.currentTime = 40;
  const older = save();
  context.artPlayerRef.current.currentTime = 80;
  const newer = save();
  assert.equal(histories.length, 2);

  histories[1].resolve({});
  await flushMicrotasks();
  histories[0].resolve({});
  await Promise.all([older, newer]);

  assert.deepEqual(writes.map(item => item.record.play_time), [80]);
});

test('progress mutations for one record finish in capture order', async () => {
  const mutations = [];
  function beginMutation(value) {
    const result = deferred();
    mutations.push({ value: copy(value), ...result });
    return result.promise;
  }
  const { context, save } = createProgressFixture({
    savePlayRecordMutation: { mutate: beginMutation, mutateAsync: beginMutation },
  });
  context.artPlayerRef.current.currentTime = 40;
  const older = save();
  await flushMicrotasks();
  assert.equal(mutations.length, 1);

  context.artPlayerRef.current.currentTime = 80;
  const newer = save();
  await flushMicrotasks();
  assert.equal(mutations.length, 1, 'the newer request waits for the in-flight write');
  mutations[0].resolve();
  await flushMicrotasks();
  assert.equal(mutations.length, 2);
  assert.equal(mutations[1].value.record.play_time, 80);
  mutations[1].resolve();
  await Promise.all([older, newer]);
});

function createEpisodeFixture(t, overrides = {}) {
  const host = createHookHost();
  t.after(() => host.unmount());
  const { useEpisodeSwitch } = createSourceLoader({ react: host.React })('../hooks/useEpisodeSwitch.ts');
  const control = host.render(useEpisodeSwitch);
  const selections = [];
  const urls = [];
  const historyReads = [];
  const saves = [];
  const player = {
    currentTime: 600, duration: 600, paused: true, isDestroy: false,
    video: { ended: true }, url: 'https://fixture.test/first.m3u8',
  };
  const context = {
    ...control,
    artPlayerRef: { current: player }, errorPlayer: player,
    detailRef: { current: { episodes: ['first', 'second', 'third', 'fourth', 'fifth'] } },
    currentSourceRef: { current: 'fixture' }, currentIdRef: { current: 'video' },
    currentEpisodeIndexRef: { current: 0 }, resumeTimeRef: { current: null },
    isSourceChangingRef: { current: false }, isEpisodeChangingRef: { current: false },
    isSourceSwitchingRef: { current: false }, isSkipControllerTriggeredRef: { current: false },
    autoPlayNextEpisodeRef: { current: false },
    videoEndedHandledRef: { current: false },
    activePlaybackUrlRef: { current: player.url },
    saveCurrentPlayProgress: () => { saves.push(true); return Promise.resolve(); },
    getAllPlayRecords: async () => {
      historyReads.push(true);
      return { 'fixture/video': { index: 2, play_time: 42 } };
    },
    generateStorageKey: (source, id) => `${source}/${id}`,
    releaseWakeLock() {}, setTimeout, clearTimeout,
    setCurrentPlayTime() {}, setVideoDuration() {},
    URL, console: quietConsole,
    window: {
      location: { href: 'https://site.test/play?source=fixture&id=video&index=0' },
      history: { replaceState(_state, _title, url) {
        urls.push(new URL(url));
        context.window.location.href = String(url);
      } },
    },
    setCurrentEpisodeIndex(index) {
      selections.push(index);
      context.currentEpisodeIndexRef.current = index;
    },
    ...overrides,
  };
  context.handleEpisodeChange = loadFunction('handleEpisodeChange', context);
  return { context, control, player, selections, urls, historyReads, saves };
}

function createCanplayContext(player) {
  return {
    artPlayerRef: { current: player }, errorPlayer: player,
    activePlaybackUrlRef: { current: 'https://fixture.test/first.m3u8' },
    videoEndedHandledRef: { current: false }, episodeSwitchRef: { current: null },
    autoPlayNextEpisodeRef: { current: false },
    isSkipControllerTriggeredRef: { current: false }, resumeTimeRef: { current: 42 },
    isAudioTrackSwitching: false, isIOS: false, isSafari: false, setTimeout, clearTimeout,
    lastVolumeRef: { current: 0.7 }, loadPlaybackRate: () => 1.5,
    setIsVideoLoading() {}, isSourceChangingRef: { current: false },
    isEpisodeChangingRef: { current: true }, console: quietConsole,
  };
}

test('canplay history restoration survives the complete switchUrl promise chain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const player = { currentTime: 0, duration: 900, volume: 0.7, playbackRate: 1.5, isDestroy: false, notice: {} };
  const context = {
    ...createCanplayContext(player), isEpisodeChange: true,
    cancelled: false, switchPromise: gate.promise, switchPromiseRef: { current: null },
    videoTitle: 'Fixture', videoCover: '/fixture.jpg', currentEpisodeIndex: 1,
  };
  const canplay = loadPlayerEvent('video:canplay', context);
  const completion = loadSwitchPromiseChain(context);
  context.switchPromiseRef.current = completion;

  // ArtPlayer emits canplay before resolving switchUrl's promise.
  canplay();
  assert.equal(player.currentTime, 42);
  gate.resolve();
  await completion;
  t.mock.timers.tick(0);

  assert.equal(player.currentTime, 42, 'switch completion must preserve the restored position');
  assert.equal(context.resumeTimeRef.current, null);
  player.currentTime = 45;
  canplay();
  assert.equal(player.currentTime, 45, 'a later buffering canplay must not seek again');
});

test('natural completion advances once, updates the URL, and starts the next episode from zero', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = createEpisodeFixture(t);
  const ended = loadPlayerEvent('video:ended', fixture.context);
  ended();
  ended();
  await flushMicrotasks();
  t.mock.timers.tick(1000);
  await flushMicrotasks();

  assert.deepEqual(fixture.selections, [1]);
  assert.equal(fixture.urls.length, 1);
  assert.equal(fixture.urls[0].searchParams.get('index'), '1');
  assert.equal(fixture.context.resumeTimeRef.current, 0);
  assert.equal(fixture.historyReads.length, 0, 'automatic playback does not restore an old next-episode timestamp');
  assert.equal(fixture.saves.length, 0, 'natural completion does not save the closing frame');
});

test('an old completion cannot override a subsequent manual episode choice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = createEpisodeFixture(t);
  loadPlayerEvent('video:ended', fixture.context)();
  await flushMicrotasks();
  fixture.control.finishEpisodeSwitch(fixture.control.episodeSwitchRef.current);
  fixture.context.isEpisodeChangingRef.current = false;
  fixture.context.isSkipControllerTriggeredRef.current = false;
  fixture.player.video.ended = false;
  fixture.player.paused = false;
  await fixture.context.handleEpisodeChange(3);

  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(fixture.context.currentEpisodeIndexRef.current, 3);
  assert.equal(fixture.urls.at(-1).searchParams.get('index'), '3');
});

test('a replaced player cannot advance the current video with a stale ended event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = createEpisodeFixture(t);
  const oldEnded = loadPlayerEvent('video:ended', fixture.context);
  fixture.context.artPlayerRef.current = { ...fixture.player, video: { ended: false } };
  oldEnded();
  t.mock.timers.tick(1000);
  await flushMicrotasks();

  assert.deepEqual(fixture.selections, []);
  assert.equal(fixture.urls.length, 0);
});

test('manual selection saves the outgoing episode without erasing the target resume position', async (t) => {
  const records = { 'fixture/video': { index: 2, play_time: 42 } };
  let saves = 0;
  const fixture = createEpisodeFixture(t, {
    getAllPlayRecords: async () => records,
    saveCurrentPlayProgress: async () => {
      saves++;
      records['fixture/video'] = { index: 1, play_time: 90 };
    },
  });
  fixture.player.paused = false;
  fixture.player.video.ended = false;
  await fixture.context.handleEpisodeChange(1);

  assert.equal(saves, 1);
  assert.equal(fixture.context.resumeTimeRef.current, 42);
  assert.deepEqual(fixture.selections, [1]);
});

test('pausing a short episode saves progress while its ended frame does not', async () => {
  const fixture = createProgressFixture({ releaseWakeLock() {} });
  fixture.context.artPlayerRef.current.duration = 120;
  fixture.context.artPlayerRef.current.currentTime = 40;
  fixture.context.artPlayerRef.current.paused = true;
  const pause = loadPlayerEvent('pause', fixture.context);
  pause();
  await flushMicrotasks();
  assert.deepEqual(fixture.writes.map(item => item.record.play_time), [40]);

  fixture.context.artPlayerRef.current.currentTime = 120;
  fixture.context.artPlayerRef.current.video.ended = true;
  pause();
  await flushMicrotasks();
  assert.equal(fixture.writes.length, 1);
});

test('short episodes receive periodic progress saves without saving every timeupdate', async () => {
  const fixture = createProgressFixture({
    setCurrentPlayTime() {}, setVideoDuration() {},
    performance: { now: () => 0 }, process: { env: { NEXT_PUBLIC_STORAGE_TYPE: 'redis' } },
  });
  fixture.context.artPlayerRef.current.duration = 120;
  fixture.context.artPlayerRef.current.currentTime = 40;
  const timeupdate = loadPlayerEvent('video:timeupdate', fixture.context);
  timeupdate();
  timeupdate();
  await flushMicrotasks();
  assert.deepEqual(fixture.writes.map(item => item.record.play_time), [40]);
});

test('invalid media metadata never becomes a saved resume position', async () => {
  for (const [currentTime, duration] of [[40, 0], [40, -1], [40, NaN], [40, Infinity], [Infinity, 120]]) {
    let historyReads = 0;
    const fixture = createProgressFixture({
      getAllPlayRecords: async () => { historyReads++; return {}; },
    });
    fixture.context.artPlayerRef.current.currentTime = currentTime;
    fixture.context.artPlayerRef.current.duration = duration;
    await fixture.save();

    assert.equal(fixture.writes.length, 0, `${currentTime}/${duration} is not a valid resume position`);
    assert.equal(historyReads, 0, 'invalid media metadata does not cause a storage request');
  }
});

test('the outgoing frame is not persisted after a skip or while a new episode is loading', async () => {
  for (const state of ['isSkipControllerTriggeredRef', 'isEpisodeChangingRef']) {
    const fixture = createProgressFixture();
    fixture.context[state].current = true;
    fixture.context.artPlayerRef.current.duration = 120;
    fixture.context.artPlayerRef.current.currentTime = 110;
    await fixture.save();

    assert.equal(fixture.writes.length, 0, `${state} must prevent the outgoing frame from becoming new progress`);
  }
});

test('closing skips mark the transition before pausing can persist the closing frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const name of ['handleAutoSkip', 'handleSkip']) {
    const episodes = createEpisodeFixture(t);
    const fixture = createProgressFixture(episodes.context);
    const { context } = fixture;
    context.detailRef.current.source_name = 'Fixture source';
    context.handleEpisodeChange = loadFunction('handleEpisodeChange', context);
    const onNextEpisode = loadFunction('handleSkipToNextEpisode', context);
    const player = context.artPlayerRef.current;
    player.duration = 120;
    player.currentTime = 110;
    player.paused = false;
    player.video.ended = false;
    player.notice = {};
    const pause = loadPlayerEvent('pause', context);
    player.pause = () => { player.paused = true; pause(); };

    const segment = { type: 'ending', autoNextEpisode: true, start: 100, end: 120 };
    const skip = loadSkipFunction(name, {
      artPlayerRef: context.artPlayerRef, onNextEpisode,
      currentSkipSegment: segment, episodeSwitchCooldownRef: { current: 0 },
      skipTimeoutRef: { current: null }, lastSkipTimeRef: { current: 0 },
      setCurrentSkipSegment() {}, setShowSkipButton() {},
      clearTimeout, console: quietConsole,
    });
    skip(segment);
    await flushMicrotasks();

    assert.equal(fixture.writes.length, 0, `${name} must not record its own pause as user progress`);
    assert.deepEqual(episodes.selections, [1]);
  }
});

test('a buffering canplay from the outgoing media cannot consume the next episode resume request', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const player = {
    currentTime: 110, duration: 900, volume: 0.7, playbackRate: 1.5,
    isDestroy: false, notice: {}, _episodeSwitchTicket: null,
  };
  const context = createCanplayContext(player);
  context.episodeSwitchRef.current = { index: 1 };
  context.autoPlayNextEpisodeRef.current = true;
  loadPlayerEvent('video:canplay', context)();

  assert.equal(player.currentTime, 110, 'the outgoing video must not seek to the next episode timestamp');
  assert.equal(context.resumeTimeRef.current, 42);
  assert.equal(context.isEpisodeChangingRef.current, true);
  assert.equal(context.autoPlayNextEpisodeRef.current, true);
});

test('a source change without an episode ticket still ignores canplay from the previous playback identity', () => {
  const player = {
    currentTime: 110, duration: 900, volume: 0.7, playbackRate: 1.5,
    isDestroy: false, notice: {}, _playbackKey: JSON.stringify(['previous-source', 'video', 0]),
  };
  const context = {
    ...createCanplayContext(player),
    currentSourceRef: { current: 'new-source' }, currentIdRef: { current: 'video' },
    currentEpisodeIndexRef: { current: 0 }, isSourceChangingRef: { current: true },
  };
  loadPlayerEvent('video:canplay', context)();

  assert.equal(context.episodeSwitchRef.current, null);
  assert.equal(player.currentTime, 110);
  assert.equal(context.resumeTimeRef.current, 42);
  assert.equal(context.isSourceChangingRef.current, true);
  assert.equal(player._canPlayUrl, undefined);
});

function createAutoplayFixture(overrides = {}) {
  let scheduledTimers = 0;
  let documentListeners = 0;
  const player = {
    currentTime: 0, duration: 120, volume: 0.65, playbackRate: 1.5,
    paused: true, isDestroy: false, notice: {},
    ...overrides,
  };
  const context = {
    ...createCanplayContext(player), isIOS: true,
    resumeTimeRef: { current: null }, lastVolumeRef: { current: 0.65 },
    setTimeout() { scheduledTimers++; },
    document: { addEventListener() { documentListeners++; } },
  };
  return {
    player, context, canplay: loadPlayerEvent('video:canplay', context),
    get scheduledTimers() { return scheduledTimers; },
    get documentListeners() { return documentListeners; },
  };
}

test('source preparation cannot be unlocked by old canplay before source refs update', () => {
  const player = {
    currentTime: 110, duration: 900, volume: 0.7, playbackRate: 1.5,
    isDestroy: false, notice: {}, _sourceChangePending: true,
    _playbackKey: JSON.stringify(['fixture', 'video', 0]),
  };
  const context = {
    ...createCanplayContext(player),
    currentSourceRef: { current: 'fixture' }, currentIdRef: { current: 'video' },
    currentEpisodeIndexRef: { current: 0 }, isSourceChangingRef: { current: true },
  };
  loadPlayerEvent('video:canplay', context)();
  assert.equal(context.isSourceChangingRef.current, true);
  assert.equal(context.resumeTimeRef.current, 42);
  assert.equal(player.currentTime, 110);
});

test('blocked Safari autoplay gets one attempt without timers, document listeners, or volume reduction', async () => {
  let attempts = 0;
  const fixture = createAutoplayFixture({
    play() {
      attempts++;
      return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    },
  });
  fixture.canplay();
  await flushMicrotasks();
  assert.equal(attempts, 1);
  assert.equal(fixture.player.notice.show, '轻触播放按钮开始观看');
  assert.equal(fixture.player.volume, 0.65);

  fixture.player.currentTime = 45;
  fixture.canplay();
  await flushMicrotasks();
  assert.equal(attempts, 1, 'seeking while paused must not restart autoplay');
  assert.equal(fixture.scheduledTimers, 0);
  assert.equal(fixture.documentListeners, 0);
});

test('a source that was already playing cannot auto-resume after the user pauses and seeks', async () => {
  let attempts = 0;
  const fixture = createAutoplayFixture({
    paused: false,
    play() { attempts++; return Promise.resolve(); },
  });
  fixture.context.isIOS = false;
  fixture.context.isSafari = true;
  fixture.canplay();
  fixture.player.paused = true;
  fixture.player.currentTime = 30;
  fixture.canplay();
  await flushMicrotasks();

  assert.equal(attempts, 0);
  assert.equal(fixture.player.paused, true);
  assert.equal(fixture.scheduledTimers, 0);
});

test('a late autoplay rejection cannot change another player or playback address', async () => {
  for (const change of ['player', 'url']) {
    const pending = deferred();
    const fixture = createAutoplayFixture({ play: () => pending.promise });
    fixture.canplay();
    let activePlayer = fixture.player;
    if (change === 'player') {
      activePlayer = { ...fixture.player, notice: { show: 'Current player notice' } };
      fixture.context.artPlayerRef.current = activePlayer;
    } else {
      fixture.context.activePlaybackUrlRef.current = 'https://fixture.test/second.m3u8';
      activePlayer.notice.show = 'Current player notice';
    }
    pending.reject(new Error('outgoing autoplay was interrupted'));
    await flushMicrotasks();

    assert.equal(activePlayer.notice.show, 'Current player notice', change);
    assert.equal(activePlayer.volume, 0.65, change);
  }
});

test('an explicit replay of the same URL gets one new autoplay attempt and ignores the previous rejection', async () => {
  const attempts = [];
  const fixture = createAutoplayFixture({
    play() { const pending = deferred(); attempts.push(pending); return pending.promise; },
  });
  fixture.canplay();
  const ticket = { index: 1 };
  fixture.context.episodeSwitchRef.current = ticket;
  fixture.player._episodeSwitchTicket = ticket;
  fixture.player._canPlayUrl = null;
  fixture.canplay();
  assert.equal(attempts.length, 2);
  fixture.player.notice.show = 'Replay is loading';

  attempts[0].reject(new Error('old attempt failed'));
  await flushMicrotasks();
  assert.equal(fixture.player.notice.show, 'Replay is loading');
  attempts[1].reject(new Error('replay requires a click'));
  await flushMicrotasks();
  assert.equal(fixture.player.notice.show, '轻触播放按钮开始观看');
  fixture.canplay();
  assert.equal(attempts.length, 2);
});

function createVideoUrlFixture(overrides = {}) {
  const urls = [];
  const finished = [];
  const errors = [];
  let revision = 0;
  const context = {
    videoUrl: 'https://fixture.test/shared.m3u8',
    setVideoUrl: url => urls.push(url),
    setPlaybackRevision: update => { revision = update(revision); },
    isEpisodeChangingRef: { current: true }, isSourceChangingRef: { current: false },
    setIsVideoLoading() {}, setError: message => errors.push(message),
    finishEpisodeSwitch: ticket => finished.push(ticket),
    currentAudioTrackRef: { current: -1 }, applyVideoPlayProxy: url => url,
    console: quietConsole,
    ...overrides,
  };
  return {
    context, urls, finished, errors, update: loadFunction('updateVideoUrl', context),
    get revision() { return revision; },
  };
}

test('selecting another episode with the same URL requests a replay without releasing its ticket', async () => {
  const fixture = createVideoUrlFixture();
  const detail = { source: 'fixture', episodes: [fixture.context.videoUrl, fixture.context.videoUrl] };
  const ticket = { index: 1 };
  await fixture.update(detail, 1, new AbortController().signal, ticket);

  assert.equal(fixture.revision, 1);
  assert.deepEqual(fixture.urls, []);
  assert.deepEqual(fixture.finished, []);
  assert.deepEqual(fixture.errors, []);
  assert.equal(fixture.context.isEpisodeChangingRef.current, true);

  await fixture.update(detail, 1, new AbortController().signal, null);
  assert.equal(fixture.revision, 1, 'a metadata refresh does not replay the current episode');
  assert.equal(fixture.context.isEpisodeChangingRef.current, false);
});

test('an aborted shortdrama response cannot replace the newly selected episode or report its stale error', async () => {
  for (const responseOk of [true, false]) {
    const oldBody = deferred();
    let requestedSignal;
    const fixture = createVideoUrlFixture({
      fetch: async (_url, options) => {
        requestedSignal = options.signal;
        return { ok: responseOk, json: () => oldBody.promise };
      },
    });
    const controller = new AbortController();
    const oldTicket = { index: 0 };
    const oldRequest = fixture.update(
      { source: 'shortdrama', episodes: ['shortdrama:fixture:1'] },
      0, controller.signal, oldTicket,
    );
    await flushMicrotasks();
    assert.equal(requestedSignal, controller.signal);
    controller.abort();

    const nextUrl = 'https://fixture.test/new-selection.m3u8';
    await fixture.update(
      { source: 'fixture', episodes: [nextUrl] },
      0, new AbortController().signal, { index: 0 },
    );
    oldBody.resolve(responseOk ? { url: 'https://fixture.test/outgoing.m3u8' } : { error: 'outdated error' });
    await oldRequest;

    assert.deepEqual(fixture.urls, [nextUrl]);
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.finished, []);
  }
});

test('desktop natural completion plays the next episode once and respects a later pause and seek', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = createEpisodeFixture(t);
  const { context, player } = fixture;
  for (const [name, value] of Object.entries(createCanplayContext(player))) {
    if (!(name in context)) context[name] = value;
  }
  let playCalls = 0;
  player.play = () => { playCalls++; player.paused = false; return Promise.resolve(); };
  player.volume = 0.7;
  player.playbackRate = 1.5;
  player.notice = {};
  loadPlayerEvent('video:ended', context)();
  await flushMicrotasks();
  assert.deepEqual(fixture.selections, [1]);
  assert.equal(context.autoPlayNextEpisodeRef.current, true);

  // The real switch branch accepts the ticket before the new media emits canplay.
  player._episodeSwitchTicket = context.episodeSwitchRef.current;
  player._canPlayUrl = null;
  player.video.ended = false;
  player.currentTime = 0;
  context.activePlaybackUrlRef.current = 'https://fixture.test/second.m3u8';
  const canplay = loadPlayerEvent('video:canplay', context);
  canplay();
  await flushMicrotasks();
  assert.equal(context.isIOS, false);
  assert.equal(context.isSafari, false);
  assert.equal(playCalls, 1);
  assert.equal(player.paused, false);
  assert.equal(context.autoPlayNextEpisodeRef.current, false);

  fixture.control.finishEpisodeSwitch(context.episodeSwitchRef.current);
  player.paused = true;
  player.currentTime = 60;
  canplay();
  await flushMicrotasks();
  assert.equal(playCalls, 1, 'a user pause and seek must not replay the automatic-next intent');
  assert.equal(player.paused, true);
});
