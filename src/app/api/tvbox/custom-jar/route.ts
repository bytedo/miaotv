import { NextRequest, NextResponse } from 'next/server';
import { clearConfigCache } from '@/lib/config';
import { db } from '@/lib/db';
import { requireProxyAdministrator } from '@/lib/proxy-source';
import { validateProxyTargetUrl } from '@/lib/proxy-security';

export const runtime = 'nodejs';

/**
 * 保存自定义 JAR URL 配置
 * POST /api/tvbox/custom-jar
 */
export async function POST(request: NextRequest) {
  try {
    const config = await requireProxyAdministrator(request);
    const { jarUrl } = await request.json();

    if (!jarUrl || typeof jarUrl !== 'string') {
      return NextResponse.json(
        { error: 'Invalid JAR URL' },
        { status: 400 }
      );
    }

    // 验证 URL 格式
    try {
      await validateProxyTargetUrl(jarUrl);
    } catch {
      return NextResponse.json(
        { error: 'Invalid URL format' },
        { status: 400 }
      );
    }

    // 获取当前配置

    // 更新配置：添加或更新 CustomSpiderJar 字段
    config.CustomSpiderJar = jarUrl;

    // 保存配置
    await db.saveAdminConfig(config);
    clearConfigCache();

    console.log(`[Custom JAR] Saved custom JAR URL: ${jarUrl}`);

    return NextResponse.json({
      success: true,
      jarUrl: jarUrl,
      message: '自定义 JAR 配置已保存',
    });
  } catch (error) {
    console.error('[Custom JAR] Save failed:', error);
    return NextResponse.json(
      {
        error: 'Failed to save custom JAR configuration',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: (error as { status?: number }).status || 500 }
    );
  }
}

/**
 * 获取自定义 JAR URL 配置
 * GET /api/tvbox/custom-jar
 */
export async function GET(request: NextRequest) {
  try {
    const config = await requireProxyAdministrator(request);
    const customJarUrl = config.CustomSpiderJar || null;

    return NextResponse.json({
      jarUrl: customJarUrl,
      enabled: !!customJarUrl,
    });
  } catch (error) {
    console.error('[Custom JAR] Get failed:', error);
    return NextResponse.json(
      {
        error: 'Failed to get custom JAR configuration',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: (error as { status?: number }).status || 500 }
    );
  }
}

/**
 * 删除自定义 JAR URL 配置
 * DELETE /api/tvbox/custom-jar
 */
export async function DELETE(request: NextRequest) {
  try {
    const config = await requireProxyAdministrator(request);
    delete config.CustomSpiderJar;
    await db.saveAdminConfig(config);
    clearConfigCache();

    console.log('[Custom JAR] Deleted custom JAR configuration');

    return NextResponse.json({
      success: true,
      message: '自定义 JAR 配置已删除',
    });
  } catch (error) {
    console.error('[Custom JAR] Delete failed:', error);
    return NextResponse.json(
      {
        error: 'Failed to delete custom JAR configuration',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: (error as { status?: number }).status || 500 }
    );
  }
}
