import { getConfig } from '@/lib/config';
import { DEFAULT_USER_AGENT } from '@/lib/user-agent';

const DEFAULT_DANMU_API_URL = 'https://smonedanmu.vercel.app';
const DEFAULT_DANMU_API_TOKEN = 'smonetv';

export interface DanmuApiConfig {
  enabled: boolean;
  apiUrl: string;
  token: string;
  timeout: number;
}

export interface DanmuEpisode {
  episodeId: number;
  episodeTitle: string;
  url?: string;
}

export interface DanmuAnime {
  animeId: number;
  animeTitle: string;
  type: string;
  typeDescription?: string;
  imageUrl?: string;
  episodes: DanmuEpisode[];
}

interface DanmuComment {
  p?: string;
  m?: string;
  t?: number;
}

export class DanmuApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DanmuApiError';
  }
}

export function getDanmuApiErrorMessage(error: unknown): string {
  // Fetch and JSON errors can contain the configured URL or response contents.
  return error instanceof DanmuApiError ? error.message : '弹幕接口请求失败';
}

export async function getDanmuApiConfig(): Promise<DanmuApiConfig> {
  try {
    const { DanmuApiConfig: config } = await getConfig();
    if (config?.enabled === false) {
      return { enabled: false, apiUrl: '', token: '', timeout: 15 };
    }

    const timeout =
      Number.isFinite(config?.timeout) && config.timeout > 0
        ? config.timeout
        : 30;
    if (config?.useCustomApi && config.customApiUrl) {
      return {
        enabled: true,
        apiUrl: config.customApiUrl.trim(),
        token: (config.customToken || '').trim(),
        timeout,
      };
    }

    return {
      enabled: true,
      apiUrl: DEFAULT_DANMU_API_URL,
      token: DEFAULT_DANMU_API_TOKEN,
      timeout,
    };
  } catch {
    return {
      enabled: true,
      apiUrl: DEFAULT_DANMU_API_URL,
      token: DEFAULT_DANMU_API_TOKEN,
      timeout: 30,
    };
  }
}

export function buildDanmuApiUrl(
  config: DanmuApiConfig,
  endpoint: string,
  params: Record<string, string> = {},
): URL {
  let url: URL;
  try {
    url = new URL(config.apiUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new DanmuApiError('弹幕API地址无效');
  }

  let basePath = url.pathname.replace(/\/+$/, '').replace(/\/api\/v2$/, '');
  const token = config.token.trim();
  const tokenPath = encodeURIComponent(token);
  if (token && !basePath.endsWith(`/${tokenPath}`)) {
    basePath += `/${tokenPath}`;
  }
  url.pathname = `${basePath}/api/v2/${endpoint.replace(/^\/+/, '')}`;
  url.hash = '';
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

export function normalizeDanmuVideoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function normalizeEpisodes(value: unknown): DanmuEpisode[] {
  if (!Array.isArray(value)) return [];
  const episodes: DanmuEpisode[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const episodeId = positiveId(item.episodeId);
    if (!episodeId) continue;
    episodes.push({
      episodeId,
      episodeTitle: readString(item.episodeTitle) || `episodeId:${episodeId}`,
      url: normalizeDanmuVideoUrl(item.url),
    });
  }
  return episodes;
}

function normalizeAnimes(value: unknown[]): DanmuAnime[] {
  const animes: DanmuAnime[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const animeId = positiveId(item.animeId);
    if (!animeId) continue;
    animes.push({
      animeId,
      animeTitle: readString(item.animeTitle) || `animeId:${animeId}`,
      type: readString(item.type) || 'unknown',
      typeDescription: readString(item.typeDescription),
      imageUrl: readString(item.imageUrl),
      episodes: normalizeEpisodes(item.episodes),
    });
  }
  return animes;
}

async function requestDanmuJson(
  config: DanmuApiConfig,
  endpoint: string,
  params: Record<string, string>,
  operation: string,
  signal?: AbortSignal,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestSignal = signal || AbortSignal.timeout(config.timeout * 1000);
  let response: Response;
  try {
    response = await fetch(buildDanmuApiUrl(config, endpoint, params), {
      method: body ? 'POST' : 'GET',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: requestSignal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DanmuApiError) throw error;
    throw new DanmuApiError(
      requestSignal.aborted
        ? `${operation}超时，请重试`
        : `${operation}连接失败`,
    );
  }
  if (!response.ok) {
    throw new DanmuApiError(
      `${operation}失败: HTTP ${response.status}`,
      response.status,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new DanmuApiError(
      requestSignal.aborted
        ? `${operation}超时，请重试`
        : `${operation}失败: 接口返回无效 JSON`,
    );
  }
  if (!isRecord(data)) throw new DanmuApiError(`${operation}返回格式无效`);
  if (
    data.success === false ||
    (data.errorCode != null && Number(data.errorCode) !== 0)
  ) {
    const code = Number(data.errorCode);
    throw new DanmuApiError(
      Number.isFinite(code) && code !== 0
        ? `${operation}失败: 接口错误 ${code}`
        : `${operation}失败: 接口返回失败`,
      Number.isFinite(code) ? code : undefined,
    );
  }
  return data;
}

export async function searchDanmuAnimes(
  config: DanmuApiConfig,
  keyword: string,
  signal?: AbortSignal,
): Promise<DanmuAnime[]> {
  // This endpoint resolves search results and episode details in one request.
  // Separate bangumi requests can lose the upstream's in-memory ID mapping.
  try {
    const data = await requestDanmuJson(
      config,
      'search/episodes',
      { anime: keyword },
      '弹幕搜索',
      signal,
    );
    if (Array.isArray(data.animes)) {
      const animes = normalizeAnimes(data.animes);
      if (
        data.animes.length === 0 ||
        animes.some((anime) => anime.episodes.length > 0)
      ) {
        return animes;
      }
    }
  } catch (error) {
    if (
      !(error instanceof DanmuApiError) ||
      ![404, 405, 501].includes(error.status || 0)
    ) {
      throw error;
    }
  }

  const data = await requestDanmuJson(
    config,
    'search/anime',
    { keyword },
    '弹幕搜索',
    signal,
  );
  if (!Array.isArray(data.animes))
    throw new DanmuApiError('弹幕搜索返回格式无效');
  return normalizeAnimes(data.animes);
}

export async function getDanmuEpisodes(
  config: DanmuApiConfig,
  anime: DanmuAnime,
  signal?: AbortSignal,
): Promise<DanmuEpisode[]> {
  if (anime.episodes.length > 0) return anime.episodes;
  const data = await requestDanmuJson(
    config,
    `bangumi/${anime.animeId}`,
    {},
    '弹幕剧集查询',
    signal,
  );
  if (!isRecord(data.bangumi) || !Array.isArray(data.bangumi.episodes)) {
    throw new DanmuApiError('弹幕剧集查询返回格式无效');
  }
  return normalizeEpisodes(data.bangumi.episodes);
}

export async function fetchDanmuComments(
  config: DanmuApiConfig,
  episode: Pick<DanmuEpisode, 'episodeId' | 'url'>,
  signal?: AbortSignal,
): Promise<{ comments: DanmuComment[]; count: number }> {
  const requestSignal = signal || AbortSignal.timeout(config.timeout * 1000);
  const params: Record<string, string> = { format: 'json' };
  const videoUrl = normalizeDanmuVideoUrl(episode.url);
  if (videoUrl) {
    params.url = videoUrl;
    params.segmentflag = 'true';
  }
  // danmu_api prioritizes url; older services still accept the numeric path.
  const data = await requestDanmuJson(
    config,
    `comment/${episode.episodeId}`,
    params,
    '弹幕获取',
    requestSignal,
  );
  if (Array.isArray(data.comments)) {
    return {
      comments: data.comments as DanmuComment[],
      count: typeof data.count === 'number' ? data.count : data.comments.length,
    };
  }

  const index = data.comments;
  const validType = (value: unknown) =>
    typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(value);
  if (
    !isRecord(index) ||
    !validType(index.type) ||
    !Array.isArray(index.segmentList) ||
    index.segmentList.length > 1000
  ) {
    throw new DanmuApiError('弹幕分片索引返回格式无效');
  }

  const segments: Record<string, unknown>[] = [];
  for (const segment of index.segmentList) {
    if (
      !isRecord(segment) ||
      !validType(segment.type) ||
      typeof segment.url !== 'string' ||
      !segment.url.trim() ||
      segment.url.length > 8192 ||
      typeof segment.segment_start !== 'number' ||
      !Number.isFinite(segment.segment_start) ||
      segment.segment_start < 0 ||
      typeof segment.segment_end !== 'number' ||
      !Number.isFinite(segment.segment_end) ||
      segment.segment_end < segment.segment_start
    ) {
      throw new DanmuApiError('弹幕分片索引返回格式无效');
    }
    // Some sources use opaque keys here. Forward the original descriptor to
    // the configured API; never fetch this value as a local URL.
    segments.push(segment);
  }

  const results: DanmuComment[][] = new Array(segments.length);
  let nextSegment = 0;
  let segmentError: DanmuApiError | undefined;
  await Promise.all(
    Array.from({ length: Math.min(6, segments.length) }, async () => {
      while (!segmentError && nextSegment < segments.length) {
        const segmentIndex = nextSegment++;
        try {
          const result = await requestDanmuJson(
            config,
            'segmentcomment',
            { format: 'json' },
            '弹幕分片获取',
            requestSignal,
            segments[segmentIndex],
          );
          if (!Array.isArray(result.comments)) {
            throw new DanmuApiError('弹幕分片获取返回格式无效');
          }
          results[segmentIndex] = result.comments as DanmuComment[];
        } catch (error) {
          segmentError ??=
            error instanceof DanmuApiError
              ? error
              : new DanmuApiError(getDanmuApiErrorMessage(error));
        }
      }
    }),
  );
  if (segmentError) throw segmentError;

  // Segments already contain absolute times; preserve their original order.
  const comments = results.flat();
  return {
    comments,
    count: comments.length,
  };
}
