import { createHash, createHmac, timingSafeEqual } from 'crypto';

import type { AdminConfig } from './admin.types';

export const OIDC_REGISTRATION_SESSION_TTL_SECONDS = 10 * 60;

export interface OIDCRegistrationSession {
  sub: string;
  providerId: string;
  providerKey: string;
  email?: string;
  name?: string;
  trust_level?: number;
  timestamp: number;
}

type OIDCProvider = NonNullable<AdminConfig['OIDCAuthConfig']> & {
  id?: string;
};

export function getOIDCProvider(
  config: AdminConfig,
  requestedId: string,
): OIDCProvider | undefined {
  if (config.OIDCProviders?.length) {
    return config.OIDCProviders.find(
      (provider) =>
        provider.enabled &&
        (requestedId === 'default' || provider.id === requestedId),
    );
  }
  return config.OIDCAuthConfig?.enabled ? config.OIDCAuthConfig : undefined;
}

// Include the authority as well as the local provider ID: changing the issuer
// must not allow a different identity service to inherit existing accounts.
export function getOIDCProviderKey(
  provider: OIDCProvider,
  providerId: string,
): string {
  const authority =
    provider.issuer?.trim() ||
    provider.userInfoEndpoint?.trim() ||
    provider.tokenEndpoint?.trim();
  if (!authority) throw new Error('OIDC provider has no identity authority');
  const url = new URL(authority);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('OIDC identity authority must use HTTP or HTTPS');
  }
  return createHash('sha256')
    .update(JSON.stringify([provider.id || providerId, authority]))
    .digest('hex');
}

export function getOIDCAccountSubject(
  providerKey: string,
  subject: string,
): string {
  return `oidc:v1:${providerKey}:${Buffer.from(subject).toString('base64url')}`;
}

export function getOIDCBindingCandidates(
  config: AdminConfig,
  providerKey: string,
  subject: string,
): string[] {
  const candidates = [getOIDCAccountSubject(providerKey, subject)];
  // Old records did not contain a provider. A single configured provider is
  // the only case where that association can be retained without guessing.
  if ((config.OIDCProviders?.length || 0) <= 1 && !subject.startsWith('oidc:v1:')) {
    candidates.push(subject);
  }
  return candidates;
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`oidc-registration:v1:${payload}`)
    .digest('hex');
}

export function encodeOIDCRegistrationSession(
  session: OIDCRegistrationSession,
  secret = process.env.PASSWORD,
): string {
  if (!secret)
    throw new Error('OIDC registration requires a session signing key');
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `v1.${payload}.${signature(payload, secret)}`;
}

export function decodeOIDCRegistrationSession(
  cookie: string | undefined,
  secret = process.env.PASSWORD,
  now = Date.now(),
): OIDCRegistrationSession | null {
  if (!cookie || !secret || cookie.length > 4096) return null;
  const [version, payload, providedSignature, extra] = cookie.split('.');
  if (
    version !== 'v1' ||
    !payload ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[a-f0-9]{64}$/.test(providedSignature || '') ||
    extra !== undefined
  ) {
    return null;
  }
  const expected = Buffer.from(signature(payload, secret), 'hex');
  const provided = Buffer.from(providedSignature, 'hex');
  if (!timingSafeEqual(expected, provided)) return null;

  try {
    const session = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    if (
      !session ||
      typeof session.sub !== 'string' ||
      !session.sub ||
      typeof session.providerId !== 'string' ||
      !session.providerId ||
      typeof session.providerKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(session.providerKey) ||
      typeof session.timestamp !== 'number' ||
      !Number.isFinite(session.timestamp) ||
      session.timestamp > now + 30_000 ||
      now - session.timestamp >= OIDC_REGISTRATION_SESSION_TTL_SECONDS * 1000 ||
      (session.email !== undefined && typeof session.email !== 'string') ||
      (session.name !== undefined && typeof session.name !== 'string') ||
      (session.trust_level !== undefined &&
        (typeof session.trust_level !== 'number' ||
          !Number.isFinite(session.trust_level)))
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}
