const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');

const VIDEO_URL = 'https://v.qq.com/x/cover/fixture/episode1.html';
const IQIYI_URL = 'https://www.iqiyi.com/v_fixture.html';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function untilAborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
  });
}

function harness(t, respond, options = {}) {
  const requests = [];
  let configReads = 0;
  for (const method of ['log', 'warn', 'error'])
    t.mock.method(console, method, () => {});
  t.mock.method(global, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return respond(url, init);
  });
  const load = createSourceLoader({
    'next/server': { NextRequest: Request, NextResponse: Response },
    '@/lib/config': {
      getConfig: async () => {
        configReads++;
        return {
          DanmuApiConfig: {
            enabled: true,
            useCustomApi: true,
            customApiUrl: 'https://danmu.fixture.test',
            customToken: '',
            timeout: 30,
          },
        };
      },
    },
    '@/lib/performance-monitor': {
      recordRequest() {},
      resetDbQueryCount() {},
      getDbQueryCount: () => 0,
    },
    '@/lib/douban-anti-crawler': {
      fetchDoubanWithVerification:
        options.douban ||
        (() => {
          throw new Error('Unexpected Douban request');
        }),
    },
  });
  return {
    requests,
    configReads: () => configReads,
    api: load(path.resolve(__dirname, '../danmu-external/route.ts')),
    search: load(path.resolve(__dirname, '../danmu-external/search/route.ts')),
  };
}

function request(params, { search = false, signal } = {}) {
  return new Request(
    `https://miaotv.test/api/danmu-external${search ? '/search' : ''}?${new URLSearchParams(params)}`,
    { signal },
  );
}

function comments(count, spacing = 1) {
  return Array.from({ length: count }, (_, index) => ({
    p: `${index * spacing},1,16777215`,
    m: `Fixture comment ${index}`,
  }));
}

function inlineSearch() {
  return Response.json({
    animes: [
      {
        animeId: 7,
        animeTitle: 'Fixture',
        episodes: [{ episodeId: 71, episodeTitle: 'One' }],
      },
    ],
  });
}

function fallbackResponse(url) {
  if (url.pathname.endsWith('/search/episodes'))
    return Response.json({ animes: [] });
  if (url.hostname === 'www.caiji.cyou') {
    return Response.json({
      list: [
        {
          vod_id: 7,
          vod_name: 'Fixture',
          vod_play_url: `1$${VIDEO_URL}`,
        },
      ],
    });
  }
  if (['fc.lyz05.cn', 'danmu.smone.us'].includes(url.hostname))
    return new Response('<i/>');
  if (url.hostname === 'api.danmu.icu') return Response.json({ danmuku: [] });
  assert.fail(`Unexpected fixture request: ${url.pathname}`);
}

function doubanHtml(urls, directUrl = '') {
  return `${'Fixture content '.repeat(100)}${urls
    .map(
      (url) =>
        `play_link: "https://www.douban.com/link2/?url=${encodeURIComponent(url)}"`,
    )
    .join('\n')}<a href="${directUrl}">Watch</a>`;
}

for (const count of [1, 9]) {
  test(`${count} valid primary comments return immediately without fallback`, async (t) => {
    const state = harness(t, async (url) => {
      if (url.pathname.endsWith('/search/episodes')) return inlineSearch();
      assert.ok(url.pathname.endsWith('/comment/71'));
      return Response.json({ comments: comments(count) });
    });
    const response = await state.api.GET(
      request({ title: 'Fixture', episode: '1' }),
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.total, count);
    assert.equal(body.platforms[0].platform, 'danmu_api');
    assert.equal(state.requests.length, 2);
  });
}

test('a primary result containing only filtered comments still uses fallback', async (t) => {
  const state = harness(t, async (url) => {
    if (url.pathname.endsWith('/search/episodes')) return inlineSearch();
    if (url.pathname.endsWith('/comment/71'))
      return Response.json({
        comments: [{ p: '1,1,16777215', m: '666' }],
      });
    assert.equal(url.hostname, 'www.caiji.cyou');
    return Response.json({ list: [] });
  });
  const response = await state.api.GET(request({ title: 'Fixture' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 0);
  assert.equal(state.requests.length, 3);
});

for (const [label, params, search] of [
  ['automatic load', { title: 'Fixture' }, false],
  ['manual load', { episode_id: '71' }, false],
  ['manual search', { keyword: 'Fixture' }, true],
]) {
  test(`an already cancelled ${label} starts no work`, async (t) => {
    const state = harness(t, () => assert.fail('Unexpected request'));
    const controller = new AbortController();
    controller.abort();
    const response = await (search ? state.search : state.api).GET(
      request(params, { search, signal: controller.signal }),
    );
    assert.equal(response.status, 499);
    assert.equal(state.requests.length, 0);
    assert.equal(state.configReads(), 0);
  });
}

const pendingStages = [
  [
    'primary search',
    { title: 'Fixture' },
    (url) => url.pathname.endsWith('/search/episodes'),
  ],
  [
    'manual comments',
    { episode_id: '71' },
    (url) => url.pathname.endsWith('/comment/71'),
  ],
  [
    'Caiji search',
    { title: 'Fixture' },
    (url) => url.hostname === 'www.caiji.cyou' && !url.searchParams.has('ac'),
  ],
  [
    'Caiji details',
    { title: 'Fixture' },
    (url) =>
      url.hostname === 'www.caiji.cyou' &&
      url.searchParams.get('ac') === 'detail',
  ],
  [
    'first XML provider',
    { title: 'Fixture' },
    (url) => url.hostname === 'fc.lyz05.cn',
  ],
  [
    'JSON provider',
    { title: 'Fixture' },
    (url) => url.hostname === 'api.danmu.icu',
  ],
];

for (const [label, params, matches] of pendingStages) {
  test(`cancelling ${label} aborts the upstream and starts no fallback`, async (t) => {
    const started = deferred();
    const state = harness(t, async (url, init) => {
      if (matches(url)) {
        started.resolve(init.signal);
        return untilAborted(init.signal);
      }
      return fallbackResponse(url);
    });
    const controller = new AbortController();
    const pending = state.api.GET(
      request(params, { signal: controller.signal }),
    );
    const upstreamSignal = await started.promise;
    const callsBeforeAbort = state.requests.length;
    controller.abort();
    const response = await pending;
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(response.status, 499);
    assert.match((await response.json()).error, /已取消/);
    assert.equal(state.requests.length, callsBeforeAbort);
  });
}

test('cancelling segment downloads stops the six active workers without scheduling more', async (t) => {
  const started = deferred();
  let segmentCalls = 0;
  const signals = new Set();
  const state = harness(t, async (url, init) => {
    if (url.pathname.endsWith('/comment/71'))
      return Response.json({
        comments: {
          type: 'qq',
          segmentList: Array.from({ length: 14 }, (_, index) => ({
            type: 'qq',
            url: `fixture:${index}`,
            segment_start: index * 30,
            segment_end: (index + 1) * 30,
          })),
        },
      });
    assert.ok(url.pathname.endsWith('/segmentcomment'));
    signals.add(init.signal);
    if (++segmentCalls === 6) started.resolve();
    return untilAborted(init.signal);
  });
  const controller = new AbortController();
  const pending = state.api.GET(
    request({ episode_id: '71' }, { signal: controller.signal }),
  );
  await started.promise;
  controller.abort();
  assert.equal((await pending).status, 499);
  assert.equal(segmentCalls, 6);
  assert.equal(state.requests.length, 7);
  assert.ok([...signals].every((signal) => signal.aborted));
});

for (const [label, matches, timeout] of [
  [
    'Caiji search',
    (url) => url.hostname === 'www.caiji.cyou' && !url.searchParams.has('ac'),
    15000,
  ],
  [
    'Caiji details',
    (url) =>
      url.hostname === 'www.caiji.cyou' &&
      url.searchParams.get('ac') === 'detail',
    15000,
  ],
  ['XML', (url) => url.hostname === 'fc.lyz05.cn', 15000],
  ['JSON', (url) => url.hostname === 'api.danmu.icu', 20000],
]) {
  test(`${label} timeout remains active while reading the response body`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bodyStarted = deferred();
    const state = harness(t, async (url, init) => {
      if (!matches(url)) return fallbackResponse(url);
      const readBody = () => {
        bodyStarted.resolve(init.signal);
        return untilAborted(init.signal);
      };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: readBody,
        json: readBody,
      };
    });
    const pending = state.api.GET(request({ title: 'Fixture' }));
    const signal = await bodyStarted.promise;
    t.mock.timers.tick(timeout - 1);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    const response = await pending;
    assert.equal(signal.aborted, true);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 0);
  });
}

test('successful loads clear their upstream timeout timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = harness(t, async (url) =>
    url.pathname.endsWith('/search/episodes')
      ? inlineSearch()
      : Response.json({ comments: comments(1) }),
  );
  const response = await state.api.GET(request({ title: 'Fixture' }));
  assert.equal(response.status, 200);
  t.mock.timers.tick(60000);
  assert.ok(state.requests.every(({ init }) => !init.signal.aborted));
});

test('successful searches clear their deadline instead of aborting completed upstream requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Include native deadline signals in the controlled clock as well.
  t.mock.method(AbortSignal, 'timeout', (delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), delay);
    return controller.signal;
  });
  const state = harness(t, async () => inlineSearch());
  const response = await state.search.GET(
    request({ keyword: 'Fixture' }, { search: true }),
  );
  assert.equal(response.status, 200);
  t.mock.timers.tick(60000);
  assert.ok(state.requests.every(({ init }) => !init.signal.aborted));
});

test('legacy manual search uses four concurrent details and preserves partial result order', async (t) => {
  const gates = new Map();
  let active = 0;
  let maximum = 0;
  const state = harness(t, async (url) => {
    if (url.pathname.endsWith('/search/episodes'))
      return new Response(null, { status: 404 });
    if (url.pathname.endsWith('/search/anime'))
      return Response.json({
        animes: Array.from({ length: 8 }, (_, index) => ({
          animeId: index + 1,
          animeTitle: `Fixture ${index + 1}`,
          ...(index === 1
            ? { episodes: [{ episodeId: 21, episodeTitle: 'Inline' }] }
            : {}),
        })),
      });
    const id = Number(url.pathname.split('/').pop());
    const gate = deferred();
    gates.set(id, gate);
    maximum = Math.max(maximum, ++active);
    const response = await gate.promise;
    active--;
    return response;
  });
  const pending = state.search.GET(
    request({ keyword: 'Fixture' }, { search: true }),
  );
  await flush();
  assert.deepEqual([...gates.keys()], [1, 3, 4, 5]);
  const finish = async (id, fail = false) => {
    gates.get(id).resolve(
      fail
        ? new Response(null, { status: 503 })
        : Response.json({
            bangumi: {
              episodes: [{ episodeId: id * 10 + 1, episodeTitle: 'One' }],
            },
          }),
    );
    await flush();
  };
  await finish(5);
  assert.ok(gates.has(6));
  await finish(3, true);
  await finish(7);
  await finish(8);
  await finish(6);
  await finish(4);
  await finish(1);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.deepEqual(
    (await response.json()).animes.map((anime) => anime.animeId),
    [1, 2, 4, 5, 6, 7, 8],
  );
  assert.equal(
    gates.has(2),
    false,
    'inline episodes require no detail request',
  );
});

test('cancelling legacy manual search stops active details and never starts the remainder', async (t) => {
  const started = deferred();
  let details = 0;
  const state = harness(t, async (url, init) => {
    if (url.pathname.endsWith('/search/episodes'))
      return new Response(null, { status: 404 });
    if (url.pathname.endsWith('/search/anime'))
      return Response.json({
        animes: Array.from({ length: 12 }, (_, index) => ({
          animeId: index + 1,
        })),
      });
    if (++details === 4) started.resolve();
    return untilAborted(init.signal);
  });
  const controller = new AbortController();
  const pending = state.search.GET(
    request(
      { keyword: 'Fixture' },
      { search: true, signal: controller.signal },
    ),
  );
  await started.promise;
  controller.abort();
  assert.equal((await pending).status, 499);
  assert.equal(details, 4);
});

for (const partial of [false, true]) {
  test(`legacy detail timeout ${partial ? 'preserves completed results' : 'reports failure'} and stops scheduling`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const started = deferred();
    let details = 0;
    const state = harness(t, async (url, init) => {
      if (url.pathname.endsWith('/search/episodes'))
        return new Response(null, { status: 404 });
      if (url.pathname.endsWith('/search/anime'))
        return Response.json({
          animes: Array.from({ length: 12 }, (_, index) => ({
            animeId: index + 1,
          })),
        });
      details++;
      if (partial && url.pathname.endsWith('/bangumi/1'))
        return Response.json({
          bangumi: { episodes: [{ episodeId: 11, episodeTitle: 'One' }] },
        });
      if (details === (partial ? 5 : 4)) started.resolve();
      return untilAborted(init.signal);
    });
    const pending = state.search.GET(
      request({ keyword: 'Fixture' }, { search: true }),
    );
    await started.promise;
    t.mock.timers.tick(30000);
    const response = await pending;
    const body = await response.json();
    assert.equal(response.status, partial ? 200 : 502);
    if (partial)
      assert.deepEqual(
        body.animes.map((anime) => anime.animeId),
        [1],
      );
    else assert.match(body.message, /超时/);
    assert.equal(details, partial ? 5 : 4);
  });
}

for (const rateLimited of [false, true]) {
  test(`cancelling the Douban ${rateLimited ? 'rate limit' : 'random delay'} returns before the delay elapses`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    t.mock.method(Math, 'random', () => 0);
    let doubanCalls = 0;
    const state = harness(t, () => assert.fail('Unexpected fallback'), {
      douban: async () => {
        doubanCalls++;
        return new Response('No platform links');
      },
    });
    if (rateLimited) {
      const warmup = state.api.GET(request({ douban_id: '8' }));
      t.mock.timers.tick(300);
      assert.equal((await warmup).status, 200);
    }
    const controller = new AbortController();
    let completed = false;
    const pending = state.api
      .GET(request({ douban_id: '7' }, { signal: controller.signal }))
      .then((response) => {
        completed = true;
        return response;
      });
    controller.abort();
    await flush();
    assert.equal(completed, true, 'cancellation must not wait for the timer');
    assert.equal((await pending).status, 499);
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(doubanCalls, rateLimited ? 1 : 0);
    assert.equal(state.requests.length, 0);
  });
}

test('cancelled Douban verification cannot continue into fingerprint or Caiji fallback', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const started = deferred();
  const finished = deferred();
  const state = harness(t, () => assert.fail('Unexpected fallback'), {
    douban: async (_, options) => {
      started.resolve(options.signal);
      return finished.promise;
    },
  });
  const controller = new AbortController();
  const pending = state.api.GET(
    request({ douban_id: '7' }, { signal: controller.signal }),
  );
  const signal = await started.promise;
  controller.abort();
  finished.resolve(new Response('', { status: 503 }));
  assert.equal((await pending).status, 499);
  assert.equal(signal.aborted, true);
  assert.equal(state.requests.length, 0);
});

test('duplicate Douban platform URLs trigger one provider request', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const state = harness(
    t,
    async (url) => {
      assert.equal(url.hostname, 'fc.lyz05.cn');
      assert.equal(url.searchParams.get('url'), VIDEO_URL);
      return new Response('<i><d p="5,1,25,16777215">Fixture comment</d></i>');
    },
    { douban: async () => new Response(doubanHtml([VIDEO_URL], VIDEO_URL)) },
  );
  const response = await state.api.GET(request({ douban_id: '7' }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.platforms.length, 1);
  assert.equal(state.requests.length, 1);
});

test('large manual results stay bounded and retain the episode beginning and end', async (t) => {
  const state = harness(t, async () =>
    Response.json({ comments: comments(21001, 4) }),
  );
  const response = await state.api.GET(request({ episode_id: '71' }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.total, 20000);
  assert.equal(body.danmu[0].time, 0);
  assert.equal(body.danmu.at(-1).time, 84000);
  assert.ok(
    body.danmu.every(
      (item, index) => index === 0 || item.time > body.danmu[index - 1].time,
    ),
  );
});

test('combined JSON fallback results stay bounded across the full timeline', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const state = harness(
    t,
    async (url) => {
      if (url.hostname !== 'api.danmu.icu') return fallbackResponse(url);
      const offset = url.searchParams.get('url') === VIDEO_URL ? 0 : 1;
      return Response.json({
        danmuku: Array.from({ length: 24000 }, (_, index) => [
          index * 2 + offset,
          'right',
          '#FFFFFF',
          '',
          `Fixture source ${offset} comment ${index}`,
        ]),
      });
    },
    { douban: async () => new Response(doubanHtml([VIDEO_URL, IQIYI_URL])) },
  );
  const response = await state.api.GET(request({ douban_id: '7' }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.platforms.length, 2);
  assert.equal(body.total, 20000);
  assert.equal(body.danmu[0].time, 0);
  assert.equal(body.danmu.at(-1).time, 47999);
  assert.ok(
    body.danmu.every(
      (item, index) => index === 0 || item.time > body.danmu[index - 1].time,
    ),
  );
});
