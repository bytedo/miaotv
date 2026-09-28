const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createSourceLoader,
} = require('../../../lib/__tests__/storage-test-loader.cjs');

function fixture(t) {
  const previousStorage = process.env.NEXT_PUBLIC_STORAGE_TYPE;
  const previousOwner = process.env.USERNAME;
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
  process.env.USERNAME = 'fixture-owner';
  t.after(() => {
    if (previousStorage === undefined)
      delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
    else process.env.NEXT_PUBLIC_STORAGE_TYPE = previousStorage;
    if (previousOwner === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = previousOwner;
  });
  t.mock.method(console, 'error', () => {});
  t.mock.method(global, 'fetch', async () => {
    throw new Error('Emby cache tests must not call a real server');
  });

  const identities = new Map([
    ['2', { uid: '2', username: 'alice' }],
    ['3', { uid: '3', username: 'bob' }],
  ]);
  const source = (apiKey) => ({
    key: 'same-source',
    name: 'Personal source',
    enabled: true,
    ServerURL: 'https://emby.example',
    ApiKey: apiKey,
    UserId: apiKey,
  });
  const personal = new Map([
    ['2', { sources: [source('fixture-alice')] }],
    ['3', { sources: [source('fixture-bob')] }],
  ]);
  const labels = new Map([
    ['fixture-alice', 'Alice'],
    ['fixture-bob', 'Bob'],
    ['fixture-updated', 'Updated'],
  ]);
  const config = {
    SiteConfig: { EnableEmby: true },
    UserConfig: {
      Users: [...identities.values()].map((identity) => ({
        ...identity,
        role: 'user',
      })),
    },
    EmbyConfig: { Sources: [] },
  };
  const calls = [];
  const identityReads = [];

  class Client {
    constructor(sourceConfig) {
      this.source = { ...sourceConfig };
    }

    async getItems(params) {
      calls.push({ kind: 'items', apiKey: this.source.ApiKey, params });
      return {
        Items: [
          {
            Id: 'same-item',
            Name: `${labels.get(this.source.ApiKey)} Movie`,
            Type: 'Movie',
          },
        ],
        TotalRecordCount: 1,
      };
    }

    async getUserViews() {
      calls.push({ kind: 'views', apiKey: this.source.ApiKey });
      return [
        {
          Id: 'same-library',
          Name: `${labels.get(this.source.ApiKey)} Library`,
          CollectionType: 'movies',
        },
      ];
    }

    getImageUrl(itemId) {
      return `${this.source.ServerURL}/${itemId}?api_key=${this.source.ApiKey}`;
    }
  }

  const load = createSourceLoader({
    'next/server': {
      NextResponse: { json: (body, init) => Response.json(body, init) },
    },
    './config': { getConfig: async () => config },
    './auth.server': {
      getLocalOwnerIdentity: () => ({ uid: '1', username: 'fixture-owner' }),
    },
    '@/lib/auth.server': {
      getVerifiedAuthInfo: async (request) => request.auth,
    },
    '@/lib/optional-features.server': {
      optionalFeatureUnavailable: async () => null,
    },
    './db': {
      dbManager: {
        getUserIdentityByUid: async (uid) => {
          identityReads.push(uid);
          return identities.get(uid) || null;
        },
        getUserEmbyConfig: async (uid) => personal.get(uid) || null,
      },
    },
    './emby.client': { EmbyClient: Client },
  });
  const manager = load('emby-manager.ts').embyManager;
  const cache = load('emby-cache.ts');

  async function request(route, uid, params = {}) {
    const search = new URLSearchParams({
      embyKey: 'same-source',
      parentId: 'same-library',
      keyword: 'Movie',
      ...params,
    });
    const nextUrl = new URL(`https://site.example/api/emby/${route}?${search}`);
    const response = await load(`../app/api/emby/${route}/route.ts`).GET({
      url: nextUrl.href,
      nextUrl,
      auth: uid ? { uid, username: uid === '2' ? 'alice' : 'bob' } : null,
    });
    return { status: response.status, body: await response.json() };
  }

  return {
    request,
    manager,
    cache,
    personal,
    labels,
    identities,
    config,
    calls,
    identityReads,
  };
}

function titles(route, body) {
  if (route === 'views') return (body.views || []).map((item) => item.name);
  return (body[route === 'list' ? 'list' : 'videos'] || []).map(
    (item) => item.title,
  );
}

function assertLabel(route, response, label) {
  assert.equal(response.status, 200);
  assert.deepEqual(titles(route, response.body), [
    `${label} ${route === 'views' ? 'Library' : 'Movie'}`,
  ]);
}

for (const route of ['list', 'views', 'search']) {
  test(`Emby ${route} caches stay private when two users have the same source key`, async (t) => {
    const f = fixture(t);
    assertLabel(route, await f.request(route, '2'), 'Alice');
    const bob = await f.request(route, '3');
    assertLabel(route, bob, 'Bob');
    assert.ok(!JSON.stringify(bob.body).includes('fixture-alice'));
    assert.equal(f.calls.length, 2);

    assertLabel(route, await f.request(route, '2'), 'Alice');
    assertLabel(route, await f.request(route, '3'), 'Bob');
    assert.equal(
      f.calls.length,
      2,
      'repeated authorized requests should still use their own cache',
    );
    assert.deepEqual(
      f.identityReads,
      ['2', '3', '2', '3'],
      'cache hits must recheck the current identity',
    );
  });

  test(`Emby ${route} cannot use a warm cache after access is lost`, async (t) => {
    const f = fixture(t);
    assertLabel(route, await f.request(route, '2'), 'Alice');
    f.personal.delete('3');
    const noSource = await f.request(route, '3');
    assert.ok(noSource.body.error);
    assert.deepEqual(titles(route, noSource.body), []);

    f.personal.get('2').sources[0].enabled = false;
    const disabled = await f.request(route, '2');
    assert.ok(disabled.body.error);
    assert.deepEqual(titles(route, disabled.body), []);

    f.personal.get('2').sources[0].enabled = true;
    f.identities.delete('2');
    const removedAccount = await f.request(route, '2');
    assert.ok(removedAccount.body.error);
    assert.deepEqual(titles(route, removedAccount.body), []);
    assert.equal(
      f.calls.length,
      1,
      'denied requests must not reach the Emby server',
    );
  });

  test(`Emby ${route} rechecks public source access before returning cached data`, async (t) => {
    const f = fixture(t);
    const publicSource = { ...f.personal.get('2').sources[0], isPublic: true };
    f.personal.clear();
    f.config.EmbyConfig.Sources.push(publicSource);
    assertLabel(route, await f.request(route, '2'), 'Alice');
    publicSource.isPublic = false;
    const denied = await f.request(route, '2');
    assert.ok(denied.body.error);
    assert.deepEqual(titles(route, denied.body), []);
    assert.equal(f.calls.length, 1);
  });

  test(`Emby ${route} refreshes after source changes and manager cache resets`, async (t) => {
    const f = fixture(t);
    assertLabel(route, await f.request(route, '2'), 'Alice');

    f.personal.get('2').sources[0].ApiKey = 'fixture-updated';
    assertLabel(route, await f.request(route, '2'), 'Updated');

    f.labels.set('fixture-updated', 'After user reset');
    f.manager.clearUserCache('2');
    assertLabel(route, await f.request(route, '2'), 'After user reset');

    f.labels.set('fixture-updated', 'After global reset');
    f.manager.clearCache();
    assertLabel(route, await f.request(route, '2'), 'After global reset');
    assert.equal(f.calls.length, 4);
  });

  test(`Emby ${route} follows a changed default source without reusing the old default cache`, async (t) => {
    const f = fixture(t);
    const sources = f.personal.get('2').sources;
    sources.push({
      ...sources[0],
      key: 'another-source',
      ApiKey: 'fixture-bob',
    });
    assertLabel(route, await f.request(route, '2', { embyKey: '' }), 'Alice');
    sources[1].isDefault = true;
    assertLabel(route, await f.request(route, '2', { embyKey: '' }), 'Bob');
    assert.equal(f.calls.length, 2);
  });
}

test('Emby cache scopes keep UIDs separate even when a client instance is shared', () => {
  const cache = createSourceLoader()('emby-cache.ts');
  const client = {};
  const alice = { uid: '2', client };
  const bob = { uid: '3', client };
  const replaced = { uid: '2', client: {} };
  const list = { list: ['Alice'] };
  const views = { views: ['Alice'] };
  const index = [{ id: 'one', title: 'Alice Movie' }];

  cache.setCachedEmbyList(alice, 1, 20, list, 'library');
  cache.setCachedEmbyViews(alice, views);
  cache.setCachedMediaIndex(alice, index, 'library');
  assert.deepEqual(cache.getCachedEmbyList(alice, 1, 20, 'library'), list);
  assert.deepEqual(cache.getCachedEmbyViews(alice), views);
  assert.deepEqual(cache.getCachedMediaIndex(alice, 'library'), index);

  for (const scope of [bob, replaced]) {
    assert.equal(cache.getCachedEmbyList(scope, 1, 20, 'library'), null);
    assert.equal(cache.getCachedEmbyViews(scope), null);
    assert.equal(cache.getCachedMediaIndex(scope, 'library'), null);
  }
});

test('Emby cache preserves pagination, library boundaries and existing expiration periods', (t) => {
  const cache = createSourceLoader()('emby-cache.ts');
  const scope = { uid: '2', client: {} };
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  cache.setCachedEmbyList(scope, 1, 20, { list: ['Alice'] }, 'library:one');
  cache.setCachedEmbyViews(scope, { views: ['Alice'] });
  cache.setCachedMediaIndex(scope, [], 'library:one');
  assert.equal(cache.getCachedEmbyList(scope, 2, 20, 'library:one'), null);
  assert.equal(cache.getCachedEmbyList(scope, 1, 40, 'library:one'), null);
  assert.equal(cache.getCachedEmbyList(scope, 1, 20, 'library:two'), null);
  assert.equal(cache.getCachedMediaIndex(scope, 'library:two'), null);
  assert.equal(cache.getCachedMediaIndex(scope), null);

  now += 6 * 60 * 60 * 1000;
  assert.equal(cache.getCachedEmbyList(scope, 1, 20, 'library:one'), null);
  assert.equal(cache.getCachedMediaIndex(scope, 'library:one'), null);
  assert.deepEqual(cache.getCachedEmbyViews(scope), { views: ['Alice'] });

  now += 18 * 60 * 60 * 1000;
  assert.equal(cache.getCachedEmbyViews(scope), null);
  cache.setCachedEmbyViews(scope, { views: ['Old client'] });
  now += 24 * 60 * 60 * 1000;
  cache.setCachedEmbyViews({ uid: '2', client: {} }, { views: ['New client'] });
  assert.equal(
    cache.getEmbyCacheStats().size,
    1,
    'expired data from old clients is reclaimed on a later write',
  );
  assert.deepEqual(cache.clearEmbyCache(), { cleared: 1 });
});
