import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.env.SMOKE_ORIGIN;
const username = process.env.SMOKE_USERNAME;
const password = process.env.SMOKE_PASSWORD;
const storageMode = process.env.SMOKE_STORAGE_MODE || '';
const fixtureId = process.env.SMOKE_STORAGE_FIXTURE_ID;
assert.ok(
  ['', 'seed', 'verify'].includes(storageMode),
  'SMOKE_STORAGE_MODE must be empty, seed or verify',
);
assert.ok(
  origin && username && password,
  'Smoke origin and isolated credentials are required',
);

if (storageMode) {
  assert.ok(
    process.env.CI === 'true' && process.env.SMOKE_STORAGE_ISOLATED === 'true',
    'Storage writes require CI=true and SMOKE_STORAGE_ISOLATED=true',
  );
  assert.equal(
    username,
    'release-smoke',
    'Storage smoke must use the isolated release-smoke owner',
  );
  assert.match(
    fixtureId || '',
    /^release-smoke-[1-9]\d*-[1-9]\d*$/,
    'SMOKE_STORAGE_FIXTURE_ID must be release-smoke-<run ID>-<run attempt>',
  );
  const endpoint = new URL(origin);
  assert.ok(
    endpoint.protocol === 'http:' &&
      endpoint.hostname === '127.0.0.1' &&
      endpoint.port &&
      !endpoint.username &&
      !endpoint.password &&
      endpoint.pathname === '/' &&
      !endpoint.search &&
      !endpoint.hash,
    'Storage smoke requires the isolated container at http://127.0.0.1:<port>',
  );
}

async function request(path, options = {}) {
  return fetch(new URL(path, origin), {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    ...options,
  });
}

async function checkStorage(cookie) {
  const source = '__miaotv_release_smoke__';
  const key = `${source}+${fixtureId}`;
  const fixturePath = `/api/favorites?${new URLSearchParams({ key })}`;
  const favorite = {
    source_name: source,
    total_episodes: 1,
    title: fixtureId,
    year: '',
    cover: '',
    save_time: 1,
    search_title: fixtureId,
    origin: 'vod',
    type: 'movie',
  };
  const readFixture = async () => {
    const response = await request(fixturePath, {
      headers: { cookie },
      cache: 'no-store',
    });
    assert.equal(response.status, 200, 'Storage fixture read must succeed');
    return response.json();
  };

  // Verify must inspect the existing record before any fixture mutation.
  const existing = await readFixture();
  if (storageMode === 'seed') {
    assert.equal(existing, null, 'Refusing to overwrite an existing smoke fixture');
    const response = await request('/api/favorites', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key, favorite }),
    });
    assert.equal(response.status, 200, 'Storage fixture creation must succeed');
    assert.equal(
      (await response.json()).success,
      true,
      'Storage fixture creation was rejected',
    );
    assert.deepEqual(
      await readFixture(),
      favorite,
      'Stored fixture must match the submitted content',
    );
    console.log(
      `Storage fixture seeded and read back: ${fixtureId}. Restart the isolated container before verify.`,
    );
    return;
  }

  assert.notEqual(existing, null, 'Storage fixture is missing after restart');
  assert.deepEqual(
    existing,
    favorite,
    'Persisted fixture content must match before cleanup',
  );
  const response = await request(fixturePath, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(response.status, 200, 'Storage fixture cleanup must succeed');
  assert.equal(
    (await response.json()).success,
    true,
    'Storage fixture cleanup was rejected',
  );
  assert.equal(
    await readFixture(),
    null,
    'Storage fixture must be absent after cleanup',
  );
  console.log(
    `Storage fixture verified after restart and cleanup confirmed: ${fixtureId}.`,
  );
}

const deadline = Date.now() + 60000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const response = await request('/login');
    ready = response.status === 200;
    await response.arrayBuffer();
    if (ready) break;
  } catch {
    // A cold container may not have opened its listening socket yet.
  }
  await delay(1000);
}
assert.ok(ready, 'Container did not become ready');

const anonymous = await request('/api/admin/config');
assert.equal(
  anonymous.status,
  401,
  'Anonymous access to admin configuration must fail',
);
await anonymous.arrayBuffer();

const download = await request('/download');
assert.equal(
  download.status,
  200,
  'The client download page must remain public',
);
assert.match(await download.text(), /MiaoTV/);

const login = await request('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
assert.equal(login.status, 200, 'Isolated owner login must succeed');
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
assert.ok(cookie, 'Owner login must set an authentication cookie');
await login.arrayBuffer();

for (const path of ['/', '/shortdrama', '/search', '/admin']) {
  const response = await request(path, { headers: { cookie } });
  assert.equal(response.status, 200, `Authenticated page failed: ${path}`);
  const html = await response.text();
  assert.ok(
    !html.includes('NEXT_HTTP_ERROR_FALLBACK'),
    `Page returned a fallback: ${path}`,
  );
}

const config = await request('/api/admin/config', { headers: { cookie } });
assert.equal(config.status, 200, 'Owner must be able to read configuration');
assert.ok(
  (await config.json()).Config?.SiteConfig,
  'Container must return its configuration',
);

const manifest = await request('/manifest.json');
assert.equal(manifest.status, 200, 'Runtime manifest generation must succeed');
assert.ok((await manifest.json()).name);

if (storageMode) await checkStorage(cookie);

console.log(
  'Container smoke passed: startup, public assets, authentication, configuration read and core pages.',
);
