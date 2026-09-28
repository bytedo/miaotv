/* eslint-disable no-console */

import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { checkForUpdates, type UpdateStatus } from '@/lib/version_check';

import { useFavoritesArrayQuery } from './useFavoritesQuery';
import { playRecordsQueryOptions } from './usePlayRecordsQuery';

// ─── Emby Config Types ──────────────────────────────────────────────────────

export interface EmbySource {
  key: string;
  name: string;
  enabled: boolean;
  ServerURL: string;
  ApiKey?: string;
  Username?: string;
  Password?: string;
  removeEmbyPrefix?: boolean;
  appendMediaSourceId?: boolean;
  transcodeMp4?: boolean;
  proxyPlay?: boolean;
}

export interface EmbyConfig {
  sources: EmbySource[];
}

export function isEmbyMenuEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const runtimeConfig = (window as Window & {
    RUNTIME_CONFIG?: {
      PRIVATE_LIBRARY_ENABLED?: boolean;
      EMBY_ENABLED?: boolean;
    };
  }).RUNTIME_CONFIG;
  return (
    runtimeConfig?.PRIVATE_LIBRARY_ENABLED === true ||
    runtimeConfig?.EMBY_ENABLED === true
  );
}

// ─── Emby Config Query Options (reusable key, type-safe) ─────────────────────

export const embyConfigQueryOptions = queryOptions({
  queryKey: ['user', 'emby-config'] as const,
  queryFn: async (): Promise<EmbyConfig> => {
    // Manual refetch bypasses Query's enabled option; keep the feature gate here.
    if (!isEmbyMenuEnabled()) return { sources: [] };
    const res = await fetch('/api/user/emby-config');
    if (!res.ok) return { sources: [] };
    const data = await res.json();
    if (data.success && data.config) {
      return data.config as EmbyConfig;
    }
    return { sources: [] };
  },
  staleTime: 5 * 60 * 1000,  // 5 minutes - config rarely changes
  gcTime: 30 * 60 * 1000,
});

export const publicEmbySourcesQueryOptions = queryOptions({
  queryKey: ['emby', 'public-sources'] as const,
  queryFn: async (): Promise<{
    sources: Array<Pick<EmbySource, 'key' | 'name'> & { isPublic: boolean }>;
  }> => {
    if (!isEmbyMenuEnabled()) return { sources: [] };
    const res = await fetch('/api/emby/public-sources');
    if (!res.ok) return { sources: [] };
    return res.json();
  },
  staleTime: 5 * 60 * 1000,
  retry: false,
});

/**
 * Fetch user Emby config
 * Only fetches when isSettingsOpen - use enabled option at call site
 */
export function useEmbyConfigQuery(enabled: boolean) {
  return useQuery({
    ...embyConfigQueryOptions,
    enabled: enabled && isEmbyMenuEnabled(),
  });
}

/**
 * Save Emby config mutation
 * Invalidates emby-config query on success so ModernNav etc. refresh
 */
export function useSaveEmbyConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: EmbyConfig) => {
      if (!isEmbyMenuEnabled()) throw new Error('Emby 功能未启用');
      const res = await fetch('/api/user/emby-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || '保存失败');
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: embyConfigQueryOptions.queryKey });
    },
  });
}

/**
 * Query options for server config
 */
const serverConfigOptions = () => queryOptions({
  queryKey: ['serverConfig'],
  queryFn: async () => {
    const response = await fetch('/api/server-config');
    if (response.ok) {
      const config = await response.json();
      return { downloadEnabled: config.DownloadEnabled ?? true };
    }
    return { downloadEnabled: true };
  },
  staleTime: 10 * 60 * 1000, // 10 minutes
  gcTime: 30 * 60 * 1000,
});

/**
 * Fetch server config (download enabled, etc.)
 */
export function useServerConfigQuery() {
  return useQuery(serverConfigOptions());
}

/**
 * Query options for version check
 */
const versionCheckOptions = () => queryOptions<UpdateStatus>({
  queryKey: ['versionCheck'],
  queryFn: () => checkForUpdates(),
  staleTime: 30 * 60 * 1000, // 30 minutes - no need to check frequently
  gcTime: 60 * 60 * 1000,
  retry: 1,
});

/**
 * Check for version updates
 */
export function useVersionCheckQuery() {
  return useQuery(versionCheckOptions());
}

interface UsePlayRecordsQueryOptions {
  enabled: boolean;
  enableFilter: boolean;
  minProgress: number;
  maxProgress: number;
}

/**
 * Query options for play records with filtering
 * 使用新的 usePlayRecordsQuery 作为数据源
 */
const playRecordsOptions = (
  enableFilter: boolean,
  minProgress: number,
  maxProgress: number
) => queryOptions({
  ...playRecordsQueryOptions,
  select: (records) => {
    const recordsArray = Object.entries(records).map(([key, record]) => ({
      ...record,
      key,
    }));

    // Filter records that need continue watching
    const validPlayRecords = recordsArray.filter(record => {
      const progress = record.total_time === 0
        ? 0
        : (record.play_time / record.total_time) * 100;

      // Play time must exceed 2 minutes
      if (record.play_time < 120) return false;

      // If filter is disabled, show all records with > 2 min playtime
      if (!enableFilter) return true;

      // Filter by user's custom progress range
      return progress >= minProgress && progress <= maxProgress;
    });

    // Sort by last play time descending
    const sortedRecords = validPlayRecords.sort((a, b) => b.save_time - a.save_time);
    return sortedRecords.slice(0, 12); // Only take the latest 12
  },
});

/**
 * Fetch play records with filtering
 */
export function usePlayRecordsQuery({
  enabled,
  enableFilter,
  minProgress,
  maxProgress,
}: UsePlayRecordsQueryOptions) {
  return useQuery({
    ...playRecordsOptions(enableFilter, minProgress, maxProgress),
    enabled,
  });
}

interface UseFavoritesQueryOptions {
  enabled: boolean;
}

/**
 * Fetch favorites list
 */
export function useFavoritesQuery({ enabled }: UseFavoritesQueryOptions) {
  return useFavoritesArrayQuery({ enabled });
}

/**
 * Change password mutation
 * Based on TanStack Query useMutation pattern from source code
 */
export function useChangePasswordMutation() {
  return useMutation({
    mutationFn: async ({ oldPassword, newPassword }: { oldPassword: string; newPassword: string }) => {
      const response = await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '修改密码失败');
      }

      return data;
    },
  });
}

/**
 * Invalidate play records and favorites queries
 * Useful when external events update data
 */
export function useInvalidateUserMenuData() {
  const queryClient = useQueryClient();

  return {
    invalidatePlayRecords: () => {
      queryClient.invalidateQueries({ queryKey: ['playRecords'] });
    },
    invalidateFavorites: () => {
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
    invalidateAll: () => {
      queryClient.invalidateQueries({ queryKey: ['playRecords'] });
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  };
}
