export type AccountState = {
  banned?: boolean;
  pending?: boolean;
};

export type RegistrationSettings = {
  AllowRegister?: boolean;
  RequireApproval?: boolean;
  RequireInviteCode?: boolean;
};

export type RegistrationPolicy = {
  allowRegister: boolean;
  requireApproval: boolean;
  requireInviteCode: boolean;
};

export function getRegistrationPolicy(
  settings?: RegistrationSettings,
  supportsRegistration = true,
): RegistrationPolicy {
  return {
    allowRegister: supportsRegistration && settings?.AllowRegister !== false,
    requireApproval: settings?.RequireApproval === true,
    requireInviteCode: settings?.RequireInviteCode === true,
  };
}

export function normalizeInviteCode(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function getRegistrationMode(
  policy: Omit<RegistrationPolicy, 'allowRegister'> & {
    allowRegister?: boolean;
  },
  inviteCode?: unknown,
): 'closed' | 'invite' | 'approval' | 'open' {
  if (policy.allowRegister === false) return 'closed';
  // This describes the form requirements. The server must consume the code
  // successfully before creating an account that bypasses approval.
  if (policy.requireInviteCode || normalizeInviteCode(inviteCode))
    return 'invite';
  return policy.requireApproval ? 'approval' : 'open';
}

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isSecureAccountRequest(request: Request): boolean {
  const forwarded = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    .trim()
    .toLowerCase();
  return forwarded
    ? forwarded === 'https'
    : new URL(request.url).protocol === 'https:';
}

export function isValidEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
    !/[<>,;:"()[\]\\\u0000-\u0020\u007f]/.test(value)
  );
}

export function getAccountAccessError(
  configured?: AccountState | null,
  stored?: AccountState | null,
): string | null {
  // Admin decisions explicitly set false. Stored flags protect the creation
  // window and legacy accounts until those configuration fields exist.
  if (configured?.banned ?? stored?.banned) return '用户被封禁';
  if (configured?.pending ?? stored?.pending) {
    return '账户正在等待管理员审核，审核通过后将通过邮件通知您';
  }
  return null;
}

export function validateRegistrationProfile(
  input: { email?: unknown; source?: unknown; inviteCode?: unknown },
  rules: Omit<RegistrationPolicy, 'allowRegister'> & {
    allowRegister?: boolean;
  },
): { email: string; source: string; inviteCode: string; error?: string } {
  const email = normalizeEmail(input.email);
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  const inviteCode = normalizeInviteCode(input.inviteCode);
  const result = { email, source, inviteCode };
  const mode = getRegistrationMode(rules, inviteCode);

  if (mode === 'closed') {
    return { ...result, error: '管理员已关闭用户注册功能' };
  }
  if (input.inviteCode != null && typeof input.inviteCode !== 'string') {
    return { ...result, error: '请输入有效的邀请码' };
  }
  if (rules.requireInviteCode && !inviteCode) {
    return { ...result, error: '请输入邀请码' };
  }

  if (input.email != null && typeof input.email !== 'string') {
    return { ...result, error: '请输入有效的邮箱地址' };
  }
  if (email && !isValidEmail(email)) {
    return { ...result, error: '请输入有效的邮箱地址' };
  }
  if (mode === 'approval' && !email) {
    return { ...result, error: '开启审核模式时邮箱为必填项' };
  }
  if (input.source != null && typeof input.source !== 'string') {
    return { ...result, error: '请输入有效的来源信息' };
  }
  if (mode === 'approval' && !source) {
    return { ...result, error: '开启审核模式时来源为必填项' };
  }
  if (source.length > 500) {
    return { ...result, error: '来源信息不能超过500字' };
  }
  return result;
}

// Keep authentication redirects on this site, including after registration.
export function sanitizeRedirect(target: string | null): string {
  if (
    !target ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/.test(target)
  ) {
    return '/';
  }
  return target;
}
