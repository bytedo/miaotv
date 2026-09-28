import {
  credentialForRestore,
  encodeStoredCredential,
  hashPassword,
  type PasswordSnapshot,
  verifyAndUpgradePassword,
} from './password';

export interface AccountRedisPort {
  get(key: string): Promise<unknown>;
  getInfo(key: string): Promise<Record<string, unknown> | null>;
  scan(pattern: string): Promise<string[]>;
  list(key: string): Promise<unknown[]>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export interface AccountCreationMetadata {
  /** Trusted backup restore may retain an existing stable identity. */
  uid?: string;
  legacyUids?: string[];
  /** Set only by the server-side backup importer for pre-existing names. */
  allowLegacyUsername?: boolean;
  pending?: boolean;
  source?: string;
  banned?: boolean;
  createdAt?: number;
}

export interface PasswordChangeExpectation {
  credential: string | null;
  email?: string;
}

export class AccountStateChangedError extends Error {
  readonly code = 'ACCOUNT_CHANGED';
  constructor() {
    super('账号凭据或邮箱已变更，请重新发起操作');
    this.name = 'AccountStateChangedError';
  }
}

export function assertExpectedAccountState(snapshot: PasswordSnapshot, expected: PasswordChangeExpectation): void {
  const stored = snapshot.current ?? snapshot.legacy;
  let currentCredential: string | null;
  try {
    currentCredential = stored === null || stored === '' ? null : encodeStoredCredential(stored);
  } catch {
    // An unreadable replacement is also a change from the caller's snapshot.
    throw new AccountStateChangedError();
  }
  // The expectation is the exact canonical credential and normalized email
  // returned by the account getters, not another credential to restore.
  if (currentCredential !== expected.credential || (expected.email !== undefined &&
      String(snapshot.email ?? '').trim().toLowerCase() !== expected.email)) {
    throw new AccountStateChangedError();
  }
}

export const ACCOUNT_SNAPSHOT_LUA = `
return cjson.encode({
  current = redis.call('GET', KEYS[1]) or cjson.null,
  legacy = redis.call('HGET', KEYS[2], 'password') or cjson.null,
  email = redis.call('GET', KEYS[3]) or redis.call('HGET', KEYS[2], 'email') or cjson.null
})
`;

export const ACCOUNT_COMPARE_AND_SET_LUA = `
local current = redis.call('GET', KEYS[1])
local legacy = redis.call('HGET', KEYS[2], 'password')
if (ARGV[1] == '1' and current ~= ARGV[2]) or (ARGV[1] == '0' and current) then return 0 end
if (ARGV[3] == '1' and legacy ~= ARGV[4]) or (ARGV[3] == '0' and legacy) then return 0 end
if ARGV[8] == '1' then
  local email = redis.call('GET', KEYS[4]) or redis.call('HGET', KEYS[2], 'email')
  if (ARGV[9] == '1' and email ~= ARGV[10]) or (ARGV[9] == '0' and email) then return 0 end
end
if not current and not legacy and redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[5])
redis.call('HDEL', KEYS[2], 'password')
redis.call('ZADD', KEYS[3], 'NX', ARGV[6], ARGV[7])
return 1
`;

export const ACCOUNT_SET_CREDENTIAL_LUA = `
if redis.call('EXISTS', KEYS[1], KEYS[2]) == 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], 'password')
redis.call('ZADD', KEYS[3], 'NX', ARGV[2], ARGV[3])
return 1
`;

export const ACCOUNT_EXISTS_LUA = `
return redis.call('EXISTS', KEYS[1], KEYS[2])
`;

export const ACCOUNT_CREATE_LUA = `
local current = redis.call('GET', KEYS[1])
-- A retry after a lost response must not turn this same creation into a failure.
if current == ARGV[2] then return 'created' end
if current or redis.call('EXISTS', KEYS[2]) == 1 then return 'username_exists' end
if ARGV[4] ~= '' then
  local owner = redis.call('GET', KEYS[5])
  if owner and owner ~= ARGV[1] then
    local storedEmail = redis.call('GET', 'u:' .. owner .. ':email') or redis.call('HGET', 'u:' .. owner .. ':info', 'email')
    if storedEmail and string.lower(string.match(storedEmail, '^%s*(.-)%s*$')) == ARGV[4]
      and redis.call('EXISTS', 'u:' .. owner .. ':pwd', 'u:' .. owner .. ':info') > 0 then return 'email_exists' end
  end
end
if ARGV[5] ~= '' then
  local owner = redis.call('GET', KEYS[6])
  if owner and owner ~= ARGV[1] and redis.call('HGET', 'u:' .. owner .. ':info', 'oidcSub') == ARGV[5] then return 'oidc_exists' end
end
-- Orphan attributes from a partial legacy deletion must not bind a new account.
local oldEmail = redis.call('GET', KEYS[4])
if oldEmail then
  local oldIndex = 'email:lookup:' .. string.lower(string.match(oldEmail, '^%s*(.-)%s*$'))
  if redis.call('GET', oldIndex) == ARGV[1] then redis.call('DEL', oldIndex) end
end
redis.call('DEL', KEYS[4])
redis.call('SET', KEYS[1], ARGV[2])
if ARGV[6] ~= '' then
  local info = cjson.decode(ARGV[6])
  for field, value in pairs(info) do redis.call('HSET', KEYS[2], field, value) end
end
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
if ARGV[4] ~= '' then
  redis.call('SET', KEYS[4], ARGV[4])
  redis.call('SET', KEYS[5], ARGV[1])
end
if ARGV[5] ~= '' then redis.call('SET', KEYS[6], ARGV[1]) end
return 'created'
`;

export const ACCOUNT_SET_EMAIL_LUA = `
if redis.call('EXISTS', KEYS[1], KEYS[2]) == 0 then return 'missing' end
if ARGV[2] ~= '' then
  local owner = redis.call('GET', KEYS[4])
  if owner and owner ~= ARGV[1] then
    local storedEmail = redis.call('GET', 'u:' .. owner .. ':email') or redis.call('HGET', 'u:' .. owner .. ':info', 'email')
    if storedEmail and string.lower(string.match(storedEmail, '^%s*(.-)%s*$')) == ARGV[2]
      and redis.call('EXISTS', 'u:' .. owner .. ':pwd', 'u:' .. owner .. ':info') > 0 then return 'email_exists' end
  end
end
local oldEmail = redis.call('GET', KEYS[3]) or redis.call('HGET', KEYS[2], 'email')
if oldEmail then
  local oldKey = 'email:lookup:' .. string.lower(string.match(oldEmail, '^%s*(.-)%s*$'))
  if redis.call('GET', oldKey) == ARGV[1] then redis.call('DEL', oldKey) end
end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[3])
else
  redis.call('SET', KEYS[3], ARGV[2])
  redis.call('SET', KEYS[4], ARGV[1])
end
redis.call('HDEL', KEYS[2], 'email')
return 'updated'
`;

export const ACCOUNT_DELETE_LUA = `
local current = redis.call('GET', KEYS[1])
local legacy = redis.call('HGET', KEYS[2], 'password')
if not current and not legacy and redis.call('EXISTS', KEYS[2]) == 0
  and (ARGV[2] == '1' or ARGV[4] == '1') then return 1 end
if (ARGV[2] == '1' and current ~= ARGV[3]) or (ARGV[2] == '0' and current) then return 0 end
if (ARGV[4] == '1' and legacy ~= ARGV[5]) or (ARGV[4] == '0' and legacy) then return 0 end
-- Read bindings before removing the user info, in the same atomic operation.
local sub = redis.call('HGET', KEYS[2], 'oidcSub')
local email = redis.call('GET', KEYS[3]) or redis.call('HGET', KEYS[2], 'email')
if sub then
  local oidcKey = 'oidc:sub:' .. sub
  if redis.call('GET', oidcKey) == ARGV[1] then redis.call('DEL', oidcKey) end
end
if email then
  local emailKey = 'email:lookup:' .. string.lower(string.match(email, '^%s*(.-)%s*$'))
  if redis.call('GET', emailKey) == ARGV[1] then redis.call('DEL', emailKey) end
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
redis.call('ZREM', KEYS[4], ARGV[1])
for index = 5, #KEYS do redis.call('DEL', KEYS[index]) end
return 1
`;

export const CONSUME_CACHE_LUA = `
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value
`;

export function decodeCacheValue(value: unknown): any | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function normalizeUserEmail(email: string): string {
  if (typeof email !== 'string') throw new Error('邮箱格式无效');
  const normalized = email.trim().toLowerCase();
  if (normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('邮箱格式无效');
  }
  return normalized;
}

/** Account-only Redis operations, shared by Redis/Kvrocks and Upstash. */
export class RedisAccountStorage {
  constructor(private readonly port: AccountRedisPort) {}

  private pwd(user: string) { return `u:${user}:pwd`; }
  private info(user: string) { return `u:${user}:info`; }
  private email(user: string) { return `u:${user}:email`; }
  private emailIndex(email: string) { return `email:lookup:${email}`; }
  private oidc(sub: string) { return `oidc:sub:${sub}`; }

  private async snapshot(user: string): Promise<PasswordSnapshot> {
    const result = await this.port.eval(ACCOUNT_SNAPSHOT_LUA, [this.pwd(user), this.info(user), this.email(user)], []);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    if (!data || typeof data !== 'object') throw new Error('无法读取账号凭据');
    const snapshot = data as PasswordSnapshot;
    if ((snapshot.current !== null && typeof snapshot.current !== 'string') ||
        (snapshot.legacy !== null && typeof snapshot.legacy !== 'string') ||
        (snapshot.email !== null && typeof snapshot.email !== 'string')) {
      throw new Error('账号凭据格式无效');
    }
    return snapshot;
  }

  async verifyUser(user: string, password: string): Promise<boolean> {
    return verifyAndUpgradePassword(password, () => this.snapshot(user), async (snapshot, credential) => {
      const result = await this.port.eval(
        ACCOUNT_COMPARE_AND_SET_LUA,
        [this.pwd(user), this.info(user), 'users:list'],
        [snapshot.current === null ? '0' : '1', snapshot.current ?? '',
          snapshot.legacy === null ? '0' : '1', snapshot.legacy ?? '',
          credential, Date.now().toString(), user],
      );
      return Number(result) === 1;
    });
  }

  async checkUserExist(user: string): Promise<boolean> {
    return Number(await this.port.eval(ACCOUNT_EXISTS_LUA, [this.pwd(user), this.info(user)], [])) > 0;
  }

  async getUserCredential(user: string): Promise<string | null> {
    const snapshot = await this.snapshot(user);
    const stored = snapshot.current ?? snapshot.legacy;
    return stored === null || stored === '' ? null : encodeStoredCredential(stored);
  }

  async restoreUserCredential(user: string, encodedCredential: string): Promise<void> {
    const credential = credentialForRestore(encodedCredential);
    const result = await this.port.eval(ACCOUNT_SET_CREDENTIAL_LUA,
      [this.pwd(user), this.info(user), 'users:list'], [credential, Date.now().toString(), user]);
    if (Number(result) !== 1) throw new Error('用户不存在');
  }

  async changePassword(user: string, password: string, expected?: PasswordChangeExpectation): Promise<void> {
    if (expected === undefined) {
      await this.restoreUserCredential(user, hashPassword(password));
      return;
    }
    const snapshot = await this.snapshot(user);
    assertExpectedAccountState(snapshot, expected);
    const result = await this.port.eval(ACCOUNT_COMPARE_AND_SET_LUA,
      [this.pwd(user), this.info(user), 'users:list', this.email(user)],
      [snapshot.current === null ? '0' : '1', snapshot.current ?? '',
        snapshot.legacy === null ? '0' : '1', snapshot.legacy ?? '',
        hashPassword(password), Date.now().toString(), user, expected.email === undefined ? '0' : '1',
        snapshot.email === null ? '0' : '1', snapshot.email ?? '']);
    if (Number(result) !== 1) throw new AccountStateChangedError();
  }

  private async createUser(user: string, password: string, email: string | undefined,
    metadata?: Record<string, string>): Promise<void> {
    const normalizedEmail = normalizeUserEmail(email ?? '');
    if (normalizedEmail) {
      const owner = await this.getUsernameByEmail(normalizedEmail);
      if (owner && owner !== user) throw new Error('该邮箱已被其他账号关联');
    }
    const sub = metadata?.oidcSub ?? '';
    if (sub) {
      const owner = await this.getUserByOidcSub(sub);
      if (owner && owner !== user) throw new Error('该 OIDC 身份已绑定其他账号');
    }
    const createdAt = metadata?.created_at ?? Date.now().toString();
    const result = await this.port.eval(ACCOUNT_CREATE_LUA,
      [this.pwd(user), this.info(user), 'users:list', this.email(user),
        this.emailIndex(normalizedEmail), this.oidc(sub)],
      [user, hashPassword(password), createdAt, normalizedEmail, sub,
        metadata ? JSON.stringify(metadata) : '']);
    if (result === 'username_exists') throw new Error('该用户名已被注册');
    if (result === 'email_exists') throw new Error('该邮箱已被其他账号关联');
    if (result === 'oidc_exists') throw new Error('该 OIDC 身份已绑定其他账号');
    if (result !== 'created') throw new Error('创建账号失败');
  }

  async registerUser(user: string, password: string, email?: string): Promise<void> {
    await this.createUser(user, password, email);
  }

  async createUserV2(user: string, password: string, role: 'owner' | 'admin' | 'user' = 'user',
    tags?: string[], oidcSub?: string, enabledApis?: string[], email?: string,
    metadata?: AccountCreationMetadata): Promise<void> {
    const createdAt = metadata?.createdAt ?? Date.now();
    if (!Number.isFinite(createdAt) || createdAt < 0) throw new Error('账号创建时间无效');
    const info: Record<string, string> = {
      role, banned: String(metadata?.banned === true), pending: String(metadata?.pending === true),
      created_at: createdAt.toString(),
    };
    if (metadata?.source) info.source = metadata.source;
    if (tags?.length) info.tags = JSON.stringify(tags);
    if (enabledApis?.length) info.enabledApis = JSON.stringify(enabledApis);
    if (oidcSub !== undefined && oidcSub !== '') info.oidcSub = String(oidcSub);
    await this.createUser(user, password, email, info);
  }

  async getUserEmail(user: string): Promise<string | null> {
    const value = await this.port.get(this.email(user)) ?? (await this.port.getInfo(this.info(user)))?.email;
    return value === null || value === undefined ? null : String(value).trim().toLowerCase() || null;
  }

  async getUsernameByEmail(email: string): Promise<string | null> {
    const normalized = normalizeUserEmail(email);
    if (!normalized) return null;
    // Scan legacy attributes until every existing email has an index. Never
    // silently choose a user when old data contains duplicate email addresses.
    const [emailKeys, infoKeys] = await Promise.all([this.port.scan('u:*:email'), this.port.scan('u:*:info')]);
    const users = new Set([
      ...emailKeys.map(key => key.slice(2, -6)), ...infoKeys.map(key => key.slice(2, -5)),
    ]);
    let owner: string | null = null;
    const candidates = Array.from(users);
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const batch = candidates.slice(offset, offset + 100);
      const values = await Promise.all(batch.map(user => this.getUserEmail(user)));
      for (let i = 0; i < batch.length; i++) {
        if (values[i] !== normalized) continue;
        const user = batch[i];
        if (!await this.checkUserExist(user)) continue;
        if (owner && owner !== user) throw new Error('该邮箱关联多个账号，请联系管理员');
        owner = user;
      }
    }
    return owner;
  }

  async setUserEmail(user: string, email: string): Promise<void> {
    const normalized = normalizeUserEmail(email);
    const owner = normalized ? await this.getUsernameByEmail(normalized) : null;
    if (owner && owner !== user) throw new Error('该邮箱已被其他账号关联');
    const result = await this.port.eval(ACCOUNT_SET_EMAIL_LUA,
      [this.pwd(user), this.info(user), this.email(user), this.emailIndex(normalized)], [user, normalized]);
    if (result === 'missing') throw new Error('用户不存在');
    if (result === 'email_exists') throw new Error('该邮箱已被其他账号关联');
    if (result !== 'updated') throw new Error('保存邮箱失败');
  }

  async deleteIdentity(user: string, relatedKeys: string[] = []): Promise<void> {
    const snapshot = await this.snapshot(user);
    const result = await this.port.eval(ACCOUNT_DELETE_LUA,
      [this.pwd(user), this.info(user), this.email(user), 'users:list', ...relatedKeys],
      [user, snapshot.current === null ? '0' : '1', snapshot.current ?? '',
        snapshot.legacy === null ? '0' : '1', snapshot.legacy ?? '']);
    if (Number(result) !== 1) throw new AccountStateChangedError();
  }

  async getAllUsers(): Promise<string[]> {
    const [listed, pwdKeys, infoKeys] = await Promise.all([
      this.port.list('users:list'), this.port.scan('u:*:pwd'), this.port.scan('u:*:info'),
    ]);
    const keyed = new Set([
      ...pwdKeys.map(key => key.slice(2, -4)), ...infoKeys.map(key => key.slice(2, -5)),
    ]);
    const users = new Set<string>();
    // Validate scan results too: SCAN is not a snapshot and may return keys
    // removed before configSelfCheck consumes the combined user list.
    for (const user of new Set([...listed.map(String), ...keyed])) {
      if (await this.checkUserExist(user)) users.add(user);
    }
    return Array.from(users);
  }

  async getUserByOidcSub(sub: string): Promise<string | null> {
    const subject = String(sub);
    const [indexed, keys] = await Promise.all([
      this.port.get(this.oidc(subject)), this.port.scan('u:*:info'),
    ]);
    const users = new Set(keys.map(key => key.slice(2, -5)));
    if (indexed !== null && indexed !== undefined) users.add(String(indexed));
    let owner: string | null = null;
    for (const user of users) {
      const info = await this.port.getInfo(this.info(user));
      if (info?.oidcSub === undefined || String(info.oidcSub) !== subject) continue;
      if (owner && owner !== user) throw new Error('该 OIDC 身份关联多个账号，请联系管理员');
      owner = user;
    }
    return owner;
  }
}
