const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const { createComponentLoader } = require('./component-test-loader.cjs');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createHookHost } = require('./playback-test-helpers.cjs');

const categories = [
  { type_id: 1, type_pid: 0, type_name: '电影' },
  { type_id: 2, type_pid: 0, type_name: '连续剧' },
  { type_id: 5, type_pid: 0, type_name: '独立分类' },
  { type_id: 6, type_pid: 1, type_name: '动作片' },
  { type_id: 23, type_pid: 2, type_name: '国产剧' },
];

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

function browserFixture(t, { params = 'source=alpha', sourceCategories = categories } = {}) {
  const host = createHookHost();
  t.after(() => host.unmount());
  const requests = [];
  t.mock.method(global, 'fetch', (url) => new Promise((resolve, reject) => {
    requests.push({ url: new URL(url, 'https://fixture.test'), resolve, reject });
  }));
  const searchParams = new URLSearchParams(params);
  const sources = [
    { key: 'alpha', name: 'Alpha', api: 'https://alpha.fixture.test/api' },
    { key: 'beta', name: 'Beta', api: 'https://beta.fixture.test/api' },
  ];
  const router = { replace: () => {}, push: () => {} };
  const Page = createComponentLoader({
    react: { ...React, ...host.React, useMemo: (factory) => factory() },
    'next/navigation': {
      useRouter: () => router,
      useSearchParams: () => searchParams,
      usePathname: () => '/source-browser',
    },
    '@tanstack/react-query': {
      useQuery: ({ queryKey, enabled }) => ({
        data: enabled === false ? undefined : queryKey[1] === 'sites' ? sources : sourceCategories,
        isLoading: false,
      }),
    },
    '@/lib/client-cache': { ClientCache: { get: async () => null } },
    '@/components/PageLayout': { default: () => null },
  })('app/source-browser/page.tsx').default;
  let nodes = [];
  function render() {
    nodes = elements(host.render(Page));
    return nodes;
  }
  function click(key) {
    const button = nodes.find(node => node.type === 'button' && node.key === String(key));
    assert.ok(button, `Missing button ${key}`);
    button.props.onClick();
    render();
    render();
  }
  async function respond(request, title, { page = 1, pagecount = 1 } = {}) {
    request.resolve(Response.json({
      items: [{ id: title, title, poster: 'https://image.fixture.test/poster.jpg', year: '2026' }],
      meta: { page, pagecount },
    }));
    await new Promise(resolve => setImmediate(resolve));
    render();
  }
  render();
  render();
  return {
    requests, render, click, respond,
    posters: () => nodes.filter(node => node.type === 'img').map(node => node.props.alt),
    text: () => nodes.flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : []).join(' '),
  };
}

test('source categories preserve upstream hierarchy and legacy flat entries', async t => {
  t.mock.method(global, 'fetch', async () => Response.json({ class: [
    ...categories,
    { typeid: 'flat', typename: '平面分类' },
  ] }));
  const route = createSourceLoader({
    'next/server': { NextResponse: Response },
    '@/lib/auth': { getAuthInfoFromCookie: () => ({ username: 'fixture' }) },
    '@/lib/config': {
      API_CONFIG: { search: { headers: {} } },
      getAvailableApiSites: async () => [{ key: 'alpha', api: 'https://alpha.fixture.test/api' }],
    },
  })('../app/api/source-browser/categories/route.ts');
  const response = await route.GET(new Request('https://fixture.test/api/source-browser/categories?source=alpha'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).categories, [
    ...categories,
    { type_id: 'flat', type_name: '平面分类' },
  ]);
});

test('source browser defaults to the first leaf within the first category branch', t => {
  const fixture = browserFixture(t);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].url.searchParams.get('type_id'), '6');
});

test('source browser retains the first category when upstream has no hierarchy', t => {
  const fixture = browserFixture(t, { sourceCategories: categories.map(({ type_pid, ...category }) => category) });
  assert.equal(fixture.requests[0].url.searchParams.get('type_id'), '1');
});

test('source browser preserves explicit URL and user-selected parent categories', t => {
  const fixture = browserFixture(t, { params: 'source=alpha&category=1' });
  assert.equal(fixture.requests[0].url.searchParams.get('type_id'), '1');
  fixture.click(2);
  assert.equal(fixture.requests.at(-1).url.searchParams.get('type_id'), '2');
});

test('an old source response cannot overwrite results from the selected source', async t => {
  const fixture = browserFixture(t, { params: 'source=alpha&category=6' });
  const oldRequest = fixture.requests[0];
  fixture.click('beta');
  const currentRequest = fixture.requests.at(-1);
  assert.equal(currentRequest.url.searchParams.get('source'), 'beta');
  await fixture.respond(currentRequest, 'Current source');
  assert.deepEqual(fixture.posters(), ['Current source']);
  await fixture.respond(oldRequest, 'Old source');
  assert.deepEqual(fixture.posters(), ['Current source']);
});

test('an old category response cannot overwrite a newly selected category', async t => {
  const fixture = browserFixture(t, { params: 'source=alpha&category=6' });
  const oldRequest = fixture.requests[0];
  fixture.click(23);
  const currentRequest = fixture.requests.at(-1);
  await fixture.respond(currentRequest, 'Current category');
  await fixture.respond(oldRequest, 'Old category');
  assert.deepEqual(fixture.posters(), ['Current category']);
});

test('old failures cannot clear results or show errors after switching sources', async t => {
  const fixture = browserFixture(t, { params: 'source=alpha&category=6' });
  const oldRequest = fixture.requests[0];
  fixture.click('beta');
  await fixture.respond(fixture.requests.at(-1), 'Current source');
  oldRequest.reject(new Error('Stale source failed'));
  await new Promise(resolve => setImmediate(resolve));
  fixture.render();
  assert.deepEqual(fixture.posters(), ['Current source']);
  assert.ok(!fixture.text().includes('Stale source failed'));
});

test('returning to a source still ignores a response from its earlier visit', async t => {
  const fixture = browserFixture(t, { params: 'source=alpha&category=6' });
  const originalRequest = fixture.requests[0];
  fixture.click('beta');
  fixture.click('alpha');
  const currentRequest = fixture.requests.at(-1);
  assert.equal(currentRequest.url.searchParams.get('source'), 'alpha');
  await fixture.respond(currentRequest, 'Latest visit');
  await fixture.respond(originalRequest, 'Earlier visit');
  assert.deepEqual(fixture.posters(), ['Latest visit']);
});
