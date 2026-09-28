const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');

const TARGET = 'https://movie.douban.com/subject/7/';
const VERIFY = 'https://sec.douban.com/verify';
const COOKIE = 'dbsawcv1=fixture-cookie';
// The existing SHA-512 verification accepts nonce 1 for this fixture.
const VERIFY_HTML = `<input id="tok" value="fixture-token">
  <input id="cha" value="danmu-cancel-fixture-15492">
  <input id="red" value="${TARGET}">`;

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

function fixtureResponse(url, init) {
  if (url === VERIFY) return new Response(VERIFY_HTML);
  if (url === 'https://sec.douban.com/c') {
    assert.equal(new URLSearchParams(init.body).get('sol'), '1');
    return new Response(null, {
      status: 302,
      headers: { 'set-cookie': COOKIE },
    });
  }
  assert.ok(url.startsWith(TARGET));
  return init.headers.Cookie === COOKIE
    ? new Response('Fixture success')
    : new Response(null, { status: 302, headers: { location: VERIFY } });
}

function harness(t, respond = fixtureResponse, overrides = {}) {
  for (const method of ['log', 'warn', 'error'])
    t.mock.method(console, method, () => {});
  const requests = [];
  t.mock.method(global, 'fetch', async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    return respond(url, init, requests.length - 1);
  });
  const helper = createSourceLoader(overrides)('douban-anti-crawler.ts');
  return { requests, ...helper };
}

test('already cancelled Douban calls never start a request or use the cookie cache', async (t) => {
  const state = harness(t, () => assert.fail('Unexpected request'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    state.fetchDoubanWithVerification(TARGET, { signal: controller.signal }),
    (error) => error === controller.signal.reason,
  );
  await assert.rejects(
    state.getDoubanCookie(TARGET, false, controller.signal),
    (error) => error === controller.signal.reason,
  );
  assert.equal(state.requests.length, 0);
});

for (const [stage, label] of [
  [0, 'initial request'],
  [1, 'cookie lookup'],
  [2, 'verification page'],
  [3, 'verification submission'],
  [4, 'final retry'],
]) {
  test(`cancelling a Douban ${label} aborts that upstream and starts no later stage`, async (t) => {
    const started = deferred();
    const state = harness(t, (url, init, index) => {
      if (index === stage) {
        started.resolve(init.signal);
        return untilAborted(init.signal);
      }
      return fixtureResponse(url, init);
    });
    const controller = new AbortController();
    const pending = state
      .fetchDoubanWithVerification(TARGET, { signal: controller.signal })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const signal = await started.promise;
    controller.abort();
    assert.equal((await pending).error, controller.signal.reason);
    assert.equal(signal, controller.signal);
    assert.equal(signal.aborted, true);
    assert.equal(state.requests.length, stage + 1);
    assert.ok(state.requests.every(({ init }) => init.signal === signal));
  });
}

test('a Douban verification body remains subject to the caller deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred();
  const state = harness(t, (url, init) => {
    if (url !== VERIFY) return fixtureResponse(url, init);
    return {
      ok: true,
      text: () => {
        started.resolve(init.signal);
        return untilAborted(init.signal);
      },
    };
  });
  const controller = new AbortController();
  const deadline = new DOMException('Fixture deadline', 'TimeoutError');
  const timer = setTimeout(() => controller.abort(deadline), 15000);
  t.after(() => clearTimeout(timer));
  const pending = state
    .fetchDoubanWithVerification(TARGET, { signal: controller.signal })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const signal = await started.promise;
  t.mock.timers.tick(15000);
  assert.equal((await pending).error, deadline);
  assert.equal(signal, controller.signal);
  assert.equal(state.requests.length, 3);
});

test('cancellation can interrupt the existing verification calculation before submission', async (t) => {
  const controller = new AbortController();
  let hashes = 0;
  const state = harness(t, fixtureResponse, {
    crypto: {
      createHash: () => ({
        update() {
          return this;
        },
        digest() {
          if (++hashes === 1) setImmediate(() => controller.abort());
          // Bound the fixture even if the calculation stops yielding to cancellation.
          return hashes >= 6000 ? '0000' : 'ffff';
        },
      }),
    },
  });
  const result = await state
    .fetchDoubanWithVerification(TARGET, { signal: controller.signal })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  assert.equal(result.error, controller.signal.reason);
  assert.equal(controller.signal.aborted, true);
  assert.ok(hashes < 6000);
  assert.equal(
    state.requests.length,
    3,
    'no verification submission after cancellation',
  );
});

test('cancelling one Douban request preserves another caller and its shared successful cookie', async (t) => {
  const responseGate = deferred();
  const started = deferred();
  const state = harness(t, (url, init) => {
    if (url.endsWith('?caller=cancel')) {
      started.resolve();
      return responseGate.promise;
    }
    return fixtureResponse(url, init);
  });
  assert.equal(await state.getDoubanCookie(TARGET), COOKIE);
  state.requests.length = 0;
  const controller = new AbortController();
  const survivor = new AbortController();
  const cancelled = state
    .fetchDoubanWithVerification(`${TARGET}?caller=cancel`, {
      signal: controller.signal,
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await started.promise;
  const successful = state.fetchDoubanWithVerification(
    `${TARGET}?caller=keep`,
    { signal: survivor.signal },
  );
  controller.abort();
  responseGate.resolve(new Response(null, { status: 503 }));
  assert.equal((await cancelled).error, controller.signal.reason);
  assert.equal((await successful).status, 200);
  assert.equal(survivor.signal.aborted, false);
  assert.equal((await state.fetchDoubanWithVerification(TARGET)).status, 200);
  assert.equal(
    state.requests.length,
    3,
    'the cancelled response must not invalidate the shared cookie',
  );
  assert.ok(state.requests.every(({ init }) => init.headers.Cookie === COOKIE));
});
