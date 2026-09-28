'use client';

import { useSyncExternalStore } from 'react';

// Runtime settings are injected by the layout; saving them reloads the page.
const subscribe = () => () => {};

export function useWebLiveEnabled(): boolean | null {
  return useSyncExternalStore<boolean | null>(
    subscribe,
    () => {
      const config = (
        window as Window & { RUNTIME_CONFIG?: { ENABLE_WEB_LIVE?: boolean } }
      ).RUNTIME_CONFIG;
      // Older MiaoTV settings had no switch and always exposed web live TV.
      return config?.ENABLE_WEB_LIVE !== false;
    },
    () => null,
  );
}
