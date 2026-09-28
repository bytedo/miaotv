import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const SCRYPT_V1 = /^scrypt:v1:([a-f0-9]{32}):([a-f0-9]{128})$/i;
const LEGACY_SCRYPT = /^([a-f0-9]{32}):([a-f0-9]{128})$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

type Credential =
  | { kind: 'scrypt'; salt: string; hash: string }
  | { kind: 'sha256'; hash: string }
  | { kind: 'plain'; value: string };

function parseCredential(value: string): Credential | null {
  if (typeof value !== 'string') return null;
  const scrypt = value.match(SCRYPT_V1) || value.match(LEGACY_SCRYPT);
  if (scrypt) return { kind: 'scrypt', salt: scrypt[1], hash: scrypt[2] };
  if (value.startsWith('scrypt:')) return null;

  const sha256 = value.startsWith('sha256:v1:')
    ? value.slice(10)
    : value.startsWith('sha256:')
      ? value.slice(7)
      : value;
  if (SHA256.test(sha256)) return { kind: 'sha256', hash: sha256.toLowerCase() };
  if (value.startsWith('sha256:')) return null;

  if (value.startsWith('plain:v1:')) {
    const encoded = value.slice(9);
    const decoded = Buffer.from(encoded, 'base64');
    // Reject malformed base64 and invalid UTF-8 instead of guessing.
    if (decoded.toString('base64') !== encoded) return null;
    const plain = decoded.toString('utf8');
    if (!Buffer.from(plain, 'utf8').equals(decoded)) return null;
    return { kind: 'plain', value: plain };
  }
  if (value.startsWith('plain:')) return null;
  // A malformed upstream hash must not become an accepted literal password.
  if (/^[^:]{32}:[^:]{128}$/.test(value)) return null;
  return { kind: 'plain', value };
}

function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** New credentials always use the explicitly versioned scrypt format. */
export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('密码不能为空');
  }
  const salt = randomBytes(SALT_LENGTH).toString('hex');
  const hash = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS).toString('hex');
  return `scrypt:v1:${salt}:${hash}`;
}

/**
 * Legacy 64-hex values are SHA256 digests, never an alternate literal password.
 * Old plaintext passwords with that shape need a reset or explicit plain:v1
 * metadata. New 64-hex passwords are unambiguous once scrypt encoded.
 */
export function verifyPassword(password: string, storedValue: string): boolean {
  if (typeof password !== 'string' || password.length === 0) return false;
  const credential = parseCredential(storedValue);
  if (!credential) return false;
  switch (credential.kind) {
    case 'scrypt': {
      const actual = scryptSync(password, credential.salt, KEY_LENGTH, SCRYPT_OPTIONS);
      return equalBytes(actual, Buffer.from(credential.hash, 'hex'));
    }
    case 'sha256': {
      const actual = createHash('sha256').update(password, 'utf8').digest();
      return equalBytes(actual, Buffer.from(credential.hash, 'hex'));
    }
    case 'plain':
      return equalBytes(Buffer.from(password, 'utf8'), Buffer.from(credential.value, 'utf8'));
  }
}

export function isHashed(storedValue: string): boolean {
  return parseCredential(storedValue)?.kind === 'scrypt';
}

export function isCurrentCredential(storedValue: string): boolean {
  return SCRYPT_V1.test(storedValue);
}

/** Export an existing credential without hashing an already encoded value. */
export function encodeStoredCredential(storedValue: string, _source?: 'pwd' | 'info'): string {
  const credential = parseCredential(storedValue);
  if (!credential) throw new Error('无效的已存密码格式');
  switch (credential.kind) {
    case 'scrypt':
      return `scrypt:v1:${credential.salt}:${credential.hash}`;
    case 'sha256':
      return `sha256:v1:${credential.hash}`;
    case 'plain':
      return `plain:v1:${Buffer.from(credential.value, 'utf8').toString('base64')}`;
  }
}

/** Restore takes typed credentials or legacy digests, never an untyped password. */
export function credentialForRestore(encodedCredential: string): string {
  const credential = parseCredential(encodedCredential);
  if (!credential || (credential.kind === 'plain' && !encodedCredential.startsWith('plain:v1:'))) {
    throw new Error('恢复密码需要有效的编码凭据');
  }
  return encodeStoredCredential(encodedCredential);
}

export function isValidEncodedCredential(value: string): boolean {
  return typeof value === 'string' &&
    (value.startsWith('scrypt:v1:') || value.startsWith('sha256:v1:') || value.startsWith('plain:v1:')) &&
    parseCredential(value) !== null;
}

export interface PasswordSnapshot {
  current: string | null;
  legacy: string | null;
  email?: string | null;
}

/**
 * Current credentials always win over info.password, including on failure.
 * Compare-and-set prevents a concurrent login upgrade from undoing a reset
 * or recreating a deleted account.
 */
export async function verifyAndUpgradePassword(
  password: string,
  read: () => Promise<PasswordSnapshot>,
  compareAndSet: (snapshot: PasswordSnapshot, credential: string) => Promise<boolean>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await read();
    const stored = snapshot.current ?? snapshot.legacy;
    if (stored === null || !verifyPassword(password, stored)) return false;
    const credential = isCurrentCredential(stored) ? stored : hashPassword(password);
    if (await compareAndSet(snapshot, credential)) return true;
  }
  return false;
}
