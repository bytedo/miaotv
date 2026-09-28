const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');

const emailSettings = () => ({
  enabled: true,
  smtpHost: 'smtp.example.test',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: 'fixture-user',
  smtpPass: 'fixture-mail-secret',
  senderName: 'Fixture sender',
  senderEmail: 'sender@example.test',
});
const webhookSettings = () => ({
  enabled: true,
  url: 'https://hooks.example.test/notify',
  secret: 'fixture-hook-secret',
  notifyOnRegister: true,
  messageTemplate: '',
});

function fixture(t) {
  const environment = {
    USERNAME: 'notification-owner',
    NEXT_PUBLIC_STORAGE_TYPE: 'redis',
    SITE_BASE: 'https://miaotv.example.test',
    NEXT_PUBLIC_BASE_URL: 'https://legacy.example.test',
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(global, 'fetch', async () => {
    throw new Error('Unexpected network access in notification test');
  });
  t.mock.method(console, 'error', () => {});
  const state = {
    config: {
      SiteConfig: { SiteName: 'Fixture TV', DefaultUserTags: [] },
      UserConfig: {
        AllowRegister: true,
        RequireApproval: true,
        RequireInviteCode: false,
        Users: [
          { username: 'admin', role: 'admin' },
          { username: 'member', role: 'user', email: 'member@example.test' },
          { username: 'pending-admin', role: 'admin', pending: true },
          { username: 'banned-admin', role: 'admin', banned: true },
        ],
      },
      EmailConfig: emailSettings(),
      WebhookConfig: webhookSettings(),
    },
    saved: [],
    cacheClears: 0,
    transports: [],
    mail: [],
    closed: 0,
    hooks: [],
    events: [],
    users: new Map(),
    cache: new Map(),
    replies: [],
  };
  let lastUid = 1;
  for (const user of state.config.UserConfig.Users) {
    user.uid = String(++lastUid);
    state.users.set(user.username, { ...user });
  }
  const usernameFor = (ref) => [...state.users.values()].find((user) => user.uid === ref)?.username || ref;
  const configModule = {
    getConfig: async () => state.config,
    clearConfigCache: () => {
      state.cacheClears++;
    },
  };
  const db = {
    allocateUserUid: async () => String(++lastUid),
    getUserIdentity: async (username) => {
      const user = state.users.get(username);
      return user ? { uid: user.uid, username, storageKey: username } : null;
    },
    checkUserExist: async (ref) => state.users.has(usernameFor(ref)),
    getUserInfoV2: async (ref) => state.users.get(usernameFor(ref)) || null,
    getUserEmail: async (ref) => state.users.get(usernameFor(ref))?.email || null,
    getUsernameByEmail: async (email) =>
      [...state.users.values()].find((user) => user.email === email)
        ?.username || null,
    setUserEmail: async (ref, email) => {
      state.users.get(usernameFor(ref)).email = email;
    },
    saveAdminConfig: async (config) => {
      if (state.failSave) throw new Error('Fixture persistence failure');
      state.events.push('persist');
      state.saved.push(structuredClone(config));
      state.config = config;
    },
    createUserV2: async (
      username,
      _password,
      role,
      _tags,
      _oidc,
      _apis,
      email,
      metadata,
    ) => {
      state.users.set(username, { username, role, email, ...metadata });
    },
    deleteUser: async (username) => {
      state.users.delete(username);
    },
    deleteCache: async (key) => {
      state.cache.delete(key);
    },
  };
  class ProxyTargetError extends Error {
    status = 403;
  }
  const load = createSourceLoader({
    'next/server': {
      NextResponse: { json: (body, init) => Response.json(body, init) },
    },
    '@/lib/auth.server': {
      getVerifiedAuthInfo: async (request) => request.verifiedAuth || null,
    },
    './config': configModule,
    '@/lib/config': configModule,
    './db': { db },
    '@/lib/db': { db },
    './invite-code': {
      useInviteCode: async () => true,
      releaseInviteCode: async () => {},
    },
    '@/lib/password-reset-tokens': {
      generatePasswordResetToken: async (uid, email) => {
        state.cache.set('password_reset:fixture-reset-token', {
          uid,
          username: usernameFor(uid),
          email,
        });
        return 'fixture-reset-token';
      },
    },
    nodemailer: {
      createTransport: (options) => {
        state.transports.push(options);
        return {
          sendMail: async (message) => {
            state.events.push('mail');
            state.mail.push(message);
            if (state.smtpError) throw state.smtpError;
            return {
              accepted: [message.to],
              rejected: state.rejectRecipient ? [message.to] : [],
            };
          },
          close: () => {
            state.closed++;
          },
        };
      },
    },
    './proxy-security': {
      ProxyTargetError,
      fetchWithValidatedRedirects: async (url, init, options) => {
        state.events.push('webhook');
        state.hooks.push({ url, init, options });
        if (state.hookError) throw state.hookError;
        return state.replies.shift() || new Response('fixture');
      },
    },
  });
  const request = (body, username = environment.USERNAME) => ({
    verifiedAuth: username ? { username } : null,
    // Unsigned claims never become the verified auth used by admin-auth.
    cookies: {
      get: () => ({
        value: JSON.stringify({
          username: environment.USERNAME,
          role: 'owner',
        }),
      }),
    },
    json: async () => body,
  });
  const route = (name) => load('../app/api/' + name + '/route.ts');
  return { state, load, request, route, ProxyTargetError };
}

test('notification GET, save and test actions require the verified owner, including against unsigned owner claims', async (t) => {
  const f = fixture(t);
  for (const name of ['email', 'webhook']) {
    const route = f.route('admin/' + name);
    for (const operator of [
      null,
      'admin',
      'member',
      'pending-admin',
      'banned-admin',
    ]) {
      assert.equal(
        (await route.GET(f.request(undefined, operator))).status,
        403,
      );
      for (const action of ['save', 'test']) {
        assert.equal(
          (
            await route.POST(
              f.request(
                { action, config: {}, testEmail: 'recipient@example.test' },
                operator,
              ),
            )
          ).status,
          403,
        );
      }
    }
  }
  assert.equal(f.state.saved.length, 0);
  assert.equal(f.state.mail.length, 0);
  assert.equal(f.state.hooks.length, 0);
});

test('notification GET masks secrets without mutating persisted settings and all responses disable caching', async (t) => {
  const f = fixture(t);
  for (const [name, field, key] of [
    ['email', 'EmailConfig', 'smtpPass'],
    ['webhook', 'WebhookConfig', 'secret'],
  ]) {
    const response = await f.route('admin/' + name).GET(f.request());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.equal(data.config[key], '******');
    assert.notEqual(f.state.config[field][key], '******');
    delete f.state.config[field];
    assert.equal(
      (await (await f.route('admin/' + name).GET(f.request())).json()).config,
      null,
    );
  }
});

test('masked and omitted secrets survive saves, explicit new values replace them, and saving never sends a notification', async (t) => {
  const f = fixture(t);
  for (const [name, field, key] of [
    ['email', 'EmailConfig', 'smtpPass'],
    ['webhook', 'WebhookConfig', 'secret'],
  ]) {
    const route = f.route('admin/' + name);
    const previous = f.state.config[field][key];
    const masked = (await (await route.GET(f.request())).json()).config;
    let response = await route.POST(
      f.request({ action: 'save', config: masked }),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).config[key], '******');
    assert.equal(f.state.config[field][key], previous);
    delete masked[key];
    assert.equal(
      (await route.POST(f.request({ action: 'save', config: masked }))).status,
      200,
    );
    assert.equal(f.state.config[field][key], previous);
    response = await route.POST(
      f.request({
        action: 'save',
        config: { ...masked, [key]: 'fixture-new-secret' },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(f.state.config[field][key], 'fixture-new-secret');
    assert.equal(
      (
        await route.POST(
          f.request({
            action: 'save',
            config: { ...masked, enabled: false, [key]: '' },
          }),
        )
      ).status,
      200,
    );
    assert.equal(f.state.config[field][key], '');
  }
  assert.equal(f.state.cacheClears, 8);
  assert.equal(f.state.mail.length, 0);
  assert.equal(f.state.hooks.length, 0);
});

test('malformed notification settings and orphaned masks are rejected before storage or delivery', async (t) => {
  const f = fixture(t);
  const email = f.route('admin/email');
  const webhook = f.route('admin/webhook');
  for (const config of [
    null,
    [],
    {},
    ...[
      { enabled: 'true' },
      { smtpSecure: 'false' },
      { smtpPort: 0 },
      { smtpPort: 65536 },
      { smtpPort: 1.5 },
      { smtpHost: 'https://smtp.example.test' },
      { smtpPass: {} },
      { senderEmail: 'a@example.test,b@example.test' },
      { senderName: 'sender\r\nBcc: other@example.test' },
    ].map((change) => ({ ...emailSettings(), ...change })),
  ]) {
    assert.equal(
      (await email.POST(f.request({ action: 'save', config }))).status,
      400,
    );
  }
  for (const config of [
    null,
    [],
    {},
    ...[
      { enabled: 'true' },
      { notifyOnRegister: 'false' },
      { url: '' },
      { url: 'file:///fixture' },
      { url: 'https://user:pass@example.test/' },
      { url: 'https://{username}.example.test/' },
      { url: 'https://example.test/{unknown}' },
      { url: 'https://example.test/#fragment' },
      { secret: [] },
      { messageTemplate: 1 },
    ].map((change) => ({ ...webhookSettings(), ...change })),
  ]) {
    assert.equal(
      (await webhook.POST(f.request({ action: 'save', config }))).status,
      400,
    );
  }
  delete f.state.config.EmailConfig;
  delete f.state.config.WebhookConfig;
  assert.equal(
    (
      await email.POST(
        f.request({
          action: 'save',
          config: { ...emailSettings(), smtpPass: '******' },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await webhook.POST(
        f.request({
          action: 'save',
          config: { ...webhookSettings(), secret: '******' },
        }),
      )
    ).status,
    400,
  );
  f.state.config.EmailConfig = { ...emailSettings(), smtpPass: 42 };
  f.state.config.WebhookConfig = {
    ...webhookSettings(),
    secret: { invalid: true },
  };
  assert.equal(
    (
      await email.POST(
        f.request({
          action: 'save',
          config: { ...emailSettings(), smtpPass: '******' },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await webhook.POST(
        f.request({
          action: 'save',
          config: { ...webhookSettings(), secret: '******' },
        }),
      )
    ).status,
    400,
  );
  for (const route of [email, webhook]) {
    assert.equal((await route.POST(f.request(null))).status, 400);
    assert.equal(
      (await route.POST(f.request({ action: 'unknown' }))).status,
      400,
    );
    assert.equal(
      (
        await route.POST({
          ...f.request(),
          json: async () => {
            throw new SyntaxError('fixture');
          },
        })
      ).status,
      400,
    );
  }
  assert.equal(f.state.saved.length, 0);
  assert.equal(f.state.mail.length, 0);
  assert.equal(f.state.hooks.length, 0);
});

test('notification save failures leave the current cached config untouched and localStorage saves are rejected', async (t) => {
  const f = fixture(t);
  f.state.failSave = true;
  for (const [name, field] of [
    ['email', 'EmailConfig'],
    ['webhook', 'WebhookConfig'],
  ]) {
    const current = f.state.config[field];
    const response = await f
      .route('admin/' + name)
      .POST(
        f.request({ action: 'save', config: { ...current, enabled: false } }),
      );
    assert.equal(response.status, 500);
    assert.equal(f.state.config[field], current);
    assert.equal(current.enabled, true);
  }
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'localstorage';
  assert.equal(
    (
      await f
        .route('admin/email')
        .POST(f.request({ action: 'save', config: emailSettings() }))
    ).status,
    400,
  );
  assert.equal(
    (
      await f
        .route('admin/webhook')
        .POST(f.request({ action: 'save', config: webhookSettings() }))
    ).status,
    400,
  );
  assert.equal(f.state.saved.length, 0);
  assert.equal(f.state.cacheClears, 0);
});

test('email test actions validate one recipient and use saved credentials with bounded verified SMTP transport', async (t) => {
  const f = fixture(t);
  const route = f.route('admin/email');
  for (const testEmail of [
    '',
    [],
    'bad',
    'a@example.test,b@example.test',
    'a@example.test\r\nBcc: b@example.test',
  ])
    assert.equal(
      (await route.POST(f.request({ action: 'test', testEmail }))).status,
      400,
    );
  assert.equal(f.state.mail.length, 0);
  const response = await route.POST(
    f.request({ action: 'test', testEmail: ' Recipient@Example.Test ' }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(f.state.mail[0].to, 'recipient@example.test');
  assert.equal(f.state.transports[0].auth.pass, 'fixture-mail-secret');
  assert.equal(f.state.transports[0].tls.rejectUnauthorized, true);
  assert.ok(f.state.transports[0].connectionTimeout <= 15000);
  assert.ok(f.state.transports[0].socketTimeout <= 15000);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.saved.length, 0);
});

test('delivery failures are reported to test callers without leaking SMTP credentials or pretending success', async (t) => {
  const f = fixture(t);
  const route = f.route('admin/email');
  f.state.smtpError = Object.assign(
    new Error('fixture-mail-secret must not be returned'),
    { code: 'EAUTH' },
  );
  let response = await route.POST(
    f.request({ action: 'test', testEmail: 'recipient@example.test' }),
  );
  assert.equal(response.status, 502);
  let data = await response.json();
  assert.equal(data.success, false);
  assert.match(data.error, /身份验证失败/);
  assert.doesNotMatch(JSON.stringify(data), /fixture-mail-secret/);
  f.state.smtpError = null;
  f.state.rejectRecipient = true;
  response = await route.POST(
    f.request({ action: 'test', testEmail: 'recipient@example.test' }),
  );
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /收件地址/);
  f.state.config.EmailConfig.enabled = false;
  const before = f.state.transports.length;
  response = await route.POST(
    f.request({ action: 'test', testEmail: 'recipient@example.test' }),
  );
  assert.equal(response.status, 502);
  assert.equal(f.state.transports.length, before);
});

test('authenticated SMTP on a STARTTLS port requires TLS while explicitly anonymous SMTP omits authentication', async (t) => {
  const f = fixture(t);
  const api = f.load('emailService.ts');
  f.state.config.EmailConfig.smtpSecure = false;
  f.state.config.EmailConfig.smtpPort = 587;
  assert.equal(
    (await api.testEmailConfig('recipient@example.test')).success,
    true,
  );
  assert.equal(f.state.transports[0].secure, false);
  assert.equal(f.state.transports[0].requireTLS, true);
  f.state.config.EmailConfig.smtpUser = '';
  f.state.config.EmailConfig.smtpPass = '';
  assert.equal(
    (await api.testEmailConfig('recipient@example.test')).success,
    true,
  );
  assert.equal(f.state.transports[1].auth, undefined);
  assert.equal(f.state.transports[1].requireTLS, false);
});

test('webhook tests require the saved URL, sign the saved secret, and work independently of the registration switch', async (t) => {
  const f = fixture(t);
  const route = f.route('admin/webhook');
  assert.equal(
    (
      await route.POST(
        f.request({ action: 'test', url: 'https://other.example.test/' }),
      )
    ).status,
    400,
  );
  assert.equal(f.state.hooks.length, 0);
  f.state.config.WebhookConfig.notifyOnRegister = false;
  const response = await route.POST(
    f.request({ action: 'test', url: f.state.config.WebhookConfig.url }),
  );
  assert.equal(response.status, 200);
  const call = f.state.hooks[0];
  assert.equal(JSON.parse(call.init.body).type, 'test');
  assert.equal(
    call.init.headers['X-Webhook-Signature'],
    createHmac('sha256', 'fixture-hook-secret')
      .update(call.init.body)
      .digest('hex'),
  );
  assert.equal(call.options.timeoutMs, 10000);
  assert.equal(call.options.maxRedirects, 0);
  assert.equal(call.options.allowCrossOriginRedirects, false);
  assert.deepEqual(call.options.allowedPrivateOrigins, [
    'https://hooks.example.test',
  ]);
  assert.equal(f.state.saved.length, 0);
});

test('webhook HTTP and blocked-target failures reach the test UI without exposing response content or endpoint credentials', async (t) => {
  const f = fixture(t);
  const route = f.route('admin/webhook');
  f.state.replies.push(
    new Response('fixture-hook-secret', {
      status: 401,
      statusText: 'fixture-hook-secret',
    }),
  );
  let response = await route.POST(f.request({ action: 'test' }));
  assert.equal(response.status, 502);
  let data = await response.json();
  assert.equal(data.error, 'Webhook 返回 HTTP 401');
  assert.equal(f.state.hooks.length, 1);
  f.state.hookError = new f.ProxyTargetError('fixture-hook-secret');
  response = await route.POST(f.request({ action: 'test' }));
  assert.equal(response.status, 502);
  data = await response.json();
  assert.match(data.error, /安全规则/);
  assert.doesNotMatch(JSON.stringify(data), /fixture-hook-secret/);
  assert.equal(f.state.hooks.length, 2);
});

test('webhook transient failures retry at most three times, reuse the signed payload, and report timeouts', async (t) => {
  const f = fixture(t);
  const delays = [];
  t.mock.method(global, 'setTimeout', (callback, milliseconds, ...args) => {
    delays.push(milliseconds);
    return setImmediate(callback, ...args);
  });
  const route = f.route('admin/webhook');
  f.state.replies.push(
    ...Array.from(
      { length: 3 },
      () => new Response('fixture', { status: 503 }),
    ),
  );
  let response = await route.POST(f.request({ action: 'test' }));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'Webhook 返回 HTTP 503');
  assert.equal(f.state.hooks.length, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.ok(
    f.state.hooks.every(
      (call) => call.init.body === f.state.hooks[0].init.body,
    ),
  );
  assert.ok(
    f.state.hooks.every(
      (call) =>
        call.init.headers['X-Webhook-Signature'] ===
        f.state.hooks[0].init.headers['X-Webhook-Signature'],
    ),
  );
  f.state.hookError = Object.assign(new Error('fixture-hook-secret'), {
    name: 'AbortError',
  });
  response = await route.POST(f.request({ action: 'test' }));
  assert.equal(response.status, 502);
  const failure = await response.json();
  assert.match(failure.error, /请求超时/);
  assert.doesNotMatch(JSON.stringify(failure), /fixture-hook-secret/);
  assert.equal(f.state.hooks.length, 6);
  f.state.hookError = null;
  f.state.replies.push(
    new Response('fixture', { status: 500 }),
    new Response('fixture'),
  );
  response = await route.POST(f.request({ action: 'test' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(f.state.hooks.length, 8);
});

test('webhook GET templates preserve literal replacements and encode untrusted values without adding recipients or parameters', async (t) => {
  const f = fixture(t);
  f.state.config.WebhookConfig.url =
    'https://hooks.example.test/notify?message={message}&user={username}';
  f.state.config.WebhookConfig.messageTemplate = '用户名 {username} / {source}';
  const api = f.load('webhookService.ts');
  assert.equal(
    (
      await api.sendNewRegistrationWebhook(
        '$&{email}',
        'user@example.test',
        'one&other=two',
      )
    ).success,
    true,
  );
  const call = f.state.hooks[0];
  const url = new URL(call.url);
  assert.equal(
    url.searchParams.get('message'),
    '用户名 $&{email} / one&other=two',
  );
  assert.equal(url.searchParams.get('user'), '$&{email}');
  assert.equal(url.searchParams.has('other'), false);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers, undefined);
  f.state.config.WebhookConfig.notifyOnRegister = false;
  assert.equal((await api.sendNewRegistrationWebhook('member')).success, false);
  f.state.config.WebhookConfig.enabled = false;
  assert.equal((await api.testWebhookConfig()).success, false);
  assert.equal(f.state.hooks.length, 1);
});

test('email templates escape account content and use this deployment for approval and reset links', async (t) => {
  const f = fixture(t);
  const api = f.load('emailService.ts');
  f.state.config.SiteConfig.SiteName = '<img src=x>';
  assert.equal(
    (
      await api.sendRegistrationPendingEmail(
        'recipient@example.test',
        '<b>member</b>',
      )
    ).success,
    true,
  );
  assert.match(f.state.mail.at(-1).html, /&lt;b&gt;member&lt;\/b&gt;/);
  assert.match(f.state.mail.at(-1).html, /&lt;img src=x&gt;/);
  assert.equal(
    (
      await api.sendRejectionEmail(
        'recipient@example.test',
        'member',
        '<a href="https://evil.test">reason</a>',
      )
    ).success,
    true,
  );
  assert.doesNotMatch(f.state.mail.at(-1).html, /<a href="https:\/\/evil/);
  assert.equal(
    (await api.sendApprovalEmail('recipient@example.test', 'member')).success,
    true,
  );
  assert.match(
    f.state.mail.at(-1).html,
    /https:\/\/miaotv\.example\.test\/login/,
  );
  assert.equal(
    (
      await api.sendPasswordResetEmail(
        'recipient@example.test',
        'member',
        'fixture&other=value',
      )
    ).success,
    true,
  );
  assert.match(
    f.state.mail.at(-1).html,
    /https:\/\/miaotv\.example\.test\/reset-password\?token=fixture%26other%3Dvalue/,
  );
  assert.doesNotMatch(
    f.state.mail.at(-1).html,
    /legacy\.example|deprecated\.example/,
  );
  delete process.env.SITE_BASE;
  assert.equal(
    (
      await api.sendPasswordResetEmail(
        'recipient@example.test',
        'member',
        'fixture',
      )
    ).success,
    true,
  );
  assert.match(
    f.state.mail.at(-1).html,
    /https:\/\/legacy\.example\.test\/reset-password/,
  );
  delete process.env.NEXT_PUBLIC_BASE_URL;
  const before = f.state.mail.length;
  assert.equal(
    (
      await api.sendPasswordResetEmail(
        'recipient@example.test',
        'member',
        'fixture',
      )
    ).success,
    false,
  );
  assert.equal(f.state.mail.length, before);
  assert.equal(
    (await api.sendApprovalEmail('recipient@example.test', 'member')).success,
    true,
  );
  assert.doesNotMatch(f.state.mail.at(-1).html, /href=/);
});

test('pending registration persists before email and webhook delivery and notification failure does not undo the account', async (t) => {
  const f = fixture(t);
  const api = f.load('account-registration.ts');
  f.state.smtpError = Object.assign(new Error('fixture'), { code: 'EAUTH' });
  f.state.hookError = new f.ProxyTargetError('fixture');
  const result = await api.createRegisteredAccount(f.state.config, {
    username: 'new-member',
    password: 'fixture-password',
    email: 'new@example.test',
    source: 'fixture registration',
  });
  assert.equal(result.pending, true);
  assert.equal(
    f.state.config.UserConfig.Users.find(
      (user) => user.username === 'new-member',
    ).pending,
    true,
  );
  assert.equal(f.state.users.has('new-member'), true);
  assert.ok(f.state.events.indexOf('persist') < f.state.events.indexOf('mail'));
  assert.ok(
    f.state.events.indexOf('persist') < f.state.events.indexOf('webhook'),
  );
  assert.equal(JSON.parse(f.state.hooks[0].init.body).type, 'new_registration');
  f.state.config.UserConfig.RequireApproval = false;
  const mailCount = f.state.mail.length;
  const hookCount = f.state.hooks.length;
  assert.equal(
    (
      await api.createRegisteredAccount(f.state.config, {
        username: 'instant-member',
        password: 'fixture-password',
      })
    ).pending,
    false,
  );
  assert.equal(f.state.mail.length, mailCount);
  assert.equal(f.state.hooks.length, hookCount);
});

test('approval and rejection send email only after persistence and delivery failure leaves the saved decision intact', async (t) => {
  const f = fixture(t);
  const route = f.route('admin/user');
  for (const action of ['approve', 'reject']) {
    const username = 'applicant-' + action;
    const entry = {
      username,
      role: 'user',
      pending: true,
      email: username + '@example.test',
    };
    f.state.config.UserConfig.Users.push(entry);
    f.state.users.set(username, { ...entry });
    f.state.events.length = 0;
    f.state.smtpError = Object.assign(new Error('fixture'), { code: 'EAUTH' });
    assert.equal(
      (
        await route.POST(
          f.request({
            action,
            targetUsername: username,
            reason: 'fixture reason',
          }),
        )
      ).status,
      200,
    );
    assert.ok(
      f.state.events.indexOf('persist') < f.state.events.indexOf('mail'),
    );
    if (action === 'approve')
      assert.equal(
        f.state.config.UserConfig.Users.find(
          (user) => user.username === username,
        ).pending,
        false,
      );
    else assert.equal(f.state.users.has(username), false);
  }
  assert.equal(f.state.hooks.length, 0);
});

test('forgot-password uses the restored email service and revokes a token on delivery failure without notifying unknown users', async (t) => {
  const f = fixture(t);
  const route = f.route('forgot-password');
  let response = await route.POST(f.request({ email: 'member@example.test' }));
  assert.equal(response.status, 200);
  assert.match(
    f.state.mail.at(-1).html,
    /miaotv\.example\.test\/reset-password\?token=fixture-reset-token/,
  );
  assert.equal(f.state.cache.has('password_reset:fixture-reset-token'), true);
  assert.equal(f.state.cache.get('password_reset:fixture-reset-token').uid, f.state.users.get('member').uid);
  f.state.smtpError = Object.assign(new Error('fixture'), { code: 'EAUTH' });
  response = await route.POST(f.request({ email: 'member@example.test' }));
  assert.equal(response.status, 200);
  assert.equal(f.state.cache.has('password_reset:fixture-reset-token'), false);
  const before = f.state.mail.length;
  response = await route.POST(f.request({ email: 'unknown@example.test' }));
  assert.equal(response.status, 200);
  assert.equal(f.state.mail.length, before);
  assert.equal(f.state.hooks.length, 0);
});
