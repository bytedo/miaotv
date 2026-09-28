import { NextRequest } from 'next/server';

import { getAccountAccessError } from './account-policy';
import { getVerifiedAuthInfo } from './auth.server';
import { getAvailableApiSites, getConfig } from './config';
import { db } from './db';
import { getEmbyTargetPolicy } from './emby-source';
import type { ProxyTargetPolicy } from './proxy-security';
import { isRequestFromTrustedNetwork } from './trusted-network';
import { DEFAULT_USER_AGENT } from './user-agent';

export class ProxySourceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function getProxyPrincipal(request: Request) {
  const auth = await getVerifiedAuthInfo('cookies' in request ? request as NextRequest : new NextRequest(request));
  const config = await getConfig();
  if (auth) {
    if (auth.username !== process.env.USERNAME) {
      const user = config.UserConfig.Users.find((entry) => entry.uid ? entry.uid === auth.uid : entry.username === auth.username);
      const stored = await db.getUserInfoV2(auth.uid);
      if (getAccountAccessError(user, stored) || !(await db.checkUserExist(auth.uid))) throw new ProxySourceError('Account access denied', 403);
    }
    return { config, username: auth.username };
  }
  if (isRequestFromTrustedNetwork(request, config)) return { config, username: undefined };
  throw new ProxySourceError('Unauthorized', 401);
}

export async function getMediaProxyPolicy(request: Request, sourceKey: string | null, requireSource = false): Promise<ProxyTargetPolicy & { userAgent: string }> {
  const { config, username } = await getProxyPrincipal(request);
  if (!sourceKey) {
    if (requireSource) throw new ProxySourceError('Source not found', 404);
    return { userAgent: DEFAULT_USER_AGENT };
  }
  const source = config.LiveConfig?.find((entry) => entry.key === sourceKey && !entry.disabled);
  if (!source) throw new ProxySourceError('Source not found', 404);
  const origin = new URL(source.url).origin;
  return {
    userAgent: source.ua || DEFAULT_USER_AGENT,
    allowedPrivateOrigins: username ? [origin] : [],
  };
}

export async function requireProxyAdministrator(request: Request) {
  const { config, username } = await getProxyPrincipal(request);
  if (!username) throw new ProxySourceError('Unauthorized', 401);
  if (username !== process.env.USERNAME && config.UserConfig.Users.find((user) => user.username === username)?.role !== 'admin') {
    throw new ProxySourceError('Administrator access required', 403);
  }
  return config;
}

export async function getEmbyProxyPolicy(request: Request, target: string): Promise<ProxyTargetPolicy> {
  const { config, username } = await getProxyPrincipal(request);
  if (!username) throw new ProxySourceError('Unauthorized', 401);
  return getEmbyTargetPolicy(config, target, username);
}

export async function getCMSProxyPolicy(request: Request, target: string): Promise<ProxyTargetPolicy> {
  const { username } = await getProxyPrincipal(request);
  const sources = await getAvailableApiSites(username);
  const url = new URL(target);
  const source = sources.find((entry) => {
    try {
      const base = new URL(entry.api);
      const path = base.pathname.replace(/\/$/, '');
      return base.origin === url.origin && (url.pathname === base.pathname || url.pathname.startsWith(path + '/')) && (!base.searchParams.has('url') || base.searchParams.get('url') === url.searchParams.get('url'));
    } catch { return false; }
  });
  if (!source) throw new ProxySourceError('Source is not authorized', 403);
  return { allowedPrivateOrigins: username ? [new URL(source.api).origin] : [] };
}
