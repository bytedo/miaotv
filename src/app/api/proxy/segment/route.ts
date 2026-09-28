/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextResponse } from 'next/server';

import { getMediaProxyPolicy } from '@/lib/proxy-source';
import {
  fetchWithValidatedRedirects,
  normalizeHeaderUrl,
} from '@/lib/proxy-security';

export const runtime = 'nodejs';

// 连接池管理
import * as https from 'https';
import * as http from 'http';

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 30000,
  keepAliveMsecs: 30000,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 30000,
  keepAliveMsecs: 30000,
});

// 性能统计
const segmentStats = {
  requests: 0,
  errors: 0,
  totalBytes: 0,
  avgResponseTime: 0,
  activeStreams: 0,
};

export async function GET(request: Request) {
  const startTime = Date.now();
  segmentStats.requests++;
  segmentStats.activeStreams++;

  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const source =
    searchParams.get('moontv-source') || searchParams.get('decotv-source');

  if (!url) {
    segmentStats.errors++;
    segmentStats.activeStreams--;
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  let policy;
  try {
    policy = await getMediaProxyPolicy(request, source);
  } catch (error: any) {
    segmentStats.activeStreams--;
    return NextResponse.json(
      { error: error.message },
      { status: error.status || 403 },
    );
  }
  const ua = policy.userAgent;

  let response: Response | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时

  try {
    const decodedUrl = url;
    const isHttps = decodedUrl.startsWith('https:');
    const agent = isHttps ? httpsAgent : httpAgent;

    const referer =
      normalizeHeaderUrl(searchParams.get('referer')) ||
      new URL(decodedUrl).origin + '/';
    response = await fetchWithValidatedRedirects(
      decodedUrl,
      {
        signal: controller.signal,
        headers: {
          'User-Agent': ua,
          Accept: 'video/mp2t, video/*, */*',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          Referer: referer,
          Origin: new URL(referer).origin,
          ...(request.headers.get('range') && {
            Range: request.headers.get('range')!,
          }),
        },
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - Node.js specific option
        agent: typeof window === 'undefined' ? agent : undefined,
      },
      { ...policy, timeoutMs: 30000 },
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      await response.body?.cancel();
      segmentStats.errors++;
      segmentStats.activeStreams--;
      // 改进错误消息，对 401/403 提供更友好的提示
      const upstreamStatus = response.status;
      let errorMessage = `Failed to fetch segment: ${response.status} ${response.statusText}`;

      if (upstreamStatus === 401 || upstreamStatus === 403) {
        errorMessage = `上游资源拒绝访问（${upstreamStatus}），已尝试自动补齐鉴权和防盗链请求头`;
      }

      return NextResponse.json(
        {
          error: errorMessage,
        },
        { status: response.status >= 500 ? 500 : response.status },
      );
    }

    const headers = new Headers();

    // 设置内容类型 - 更精确的类型判断
    const originalContentType = response?.headers.get('Content-Type');
    if (originalContentType) {
      headers.set('Content-Type', originalContentType);
    } else {
      headers.set('Content-Type', 'video/mp2t');
    }

    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Range, Origin, Accept, User-Agent',
    );
    headers.set('Accept-Ranges', 'bytes');
    headers.set(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Content-Type, Accept-Ranges, X-Upstream-Url',
    );
    headers.set('Cache-Control', 'private, max-age=300'); // 5分钟缓存

    // 添加上游 URL 头（用于追踪重定向）
    if (response.url) {
      headers.set('X-Upstream-Url', response.url);
    }

    // 复制原始响应的重要头部（不转发 Content-Length，因为流式传输使用 chunked encoding，两者冲突）
    const importantHeaders = ['Content-Range', 'Last-Modified', 'ETag'];
    importantHeaders.forEach((header) => {
      const value = response?.headers.get(header);
      if (value) {
        headers.set(header, value);
      }
    });

    let bytesTransferred = 0;
    let isCancelled = false;
    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      reader?.releaseLock();
      reader = null;
      segmentStats.activeStreams--;
      segmentStats.totalBytes += bytesTransferred;
      const responseTime = Date.now() - startTime;
      segmentStats.avgResponseTime =
        (segmentStats.avgResponseTime * (segmentStats.requests - 1) +
          responseTime) /
        segmentStats.requests;
    }

    if (!response.body) {
      finish();
      return new Response(null, { headers, status: response.status });
    }
    reader = response.body.getReader();

    // Read only when the downstream has capacity; cancellation must reach the
    // upstream reader before releasing its lock.
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const result = await reader!.read();
            if (isCancelled) return;
            if (result.done) {
              finish();
              controller.close();
              return;
            }
            bytesTransferred += result.value.byteLength;
            controller.enqueue(result.value);
          } catch (error) {
            finish();
            if (!isCancelled) controller.error(error);
          }
        },
        async cancel(reason) {
          isCancelled = true;
          try {
            await reader?.cancel(reason);
          } finally {
            finish();
          }
        },
      },
      {
        // 添加背压控制
        highWaterMark: 65536, // 64KB 缓冲区
        size(chunk) {
          return chunk ? chunk.byteLength : 0;
        },
      },
    );

    return new Response(stream, { headers, status: response.status });
  } catch (error: any) {
    segmentStats.errors++;
    segmentStats.activeStreams--;
    clearTimeout(timeoutId);

    // 确保在错误情况下也释放资源
    if (reader) {
      try {
        await (reader as ReadableStreamDefaultReader<Uint8Array>).cancel();
        (reader as ReadableStreamDefaultReader<Uint8Array>).releaseLock();
      } catch (e) {
        // 忽略错误
      }
    }

    if (response?.body) {
      try {
        await response.body.cancel();
      } catch (e) {
        // 忽略错误
      }
    }

    // 处理不同类型的错误
    if (error.status === 403) {
      return NextResponse.json(
        { error: 'Invalid or blocked URL' },
        { status: 403 },
      );
    }
    if (error.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Segment request timeout' },
        { status: 408 },
      );
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return NextResponse.json(
        { error: 'Network connection failed' },
        { status: 503 },
      );
    }

    if (process.env.NODE_ENV === 'development') {
      console.error('Segment proxy error:', error);
    }
    return NextResponse.json(
      {
        error: 'Failed to fetch segment',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      { status: 500 },
    );
  } finally {
    clearTimeout(timeoutId);

    // 定期打印统计信息
    if (
      segmentStats.requests % 500 === 0 &&
      process.env.NODE_ENV === 'development'
    ) {
      console.log(
        `Segment Proxy Stats - Requests: ${segmentStats.requests}, Active: ${segmentStats.activeStreams}, Errors: ${segmentStats.errors}, Avg Time: ${segmentStats.avgResponseTime.toFixed(2)}ms, Total: ${(segmentStats.totalBytes / 1024 / 1024).toFixed(2)}MB`,
      );
    }
  }
}
