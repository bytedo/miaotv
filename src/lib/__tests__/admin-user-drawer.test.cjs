const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createComponentLoader } = require('./component-test-loader.cjs');

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const emptyComponent = () => null;

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (React.isValidElement(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : '';
}

const button = (label) => (node) =>
  node.type === 'button' && text(node).trim() === label;
const aria = (label) => (node) => node.props['aria-label'] === label;
const isDialog = (node) => node.props.role === 'dialog';

// A deterministic component renderer: run the actual TSX, hooks, effects and
// event handlers without Next, a browser, environment files or a database.
function mountUsers(
  t,
  initialUsers,
  auth = { uid: '1', username: 'admin' },
  role = 'owner',
) {
  const previousDocument = global.document;
  const previousWindow = global.window;
  const focusTarget = { focus() {}, isConnected: true };
  global.document = {
    body: { style: { overflow: '' } },
    documentElement: { clientWidth: 1280 },
    activeElement: focusTarget,
    addEventListener() {},
    removeEventListener() {},
  };
  global.window = {
    innerWidth: 1280,
    addEventListener() {},
    removeEventListener() {},
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const requests = [];
  const network = [];
  const alerts = [];
  const navigations = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(
      url === '/api/admin/user' || url === '/api/admin/user-tvbox-token',
      'only mocked account actions may be requested: ' + url,
    );
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push(body);
    network.push({ url, method: options.method, body });
    return {
      ok: true,
      json: async () => ({ ok: true, success: true, requiresRelogin: false }),
    };
  });

  const frames = new Map();
  t.after(() => {
    for (const current of frames.values()) {
      current.hooks.forEach((hook) => hook?.cleanup?.());
    }
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  let frame;
  let hookIndex = 0;
  let dirty = false;
  let pendingEffects = [];
  let visited;
  let users = initialUsers;
  let tree;
  const sameDependencies = (left, right) =>
    left &&
    right &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const react = {
    ...React,
    useState(initial) {
      const target = frame;
      const index = hookIndex++;
      if (!target.hooks[index]) {
        target.hooks[index] = {
          value: typeof initial === 'function' ? initial() : initial,
        };
      }
      const hook = target.hooks[index];
      if (!hook.setValue) {
        hook.setValue = (next) => {
          const value = typeof next === 'function' ? next(hook.value) : next;
          if (!Object.is(value, hook.value)) {
            hook.value = value;
            dirty = true;
          }
        };
      }
      return [hook.value, hook.setValue];
    },
    useRef(initial) {
      const index = hookIndex++;
      if (!frame.hooks[index]) frame.hooks[index] = { current: initial };
      return frame.hooks[index];
    },
    useMemo(create, dependencies) {
      const index = hookIndex++;
      if (!sameDependencies(frame.hooks[index]?.dependencies, dependencies)) {
        frame.hooks[index] = { dependencies, value: create() };
      }
      return frame.hooks[index].value;
    },
    useCallback(callback, dependencies) {
      return react.useMemo(() => callback, dependencies);
    },
    useContext() {
      return true;
    },
    useEffect(effect, dependencies) {
      const index = hookIndex++;
      const previous = frame.hooks[index];
      if (!sameDependencies(previous?.dependencies, dependencies)) {
        const hook = { dependencies, cleanup: previous?.cleanup };
        frame.hooks[index] = hook;
        pendingEffects.push(() => {
          hook.cleanup?.();
          hook.cleanup = effect();
        });
      }
    },
    useId() {
      const index = hookIndex++;
      if (!frame.hooks[index])
        frame.hooks[index] = { value: 'test-id-' + frames.size + '-' + index };
      return frame.hooks[index].value;
    },
  };
  react.useLayoutEffect = react.useEffect;
  const overrides = {
    react,
    'next/navigation': {
      useRouter: () => ({ replace: (url) => navigations.push(url) }),
    },
    '@/lib/auth': { getAuthInfoFromBrowserCookie: () => auth },
    '@/components/admin/AdminPortal': { createPortal: (children) => children },
    './AdminPortal': { createPortal: (children) => children },
    './user-action-drawer.css': {},
    './user-management-drawer.css': {},
    '@/components/UserApprovalModal': emptyComponent,
    './shared': {
      AlertModal: emptyComponent,
      buttonStyles: {},
      useAlertModal: () => ({
        alertModal: { isOpen: false },
        showAlert: (alert) => alerts.push(alert),
        hideAlert() {},
      }),
      useLoadingState: () => ({
        isLoading: () => false,
        withLoading: async (_key, action) => action(),
      }),
      showError: (message) => alerts.push({ type: 'error', message }),
      showSuccess: (message) => alerts.push({ type: 'success', message }),
    },
  };
  const load = createComponentLoader(overrides);
  overrides['./AdminPrimitives'] = load('components/admin/AdminPrimitives.tsx');
  overrides['./UserActionDrawer'] = load(
    'components/admin/UserActionDrawer.tsx',
  );
  overrides['@/components/TVBoxTokenManager'] = load(
    'components/TVBoxTokenManager.tsx',
  );
  overrides['./UserDrawerOverview'] = load(
    'components/admin/UserDrawerOverview.tsx',
  );
  const Component = load('components/admin/UserManagement.tsx').default;
  let config = {
    SiteConfig: { ShowAdultContent: false },
    UserConfig: {
      Users: users,
      Tags: [
        { name: 'cinema', enabledApis: ['second'] },
        { name: 'staff', enabledApis: ['first'] },
      ],
    },
    SourceConfig: [
      { key: 'first', name: 'First source', api: 'https://first.example.test' },
      {
        key: 'second',
        name: 'Second source',
        api: 'https://second.example.test',
      },
    ],
  };

  function resolve(node, path) {
    if (Array.isArray(node)) {
      return node.map((child, index) =>
        resolve(
          child,
          path +
            '/' +
            (React.isValidElement(child) && child.key !== null
              ? child.key
              : index),
        ),
      );
    }
    if (!React.isValidElement(node)) return node;
    if (typeof node.type === 'function') {
      visited.add(path);
      const previousFrame = frame;
      const previousIndex = hookIndex;
      let current = frames.get(path);
      if (!current || current.type !== node.type) {
        current?.hooks.forEach((hook) => hook?.cleanup?.());
        current = { type: node.type, hooks: [] };
        frames.set(path, current);
      }
      frame = current;
      hookIndex = 0;
      const rendered = node.type(node.props);
      frame = previousFrame;
      hookIndex = previousIndex;
      return resolve(rendered, path + '/render');
    }
    return React.cloneElement(node, {
      children: resolve(node.props.children, path + '/children'),
    });
  }

  function render() {
    let attempts = 0;
    do {
      assert.ok(attempts++ < 20, 'component effects must settle');
      dirty = false;
      pendingEffects = [];
      visited = new Set();
      tree = resolve(
        React.createElement(Component, {
          config,
          role,
          refreshConfig: async () => {},
        }),
        'root',
      );
      for (const [path, current] of frames) {
        if (visited.has(path)) continue;
        current.hooks.forEach((hook) => hook?.cleanup?.());
        frames.delete(path);
      }
      pendingEffects.forEach((effect) => effect());
    } while (dirty);
  }
  function findAll(predicate, node = tree) {
    return elements(node).filter(predicate);
  }
  function find(predicate, node = tree) {
    const matches = findAll(predicate, node);
    assert.equal(matches.length, 1, 'expected exactly one matching control');
    return matches[0];
  }
  function rows() {
    return elements(find((node) => node.type === 'tbody')).filter(
      (node) => node.type === 'tr' && node.key !== null,
    );
  }
  async function click(predicate, node = tree) {
    const control = find(predicate, node);
    assert.ok(!control.props.disabled, 'the control must be enabled');
    const event = {
      currentTarget: focusTarget,
      stopPropagation() {},
      preventDefault() {},
    };
    const pending = control.props.onClick
      ? control.props.onClick(event)
      : control.props.type === 'submit'
        ? find(
            (element) =>
              element.type === 'form' &&
              (!control.props.form || element.props.id === control.props.form),
          ).props.onSubmit(event)
        : assert.fail('the control must handle clicks or submit its form');
    render();
    await pending;
    await nextTick();
    render();
  }
  render();
  return {
    requests,
    network,
    alerts,
    navigations,
    find,
    findAll,
    rows,
    click,
    dialog: () => find(isDialog),
    async open(uid) {
      const row = rows().find((entry) => entry.key === uid);
      assert.ok(row, 'the requested UID must be present in the table');
      await click(button('操作'), row);
      return find(isDialog);
    },
    change(predicate, value, node = tree) {
      const control = find(predicate, node);
      assert.ok(!control.props.disabled);
      control.props.onChange({
        target: typeof value === 'object' ? value : { value },
      });
      render();
    },
    async submit(node = tree) {
      const pending = find(
        (element) => element.type === 'form',
        node,
      ).props.onSubmit({
        preventDefault() {},
      });
      render();
      await pending;
      await nextTick();
      render();
    },
    async advance(milliseconds) {
      t.mock.timers.tick(milliseconds);
      await nextTick();
      render();
    },
    setUsers(next) {
      users = next;
      config = {
        ...config,
        UserConfig: { ...config.UserConfig, Users: users },
      };
      render();
    },
  };
}

const fixtureUsers = () => [
  { uid: '1', username: 'admin', role: 'owner' },
  {
    uid: '2',
    username: 'viewer',
    role: 'user',
    email: 'viewer@example.test',
    tags: ['cinema'],
    enabledApis: ['first'],
    tvboxToken: 'viewer-offline-token',
    tvboxEnabledSources: ['second'],
  },
  { uid: '12', username: 'alternate', role: 'user' },
];

const actionLabels = [
  '修改用户名',
  '修改密码',
  '配置用户组',
  '配置采集源权限',
  '配置 TVBox',
  '设为管理员',
  '取消管理员',
  '封禁用户',
  '解除封禁',
  '删除用户',
  '通过审核',
  '拒绝申请',
];

// The numeric-ID suite reuses this fixture without registering these tests twice.
module.exports = { mountUsers, elements, text, fixtureUsers, button, aria };

if (require.main === module) {
  test('each user has one action entry while the seven-column table keeps identity and group information', async (t) => {
    const panel = mountUsers(t, fixtureUsers());
    const headers = elements(
      panel.find((node) => node.type === 'thead'),
    ).filter((node) => node.type === 'th');
    assert.equal(headers.length, 7);
    assert.deepEqual(headers.slice(1).map(text), [
      'ID',
      '用户名',
      '角色',
      '状态',
      '用户组',
      '操作',
    ]);
    for (const row of panel.rows()) {
      const controls = elements(row).filter((node) => node.type === 'button');
      assert.equal(
        controls.length,
        1,
        'row ' + row.key + ' has one action entry',
      );
      assert.equal(text(controls[0]).trim(), '操作');
      assert.equal(
        elements(row).filter((node) => node.type === 'td').length,
        7,
      );
    }
    const viewer = panel.rows().find((row) => row.key === '2');
    assert.ok(text(viewer).includes('viewer@example.test'));
    assert.ok(text(viewer).includes('cinema'));
    assert.ok(
      text(panel.rows().find((row) => row.key === '12')).includes('null'),
    );
    assert.equal(panel.findAll(isDialog).length, 0);
    const detail = await panel.open('2');
    for (const expected of ['viewer', 'viewer@example.test', 'cinema', 'ID']) {
      assert.ok(text(detail).includes(expected), 'details retain ' + expected);
    }
  });

  test('drawer actions follow the owner and administrator permission boundaries', async (t) => {
    const edit = [
      '修改用户名',
      '修改密码',
      '配置用户组',
      '配置采集源权限',
      '配置 TVBox',
    ];
    const configure = ['配置用户组', '配置采集源权限', '配置 TVBox'];
    const users = [
      ...fixtureUsers().map((user) =>
        user.uid === '12' ? { ...user, role: 'admin' } : user,
      ),
      { uid: '3', username: 'other_admin', role: 'admin' },
    ];
    const cases = [
      {
        name: 'owner manages a user',
        role: 'owner',
        uid: '1',
        target: '2',
        allowed: [...edit, '设为管理员', '封禁用户', '删除用户'],
      },
      {
        name: 'owner manages an administrator',
        role: 'owner',
        uid: '1',
        target: '3',
        allowed: [...edit, '取消管理员', '封禁用户', '删除用户'],
      },
      {
        name: 'owner account stays protected',
        role: 'owner',
        uid: '1',
        target: '1',
        allowed: configure,
      },
      {
        name: 'administrator manages an ordinary user without promotion',
        role: 'admin',
        uid: '12',
        target: '2',
        allowed: [...edit, '封禁用户', '删除用户'],
      },
      {
        name: 'administrator edits their own UID',
        role: 'admin',
        uid: '12',
        target: '12',
        allowed: edit,
      },
      {
        name: 'another administrator is read-only',
        role: 'admin',
        uid: '12',
        target: '3',
        allowed: [],
      },
      {
        name: 'owner is read-only to an administrator',
        role: 'admin',
        uid: '12',
        target: '1',
        allowed: [],
      },
    ];
    for (const scenario of cases) {
      await t.test(scenario.name, async (subtest) => {
        const operator = users.find((user) => user.uid === scenario.uid);
        const panel = mountUsers(subtest, users, operator, scenario.role);
        const detail = await panel.open(scenario.target);
        const available = actionLabels.filter((label) =>
          elements(detail).some(
            (node) => button(label)(node) && !node.props.disabled,
          ),
        );
        assert.deepEqual(available.sort(), [...scenario.allowed].sort());
      });
    }
  });

  test('return and cancel keep each single-user form inside the same drawer without submitting', async (t) => {
    const panel = mountUsers(t, fixtureUsers());
    await panel.open('2');
    for (const action of [
      '修改用户名',
      '修改密码',
      '配置用户组',
      '配置采集源权限',
      '配置 TVBox',
      '删除用户',
    ]) {
      for (const back of [aria('返回用户详情'), button('取消')]) {
        await panel.click(button(action), panel.dialog());
        assert.equal(
          panel.findAll(isDialog).length,
          1,
          action + ' does not open a second dialog',
        );
        assert.ok(text(panel.dialog()).includes('viewer'));
        if (action === '配置 TVBox') {
          assert.equal(
            panel.findAll(aria('关闭 TVBox Token 管理')).length,
            0,
            'TVBox uses the drawer navigation',
          );
        }
        if (action === '修改用户名') {
          panel.change(
            (node) => node.props.id === 'admin-rename-new-username',
            'unsaved_name',
          );
        }
        await panel.click(back, panel.dialog());
        assert.equal(panel.findAll(isDialog).length, 1);
        assert.ok(panel.find(button('修改用户名'), panel.dialog()));
        assert.equal(
          panel.findAll((node) => node.props.id === 'admin-rename-new-username')
            .length,
          0,
        );
      }
    }
    assert.deepEqual(panel.requests, []);
    await panel.click(aria('关闭用户操作'), panel.dialog());
    assert.equal(panel.findAll(isDialog).length, 0);
  });

  test('drawer details follow the selected UID through an external rename and username reuse', async (t) => {
    const panel = mountUsers(t, fixtureUsers());
    await panel.open('2');
    const renamed = {
      ...fixtureUsers()[1],
      username: 'renamed_elsewhere',
      email: 'same-uid@example.test',
    };
    panel.setUsers([
      fixtureUsers()[0],
      renamed,
      {
        uid: '25',
        username: 'viewer',
        role: 'user',
        email: 'replacement@example.test',
        tvboxToken: 'replacement-token',
      },
    ]);
    const detail = text(panel.dialog());
    assert.ok(detail.includes('renamed_elsewhere'));
    assert.ok(detail.includes('same-uid@example.test'));
    assert.ok(!detail.includes('replacement@example.test'));
    await panel.click(button('配置 TVBox'), panel.dialog());
    assert.ok(text(panel.dialog()).includes('viewer-offline-token'));
    assert.ok(!text(panel.dialog()).includes('replacement-token'));
    const firstSource = panel.find(
      (node) => node.type === 'label' && text(node).includes('First source'),
      panel.dialog(),
    );
    panel.change(
      (node) => node.type === 'input',
      { checked: true },
      firstSource,
    );
    await panel.click(button('保存配置'), panel.dialog());
    assert.deepEqual(panel.network, [
      {
        url: '/api/admin/user-tvbox-token',
        method: 'POST',
        body: {
          targetUid: '2',
          tvboxEnabledSources: ['second', 'first'],
          regenerateToken: false,
        },
      },
    ]);
    await panel.advance(1500);
    assert.ok(panel.find(button('修改用户名'), panel.dialog()));
  });

  test('removing the selected UID closes an open draft even if another user reuses its name', async (t) => {
    const panel = mountUsers(t, fixtureUsers());
    await panel.open('2');
    await panel.click(button('修改用户名'), panel.dialog());
    panel.change(
      (node) => node.props.id === 'admin-rename-new-username',
      'unsaved_name',
    );
    panel.setUsers([
      fixtureUsers()[0],
      {
        uid: '25',
        username: 'viewer',
        role: 'user',
        email: 'replacement@example.test',
      },
    ]);
    assert.equal(panel.findAll(isDialog).length, 0);
    assert.deepEqual(panel.requests, []);
    panel.setUsers(fixtureUsers());
    assert.equal(
      panel.findAll(isDialog).length,
      0,
      'a later refresh cannot reopen the discarded draft',
    );
  });

  test('saving source permissions preserves personal selection instead of copying inherited group sources', async (t) => {
    for (const enabledApis of [['first'], []]) {
      await t.test(
        enabledApis.length ? 'personal source override' : 'group inheritance',
        async (subtest) => {
          const users = fixtureUsers().map((user) =>
            user.uid === '2' ? { ...user, enabledApis } : user,
          );
          const panel = mountUsers(subtest, users);
          await panel.click(button('配置采集源权限'), await panel.open('2'));
          await panel.click(button('保存权限'), panel.dialog());
          assert.deepEqual(panel.requests, [
            {
              action: 'updateUserApis',
              targetUid: '2',
              enabledApis,
            },
          ]);
          assert.ok(panel.find(button('配置采集源权限'), panel.dialog()));
        },
      );
    }
  });

  test('closing a draft and opening another UID starts from that account details', async (t) => {
    const panel = mountUsers(t, fixtureUsers());
    await panel.open('2');
    await panel.click(button('修改用户名'), panel.dialog());
    panel.change(
      (node) => node.props.id === 'admin-rename-new-username',
      'unsaved_name',
    );
    await panel.click(aria('关闭用户操作'), panel.dialog());
    await panel.open('12');
    assert.ok(text(panel.dialog()).includes('alternate'));
    assert.ok(!text(panel.dialog()).includes('viewer@example.test'));
    assert.equal(
      panel.findAll((node) => node.props.id === 'admin-rename-new-username')
        .length,
      0,
    );
    await panel.click(button('修改用户名'), panel.dialog());
    assert.equal(
      panel.find((node) => node.props.id === 'admin-rename-new-username').props
        .value,
      'alternate',
    );
    assert.deepEqual(panel.requests, []);
  });

  test('administrators can review a pending ordinary user but not themselves or protected accounts', async (t) => {
    const users = [
      ...fixtureUsers().map((user) => ({
        ...user,
        pending: true,
        role: user.uid === '12' ? 'admin' : user.role,
      })),
      { uid: '3', username: 'other_admin', role: 'admin', pending: true },
    ];
    for (const uid of ['2', '12', '3', '1']) {
      await t.test('pending UID ' + uid, async (subtest) => {
        const panel = mountUsers(
          subtest,
          users,
          { uid: '12', username: 'alternate' },
          'admin',
        );
        await panel.open(uid);
        for (const action of ['通过审核', '拒绝申请']) {
          assert.equal(
            panel.findAll(button(action), panel.dialog()).length,
            uid === '2' ? 1 : 0,
          );
        }
        if (uid === '2') {
          await panel.click(button('通过审核'), panel.dialog());
          assert.deepEqual(panel.requests, [
            { action: 'approve', targetUid: '2' },
          ]);
        } else {
          assert.deepEqual(panel.requests, []);
        }
      });
    }
  });

  test('pending and banned status expose the appropriate actions for the same UID', async (t) => {
    const users = fixtureUsers();
    users[1] = { ...users[1], pending: true };
    const panel = mountUsers(t, users);
    await panel.open('2');
    assert.ok(panel.find(button('通过审核'), panel.dialog()));
    assert.ok(panel.find(button('拒绝申请'), panel.dialog()));
    await panel.click(button('拒绝申请'), panel.dialog());
    assert.equal(panel.findAll(isDialog).length, 1);
    assert.ok(panel.find(button('确认拒绝'), panel.dialog()));
    await panel.click(button('取消'), panel.dialog());
    assert.deepEqual(panel.requests, []);
    panel.setUsers(
      users.map((user) =>
        user.uid === '2' ? { ...user, pending: false, banned: true } : user,
      ),
    );
    assert.equal(panel.findAll(button('通过审核'), panel.dialog()).length, 0);
    assert.equal(panel.findAll(button('拒绝申请'), panel.dialog()).length, 0);
    assert.ok(panel.find(button('解除封禁'), panel.dialog()));
    assert.equal(panel.findAll(button('封禁用户'), panel.dialog()).length, 0);
    await panel.click(button('解除封禁'), panel.dialog());
    assert.deepEqual(panel.requests, [{ action: 'unban', targetUid: '2' }]);
  });
}
