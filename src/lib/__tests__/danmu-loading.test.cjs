const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const {
  createHookHost,
  installBrowser,
} = require('./playback-test-helpers.cjs');

const cacheKey = '加载测试_2026_42_1';
const localCacheKey = 'lunatv_danmu_cache';
const comments = [{ text: '当前集弹幕', time: 0, color: '#FFFFFF', mode: 0 }];
const otherComments = [{ text: '另一集弹幕', time: 23, mode: 0 }];
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createPlayer() {
  const plugin = {
    comments: [],
    loads: [],
    shows: 0,
    hides: 0,
    reset() {},
    async load(data) {
      this.loads.push(data);
      if (data) this.comments.push(...data);
      else this.comments = [];
    },
    show() {
      this.shows++;
    },
    hide() {
      this.hides++;
    },
  };
  return {
    _playbackKey: 'fixture:1',
    plugins: { artplayerPluginDanmuku: plugin },
    notice: {},
  };
}

function createHarness(t, config = {}) {
  const storage = installBrowser(t);
  storage.set('enable_external_danmu', 'true');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  for (const method of ['log', 'warn', 'error'])
    t.mock.method(console, method, () => {});
  const requests = [];
  const cacheReads = [];
  const cacheWrites = [];
  // Deliberately ignore the signal in this mock, exercising late transport results too.
  t.mock.method(global, 'fetch', (input, init) => {
    const response = deferred();
    requests.push({
      url: new URL(String(input), 'https://site.test'),
      init,
      ...response,
    });
    return response.promise;
  });
  const host = createHookHost();
  t.after(() => host.unmount());
  const { useDanmu } = createSourceLoader({
    react: host.React,
    '@/lib/client-cache': {
      ClientCache: {
        get: async (key, signal) => {
          cacheReads.push({ key, signal });
          return config.getCache ? config.getCache(key, signal) : null;
        },
        set: async (key, item, ttl) => {
          cacheWrites.push({ key, item, ttl });
          return config.setCache?.(key, item, ttl);
        },
      },
    },
  })('../hooks/useDanmu.ts');
  const options = {
    videoTitle: '加载测试',
    videoYear: '2026',
    videoDoubanId: 42,
    currentEpisodeIndex: 0,
    currentSource: 'first',
    artPlayerRef: { current: config.player ?? null },
  };
  const render = () => host.render(() => useDanmu(options));
  const respond = (index, data, status = 200) =>
    requests[index].resolve(Response.json({ danmu: data }, { status }));
  const seedLocal = (data = comments, key = cacheKey) =>
    storage.set(
      localCacheKey,
      JSON.stringify({ [key]: { data, timestamp: Date.now() } }),
    );
  return {
    storage,
    options,
    requests,
    cacheReads,
    cacheWrites,
    render,
    respond,
    seedLocal,
    unmount: () => host.unmount(),
  };
}

test('concurrent loads share the same pending promise and never return a temporary empty list', async (t) => {
  const h = createHarness(t);
  const hook = h.render();
  const first = hook.loadExternalDanmu();
  const second = hook.loadExternalDanmu();
  assert.equal(second, first);
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.cacheReads.length, 1);
  assert.equal(settled, false);
  h.respond(0, comments);
  const result = await first;
  assert.equal(await second, result);
  assert.deepEqual(result.data, comments);
  assert.equal(h.render().loading, false);
});

for (const outcome of ['success', 'failure']) {
  test(`switching episodes cancels an old ${outcome} without clearing the new loading state`, async (t) => {
    const h = createHarness(t);
    const stableLoad = h.render().loadExternalDanmu;
    const first = stableLoad();
    await flush();
    h.options.currentEpisodeIndex = 1;
    assert.equal(h.render().loadExternalDanmu, stableLoad);
    const second = stableLoad();
    await flush();
    assert.equal(h.requests[0].init.signal.aborted, true);
    assert.equal(h.requests[1].url.searchParams.get('episode'), '2');
    assert.deepEqual(await first, { count: 0, data: [], cancelled: true });
    if (outcome === 'success') h.respond(0, comments);
    else h.requests[0].reject(new Error('obsolete transport failure'));
    await flush();
    assert.equal(h.render().loading, true);
    assert.equal(h.render().error, null);
    assert.deepEqual(h.render().danmuList, []);
    h.respond(1, otherComments);
    assert.deepEqual((await second).data, otherComments);
    t.mock.timers.tick(0);
    await flush();
    assert.equal(h.cacheWrites.length, 1);
    assert.ok(h.cacheWrites[0].key.endsWith('_2'));
    assert.deepEqual(h.render().danmuList, otherComments);
  });
}

test('different manual URLs sharing an episode ID are separate cancellable requests', async (t) => {
  const h = createHarness(t);
  const hook = h.render();
  const firstOverride = {
    animeId: 7,
    episodeId: 8,
    episodeUrl: 'https://video.example/a?token=x%2Fy&episode=1',
  };
  const secondOverride = {
    ...firstOverride,
    episodeUrl: 'https://video.example/b?episode=2',
  };
  const first = hook.loadExternalDanmu({ manualOverride: firstOverride });
  await flush();
  const second = hook.loadExternalDanmu({ manualOverride: secondOverride });
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(
    h.requests[1].url.searchParams.get('episode_url'),
    secondOverride.episodeUrl,
  );
  assert.equal((await first).cancelled, true);
  h.respond(1, otherComments);
  await second;
  h.respond(0, comments);
  await flush();
  assert.deepEqual(h.render().danmuList, otherComments);
});

test('committing manual selection state keeps the already started matching request', async (t) => {
  const h = createHarness(t);
  const override = {
    animeId: 7,
    episodeId: 8,
    episodeUrl: 'https://video.example/manual',
  };
  const pending = h.render().loadExternalDanmu({ manualOverride: override });
  await flush();
  h.options.manualOverride = { ...override };
  h.render();
  assert.equal(h.requests[0].init.signal.aborted, false);
  assert.equal(h.render().loading, true);
  h.respond(0, comments);
  assert.equal((await pending).cancelled, undefined);
  assert.deepEqual(h.render().danmuList, comments);
});

test('a forced reload supersedes a request even when its query key is unchanged', async (t) => {
  const h = createHarness(t);
  const hook = h.render();
  const first = hook.loadExternalDanmu();
  await flush();
  const second = hook.loadExternalDanmu({ force: true });
  assert.equal(h.requests.length, 2);
  assert.equal(h.cacheReads.length, 1, 'force bypasses all cache tiers');
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal((await first).cancelled, true);
  h.respond(1, otherComments);
  await second;
  h.respond(0, comments);
  await flush();
  assert.deepEqual(h.render().danmuList, otherComments);
  assert.equal(h.render().loadMeta.source, 'network-retry');
});

test('a valid local cache resolves without contacting the shared cache or comment API', async (t) => {
  const h = createHarness(t, {
    getCache: () => {
      throw new Error('must not query shared cache');
    },
  });
  h.seedLocal();
  const result = await h.render().loadExternalDanmu();
  assert.deepEqual(result, { count: comments.length, data: comments });
  assert.equal(h.cacheReads.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.render().loadMeta.source, 'cache');
});

test('same-episode source switches reuse memory and the stable loader reads current options', async (t) => {
  const h = createHarness(t);
  const load = h.render().loadExternalDanmu;
  const pending = load();
  await flush();
  h.respond(0, comments);
  const first = await pending;
  h.options.currentSource = 'another-source';
  assert.equal(h.render().loadExternalDanmu, load);
  const second = await load();
  assert.equal(second.data, first.data);
  assert.equal(h.requests.length, 1);
  assert.equal(h.cacheReads.length, 1);
  assert.equal(h.render().loadMeta.source, 'cache');
});

test('expired in-memory and local comments are replaced by a fresh request', async (t) => {
  const h = createHarness(t);
  h.seedLocal();
  await h.render().loadExternalDanmu();
  t.mock.timers.tick(30 * 60 * 1000 + 1);
  const pending = h.render().loadExternalDanmu();
  await flush();
  assert.equal(h.requests.length, 1);
  h.respond(0, otherComments);
  assert.deepEqual((await pending).data, otherComments);
  assert.equal(h.render().loadMeta.source, 'network');
});

test('a slow shared cache gets one second before its lookup is cancelled and source loading starts', async (t) => {
  const cache = deferred();
  const h = createHarness(t, { getCache: () => cache.promise });
  const pending = h.render().loadExternalDanmu();
  await flush();
  t.mock.timers.tick(999);
  await flush();
  assert.equal(h.requests.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.cacheReads[0].signal.aborted, true);
  assert.equal(h.requests.length, 1);
  h.respond(0, comments);
  await pending;
  cache.resolve({ data: otherComments, timestamp: Date.now() });
  await flush();
  assert.deepEqual(h.render().danmuList, comments);
  assert.equal(h.render().error, null);
});

test('explicit cancellation also cancels a cache lookup and prevents its late result starting network work', async (t) => {
  const cache = deferred();
  const h = createHarness(t, { getCache: () => cache.promise });
  const hook = h.render();
  const pending = hook.loadExternalDanmu();
  hook.cancelExternalDanmuLoad();
  assert.equal(h.cacheReads[0].signal.aborted, true);
  assert.equal((await pending).cancelled, true);
  cache.resolve(null);
  await flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.render().loading, false);
  assert.equal(h.render().error, null);
});

test('the request deadline aborts a stalled response and allows an explicit retry', async (t) => {
  const h = createHarness(t);
  const hook = h.render();
  const pending = hook.loadExternalDanmu({ force: true });
  t.mock.timers.tick(44999);
  await flush();
  assert.equal(h.render().loading, true);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.deepEqual(result, { count: 0, data: [], error: h.render().error });
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(h.render().loading, false);
  assert.match(h.render().error.message, /超时/);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(
    h.requests.length,
    1,
    'timeouts do not create an automatic request loop',
  );
  const retry = hook.loadExternalDanmu({ force: true });
  h.respond(1, comments);
  await retry;
  h.respond(0, otherComments);
  await flush();
  assert.deepEqual(h.render().danmuList, comments);
  assert.equal(h.render().error, null);
});

test('enabling at mount never schedules a forced retry before the first load', async (t) => {
  const h = createHarness(t);
  h.seedLocal();
  h.render();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.cacheReads.length, 0);
  assert.deepEqual((await h.render().loadExternalDanmu()).data, comments);
  assert.equal(h.requests.length, 0);
});

test('persistent cache writes happen after results are usable, and a failed POST preserves local fallback', async (t) => {
  const write = deferred();
  const h = createHarness(t, { setCache: () => write.promise });
  const pending = h.render().loadExternalDanmu({ force: true });
  h.respond(0, comments);
  const result = await pending;
  assert.deepEqual(result.data, comments);
  assert.equal(h.render().loading, false);
  assert.equal(h.cacheWrites.length, 0);
  assert.equal(h.storage.has(localCacheKey), false);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.cacheWrites.length, 1);
  assert.deepEqual(
    JSON.parse(h.storage.get(localCacheKey))[cacheKey].data,
    comments,
  );
  write.reject(new Error('cache is unavailable'));
  await flush();
  assert.equal(h.render().error, null);
  assert.deepEqual(h.render().danmuList, comments);
});

test('shared cache hits warm local storage without rewriting the shared cache', async (t) => {
  const h = createHarness(t, {
    getCache: async () => ({ data: comments, timestamp: Date.now() }),
  });
  assert.deepEqual((await h.render().loadExternalDanmu()).data, comments);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.cacheWrites.length, 0);
  assert.deepEqual(
    JSON.parse(h.storage.get(localCacheKey))[cacheKey].data,
    comments,
  );
});

test('turning off immediately hides comments and prevents late toggle results reaching the plugin', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  const hook = h.render();
  hook.handleDanmuOperationOptimized(true);
  await flush();
  hook.handleDanmuOperationOptimized(false);
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(player.plugins.artplayerPluginDanmuku.hides, 1);
  h.respond(0, comments);
  await flush();
  assert.deepEqual(player.plugins.artplayerPluginDanmuku.loads, []);
  assert.deepEqual(h.render().danmuList, []);
  assert.equal(h.render().loading, false);
  assert.equal(h.render().error, null);
});

test('unmount cancels pending work and never applies or caches its late response', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  const pending = h.render().loadExternalDanmu();
  await flush();
  h.unmount();
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal((await pending).cancelled, true);
  h.respond(0, comments);
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.cacheWrites.length, 0);
  assert.deepEqual(player.plugins.artplayerPluginDanmuku.loads, []);
});

test('toggle loads cannot apply comments to a player replaced while fetching', async (t) => {
  const oldPlayer = createPlayer();
  const h = createHarness(t, { player: oldPlayer });
  h.render().handleDanmuOperationOptimized(true);
  await flush();
  const replacement = createPlayer();
  h.options.artPlayerRef.current = replacement;
  h.respond(0, comments);
  await flush();
  assert.equal(oldPlayer.plugins.artplayerPluginDanmuku.loads.length, 0);
  assert.equal(replacement.plugins.artplayerPluginDanmuku.loads.length, 0);
});

test('enabling comments applies cached data without changing zero-time cache entries', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  h.seedLocal();
  h.render().handleDanmuOperationOptimized(true);
  await flush();
  const plugin = player.plugins.artplayerPluginDanmuku;
  assert.equal(plugin.comments.length, 1);
  assert.equal(plugin.comments[0].time, Number.EPSILON);
  assert.equal(h.render().danmuList[0].time, 0);
  assert.equal(plugin.shows, 1);
  assert.equal(h.requests.length, 0);
});

test('storage restrictions do not prevent loading or shared-cache persistence', async (t) => {
  const h = createHarness(t);
  t.mock.method(global.localStorage, 'getItem', () => {
    throw new Error('storage denied');
  });
  t.mock.method(global.localStorage, 'setItem', () => {
    throw new Error('storage denied');
  });
  const hook = h.render();
  assert.equal(hook.externalDanmuEnabled, false);
  hook.setExternalDanmuEnabled(true);
  const pending = hook.loadExternalDanmu();
  await flush();
  h.respond(0, comments);
  assert.deepEqual((await pending).data, comments);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.cacheWrites.length, 1);
  assert.equal(h.render().error, null);
});

test('ClientCache.get forwards optional cancellation without logging expected aborts', async (t) => {
  const controller = new AbortController();
  let capturedSignal;
  t.mock.method(global, 'fetch', (_url, init) => {
    capturedSignal = init.signal;
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(init.signal.reason), {
        once: true,
      }),
    );
  });
  const errors = t.mock.method(console, 'error', () => {});
  const { ClientCache } = createSourceLoader()('client-cache.ts');
  const pending = ClientCache.get('danmu-fixture', controller.signal);
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(capturedSignal, controller.signal);
  assert.equal(errors.mock.callCount(), 0);
});

test('player loading reuses a pending prefetch and waits for the plugin before reporting success', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  const batch = deferred();
  const plugin = player.plugins.artplayerPluginDanmuku;
  const originalLoad = plugin.load.bind(plugin);
  plugin.load = async (data) => {
    await originalLoad(data);
    if (data) await batch.promise;
  };
  const hook = h.render();
  const prefetch = hook.loadExternalDanmu();
  const pending = hook.loadDanmuForPlayer();
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(h.requests.length, 1);
  h.respond(0, comments);
  const fetched = await prefetch;
  await flush();
  assert.equal(settled, false);
  assert.equal(plugin.comments.length, comments.length);
  batch.resolve();
  assert.equal(await pending, fetched);
  assert.equal(plugin.shows, 1);
  assert.equal(h.render().loadDanmuForPlayer, hook.loadDanmuForPlayer);
});

test('player loading respects an existing hidden preference', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  h.seedLocal();
  h.storage.set('danmaku_visible', 'false');
  const result = await h.render().loadDanmuForPlayer();
  assert.equal(result.count, comments.length);
  assert.equal(result.cancelled, undefined);
  assert.equal(player.plugins.artplayerPluginDanmuku.shows, 0);
  assert.equal(player.plugins.artplayerPluginDanmuku.hides, 1);
  assert.equal(h.storage.get('danmaku_visible'), 'false');
});

test('player loading reports transport errors without clearing an existing plugin', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  const plugin = player.plugins.artplayerPluginDanmuku;
  plugin.comments.push(...otherComments);
  const pending = h.render().loadDanmuForPlayer({ force: true });
  h.respond(0, [], 503);
  const result = await pending;
  assert.match(result.error?.message ?? '', /503/);
  assert.equal(result.error, h.render().error);
  assert.equal(result.cancelled, undefined);
  assert.deepEqual(plugin.comments, otherComments);
  assert.deepEqual(plugin.loads, []);
});

test('player loading rejects results when the same player has switched playback keys', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  const pending = h.render().loadDanmuForPlayer({ force: true });
  player._playbackKey = 'fixture:2';
  h.respond(0, comments);
  assert.deepEqual(await pending, { count: 0, data: [], cancelled: true });
  assert.deepEqual(player.plugins.artplayerPluginDanmuku.loads, []);
});

test('completed manual matching stays current while its player application is still pending', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  const override = { animeId: 7, episodeId: 8 };
  const batch = deferred();
  const plugin = player.plugins.artplayerPluginDanmuku;
  const originalLoad = plugin.load.bind(plugin);
  plugin.load = async (data) => {
    await originalLoad(data);
    if (data) await batch.promise;
  };
  const pending = h
    .render()
    .loadDanmuForPlayer({ force: true, manualOverride: override });
  h.respond(0, comments);
  await flush();
  assert.equal(
    h.render().loading,
    false,
    'network work finished before the React commit',
  );
  h.options.manualOverride = { ...override };
  h.render();
  batch.resolve();
  const result = await pending;
  assert.equal(result.cancelled, undefined);
  assert.deepEqual(result.data, comments);
  assert.equal(plugin.shows, 1);
});

test('committing manual options after an empty response preserves the one pending retry', async (t) => {
  const h = createHarness(t);
  const override = { animeId: 7, episodeId: 8 };
  const pending = h
    .render()
    .loadExternalDanmu({ force: true, manualOverride: override });
  h.respond(0, []);
  await pending;
  h.options.manualOverride = { ...override };
  h.render();
  t.mock.timers.tick(900);
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url.searchParams.get('episode_id'), '8');
  h.respond(1, comments);
  await flush();
  assert.deepEqual(h.render().danmuList, comments);
});

test('committing manual options after its empty retry cannot start a second automatic retry', async (t) => {
  const h = createHarness(t);
  const override = { animeId: 7, episodeId: 8 };
  const pending = h
    .render()
    .loadExternalDanmu({ force: true, manualOverride: override });
  h.respond(0, []);
  await pending;
  h.render();
  t.mock.timers.tick(900);
  await flush();
  assert.equal(h.requests.length, 2);
  h.respond(1, []);
  await flush();
  h.options.manualOverride = { ...override };
  h.render();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.requests.length, 2);
});

test('plugin mutations never reach a network result, deferred cache writes, or memory reuse', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  const source = [{ ...comments[0], style: { color: '#FFFFFF' } }];
  const plugin = player.plugins.artplayerPluginDanmuku;
  const originalLoad = plugin.load.bind(plugin);
  plugin.load = async (data) => {
    if (data) {
      data[0].text = 'plugin bookkeeping';
      data[0].time = 999;
      data[0].style.color = '#000000';
      data[0].playerNode = { attached: true };
    }
    await originalLoad(data);
  };
  const hook = h.render();
  const pending = hook.loadDanmuForPlayer({ force: true });
  h.respond(0, source);
  const result = await pending;
  assert.deepEqual(result.data, source);
  assert.deepEqual(h.render().danmuList, source);
  assert.equal(h.cacheWrites.length, 0);
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(h.cacheWrites[0].item.data, source);
  assert.deepEqual(
    JSON.parse(h.storage.get(localCacheKey))[cacheKey].data,
    source,
  );
  const cached = await hook.loadExternalDanmu();
  assert.equal(
    cached.data,
    result.data,
    'unchanged memory data stays shared for player deduplication',
  );
  assert.deepEqual(cached.data, source);
  assert.equal(h.requests.length, 1);
});

test('a plugin failure is returned to the caller and a subsequent cached load can recover', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  h.seedLocal();
  const failure = new Error('plugin append failed');
  const plugin = player.plugins.artplayerPluginDanmuku;
  const originalLoad = plugin.load.bind(plugin);
  plugin.load = async (data) => {
    if (data) throw failure;
    return originalLoad(data);
  };
  const hook = h.render();
  const failed = await hook.loadDanmuForPlayer();
  assert.equal(failed.error, failure);
  assert.equal(h.render().error, failure);
  assert.equal(failed.cancelled, undefined);
  plugin.load = originalLoad;
  const recovered = await hook.loadDanmuForPlayer();
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.cancelled, undefined);
  assert.deepEqual(recovered.data, comments);
  assert.equal(h.render().error, null);
  assert.equal(h.requests.length, 0);
});

for (const trigger of ['load', 'toggle', 'retry']) {
  test(`${trigger} only warms the cache until the player is ready for the selected episode`, async (t) => {
    const player = createPlayer();
    const h = createHarness(t, { player });
    // The player still belongs to the previous episode while the next URL resolves.
    h.options.currentEpisodeIndex = 1;
    h.options.canApplyToPlayer = () => false;
    const hook = h.render();
    let expectedRequests = 1;
    if (trigger === 'load') {
      const pending = hook.loadDanmuForPlayer({ force: true });
      h.respond(0, otherComments);
      assert.equal((await pending).cancelled, true);
    } else if (trigger === 'toggle') {
      hook.handleDanmuOperationOptimized(true);
      await flush();
      h.respond(0, otherComments);
      await flush();
    } else {
      const first = hook.loadExternalDanmu({ force: true });
      h.respond(0, []);
      await first;
      h.render();
      t.mock.timers.tick(900);
      await flush();
      expectedRequests = 2;
      h.respond(1, otherComments);
      await flush();
    }
    assert.deepEqual(player.plugins.artplayerPluginDanmuku.loads, []);
    assert.deepEqual(h.render().danmuList, otherComments);

    player._playbackKey = 'fixture:2';
    // Use a new callback to verify that same-query option updates reach the hook.
    h.options.canApplyToPlayer = (candidate) =>
      candidate === player && candidate._playbackKey === 'fixture:2';
    h.render();
    const ready = await hook.loadDanmuForPlayer();
    assert.equal(ready.cancelled, undefined);
    assert.deepEqual(ready.data, otherComments);
    assert.equal(
      player.plugins.artplayerPluginDanmuku.comments.length,
      otherComments.length,
    );
    assert.equal(
      h.requests.length,
      expectedRequests,
      'ready reuses the prefetched comments',
    );
  });
}

test('revoking playback readiness prevents a pending plugin application from completing', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  h.seedLocal();
  h.options.canApplyToPlayer = () => true;
  const batch = deferred();
  const plugin = player.plugins.artplayerPluginDanmuku;
  const originalLoad = plugin.load.bind(plugin);
  plugin.load = async (data) => {
    await originalLoad(data);
    if (data) await batch.promise;
  };
  const pending = h.render().loadDanmuForPlayer();
  await flush();
  h.options.canApplyToPlayer = () => false;
  h.render();
  batch.resolve();
  assert.equal((await pending).cancelled, true);
  assert.equal(plugin.shows, 0);
  assert.equal(player.notice.show, undefined);
  assert.equal(h.render().error, null);
});

test('enabling before playback is ready preserves the visibility intent for the ready load', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  h.seedLocal();
  h.storage.set('enable_external_danmu', 'false');
  h.storage.set('danmaku_visible', 'false');
  h.options.canApplyToPlayer = () => false;
  const hook = h.render();
  hook.handleDanmuOperationOptimized(true);
  await flush();
  assert.equal(h.storage.get('danmaku_visible'), 'true');
  assert.deepEqual(player.plugins.artplayerPluginDanmuku.loads, []);

  h.options.canApplyToPlayer = () => true;
  h.render();
  assert.equal((await hook.loadDanmuForPlayer()).cancelled, undefined);
  assert.equal(player.plugins.artplayerPluginDanmuku.shows, 1);
  assert.equal(player.plugins.artplayerPluginDanmuku.hides, 0);
  assert.equal(h.requests.length, 0);
});

test('hiding comments while an enable request is pending takes precedence when it finishes', async (t) => {
  const player = createPlayer();
  const h = createHarness(t, { player });
  h.storage.set('enable_external_danmu', 'false');
  h.storage.set('danmaku_visible', 'false');
  h.render().handleDanmuOperationOptimized(true);
  await flush();
  assert.equal(h.storage.get('danmaku_visible'), 'true');

  // The visibility switch remains available while the enabled comments load.
  h.storage.set('danmaku_visible', 'false');
  player.plugins.artplayerPluginDanmuku.hide();
  h.respond(0, comments);
  await flush();
  assert.equal(h.render().externalDanmuEnabled, true);
  assert.equal(player.plugins.artplayerPluginDanmuku.shows, 0);
  assert.equal(h.storage.get('danmaku_visible'), 'false');
  assert.equal(
    player.plugins.artplayerPluginDanmuku.comments.length,
    comments.length,
  );
});
