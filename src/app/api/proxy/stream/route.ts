/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextResponse } from 'next/server';

import { getMediaProxyPolicy } from '@/lib/proxy-source';
import { fetchWithValidatedRedirects, normalizeHeaderUrl, validateProxyTargetUrl } from '@/lib/proxy-security';

export const runtime = 'nodejs';

function withCorsHeaders(headers: Headers) {
  headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Range, Origin, Accept',
  );
  headers.set(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  );
}

function copyHeader(
  from: Headers,
  to: Headers,
  sourceKey: string,
  targetKey = sourceKey,
) {
  const value = from.get(sourceKey);
  if (value) {
    to.set(targetKey, value);
  }
}

export async function OPTIONS() {
  const headers = new Headers();
  withCorsHeaders(headers);
  return new Response(null, { status: 204, headers });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const source = searchParams.get('moontv-source') || searchParams.get('decotv-source');

  if (!url) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  let policy;
  try { policy = await getMediaProxyPolicy(request, source, true); }
  catch (error: any) { return NextResponse.json({ error: error.message }, { status: error.status || 403 }); }
  const ua = policy.userAgent;
  const decodedUrl = url;

  // SSRF 防护：验证目标 URL
  try {
    await validateProxyTargetUrl(decodedUrl, policy);
  } catch (error) {
    console.error('[Stream Proxy] SSRF validation failed:', error);
    return NextResponse.json(
      { error: 'Invalid or blocked URL' },
      { status: 403 }
    );
  }

  try {
    const targetUrl = new URL(decodedUrl);
    const referer = normalizeHeaderUrl(searchParams.get('referer')) || targetUrl.href;
    const requestHeaders = new Headers();
    requestHeaders.set('User-Agent', ua);
    requestHeaders.set('Accept', '*/*');
    requestHeaders.set(
      'Referer',
      referer,
    );
    requestHeaders.set('Origin', new URL(referer).origin);

    const range = request.headers.get('range');
    if (range) {
      requestHeaders.set('Range', range);
    }

    const response = await fetchWithValidatedRedirects(decodedUrl, {
      cache: 'no-cache',
      redirect: 'follow',
      headers: requestHeaders,
      signal: request.signal,
    }, { ...policy, timeoutMs: 30000 });

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel();
      return NextResponse.json(
        { error: 'Failed to fetch stream' },
        { status: response.status || 500 },
      );
    }

    const headers = new Headers();
    withCorsHeaders(headers);
    headers.set('Cache-Control', 'no-cache');

    copyHeader(response.headers, headers, 'content-type', 'Content-Type');
    copyHeader(response.headers, headers, 'content-length', 'Content-Length');
    copyHeader(response.headers, headers, 'content-range', 'Content-Range');
    copyHeader(response.headers, headers, 'accept-ranges', 'Accept-Ranges');
    copyHeader(
      response.headers,
      headers,
      'content-disposition',
      'Content-Disposition',
    );

    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/octet-stream');
    }
    if (!headers.has('Accept-Ranges')) {
      headers.set('Accept-Ranges', 'bytes');
    }

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch stream' },
      { status: (error as { status?: number }).status || 500 },
    );
  }
}
