const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const CryptoJS = require('crypto-js');
const { createSourceLoader } = require('./storage-test-loader.cjs');
const { createHookHost } = require('./playback-test-helpers.cjs');
const { createIndexedDB, installDownloadBrowser, makeTask, loadDownloader, loadDownloadProvider, buffer, commit } = require('./download-test-helpers.cjs');

function encrypt(data, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength);
}

test('AES key bytes survive task persistence and decrypt the same content after reload', async t => {
  installDownloadBrowser(t);
  const idb = createSourceLoader()('download/download-idb.ts');
  const key = Buffer.from('0123456789abcdef');
  const iv = Buffer.alloc(16, 3);
  const plaintext = Buffer.from('synthetic media payload for a refreshed download');
  const task = makeTask({ aesConf: { method: 'AES-128', uri: 'https://media.test/key', iv: iv.toString('hex'), key: CryptoJS.enc.Hex.parse(key.toString('hex')) } });
  await idb.saveTask('encrypted', task, 'downloading');
  await commit();
  const stored = (await idb.getAllTasks())[0];
  const { aesDecrypt } = loadDownloader();
  assert.deepEqual(Buffer.from(aesDecrypt(encrypt(plaintext, key, iv), stored.task.aesConf.key, stored.task.aesConf.iv)), plaintext);
  assert.equal(stored.status, 'pause');
});

test('resumed streaming downloads write cached fragments in order and count them once', async t => {
  installDownloadBrowser(t);
  const chunks = [];
  let closed = false;
  const stream = new WritableStream({ write: chunk => chunks.push(Buffer.from(chunk)), close: () => { closed = true; } });
  const { downloadM3U8Video } = loadDownloader({ './stream-saver-fallback': { createFileSystemWriteStream: async () => stream } });
  const task = makeTask({ downloadedSegments: new Map([[0, buffer([1, 2])], [1, buffer([3, 4])]]), finishNum: 2 });
  await downloadM3U8Video(task, undefined, undefined, undefined, 2, 'file-system', 0, undefined, 'resumed');
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4]));
  assert.equal(closed, true);
  assert.equal(task.finishNum, 2);
  const persisted = await createSourceLoader()('download/download-idb.ts').getTaskSegments('resumed');
  assert.equal(persisted.size, 2, 'retrying also repairs evicted persistent fragments from the in-memory cache');
});

test('a transaction aborted after put success cannot be reported as persisted', async t => {
  const { idb: fake } = installDownloadBrowser(t);
  const idb = createSourceLoader()('download/download-idb.ts');
  fake.state.abortNextWrite = true;
  await assert.rejects(idb.saveTask('aborted', makeTask(), 'ready'), /Commit failed/);
  assert.deepEqual(await idb.getAllTasks(), []);
});

for (const mode of ['disabled', 'file-system', 'service-worker']) {
  test(`permanently missing fragments fail instead of completing in ${mode} mode`, async t => {
    const { downloads } = installDownloadBrowser(t, async url => url.endsWith('0.ts') ? new Response(buffer([1, 2])) : new Response('missing', { status: 404 }));
    let closed = false;
    let aborted = false;
    const progress = [];
    const stream = new WritableStream({ write() {}, close: () => { closed = true; }, abort: () => { aborted = true; } });
    const { downloadM3U8Video } = loadDownloader({
      './stream-saver-fallback': { createFileSystemWriteStream: async () => stream },
      './stream-saver': { createWriteStream: () => stream },
    });
    await assert.rejects(downloadM3U8Video(makeTask(), update => progress.push(update), undefined, undefined, 2, mode, 0), /片段.*失败/);
    assert.equal(progress.some(update => update.status === 'done'), false);
    assert.equal(downloads.length, 0);
    assert.equal(closed, false);
    if (mode !== 'disabled') assert.equal(aborted, true);
  });
}

test('export validates every selected fragment and keeps the original range and format', async t => {
  installDownloadBrowser(t);
  const { createCachedDownloadBlob } = loadDownloader();
  const task = makeTask({ tsUrlList: ['0', '1', '2'], rangeDownload: { startSegment: 2, endSegment: 3, targetSegment: 2 } });
  const segments = new Map([[0, buffer([99])], [2, buffer([3])]]);
  assert.throws(() => createCachedDownloadBlob(task, segments), /缺少第 2 个分片/);
  segments.set(1, buffer([]));
  assert.throws(() => createCachedDownloadBlob(task, segments), /缺少第 2 个分片/);
  segments.set(1, buffer([2]));
  assert.deepEqual(Buffer.from(await createCachedDownloadBlob(task, segments).arrayBuffer()), Buffer.from([2, 3]));
  const mp4 = makeTask({ type: 'MP4', mapSegment: { url: 'https://media.test/init.mp4' } });
  const fragments = new Map([[0, buffer([1])], [1, buffer([2])]]);
  assert.throws(() => createCachedDownloadBlob(mp4, fragments), /初始化分片/);
  fragments.set(-1, buffer([0]));
  const blob = createCachedDownloadBlob(mp4, fragments);
  assert.equal(blob.type, 'video/mp4');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.from([0, 1, 2]));
});

test('refresh recomputes completion from cached range data instead of stale done metadata', () => {
  const { restoreDownloadTask } = createSourceLoader()('download/download-cache.ts');
  const stored = { id: 'task', task: makeTask({ finishNum: 2 }), status: 'done' };
  let restored = restoreDownloadTask(stored, new Map([[0, buffer([1])], [5, buffer([9])]]));
  assert.equal(restored.status, 'error');
  assert.equal(restored.finishNum, 1);
  assert.equal(restored.finishList[0].status, 'success');
  assert.equal(restored.finishList[1].status, '');
  restored = restoreDownloadTask({ ...stored, status: 'downloading' }, new Map([[1, buffer([2])]]));
  assert.equal(restored.status, 'pause');
  assert.equal(restored.finishNum, 1);
  assert.equal(restored.finishList[1].status, 'success');
});

test('new encrypted downloads use the media sequence as IV and preserve bytes after refresh', async t => {
  const key = Buffer.from('0123456789abcdef');
  const plaintext = [Buffer.from('first synthetic segment'), Buffer.from('second synthetic segment')];
  const ciphers = plaintext.map((bytes, index) => { const iv = Buffer.alloc(16); iv.writeUInt32BE(42 + index, 12); return encrypt(bytes, key, iv); });
  const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\n0.ts\n#EXTINF:2,\n1.ts\n#EXT-X-ENDLIST\n';
  const fetched = [];
  const { downloads } = installDownloadBrowser(t, async url => {
    fetched.push(url);
    if (url.endsWith('.m3u8')) return new Response(manifest);
    if (url.endsWith('key.bin')) return new Response(key);
    return new Response(ciphers[Number(new URL(url).pathname.slice(1, 2))]);
  });
  const downloader = loadDownloader();
  const idb = createSourceLoader()('download/download-idb.ts');
  const task = await downloader.parseM3U8('https://media.test/list.m3u8');
  await idb.saveTask('encrypted', task, 'downloading');
  await idb.saveSegment('encrypted', 0, plaintext[0].buffer.slice(plaintext[0].byteOffset, plaintext[0].byteOffset + plaintext[0].byteLength));
  const stored = (await idb.getAllTasks())[0];
  const restored = { ...stored.task, downloadedSegments: await idb.getTaskSegments(stored.id) };
  await downloader.downloadM3U8Video(restored, undefined, undefined, undefined, 2, 'disabled', 0, undefined, stored.id);
  assert.equal(fetched.some(url => url.endsWith('0.ts')), false);
  assert.deepEqual(Buffer.from(await downloads[0].blob.arrayBuffer()), Buffer.concat(plaintext));
  const saved = await idb.getTaskSegments(stored.id);
  assert.deepEqual(Buffer.from(saved.get(1)), plaintext[1]);
  assert.equal(restored.finishNum, 2);
  const legacy = { ...stored.task, aesConf: { ...stored.task.aesConf, key: new Uint8Array(16) }, downloadedSegments: new Map([[0, saved.get(0)]]) };
  delete legacy.mediaSequence;
  await downloader.downloadM3U8Video(legacy, undefined, undefined, undefined, 2, 'disabled', 0);
  assert.deepEqual(Buffer.from(await downloads[1].blob.arrayBuffer()), Buffer.concat(plaintext));
  assert.equal(legacy.mediaSequence, 42);
});

test('invalid encrypted data and unsupported key changes fail without emitting corrupt files', async t => {
  installDownloadBrowser(t, async () => new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="a"\n#EXTINF:1,\na.ts\n#EXT-X-KEY:METHOD=AES-128,URI="b"\n#EXTINF:1,\nb.ts'));
  const { aesDecrypt, parseM3U8 } = loadDownloader();
  assert.throws(() => aesDecrypt(buffer([1, 2, 3]), '00000000000000000000000000000000', ''), /不完整/);
  await assert.rejects(parseM3U8('https://media.test/list.m3u8'), /切换加密密钥/);
});

test('fragment storage waits for bucket initialization, reads legacy fragments, and deletes both stores', async t => {
  installDownloadBrowser(t);
  const legacy = createSourceLoader()('download/download-idb.ts');
  await legacy.saveTask('task', makeTask(), 'pause');
  await legacy.saveSegment('task', 0, buffer([1]));
  const bucket = createIndexedDB();
  let ready;
  navigator.storageBuckets = { open: () => new Promise(resolve => { ready = resolve; }) };
  const current = createSourceLoader()('download/download-idb.ts');
  let saved = false;
  const pending = current.saveSegment('task', 1, buffer([2])).then(() => { saved = true; });
  await Promise.resolve();
  assert.equal(saved, false);
  ready({ name: 'video-segments', indexedDB: bucket.factory });
  await pending;
  const segments = await current.getTaskSegments('task');
  assert.deepEqual([...segments.keys()].sort(), [0, 1]);
  await current.deleteTask('task');
  assert.equal((await current.getAllTasks()).length, 0);
  assert.equal((await current.getTaskSegments('task')).size, 0);
});

test('cached initialization data survives streaming resume and permits an offline MP4 export', async t => {
  const { downloads } = installDownloadBrowser(t);
  const chunks = [];
  const stream = new WritableStream({ write: chunk => chunks.push(Buffer.from(chunk)) });
  const downloader = loadDownloader({ './stream-saver-fallback': { createFileSystemWriteStream: async () => stream } });
  const task = makeTask({ type: 'MP4', mapSegment: { url: 'https://media.test/init.mp4' }, downloadedSegments: new Map([[-1, buffer([0])], [0, buffer([1])], [1, buffer([2])]]) });
  await downloader.downloadM3U8Video(task, undefined, undefined, undefined, 2, 'file-system', 0);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 1, 2]));
  assert.equal(task.finishNum, 2);
  const blob = downloader.createCachedDownloadBlob(task, task.downloadedSegments);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.concat(chunks));
  assert.equal(downloads.length, 0);
});

for (const encryptedInitialization of [true, false]) {
test(`AES media with ${encryptedInitialization ? 'encrypted' : 'plain'} initialization exports intact`, async t => {
  const key = Buffer.from('0123456789abcdef');
  const iv = Buffer.alloc(16, 9);
  const initialization = Buffer.from('synthetic MP4 initialization');
  const media = Buffer.from('synthetic fragmented MP4 media');
  const keyTag = `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString('hex')}`;
  const mapTag = '#EXT-X-MAP:URI="init.mp4"';
  const manifest = `#EXTM3U\n${encryptedInitialization ? keyTag + '\n' + mapTag : mapTag + '\n' + keyTag}\n#EXTINF:2,\n0.m4s\n#EXT-X-ENDLIST\n`;
  const { downloads } = installDownloadBrowser(t, async url => {
    if (url.endsWith('.m3u8')) return new Response(manifest);
    if (url.endsWith('key.bin')) return new Response(key);
    if (url.endsWith('init.mp4') && !encryptedInitialization) return new Response(initialization);
    return new Response(encrypt(url.endsWith('init.mp4') ? initialization : media, key, iv));
  });
  const downloader = loadDownloader();
  const task = await downloader.parseM3U8('https://media.test/list.m3u8');
  task.type = 'MP4';
  await downloader.downloadM3U8Video(task, undefined, undefined, undefined, 2, 'disabled', 0);
  assert.deepEqual(Buffer.from(await downloads[0].blob.arrayBuffer()), Buffer.concat([initialization, media]));
  assert.deepEqual(Buffer.from(await downloader.createCachedDownloadBlob(task, task.downloadedSegments).arrayBuffer()), Buffer.concat([initialization, media]));
});
}

test('the provider resumes an existing paused controller instead of starting another download', async t => {
  installDownloadBrowser(t);
  const host = createHookHost();
  t.after(() => host.unmount());
  let complete;
  const calls = [];
  const statusChanges = [];
  const actual = loadDownloader();
  const DownloadProvider = loadDownloadProvider(host.React, {
    '@/lib/download': { ...actual, downloadM3U8Video: async (...args) => { calls.push(args); await new Promise(resolve => { complete = resolve; }); } },
    '@/lib/download/download-idb': {
      getAllTasks: async () => [{ id: 'task', task: makeTask(), status: 'pause' }], getTaskSegments: async () => new Map(),
      isStorageBucketsSupported: () => false, updateTaskStatus: async (id, status) => statusChanges.push(status),
    },
  });
  const render = () => host.render(() => DownloadProvider({ children: null })).props.value;
  render();
  await commit();
  const pending = render().startTask('task');
  await commit();
  await render().pauseTask('task');
  assert.equal(calls[0][3].getPaused(), true);
  await render().startTask('task');
  assert.equal(calls[0][3].getPaused(), false);
  assert.equal(calls.length, 1);
  assert.equal(render().tasks[0].status, 'downloading');
  complete();
  await pending;
  assert.equal(render().tasks[0].status, 'done');
  assert.deepEqual(statusChanges, ['downloading', 'pause', 'downloading', 'done']);
});

test('cancelling a paused provider task releases its pending download without recreating metadata', { timeout: 3000 }, async t => {
  installDownloadBrowser(t);
  const host = createHookHost();
  t.after(() => host.unmount());
  let reachPause;
  const gate = new Promise(resolve => { reachPause = resolve; });
  const statusChanges = [];
  const deleted = [];
  const actual = loadDownloader();
  const DownloadProvider = loadDownloadProvider(host.React, {
    '@/lib/download': { ...actual, downloadM3U8Video: async (_task, _progress, signal, pause) => {
      await gate;
      await pause.waitIfPaused();
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    } },
    '@/lib/download/download-idb': {
      getAllTasks: async () => [{ id: 'task', task: makeTask(), status: 'pause' }], getTaskSegments: async () => new Map(),
      isStorageBucketsSupported: () => false, updateTaskStatus: async (id, status) => statusChanges.push(status), deleteTask: async id => deleted.push(id),
    },
  });
  const render = () => host.render(() => DownloadProvider({ children: null })).props.value;
  render();
  await commit();
  const pending = render().startTask('task');
  await commit();
  await render().pauseTask('task');
  reachPause();
  await commit();
  await render().cancelTask('task');
  await pending;
  assert.deepEqual(render().tasks, []);
  assert.deepEqual(deleted, ['task']);
  assert.deepEqual(statusChanges, ['downloading', 'pause']);
});

test('a failed status transaction releases the controller so the download can retry', async t => {
  installDownloadBrowser(t);
  const host = createHookHost();
  t.after(() => host.unmount());
  let rejectWrite = true;
  let downloads = 0;
  const actual = loadDownloader();
  const DownloadProvider = loadDownloadProvider(host.React, {
    '@/lib/download': { ...actual, downloadM3U8Video: async () => { downloads++; } },
    '@/lib/download/download-idb': {
      getAllTasks: async () => [{ id: 'task', task: makeTask(), status: 'pause' }], getTaskSegments: async () => new Map(),
      isStorageBucketsSupported: () => false, updateTaskStatus: async (_id, status) => { if (rejectWrite && status === 'downloading') { rejectWrite = false; throw new Error('storage aborted'); } },
    },
  });
  const render = () => host.render(() => DownloadProvider({ children: null })).props.value;
  render();
  await commit();
  await render().startTask('task');
  assert.equal(render().tasks[0].status, 'error');
  assert.equal(downloads, 0);
  await render().startTask('task');
  assert.equal(render().tasks[0].status, 'done');
  assert.equal(downloads, 1);
});
