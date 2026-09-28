/**
 * IndexedDB 工具 - 用于持久化下载任务和片段数据
 * 支持断点续传和页面刷新后恢复下载
 * 使用 Storage Buckets API (Chrome 126+) 优化性能
 */

import type { M3U8Task } from './m3u8-downloader';
import { serializeAesKey } from './download-crypto';

const DB_NAME = 'LunaTVDownloads';
const DB_VERSION = 2;
const TASKS_STORE = 'tasks';
const SEGMENTS_STORE = 'segments';
const SEGMENTS_BUCKET = 'video-segments';

interface StoredTask {
  id: string;
  task: Omit<M3U8Task, 'downloadedSegments'>;
  status: 'ready' | 'downloading' | 'pause' | 'done' | 'error';
  createdAt: number;
  updatedAt: number;
}

interface StoredSegment {
  taskId: string;
  segmentIndex: number;
  data: Blob;
  createdAt: number;
}

// Storage Buckets API 类型定义
interface StorageBucket {
  indexedDB: IDBFactory;
  name: string;
}

interface StorageBucketManager {
  open(name: string): Promise<StorageBucket>;
  delete(name: string): Promise<void>;
  keys(): Promise<string[]>;
}

declare global {
  interface Navigator {
    storageBuckets?: StorageBucketManager;
  }
}

let segmentsBucket: StorageBucket | null = null;
let supportsStorageBuckets = false;
let storageBucketsReady: Promise<void> | null = null;

/**
 * 初始化 Storage Buckets（如果支持）
 */
async function initStorageBuckets(): Promise<void> {
  if (typeof navigator !== 'undefined' && 'storageBuckets' in navigator) {
    try {
      segmentsBucket = await navigator.storageBuckets!.open(SEGMENTS_BUCKET);
      supportsStorageBuckets = true;
      console.log('✅ Storage Buckets enabled for video segments');
    } catch (error) {
      console.warn('Storage Buckets not available, using default IndexedDB:', error);
    }
  }
}

// 初始化（仅在浏览器环境）
if (typeof window !== 'undefined') {
  storageBucketsReady = initStorageBuckets();
}

/**
 * 打开任务数据库（主数据库）
 */
function openTasksDB(): Promise<IDBDatabase> {
  return openDownloadDB(indexedDB);
}

function openDownloadDB(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () => reject(new Error('下载缓存升级被其他页面占用，请关闭旧页面后重试'));

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // 创建任务存储
      if (!db.objectStoreNames.contains(TASKS_STORE)) {
        const taskStore = db.createObjectStore(TASKS_STORE, { keyPath: 'id' });
        taskStore.createIndex('status', 'status', { unique: false });
        taskStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      // Both stores are always present, regardless of open order or bucket support.
      if (!db.objectStoreNames.contains(SEGMENTS_STORE)) {
        const segmentStore = db.createObjectStore(SEGMENTS_STORE, {
          keyPath: ['taskId', 'segmentIndex'],
        });
        segmentStore.createIndex('taskId', 'taskId', { unique: false });
      }
    };
  });
}

/**
 * 打开片段数据库（使用 Storage Bucket 或主数据库）
 */
async function openSegmentsDB(): Promise<IDBDatabase> {
  await (storageBucketsReady ??= initStorageBuckets());
  return openDownloadDB(segmentsBucket?.indexedDB || indexedDB);
}

function commitTransaction(transaction: IDBTransaction, write: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('下载缓存写入失败'));
    transaction.onabort = () => reject(transaction.error || new Error('下载缓存写入已中止'));
    try { write(); } catch (error) {
      try { transaction.abort(); } catch { /* It may already have aborted. */ }
      reject(error);
    }
  });
}

/**
 * 保存任务到 IndexedDB
 */
export async function saveTask(
  id: string,
  task: M3U8Task,
  status: StoredTask['status']
): Promise<void> {
  const db = await openTasksDB();
  const transaction = db.transaction([TASKS_STORE], 'readwrite');
  const store = transaction.objectStore(TASKS_STORE);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { downloadedSegments, ...taskWithoutSegments } = task;

  // 深度清理 aesConf，移除 crypto-js 对象中的不可序列化函数
  const cleanedTask = {
    ...taskWithoutSegments,
    aesConf: {
      method: taskWithoutSegments.aesConf.method,
      uri: taskWithoutSegments.aesConf.uri,
      iv: taskWithoutSegments.aesConf.iv,
      // 只保存 key 的原始数据，不保存 WordArray 对象
      key: serializeAesKey(taskWithoutSegments.aesConf.key),
    },
  };

  const storedTask: StoredTask = {
    id,
    task: cleanedTask as any,
    status: status === 'downloading' ? 'pause' : status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await commitTransaction(transaction, () => { store.put(storedTask); }).finally(() => db.close());
}

/**
 * 保存片段到 IndexedDB（使用 Storage Bucket 隔离）
 */
export async function saveSegment(
  taskId: string,
  segmentIndex: number,
  data: ArrayBuffer
): Promise<void> {
  try {
    const db = await openSegmentsDB();
    const transaction = db.transaction([SEGMENTS_STORE], 'readwrite');
    const store = transaction.objectStore(SEGMENTS_STORE);

    const storedSegment: StoredSegment = {
      taskId,
      segmentIndex,
      data: new Blob([data]),
      createdAt: Date.now(),
    };

    await commitTransaction(transaction, () => { store.put(storedSegment); }).finally(() => db.close());
  } catch (error) {
    // Report durability failure; callers may still finish an in-memory download.
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.warn('IndexedDB quota exceeded, segment not saved:', taskId, segmentIndex);
    }
    throw error;
  }
}

/**
 * 批量保存片段（性能优化）
 */
export async function saveSegmentsBatch(
  segments: Array<{ taskId: string; segmentIndex: number; data: ArrayBuffer }>
): Promise<void> {
  if (segments.length === 0) return;

  try {
    const db = await openSegmentsDB();
    const transaction = db.transaction([SEGMENTS_STORE], 'readwrite');
    const store = transaction.objectStore(SEGMENTS_STORE);

    await commitTransaction(transaction, () => segments.forEach(({ taskId, segmentIndex, data }) => {
      const storedSegment: StoredSegment = {
        taskId,
        segmentIndex,
        data: new Blob([data]),
        createdAt: Date.now(),
      };

      store.put(storedSegment);
    })).finally(() => db.close());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.warn('IndexedDB quota exceeded during batch save');
    }
    throw error;
  }
}

/**
 * 获取所有任务
 */
export async function getAllTasks(): Promise<StoredTask[]> {
  const db = await openTasksDB();
  const transaction = db.transaction([TASKS_STORE], 'readonly');
  const store = transaction.objectStore(TASKS_STORE);

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => { db.close(); resolve(request.result); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

/**
 * 获取任务的所有片段（使用批量读取优化）
 */
export async function getTaskSegments(taskId: string): Promise<Map<number, ArrayBuffer>> {
  const db = await openSegmentsDB();
  const current = await readTaskSegments(db, taskId);
  if (!segmentsBucket) return current;
  // Earlier versions could write to the default DB while the bucket was opening.
  const legacy = await readTaskSegments(await openTasksDB(), taskId);
  return new Map([...legacy, ...current]);
}

async function readTaskSegments(db: IDBDatabase, taskId: string): Promise<Map<number, ArrayBuffer>> {
  const transaction = db.transaction([SEGMENTS_STORE], 'readonly');
  const store = transaction.objectStore(SEGMENTS_STORE);
  const index = store.index('taskId');

  return new Promise((resolve, reject) => {
    // 使用 getAll 批量读取，比 cursor 快 40-50%
    const request = index.getAll(taskId);
    request.onsuccess = async () => {
      try {
        const segments = request.result as StoredSegment[];
        const map = new Map<number, ArrayBuffer>();
        await Promise.all(
          segments.map(async (segment) => {
            const arrayBuffer = await segment.data.arrayBuffer();
            map.set(segment.segmentIndex, arrayBuffer);
          })
        );
        resolve(map);
      } catch (error) {
        reject(error);
      } finally {
        db.close();
      }
    };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

/**
 * 删除任务及其所有片段
 */
export async function deleteTask(taskId: string): Promise<void> {
  // 删除任务元数据
  const tasksDB = await openTasksDB();
  const tasksTransaction = tasksDB.transaction([TASKS_STORE], 'readwrite');
  const taskStore = tasksTransaction.objectStore(TASKS_STORE);
  await commitTransaction(tasksTransaction, () => { taskStore.delete(taskId); }).finally(() => tasksDB.close());
  await deleteTaskSegments(taskId);
}

async function deleteTaskSegments(taskId: string): Promise<void> {
  const primary = await openSegmentsDB();
  const databases = segmentsBucket ? [primary, await openTasksDB()] : [primary];
  for (const db of databases) {
    const transaction = db.transaction([SEGMENTS_STORE], 'readwrite');
    const store = transaction.objectStore(SEGMENTS_STORE);
    await commitTransaction(transaction, () => {
      const request = store.index('taskId').getAll(taskId);
      request.onsuccess = () => {
        for (const segment of request.result as StoredSegment[]) store.delete([taskId, segment.segmentIndex]);
      };
    }).finally(() => db.close());
  }
}

/**
 * 更新任务状态
 */
export async function updateTaskStatus(
  taskId: string,
  status: StoredTask['status']
): Promise<void> {
  const db = await openTasksDB();
  const transaction = db.transaction([TASKS_STORE], 'readwrite');
  const store = transaction.objectStore(TASKS_STORE);

  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('下载任务状态写入已中止'));
    const getRequest = store.get(taskId);
    getRequest.onsuccess = () => {
      const task = getRequest.result as StoredTask | undefined;
      if (task) {
        task.status = status;
        task.updatedAt = Date.now();
        store.put(task);
      } else {
        reject(new Error(`Task ${taskId} not found`));
        transaction.abort();
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  }).finally(() => db.close());
}

/**
 * 获取存储空间使用情况
 */
export async function getStorageEstimate(): Promise<{
  usage: number;
  quota: number;
  percentage: number;
  usageMB: number;
  quotaMB: number;
}> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage || 0;
    const quota = estimate.quota || 0;
    const percentage = quota > 0 ? (usage / quota) * 100 : 0;
    const usageMB = usage / 1024 / 1024;
    const quotaMB = quota / 1024 / 1024;
    return { usage, quota, percentage, usageMB, quotaMB };
  }
  return { usage: 0, quota: 0, percentage: 0, usageMB: 0, quotaMB: 0 };
}

/**
 * 清理已完成的任务（保留元数据，删除片段数据）
 */
export async function cleanupCompletedTasks(): Promise<number> {
  const tasks = await getAllTasks();
  const completedTasks = tasks.filter(t => t.status === 'done');

  for (const task of completedTasks) {
    await deleteTaskSegments(task.id);
  }

  return completedTasks.length;
}

/**
 * 检查是否支持 Storage Buckets
 */
export function isStorageBucketsSupported(): boolean {
  return supportsStorageBuckets;
}
