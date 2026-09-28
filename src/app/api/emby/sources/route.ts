import { NextRequest, NextResponse } from 'next/server';

import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { embyManager } from '@/lib/emby-manager';
import { optionalFeatureUnavailable } from '@/lib/optional-features.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // 禁用缓存

/**
 * 获取用户的所有启用的Emby源列表
 */
export async function GET(request: NextRequest) {
  const unavailable = await optionalFeatureUnavailable('EnableEmby');
  if (unavailable) return unavailable;

  try {
    // 从 cookie 获取用户信息
    const authCookie = await getVerifiedAuthInfo(request);

    if (!authCookie?.username) {
      return NextResponse.json(
        { error: '未登录', sources: [] },
        { status: 401 }
      );
    }

    const userRef = authCookie.uid;
    const sources = await embyManager.getEnabledSourcesForUser(userRef);

    return NextResponse.json({
      sources: sources.map(s => ({
        key: s.key,
        name: s.name,
      })),
    });
  } catch (error) {
    console.error('[Emby Sources] 获取Emby源列表失败:', error);
    return NextResponse.json(
      { error: '获取Emby源列表失败', sources: [] },
      { status: 500 }
    );
  }
}
