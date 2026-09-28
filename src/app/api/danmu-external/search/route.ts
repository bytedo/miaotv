/* eslint-disable no-console */
import { NextResponse } from 'next/server';

import {
  type DanmuAnime,
  DanmuApiError,
  getDanmuApiConfig,
  getDanmuApiErrorMessage,
  getDanmuEpisodes,
  searchDanmuAnimes,
} from '@/lib/danmu-api';

export const runtime = 'nodejs';

function cancelledResponse() {
  return NextResponse.json(
    { code: 499, message: '弹幕搜索已取消', animes: [] },
    { status: 499, headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}

export async function GET(request: Request) {
  if (request.signal.aborted) return cancelledResponse();
  const { searchParams } = new URL(request.url);
  const keyword = (searchParams.get('keyword') || '').trim();

  if (!keyword) {
    return NextResponse.json(
      { code: 400, message: '缺少必要参数: keyword', animes: [] },
      { status: 400 },
    );
  }

  const config = await getDanmuApiConfig();
  if (request.signal.aborted) return cancelledResponse();
  if (!config.enabled || !config.apiUrl) {
    return NextResponse.json(
      { code: 503, message: '弹幕API未启用', animes: [] },
      { status: 503 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout * 1000);
  try {
    console.log(`[danmu-search] 搜索: "${keyword}"`);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const animes = await searchDanmuAnimes(config, keyword, signal);
    request.signal.throwIfAborted();
    const results: (DanmuAnime | undefined)[] = animes.map((anime) =>
      anime.episodes.length > 0 ? anime : undefined,
    );
    const pendingDetails = animes
      .map((anime, index) => ({ anime, index }))
      .filter(({ anime }) => anime.episodes.length === 0);
    let nextDetail = 0;
    let detailError: unknown;

    await Promise.all(
      Array.from({ length: Math.min(4, pendingDetails.length) }, async () => {
        while (!signal.aborted && nextDetail < pendingDetails.length) {
          const { anime, index } = pendingDetails[nextDetail++];
          try {
            const episodes = await getDanmuEpisodes(config, anime, signal);
            if (episodes.length > 0) results[index] = { ...anime, episodes };
          } catch (error) {
            detailError ??= error;
          }
        }
      }),
    );
    request.signal.throwIfAborted();
    const animesWithEpisodes = results.filter(
      (anime): anime is DanmuAnime => anime !== undefined,
    );
    if (animesWithEpisodes.length === 0) {
      if (detailError) throw detailError;
      if (signal.aborted) throw new DanmuApiError('弹幕剧集查询超时，请重试');
    }

    console.log(`[danmu-search] 找到 ${animesWithEpisodes.length} 个结果`);
    return NextResponse.json(
      {
        code: 200,
        message: '获取成功',
        keyword,
        animes: animesWithEpisodes,
        count: animesWithEpisodes.length,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    if (request.signal.aborted) return cancelledResponse();
    const message = getDanmuApiErrorMessage(error);
    console.error(`[danmu-search] ${message}`);
    return NextResponse.json(
      { code: 502, message, animes: [] },
      { status: 502, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
