export interface UserIdentity {
  /** Canonical positive decimal ID. Legacy UUIDs resolve through permanent aliases. */
  uid: string;
  username: string;
  /** Immutable internal namespace; old accounts retain their existing data. */
  storageKey: string;
  /** Signed session epoch. Missing values in the first UID schema mean zero. */
  sessionVersion?: number;
  /** Historical UUIDs remain bound to this ID, including after delete/restore. */
  legacyUids?: string[];
}

export type UserIdentityErrorCode =
  | 'INVALID_USERNAME'
  | 'INVALID_UID'
  | 'USER_NOT_FOUND'
  | 'USERNAME_EXISTS'
  | 'UID_EXISTS'
  | 'IDENTITY_CONFLICT'
  | 'STALE_USERNAME'
  | 'OWNER_PROTECTED';

const messages: Record<UserIdentityErrorCode, string> = {
  INVALID_USERNAME: '用户名只能包含汉字、字母、数字和下划线，长度2-20位',
  INVALID_UID: '用户 UID 格式无效',
  USER_NOT_FOUND: '用户不存在',
  USERNAME_EXISTS: '该用户名已被注册',
  UID_EXISTS: '用户 UID 已被其他账号使用',
  IDENTITY_CONFLICT: '账号身份信息冲突，请刷新后重试',
  STALE_USERNAME: '用户名已发生变化，请刷新后重试',
  OWNER_PROTECTED: '站长账号由环境配置管理，不能在此修改',
};

export class UserIdentityError extends Error {
  constructor(readonly code: UserIdentityErrorCode) {
    super(messages[code]);
    this.name = 'UserIdentityError';
  }
}

export function isNumericUserUid(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

export function isLegacyUserUid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

export function isUserUid(value: unknown): value is string {
  return isNumericUserUid(value) || isLegacyUserUid(value);
}

export function validateUsername(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,20}$/.test(value)
  ) {
    throw new UserIdentityError('INVALID_USERNAME');
  }
  return value;
}

export interface UserIdentityAccess {
  allocateUserUid(preferredUid?: string): Promise<string>;
  getAllUserIdentities(): Promise<UserIdentity[]>;
  getUserIdentity(username: string): Promise<UserIdentity | null>;
  getUserIdentityByUid(uid: string): Promise<UserIdentity | null>;
  isLegacyUsernameRetired(username: string): Promise<boolean>;
  renameUser(
    uid: string,
    newUsername: string,
    expectedUsername?: string,
  ): Promise<UserIdentity>;
}

export interface IdentityRegistry {
  allocateUid(): Promise<string>;
  reserveUid(uid: string): Promise<string>;
  getByUid(uid: string): Promise<UserIdentity | null>;
  getByUsername(username: string): Promise<UserIdentity | null>;
  getByStorageKey(storageKey: string): Promise<UserIdentity | null>;
  getOwner(): Promise<UserIdentity | null>;
  list(): Promise<UserIdentity[]>;
  isUsernameRetired(username: string): Promise<boolean>;
  isStorageRetired(storageKey: string): Promise<boolean>;
  retiredUsernameUid(username: string): Promise<string | null>;
  ensure(
    identity: UserIdentity,
    options?: { fresh?: boolean; owner?: boolean },
  ): Promise<UserIdentity>;
  rename(
    uid: string,
    username: string,
    expectedUsername?: string,
  ): Promise<UserIdentity>;
  remove(uid: string, expectedStorageKey?: string): Promise<void>;
  clear(): Promise<void>;
}
