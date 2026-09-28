type PlaybackFeature = 'WEBSR_ENABLED';

// Persisted browser preferences cannot enable a feature disabled by the site.
export function isPlaybackFeatureEnabled(feature: PlaybackFeature): boolean {
  return (
    typeof window !== 'undefined' &&
    (
      window as Window & {
        RUNTIME_CONFIG?: Partial<Record<PlaybackFeature, boolean>>;
      }
    ).RUNTIME_CONFIG?.[feature] === true
  );
}
