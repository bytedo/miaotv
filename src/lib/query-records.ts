import type { QueryClient } from '@tanstack/react-query';

export function rollbackRecordCache<T>(
  client: QueryClient,
  queryKey: readonly string[],
  previous: Record<string, T> | undefined,
  optimistic: Record<string, T> | undefined,
  keys = Object.keys(previous || {}),
) {
  client.setQueryData<Record<string, T>>(queryKey, (current) => {
    const restored = { ...current };
    for (const key of keys) {
      // A later mutation or storage update owns this entry now.
      if (current?.[key] !== optimistic?.[key]) continue;
      if (previous?.[key] === undefined) delete restored[key];
      else restored[key] = previous[key];
    }
    return restored;
  });
}
