const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');

const TOKEN = 'fixture-private-danmu-token';
const API_CONFIG = {
  enabled: true,
  apiUrl: 'https://danmu.fixture.test/',
  token: TOKEN,
  timeout: 30,
};
const VIDEO_URL =
  'https://v.qq.com/x/cover/fixture/episode29.html?from=test&episode=29';

function harness(t, respond, overrides = {}) {
  const requests = [];
  const logs = [];
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) =>
      logs.push(args.map(String).join(' ')),
    );
  }
  t.mock.method(global, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return respond(url, init);
  });
  const load = createSourceLoader({
    'next/server': { NextRequest: Request, NextResponse: Response },
    '@/lib/config': {
      getConfig: async () => ({
        DanmuApiConfig: {
          enabled: true,
          useCustomApi: true,
          customApiUrl: API_CONFIG.apiUrl,
          customToken: TOKEN,
          timeout: 30,
          ...overrides,
        },
      }),
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
  });
  return {
    requests,
    logs,
    api: load(path.resolve(__dirname, '../danmu-external/route.ts')),
    search: load(path.resolve(__dirname, '../danmu-external/search/route.ts')),
    helper: load(path.resolve(__dirname, '../../../lib/danmu-api.ts')),
  };
}

function request(params, search = false) {
  return new Request(
    `https://miaotv.test/api/danmu-external${search ? '/search' : ''}?${new URLSearchParams(params)}`,
  );
}

function comments(count = 12, segment = 0) {
  return Array.from({ length: count }, (_, index) => ({
    cid: index + 1,
    p: `${segment * 30 + index},1,16777215`,
    t: segment * 30 + index,
    m: `弹幕片段${segment}编号${index}`,
  }));
}

function segments(count) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'qq',
    segment_start: index * 30,
    segment_end: (index + 1) * 30,
    url: `https://dm.video.qq.com/barrage/segment/fixture/${index}`,
    data: { fixture: index },
  }));
}

function segmentIndex(list) {
  return Response.json({
    errorCode: 0,
    success: true,
    comments: { type: 'qq', duration: 0, segmentList: list },
  });
}

function animes() {
  return [2025, 2026].map((year) => ({
    animeId: year === 2026 ? 1641600 : 1641500,
    bangumiId: 'fixture-tencent-album',
    animeTitle: `兰香如故 (${year})【腾讯】`,
    episodeCount: 29,
    source: 'tencent',
    episodes: Array.from({ length: 29 }, (_, index) => ({
      episodeId: year * 100 + index + 1,
      episodeTitle: `第${index + 1}集`,
      url:
        year === 2026 && index === 28
          ? VIDEO_URL
          : `https://v.qq.com/x/cover/fixture/${year}-${index + 1}.html`,
    })),
  }));
}

test('automatic matching uses episode URLs and complete segments when upstream ID mappings are missing', async (t) => {
  const list = animes();
  const slices = segments(4);
  const state = harness(t, async (url, init) => {
    if (url.pathname.endsWith('/search/episodes')) {
      assert.equal(url.searchParams.get('anime'), '兰香如故');
      return Response.json({ success: true, errorCode: 0, animes: list });
    }
    if (url.pathname.endsWith('/search/anime')) {
      return Response.json({
        success: true,
        animes: list.map(({ episodes, ...metadata }) => metadata),
      });
    }
    if (url.pathname.includes('/bangumi/'))
      return Response.json({ success: false }, { status: 404 });
    if (url.pathname.includes('/comment/')) {
      if (!url.searchParams.has('url'))
        return Response.json({ comments: [] }, { status: 404 });
      assert.ok(url.pathname.endsWith('/comment/202629'));
      assert.equal(url.searchParams.get('url'), VIDEO_URL);
      assert.equal(url.searchParams.get('segmentflag'), 'true');
      return segmentIndex(slices);
    }
    assert.ok(url.pathname.endsWith('/segmentcomment'));
    assert.equal(init.method, 'POST');
    const descriptor = JSON.parse(init.body);
    const index = descriptor.data.fixture;
    assert.deepEqual(descriptor, slices[index]);
    return Response.json({
      success: true,
      errorCode: 0,
      count: 3,
      comments: comments(3, index),
    });
  });
  const response = await state.api.GET(
    request({ title: '兰香如故', year: '2026', episode: '29' }),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.total, 12);
  assert.equal(body.platforms[0].platform, 'danmu_api');
  assert.match(body.platforms[0].source, /2026/);
  assert.deepEqual(
    body.danmu.map((item) => item.time),
    [0, 1, 2, 30, 31, 32, 60, 61, 62, 90, 91, 92],
  );
  assert.equal(state.requests.length, 6);
  assert.ok(
    state.requests.every(
      ({ url }) =>
        !url.pathname.includes('/bangumi/') &&
        !url.pathname.endsWith('/search/anime'),
    ),
  );
  assert.ok(!state.logs.join('\n').includes(TOKEN));
});

test('manual search keeps all episode URLs without separate bangumi requests', async (t) => {
  const state = harness(t, async (url) => {
    assert.ok(url.pathname.endsWith('/search/episodes'));
    return Response.json({ errorCode: 0, success: true, animes: animes() });
  });
  const response = await state.search.GET(
    request({ keyword: '兰香如故' }, true),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.count, 2);
  assert.equal(body.animes[1].episodes.length, 29);
  assert.equal(body.animes[1].episodes[28].url, VIDEO_URL);
  assert.equal(state.requests.length, 1);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.ok(!state.logs.join('\n').includes(TOKEN));
});

test('legacy search, detail and full comments remain compatible with an empty token', async (t) => {
  const state = harness(
    t,
    async (url) => {
      assert.ok(url.pathname.startsWith('/api/v2/'));
      if (url.pathname.endsWith('/search/episodes'))
        return new Response(null, { status: 404 });
      if (url.pathname.endsWith('/search/anime')) {
        return Response.json({
          errorCode: 0,
          animes: [{ animeId: 7, animeTitle: 'Legacy' }],
        });
      }
      if (url.pathname.endsWith('/bangumi/7')) {
        return Response.json({
          bangumi: { episodes: [{ episodeId: 71, episodeTitle: 'Episode 1' }] },
        });
      }
      assert.ok(url.pathname.endsWith('/comment/71'));
      assert.equal(url.searchParams.has('url'), false);
      assert.equal(url.searchParams.has('segmentflag'), false);
      return Response.json({ count: 12, comments: comments() });
    },
    { customToken: '' },
  );
  const response = await state.api.GET(
    request({ title: 'Legacy', episode: '1' }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 12);
  assert.deepEqual(
    state.requests.map(({ url }) => url.pathname),
    [
      '/api/v2/search/episodes',
      '/api/v2/search/anime',
      '/api/v2/bangumi/7',
      '/api/v2/comment/71',
    ],
  );
});

test('legacy inline episodes are reused and invalid IDs or URLs are normalized safely', async (t) => {
  const state = harness(t, async (url) => {
    if (url.pathname.endsWith('/search/episodes'))
      return new Response(null, { status: 405 });
    assert.ok(url.pathname.endsWith('/search/anime'));
    return Response.json({
      animes: [
        {
          animeId: '7',
          animeTitle: 'Inline',
          episodes: [
            null,
            {},
            { episodeId: -1 },
            { episodeId: '71junk' },
            { episodeId: '71', episodeTitle: '  ', url: 'javascript:alert(1)' },
            { episodeId: 72, episodeTitle: 'Second', url: VIDEO_URL },
          ],
        },
      ],
    });
  });
  const response = await state.search.GET(request({ keyword: 'Inline' }, true));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.animes[0].episodes, [
    { episodeId: 71, episodeTitle: 'episodeId:71' },
    { episodeId: 72, episodeTitle: 'Second', url: VIDEO_URL },
  ]);
  assert.equal(state.requests.length, 2);
});

test('missing or unusable inline episodes fall back to legacy detail lookup', async (t) => {
  for (const [name, inline] of [
    ['missing', undefined],
    ['object', {}],
    ['invalid entries', [null, {}, { episodeId: 0 }]],
  ]) {
    await t.test(name, async (subtest) => {
      const state = harness(subtest, async (url) => {
        if (url.pathname.endsWith('/search/episodes')) {
          return Response.json({
            animes: [{ animeId: 7, animeTitle: 'Legacy', episodes: inline }],
          });
        }
        if (url.pathname.endsWith('/search/anime')) {
          return Response.json({
            animes: [{ animeId: 7, animeTitle: 'Legacy', episodes: inline }],
          });
        }
        assert.ok(url.pathname.endsWith('/bangumi/7'));
        return Response.json({
          bangumi: { episodes: [{ episodeId: 71, episodeTitle: 'First' }] },
        });
      });
      const response = await state.search.GET(
        request({ keyword: 'Legacy' }, true),
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).animes[0].episodes[0].episodeId, 71);
      assert.equal(state.requests.length, 3);
    });
  }
});

test('manual matching forwards a valid episode URL and preserves ID-only calls', async (t) => {
  for (const episodeUrl of [VIDEO_URL, undefined]) {
    await t.test(
      episodeUrl ? 'URL included' : 'numeric only',
      async (subtest) => {
        const state = harness(subtest, async (url) => {
          assert.ok(url.pathname.endsWith('/comment/71'));
          assert.equal(url.searchParams.get('url'), episodeUrl || null);
          assert.equal(
            url.searchParams.get('segmentflag'),
            episodeUrl ? 'true' : null,
          );
          return Response.json({ comments: comments() });
        });
        const response = await state.api.GET(
          request({
            episode_id: '71',
            ...(episodeUrl ? { episode_url: episodeUrl } : {}),
          }),
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).total, 12);
        assert.equal(state.requests.length, 1);
      },
    );
  }
});

test('API URL builder handles token and API-prefix forms without duplicate segments', async (t) => {
  const { helper } = harness(t, async () => {
    throw new Error('Unexpected fetch');
  });
  for (const [apiUrl, token, expected] of [
    ['https://danmu.test', '', '/api/v2/search/episodes'],
    ['https://danmu.test///', 'test', '/test/api/v2/search/episodes'],
    ['https://danmu.test/api/v2/', 'test', '/test/api/v2/search/episodes'],
    ['https://danmu.test/test/api/v2', 'test', '/test/api/v2/search/episodes'],
    [
      'https://danmu.test/proxy/test',
      'test',
      '/proxy/test/api/v2/search/episodes',
    ],
    ['https://danmu.test/proxy/api/v2', '', '/proxy/api/v2/search/episodes'],
    ['https://danmu.test', 'a/b ?', '/a%2Fb%20%3F/api/v2/search/episodes'],
  ]) {
    const url = helper.buildDanmuApiUrl(
      { ...API_CONFIG, apiUrl, token },
      'search/episodes',
      { anime: '兰香如故 &2026' },
    );
    assert.equal(url.pathname, expected);
    assert.equal(url.searchParams.get('anime'), '兰香如故 &2026');
  }
});

test('segment workers preserve order, absolute times and descriptors with at most six requests', async (t) => {
  const slices = segments(14);
  let active = 0;
  let maximum = 0;
  const signals = new Set();
  const state = harness(t, async (url, init) => {
    signals.add(init.signal);
    if (url.pathname.includes('/comment/')) return segmentIndex(slices);
    assert.ok(url.pathname.endsWith('/segmentcomment'));
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    const descriptor = JSON.parse(init.body);
    const index = descriptor.data.fixture;
    assert.deepEqual(descriptor, slices[index]);
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, (6 - (index % 6)) * 2));
    active--;
    return Response.json({
      success: true,
      errorCode: 0,
      comments: index === 3 ? [] : comments(1, index),
    });
  });
  const result = await state.helper.fetchDanmuComments(API_CONFIG, {
    episodeId: 71,
    url: VIDEO_URL,
  });
  assert.equal(maximum, 6);
  assert.equal(active, 0);
  assert.equal(signals.size, 1);
  assert.equal(result.count, 13);
  assert.deepEqual(
    result.comments.map((item) => item.t),
    Array.from({ length: 14 }, (_, index) => index * 30).filter(
      (time) => time !== 90,
    ),
  );
  assert.equal(state.requests.length, 15);
});

test('valid empty full responses and empty segment indexes remain successful', async (t) => {
  for (const segmented of [false, true]) {
    await t.test(segmented ? 'empty index' : 'empty array', async (subtest) => {
      const state = harness(subtest, async () =>
        segmented
          ? segmentIndex([])
          : Response.json({ count: 0, comments: [] }),
      );
      const response = await state.api.GET(request({ episode_id: '71' }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).total, 0);
      assert.equal(state.requests.length, 1);
    });
  }
});

test('opaque segment keys and optional credentials are forwarded only to the configured API', async (t) => {
  const descriptor = {
    type: 'hongguo',
    url: 'hongguo:v1:12:34:60#segment=0',
    segment_start: 0,
    segment_end: 30,
    data: { fixture: true },
    _m_h5_tk: 'fixture-source-cookie-token',
  };
  const state = harness(t, async (url, init) => {
    assert.equal(url.hostname, 'danmu.fixture.test');
    if (url.pathname.includes('/comment/')) {
      assert.equal(url.searchParams.get('segmentflag'), 'true');
      return Response.json({
        comments: { type: 'hongguo', segmentList: [descriptor] },
      });
    }
    assert.ok(url.pathname.endsWith('/segmentcomment'));
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), descriptor);
    return Response.json({ comments: comments(1) });
  });
  const result = await state.helper.fetchDanmuComments(API_CONFIG, {
    episodeId: 71,
    url: VIDEO_URL,
  });
  assert.equal(result.count, 1);
  assert.equal(state.requests.length, 2);
  assert.ok(
    state.requests.every(({ url }) => url.hostname === 'danmu.fixture.test'),
  );
  assert.ok(!state.logs.join('\n').includes(descriptor._m_h5_tk));
  assert.ok(!state.logs.join('\n').includes(TOKEN));
});

test('manual upstream HTTP, business, network and JSON failures return readable 502 without secrets', async (t) => {
  const failures = [
    [
      'missing numeric mapping',
      () => Response.json({ comments: [] }, { status: 404 }),
      /HTTP 404/,
    ],
    ['HTTP failure', () => new Response(TOKEN, { status: 503 }), /HTTP 503/],
    [
      'business failure',
      () =>
        Response.json({
          success: false,
          errorCode: 7,
          errorMessage: TOKEN,
          comments: [],
        }),
      /接口错误 7/,
    ],
    [
      'success false',
      () => Response.json({ success: false, comments: [] }),
      /接口返回失败/,
    ],
    ['bad shape', () => Response.json({ count: 0 }), /格式无效/],
    [
      'truncated JSON',
      () => new Response(`{"comments":[{"m":"${TOKEN}`),
      /无效 JSON/,
    ],
    [
      'network failure',
      () => {
        throw new Error(
          `Request failed at https://danmu.test/${TOKEN}/api/v2/comment/71`,
        );
      },
      /连接失败/,
    ],
  ];
  for (const [name, respond, message] of failures) {
    await t.test(name, async (subtest) => {
      const state = harness(subtest, async () => respond());
      const response = await state.api.GET(request({ episode_id: '71' }));
      const body = await response.json();
      assert.equal(response.status, 502);
      assert.match(body.error, message);
      assert.equal(body.total, 0);
      assert.equal(state.requests.length, 1);
      assert.ok(!JSON.stringify(body).includes(TOKEN));
      assert.ok(!state.logs.join('\n').includes(TOKEN));
    });
  }
});

test('invalid manual parameters do not trigger upstream requests', async (t) => {
  const state = harness(t, async () => {
    throw new Error('Unexpected fetch');
  });
  for (const params of [
    { episode_id: '71junk' },
    { episode_id: '1.5' },
    { episode_id: '71', episode_url: 'javascript:alert(1)' },
    { episode_id: '71', episode_url: 'https://user:password@video.test/' },
  ]) {
    const response = await state.api.GET(request(params));
    assert.equal(response.status, 400);
  }
  assert.equal(state.requests.length, 0);
});

test('malformed or oversized segment indexes fail before any segment request', async (t) => {
  const good = segments(1)[0];
  const indexes = [
    { type: 'qq', segmentList: {} },
    { type: 5, segmentList: [] },
    { type: 'qq', segmentList: [null] },
    { type: 'qq', segmentList: [{ ...good, url: '' }] },
    { type: 'qq', segmentList: [{ ...good, url: 'x'.repeat(8193) }] },
    { type: 'qq', segmentList: [{ ...good, segment_end: -1 }] },
    { type: 'qq', segmentList: new Array(1001).fill(good) },
  ];
  for (const [index, value] of indexes.entries()) {
    await t.test(`invalid index ${index}`, async (subtest) => {
      const state = harness(subtest, async () =>
        Response.json({ comments: value }),
      );
      const response = await state.api.GET(request({ episode_id: '71' }));
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /分片索引/);
      assert.equal(state.requests.length, 1);
    });
  }
});

test('failed or truncated segments reject the whole result and stop scheduling further work', async (t) => {
  for (const [name, failure, pattern] of [
    ['HTTP', () => new Response(null, { status: 503 }), /HTTP 503/],
    ['JSON', () => new Response('{"comments":['), /无效 JSON/],
    [
      'business',
      () => Response.json({ success: false, errorCode: 4, comments: [] }),
      /接口错误 4/,
    ],
    ['shape', () => Response.json({ count: 4 }), /格式无效/],
  ]) {
    await t.test(name, async (subtest) => {
      let segmentCalls = 0;
      const state = harness(subtest, async (url, init) => {
        if (url.pathname.includes('/comment/'))
          return segmentIndex(segments(10));
        segmentCalls++;
        if (JSON.parse(init.body).data.fixture === 0) return failure();
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ comments: comments(1) });
      });
      const response = await state.api.GET(request({ episode_id: '71' }));
      const body = await response.json();
      assert.equal(response.status, 502);
      assert.match(body.error, pattern);
      assert.equal(body.total, 0);
      assert.ok(segmentCalls <= 6);
    });
  }
});

test('automatic upstream failure is preserved when fallback sources also have no data', async (t) => {
  const state = harness(t, async (url) => {
    if (url.hostname === 'www.caiji.cyou') return Response.json({ list: [] });
    assert.ok(url.pathname.endsWith('/search/episodes'));
    return new Response(null, { status: 401 });
  });
  const response = await state.api.GET(request({ title: 'Unavailable' }));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /HTTP 401/);
  assert.ok(
    !state.requests.some(({ url }) => url.pathname.endsWith('/search/anime')),
  );
});

test('manual search reports failed details instead of returning a successful empty list', async (t) => {
  const state = harness(t, async (url) => {
    if (url.pathname.endsWith('/search/episodes'))
      return new Response(null, { status: 501 });
    if (url.pathname.endsWith('/search/anime'))
      return Response.json({ animes: [{ animeId: 7, animeTitle: 'Fixture' }] });
    return new Response(null, { status: 404 });
  });
  const response = await state.search.GET(
    request({ keyword: 'Fixture' }, true),
  );
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.match(body.message, /HTTP 404/);
  assert.deepEqual(body.animes, []);
});
