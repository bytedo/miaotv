const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const { createSourceLoader } = require('../../../lib/__tests__/storage-test-loader.cjs');

process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
process.env.PASSWORD = 'proxy-test-signing-key';
process.env.USERNAME = 'fixture-owner';
delete process.env.TRUSTED_NETWORK_IPS;
delete process.env.TRUST_PROXY_HEADERS;

class TestRequest extends Request {
  constructor(input, init) {
    super(input, init);
    this.nextUrl = new URL(this.url);
    this.cookies = { get: (name) => {
      const entry = (this.headers.get('cookie') || '').split(';').map((value) => value.trim()).find((value) => value.startsWith(name + '='));
      return entry ? { value: entry.slice(name.length + 1) } : undefined;
    } };
  }
}
class TestResponse extends Response {
  constructor(body, init) { super(body, init); const values = new Map(); this.cookies = { set: (name, value, options) => values.set(name, { name, value, ...options }), get: (name) => values.get(name) }; }
  static next(init = {}) { const response = new TestResponse(); response.forwarded = init.request?.headers; return response; }
  static rewrite(url, init = {}) { const response = TestResponse.next(init); response.headers.set('x-rewrite', String(url)); return response; }
  static redirect(url) { return new TestResponse(null, { status: 307, headers: { location: String(url) } }); }
}
function cookie(username, fields = {}) {
  return 'user_auth=' + encodeURIComponent(JSON.stringify({ username, role: 'user', signature: createHmac('sha256', process.env.PASSWORD).update(username).digest('hex'), ...fields }));
}
function request(url = '/', { username, headers = {}, method = 'GET', body } = {}) {
  return new TestRequest(new URL(url, 'https://miaotv.test'), { method, headers: { ...(username ? { cookie: cookie(username) } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function fixture() {
  const users = new Map([['alice', { username: 'alice', role: 'user' }], ['manager', { username: 'manager', role: 'admin' }]]);
  const config = {
    UserConfig: { Users: [...users.values()].map((user) => ({ ...user })) },
    SiteConfig: {}, SourceConfig: [],
    TrustedNetworkConfig: { enabled: true, trustedIPs: ['192.168.5.0/24', '2001:db8:1::/48'] },
    LiveConfig: [{ key: 'local/a&b', url: 'http://192.168.5.2:8096/playlist.m3u', ua: 'FixturePlayer' }, { key: 'disabled', url: 'https://media.test/list', disabled: true }],
  };
  const state = { users, config, fetches: [], replies: [], saves: 0, sites: [{ key: 'allowed', api: 'https://cms.test/api.php' }] };
  const cfg = { getConfig: async () => config, getAvailableApiSites: async () => state.sites, getCacheTime: async () => 10, clearConfigCache() {} };
  for (const user of users.values()) user.uid = `uid:${user.username}`;
  function usernameFor(ref) { return [...users.values()].find((user) => user.uid === ref)?.username || ref; }
  function identityFor(name) {
    if (name === process.env.USERNAME) return { uid: 'uid:owner', username: name, storageKey: name };
    const user = users.get(name); return user ? { uid: user.uid, username: user.username, storageKey: user.username } : null;
  }
  const db = {
    getUserIdentity: async (name) => identityFor(name),
    getUserIdentityByUid: async (uid) => uid === 'uid:owner' ? identityFor(process.env.USERNAME) : identityFor(usernameFor(uid)),
    isLegacyUsernameRetired: async () => false,
    getUserInfoV2: async (ref) => users.get(usernameFor(ref)) || null,
    checkUserExist: async (ref) => users.has(usernameFor(ref)),
    saveAdminConfig: async () => { state.saves++; },
  };
  const source = createSourceLoader({ 'cacheable-lookup': class { async lookupAsync() { return [{ address: '8.8.8.8', family: 4 }]; } } });
  const security = source('proxy-security.ts');
  const overrides = {
    'next/server': { NextRequest: TestRequest, NextResponse: TestResponse },
    './config': cfg, '@/lib/config': cfg, './db': { db }, '@/lib/db': { db },
    '@/lib/video-cache': { isVideoCached: async () => false },
    '@/lib/proxy-security': { ...security, fetchWithValidatedRedirects: async (url, init, options) => {
      await security.validateProxyTargetUrl(url, options);
      state.fetches.push({ url, init, options });
      const reply = state.replies.shift();
      if (!reply) throw new Error('Unexpected outbound request');
      const response = new Response(reply.body || null, { status: reply.status || 200, headers: reply.headers });
      Object.defineProperty(response, 'url', { value: reply.url || url });
      return response;
    } },
  };
  const load = createSourceLoader(overrides);
  return { state, load, route: (name) => load(path.resolve(__dirname, '..', name, 'route.ts')), proxy: () => load(path.resolve(__dirname, '../../../proxy.ts')).proxy };
}

test('public login/download/reset/OIDC pages remain open, and Telegram/cache/log prefixes are not broadly opened', async () => {
  const f = fixture();
  const proxy = f.proxy();
  for (const page of ['/download', '/forgot-password', '/reset-password?token=x', '/oidc-register', '/api/forgot-password']) assert.equal((await proxy(request(page))).status, 200, page);
  for (const endpoint of ['/api/telegram/send-magic-link', '/api/telegram/webhook', '/api/telegram/verify', '/api/cache/private', '/api/client-log']) assert.equal((await proxy(request(endpoint))).status, 401, endpoint);
});

test('simple passwords require explicit loopback development opt-in and still require authentication', async (t) => {
  const keys = ['NODE_ENV', 'PASSWORD', 'MIAOTV_ALLOW_WEAK_DEV_PASSWORD'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const proxy = fixture().proxy();
  const scenarios = [
    ['development', 'true', 'http://127.0.0.1:3000', '123456', true],
    ['development', 'true', 'http://localhost:3000', '123456', true],
    ['development', 'true', 'http://[::1]:3000', '123456', true],
    ['development', undefined, 'http://127.0.0.1:3000', '123456', false],
    ['development', 'false', 'http://127.0.0.1:3000', '123456', false],
    ['development', 'true', 'https://miaotv.test', '123456', false],
    ['development', 'true', 'http://192.168.0.6:3000', '123456', false],
    ['production', 'true', 'http://127.0.0.1:3000', '123456', false],
    ['test', 'true', 'http://127.0.0.1:3000', '123456', false],
    ['development', 'true', 'http://127.0.0.1:3000', '', false],
  ];
  for (const [nodeEnv, optIn, origin, password, allowed] of scenarios) {
    process.env.NODE_ENV = nodeEnv;
    process.env.PASSWORD = password;
    if (optIn === undefined) delete process.env.MIAOTV_ALLOW_WEAK_DEV_PASSWORD;
    else process.env.MIAOTV_ALLOW_WEAK_DEV_PASSWORD = optIn;
    const label = JSON.stringify([nodeEnv, optIn, origin, password]);
    const authenticated = await proxy(request(origin + '/', { username: 'fixture-owner' }));
    assert.equal(authenticated.status, allowed ? 200 : 307, label);
    if (allowed) {
      const anonymous = await proxy(request(origin + '/'));
      assert.equal(new URL(anonymous.headers.get('location')).pathname, '/login', label);
      assert.equal((await proxy(request(origin + '/api/admin/site'))).status, 401, label);
    } else {
      const warning = new URL(authenticated.headers.get('location'));
      assert.equal(warning.pathname, '/warning', label);
      assert.equal(warning.searchParams.get('reason'), password ? 'weak-password' : null, label);
    }
  }
});

test('proxy checks stored account state and role instead of forged network or owner flags', async () => {
  const f = fixture();
  const proxy = f.proxy();
  const forged = 'user_auth=' + encodeURIComponent(JSON.stringify({ username: 'fixture-owner', role: 'owner', trustedNetwork: true }));
  assert.equal((await proxy(request('/api/admin/site', { headers: { cookie: forged } }))).status, 401);
  assert.equal((await proxy(request('/api/admin/site', { headers: { cookie: cookie('alice', { role: 'owner' }) } }))).status, 403);
  assert.equal((await proxy(request('/api/admin/site', { username: 'manager' }))).status, 200);
  f.state.users.get('alice').pending = true;
  assert.equal((await proxy(request('/api/search', { username: 'alice' }))).status, 403);
});

test('network access is checked on each request, requires an explicitly trusted ingress, and never supplies an account', async (t) => {
  const f = fixture();
  const proxy = f.proxy();
  const headers = { 'x-forwarded-for': '192.168.5.8', cookie: 'user_auth=' + encodeURIComponent(JSON.stringify({ username: 'fixture-owner', trustedNetwork: true })) };
  assert.equal((await proxy(request('/api/search', { headers }))).status, 401);
  process.env.TRUST_PROXY_HEADERS = 'true';
  t.after(() => delete process.env.TRUST_PROXY_HEADERS);
  const browse = await proxy(request('/api/search', { headers }));
  assert.equal(browse.status, 200);
  assert.equal(browse.forwarded.get('cookie').includes('user_auth'), false);
  assert.equal((await proxy(request('/api/admin/site', { headers }))).status, 401);
  assert.equal((await proxy(request('/api/favorites', { headers, method: 'POST', body: {} }))).status, 401);
  assert.equal((await proxy(request('/api/search', { headers: { ...headers, 'x-forwarded-for': '8.8.8.8' } }))).status, 401);
});

test('source policy rejects disabled sources and grants private origin only for an authenticated configured source', async () => {
  const f = fixture();
  const policies = f.load('proxy-source.ts');
  await assert.rejects(policies.getMediaProxyPolicy(request(), 'local/a&b'), (error) => error.status === 401);
  await assert.rejects(policies.getMediaProxyPolicy(request('/', { username: 'alice' }), 'disabled'), (error) => error.status === 404);
  const policy = await policies.getMediaProxyPolicy(request('/', { username: 'alice' }), 'local/a&b');
  assert.deepEqual(policy.allowedPrivateOrigins, ['http://192.168.5.2:8096']);
  assert.equal(policy.userAgent, 'FixturePlayer');
  await assert.rejects(policies.getCMSProxyPolicy(request('/', { username: 'alice' }), 'https://other.test/api.php'), (error) => error.status === 403);
  await policies.getCMSProxyPolicy(request('/', { username: 'alice' }), 'https://cms.test/api.php?ac=detail');
});

test('HLS rewriting preserves source/referer and signed URLs for nested playlists, keys and segments', async () => {
  const f = fixture();
  const manifest = '#EXTM3U\n# 注释\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PART:URI="part.m4s"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8?sig=%2Fabc\nseg.ts?sig=%2Fxyz\n';
  f.state.replies.push({ body: manifest, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, url: 'https://media.test/path/master.m3u8' });
  const params = new URLSearchParams({ url: 'https://media.test/path/master.m3u8?sig=%2Ftop', 'moontv-source': 'local/a&b', referer: 'https://origin.test/player' });
  const response = await f.route('proxy/m3u8').GET(request('/api/proxy/m3u8?' + params, { username: 'alice' }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
  const urls = text.match(/\/api\/proxy\/(?:m3u8|key|segment)\?[^"\r\n]+/g);
  assert.equal(urls.length, 6);
  for (const value of urls) {
    const url = new URL(value, 'https://miaotv.test');
    assert.equal(url.searchParams.get('moontv-source'), 'local/a&b');
    assert.equal(url.searchParams.get('referer'), 'https://origin.test/player');
  }
  assert.equal(f.state.fetches[0].url, 'https://media.test/path/master.m3u8?sig=%2Ftop');
  assert.ok(urls.some((value) => new URL(value, 'https://miaotv.test').searchParams.get('url').endsWith('sig=%2Fabc')));
});

test('segment proxy forwards Range and source request headers, preserving 206', async () => {
  const f = fixture();
  f.state.replies.push({ body: 'abc', status: 206, headers: { 'content-type': 'video/mp2t', 'content-range': 'bytes 1-3/10' } });
  const params = new URLSearchParams({ url: 'https://media.test/seg.ts', 'moontv-source': 'local/a&b', referer: 'https://origin.test/player' });
  const response = await f.route('proxy/segment').GET(request('/api/proxy/segment?' + params, { username: 'alice', headers: { range: 'bytes=1-3' } }));
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'abc');
  assert.equal(f.state.fetches[0].init.headers.Range, 'bytes=1-3');
  assert.equal(f.state.fetches[0].init.headers.Referer, 'https://origin.test/player');
  assert.equal(response.headers.get('content-range'), 'bytes 1-3/10');
});

test('HLS resolves extensionless redirected playlists, query-only URLs and variables against the final resource', async () => {
  const f = fixture();
  const manifest = '#EXTM3U\n#EXT-X-DEFINE:NAME="quality",VALUE="hd"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="banana/audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\n{$quality}/variant.m3u8\n?segment=1&sig=%2Fxyz\n';
  f.state.replies.push({ body: manifest, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, url: 'https://media.test/path/manifest?sig=top' });
  const response = await f.route('proxy/m3u8').GET(request('/api/proxy/m3u8?url=https%3A%2F%2Fmedia.test%2Foriginal', { username: 'alice' }));
  const content = await response.text();
  const urls = content.match(/\/api\/proxy\/(?:m3u8|segment)\?[^"\r\n]+/g).map(value => new URL(value, 'https://miaotv.test').searchParams.get('url'));
  assert.deepEqual(urls, [
    'https://media.test/path/banana/audio.m3u8',
    'https://media.test/path/hd/variant.m3u8',
    'https://media.test/path/manifest?segment=1&sig=%2Fxyz',
  ]);
});

test('M3U8 passthrough keeps the upstream stream open until the client consumes or cancels it', async () => {
  const f = fixture();
  let controller;
  let cancelled = false;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  f.state.replies.push({ body, headers: { 'content-type': 'video/mp4' } });
  const response = await f.route('proxy/m3u8').GET(request('/api/proxy/m3u8?url=https%3A%2F%2Fmedia.test%2Fstream', { username: 'alice' }));
  assert.equal(cancelled, false);
  controller.enqueue(new TextEncoder().encode('video'));
  controller.close();
  assert.equal(await response.text(), 'video');
});

test('segment streaming respects downstream backpressure and propagates cancellation once', async () => {
  const f = fixture();
  let pulls = 0;
  let cancels = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(32768));
      if (pulls === 100) controller.close();
    },
    cancel() { cancels++; },
  });
  f.state.replies.push({ body, headers: { 'content-type': 'video/mp2t' } });
  const response = await f.route('proxy/segment').GET(request('/api/proxy/segment?url=https%3A%2F%2Fmedia.test%2Fseg.ts', { username: 'alice' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(pulls <= 4, `read ${pulls} chunks before the downstream consumed data`);
  await response.body.cancel('client disconnected');
  assert.equal(cancels, 1);
});

test('private key and logo caches cannot bypass current source or network-principal authorization', async (t) => {
  process.env.TRUST_PROXY_HEADERS = 'true';
  t.after(() => delete process.env.TRUST_PROXY_HEADERS);
  for (const name of ['key', 'logo']) {
    const f = fixture();
    const endpoint = f.route('proxy/' + name);
    const params = new URLSearchParams({ url: 'http://192.168.5.2:8096/' + name, 'moontv-source': 'local/a&b' });
    f.state.replies.push({ body: 'private', headers: { 'content-type': name === 'key' ? 'application/octet-stream' : 'image/png' } });
    assert.equal((await endpoint.GET(request('/api/proxy/' + name + '?' + params, { username: 'alice' }))).status, 200);
    assert.equal((await endpoint.GET(request('/api/proxy/' + name + '?' + params, { headers: { 'x-forwarded-for': '192.168.5.8' } }))).status, 403);
    f.state.config.LiveConfig[0].url = 'https://new-source.test/list';
    assert.equal((await endpoint.GET(request('/api/proxy/' + name + '?' + params, { username: 'alice' }))).status, 403);
    assert.equal(f.state.fetches.length, 1);
  }
});

test('live channels enforce account/source authorization before cold and warm cache reads', async (t) => {
  const f = fixture();
  const endpoint = f.route('live/channels');
  const path = '/api/live/channels?source=local%2Fa%26b';
  assert.equal((await endpoint.GET(request(path))).status, 401);
  f.state.replies.push({ body: '#EXTM3U\n#EXTINF:-1 tvg-id="one",Channel\nhttp://192.168.5.2:8096/live.m3u8\n' });
  const response = await endpoint.GET(request(path, { username: 'alice' }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /^private/);
  assert.equal((await response.json()).data.length, 1);
  process.env.TRUST_PROXY_HEADERS = 'true';
  t.after(() => delete process.env.TRUST_PROXY_HEADERS);
  assert.equal((await endpoint.GET(request(path, { headers: { 'x-forwarded-for': '192.168.5.8' } }))).status, 403);
  f.state.config.LiveConfig[0].disabled = true;
  assert.equal((await endpoint.GET(request(path, { username: 'alice' }))).status, 404);
  assert.equal(f.state.fetches.length, 1);
});

test('TVBox live indirection cannot grant a private origin supplied by a public playlist', async () => {
  for (const withConfiguredEpg of [false, true]) {
    const f = fixture();
    f.state.config.LiveConfig[0].url = 'https://media.test/list.json';
    f.state.config.LiveConfig[0].isTvBox = true;
    if (withConfiguredEpg) f.state.config.LiveConfig[0].epg = 'http://192.168.9.2/guide.xml';
    f.state.replies.push({ body: JSON.stringify({ lives: [{ url: 'http://192.168.9.2/list.m3u' }] }) });
    const response = await f.route('live/channels').GET(request('/api/live/channels?source=local%2Fa%26b', { username: 'alice' }));
    assert.equal(response.status, 404);
    assert.equal(f.state.fetches.length, 1);
  }
});

test('only the explicitly configured EPG origin can extend an authenticated live-source grant', async () => {
  for (const explicitlyConfigured of [false, true]) {
    const f = fixture();
    const epgUrl = 'http://192.168.9.2/guide.xml';
    if (explicitlyConfigured) f.state.config.LiveConfig[0].epg = epgUrl;
    f.state.replies.push({ body: `#EXTM3U x-tvg-url="${epgUrl}"\n#EXTINF:-1 tvg-id="one",Channel\nhttp://192.168.5.2:8096/live.m3u8\n` });
    if (explicitlyConfigured) f.state.replies.push({ body: '<tv>\n<channel id="one"><display-name>Channel</display-name></channel>\n<programme channel="one" start="20260919000000" stop="20260919010000"><title>Fixture programme</title></programme>\n</tv>\n' });
    const response = await f.route('live/epg').GET(request('/api/live/epg?source=local%2Fa%26b&tvgId=one', { username: 'alice' }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.programs.length, explicitlyConfigured ? 1 : 0);
    assert.equal(f.state.fetches.length, explicitlyConfigured ? 2 : 1);
  }
});

test('live precheck cancels upstream error bodies and preserves explicit referer and the byte probe', async () => {
  const f = fixture();
  let cancelled = false;
  f.state.replies.push({ status: 403, body: new ReadableStream({ cancel() { cancelled = true; } }) });
  const params = new URLSearchParams({ url: 'https://media.test/live', 'moontv-source': 'local/a&b', referer: 'https://origin.test/player' });
  const response = await f.route('live/precheck').GET(request('/api/live/precheck?' + params, { username: 'alice' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, false);
  assert.equal(cancelled, true);
  assert.equal(f.state.fetches[0].init.headers.Range, 'bytes=0-2047');
  assert.equal(f.state.fetches[0].init.headers.Referer, 'https://origin.test/player');
});

test('public merged subscriptions fetch public configured playlists without granting anonymous private access', async () => {
  for (const username of [undefined, 'alice']) {
    const f = fixture();
    f.state.config.LiveConfig.push({ key: 'public', name: 'Public', url: 'https://media.test/list.m3u' });
    if (username) f.state.replies.push({ body: '#EXTM3U\n#EXTINF:-1,Private Channel\nhttp://192.168.5.2:8096/live\n' });
    f.state.replies.push({ body: '#EXTM3U\n#EXTINF:-1,Public Channel\nhttps://media.test/live\n' });
    const response = await f.route('live/merged').GET(request('/api/live/merged', { username }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /Public Channel/);
    assert.equal(text.includes('Private Channel'), Boolean(username));
    assert.equal(f.state.fetches.length, username ? 2 : 1);
  }
});

test('video and shortdrama HEAD requests reach upstream as HEAD and preserve response metadata', async () => {
  for (const name of ['video-proxy', 'proxy/shortdrama']) {
    const f = fixture();
    f.state.replies.push({ headers: { 'content-type': 'video/mp4', 'content-length': '1234', 'accept-ranges': 'bytes' } });
    const response = await f.route(name).HEAD(request('/api/' + name + '?url=https%3A%2F%2Fmedia.test%2Fvideo&moontv-source=local%2Fa%26b', { username: 'alice', method: 'HEAD' }));
    assert.equal(response.status, 200);
    assert.equal(response.body, null);
    assert.equal(response.headers.get('content-length'), '1234');
    assert.equal(f.state.fetches[0].init.method, 'HEAD');
    if (name === 'video-proxy') assert.equal(f.state.fetches[0].init.headers['User-Agent'], 'FixturePlayer');
  }
});

test('the CMS proxy treats non-JSON content as sandboxed and keeps responses out of shared caches', async () => {
  const f = fixture();
  f.state.replies.push({ body: '<html><script>fixture</script></html>', headers: { 'content-type': 'text/html' } });
  const response = await f.route('proxy/cms').GET(request('/api/proxy/cms?url=https%3A%2F%2Fcms.test%2Fapi.php%3Fac%3Ddetail', { username: 'alice' }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control'), /^private/);
});

test('optional Emby API routes reject disabled capabilities before external calls or writes', async (t) => {
  let externalCalls = 0;
  t.mock.method(global, 'fetch', async () => { externalCalls++; throw new Error('Disabled feature attempted an external request'); });
  const f = fixture();
  const routes = [
    ['emby/audio-streams', 'GET'], ['emby/detail', 'GET'], ['emby/list', 'GET'], ['emby/public-sources', 'GET'], ['emby/search', 'GET'], ['emby/sources', 'GET'], ['emby/views', 'GET'], ['emby/test', 'POST'],
    ['emby/cms-proxy/[token]', 'GET'], ['emby/play/[token]/[filename]', 'GET'],
    ['user/emby-config', 'GET'], ['user/emby-config', 'POST'], ['user/emby-config', 'DELETE'],
    ['admin/emby', 'POST'], ['admin/emby/import', 'POST'], ['admin/emby/export', 'GET'],
  ];
  for (const [name, method] of routes) {
    const response = await f.route(name)[method](request('/api/' + name, { username: 'manager', method, ...(method === 'POST' ? { body: { action: 'test', ServerURL: 'http://192.168.5.2:8096', ApiKey: 'fixture' } } : {}) }), { params: Promise.resolve({ token: 'fixture', filename: 'video.mp4' }) });
    assert.equal(response.status, 403, `${method} ${name}`);
  }
  assert.equal(externalCalls, 0);
  assert.equal(f.state.fetches.length, 0);
  assert.equal(f.state.saves, 0);
});

test('image proxy returns actual body length, rejects HTML and confines SVG script execution', async () => {
  const f = fixture();
  f.state.replies.push({ body: '<svg/>', headers: { 'content-type': 'image/svg+xml', 'content-length': '999' } });
  const endpoint = f.route('image-proxy');
  const req = () => request('/api/image-proxy?url=https%3A%2F%2Fmedia.test%2Fimage', { username: 'alice' });
  const image = await endpoint.GET(req());
  assert.equal(image.headers.get('content-length'), '6');
  assert.match(image.headers.get('content-security-policy'), /sandbox/);
  f.state.replies.push({ body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html' } });
  assert.equal((await endpoint.GET(req())).status, 415);
});

test('image proxy uses the Douban page referer without an Origin header for Douban covers', async () => {
  const f = fixture();
  f.state.replies.push({ body: 'cover', headers: { 'content-type': 'image/jpeg' } });
  const params = new URLSearchParams({ url: 'https://img9.doubanio.com/view/photo/s_ratio_poster/public/cover.jpg', source: 'local/a&b' });
  const response = await f.route('image-proxy').GET(request('/api/image-proxy?' + params, { username: 'alice' }));
  assert.equal(response.status, 200);
  assert.equal(f.state.fetches[0].init.headers.Referer, 'https://movie.douban.com/');
  assert.equal(f.state.fetches[0].init.headers.Origin, undefined);
  assert.equal(f.state.fetches[0].init.headers['User-Agent'], 'FixturePlayer');
});

test('image proxy does not apply Douban headers to lookalike hosts or unrelated image URLs', async () => {
  const f = fixture();
  const endpoint = f.route('image-proxy');
  for (const target of ['https://img9.doubanio.com.example.test/cover.jpg', 'https://media.test/cover.jpg?site=doubanio.com']) {
    f.state.replies.push({ body: 'cover', headers: { 'content-type': 'image/jpeg' } });
    const params = new URLSearchParams({ url: target });
    assert.equal((await endpoint.GET(request('/api/image-proxy?' + params, { username: 'alice' }))).status, 200);
    const { headers } = f.state.fetches.at(-1).init;
    assert.equal(headers.Referer, new URL(target).origin + '/');
    assert.equal(headers.Origin, new URL(target).origin);
  }
});

test('public TVBox custom JAR management rejects unsigned and ordinary users before writing', async () => {
  const f = fixture();
  const endpoint = f.route('tvbox/custom-jar');
  assert.equal((await endpoint.POST(request('/api/tvbox/custom-jar', { method: 'POST', body: { jarUrl: 'https://media.test/custom.jar' } }))).status, 401);
  assert.equal((await endpoint.DELETE(request('/api/tvbox/custom-jar', { username: 'alice', method: 'DELETE' }))).status, 403);
  assert.equal(f.state.saves, 0);
});

test('TVBox JAR health checks require an administrator before making a request', async (t) => {
  let uncheckedRequests = 0;
  t.mock.method(global, 'fetch', async () => {
    uncheckedRequests++;
    throw new Error('Unexpected unchecked request');
  });
  const f = fixture();
  const endpoint = f.route('tvbox/health');
  const url = '/api/tvbox/health?' + new URLSearchParams({ url: 'https://media.test/spider.jar' });
  assert.equal((await endpoint.GET(request(url))).status, 401);
  assert.equal((await endpoint.GET(request(url, { username: 'alice' }))).status, 403);
  assert.equal(uncheckedRequests, 0);
  assert.equal(f.state.fetches.length, 0);
});

test('TVBox JAR health checks reject private and non-HTTP targets', async (t) => {
  let uncheckedRequests = 0;
  t.mock.method(global, 'fetch', async () => {
    uncheckedRequests++;
    throw new Error('Unexpected unchecked request');
  });
  const f = fixture();
  const endpoint = f.route('tvbox/health');
  for (const target of [
    'http://127.0.0.1:6379/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'file:///etc/passwd',
    'https://user:fixture@media.test/spider.jar',
  ]) {
    const url = '/api/tvbox/health?' + new URLSearchParams({ url: target });
    const response = await endpoint.GET(request(url, { username: 'manager' }));
    assert.equal(response.status, 403, target);
    assert.equal((await response.json()).accessible, false);
  }
  assert.equal(uncheckedRequests, 0);
  assert.equal(f.state.fetches.length, 0);
});

test('TVBox JAR health checks preserve HEAD metadata for allowed public targets', async (t) => {
  t.mock.method(global, 'fetch', async () => {
    throw new Error('Health checks must use the validated proxy transport');
  });
  const f = fixture();
  f.state.replies.push({ headers: { 'content-type': 'application/java-archive', 'content-length': '1234' } });
  const url = '/api/tvbox/health?' + new URLSearchParams({ url: 'https://media.test/spider.jar;md5;fixture' });
  const response = await f.route('tvbox/health').GET(request(url, { username: 'manager' }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.accessible, true);
  assert.equal(result.url, 'https://media.test/spider.jar');
  assert.equal(result.contentType, 'application/java-archive');
  assert.equal(result.contentLength, '1234');
  assert.equal(f.state.fetches.length, 1);
  assert.equal(f.state.fetches[0].init.method, 'HEAD');
});

test('TVBox JAR health checks report a missing URL without a network request', async () => {
  const f = fixture();
  const response = await f.route('tvbox/health').GET(request('/api/tvbox/health', { username: 'manager' }));
  assert.equal(response.status, 400);
  assert.equal(f.state.fetches.length, 0);
});
