// Emby 媒体缓存：调用方必须先取得当前用户有权使用的客户端。

import type { EmbyClient } from './emby.client';

export interface EmbyCacheScope {
  uid: string;
  client: EmbyClient;
}

// 缓存条目接口
export interface EmbyCachedEntry<T> {
  expiresAt: number;
  data: T;
}

// 缓存配置
const EMBY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6小时
const EMBY_VIEWS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1天
const EMBY_CACHE: Map<string, EmbyCachedEntry<any>> = new Map();
const CLIENT_IDS = new WeakMap<object, number>();
let nextClientId = 0;

function makeCacheKey(
  scope: EmbyCacheScope,
  kind: 'list' | 'views' | 'index',
  ...params: (string | number | undefined)[]
): string {
  let clientId = CLIENT_IDS.get(scope.client);
  if (clientId === undefined) {
    clientId = ++nextClientId;
    CLIENT_IDS.set(scope.client, clientId);
  }

  // manager 会在配置、凭据或访问策略变化后重建客户端。
  // 用实例 ID 区分这些版本，缓存键中不存放凭据。
  return `emby:${JSON.stringify([scope.uid, clientId, kind, ...params])}`;
}

function setEntry(key: string, data: any, ttl: number): void {
  const now = Date.now();
  // 旧客户端的键不会再被读取，写入时清走这些已过期条目。
  for (const [cachedKey, entry] of EMBY_CACHE) {
    if (entry.expiresAt <= now) EMBY_CACHE.delete(cachedKey);
  }
  EMBY_CACHE.set(key, { expiresAt: now + ttl, data });
}

/**
 * 获取缓存的 Emby 列表数据
 */
export function getCachedEmbyList(
  scope: EmbyCacheScope,
  page: number,
  pageSize: number,
  parentId?: string,
): any | null {
  const key = makeCacheKey(scope, 'list', page, pageSize, parentId);
  const entry = EMBY_CACHE.get(key);
  if (!entry) return null;

  // 检查是否过期
  if (entry.expiresAt <= Date.now()) {
    EMBY_CACHE.delete(key);
    return null;
  }

  return entry.data;
}

/**
 * 设置缓存的 Emby 列表数据
 */
export function setCachedEmbyList(
  scope: EmbyCacheScope,
  page: number,
  pageSize: number,
  data: any,
  parentId?: string,
): void {
  const key = makeCacheKey(scope, 'list', page, pageSize, parentId);
  setEntry(key, data, EMBY_CACHE_TTL_MS);
}

/**
 * 清除所有 Emby 缓存
 */
export function clearEmbyCache(): { cleared: number } {
  const size = EMBY_CACHE.size;
  EMBY_CACHE.clear();
  return { cleared: size };
}

/**
 * 获取缓存的 Emby 媒体库列表
 */
export function getCachedEmbyViews(scope: EmbyCacheScope): any | null {
  const cacheKey = makeCacheKey(scope, 'views');
  const entry = EMBY_CACHE.get(cacheKey);
  if (!entry) return null;

  // 检查是否过期
  if (entry.expiresAt <= Date.now()) {
    EMBY_CACHE.delete(cacheKey);
    return null;
  }

  return entry.data;
}

/**
 * 设置缓存的 Emby 媒体库列表
 */
export function setCachedEmbyViews(scope: EmbyCacheScope, data: any): void {
  const cacheKey = makeCacheKey(scope, 'views');
  setEntry(cacheKey, data, EMBY_VIEWS_CACHE_TTL_MS);
}

// 搜索索引缓存相关

interface MediaIndexItem {
  id: string;
  title: string;
  poster: string;
  year: string;
  releaseDate?: string;
  overview?: string;
  voteAverage?: number;
  rating?: number;
  mediaType: 'movie' | 'tv';
}

/**
 * 获取缓存的全量媒体索引
 */
export function getCachedMediaIndex(
  scope: EmbyCacheScope,
  parentId?: string,
): MediaIndexItem[] | null {
  const key = makeCacheKey(scope, 'index', parentId);
  const entry = EMBY_CACHE.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    EMBY_CACHE.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * 设置全量媒体索引缓存
 */
export function setCachedMediaIndex(
  scope: EmbyCacheScope,
  data: MediaIndexItem[],
  parentId?: string,
): void {
  const key = makeCacheKey(scope, 'index', parentId);
  setEntry(key, data, EMBY_CACHE_TTL_MS);
}

/**
 * 获取缓存统计信息
 */
export function getEmbyCacheStats(): {
  size: number;
  keys: string[];
} {
  return {
    size: EMBY_CACHE.size,
    keys: Array.from(EMBY_CACHE.keys()),
  };
}
