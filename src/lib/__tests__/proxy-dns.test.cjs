const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');

const endpoint = 'https://resolver.test/dns-query';

function answer(type, ttl = 60) {
  return { Status: 0, Answer: [{ type: type === 'A' ? 1 : 28, data: type === 'A' ? '8.8.4.4' : '2606:4700:4700::1111', TTL: ttl }] };
}

function fixture(reply = (url) => ({ json: answer(url.searchParams.get('type')) })) {
  const calls = [];
  const responses = [];
  function request(url, options, callback) {
    const req = new EventEmitter();
    req.destroy = (error) => {
      if (req.destroyed) return;
      req.destroyed = true;
      if (error) req.emit('error', error);
    };
    options.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    req.end = () => {
      calls.push({ url: new URL(url), options });
      const result = reply(url, calls.length);
      if (result.hang) return;
      if (result.error) {
        req.emit('error', result.error);
        return;
      }
      const body = result.body === undefined ? JSON.stringify(result.json) : result.body;
      const incoming = result.stream || Readable.from([Buffer.from(body)]);
      incoming.statusCode = result.status || 200;
      incoming.headers = result.headers || {};
      responses.push(incoming);
      callback(incoming);
    };
    return req;
  }
  const api = createSourceLoader({ https: { request } })('proxy-dns.ts');
  return { api, calls, responses };
}

test('only the 198.18.0.0/15 IPv4 range is recognized as proxy fake-IP', () => {
  const { api } = fixture();
  for (const value of ['198.18.0.0', '198.18.1.2', '198.19.255.255']) assert.equal(api.isProxyFakeIp(value), true, value);
  for (const value of ['198.17.255.255', '198.20.0.0', '198.18.1.999', '127.0.0.1', '10.0.0.1', '::1']) assert.equal(api.isProxyFakeIp(value), false, value);
});

test('resolver endpoints require HTTPS without user information and redirects are never followed', async () => {
  for (const value of ['http://resolver.test/dns-query', 'https://user:secret@resolver.test/dns-query', 'file:///dns-query', 'invalid']) {
    const f = fixture();
    await assert.rejects(f.api.resolveProxyDnsOverHttps('cover.test', value));
    assert.equal(f.calls.length, 0);
  }
  const redirect = fixture(() => ({ status: 302, headers: { location: 'https://other.test/dns-query' }, body: '' }));
  await assert.rejects(redirect.api.resolveProxyDnsOverHttps('cover.test', endpoint));
  assert.equal(redirect.calls.length, 2);
  assert.ok(redirect.calls.every(call => call.url.hostname === 'resolver.test' && call.options.rejectUnauthorized === true));
  assert.ok(redirect.responses.every(response => response.destroyed));
});

test('A and AAAA requests preserve endpoint parameters, deduplicate concurrent lookups and return independent records', async () => {
  const f = fixture();
  const value = endpoint + '?existing=fixture';
  const results = await Promise.all(Array.from({ length: 24 }, () => f.api.resolveProxyDnsOverHttps('cover.test', value)));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => call.url.searchParams.get('type')), ['A', 'AAAA']);
  assert.ok(f.calls.every(call => call.url.searchParams.get('name') === 'cover.test' && call.url.searchParams.get('existing') === 'fixture'));
  assert.ok(f.calls.every(call => call.options.headers.Accept === 'application/dns-json'));
  results[0][0].address = '127.0.0.1';
  const cached = await f.api.resolveProxyDnsOverHttps('cover.test', value);
  assert.equal(cached[0].address, '8.8.4.4');
  assert.equal(results[1][0].address, '8.8.4.4');
  assert.equal(f.calls.length, 2);
  await f.api.resolveProxyDnsOverHttps('cover.test', endpoint + '?existing=another');
  assert.equal(f.calls.length, 4);
});

test('cache TTL follows the shortest CNAME and address TTL and is capped at 300 seconds', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const alias = fixture(url => ({ json: { ...answer(url.searchParams.get('type'), 900), Answer: [{ type: 5, data: 'alias.test.', TTL: 2 }, ...answer(url.searchParams.get('type'), 900).Answer] } }));
  await alias.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  now += 1999;
  await alias.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  assert.equal(alias.calls.length, 2);
  now += 1;
  await alias.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  assert.equal(alias.calls.length, 4);
  const capped = fixture(url => ({ json: answer(url.searchParams.get('type'), 900) }));
  await capped.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  now += 299999;
  await capped.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  assert.equal(capped.calls.length, 2);
  now += 1;
  await capped.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  assert.equal(capped.calls.length, 4);
});

test('zero, missing or invalid TTL does not cache an otherwise valid DNS answer', async () => {
  for (const ttl of [0, -1, undefined, '60']) {
    const f = fixture(url => ({ json: { Status: 0, Answer: [{ ...answer(url.searchParams.get('type')).Answer[0], TTL: ttl }] } }));
    await f.api.resolveProxyDnsOverHttps('cover.test', endpoint);
    await f.api.resolveProxyDnsOverHttps('cover.test', endpoint);
    assert.equal(f.calls.length, 4, String(ttl));
  }
});

test('an absent address family uses its authority TTL rather than caching an incomplete answer forever', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(url => ({ json: url.searchParams.get('type') === 'A' ? answer('A', 60) : { Status: 0, Authority: [{ type: 6, data: 'fixture SOA', TTL: 5 }] } }));
  assert.deepEqual(await f.api.resolveProxyDnsOverHttps('cover.test', endpoint), [{ address: '8.8.4.4', family: 4 }]);
  now += 4999;
  await f.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  assert.equal(f.calls.length, 2);
  now += 1;
  await f.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  assert.equal(f.calls.length, 4);
});

test('CNAME-only NODATA responses also obey authority TTL and are not cached without authority', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  for (const authority of [[{ type: 6, data: 'fixture SOA', TTL: 1 }], []]) {
    const f = fixture(url => ({ json: url.searchParams.get('type') === 'A' ? answer('A', 300) : { Status: 0, Answer: [{ type: 5, data: 'alias.test.', TTL: 300 }], Authority: authority } }));
    await f.api.resolveProxyDnsOverHttps('cover.test', endpoint);
    now += authority.length ? 1000 : 0;
    await f.api.resolveProxyDnsOverHttps('cover.test', endpoint);
    assert.equal(f.calls.length, 4);
  }
});

test('cache eviction bounds stored hostnames while preserving recently used entries', async () => {
  const f = fixture();
  for (let i = 0; i < 256; i++) await f.api.resolveProxyDnsOverHttps('cover-' + i + '.test', endpoint);
  await f.api.resolveProxyDnsOverHttps('cover-0.test', endpoint);
  await f.api.resolveProxyDnsOverHttps('cover-256.test', endpoint);
  const before = f.calls.length;
  await f.api.resolveProxyDnsOverHttps('cover-0.test', endpoint);
  assert.equal(f.calls.length, before);
  await f.api.resolveProxyDnsOverHttps('cover-1.test', endpoint);
  assert.equal(f.calls.length, before + 2);
});

test('oversized declared and streamed responses are closed and not cached', async () => {
  for (const oversized of [
    { headers: { 'content-length': '65537' }, body: '{}' },
    { body: ' '.repeat(65537) },
  ]) {
    const f = fixture(() => oversized);
    await assert.rejects(f.api.resolveProxyDnsOverHttps('cover.test', endpoint), /too large/);
    assert.ok(f.responses.every(response => response.destroyed));
    await assert.rejects(f.api.resolveProxyDnsOverHttps('cover.test', endpoint), /too large/);
    assert.equal(f.calls.length, 4);
  }
});

test('truncated, malformed and failed DNS JSON responses fail the complete A/AAAA lookup and can be retried', async () => {
  for (const invalid of [
    { body: '{invalid' },
    { json: { Status: 0, TC: true } },
    { json: { Status: 2 } },
    { json: { Status: 0, Answer: [{ type: 1, data: '::1', TTL: 60 }] } },
    { json: { Status: 0, Answer: [{ type: 28, data: '8.8.8.8', TTL: 60 }] } },
    { json: { Status: 0, Answer: [] } },
    { error: new Error('fixture connection failure') },
  ]) {
    const f = fixture(() => invalid);
    await assert.rejects(f.api.resolveProxyDnsOverHttps('cover.test', endpoint));
    await assert.rejects(f.api.resolveProxyDnsOverHttps('cover.test', endpoint));
    assert.equal(f.calls.length, 4);
  }
  const oneFamilyFails = fixture(url => ({ json: url.searchParams.get('type') === 'A' ? answer('A') : { Status: 2 } }));
  await assert.rejects(oneFamilyFails.api.resolveProxyDnsOverHttps('cover.test', endpoint));
});

test('the five-second deadline cancels a stalled lookup instead of leaving concurrent callers pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => ({ hang: true }));
  const first = f.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  const second = f.api.resolveProxyDnsOverHttps('cover.test', endpoint);
  const checks = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
  t.mock.timers.tick(4999);
  assert.ok(f.calls.every(call => !call.options.signal.aborted));
  t.mock.timers.tick(1);
  await checks;
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.options.signal.aborted));
});

test('concurrent distinct hostname lookups have a bounded pending set', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => ({ hang: true }));
  const lookups = Array.from({ length: 256 }, (_, index) => f.api.resolveProxyDnsOverHttps('cover-' + index + '.test', endpoint));
  const completed = Promise.allSettled(lookups);
  await assert.rejects(f.api.resolveProxyDnsOverHttps('overflow.test', endpoint), /Too many concurrent/);
  assert.equal(f.calls.length, 512);
  t.mock.timers.tick(5000);
  assert.ok((await completed).every(result => result.status === 'rejected'));
});
