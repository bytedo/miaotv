const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require(process.env.MIAOTV_TYPESCRIPT_PATH || 'typescript');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const {
  createHookHost,
  installBrowser,
} = require('./playback-test-helpers.cjs');

const pageFile = path.resolve(__dirname, '../../app/play/page.tsx');
const page = ts.createSourceFile(
  pageFile,
  fs.readFileSync(pageFile, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const pluginFile = path.resolve(
  require.resolve('artplayer-plugin-danmuku'),
  '../artplayer-plugin-danmuku.mjs',
);
const pluginSource = ts.createSourceFile(
  pluginFile,
  fs.readFileSync(pluginFile, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);

function findNode(source, predicate, label) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1, `expected one actual ${label}`);
  return matches[0];
}

function evaluate(node, source, context) {
  const script = ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(script, context, {
    filename: source === page ? 'actual-danmu-page-callback.js' : pluginFile,
  });
}

function loadPlayerEvent(name, context) {
  const registration = findNode(
    page,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'on' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === name,
    `${name} listener`,
  );
  return evaluate(registration.arguments[1], page, context);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const comments = [{ text: '设置面板弹幕', time: 1, mode: 0 }];

function createFixture(t) {
  const storage = installBrowser(t);
  storage.set('enable_external_danmu', 'true');
  storage.set('danmaku_visible', 'true');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const requests = [];
  t.mock.method(
    global,
    'fetch',
    (url, init) =>
      new Promise((resolve) => requests.push({ url, init, resolve })),
  );
  const events = new Map();
  const player = {
    _playbackKey: 'fixture:1',
    template: { $controlsCenter: {} },
    notice: {},
    plugins: {},
    emit(name, ...args) {
      events.get(name)?.(...args);
    },
  };
  // Use the installed plugin's actual config/show/hide/reset methods. Only its
  // DOM, validation and data-loading dependencies are replaced by small fakes.
  const declaration = findNode(
    pluginSource,
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'Danmuku',
    'installed Danmuku class',
  );
  const Danmuku = evaluate(declaration, pluginSource, {});
  const plugin = Object.assign(Object.create(Danmuku.prototype), {
    art: player,
    utils: { clamp: (value, min, max) => Math.min(max, Math.max(min, value)) },
    validator() {},
    $danmuku: { style: {} },
    option: Danmuku.option,
    queue: [],
    comments: [],
    isHide: false,
    async load(data) {
      if (data) this.comments.push(...data);
      else this.comments = [];
    },
  });
  player.plugins.artplayerPluginDanmuku = plugin;
  const host = createHookHost();
  t.after(() => host.unmount());
  const { useDanmu } = createSourceLoader({
    react: host.React,
    '@/lib/client-cache': {
      ClientCache: { get: async () => null, set: async () => {} },
    },
  })('../hooks/useDanmu.ts');
  const options = {
    videoTitle: '显隐测试',
    videoYear: '2026',
    videoDoubanId: 42,
    currentEpisodeIndex: 0,
    currentSource: 'fixture',
    artPlayerRef: { current: player },
  };
  const render = () => host.render(() => useDanmu(options));
  const hook = render();
  const context = {
    artPlayerRef: options.artPlayerRef,
    localStorage: global.localStorage,
    console: { log() {}, warn() {}, error() {} },
    handleDanmuOperationOptimized: hook.handleDanmuOperationOptimized,
    externalDanmuEnabledRef: hook.externalDanmuEnabledRef,
    isDraggingProgressRef: { current: false },
    setDanmuSettingsVersion() {},
  };
  for (const name of ['show', 'hide', 'config']) {
    const event = `artplayerPluginDanmuku:${name}`;
    events.set(event, loadPlayerEvent(event, context));
  }
  const panel = findNode(
    page,
    (node) =>
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(page) === 'DanmuSettingsPanel',
    'DanmuSettingsPanel',
  );
  const change = panel.attributes.properties.find(
    (node) => ts.isJsxAttribute(node) && node.name.text === 'onSettingsChange',
  );
  const onSettingsChange = evaluate(
    change.initializer.expression,
    page,
    context,
  );
  return {
    storage,
    requests,
    plugin,
    hook,
    render,
    onSettingsChange,
    async finishLoad() {
      await flush();
      assert.equal(requests.length, 1);
      requests[0].resolve(Response.json({ danmu: comments }));
      await flush();
      assert.equal(plugin.comments.length, comments.length);
    },
  };
}

test('re-enabling from the settings panel preserves show intent until comments arrive', async (t) => {
  const h = createFixture(t);
  h.onSettingsChange({ enabled: false });
  assert.equal(h.plugin.option.visible, false);
  assert.equal(h.storage.get('danmaku_visible'), 'false');

  h.onSettingsChange({ enabled: true });
  assert.equal(h.storage.get('danmaku_visible'), 'true');
  await h.finishLoad();
  assert.equal(h.render().externalDanmuEnabled, true);
  assert.equal(h.plugin.isHide, false);
  assert.equal(h.plugin.option.visible, true);
});

test('changing font size during an enable request preserves the latest show intent', async (t) => {
  const h = createFixture(t);
  h.onSettingsChange({ enabled: false });
  // The player's own enable control does not call the panel config callback.
  h.hook.handleDanmuOperationOptimized(true);
  assert.equal(h.storage.get('danmaku_visible'), 'true');
  assert.equal(h.plugin.option.visible, false, 'the old layer is still hidden');

  h.onSettingsChange({ fontSize: 30 });
  assert.equal(h.storage.get('danmaku_visible'), 'true');
  assert.equal(h.plugin.option.fontSize, 30);
  await h.finishLoad();
  assert.equal(h.plugin.isHide, false);
  assert.equal(h.plugin.option.visible, true);
});

test('explicitly hiding while loading survives later style changes and the response', async (t) => {
  const h = createFixture(t);
  h.onSettingsChange({ enabled: false });
  h.hook.handleDanmuOperationOptimized(true);
  h.onSettingsChange({ visible: false });
  h.onSettingsChange({ fontSize: 30 });
  assert.equal(h.storage.get('danmaku_visible'), 'false');
  await h.finishLoad();
  assert.equal(h.render().externalDanmuEnabled, true);
  assert.equal(h.plugin.isHide, true);
  assert.equal(h.plugin.option.visible, false);
});

function createPlayer(visible) {
  const file = path.resolve(__dirname, '../../app/play/page.tsx');
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const selectedEvents = new Set([
    'artplayerPluginDanmuku:show',
    'artplayerPluginDanmuku:hide',
    'artplayerPluginDanmuku:config',
    'video:seeking',
    'video:seeked',
  ]);
  const registrations = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'on' &&
      ts.isStringLiteral(node.arguments[0]) &&
      selectedEvents.has(node.arguments[0].text)
    )
      registrations.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(
    registrations.length,
    selectedEvents.size,
    'exercise the actual player visibility handlers',
  );

  const handlers = new Map();
  const values = new Map([['danmaku_visible', String(visible)]]);
  const timers = [];
  const enabled = { current: true };
  const dragging = { current: false };
  const emit = (event, data) => handlers.get(event)?.(data);
  const plugin = {
    isHide: !visible,
    resets: 0,
    show() {
      this.isHide = false;
      emit('artplayerPluginDanmuku:show');
    },
    hide() {
      this.isHide = true;
      emit('artplayerPluginDanmuku:hide');
    },
    reset() {
      this.resets++;
    },
  };
  const player = {
    on: (event, callback) => handlers.set(event, callback),
    plugins: { artplayerPluginDanmuku: plugin },
  };
  const script = ts.transpileModule(registrations.join(';\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(script, {
    artPlayerRef: { current: player },
    externalDanmuEnabledRef: enabled,
    isDraggingProgressRef: dragging,
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    setTimeout: (callback) => timers.push(callback),
    console: { log() {}, error() {} },
  });
  return { plugin, values, emit, timers, enabled, dragging };
}

test('seeking preserves a user preference to keep danmu hidden', () => {
  const player = createPlayer(false);
  player.emit('video:seeking');
  player.emit('video:seeked');

  assert.equal(player.plugin.isHide, true);
  assert.equal(player.values.get('danmaku_visible'), 'false');
  assert.equal(player.dragging.current, false);
});

test('temporary seek hiding and configuration events do not overwrite visible preference', () => {
  const player = createPlayer(true);
  player.emit('video:seeking');
  assert.equal(player.plugin.isHide, true);
  assert.equal(
    player.values.get('danmaku_visible'),
    'true',
    'leaving the page during a seek must preserve the preference',
  );

  player.emit('artplayerPluginDanmuku:config', {
    visible: false,
    opacity: 0.5,
  });
  assert.equal(player.values.get('danmaku_visible'), 'true');
  assert.equal(player.values.get('danmaku_opacity'), '0.5');

  player.emit('video:seeked');
  assert.equal(player.plugin.isHide, false);
  assert.equal(player.values.get('danmaku_visible'), 'true');
  player.timers.forEach((callback) => callback());
  assert.equal(player.plugin.resets, 1);
});

test('finishing a seek after disabling danmu keeps it hidden without overwriting visibility preference', () => {
  const player = createPlayer(true);
  player.emit('video:seeking');
  player.enabled.current = false;
  player.emit('video:seeked');

  assert.equal(player.plugin.isHide, true);
  assert.equal(player.values.get('danmaku_visible'), 'true');
  assert.equal(player.dragging.current, false);
});

test('explicit show and hide actions outside a seek still save the preference', () => {
  const player = createPlayer(true);
  player.plugin.hide();
  assert.equal(player.values.get('danmaku_visible'), 'false');
  player.plugin.show();
  assert.equal(player.values.get('danmaku_visible'), 'true');
});
