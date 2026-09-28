/** Infer the media type from a direct URL or a bounded chain of proxy URLs. */
export function inferPlaybackType(value: string): string {
  let current = value;
  const visited = new Set<string>();
  for (let depth = 0; current && depth < 5 && !visited.has(current); depth++) {
    visited.add(current);
    try {
      const parsed = new URL(current, 'https://playback.invalid');
      const pathname = parsed.pathname.toLowerCase();
      if (/\/(?:m3u8|[^/]+\.m3u8)$/.test(pathname)) return 'm3u8';
      const extension = pathname.match(/\.([a-z0-9]+)$/)?.[1];
      if (extension && ['mp4', 'webm', 'ogg', 'flv', 'mkv', 'm3u'].includes(extension)) {
        return extension === 'm3u' ? 'm3u8' : extension;
      }
      current = parsed.searchParams.get('url') ?? '';
    } catch {
      return '';
    }
  }
  return '';
}

export function unwrapPlaybackProxy(value: string, proxyBase: string): string | null {
  if (!value || !proxyBase) return null;
  try {
    const proxy = new URL(proxyBase);
    const target = new URL(value);
    const basePath = proxy.pathname.replace(/\/$/, '');
    if (target.origin !== proxy.origin ||
        (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))) return null;
    // URLSearchParams already decodes one layer. Decoding twice breaks signed
    // URLs whose original path/query legitimately contains percent escapes.
    const original = target.searchParams.get('url');
    if (!original || !/^https?:\/\//i.test(original)) return null;
    return original;
  } catch {
    return null;
  }
}
