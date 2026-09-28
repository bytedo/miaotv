/* eslint-disable no-console */

import { Redis } from '@upstash/redis';

import { AdminConfig } from './admin.types';
import { IDENTITY_REGISTRY_KEY, RedisIdentityRegistry } from './identity-storage';
import { type AccountCreationMetadata, CONSUME_CACHE_LUA, decodeCacheValue, type PasswordChangeExpectation, RedisAccountStorage } from './password-storage';
import { type DataMigrationReport, RedisDataStorage } from './redis-data-compat';
import {
  ContentStat,
  EpisodeSkipConfig,
  Favorite,
  IStorage,
  PlayRecord,
  PlayStatsResult,
  Reminder,
  UserPlayStat,
} from './types';

// 搜索历史最大条数
const SEARCH_HISTORY_LIMIT = 20;

// 数据类型转换辅助函数
function ensureString(value: any): string {
  return String(value);
}

function ensureStringArray(value: any[]): string[] {
  return value.map((item) => String(item));
}

// 添加Upstash Redis操作重试包装器
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (err: any) {
      const isLastAttempt = i === maxRetries - 1;
      const isConnectionError =
        err.message?.includes('Connection') ||
        err.message?.includes('ECONNREFUSED') ||
        err.message?.includes('ENOTFOUND') ||
        err.code === 'ECONNRESET' ||
        err.code === 'EPIPE' ||
        err.name === 'UpstashError';

      if (isConnectionError && !isLastAttempt) {
        console.log(
          `Upstash Redis operation failed, retrying... (${i + 1}/${maxRetries})`,
        );
        console.error('Error:', err.message);

        // 等待一段时间后重试
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }

      throw err;
    }
  }

  throw new Error('Max retries exceeded');
}

export class UpstashRedisStorage implements IStorage {
  private client: Redis;

  constructor() {
    this.client = getUpstashRedisClient();
  }

  getIdentityRegistry(): RedisIdentityRegistry {
    return new RedisIdentityRegistry({
      get: field => withRetry(() => this.client.hget(IDENTITY_REGISTRY_KEY, field)),
      all: () => withRetry(() => this.client.hgetall(IDENTITY_REGISTRY_KEY)),
      eval: (script, keys, args) => withRetry(() => this.client.eval(script, keys, args)),
    });
  }

  private get dataStorage(): RedisDataStorage {
    return new RedisDataStorage({
      hash: key => withRetry(() => this.client.hgetall(key)),
      getMany: keys => withRetry(() => this.client.mget(...keys)),
      scan: pattern => withRetry(() => this.client.keys(pattern)),
      eval: (script, keys, args) => withRetry(() => this.client.eval(script, keys, args)),
    });
  }

  // ---------- 播放记录与收藏：兼容旧扁平键和新 Hash ----------
  async getPlayRecord(userName: string, key: string): Promise<PlayRecord | null> {
    return this.dataStorage.get<PlayRecord>(userName, 'pr', key);
  }

  async setPlayRecord(userName: string, key: string, record: PlayRecord): Promise<void> {
    await this.dataStorage.set(userName, 'pr', key, record);
  }

  async getAllPlayRecords(userName: string): Promise<Record<string, PlayRecord>> {
    return this.dataStorage.getAll<PlayRecord>(userName, 'pr');
  }

  async deletePlayRecord(userName: string, key: string): Promise<void> {
    await this.dataStorage.delete(userName, 'pr', key);
  }

  async deleteAllPlayRecords(userName: string): Promise<void> {
    await this.dataStorage.deleteAll(userName, 'pr');
  }

  async getFavorite(userName: string, key: string): Promise<Favorite | null> {
    return this.dataStorage.get<Favorite>(userName, 'fav', key);
  }

  async setFavorite(userName: string, key: string, favorite: Favorite): Promise<void> {
    await this.dataStorage.set(userName, 'fav', key, favorite);
  }

  async getAllFavorites(userName: string): Promise<Record<string, Favorite>> {
    return this.dataStorage.getAll<Favorite>(userName, 'fav');
  }

  async deleteFavorite(userName: string, key: string): Promise<void> {
    await this.dataStorage.delete(userName, 'fav', key);
  }

  async deleteAllFavorites(userName: string): Promise<void> {
    await this.dataStorage.deleteAll(userName, 'fav');
  }

  // ---------- 提醒 ----------
  private reminderHashKey(user: string) {
    return `u:${user}:reminder`; // 一个用户的所有提醒存在一个 Hash 中
  }

  async getReminder(userName: string, key: string): Promise<Reminder | null> {
    const val = await withRetry(() =>
      this.client.hget(this.reminderHashKey(userName), key)
    );
    return val ? (val as Reminder) : null;
  }

  async setReminder(
    userName: string,
    key: string,
    reminder: Reminder
  ): Promise<void> {
    await withRetry(() =>
      this.client.hset(this.reminderHashKey(userName), { [key]: reminder })
    );
  }

  async getAllReminders(userName: string): Promise<Record<string, Reminder>> {
    const all = await withRetry(() =>
      this.client.hgetall(this.reminderHashKey(userName))
    );
    if (!all || Object.keys(all).length === 0) return {};
    const result: Record<string, Reminder> = {};
    for (const [field, value] of Object.entries(all)) {
      if (value) result[field] = value as Reminder;
    }
    return result;
  }

  async deleteReminder(userName: string, key: string): Promise<void> {
    await withRetry(() => this.client.hdel(this.reminderHashKey(userName), key));
  }

  async deleteAllReminders(userName: string): Promise<void> {
    await withRetry(() => this.client.del(this.reminderHashKey(userName)));
  }

  // ---------- 批量写入 ----------
  async setPlayRecordsBatch(userName: string, records: Record<string, PlayRecord>): Promise<void> {
    await this.dataStorage.setMany(userName, 'pr', records);
  }

  async setFavoritesBatch(userName: string, favorites: Record<string, Favorite>): Promise<void> {
    await this.dataStorage.setMany(userName, 'fav', favorites);
  }

  // ---------- 用户注册 / 登录 ----------
  private userPwdKey(user: string) { return `u:${user}:pwd`; }
  private userInfoKey(user: string) { return `u:${user}:info`; }
  private userListKey() { return 'users:list'; }
  private oidcSubKey(sub: string) { return `oidc:sub:${sub}`; }

  private get accountStorage(): RedisAccountStorage {
    return new RedisAccountStorage({
      get: key => withRetry(() => this.client.get(key)),
      getInfo: key => withRetry(() => this.client.hgetall(key)),
      scan: pattern => withRetry(() => this.client.keys(pattern)),
      list: key => withRetry(() => this.client.zrange(key, 0, -1)),
      eval: (script, keys, args) => withRetry(() => this.client.eval(script, keys, args)),
    });
  }

  async registerUser(userName: string, password: string, email?: string): Promise<void> {
    await this.accountStorage.registerUser(userName, password, email);
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    return this.accountStorage.verifyUser(userName, password);
  }

  async verifyUserV2(userName: string, password: string): Promise<boolean> {
    return this.verifyUser(userName, password);
  }

  async checkUserExist(userName: string): Promise<boolean> {
    return this.accountStorage.checkUserExist(userName);
  }

  async changePassword(userName: string, password: string, expected?: PasswordChangeExpectation): Promise<void> {
    await this.accountStorage.changePassword(userName, password, expected);
  }

  async getUserCredential(userName: string): Promise<string | null> {
    return this.accountStorage.getUserCredential(userName);
  }

  async restoreUserCredential(userName: string, credential: string): Promise<void> {
    await this.accountStorage.restoreUserCredential(userName, credential);
  }

  async getUserEmail(userName: string): Promise<string | null> {
    return this.accountStorage.getUserEmail(userName);
  }

  async setUserEmail(userName: string, email: string): Promise<void> {
    await this.accountStorage.setUserEmail(userName, email);
  }

  async getUsernameByEmail(email: string): Promise<string | null> {
    return this.accountStorage.getUsernameByEmail(email);
  }

  async createUserV2(userName: string, password: string, role: 'owner' | 'admin' | 'user' = 'user',
    tags?: string[], oidcSub?: string, enabledApis?: string[], email?: string,
    metadata?: AccountCreationMetadata): Promise<void> {
    await this.accountStorage.createUserV2(userName, password, role, tags, oidcSub, enabledApis, email, metadata);
  }

  async deleteUser(userName: string): Promise<void> {
    const relatedKeys = await this.dataStorage.relatedKeys(userName);
    await this.accountStorage.deleteIdentity(userName, relatedKeys);
  }

  // 获取用户信息（新版本）
  async getUserInfoV2(userName: string): Promise<{
    username: string;
    role: 'owner' | 'admin' | 'user';
    banned: boolean;
    tags?: string[];
    oidcSub?: string;
    enabledApis?: string[];
    createdAt?: number;
    email?: string;
    pending?: boolean;
    source?: string;
  } | null> {
    const userInfo = await withRetry(() =>
      this.client.hgetall(this.userInfoKey(userName)),
    );

    if (!userInfo || Object.keys(userInfo).length === 0) {
      return null;
    }

    // 安全解析 tags 字段
    let parsedTags: string[] | undefined;
    if (userInfo.tags) {
      try {
        const tagsStr = ensureString(userInfo.tags);
        // 如果 tags 已经是数组（某些情况），直接使用
        if (Array.isArray(userInfo.tags)) {
          parsedTags = userInfo.tags;
        } else {
          // 尝试 JSON 解析
          const parsed = JSON.parse(tagsStr);
          parsedTags = Array.isArray(parsed) ? parsed : [parsed];
        }
      } catch {
        // JSON 解析失败，可能是单个字符串值
        console.warn(`用户 ${userName} tags 解析失败，原始值:`, userInfo.tags);
        const tagsStr = ensureString(userInfo.tags);
        // 如果是逗号分隔的字符串
        if (tagsStr.includes(',')) {
          parsedTags = tagsStr.split(',').map((t) => t.trim());
        } else {
          parsedTags = [tagsStr];
        }
      }
    }

    // 安全解析 enabledApis 字段
    let parsedApis: string[] | undefined;
    if (userInfo.enabledApis) {
      try {
        const apisStr = ensureString(userInfo.enabledApis);
        if (Array.isArray(userInfo.enabledApis)) {
          parsedApis = userInfo.enabledApis;
        } else {
          const parsed = JSON.parse(apisStr);
          parsedApis = Array.isArray(parsed) ? parsed : [parsed];
        }
      } catch {
        console.warn(`用户 ${userName} enabledApis 解析失败`);
        const apisStr = ensureString(userInfo.enabledApis);
        if (apisStr.includes(',')) {
          parsedApis = apisStr.split(',').map((t) => t.trim());
        } else {
          parsedApis = [apisStr];
        }
      }
    }

    return {
      username: userName,
      role: (userInfo.role as 'owner' | 'admin' | 'user') || 'user',
      banned: String(userInfo.banned) === 'true',
      pending: String(userInfo.pending) === 'true',
      source: userInfo.source ? String(userInfo.source) : undefined,
      email: (await this.getUserEmail(userName)) ?? undefined,
      tags: parsedTags,
      oidcSub: userInfo.oidcSub ? ensureString(userInfo.oidcSub) : undefined,
      enabledApis: parsedApis,
      createdAt: userInfo.created_at
        ? parseInt(ensureString(userInfo.created_at), 10)
        : undefined,
    };
  }

  // 检查用户是否存在（新版本）
  async checkUserExistV2(userName: string): Promise<boolean> {
    return this.checkUserExist(userName);
  }

  // 通过OIDC Sub查找用户名
  async getUserByOidcSub(oidcSub: string): Promise<string | null> {
    return this.accountStorage.getUserByOidcSub(oidcSub);
  }

  // ---------- 搜索历史 ----------
  private shKey(user: string) {
    return `u:${user}:sh`; // u:username:sh
  }

  async getSearchHistory(userName: string): Promise<string[]> {
    const result = await withRetry(() =>
      this.client.lrange(this.shKey(userName), 0, -1),
    );
    // 确保返回的都是字符串类型
    return ensureStringArray(result as any[]);
  }

  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    const key = this.shKey(userName);
    // 先去重
    await withRetry(() => this.client.lrem(key, 0, ensureString(keyword)));
    // 插入到最前
    await withRetry(() => this.client.lpush(key, ensureString(keyword)));
    // 限制最大长度
    await withRetry(() => this.client.ltrim(key, 0, SEARCH_HISTORY_LIMIT - 1));
  }

  async deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    const key = this.shKey(userName);
    if (keyword) {
      await withRetry(() => this.client.lrem(key, 0, ensureString(keyword)));
    } else {
      await withRetry(() => this.client.del(key));
    }
  }

  // ---------- 获取全部用户 ----------
  async getAllUsers(): Promise<string[]> {
    return this.accountStorage.getAllUsers();
  }

  // ---------- 管理员配置 ----------
  private adminConfigKey() {
    return 'admin:config';
  }

  async getAdminConfig(): Promise<AdminConfig | null> {
    const val = await withRetry(() => this.client.get(this.adminConfigKey()));
    if (!val) return null;

    // 智能兼容：自动识别 JSON 字符串或对象
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch (e) {
        console.error('解析 AdminConfig JSON 失败:', e);
        return null;
      }
    }

    // 对象格式，直接返回
    return val as AdminConfig;
  }

  async setAdminConfig(config: AdminConfig): Promise<void> {
    // 智能保存：尝试 JSON 字符串，失败则用对象（兼容两种方式）
    try {
      const jsonStr = JSON.stringify(config);
      await withRetry(() => this.client.set(this.adminConfigKey(), jsonStr));
    } catch (e) {
      // JSON 序列化失败，回退到对象方式
      console.warn('[Upstash] JSON.stringify 失败，回退到对象方式:', e);
      await withRetry(() => this.client.set(this.adminConfigKey(), config));
    }
  }

  // ---------- 跳过配置：兼容两种键布局 ----------
  private skipField(source: string, id: string) {
    return `${source}+${id}`;
  }

  async getSkipConfig(userName: string, source: string, id: string): Promise<EpisodeSkipConfig | null> {
    return this.dataStorage.get<EpisodeSkipConfig>(userName, 'skip', this.skipField(source, id));
  }

  async setSkipConfig(userName: string, source: string, id: string, config: EpisodeSkipConfig): Promise<void> {
    await this.dataStorage.set(userName, 'skip', this.skipField(source, id), config);
  }

  async deleteSkipConfig(userName: string, source: string, id: string): Promise<void> {
    await this.dataStorage.delete(userName, 'skip', this.skipField(source, id));
  }

  async getAllSkipConfigs(userName: string): Promise<Record<string, EpisodeSkipConfig>> {
    return this.dataStorage.getAll<EpisodeSkipConfig>(userName, 'skip');
  }

  async getEpisodeSkipConfig(userName: string, source: string, id: string): Promise<EpisodeSkipConfig | null> {
    return this.dataStorage.get<EpisodeSkipConfig>(userName, 'episodeskip', this.skipField(source, id));
  }

  async saveEpisodeSkipConfig(userName: string, source: string, id: string, config: EpisodeSkipConfig): Promise<void> {
    await this.dataStorage.set(userName, 'episodeskip', this.skipField(source, id), config);
  }

  async deleteEpisodeSkipConfig(userName: string, source: string, id: string): Promise<void> {
    await this.dataStorage.delete(userName, 'episodeskip', this.skipField(source, id));
  }

  async getAllEpisodeSkipConfigs(userName: string): Promise<Record<string, EpisodeSkipConfig>> {
    return this.dataStorage.getAll<EpisodeSkipConfig>(userName, 'episodeskip');
  }

  // 清空所有数据
  async clearAllData(): Promise<void> {
    try {
      // 获取所有用户
      const allUsers = await this.getAllUsers();

      // 删除所有用户及其数据
      for (const username of allUsers) {
        await this.deleteUser(username);
      }

      // 删除管理员配置
      await withRetry(() => this.client.del(this.adminConfigKey()));

      console.log('所有数据已清空');
    } catch (error) {
      console.error('清空数据失败:', error);
      throw new Error('清空数据失败');
    }
  }

  // ---------- 通用缓存方法 ----------
  private cacheKey(key: string) {
    return `cache:${key}`;
  }

  async getCache(key: string): Promise<any | null> {
    try {
      const val = await withRetry(() => this.client.get(this.cacheKey(key)));
      if (val === null || val === undefined) return null;

      // 智能处理返回值：Upstash 可能返回字符串或已解析的对象
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch (parseError) {
          console.warn(`JSON解析失败，返回原字符串 (key: ${key}):`, parseError);
          return val; // 解析失败返回原字符串
        }
      } else {
        // Upstash 可能直接返回解析后的对象
        return val;
      }
    } catch (error) {
      console.error(`Upstash getCache error (key: ${key}):`, error);
      return null;
    }
  }

  async setCache(
    key: string,
    data: any,
    expireSeconds?: number,
  ): Promise<void> {
    const cacheKey = this.cacheKey(key);
    const value = JSON.stringify(data);

    if (expireSeconds) {
      await withRetry(() => this.client.setex(cacheKey, expireSeconds, value));
    } else {
      await withRetry(() => this.client.set(cacheKey, value));
    }
  }

  async consumeCache(key: string): Promise<any | null> {
    const value = await withRetry(() => this.client.eval(CONSUME_CACHE_LUA, [this.cacheKey(key)], []));
    return decodeCacheValue(value);
  }

  async deleteCache(key: string): Promise<void> {
    await withRetry(() => this.client.del(this.cacheKey(key)));
  }

  async clearExpiredCache(prefix?: string): Promise<void> {
    // Upstash 的 TTL 机制会自动清理过期数据
    // 仅在有明确前缀时做手动清理，避免全库 KEYS 扫描
    if (!prefix) return;
    const pattern = `cache:${prefix}*`;
    const keys = await withRetry(() => this.client.keys(pattern));
    if (keys.length > 0) {
      await withRetry(() => this.client.del(...keys));
      console.log(
        `Cleared ${keys.length} cache entries with pattern: ${pattern}`,
      );
    }
  }

  // Explicit, repeatable copy. Constructors never call this operation.
  // Existing canonical entries win, and every legacy key is retained.
  async migrateData(): Promise<DataMigrationReport> {
    return this.dataStorage.migrate(await this.getAllUsers());
  }

  // Bulk password rewrites are deliberately disabled. Only a successful login
  // can upgrade a legacy value without mistaking a digest for a raw password.
  async migratePasswords(): Promise<void> {}

  // ---------- 播放统计相关 ----------
  async getPlayStats(): Promise<PlayStatsResult> {
    try {
      // 尝试从缓存获取
      const cached = await this.getCache('play_stats_summary');
      if (cached) {
        return cached as PlayStatsResult;
      }

      // 重新计算统计数据
      const allUsers = await this.getAllUsers();
      const userStats: Array<{
        username: string;
        totalWatchTime: number;
        totalPlays: number;
        lastPlayTime: number;
        recentRecords: PlayRecord[];
        avgWatchTime: number;
        mostWatchedSource: string;
        registrationDays: number;
        lastLoginTime: number;
        loginCount: number;
        createdAt: number;
      }> = [];
      let totalWatchTime = 0;
      let totalPlays = 0;
      const sourceCount: Record<string, number> = {};
      const dailyData: Record<string, { watchTime: number; plays: number }> =
        {};

      // 用户注册统计
      const now = Date.now();
      const todayStart = new Date(now).setHours(0, 0, 0, 0);
      let todayNewUsers = 0;
      const registrationData: Record<string, number> = {};

      // 计算近7天的日期范围
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

      for (const username of allUsers) {
        const userStat = await this.getUserPlayStat(username);

        // 设置项目开始时间，2025年9月14日
        const PROJECT_START_DATE = new Date('2025-09-14').getTime();
        // 模拟用户创建时间（Upstash模式下通常没有这个信息，使用首次播放时间或项目开始时间）
        const userCreatedAt = userStat.firstWatchDate || PROJECT_START_DATE;
        const registrationDays =
          Math.floor((now - userCreatedAt) / (1000 * 60 * 60 * 24)) + 1;

        // 统计今日新增用户
        if (userCreatedAt >= todayStart) {
          todayNewUsers++;
        }

        // 统计注册时间分布（近7天）
        if (userCreatedAt >= sevenDaysAgo) {
          const regDate = new Date(userCreatedAt).toISOString().split('T')[0];
          registrationData[regDate] = (registrationData[regDate] || 0) + 1;
        }

        // 推断最后登录时间（基于最后播放时间）
        const lastLoginTime = userStat.lastPlayTime || userCreatedAt;

        const enhancedUserStat = {
          username: userStat.username,
          totalWatchTime: userStat.totalWatchTime,
          totalPlays: userStat.totalPlays,
          lastPlayTime: userStat.lastPlayTime,
          recentRecords: userStat.recentRecords,
          avgWatchTime: userStat.avgWatchTime,
          mostWatchedSource: userStat.mostWatchedSource,
          registrationDays,
          lastLoginTime,
          loginCount: userStat.loginCount || 0, // 添加登入次数字段
          createdAt: userCreatedAt,
        };

        userStats.push(enhancedUserStat);
        totalWatchTime += userStat.totalWatchTime;
        totalPlays += userStat.totalPlays;

        // 获取用户的播放记录来统计源和每日数据
        const records = await this.getAllPlayRecords(username);
        Object.values(records).forEach((record) => {
          const sourceName = record.source_name || '未知来源';
          sourceCount[sourceName] = (sourceCount[sourceName] || 0) + 1;

          const recordDate = new Date(record.save_time);
          if (recordDate.getTime() >= sevenDaysAgo) {
            const dateKey = recordDate.toISOString().split('T')[0];
            if (!dailyData[dateKey]) {
              dailyData[dateKey] = { watchTime: 0, plays: 0 };
            }
            dailyData[dateKey].watchTime += record.play_time || 0;
            dailyData[dateKey].plays += 1;
          }
        });
      }

      // 按观看时间降序排序
      userStats.sort((a, b) => b.totalWatchTime - a.totalWatchTime);

      // 整理热门来源数据
      const topSources = Object.entries(sourceCount)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([source, count]) => ({ source, count }));

      // 整理近7天数据
      const dailyStats: Array<{
        date: string;
        watchTime: number;
        plays: number;
      }> = [];
      for (let i = 6; i >= 0; i--) {
        const date = new Date(now - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];
        const data = dailyData[dateKey] || { watchTime: 0, plays: 0 };
        dailyStats.push({
          date: dateKey,
          watchTime: data.watchTime,
          plays: data.plays,
        });
      }

      // 计算注册趋势
      const registrationStats = [];
      for (let i = 6; i >= 0; i--) {
        const date = new Date(now - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];
        registrationStats.push({
          date: dateKey,
          newUsers: registrationData[dateKey] || 0,
        });
      }

      // 计算活跃用户统计
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

      const activeUsers = {
        daily: userStats.filter((user) => user.lastLoginTime >= oneDayAgo)
          .length,
        weekly: userStats.filter((user) => user.lastLoginTime >= sevenDaysAgo)
          .length,
        monthly: userStats.filter((user) => user.lastLoginTime >= thirtyDaysAgo)
          .length,
      };

      const result: PlayStatsResult = {
        totalUsers: allUsers.length,
        totalWatchTime,
        totalPlays,
        avgWatchTimePerUser:
          allUsers.length > 0 ? totalWatchTime / allUsers.length : 0,
        avgPlaysPerUser: allUsers.length > 0 ? totalPlays / allUsers.length : 0,
        userStats,
        topSources,
        dailyStats,
        // 新增：用户注册统计
        registrationStats: {
          todayNewUsers,
          totalRegisteredUsers: allUsers.length,
          registrationTrend: registrationStats,
        },
        // 新增：用户活跃度统计
        activeUsers,
      };

      // 缓存结果30分钟
      await this.setCache('play_stats_summary', result, 1800);
      return result;
    } catch (error) {
      console.error('获取播放统计失败:', error);
      return {
        totalUsers: 0,
        totalWatchTime: 0,
        totalPlays: 0,
        avgWatchTimePerUser: 0,
        avgPlaysPerUser: 0,
        userStats: [],
        topSources: [],
        dailyStats: [],
        // 新增：用户注册统计
        registrationStats: {
          todayNewUsers: 0,
          totalRegisteredUsers: 0,
          registrationTrend: [],
        },
        // 新增：用户活跃度统计
        activeUsers: {
          daily: 0,
          weekly: 0,
          monthly: 0,
        },
      };
    }
  }

  async getUserPlayStat(userName: string): Promise<UserPlayStat> {
    try {
      // 获取用户的所有播放记录
      const records = await this.getAllPlayRecords(userName);
      const playRecords = Object.values(records);

      if (playRecords.length === 0) {
        // 即使没有播放记录，也要获取登入统计
        let loginStats: {
          loginCount: number; firstLoginTime: number; lastLoginTime: number; lastLoginDate: number;
          lastLoginIp?: string; lastLoginLocation?: string; lastLoginDevice?: string;
          lastLoginBrowser?: string; lastLoginOs?: string;
        } = { loginCount: 0, firstLoginTime: 0, lastLoginTime: 0, lastLoginDate: 0 };

        try {
          const loginStatsKey = `user_login_stats:${userName}`;
          const storedLoginStats = await this.client.get<{
            loginCount?: number;
            firstLoginTime?: number;
            lastLoginTime?: number;
            lastLoginDate?: number;
            lastLoginIp?: string;
            lastLoginLocation?: string;
            lastLoginDevice?: string;
            lastLoginBrowser?: string;
            lastLoginOs?: string;
          }>(loginStatsKey);
          console.log(`[Upstash-NoRecords] 用户 ${userName} 登入统计查询:`, {
            key: loginStatsKey,
            rawValue: storedLoginStats,
            hasValue: !!storedLoginStats,
          });

          if (storedLoginStats) {
            loginStats = {
              loginCount: storedLoginStats.loginCount || 0,
              firstLoginTime: storedLoginStats.firstLoginTime || 0,
              lastLoginTime: storedLoginStats.lastLoginTime || 0,
              lastLoginDate: storedLoginStats.lastLoginDate || storedLoginStats.lastLoginTime || 0,
              lastLoginIp: storedLoginStats.lastLoginIp,
              lastLoginLocation: storedLoginStats.lastLoginLocation,
              lastLoginDevice: storedLoginStats.lastLoginDevice,
              lastLoginBrowser: storedLoginStats.lastLoginBrowser,
              lastLoginOs: storedLoginStats.lastLoginOs,
            };
            console.log(`[Upstash-NoRecords] 解析后的登入统计:`, loginStats);
          } else {
            console.log(
              `[Upstash-NoRecords] 用户 ${userName} 没有登入统计数据`,
            );
          }
        } catch (error) {
          console.error(`获取用户 ${userName} 登入统计失败:`, error);
        }

        return {
          username: userName,
          totalWatchTime: 0,
          totalPlays: 0,
          lastPlayTime: 0,
          recentRecords: [],
          avgWatchTime: 0,
          mostWatchedSource: '',
          // 新增字段
          totalMovies: 0,
          firstWatchDate: Date.now(),
          lastUpdateTime: Date.now(),
          // 登入统计字段
          loginCount: loginStats.loginCount,
          firstLoginTime: loginStats.firstLoginTime,
          lastLoginTime: loginStats.lastLoginTime,
          lastLoginDate: loginStats.lastLoginDate,
          lastLoginIp: loginStats.lastLoginIp,
          lastLoginLocation: loginStats.lastLoginLocation,
          lastLoginDevice: loginStats.lastLoginDevice,
          lastLoginBrowser: loginStats.lastLoginBrowser,
          lastLoginOs: loginStats.lastLoginOs,
        };
      }

      // 计算统计
      let totalWatchTime = 0;
      let lastPlayTime = 0;
      const sourceCount: Record<string, number> = {};

      playRecords.forEach((record) => {
        totalWatchTime += record.play_time || 0;
        if (record.save_time > lastPlayTime) {
          lastPlayTime = record.save_time;
        }
        const sourceName = record.source_name || '未知来源';
        sourceCount[sourceName] = (sourceCount[sourceName] || 0) + 1;
      });

      // 计算观看影片总数（去重）
      const totalMovies = new Set(
        playRecords.map((r) => `${r.title}_${r.source_name}_${r.year}`),
      ).size;

      // 计算首次观看时间
      const firstWatchDate = Math.min(
        ...playRecords.map((r) => r.save_time || Date.now()),
      );

      // 获取最近播放记录
      const recentRecords = playRecords
        .sort((a, b) => (b.save_time || 0) - (a.save_time || 0))
        .slice(0, 10);

      // 找出最常观看的来源
      let mostWatchedSource = '';
      let maxCount = 0;
      for (const [source, count] of Object.entries(sourceCount)) {
        if (count > maxCount) {
          maxCount = count;
          mostWatchedSource = source;
        }
      }

      // 获取登入统计数据
      let loginStats: {
        loginCount: number; firstLoginTime: number; lastLoginTime: number; lastLoginDate: number;
        lastLoginIp?: string; lastLoginLocation?: string; lastLoginDevice?: string;
        lastLoginBrowser?: string; lastLoginOs?: string;
      } = { loginCount: 0, firstLoginTime: 0, lastLoginTime: 0, lastLoginDate: 0 };

      try {
        const loginStatsKey = `user_login_stats:${userName}`;
        const storedLoginStats = await this.client.get<{
          loginCount?: number;
          firstLoginTime?: number;
          lastLoginTime?: number;
          lastLoginDate?: number;
          lastLoginIp?: string;
          lastLoginLocation?: string;
          lastLoginDevice?: string;
          lastLoginBrowser?: string;
          lastLoginOs?: string;
        }>(loginStatsKey);
        console.log(`[Upstash] 用户 ${userName} 登入统计查询:`, {
          key: loginStatsKey,
          rawValue: storedLoginStats,
          hasValue: !!storedLoginStats,
        });

        if (storedLoginStats) {
          loginStats = {
            loginCount: storedLoginStats.loginCount || 0,
            firstLoginTime: storedLoginStats.firstLoginTime || 0,
            lastLoginTime: storedLoginStats.lastLoginTime || 0,
            lastLoginDate: storedLoginStats.lastLoginDate || storedLoginStats.lastLoginTime || 0,
            lastLoginIp: storedLoginStats.lastLoginIp,
            lastLoginLocation: storedLoginStats.lastLoginLocation,
            lastLoginDevice: storedLoginStats.lastLoginDevice,
            lastLoginBrowser: storedLoginStats.lastLoginBrowser,
            lastLoginOs: storedLoginStats.lastLoginOs,
          };
          console.log(`[Upstash] 解析后的登入统计:`, loginStats);
        } else {
          console.log(`[Upstash] 用户 ${userName} 没有登入统计数据`);
        }
      } catch (error) {
        console.error(`获取用户 ${userName} 登入统计失败:`, error);
      }

      return {
        username: userName,
        totalWatchTime,
        totalPlays: playRecords.length,
        lastPlayTime,
        recentRecords,
        avgWatchTime:
          playRecords.length > 0 ? totalWatchTime / playRecords.length : 0,
        mostWatchedSource,
        // 新增字段
        totalMovies,
        firstWatchDate,
        lastUpdateTime: Date.now(),
        // 登入统计字段
        loginCount: loginStats.loginCount,
        firstLoginTime: loginStats.firstLoginTime,
        lastLoginTime: loginStats.lastLoginTime,
        lastLoginDate: loginStats.lastLoginDate,
        lastLoginIp: loginStats.lastLoginIp,
        lastLoginLocation: loginStats.lastLoginLocation,
        lastLoginDevice: loginStats.lastLoginDevice,
        lastLoginBrowser: loginStats.lastLoginBrowser,
        lastLoginOs: loginStats.lastLoginOs,
      };
    } catch (error) {
      console.error(`获取用户 ${userName} 统计失败:`, error);
      return {
        username: userName,
        totalWatchTime: 0,
        totalPlays: 0,
        lastPlayTime: 0,
        recentRecords: [],
        avgWatchTime: 0,
        mostWatchedSource: '',
        // 新增字段
        totalMovies: 0,
        firstWatchDate: Date.now(),
        lastUpdateTime: Date.now(),
        // 登入统计字段（错误时使用默认值）
        loginCount: 0,
        firstLoginTime: 0,
        lastLoginTime: 0,
        lastLoginDate: 0,
      };
    }
  }

  async getContentStats(limit = 10): Promise<ContentStat[]> {
    try {
      // 获取所有用户的播放记录
      const allUsers = await this.getAllUsers();
      const contentStats: Record<
        string,
        {
          source: string;
          id: string;
          title: string;
          source_name: string;
          cover: string;
          year: string;
          playCount: number;
          totalWatchTime: number;
          uniqueUsers: Set<string>;
          lastPlayed: number;
        }
      > = {};

      for (const username of allUsers) {
        const records = await this.getAllPlayRecords(username);
        Object.entries(records).forEach(([key, record]) => {
          if (!contentStats[key]) {
            // 从key中解析source和id
            const [source, id] = key.split('+', 2);
            contentStats[key] = {
              source: source || '',
              id: id || '',
              title: record.title || '未知标题',
              source_name: record.source_name || '未知来源',
              cover: record.cover || '',
              year: record.year || '',
              playCount: 0,
              totalWatchTime: 0,
              uniqueUsers: new Set(),
              lastPlayed: 0,
            };
          }

          const stat = contentStats[key];
          stat.playCount += 1;
          stat.totalWatchTime += record.play_time || 0;
          stat.uniqueUsers.add(username);
          if (record.save_time > stat.lastPlayed) {
            stat.lastPlayed = record.save_time;
          }
        });
      }

      // 转换 Set 为数量并排序
      const result = Object.values(contentStats)
        .map((stat) => ({
          source: stat.source,
          id: stat.id,
          title: stat.title,
          source_name: stat.source_name,
          cover: stat.cover,
          year: stat.year,
          playCount: stat.playCount,
          totalWatchTime: stat.totalWatchTime,
          averageWatchTime:
            stat.playCount > 0 ? stat.totalWatchTime / stat.playCount : 0,
          lastPlayed: stat.lastPlayed,
          uniqueUsers: stat.uniqueUsers.size,
        }))
        .sort((a, b) => b.playCount - a.playCount)
        .slice(0, limit);

      return result;
    } catch (error) {
      console.error('获取内容统计失败:', error);
      return [];
    }
  }

  async updatePlayStatistics(
    _userName: string,
    _source: string,
    _id: string,
    _watchTime: number,
  ): Promise<void> {
    try {
      // 清除全站统计缓存，下次查询时重新计算
      await this.deleteCache('play_stats_summary');
    } catch (error) {
      console.error('更新播放统计失败:', error);
    }
  }

  // 更新用户登入统计
  async updateUserLoginStats(
    userName: string,
    loginTime: number,
    isFirstLogin?: boolean,
    loginMeta?: { ip?: string; location?: string; device?: string; browser?: string; os?: string }
  ): Promise<void> {
    try {
      const loginStatsKey = `user_login_stats:${userName}`;

      const currentStats = await this.client.get<{
        loginCount?: number;
        firstLoginTime?: number | null;
        lastLoginTime?: number | null;
        lastLoginDate?: number | null;
        lastLoginIp?: string;
        lastLoginLocation?: string;
        lastLoginDevice?: string;
        lastLoginBrowser?: string;
        lastLoginOs?: string;
      }>(loginStatsKey);
      const loginStats = currentStats || {
        loginCount: 0,
        firstLoginTime: null,
        lastLoginTime: null,
        lastLoginDate: null,
      };

      loginStats.loginCount = (loginStats.loginCount || 0) + 1;
      loginStats.lastLoginTime = loginTime;
      loginStats.lastLoginDate = loginTime;

      if (isFirstLogin || !loginStats.firstLoginTime) {
        loginStats.firstLoginTime = loginTime;
      }

      if (loginMeta) {
        if (loginMeta.ip) loginStats.lastLoginIp = loginMeta.ip;
        if (loginMeta.location) loginStats.lastLoginLocation = loginMeta.location;
        if (loginMeta.device) loginStats.lastLoginDevice = loginMeta.device;
        if (loginMeta.browser) loginStats.lastLoginBrowser = loginMeta.browser;
        if (loginMeta.os) loginStats.lastLoginOs = loginMeta.os;
      }

      await this.client.set(loginStatsKey, loginStats);

      console.log(`用户 ${userName} 登入统计已更新:`, loginStats);
    } catch (error) {
      console.error(`更新用户 ${userName} 登入统计失败:`, error);
      throw error;
    }
  }

  // ---------- 用户 Emby 配置 ----------
  async getUserEmbyConfig(userName: string): Promise<any | null> {
    try {
      const key = `u:${userName}:emby-config`;
      const data = await withRetry(() => this.client.get(key));
      return data || null;
    } catch (error) {
      console.error(`获取用户 ${userName} Emby 配置失败:`, error);
      return null;
    }
  }

  async saveUserEmbyConfig(userName: string, config: any): Promise<void> {
    try {
      const key = `u:${userName}:emby-config`;
      await withRetry(() => this.client.set(key, config));
      console.log(`用户 ${userName} Emby 配置已保存`);
    } catch (error) {
      console.error(`保存用户 ${userName} Emby 配置失败:`, error);
      throw error;
    }
  }

  async deleteUserEmbyConfig(userName: string): Promise<void> {
    try {
      const key = `u:${userName}:emby-config`;
      await withRetry(() => this.client.del(key));
      console.log(`用户 ${userName} Emby 配置已删除`);
    } catch (error) {
      console.error(`删除用户 ${userName} Emby 配置失败:`, error);
      throw error;
    }
  }

  // 崩溃日志相关
  async saveCrashLog(crashLog: any): Promise<void> {
    try {
      const key = `crash-log:${crashLog.timestamp}`;
      // 保存崩溃日志，设置 7 天 TTL (604800 秒)
      await withRetry(() => this.client.set(key, JSON.stringify(crashLog), { ex: 604800 }));
      console.log(`崩溃日志已保存: ${crashLog.timestamp}`);
    } catch (error) {
      console.error('保存崩溃日志失败:', error);
      throw error;
    }
  }

  async getCrashLogs(limit: number = 50): Promise<any[]> {
    try {
      // 获取所有崩溃日志的 key
      const keys = await withRetry(() => this.client.keys('crash-log:*'));

      if (keys.length === 0) {
        return [];
      }

      // 批量获取崩溃日志
      const logs = await withRetry(() => this.client.mget(...keys));

      // 解析并排序（按时间戳降序）
      const parsedLogs = logs
        .filter((log): log is string => log !== null)
        .map((log) => JSON.parse(log))
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit);

      return parsedLogs;
    } catch (error) {
      console.error('获取崩溃日志失败:', error);
      throw error;
    }
  }

  async deleteCrashLog(timestamp: string): Promise<void> {
    try {
      const key = `crash-log:${timestamp}`;
      await withRetry(() => this.client.del(key));
      console.log(`崩溃日志已删除: ${timestamp}`);
    } catch (error) {
      console.error('删除崩溃日志失败:', error);
      throw error;
    }
  }

  async clearCrashLogs(): Promise<void> {
    try {
      const keys = await withRetry(() => this.client.keys('crash-log:*'));

      if (keys.length > 0) {
        await withRetry(() => this.client.del(...keys));
        console.log(`已清除 ${keys.length} 条崩溃日志`);
      }
    } catch (error) {
      console.error('清除崩溃日志失败:', error);
      throw error;
    }
  }
}

// 单例 Upstash Redis 客户端
function getUpstashRedisClient(): Redis {
  const globalKey = Symbol.for('__MOONTV_UPSTASH_REDIS_CLIENT__');
  let client: Redis | undefined = (global as any)[globalKey];

  if (!client) {
    const upstashUrl = process.env.UPSTASH_URL;
    const upstashToken = process.env.UPSTASH_TOKEN;

    if (!upstashUrl || !upstashToken) {
      throw new Error(
        'UPSTASH_URL and UPSTASH_TOKEN env variables must be set',
      );
    }

    // 创建 Upstash Redis 客户端
    client = new Redis({
      url: upstashUrl,
      token: upstashToken,
      // 启用 auto-pipelining 减少 HTTP 往返延迟
      enableAutoPipelining: true,
      // 可选配置
      retry: {
        retries: 3,
        backoff: (retryCount: number) =>
          Math.min(1000 * Math.pow(2, retryCount), 30000),
      },
    });

    console.log('Upstash Redis client created successfully');

    (global as any)[globalKey] = client;
  }

  return client;
}
