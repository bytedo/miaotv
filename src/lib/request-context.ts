export const WARNING_PAGE_HEADER = 'x-miaotv-warning-page';

/** Proxy derives this marker from the resolved path, never from client input. */
export function createPageRequestHeaders(
  incoming: HeadersInit,
  pathname: string,
): Headers {
  const headers = new Headers(incoming);
  headers.delete(WARNING_PAGE_HEADER);
  if (pathname === '/warning') headers.set(WARNING_PAGE_HEADER, '1');
  return headers;
}

export function isWarningPageRequest(headers: Pick<Headers, 'get'>): boolean {
  return headers.get(WARNING_PAGE_HEADER) === '1';
}
