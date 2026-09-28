import { createHash, randomBytes } from 'crypto';

import { normalizeEmail } from './account-policy';
import { db } from './db';

const TOKEN_EXPIRY_SECONDS = 15 * 60;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export interface PasswordResetTokenData {
  uid: string;
  username: string;
  email: string;
  expiresAt: number;
  credentialVersion: string;
}

export function getPasswordResetCredentialVersion(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

export async function generatePasswordResetToken(
  uid: string,
  email: string,
): Promise<string> {
  // Callers capture the account by username first; numeric names are not UIDs.
  const identity = await db.getUserIdentityByUid(uid);
  if (!identity) throw new Error('User identity is unavailable');
  const credential = await db.getUserCredential(identity.uid);
  if (!credential) throw new Error('User credential is unavailable');

  const token = randomBytes(32).toString('hex');
  const tokenData: PasswordResetTokenData = {
    uid: identity.uid,
    username: identity.username,
    email: normalizeEmail(email),
    expiresAt: Date.now() + TOKEN_EXPIRY_SECONDS * 1000,
    credentialVersion: getPasswordResetCredentialVersion(credential),
  };
  await db.setCache(`password_reset:${token}`, tokenData, TOKEN_EXPIRY_SECONDS);
  return token;
}

export async function verifyAndConsumePasswordResetToken(
  token: string,
): Promise<PasswordResetTokenData | null> {
  if (!TOKEN_PATTERN.test(token)) return null;

  // Retrieve and delete together so only one request can use this token.
  const data = await db.consumeCache(`password_reset:${token}`);
  if (
    !data ||
    // Pre-UID links expire after 15 minutes; require a new link rather than
    // risk assigning an old username's reset request to a recreated account.
    typeof data.uid !== 'string' ||
    !data.uid ||
    typeof data.username !== 'string' ||
    !data.username ||
    typeof data.email !== 'string' ||
    !normalizeEmail(data.email) ||
    typeof data.expiresAt !== 'number' ||
    !Number.isFinite(data.expiresAt) ||
    data.expiresAt <= Date.now() ||
    typeof data.credentialVersion !== 'string' ||
    !TOKEN_PATTERN.test(data.credentialVersion)
  ) {
    return null;
  }
  return data as PasswordResetTokenData;
}
