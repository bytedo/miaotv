import type { AdminConfig } from './admin.types';

// Older database snapshots and configuration imports can still carry these
// settings. Omit them from active configuration without rewriting account data.
export function stripRemovedFeatureConfig(config: AdminConfig): AdminConfig {
  const result = { ...config } as AdminConfig & Record<string, unknown>;
  for (const key of [
    'AIRecommendConfig',
    'YouTubeConfig',
    'BilibiliConfig',
    'TelegramAuthConfig',
    'WatchRoomConfig',
  ]) {
    delete result[key];
  }
  const site = { ...config.SiteConfig } as AdminConfig['SiteConfig'] &
    Record<string, unknown>;
  delete site.EnableBilibili;
  delete site.EnableYouTube;
  delete site.EnableWatchRoomScreen;
  delete site.EnableWatchRoomLive;
  result.SiteConfig = site;
  // Keep source allowlists intact: removing the last legacy permission could
  // turn a restricted account's empty list into unrestricted source access.
  return result;
}
