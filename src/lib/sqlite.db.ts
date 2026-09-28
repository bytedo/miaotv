/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

// Resolve the optional built-in at runtime. Turbopack cannot bundle a CommonJS
// require('node:sqlite'); other storage backends must not load SQLite at all.

type DatabaseSync = any;

import { AdminConfig } from './admin.types';
import { SqliteIdentityRegistry } from './identity-storage';
import {
  credentialForRestore,
  encodeStoredCredential,
  hashPassword,
  type PasswordSnapshot,
  verifyAndUpgradePassword,
} from './password';
import {
  type AccountCreationMetadata,
  AccountStateChangedError,
  assertExpectedAccountState,
  decodeCacheValue,
  normalizeUserEmail,
  type PasswordChangeExpectation,
} from './password-storage';
import {
  ContentStat,
  CrashLog,
  EpisodeSkipConfig,
  Favorite,
  IStorage,
  PlayRecord,
  PlayStatsResult,
  Reminder,
  UserPlayStat,
} from './types';

const SEARCH_HISTORY_LIMIT = 20;
const CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 60 分钟

export class SqliteStorage implements IStorage {
  private db!: DatabaseSync;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const sqlite = process.getBuiltinModule?.('node:sqlite') as
      | { DatabaseSync: new (path: string) => DatabaseSync }
      | undefined;
    if (!sqlite?.DatabaseSync) {
      throw new Error(
        'SQLite storage requires a Node.js runtime with node:sqlite support.',
      );
    }
    const { DatabaseSync } = sqlite;

    const isBuild = process.env.IS_BUILD_PHASE === 'true';

    if (isBuild) {
      this.db = new DatabaseSync(':memory:');
      this.initTables();
      return;
    }

    const dbPath =
      process.env.SQLITE_DB_PATH ||
      path.join(process.cwd(), 'data', 'lunatv.db');
    const dbDir = path.dirname(dbPath);

    // 自动创建数据库目录
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    console.log(`[SQLite] 正在打开数据库: ${dbPath}`);
    try {
      this.db = new DatabaseSync(dbPath);

      // WAL 模式 — 提升并发读性能
      this.db.exec('PRAGMA journal_mode = WAL');

      this.initTables();

      // 定时清理过期缓存
      this.cleanupTimer = setInterval(() => {
        this.clearExpiredCache().catch((err) => {
          console.error('[SQLite] 缓存清理出错:', err);
        });
      }, CACHE_CLEANUP_INTERVAL_MS);
    } catch (err) {
      console.error(`[SQLite] 打开数据库失败:`, err);
      throw err;
    }

    // 进程退出时关闭数据库
    process.once('exit', () => this.close());
  }

  // ==================== 初始化 & 关闭 ====================

  getIdentityRegistry(): SqliteIdentityRegistry {
    return new SqliteIdentityRegistry(this.db);
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_identity_registry (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_emails (
        username TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS users_v2 (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        banned INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        tags TEXT,
        enabled_apis TEXT,
        oidc_sub TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_v2_oidc_sub ON users_v2(oidc_sub);

      CREATE TABLE IF NOT EXISTS play_records (
        username TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (username, key)
      );

      CREATE TABLE IF NOT EXISTS favorites (
        username TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (username, key)
      );

      CREATE TABLE IF NOT EXISTS reminders (
        username TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (username, key)
      );

      CREATE TABLE IF NOT EXISTS search_history (
        username TEXT NOT NULL,
        keyword TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (username, keyword)
      );

      CREATE TABLE IF NOT EXISTS skip_configs (
        username TEXT NOT NULL,
        source TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (username, source, id)
      );

      CREATE TABLE IF NOT EXISTS episode_skip_configs (
        username TEXT NOT NULL,
        source TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (username, source, id)
      );

      CREATE TABLE IF NOT EXISTS admin_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS login_stats (
        username TEXT PRIMARY KEY,
        login_count INTEGER NOT NULL DEFAULT 0,
        first_login_time INTEGER,
        last_login_time INTEGER,
        last_login_date INTEGER,
        last_login_ip TEXT,
        last_login_location TEXT,
        last_login_device TEXT,
        last_login_browser TEXT,
        last_login_os TEXT
      );

      CREATE TABLE IF NOT EXISTS emby_configs (
        username TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crash_logs (
        timestamp TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // Account schema additions preserve all existing rows and credentials.
    this.accountTransaction(() => {
      const columns = this.db
        .prepare('PRAGMA table_info(users_v2)')
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'pending')) {
        this.db.exec(
          'ALTER TABLE users_v2 ADD COLUMN pending INTEGER NOT NULL DEFAULT 0',
        );
      }
      if (!columns.some((column) => column.name === 'source')) {
        this.db.exec('ALTER TABLE users_v2 ADD COLUMN source TEXT');
      }
    });
    console.log('[SQLite] 数据表初始化完成');
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    try {
      this.db.close();
      console.log('[SQLite] 数据库已关闭');
    } catch {
      // 忽略关闭错误
    }
  }

  // ==================== 播放记录 ====================

  async getPlayRecord(
    userName: string,
    key: string,
  ): Promise<PlayRecord | null> {
    const row = this.db
      .prepare('SELECT value FROM play_records WHERE username = ? AND key = ?')
      .get(userName, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as PlayRecord) : null;
  }

  async setPlayRecord(
    userName: string,
    key: string,
    record: PlayRecord,
  ): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO play_records (username, key, value) VALUES (?, ?, ?)',
      )
      .run(userName, key, JSON.stringify(record));
  }

  async getAllPlayRecords(
    userName: string,
  ): Promise<Record<string, PlayRecord>> {
    const rows = this.db
      .prepare('SELECT key, value FROM play_records WHERE username = ?')
      .all(userName) as Array<{ key: string; value: string }>;
    const result: Record<string, PlayRecord> = {};
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value) as PlayRecord;
    }
    return result;
  }

  async deletePlayRecord(userName: string, key: string): Promise<void> {
    this.db
      .prepare('DELETE FROM play_records WHERE username = ? AND key = ?')
      .run(userName, key);
  }

  async setPlayRecordsBatch(
    userName: string,
    records: Record<string, PlayRecord>,
  ): Promise<void> {
    const entries = Object.entries(records);
    if (entries.length === 0) return;

    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO play_records (username, key, value) VALUES (?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const [key, record] of entries) {
        insert.run(userName, key, JSON.stringify(record));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ==================== 收藏 ====================

  async getFavorite(userName: string, key: string): Promise<Favorite | null> {
    const row = this.db
      .prepare('SELECT value FROM favorites WHERE username = ? AND key = ?')
      .get(userName, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Favorite) : null;
  }

  async setFavorite(
    userName: string,
    key: string,
    favorite: Favorite,
  ): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO favorites (username, key, value) VALUES (?, ?, ?)',
      )
      .run(userName, key, JSON.stringify(favorite));
  }

  async getAllFavorites(userName: string): Promise<Record<string, Favorite>> {
    const rows = this.db
      .prepare('SELECT key, value FROM favorites WHERE username = ?')
      .all(userName) as Array<{ key: string; value: string }>;
    const result: Record<string, Favorite> = {};
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value) as Favorite;
    }
    return result;
  }

  async deleteFavorite(userName: string, key: string): Promise<void> {
    this.db
      .prepare('DELETE FROM favorites WHERE username = ? AND key = ?')
      .run(userName, key);
  }

  async setFavoritesBatch(
    userName: string,
    favorites: Record<string, Favorite>,
  ): Promise<void> {
    const entries = Object.entries(favorites);
    if (entries.length === 0) return;

    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO favorites (username, key, value) VALUES (?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const [key, fav] of entries) {
        insert.run(userName, key, JSON.stringify(fav));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ==================== 提醒 ====================

  async getReminder(userName: string, key: string): Promise<Reminder | null> {
    const row = this.db
      .prepare('SELECT value FROM reminders WHERE username = ? AND key = ?')
      .get(userName, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Reminder) : null;
  }

  async setReminder(
    userName: string,
    key: string,
    reminder: Reminder,
  ): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO reminders (username, key, value) VALUES (?, ?, ?)',
      )
      .run(userName, key, JSON.stringify(reminder));
  }

  async getAllReminders(userName: string): Promise<Record<string, Reminder>> {
    const rows = this.db
      .prepare('SELECT key, value FROM reminders WHERE username = ?')
      .all(userName) as Array<{ key: string; value: string }>;
    const result: Record<string, Reminder> = {};
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value) as Reminder;
    }
    return result;
  }

  async deleteReminder(userName: string, key: string): Promise<void> {
    this.db
      .prepare('DELETE FROM reminders WHERE username = ? AND key = ?')
      .run(userName, key);
  }

  // ==================== 用户账号：一个凭据来源 ====================

  private accountTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private accountExists(userName: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM users WHERE username = ? UNION ALL SELECT 1 FROM users_v2 WHERE username = ? LIMIT 1',
      )
      .get(userName, userName);
  }

  private accountSnapshot(userName: string): PasswordSnapshot {
    const row = this.db
      .prepare(
        'SELECT (SELECT password_hash FROM users WHERE username = ?) AS current, (SELECT password FROM users_v2 WHERE username = ?) AS legacy',
      )
      .get(userName, userName) as PasswordSnapshot;
    return { current: row.current ?? null, legacy: row.legacy || null };
  }

  private setCanonicalCredential(userName: string, credential: string): void {
    this.db
      .prepare(
        'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, COALESCE((SELECT created_at FROM users_v2 WHERE username = ?), ?)) ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash',
      )
      .run(userName, credential, userName, Date.now());
    // The existing column is NOT NULL; empty disables its legacy credential.
    this.db
      .prepare("UPDATE users_v2 SET password = '' WHERE username = ?")
      .run(userName);
  }

  private saveAccountEmail(userName: string, email: string): void {
    if (!email) {
      this.db
        .prepare('DELETE FROM user_emails WHERE username = ?')
        .run(userName);
      return;
    }
    const owner = this.findAccountByEmail(email);
    if (owner && owner !== userName) throw new Error('该邮箱已被其他账号关联');
    this.db
      .prepare(
        'INSERT INTO user_emails (username, email) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET email = excluded.email',
      )
      .run(userName, email);
  }

  async registerUser(
    userName: string,
    password: string,
    email?: string,
  ): Promise<void> {
    const credential = hashPassword(password);
    const normalized = normalizeUserEmail(email ?? '');
    this.accountTransaction(() => {
      if (this.accountExists(userName)) throw new Error('该用户名已被注册');
      this.db
        .prepare('DELETE FROM user_emails WHERE username = ?')
        .run(userName);
      this.db
        .prepare(
          'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)',
        )
        .run(userName, credential, Date.now());
      if (normalized) this.saveAccountEmail(userName, normalized);
    });
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    return verifyAndUpgradePassword(
      password,
      async () => this.accountSnapshot(userName),
      async (snapshot, credential) =>
        this.accountTransaction(() => {
          const current = this.accountSnapshot(userName);
          if (
            current.current !== snapshot.current ||
            current.legacy !== snapshot.legacy
          )
            return false;
          if (current.current === null && current.legacy === null) return false;
          this.setCanonicalCredential(userName, credential);
          return true;
        }),
    );
  }

  async verifyUserV2(userName: string, password: string): Promise<boolean> {
    return this.verifyUser(userName, password);
  }

  async checkUserExist(userName: string): Promise<boolean> {
    return this.accountExists(userName);
  }

  async checkUserExistV2(userName: string): Promise<boolean> {
    return this.checkUserExist(userName);
  }

  async getUserCredential(userName: string): Promise<string | null> {
    const snapshot = this.accountSnapshot(userName);
    const stored = snapshot.current ?? snapshot.legacy;
    return stored === null || stored === ''
      ? null
      : encodeStoredCredential(stored);
  }

  async restoreUserCredential(
    userName: string,
    encodedCredential: string,
  ): Promise<void> {
    const credential = credentialForRestore(encodedCredential);
    this.accountTransaction(() => {
      if (!this.accountExists(userName)) throw new Error('用户不存在');
      this.setCanonicalCredential(userName, credential);
    });
  }

  async changePassword(
    userName: string,
    newPassword: string,
    expected?: PasswordChangeExpectation,
  ): Promise<void> {
    if (expected === undefined) {
      await this.restoreUserCredential(userName, hashPassword(newPassword));
      return;
    }
    const credential = hashPassword(newPassword);
    this.accountTransaction(() => {
      if (!this.accountExists(userName)) throw new AccountStateChangedError();
      const snapshot = this.accountSnapshot(userName);
      const email = this.db
        .prepare('SELECT email FROM user_emails WHERE username = ?')
        .get(userName) as { email: string } | undefined;
      assertExpectedAccountState(
        { ...snapshot, email: email?.email ?? null },
        expected,
      );
      this.setCanonicalCredential(userName, credential);
    });
  }

  async getUserEmail(userName: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT email FROM user_emails WHERE username = ?')
      .get(userName) as { email: string } | undefined;
    return row?.email.trim().toLowerCase() || null;
  }

  async setUserEmail(userName: string, email: string): Promise<void> {
    const normalized = normalizeUserEmail(email);
    this.accountTransaction(() => {
      if (!this.accountExists(userName)) throw new Error('用户不存在');
      this.saveAccountEmail(userName, normalized);
    });
  }

  async getUsernameByEmail(email: string): Promise<string | null> {
    const normalized = normalizeUserEmail(email);
    if (!normalized) return null;
    return this.findAccountByEmail(normalized);
  }

  private findAccountByEmail(normalized: string): string | null {
    const rows = this.db
      .prepare('SELECT username, email FROM user_emails')
      .all() as Array<{ username: string; email: string }>;
    let owner: string | null = null;
    for (const row of rows) {
      if (
        row.email.trim().toLowerCase() !== normalized ||
        !this.accountExists(row.username)
      )
        continue;
      if (owner && owner !== row.username)
        throw new Error('该邮箱关联多个账号，请联系管理员');
      owner = row.username;
    }
    return owner;
  }

  async createUserV2(
    userName: string,
    password: string,
    role: 'owner' | 'admin' | 'user' = 'user',
    tags?: string[],
    oidcSub?: string,
    enabledApis?: string[],
    email?: string,
    metadata?: AccountCreationMetadata,
  ): Promise<void> {
    const credential = hashPassword(password);
    const normalized = normalizeUserEmail(email ?? '');
    const sub =
      oidcSub === undefined || oidcSub === '' ? null : String(oidcSub);
    const createdAt = metadata?.createdAt ?? Date.now();
    if (!Number.isFinite(createdAt) || createdAt < 0)
      throw new Error('账号创建时间无效');
    this.accountTransaction(() => {
      if (this.accountExists(userName)) throw new Error('该用户名已被注册');
      if (
        sub &&
        this.db
          .prepare('SELECT 1 FROM users_v2 WHERE oidc_sub = ? LIMIT 1')
          .get(sub)
      ) {
        throw new Error('该 OIDC 身份已绑定其他账号');
      }
      this.db
        .prepare('DELETE FROM user_emails WHERE username = ?')
        .run(userName);
      this.db
        .prepare(
          'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)',
        )
        .run(userName, credential, createdAt);
      this.db
        .prepare(
          "INSERT INTO users_v2 (username, password, role, banned, pending, source, tags, enabled_apis, oidc_sub, created_at) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          userName,
          role,
          metadata?.banned === true ? 1 : 0,
          metadata?.pending === true ? 1 : 0,
          metadata?.source ?? null,
          tags?.length ? JSON.stringify(tags) : null,
          enabledApis?.length ? JSON.stringify(enabledApis) : null,
          sub,
          createdAt,
        );
      if (normalized) this.saveAccountEmail(userName, normalized);
    });
  }

  async deleteUser(userName: string): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM user_emails WHERE username = ?')
        .run(userName);
      // V1 用户
      this.db.prepare('DELETE FROM users WHERE username = ?').run(userName);
      // V2 用户
      this.db.prepare('DELETE FROM users_v2 WHERE username = ?').run(userName);
      // 关联数据
      this.db
        .prepare('DELETE FROM play_records WHERE username = ?')
        .run(userName);
      this.db.prepare('DELETE FROM favorites WHERE username = ?').run(userName);
      this.db.prepare('DELETE FROM reminders WHERE username = ?').run(userName);
      this.db
        .prepare('DELETE FROM search_history WHERE username = ?')
        .run(userName);
      this.db
        .prepare('DELETE FROM skip_configs WHERE username = ?')
        .run(userName);
      this.db
        .prepare('DELETE FROM episode_skip_configs WHERE username = ?')
        .run(userName);
      this.db
        .prepare('DELETE FROM login_stats WHERE username = ?')
        .run(userName);
      this.db
        .prepare('DELETE FROM emby_configs WHERE username = ?')
        .run(userName);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async getUserInfoV2(userName: string): Promise<{
    username: string;
    role: 'owner' | 'admin' | 'user';
    tags?: string[];
    enabledApis?: string[];
    banned?: boolean;
    createdAt?: number;
    oidcSub?: string;
    email?: string;
    pending?: boolean;
    source?: string;
  } | null> {
    const row = this.db
      .prepare('SELECT * FROM users_v2 WHERE username = ?')
      .get(userName) as
      | {
          username: string;
          password: string;
          role: string;
          banned: number;
          pending: number;
          source: string | null;
          tags: string | null;
          enabled_apis: string | null;
          oidc_sub: string | null;
          created_at: number;
        }
      | undefined;

    if (!row) return null;

    const parseJsonArray = (val: string | null): string[] | undefined => {
      if (!val) return undefined;
      try {
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return val
          .split(',')
          .map((t: string) => t.trim())
          .filter(Boolean);
      }
    };

    return {
      username: row.username,
      role: (row.role as 'owner' | 'admin' | 'user') || 'user',
      banned: row.banned === 1,
      pending: row.pending === 1,
      source: row.source ?? undefined,
      email: (await this.getUserEmail(userName)) ?? undefined,
      tags: parseJsonArray(row.tags),
      enabledApis: parseJsonArray(row.enabled_apis),
      oidcSub: row.oidc_sub || undefined,
      createdAt: row.created_at,
    };
  }

  async getUserByOidcSub(oidcSub: string): Promise<string | null> {
    const rows = this.db
      .prepare('SELECT username FROM users_v2 WHERE oidc_sub = ? LIMIT 2')
      .all(oidcSub) as Array<{ username: string }>;
    if (rows.length > 1)
      throw new Error('该 OIDC 身份关联多个账号，请联系管理员');
    return rows[0]?.username ?? null;
  }

  // ==================== 搜索历史 ====================

  async getSearchHistory(userName: string): Promise<string[]> {
    const rows = this.db
      .prepare(
        'SELECT keyword FROM search_history WHERE username = ? ORDER BY created_at DESC',
      )
      .all(userName) as Array<{ keyword: string }>;
    return rows.map((r) => r.keyword);
  }

  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    this.db.exec('BEGIN');
    try {
      // 去重
      this.db
        .prepare(
          'DELETE FROM search_history WHERE username = ? AND keyword = ?',
        )
        .run(userName, keyword);
      // 插入到最前
      this.db
        .prepare(
          'INSERT INTO search_history (username, keyword, created_at) VALUES (?, ?, ?)',
        )
        .run(userName, keyword, Date.now());
      // 限制最大条数
      const count = this.db
        .prepare(
          'SELECT COUNT(*) as cnt FROM search_history WHERE username = ?',
        )
        .get(userName) as { cnt: number };
      if (count.cnt > SEARCH_HISTORY_LIMIT) {
        this.db
          .prepare(
            `DELETE FROM search_history WHERE username = ? AND keyword NOT IN (
              SELECT keyword FROM search_history
              WHERE username = ? ORDER BY created_at DESC LIMIT ?
            )`,
          )
          .run(userName, userName, SEARCH_HISTORY_LIMIT);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    if (keyword) {
      this.db
        .prepare(
          'DELETE FROM search_history WHERE username = ? AND keyword = ?',
        )
        .run(userName, keyword);
    } else {
      this.db
        .prepare('DELETE FROM search_history WHERE username = ?')
        .run(userName);
    }
  }

  // ==================== 用户列表 ====================

  async getAllUsers(): Promise<string[]> {
    const rows = this.db
      .prepare(
        'SELECT username, MIN(created_at) AS created_at FROM (SELECT username, created_at FROM users UNION ALL SELECT username, created_at FROM users_v2) GROUP BY username ORDER BY created_at ASC, username ASC',
      )
      .all() as Array<{ username: string }>;
    return rows.map((row) => row.username);
  }

  // ==================== 管理员配置 ====================

  async getAdminConfig(): Promise<AdminConfig | null> {
    const row = this.db
      .prepare('SELECT value FROM admin_config WHERE id = 1')
      .get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as AdminConfig) : null;
  }

  async setAdminConfig(config: AdminConfig): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO admin_config (id, value) VALUES (1, ?)')
      .run(JSON.stringify(config));
  }

  // ==================== 跳过片头片尾配置 ====================

  private skipField(source: string, id: string): string {
    return `${source}+${id}`;
  }

  async getSkipConfig(
    userName: string,
    source: string,
    id: string,
  ): Promise<EpisodeSkipConfig | null> {
    const row = this.db
      .prepare(
        'SELECT value FROM skip_configs WHERE username = ? AND source = ? AND id = ?',
      )
      .get(userName, source, id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as EpisodeSkipConfig) : null;
  }

  async setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: EpisodeSkipConfig,
  ): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO skip_configs (username, source, id, value) VALUES (?, ?, ?, ?)',
      )
      .run(userName, source, id, JSON.stringify(config));
  }

  async deleteSkipConfig(
    userName: string,
    source: string,
    id: string,
  ): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM skip_configs WHERE username = ? AND source = ? AND id = ?',
      )
      .run(userName, source, id);
  }

  async getAllSkipConfigs(
    userName: string,
  ): Promise<Record<string, EpisodeSkipConfig>> {
    const rows = this.db
      .prepare('SELECT source, id, value FROM skip_configs WHERE username = ?')
      .all(userName) as Array<{ source: string; id: string; value: string }>;
    const result: Record<string, EpisodeSkipConfig> = {};
    for (const row of rows) {
      result[this.skipField(row.source, row.id)] = JSON.parse(
        row.value,
      ) as EpisodeSkipConfig;
    }
    return result;
  }

  // ==================== 剧集跳过配置（新版，多片段支持）====================

  async getEpisodeSkipConfig(
    userName: string,
    source: string,
    id: string,
  ): Promise<EpisodeSkipConfig | null> {
    const row = this.db
      .prepare(
        'SELECT value FROM episode_skip_configs WHERE username = ? AND source = ? AND id = ?',
      )
      .get(userName, source, id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as EpisodeSkipConfig) : null;
  }

  async saveEpisodeSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: EpisodeSkipConfig,
  ): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO episode_skip_configs (username, source, id, value) VALUES (?, ?, ?, ?)',
      )
      .run(userName, source, id, JSON.stringify(config));
  }

  async deleteEpisodeSkipConfig(
    userName: string,
    source: string,
    id: string,
  ): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM episode_skip_configs WHERE username = ? AND source = ? AND id = ?',
      )
      .run(userName, source, id);
  }

  async getAllEpisodeSkipConfigs(
    userName: string,
  ): Promise<Record<string, EpisodeSkipConfig>> {
    const rows = this.db
      .prepare(
        'SELECT source, id, value FROM episode_skip_configs WHERE username = ?',
      )
      .all(userName) as Array<{ source: string; id: string; value: string }>;
    const result: Record<string, EpisodeSkipConfig> = {};
    for (const row of rows) {
      result[this.skipField(row.source, row.id)] = JSON.parse(
        row.value,
      ) as EpisodeSkipConfig;
    }
    return result;
  }

  // ==================== 数据清理 ====================

  async clearAllData(): Promise<void> {
    const tables = [
      'users',
      'users_v2',
      'user_emails',
      'play_records',
      'favorites',
      'reminders',
      'search_history',
      'skip_configs',
      'episode_skip_configs',
      'admin_config',
      'cache',
      'login_stats',
      'emby_configs',
      'crash_logs',
    ];
    this.db.exec('BEGIN');
    try {
      for (const table of tables) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    console.log('[SQLite] 所有数据已清空');
  }

  // ==================== 通用缓存 ====================

  async getCache(key: string): Promise<any | null> {
    const row = this.db
      .prepare(
        'SELECT value FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)',
      )
      .get(key, Date.now()) as { value: string } | undefined;
    if (!row) return null;

    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  async setCache(
    key: string,
    data: any,
    expireSeconds?: number,
  ): Promise<void> {
    const expiresAt =
      expireSeconds !== undefined ? Date.now() + expireSeconds * 1000 : null;
    this.db
      .prepare(
        'INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)',
      )
      .run(key, JSON.stringify(data), expiresAt);
  }

  async consumeCache(key: string): Promise<any | null> {
    return this.accountTransaction(() => {
      const row = this.db
        .prepare('SELECT value, expires_at FROM cache WHERE key = ?')
        .get(key) as { value: string; expires_at: number | null } | undefined;
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      if (!row || (row.expires_at !== null && row.expires_at <= Date.now()))
        return null;
      return decodeCacheValue(row.value);
    });
  }

  async deleteCache(key: string): Promise<void> {
    this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
  }

  async clearExpiredCache(prefix?: string): Promise<void> {
    const now = Date.now();
    if (prefix) {
      this.db
        .prepare(
          'DELETE FROM cache WHERE key LIKE ? AND expires_at IS NOT NULL AND expires_at <= ?',
        )
        .run(`${prefix}%`, now);
    } else {
      this.db
        .prepare(
          'DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?',
        )
        .run(now);
    }
  }

  // ==================== 播放统计 ====================

  async getPlayStats(): Promise<PlayStatsResult> {
    try {
      // 尝试从缓存获取
      const cached = await this.getCache('play_stats_summary');
      if (cached) return cached;

      const allUsers = await this.getAllUsers();
      const now = Date.now();
      const todayStart = new Date(now).setHours(0, 0, 0, 0);
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      const PROJECT_START = new Date('2025-09-14').getTime();

      const userStats: PlayStatsResult['userStats'] = [];
      let totalWatchTime = 0;
      let totalPlays = 0;
      let todayNewUsers = 0;
      const registrationData: Record<string, number> = {};

      for (const username of allUsers) {
        const userStat = await this.getUserPlayStat(username);
        const userCreatedAt = userStat.firstWatchDate || PROJECT_START;
        const registrationDays =
          Math.floor((now - userCreatedAt) / (1000 * 60 * 60 * 24)) + 1;

        if (userCreatedAt >= todayStart) todayNewUsers++;
        if (userCreatedAt >= sevenDaysAgo) {
          const regDate = new Date(userCreatedAt).toISOString().split('T')[0];
          registrationData[regDate] = (registrationData[regDate] || 0) + 1;
        }

        userStats.push({
          username: userStat.username,
          totalWatchTime: userStat.totalWatchTime,
          totalPlays: userStat.totalPlays,
          lastPlayTime: userStat.lastPlayTime,
          recentRecords: userStat.recentRecords,
          avgWatchTime: userStat.avgWatchTime,
          mostWatchedSource: userStat.mostWatchedSource,
          registrationDays,
          lastLoginTime: userStat.lastPlayTime || userCreatedAt,
          loginCount: userStat.loginCount || 0,
          createdAt: userCreatedAt,
        });

        totalWatchTime += userStat.totalWatchTime;
        totalPlays += userStat.totalPlays;
      }

      // 热门来源
      const sourceMap = new Map<string, number>();
      for (const user of userStats) {
        for (const record of user.recentRecords) {
          sourceMap.set(
            record.source_name,
            (sourceMap.get(record.source_name) || 0) + 1,
          );
        }
      }
      const topSources = Array.from(sourceMap.entries())
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      // 近7天每日统计（简化）
      const dailyStats = [];
      for (let i = 6; i >= 0; i--) {
        const date = new Date(now - i * 24 * 60 * 60 * 1000);
        dailyStats.push({
          date: date.toISOString().split('T')[0],
          watchTime: Math.floor(totalWatchTime / 7),
          plays: Math.floor(totalPlays / 7),
        });
      }

      // 注册趋势
      const registrationTrend = [];
      for (let i = 6; i >= 0; i--) {
        const date = new Date(now - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];
        registrationTrend.push({
          date: dateKey,
          newUsers: registrationData[dateKey] || 0,
        });
      }

      const result: PlayStatsResult = {
        totalUsers: allUsers.length,
        totalWatchTime,
        totalPlays,
        avgWatchTimePerUser:
          allUsers.length > 0 ? totalWatchTime / allUsers.length : 0,
        avgPlaysPerUser: allUsers.length > 0 ? totalPlays / allUsers.length : 0,
        userStats: userStats.sort(
          (a, b) => b.totalWatchTime - a.totalWatchTime,
        ),
        topSources,
        dailyStats,
        registrationStats: {
          todayNewUsers,
          totalRegisteredUsers: allUsers.length,
          registrationTrend,
        },
        activeUsers: {
          daily: userStats.filter((u) => u.lastLoginTime >= now - 86400000)
            .length,
          weekly: userStats.filter((u) => u.lastLoginTime >= sevenDaysAgo)
            .length,
          monthly: userStats.filter((u) => u.lastLoginTime >= thirtyDaysAgo)
            .length,
        },
      };

      await this.setCache('play_stats_summary', result, 3600);
      return result;
    } catch (error) {
      console.error('[SQLite] getPlayStats 错误:', error);
      return {
        totalUsers: 0,
        totalWatchTime: 0,
        totalPlays: 0,
        avgWatchTimePerUser: 0,
        avgPlaysPerUser: 0,
        userStats: [],
        topSources: [],
        dailyStats: [],
        registrationStats: {
          todayNewUsers: 0,
          totalRegisteredUsers: 0,
          registrationTrend: [],
        },
        activeUsers: { daily: 0, weekly: 0, monthly: 0 },
      };
    }
  }

  async getUserPlayStat(userName: string): Promise<UserPlayStat> {
    try {
      const records = await this.getAllPlayRecords(userName);
      const values = Object.values(records);

      if (values.length === 0) {
        const loginRow = this.db
          .prepare('SELECT * FROM login_stats WHERE username = ?')
          .get(userName) as any;
        const loginStats = loginRow
          ? {
              loginCount: loginRow.login_count || 0,
              firstLoginTime: loginRow.first_login_time || 0,
              lastLoginTime: loginRow.last_login_time || 0,
              lastLoginDate:
                loginRow.last_login_date || loginRow.last_login_time || 0,
            }
          : {
              loginCount: 0,
              firstLoginTime: 0,
              lastLoginTime: 0,
              lastLoginDate: 0,
            };

        return {
          username: userName,
          totalWatchTime: 0,
          totalPlays: 0,
          lastPlayTime: 0,
          recentRecords: [],
          avgWatchTime: 0,
          mostWatchedSource: '',
          totalMovies: 0,
          firstWatchDate: Date.now(),
          lastUpdateTime: Date.now(),
          loginCount: loginStats.loginCount,
          firstLoginTime: loginStats.firstLoginTime,
          lastLoginTime: loginStats.lastLoginTime,
          lastLoginDate: loginStats.lastLoginDate,
          lastLoginIp: loginRow?.last_login_ip ?? undefined,
          lastLoginLocation: loginRow?.last_login_location ?? undefined,
          lastLoginDevice: loginRow?.last_login_device ?? undefined,
          lastLoginBrowser: loginRow?.last_login_browser ?? undefined,
          lastLoginOs: loginRow?.last_login_os ?? undefined,
        };
      }

      const totalWatchTime = values.reduce(
        (sum, r) => sum + (r.play_time || 0),
        0,
      );
      const totalPlays = values.length;
      const lastPlayTime = Math.max(...values.map((r) => r.save_time || 0));
      const totalMovies = new Set(
        values.map((r) => `${r.title}_${r.source_name}_${r.year}`),
      ).size;
      const firstWatchDate = Math.min(
        ...values.map((r) => r.save_time || Date.now()),
      );
      const recentRecords = values
        .sort((a, b) => (b.save_time || 0) - (a.save_time || 0))
        .slice(0, 10);
      const avgWatchTime = totalPlays > 0 ? totalWatchTime / totalPlays : 0;

      const sourceMap = new Map<string, number>();
      values.forEach((r) => {
        const name = r.source_name || '未知来源';
        sourceMap.set(name, (sourceMap.get(name) || 0) + 1);
      });
      const mostWatchedSource =
        sourceMap.size > 0
          ? Array.from(sourceMap.entries()).reduce((a, b) =>
              a[1] > b[1] ? a : b,
            )[0]
          : '';

      const loginRow = this.db
        .prepare('SELECT * FROM login_stats WHERE username = ?')
        .get(userName) as any;
      const loginStats = loginRow
        ? {
            loginCount: loginRow.login_count || 0,
            firstLoginTime: loginRow.first_login_time || 0,
            lastLoginTime: loginRow.last_login_time || 0,
            lastLoginDate:
              loginRow.last_login_date || loginRow.last_login_time || 0,
          }
        : {
            loginCount: 0,
            firstLoginTime: 0,
            lastLoginTime: 0,
            lastLoginDate: 0,
          };

      return {
        username: userName,
        totalWatchTime,
        totalPlays,
        lastPlayTime,
        recentRecords,
        avgWatchTime,
        mostWatchedSource,
        totalMovies,
        firstWatchDate,
        lastUpdateTime: Date.now(),
        loginCount: loginStats.loginCount,
        firstLoginTime: loginStats.firstLoginTime,
        lastLoginTime: loginStats.lastLoginTime,
        lastLoginDate: loginStats.lastLoginDate,
        lastLoginIp: loginRow?.last_login_ip ?? undefined,
        lastLoginLocation: loginRow?.last_login_location ?? undefined,
        lastLoginDevice: loginRow?.last_login_device ?? undefined,
        lastLoginBrowser: loginRow?.last_login_browser ?? undefined,
        lastLoginOs: loginRow?.last_login_os ?? undefined,
      };
    } catch (error) {
      console.error(`[SQLite] getUserPlayStat 错误 (${userName}):`, error);
      return {
        username: userName,
        totalWatchTime: 0,
        totalPlays: 0,
        lastPlayTime: 0,
        recentRecords: [],
        avgWatchTime: 0,
        mostWatchedSource: '',
        totalMovies: 0,
        firstWatchDate: Date.now(),
        lastUpdateTime: Date.now(),
        loginCount: 0,
        firstLoginTime: 0,
        lastLoginTime: 0,
        lastLoginDate: 0,
      };
    }
  }

  async getContentStats(limit = 10): Promise<ContentStat[]> {
    try {
      // 使用 SQL 聚合分组，避免 json_extract 依赖
      const grouped = this.db
        .prepare(
          `SELECT key, COUNT(*) as play_count, COUNT(DISTINCT username) as unique_users
           FROM play_records
           GROUP BY key
           ORDER BY play_count DESC
           LIMIT ?`,
        )
        .all(limit) as Array<{
        key: string;
        play_count: number;
        unique_users: number;
      }>;

      if (grouped.length === 0) return [];

      // 批量获取记录详情
      const keys = grouped.map((r) => r.key);
      const placeholders = keys.map(() => '?').join(',');
      const allRecords = this.db
        .prepare(
          `SELECT key, value FROM play_records WHERE key IN (${placeholders})`,
        )
        .all(...keys) as Array<{ key: string; value: string }>;

      // 按 key 分组
      const recordsByKey = new Map<string, string[]>();
      for (const r of allRecords) {
        if (!recordsByKey.has(r.key)) recordsByKey.set(r.key, []);
        recordsByKey.get(r.key)!.push(r.value);
      }

      return grouped
        .map((row) => {
          const entries = recordsByKey.get(row.key) || [];
          const totalWatchTime = entries.reduce((sum, v) => {
            try {
              return sum + (JSON.parse(v).play_time || 0);
            } catch {
              return sum;
            }
          }, 0);
          const firstVal = entries.length > 0 ? entries[0] : null;
          if (!firstVal) return null;
          const record = JSON.parse(firstVal) as PlayRecord;
          const sep = row.key.indexOf('+');
          const source = sep >= 0 ? row.key.substring(0, sep) : '';
          const id = sep >= 0 ? row.key.substring(sep + 1) : row.key;
          return {
            source,
            id,
            title: record.title,
            source_name: record.source_name,
            cover: record.cover,
            year: record.year,
            playCount: row.play_count,
            totalWatchTime,
            averageWatchTime:
              row.play_count > 0 ? totalWatchTime / row.play_count : 0,
            lastPlayed: record.save_time,
            uniqueUsers: row.unique_users,
          };
        })
        .filter(Boolean) as ContentStat[];
    } catch (error) {
      console.error('[SQLite] getContentStats 错误:', error);
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
      await this.deleteCache('play_stats_summary');
    } catch (error) {
      console.error('[SQLite] updatePlayStatistics 错误:', error);
    }
  }

  async updateUserLoginStats(
    userName: string,
    loginTime: number,
    isFirstLogin?: boolean,
    loginMeta?: {
      ip?: string;
      location?: string;
      device?: string;
      browser?: string;
      os?: string;
    },
  ): Promise<void> {
    const row = this.db
      .prepare('SELECT * FROM login_stats WHERE username = ?')
      .get(userName) as any;
    const stats = row || {
      login_count: 0,
      first_login_time: null,
      last_login_time: null,
      last_login_date: null,
    };

    const loginCount = (stats.login_count || 0) + 1;
    const firstLoginTime =
      isFirstLogin || !stats.first_login_time
        ? loginTime
        : stats.first_login_time;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO login_stats
         (username, login_count, first_login_time, last_login_time, last_login_date,
          last_login_ip, last_login_location, last_login_device, last_login_browser, last_login_os)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userName,
        loginCount,
        firstLoginTime,
        loginTime,
        loginTime,
        loginMeta?.ip ?? row?.last_login_ip ?? null,
        loginMeta?.location ?? row?.last_login_location ?? null,
        loginMeta?.device ?? row?.last_login_device ?? null,
        loginMeta?.browser ?? row?.last_login_browser ?? null,
        loginMeta?.os ?? row?.last_login_os ?? null,
      );
  }

  // ==================== Emby 配置 ====================

  async getUserEmbyConfig(userName: string): Promise<any | null> {
    const row = this.db
      .prepare('SELECT value FROM emby_configs WHERE username = ?')
      .get(userName) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  async saveUserEmbyConfig(userName: string, config: any): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO emby_configs (username, value) VALUES (?, ?)',
      )
      .run(userName, JSON.stringify(config));
  }

  async deleteUserEmbyConfig(userName: string): Promise<void> {
    this.db
      .prepare('DELETE FROM emby_configs WHERE username = ?')
      .run(userName);
  }

  // ==================== 崩溃日志 ====================

  async saveCrashLog(crashLog: CrashLog): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO crash_logs (timestamp, value, created_at) VALUES (?, ?, ?)',
      )
      .run(crashLog.timestamp, JSON.stringify(crashLog), Date.now());
  }

  async getCrashLogs(limit = 50): Promise<CrashLog[]> {
    const rows = this.db
      .prepare('SELECT value FROM crash_logs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ value: string }>;
    return rows.map((r) => JSON.parse(r.value) as CrashLog);
  }

  async deleteCrashLog(timestamp: string): Promise<void> {
    this.db
      .prepare('DELETE FROM crash_logs WHERE timestamp = ?')
      .run(timestamp);
  }

  async clearCrashLogs(): Promise<void> {
    this.db.prepare('DELETE FROM crash_logs').run();
  }
}
