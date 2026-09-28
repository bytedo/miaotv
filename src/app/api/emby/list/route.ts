import { NextRequest, NextResponse } from 'next/server';

import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { getCachedEmbyList, setCachedEmbyList } from '@/lib/emby-cache';
import { embyManager } from '@/lib/emby-manager';
import { optionalFeatureUnavailable } from '@/lib/optional-features.server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const unavailable = await optionalFeatureUnavailable('EnableEmby');
  if (unavailable) return unavailable;

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get('page') || '1');
  const pageSize = parseInt(searchParams.get('pageSize') || '20');
  const parentId = searchParams.get('parentId') || undefined;
  const embyKey = searchParams.get('embyKey') || undefined;
  const sortBy = searchParams.get('sortBy') || 'SortName';
  const sortOrder = searchParams.get('sortOrder') || 'Ascending';

  try {
    // 从 cookie 获取用户信息
    const authCookie = await getVerifiedAuthInfo(request);

    if (!authCookie?.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const userRef = authCookie.uid;

    // 缓存命中前也要检查当前权限；客户端变化时使用独立缓存。
    const client = await embyManager.getClientForUser(userRef, embyKey);
    const cacheScope = { uid: userRef, client };

    // 判断是否是默认排序（只有默认排序才使用缓存）
    const isDefaultSort = sortBy === 'SortName' && sortOrder === 'Ascending';

    // 只有默认排序才检查缓存
    if (isDefaultSort) {
      const cached = getCachedEmbyList(cacheScope, page, pageSize, parentId);
      if (cached) {
        return NextResponse.json(cached);
      }
    }

    // 获取媒体列表
    const result = await client.getItems({
      ParentId: parentId,
      IncludeItemTypes: 'Movie,Series',
      Recursive: true,
      Fields: 'Overview,ProductionYear',
      SortBy: sortBy,
      SortOrder: sortOrder,
      StartIndex: (page - 1) * pageSize,
      Limit: pageSize,
    });

    const list = result.Items.map((item) => ({
      id: item.Id,
      title: item.Name,
      poster: client.getImageUrl(item.Id, 'Primary'),
      year: item.ProductionYear?.toString() || '',
      rating: item.CommunityRating || 0,
      mediaType: item.Type === 'Movie' ? 'movie' : 'tv',
    }));

    const totalPages = Math.ceil(result.TotalRecordCount / pageSize);

    const response = {
      success: true,
      list,
      totalPages,
      currentPage: page,
      total: result.TotalRecordCount,
    };

    // 只有默认排序才缓存结果
    if (isDefaultSort) {
      setCachedEmbyList(cacheScope, page, pageSize, response, parentId);
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('获取 Emby 列表失败:', error);
    return NextResponse.json({
      error: '获取 Emby 列表失败: ' + (error as Error).message,
      list: [],
      totalPages: 0,
      currentPage: page,
      total: 0,
    });
  }
}
