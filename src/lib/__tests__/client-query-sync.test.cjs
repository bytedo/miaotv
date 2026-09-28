const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const reactQuery = require('@tanstack/react-query');
const { QueryObserver } = reactQuery;
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createComponentLoader } = require('./component-test-loader.cjs');

const nextTick = () => new Promise(resolve => setImmediate(resolve));
const jsonResponse = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data) });
const savedItem = title => ({ title, source_name: 'Source', year: '2026', cover: '', total_episodes: 1, save_time: 1, releaseDate: '2026-10-01' });

function createFixture(t, fetch, storageType = 'redis', initialAuth = { username: 'fixture', uid: 'fixture-uid' }) {
  const previous = { window: global.window, document: global.document, localStorage: global.localStorage };
  global.window = new EventTarget();
  global.window.RUNTIME_CONFIG = { STORAGE_TYPE: storageType };
  global.window.location = { pathname: '/fixture', search: '', origin: 'http://localhost:3000', href: 'http://localhost:3000/fixture' };
  global.document = new EventTarget();
  global.document.visibilityState = 'visible';
  const storage = new Map();
  global.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
    key: index => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(global, 'fetch', fetch);
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let auth = initialAuth;
  const load = createSourceLoader({
    './auth': { getAuthInfoFromBrowserCookie: () => auth },
    '@tanstack/react-query': { ...reactQuery, environmentManager: { isServer: () => false } },
  });
  const db = load('db.client.ts');
  const queries = load('get-query-client.ts');
  const clients = new Set();
  const effects = [];
  let cleanups = [];
  const loadComponent = createComponentLoader({
    react: {
      ...React,
      useEffect: effect => effects.push(effect),
      useSyncExternalStore: (subscribe, getSnapshot) => {
        const snapshot = getSnapshot();
        effects.push(() => subscribe(() => {
          if (getSnapshot() !== snapshot) render();
        }));
        return snapshot;
      },
    },
    'next/navigation': { usePathname: () => '/fixture' },
    '@tanstack/react-query-devtools': { ReactQueryDevtools: () => null },
    '@/lib/db.client': db,
    '@/lib/get-query-client': queries,
  });
  const Provider = loadComponent('components/QueryProvider.tsx').default;
  function render() {
    cleanups.forEach(cleanup => cleanup?.());
    effects.length = 0;
    renderToStaticMarkup(React.createElement(Provider));
    clients.add(queries.getQueryClient());
    cleanups = effects.map(effect => effect());
  }
  render();
  t.after(() => {
    cleanups.forEach(cleanup => cleanup?.());
    clients.forEach(client => client.clear());
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });
  return {
    db, storage,
    get client() { return queries.getQueryClient(); },
    setAuth(next, notify = true) {
      auth = next;
      if (notify) window.dispatchEvent(new Event('focus'));
    },
  };
}

for (const kind of [
  { root: 'favorites', path: '/api/favorites', read: 'getAllFavorites', save: 'saveFavorite', remove: 'deleteFavorite', check: 'isFavorited' },
  { root: 'reminders', path: '/api/reminders', read: 'getAllReminders', save: 'saveReminder', remove: 'deleteReminder', check: 'isReminded' },
]) {
  test(`${kind.root}: server writes publish full records and refetches retain immediate changes`, async (t) => {
    const initial = { 'source+existing': savedItem('Existing') };
    let getRequests = 0;
    const pendingWrites = [];
    const { db, client } = createFixture(t, (url, options) => {
      assert.ok(url.startsWith(kind.path));
      if (!options.method) { getRequests += 1; return Promise.resolve(jsonResponse(initial)); }
      return new Promise(resolve => pendingWrites.push(resolve));
    });
    const observer = new QueryObserver(client, {
      queryKey: [kind.root], queryFn: () => db[kind.read](), staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    t.after(unsubscribe);
    await client.ensureQueryData({ queryKey: [kind.root], queryFn: () => db[kind.read]() });
    const beforeWrite = await db[kind.read]();
    await nextTick();
    const originalGetCount = getRequests;
    const added = savedItem('Added');
    const save = db[kind.save]('source', 'added', added);
    await nextTick();
    assert.deepEqual(client.getQueryData([kind.root]), { ...initial, 'source+added': added });
    assert.equal(beforeWrite['source+added'], undefined);
    assert.equal(await db[kind.check]('source', 'added'), true);
    pendingWrites.shift()(jsonResponse({ success: true }));
    await save;
    await observer.refetch();
    assert.equal(getRequests, originalGetCount);
    assert.equal(observer.getCurrentResult().data['source+added'].title, 'Added');

    const remove = db[kind.remove]('source', 'added');
    await nextTick();
    assert.deepEqual(client.getQueryData([kind.root]), initial);
    pendingWrites.shift()(jsonResponse({ success: true }));
    await remove;
    assert.equal(await db[kind.check]('source', 'added'), false);
    assert.deepEqual(await db[kind.read](), initial);
    assert.equal(getRequests, originalGetCount);
  });

  test(`${kind.root}: a failed write preserves another completed write and rejects stale background data`, async (t) => {
    const initial = { 'source+existing': savedItem('Existing') };
    let gets = 0;
    let resolveBackground;
    let resolveFailure;
    const { db, client } = createFixture(t, (url, options) => {
      if (!options.method) {
        gets += 1;
        if (gets === 1) return Promise.resolve(jsonResponse(initial));
        return new Promise(resolve => { resolveBackground = resolve; });
      }
      const key = JSON.parse(options.body).key;
      if (key === 'source+failed') return new Promise(resolve => { resolveFailure = resolve; });
      return Promise.resolve(jsonResponse({ success: true }));
    });
    await db[kind.read]();
    await db[kind.read](); // Starts a background read of the old snapshot.
    const failure = db[kind.save]('source', 'failed', savedItem('Failed'));
    const rejection = assert.rejects(failure, /500/);
    await nextTick();
    await db[kind.save]('source', 'saved', savedItem('Saved'));
    resolveBackground(jsonResponse(initial));
    await nextTick();
    assert.equal(client.getQueryData([kind.root])['source+saved'].title, 'Saved');
    resolveFailure(jsonResponse({ error: 'offline' }, 500));
    await rejection;
    const expected = { ...initial, 'source+saved': savedItem('Saved') };
    assert.deepEqual(await db[kind.read](), expected);
    assert.deepEqual(client.getQueryData([kind.root]), expected);
  });

  test(`${kind.root}: simultaneous local saves and deletes retain unrelated entries`, async (t) => {
    const { db, client } = createFixture(t, () => { throw new Error('Local storage must stay offline'); }, 'localstorage');
    await Promise.all([
      db[kind.save]('source', 'first', savedItem('First')),
      db[kind.save]('source', 'second', savedItem('Second')),
    ]);
    assert.deepEqual(await db[kind.read](), {
      'source+first': savedItem('First'), 'source+second': savedItem('Second'),
    });
    await Promise.all([
      db[kind.remove]('source', 'first'),
      db[kind.save]('source', 'third', savedItem('Third')),
    ]);
    const expected = { 'source+second': savedItem('Second'), 'source+third': savedItem('Third') };
    assert.deepEqual(await db[kind.read](), expected);
    assert.deepEqual(client.getQueryData([kind.root]), expected);
  });
}

test('deleting a server play record keeps the resume cache and remaining records synchronized', async (t) => {
  const initial = { 'source+first': savedItem('First'), 'source+second': savedItem('Second') };
  let resolveDelete;
  const { db, client } = createFixture(t, (_url, options) => {
    if (!options.method) return Promise.resolve(jsonResponse(initial));
    return new Promise(resolve => { resolveDelete = resolve; });
  });
  await db.getAllPlayRecords();
  const remove = db.deletePlayRecord('source', 'first');
  await nextTick();
  assert.deepEqual(client.getQueryData(['playRecords']), { 'source+second': initial['source+second'] });
  assert.deepEqual(await db.getAllPlayRecords(), { 'source+second': initial['source+second'] });
  resolveDelete(jsonResponse({ success: true }));
  await remove;
  assert.deepEqual(await db.getAllPlayRecords(), { 'source+second': initial['source+second'] });
});

test('renaming keeps the UID cache, while reusing the username creates a separate query client', async (t) => {
  const original = { 'source+original': savedItem('Original account') };
  let serverRecords = original;
  const fixture = createFixture(t, () => Promise.resolve(jsonResponse(serverRecords)));
  const firstClient = fixture.client;
  await firstClient.ensureQueryData({ queryKey: ['favorites'], queryFn: () => fixture.db.getAllFavorites() });
  fixture.setAuth({ uid: 'fixture-uid', username: 'renamed' });
  assert.equal(fixture.client, firstClient);
  assert.deepEqual(await fixture.db.getAllFavorites(), original);

  serverRecords = { 'source+new': savedItem('New account') };
  fixture.setAuth({ uid: 'new-uid', username: 'fixture' });
  const secondClient = fixture.client;
  assert.notEqual(secondClient, firstClient);
  assert.equal(secondClient.getQueryData(['favorites']), undefined);
  assert.equal(firstClient.getQueryData(['favorites']), undefined);
  assert.deepEqual(await fixture.db.getAllFavorites(), serverRecords);
  firstClient.setQueryData(['favorites'], original); // A late callback still holds the retired instance.
  assert.equal(secondClient.getQueryData(['favorites']), undefined);
  fixture.setAuth(null);
  assert.notEqual(fixture.client, secondClient);
  assert.equal(fixture.client.getQueryData(['favorites']), undefined);
});

test('pending requests are deduplicated within a UID and never reused by a namesake account', async (t) => {
  const pending = [];
  const fixture = createFixture(t, () => new Promise(resolve => pending.push(resolve)));
  const firstRead = fixture.db.getAllFavorites();
  const duplicateRead = fixture.db.getAllFavorites();
  const firstRejection = assert.rejects(firstRead, /账号已切换/);
  const duplicateRejection = assert.rejects(duplicateRead, /账号已切换/);
  assert.equal(pending.length, 1);
  fixture.setAuth({ uid: 'second-uid', username: 'fixture' });
  const secondRead = fixture.db.getAllFavorites();
  assert.equal(pending.length, 2);
  const secondRecords = { 'source+second': savedItem('Second') };
  pending[1](jsonResponse(secondRecords));
  assert.deepEqual(await secondRead, secondRecords);
  pending[0](jsonResponse({ 'source+first': savedItem('First') }));
  await Promise.all([firstRejection, duplicateRejection]);
  assert.equal(fixture.db.getCacheStatus().hasFavorites, true);
  // An independent background refresh can start for the new account.
  assert.deepEqual(await fixture.db.getAllFavorites(), secondRecords);
  assert.equal(pending.length, 3);
  pending[2](jsonResponse(secondRecords));
  await nextTick();
});

test('an account switch during JSON parsing discards the old response before it can populate the cache', async (t) => {
  let finishJson;
  let request = 0;
  const currentRecords = { 'source+current': savedItem('Current') };
  const fixture = createFixture(t, () => {
    request += 1;
    if (request === 1) return Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => { finishJson = resolve; }) });
    return Promise.resolve(jsonResponse(currentRecords));
  });
  const oldRead = fixture.db.getAllFavorites();
  const rejection = assert.rejects(oldRead, /账号已切换/);
  await nextTick();
  fixture.setAuth({ uid: 'current-uid', username: 'fixture' });
  assert.deepEqual(await fixture.db.getAllFavorites(), currentRecords);
  finishJson({ 'source+old': savedItem('Old') });
  await rejection;
  assert.deepEqual(await fixture.db.getAllFavorites(), currentRecords);
});

test('a pending optimistic write cannot roll back or log out the next account', async (t) => {
  let resolveWrite;
  const original = { 'source+shared': savedItem('Original') };
  const replacement = { 'source+shared': savedItem('Replacement') };
  let serverRecords = original;
  let logoutRequests = 0;
  const fixture = createFixture(t, (url, options) => {
    if (url === '/api/logout') logoutRequests += 1;
    if (options.method) return new Promise(resolve => { resolveWrite = resolve; });
    return Promise.resolve(jsonResponse(serverRecords));
  });
  await fixture.db.getAllFavorites();
  const write = fixture.db.deleteFavorite('source', 'shared');
  const rejection = assert.rejects(write, /账号已切换/);
  await nextTick();
  serverRecords = replacement;
  fixture.setAuth({ uid: 'replacement-uid', username: 'fixture' });
  const client = fixture.client;
  await client.ensureQueryData({ queryKey: ['favorites'], queryFn: () => fixture.db.getAllFavorites() });
  resolveWrite(jsonResponse({ error: 'expired session' }, 401));
  await rejection;
  assert.deepEqual(await fixture.db.getAllFavorites(), replacement);
  assert.deepEqual(client.getQueryData(['favorites']), replacement);
  assert.equal(logoutRequests, 0);
  assert.equal(window.location.href, 'http://localhost:3000/fixture');
  serverRecords = original;
  fixture.setAuth({ uid: 'fixture-uid', username: 'renamed' });
  assert.equal(fixture.db.getCacheStatus().hasFavorites, false);
  assert.deepEqual(await fixture.db.getAllFavorites(), original);
});

test('a stale 401 after the same UID signs in again does not redirect or retain an abandoned write', async (t) => {
  let resolveWrite;
  const records = { 'source+saved': savedItem('Saved') };
  const fixture = createFixture(t, (_url, options) => {
    if (options.method) return new Promise(resolve => { resolveWrite = resolve; });
    return Promise.resolve(jsonResponse(records));
  }, 'redis', { uid: 'fixture-uid', username: 'fixture', signature: 'old-session', sessionVersion: 1 });
  await fixture.db.getAllFavorites();
  const client = fixture.client;
  const remove = fixture.db.deleteFavorite('source', 'saved');
  const rejection = assert.rejects(remove, /账号已切换/);
  await nextTick();
  fixture.setAuth({ uid: 'fixture-uid', username: 'renamed', signature: 'new-session', sessionVersion: 2 });
  resolveWrite(jsonResponse({ error: 'expired' }, 401));
  await rejection;
  assert.equal(fixture.client, client);
  assert.deepEqual(await fixture.db.getAllFavorites(), records);
  assert.deepEqual(client.getQueryData(['favorites']), records);
  assert.equal(window.location.href, 'http://localhost:3000/fixture');
});

test('a save awaiting its initial cache load does not post after the account changes', async (t) => {
  let resolveInitialRead;
  const requests = [];
  const fixture = createFixture(t, (url, options) => {
    requests.push({ url, method: options.method });
    return new Promise(resolve => { resolveInitialRead = resolve; });
  });
  const save = fixture.db.saveFavorite('source', 'private', savedItem('Private'));
  const rejection = assert.rejects(save, /账号已切换/);
  fixture.setAuth({ uid: 'replacement-uid', username: 'fixture' });
  resolveInitialRead(jsonResponse({}));
  await rejection;
  assert.deepEqual(requests.map(request => request.method), [undefined]);
  assert.equal(fixture.db.getCacheStatus().hasFavorites, false);
  assert.equal(fixture.client.getQueryData(['favorites']), undefined);
});

test('a batch refresh cannot publish responses that completed before switching accounts', async (t) => {
  let resolveSkipConfigs;
  let replacement = false;
  const original = { 'source+old': savedItem('Old') };
  const current = { 'source+new': savedItem('New') };
  const fixture = createFixture(t, url => {
    if (!replacement && url === '/api/skipconfigs') return new Promise(resolve => { resolveSkipConfigs = resolve; });
    return Promise.resolve(jsonResponse(url === '/api/searchhistory' ? [] : replacement ? current : original));
  });
  const refresh = fixture.db.refreshAllCache();
  const rejection = assert.rejects(refresh, /账号已切换/);
  await nextTick();
  replacement = true;
  fixture.setAuth({ uid: 'replacement-uid', username: 'fixture' });
  await fixture.client.ensureQueryData({ queryKey: ['favorites'], queryFn: () => fixture.db.getAllFavorites() });
  resolveSkipConfigs(jsonResponse({}));
  await rejection;
  assert.deepEqual(await fixture.db.getAllFavorites(), current);
  assert.deepEqual(fixture.client.getQueryData(['favorites']), current);
  assert.equal(fixture.db.getCacheStatus().hasPlayRecords, false);
});

test('local records belong to the UID across rename and username reuse', async (t) => {
  const fixture = createFixture(t, () => { throw new Error('Local storage must stay offline'); }, 'localstorage');
  await fixture.db.saveFavorite('source', 'first', savedItem('First account'));
  fixture.setAuth({ uid: 'fixture-uid', username: 'renamed' });
  assert.deepEqual(await fixture.db.getAllFavorites(), { 'source+first': savedItem('First account') });
  fixture.setAuth({ uid: 'second-uid', username: 'fixture' });
  assert.deepEqual(await fixture.db.getAllFavorites(), {});
  await fixture.db.saveFavorite('source', 'second', savedItem('Second account'));
  await fixture.db.clearAllFavorites();
  assert.deepEqual(await fixture.db.getAllFavorites(), {});
  fixture.setAuth({ uid: 'fixture-uid', username: 'renamed' });
  assert.deepEqual(await fixture.db.getAllFavorites(), { 'source+first': savedItem('First account') });
});

test('watch progress keeps its UID after rename and starts independently for the next account', async (t) => {
  const increments = [];
  const fixture = createFixture(t, (_url, options) => {
    increments.push(JSON.parse(options.body).watchTime);
    return Promise.resolve(jsonResponse({}));
  });
  const record = { ...savedItem('Episode'), play_time: 30, total_time: 1800, index: 1 };
  await fixture.db.updateUserStats(record);
  fixture.setAuth({ uid: 'fixture-uid', username: 'renamed' });
  await fixture.db.updateUserStats({ ...record, play_time: 60 });
  fixture.setAuth({ uid: 'second-uid', username: 'fixture' });
  await fixture.db.updateUserStats(record);
  assert.deepEqual(increments, [30, 30, 30]);
});

test('a legacy username cache cannot collide with a UID having the same text', async (t) => {
  let serverRecords = { 'source+legacy': savedItem('Legacy') };
  const fixture = createFixture(t, () => Promise.resolve(jsonResponse(serverRecords)), 'redis', { username: 'shared' });
  await fixture.db.getAllFavorites();
  serverRecords = {};
  fixture.setAuth({ uid: 'shared', username: 'new-user' });
  assert.equal(fixture.db.getCacheStatus().hasFavorites, false);
  assert.deepEqual(await fixture.db.getAllFavorites(), {});
});

test('background refresh throttling is independent for each UID', async (t) => {
  let requests = 0;
  const fixture = createFixture(t, () => {
    requests += 1;
    return Promise.resolve(jsonResponse({}));
  });
  await fixture.db.getAllFavorites();
  await fixture.db.getAllFavorites();
  await nextTick();
  assert.equal(requests, 2);
  await fixture.db.getAllFavorites();
  assert.equal(requests, 2);
  fixture.setAuth({ uid: 'second-uid', username: 'fixture' });
  await fixture.db.getAllFavorites();
  await fixture.db.getAllFavorites();
  await nextTick();
  assert.equal(requests, 4);
});

test('UUID to numeric UID upgrade discards pending old-session responses and refetches the same account', async (t) => {
  const pending = [];
  const fixture = createFixture(t, () => new Promise(resolve => pending.push(resolve)), 'redis', {
    uid: '10000000-0000-4000-8000-000000000001', username: 'fixture',
  });
  const previousClient = fixture.client;
  const oldRead = fixture.db.getAllFavorites();
  const rejection = assert.rejects(oldRead, /账号已切换/);
  fixture.setAuth({ uid: '1', username: 'fixture' });
  assert.notEqual(fixture.client, previousClient);
  assert.equal(fixture.client.getQueryData(['favorites']), undefined);
  const newRead = fixture.db.getAllFavorites();
  const records = { 'source+saved': savedItem('Preserved server account') };
  pending[1](jsonResponse(records));
  assert.deepEqual(await newRead, records);
  pending[0](jsonResponse({ 'source+stale': savedItem('Old cached snapshot') }));
  await rejection;
  assert.equal(fixture.db.getCacheStatus().hasFavorites, true);
});

test('numeric UIDs keep separate offline records across rename, username reuse and numeric usernames', async (t) => {
  const fixture = createFixture(t, () => { throw new Error('Local storage must stay offline'); }, 'localstorage', {
    uid: '1', username: '2',
  });
  const firstClient = fixture.client;
  await fixture.db.saveFavorite('source', 'first', savedItem('First account'));
  fixture.setAuth({ uid: '1', username: 'renamed' });
  assert.equal(fixture.client, firstClient);
  assert.deepEqual(await fixture.db.getAllFavorites(), { 'source+first': savedItem('First account') });
  fixture.setAuth({ uid: '2', username: '2' });
  assert.notEqual(fixture.client, firstClient);
  assert.deepEqual(await fixture.db.getAllFavorites(), {});
  await fixture.db.saveFavorite('source', 'second', savedItem('Second account'));
  fixture.setAuth({ uid: '12', username: '1' });
  assert.deepEqual(await fixture.db.getAllFavorites(), {});
  fixture.setAuth({ uid: '1', username: 'renamed' });
  assert.deepEqual(await fixture.db.getAllFavorites(), { 'source+first': savedItem('First account') });
  fixture.setAuth({ uid: '2', username: '2' });
  assert.deepEqual(await fixture.db.getAllFavorites(), { 'source+second': savedItem('Second account') });
});
