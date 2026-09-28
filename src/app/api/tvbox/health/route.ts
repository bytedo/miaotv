import { NextRequest, NextResponse } from 'next/server';

import {
  fetchWithValidatedRedirects,
  ProxyTargetError,
} from '@/lib/proxy-security';
import {
  ProxySourceError,
  requireProxyAdministrator,
} from '@/lib/proxy-source';
import { DEFAULT_USER_AGENT } from '@/lib/user-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Spider jar健康检查端点
export async function GET(req: NextRequest) {
  try {
    await requireProxyAdministrator(req);
    const { searchParams } = new URL(req.url);
    const jarUrl = searchParams.get('url');

    if (!jarUrl) {
      return NextResponse.json(
        {
          error: 'Missing jar URL parameter',
        },
        { status: 400 },
      );
    }

    // 清理URL（移除MD5部分）
    const cleanUrl = jarUrl.split(';')[0];

    try {
      const response = await fetchWithValidatedRedirects(
        cleanUrl,
        {
          method: 'HEAD',
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': DEFAULT_USER_AGENT },
        },
        { timeoutMs: 10000 },
      );

      const result = {
        url: cleanUrl,
        status: response.status,
        statusText: response.statusText,
        accessible: response.ok,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        lastModified: response.headers.get('last-modified'),
        timestamp: new Date().toISOString(),
      };

      await response.body?.cancel();
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'private, no-store' },
      });
    } catch (fetchError) {
      const errorMessage =
        fetchError instanceof Error ? fetchError.message : 'Unknown error';

      return NextResponse.json(
        {
          url: cleanUrl,
          accessible: false,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
        {
          status:
            fetchError instanceof ProxyTargetError ? fetchError.status : 200,
          headers: { 'Cache-Control': 'private, no-store' },
        },
      );
    }
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof ProxySourceError
            ? error.message
            : 'Internal server error',
      },
      { status: error instanceof ProxySourceError ? error.status : 500 },
    );
  }
}
