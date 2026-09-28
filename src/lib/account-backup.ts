import { encodeStoredCredential, isValidEncodedCredential } from './password';
import { isNumericUserUid, isUserUid } from './user-identity';

export interface AccountBackupProfile {
  uid?: string;
  role: 'owner' | 'admin' | 'user';
  tags?: string[];
  enabledApis?: string[];
  oidcSub?: string;
  banned?: boolean;
  pending?: boolean;
  source?: string;
  createdAt?: number;
}

export interface AccountBackup {
  version: 1;
  credential: string | null;
  email: string | null;
  profile: AccountBackupProfile;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject malformed sections before the import route clears existing data. */
export function validateBackupConfiguration(value: unknown): void {
  if (!object(value)) throw new Error('备份管理员配置格式无效');
  for (const field of ['SiteConfig', 'UserConfig', 'ConfigSubscribtion']) {
    if (value[field] != null && !object(value[field])) {
      throw new Error(`备份的 ${field} 格式无效`);
    }
  }
  const legacyOidcConfig = value.OIDCAuthConfig;
  if (legacyOidcConfig != null) {
    if (!object(legacyOidcConfig)) {
      throw new Error('备份的 OIDCAuthConfig 格式无效');
    }
    if (
      legacyOidcConfig.issuer != null &&
      typeof legacyOidcConfig.issuer !== 'string'
    ) {
      throw new Error('备份的 OIDCAuthConfig.issuer 格式无效');
    }
  }
  for (const field of ['SourceConfig', 'CustomCategories', 'LiveConfig']) {
    const entries = value[field];
    if (
      entries != null &&
      (!Array.isArray(entries) || entries.some((entry) => !object(entry)))
    ) {
      throw new Error(`备份的 ${field} 格式无效`);
    }
  }
}

function validateUserCollections(value: unknown): void {
  if (!object(value)) throw new Error('账号备份格式无效');
  for (const field of [
    'playRecords',
    'favorites',
    'reminders',
    'skipConfigs',
  ]) {
    const entries = value[field];
    if (
      entries != null &&
      (!object(entries) ||
        Object.values(entries).some((entry) => !object(entry)))
    ) {
      throw new Error(`用户备份的 ${field} 格式无效`);
    }
  }
  if (
    value.searchHistory != null &&
    (!Array.isArray(value.searchHistory) ||
      value.searchHistory.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error('用户备份的搜索历史格式无效');
  }
  for (const field of ['loginStats', 'userInfoV2']) {
    if (value[field] != null && !object(value[field])) {
      throw new Error(`用户备份的 ${field} 格式无效`);
    }
  }
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`账号备份的 ${field} 格式无效`);
  }
  return [...value];
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`账号备份的 ${field} 格式无效`);
}

export function accountProfile(value: unknown): AccountBackupProfile {
  const profile = object(value) ? value : {};
  const role = profile.role ?? 'user';
  if (role !== 'owner' && role !== 'admin' && role !== 'user') {
    throw new Error('账号备份的角色无效');
  }
  for (const field of ['oidcSub', 'source']) {
    if (profile[field] !== undefined && typeof profile[field] !== 'string') {
      throw new Error(`账号备份的 ${field} 格式无效`);
    }
  }
  const createdAt = profile.createdAt;
  if (profile.uid !== undefined && !isUserUid(profile.uid)) {
    throw new Error('账号备份的 UID 格式无效');
  }
  if (
    createdAt !== undefined &&
    (typeof createdAt !== 'number' ||
      !Number.isFinite(createdAt) ||
      createdAt < 0)
  ) {
    throw new Error('账号备份的注册时间无效');
  }
  return {
    uid: profile.uid as string | undefined,
    role,
    tags: stringList(profile.tags, 'tags'),
    enabledApis: stringList(profile.enabledApis, 'enabledApis'),
    oidcSub: profile.oidcSub as string | undefined,
    banned: optionalBoolean(profile.banned, 'banned'),
    pending: optionalBoolean(profile.pending, 'pending'),
    source: profile.source as string | undefined,
    createdAt: createdAt as number | undefined,
  };
}

function accountEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('账号备份的邮箱格式无效');
  const email = value.trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('账号备份的邮箱格式无效');
  }
  return email || null;
}

/** Validate every account before the import route starts clearing any data. */
export function readAccountBackup(
  user: unknown,
  schemaVersion: number | undefined,
  configuredProfile?: unknown,
): AccountBackup {
  if (!object(user)) throw new Error('账号备份格式无效');
  if (
    schemaVersion !== undefined &&
    schemaVersion !== 1 &&
    schemaVersion !== 2 &&
    schemaVersion !== 3
  ) {
    throw new Error('不支持该备份版本');
  }

  if (schemaVersion === 2 || schemaVersion === 3) {
    if (!object(user.account) || user.account.version !== 1) {
      throw new Error('缺少新版账号备份信息');
    }
    const account = user.account;
    if (!object(account.profile)) throw new Error('缺少账号备份资料');
    if (
      account.credential !== null &&
      (typeof account.credential !== 'string' ||
        !isValidEncodedCredential(account.credential))
    ) {
      throw new Error('账号备份凭据格式无效');
    }
    return {
      version: 1,
      credential: account.credential as string | null,
      email: accountEmail(account.email),
      profile: accountProfile(account.profile),
    };
  }

  // Historical exports may contain both pwd and info.password. The canonical
  // pwd wins; importing the stale info password must not revive an old secret.
  const info = object(user.userInfoV2) ? user.userInfoV2 : {};
  const configured = object(configuredProfile) ? configuredProfile : {};
  let credential: string | null = null;
  if (user.password !== undefined && user.password !== null) {
    if (typeof user.password !== 'string') throw new Error('旧版密码字段无效');
    credential = encodeStoredCredential(user.password, 'pwd');
  } else if (info.password !== undefined && info.password !== null) {
    if (typeof info.password !== 'string')
      throw new Error('旧版 V2 密码字段无效');
    credential = encodeStoredCredential(info.password, 'info');
  }

  return {
    version: 1,
    credential,
    email: accountEmail(user.email ?? configured.email ?? info.email),
    profile: accountProfile({ ...info, ...configured }),
  };
}

export function prepareAccountRestore(
  userData: unknown,
  schemaVersion: unknown,
  configuredUsers: unknown,
  ownerUsername?: string,
  ownerUid?: string,
): Map<string, AccountBackup> {
  if (!object(userData)) throw new Error('账号备份格式无效');
  if (
    schemaVersion !== undefined &&
    schemaVersion !== 1 &&
    schemaVersion !== 2 &&
    schemaVersion !== 3
  ) {
    throw new Error('不支持该备份版本');
  }
  if (configuredUsers !== undefined && !Array.isArray(configuredUsers)) {
    throw new Error('备份账号配置格式无效');
  }

  const configured = new Map<string, Record<string, unknown>>();
  const configuredUids = new Set<string>();
  for (const profile of Array.isArray(configuredUsers) ? configuredUsers : []) {
    if (
      !object(profile) ||
      typeof profile.username !== 'string' ||
      !profile.username
    ) {
      throw new Error('备份账号配置格式无效');
    }
    if (configured.has(profile.username))
      throw new Error('备份账号配置包含重复用户名');
    accountProfile(profile);
    if (typeof profile.uid === 'string') {
      if (configuredUids.has(profile.uid))
        throw new Error('备份账号配置包含重复 UID');
      configuredUids.add(profile.uid);
    }
    configured.set(profile.username, profile);
  }

  const accounts = new Map<string, AccountBackup>();
  const emailOwners = new Map<string, string>();
  const oidcOwners = new Map<string, string>();
  const uidOwners = new Map<string, string>();
  for (const [key, user] of Object.entries(userData)) {
    const username = schemaVersion === 3 && object(user) ? user.username : key;
    if (typeof username !== 'string') throw new Error('备份包含无效用户名');
    if (!username) throw new Error('备份包含空用户名');
    if (accounts.has(username)) throw new Error('备份包含重复用户名');
    validateUserCollections(user);
    const account = readAccountBackup(
      user,
      schemaVersion as number | undefined,
      configured.get(username),
    );
    const configuredUid = configured.get(username)?.uid;
    if (
      account.profile.uid &&
      configuredUid &&
      account.profile.uid !== configuredUid
    ) {
      throw new Error('备份账号资料的 UID 不一致');
    }
    if (
      schemaVersion === 3 &&
      (!isUserUid(key) ||
        !object(user) ||
        user.uid !== key ||
        account.profile.uid !== key)
    ) {
      throw new Error('备份用户索引与 UID 不一致');
    }
    const uid =
      account.profile.uid ||
      (typeof configuredUid === 'string' ? configuredUid : undefined);
    if (uid && uidOwners.has(uid)) throw new Error('备份包含重复 UID');
    if (ownerUid && uid === ownerUid && username !== ownerUsername) {
      throw new Error('普通用户不能使用站长 UID');
    }
    if (uid) uidOwners.set(uid, username);
    account.profile.uid = uid;
    if (username === ownerUsername) {
      account.profile.role = 'owner';
    } else if (account.profile.role === 'owner') {
      account.profile.role = 'user';
    }
    if (
      account.credential === null &&
      !account.profile.oidcSub &&
      username !== ownerUsername
    ) {
      throw new Error(`用户 ${username} 缺少可恢复凭据或 OIDC 绑定`);
    }
    if (account.email) {
      if (emailOwners.has(account.email))
        throw new Error('备份包含重复邮箱，需先修正账号绑定');
      emailOwners.set(account.email, username);
    }
    if (account.profile.oidcSub) {
      if (oidcOwners.has(account.profile.oidcSub))
        throw new Error('备份包含重复 OIDC 绑定');
      oidcOwners.set(account.profile.oidcSub, username);
    }
    accounts.set(username, account);
  }
  return accounts;
}

/** Reserve durable numeric IDs only after every backup account is validated. */
export async function assignAccountRestoreUids(
  accounts: Map<string, AccountBackup>,
  allocateUserUid: (preferredUid?: string) => Promise<string>,
  ownerUsername?: string,
  ownerUid?: string,
): Promise<void> {
  const assigned = new Map<string, string>();
  const uidOwners = new Set<string>();
  async function assign(username: string, preferredUid?: string) {
    const uid = await allocateUserUid(preferredUid);
    if (uidOwners.has(uid)) throw new Error('备份包含重复 UID');
    if (ownerUid && uid === ownerUid && username !== ownerUsername) {
      throw new Error('普通用户不能使用站长 UID');
    }
    assigned.set(username, uid);
    uidOwners.add(uid);
  }

  // Advance the counter past every supplied number before allocating missing
  // IDs, so a valid mixed-version backup cannot accidentally reserve one twice.
  const entries = [...accounts];
  for (const [username, account] of entries) {
    if (isNumericUserUid(account.profile.uid)) {
      await assign(username, account.profile.uid);
    }
  }
  for (const [username, account] of entries) {
    if (account.profile.uid && !assigned.has(username)) {
      await assign(username, account.profile.uid);
    }
  }
  for (const [username] of entries) {
    if (!assigned.has(username)) {
      await assign(username, username === ownerUsername ? ownerUid : undefined);
    }
  }
  for (const [username, account] of entries) {
    account.profile.uid = assigned.get(username)!;
  }
}
