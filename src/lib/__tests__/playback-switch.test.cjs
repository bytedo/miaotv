const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');

const { PlaybackSwitchError, waitForPlaybackSwitch } =
  createSourceLoader()('playback-switch.ts');

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return { player: new EventEmitter(), controller: new AbortController() };
}

function assertDetached(player) {
  assert.equal(player.listenerCount('playback:error'), 0);
  assert.equal(player.listenerCount('destroy'), 0);
}

for (const reason of ['cancel', 'timeout', 'HLS failure']) {
  test(`an interrupted native switch disposes its player exactly once: ${reason}`, async (t) => {
    const { player, controller } = fixture(t);
    let disposals = 0;
    const pending = waitForPlaybackSwitch(
      player,
      () => new Promise(() => {}),
      controller.signal,
      100,
      () => {
        disposals++;
        // ArtPlayer destroy synchronously emits destroy; this must not recurse.
        player.isDestroy = true;
        player.emit('destroy');
      },
    );
    const rejected = assert.rejects(pending);
    if (reason === 'cancel') controller.abort();
    else if (reason === 'timeout') t.mock.timers.tick(100);
    else player.emit('playback:error', new Error('unrecoverable stream'));
    await rejected;
    assert.equal(disposals, 1);
    assertDetached(player);
    controller.abort();
    t.mock.timers.tick(100);
    assert.equal(disposals, 1);
  });
}

test('a successful switch retains its reusable player', async (t) => {
  const { player, controller } = fixture(t);
  let disposals = 0;
  await waitForPlaybackSwitch(
    player,
    async () => {},
    controller.signal,
    100,
    () => {
      disposals++;
    },
  );
  controller.abort();
  t.mock.timers.tick(100);
  assert.equal(disposals, 0);
});

test('successful source switches clear their failure handlers and timeout', async (t) => {
  const { player, controller } = fixture(t);
  await waitForPlaybackSwitch(player, async () => {}, controller.signal, 100);
  assertDetached(player);
  t.mock.timers.tick(100);
  controller.abort();
});

test('fatal HLS errors settle an otherwise pending switch without a native video error', async (t) => {
  const { player, controller } = fixture(t);
  const pending = waitForPlaybackSwitch(
    player,
    () => new Promise(() => {}),
    controller.signal,
  );
  player.emit('playback:error', new Error('source exhausted'));
  await assert.rejects(
    pending,
    (error) =>
      error instanceof PlaybackSwitchError &&
      error.message === 'source exhausted',
  );
  assertDetached(player);
});

test('synchronous custom source errors cannot miss the failure listener', async (t) => {
  const { player, controller } = fixture(t);
  const pending = waitForPlaybackSwitch(
    player,
    () => {
      player.emit('playback:error', new Error('manifest rejected'));
      return new Promise(() => {});
    },
    controller.signal,
  );
  await assert.rejects(pending, PlaybackSwitchError);
  assertDetached(player);
});

test('source switches have a finite timeout and release all listeners', async (t) => {
  const { player, controller } = fixture(t);
  const pending = waitForPlaybackSwitch(
    player,
    () => new Promise(() => {}),
    controller.signal,
    100,
  );
  const rejected = assert.rejects(
    pending,
    (error) =>
      error instanceof PlaybackSwitchError && error.message.includes('超时'),
  );
  t.mock.timers.tick(100);
  await rejected;
  assertDetached(player);
});

test('cancelling a switch ignores its late completion and leaves the next switch usable', async (t) => {
  const { player, controller } = fixture(t);
  let complete;
  const pending = waitForPlaybackSwitch(
    player,
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  complete();
  assertDetached(player);
  await waitForPlaybackSwitch(
    player,
    async () => {},
    new AbortController().signal,
  );
});

test('an already cancelled or destroyed player never starts a new switch', async (t) => {
  const { player, controller } = fixture(t);
  controller.abort();
  let starts = 0;
  const start = async () => {
    starts++;
  };
  await assert.rejects(
    waitForPlaybackSwitch(player, start, controller.signal),
    { name: 'AbortError' },
  );
  player.isDestroy = true;
  await assert.rejects(
    waitForPlaybackSwitch(player, start, new AbortController().signal),
    { name: 'AbortError' },
  );
  assert.equal(starts, 0);
  assertDetached(player);
});

test('destroying the player cancels its pending source switch', async (t) => {
  const { player, controller } = fixture(t);
  const pending = waitForPlaybackSwitch(
    player,
    () => new Promise(() => {}),
    controller.signal,
  );
  player.emit('destroy');
  await assert.rejects(pending, { name: 'AbortError' });
  assertDetached(player);
});

test('ordinary switch failures remain available to the player rebuild path', async (t) => {
  const { player, controller } = fixture(t);
  const failure = new Error('native source failed');
  await assert.rejects(
    waitForPlaybackSwitch(
      player,
      async () => {
        throw failure;
      },
      controller.signal,
    ),
    (error) => error === failure,
  );
  assertDetached(player);
});
