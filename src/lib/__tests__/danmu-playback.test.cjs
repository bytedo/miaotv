const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');

const { applyDanmuToPlayer, cancelDanmuApplication } =
  createSourceLoader()('danmu-playback.ts');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function playerFixture(loadBatch) {
  const plugin = {
    queue: [],
    loads: [],
    visible: false,
    resets: 0,
    reset() {
      this.resets++;
    },
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    async load(batch) {
      this.loads.push(batch);
      if (!batch) {
        this.queue = [];
        return;
      }
      await loadBatch?.(batch);
      // ArtPlayer treats zero as an immediate comment and modifies the input.
      for (const comment of batch) {
        comment.time = comment.time || 120.5;
        comment.mode ??= 0;
        comment.style ??= {};
        comment.style.transform = 'translateX(10px)';
        this.queue.push(comment);
      }
    },
  };
  return { player: { plugins: { artplayerPluginDanmuku: plugin } }, plugin };
}

const comments = (count, text = 'comment') =>
  Array.from({ length: count }, (_, i) => ({ text: `${text}-${i}`, time: i }));
const currentOptions = { isCurrent: () => true, shouldShow: () => true };

test('batched loading preserves immutable cache data, zero timestamps, and input responsiveness', async () => {
  const input = comments(451).map((comment) =>
    Object.freeze({ ...comment, style: Object.freeze({ fontWeight: 'bold' }) }),
  );
  Object.freeze(input);
  const { player, plugin } = playerFixture();
  const pending = applyDanmuToPlayer(player, input, currentOptions);
  let commentsAtInput;
  const inputHandled = new Promise((resolve) =>
    setTimeout(() => {
      commentsAtInput = plugin.queue.length;
      resolve();
    }, 0),
  );
  assert.equal(await pending, true);
  await inputHandled;
  assert.equal(plugin.queue.length, input.length);
  assert.ok(
    commentsAtInput > 0 && commentsAtInput < input.length,
    'touch input gets a turn before the entire queue is loaded',
  );
  assert.equal(input[0].time, 0);
  assert.ok(
    plugin.queue[0].time > 0 && plugin.queue[0].time < 0.001,
    'a comment at the episode start must not jump to the current playback time',
  );
  assert.equal(input[0].style.transform, undefined);
  assert.equal(plugin.queue[450].text, 'comment-450');
  assert.equal(plugin.visible, true);
});

test('a newer episode waits for an outstanding append before clearing the old queue', async () => {
  const entered = deferred();
  const release = deferred();
  const { player, plugin } = playerFixture(async (batch) => {
    if (batch[0].text.startsWith('old')) {
      entered.resolve();
      await release.promise;
    }
  });
  const old = applyDanmuToPlayer(player, comments(450, 'old'), {
    ...currentOptions,
    key: 'first',
  });
  await entered.promise;
  const fresh = applyDanmuToPlayer(player, comments(2, 'new'), {
    ...currentOptions,
    key: 'second',
  });
  release.resolve();
  assert.equal(await old, false);
  assert.equal(await fresh, true);
  assert.deepEqual(
    plugin.queue.map((comment) => comment.text),
    ['new-0', 'new-1'],
  );
  assert.equal(
    plugin.loads.filter((batch) => batch?.[0]?.text.startsWith('old')).length,
    1,
    'old batches after the running one are cancelled',
  );
});

test('closing danmu cancels all remaining work without showing the layer again', async () => {
  const entered = deferred();
  const release = deferred();
  const { player, plugin } = playerFixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = applyDanmuToPlayer(player, comments(450), currentOptions);
  await entered.promise;
  cancelDanmuApplication(player);
  plugin.hide();
  release.resolve();
  assert.equal(await pending, false);
  assert.equal(plugin.loads.filter(Boolean).length, 1);
  assert.equal(plugin.visible, false);
});

test('a duplicate completed result can change visibility without reloading comments', async () => {
  const { player, plugin } = playerFixture();
  const data = comments(2);
  assert.equal(
    await applyDanmuToPlayer(player, data, {
      ...currentOptions,
      key: 'same',
      shouldShow: () => false,
    }),
    true,
  );
  assert.equal(plugin.visible, false);
  const loads = plugin.loads.length;
  assert.equal(
    await applyDanmuToPlayer(player, data, { ...currentOptions, key: 'same' }),
    true,
  );
  assert.equal(plugin.visible, true);
  assert.equal(plugin.loads.length, loads);
});

test('duplicate in-flight loads share appends and honor the latest visibility choice', async () => {
  const entered = deferred();
  const release = deferred();
  const { player, plugin } = playerFixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const data = comments(2);
  const first = applyDanmuToPlayer(player, data, {
    ...currentOptions,
    key: 'same',
  });
  await entered.promise;
  const second = applyDanmuToPlayer(player, data, {
    ...currentOptions,
    key: 'same',
    shouldShow: () => false,
  });
  release.resolve();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(plugin.queue.length, 2);
  assert.equal(plugin.visible, false);
});

test('an obsolete consumer cannot restore visibility through a previously completed result', async () => {
  const { player, plugin } = playerFixture();
  const data = comments(2);
  await applyDanmuToPlayer(player, data, currentOptions);
  const duplicate = applyDanmuToPlayer(player, data, currentOptions);
  cancelDanmuApplication(player);
  plugin.hide();
  assert.equal(await duplicate, false);
  assert.equal(plugin.visible, false);
});

test('clearing for a switch preserves the saved visible state and discards an old append', async () => {
  const entered = deferred();
  const release = deferred();
  const { player, plugin } = playerFixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const old = applyDanmuToPlayer(player, comments(450), currentOptions);
  await entered.promise;
  const clear = applyDanmuToPlayer(player, [], { isCurrent: () => true });
  release.resolve();
  assert.equal(await old, false);
  assert.equal(await clear, true);
  assert.deepEqual(plugin.queue, []);
  assert.equal(
    plugin.visible,
    false,
    'clearing alone must not override a hidden preference',
  );
});

test('a failed plugin append does not poison a later retry', async () => {
  let fails = true;
  const { player, plugin } = playerFixture(async () => {
    if (fails) {
      fails = false;
      throw new Error('append failed');
    }
  });
  const data = comments(2);
  await assert.rejects(
    applyDanmuToPlayer(player, data, currentOptions),
    /append failed/,
  );
  assert.equal(await applyDanmuToPlayer(player, data, currentOptions), true);
  assert.equal(plugin.queue.length, 2);
});

test('destroying or replacing a player plugin makes its pending load obsolete', async () => {
  for (const replacePlugin of [false, true]) {
    const entered = deferred();
    const release = deferred();
    const { player, plugin } = playerFixture(async () => {
      entered.resolve();
      await release.promise;
    });
    const pending = applyDanmuToPlayer(player, comments(450), currentOptions);
    await entered.promise;
    if (replacePlugin)
      player.plugins.artplayerPluginDanmuku = playerFixture().plugin;
    else player.isDestroy = true;
    release.resolve();
    assert.equal(await pending, false);
    assert.equal(plugin.loads.filter(Boolean).length, 1);
    assert.equal(plugin.visible, false);
  }
});
