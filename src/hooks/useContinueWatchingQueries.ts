import { usePlayRecordsArrayQuery } from './usePlayRecordsQuery';
import { useWatchingUpdatesQuery as useWatchingUpdates } from './useWatchingUpdates';

/**
 * Fetch all play records sorted by save_time
 * Based on TanStack Query useQuery with event-driven invalidation
 */
export function useContinueWatchingQuery() {
  return usePlayRecordsArrayQuery();
}

/**
 * Fetch watching updates (new episodes detection)
 * Uses the new TanStack Query implementation
 */
export function useWatchingUpdatesQuery(options?: { enabled?: boolean }) {
  return useWatchingUpdates(options);
}
