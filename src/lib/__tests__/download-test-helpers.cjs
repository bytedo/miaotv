const { createSourceLoader } = require('./storage-test-loader.cjs');

function createIndexedDB() {
  const databases = new Map();
  const state = { abortNextWrite: false };
  const factory = {
    open(name, version) {
      const request = {};
      queueMicrotask(() => {
        let data = databases.get(name);
        const upgrade = !data || data.version < version;
        if (!data) databases.set(name, data = { version, stores: new Map() });
        const db = {
          objectStoreNames: { contains: (store) => data.stores.has(store) },
          createObjectStore(store, options) {
            data.stores.set(store, { keyPath: options.keyPath, rows: new Map() });
            return { createIndex() {} };
          },
          close() {},
          transaction(names, mode) {
            for (const store of names) if (!data.stores.has(store)) throw new DOMException('Missing store', 'NotFoundError');
            const snapshots = new Map(names.map(store => [store, new Map(data.stores.get(store).rows)]));
            const mutations = [];
            const transaction = { error: null };
            let pending = 0;
            let scheduled = false;
            const complete = () => {
              if (pending || scheduled) return;
              scheduled = true;
              setImmediate(() => {
                scheduled = false;
                if (pending) return;
                if (mode === 'readwrite' && state.abortNextWrite) {
                  state.abortNextWrite = false;
                  transaction.error = new DOMException('Commit failed', 'QuotaExceededError');
                  transaction.onabort?.();
                  return;
                }
                if (mode === 'readwrite') for (const mutation of mutations) {
                  const rows = data.stores.get(mutation.store).rows;
                  if (mutation.delete) rows.delete(mutation.key); else rows.set(mutation.key, mutation.value);
                }
                transaction.oncomplete?.();
              });
            };
            const enqueue = (operation) => {
              const result = {};
              pending++;
              queueMicrotask(() => {
                try { result.result = operation(); result.onsuccess?.({ target: result }); }
                catch (error) { result.error = error; transaction.error = error; result.onerror?.(); transaction.onerror?.(); }
                pending--;
                complete();
              });
              return result;
            };
            transaction.objectStore = (store) => {
              const schema = data.stores.get(store);
              const rows = snapshots.get(store);
              const key = (value) => JSON.stringify(Array.isArray(schema.keyPath) ? schema.keyPath.map(part => value[part]) : value[schema.keyPath]);
              return {
                put: (value) => enqueue(() => { const copy = structuredClone(value); rows.set(key(copy), copy); mutations.push({ store, key: key(copy), value: copy }); return key(copy); }),
                get: (value) => enqueue(() => structuredClone(rows.get(JSON.stringify(value)))),
                getAll: () => enqueue(() => structuredClone([...rows.values()])),
                delete: (value) => enqueue(() => { mutations.push({ store, key: JSON.stringify(value), delete: true }); return rows.delete(JSON.stringify(value)); }),
                index: (field) => ({ getAll: (value) => enqueue(() => structuredClone([...rows.values()].filter(row => row[field] === value))) }),
              };
            };
            complete();
            return transaction;
          },
        };
        request.result = db;
        if (upgrade) { data.version = version; request.onupgradeneeded?.({ target: request }); }
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory, state };
}

function installDownloadBrowser(t, fetcher = () => { throw new Error('Unexpected network request'); }) {
  const downloads = [];
  const blobs = new Map();
  const previous = new Map();
  const set = (key, value) => { previous.set(key, Object.getOwnPropertyDescriptor(global, key)); Object.defineProperty(global, key, { value, configurable: true, writable: true }); };
  const idb = createIndexedDB();
  set('window', { location: { href: 'https://site.test/', origin: 'https://site.test' }, setTimeout: (fn) => { fn(); return 0; } });
  set('navigator', {});
  const storage = new Map();
  set('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) });
  set('indexedDB', idb.factory);
  set('fetch', fetcher);
  set('document', { body: { appendChild() {}, removeChild() {} }, createElement: () => ({ style: {}, click() { downloads.push({ filename: this.download, blob: blobs.get(this.href) }); }, remove() {} }) });
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { const id = `blob:test-${blobs.size}`; blobs.set(id, blob); return id; };
  URL.revokeObjectURL = () => {};
  t.after(() => {
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key];
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  return { downloads, idb, storage };
}

function makeTask(overrides = {}) {
  return {
    url: 'https://media.test/list.m3u8', title: 'synthetic', type: 'TS',
    tsUrlList: ['https://media.test/0.ts', 'https://media.test/1.ts'],
    finishList: [{ title: '0.ts', status: '' }, { title: '1.ts', status: '' }],
    downloadIndex: 0, finishNum: 0, errorNum: 0,
    aesConf: { method: '', uri: '', iv: '', key: '' },
    durationSecond: 4, segmentDurations: [2, 2],
    rangeDownload: { startSegment: 1, endSegment: 2, targetSegment: 2 },
    ...overrides,
  };
}

function loadDownloader(overrides = {}) {
  return createSourceLoader({
    '../user-agent': { getRandomUserAgent: () => 'test', DEFAULT_USER_AGENT: 'test' },
    ...overrides,
  })('download/m3u8-downloader.ts');
}

const buffer = value => Uint8Array.from(value).buffer;
const commit = () => new Promise(resolve => setImmediate(resolve));

function loadDownloadProvider(react, overrides) {
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');
  const ts = require('typescript');
  const filename = path.resolve(__dirname, '../../contexts/DownloadContext.tsx');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const instance = new Module(filename, module);
  const sources = createSourceLoader();
  const stubs = {
    react: { ...react, createContext: () => ({ Provider: 'download-provider' }) },
    sonner: { toast: { warning() {} } },
    '@/lib/download/stream-mode-detector': { getBestStreamMode: () => 'disabled', detectStreamModeSupport: () => ({ fileSystem: false, serviceWorker: false, blob: true }), estimateServiceWorkerRisk: () => false },
    ...overrides,
  };
  instance.require = name => Object.hasOwn(stubs, name) ? stubs[name] : name.startsWith('@/lib/') ? sources(name.slice(6) + '.ts') : require(name);
  instance._compile(source, filename);
  return instance.exports.DownloadProvider;
}
module.exports = { createIndexedDB, installDownloadBrowser, makeTask, loadDownloader, loadDownloadProvider, buffer, commit };
