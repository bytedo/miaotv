const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const { createComponentLoader } = require('./component-test-loader.cjs');
const { createHookHost } = require('./playback-test-helpers.cjs');

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const anime = (id, title) => ({
  animeId: id,
  animeTitle: title,
  type: 'TV',
  episodes: [
    { episodeId: id * 100 + 1, episodeTitle: '第1集' },
    { episodeId: id * 100 + 2, episodeTitle: '第2集' },
  ],
});

function nodes(tree, predicate) {
  if (Array.isArray(tree))
    return tree.flatMap((item) => nodes(item, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...nodes(tree.props?.children, predicate),
  ];
}

function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree?.props ? textContent(tree.props.children) : '';
}

function installDom(t) {
  const saved = {
    window: global.window,
    document: global.document,
    localStorage: global.localStorage,
    HTMLElement: global.HTMLElement,
  };
  const mediaQueries = new Map();
  global.window = {
    matchMedia(query) {
      if (!mediaQueries.has(query)) {
        mediaQueries.set(
          query,
          Object.assign(new EventTarget(), { matches: false }),
        );
      }
      return mediaQueries.get(query);
    },
  };
  global.document = Object.assign(new EventTarget(), {
    body: { style: { overflow: '' } },
    documentElement: { style: { overflow: '' } },
    activeElement: null,
  });
  global.HTMLElement = class {};
  global.localStorage = {
    getItem: () => null,
    setItem() {},
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });
}

function createFixture(t, initialProps = {}) {
  const host = createHookHost();
  t.after(() => host.unmount());
  installDom(t);
  const requests = [];
  t.mock.method(global, 'fetch', (url, options) => {
    assert.ok(String(url).startsWith('/api/danmu-external/search?'));
    return new Promise((resolve) => {
      requests.push({
        url,
        signal: options.signal,
        respond(results) {
          resolve({
            ok: true,
            json: async () => ({ code: 200, animes: results }),
          });
        },
      });
    });
  });
  const load = createComponentLoader({
    react: {
      ...React,
      ...host.React,
      useMemo: (factory) => factory(),
      useId: () => 'danmu-fixture',
    },
    'react-dom': { createPortal: (element) => element },
  });
  const Modal = load('components/DanmuManualMatchModal.tsx').default;
  const props = {
    isOpen: true,
    defaultKeyword: '初始标题',
    currentEpisode: 1,
    onClose() {},
    onApply() {},
    ...initialProps,
  };
  let tree;
  function render() {
    tree = host.render(() => Modal(props));
    return tree;
  }
  render();
  render();
  return {
    requests,
    props,
    render,
    get tree() {
      return tree;
    },
    submit(keyword) {
      nodes(tree, (node) => node.type === 'input')[0].props.onChange({
        target: { value: keyword },
      });
      render();
      nodes(tree, (node) => node.type === 'form')[0].props.onSubmit({
        preventDefault() {},
      });
      render();
    },
  };
}

test('manual matching cancels replaced searches and ignores late responses', async (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.requests.length, 1);
  fixture.submit('新标题');
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[0].signal.aborted, true);

  fixture.requests[1].respond([anime(2, '新搜索结果')]);
  await nextTick();
  assert.match(textContent(fixture.render()), /新搜索结果/);
  fixture.requests[0].respond([anime(1, '过期搜索结果')]);
  await nextTick();
  assert.doesNotMatch(textContent(fixture.render()), /过期搜索结果/);
  assert.match(textContent(fixture.tree), /新搜索结果/);
});

test('closing manual matching cancels search and preserves a fresh result after reopening', async (t) => {
  const fixture = createFixture(t);
  fixture.props.isOpen = false;
  assert.equal(fixture.render(), null);
  assert.equal(fixture.requests[0].signal.aborted, true);

  fixture.props.isOpen = true;
  fixture.props.defaultKeyword = '重新打开';
  fixture.render();
  fixture.requests[1].respond([anime(2, '重新搜索的结果')]);
  await nextTick();
  fixture.requests[0].respond([anime(1, '关闭前的结果')]);
  await nextTick();
  assert.match(textContent(fixture.render()), /重新搜索的结果/);
  assert.doesNotMatch(textContent(fixture.tree), /关闭前的结果/);
});

test('changing the playback episode invalidates the previous manual search scope', async (t) => {
  const fixture = createFixture(t);
  fixture.props.currentEpisode = 2;
  fixture.render();
  assert.equal(fixture.requests[0].signal.aborted, true);
  assert.equal(fixture.requests.length, 2);
  fixture.requests[0].respond([anime(1, '旧集结果')]);
  await nextTick();
  assert.doesNotMatch(textContent(fixture.render()), /旧集结果/);
  assert.equal(
    nodes(fixture.tree, (node) => node.props?.['aria-busy'] === true).length,
    1,
  );
});

test('choosing a mobile source opens its episode step and repeated taps apply once', async (t) => {
  let applied = 0;
  let finishApply;
  const fixture = createFixture(t, {
    onApply(selection) {
      applied += 1;
      assert.equal(selection.episodeId, 201);
      return new Promise((resolve) => {
        finishApply = resolve;
      });
    },
  });
  fixture.requests[0].respond([anime(2, '手机选源')]);
  await nextTick();
  fixture.render();
  const source = nodes(
    fixture.tree,
    (node) => node.type === 'button' && textContent(node).includes('手机选源'),
  )[0];
  source.props.onClick();
  fixture.render();
  const episodeStep = nodes(
    fixture.tree,
    (node) => node.type === 'button' && textContent(node) === '2. 选择集数',
  )[0];
  assert.equal(episodeStep.props['aria-pressed'], true);
  const episode = nodes(
    fixture.tree,
    (node) => node.type === 'button' && node.props['aria-current'] === 'true',
  )[0];
  episode.props.onClick();
  episode.props.onClick();
  assert.equal(applied, 1);
  fixture.render();
  assert.equal(
    nodes(
      fixture.tree,
      (node) => node.type === 'button' && node.props['aria-current'] === 'true',
    )[0].props.disabled,
    true,
  );
  finishApply();
  await nextTick();
  fixture.render();
  assert.equal(
    nodes(
      fixture.tree,
      (node) => node.type === 'button' && node.props['aria-current'] === 'true',
    )[0].props.disabled,
    false,
  );
});

test('manual dialog recovers focus after a responsive pane hides and releases it on close', (t) => {
  const fixture = createFixture(t);
  const dialogRef = nodes(
    fixture.tree,
    (node) => node.props?.role === 'dialog',
  )[0].props.ref;
  const titleRef = nodes(fixture.tree, (node) => node.type === 'h2')[0].props
    .ref;

  fixture.props.isOpen = false;
  fixture.render();

  const createElement = () =>
    Object.assign(new HTMLElement(), {
      isConnected: true,
      visible: true,
      focusCount: 0,
      getClientRects() {
        return this.visible ? [{}] : [];
      },
      focus() {
        this.focusCount += 1;
        assert.ok(this.focusCount < 10, 'focus recovery must not loop');
        document.activeElement = this;
        document.dispatchEvent(new Event('focusin'));
      },
    });
  const opener = createElement();
  const title = createElement();
  const result = createElement();
  const outside = createElement();
  dialogRef.current = {
    contains: (element) => element === title || element === result,
  };
  titleRef.current = title;
  opener.focus();

  fixture.props.isOpen = true;
  fixture.render();
  assert.equal(document.activeElement, title);
  result.focus();
  assert.equal(document.activeElement, result, 'visible controls keep focus');

  const breakpoint = window.matchMedia('(max-width: 767px)');
  result.visible = false;
  breakpoint.matches = true;
  breakpoint.dispatchEvent(new Event('change'));
  assert.equal(
    document.activeElement,
    title,
    'hidden pane returns focus to the title',
  );

  document.activeElement = document.body;
  outside.focus();
  assert.equal(
    document.activeElement,
    title,
    'background focus stays inside the modal',
  );

  fixture.props.isOpen = false;
  fixture.render();
  assert.equal(document.activeElement, opener, 'closing restores the opener');
  assert.equal(document.body.style.overflow, '');
  outside.focus();
  breakpoint.matches = false;
  breakpoint.dispatchEvent(new Event('change'));
  assert.equal(
    document.activeElement,
    outside,
    'closed modal releases focus listeners',
  );
});

test('episode pagination follows playback changes while allowing manual browsing', (t) => {
  installDom(t);
  const host = createHookHost();
  const load = createComponentLoader({
    react: { ...React, ...host.React, useMemo: (factory) => factory() },
    'next/navigation': { useRouter: () => ({ push() {} }) },
    '@/lib/utils': {
      processImageUrl: (url) => url,
      getVideoResolutionFromM3u8: () => {
        throw new Error('No media requests expected');
      },
    },
  });
  const Selector = load('components/EpisodeSelector.tsx').default;
  const props = { totalEpisodes: 160, episodes_titles: [], value: 4 };
  const render = () => host.render(() => Selector(props));
  const currentPage = (tree) =>
    nodes(
      tree,
      (node) =>
        node.type === 'button' &&
        node.props['aria-pressed'] === true &&
        /^第 \d+-\d+ 集$/.test(node.props['aria-label'] || ''),
    )[0]?.props['aria-label'];
  let tree = render();
  const lastPage = nodes(
    tree,
    (node) => node.props?.['aria-label'] === '第 151-160 集',
  )[0];
  lastPage.props.onClick();
  assert.equal(currentPage(render()), '第 151-160 集');

  props.value = 55;
  render();
  tree = render();
  assert.equal(currentPage(tree), '第 51-100 集');
  assert.equal(
    nodes(tree, (node) => node.props?.['aria-current'] === 'true')[0].props[
      'aria-label'
    ],
    '第 56 集',
  );

  props.totalEpisodes = 20;
  props.value = 3;
  render();
  assert.equal(currentPage(render()), '第 1-20 集');
  host.unmount();
});
