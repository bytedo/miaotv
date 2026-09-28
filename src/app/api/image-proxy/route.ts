import { NextResponse } from 'next/server';

import {
  fetchWithValidatedRedirects,
  readArrayBufferLimited,
} from '@/lib/proxy-security';
import { getMediaProxyPolicy } from '@/lib/proxy-source';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const url = params.get('url');
  if (!url)
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  try {
    const policy = await getMediaProxyPolicy(
      request,
      params.get('moontv-source') || params.get('source'),
    );
    const imageUrl = new URL(url);
    const origin = imageUrl.origin;
    const hostname = imageUrl.hostname.toLowerCase().replace(/\.$/, '');
    const isDoubanImage =
      hostname === 'doubanio.com' || hostname.endsWith('.doubanio.com');
    const upstream = await fetchWithValidatedRedirects(
      url,
      {
        headers: {
          'User-Agent': policy.userAgent,
          // Douban's image CDN accepts its page origin, not the image origin.
          Referer: isDoubanImage ? 'https://movie.douban.com/' : origin + '/',
          ...(isDoubanImage ? {} : { Origin: origin }),
          Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        },
      },
      { ...policy, timeoutMs: 15000 },
    );
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return NextResponse.json(
        { error: 'Failed to fetch image' },
        { status: upstream.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.toLowerCase().trim().startsWith('image/')) {
      await upstream.body?.cancel();
      return NextResponse.json(
        { error: 'Upstream response is not an image' },
        { status: 415 },
      );
    }
    const image = await readArrayBufferLimited(upstream, 10 * 1024 * 1024);
    return new Response(image, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(image.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=604800',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  } catch (error) {
    const status =
      (error as { status?: number }).status ||
      ((error as Error).name === 'AbortError' ? 504 : 502);
    return NextResponse.json(
      {
        error:
          status === 403 ? 'Invalid or blocked URL' : 'Image proxy unavailable',
      },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
