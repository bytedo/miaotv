/** Own the asynchronous work and resources for one live playback attempt. */
export function createLivePlaybackSession() {
  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cleanups = new Set<() => void>();
  let active = true;

  const cancel = (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(timer);
  };

  const release = (cleanup: () => void) => {
    try {
      cleanup();
    } catch {
      // One already-destroyed resource must not prevent the others from closing.
    }
  };

  return {
    signal: controller.signal,
    isActive: () => active,
    cancel,
    schedule(callback: () => void, delay: number) {
      if (!active) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (active) callback();
      }, delay);
      timers.add(timer);
      return timer;
    },
    addCleanup(cleanup: () => void) {
      if (active) cleanups.add(cleanup);
      else release(cleanup);
    },
    dispose() {
      if (!active) return;
      active = false;
      controller.abort();
      timers.forEach(clearTimeout);
      timers.clear();
      cleanups.forEach(release);
      cleanups.clear();
    },
  };
}

export type LivePlaybackSession = ReturnType<typeof createLivePlaybackSession>;
