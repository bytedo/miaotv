const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createComponentLoader } = require('./component-test-loader.cjs');

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  return React.isValidElement(node)
    ? [node, ...elements(node.props.children)]
    : [];
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (React.isValidElement(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : '';
}

function mount(t) {
  const previousDocument = global.document;
  global.document = { body: {} };
  t.after(() => {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  });
  const slots = [];
  let cursor = 0;
  const hooks = {
    ...React,
    useEffect() {},
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: initial };
      return [
        slots[index].value,
        (value) => {
          slots[index].value = value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
  };
  const requests = [];
  let response = { ok: true, data: { ok: true, code: 'MIAO-2026' } };
  let gate;
  let tree;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, '/api/admin/invites');
    if (!options)
      return { ok: true, json: async () => ({ ok: true, codes: [] }) };
    assert.equal(options.method, 'POST');
    requests.push(JSON.parse(options.body));
    if (gate) await gate;
    return { ok: response.ok, json: async () => response.data };
  });
  const Component = createComponentLoader({
    react: hooks,
    '@/components/admin/AdminPortal': { createPortal: (children) => children },
  })('components/InviteCodeManager.tsx').default;
  function render() {
    cursor = 0;
    tree = Component();
  }
  function find(predicate) {
    const matches = elements(tree).filter(predicate);
    assert.equal(matches.length, 1, 'expected one matching control');
    return matches[0];
  }
  function open() {
    find(
      (node) => node.type === 'button' && text(node) === '创建邀请码',
    ).props.onClick();
    render();
  }
  render();
  open();
  return {
    requests,
    find,
    render,
    open,
    nodes: () => elements(tree),
    input: (id) => find((node) => node.props.id === id),
    change(id, value) {
      find((node) => node.props.id === id).props.onChange({
        target: { value },
      });
      render();
    },
    async submit() {
      await find((node) => node.type === 'form').props.onSubmit({
        preventDefault() {},
      });
      render();
    },
    response(value) {
      response = value;
    },
    delay(promise) {
      gate = promise;
    },
  };
}

test('invitation creation submits a normalized custom code with the selected limits', async (t) => {
  const modal = mount(t);
  modal.change('custom-invite-code', ' miao-2026_vip ');
  modal.change('invite-max-uses', '12');
  modal.change('invite-expires-days', '14');
  await modal.submit();
  assert.deepEqual(modal.requests, [
    { code: 'MIAO-2026_VIP', maxUses: 12, expiresIn: 1209600 },
  ]);
  assert.equal(
    modal.nodes().some((node) => node.type === 'form'),
    false,
  );
  modal.open();
  assert.equal(modal.input('custom-invite-code').props.value, '');
  modal.change('custom-invite-code', '   ');
  await modal.submit();
  assert.deepEqual(modal.requests[1], { maxUses: 12, expiresIn: 1209600 });
});

test('invalid custom codes stay in the modal and never reach the server', async (t) => {
  const modal = mount(t);
  modal.change('custom-invite-code', 'ab/c');
  await modal.submit();
  assert.equal(modal.requests.length, 0);
  assert.equal(modal.input('custom-invite-code').props.value, 'ab/c');
  assert.match(text(modal.find((node) => node.props.role === 'alert')), /4–32/);
});

test('duplicate code errors preserve the draft and allow another submission', async (t) => {
  const modal = mount(t);
  modal.change('custom-invite-code', 'existing-code');
  modal.change('invite-max-uses', '3');
  modal.response({ ok: false, data: { error: '邀请码已存在，请更换一个' } });
  await modal.submit();
  assert.equal(modal.input('custom-invite-code').props.value, 'existing-code');
  assert.equal(modal.input('invite-max-uses').props.value, 3);
  assert.match(
    text(modal.find((node) => node.props.role === 'alert')),
    /已存在/,
  );
  modal.change('custom-invite-code', 'replacement-code');
  modal.response({ ok: true, data: { ok: true, code: 'REPLACEMENT-CODE' } });
  await modal.submit();
  assert.equal(modal.requests.length, 2);
  assert.equal(modal.requests[1].code, 'REPLACEMENT-CODE');
  assert.equal(
    modal.nodes().some((node) => node.type === 'form'),
    false,
  );
});

test('rapid form submissions create at most one invitation while the request is pending', async (t) => {
  const modal = mount(t);
  let release;
  modal.delay(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const first = modal.submit();
  const second = modal.submit();
  modal.render();
  assert.equal(modal.requests.length, 1);
  assert.equal(
    modal.find((node) => node.type === 'button' && node.props.type === 'submit')
      .props.disabled,
    true,
  );
  modal
    .find((node) => node.props['aria-label'] === '关闭创建邀请码')
    .props.onClick();
  modal.render();
  assert.equal(
    modal.nodes().some((node) => node.type === 'form'),
    true,
  );
  release();
  await Promise.all([first, second]);
  assert.equal(modal.requests.length, 1);
});
