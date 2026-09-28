import type { M3U8DownloadTask } from './index';
import type { M3U8Task } from './m3u8-downloader';

export const MAP_SEGMENT_INDEX = -1;

export function getCachedSegmentCount(task: M3U8Task, segments: Map<number, ArrayBuffer>): number {
  let count = 0;
  for (let index = task.rangeDownload.startSegment - 1; index < task.rangeDownload.endSegment; index++) {
    if (segments.get(index)?.byteLength) count++;
  }
  return count;
}

export function getCompleteCachedSegments(task: M3U8Task, segments: Map<number, ArrayBuffer>): ArrayBuffer[] {
  const { startSegment, endSegment } = task.rangeDownload;
  if (!Number.isInteger(startSegment) || !Number.isInteger(endSegment) || startSegment < 1 || endSegment < startSegment || endSegment > task.tsUrlList.length) {
    throw new Error('下载分片范围无效');
  }
  const result: ArrayBuffer[] = [];
  if (task.mapSegment) {
    const initialization = segments.get(MAP_SEGMENT_INDEX);
    if (!initialization?.byteLength) throw new Error('缺少初始化分片，请恢复下载后重试导出');
    result.push(initialization);
  }
  for (let index = startSegment - 1; index < endSegment; index++) {
    const segment = segments.get(index);
    if (!segment?.byteLength) throw new Error(`缺少第 ${index + 1} 个分片，请恢复下载后重试导出`);
    result.push(segment);
  }
  return result;
}

export function restoreDownloadTask(
  stored: { id: string; task: Omit<M3U8Task, 'downloadedSegments'>; status: M3U8DownloadTask['status'] },
  downloadedSegments: Map<number, ArrayBuffer>,
): M3U8DownloadTask {
  const finishNum = getCachedSegmentCount(stored.task, downloadedSegments);
  const total = stored.task.rangeDownload.endSegment - stored.task.rangeDownload.startSegment + 1;
  const complete = finishNum === total && (!stored.task.mapSegment || !!downloadedSegments.get(MAP_SEGMENT_INDEX)?.byteLength);
  const status = stored.status === 'done' ? complete ? 'done' : 'error' : stored.status === 'error' ? 'error' : 'pause';
  return {
    ...stored.task,
    id: stored.id,
    status,
    downloadedSegments,
    finishNum,
    downloadIndex: finishNum,
    finishList: stored.task.finishList.map((item, index) => ({ ...item, status: downloadedSegments.get(index)?.byteLength ? 'success' : '' })),
    ...(stored.status === 'done' && !complete ? { progress: { current: finishNum, total, percentage: total > 0 ? Math.floor(finishNum / total * 100) : 0, status: 'error' as const, message: '缓存分片不完整，请恢复下载后重试导出' } } : {}),
  };
}
