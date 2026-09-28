const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createComponentLoader } = require('./component-test-loader.cjs');
const { createSourceLoader } = require('./storage-test-loader.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const empty = () => null;
const allEnabled = {
  allowRegister: true,
  requireApproval: true,
  requireInviteCode: true,
};

function mountRegistrationSettings(t) {
  const hooks = hookHarness(true);
  const requests = [];
  const alerts = [];
  let notifications = 0;
  const config = {
    UserConfig: {
      AllowRegister: true,
      RequireApproval: true,
      RequireInviteCode: true,
      Users: [{ uid: '2', username: 'applicant', role: 'user', pending: true }],
      Tags: [],
    },
    SiteConfig: { DefaultUserTags: [] },
    SourceConfig: [],
  };
  let tree;
  let saving = false;
  let failSave = false;
  let gate;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, '/api/admin/config');
    assert.equal(options.method, 'PATCH');
    const patch = JSON.parse(options.body);
    requests.push(patch);
    if (gate) await gate;
    if (failSave)
      return { ok: false, json: async () => ({ error: '保存注册设置失败' }) };
    Object.assign(config.UserConfig, patch);
    return { ok: true };
  });
  const Component = createComponentLoader({
    react: hooks.react,
    'next/navigation': { useRouter: () => ({ replace() {} }) },
    '@/lib/auth': {
      getAuthInfoFromBrowserCookie: () => ({ uid: '1', username: 'owner' }),
    },
    '@/lib/registration-policy-events': {
      notifyRegistrationPolicyChanged: () => {
        notifications++;
      },
    },
    '@/components/admin/AdminPortal': { createPortal: (children) => children },
    '@/components/TVBoxTokenManager': {
      TVBoxTokenCell: empty,
      TVBoxTokenModal: empty,
    },
    '@/components/UserApprovalModal': empty,
    './AdminPrimitives': {
      AdminEmptyState: empty,
      AdminSection: empty,
      AdminTabs: empty,
    },
    './UserActionDrawer': { UserActionDrawer: empty },
    './UserDrawerOverview': { UserDrawerOverview: empty },
    './user-management-drawer.css': {},
    './user-action-drawer.css': {},
    './shared': {
      AlertModal: empty,
      buttonStyles: {},
      useAlertModal: () => ({
        alertModal: { isOpen: false },
        showAlert: (value) => alerts.push(value),
        hideAlert() {},
      }),
      useLoadingState: () => ({
        isLoading: () => saving,
        withLoading: async (_key, action) => {
          saving = true;
          try {
            return await action();
          } finally {
            saving = false;
          }
        },
      }),
      showError: (message) => alerts.push({ type: 'error', message }),
      showSuccess() {},
    },
  })('components/admin/UserManagement.tsx').default;
  const props = { config, role: 'owner', refreshConfig: async () => {} };
  function render() {
    hooks.begin();
    tree = Component(props);
  }
  function find(predicate) {
    const found = elements(tree).filter(predicate);
    assert.equal(found.length, 1, 'expected one admin control');
    return found[0];
  }
  render();
  function selectView(value) {
    find((node) => node.props.label === '用户管理视图').props.onChange(value);
    render();
  }
  selectView('registration');
  return {
    requests,
    alerts,
    notifications: () => notifications,
    config,
    find,
    selectView,
    render,
    nodes: () => elements(tree),
    message: () => text(tree),
    switch: (label) =>
      find(
        (node) =>
          node.props.role === 'switch' && node.props['aria-label'] === label,
      ),
    failSave(value) {
      failSave = value;
    },
    delaySave(promise) {
      gate = promise;
    },
  };
}

test('admin registration switches save only the changed field and report persistence failures', async (t) => {
  const panel = mountRegistrationSettings(t);
  for (const [label, key] of [
    ['需要邀请码注册', 'RequireInviteCode'],
    ['需要审核注册', 'RequireApproval'],
    ['允许用户注册', 'AllowRegister'],
  ]) {
    await panel.switch(label).props.onClick();
    panel.render();
    assert.deepEqual(panel.requests.at(-1), { [key]: false });
    assert.equal(panel.switch(label).props['aria-checked'], false);
  }
  assert.match(panel.message(), /当前注册方式：已关闭注册/);
  assert.equal(panel.notifications(), 3);
  assert.ok(
    panel
      .nodes()
      .some(
        (node) => node.type === 'button' && text(node) === '查看待审核申请',
      ),
  );
  panel.failSave(true);
  await panel.switch('需要审核注册').props.onClick();
  panel.render();
  assert.equal(panel.switch('需要审核注册').props['aria-checked'], false);
  assert.deepEqual(panel.alerts.at(-1), {
    type: 'error',
    message: '保存注册设置失败',
  });
  assert.equal(
    panel.notifications(),
    3,
    'failed saves do not announce a change',
  );
  panel.selectView('users');
  assert.ok(
    panel
      .nodes()
      .some((node) => node.type === 'button' && /待审核/.test(text(node))),
  );
});

test('admin registration switches reject rapid overlapping writes and remain adjustable after saving', async (t) => {
  const panel = mountRegistrationSettings(t);
  let release;
  panel.delaySave(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const first = panel.switch('需要审核注册').props.onClick();
  const overlapping = panel.switch('需要邀请码注册').props.onClick();
  panel.render();
  assert.equal(panel.requests.length, 1);
  assert.equal(panel.switch('允许用户注册').props.disabled, true);
  release();
  await Promise.all([first, overlapping]);
  panel.render();
  assert.equal(panel.switch('允许用户注册').props.disabled, false);
  assert.equal(panel.switch('需要邀请码注册').props['aria-checked'], true);
  await panel.switch('需要邀请码注册').props.onClick();
  assert.equal(panel.requests.length, 2);
});

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [
    node,
    ...elements(node.props.children),
    ...elements(node.props.action),
  ];
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (React.isValidElement(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : '';
}

function hookHarness(ignoreEffects = false) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const react = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!slots[index])
        slots[index] = {
          value: typeof initial === 'function' ? initial() : initial,
        };
      return [
        slots[index].value,
        (value) => {
          slots[index].value =
            typeof value === 'function' ? value(slots[index].value) : value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (
        !ignoreEffects &&
        (!previous ||
          dependencies?.some((value, i) => !Object.is(value, previous[i])))
      ) {
        effects.push(effect);
      }
      slots[index] = dependencies;
    },
  };
  return {
    react,
    begin() {
      cursor = 0;
    },
    effects() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
  };
}

async function mountAuth(t, kind, initialPolicy = allEnabled) {
  const hooks = hookHarness();
  let policy = { ...initialPolicy };
  let tree;
  const requests = [];
  const redirects = [];
  let refreshes = 0;
  let response = { ok: true, data: { pending: true } };
  const router = { replace: (url) => redirects.push(url) };
  const search = new URLSearchParams();
  const previousWindow = global.window;
  global.window = { RUNTIME_CONFIG: { STORAGE_TYPE: 'redis' } };
  t.after(() => {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(global, 'fetch', async (url, options) => {
    if (url === '/api/auth/oidc/session-info' || url === '/api/server-config') {
      return { ok: true, json: async () => ({ ...policy }) };
    }
    assert.equal(
      url,
      kind === 'oidc' ? '/api/auth/oidc/complete-register' : '/api/register',
    );
    requests.push(JSON.parse(options.body));
    return { ok: response.ok, json: async () => response.data };
  });
  const disabled = ({ reason }) => React.createElement('p', null, reason);
  const load = createComponentLoader({
    react: hooks.react,
    'next/navigation': {
      useRouter: () => router,
      useSearchParams: () => search,
    },
    'framer-motion': {
      motion: new Proxy({}, { get: (_target, tag) => tag }),
      AnimatePresence: React.Fragment,
    },
    '@/hooks/useRegistrationPolicy': {
      useRegistrationPolicy: () => ({
        data: policy,
        refetch: async () => {
          refreshes++;
        },
      }),
    },
    '@/components/SiteProvider': {
      useSite: () => ({ siteName: 'Fixture TV' }),
    },
    '@/components/ThemeToggle': { ThemeToggle: empty },
    './RegisterDisabledPage': disabled,
    '@/app/register/RegisterDisabledPage': disabled,
    '@/components/OIDCProviderLogos': {},
  });
  const paths = {
    password: ['app/register/RegisterPageClient.tsx', 'RegisterForm'],
    oidc: ['app/oidc-register/page.tsx', 'OIDCRegisterForm'],
    login: ['app/login/page.tsx', 'LoginPageClient'],
  };
  const [path, name] = paths[kind];
  const wrapper = load(path).default(initialPolicy);
  const form = elements(wrapper).find((element) => element.type?.name === name);
  assert.ok(form, 'the real form must be rendered by the page');
  function render() {
    hooks.begin();
    tree = form.type(form.props);
    hooks.effects();
  }
  function find(predicate) {
    const found = elements(tree).filter(predicate);
    assert.equal(found.length, 1, 'expected exactly one matching control');
    return found[0];
  }
  render();
  await tick();
  render();
  return {
    requests,
    redirects,
    nodes: () => elements(tree),
    find,
    input: (id) =>
      find((node) => node.type === 'input' && node.props.id === id),
    message: () => text(tree),
    refreshes: () => refreshes,
    setPolicy(value) {
      policy = { ...value };
      render();
    },
    setResponse(value) {
      response = value;
    },
    change(id, value) {
      find(
        (node) => node.type === 'input' && node.props.id === id,
      ).props.onChange({ target: { value } });
      render();
    },
    async submit() {
      await find((node) => node.type === 'form').props.onSubmit({
        preventDefault() {},
      });
      render();
    },
  };
}

for (const kind of ['password', 'oidc']) {
  test(`${kind} registration page responds to all switch combinations and reopens without losing input`, async (t) => {
    const page = await mountAuth(t, kind);
    page.change('username', 'draft_user');
    // Begin with every switch enabled, then close each combination on the same page.
    for (const allowRegister of [true, false, true]) {
      for (const requireApproval of [true, false]) {
        for (const requireInviteCode of [true, false]) {
          page.setPolicy({ allowRegister, requireApproval, requireInviteCode });
          const forms = page.nodes().filter((node) => node.type === 'form');
          assert.equal(forms.length, allowRegister ? 1 : 0);
          if (!allowRegister) continue;
          assert.equal(page.input('username').props.value, 'draft_user');
          const approval = requireApproval && !requireInviteCode;
          assert.equal(page.input('email').props.required, approval);
          assert.equal(
            page.nodes().filter((node) => node.props.id === 'source').length,
            approval ? 1 : 0,
          );
          const invitations = page
            .nodes()
            .filter((node) => node.props.id === 'inviteCode');
          assert.equal(
            invitations.length,
            requireApproval || requireInviteCode ? 1 : 0,
          );
          if (invitations.length)
            assert.equal(invitations[0].props.required, requireInviteCode);
          assert.equal(page.message().includes('提交审核申请'), approval);
        }
      }
    }
  });

  test(`${kind} optional invitation removes review fields and clearing it restores their requirements`, async (t) => {
    const page = await mountAuth(t, kind, {
      ...allEnabled,
      requireInviteCode: false,
    });
    assert.equal(page.input('email').props.required, true);
    page.change('source', 'saved draft');
    page.change('inviteCode', 'abcd2345');
    assert.equal(page.input('email').props.required, false);
    assert.equal(
      page.nodes().some((node) => node.props.id === 'source'),
      false,
    );
    assert.match(page.message(), /直接登录，无需审核/);
    page.change('inviteCode', '   ');
    assert.equal(page.input('email').props.required, true);
    assert.equal(page.input('source').props.value, 'saved draft');
  });

  test(`${kind} invitation submissions omit hidden review fields, reject invalid codes and refresh changed policy`, async (t) => {
    const page = await mountAuth(t, kind, {
      ...allEnabled,
      requireInviteCode: false,
    });
    page.change('username', 'new_user');
    if (kind === 'password') {
      page.change('password', 'new-password');
      page.change('confirmPassword', 'new-password');
    }
    page.change('source', 'old source');
    page.change('inviteCode', 'badcode');
    page.setResponse({ ok: false, data: { error: '邀请码已过期' } });
    await page.submit();
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].inviteCode, 'BADCODE');
    assert.ok(!page.requests[0].source);
    assert.match(page.message(), /邀请码已过期/);
    assert.equal(page.refreshes(), 1);
    assert.equal(page.redirects.length, 0);

    page.setPolicy({
      allowRegister: true,
      requireApproval: false,
      requireInviteCode: false,
    });
    page.setResponse({ ok: true, data: { pending: false } });
    await page.submit();
    assert.equal(page.requests.length, 2);
    assert.ok(
      !page.requests[1].inviteCode,
      'a now-hidden invitation is not consumed',
    );
    assert.ok(!page.requests[1].source);
    t.mock.timers.runAll();
    assert.deepEqual(page.redirects, ['/']);
  });

  test(`${kind} approval submissions remain on the page and preserve their success message after registration closes`, async (t) => {
    const page = await mountAuth(t, kind, {
      ...allEnabled,
      requireInviteCode: false,
    });
    page.change('username', 'new_user');
    if (kind === 'password') {
      page.change('password', 'new-password');
      page.change('confirmPassword', 'new-password');
    }
    page.change('email', 'new@example.com');
    page.change('source', 'friend');
    await page.submit();
    assert.equal(page.requests[0].source, 'friend');
    assert.match(page.message(), /请等待管理员审核/);
    assert.deepEqual(page.redirects, []);
    page.setPolicy({ ...allEnabled, allowRegister: false });
    assert.match(page.message(), /请等待管理员审核/);
  });
}

test('login registration link follows the current registration switch without hiding password recovery', async (t) => {
  const page = await mountAuth(t, 'login');
  for (const allowRegister of [true, false, true]) {
    page.setPolicy({ ...allEnabled, allowRegister });
    assert.equal(
      page.nodes().some((node) => node.props.href === '/register'),
      allowRegister,
    );
    assert.equal(
      page.nodes().some((node) => node.props.href === '/forgot-password'),
      true,
    );
  }
});

test('registration pages refresh on focus and saved policy changes in the same or another tab', async (t) => {
  const previousWindow = global.window;
  global.window = new EventTarget();
  t.after(() => {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  let cleanup;
  let refreshes = 0;
  let options;
  const events = createSourceLoader()('registration-policy-events.ts');
  const storageWrites = [];
  window.localStorage = {
    setItem: (...args) => storageWrites.push(args),
  };
  const api = createSourceLoader({
    react: {
      useEffect: (effect) => {
        cleanup = effect();
      },
    },
    '@tanstack/react-query': {
      queryOptions: (value) => value,
      useQuery: (value) => {
        options = value;
        return {
          refetch: async () => {
            refreshes++;
          },
        };
      },
    },
  })('../hooks/useRegistrationPolicy.ts');
  api.useRegistrationPolicy(allEnabled);
  assert.equal(options.staleTime, 0);
  assert.ok(options.refetchInterval > 0 && options.refetchInterval <= 15_000);
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('pageshow'));
  assert.equal(refreshes, 2);
  events.notifyRegistrationPolicyChanged();
  assert.equal(refreshes, 3);
  assert.equal(storageWrites[0][0], events.REGISTRATION_POLICY_STORAGE_KEY);
  window.dispatchEvent(
    Object.assign(new Event('storage'), {
      key: events.REGISTRATION_POLICY_STORAGE_KEY,
    }),
  );
  assert.equal(refreshes, 4);
  window.dispatchEvent(
    Object.assign(new Event('storage'), { key: 'unrelated-setting' }),
  );
  assert.equal(refreshes, 4);
  window.localStorage.setItem = () => {
    throw new Error('storage blocked');
  };
  assert.doesNotThrow(() => events.notifyRegistrationPolicyChanged());
  assert.equal(refreshes, 5);
  cleanup();
  window.dispatchEvent(new Event('focus'));
  events.notifyRegistrationPolicyChanged();
  window.dispatchEvent(
    Object.assign(new Event('storage'), {
      key: events.REGISTRATION_POLICY_STORAGE_KEY,
    }),
  );
  assert.equal(refreshes, 5);
  const signal = new AbortController().signal;
  const network = t.mock.method(global, 'fetch', async (url, init) => {
    assert.equal(url, '/api/server-config');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.signal, signal);
    return {
      ok: true,
      json: async () => ({
        ...allEnabled,
        allowRegister: false,
        SiteName: 'Fixture TV',
      }),
    };
  });
  assert.deepEqual(await options.queryFn({ signal }), {
    ...allEnabled,
    allowRegister: false,
  });
  network.mock.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ error: 'unavailable' }),
  }));
  await assert.rejects(options.queryFn({ signal }), /注册设置无效/);
});
