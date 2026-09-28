'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ClientCache } from '@/lib/client-cache';
import {
  applyDanmuToPlayer,
  cancelDanmuApplication,
} from '@/lib/danmu-playback';

export interface UseDanmuOptions {
  videoTitle: string;
  videoYear: string;
  videoDoubanId: number;
  currentEpisodeIndex: number;
  currentSource: string;
  artPlayerRef: React.MutableRefObject<any>;
  manualOverride?: DanmuManualOverride | null;
  /** 弹幕可提前缓存，但播放器实际切换完成后才能应用。 */
  canApplyToPlayer?: (player: any) => boolean;
}

export interface DanmuManualOverride {
  animeId: number;
  episodeId: number;
  episodeUrl?: string;
  animeTitle?: string;
  episodeTitle?: string;
}

export interface DanmuLoadMeta {
  source: 'init' | 'cache' | 'network' | 'network-retry' | 'empty' | 'error';
  loadedAt: number | null;
  count: number;
}

export interface DanmuLoadResult {
  count: number;
  /** 共享缓存中的数据；交给播放器时必须通过 loadDanmuForPlayer 复制后使用。 */
  data: any[];
  error?: Error;
  /** 调用方应忽略被切集、关闭或新请求替代的结果，包括清空插件的操作。 */
  cancelled?: boolean;
}

export interface DanmuLoadOptions {
  force?: boolean;
  manualOverride?: DanmuManualOverride | null;
}

export interface UseDanmuReturn {
  externalDanmuEnabled: boolean;
  setExternalDanmuEnabled: (enabled: boolean) => void;
  danmuList: any[];
  loading: boolean;
  loadMeta: DanmuLoadMeta;
  error: Error | null;
  loadExternalDanmu: (options?: DanmuLoadOptions) => Promise<DanmuLoadResult>;
  loadDanmuForPlayer: (options?: DanmuLoadOptions) => Promise<DanmuLoadResult>;
  cancelExternalDanmuLoad: () => void;
  handleDanmuOperationOptimized: (nextState: boolean) => void;
  externalDanmuEnabledRef: React.MutableRefObject<boolean>;
  danmuLoadingRef: React.MutableRefObject<any>;
  lastDanmuLoadKeyRef: React.MutableRefObject<string>;
  danmuPluginStateRef: React.MutableRefObject<any>;
}

interface DanmuCacheItem {
  data: any[];
  timestamp: number;
}

interface DanmuRequest {
  key: string;
  controller: AbortController;
  promise: Promise<DanmuLoadResult>;
  timedOut: boolean;
}

const DANMU_CACHE_DURATION = 30 * 60;
const DANMU_CACHE_KEY_PREFIX = 'danmu-cache';
const DANMU_LOCAL_CACHE_KEY = 'lunatv_danmu_cache';
const DANMU_MEMORY_CACHE_LIMIT = 3;
const DANMU_CACHE_LOOKUP_TIMEOUT = 1000;
// 上游默认允许 30 秒；客户端给匹配、传输及响应解析留出余量。
const DANMU_LOAD_TIMEOUT = 45000;

function emptyResult(cancelled = false): DanmuLoadResult {
  return cancelled
    ? { count: 0, data: [], cancelled: true }
    : { count: 0, data: [] };
}

function initialLoadMeta(): DanmuLoadMeta {
  return { source: 'init', loadedAt: null, count: 0 };
}

function getDanmuCacheKey(
  options: UseDanmuOptions,
  override: DanmuManualOverride | null | undefined,
): string {
  const base = `${options.videoTitle}_${options.videoYear}_${options.videoDoubanId}_${options.currentEpisodeIndex + 1}`;
  let key = override
    ? `${base}__manual_${override.animeId}_${override.episodeId}`
    : base;
  if (override?.episodeUrl)
    key += `__url_${encodeURIComponent(override.episodeUrl)}`;
  return key;
}

function isDanmuList(value: unknown): value is any[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.text === 'string' &&
        typeof item.time === 'number' &&
        Number.isFinite(item.time) &&
        (item.color === undefined || typeof item.color === 'string') &&
        (item.mode === undefined || [0, 1, 2].includes(item.mode)),
    )
  );
}

function isFreshCacheItem(item: any): item is DanmuCacheItem {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof item.timestamp === 'number' &&
    Number.isFinite(item.timestamp) &&
    item.timestamp <= Date.now() &&
    Date.now() - item.timestamp < DANMU_CACHE_DURATION * 1000 &&
    Array.isArray(item.data) &&
    item.data.length > 0
  );
}

function isUsableDanmuCache(item: unknown): item is DanmuCacheItem {
  return isFreshCacheItem(item) && isDanmuList(item.data);
}

function getLocalDanmuCacheItem(key: string): DanmuCacheItem | null {
  try {
    const raw = localStorage.getItem(DANMU_LOCAL_CACHE_KEY);
    if (!raw) return null;
    const item = JSON.parse(raw)?.[key];
    return isUsableDanmuCache(item) ? item : null;
  } catch {
    return null;
  }
}

function setLocalDanmuCacheItem(key: string, item: DanmuCacheItem): void {
  try {
    let previous: Record<string, DanmuCacheItem> = {};
    try {
      const raw = localStorage.getItem(DANMU_LOCAL_CACHE_KEY);
      if (raw) previous = JSON.parse(raw) || {};
    } catch {
      // 损坏的旧缓存不影响保存本次有效结果。
    }
    const entries = Object.entries(previous)
      .filter(([oldKey, value]) => oldKey !== key && isFreshCacheItem(value))
      .slice(-9);
    entries.push([key, item]);
    localStorage.setItem(
      DANMU_LOCAL_CACHE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // 存储被禁用或额度已满时，仍可使用内存和服务端缓存。
  }
}

function abortedError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('弹幕请求已取消');
  error.name = 'AbortError';
  return error;
}

/** 即使底层缓存适配器未响应取消，调用方也能及时结束等待。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError(signal));
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function getSharedDanmuCacheItem(
  key: string,
  signal: AbortSignal,
): Promise<DanmuCacheItem | null> {
  if (signal.aborted) throw abortedError(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    DANMU_CACHE_LOOKUP_TIMEOUT,
  );
  try {
    const cached = await abortable(
      ClientCache.get(`${DANMU_CACHE_KEY_PREFIX}-${key}`, controller.signal),
      controller.signal,
    );
    return isUsableDanmuCache(cached) ? cached : null;
  } catch {
    if (signal.aborted) throw abortedError(signal);
    return null;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

function persistDanmuCacheItem(
  key: string,
  item: DanmuCacheItem,
  shared: boolean,
): void {
  // 序列化和 POST 不阻塞弹幕交给播放器；两种存储独立失败。
  setTimeout(() => {
    setLocalDanmuCacheItem(key, item);
    if (shared) {
      void ClientCache.set(
        `${DANMU_CACHE_KEY_PREFIX}-${key}`,
        item,
        DANMU_CACHE_DURATION,
      ).catch(() => {});
    }
  }, 0);
}

export function useDanmu(options: UseDanmuOptions): UseDanmuReturn {
  const {
    videoTitle,
    videoYear,
    videoDoubanId,
    currentEpisodeIndex,
    currentSource,
    artPlayerRef,
    manualOverride,
    canApplyToPlayer,
  } = options;
  const [externalDanmuEnabled, setEnabledState] = useState(() => {
    try {
      return localStorage.getItem('enable_external_danmu') === 'true';
    } catch {
      return false;
    }
  });
  const [danmuList, setDanmuList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadMeta, setLoadMeta] = useState<DanmuLoadMeta>(initialLoadMeta);

  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const configuredKeyRef = useRef(getDanmuCacheKey(options, manualOverride));
  const displayedKeyRef = useRef('');
  const activeRequestRef = useRef<DanmuRequest | null>(null);
  const memoryCacheRef = useRef(new Map<string, DanmuCacheItem>());
  const applicationGenerationRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCandidateRef = useRef<{
    key: string;
    manualOverride: DanmuManualOverride | null | undefined;
  } | null>(null);
  const autoRetryDanmuScopeRef = useRef('');
  const externalDanmuEnabledRef = useRef(externalDanmuEnabled);
  const danmuLoadingRef = useRef<any>(false);
  const lastDanmuLoadKeyRef = useRef('');
  const danmuPluginStateRef = useRef<any>(null);

  const cancelExternalDanmuLoad = useCallback(() => {
    const request = activeRequestRef.current;
    activeRequestRef.current = null;
    request?.controller.abort();
    danmuLoadingRef.current = false;
    applicationGenerationRef.current++;
    retryCandidateRef.current = null;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const player = optionsRef.current.artPlayerRef.current;
    if (player) cancelDanmuApplication(player);
    if (mountedRef.current) setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelExternalDanmuLoad();
    };
  }, [cancelExternalDanmuLoad]);

  useEffect(() => {
    const latestOptions = {
      videoTitle,
      videoYear,
      videoDoubanId,
      currentEpisodeIndex,
      currentSource,
      artPlayerRef,
      manualOverride,
      canApplyToPlayer,
    };
    optionsRef.current = latestOptions;
    const key = getDanmuCacheKey(latestOptions, manualOverride);
    if (configuredKeyRef.current === key) return;
    configuredKeyRef.current = key;
    // 手动选择可能在 React 提交前就完成加载；保留对应请求、分批应用和补试。
    const request = activeRequestRef.current;
    if (
      request
        ? request.key !== key
        : displayedKeyRef.current !== key || lastDanmuLoadKeyRef.current !== key
    )
      cancelExternalDanmuLoad();
    if (displayedKeyRef.current !== key) {
      setDanmuList([]);
      setError(null);
      setLoadMeta(initialLoadMeta());
    }
    if (
      autoRetryDanmuScopeRef.current !== `pending:${key}` &&
      autoRetryDanmuScopeRef.current !== `done:${key}`
    )
      autoRetryDanmuScopeRef.current = `pending:${key}`;
  }, [
    videoTitle,
    videoYear,
    videoDoubanId,
    currentEpisodeIndex,
    currentSource,
    artPlayerRef,
    manualOverride,
    canApplyToPlayer,
    cancelExternalDanmuLoad,
  ]);

  const setExternalDanmuEnabled = useCallback(
    (enabled: boolean) => {
      externalDanmuEnabledRef.current = enabled;
      setEnabledState(enabled);
      if (!enabled) cancelExternalDanmuLoad();
    },
    [cancelExternalDanmuLoad],
  );

  const loadExternalDanmu = useCallback(
    (loadOptions?: DanmuLoadOptions): Promise<DanmuLoadResult> => {
      if (!mountedRef.current || !externalDanmuEnabledRef.current)
        return Promise.resolve(emptyResult(true));
      const current = optionsRef.current;
      const override =
        loadOptions?.manualOverride !== undefined
          ? loadOptions.manualOverride
          : current.manualOverride;
      if (!current.videoTitle && !current.videoDoubanId && !override?.episodeId)
        return Promise.resolve(emptyResult());
      const force = loadOptions?.force === true;
      const key = getDanmuCacheKey(current, override);
      const previous = activeRequestRef.current;
      if (
        !force &&
        previous?.key === key &&
        !previous.controller.signal.aborted
      )
        return previous.promise;
      if (previous || force || lastDanmuLoadKeyRef.current !== key)
        cancelExternalDanmuLoad();
      if (
        autoRetryDanmuScopeRef.current !== `pending:${key}` &&
        autoRetryDanmuScopeRef.current !== `done:${key}`
      ) {
        autoRetryDanmuScopeRef.current = `pending:${key}`;
      }
      retryCandidateRef.current = null;
      lastDanmuLoadKeyRef.current = key;
      setLoading(true);
      setError(null);
      if (displayedKeyRef.current !== key) {
        setDanmuList([]);
        setLoadMeta(initialLoadMeta());
      }

      const request: DanmuRequest = {
        key,
        controller: new AbortController(),
        promise: Promise.resolve(emptyResult(true)),
        timedOut: false,
      };
      activeRequestRef.current = request;
      danmuLoadingRef.current = {
        loading: true,
        timestamp: Date.now(),
        requestKey: key,
        source: current.currentSource,
        episode: current.currentEpisodeIndex + 1,
      };
      const signal = request.controller.signal;
      const timeout = setTimeout(() => {
        request.timedOut = true;
        request.controller.abort(new Error('弹幕加载超时，请重试'));
      }, DANMU_LOAD_TIMEOUT);
      const ownsRequest = () =>
        mountedRef.current &&
        activeRequestRef.current === request &&
        externalDanmuEnabledRef.current;

      const readData = async (): Promise<{
        item: DanmuCacheItem;
        source: DanmuLoadMeta['source'];
        persist: 'none' | 'local' | 'all';
      }> => {
        if (!force) {
          const memory = memoryCacheRef.current.get(key);
          if (isUsableDanmuCache(memory))
            return { item: memory, source: 'cache', persist: 'none' };
          memoryCacheRef.current.delete(key);
          const local = getLocalDanmuCacheItem(key);
          if (local) return { item: local, source: 'cache', persist: 'none' };
          const shared = await getSharedDanmuCacheItem(key, signal);
          if (shared)
            return { item: shared, source: 'cache', persist: 'local' };
        }
        if (signal.aborted) throw abortedError(signal);
        const params = new URLSearchParams();
        if (current.videoDoubanId > 0)
          params.set('douban_id', String(current.videoDoubanId));
        if (current.videoTitle) params.set('title', current.videoTitle);
        if (current.videoYear) params.set('year', current.videoYear);
        if (current.currentEpisodeIndex >= 0)
          params.set('episode', String(current.currentEpisodeIndex + 1));
        if (override?.episodeId)
          params.set('episode_id', String(override.episodeId));
        if (override?.episodeUrl)
          params.set('episode_url', override.episodeUrl);
        const response = await fetch(`/api/danmu-external?${params}`, {
          signal,
        });
        if (!response.ok) throw new Error(`弹幕加载失败: ${response.status}`);
        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data))
          throw new Error('弹幕接口返回的数据格式无效');
        if (
          (data.code !== undefined && data.code !== 200) ||
          data.success === false ||
          data.error
        ) {
          throw new Error(
            typeof data.error === 'string' && data.error
              ? data.error
              : typeof data.message === 'string' && data.message
                ? data.message
                : '弹幕接口返回失败',
          );
        }
        if (!isDanmuList(data.danmu))
          throw new Error('弹幕接口返回的弹幕数据格式无效');
        return {
          item: { data: data.danmu, timestamp: Date.now() },
          source: force ? 'network-retry' : 'network',
          persist: 'all',
        };
      };

      request.promise = abortable(readData(), signal)
        .then(({ item, source, persist }) => {
          if (!ownsRequest() || signal.aborted) return emptyResult(true);
          if (item.data.length > 0) {
            const memory = memoryCacheRef.current;
            memory.delete(key);
            memory.set(key, item);
            while (memory.size > DANMU_MEMORY_CACHE_LIMIT) {
              const oldestKey = memory.keys().next().value;
              if (oldestKey === undefined) break;
              memory.delete(oldestKey);
            }
            if (persist !== 'none')
              persistDanmuCacheItem(key, item, persist === 'all');
          } else {
            // 空结果不写入缓存；只在真正完成一次请求后安排一次补试。
            retryCandidateRef.current = { key, manualOverride: override };
          }
          displayedKeyRef.current = key;
          setDanmuList(item.data);
          setLoadMeta({
            source,
            loadedAt: item.timestamp,
            count: item.data.length,
          });
          return { count: item.data.length, data: item.data };
        })
        .catch((loadError: unknown) => {
          if (!ownsRequest() || (signal.aborted && !request.timedOut))
            return emptyResult(true);
          const failure =
            loadError instanceof Error ? loadError : new Error('弹幕加载失败');
          displayedKeyRef.current = key;
          setDanmuList([]);
          setError(failure);
          setLoadMeta({ source: 'error', loadedAt: Date.now(), count: 0 });
          return { ...emptyResult(), error: failure };
        })
        .finally(() => {
          clearTimeout(timeout);
          if (activeRequestRef.current !== request) return;
          activeRequestRef.current = null;
          danmuLoadingRef.current = false;
          if (mountedRef.current) setLoading(false);
        });
      return request.promise;
    },
    [cancelExternalDanmuLoad],
  );

  const loadDanmuForPlayer = useCallback(
    async (loadOptions?: DanmuLoadOptions): Promise<DanmuLoadResult> => {
      const player = optionsRef.current.artPlayerRef.current;
      const playbackKey = player?._playbackKey;
      const pending = loadExternalDanmu(loadOptions);
      const generation = applicationGenerationRef.current;
      const queryKey = lastDanmuLoadKeyRef.current;
      const result = await pending;
      const isCurrent = () =>
        !result.cancelled &&
        mountedRef.current &&
        externalDanmuEnabledRef.current &&
        applicationGenerationRef.current === generation &&
        lastDanmuLoadKeyRef.current === queryKey &&
        optionsRef.current.artPlayerRef.current === player &&
        !player?.isDestroy &&
        (!player || optionsRef.current.canApplyToPlayer?.(player) !== false) &&
        player?._playbackKey === playbackKey;
      if (!isCurrent()) return emptyResult(true);
      if (result.error) return result;
      if (!player) return emptyResult(true);
      try {
        const applied = await applyDanmuToPlayer(player, result.data, {
          key: playbackKey,
          isCurrent,
          shouldShow: () => {
            if (!externalDanmuEnabledRef.current) return false;
            try {
              return localStorage.getItem('danmaku_visible') !== 'false';
            } catch {
              return true;
            }
          },
        });
        if (!applied || !isCurrent()) return emptyResult(true);
        if (result.count > 0 && player.notice)
          player.notice.show = `已加载 ${result.count} 条弹幕`;
        return result;
      } catch (applyError: unknown) {
        if (!isCurrent()) return emptyResult(true);
        const failure =
          applyError instanceof Error
            ? applyError
            : new Error('弹幕显示失败，请重试');
        setError(failure);
        setLoadMeta({
          source: 'error',
          loadedAt: Date.now(),
          count: result.count,
        });
        return { ...result, error: failure };
      }
    },
    [loadExternalDanmu],
  );

  useEffect(() => {
    const candidate = retryCandidateRef.current;
    if (
      loading ||
      !externalDanmuEnabled ||
      danmuList.length > 0 ||
      !candidate ||
      autoRetryDanmuScopeRef.current !== `pending:${candidate.key}`
    )
      return;
    const timer = setTimeout(() => {
      retryTimerRef.current = null;
      if (
        activeRequestRef.current ||
        !externalDanmuEnabledRef.current ||
        retryCandidateRef.current !== candidate ||
        lastDanmuLoadKeyRef.current !== candidate.key
      )
        return;
      autoRetryDanmuScopeRef.current = `done:${candidate.key}`;
      void loadDanmuForPlayer({
        force: true,
        manualOverride: candidate.manualOverride,
      }).catch(() => {});
    }, 900);
    retryTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (retryTimerRef.current === timer) retryTimerRef.current = null;
    };
  }, [
    loading,
    externalDanmuEnabled,
    danmuList.length,
    loadMeta,
    loadDanmuForPlayer,
  ]);

  const handleDanmuOperationOptimized = useCallback(
    (nextState: boolean) => {
      setExternalDanmuEnabled(nextState);
      try {
        localStorage.setItem('enable_external_danmu', String(nextState));
        // 在开启时保存意图；等待数据/切流期间的新显隐选择仍可覆盖它。
        if (nextState) localStorage.setItem('danmaku_visible', 'true');
      } catch {
        /* 本次会话中的开关仍可正常使用。 */
      }
      if (!nextState) {
        optionsRef.current.artPlayerRef.current?.plugins?.artplayerPluginDanmuku?.hide();
        return;
      }
      void loadDanmuForPlayer().catch(() => {});
    },
    [loadDanmuForPlayer, setExternalDanmuEnabled],
  );

  return {
    externalDanmuEnabled,
    setExternalDanmuEnabled,
    danmuList,
    loading,
    loadMeta,
    error,
    loadExternalDanmu,
    loadDanmuForPlayer,
    cancelExternalDanmuLoad,
    handleDanmuOperationOptimized,
    externalDanmuEnabledRef,
    danmuLoadingRef,
    lastDanmuLoadKeyRef,
    danmuPluginStateRef,
  };
}
