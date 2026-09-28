/** Read both storage layouts; copy legacy data only when explicitly requested. */
export const LEGACY_DATA_KINDS = ['pr', 'fav', 'skip', 'episodeskip'] as const;
export type LegacyDataKind = typeof LEGACY_DATA_KINDS[number];

export interface DataMigrationCount {
  copied: number;
  skipped: number;
  missing: number;
}

export interface DataMigrationReport extends DataMigrationCount {
  retainedLegacy: true;
  byKind: Record<LegacyDataKind, DataMigrationCount>;
}

export interface RedisDataPort {
  hash(key: string): Promise<Record<string, unknown> | null>;
  getMany(keys: string[]): Promise<unknown[]>;
  scan(pattern: string): Promise<string[]>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export const DATA_READ_LUA = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current then return current end
return redis.call('GET', KEYS[2])
`;

export const DATA_WRITE_LUA = `
for index = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[index], ARGV[index + 1]) end
return #ARGV / 2
`;

export const DATA_DELETE_LUA = `
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
return 1
`;

export const DATA_DELETE_ALL_LUA = `
for index = 1, #KEYS do redis.call('DEL', KEYS[index]) end
return #KEYS
`;

export const DATA_COPY_LEGACY_LUA = `
-- Read and copy in one operation so a concurrent delete cannot resurrect data.
local value = redis.call('GET', KEYS[2])
if not value then return -1 end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
local valid = pcall(cjson.decode, value)
if not valid then return redis.error_reply('Invalid legacy JSON; source retained') end
return redis.call('HSETNX', KEYS[1], ARGV[1], value)
`;

function decode<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function escapeGlob(value: string): string {
  return value.replace(/[\\*?\[\]]/g, '\\$&');
}

export class RedisDataStorage {
  constructor(private readonly port: RedisDataPort) {}

  private hashKey(user: string, kind: LegacyDataKind): string {
    return `u:${user}:${kind}`;
  }

  private legacyPrefix(user: string, kind: LegacyDataKind): string {
    return `${this.hashKey(user, kind)}:`;
  }

  private async legacyKeys(user: string, kind: LegacyDataKind): Promise<string[]> {
    const prefix = this.legacyPrefix(user, kind);
    return (await this.port.scan(`${escapeGlob(prefix)}*`)).filter(key => key.startsWith(prefix));
  }

  async get<T>(user: string, kind: LegacyDataKind, field: string): Promise<T | null> {
    return decode<T>(await this.port.eval(DATA_READ_LUA,
      [this.hashKey(user, kind), `${this.legacyPrefix(user, kind)}${field}`], [field]));
  }

  async getAll<T>(user: string, kind: LegacyDataKind): Promise<Record<string, T>> {
    const [keys, current] = await Promise.all([
      this.legacyKeys(user, kind), this.port.hash(this.hashKey(user, kind)),
    ]);
    const result: Record<string, T> = Object.create(null);
    const prefix = this.legacyPrefix(user, kind);
    for (let offset = 0; offset < keys.length; offset += 100) {
      const batch = keys.slice(offset, offset + 100);
      const values = await this.port.getMany(batch);
      for (let index = 0; index < batch.length; index++) {
        const field = batch[index].slice(prefix.length);
        if (Object.prototype.hasOwnProperty.call(current ?? {}, field)) continue;
        const value = decode<T>(values[index]);
        if (value !== null) result[field] = value;
      }
    }
    for (const [field, raw] of Object.entries(current ?? {})) {
      const value = decode<T>(raw);
      if (value !== null) result[field] = value;
    }
    return result;
  }

  async set<T>(user: string, kind: LegacyDataKind, field: string, value: T): Promise<void> {
    await this.setMany(user, kind, { [field]: value });
  }

  async setMany<T>(user: string, kind: LegacyDataKind, values: Record<string, T>): Promise<void> {
    const entries = Object.entries(values);
    for (let offset = 0; offset < entries.length; offset += 100) {
      const args = entries.slice(offset, offset + 100).flatMap(([field, value]) => [field, JSON.stringify(value)]);
      await this.port.eval(DATA_WRITE_LUA, [this.hashKey(user, kind)], args);
    }
  }

  async delete(user: string, kind: LegacyDataKind, field: string): Promise<void> {
    await this.port.eval(DATA_DELETE_LUA,
      [this.hashKey(user, kind), `${this.legacyPrefix(user, kind)}${field}`], [field]);
  }

  async deleteAll(user: string, kind: LegacyDataKind): Promise<void> {
    const keys = await this.legacyKeys(user, kind);
    await this.port.eval(DATA_DELETE_ALL_LUA, [this.hashKey(user, kind), ...keys], []);
  }

  async relatedKeys(user: string): Promise<string[]> {
    const oldKeys = await Promise.all(LEGACY_DATA_KINDS.map(kind => this.legacyKeys(user, kind)));
    return [...LEGACY_DATA_KINDS.map(kind => this.hashKey(user, kind)), ...oldKeys.flat(),
      `u:${user}:reminders`, `u:${user}:reminder`, `u:${user}:sh`, `u:${user}:stats`,
      `u:${user}:emby-config`, `user_login_stats:${user}`];
  }

  async migrate(users: string[]): Promise<DataMigrationReport> {
    const empty = (): DataMigrationCount => ({ copied: 0, skipped: 0, missing: 0 });
    const byKind = Object.fromEntries(LEGACY_DATA_KINDS.map(kind => [kind, empty()])) as Record<LegacyDataKind, DataMigrationCount>;
    const report: DataMigrationReport = { ...empty(), retainedLegacy: true, byKind };
    for (const user of new Set(users)) {
      for (const kind of LEGACY_DATA_KINDS) {
        const prefix = this.legacyPrefix(user, kind);
        for (const key of await this.legacyKeys(user, kind)) {
          const result = Number(await this.port.eval(DATA_COPY_LEGACY_LUA,
            [this.hashKey(user, kind), key], [key.slice(prefix.length)]));
          if (![1, 0, -1].includes(result)) throw new Error('无法确认旧数据复制结果');
          const counter = result === 1 ? 'copied' : result === 0 ? 'skipped' : 'missing';
          report[counter]++;
          byKind[kind][counter]++;
        }
      }
    }
    return report;
  }
}
