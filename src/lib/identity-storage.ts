import {
  type IdentityRegistry,
  isLegacyUserUid,
  isNumericUserUid,
  isUserUid,
  type UserIdentity,
  UserIdentityError,
  type UserIdentityErrorCode,
} from './user-identity';

// This key/table is deliberately outside cache namespaces and has no TTL.
export const IDENTITY_REGISTRY_KEY = 'identity:registry:v1';
const IDENTITY_READ_LUA = "return cjson.encode({redis.call('HGET', KEYS[1], ARGV[1])})";
const IDENTITY_SNAPSHOT_LUA = "return cjson.encode(redis.call('HGETALL', KEYS[1]))";

export const IDENTITY_MUTATE_LUA = `
local key = KEYS[1]
local input = cjson.decode(ARGV[2])
local function get(field) return redis.call('HGET', key, field) end
local function put(field, value) redis.call('HSET', key, field, value) end
local function del(field) redis.call('HDEL', key, field) end
local function advanceCounter(uid)
  local current = get('counter') or '0'
  if #uid > #current or (#uid == #current and uid > current) then put('counter', uid) end
end
local function allocate()
  local current = get('counter') or '0'
  local value = ''
  local carry = 1
  for i = #current, 1, -1 do
    local digit = tonumber(string.sub(current, i, i)) + carry
    if digit >= 10 then digit = 0; carry = 1 else carry = 0 end
    value = tostring(digit) .. value
  end
  if carry == 1 then value = '1' .. value end
  put('counter', value)
  return value
end
local function canonical(uid) return uid and (get('a:' .. uid) or uid) end
local function record(uid)
  uid = canonical(uid)
  local value = uid and get('u:' .. uid)
  if value then return cjson.decode(value) end
  return nil
end
local function fail(code) return cjson.encode({error = code}) end
local function save(value)
  local historical = {}
  local seen = {}
  local previous = get('l:' .. value.uid)
  for _, alias in ipairs(previous and cjson.decode(previous) or {}) do
    if not seen[alias] then seen[alias] = true; table.insert(historical, alias) end
  end
  for _, alias in ipairs(value.legacyUids or {}) do
    if not seen[alias] then seen[alias] = true; table.insert(historical, alias) end
  end
  table.sort(historical)
  if #historical > 0 then
    value.legacyUids = historical
    put('l:' .. value.uid, cjson.encode(historical))
    for _, alias in ipairs(historical) do put('a:' .. alias, value.uid) end
  else value.legacyUids = nil end
  advanceCounter(value.uid)
  local encoded = cjson.encode(value)
  put('u:' .. value.uid, encoded)
  put('n:' .. value.username, value.uid)
  put('s:' .. value.storageKey, value.uid)
  put('v:' .. value.uid, tostring(math.max(tonumber(get('v:' .. value.uid)) or 0, value.sessionVersion or 0)))
  return encoded
end
local function retire(value)
  put('r:' .. value.username, value.uid)
  put('d:' .. value.storageKey, value.uid)
  put('v:' .. value.uid, tostring(math.max(tonumber(get('v:' .. value.uid)) or 0, value.sessionVersion or 0)))
  if get('n:' .. value.username) == value.uid then del('n:' .. value.username) end
  if get('s:' .. value.storageKey) == value.uid then del('s:' .. value.storageKey) end
  del('u:' .. value.uid)
  if get('owner') == value.uid then del('owner') end
end
local function rename(value, name)
  local occupant = get('n:' .. name)
  if occupant and occupant ~= value.uid then return fail('USERNAME_EXISTS') end
  if value.username ~= name then
    put('r:' .. value.username, value.uid)
    if get('n:' .. value.username) == value.uid then del('n:' .. value.username) end
    value.username = name
    value.sessionVersion = (value.sessionVersion or 0) + 1
  end
  return save(value)
end
if ARGV[1] == 'snapshot' then
  return cjson.encode(redis.call('HGETALL', key))
elseif ARGV[1] == 'migrate' then
  if get('uid-schema') == '2' then return 'null' end
  local entries = redis.call('HGETALL', key)
  local count = 0
  for _ in pairs(input.expected) do count = count + 1 end
  if #entries ~= count * 2 then return cjson.encode('retry') end
  for i = 1, #entries, 2 do
    if input.expected[entries[i]] ~= entries[i + 1] then return cjson.encode('retry') end
  end
  for i = 1, #entries, 2 do
    if not input.replacement[entries[i]] then del(entries[i]) end
  end
  for field, value in pairs(input.replacement) do put(field, value) end
  return 'null'
elseif ARGV[1] == 'allocate' then
  return cjson.encode(allocate())
elseif ARGV[1] == 'reserve' then
  if string.match(input.uid, '^[1-9][0-9]*$') then
    advanceCounter(input.uid)
    return cjson.encode(input.uid)
  end
  local existing = get('a:' .. input.uid)
  if existing then return cjson.encode(existing) end
  local uid = allocate()
  put('a:' .. input.uid, uid)
  put('l:' .. uid, cjson.encode({input.uid}))
  return cjson.encode(uid)
elseif ARGV[1] == 'ensure' then
  local value = input.identity
  for _, alias in ipairs(value.legacyUids or {}) do
    local existing = get('a:' .. alias)
    if existing and existing ~= value.uid then return fail('IDENTITY_CONFLICT') end
  end
  if input.owner then
    local existingOwner = record(get('owner'))
    if existingOwner then return rename(existingOwner, value.username) end
  end
  local named = record(get('n:' .. value.username))
  if named then
    if input.fresh and named.uid ~= value.uid then return fail('USERNAME_EXISTS') end
    if input.owner then put('owner', named.uid) end
    return cjson.encode(named)
  end
  local stored = record(get('s:' .. value.storageKey))
  if stored then
    if input.fresh then return fail('IDENTITY_CONFLICT') end
    if input.owner then put('owner', stored.uid) end
    return cjson.encode(stored)
  end
  if get('d:' .. value.storageKey) then return fail('IDENTITY_CONFLICT') end
  if get('u:' .. value.uid) then return fail('UID_EXISTS') end
  value.sessionVersion = math.max(value.sessionVersion or 0, (tonumber(get('v:' .. value.uid)) or -1) + 1)
  if input.owner then put('owner', value.uid) end
  return save(value)
elseif ARGV[1] == 'rename' then
  local value = record(input.uid)
  if not value then return fail('USER_NOT_FOUND') end
  if get('owner') == value.uid then return fail('OWNER_PROTECTED') end
  if input.expectedUsername and input.expectedUsername ~= value.username then return fail('STALE_USERNAME') end
  return rename(value, input.username)
elseif ARGV[1] == 'remove' then
  local value = record(input.uid)
  if value and input.expectedStorageKey and value.storageKey ~= input.expectedStorageKey then return fail('IDENTITY_CONFLICT') end
  if value then retire(value) end
  return 'null'
elseif ARGV[1] == 'clear' then
  local fields = redis.call('HKEYS', key)
  for _, field in ipairs(fields) do
    if string.sub(field, 1, 2) == 'u:' then
      local value = record(string.sub(field, 3))
      if value then retire(value) end
    end
  end
  del('owner')
  return 'null'
end
return fail('IDENTITY_CONFLICT')
`;

type Mutation = {
  identity?: UserIdentity;
  fresh?: boolean;
  owner?: boolean;
  uid?: string;
  username?: string;
  expectedUsername?: string;
  expectedStorageKey?: string;
  expected?: Record<string, string>;
  replacement?: Record<string, string>;
};

type MutationResult = UserIdentity | string | null;

function decode(value: unknown): UserIdentity | null {
  if (value === null || value === undefined || value === 'null') return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed?.error)
    throw new UserIdentityError(parsed.error as UserIdentityErrorCode);
  if (
    !parsed ||
    !isUserUid(parsed.uid) ||
    typeof parsed.username !== 'string' ||
    typeof parsed.storageKey !== 'string'
  )
    throw new UserIdentityError('IDENTITY_CONFLICT');
  if (
    parsed.sessionVersion !== undefined &&
    (!Number.isSafeInteger(parsed.sessionVersion) || parsed.sessionVersion < 0)
  ) {
    throw new UserIdentityError('IDENTITY_CONFLICT');
  }
  if (
    parsed.legacyUids !== undefined &&
    (!Array.isArray(parsed.legacyUids) ||
      !parsed.legacyUids.every(isLegacyUserUid))
  ) {
    throw new UserIdentityError('IDENTITY_CONFLICT');
  }
  return parsed as UserIdentity;
}

function decodeMutation(value: unknown): MutationResult {
  if (value === null || value === undefined || value === 'null') return null;
  if (isNumericUserUid(value) || value === 'retry') return value;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return typeof parsed === 'string' ? parsed : decode(parsed);
}

/** Build the complete migration without writing; the adapters commit it by CAS. */
function numericMigration(snapshot: Record<string, string>): Record<string, string> {
  const replacement = { ...snapshot };
  const parents = new Map<string, string>();
  const active: UserIdentity[] = [];
  const add = (uid: string) => {
    if (!isUserUid(uid)) throw new UserIdentityError('IDENTITY_CONFLICT');
    if (!parents.has(uid)) parents.set(uid, uid);
  };
  const root = (uid: string): string => {
    add(uid);
    let current = uid;
    while (parents.get(current) !== current) current = parents.get(current)!;
    return current;
  };
  const link = (alias: string, uid: string) => {
    if (!isLegacyUserUid(alias)) throw new UserIdentityError('IDENTITY_CONFLICT');
    const a = root(alias);
    const b = root(uid);
    if (a === b) return;
    if (isNumericUserUid(a) && isNumericUserUid(b))
      throw new UserIdentityError('IDENTITY_CONFLICT');
    if (isNumericUserUid(a)) parents.set(b, a);
    else if (isNumericUserUid(b)) parents.set(a, b);
    else parents.set(a > b ? a : b, a > b ? b : a);
  };
  const aliasList = (value: string): string[] => {
    const list = JSON.parse(value);
    if (!Array.isArray(list) || !list.every(isLegacyUserUid))
      throw new UserIdentityError('IDENTITY_CONFLICT');
    return list;
  };
  for (const [field, value] of Object.entries(snapshot)) {
    const prefix = field.slice(0, 2);
    if (prefix === 'u:') {
      const identity = decode(value)!;
      if (identity.uid !== field.slice(2))
        throw new UserIdentityError('IDENTITY_CONFLICT');
      add(identity.uid);
      active.push(identity);
      for (const alias of identity.legacyUids ?? []) link(alias, identity.uid);
    } else if (prefix === 'v:') add(field.slice(2));
    else if (['n:', 's:', 'r:', 'd:'].includes(prefix)) add(value);
    else if (prefix === 'a:') link(field.slice(2), value);
    else if (prefix === 'l:') {
      add(field.slice(2));
      for (const alias of aliasList(value)) link(alias, field.slice(2));
    }
  }
  const owner = snapshot.owner || (process.env.USERNAME ? snapshot[`n:${process.env.USERNAME}`] : undefined);
  if (owner) add(owner);
  const counterValue = snapshot.counter ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(counterValue))
    throw new UserIdentityError('IDENTITY_CONFLICT');
  let counter = BigInt(counterValue);
  for (const uid of parents.keys()) {
    if (isNumericUserUid(uid) && BigInt(uid) > counter) counter = BigInt(uid);
  }
  const assigned = new Map<string, string>();
  const legacyRoots = [...new Set([...parents.keys()].map(root))]
    .filter(isLegacyUserUid)
    .sort();
  const ownerRoot = owner ? root(owner) : null;
  if (ownerRoot && isLegacyUserUid(ownerRoot)) {
    legacyRoots.splice(legacyRoots.indexOf(ownerRoot), 1);
    legacyRoots.unshift(ownerRoot);
  }
  for (const uid of legacyRoots) {
    counter += BigInt(1);
    assigned.set(uid, counter.toString());
  }
  const canonical = (uid: string): string => {
    const resolved = root(uid);
    return isNumericUserUid(resolved) ? resolved : assigned.get(resolved)!;
  };
  const aliases = new Map<string, string[]>();
  for (const uid of parents.keys()) {
    if (!isLegacyUserUid(uid)) continue;
    const numeric = canonical(uid);
    replacement[`a:${uid}`] = numeric;
    const list = aliases.get(numeric) ?? [];
    list.push(uid);
    aliases.set(numeric, list);
  }
  for (const list of aliases.values()) list.sort();
  const versions = new Map<string, number>();
  for (const [field, value] of Object.entries(snapshot)) {
    const prefix = field.slice(0, 2);
    if (['u:', 'v:', 'l:'].includes(prefix)) delete replacement[field];
    if (['n:', 's:', 'r:', 'd:'].includes(prefix)) replacement[field] = canonical(value);
    if (prefix === 'v:') {
      const version = Number(value);
      if (!Number.isSafeInteger(version) || version < 0)
        throw new UserIdentityError('IDENTITY_CONFLICT');
      const uid = canonical(field.slice(2));
      versions.set(uid, Math.max(versions.get(uid) ?? 0, version));
    }
  }
  const identities = new Map<string, UserIdentity>();
  for (const identity of active) {
    const uid = canonical(identity.uid);
    const previous = identities.get(uid);
    if (previous && (previous.username !== identity.username || previous.storageKey !== identity.storageKey || previous.sessionVersion !== identity.sessionVersion))
      throw new UserIdentityError('IDENTITY_CONFLICT');
    const migrated = { ...identity, uid };
    const historical = aliases.get(uid);
    if (historical?.length) migrated.legacyUids = historical;
    else delete migrated.legacyUids;
    identities.set(uid, migrated);
  }
  for (const [uid, identity] of identities) replacement[`u:${uid}`] = JSON.stringify(identity);
  for (const [uid, version] of versions) replacement[`v:${uid}`] = String(version);
  for (const [uid, list] of aliases) replacement[`l:${uid}`] = JSON.stringify(list);
  if (owner) replacement.owner = canonical(owner);
  replacement.counter = counter.toString();
  replacement['uid-schema'] = '2';
  return replacement;
}

abstract class Registry implements IdentityRegistry {
  private readiness?: Promise<void>;
  protected abstract read(field: string): Promise<string | null>;
  protected abstract fields(): Promise<Record<string, string>>;
  protected abstract mutate(
    operation: string,
    input: Mutation,
  ): Promise<MutationResult>;

  private async prepare(): Promise<void> {
    if (!this.readiness) {
      this.readiness = (async () => {
        for (let attempt = 0; attempt < 16; attempt++) {
          const snapshot = await this.fields();
          if (snapshot['uid-schema'] === '2') return;
          const result = await this.mutate('migrate', {
            expected: snapshot,
            replacement: numericMigration(snapshot),
          });
          if (result !== 'retry') return;
        }
        throw new UserIdentityError('IDENTITY_CONFLICT');
      })().catch((error) => {
        this.readiness = undefined;
        throw error;
      });
    }
    await this.readiness;
  }

  async allocateUid(): Promise<string> {
    await this.prepare();
    return (await this.mutate('allocate', {})) as string;
  }

  async reserveUid(uid: string): Promise<string> {
    if (!isUserUid(uid)) throw new UserIdentityError('INVALID_UID');
    await this.prepare();
    return (await this.mutate('reserve', { uid })) as string;
  }

  async getByUid(uid: string): Promise<UserIdentity | null> {
    if (!isUserUid(uid)) return null;
    await this.prepare();
    if (isLegacyUserUid(uid)) {
      const numeric = await this.read(`a:${uid}`);
      if (!numeric) return null;
      uid = numeric;
    }
    return decode(await this.read(`u:${uid}`));
  }
  private async indexed(field: string): Promise<UserIdentity | null> {
    await this.prepare();
    const uid = await this.read(field);
    return uid ? this.getByUid(uid) : null;
  }
  async getByUsername(username: string) {
    const identity = await this.indexed(`n:${username}`);
    return identity?.username === username ? identity : null;
  }
  getByStorageKey(storageKey: string) {
    return this.indexed(`s:${storageKey}`);
  }
  getOwner() {
    return this.indexed('owner');
  }
  async list(): Promise<UserIdentity[]> {
    await this.prepare();
    return Object.entries(await this.fields())
      .filter(([field]) => field.startsWith('u:'))
      .map(([, value]) => decode(value)!)
      .filter(Boolean);
  }
  async isUsernameRetired(username: string): Promise<boolean> {
    await this.prepare();
    return !!(await this.read(`r:${username}`));
  }
  async isStorageRetired(storageKey: string): Promise<boolean> {
    await this.prepare();
    return !!(await this.read(`d:${storageKey}`));
  }
  async retiredUsernameUid(username: string) {
    await this.prepare();
    return this.read(`r:${username}`);
  }
  async ensure(
    identity: UserIdentity,
    options: { fresh?: boolean; owner?: boolean } = {},
  ): Promise<UserIdentity> {
    decode(identity);
    const uid = await this.reserveUid(identity.uid);
    const legacyUids = [...new Set([
      ...(identity.legacyUids ?? []),
      ...(isLegacyUserUid(identity.uid) ? [identity.uid] : []),
    ])];
    return decode(await this.mutate('ensure', {
      identity: { ...identity, uid, ...(legacyUids.length ? { legacyUids } : {}) },
      ...options,
    }))!;
  }
  async rename(
    uid: string,
    username: string,
    expectedUsername?: string,
  ): Promise<UserIdentity> {
    await this.prepare();
    return decode(await this.mutate('rename', { uid, username, expectedUsername }))!;
  }
  async remove(uid: string, expectedStorageKey?: string): Promise<void> {
    await this.prepare();
    await this.mutate('remove', { uid, expectedStorageKey });
  }
  async clear(): Promise<void> {
    await this.prepare();
    await this.mutate('clear', {});
  }
}

export interface RedisIdentityPort {
  get(field: string): Promise<unknown>;
  all(): Promise<Record<string, unknown> | null>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export class RedisIdentityRegistry extends Registry {
  constructor(private readonly port: RedisIdentityPort) {
    super();
  }
  protected async read(field: string): Promise<string | null> {
    const result = await this.port.eval(IDENTITY_READ_LUA, [IDENTITY_REGISTRY_KEY], [field]);
    const values = typeof result === 'string' ? JSON.parse(result) : result;
    const value = Array.isArray(values) ? values[0] : null;
    return typeof value === 'string' ? value : null;
  }
  protected async fields(): Promise<Record<string, string>> {
    // Returning HGETALL inside JSON preserves raw field strings even when an
    // Upstash client automatically decodes individual hash values.
    const result = await this.port.eval(IDENTITY_SNAPSHOT_LUA, [IDENTITY_REGISTRY_KEY], []);
    const entries = typeof result === 'string' ? JSON.parse(result) : result;
    if (!Array.isArray(entries)) {
      if (entries && typeof entries === 'object' && Object.keys(entries).length === 0) return {};
      throw new UserIdentityError('IDENTITY_CONFLICT');
    }
    const fields: Record<string, string> = {};
    for (let index = 0; index < entries.length; index += 2) {
      fields[entries[index]] = entries[index + 1];
    }
    return fields;
  }
  protected async mutate(
    operation: string,
    input: Mutation,
  ): Promise<MutationResult> {
    return decodeMutation(
      await this.port.eval(
        IDENTITY_MUTATE_LUA,
        [IDENTITY_REGISTRY_KEY],
        [operation, JSON.stringify(input)],
      ),
    );
  }
}

// Uses the same permanent key model as Redis. Every mutation is one SQLite
// write transaction, so competing processes cannot allocate different UIDs.
export class SqliteIdentityRegistry extends Registry {
  constructor(private readonly database: any) {
    super();
  }
  private readSync(field: string): string | null {
    return (
      this.database
        .prepare('SELECT value FROM user_identity_registry WHERE key = ?')
        .get(field)?.value ?? null
    );
  }
  protected async read(field: string) {
    return this.readSync(field);
  }
  protected async fields(): Promise<Record<string, string>> {
    return Object.fromEntries(
      this.database
        .prepare('SELECT key, value FROM user_identity_registry')
        .all()
        .map((row: { key: string; value: string }) => [row.key, row.value]),
    );
  }
  protected async mutate(
    operation: string,
    input: Mutation,
  ): Promise<MutationResult> {
    this.database.exec('BEGIN IMMEDIATE');
    const get = (field: string) => this.readSync(field);
    const put = (field: string, value: string) =>
      this.database
        .prepare(
          'INSERT INTO user_identity_registry (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(field, value);
    const del = (field: string) =>
      this.database
        .prepare('DELETE FROM user_identity_registry WHERE key = ?')
        .run(field);
    const record = (uid: string | null | undefined) =>
      uid ? decode(get(`u:${get(`a:${uid}`) ?? uid}`)) : null;
    const fail = (code: UserIdentityErrorCode): never => {
      throw new UserIdentityError(code);
    };
    const advanceCounter = (uid: string) => {
      if (BigInt(uid) > BigInt(get('counter') ?? '0')) put('counter', uid);
    };
    const allocate = () => {
      const uid = (BigInt(get('counter') ?? '0') + BigInt(1)).toString();
      put('counter', uid);
      return uid;
    };
    const save = (identity: UserIdentity) => {
      const historical = [...new Set<string>([
        ...JSON.parse(get(`l:${identity.uid}`) ?? '[]'),
        ...(identity.legacyUids ?? []),
      ])].sort();
      if (historical.length) {
        identity.legacyUids = historical;
        put(`l:${identity.uid}`, JSON.stringify(historical));
        for (const alias of historical) put(`a:${alias}`, identity.uid);
      } else delete identity.legacyUids;
      advanceCounter(identity.uid);
      put(`u:${identity.uid}`, JSON.stringify(identity));
      put(`n:${identity.username}`, identity.uid);
      put(`s:${identity.storageKey}`, identity.uid);
      put(
        `v:${identity.uid}`,
        String(
          Math.max(
            Number(get(`v:${identity.uid}`)) || 0,
            identity.sessionVersion ?? 0,
          ),
        ),
      );
      return identity;
    };
    const retire = (identity: UserIdentity) => {
      put(`r:${identity.username}`, identity.uid);
      put(`d:${identity.storageKey}`, identity.uid);
      put(
        `v:${identity.uid}`,
        String(
          Math.max(
            Number(get(`v:${identity.uid}`)) || 0,
            identity.sessionVersion ?? 0,
          ),
        ),
      );
      if (get(`n:${identity.username}`) === identity.uid)
        del(`n:${identity.username}`);
      if (get(`s:${identity.storageKey}`) === identity.uid)
        del(`s:${identity.storageKey}`);
      del(`u:${identity.uid}`);
      if (get('owner') === identity.uid) del('owner');
    };
    const rename = (identity: UserIdentity, username: string) => {
      const occupant = get(`n:${username}`);
      if (occupant && occupant !== identity.uid) fail('USERNAME_EXISTS');
      if (identity.username !== username) {
        put(`r:${identity.username}`, identity.uid);
        if (get(`n:${identity.username}`) === identity.uid)
          del(`n:${identity.username}`);
        identity.username = username;
        identity.sessionVersion = (identity.sessionVersion ?? 0) + 1;
      }
      return save(identity);
    };
    try {
      let result: MutationResult = null;
      if (operation === 'migrate') {
        if (get('uid-schema') !== '2') {
          const entries = this.database.prepare('SELECT key, value FROM user_identity_registry').all();
          if (entries.length !== Object.keys(input.expected!).length || entries.some((row: { key: string; value: string }) => input.expected![row.key] !== row.value)) result = 'retry';
          else {
            for (const row of entries) {
              if (!Object.prototype.hasOwnProperty.call(input.replacement!, row.key)) del(row.key);
            }
            for (const [field, value] of Object.entries(input.replacement!)) put(field, value);
          }
        }
      } else if (operation === 'allocate') result = allocate();
      else if (operation === 'reserve') {
        const preferred = input.uid!;
        if (isNumericUserUid(preferred)) {
          advanceCounter(preferred);
          result = preferred;
        } else {
          result = get(`a:${preferred}`);
          if (!result) {
            result = allocate();
            put(`a:${preferred}`, result);
            put(`l:${result}`, JSON.stringify([preferred]));
          }
        }
      } else if (operation === 'ensure') {
        const identity = input.identity!;
        for (const alias of identity.legacyUids ?? []) {
          const existing = get(`a:${alias}`);
          if (existing && existing !== identity.uid) fail('IDENTITY_CONFLICT');
        }
        const owner = input.owner ? record(get('owner')) : null;
        const named = record(get(`n:${identity.username}`));
        const stored = record(get(`s:${identity.storageKey}`));
        if (owner) result = rename(owner, identity.username);
        else if (named) {
          if (input.fresh && named.uid !== identity.uid)
            fail('USERNAME_EXISTS');
          if (input.owner) put('owner', named.uid);
          result = named;
        } else if (stored) {
          if (input.fresh) fail('IDENTITY_CONFLICT');
          if (input.owner) put('owner', stored.uid);
          result = stored;
        } else {
          if (get(`d:${identity.storageKey}`)) fail('IDENTITY_CONFLICT');
          if (get(`u:${identity.uid}`)) fail('UID_EXISTS');
          identity.sessionVersion = Math.max(
            identity.sessionVersion ?? 0,
            Number(get(`v:${identity.uid}`) ?? -1) + 1,
          );
          if (input.owner) put('owner', identity.uid);
          result = save(identity);
        }
      } else if (operation === 'rename') {
        const identity = record(input.uid);
        if (!identity) fail('USER_NOT_FOUND');
        if (get('owner') === identity.uid) fail('OWNER_PROTECTED');
        if (
          input.expectedUsername !== undefined &&
          input.expectedUsername !== identity.username
        )
          fail('STALE_USERNAME');
        result = rename(identity, input.username!);
      } else if (operation === 'remove') {
        const identity = record(input.uid);
        if (
          identity &&
          input.expectedStorageKey !== undefined &&
          identity.storageKey !== input.expectedStorageKey
        )
          fail('IDENTITY_CONFLICT');
        if (identity) retire(identity);
      } else if (operation === 'clear') {
        const rows = this.database
          .prepare(
            "SELECT value FROM user_identity_registry WHERE key LIKE 'u:%'",
          )
          .all();
        for (const row of rows) retire(decode(row.value)!);
        del('owner');
      } else fail('IDENTITY_CONFLICT');
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
