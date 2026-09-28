const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { renderToStaticMarkup } = require('react-dom/server');
const { createComponentLoader } = require('./component-test-loader.cjs');
const { createHookHost } = require('./playback-test-helpers.cjs');
const { createSourceLoader } = require('./storage-test-loader.cjs');

function findNodes(node, predicate, result = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => findNodes(child, predicate, result));
  } else if (node && typeof node === 'object') {
    if (predicate(node)) result.push(node);
    findNodes(node.props?.children, predicate, result);
  }
  return result;
}

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (node && typeof node === 'object')
    return textContent(node.props?.children);
  return typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : '';
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

function gestureFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = createHookHost();
  t.after(() => host.unmount());
  const calls = { click: 0, longPress: 0 };
  const { useLongPress } = createSourceLoader({ react: host.React })(
    '../hooks/useLongPress.ts',
  );
  const handlers = host.render(() =>
    useLongPress({
      onClick: () => {
        calls.click++;
      },
      onLongPress: () => {
        calls.longPress++;
      },
    }),
  );
  const event = (target, points = [{ clientX: 40, clientY: 40 }]) => ({
    target,
    currentTarget: {},
    touches: points,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  });
  return { host, handlers, calls, event };
}

for (const selector of [
  'button',
  '[role="button"]',
  '[data-button]',
  'a[href]',
]) {
  test(`a touch on an SVG inside ${selector} preserves its native control click`, (t) => {
    const { handlers, calls, event } = gestureFixture(t);
    const control = {};
    const iconPath = {
      closest: (selectors) =>
        selectors
          .split(',')
          .map((value) => value.trim())
          .includes(selector)
          ? control
          : null,
      hasAttribute: () => false,
    };
    const start = event(iconPath);
    handlers.onTouchStart(start);
    t.mock.timers.tick(600);
    const end = event(iconPath, []);
    handlers.onTouchEnd(end);
    let controlClicks = 0;
    if (!end.defaultPrevented) controlClicks++;
    assert.equal(controlClicks, 1);
    assert.equal(end.stopped, false);
    assert.deepEqual(calls, { click: 0, longPress: 0 });
  });
}

test('card taps still activate once, while a long press opens actions without a click', (t) => {
  const { handlers, calls, event } = gestureFixture(t);
  const card = { closest: () => null };
  handlers.onTouchStart(event(card));
  const tap = event(card, []);
  handlers.onTouchEnd(tap);
  assert.equal(
    tap.defaultPrevented,
    true,
    'the synthetic click must not duplicate the card action',
  );
  assert.deepEqual(calls, { click: 1, longPress: 0 });
  handlers.onTouchStart(event(card));
  t.mock.timers.tick(500);
  handlers.onTouchEnd(event(card, []));
  assert.deepEqual(calls, { click: 1, longPress: 1 });
});

test('scrolling, touch cancellation and unmount cancel pending card long presses', (t) => {
  const { host, handlers, calls, event } = gestureFixture(t);
  const card = { closest: () => null };
  handlers.onTouchStart(event(card));
  handlers.onTouchMove(event(card, [{ clientX: 40, clientY: 80 }]));
  t.mock.timers.tick(500);
  handlers.onTouchEnd(event(card, []));
  handlers.onTouchStart(event(card));
  handlers.onTouchCancel();
  t.mock.timers.tick(500);
  handlers.onTouchStart(event(card));
  host.unmount();
  t.mock.timers.tick(500);
  assert.deepEqual(calls, { click: 0, longPress: 0 });
});

function swipeFixture(t) {
  const host = createHookHost();
  t.after(() => host.unmount());
  const calls = { left: 0, right: 0 };
  const { useSwipeGesture } = createSourceLoader({ react: host.React })(
    '../components/hooks/useSwipeGesture.ts',
  );
  const render = () =>
    host.render(() =>
      useSwipeGesture({
        onSwipeLeft: () => {
          calls.left++;
        },
        onSwipeRight: () => {
          calls.right++;
        },
      }),
    );
  const target = { closest: () => null };
  const event = (x, y, extra = {}) => {
    const points = [{ identifier: 1, clientX: x, clientY: y }];
    return {
      target,
      currentTarget: target,
      touches: points,
      targetTouches: points,
      changedTouches: points,
      preventDefault() {
        throw new Error('A swipe must preserve native scrolling');
      },
      ...extra,
    };
  };
  return { render, calls, event };
}

test('banner swipes work from the screen edge without waiting for a render', (t) => {
  const { render, calls, event } = swipeFixture(t);
  const handlers = render();
  handlers.onTouchStart(event(0, 40));
  handlers.onTouchMove(event(90, 45));
  handlers.onTouchEnd(event(90, 45, { touches: [], targetTouches: [] }));
  handlers.onTouchStart(event(90, 40));
  handlers.onTouchMove(event(0, 45));
  handlers.onTouchEnd(event(0, 45, { touches: [], targetTouches: [] }));
  assert.deepEqual(calls, { left: 1, right: 1 });
});

test('vertical banner scrolls with sideways drift do not switch slides', (t) => {
  const { render, calls, event } = swipeFixture(t);
  render().onTouchStart(event(200, 40));
  render().onTouchMove(event(130, 160));
  render().onTouchEnd(event(130, 160, { touches: [], targetTouches: [] }));
  assert.deepEqual(calls, { left: 0, right: 0 });
});

test('banner swipes ignore nested controls and reset after cancellation or multiple touches', (t) => {
  const { render, calls, event } = swipeFixture(t);
  const control = {};
  const icon = { closest: () => control };
  let handlers = render();
  handlers.onTouchStart(event(200, 40, { target: icon }));
  handlers = render();
  handlers.onTouchMove(event(100, 42));
  render().onTouchEnd(event(100, 42, { touches: [], targetTouches: [] }));
  assert.deepEqual(calls, { left: 0, right: 0 });

  handlers = render();
  handlers.onTouchStart(event(200, 40));
  handlers.onTouchMove(event(100, 42));
  handlers.onTouchCancel();
  handlers.onTouchEnd(event(100, 42, { touches: [], targetTouches: [] }));
  handlers.onTouchStart(event(200, 40));
  handlers.onTouchMove(
    event(100, 42, {
      touches: [
        { identifier: 1, clientX: 100, clientY: 42 },
        { identifier: 2, clientX: 150, clientY: 50 },
      ],
    }),
  );
  handlers.onTouchEnd(event(100, 42, { touches: [], targetTouches: [] }));
  assert.deepEqual(calls, { left: 0, right: 0 });
});

function sheetFixture(t, requests = {}) {
  const hosts = [];
  const previous = {
    window: global.window,
    document: global.document,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };
  const portals = new Set();
  const listeners = new Map();
  const frames = new Map();
  let frameId = 0;
  const makeFocusable = () => ({
    isConnected: true,
    focus() {
      global.document.activeElement = this;
    },
  });
  const trigger = makeFocusable();
  const close = makeFocusable();
  const lastAction = makeFocusable();
  const sheet = {
    ...makeFocusable(),
    querySelectorAll: () => [close, lastAction],
    contains: (element) =>
      element === sheet || element === close || element === lastAction,
  };
  const body = {
    style: {},
    appendChild(element) {
      portals.add(element);
    },
    removeChild(element) {
      portals.delete(element);
    },
  };
  global.window = { scrollX: 0, scrollY: 240, innerWidth: 1000, scrollTo() {} };
  global.document = {
    body,
    documentElement: { clientWidth: 980 },
    activeElement: trigger,
    createElement: () => ({ style: {}, setAttribute() {} }),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  global.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  global.cancelAnimationFrame = (id) => frames.delete(id);
  t.after(() => {
    hosts.forEach((host) => host.unmount());
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete global[name];
      else global[name] = value;
    }
  });
  const create = () => {
    const host = createHookHost();
    hosts.push(host);
    const Sheet = createComponentLoader({
      react: host.React,
      'react-dom': {
        createPortal: (content) => {
          findNodes(content, (node) => node.props?.role === 'dialog').forEach(
            (node) => {
              node.props.ref.current = sheet;
            },
          );
          return content;
        },
      },
      'next/image': () => null,
      '@/lib/douban.client': {
        fetchDoubanQuickInfo: requests.quickInfo || (async () => null),
        fetchDoubanSuggest: requests.suggest || (async () => []),
      },
      '@/lib/bangumi.client': {
        fetchBangumiSubject: requests.bangumi || (async () => null),
      },
    })('components/MobileActionSheet.tsx').default;
    let props = { isOpen: false, title: 'Card', actions: [], onClose() {} };
    return {
      render(next = {}) {
        props = { ...props, ...next };
        let result;
        // Flush state changes from effects and assign refs before the next effects run.
        for (let index = 0; index < 4; index++)
          result = host.render(() => Sheet(props));
        return result;
      },
    };
  };
  return {
    create,
    portals,
    frames,
    body,
    trigger,
    close,
    lastAction,
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    },
    key(event) {
      listeners.get('keydown')?.forEach((listener) => listener(event));
    },
  };
}

test('one hundred unopened card action sheets create no portals, timers or animation frames', (t) => {
  const fixture = sheetFixture(t);
  const timers = t.mock.method(global, 'setTimeout', () => {
    throw new Error('An unopened sheet scheduled a timeout');
  });
  for (let index = 0; index < 100; index++)
    assert.equal(fixture.create().render(), null);
  assert.equal(fixture.portals.size, 0);
  assert.equal(fixture.frames.size, 0);
  assert.equal(timers.mock.callCount(), 0);
});

test('action sheets keep close animations interruptible and manage focus for the visible dialog', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = sheetFixture(t);
  const panel = fixture.create();
  let closes = 0;
  panel.render({
    isOpen: true,
    onClose: () => {
      closes++;
    },
  });
  fixture.frame();
  fixture.frame();
  assert.equal(fixture.portals.size, 1);
  assert.equal(global.document.activeElement, fixture.close);
  assert.equal(fixture.body.style.position, 'fixed');
  const tab = {
    key: 'Tab',
    shiftKey: true,
    preventDefault() {
      this.prevented = true;
    },
  };
  fixture.key(tab);
  assert.equal(tab.prevented, true);
  assert.equal(global.document.activeElement, fixture.lastAction);
  fixture.key({ key: 'Tab', preventDefault() {} });
  assert.equal(global.document.activeElement, fixture.close);
  fixture.key({ key: 'Escape' });
  assert.equal(closes, 1);

  panel.render({ isOpen: false });
  t.mock.timers.tick(100);
  panel.render({ isOpen: true });
  t.mock.timers.tick(200);
  assert.ok(panel.render(), 'reopening must cancel the pending close');
  assert.equal(fixture.portals.size, 1);

  panel.render({ isOpen: false });
  t.mock.timers.tick(199);
  assert.ok(
    panel.render(),
    'the portal stays mounted during its close animation',
  );
  t.mock.timers.tick(1);
  assert.equal(panel.render(), null);
  assert.equal(fixture.portals.size, 0);
  assert.equal(global.document.activeElement, fixture.trigger);
  assert.notEqual(fixture.body.style.position, 'fixed');
});

test('retry actions keep the sheet open to show progress while ordinary actions close it', (t) => {
  const fixture = sheetFixture(t);
  const panel = fixture.create();
  let retries = 0;
  let closes = 0;
  const content = panel.render({
    isOpen: true,
    onClose: () => {
      closes++;
    },
    actions: [
      {
        id: 'retry',
        label: '重试加载收藏状态',
        closeOnClick: false,
        onClick: () => {
          retries++;
        },
      },
      { id: 'play', label: '播放', onClick() {} },
    ],
  });
  const buttons = findNodes(content, (node) => node.type === 'button');
  buttons
    .find((button) => textContent(button) === '重试加载收藏状态')
    .props.onClick();
  assert.equal(retries, 1);
  assert.equal(closes, 0);
  buttons.find((button) => textContent(button) === '播放').props.onClick();
  assert.equal(closes, 1);
});

test('a closing action sheet keeps its overlay while rejecting further actions', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = sheetFixture(t);
  const panel = fixture.create();
  let actions = 0;
  panel.render({
    isOpen: true,
    actions: [
      {
        id: 'play',
        label: '播放',
        onClick: () => {
          actions++;
        },
      },
    ],
  });
  fixture.frame();
  fixture.frame();
  const closing = panel.render({ isOpen: false });
  assert.equal(fixture.portals.size, 1);
  const play = findNodes(closing, (node) => node.type === 'button').find(
    (node) => textContent(node) === '播放',
  );
  play.props.onClick();
  assert.equal(actions, 0, 'a dismissed menu must not perform a second action');
  assert.equal(play.props.disabled, true);
  t.mock.timers.tick(200);
  assert.equal(panel.render(), null);
});

test('late action-sheet metadata cannot replace details for a newly selected item', async (t) => {
  const old = deferred();
  const current = deferred();
  const fixture = sheetFixture(t, {
    quickInfo: (id) => (id === '1' ? old.promise : current.promise),
  });
  const panel = fixture.create();
  panel.render({ isOpen: true, doubanId: 1 });
  panel.render({ doubanId: 2 });
  current.resolve({ code: 200, data: { plot_summary: 'Current description' } });
  await flushPromises();
  assert.match(textContent(panel.render()), /Current description/);
  old.resolve({ code: 200, data: { plot_summary: 'Outdated description' } });
  await flushPromises();
  const content = textContent(panel.render());
  assert.match(content, /Current description/);
  assert.doesNotMatch(content, /Outdated description/);
});

function bannerFixture(t, options = {}) {
  const host = createHookHost();
  const previousWindow = global.window;
  const previousStorage = global.localStorage;
  global.window = { Image: class {} };
  global.localStorage = { getItem: () => null, setItem() {} };
  t.mock.method(global, 'fetch', async () => Response.json({}));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.after(() => {
    host.unmount();
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousStorage === undefined) delete global.localStorage;
    else global.localStorage = previousStorage;
  });
  const cache = {};
  const refresh = options.refresh || (async () => null);
  const Banner = createComponentLoader({
    react: { ...host.React, memo: (component) => component },
    'next/image': () => null,
    'next/link': 'a',
    '@/hooks/useHeroBannerQueries': {
      useRefreshedTrailerUrlsQuery: () => ({ data: cache }),
      useRefreshTrailerUrlMutation: () => ({ mutateAsync: refresh }),
      useClearTrailerUrlMutation: () => ({ mutate() {} }),
    },
    './hooks/useAutoplay': options.autoplay
      ? createSourceLoader({ react: host.React })(
          '../components/hooks/useAutoplay.ts',
        )
      : { useAutoplay() {} },
    './hooks/useSwipeGesture': { useSwipeGesture: () => ({}) },
  })('components/HeroBanner.tsx').default;
  let props = {
    items: ['A', 'B', 'C'].map((title, index) => ({
      id: title,
      title,
      douban_id: index + 1,
      poster: `/${title}.jpg`,
      trailerUrl: `/${title}.mp4`,
    })),
    enableVideo: false,
  };
  let node;
  let lastKey;
  let lastVideo;
  let lastRef;
  const assignRef = (ref, element) => {
    if (typeof ref === 'function') ref(element);
    else if (ref) ref.current = element;
  };
  const render = (next = {}) => {
    props = { ...props, ...next };
    node = host.render(() => {
      const result = Banner(props);
      const video = findNodes(result, (item) => item.type === 'video')[0];
      if (video) {
        const remounted = video.key !== lastKey;
        if (remounted || video.props.ref !== lastRef) assignRef(lastRef, null);
        if (remounted) {
          lastVideo = {
            error: { code: 2 },
            plays: 0,
            loads: 0,
            play() {
              this.plays++;
              return Promise.resolve();
            },
            load() {
              this.loads++;
            },
          };
        }
        if (remounted || video.props.ref !== lastRef)
          assignRef(video.props.ref, lastVideo);
        lastKey = video.key;
        lastRef = video.props.ref;
      } else if (lastRef) {
        assignRef(lastRef, null);
        lastRef = null;
        lastKey = null;
      }
      return result;
    });
    return node;
  };
  return {
    cache,
    render,
    button: (label) =>
      findNodes(
        node,
        (item) => item.type === 'button' && item.props['aria-label'] === label,
      )[0],
    video: () => ({
      element: lastVideo,
      node: findNodes(node, (item) => item.type === 'video')[0],
    }),
    title: () => textContent(findNodes(node, (item) => item.type === 'h1')[0]),
  };
}

test('banner controls accept consecutive clicks and the latest indicator before a render', (t) => {
  const banner = bannerFixture(t);
  const timers = t.mock.method(global, 'setTimeout', () => {
    throw new Error('Navigation scheduled a lockout');
  });
  banner.render();
  const next = banner.button('下一张').props.onClick;
  next();
  next();
  banner.render();
  assert.equal(banner.title(), 'C');
  banner.button('上一张').props.onClick();
  banner.render();
  assert.equal(banner.title(), 'B');
  banner.button('跳转到第 3 张').props.onClick();
  banner.button('跳转到第 2 张').props.onClick();
  banner.render();
  assert.equal(banner.title(), 'B');
  assert.equal(timers.mock.callCount(), 0);
});

test('banner autoplay restarts after manual navigation and pauses while hovered', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const banner = bannerFixture(t, { autoplay: true });
  let content = banner.render({ autoPlayInterval: 8000 });
  t.mock.timers.tick(8000);
  banner.render();
  assert.equal(banner.title(), 'B');
  t.mock.timers.tick(3000);
  banner.button('下一张').props.onClick();
  content = banner.render();
  t.mock.timers.tick(7999);
  banner.render();
  assert.equal(banner.title(), 'C');
  content.props.onMouseEnter();
  banner.render();
  t.mock.timers.tick(16000);
  content = banner.render();
  assert.equal(banner.title(), 'C');
  content.props.onMouseLeave();
  banner.render();
  t.mock.timers.tick(8000);
  banner.render();
  assert.equal(banner.title(), 'A');
});

test('consecutive banner navigation ending on the same item preserves its loaded video', (t) => {
  const banner = bannerFixture(t);
  banner.render({ enableVideo: true });
  const initial = banner.video();
  initial.node.props.onLoadedData({ currentTarget: initial.element });
  banner.render();
  const next = banner.button('下一张').props.onClick;
  next();
  next();
  next();
  banner.render();
  assert.equal(banner.video().element, initial.element);
  assert.match(banner.video().node.props.className, /opacity-100/);
  banner.button('跳转到第 2 张').props.onClick();
  banner.button('跳转到第 1 张').props.onClick();
  banner.render();
  assert.equal(banner.video().element, initial.element);
  assert.match(banner.video().node.props.className, /opacity-100/);
});

test('returning to an item waits for the replacement video to load', (t) => {
  const banner = bannerFixture(t);
  banner.render({ enableVideo: true });
  const initial = banner.video();
  initial.node.props.onLoadedData({ currentTarget: initial.element });
  banner.render();
  banner.button('下一张').props.onClick();
  banner.render();
  banner.button('上一张').props.onClick();
  banner.render();
  banner.render();
  assert.notEqual(banner.video().element, initial.element);
  assert.match(banner.video().node.props.className, /opacity-0/);
  const current = banner.video();
  current.node.props.onLoadedData({ currentTarget: current.element });
  banner.render();
  banner.render({ enableVideo: false });
  banner.render({ enableVideo: true });
  banner.render();
  assert.match(banner.video().node.props.className, /opacity-0/);
});

test('late video load events cannot reveal or play a different banner item', (t) => {
  const banner = bannerFixture(t);
  banner.render({ enableVideo: true });
  const old = banner.video();
  banner.button('下一张').props.onClick();
  banner.render();
  old.node.props.onLoadedData({ currentTarget: old.element });
  banner.render();
  assert.match(banner.video().node.props.className, /opacity-0/);
  assert.equal(old.element.plays, 0);
  const current = banner.video();
  current.node.props.onLoadedData({ currentTarget: current.element });
  banner.render();
  assert.match(banner.video().node.props.className, /opacity-100/);
  assert.equal(current.element.plays, 1);
  banner.cache[2] = '/B-refreshed.mp4';
  banner.render();
  assert.notEqual(banner.video().node.key, current.node.key);
  assert.match(banner.video().node.props.className, /opacity-0/);
});

test('an old trailer refresh never reloads the current banner video', async (t) => {
  const refresh = deferred();
  const banner = bannerFixture(t, { refresh: () => refresh.promise });
  banner.render({ enableVideo: true });
  const old = banner.video();
  const loading = old.node.props.onError({ currentTarget: old.element });
  banner.button('下一张').props.onClick();
  banner.render();
  const current = banner.video();
  refresh.resolve('/A-refreshed.mp4');
  await loading;
  assert.equal(old.element.loads, 0);
  assert.equal(current.element.loads, 0);
});

test('a changed banner selection stops the previous delayed adjacent-trailer work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const ids = [];
  const banner = bannerFixture(t, {
    refresh: ({ doubanId }) => {
      ids.push(doubanId);
      return pending.promise;
    },
  });
  banner.render({ enableVideo: true });
  t.mock.timers.tick(1000);
  assert.deepEqual(ids, [1]);
  banner.button('跳转到第 3 张').props.onClick();
  banner.render();
  pending.resolve('/A.mp4');
  await flushPromises();
  assert.deepEqual(
    ids,
    [1],
    'the abandoned request must not start loading its old neighbour',
  );
});

test('home card favorite and reminder controls visibly wait for state without guessing a write', (t) => {
  const client = new QueryClient();
  t.after(() => client.clear());
  let actions;
  let pending = false;
  const writes = [];
  const empty = () => null;
  const Card = createComponentLoader({
    'next/navigation': { useRouter: () => ({ push() {}, prefetch() {} }) },
    'next/image': ({ src, alt }) => React.createElement('img', { src, alt }),
    '@/components/ImagePlaceholder': { ImagePlaceholder: empty },
    '@/components/MobileActionSheet': (props) => {
      actions = props.actions;
      return null;
    },
    '@/hooks/useLongPress': { useLongPress: () => ({}) },
    '@/hooks/useFavoritesMutations': {
      useToggleFavoriteMutation: () => ({
        isPending: pending,
        mutate: (value) => writes.push(value),
      }),
    },
    '@/hooks/useRemindersMutations': {
      useToggleReminderMutation: () => ({
        isPending: false,
        mutate: (value) => writes.push(value),
      }),
    },
    '@/hooks/usePlayRecordsMutations': {
      useDeletePlayRecordMutation: () => ({ mutate() {} }),
    },
    '@/lib/db.client': {
      getAllFavorites: async () => ({}),
      getAllReminders: async () => ({}),
    },
    '@/lib/utils': {
      processImageUrl: (value) => value,
      isSeriesCompleted: () => false,
    },
    '@/lib/imageCache': { loadedImageUrls: new Set() },
  })('components/VideoCard.tsx').default;
  const render = (from) =>
    renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Card, {
          from,
          source: 'douban',
          id: '1',
          title: 'Fixture',
          poster: '/cover.jpg',
        }),
      ),
    );
  for (const from of ['douban', 'favorite', 'reminder']) {
    const markup = render(from);
    assert.match(
      markup,
      /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*aria-label="(?:收藏|想看)状态加载中\.\.\."/,
    );
    const action = actions.find((item) => item.id === 'favorite-loading');
    assert.equal(action.disabled, true);
    action.onClick();
  }
  assert.deepEqual(writes, []);
  client.setQueryData(['favorites'], { 'douban+1': { title: 'Fixture' } });
  client.setQueryData(['reminders'], {});
  assert.match(
    render('favorite'),
    /<button[^>]*aria-busy="false"[^>]*aria-label="取消收藏"/,
  );
  actions.find((item) => item.id === 'favorite').onClick();
  assert.equal(writes[0].isFavorited, true);
  pending = true;
  assert.match(
    render('douban'),
    /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*aria-label="正在保存\.\.\."/,
  );
  assert.equal(
    actions.find((item) => item.id === 'favorite-loading').disabled,
    true,
  );
});

for (const collection of ['favorites', 'reminders']) {
  test(`a failed ${collection} status can be retried without navigation or an uninformed write`, async (t) => {
    const client = new QueryClient();
    t.after(() => client.clear());
    // Each static render creates an observer; retain the failed mounted-card
    // state instead of treating the next render as an automatic mount retry.
    client.setQueryDefaults([collection], { retryOnMount: false });
    const pending = deferred();
    let attempts = 0;
    const readCollection = async () => {
      if (++attempts === 1) throw new Error('Temporary collection outage');
      return pending.promise;
    };
    await client
      .fetchQuery({
        queryKey: [collection],
        queryFn: readCollection,
        retry: false,
      })
      .catch(() => {});
    const writes = [];
    const buttons = [];
    let actions;
    const jsxRuntime = require('react/jsx-runtime');
    const captureButton =
      (render) =>
      (type, props, ...args) => {
        if (type === 'button') buttons.push(props);
        return render(type, props, ...args);
      };
    const empty = () => null;
    const Card = createComponentLoader({
      'react/jsx-runtime': {
        ...jsxRuntime,
        jsx: captureButton(jsxRuntime.jsx),
        jsxs: captureButton(jsxRuntime.jsxs),
      },
      'next/navigation': {
        useRouter: () => ({
          push() {
            throw new Error('A retry must not navigate');
          },
          prefetch() {},
        }),
      },
      'next/image': ({ src, alt }) => React.createElement('img', { src, alt }),
      '@/components/ImagePlaceholder': { ImagePlaceholder: empty },
      '@/components/MobileActionSheet': (props) => {
        actions = props.actions;
        return null;
      },
      '@/hooks/useLongPress': { useLongPress: () => ({}) },
      '@/hooks/useFavoritesMutations': {
        useToggleFavoriteMutation: () => ({
          isPending: false,
          mutate: (value) => writes.push(value),
        }),
      },
      '@/hooks/useRemindersMutations': {
        useToggleReminderMutation: () => ({
          isPending: false,
          mutate: (value) => writes.push(value),
        }),
      },
      '@/hooks/usePlayRecordsMutations': {
        useDeletePlayRecordMutation: () => ({ mutate() {} }),
      },
      '@/lib/db.client': {
        getAllFavorites:
          collection === 'favorites' ? readCollection : async () => ({}),
        getAllReminders:
          collection === 'reminders' ? readCollection : async () => ({}),
      },
      '@/lib/utils': {
        processImageUrl: (value) => value,
        isSeriesCompleted: () => false,
      },
      '@/lib/imageCache': { loadedImageUrls: new Set() },
    })('components/VideoCard.tsx').default;
    const render = () => {
      buttons.length = 0;
      return renderToStaticMarkup(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(Card, {
            from: collection === 'favorites' ? 'douban' : 'reminder',
            source: 'douban',
            id: '1',
            title: 'Fixture',
            poster: '/cover.jpg',
          }),
        ),
      );
    };
    assert.match(render(), /aria-label="重试加载(?:收藏|想看)状态"/);
    assert.equal(
      actions.find((item) => item.id === 'favorite-retry').disabled,
      false,
    );
    assert.equal(
      actions.find((item) => item.id === 'favorite-retry').closeOnClick,
      false,
    );
    const retry = buttons.find((button) =>
      button['aria-label']?.startsWith('重试加载'),
    );
    assert.equal(retry.disabled, false);
    const event = {
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };
    await retry.onClick(event);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.deepEqual(writes, []);
    assert.equal(attempts, 2);
    assert.match(
      render(),
      /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*aria-label="(?:收藏|想看)状态加载中\.\.\."/,
    );
    pending.resolve({ 'douban+1': { title: 'Fixture' } });
    await flushPromises();
    assert.match(
      render(),
      /aria-busy="false"[^>]*aria-label="取消(?:收藏|想看)"/,
    );
    actions.find((item) => item.id === 'favorite').onClick();
    assert.equal(writes.length, 1);
    assert.equal(
      collection === 'favorites' ? writes[0].isFavorited : writes[0].isReminded,
      true,
    );
  });
}
