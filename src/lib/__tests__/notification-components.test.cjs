const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createComponentLoader } = require('./component-test-loader.cjs');

// Run the real TSX handlers and their state/effect updates without a DOM.
// This checks controlled form behavior, not browser input parsing or layout.
function mountForm(file, initialProps) {
  const hooks = [];
  let props = initialProps;
  let tree;
  let hookIndex = 0;
  let pendingRender = true;
  let pendingEffects = [];
  const Component = createComponentLoader({
    react: {
      ...React,
      useState(initialValue) {
        const index = hookIndex++;
        if (!hooks[index]) {
          const state = {
            value: typeof initialValue === 'function' ? initialValue() : initialValue,
          };
          state.set = next => {
            const value = typeof next === 'function' ? next(state.value) : next;
            if (!Object.is(value, state.value)) {
              state.value = value;
              pendingRender = true;
            }
          };
          hooks[index] = state;
        }
        return [hooks[index].value, hooks[index].set];
      },
      useEffect(effect, dependencies) {
        const index = hookIndex++;
        const previous = hooks[index];
        if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
          hooks[index] = { dependencies };
          pendingEffects.push(effect);
        }
      },
    },
  })(file).default;

  function flush() {
    let renders = 0;
    while (pendingRender) {
      assert.ok(++renders < 25, 'form updates should settle');
      pendingRender = false;
      pendingEffects = [];
      hookIndex = 0;
      tree = Component(props);
      for (const effect of pendingEffects) effect();
    }
  }

  function entries(node, inheritedDisabled = false) {
    if (Array.isArray(node)) return node.flatMap(child => entries(child, inheritedDisabled));
    if (!React.isValidElement(node)) return [];
    const disabled = inheritedDisabled || Boolean(node.props.disabled);
    return [{ node, disabled }, ...entries(node.props.children, disabled)];
  }

  function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    if (React.isValidElement(node)) return text(node.props.children);
    return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
  }

  function find(predicate) {
    const matches = entries(tree).filter(({ node }) => predicate(node));
    assert.equal(matches.length, 1, 'expected exactly one matching form control');
    return matches[0];
  }

  const control = label => find(node => node.type !== 'fieldset' && node.props['aria-label'] === label);
  const button = label => find(node => node.type === 'button' && text(node) === label);
  flush();
  return {
    field: label => control(label).node.props,
    button: label => button(label).node.props,
    busy: () => tree.props.disabled,
    status: () => entries(tree).filter(({ node }) => node.props.role === 'status').map(({ node }) => text(node)).join('\n'),
    updateProps(next) {
      props = { ...props, ...next };
      pendingRender = true;
      flush();
    },
    change(label, value) {
      const target = control(label);
      assert.equal(target.disabled, false, `${label} should be editable`);
      target.node.props.onChange({ target: typeof value === 'object' ? value : { value } });
      flush();
    },
    async click(label) {
      const target = button(label);
      assert.equal(target.disabled, false, `${label} should be enabled`);
      const completion = target.node.props.onClick();
      flush();
      try {
        await completion;
      } finally {
        flush();
      }
    },
  };
}

const emailConfig = {
  enabled: true,
  smtpHost: 'smtp.example.test',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: 'sender@example.test',
  smtpPass: '******',
  senderName: 'MiaoTV',
  senderEmail: 'sender@example.test',
};
const webhookConfig = {
  enabled: true,
  url: 'https://example.test/webhook',
  secret: '******',
  notifyOnRegister: true,
  messageTemplate: 'New user: {username}',
};
const unusedSave = async () => assert.fail('unexpected save request');
const unusedTest = async () => assert.fail('unexpected notification request');

test('email rejects empty, fractional and out-of-range SMTP ports before saving', async () => {
  const saves = [];
  const form = mountForm('components/EmailConfig.tsx', {
    config: { ...emailConfig },
    onSave: async config => saves.push(config),
    onTest: unusedTest,
  });

  for (const port of [NaN, 465.5, 0, -1, 65536]) {
    form.change('SMTP 端口', { valueAsNumber: port });
    assert.equal(form.field('SMTP 端口').value, Number.isNaN(port) ? '' : port);
    await form.click('保存配置');
    assert.equal(saves.length, 0);
    assert.match(form.status(), /SMTP 端口必须是 1 到 65535 之间的整数/);
    assert.equal(form.button('发送测试').disabled, true);
  }

  form.change('SMTP 端口', { valueAsNumber: 587 });
  await form.click('保存配置');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].smtpPort, 587);
});

test('email preserves drafts on equal saved values and synchronizes changed saved values', () => {
  const form = mountForm('components/EmailConfig.tsx', {
    config: { ...emailConfig }, onSave: unusedSave, onTest: unusedTest,
  });
  form.change('SMTP 服务器', 'draft.example.test');
  form.updateProps({ config: Object.fromEntries(Object.entries(emailConfig).reverse()) });
  assert.equal(form.field('SMTP 服务器').value, 'draft.example.test');
  assert.equal(form.button('发送测试').disabled, true);

  form.updateProps({ config: { ...emailConfig, senderName: 'Saved sender name' } });
  assert.equal(form.field('SMTP 服务器').value, emailConfig.smtpHost);
  assert.equal(form.field('发件人名称').value, 'Saved sender name');
  assert.equal(form.button('发送测试').disabled, false);
});

test('email applies an unchanged masked save response and clears dirty state', async () => {
  let finishSave;
  const saves = [];
  const form = mountForm('components/EmailConfig.tsx', {
    config: { ...emailConfig },
    onSave: async config => {
      saves.push(config);
      await new Promise(resolve => { finishSave = resolve; });
      form.updateProps({ config: { ...emailConfig } });
    },
    onTest: unusedTest,
  });
  form.change('SMTP 密码', 'replacement-password');
  assert.equal(form.button('发送测试').disabled, true);
  const saving = form.click('保存配置');
  assert.equal(form.busy(), true);
  finishSave();
  await saving;

  assert.equal(saves[0].smtpPass, 'replacement-password');
  assert.equal(form.field('SMTP 密码').value, '******');
  assert.equal(form.button('发送测试').disabled, false);
  assert.equal(form.busy(), false);
  assert.match(form.status(), /配置已保存/);
});

test('changing the test recipient clears both success and failure feedback', async () => {
  const recipients = [];
  const form = mountForm('components/EmailConfig.tsx', {
    config: { ...emailConfig },
    onSave: unusedSave,
    onTest: async recipient => {
      recipients.push(recipient);
      return recipients.length === 1 ? { success: true } : { success: false, error: 'Delivery unavailable' };
    },
  });
  form.change('测试邮箱地址', 'first@example.test');
  await form.click('发送测试');
  assert.match(form.status(), /测试邮件发送成功/);
  form.change('测试邮箱地址', 'second@example.test');
  assert.equal(form.status(), '');
  await form.click('发送测试');
  assert.match(form.status(), /Delivery unavailable/);
  form.change('测试邮箱地址', 'third@example.test');
  assert.equal(form.status(), '');
  assert.deepEqual(recipients, ['first@example.test', 'second@example.test']);
});

test('webhook preserves drafts on equal refreshes and synchronizes changed saved values', () => {
  const form = mountForm('components/WebhookConfig.tsx', {
    config: { ...webhookConfig }, onSave: unusedSave, onTest: unusedTest,
  });
  form.change('Webhook URL', 'https://example.test/draft');
  form.change('Webhook 消息模板', 'Draft template');
  form.updateProps({ config: Object.fromEntries(Object.entries(webhookConfig).reverse()) });
  assert.equal(form.field('Webhook URL').value, 'https://example.test/draft');
  assert.equal(form.field('Webhook 消息模板').value, 'Draft template');
  assert.equal(form.button('测试').disabled, true);

  form.updateProps({ config: { ...webhookConfig, url: 'https://example.test/saved' } });
  assert.equal(form.field('Webhook URL').value, 'https://example.test/saved');
  assert.equal(form.field('Webhook 消息模板').value, webhookConfig.messageTemplate);
  assert.equal(form.button('测试').disabled, false);
});

test('webhook applies an unchanged masked save response and clears dirty state', async () => {
  const saves = [];
  const form = mountForm('components/WebhookConfig.tsx', {
    config: { ...webhookConfig },
    onSave: async config => {
      saves.push(config);
      form.updateProps({ config: { ...webhookConfig } });
    },
    onTest: unusedTest,
  });
  form.change('Webhook 签名密钥', 'replacement-secret');
  assert.equal(form.button('测试').disabled, true);
  await form.click('保存配置');
  assert.equal(saves[0].secret, 'replacement-secret');
  assert.equal(form.field('Webhook 签名密钥').value, '******');
  assert.equal(form.button('测试').disabled, false);
  assert.match(form.status(), /配置保存成功/);
});
