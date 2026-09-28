
import { NextRequest, NextResponse } from 'next/server';

import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { dbManager } from '@/lib/db';
import { embyManager } from '@/lib/emby-manager';
import { optionalFeatureUnavailable } from '@/lib/optional-features.server';

// GET - 获取用户 Emby 配置
export async function GET(request: NextRequest) {
  const unavailable = await optionalFeatureUnavailable('EnableEmby');
  if (unavailable) return unavailable;

  try {
    // 从 cookie 获取用户信息
    const authCookie = await getVerifiedAuthInfo(request);

    if (!authCookie?.username) {
      return NextResponse.json(
        { error: '未登录' },
        { status: 401 }
      );
    }

    const config = await dbManager.getUserEmbyConfig(authCookie.uid);

    return NextResponse.json({
      success: true,
      config: config || { sources: [] }
    });
  } catch (error: any) {
    console.error('获取用户 Emby 配置失败:', error);
    return NextResponse.json(
      { error: error.message || '获取配置失败' },
      { status: 500 }
    );
  }
}

// POST - 保存用户 Emby 配置
export async function POST(request: NextRequest) {
  const unavailable = await optionalFeatureUnavailable('EnableEmby');
  if (unavailable) return unavailable;

  try {
    // 从 cookie 获取用户信息
    const authCookie = await getVerifiedAuthInfo(request);

    if (!authCookie?.username) {
      return NextResponse.json(
        { error: '未登录' },
        { status: 401 }
      );
    }

    const username = authCookie.username;
    const body = await request.json();
    const { config } = body;

    console.log('📝 保存 Emby 配置 - 用户:', username);

    if (!config || !config.sources || !Array.isArray(config.sources)) {
      return NextResponse.json(
        { error: '配置格式错误' },
        { status: 400 }
      );
    }

    // 验证配置格式
    for (const source of config.sources) {
      if (!source.key || !source.name || !source.ServerURL) {
        return NextResponse.json(
          { error: '源配置缺少必填字段 (key, name, ServerURL)' },
          { status: 400 }
        );
      }
    }

    await dbManager.saveUserEmbyConfig(authCookie.uid, config);

    // 清除用户的 EmbyClient 缓存，使新配置立即生效
    embyManager.clearUserCache(authCookie.uid);
    console.log('🔄 已清除用户 Emby 客户端缓存');

    return NextResponse.json({
      success: true,
      message: '配置保存成功'
    });
  } catch (error: any) {
    console.error('保存用户 Emby 配置失败:', error);
    return NextResponse.json(
      { error: error.message || '保存配置失败' },
      { status: 500 }
    );
  }
}

// DELETE - 删除用户 Emby 配置
export async function DELETE(request: NextRequest) {
  const unavailable = await optionalFeatureUnavailable('EnableEmby');
  if (unavailable) return unavailable;

  try {
    // 从 cookie 获取用户信息
    const authCookie = await getVerifiedAuthInfo(request);

    if (!authCookie?.username) {
      return NextResponse.json(
        { error: '未登录' },
        { status: 401 }
      );
    }

    await dbManager.deleteUserEmbyConfig(authCookie.uid);

    // 清除用户的 EmbyClient 缓存
    embyManager.clearUserCache(authCookie.uid);
    console.log('🔄 已清除用户 Emby 客户端缓存');

    return NextResponse.json({
      success: true,
      message: '配置删除成功'
    });
  } catch (error: any) {
    console.error('删除用户 Emby 配置失败:', error);
    return NextResponse.json(
      { error: error.message || '删除配置失败' },
      { status: 500 }
    );
  }
}
