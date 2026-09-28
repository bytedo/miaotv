const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');
const { createIdentityFixture } = require('../../../lib/__tests__/user-identity-fixture.cjs');

function fixture(t) {
  const env = {
    USERNAME: 'config-owner',
    PASSWORD: 'isolated-config-signature-key',
    NEXT_PUBLIC_STORAGE_TYPE: 'sqlite',
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = {
    config: {
      ConfigFile: '{}',
      ConfigSubscribtion: { URL: '', AutoUpdate: false, LastCheck: '' },
      SiteConfig: {
        SiteName: 'Fixture',
        EnableWebLive: false,
        EnableEmby: true,
        EnableYouTube: true,
        EnableBilibili: true,
        EnableWatchRoomScreen: true,
        EnableWatchRoomLive: true,
      },
      UserConfig: {
        Users: [
          { username: 'manager', role: 'admin' },
          { username: 'blocked', role: 'admin', banned: true },
          { username: 'pending', role: 'admin', pending: true },
          { username: 'member', role: 'user', enabledApis: ['ai-recommend'] },
        ],
      },
      SourceConfig: [
        {
          key: 'films',
          name: 'Films',
          api: 'https://media.example.test',
          from: 'custom',
        },
      ],
      CustomCategories: [],
      AIRecommendConfig: { enabled: true, apiKey: 'retired-ai-secret' },
      YouTubeConfig: { enabled: true, apiKey: 'retired-video-secret' },
      BilibiliConfig: { enabled: true, sessdata: 'retired-cookie' },
      TelegramAuthConfig: { enabled: true, botToken: 'retired-bot-token' },
      WatchRoomConfig: {
        enabled: true,
        serverUrl: 'https://room.example.test',
        authKey: 'retired-room-auth-key',
      },
      EmailConfig: {
        enabled: true,
        smtpHost: 'smtp.example.test',
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: 'sender@example.test',
        smtpPass: 'fixture-smtp-password',
        senderName: 'Fixture',
        senderEmail: 'sender@example.test',
      },
      WebhookConfig: {
        enabled: true,
        url: 'https://hooks.example.test/fixture-token',
        secret: 'fixture-hook-secret',
        notifyOnRegister: true,
        messageTemplate: '{username}',
      },
    },
    saved: [],
    cacheClears: 0,
    revalidated: [],
    failSave: false,
  };
  const identities = createIdentityFixture(() => state.config.UserConfig.Users);
  const db = {
    ...identities,
    checkUserExist: async (reference) => !!identities.findUser(reference),
    getUserInfoV2: async (reference) => identities.findUser(reference),
    saveAdminConfig: async (config) => {
      if (state.failSave)
        throw new Error('Database error containing fixture-secret');
      state.saved.push(structuredClone(config));
      state.config = config;
    },
  };
  const config = {
    getConfig: async () => state.config,
    clearConfigCache: () => {
      state.cacheClears++;
    },
  };
  const load = createSourceLoader({
    '@/lib/db': { db },
    './db': { db },
    '@/lib/config': config,
    './config': config,
    'next/server': {
      NextResponse: { json: (body, init) => Response.json(body, init) },
    },
    'next/cache': { revalidatePath: (...args) => state.revalidated.push(args) },
  });
  const request = (body, username = env.USERNAME, signed = true) => ({
    json: async () => body,
    cookies: {
      get: () =>
        username
          ? {
              value: JSON.stringify({
                username,
                role: 'owner',
                trustedNetwork: true,
                signature: signed
                  ? createHmac('sha256', env.PASSWORD)
                      .update(username)
                      .digest('hex')
                  : '0'.repeat(64),
              }),
            }
          : undefined,
    },
  });
  const network = t.mock.method(global, 'fetch', async () => {
    throw new Error('Unexpected network access');
  });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  return {
    state, request,
    route: load('../app/api/admin/config/route.ts'),
    publicRoute: load('../app/api/server-config/route.ts'),
  };
}

test('registration settings PATCH requires the owner and rejects unrelated or non-boolean fields', async (t) => {
  const f = fixture(t);
  for (const [username, signed] of [
    [null, true], ['config-owner', false], ['manager', true],
    ['member', true], ['blocked', true], ['pending', true],
  ]) {
    assert.equal((await f.route.PATCH(f.request({ AllowRegister: false }, username, signed))).status, 403);
  }
  for (const body of [
    null, [], {}, { AllowRegister: 'false' }, { RequireApproval: 1 },
    { RequireInviteCode: null }, { Users: [] },
    { AllowRegister: false, SiteConfig: {} },
  ]) {
    assert.equal((await f.route.PATCH(f.request(body))).status, 400);
  }
  assert.equal((await f.route.PATCH({ ...f.request(), json: async () => { throw new SyntaxError(); } })).status, 400);
  assert.equal(f.state.saved.length, 0);
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'localstorage';
  assert.equal((await f.route.PATCH(f.request({ AllowRegister: false }))).status, 400);
});

test('turning registration switches off and on publishes current policy while preserving users and other settings', async (t) => {
  const f = fixture(t);
  const original = structuredClone(f.state.config);
  const expected = { allowRegister: true, requireApproval: false, requireInviteCode: false };
  const keys = { AllowRegister: 'allowRegister', RequireApproval: 'requireApproval', RequireInviteCode: 'requireInviteCode' };
  for (const patch of [
    { AllowRegister: true, RequireApproval: true, RequireInviteCode: true },
    { RequireInviteCode: false },
    { RequireApproval: false },
    { AllowRegister: false },
    { RequireApproval: true, RequireInviteCode: true },
    { AllowRegister: true },
    { RequireApproval: false },
    { RequireInviteCode: false },
  ]) {
    const saved = await f.route.PATCH(f.request(patch));
    assert.equal(saved.status, 200);
    for (const [key, value] of Object.entries(patch)) expected[keys[key]] = value;
    assert.deepEqual(await saved.json(), { success: true, ...expected });
    const response = await f.publicRoute.GET();
    const published = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const [key, value] of Object.entries(expected)) assert.equal(published[key], value);
    for (const key of ['SiteConfig', 'EmailConfig', 'WebhookConfig', 'SourceConfig']) {
      assert.deepEqual(f.state.config[key], original[key]);
    }
    assert.deepEqual(f.state.config.UserConfig.Users, original.UserConfig.Users);
  }
  assert.equal(f.state.cacheClears, 8);
  assert.equal(f.state.revalidated.length, 8);
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'localstorage';
  assert.equal((await (await f.publicRoute.GET()).json()).allowRegister, false);
});

test('concurrent registration switches merge with the latest saved settings and failed saves release the queue', async (t) => {
  const f = fixture(t);
  const results = await Promise.all([
    f.route.PATCH(f.request({ AllowRegister: false })),
    f.route.PATCH(f.request({ RequireApproval: true })),
    f.route.PATCH(f.request({ RequireInviteCode: true })),
  ]);
  assert.ok(results.every((response) => response.status === 200));
  assert.equal(f.state.config.UserConfig.AllowRegister, false);
  assert.equal(f.state.config.UserConfig.RequireApproval, true);
  assert.equal(f.state.config.UserConfig.RequireInviteCode, true);
  const before = structuredClone(f.state.config);
  const cacheClears = f.state.cacheClears;
  f.state.failSave = true;
  assert.equal((await f.route.PATCH(f.request({ RequireApproval: false }))).status, 500);
  assert.deepEqual(f.state.config, before);
  assert.equal(f.state.cacheClears, cacheClears);
  f.state.failSave = false;
  assert.equal((await f.route.PATCH(f.request({ RequireApproval: false }))).status, 200);
  assert.equal(f.state.config.UserConfig.RequireApproval, false);
});

test('full configuration writes cannot silently coerce registration flags', async (t) => {
  const f = fixture(t);
  for (const key of ['AllowRegister', 'RequireApproval', 'RequireInviteCode']) {
    const body = structuredClone(f.state.config);
    body.UserConfig[key] = 'false';
    assert.equal((await f.route.POST(f.request(body))).status, 400);
  }
  assert.equal(f.state.saved.length, 0);
});

test('full admin configuration requires verified identity and owner-only writes', async (t) => {
  const f = fixture(t);
  for (const [username, signed] of [
    [null, true],
    ['config-owner', false],
    ['member', true],
    ['blocked', true],
    ['pending', true],
    ['missing', true],
  ]) {
    assert.equal(
      (await f.route.GET(f.request(undefined, username, signed))).status,
      401,
    );
    assert.equal(
      (await f.route.POST(f.request(f.state.config, username, signed))).status,
      403,
    );
  }
  assert.equal(
    (await f.route.GET(f.request(undefined, 'manager'))).status,
    200,
  );
  assert.equal(
    (await f.route.POST(f.request(f.state.config, 'manager'))).status,
    403,
  );
  assert.equal(f.state.saved.length, 0);
});

test('admin configuration redacts notification and retired credentials without mutating storage', async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.state.config);
  const owner = await f.route.GET(f.request());
  const { Role, Config } = await owner.json();
  assert.equal(Role, 'owner');
  assert.equal(owner.headers.get('cache-control'), 'no-store');
  assert.equal(Config.EmailConfig.smtpPass, '******');
  assert.equal(Config.WebhookConfig.secret, '******');
  for (const key of [
    'AIRecommendConfig',
    'YouTubeConfig',
    'BilibiliConfig',
    'TelegramAuthConfig',
    'WatchRoomConfig',
  ])
    assert.equal(Object.hasOwn(Config, key), false);
  assert.equal(Object.hasOwn(Config.SiteConfig, 'EnableBilibili'), false);
  assert.equal(Object.hasOwn(Config.SiteConfig, 'EnableYouTube'), false);
  assert.equal(Object.hasOwn(Config.SiteConfig, 'EnableWatchRoomScreen'), false);
  assert.equal(Object.hasOwn(Config.SiteConfig, 'EnableWatchRoomLive'), false);
  assert.equal(JSON.stringify(Config).includes('retired-room-auth-key'), false);
  const admin = (
    await (await f.route.GET(f.request(undefined, 'manager'))).json()
  ).Config;
  assert.equal(Object.hasOwn(admin, 'EmailConfig'), false);
  assert.equal(Object.hasOwn(admin, 'WebhookConfig'), false);
  assert.equal(JSON.stringify(admin).includes('fixture-token'), false);
  assert.equal(JSON.stringify(admin).includes('retired-room-auth-key'), false);
  assert.deepEqual(f.state.config, before);
});

test('full configuration round trips preserve masked and omitted notification secrets', async (t) => {
  const f = fixture(t);
  const input = (await (await f.route.GET(f.request())).json()).Config;
  input.SiteConfig.SiteName = 'Updated title';
  assert.equal((await f.route.POST(f.request(input))).status, 200);
  assert.equal(f.state.config.EmailConfig.smtpPass, 'fixture-smtp-password');
  assert.equal(f.state.config.WebhookConfig.secret, 'fixture-hook-secret');
  assert.deepEqual(
    f.state.config.UserConfig.Users.find((user) => user.username === 'member')
      .enabledApis,
    ['ai-recommend'],
  );
  assert.equal(f.state.config.SiteConfig.EnableWebLive, false);
  assert.equal(f.state.config.SiteConfig.EnableEmby, true);
  assert.equal(Object.hasOwn(f.state.config, 'AIRecommendConfig'), false);

  const omitted = structuredClone(f.state.config);
  delete omitted.EmailConfig;
  delete omitted.WebhookConfig;
  omitted.YouTubeConfig = { enabled: true, apiKey: 'stale-import' };
  omitted.SiteConfig.EnableYouTube = true;
  omitted.WatchRoomConfig = {
    enabled: true,
    serverUrl: 'https://room.example.test',
    authKey: 'stale-import-room-auth-key',
  };
  omitted.SiteConfig.EnableWatchRoomScreen = true;
  omitted.SiteConfig.EnableWatchRoomLive = true;
  assert.equal((await f.route.POST(f.request(omitted))).status, 200);
  assert.equal(f.state.config.EmailConfig.smtpPass, 'fixture-smtp-password');
  assert.equal(f.state.config.WebhookConfig.secret, 'fixture-hook-secret');
  assert.equal(Object.hasOwn(f.state.config, 'YouTubeConfig'), false);
  assert.equal(
    Object.hasOwn(f.state.config.SiteConfig, 'EnableYouTube'),
    false,
  );
  assert.equal(Object.hasOwn(f.state.config, 'WatchRoomConfig'), false);
  assert.equal(
    Object.hasOwn(f.state.config.SiteConfig, 'EnableWatchRoomScreen'),
    false,
  );
  assert.equal(
    Object.hasOwn(f.state.config.SiteConfig, 'EnableWatchRoomLive'),
    false,
  );
  assert.equal(JSON.stringify(f.state.saved).includes('room-auth-key'), false);
  assert.equal(f.state.cacheClears, 2);
  assert.deepEqual(f.state.revalidated, [
    ['/', 'layout'],
    ['/', 'layout'],
  ]);
});

test('invalid full configuration and failed saves leave persisted secrets and cache unchanged', async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.state.config);
  for (const input of [
    null,
    [],
    {},
    { ...before, UserConfig: [] },
    { ...before, EmailConfig: { ...before.EmailConfig, smtpPort: 0 } },
    {
      ...before,
      WebhookConfig: { ...before.WebhookConfig, url: 'file:///tmp/hook' },
    },
  ]) {
    assert.equal((await f.route.POST(f.request(input))).status, 400);
  }
  assert.equal(
    (
      await f.route.POST({
        ...f.request(),
        json: async () => {
          throw new SyntaxError();
        },
      })
    ).status,
    400,
  );
  f.state.failSave = true;
  const failed = await f.route.POST(f.request(before));
  assert.equal(failed.status, 500);
  assert.equal((await failed.text()).includes('fixture-secret'), false);
  assert.deepEqual(f.state.config, before);
  assert.equal(f.state.saved.length, 0);
  assert.equal(f.state.cacheClears, 0);
  assert.deepEqual(f.state.revalidated, []);
});
