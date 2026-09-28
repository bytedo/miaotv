import { createHmac, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

import type { AuthInfo } from './auth';
import { getAuthInfoFromCookie } from './auth';
import { db } from './db';

export interface VerifiedAuthInfo {
  uid: string;
  username: string;
  sessionVersion?: number;
}

export function getLocalOwnerIdentity(): VerifiedAuthInfo {
  return {
    uid: 'local-owner',
    username: process.env.USERNAME || 'owner',
    sessionVersion: 0,
  };
}

function identityMessage(identity: VerifiedAuthInfo): string {
  return JSON.stringify([
    'miaotv-auth',
    2,
    identity.uid,
    identity.username,
    identity.sessionVersion ?? 0,
  ]);
}

/** Only call after authenticating this exact UID, never a later username lookup. */
export function createSignedAuthCookie(
  identity: VerifiedAuthInfo,
  details: Pick<AuthInfo, 'role' | 'loginTime'> = {},
): string {
  const secret = process.env.PASSWORD;
  if (!secret || !identity.uid || !identity.username) {
    throw new Error('Authenticated account identity is unavailable');
  }
  const now = Date.now();
  return encodeURIComponent(
    JSON.stringify({
      uid: identity.uid,
      username: identity.username,
      authVersion: 2,
      sessionVersion: identity.sessionVersion ?? 0,
      signature: createHmac('sha256', secret)
        .update(identityMessage(identity))
        .digest('hex'),
      role: details.role || 'user',
      timestamp: now,
      loginTime: details.loginTime ?? now,
      trustedNetwork: false,
    }),
  );
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

/** Bind requests to a stable UID and reject sessions issued before a rename. */
export async function getVerifiedAuthInfo(
  request: NextRequest,
): Promise<VerifiedAuthInfo | null> {
  const secret = process.env.PASSWORD;
  if (!secret) return null;

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || typeof authInfo !== 'object') return null;
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  if (authInfo.uid !== undefined || authInfo.authVersion !== undefined) {
    if (
      authInfo.authVersion !== 2 ||
      typeof authInfo.uid !== 'string' ||
      !authInfo.uid ||
      typeof authInfo.username !== 'string' ||
      !authInfo.username ||
      (authInfo.sessionVersion !== undefined &&
        (!Number.isSafeInteger(authInfo.sessionVersion) ||
          authInfo.sessionVersion < 0)) ||
      typeof authInfo.signature !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(authInfo.signature)
    )
      return null;
    const expected = createHmac('sha256', secret)
      .update(
        identityMessage({
          uid: authInfo.uid,
          username: authInfo.username,
          sessionVersion: authInfo.sessionVersion,
        }),
      )
      .digest();
    if (!timingSafeEqual(Buffer.from(authInfo.signature, 'hex'), expected))
      return null;
    const identity =
      storageType === 'localstorage'
        ? getLocalOwnerIdentity()
        : await db.getUserIdentityByUid(authInfo.uid);
    if (
      !identity ||
      // Database lookups resolve immutable legacy UUID aliases to numeric UIDs.
      // Local owner sessions have no alias registry and must still match exactly.
      (storageType === 'localstorage' && identity.uid !== authInfo.uid) ||
      identity.username !== authInfo.username ||
      (identity.sessionVersion ?? 0) !== (authInfo.sessionVersion ?? 0)
    )
      return null;
    return {
      uid: identity.uid,
      username: identity.username,
      sessionVersion: identity.sessionVersion ?? 0,
    };
  }

  if (storageType === 'localstorage') {
    if (
      typeof authInfo.password !== 'string' ||
      !equalSecret(authInfo.password, secret)
    ) {
      return null;
    }
    return getLocalOwnerIdentity();
  }

  // A client-controlled network flag or role is not an identity credential.
  if (
    typeof authInfo.username !== 'string' ||
    !authInfo.username ||
    typeof authInfo.signature !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(authInfo.signature)
  ) {
    return null;
  }

  const expected = createHmac('sha256', secret)
    .update(authInfo.username)
    .digest();
  const actual = Buffer.from(authInfo.signature, 'hex');
  if (!timingSafeEqual(actual, expected)) return null;

  // A legacy signature cannot distinguish a renamed or recreated account.
  // Retired names must log in again before they can acquire a UID session.
  if (await db.isLegacyUsernameRetired(authInfo.username)) return null;
  const identity = await db.getUserIdentity(authInfo.username);
  if (!identity || identity.username !== authInfo.username) return null;
  if (await db.isLegacyUsernameRetired(authInfo.username)) return null;
  return {
    uid: identity.uid,
    username: identity.username,
    sessionVersion: identity.sessionVersion ?? 0,
  };
}
