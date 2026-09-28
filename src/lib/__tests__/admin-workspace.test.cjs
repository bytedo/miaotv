const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createComponentLoader } = require('./component-test-loader.cjs');
const { createSourceLoader } = require('./storage-test-loader.cjs');

const loadSource = createSourceLoader();
const { getAdminNavigation, getAdminSectionHref, resolveAdminSection } =
  loadSource('../components/admin/admin-navigation.ts');
const { persistAdminConfig, reconcileAdminConfig } =
  loadSource('admin-workspace.ts');

// These capabilities require the owner regardless of how the navigation is grouped.
const ownerSections = [
  'inviteCodeManager',
  'oidcAuthConfig',
  'trustedNetworkConfig',
  'danmuApiConfig',
  'emailConfig',
  'webhookConfig',
  'configFile',
  'cacheManager',
  'dataMigration',
  'performanceMonitor',
  'maintenance',
];

function makeConfig() {
  return {
    SiteConfig: {
      SiteName: 'Example TV',
      Announcement: 'Saved announcement',
      SearchDownstreamMaxPage: 3,
      SiteInterfaceCacheTime: 7200,
      DoubanProxyType: 'direct',
      DoubanProxy: '',
      DoubanImageProxyType: 'direct',
      DoubanImageProxy: '',
      DisableYellowFilter: false,
      ShowAdultContent: false,
      FluidSearch: true,
      EnableWebLive: true,
    },
    DoubanConfig: { enablePuppeteer: false, cookies: '' },
    CronConfig: {
      enableAutoRefresh: true,
      maxRecordsPerRun: 100,
      onlyRefreshRecent: true,
      recentDays: 30,
      onlyRefreshOngoing: true,
    },
    UserConfig: {
      Users: [{ username: 'viewer', role: 'user', banned: false }],
      Tags: [],
    },
    SourceConfig: [
      {
        key: 'first',
        name: 'First source',
        api: 'https://first.example.test',
        disabled: false,
      },
      {
        key: 'second',
        name: 'Second source',
        api: 'https://second.example.test',
        disabled: false,
      },
    ],
    CustomCategories: [],
    ConfigFile: '{"sources":[]}',
    ConfigSubscribtion: {
      URL: 'https://example.test/config',
      AutoUpdate: false,
      LastCheck: '',
    },
    EmailConfig: { enabled: false, senderName: 'Example TV' },
  };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('administrator navigation exposes routine management without owner capabilities', () => {
  const groups = getAdminNavigation('admin');
  const visible = new Set(
    groups.flatMap((group) => group.items.map((item) => item.id)),
  );
  for (const id of ['userConfig', 'videoSource', 'liveSource', 'siteConfig']) {
    assert.ok(visible.has(id), `${id} must remain available to administrators`);
  }
  for (const id of ownerSections) {
    assert.equal(
      visible.has(id),
      false,
      `${id} must be hidden from administrators`,
    );
  }
  assert.ok(
    groups.every((group) => group.items.length > 0),
    'hide empty navigation groups',
  );
});

test('restricted and stale section addresses fall back to the workspace overview', () => {
  for (const role of ['admin', null]) {
    for (const section of ownerSections) {
      assert.equal(
        resolveAdminSection(section, role).id,
        'overview',
        `${role}: ${section}`,
      );
    }
  }
  for (const role of ['owner', 'admin']) {
    for (const section of [
      null,
      '',
      'unknown-section',
      'shortDramaConfig',
      'constructor',
    ]) {
      assert.equal(
        resolveAdminSection(section, role).id,
        'overview',
        `${role}: ${section}`,
      );
    }
  }
});

test('owners can restore every available section from a stable bookmark URL', () => {
  const items = getAdminNavigation('owner').flatMap((group) => group.items);
  const visible = new Set(items.map((item) => item.id));
  for (const id of ownerSections)
    assert.ok(visible.has(id), `owner can reach ${id}`);

  assert.equal(getAdminSectionHref('overview'), '/admin');
  assert.equal(
    getAdminSectionHref('videoSource'),
    '/admin?section=videoSource',
  );
  assert.equal(getAdminSectionHref('configFile'), '/admin?section=configFile');

  for (const id of ['overview', ...visible]) {
    const address = new URL(getAdminSectionHref(id), 'https://example.test');
    assert.equal(address.pathname, '/admin');
    assert.equal(address.hash, '');
    assert.equal(
      resolveAdminSection(address.searchParams.get('section'), 'owner').id,
      id,
    );
  }
});

test('admin routes render their workspace without the public navigation', () => {
  let pathname = '/admin';
  const emptyComponent = () => null;
  const load = createComponentLoader({
    'next/navigation': { usePathname: () => pathname },
    'next/link': ({ children, ...props }) =>
      React.createElement('a', props, children),
    './ModernNav': () =>
      React.createElement('nav', { 'data-public-navigation': true }),
    './NavigationLayoutContext': {
      NavigationLayoutContext: React.createContext(null),
    },
    './SiteProvider': { useSite: () => ({ siteName: 'Example TV' }) },
    './ThemeToggle': { ThemeToggle: emptyComponent },
    './UserMenu': { UserMenu: emptyComponent },
  });
  const NavigationShell = load('components/NavigationShell.tsx').default;
  const render = () =>
    renderToStaticMarkup(
      React.createElement(
        NavigationShell,
        null,
        React.createElement(
          'div',
          { 'data-workspace-content': true },
          'Workspace content',
        ),
      ),
    );

  for (const route of ['/admin', '/admin/', '/admin/users']) {
    pathname = route;
    const html = render();
    assert.match(html, /data-workspace-content/);
    assert.doesNotMatch(html, /data-public-navigation/, route);
    assert.doesNotMatch(html, /aria-label="收藏夹"/, route);
  }
  for (const route of ['/', '/download', '/administrator']) {
    pathname = route;
    assert.match(
      render(),
      /data-public-navigation/,
      `${route} keeps the public navigation`,
    );
  }
});

test('an unchanged server refresh preserves the existing config and form inputs', () => {
  const current = freeze(makeConfig());
  const incoming = structuredClone(current);
  assert.equal(reconcileAdminConfig(current, incoming), current);
  assert.deepEqual(reconcileAdminConfig(null, incoming), incoming);
});

test('saving a source updates that source while preserving other editable sections', () => {
  const current = freeze(makeConfig());
  const incoming = structuredClone(current);
  incoming.SourceConfig[0].disabled = true;
  const saved = reconcileAdminConfig(current, incoming);

  assert.notEqual(saved, current);
  assert.equal(saved.SourceConfig[0].disabled, true);
  assert.equal(
    current.SourceConfig[0].disabled,
    false,
    'the displayed config is not mutated',
  );
  for (const branch of [
    'SiteConfig',
    'DoubanConfig',
    'CronConfig',
    'UserConfig',
    'ConfigSubscribtion',
  ]) {
    assert.equal(
      saved[branch],
      current[branch],
      `${branch} must not reset its draft`,
    );
  }
});

test('saved source ordering is applied without resetting unrelated settings', () => {
  const current = freeze(makeConfig());
  const incoming = structuredClone(current);
  incoming.SourceConfig.reverse();
  const saved = reconcileAdminConfig(current, incoming);

  assert.deepEqual(
    saved.SourceConfig.map((source) => source.key),
    ['second', 'first'],
  );
  assert.deepEqual(
    current.SourceConfig.map((source) => source.key),
    ['first', 'second'],
  );
  assert.equal(saved.SiteConfig, current.SiteConfig);
});

test('removing an integration removes stale configuration and preserves remaining drafts', () => {
  const current = freeze(makeConfig());
  const incoming = structuredClone(current);
  delete incoming.EmailConfig;
  const saved = reconcileAdminConfig(current, incoming);

  assert.equal(Object.hasOwn(saved, 'EmailConfig'), false);
  assert.equal(Object.hasOwn(current, 'EmailConfig'), true);
  assert.equal(saved.SiteConfig, current.SiteConfig);
  assert.equal(saved.UserConfig, current.UserConfig);
});

test('equivalent JSON with reordered object properties does not reset drafts', () => {
  const current = freeze(makeConfig());
  const incoming = structuredClone(current);
  incoming.SiteConfig = Object.fromEntries(
    Object.entries(incoming.SiteConfig).reverse(),
  );
  incoming.UserConfig.Users[0] = Object.fromEntries(
    Object.entries(incoming.UserConfig.Users[0]).reverse(),
  );
  incoming.SourceConfig[0].disabled = true;
  const saved = reconcileAdminConfig(current, incoming);

  assert.equal(saved.SourceConfig[0].disabled, true);
  assert.equal(saved.SiteConfig, current.SiteConfig);
  assert.equal(saved.UserConfig, current.UserConfig);
});

// Exercise real controlled form state/effects; only unrelated dialogs/loading are mocked.
function mountSettings(file, initialConfig) {
  const hooks = [];
  let hookIndex = 0;
  let config = initialConfig;
  let pending = true;
  let effects = [];
  let tree;
  const primitives = createComponentLoader()(
    'components/admin/AdminPrimitives.tsx',
  );
  const panelVisibility = React.createContext(true);
  const Component = createComponentLoader({
    './AdminPrimitives': primitives,
    './AdminPortal': { AdminPanelVisibilityContext: panelVisibility },
    'next/dynamic': () => () => null,
    './shared': {
      AlertModal: () => null,
      useAlertModal: () => ({
        alertModal: { isOpen: false },
        showAlert() {},
        hideAlert() {},
      }),
      useLoadingState: () => ({
        isLoading: () => false,
        withLoading: async (_key, action) => action(),
      }),
      showError() {},
      showSuccess() {},
    },
    react: {
      ...React,
      useContext(context) {
        assert.equal(context, panelVisibility);
        return true;
      },
      useState(initial) {
        const index = hookIndex++;
        if (!hooks[index]) {
          const state = {
            value: typeof initial === 'function' ? initial() : initial,
          };
          state.set = (next) => {
            const value = typeof next === 'function' ? next(state.value) : next;
            if (!Object.is(value, state.value)) {
              state.value = value;
              pending = true;
            }
          };
          hooks[index] = state;
        }
        return [hooks[index].value, hooks[index].set];
      },
      useEffect(effect, dependencies) {
        const index = hookIndex++;
        const previous = hooks[index];
        if (
          !previous ||
          dependencies.some((value, i) => !Object.is(value, previous[i]))
        ) {
          hooks[index] = dependencies;
          effects.push(effect);
        }
      },
    },
  })(file).default;

  function flush() {
    let renders = 0;
    while (pending) {
      assert.ok(++renders < 25, 'config updates settle without a render loop');
      pending = false;
      effects = [];
      hookIndex = 0;
      tree = Component({
        config,
        refreshConfig: async () => assert.fail('unexpected refresh'),
      });
      effects.forEach((effect) => effect());
    }
  }

  function elements(node) {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    return [node, ...elements(node.props.children)];
  }

  function field(label) {
    const nodes = elements(tree);
    const fieldLabel = nodes.find(
      (node) => node.type === 'label' && node.props.children === label,
    );
    assert.ok(fieldLabel, `visible label: ${label}`);
    const control = nodes.find(
      (node) => node.props.id === fieldLabel.props.htmlFor,
    );
    assert.ok(control, `associated input: ${label}`);
    return control.props;
  }

  flush();
  return {
    field,
    change(label, value) {
      field(label).onChange({ target: { value } });
      flush();
    },
    update(next) {
      config = next;
      pending = true;
      flush();
    },
  };
}

test('open settings drafts survive another module saving and accept their own saved values', () => {
  const current = makeConfig();
  const site = mountSettings('components/admin/SiteSettings.tsx', current);
  const editor = mountSettings(
    'components/admin/ConfigurationFile.tsx',
    current,
  );
  site.change('站点名称', 'Unsaved site name');
  editor.change('配置内容', '{"sources":["unsaved-source"]}');

  const sourceResponse = structuredClone(current);
  sourceResponse.SourceConfig[0].disabled = true;
  const sourceSaved = reconcileAdminConfig(current, sourceResponse);
  site.update(sourceSaved);
  editor.update(sourceSaved);
  assert.equal(site.field('站点名称').value, 'Unsaved site name');
  assert.equal(
    editor.field('配置内容').value,
    '{"sources":["unsaved-source"]}',
  );

  const siteResponse = structuredClone(sourceSaved);
  siteResponse.SiteConfig.SiteName = 'Saved site name';
  const siteSaved = reconcileAdminConfig(sourceSaved, siteResponse);
  site.update(siteSaved);
  editor.update(siteSaved);
  assert.equal(site.field('站点名称').value, 'Saved site name');
  assert.equal(
    editor.field('配置内容').value,
    '{"sources":["unsaved-source"]}',
  );

  const editorResponse = structuredClone(siteSaved);
  editorResponse.ConfigFile = '';
  editor.update(reconcileAdminConfig(siteSaved, editorResponse));
  assert.equal(
    editor.field('配置内容').value,
    '',
    'a saved empty config clears the old draft',
  );
});

test('successful settings saves POST the complete config without requiring a JSON response', async (t) => {
  const config = freeze(makeConfig());
  const requests = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/admin/config');
    assert.equal(options.method, 'POST');
    assert.equal(
      new Headers(options.headers).get('Content-Type'),
      'application/json',
    );
    assert.deepEqual(JSON.parse(options.body), config);
    return new Response(null, { status: 204 });
  });

  await assert.doesNotReject(persistAdminConfig(config));
  assert.equal(requests.mock.callCount(), 1);
});

test('failed settings saves reject with the server error instead of reporting success', async (t) => {
  let response;
  const requests = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, '/api/admin/config');
    return response;
  });
  const failures = [
    { status: 400, error: '配置格式错误' },
    { status: 403, error: '只有站长可以修改配置' },
    { status: 500, error: '保存配置失败' },
  ];

  for (const failure of failures) {
    response = Response.json(
      { error: failure.error },
      { status: failure.status },
    );
    await assert.rejects(persistAdminConfig(makeConfig()), {
      message: failure.error,
    });
  }
  assert.equal(requests.mock.callCount(), failures.length);
});

test('non-JSON HTTP save failures surface a usable error message', async (t) => {
  const requests = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, '/api/admin/config');
    return new Response('<html>Bad gateway</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
  });

  await assert.rejects(persistAdminConfig(makeConfig()), {
    message: '保存第三方登录配置失败',
  });
  assert.equal(requests.mock.callCount(), 1);
});

test('hidden admin panels hide portals while keeping dialog content available for returning', () => {
  const container = { nodeType: 1 };
  const content = React.createElement('input', {
    'aria-label': 'Provider name',
    defaultValue: 'Draft provider',
  });
  const rendered = [];
  const { AdminPanelVisibilityContext, createPortal } = createComponentLoader({
    'react-dom': {
      createPortal: (children, target) => {
        assert.equal(target, container);
        rendered.push(children);
        return children;
      },
    },
  })('components/admin/AdminPortal.tsx');
  const dialog = createPortal(content, container, 'provider-dialog');
  const render = (visible) =>
    renderToStaticMarkup(
      React.createElement(
        AdminPanelVisibilityContext.Provider,
        { value: visible },
        dialog,
      ),
    );

  const hidden = render(false);
  assert.match(hidden, /data-admin-portal/);
  assert.match(hidden, /style="display:none"/);
  assert.match(hidden, /aria-hidden="true"/);
  assert.match(hidden, /value="Draft provider"/);
  assert.equal(rendered.at(-1).props.children, content);

  const visible = render(true);
  assert.match(visible, /style="display:contents"/);
  assert.doesNotMatch(visible, /aria-hidden="true"/);
  assert.match(visible, /value="Draft provider"/);
  assert.equal(rendered.at(-1).props.children, content);
});

test('portals reused outside an admin visibility provider stay visible', () => {
  const container = { nodeType: 1 };
  const { createPortal } = createComponentLoader({
    'react-dom': {
      createPortal: (children, target) => {
        assert.equal(target, container);
        return children;
      },
    },
  })('components/admin/AdminPortal.tsx');
  const html = renderToStaticMarkup(
    createPortal(
      React.createElement('div', { role: 'dialog' }, 'Public dialog'),
      container,
    ),
  );

  assert.match(html, /style="display:contents"/);
  assert.doesNotMatch(html, /aria-hidden/);
  assert.match(html, /role="dialog">Public dialog/);
});
