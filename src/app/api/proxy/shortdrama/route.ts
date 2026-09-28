/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextResponse } from 'next/server';
import { getMediaProxyPolicy } from '@/lib/proxy-source';
import { fetchWithValidatedRedirects } from '@/lib/proxy-security';

export const runtime = 'nodejs';

import * as http from 'http';
import * as https from 'https';

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveMsecs: 30000,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveMsecs: 30000,
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');

  if (!url) {
    return NextResponse.json(
      { error: 'Missing url parameter' },
      { status: 400 }
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时

  try {
    const policy = await getMediaProxyPolicy(request, null);
    const decodedUrl = url;
    const isHttps = decodedUrl.startsWith('https:');
    const agent = isHttps ? httpsAgent : httpAgent;

    const headers: Record<string, string> = {
      'User-Agent': policy.userAgent,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Connection: 'keep-alive',
      Range: request.headers.get('range') || '',
    };

    // 移除空的 Range header
    if (!headers['Range']) {
      delete headers['Range'];
    }

    const response = await fetchWithValidatedRedirects(decodedUrl, {
      method: request.method,
      cache: 'no-cache',
      redirect: 'follow',
      signal: controller.signal,
      headers: new Headers(headers),
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - Node.js specific option
      agent: typeof window === 'undefined' ? agent : undefined,
    }, { ...policy, timeoutMs: 30000 });

    clearTimeout(timeoutId);

    if (!response.ok) {
      await response.body?.cancel();
      return NextResponse.json(
        { error: `Upstream error: ${response.status}` },
        { status: response.status }
      );
    }

    // 流式传输视频内容
    const responseHeaders = new Headers();
    responseHeaders.set(
      'Content-Type',
      response.headers.get('content-type') || 'video/mp4'
    );
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    responseHeaders.set('Content-Security-Policy', "default-src 'none'; sandbox");
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', 'Range');

    if (response.headers.get('content-length')) {
      responseHeaders.set(
        'Content-Length',
        response.headers.get('content-length')!
      );
    }
    if (response.headers.get('content-range')) {
      responseHeaders.set(
        'Content-Range',
        response.headers.get('content-range')!
      );
    }

    return new NextResponse(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error: any) {
    clearTimeout(timeoutId);
    console.error('短剧代理错误:', error);

    if (error.name === 'AbortError') {
      return NextResponse.json({ error: 'Request timeout' }, { status: 504 });
    }

    return NextResponse.json(
      { error: `Proxy error: ${error.message}` },
      { status: error.status || 500 }
    );
  }
}

export async function HEAD(request: Request) {
  // HEAD 请求也需要支持
  return GET(request);
}
