interface PlaybackSwitchPlayer {
  isDestroy?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export class PlaybackSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybackSwitchError';
  }
}

// ArtPlayer's switch promise waits for canplay. A fatal custom HLS error does
// not dispatch a native video error, so it must also settle the pending switch.
export function waitForPlaybackSwitch(
  player: PlaybackSwitchPlayer,
  switchSource: () => Promise<unknown>,
  signal: AbortSignal,
  timeoutMs = 30000,
  disposeInterruptedPlayer?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || player.isDestroy) {
      reject(new DOMException('Playback cancelled', 'AbortError'));
      return;
    }

    let settled = false;
    const finish = (error?: unknown, interrupted = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      player.off('destroy', cancel);
      player.off('playback:error', fail);
      if (interrupted) {
        // ArtPlayer does not expose cancellation for the listeners installed by
        // switchUrl/switchQuality. Their player must not be reused after abort.
        try {
          disposeInterruptedPlayer?.();
        } catch {
          /* Still settle the switch. */
        }
      }
      if (error) reject(error);
      else resolve();
    };
    const cancel = () =>
      finish(new DOMException('Playback cancelled', 'AbortError'), true);
    const fail = (error: unknown) =>
      finish(
        new PlaybackSwitchError(
          error instanceof Error
            ? error.message
            : '播放失败，请重新尝试或切换播放源',
        ),
        true,
      );
    const timer = setTimeout(
      () =>
        finish(
          new PlaybackSwitchError('视频加载超时，请重新尝试或切换播放源'),
          true,
        ),
      timeoutMs,
    );

    signal.addEventListener('abort', cancel, { once: true });
    player.on('destroy', cancel);
    player.on('playback:error', fail);
    try {
      Promise.resolve(switchSource()).then(() => finish(), finish);
    } catch (error) {
      finish(error);
    }
  });
}
