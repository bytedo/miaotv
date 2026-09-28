interface VideoWithHls {
  hls?: { destroy(): void };
  querySelectorAll?(selector: string): NodeListOf<Element>;
}

/** Release ownership before destroy(), which can synchronously emit media events. */
export function destroyVideoHls(
  video: VideoWithHls | null | undefined,
  expectedHls = video?.hls,
): void {
  if (!video?.hls || video.hls !== expectedHls) return;
  const hls = video.hls;
  video.hls = undefined;
  try {
    // hls.js checks the first <source> when deciding whether it owns the media.
    // Remove the AirPlay alternative so destroy() can detach its blob URL.
    video.querySelectorAll?.('source').forEach((source) => source.remove());
  } finally {
    hls.destroy();
  }
}

/** A healthy interval restores the short retry budget, never the session ceiling. */
export function createHlsRecoveryBudget() {
  const maxConsecutiveRecoveries = 2;
  const maxTotalRecoveries = 6;
  const stablePlaybackMs = 30_000;
  let consecutiveRecoveries = 0;
  let totalRecoveries = 0;
  let stableElapsedMs = 0;
  let lastProgress: { position: number; at: number } | null = null;

  const interruptProgress = () => {
    stableElapsedMs = 0;
    lastProgress = null;
  };

  return {
    interruptProgress,
    takeRecovery(): boolean {
      interruptProgress();
      if (
        consecutiveRecoveries >= maxConsecutiveRecoveries ||
        totalRecoveries >= maxTotalRecoveries
      )
        return false;
      consecutiveRecoveries++;
      totalRecoveries++;
      return true;
    },
    resetAfterFallback() {
      consecutiveRecoveries = 0;
      interruptProgress();
    },
    recordPlaybackProgress(position: number, now = Date.now()): boolean {
      if (!Number.isFinite(position) || !Number.isFinite(now)) {
        interruptProgress();
        return false;
      }
      const previous = lastProgress;
      lastProgress = { position, at: now };
      if (!previous) return false;

      const elapsed = now - previous.at;
      const advanced = position - previous.position;
      // Pauses, seeks and suspended tabs cannot count as healthy playback.
      if (
        elapsed <= 0 ||
        elapsed > 5_000 ||
        advanced <= 0 ||
        advanced > (elapsed / 1_000) * 4 + 0.5
      ) {
        stableElapsedMs = 0;
        return false;
      }
      stableElapsedMs += elapsed;
      if (stableElapsedMs < stablePlaybackMs) return false;
      consecutiveRecoveries = 0;
      stableElapsedMs = 0;
      return true;
    },
  };
}

interface HlsRecoverySession {
  requestedUrl: string;
  currentUrl: string;
  budget: ReturnType<typeof createHlsRecoveryBudget>;
  attemptedUrls: Set<string>;
  consecutiveNetworkErrors: number;
  consecutiveMediaErrors: number;
  resumePosition?: number;
  terminal: boolean;
}

const recoverySessions = new WeakMap<VideoWithHls, HlsRecoverySession>();

/** Keep retries bounded when ArtPlayer recreates HLS for the same URL. */
export function getVideoHlsRecovery(
  video: VideoWithHls,
  url: string,
): HlsRecoverySession {
  const existing = recoverySessions.get(video);
  if (existing?.requestedUrl === url) return existing;
  if (existing) existing.terminal = true;
  const session: HlsRecoverySession = {
    requestedUrl: url,
    currentUrl: url,
    budget: createHlsRecoveryBudget(),
    attemptedUrls: new Set([url]),
    consecutiveNetworkErrors: 0,
    consecutiveMediaErrors: 0,
    terminal: false,
  };
  recoverySessions.set(video, session);
  return session;
}

/** Explicit user switches get a fresh budget and invalidate late old callbacks. */
export function resetVideoHlsRecovery(
  video: VideoWithHls | null | undefined,
): void {
  if (!video) return;
  const existing = recoverySessions.get(video);
  if (existing) existing.terminal = true;
  recoverySessions.delete(video);
}
