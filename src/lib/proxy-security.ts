import CacheableLookup from 'cacheable-lookup';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import ipaddr from 'ipaddr.js';
import { isIP, type LookupFunction } from 'net';
import { Readable } from 'stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib';

import { isProxyFakeIp, resolveProxyDnsOverHttps } from './proxy-dns';

const resolver = new CacheableLookup({ maxTtl: 300, errorTtl: 0.15 });

export interface ProxyTargetPolicy {
  // Only populated after checking an enabled, authorized source. Scheme and
  // port are part of the grant; redirects do not inherit a private-host grant.
  allowedPrivateOrigins?: string[];
}

export class ProxyTargetError extends Error {
  readonly status = 403;
}

export function parseByteRange(
  value: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (
    !match ||
    (!match[1] && !match[2]) ||
    !Number.isSafeInteger(size) ||
    size <= 0
  )
    return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= size ||
      end < start
    )
      return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function normalizeHeaderUrl(
  value: string | null | undefined,
): string | undefined {
  if (!value || /[\r\n]/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function permittedAddress(address: string, allowPrivate: boolean): boolean {
  try {
    const range = ipaddr.process(address).range();
    return (
      range === 'unicast' ||
      (allowPrivate &&
        ['private', 'uniqueLocal', 'carrierGradeNat'].includes(range))
    );
  } catch {
    return false;
  }
}

async function resolveTarget(rawUrl: string, policy: ProxyTargetPolicy) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProxyTargetError('Invalid url');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new ProxyTargetError('Only http/https supported');
  if (url.username || url.password)
    throw new ProxyTargetError('URL credentials are not supported');
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'metadata.google.internal'
  )
    throw new ProxyTargetError('Blocked host');
  const allowPrivate = (policy.allowedPrivateOrigins || []).some((origin) => {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  });
  const version = isIP(hostname);
  let records = version
    ? [{ address: hostname, family: version }]
    : await resolver.lookupAsync(hostname, { all: true });
  const dnsEndpoint = process.env.PROXY_DNS_OVER_HTTPS;
  if (
    !version &&
    dnsEndpoint &&
    records.some((record) => isProxyFakeIp(record.address)) &&
    records.every(
      (record) =>
        isProxyFakeIp(record.address) ||
        permittedAddress(record.address, allowPrivate),
    )
  ) {
    // A configured resolver can replace fake-IP DNS answers, never an existing
    // denial for another address class. All replacement answers are checked
    // below and pinned to the actual socket by fetchPinned, including redirects.
    records = await resolveProxyDnsOverHttps(hostname, dnsEndpoint);
  }
  if (
    !records.length ||
    records.some((record) => !permittedAddress(record.address, allowPrivate))
  )
    throw new ProxyTargetError('Host resolves to a blocked IP address');
  return { url, records };
}

export async function validateProxyTargetUrl(
  rawUrl: string,
  policy: ProxyTargetPolicy = {},
): Promise<string> {
  return (await resolveTarget(rawUrl, policy)).url.href;
}

async function fetchPinned(
  target: Awaited<ReturnType<typeof resolveTarget>>,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete('host');
  headers.set('accept-encoding', 'identity');
  const body = init.body;
  if (
    body != null &&
    typeof body !== 'string' &&
    !(body instanceof URLSearchParams) &&
    !(body instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(body)
  )
    throw new Error('Unsupported proxy request body');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  return new Promise((resolve, reject) => {
    // Bind the validated answers to the actual socket lookup, avoiding a second
    // DNS lookup that could rebind a public hostname to a private destination.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const family =
        options.family === 'IPv4'
          ? 4
          : options.family === 'IPv6'
            ? 6
            : options.family;
      const records = family
        ? target.records.filter((record) => record.family === family)
        : target.records;
      if (!records.length)
        return callback(
          new Error('No validated address for requested family'),
          [],
        );
      if (options.all)
        callback(
          null,
          records.map(({ address, family }) => ({ address, family })),
        );
      else callback(null, records[0].address, records[0].family);
    };
    const start = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = start(
      target.url,
      {
        method: init.method || 'GET',
        headers: Object.fromEntries(headers),
        signal,
        // Reused sockets skip lookup and may belong to a prior private grant.
        agent: false,
        lookup,
      },
      (incoming) => {
        // Long video/FLV streams can remain open while bytes keep arriving. The
        // header deadline ends here; socket inactivity still has a timeout.
        clearTimeout(timer);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined)
            responseHeaders.set(
              key,
              Array.isArray(value) ? value.join(', ') : value,
            );
        }
        const status = incoming.statusCode || 502;
        let stream: Readable = incoming;
        const encoding = responseHeaders.get('content-encoding')?.toLowerCase();
        const decoder =
          encoding === 'gzip'
            ? createGunzip()
            : encoding === 'deflate'
              ? createInflate()
              : encoding === 'br'
                ? createBrotliDecompress()
                : null;
        if (decoder) {
          incoming.on('error', (error) => decoder.destroy(error));
          decoder.on('close', () => incoming.destroy());
          stream = incoming.pipe(decoder);
          responseHeaders.delete('content-encoding');
          responseHeaders.delete('content-length');
        }
        const noBody =
          init.method === 'HEAD' || [204, 205, 304].includes(status);
        if (noBody) incoming.resume();
        const response = new Response(
          noBody
            ? null
            : (Readable.toWeb(stream) as ReadableStream<Uint8Array>),
          {
            status,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          },
        );
        Object.defineProperty(response, 'url', { value: target.url.href });
        resolve(response);
      },
    );
    req.setTimeout(timeoutMs, () => controller.abort());
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    if (body instanceof URLSearchParams) req.end(body.toString());
    else if (body instanceof ArrayBuffer) req.end(Buffer.from(body));
    else if (ArrayBuffer.isView(body))
      req.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    else req.end(body);
  });
}

export async function fetchWithValidatedRedirects(
  rawUrl: string,
  init: RequestInit,
  options: ProxyTargetPolicy & {
    timeoutMs: number;
    maxRedirects?: number;
    allowCrossOriginRedirects?: boolean;
  },
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 3;
  let currentUrl = rawUrl;
  let currentInit = init;
  for (let index = 0; index <= maxRedirects; index++) {
    const target = await resolveTarget(currentUrl, options);
    const response = await fetchPinned(target, currentInit, options.timeoutMs);
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      response.headers.has('location')
    ) {
      await response.body?.cancel();
      if (index === maxRedirects)
        throw new ProxyTargetError('Too many redirects');
      const next = new URL(response.headers.get('location')!, target.url);
      if (next.origin !== target.url.origin) {
        if (options.allowCrossOriginRedirects === false)
          throw new ProxyTargetError('Cross-origin redirect is not allowed');
        const nextHeaders = new Headers(currentInit.headers);
        for (const key of [
          'authorization',
          'cookie',
          'proxy-authorization',
          'x-emby-authorization',
          'x-emby-token',
          'x-mediabrowser-token',
        ])
          nextHeaders.delete(key);
        currentInit = { ...currentInit, headers: nextHeaders };
      }
      if (response.status === 303 && currentInit.method !== 'HEAD')
        currentInit = { ...currentInit, method: 'GET', body: undefined };
      currentUrl = next.href;
      continue;
    }
    return response;
  }
  throw new ProxyTargetError('Too many redirects');
}

async function readBodyLimited(
  response: Response,
  limitBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes)
        throw new Error(`Response body exceeds ${limitBytes} byte limit`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readTextLimited(
  response: Response,
  limitBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readBodyLimited(response, limitBytes));
}

export async function readArrayBufferLimited(
  response: Response,
  limitBytes: number,
): Promise<ArrayBuffer> {
  const bytes = await readBodyLimited(response, limitBytes);
  const result = new ArrayBuffer(bytes.length);
  new Uint8Array(result).set(bytes);
  return result;
}
