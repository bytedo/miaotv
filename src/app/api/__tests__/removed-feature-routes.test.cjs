const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');

function route(name, overrides = {}) {
  const load = createSourceLoader({
    'next/server': { NextRequest: Request, NextResponse: Response },
    '@/lib/config': {
      getConfig: async () => ({ DanmuApiConfig: { enabled: false } }),
    },
    '@/lib/performance-monitor': {
      recordRequest() {},
      resetDbQueryCount() {},
      getDbQueryCount: () => 0,
    },
    '@/lib/douban-anti-crawler': {
      fetchDoubanWithVerification: async () => {
        throw new Error('Unexpected Douban request');
      },
    },
    ...overrides,
  });
  return load(path.resolve(__dirname, '..', name, 'route.ts'));
}

function request(name, params, method = 'GET') {
  return new Request(
    `https://miaotv.test/api/${name}?${new URLSearchParams(params)}`,
    { method },
  );
}

test('removed feature routes cannot be re-enabled by legacy settings', () => {
  const removed = [
    'ai-recommend',
    'admin/ai-recommend',
    'admin/ai-recommend/test',
    'admin/ai-recommend/usage',
    'youtube/popular',
    'youtube/regions',
    'youtube/search',
    'proxy/youtube',
    'admin/youtube',
    'bilibili/popular',
    'bilibili/search',
    'admin/bilibili',
    'admin/bilibili/check',
    'admin/bilibili/logout',
    'admin/bilibili/poll',
    'admin/bilibili/qrcode',
    'telegram/send-magic-link',
    'telegram/set-webhook',
    'telegram/verify',
    'telegram/webhook',
    'watch-room/config',
    'watch-room/stats',
    'watch-room/test-connection',
  ];
  for (const name of removed) {
    assert.equal(
      existsSync(path.resolve(__dirname, '..', name, 'route.ts')),
      false,
      name,
    );
  }
});

test('removed room endpoints no longer bypass standard API authentication', async (t) => {
  const previous = {
    USERNAME: process.env.USERNAME,
    PASSWORD: process.env.PASSWORD,
    NEXT_PUBLIC_STORAGE_TYPE: process.env.NEXT_PUBLIC_STORAGE_TYPE,
  };
  process.env.PASSWORD = 'removed-room-fixture-signing-key';
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const load = createSourceLoader({
    'next/server': {
      NextResponse: {
        json: (body, init) => Response.json(body, init),
        next: () => new Response(null, { status: 200 }),
      },
    },
    '@/lib/config': { getConfig: async () => ({ UserConfig: { Users: [] } }) },
    '@/lib/db': { db: {} },
    '@/lib/auth.server': { getVerifiedAuthInfo: async () => null },
    '@/lib/trusted-network': { isRequestFromTrustedNetwork: () => false },
  });
  const { proxy } = load(path.resolve(__dirname, '../../../proxy.ts'));
  for (const owner of [undefined, 'removed-room-fixture-owner']) {
    if (owner === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = owner;
    for (const name of ['config', 'stats', 'test-connection']) {
      for (const method of ['GET', 'POST']) {
        const url = `https://miaotv.test/api/watch-room/${name}`;
        const response = await proxy({
          url,
          nextUrl: new URL(url),
          method,
          headers: new Headers(),
          cookies: { get: () => undefined },
        });
        assert.equal(response.status, 401, `${method}: ${name}`);
      }
    }
  }
});

test('generic parsing rejects removed platforms in JSON, redirect and iframe modes', async (t) => {
  let externalCalls = 0;
  t.mock.method(global, 'fetch', async () => {
    externalCalls++;
    throw new Error('Unexpected external request');
  });
  const endpoint = route('parse');
  const removed = [
    'https://www.bilibili.com/video/BVfixture',
    'https://M.BILIBILI.COM./bangumi/play/ep1',
    'https://b23.tv/fixture',
    '//www.bilibili.com/video/BVfixture',
    'https://www.youtube.com/watch?v=fixture',
    'https://youtu.be/fixture',
    'https://www.youtube-nocookie.com/embed/fixture',
  ];
  for (const url of removed) {
    for (const format of ['json', 'redirect', 'iframe']) {
      const response = await endpoint.GET(request('parse', { url, format }));
      const body = await response.json();
      assert.equal(body.success, false, `${format}: ${url}`);
      assert.equal(body.data.platform, 'unsupported');
      assert.deepEqual(body.data.available_parsers, []);
      assert.equal(response.headers.get('location'), null);
      assert.equal(body.data.parse_url, undefined);
    }
  }
  for (const [url, platform] of [
    ['https://v.qq.com/x/page/fixture.html', 'qq'],
    ['https://www.iqiyi.com/v_fixture.html', 'iqiyi'],
    ['https://video.example.test/watch?v=fixture', 'unknown'],
    ['https://bilibili.com.example.test/watch', 'unknown'],
  ]) {
    const response = await endpoint.GET(request('parse', { url }));
    const body = await response.json();
    assert.equal(body.success, true, url);
    assert.equal(body.data.platform, platform);
    assert.equal(new URL(body.data.parse_url).searchParams.get('url'), url);
  }
  assert.equal(externalCalls, 0);
});

test('danmu collection skips removed platform URLs while preserving Tencent fallback', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requests = [];
  let videoUrl;
  t.mock.method(global, 'fetch', async (input) => {
    const target = new URL(input);
    requests.push(target);
    if (target.hostname === 'www.caiji.cyou') {
      return Response.json({
        list: [
          {
            vod_id: 1,
            vod_name: 'Fixture',
            vod_year: '2026',
            vod_play_url: `第1集$${videoUrl}`,
          },
        ],
      });
    }
    if (target.hostname === 'fc.lyz05.cn') {
      return new Response(
        '<i><d p="1,1,25,16777215,0,0,0,0">Fixture comment</d></i>',
      );
    }
    throw new Error(`Unexpected request: ${target}`);
  });
  const endpoint = route('danmu-external');
  for (videoUrl of [
    'https://www.bilibili.com/video/BVfixture',
    'https://M.BILIBILI.COM./bangumi/play/ep1',
    '//b23.tv/fixture',
    'https://www.youtube.com/watch?v=fixture',
    'https://youtu.be/fixture',
  ]) {
    requests.length = 0;
    const response = await endpoint.GET(
      request('danmu-external', { title: 'Fixture', episode: '1' }),
    );
    const body = await response.json();
    assert.equal(response.status, 200, videoUrl);
    assert.equal(body.total, 0, videoUrl);
    assert.deepEqual(body.platforms, []);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((target) => target.hostname === 'www.caiji.cyou'));
  }
  requests.length = 0;
  videoUrl = 'https://v.qq.com/x/page/fixture.html';
  const response = await endpoint.GET(
    request('danmu-external', { title: 'Fixture', episode: '1' }),
  );
  const body = await response.json();
  assert.equal(body.total, 1);
  assert.equal(body.danmu[0].text, 'Fixture comment');
  assert.equal(body.platforms[0].platform, 'tencent_caiji');
  assert.equal(requests.at(-1).searchParams.get('url'), videoUrl);
});

test('Douban danmu extraction ignores direct and encoded Bilibili links', async (t) => {
  t.mock.method(console, 'log', () => {});
  let externalCalls = 0;
  t.mock.method(global, 'fetch', async () => {
    externalCalls++;
    throw new Error('Unexpected external request');
  });
  const html =
    ' '.repeat(1200) +
    '<a href="https://www.bilibili.com/video/BVfixture">Video</a>' +
    'play_link: "https%3A%2F%2Fm.bilibili.com%2Fbangumi%2Fplay%2Fep1"';
  const endpoint = route('danmu-external', {
    '@/lib/douban-anti-crawler': {
      fetchDoubanWithVerification: async () => new Response(html),
    },
  });
  const response = await endpoint.GET(
    request('danmu-external', { douban_id: '1' }),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.total, 0);
  assert.deepEqual(body.platforms, []);
  assert.equal(externalCalls, 0);
});

test('cache management no longer accepts removed video platform cache types', async () => {
  let cacheWrites = 0;
  const endpoint = route('admin/cache', {
    '@/lib/auth': {
      getAuthInfoFromCookie: () => ({ username: process.env.USERNAME }),
    },
    '@/lib/database-cache': {
      DatabaseCacheManager: {
        clearCacheByType: async () => {
          cacheWrites++;
          return 1;
        },
      },
    },
    '@/lib/db': { db: {} },
  });
  const previousOwner = process.env.USERNAME;
  process.env.USERNAME = 'fixture-owner';
  try {
    for (const type of ['youtube', 'bilibili']) {
      const response = await endpoint.DELETE(
        request('admin/cache', { type }, 'DELETE'),
      );
      assert.equal(response.status, 400);
      assert.equal((await response.json()).success, false);
    }
    assert.equal(cacheWrites, 0);
  } finally {
    if (previousOwner === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = previousOwner;
  }
});
