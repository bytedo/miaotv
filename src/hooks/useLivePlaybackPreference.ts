import { useCallback, useState } from 'react';

const DIRECT_PLAYBACK_KEY = 'live-direct-playback-enabled';

export function useLivePlaybackPreference() {
  const [directPlaybackEnabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(DIRECT_PLAYBACK_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const setDirectPlaybackEnabled = useCallback((enabled: boolean) => {
    setEnabled(enabled);
    try {
      localStorage.setItem(DIRECT_PLAYBACK_KEY, String(enabled));
    } catch { /* Keep the active preference usable when storage is unavailable. */ }
  }, []);

  return { directPlaybackEnabled, setDirectPlaybackEnabled };
}
