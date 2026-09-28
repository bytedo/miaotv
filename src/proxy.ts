import { NextRequest, NextResponse } from 'next/server';

import { getAccountAccessError } from '@/lib/account-policy';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { createPageRequestHeaders } from '@/lib/request-context';
import { isRequestFromTrustedNetwork } from '@/lib/trusted-network';

const PUBLIC_PAGES = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/oidc-register',
  '/warning',
  '/download',
];
const PUBLIC_APIS = [
  '/api/login',
  '/api/register',
  '/api/logout',
  '/api/cron',
  '/api/server-config',
  '/api/tvbox',
  '/api/live/merged',
  '/api/parse',
  '/api/bing-wallpaper',
  '/api/proxy/spider.jar',
  '/api/forgot-password',
  '/api/reset-password',
  '/api/auth/oidc',
];
const WEAK_DEFAULT_CREDENTIALS = new Set([
  'admin',
  'admin123',
  'password',
  'password123',
  '123456',
  '12345678',
  'changeme',
  'letmein',
  'lunatv',
  'moontv',
]);
const within = (pathname: string, root: string) =>
  pathname === root || pathname.startsWith(root + '/');

function publicPath(pathname: string): boolean {
  return (
    PUBLIC_PAGES.some((root) => within(pathname, root)) ||
    PUBLIC_APIS.some((root) => within(pathname, root)) ||
    ['/_next', '/icons'].some((root) => within(pathname, root)) ||
    [
      '/favicon.ico',
      '/robots.txt',
      '/manifest.json',
      '/logo.png',
      '/screenshot.png',
    ].includes(pathname)
  );
}

function denied(request: NextRequest, pathname: string, status = 401) {
  if (within(pathname, '/api'))
    return NextResponse.json(
      { error: status === 403 ? 'Forbidden' : 'Unauthorized' },
      { status },
    );
  const target = new URL('/login', request.url);
  target.searchParams.set('redirect', pathname + request.nextUrl.search);
  return NextResponse.redirect(target);
}

function forwardRequest(
  request: NextRequest,
  rewrite: URL | undefined,
  incoming: Headers = request.headers,
) {
  const headers = createPageRequestHeaders(
    incoming,
    rewrite?.pathname ?? request.nextUrl.pathname,
  );
  return rewrite
    ? NextResponse.rewrite(rewrite, { request: { headers } })
    : NextResponse.next({ request: { headers } });
}

function passthrough(
  request: NextRequest,
  rewrite: URL | undefined,
  createSignedAuthCookie: typeof import('@/lib/auth.server').createSignedAuthCookie,
  auth?: {
    uid: string;
    username: string;
    sessionVersion?: number;
    role: 'owner' | 'admin' | 'user';
  },
) {
  const headers = new Headers(request.headers);
  // Do not pass forged role/network markers to legacy route handlers. Network
  // visitors have no account principal; authenticated users get the stored role.
  const cookies = (headers.get('cookie') || '')
    .split(';')
    .filter((entry) => !/^\s*(?:user_auth|auth)=/.test(entry));
  const original = getAuthInfoFromCookie(request);
  const authCookie =
    auth &&
    createSignedAuthCookie(auth, {
      role: auth.role,
      loginTime:
        typeof original?.loginTime === 'number'
          ? original.loginTime
          : undefined,
    });
  if (authCookie) cookies.push('user_auth=' + authCookie);
  headers.set('cookie', cookies.join(';'));
  const response = forwardRequest(request, rewrite, headers);
  if (authCookie && (original?.authVersion !== 2 || original.uid !== auth?.uid)) {
    response.cookies.set('user_auth', authCookie, {
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
      sameSite: 'lax',
      httpOnly: false,
      secure:
        request.nextUrl.protocol === 'https:' ||
        request.headers.get('x-forwarded-proto')?.split(',')[0].trim() ===
          'https',
    });
  }
  return response;
}

export async function proxy(request: NextRequest) {
  let pathname = request.nextUrl.pathname;
  let rewrite: URL | undefined;
  if (pathname.startsWith('/adult/')) {
    pathname = pathname.slice('/adult'.length) || '/';
    rewrite = new URL(request.url);
    rewrite.pathname = pathname;
    if (!rewrite.searchParams.has('adult'))
      rewrite.searchParams.set('adult', '1');
  }
  const publicRequest = publicPath(pathname);
  const authPage = pathname === '/login' || pathname === '/register';
  if (publicRequest && !authPage)
    return forwardRequest(request, rewrite);

  const secret = process.env.PASSWORD;
  const allowWeakDevPassword =
    process.env.NODE_ENV === 'development' &&
    process.env.MIAOTV_ALLOW_WEAK_DEV_PASSWORD === 'true' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(request.nextUrl.hostname);
  if (
    !secret ||
    (!allowWeakDevPassword &&
      WEAK_DEFAULT_CREDENTIALS.has(secret.toLowerCase()))
  ) {
    if (authPage) return forwardRequest(request, rewrite);
    const warning = new URL('/warning', request.url);
    if (secret) warning.searchParams.set('reason', 'weak-password');
    return NextResponse.redirect(warning);
  }

  try {
    // Public safety pages must work even if storage cannot initialize.
    const [{ getConfig }, { db }, { createSignedAuthCookie, getVerifiedAuthInfo }] =
      await Promise.all([
        import('@/lib/config'),
        import('@/lib/db'),
        import('@/lib/auth.server'),
      ]);
    const config = await getConfig();
    let identity:
      | {
          uid: string;
          username: string;
          sessionVersion?: number;
          role: 'owner' | 'admin' | 'user';
        }
      | undefined;
    const verified = await getVerifiedAuthInfo(request);
    if (
      (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') ===
      'localstorage'
    ) {
      if (verified) identity = { ...verified, role: 'owner' };
    } else {
      if (verified?.username && verified.username === process.env.USERNAME)
        identity = { ...verified, role: 'owner' };
      else if (verified) {
        const configured = config.UserConfig.Users.find((user) =>
          user.uid
            ? user.uid === verified.uid
            : user.username === verified.username,
        );
        const stored = await db.getUserInfoV2(verified.uid);
        if (
          !getAccountAccessError(configured, stored) &&
          (await db.checkUserExist(verified.uid))
        )
          identity = {
            ...verified,
            role: configured?.role || stored?.role || 'user',
          };
        else return denied(request, pathname, 403);
      }
    }
    if (authPage)
      return identity
        ? NextResponse.redirect(new URL('/', request.url))
        : forwardRequest(request, rewrite);
    const adminPath =
      within(pathname, '/admin') || within(pathname, '/api/admin');
    if (identity) {
      if (adminPath && identity.role !== 'admin' && identity.role !== 'owner')
        return denied(request, pathname, 403);
      return passthrough(request, rewrite, createSignedAuthCookie, identity);
    }
    const sensitive =
      adminPath ||
      within(pathname, '/api/change-password') ||
      within(pathname, '/api/user');
    if (
      !sensitive &&
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      isRequestFromTrustedNetwork(request, config)
    )
      return passthrough(request, rewrite, createSignedAuthCookie);
    return denied(request, pathname);
  } catch {
    return NextResponse.json(
      { error: 'Authentication unavailable' },
      { status: 503 },
    );
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
