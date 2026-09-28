const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createComponentLoader } = require('./component-test-loader.cjs');

function navigationFixture() {
  let link;
  let pending = false;
  const pushes = [];
  const load = createComponentLoader({
    react: {
      ...React,
      useTransition: () => [
        pending,
        (navigate) => {
          pending = true;
          navigate();
        },
      ],
    },
    'next/navigation': {
      useRouter: () => ({ push: (href) => pushes.push(href) }),
    },
    'next/link': ({ prefetch: _prefetch, ...props }) => {
      link = props;
      return React.createElement('a', props, props.children);
    },
  });
  const { FastLink } = load('components/FastLink.tsx');
  return {
    pushes,
    get link() {
      return link;
    },
    finish() {
      pending = false;
    },
    render(props = {}) {
      return renderToStaticMarkup(
        React.createElement(
          FastLink,
          {
            href: '/douban?type=movie',
            useTransitionNav: true,
            ...props,
          },
          '电影',
        ),
      );
    },
  };
}

function click(properties = {}) {
  return {
    button: 0,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...properties,
  };
}

test('navigation shows pending feedback without disabling a subsequent destination', () => {
  const fixture = navigationFixture();
  assert.doesNotMatch(fixture.render(), /正在打开/);
  fixture.link.onClick(click());
  assert.deepEqual(fixture.pushes, ['/douban?type=movie']);
  assert.match(fixture.render(), /正在打开/);
  assert.equal(fixture.link['aria-busy'], true);
  assert.equal(fixture.link['aria-disabled'], undefined);
  assert.doesNotMatch(fixture.link.className, /pointer-events-none/);

  fixture.render({ href: '/search' });
  fixture.link.onClick(click());
  assert.deepEqual(fixture.pushes, ['/douban?type=movie', '/search']);
  fixture.finish();
  assert.doesNotMatch(fixture.render(), /正在打开/);
  assert.equal(fixture.link['aria-busy'], undefined);
});

test('browser gestures and canceled clicks do not start a pending navigation', () => {
  const fixture = navigationFixture();
  for (const properties of [
    { button: 1 },
    { button: 2 },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
  ]) {
    fixture.render();
    const event = click(properties);
    fixture.link.onClick(event);
    assert.equal(event.defaultPrevented, false);
  }
  for (const props of [
    { target: '_blank' },
    { target: 'preview' },
    { href: 'https://example.test/' },
    { href: '//example.test/' },
    { href: 'mailto:test@example.test' },
  ]) {
    fixture.render(props);
    const event = click();
    fixture.link.onClick(event);
    assert.equal(event.defaultPrevented, false);
  }
  fixture.render({ onClick: (event) => event.preventDefault() });
  fixture.link.onClick(click());
  assert.deepEqual(fixture.pushes, []);
  assert.doesNotMatch(fixture.render(), /正在打开/);
});

test('route loading is visible before hydration and cannot cover navigation controls', () => {
  const load = createComponentLoader();
  const { PageLoading } = load('components/PageLoading.tsx');
  const html = renderToStaticMarkup(React.createElement(PageLoading));
  assert.match(html, /role="status"/);
  assert.match(html, /正在加载…/);
  assert.match(html, /pointer-events-none/);
  assert.doesNotMatch(html, /\bfixed\b|\binset-0\b|\bopacity-0\b/);
  const route = createComponentLoader({
    '@/components/PageLoading': { PageLoading },
  })('app/loading.tsx');
  assert.equal(route.default, PageLoading);
  const layout = fs.readFileSync(
    path.resolve(__dirname, '../../app/layout.tsx'),
    'utf8',
  );
  assert.match(layout, /<Suspense fallback=\{<PageLoading \/>\}>/);
});
