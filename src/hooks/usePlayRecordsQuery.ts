'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';

import { getAllPlayRecords } from '@/lib/db.client';
import type { PlayRecord } from '@/lib/types';

// Keep the root cache as a Record; list and single-record views use selectors.
export const playRecordsQueryOptions = queryOptions({
  queryKey: ['playRecords'] as const,
  queryFn: (): Promise<Record<string, PlayRecord>> => getAllPlayRecords(),
  staleTime: 5 * 60 * 1000,
  gcTime: 10 * 60 * 1000,
  retry: 1,
});

export function usePlayRecordsQuery(options?: { enabled?: boolean }) {
  return useQuery({ ...playRecordsQueryOptions, enabled: options?.enabled });
}

const selectPlayRecordsArray = (records: Record<string, PlayRecord>) =>
  Object.entries(records)
    .map(([key, record]) => ({ ...record, key }))
    .sort((a, b) => b.save_time - a.save_time);

export function usePlayRecordsArrayQuery(options?: { enabled?: boolean }) {
  return useQuery({
    ...playRecordsQueryOptions,
    enabled: options?.enabled,
    select: selectPlayRecordsArray,
  });
}

export function usePlayRecordQuery(
  source: string,
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...playRecordsQueryOptions,
    enabled: (options?.enabled ?? true) && !!source && !!id,
    select: (records) => records[source + '+' + id] || null,
  });
}
