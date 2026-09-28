export const CUSTOM_INVITE_CODE_MIN_LENGTH = 4;
export const CUSTOM_INVITE_CODE_MAX_LENGTH = 32;

const formatError = '邀请码须为 4–32 位字母、数字、短横线（-）或下划线（_）';

/** Empty input keeps random generation; custom codes share registration's casing. */
export function parseCustomInviteCode(value: unknown): {
  code: string;
  error?: string;
} {
  if (value === undefined) return { code: '' };
  if (typeof value !== 'string') return { code: '', error: formatError };
  const code = value.trim();
  if (!code) return { code: '' };
  if (
    code.length < CUSTOM_INVITE_CODE_MIN_LENGTH ||
    code.length > CUSTOM_INVITE_CODE_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(code)
  ) {
    return { code: '', error: formatError };
  }
  return { code: code.toUpperCase() };
}
