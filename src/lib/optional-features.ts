import type { AdminConfig } from './admin.types';

export const OPTIONAL_FEATURES = {
  EnableEmby: 'Emby 媒体库',
  EnableWebSR: 'WebSR 画质增强',
} as const;

export type OptionalFeature = keyof typeof OPTIONAL_FEATURES;

export function isOptionalFeatureEnabled(
  config: Pick<AdminConfig, 'SiteConfig'>,
  feature: OptionalFeature,
): boolean {
  return config.SiteConfig?.[feature] === true;
}
