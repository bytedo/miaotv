// Explicitly authorized remote integration only. No production configuration
// module is loaded. Every operation is restricted to synthetic owned keys or
// exact owned members of the two existing global indexes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { createSourceLoader } = require('./storage-test-loader.cjs');

if (process.env.MIAOTV_ALLOW_KVROCKS_TESTS !== '1' || !process.env.MIAOTV_KVROCKS_TEST_CONFIG) {
  throw new Error('Explicit isolated Kvrocks test authorization and connection-file path are required');
}

const config = JSON.parse(fs.readFileSync(process.env.MIAOTV_KVROCKS_TEST_CONFIG, 'utf8'));
const redis = require(process.env.MIAOTV_NODE_MODULES ? path.join(process.env.MIAOTV_NODE_MODULES, 'redis') : 'redis');
const prefix = `${String(config.prefix || 'codexstorage').replace(/[^A-Za-z0-9]/g, '')}${randomBytes(8).toString('hex')}_`;
const codePrefix = prefix.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const ownedKeys = new Set();
const ownedUsers = new Set();
const ownedCodes = new Set();
let raw;
let passed = 0;
let activeCase = 'connect';
const originalLog = console.log;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

function user(label) {
  const value = `${prefix}${label}`;
  ownedUsers.add(value);
  return value;
}
function isOwnedKey(key) {
  return typeof key === 'string' && [
    `u:${prefix}`, `email:lookup:${prefix}`, `oidc:sub:${prefix}`,
    `cache:${prefix}`, `user_login_stats:${prefix}`, `invite:${codePrefix}`,
  ].some(start => key.startsWith(start));
}
function key(key) {
  assert.equal(isOwnedKey(key), true, 'Operation tried to escape the synthetic namespace');
  ownedKeys.add(key);
  return key;
}
function argumentsForScript(script, keys, args) {
  for (const item of keys) {
    if (item === 'users:list') {
      assert.equal(args.some(value => ownedUsers.has(value)), true, 'A user index operation needs an owned member');
    } else if (item === 'invites:active') {
      assert.equal(ownedCodes.has(args[0]), true, 'An invite index operation needs an owned code');
      assert.equal(ownedUsers.has(args[1]), true, 'An invite operation needs an owned user');
    } else if (item === 'email:lookup:' || item === 'oidc:sub:') {
      // Account scripts pass unused sentinel keys for absent email/sub values.
      assert.equal(script.includes("return 'created'") || script.includes("return 'updated'"), true);
      if (item === 'oidc:sub:') assert.equal(args[4], '');
      if (item === 'email:lookup:') assert.equal(args[script.includes("return 'created'") ? 3 : 1], '');
    } else key(item);
  }
}

async function scanOwned(pattern) {
  const restricted = pattern.replace(/^u:\*:/, `u:${prefix}*:`);
  assert.equal(restricted.startsWith(`u:${prefix}`), true, 'Only synthetic user patterns may be scanned');
  const keys = [];
  let cursor = 0;
  do {
    const result = await raw.scan(cursor, { MATCH: restricted, COUNT: 100 });
    cursor = result.cursor;
    for (const item of result.keys) keys.push(key(item));
  } while (cursor !== 0);
  return keys;
}

const guarded = {
  get: item => raw.get(key(item)),
  set: (item, value) => raw.set(key(item), value),
  setEx: (item, seconds, value) => raw.setEx(key(item), seconds, value),
  ttl: item => raw.ttl(key(item)),
  hGet: (item, field) => raw.hGet(key(item), field),
  hGetAll: item => raw.hGetAll(key(item)),
  hSet: (item, ...args) => raw.hSet(key(item), ...args),
  mGet: items => raw.mGet(items.map(key)),
  del: items => raw.del((Array.isArray(items) ? items : [items]).map(key)),
  eval: (script, options) => {
    argumentsForScript(script, options.keys, options.arguments);
    return raw.eval(script, options);
  },
};

const load = createSourceLoader({ redis, nanoid: { customAlphabet: () => () => { throw new Error('Do not allocate untracked invite codes'); } }, './db': { db: { storage: { client: guarded } } } });
const { BaseRedisStorage } = load('redis-base.db.ts');
const { RedisAccountStorage, ACCOUNT_DELETE_LUA } = load('password-storage.ts');
const { RedisDataStorage, DATA_COPY_LEGACY_LUA } = load('redis-data-compat.ts');
const { hashPassword } = load('password.ts');
const { useInviteCode, releaseInviteCode } = load('invite-code.ts');
const storage = Object.create(BaseRedisStorage.prototype);
storage.client = guarded;
storage.withRetry = operation => operation();
storage.config = { clientName: 'Authorized isolated Kvrocks test' };
Object.defineProperty(storage, 'accountStorage', { get: () => new RedisAccountStorage({
  get: guarded.get, getInfo: guarded.hGetAll, scan: scanOwned,
  list: async () => Array.from(ownedUsers),
  eval: (script, keys, args) => guarded.eval(script, { keys, arguments: args }),
}) });
Object.defineProperty(storage, 'dataStorage', { get: () => new RedisDataStorage({
  hash: guarded.hGetAll, getMany: guarded.mGet, scan: scanOwned,
  eval: (script, keys, args) => guarded.eval(script, { keys, arguments: args }),
}) });
storage.clearAllData = () => { throw new Error('Global clear is forbidden in integration tests'); };

async function check(name, operation) {
  activeCase = name;
  await operation();
  passed++;
  process.stdout.write(`PASS ${passed}: ${name}\n`);
}

async function connect() {
  for (const host of [...new Set([config.host, config.alternateHost].filter(Boolean))]) {
    const client = redis.createClient({
      socket: { host, port: Number(config.port), connectTimeout: 3000, reconnectStrategy: false },
      password: config.password, disableOfflineQueue: true,
    });
    client.on('error', () => {});
    try {
      await client.connect();
      const timeout = setTimeout(() => client.disconnect(), 5000);
      try { assert.equal(await client.ping(), 'PONG'); } finally { clearTimeout(timeout); }
      raw = client;
      process.stdout.write(`Connected authorized Kvrocks test backend: ${host}\n`);
      return;
    } catch {
      if (client.isOpen) await client.disconnect();
    }
  }
  throw new Error('No authorized test host could be reached');
}

async function main() {
  await connect();
  await check('mixed passwords and metadata preservation', async () => {
    const sha = createHash('sha256').update('legacy-secret').digest('hex');
    const shapes = ['legacy-secret', sha, `sha256:${sha}`, hashPassword('legacy-secret').replace('scrypt:v1:', '')];
    for (let index = 0; index < shapes.length; index++) {
      const name = user(`shape${index}`);
      await guarded.set(`u:${name}:pwd`, shapes[index]);
      assert.equal(await storage.verifyUser(name, 'legacy-secret'), true);
      assert.match(await storage.getUserCredential(name), /^scrypt:v1:/);
    }
    const name = user('infoonly');
    await guarded.hSet(`u:${name}:info`, {
      password: sha, email: `${prefix}legacy@example.invalid`, pending: 'true', banned: 'true',
      source: 'isolated-test', created_at: '123', oidcSub: `${prefix}legacy-sub`,
    });
    assert.equal(await storage.getUsernameByEmail(`${prefix}legacy@example.invalid`), name);
    assert.equal(await storage.getUserByOidcSub(`${prefix}legacy-sub`), name);
    await assert.rejects(storage.registerUser(name, 'new-secret'), /已被注册/);
    assert.equal(await storage.verifyUserV2(name, 'legacy-secret'), true);
    const info = await storage.getUserInfoV2(name);
    assert.equal(info.pending, true);
    assert.equal(info.banned, true);
    assert.equal(info.createdAt, 123);
    await storage.changePassword(name, 'new-secret', {
      credential: await storage.getUserCredential(name), email: `${prefix}legacy@example.invalid`,
    });
    assert.equal(await storage.verifyUser(name, 'legacy-secret'), false);
    assert.equal(await storage.verifyUser(name, 'new-secret'), true);
  });

  await check('unique creation under concurrent email and OIDC requests', async () => {
    const names = [user('emailone'), user('emailtwo')];
    const results = await Promise.allSettled(names.map(name => storage.createUserV2(name, 'secret', 'user',
      undefined, `${prefix}${name.slice(prefix.length)}-sub`, undefined, `${prefix}same@example.invalid`)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const name = names[results.findIndex(result => result.status === 'fulfilled')];
    const sub = (await storage.getUserInfoV2(name)).oidcSub;
    await assert.rejects(storage.createUserV2(user('oidcduplicate'), 'secret', 'user', undefined, sub), /绑定其他账号/);
  });

  await check('conditional resets and one-time reset token consumption', async () => {
    const name = user('reset');
    await storage.registerUser(name, 'old-secret');
    const expected = { credential: await storage.getUserCredential(name) };
    const results = await Promise.allSettled([
      storage.changePassword(name, 'first-secret', expected), storage.changePassword(name, 'second-secret', expected),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ACCOUNT_CHANGED');
    await storage.setCache(`${prefix}reset-once`, { username: name }, 60);
    const tokens = await Promise.all(Array.from({ length: 12 }, () => storage.consumeCache(`${prefix}reset-once`)));
    assert.equal(tokens.filter(Boolean).length, 1);
    assert.equal(tokens.find(Boolean).username, name);
  });

  await check('deletion removes old bindings and cannot remove a recreated account on retry', async () => {
    const name = user('reused');
    await storage.createUserV2(name, 'secret', 'user', undefined, `${prefix}old-sub`, undefined, `${prefix}old@example.invalid`);
    const credential = await storage.getUserCredential(name);
    await guarded.set(`u:${name}:pr:legacy`, '{"title":"legacy"}');
    await storage.setPlayRecord(name, 'new', { title: 'new' });
    await storage.deleteUser(name);
    assert.equal(await storage.getUsernameByEmail(`${prefix}old@example.invalid`), null);
    assert.equal(await storage.getUserByOidcSub(`${prefix}old-sub`), null);
    await storage.createUserV2(name, 'secret', 'user', undefined, `${prefix}new-sub`);
    assert.notEqual(await storage.getUserCredential(name), credential);
    const result = await guarded.eval(ACCOUNT_DELETE_LUA, {
      keys: [`u:${name}:pwd`, `u:${name}:info`, `u:${name}:email`, 'users:list'],
      arguments: [name, '1', credential, '0', ''],
    });
    assert.equal(result, 0);
    assert.equal(await storage.checkUserExist(name), true);
    assert.equal(await storage.getPlayRecord(name, 'legacy'), null);
  });

  await check('restricted legacy migration is additive, resumable and deletion-safe', async () => {
    const name = user('migration');
    await storage.registerUser(name, 'secret');
    for (const kind of ['pr', 'fav', 'skip', 'episodeskip']) {
      await guarded.set(`u:${name}:${kind}:source+old`, '{"revision":1}');
      await guarded.set(`u:${name}:${kind}:source+both`, '{"revision":1}');
      await guarded.hSet(`u:${name}:${kind}`, 'source+both', '{"revision":2}');
    }
    const helper = storage.dataStorage;
    const first = await helper.migrate([name]);
    assert.equal(first.copied, 4);
    assert.equal(first.skipped, 4);
    assert.equal(first.retainedLegacy, true);
    assert.equal((await storage.getPlayRecord(name, 'source+both')).revision, 2);
    assert.equal((await helper.migrate([name])).copied, 0);
    assert.equal(await guarded.get(`u:${name}:pr:source+old`), '{"revision":1}');
    await storage.deletePlayRecord(name, 'source+old');
    assert.equal(await guarded.eval(DATA_COPY_LEGACY_LUA, {
      keys: [`u:${name}:pr`, `u:${name}:pr:source+old`], arguments: ['source+old'],
    }), -1);
    assert.equal(await storage.getPlayRecord(name, 'source+old'), null);
    await guarded.set(`u:${name}:fav:broken`, 'not-json');
    await assert.rejects(helper.migrate([name]), /Invalid legacy JSON/);
    assert.equal(await guarded.get(`u:${name}:fav:broken`), 'not-json');
    await guarded.set(`u:${name}:fav:broken`, '{"revision":3}');
    assert.equal((await helper.migrate([name])).copied, 1);
    await storage.deleteAllFavorites(name);
    assert.equal(Object.keys(await storage.getAllFavorites(name)).length, 0);
  });

  await check('invite final-slot concurrency, reservation idempotence and exact compensation', async () => {
    const code = `${codePrefix}INVITE`;
    ownedCodes.add(code);
    await guarded.hSet(`invite:${code}`, {
      code, createdBy: user('inviteowner'), createdAt: Date.now().toString(), maxUses: '1', currentUses: '0',
      expiresAt: (Date.now() + 600000).toString(), disabled: 'false',
    });
    ownedKeys.add(`invite:${code}:users`);
    await raw.sAdd('invites:active', code);
    const names = Array.from({ length: 10 }, (_, index) => user(`invite${index}`));
    const attempts = names.map(() => randomUUID());
    const results = await Promise.allSettled(names.map((name, index) => useInviteCode(code, name, attempts[index])));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    await useInviteCode(code, names[winner], attempts[winner]);
    assert.equal(await guarded.hGet(`invite:${code}`, 'currentUses'), '1');
    assert.equal(await releaseInviteCode(code, names[(winner + 1) % names.length], attempts[winner]), false);
    assert.equal(await releaseInviteCode(code, names[winner], randomUUID()), false);
    assert.equal(await releaseInviteCode(code, names[winner], attempts[winner]), true);
    assert.equal(await releaseInviteCode(code, names[winner], attempts[winner]), false);
    assert.equal(await guarded.hGet(`invite:${code}`, 'currentUses'), '0');
    await useInviteCode(code, user('inviteafterrefund'), randomUUID());
    assert.equal(await guarded.hGet(`invite:${code}`, 'currentUses'), '1');
  });
}

async function cleanup() {
  if (!raw?.isOpen) return;
  // Exact tracked keys only. Never clear or enumerate the user's database.
  for (const item of ownedKeys) await raw.del(item);
  for (const name of ownedUsers) await raw.zRem('users:list', name);
  for (const code of ownedCodes) await raw.sRem('invites:active', code);
  for (const item of ownedKeys) assert.equal(await raw.exists(item), 0);
  for (const name of ownedUsers) assert.equal(await raw.zScore('users:list', name), null);
  for (const code of ownedCodes) assert.equal(await raw.sIsMember('invites:active', code), false);
  process.stdout.write(`PASS cleanup: ${ownedKeys.size} exact synthetic keys and owned index members removed\n`);
}

main().catch(error => {
  // Do not print connection objects, credentials, or raw database replies.
  process.stderr.write(`FAIL ${activeCase} (${error.code || error.name || 'Error'})\n`);
  process.exitCode = 1;
}).finally(async () => {
  try { await cleanup(); } catch { process.stderr.write('FAIL exact synthetic cleanup\n'); process.exitCode = 1; }
  if (raw?.isOpen) await raw.quit();
  console.log = originalLog;
  process.stdout.write(`Kvrocks integration cases passed: ${passed}/6\n`);
});
