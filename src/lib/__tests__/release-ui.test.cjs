const assert = require('node:assert/strict');
const test = require('node:test');
const React = require('react');
const { createComponentLoader } = require('./component-test-loader.cjs');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createHookHost, installBrowser } = require('./playback-test-helpers.cjs');

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

async function tvboxPage(t, securityConfig, userToken = '') {
  installBrowser(t);
  const requests = [];
  t.mock.method(global, 'fetch', async url => {
    requests.push(String(url));
    if (url === '/api/tvbox-config') {
      return Response.json({ securityConfig, userToken, siteName: 'MiaoTV' });
    }
    return Response.json({ enabled: false });
  });
  const host = createHookHost();
  t.after(() => host.unmount());
  const Page = createComponentLoader({
    react: { ...React, ...host.React },
    '@/components/PageLayout': { default: () => null },
  })('app/tvbox/page.tsx').default;
  host.render(Page);
  await new Promise(resolve => setImmediate(resolve));
  const nodes = elements(host.render(Page));
  return { nodes, requests };
}

const security = {
  enableAuth: true, token: '', enableIpWhitelist: false,
  allowedIPs: [], enableRateLimit: false, rateLimit: 60,
};

test('TVBox requires an assigned token before offering copyable authenticated subscriptions', async t => {
  const { nodes } = await tvboxPage(t, security);
  assert.equal(nodes.find(node => node.type === 'fieldset').props.disabled, true);
  assert.equal(nodes.find(node => node.type === 'input' && node.props.readOnly).props.value, '');
  assert.ok(nodes.some(node => node.props.role === 'status' && String(node.props.children).includes('个人 TVBox 密钥')));
});

test('TVBox personal tokens work for both subscriptions and basic diagnostics', async t => {
  const { nodes, requests } = await tvboxPage(t, security, 'personal-test-token');
  assert.equal(nodes.find(node => node.type === 'fieldset').props.disabled, false);
  const value = nodes.find(node => node.type === 'input' && node.props.readOnly).props.value;
  assert.equal(new URL(value).searchParams.get('token'), 'personal-test-token');
  const diagnose = nodes.find(node => node.type === 'button' && node.props.children === '开始诊断');
  await diagnose.props.onClick();
  assert.ok(requests.includes('/api/tvbox/diagnose?token=personal-test-token'));
});

test('TVBox retains owner token and explicitly unauthenticated subscription behavior', async t => {
  const owner = await tvboxPage(t, { ...security, token: 'owner-test-token' });
  const ownerValue = owner.nodes.find(node => node.type === 'input' && node.props.readOnly).props.value;
  assert.equal(new URL(ownerValue).searchParams.get('token'), 'owner-test-token');
  const publicPage = await tvboxPage(t, { ...security, enableAuth: false });
  assert.equal(publicPage.nodes.find(node => node.type === 'fieldset').props.disabled, false);
  const publicValue = publicPage.nodes.find(node => node.type === 'input' && node.props.readOnly).props.value;
  assert.equal(new URL(publicValue).searchParams.has('token'), false);
});

test('forced watching-update checks keep a stable query and bypass the saved initial result', t => {
  // Keep hook debug logs out of the Windows test runner's IPC stream.
  t.mock.method(console, 'log', () => {});
  const storage = installBrowser(t);
  storage.set('moontv_watching_updates', JSON.stringify({ hasUpdates: false, timestamp: 1 }));
  let now = 1000;
  t.mock.method(Date, 'now', () => now++);
  const { useWatchingUpdatesQuery } = createSourceLoader({
    '@tanstack/react-query': { useQuery: options => options, useQueryClient: () => ({}) },
  })('../hooks/useWatchingUpdates.ts');
  const first = useWatchingUpdatesQuery({ forceRefresh: true });
  const rerender = useWatchingUpdatesQuery({ forceRefresh: true });
  assert.deepEqual(first.queryKey, rerender.queryKey, 'rendering must not create another network query');
  assert.equal(first.initialData(), undefined, 'force refresh must not start with a fresh cached result');
  assert.equal(first.staleTime, 0);
  const cached = useWatchingUpdatesQuery({ forceRefresh: false });
  assert.equal(cached.initialData().timestamp, 1);
  assert.equal(cached.staleTime, 30 * 60 * 1000);
});
