import { NextRequest, NextResponse } from 'next/server';

import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { getCachedEmbyViews, setCachedEmbyViews } from '@/lib/emby-cache';
import { embyManager } from '@/lib/emby-manager';
import { optionalFeatureUnavailable } from '@/lib/optional-features.server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const unavailable = await optionalFeatureUnavailable('EnableEmby');
  if (unavailable) return unavailable;

  try {
    const { searchParams } = new URL(request.url);
    const embyKey = searchParams.get('embyKey') || undefined;

    // 从 cookie 获取用户信息
    const authCookie = await getVerifiedAuthInfo(request);

    if (!authCookie?.username) {
      return NextResponse.json(
        { error: '未登录', success: false },
        { status: 401 },
      );
    }

    const userRef = authCookie.uid;

    // 缓存命中前也要检查当前权限；客户端变化时使用独立缓存。
    const client = await embyManager.getClientForUser(userRef, embyKey);
    const cacheScope = { uid: userRef, client };
    const cached = getCachedEmbyViews(cacheScope);
    if (cached) {
      return NextResponse.json(cached);
    }

    // 获取媒体库列表
    const views = await client.getUserViews();

    // 过滤出电影和电视剧媒体库
    const filteredViews = views.filter(
      (view) =>
        view.CollectionType === 'movies' || view.CollectionType === 'tvshows',
    );

    const response = {
      success: true,
      views: filteredViews.map((view) => ({
        id: view.Id,
        name: view.Name,
        type: view.CollectionType,
      })),
    };

    // 缓存结果
    setCachedEmbyViews(cacheScope, response);

    return NextResponse.json(response);
  } catch (error) {
    console.error('获取 Emby 媒体库列表失败:', error);
    return NextResponse.json({
      error: '获取 Emby 媒体库列表失败: ' + (error as Error).message,
      views: [],
    });
  }
}
