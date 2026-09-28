const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const { Readable } = require('node:stream');
const { gzipSync } = require('node:zlib');
const { test } = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const ipaddr = require('ipaddr.js');

function fixture({ records = [{ address: '8.8.8.8', family: 4 }], replies = [], dnsAnswers } = {}) {
  const calls = [];
  const dnsCalls = [];
  const resolutions = [];
  class Resolver {
    async lookupAsync(host) { resolutions.push(host); return typeof records === 'function' ? records(host) : records; }
  }
  function request(url, options, callback) {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => { if (error) req.emit('error', error); };
    req.end = () => {
      if (url.hostname === 'resolver.test') {
        dnsCalls.push({ url: new URL(url), options });
        if (!dnsAnswers) throw new Error('Unexpected DNS over HTTPS request');
        const response = dnsAnswers(url.searchParams.get('name'), url.searchParams.get('type'));
        const incoming = Readable.from([Buffer.from(JSON.stringify(response))]);
        incoming.headers = {};
        incoming.statusCode = 200;
        callback(incoming);
        return;
      }
      const call = { url: url.href, options };
      calls.push(call);
      options.lookup(url.hostname, { all: true }, (error, resolved) => {
        if (error) throw error;
        call.addresses = resolved;
      });
      const reply = replies.shift();
      if (!reply) throw new Error('Unexpected outbound request');
      const incoming = Readable.from([Buffer.from(reply.body || '')]);
      incoming.headers = reply.headers || {};
      incoming.statusCode = reply.status || 200;
      incoming.statusMessage = 'fixture';
      callback(incoming);
    };
    return req;
  }
  const load = createSourceLoader({
    'cacheable-lookup': Resolver,
    'ipaddr.js': ipaddr,
    http: { request },
    https: { request },
  });
  return { api: load('proxy-security.ts'), calls, dnsCalls, resolutions };
}

function setDoh(t, value = 'https://resolver.test/dns-query') {
  const previous = process.env.PROXY_DNS_OVER_HTTPS;
  if (value === null) delete process.env.PROXY_DNS_OVER_HTTPS;
  else process.env.PROXY_DNS_OVER_HTTPS = value;
  t.after(() => previous === undefined ? delete process.env.PROXY_DNS_OVER_HTTPS : process.env.PROXY_DNS_OVER_HTTPS = previous);
}

function publicDnsAnswers(_host, type) {
  return { Status: 0, Answer: [{ type: type === 'A' ? 1 : 28, data: type === 'A' ? '8.8.4.4' : '2606:4700:4700::1111', TTL: 60 }] };
}

test('proxy rejects local, reserved, mapped IPv6, credential URLs and obsolete global bypass', async (t) => {
  const { api, calls } = fixture();
  const previous = process.env.DISABLE_SSRF_PROTECTION;
  process.env.DISABLE_SSRF_PROTECTION = 'true';
  t.after(() => previous === undefined ? delete process.env.DISABLE_SSRF_PROTECTION : process.env.DISABLE_SSRF_PROTECTION = previous);
  for (const url of [
    'http://127.1/', 'http://2130706433/', 'http://10.0.0.1/', 'http://169.254.169.254/',
    'http://192.168.1.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://[fd00::1]/',
    'http://localhost/', 'http://metadata.google.internal/', 'file:///etc/passwd', 'https://user:secret@example.org/',
  ]) await assert.rejects(api.validateProxyTargetUrl(url), (error) => error.status === 403, url);
  assert.equal(calls.length, 0);
});

test('private source grants apply only to the exact origin including port', async () => {
  const { api } = fixture();
  const policy = { allowedPrivateOrigins: ['http://192.168.10.2:8096'] };
  assert.equal(await api.validateProxyTargetUrl('http://192.168.10.2:8096/video', policy), 'http://192.168.10.2:8096/video');
  await assert.rejects(api.validateProxyTargetUrl('http://192.168.10.2/video', policy));
  await assert.rejects(api.validateProxyTargetUrl('http://192.168.10.3:8096/video', policy));
  await assert.rejects(api.validateProxyTargetUrl('http://127.0.0.1/', { allowedPrivateOrigins: ['http://127.0.0.1'] }));
});

test('mixed public/private DNS records are rejected before any socket opens', async () => {
  const f = fixture({ records: [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.2', family: 4 }] });
  await assert.rejects(f.api.fetchWithValidatedRedirects('https://media.test/file', {}, { timeoutMs: 1000 }));
  assert.equal(f.calls.length, 0);
});

test('validated DNS addresses are pinned to socket lookup and redirected private targets are rejected', async () => {
  const f = fixture({ replies: [{ status: 302, headers: { location: 'http://127.0.0.1/secret' } }] });
  await assert.rejects(f.api.fetchWithValidatedRedirects('https://media.test/file', {}, { timeoutMs: 1000 }));
  assert.deepEqual(f.calls[0].addresses, [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.resolutions, ['media.test']);
});

test('allowed public redirects revalidate and remove credentials on origin changes', async () => {
  const f = fixture({ replies: [{ status: 302, headers: { location: 'https://second.test/video' } }, { body: 'video' }] });
  const response = await f.api.fetchWithValidatedRedirects('https://first.test/file', { headers: { authorization: 'Bearer test', cookie: 'session=test' } }, { timeoutMs: 1000 });
  assert.equal(await response.text(), 'video');
  assert.equal(response.url, 'https://second.test/video');
  assert.deepEqual(f.resolutions, ['first.test', 'second.test']);
  assert.equal(f.calls[1].options.headers.authorization, undefined);
  assert.equal(f.calls[1].options.headers.cookie, undefined);
});

test('socket lookup returns independent address records without exposing the validated DNS set', async () => {
  const records = Object.freeze([Object.freeze({ address: '8.8.8.8', family: 4 })]);
  const f = fixture({ records, replies: [{ body: 'data' }] });
  await f.api.fetchWithValidatedRedirects('https://media.test/file', {}, { timeoutMs: 1000 });
  f.calls[0].addresses[0].address = '127.0.0.1';
  const resolved = await new Promise((resolve, reject) => f.calls[0].options.lookup('media.test', { all: true }, (error, result) => error ? reject(error) : resolve(result)));
  assert.deepEqual(resolved, [{ address: '8.8.8.8', family: 4 }]);
});

test('fresh sockets use the current DNS validation instead of reusing a privately authorized connection', async (t) => {
  setDoh(t, null);
  const server = http.createServer((_request, response) => response.end('fixture'));
  let connections = 0;
  server.on('connection', () => { connections++; });
  // Isolate the keep-alive pool while preserving Node's normal reuse behavior.
  const agent = new http.Agent({ keepAlive: true });
  t.after(async () => {
    agent.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = `http://cover.test:${server.address().port}/image`;
  const resolutions = [];
  const socketLookups = [];
  const requests = [];
  class Resolver {
    async lookupAsync() {
      const address = resolutions.length ? '8.8.8.8' : '10.0.0.2';
      resolutions.push(address);
      return [{ address, family: 4 }];
    }
  }
  function request(url, options, callback) {
    assert.equal(url.href, target);
    const pinnedLookup = options.lookup;
    const native = http.request(url, {
      agent,
      ...options,
      lookup(hostname, lookupOptions, done) {
        pinnedLookup(hostname, lookupOptions, (error, values, family) => {
          if (error) return done(error);
          const records = Array.isArray(values) ? values : [{ address: values, family }];
          socketLookups.push(records.map(record => record.address));
          // Observe the validated records, but keep every actual connection local.
          const local = records.map(() => ({ address: '127.0.0.1', family: 4 }));
          if (lookupOptions.all) done(null, local);
          else done(null, local[0].address, local[0].family);
        });
      },
    }, callback);
    requests.push(native);
    return native;
  }
  const api = createSourceLoader({ 'cacheable-lookup': Resolver, 'ipaddr.js': ipaddr, http: { request } })('proxy-security.ts');
  const granted = await api.fetchWithValidatedRedirects(target, {}, { timeoutMs: 1000, allowedPrivateOrigins: [new URL(target).origin] });
  assert.equal(await granted.text(), 'fixture');
  await new Promise(setImmediate);
  const publicOnly = await api.fetchWithValidatedRedirects(target, {}, { timeoutMs: 1000 });
  assert.equal(await publicOnly.text(), 'fixture');
  assert.deepEqual(resolutions, ['10.0.0.2', '8.8.8.8']);
  assert.deepEqual(socketLookups, [['10.0.0.2'], ['8.8.8.8']]);
  assert.equal(requests[1].reusedSocket, false);
  assert.equal(connections, 2);
});

test('credential-bearing metadata requests can prohibit cross-origin redirects before opening a second socket', async () => {
  const f = fixture({ replies: [{ status: 307, headers: { location: 'https://other.test/authenticate' } }] });
  await assert.rejects(f.api.fetchWithValidatedRedirects('https://media.test/authenticate', {
    method: 'POST', body: 'fixture-credentials', headers: { 'X-Emby-Authorization': 'fixture' },
  }, { timeoutMs: 1000, allowCrossOriginRedirects: false }), error => error.status === 403);
  assert.equal(f.calls.length, 1);
});

test('body decoding removes compressed content-length and bounded reads cancel oversized bodies', async () => {
  const f = fixture({ replies: [{ body: gzipSync('hello image'), headers: { 'content-encoding': 'gzip', 'content-length': '999' } }] });
  const response = await f.api.fetchWithValidatedRedirects('https://media.test/image', {}, { timeoutMs: 1000 });
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(await response.text(), 'hello image');
  let cancelled = false;
  const oversized = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(12)); }, cancel() { cancelled = true; } }));
  await assert.rejects(f.api.readArrayBufferLimited(oversized, 10), /exceeds/);
  assert.equal(cancelled, true);
});

test('byte ranges support suffix, open end and clamping while rejecting invalid or multipart ranges', () => {
  const { api } = fixture();
  assert.deepEqual(api.parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(api.parseByteRange('bytes=3-', 10), { start: 3, end: 9 });
  assert.deepEqual(api.parseByteRange('bytes=8-999', 10), { start: 8, end: 9 });
  for (const range of ['bytes=10-', 'bytes=-0', 'bytes=3-1', 'bytes=0-1,4-5', 'nonsense']) assert.equal(api.parseByteRange(range, 10), null);
});

test('fake-IP DNS stays blocked by default and literal fake IP never invokes DoH', async (t) => {
  setDoh(t, null);
  const f = fixture({ records: [{ address: '198.18.1.2', family: 4 }] });
  await assert.rejects(f.api.fetchWithValidatedRedirects('https://cover.test/image', {}, { timeoutMs: 1000 }), error => error.status === 403);
  process.env.PROXY_DNS_OVER_HTTPS = 'https://resolver.test/dns-query';
  for (const url of ['https://198.18.1.2/image', 'https://198.19.255.255/image', 'https://[::ffff:c612:102]/image']) {
    await assert.rejects(f.api.validateProxyTargetUrl(url), error => error.status === 403);
  }
  assert.equal(f.dnsCalls.length, 0);
  assert.equal(f.calls.length, 0);
});

test('opt-in DoH replaces fake-IP answers and pins both validated address families to the image socket', async (t) => {
  setDoh(t);
  const f = fixture({ records: [{ address: '198.19.1.2', family: 4 }], dnsAnswers: publicDnsAnswers, replies: [{ body: 'image' }] });
  const response = await f.api.fetchWithValidatedRedirects('https://cover.test/image', {}, { timeoutMs: 1000 });
  assert.equal(await response.text(), 'image');
  assert.deepEqual(f.calls[0].addresses, [{ address: '8.8.4.4', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]);
  assert.deepEqual(f.dnsCalls.map(call => call.url.searchParams.get('type')), ['A', 'AAAA']);
  assert.ok(f.dnsCalls.every(call => call.options.rejectUnauthorized === true));
  assert.equal(f.calls[0].url, 'https://cover.test/image');
});

test('DoH does not run for normal public DNS or erase another blocked system-DNS address', async (t) => {
  setDoh(t);
  for (const blocked of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '::ffff:127.0.0.1', '192.0.2.1']) {
    const f = fixture({ records: [{ address: '198.18.1.2', family: 4 }, { address: blocked, family: blocked.includes(':') ? 6 : 4 }], dnsAnswers: publicDnsAnswers });
    await assert.rejects(f.api.validateProxyTargetUrl('https://cover.test/image'), error => error.status === 403);
    assert.equal(f.dnsCalls.length, 0, blocked);
  }
  const mixed = fixture({ records: [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], dnsAnswers: publicDnsAnswers });
  await assert.rejects(mixed.api.validateProxyTargetUrl('https://cover.test/image'), error => error.status === 403);
  assert.equal(mixed.dnsCalls.length, 0);
  const normal = fixture({ dnsAnswers: publicDnsAnswers });
  await normal.api.validateProxyTargetUrl('https://cover.test/image');
  assert.equal(normal.dnsCalls.length, 0);
});

test('every DoH address is checked, including a private AAAA embedded in the A response', async (t) => {
  setDoh(t);
  for (const extra of [
    { type: 1, data: '10.0.0.1', TTL: 60 },
    { type: 28, data: '::ffff:127.0.0.1', TTL: 60 },
    { type: 1, data: '198.18.1.5', TTL: 60 },
  ]) {
    const f = fixture({
      records: [{ address: '198.18.1.2', family: 4 }],
      dnsAnswers: (host, type) => ({ ...publicDnsAnswers(host, type), Answer: [...publicDnsAnswers(host, type).Answer, ...(type === 'A' ? [extra] : [])] }),
    });
    await assert.rejects(f.api.fetchWithValidatedRedirects('https://cover.test/image', {}, { timeoutMs: 1000 }), error => error.status === 403);
    assert.equal(f.calls.length, 0);
  }
});

test('DoH errors or malformed address families fail closed without opening a fake-IP socket', async (t) => {
  setDoh(t);
  for (const answer of [
    { Status: 2 },
    { Status: 0, Answer: [{ type: 1, data: '::1', TTL: 60 }] },
    { Status: 0, Answer: [{ type: 28, data: '8.8.8.8', TTL: 60 }] },
    { Status: 0, Answer: [] },
  ]) {
    const f = fixture({ records: [{ address: '198.18.1.2', family: 4 }], dnsAnswers: () => answer });
    await assert.rejects(f.api.fetchWithValidatedRedirects('https://cover.test/image', {}, { timeoutMs: 1000 }));
    assert.equal(f.calls.length, 0);
  }
});

test('redirects from DoH-resolved targets still reject literal and DNS-resolved private destinations', async (t) => {
  setDoh(t);
  for (const location of ['http://127.0.0.1/secret', 'https://private.test/secret', 'https://other-cover.test/image']) {
    const f = fixture({
      records: host => host === 'private.test' ? [{ address: '10.0.0.1', family: 4 }] : [{ address: '198.18.1.2', family: 4 }],
      dnsAnswers: (host, type) => host === 'other-cover.test' ? { Status: 0, Answer: [{ type: 1, data: '10.0.0.1', TTL: 60 }] } : publicDnsAnswers(host, type),
      replies: [{ status: 302, headers: { location } }],
    });
    await assert.rejects(f.api.fetchWithValidatedRedirects('https://cover.test/image', {}, { timeoutMs: 1000 }), error => error.status === 403);
    assert.equal(f.calls.length, 1, location);
    assert.deepEqual(f.calls[0].addresses, [{ address: '8.8.4.4', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]);
  }
});
