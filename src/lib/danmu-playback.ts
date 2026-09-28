interface DanmuComment {
  time?: number;
  style?: Record<string, unknown>;
  [key: string]: unknown;
}

interface DanmuPlugin {
  load(comments?: DanmuComment[]): unknown;
  reset?(): void;
  show?(): void;
  hide?(): void;
}

interface DanmuPlayer {
  isDestroy?: boolean;
  plugins?: { artplayerPluginDanmuku?: DanmuPlugin };
}

interface ApplyOptions {
  key?: string;
  isCurrent: () => boolean;
  shouldShow?: () => boolean;
}

interface ApplicationState {
  generation: number;
  tail: Promise<unknown>;
  comments?: readonly DanmuComment[];
  key?: string;
  result?: Promise<boolean>;
  wake?: () => void;
  visibility?: () => boolean;
}

const applications = new WeakMap<DanmuPlayer, ApplicationState>();
const BATCH_SIZE = 200;

/** Stop queued batches before another episode clears or reuses this player. */
export function cancelDanmuApplication(
  player: DanmuPlayer | null | undefined,
): void {
  if (!player) return;
  const state = applications.get(player);
  if (!state) return;
  state.generation++;
  state.comments = undefined;
  state.result = undefined;
  state.visibility = undefined;
  state.wake?.();
}

function yieldToInput(state: ApplicationState): Promise<void> {
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      if (state.wake === wake) state.wake = undefined;
      resolve();
    };
    const timer = setTimeout(wake, 0);
    state.wake = wake;
  });
}

/**
 * The plugin appends asynchronously and mutates each input comment. Serialize
 * clearing/loading for one player, copying cached data and yielding to touch
 * input between batches. A superseded batch must finish before the next clear.
 */
export function applyDanmuToPlayer(
  player: DanmuPlayer,
  comments: readonly DanmuComment[],
  options: ApplyOptions,
): Promise<boolean> {
  const plugin = player.plugins?.artplayerPluginDanmuku;
  if (!plugin || player.isDestroy || !options.isCurrent())
    return Promise.resolve(false);

  let state = applications.get(player);
  if (!state) {
    state = { generation: 0, tail: Promise.resolve() };
    applications.set(player, state);
  }
  const updateVisibility = () => {
    if (!options.shouldShow) return;
    if (options.shouldShow()) plugin.show?.();
    else plugin.hide?.();
  };
  if (
    state.comments === comments &&
    state.key === options.key &&
    state.result
  ) {
    state.visibility = options.shouldShow;
    const generation = state.generation;
    return state.result.then((applied) => {
      if (
        !applied ||
        state.generation !== generation ||
        player.isDestroy ||
        player.plugins?.artplayerPluginDanmuku !== plugin ||
        !options.isCurrent()
      )
        return false;
      updateVisibility();
      return true;
    });
  }

  cancelDanmuApplication(player);
  const generation = state.generation;
  const current = () =>
    state.generation === generation &&
    !player.isDestroy &&
    player.plugins?.artplayerPluginDanmuku === plugin &&
    options.isCurrent();
  const result = state.tail.then(async () => {
    if (!current()) return false;
    plugin.reset?.();
    await plugin.load();
    if (!current()) return false;

    for (let offset = 0; offset < comments.length; offset += BATCH_SIZE) {
      if (!current()) return false;
      const batch = comments
        .slice(offset, offset + BATCH_SIZE)
        .map((comment) => ({
          ...comment,
          // The plugin interprets exactly zero as "emit at the current time".
          ...(comment.time === 0 ? { time: Number.EPSILON } : {}),
          ...(comment.style ? { style: { ...comment.style } } : {}),
        }));
      await plugin.load(batch);
      if (!current()) return false;
      if (offset + BATCH_SIZE < comments.length) await yieldToInput(state);
    }

    if (!current()) return false;
    if (state.visibility) {
      if (state.visibility()) plugin.show?.();
      else plugin.hide?.();
    }
    return true;
  });
  state.comments = comments;
  state.key = options.key;
  state.visibility = options.shouldShow;
  state.result = result;
  state.tail = result.catch(() => undefined);
  const clearFailed = () => {
    if (state.generation === generation) {
      state.comments = undefined;
      state.result = undefined;
    }
  };
  void result.then((applied) => {
    if (!applied) clearFailed();
  }, clearFailed);
  return result;
}
