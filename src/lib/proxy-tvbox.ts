import { getAccountAccessError } from './account-policy';
import type { AdminConfig } from './admin.types';
import { getConfig } from './config';
import { db } from './db';
import { isIPInTrustedRange } from './trusted-network';

type TVBoxUser = AdminConfig['UserConfig']['Users'][number];

export class TVBoxAccessError extends Error {
  constructor(message: string, readonly status: number, readonly hint?: string) {
    super(message);
  }
}

function getClientAddress(request: Request): string | undefined {
  const peer = (request as Request & { ip?: string }).ip;
  if (peer) return peer;
  // Only accept addresses supplied by an ingress the operator explicitly trusts.
  if (process.env.TRUST_PROXY_HEADERS !== 'true') return undefined;
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || request.headers.get('x-real-ip')?.trim()
    || request.headers.get('cf-connecting-ip')?.trim()
    || undefined;
}

async function checkRateLimit(address: string, limit: number): Promise<boolean> {
  const windowMs = 60_000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const key = `tvbox-rate-limit:${address}:${windowStart}`;
  try {
    const count = Number(await db.getCache(key)) || 0;
    if (count >= limit) return false;
    await db.setCache(key, count + 1, windowMs / 1000);
    return true;
  } catch {
    // Preserve subscription availability when the cache backend is unavailable.
    return true;
  }
}

/** Apply the same token, account, ingress and rate policy to every TVBox data API. */
export async function authorizeTVBoxRequest(request: Request) {
  const config = await getConfig();
  const security = config.TVBoxSecurityConfig;
  const token = new URL(request.url).searchParams.get('token');
  let currentUser: TVBoxUser | null = null;

  if (token) {
    const user = config.UserConfig.Users.find((entry) => entry.tvboxToken === token);
    if (user) {
      // A legacy cached token row cannot safely follow a reused login name.
      if (!user.uid && await db.isLegacyUsernameRetired(user.username)) {
        throw new TVBoxAccessError('Account access denied', 403);
      }
      const identity = user.uid
        ? await db.getUserIdentityByUid(user.uid)
        : await db.getUserIdentity(user.username);
      if (!identity || (!user.uid && await db.isLegacyUsernameRetired(user.username))) {
        throw new TVBoxAccessError('Account access denied', 403);
      }
      const resolvedUser = { ...user, uid: identity.uid, username: identity.username };
      if (identity.username !== process.env.USERNAME) {
        const stored = await db.getUserInfoV2(identity.uid);
        if (getAccountAccessError(resolvedUser, stored) || !(await db.checkUserExist(identity.uid))) {
          throw new TVBoxAccessError('Account access denied', 403);
        }
      }
      currentUser = resolvedUser;
    }
  }

  if (security?.enableAuth && !currentUser && (!token || token !== security.token)) {
    throw new TVBoxAccessError(
      'Invalid token. Please add ?token=YOUR_TOKEN to the URL',
      401,
      '请在URL中添加 ?token=你的密钥 参数',
    );
  }

  const address = getClientAddress(request);
  if (security?.enableIpWhitelist && security.allowedIPs.length > 0) {
    const allowed = security.allowedIPs.some((rule) => {
      const range = rule.trim();
      return range === '*' || (!!address && isIPInTrustedRange(address, range));
    });
    if (!allowed) {
      throw new TVBoxAccessError('IP access denied', 403, '该IP地址不在白名单中');
    }
  }

  if (security?.enableRateLimit) {
    const limit = security.rateLimit || 60;
    if (!(await checkRateLimit(address || 'unknown', limit))) {
      throw new TVBoxAccessError('Rate limit exceeded', 429, `访问频率超限，每分钟最多${limit}次请求`);
    }
  }

  return { config, currentUser };
}
