// Opt in with MIAOTV_REDIS_LUA_TESTS=1 and make fakeredis[lua] available to Python.
// Real node-redis and @upstash/redis clients exercise the Lua emulator over
// loopback TCP/HTTP. No application constructors, .env files or live DBs load.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { runNumericIdentityCases } = require('./numeric-identity-cases.cjs');

const enabled = process.env.MIAOTV_REDIS_LUA_TESTS === '1';
const dependency = name => require(process.env.MIAOTV_NODE_MODULES ? path.join(process.env.MIAOTV_NODE_MODULES, name) : name);

async function startFixture(t) {
  const python = spawn(process.env.MIAOTV_LUA_PYTHON || 'python', ['-u', path.join(__dirname, 'redis-lua-test-server.py')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  python.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { python.stdin.end(); python.kill(); });
  const lines = readline.createInterface({ input: python.stdout });
  const startup = new Promise((resolve, reject) => {
    lines.once('line', line => resolve(JSON.parse(line)));
    python.once('error', reject);
    python.once('exit', code => reject(new Error(`Lua test server exited (${code}): ${stderr}`)));
  });
  const timeout = setTimeout(() => python.kill(), 15000);
  const address = await startup.finally(() => clearTimeout(timeout));
  const redis = dependency('redis');
  const { Redis } = dependency('@upstash/redis');
  const raw = redis.createClient({ url: `redis://127.0.0.1:${address.port}`, socket: { reconnectStrategy: false } });
  raw.on('error', () => {});
  await raw.connect();
  t.after(() => { if (raw.isOpen) raw.disconnect(); });

  const encode = value => typeof value === 'string' && value !== 'OK'
    ? Buffer.from(value).toString('base64') : Array.isArray(value) ? value.map(encode) : value;
  const httpServer = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const execute = async command => {
      try {
        const result = await raw.sendCommand(command.map(String));
        return { result: request.headers['upstash-encoding'] === 'base64' ? encode(result) : result };
      } catch (error) {
        return { error: error.message };
      }
    };
    try {
      const command = JSON.parse(body);
      const result = Array.isArray(command[0]) ? await Promise.all(command.map(execute)) : await execute(command);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => { httpServer.closeAllConnections(); httpServer.close(); });
  const upstash = new Redis({
    url: `http://127.0.0.1:${httpServer.address().port}`, token: 'isolated-test',
    retry: { retries: 0 }, enableAutoPipelining: true,
  });
  const load = createSourceLoader({ redis, '@upstash/redis': { Redis } });
  const { BaseRedisStorage } = load('redis-base.db.ts');
  const { UpstashRedisStorage } = load('upstash.db.ts');
  const local = Object.create(BaseRedisStorage.prototype);
  local.client = raw;
  local.config = { clientName: 'Isolated Redis emulator' };
  local.withRetry = operation => operation();
  const remote = Object.create(UpstashRedisStorage.prototype);
  remote.client = upstash;
  return { raw, load, adapters: [['Redis/Kvrocks client', local], ['Upstash HTTP client', remote]] };
}

test('Redis/Upstash Lua compatibility against an isolated emulator', { skip: !enabled, timeout: 60000 }, async t => {
  const { raw, load, adapters } = await startFixture(t);
  const { hashPassword } = load('password.ts');
  const { ACCOUNT_DELETE_LUA, ACCOUNT_COMPARE_AND_SET_LUA } = load('password-storage.ts');
  const { DATA_COPY_LEGACY_LUA } = load('redis-data-compat.ts');
  const sha256 = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  for (const [name, storage] of adapters) {
    await t.test(`${name}: mixed legacy credentials, metadata, canonical precedence`, async () => {
      await raw.flushDb();
      await raw.hSet('u:legacy:info', { password: sha256('old-secret'), email: ' Old@Example.COM ', pending: 'true', source: 'friend', banned: 'true', created_at: '42', oidcSub: 'old-sub' });
      assert.equal(await storage.getUsernameByEmail('old@example.com'), 'legacy');
      assert.equal(await storage.getUserByOidcSub('old-sub'), 'legacy');
      await assert.rejects(storage.registerUser('legacy', 'replacement'), /已被注册/);
      assert.equal(await storage.verifyUser('legacy', sha256('old-secret')), false);
      assert.equal(await storage.verifyUserV2('legacy', 'old-secret'), true);
      assert.match(await raw.get('u:legacy:pwd'), /^scrypt:v1:/);
      assert.equal(await raw.hGet('u:legacy:info', 'password'), null);
      const info = await storage.getUserInfoV2('legacy');
      assert.equal(info.pending, true);
      assert.equal(info.banned, true);
      assert.equal(info.source, 'friend');
      assert.equal(info.createdAt, 42);
      assert.equal(info.email, 'old@example.com');
      await raw.hSet('u:legacy:info', 'password', sha256('stale-secret'));
      assert.equal(await storage.verifyUserV2('legacy', 'stale-secret'), false);
      await storage.changePassword('legacy', 'reset-secret', {
        credential: await storage.getUserCredential('legacy'), email: 'old@example.com',
      });
      assert.equal(await storage.verifyUser('legacy', 'old-secret'), false);
      assert.equal(await storage.verifyUser('legacy', 'reset-secret'), true);
    });

    await t.test(`${name}: atomic creation and duplicate identities`, async () => {
      await raw.flushDb();
      const attempts = await Promise.allSettled([
        storage.createUserV2('one', 'first-secret', 'user', ['group'], 'one-sub', ['api'], 'same@example.com', { pending: true, source: 'friend', createdAt: 10 }),
        storage.createUserV2('two', 'second-secret', 'user', undefined, 'two-sub', undefined, ' SAME@example.com '),
      ]);
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      const users = await storage.getAllUsers();
      assert.equal(users.length, 1);
      assert.equal(await storage.getUsernameByEmail('same@example.com'), users[0]);
      const sub = (await storage.getUserInfoV2(users[0])).oidcSub;
      await assert.rejects(storage.createUserV2('third', 'secret', 'user', undefined, sub), /绑定其他账号/);
      await raw.set('email:lookup:stale@example.com', 'deleted');
      await raw.set('oidc:sub:orphan-sub', 'deleted');
      await storage.createUserV2('reclaimed', 'secret', 'user', undefined, 'orphan-sub', undefined, 'stale@example.com');
      assert.equal(await storage.getUserByOidcSub('orphan-sub'), 'reclaimed');
      await raw.set('u:newname:email', 'orphan@example.com');
      await raw.set('email:lookup:orphan@example.com', 'newname');
      await storage.registerUser('newname', 'secret');
      assert.equal(await storage.getUserEmail('newname'), null);
      assert.equal(await raw.get('email:lookup:orphan@example.com'), null);
    });

    await t.test(`${name}: concurrent conditional reset and one-time token consumption`, async () => {
      await raw.flushDb();
      await storage.registerUser('reset', 'original-secret', 'reset@example.com');
      const expected = { credential: await storage.getUserCredential('reset'), email: 'reset@example.com' };
      const changes = await Promise.allSettled([
        storage.changePassword('reset', 'first-secret', expected),
        storage.changePassword('reset', 'second-secret', expected),
      ]);
      assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(changes.find(result => result.status === 'rejected').reason.code, 'ACCOUNT_CHANGED');
      await storage.setCache('password_reset:once', { username: 'reset' }, 60);
      const tokens = await Promise.all(Array.from({ length: 12 }, () => storage.consumeCache('password_reset:once')));
      assert.equal(tokens.filter(Boolean).length, 1);
      assert.equal(tokens.find(Boolean).username, 'reset');
      assert.equal(await storage.getCache('password_reset:once'), null);
      for (const value of [false, 0, '']) {
        await storage.setCache('falsy-value', value);
        assert.equal(await storage.getCache('falsy-value'), value);
        assert.equal(await storage.consumeCache('falsy-value'), value);
        assert.equal(await storage.consumeCache('falsy-value'), null);
      }
    });

    await t.test(`${name}: deletion clears both data layouts and old email/OIDC bindings`, async () => {
      await raw.flushDb();
      await storage.createUserV2('reused', 'secret', 'user', undefined, 'old-sub', undefined, 'old@example.com');
      const oldCredential = await storage.getUserCredential('reused');
      await raw.set('u:reused:pr:old', '{"title":"old"}');
      await storage.setPlayRecord('reused', 'new', { title: 'new' });
      await storage.setFavorite('reused', 'new', { title: 'favorite' });
      await raw.set('u:reused:emby-config', '{"url":"test"}');
      await storage.deleteUser('reused');
      assert.deepEqual(await raw.keys('u:reused:*'), []);
      assert.equal(await raw.get('oidc:sub:old-sub'), null);
      assert.equal(await raw.get('email:lookup:old@example.com'), null);
      await storage.createUserV2('reused', 'secret', 'user', undefined, 'new-sub');
      assert.notEqual(await storage.getUserCredential('reused'), oldCredential);
      assert.equal(await storage.getUserByOidcSub('old-sub'), null);
      const retried = await raw.eval(ACCOUNT_DELETE_LUA, {
        keys: ['u:reused:pwd', 'u:reused:info', 'u:reused:email', 'users:list'],
        arguments: ['reused', '1', oldCredential, '0', ''],
      });
      assert.equal(retried, 0);
      assert.equal(await storage.checkUserExist('reused'), true);
    });

    await t.test(`${name}: mixed reads, explicit migration, retry and deletion never resurrect data`, async () => {
      await raw.flushDb();
      const user = 'legacy[1]';
      await storage.registerUser(user, 'secret');
      for (const kind of ['pr', 'fav', 'skip', 'episodeskip']) {
        await raw.set(`u:${user}:${kind}:source+old`, JSON.stringify({ title: kind, revision: 1 }));
        await raw.set(`u:${user}:${kind}:source+both`, JSON.stringify({ title: kind, revision: 1 }));
        await raw.hSet(`u:${user}:${kind}`, 'source+both', JSON.stringify({ title: kind, revision: 2 }));
      }
      assert.equal((await storage.getPlayRecord(user, 'source+old')).revision, 1);
      assert.equal((await storage.getFavorite(user, 'source+both')).revision, 2);
      assert.equal((await storage.getSkipConfig(user, 'source', 'old')).revision, 1);
      assert.equal((await storage.getEpisodeSkipConfig(user, 'source', 'old')).revision, 1);
      assert.equal(Object.keys(await storage.getAllPlayRecords(user)).length, 2);
      assert.equal(Object.keys(await storage.getAllFavorites(user)).length, 2);
      const first = await storage.migrateData();
      assert.equal(first.copied, 4);
      assert.equal(first.skipped, 4);
      assert.equal(first.retainedLegacy, true);
      assert.equal((await raw.keys(`u:legacy\\[1\\]:pr:*`)).length, 2);
      const second = await storage.migrateData();
      assert.equal(second.copied, 0);
      assert.equal(second.skipped, 8);
      await storage.deletePlayRecord(user, 'source+old');
      await storage.deleteFavorite(user, 'source+old');
      await storage.deleteSkipConfig(user, 'source', 'old');
      await storage.deleteEpisodeSkipConfig(user, 'source', 'old');
      await storage.migrateData();
      assert.equal(await storage.getPlayRecord(user, 'source+old'), null);
      assert.equal(await storage.getFavorite(user, 'source+old'), null);
      assert.equal(await storage.getSkipConfig(user, 'source', 'old'), null);
      assert.equal(await storage.getEpisodeSkipConfig(user, 'source', 'old'), null);
      await storage.deleteAllPlayRecords(user);
      await storage.deleteAllFavorites(user);
      assert.equal(Object.keys(await storage.getAllPlayRecords(user)).length, 0);
      assert.equal(Object.keys(await storage.getAllFavorites(user)).length, 0);
      assert.equal(await raw.get(`u:${user}:pr:source+both`), null);
    });

    await t.test(`${name}: partial migration fails visibly, preserves sources, and is resumable`, async () => {
      await raw.flushDb();
      await storage.registerUser('partial', 'secret');
      await raw.set('u:partial:pr:first', '{"title":"first"}');
      await raw.set('u:partial:fav:broken', 'not-json');
      await assert.rejects(storage.migrateData(), /Invalid legacy JSON/);
      assert.equal(await raw.get('u:partial:pr:first'), '{"title":"first"}');
      assert.equal(await raw.get('u:partial:fav:broken'), 'not-json');
      assert.equal((await storage.getPlayRecord('partial', 'first')).title, 'first');
      await raw.set('u:partial:fav:broken', '{"title":"fixed"}');
      const retried = await storage.migrateData();
      assert.equal(retried.skipped, 1);
      assert.equal(retried.copied, 1);
      await storage.deletePlayRecord('partial', 'first');
      const staleCopy = await raw.eval(DATA_COPY_LEGACY_LUA, {
        keys: ['u:partial:pr', 'u:partial:pr:first'], arguments: ['first'],
      });
      assert.equal(staleCopy, -1);
      assert.equal(await storage.getPlayRecord('partial', 'first'), null);
    });
  }

  await t.test('a Lua CAS cannot overwrite a reset or re-create a deleted legacy account', async () => {
    await raw.flushDb();
    const legacy = sha256('old-secret');
    await raw.hSet('u:race:info', { password: legacy, role: 'user' });
    const replacement = hashPassword('new-secret');
    await raw.set('u:race:pwd', replacement);
    const snapshotArgs = ['0', '', '1', legacy, hashPassword('old-secret'), '1', 'race'];
    assert.equal(await raw.eval(ACCOUNT_COMPARE_AND_SET_LUA, {
      keys: ['u:race:pwd', 'u:race:info', 'users:list'], arguments: snapshotArgs,
    }), 0);
    await raw.del(['u:race:pwd', 'u:race:info']);
    assert.equal(await raw.eval(ACCOUNT_COMPARE_AND_SET_LUA, {
      keys: ['u:race:pwd', 'u:race:info', 'users:list'], arguments: snapshotArgs,
    }), 0);
    assert.equal(await raw.get('u:race:pwd'), null);
  });
});

test('persistent UID registry and facade use real Lua for Redis/Kvrocks and Upstash', { skip: !enabled, timeout: 60000 }, async t => {
  const { raw, load, adapters } = await startFixture(t);
  const { createIdentityStorage } = load('identity-facade.ts');
  const { IDENTITY_REGISTRY_KEY } = load('identity-storage.ts');
  for (const [name, backend] of adapters) {
    await t.test(name, async () => {
      await raw.flushDb();
      await backend.createUserV2('legacy', 'fixture-password', 'admin', ['group'], 'oidc-sub', ['source'], 'legacy@example.com');
      await raw.set('u:legacy:pr:source+old', JSON.stringify({ title: 'flat legacy record' }));
      await backend.setFavorite('legacy', 'source+movie', { title: 'favorite' });
      const wrap = () => createIdentityStorage(backend, () => 'admin');
      const storage = wrap();
      const attempts = await Promise.all(Array.from({ length: 8 }, () => wrap().getUserIdentity('legacy')));
      assert.equal(new Set(attempts.map(identity => identity.uid)).size, 1);
      const identity = attempts[0];
      assert.equal(identity.storageKey, 'legacy');
      assert.equal(await raw.hGet(IDENTITY_REGISTRY_KEY, 'n:legacy'), identity.uid);
      const credential = await storage.getUserCredential(identity.uid);
      const renamed = await storage.renameUser(identity.uid, '改名之后', 'legacy');
      assert.equal(renamed.sessionVersion, identity.sessionVersion + 1);
      assert.equal(await storage.getUserCredential(identity.uid), credential);
      assert.equal(await storage.getUsernameByEmail('legacy@example.com'), '改名之后');
      assert.equal(await storage.getUserByOidcSub('oidc-sub'), '改名之后');
      assert.equal((await storage.getPlayRecord(identity.uid, 'source+old')).title, 'flat legacy record');
      await storage.registerUser('legacy', 'replacement-password');
      const replacement = await storage.getUserIdentity('legacy');
      assert.notEqual(identity.uid, replacement.uid);
      assert.equal(replacement.storageKey, `uid:${replacement.uid}`);
      assert.equal(Object.keys(await storage.getAllFavorites(replacement.uid)).length, 0);
      await storage.setPlayRecord(identity.uid, 'source+inflight', { title: 'same original user' });
      assert.equal(Object.keys(await storage.getAllPlayRecords(replacement.uid)).length, 0);
      assert.deepEqual((await wrap().getAllUsers()).sort(), ['admin', 'legacy', '改名之后'].sort());
      await assert.rejects(storage.renameUser(identity.uid, 'legacy'), error => error.code === 'USERNAME_EXISTS');
      await assert.rejects(storage.renameUser(identity.uid, 'valid', 'legacy'), error => error.code === 'STALE_USERNAME');
      await backend.setAdminConfig({ UserConfig: { Users: [{ username: 'legacy', role: 'admin', tvboxToken: 'fixture-token' }] } });
      const restoredProfile = (await storage.getAdminConfig()).UserConfig.Users[0];
      assert.equal(restoredProfile.uid, identity.uid);
      assert.equal(restoredProfile.username, '改名之后');
      assert.equal(restoredProfile.tvboxToken, 'fixture-token');
      const owner = await storage.getUserIdentity('admin');
      await storage.setFavorite(owner.uid, 'source+movie', { title: 'owner data' });
      await storage.deleteUser(identity.uid);
      assert.equal(await wrap().getUserIdentityByUid(identity.uid), null);
      assert.equal(await storage.isLegacyUsernameRetired('legacy'), true);
      assert.equal((await storage.getUserIdentity('legacy')).uid, replacement.uid);
      await storage.clearAllData();
      assert.equal(await storage.getUserIdentityByUid(owner.uid), null);
      assert.equal(await backend.getFavorite(owner.storageKey, 'source+movie'), null);
      assert.equal(await raw.type(IDENTITY_REGISTRY_KEY), 'hash', 'cache/data reset retains namespace retirement markers');
      assert.notEqual((await wrap().getUserIdentity('admin')).uid, owner.uid);
      const restore = () => storage.createUserV2('restored', 'fixture-password', 'user', [], undefined, [], undefined, { uid: identity.uid });
      await restore();
      const firstRestore = await storage.getUserIdentity('restored');
      await storage.clearAllData();
      await restore();
      const secondRestore = await storage.getUserIdentity('restored');
      assert.equal(secondRestore.uid, identity.uid);
      assert.notEqual(secondRestore.storageKey, firstRestore.storageKey);
      assert.ok(secondRestore.sessionVersion > firstRestore.sessionVersion);
      const creations = await Promise.allSettled(Array.from({ length: 5 }, () => wrap().registerUser('claim', 'fixture-password')));
      assert.equal(creations.filter(result => result.status === 'fulfilled').length, 1);
    });
  }
});

test('numeric UID migration, aliases and counters use real Redis/Kvrocks and Upstash Lua', { skip: !enabled, timeout: 60000 }, async t => {
  const { raw, load, adapters } = await startFixture(t);
  const { createIdentityStorage } = load('identity-facade.ts');
  const { IDENTITY_REGISTRY_KEY } = load('identity-storage.ts');
  for (const [name, backend] of adapters) {
    await t.test(name, async t => {
      await runNumericIdentityCases(t, async () => {
        await raw.flushDb();
        return {
          raw: backend,
          wrap: () => createIdentityStorage(backend, () => 'admin'),
          seed: values => raw.hSet(IDENTITY_REGISTRY_KEY, values),
          snapshot: () => raw.hGetAll(IDENTITY_REGISTRY_KEY),
        };
      });
    });
  }
});
