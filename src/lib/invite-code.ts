/* eslint-disable no-console */
/**
 * 邀请码系统
 * 基于 Redis 实现的邀请码生成、验证和管理
 */

import { randomUUID } from 'crypto';
import { customAlphabet } from 'nanoid';

import { db } from './db';
import { parseCustomInviteCode } from './invite-code-policy';
import { createCompatClient, evalCompat } from './redis-compat';
import { isLegacyUserUid, isUserUid, type UserIdentity } from './user-identity';

// 生成邀请码：8位大写字母+数字，排除易混淆字符 (0/O, 1/I/l)
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const generateCode = customAlphabet(alphabet, 8);

// SQLite/localstorage do not expose the Redis primitives required by this feature.
// Fail before account creation instead of silently accepting an unconsumed code.
function getRawRedisClient() {
  const storage = (db as any).storage;
  if (!storage || !storage.client) {
    throw new InviteCodeError(
      'UNSUPPORTED_STORAGE',
      '当前存储不支持邀请码，请配置 Redis、Upstash 或 Kvrocks 后再启用邀请码注册',
    );
  }
  return storage.client;
}

function getRedisClient() {
  return createCompatClient(getRawRedisClient());
}

export class InviteCodeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InviteCodeError';
  }
}

const INVITE_ERRORS: Record<string, string> = {
  ALREADY_EXISTS: '邀请码已存在，请更换一个',
  NOT_FOUND: '邀请码不存在或已失效',
  INVALID_DATA: '邀请码数据异常，请联系管理员',
  DISABLED: '邀请码已被禁用',
  EXPIRED: '邀请码已过期',
  USED_UP: '邀请码已达到最大使用次数',
  ATTEMPT_CONFLICT: '邀请码占用凭据与当前用户不匹配',
  ATTEMPT_RELEASED: '本次邀请码占用已撤销，请重新发起注册',
};

// Claim the code and write all indexes in one operation. Inactive codes and
// usage history still reserve their names; creation must never overwrite them.
const CREATE_INVITE_LUA = String.raw`
local function keyType(key)
  local value = redis.call('TYPE', key)
  if type(value) == 'table' then return value.ok end
  return value
end
local activeType = keyType(KEYS[2])
local creatorType = keyType(KEYS[3])
if (activeType ~= 'none' and activeType ~= 'set')
    or (creatorType ~= 'none' and creatorType ~= 'set') then
  return {0, 'INVALID_DATA'}
end
if redis.call('EXISTS', KEYS[1], KEYS[4]) > 0
    or redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1
    or redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 then
  return {0, 'ALREADY_EXISTS'}
end
redis.call('HSET', KEYS[1],
  'code', ARGV[1], 'createdBy', ARGV[2], 'createdByUid', ARGV[3],
  'createdAt', ARGV[4], 'maxUses', ARGV[5], 'currentUses', '0',
  'expiresAt', ARGV[6], 'disabled', 'false')
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[1])
return {1}
`;

// Keep reservation receipts in the existing invite Hash. This preserves all
// existing key names, user-list entries and admin listing/cleanup behavior.
// Released receipts are retained so a delayed retry cannot consume a slot again.
const INVITE_LUA_HELPERS = String.raw`
local function keyType(key)
  local value = redis.call('TYPE', key)
  if type(value) == 'table' then return value.ok end
  return value
end

local function checkTypes()
  local inviteType = keyType(KEYS[1])
  local activeType = keyType(KEYS[2])
  local usersType = keyType(KEYS[3])
  return (inviteType == 'none' or inviteType == 'hash')
    and (activeType == 'none' or activeType == 'set')
    and (usersType == 'none' or usersType == 'list')
end

local function integer(value, minimum)
  local n = tonumber(value)
  if not n or n ~= n or n < minimum or n > 9007199254740991 or n % 1 ~= 0 then
    return nil
  end
  return n
end

local function readInvite()
  if redis.call('HGET', KEYS[1], 'code') ~= ARGV[1] then
    return nil, 'NOT_FOUND'
  end
  local current = integer(redis.call('HGET', KEYS[1], 'currentUses'), 0)
  local maximum = integer(redis.call('HGET', KEYS[1], 'maxUses'), 1)
  local expires = integer(redis.call('HGET', KEYS[1], 'expiresAt'), 0)
  local disabled = redis.call('HGET', KEYS[1], 'disabled')
  if not current or not maximum or not expires
      or (disabled and disabled ~= 'true' and disabled ~= 'false') then
    return nil, 'INVALID_DATA'
  end
  return {current = current, maximum = maximum, expires = expires, disabled = disabled == 'true'}
end

local function nowMilliseconds()
  local time = redis.call('TIME')
  return tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end

local receiptField = '__reservation:' .. ARGV[3]
local requestedUid = ARGV[4]

local function readReceipt()
  local raw = redis.call('HGET', KEYS[1], receiptField)
  if not raw then return nil end
  local ok, receipt = pcall(cjson.decode, raw)
  if not ok or type(receipt) ~= 'table' or type(receipt.username) ~= 'string'
      or (receipt.status ~= 'reserved' and receipt.status ~= 'released') then
    return nil, 'INVALID_DATA'
  end
  if receipt.uid ~= nil and (type(receipt.uid) ~= 'string'
      or receipt.uid ~= receipt.username or receipt.listEntry ~= 'uid:' .. receipt.uid) then
    return nil, 'INVALID_DATA'
  end
  if receipt.uid == nil and receipt.listEntry ~= nil then return nil, 'INVALID_DATA' end
  return receipt
end

local function matchesReceipt(receipt)
  if receipt.username ~= ARGV[2] then return false end
  if receipt.uid ~= nil then return receipt.uid == requestedUid end
  if requestedUid == nil then return true end
  -- The previous identity schema stored UUIDs without a marker. A decimal
  -- username without that marker must never be reinterpreted as a numeric UID.
  return requestedUid == ARGV[2] and string.find(requestedUid, '-', 1, true) ~= nil
end
`;

const RESERVE_INVITE_LUA = `${INVITE_LUA_HELPERS}
if not checkTypes() then return {0, 'INVALID_DATA'} end
local invite, inviteError = readInvite()
if not invite then return {0, inviteError} end
local receipt, receiptError = readReceipt()
if receiptError then return {0, receiptError} end
if receipt then
  if not matchesReceipt(receipt) then return {0, 'ATTEMPT_CONFLICT'} end
  if receipt.status == 'released' then return {0, 'ATTEMPT_RELEASED'} end
  -- A retry after a lost reply acknowledges the same reservation, including
  -- the final slot that has already been removed from invites:active.
  return {1, invite.current, invite.maximum}
end
if invite.disabled then return {0, 'DISABLED'} end
if nowMilliseconds() > invite.expires then return {0, 'EXPIRED'} end
if invite.current >= invite.maximum then return {0, 'USED_UP'} end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) ~= 1 then return {0, 'NOT_FOUND'} end

local nextCount = invite.current + 1
local listEntry = requestedUid and 'uid:' .. requestedUid or ARGV[2]
local nextReceipt = {username = ARGV[2], status = 'reserved'}
if requestedUid then
  nextReceipt.uid = requestedUid
  nextReceipt.listEntry = listEntry
end
redis.call('HSET', KEYS[1], 'currentUses', string.format('%.0f', nextCount),
  receiptField, cjson.encode(nextReceipt))
redis.call('LPUSH', KEYS[3], listEntry)
if nextCount >= invite.maximum then redis.call('SREM', KEYS[2], ARGV[1]) end
return {1, nextCount, invite.maximum}
`;

const RELEASE_INVITE_LUA = `${INVITE_LUA_HELPERS}
if not checkTypes() then return {0, 'INVALID_DATA'} end
local receipt, receiptError = readReceipt()
if receiptError then return {0, receiptError} end
-- Legacy uses without a receipt, another attempt/user, and repeated releases
-- must never decrement the counter or remove an unrelated history entry.
if not receipt or not matchesReceipt(receipt) or receipt.status == 'released' then
  return {0, 'NO_RESERVATION'}
end
local invite, inviteError = readInvite()
if not invite then return {0, inviteError} end
if invite.current < 1 then return {0, 'INVALID_DATA'} end
local listEntry = receipt.listEntry or receipt.username
local hasUser = false
for _, entry in ipairs(redis.call('LRANGE', KEYS[3], 0, -1)) do
  if entry == listEntry then hasUser = true; break end
end
if not hasUser then return {0, 'INVALID_DATA'} end
local now = nowMilliseconds()
local nextCount = invite.current - 1
receipt.status = 'released'
redis.call('HSET', KEYS[1], 'currentUses', string.format('%.0f', nextCount),
  receiptField, cjson.encode(receipt))
redis.call('LREM', KEYS[3], 1, listEntry)
if not invite.disabled and now <= invite.expires and nextCount < invite.maximum then
  redis.call('SADD', KEYS[2], ARGV[1])
else
  redis.call('SREM', KEYS[2], ARGV[1])
end
return {1}
`;

function validateReservationArguments(
  code: string,
  username: string,
  attemptId: string,
  identity?: { userUid: string },
): string {
  if (typeof code !== 'string' || !code.trim()) {
    throw new InviteCodeError('NOT_FOUND', INVITE_ERRORS.NOT_FOUND);
  }
  if (
    typeof username !== 'string' ||
    !username ||
    typeof attemptId !== 'string' ||
    !attemptId ||
    attemptId.length > 128
  ) {
    throw new InviteCodeError(
      'INVALID_RESERVATION',
      '缺少本次注册的邀请码占用凭据',
    );
  }
  if (
    identity !== undefined &&
    (!isUserUid(identity?.userUid) || identity.userUid !== username)
  ) {
    throw new InviteCodeError(
      'INVALID_RESERVATION',
      '邀请码占用凭据与注册账号 ID 不匹配',
    );
  }
  return code.trim().toUpperCase();
}

async function runInviteScript(
  script: string,
  code: string,
  username: string,
  attemptId: string,
  userUid?: string,
): Promise<unknown[]> {
  const result = await evalCompat(
    getRawRedisClient(),
    script,
    [`invite:${code}`, 'invites:active', `invite:${code}:users`],
    [code, username, attemptId, ...(userUid ? [userUid] : [])],
  );
  if (!Array.isArray(result) || (result[0] !== 0 && result[0] !== 1)) {
    throw new InviteCodeError(
      'INVALID_RESPONSE',
      '邀请码原子操作返回异常，注册未获确认',
    );
  }
  return result;
}

function throwInviteError(result: unknown[]): never {
  const code = String(result[1] || 'INVALID_RESPONSE');
  throw new InviteCodeError(
    code,
    INVITE_ERRORS[code] || '邀请码原子操作失败，请稍后重试',
  );
}

export interface InviteCodeData {
  code: string;
  createdBy: string;
  createdByUid?: string;
  createdAt: number;
  maxUses: number;
  currentUses: number;
  expiresAt: number;
  disabled?: boolean;
  users?: string[];
}

export interface InviteCodeStats {
  code: string;
  createdBy: string;
  createdByUid?: string;
  createdAt: string;
  maxUses: number;
  currentUses: number;
  remainingUses: number;
  expiresAt: string;
  expired: boolean;
  disabled: boolean;
  status: 'active' | 'used_up' | 'expired' | 'disabled';
  users: string[];
  userUids?: string[];
}

async function readInviteData(code: string): Promise<InviteCodeData | null> {
  const data = await getRedisClient().hGetAll(`invite:${code}`);
  if (!data?.code) return null;
  // Upstash may deserialize decimal hash values as numbers. Identity fields
  // and username snapshots still need their original string representation.
  return {
    ...data,
    code: String(data.code),
    createdBy: String(data.createdBy),
    createdByUid:
      data.createdByUid == null ? undefined : String(data.createdByUid),
  };
}

function getCreatorIndexKeys(identity: UserIdentity): string[] {
  return [
    ...new Set([
      `admin:uid:${identity.uid}:invites`,
      `admin:${identity.storageKey}:invites`,
      ...(identity.legacyUids || []).map((uid) => `admin:${uid}:invites`),
    ]),
  ];
}

function getUsageUid(reference: string): string | undefined {
  if (reference.startsWith('uid:') && isUserUid(reference.slice(4))) {
    return reference.slice(4);
  }
  // UUIDs were never valid usernames. Unmarked decimal values are historical
  // usernames, including when the same text is now an unrelated account UID.
  return isLegacyUserUid(reference) ? reference : undefined;
}

/**
 * 创建邀请码
 * @param createdByUid 创建者 UID（兼容旧 UUID 别名）
 * @param maxUses 最大使用次数，默认 10
 * @param expiresIn 过期时间（秒），默认 7 天
 * @param customCode 自定义邀请码，留空则随机生成
 */
export async function createInviteCode(
  createdByUid: string,
  maxUses = 10,
  expiresIn = 604800, // 7天
  customCode?: string,
): Promise<string> {
  const parsed = parseCustomInviteCode(customCode);
  if (parsed.error) throw new InviteCodeError('INVALID_CODE', parsed.error);
  const creator = isUserUid(createdByUid)
    ? await db.getUserIdentityByUid(createdByUid)
    : null;
  if (!creator) throw new InviteCodeError('USER_NOT_FOUND', '创建者账号不存在');
  const now = Date.now();
  const expiresAt = now + expiresIn * 1000;
  const client = getRawRedisClient();

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = parsed.code || generateCode();
    const result = await evalCompat(
      client,
      CREATE_INVITE_LUA,
      [
        `invite:${code}`,
        'invites:active',
        `admin:uid:${creator.uid}:invites`,
        `invite:${code}:users`,
      ],
      [
        code,
        creator.username,
        creator.uid,
        now.toString(),
        maxUses.toString(),
        expiresAt.toString(),
      ],
    );
    if (!Array.isArray(result) || (result[0] !== 0 && result[0] !== 1)) {
      throw new InviteCodeError(
        'INVALID_RESPONSE',
        '邀请码创建返回异常，请刷新列表确认结果',
      );
    }
    if (result[0] === 1) {
      console.log(
        `[InviteCode] 创建邀请码: ${code}, 创建者 ID: ${creator.uid}, 最大使用次数: ${maxUses}`,
      );
      return code;
    }
    // Retry only a confirmed random collision, never an ambiguous write failure.
    if (parsed.code || result[1] !== 'ALREADY_EXISTS') throwInviteError(result);
  }

  throw new InviteCodeError(
    'GENERATION_FAILED',
    '无法生成唯一邀请码，请稍后重试',
  );
}

/**
 * 验证邀请码是否有效
 * @param code 邀请码
 * @returns 是否有效及剩余使用次数
 */
export async function validateInviteCode(
  code: string,
): Promise<{ valid: boolean; remainingUses?: number; error?: string }> {
  const client = getRedisClient();

  // 检查邀请码是否存在
  const exists = await client.sIsMember('invites:active', code);
  if (!exists) {
    return { valid: false, error: '邀请码不存在或已失效' };
  }

  // 获取邀请码详情
  const inviteData = await readInviteData(code);
  if (!inviteData || !inviteData.code) {
    return { valid: false, error: '邀请码数据异常' };
  }

  // 检查是否被禁用
  if (
    (inviteData.disabled as unknown as string) === 'true' ||
    inviteData.disabled === true
  ) {
    return { valid: false, error: '邀请码已被禁用' };
  }

  // 检查是否过期
  const now = Date.now();
  if (now > Number(inviteData.expiresAt)) {
    return { valid: false, error: '邀请码已过期' };
  }

  // 检查使用次数
  const currentUses = Number(inviteData.currentUses);
  const maxUses = Number(inviteData.maxUses);
  if (
    !Number.isSafeInteger(currentUses) ||
    currentUses < 0 ||
    !Number.isSafeInteger(maxUses) ||
    maxUses < 1 ||
    !Number.isSafeInteger(Number(inviteData.expiresAt))
  ) {
    return { valid: false, error: INVITE_ERRORS.INVALID_DATA };
  }
  if (currentUses >= maxUses) {
    return { valid: false, error: '邀请码已达到最大使用次数' };
  }

  const remainingUses = maxUses - currentUses;
  return { valid: true, remainingUses };
}

/**
 * 原子占用邀请码。调用方先占用，再创建账号和必要元数据。
 * 同一注册流程的重试必须复用 attemptId；省略时保留原两参数接口，
 * 但调用方没有凭据就不能补偿该次占用。
 * @param code 邀请码
 * @param username 使用者 UID；旧调用方可继续传用户名
 * @param attemptId 单次注册流程生成的 UUID
 * @param identity 新注册必须明确传入 userUid，避免与历史数字用户名混淆
 */
export async function useInviteCode(
  code: string,
  username: string,
  attemptId = randomUUID(),
  identity?: { userUid: string },
): Promise<boolean> {
  const normalizedCode = validateReservationArguments(
    code,
    username,
    attemptId,
    identity,
  );
  const result = await runInviteScript(
    RESERVE_INVITE_LUA,
    normalizedCode,
    username,
    attemptId,
    identity?.userUid,
  );
  if (result[0] !== 1) throwInviteError(result);
  return true;
}

/**
 * 只撤销与该用户和 attemptId 完全匹配的占用；重复/过时释放返回 false。
 * 旧的无凭据消费记录不能释放。必须复用 useInviteCode 的第三、第四参数。
 * 这是补偿操作，不是与账号写入跨库事务：仅在账号未创建，或本次创建
 * 的账号及元数据已确认删除后调用；账号仍存在时不能返还名额。
 */
export async function releaseInviteCode(
  code: string,
  username: string,
  attemptId: string,
  identity?: { userUid: string },
): Promise<boolean> {
  const normalizedCode = validateReservationArguments(
    code,
    username,
    attemptId,
    identity,
  );
  const result = await runInviteScript(
    RELEASE_INVITE_LUA,
    normalizedCode,
    username,
    attemptId,
    identity?.userUid,
  );
  if (result[0] === 1) return true;
  if (result[1] === 'NO_RESERVATION') return false;
  throwInviteError(result);
}

/**
 * 获取邀请码统计信息
 * @param code 邀请码
 */
export async function getInviteCodeStats(
  code: string,
): Promise<InviteCodeStats | null> {
  const client = getRedisClient();

  const inviteData = await readInviteData(code);
  if (!inviteData || !inviteData.code) {
    return null;
  }

  // 获取使用者列表
  const userRefs: string[] = (
    await client.lRange(`invite:${code}:users`, 0, -1)
  ).map(String);
  const usages = await Promise.all(
    userRefs.map(async (reference) => {
      const uid = getUsageUid(reference);
      if (!uid) return { username: reference }; // Preserve historical names.
      const identity = await db.getUserIdentityByUid(uid);
      return { username: identity?.username || uid, uid: identity?.uid || uid };
    }),
  );
  const creator = inviteData.createdByUid
    ? await db.getUserIdentityByUid(inviteData.createdByUid)
    : null;

  const now = Date.now();
  const expiresAt = Number(inviteData.expiresAt);
  const expired = now > expiresAt;
  const currentUses = Number(inviteData.currentUses);
  const maxUses = Number(inviteData.maxUses);
  const createdAt = Number(inviteData.createdAt);
  const disabled =
    (inviteData.disabled as any) === 'true' ||
    (inviteData.disabled as any) === true;

  // 计算状态
  let status: 'active' | 'used_up' | 'expired' | 'disabled';
  if (disabled) {
    status = 'disabled';
  } else if (expired) {
    status = 'expired';
  } else if (currentUses >= maxUses) {
    status = 'used_up';
  } else {
    status = 'active';
  }

  return {
    code: inviteData.code,
    createdBy: creator?.username || inviteData.createdBy,
    createdByUid: creator?.uid || inviteData.createdByUid,
    createdAt: new Date(createdAt).toISOString(),
    maxUses,
    currentUses,
    remainingUses: maxUses - currentUses,
    expiresAt: new Date(expiresAt).toISOString(),
    expired,
    disabled,
    status,
    users: usages.map((usage) => usage.username),
    userUids: usages.flatMap((usage) => (usage.uid ? [usage.uid] : [])),
  };
}

/**
 * 获取所有邀请码（包括已用完、已过期、已禁用的）
 */
export async function getAllInviteCodes(): Promise<InviteCodeStats[]> {
  const client = getRedisClient();

  // 获取所有邀请码的 key
  const keys = await client.keys('invite:*');
  const codes: string[] = [];

  for (const key of keys) {
    // 过滤掉 invite:CODE:users 这种 key，只保留 invite:CODE
    if (!key.includes(':users')) {
      const code = key.replace('invite:', '');
      codes.push(code);
    }
  }

  const stats: InviteCodeStats[] = [];
  for (const code of codes) {
    const stat = await getInviteCodeStats(code);
    if (stat) {
      stats.push(stat);
    }
  }

  return stats.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/**
 * 禁用/启用邀请码
 * @param code 邀请码
 * @param disabled 是否禁用
 */
export async function toggleInviteCode(
  code: string,
  disabled: boolean,
): Promise<boolean> {
  const client = getRedisClient();

  const inviteData = await readInviteData(code);
  if (!inviteData || !inviteData.code) {
    return false;
  }

  // 更新禁用状态
  await client.hSet(`invite:${code}`, 'disabled', disabled ? 'true' : 'false');

  // 如果禁用，从活跃集合中移除；如果启用且未用完未过期，添加到活跃集合
  if (disabled) {
    await client.sRem('invites:active', code);
    console.log(`[InviteCode] 禁用邀请码: ${code}`);
  } else {
    const now = Date.now();
    const expiresAt = Number(inviteData.expiresAt);
    const currentUses = Number(inviteData.currentUses);
    const maxUses = Number(inviteData.maxUses);

    if (now <= expiresAt && currentUses < maxUses) {
      await client.sAdd('invites:active', code);
      console.log(`[InviteCode] 启用邀请码: ${code}`);
    }
  }

  return true;
}

/**
 * 删除邀请码
 * @param code 邀请码
 */
export async function removeInviteCode(code: string): Promise<boolean> {
  const client = getRedisClient();

  const inviteData = await readInviteData(code);
  if (!inviteData || !inviteData.code) {
    return false;
  }

  // 从活跃集合中移除
  await client.sRem('invites:active', code);

  // 从创建者列表中移除
  const creatorIndexes = new Set<string>();
  if (inviteData.createdByUid) {
    const creatorUid = inviteData.createdByUid;
    creatorIndexes.add(`admin:uid:${creatorUid}:invites`);
    if (isLegacyUserUid(creatorUid)) {
      creatorIndexes.add(`admin:${creatorUid}:invites`);
    }
    const creator = await db.getUserIdentityByUid(creatorUid);
    if (creator)
      getCreatorIndexKeys(creator).forEach((key) => creatorIndexes.add(key));
  } else if (inviteData.createdBy) {
    // Without a UID this is an immutable historical username, never a lookup.
    creatorIndexes.add(`admin:${inviteData.createdBy}:invites`);
  }
  await Promise.all([...creatorIndexes].map((key) => client.sRem(key, code)));

  // 删除邀请码详情
  await client.del(`invite:${code}`);

  // 删除使用者列表
  await client.del(`invite:${code}:users`);

  console.log(`[InviteCode] 删除邀请码: ${code}`);

  return true;
}

/**
 * 获取管理员创建的邀请码列表
 * @param adminUid 管理员 UID（兼容旧 UUID 别名）
 */
export async function getAdminInviteCodes(
  adminUid: string,
): Promise<InviteCodeStats[]> {
  const client = getRedisClient();
  const identity = isUserUid(adminUid)
    ? await db.getUserIdentityByUid(adminUid)
    : null;
  if (!identity) return [];
  const codes = [
    ...new Set(
      (
        await Promise.all(
          getCreatorIndexKeys(identity).map((key) => client.sMembers(key)),
        )
      )
        .flat()
        .map(String),
    ),
  ];
  const stats: InviteCodeStats[] = [];

  for (const code of codes) {
    const stat = await getInviteCodeStats(code);
    if (
      stat &&
      (stat.createdByUid
        ? stat.createdByUid === identity.uid
        : stat.createdBy === identity.storageKey)
    ) {
      stats.push(stat);
    }
  }

  return stats.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/**
 * 清理超过30天的已用完/已过期邀请码
 */
export async function cleanupOldInviteCodes(): Promise<number> {
  const client = getRedisClient();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // 获取所有邀请码
  const keys = await client.keys('invite:*');
  const codes: string[] = [];

  for (const key of keys) {
    if (!key.includes(':users')) {
      const code = key.replace('invite:', '');
      codes.push(code);
    }
  }

  let deletedCount = 0;

  for (const code of codes) {
    const inviteData = await readInviteData(code);
    if (!inviteData || !inviteData.code) {
      continue;
    }

    const createdAt = Number(inviteData.createdAt);
    const currentUses = Number(inviteData.currentUses);
    const maxUses = Number(inviteData.maxUses);
    const expiresAt = Number(inviteData.expiresAt);
    const now = Date.now();

    // 只删除超过30天且已用完或已过期的邀请码
    if (
      createdAt < thirtyDaysAgo &&
      (currentUses >= maxUses || now > expiresAt)
    ) {
      await removeInviteCode(code);
      deletedCount++;
    }
  }

  console.log(`[InviteCode] 清理了 ${deletedCount} 个超过30天的旧邀请码`);
  return deletedCount;
}
