/* eslint-disable no-console */

'use client';

import type { DragEndEvent } from '@dnd-kit/core';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  restrictToParentElement,
  restrictToVerticalAxis,
} from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Activity,
  Download,
  GripVertical,
  LoaderCircle,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from '@/components/admin/AdminPortal';

import { AdminConfig } from '@/lib/admin.types';

import ImportExportModal from '@/components/ImportExportModal';

import { AdminEmptyState, AdminSaveBar, AdminSection } from './AdminPrimitives';
import {
  AlertModal,
  buttonStyles,
  generateKeyFromName,
  LiveDataSource,
  showError,
  useAlertModal,
  useLoadingState,
} from './shared';

const LiveSourceImportForm = ({
  onImport,
  onCancel,
}: {
  onImport: (
    content: string,
    format: string,
    mode: 'merge' | 'replace',
  ) => Promise<void>;
  onCancel: () => void;
}) => {
  const [content, setContent] = useState('');
  const [format, setFormat] = useState('auto');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [isImporting, setIsImporting] = useState(false);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setContent(text);

      if (file.name.endsWith('.m3u') || file.name.endsWith('.m3u8')) {
        setFormat('m3u');
      } else if (file.name.endsWith('.json')) {
        setFormat('json');
      }
    };
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    if (!content.trim()) return;

    setIsImporting(true);
    try {
      await onImport(content, format, mode);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <>
      <div className='p-6 space-y-5 max-h-[60vh] overflow-y-auto'>
        <div>
          <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
            导入方式
          </label>
          <div className='flex flex-wrap gap-3'>
            <label className='flex items-center cursor-pointer'>
              <input
                type='radio'
                name='live-source-import-mode'
                checked={mode === 'merge'}
                onChange={() => setMode('merge')}
                className='mr-2 w-4 h-4 text-blue-600 focus:ring-blue-500'
              />
              <span className='text-sm text-gray-700 dark:text-gray-300'>
                合并（保留现有）
              </span>
            </label>
            <label className='flex items-center cursor-pointer'>
              <input
                type='radio'
                name='live-source-import-mode'
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
                className='mr-2 w-4 h-4 text-blue-600 focus:ring-blue-500'
              />
              <span className='text-sm text-gray-700 dark:text-gray-300'>
                替换（清空现有）
              </span>
            </label>
          </div>
        </div>

        <div>
          <label
            htmlFor='live-source-import-format'
            className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
          >
            文件格式
          </label>
          <select
            id='live-source-import-format'
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className='w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all'
          >
            <option value='auto'>自动检测</option>
            <option value='json'>JSON</option>
            <option value='m3u'>M3U/M3U8</option>
          </select>
        </div>

        <div>
          <label
            htmlFor='live-source-import-file'
            className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
          >
            上传文件
          </label>
          <input
            id='live-source-import-file'
            type='file'
            accept='.json,.m3u,.m3u8,.txt'
            onChange={handleFileUpload}
            className='mb-3 block w-full text-sm text-gray-500 dark:text-gray-400
              file:mr-4 file:py-2 file:px-4
              file:rounded-lg file:border-0
              file:text-sm file:font-semibold
              file:bg-blue-50 file:text-blue-700
              hover:file:bg-blue-100
              dark:file:bg-blue-900/40 dark:file:text-blue-200
              dark:hover:file:bg-blue-900/60
              cursor-pointer'
          />
          <label
            htmlFor='live-source-import-content'
            className='block text-sm font-medium mb-2'
          >
            粘贴播放列表内容
          </label>
          <textarea
            id='live-source-import-content'
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder='或直接粘贴 M3U/JSON 内容...'
            rows={10}
            className='w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all'
          />
          <p className='mt-1.5 text-xs text-gray-500 dark:text-gray-400'>
            支持 M3U、M3U8 和 JSON 格式
          </p>
        </div>
      </div>

      <div className='flex gap-3 p-6 border-t border-gray-200 dark:border-gray-700'>
        <button
          onClick={handleSubmit}
          disabled={!content.trim() || isImporting}
          className={
            buttonStyles.success +
            ' flex-1 disabled:opacity-50 disabled:cursor-not-allowed'
          }
        >
          {isImporting ? '导入中...' : '开始导入'}
        </button>
        <button
          onClick={onCancel}
          disabled={isImporting}
          className={
            buttonStyles.secondary +
            ' disabled:opacity-50 disabled:cursor-not-allowed'
          }
        >
          取消
        </button>
      </div>
    </>
  );
};

function LiveSourceRow({
  source,
  sortingDisabled,
  isLoading,
  onToggleEnable,
  onEdit,
  onDelete,
}: {
  source: LiveDataSource;
  sortingDisabled: boolean;
  isLoading: (key: string) => boolean;
  onToggleEnable: (key: string) => void;
  onEdit: (source: LiveDataSource) => void;
  onDelete: (key: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({
      id: source.key,
      disabled: sortingDisabled,
    });

  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <td className='w-9'>
        <button
          type='button'
          {...attributes}
          {...listeners}
          disabled={sortingDisabled}
          aria-label={`调整 ${source.name} 排序`}
          title={
            sortingDisabled
              ? '清除筛选后可调整排序'
              : '拖动或使用空格和方向键调整排序'
          }
          className='flex h-8 w-7 touch-none items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-gray-800'
        >
          <GripVertical size={16} aria-hidden='true' />
        </button>
      </td>
      <td className='min-w-36'>
        <div className='break-words font-medium'>{source.name}</div>
        <div
          className='admin-table-meta max-w-48 truncate font-mono'
          title={source.key}
        >
          {source.key}
        </div>
        {source.isTvBox && (
          <span className='admin-status-badge mt-1'>TVBox</span>
        )}
      </td>
      <td className='max-w-72'>
        <div className='max-w-72 truncate text-xs' title={source.url}>
          {source.url}
        </div>
        <div
          className='admin-table-meta max-w-72 truncate'
          title={source.ua || undefined}
        >
          {source.ua ? `UA：${source.ua}` : '使用默认 UA'}
        </div>
      </td>
      <td className='max-w-48'>
        <div
          className='max-w-48 truncate text-xs'
          title={source.epg || undefined}
        >
          {source.epg || '未配置'}
        </div>
      </td>
      <td className='tabular-nums'>
        {source.channelNumber && source.channelNumber > 0
          ? source.channelNumber
          : '—'}
      </td>
      <td>
        <span
          className={`admin-status-badge ${source.disabled ? '' : 'is-enabled'}`}
        >
          {source.disabled ? '已禁用' : '已启用'}
        </span>
      </td>
      <td>
        <div className='admin-row-actions justify-end'>
          {source.from !== 'config' && (
            <button
              type='button'
              onClick={() => onEdit(source)}
              disabled={isLoading('editLiveSource')}
              className={buttonStyles.roundedPrimary}
            >
              编辑
            </button>
          )}
          <button
            type='button'
            onClick={() => onToggleEnable(source.key)}
            disabled={isLoading(`toggleLiveSource_${source.key}`)}
            className={buttonStyles.roundedSecondary}
          >
            {isLoading(`toggleLiveSource_${source.key}`)
              ? '处理中'
              : source.disabled
                ? '启用'
                : '禁用'}
          </button>
          {source.from !== 'config' && (
            <button
              type='button'
              onClick={() => onDelete(source.key)}
              disabled={isLoading(`deleteLiveSource_${source.key}`)}
              className={buttonStyles.roundedDanger}
            >
              {isLoading(`deleteLiveSource_${source.key}`) ? '删除中' : '删除'}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

const LiveSourceConfig = ({
  config,
  refreshConfig,
}: {
  config: AdminConfig | null;
  refreshConfig: () => Promise<void>;
}) => {
  const { alertModal, showAlert, hideAlert } = useAlertModal();
  const { isLoading, withLoading } = useLoadingState();
  const [liveSources, setLiveSources] = useState<LiveDataSource[]>(
    () => config?.LiveConfig || [],
  );
  const [showAddForm, setShowAddForm] = useState(false);
  const [sourceQuery, setSourceQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'enabled' | 'disabled'
  >('all');
  const addFormRef = useRef<HTMLDivElement>(null);
  const editFormRef = useRef<HTMLDivElement>(null);
  const m3uDialogRef = useRef<HTMLDivElement>(null);
  const [editingLiveSource, setEditingLiveSource] =
    useState<LiveDataSource | null>(null);
  const [orderChanged, setOrderChanged] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [liveImportExportModal, setLiveImportExportModal] = useState<{
    isOpen: boolean;
    mode: 'import' | 'export' | 'result';
    result?: {
      success: number;
      failed: number;
      skipped: number;
      details: Array<{
        name: string;
        key: string;
        status: 'success' | 'failed' | 'skipped';
        reason?: string;
      }>;
    };
  }>({
    isOpen: false,
    mode: 'import',
  });
  const [showM3UImportForm, setShowM3UImportForm] = useState(false);
  const [newLiveSource, setNewLiveSource] = useState<LiveDataSource>({
    name: '',
    key: '',
    url: '',
    ua: '',
    epg: '',
    isTvBox: false,
    disabled: false,
    from: 'custom',
  });

  const filteredSources = useMemo(() => {
    const query = sourceQuery.trim().toLocaleLowerCase();
    return liveSources.filter((source) => {
      const matchesQuery =
        !query ||
        [source.name, source.key, source.url].some((value) =>
          value.toLocaleLowerCase().includes(query),
        );
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'enabled' ? !source.disabled : source.disabled);
      return matchesQuery && matchesStatus;
    });
  }, [liveSources, sourceQuery, statusFilter]);
  const hasSourceFilters =
    Boolean(sourceQuery.trim()) || statusFilter !== 'all';
  const enabledSourceCount = liveSources.filter(
    (source) => !source.disabled,
  ).length;

  const focusSourceForm = (element: HTMLDivElement | null) => {
    if (!element) return;
    element.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
    element
      .querySelector<HTMLInputElement>('input:not([disabled])')
      ?.focus({ preventScroll: true });
  };

  const openEditForm = (source: LiveDataSource) => {
    setShowAddForm(false);
    setEditingLiveSource({ ...source });
    requestAnimationFrame(() => focusSourceForm(editFormRef.current));
  };

  useEffect(() => {
    if (showAddForm) focusSourceForm(addFormRef.current);
  }, [showAddForm]);

  useEffect(() => {
    if (!showM3UImportForm) return;
    const dialog = m3uDialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.querySelector<HTMLElement>('input, select, textarea')?.focus();
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowM3UImportForm(false);
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener('keydown', handleDialogKey);
    return () => {
      dialog.removeEventListener('keydown', handleDialogKey);
      previousFocus?.focus();
    };
  }, [showM3UImportForm]);

  // dnd-kit 传感器
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 轻微位移即可触发
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 150, // 长按 150ms 后触发，避免与滚动冲突
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // 初始化
  useEffect(() => {
    if (config?.LiveConfig) {
      setLiveSources(config.LiveConfig ?? []);
      // 进入时重置 orderChanged
      setOrderChanged(false);
    }
  }, [config?.LiveConfig]);

  // 通用 API 请求
  const callLiveSourceApi = async (body: Record<string, any>) => {
    try {
      const resp = await fetch('/api/admin/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `操作失败: ${resp.status}`);
      }

      // 成功后刷新配置
      await refreshConfig();
    } catch (err) {
      showError(err instanceof Error ? err.message : '操作失败', showAlert);
      throw err; // 向上抛出方便调用处判断
    }
  };

  const handleToggleEnable = (key: string) => {
    const target = liveSources.find((s) => s.key === key);
    if (!target) return;
    const action = target.disabled ? 'enable' : 'disable';
    withLoading(`toggleLiveSource_${key}`, () =>
      callLiveSourceApi({ action, key }),
    ).catch(() => {
      console.error('操作失败', action, key);
    });
  };

  const handleDelete = (key: string) => {
    withLoading(`deleteLiveSource_${key}`, () =>
      callLiveSourceApi({ action: 'delete', key }),
    ).catch(() => {
      console.error('操作失败', 'delete', key);
    });
  };

  // 刷新直播源
  const handleRefreshLiveSources = async () => {
    if (isRefreshing) return;

    await withLoading('refreshLiveSources', async () => {
      setIsRefreshing(true);
      try {
        const response = await fetch('/api/admin/live/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `刷新失败: ${response.status}`);
        }

        // 刷新成功后重新获取配置
        await refreshConfig();
        showAlert({
          type: 'success',
          title: '刷新成功',
          message: '直播源已刷新',
          timer: 2000,
        });
      } catch (err) {
        showError(err instanceof Error ? err.message : '刷新失败', showAlert);
        throw err;
      } finally {
        setIsRefreshing(false);
      }
    });
  };

  // 导出直播源
  const handleExportLiveSources = (
    exportFormat: 'array' | 'config' = 'array',
  ) => {
    try {
      const customSources = liveSources.filter((s) => s.from === 'custom');
      if (customSources.length === 0) {
        showAlert({
          type: 'warning',
          title: '没有可导出的直播源',
          message: '请先添加自定义直播源后再导出',
          timer: 2000,
        });
        return;
      }

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let exportData: any;
      let filename: string;

      if (exportFormat === 'config') {
        // 配置文件格式: {"lives": {...}}
        const lives: Record<
          string,
          {
            name: string;
            url: string;
            ua?: string;
            epg?: string;
          }
        > = {};

        customSources.forEach((source) => {
          const liveItem: {
            name: string;
            url: string;
            ua?: string;
            epg?: string;
          } = {
            name: source.name,
            url: source.url,
          };
          if (source.ua) liveItem.ua = source.ua;
          if (source.epg) liveItem.epg = source.epg;
          lives[source.key] = liveItem;
        });

        exportData = { lives };
        filename = `live_config_${timestamp}.json`;
      } else {
        // 数组格式
        exportData = customSources.map((source) => ({
          name: source.name,
          key: source.key,
          url: source.url,
          epg: source.epg || '',
          ua: source.ua || '',
          disabled: source.disabled || false,
        }));
        filename = `live_sources_${timestamp}.json`;
      }

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      const formatText =
        exportFormat === 'config' ? '配置文件格式' : '数组格式';
      showAlert({
        type: 'success',
        title: '导出成功',
        message: `已导出 ${customSources.length} 个直播源（${formatText}）到 ${filename}`,
        timer: 3000,
      });

      setLiveImportExportModal({ isOpen: false, mode: 'export' });
    } catch (err) {
      showAlert({
        type: 'error',
        title: '导出失败',
        message: err instanceof Error ? err.message : '未知错误',
      });
    }
  };

  // 导入直播源
  const handleImportLiveSources = async (
    file: File,
    onProgress?: (current: number, total: number) => void,
  ) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      // 规范化导入数据
      let importItems: any[] = [];
      if (Array.isArray(parsed)) {
        importItems = parsed;
      } else if (parsed && typeof parsed === 'object') {
        // 支持配置文件格式 {"lives": {...}}
        const liveMap =
          parsed.lives &&
          typeof parsed.lives === 'object' &&
          !Array.isArray(parsed.lives)
            ? parsed.lives
            : parsed;

        importItems = Object.entries(liveMap)
          .filter(([, value]) => value && typeof value === 'object')
          .map(([key, value]) => ({
            key,
            ...(value as Record<string, unknown>),
          }))
          .filter((item) => 'name' in item || 'url' in item);
      }

      if (importItems.length === 0) {
        throw new Error('文件中没有可导入的直播源数据');
      }

      const result = {
        success: 0,
        failed: 0,
        skipped: 0,
        details: [] as Array<{
          name: string;
          key: string;
          status: 'success' | 'failed' | 'skipped';
          reason?: string;
        }>,
      };

      const existingKeys = new Set(liveSources.map((source) => source.key));
      const total = importItems.length;

      for (let i = 0; i < importItems.length; i++) {
        const rawItem = importItems[i] as Record<string, unknown>;
        if (onProgress) {
          onProgress(i + 1, total);
        }

        const key = typeof rawItem.key === 'string' ? rawItem.key.trim() : '';
        const name =
          typeof rawItem.name === 'string' ? rawItem.name.trim() : '';
        const url = typeof rawItem.url === 'string' ? rawItem.url.trim() : '';
        const ua = typeof rawItem.ua === 'string' ? rawItem.ua.trim() : '';
        const epg = typeof rawItem.epg === 'string' ? rawItem.epg.trim() : '';

        if (!name || !key || !url) {
          result.failed++;
          result.details.push({
            name: name || '未知',
            key: key || '未知',
            status: 'failed',
            reason: '缺少必要字段（name、key 或 url）',
          });
          continue;
        }

        if (existingKeys.has(key)) {
          result.skipped++;
          result.details.push({
            name,
            key,
            status: 'skipped',
            reason: '该 key 已存在，跳过导入',
          });
          continue;
        }

        try {
          await callLiveSourceApi({
            action: 'add',
            key,
            name,
            url,
            ua,
            epg,
          });

          existingKeys.add(key);
          result.success++;
          result.details.push({
            name,
            key,
            status: 'success',
          });
        } catch (err) {
          result.failed++;
          result.details.push({
            name,
            key,
            status: 'failed',
            reason: err instanceof Error ? err.message : '导入失败',
          });
        }
      }

      setLiveImportExportModal({
        isOpen: true,
        mode: 'result',
        result,
      });

      if (result.success > 0) {
        await refreshConfig();
      }

      return result;
    } catch (err) {
      showAlert({
        type: 'error',
        title: '导入失败',
        message: err instanceof Error ? err.message : '文件解析失败',
      });
      setLiveImportExportModal({ isOpen: false, mode: 'import' });
      return {
        success: 0,
        failed: 0,
        skipped: 0,
        details: [],
      };
    }
  };

  // M3U 导入
  const handleM3UImport = async (
    content: string,
    format: string,
    mode: 'merge' | 'replace',
  ) => {
    try {
      const response = await fetch('/api/admin/live/import-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, format, mode }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '导入失败');
      }

      const result = await response.json();

      showAlert({
        type: 'success',
        title: '导入成功',
        message: `成功导入 ${result.added} 个直播源，跳过 ${result.skipped} 个`,
        timer: 3000,
      });

      setShowM3UImportForm(false);
      await refreshConfig();
    } catch (err) {
      showAlert({
        type: 'error',
        title: '导入失败',
        message: err instanceof Error ? err.message : '未知错误',
      });
      throw err;
    }
  };

  const handleAddLiveSource = () => {
    if (!newLiveSource.name || !newLiveSource.key || !newLiveSource.url) return;
    withLoading('addLiveSource', async () => {
      await callLiveSourceApi({
        action: 'add',
        key: newLiveSource.key,
        name: newLiveSource.name,
        url: newLiveSource.url,
        ua: newLiveSource.ua,
        epg: newLiveSource.epg,
        isTvBox: newLiveSource.isTvBox,
      });
      setNewLiveSource({
        name: '',
        key: '',
        url: '',
        epg: '',
        ua: '',
        isTvBox: false,
        disabled: false,
        from: 'custom',
      });
      setShowAddForm(false);
    }).catch(() => {
      console.error('操作失败', 'add', newLiveSource);
    });
  };

  const handleEditLiveSource = () => {
    if (!editingLiveSource || !editingLiveSource.name || !editingLiveSource.url)
      return;
    withLoading('editLiveSource', async () => {
      await callLiveSourceApi({
        action: 'edit',
        key: editingLiveSource.key,
        name: editingLiveSource.name,
        url: editingLiveSource.url,
        ua: editingLiveSource.ua,
        epg: editingLiveSource.epg,
        isTvBox: editingLiveSource.isTvBox,
      });
      setEditingLiveSource(null);
    }).catch(() => {
      console.error('操作失败', 'edit', editingLiveSource);
    });
  };

  const handleCancelEdit = () => {
    setEditingLiveSource(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (hasSourceFilters || !over || active.id === over.id) return;
    const oldIndex = liveSources.findIndex((s) => s.key === active.id);
    const newIndex = liveSources.findIndex((s) => s.key === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setLiveSources((prev) => arrayMove(prev, oldIndex, newIndex));
    setOrderChanged(true);
  };

  const handleSaveOrder = () => {
    const order = liveSources.map((s) => s.key);
    withLoading('saveLiveSourceOrder', () =>
      callLiveSourceApi({ action: 'sort', order }),
    )
      .then(() => {
        setOrderChanged(false);
      })
      .catch(() => {
        console.error('操作失败', 'sort', order);
      });
  };

  // 📊 读取 CORS 统计数据
  const [corsStats, setCorsStats] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('live-cors-stats');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {
          return { directCount: 0, proxyCount: 0, totalChecked: 0 };
        }
      }
    }
    return { directCount: 0, proxyCount: 0, totalChecked: 0 };
  });

  // 清除CORS统计和缓存
  const handleClearCorsCache = () => {
    if (typeof window !== 'undefined') {
      // 清除统计数据
      setCorsStats({ directCount: 0, proxyCount: 0, totalChecked: 0 });
      localStorage.removeItem('live-cors-stats');

      // 清除所有CORS缓存
      const keys = Object.keys(localStorage);
      keys.forEach((key) => {
        if (key.startsWith('cors-cache-')) {
          localStorage.removeItem(key);
        }
      });

      console.log('🧹 已清除所有CORS统计和缓存数据');
      showAlert({
        type: 'success',
        title: '清除成功',
        message: 'CORS统计和缓存已清除',
        timer: 2000,
      });
    }
  };

  if (!config) {
    return (
      <div
        className='flex items-center justify-center gap-2 py-12 text-sm text-gray-500'
        role='status'
      >
        <LoaderCircle
          size={18}
          className='animate-spin motion-reduce:animate-none'
          aria-hidden='true'
        />
        加载直播源配置…
      </div>
    );
  }

  return (
    <div className='admin-module admin-live-sources min-w-0 space-y-4'>
      <AdminSection
        title='直播源列表'
        description={`共 ${liveSources.length} 个直播源，${enabledSourceCount} 个已启用。`}
        action={
          <div className='admin-toolbar-actions'>
            <button
              type='button'
              onClick={() =>
                setLiveImportExportModal({ isOpen: true, mode: 'import' })
              }
              className={buttonStyles.secondary}
            >
              <Upload size={15} aria-hidden='true' /> 导入 JSON
            </button>
            <button
              type='button'
              onClick={() => setShowM3UImportForm(true)}
              className={buttonStyles.secondary}
            >
              <Upload size={15} aria-hidden='true' /> 导入 M3U
            </button>
            <button
              type='button'
              onClick={() =>
                setLiveImportExportModal({ isOpen: true, mode: 'export' })
              }
              className={buttonStyles.secondary}
            >
              <Download size={15} aria-hidden='true' /> 导出
            </button>
            <button
              type='button'
              onClick={() => setShowAddForm(!showAddForm)}
              className={
                showAddForm ? buttonStyles.secondary : buttonStyles.primary
              }
            >
              {showAddForm ? (
                <X size={16} aria-hidden='true' />
              ) : (
                <Plus size={16} aria-hidden='true' />
              )}
              {showAddForm ? '收起添加' : '添加直播源'}
            </button>
          </div>
        }
      >
        <div className='space-y-4'>
          <div className='admin-filter-row'>
            <div className='admin-search-field'>
              <Search size={16} aria-hidden='true' />
              <input
                type='search'
                value={sourceQuery}
                onChange={(event) => setSourceQuery(event.target.value)}
                aria-label='搜索直播源'
                placeholder='搜索名称、Key 或播放列表地址'
              />
            </div>
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as typeof statusFilter)
              }
              aria-label='筛选直播源状态'
            >
              <option value='all'>全部状态</option>
              <option value='enabled'>已启用</option>
              <option value='disabled'>已禁用</option>
            </select>
            <button
              type='button'
              onClick={handleRefreshLiveSources}
              disabled={isRefreshing || isLoading('refreshLiveSources')}
              className={buttonStyles.secondary}
            >
              <RefreshCw
                size={15}
                className={
                  isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''
                }
                aria-hidden='true'
              />
              {isRefreshing || isLoading('refreshLiveSources')
                ? '刷新中…'
                : '刷新直播源'}
            </button>
          </div>
          {showAddForm && (
            <div
              ref={addFormRef}
              className='scroll-mt-28 rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4 dark:border-gray-700 dark:bg-gray-900'
            >
              <h3 className='text-sm font-semibold'>添加直播源</h3>
              <div className='admin-form-grid'>
                <label className='admin-field'>
                  <span>名称</span>
                  <input
                    type='text'
                    placeholder='名称'
                    value={newLiveSource.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      const autoKey = generateKeyFromName(name);
                      setNewLiveSource((prev) => ({
                        ...prev,
                        name,
                        key: autoKey,
                      }));
                    }}
                    className='px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </label>
                <label className='admin-field'>
                  <span>Key</span>
                  <input
                    type='text'
                    placeholder='Key'
                    value={newLiveSource.key}
                    onChange={(e) =>
                      setNewLiveSource((prev) => ({
                        ...prev,
                        key: e.target.value,
                      }))
                    }
                    className='px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </label>
                <label className='admin-field'>
                  <span>播放列表地址</span>
                  <input
                    type='text'
                    placeholder='M3U 地址'
                    value={newLiveSource.url}
                    onChange={(e) =>
                      setNewLiveSource((prev) => ({
                        ...prev,
                        url: e.target.value,
                      }))
                    }
                    className='px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </label>
                <label className='admin-field'>
                  <span>节目单地址（选填）</span>
                  <input
                    type='text'
                    placeholder='节目单地址（选填）'
                    value={newLiveSource.epg}
                    onChange={(e) =>
                      setNewLiveSource((prev) => ({
                        ...prev,
                        epg: e.target.value,
                      }))
                    }
                    className='px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </label>
                <label className='admin-field'>
                  <span>自定义 UA（选填）</span>
                  <input
                    type='text'
                    placeholder='自定义 UA（选填）'
                    value={newLiveSource.ua}
                    onChange={(e) =>
                      setNewLiveSource((prev) => ({
                        ...prev,
                        ua: e.target.value,
                      }))
                    }
                    className='px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </label>

                {/* TVBox 模式开关 */}
                <div>
                  <label className='block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    强制识别为 TVBox 源
                  </label>
                  <div className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 flex items-center'>
                    <button
                      type='button'
                      role='switch'
                      aria-label='强制识别为 TVBox 源'
                      aria-checked={Boolean(newLiveSource.isTvBox)}
                      onClick={() =>
                        setNewLiveSource((prev) => ({
                          ...prev,
                          isTvBox: !prev.isTvBox,
                        }))
                      }
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                        newLiveSource.isTvBox
                          ? 'bg-blue-600 focus:ring-blue-500'
                          : 'bg-gray-200 dark:bg-gray-700 focus:ring-gray-500'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          newLiveSource.isTvBox
                            ? 'translate-x-6'
                            : 'translate-x-1'
                        }`}
                      />
                    </button>
                    <span className='ml-3 text-sm text-gray-500 dark:text-gray-400'>
                      {newLiveSource.isTvBox ? '已开启' : '已关闭'}
                    </span>
                  </div>
                </div>
              </div>
              <div className='flex flex-wrap justify-end gap-2'>
                <button
                  type='button'
                  onClick={() => setShowAddForm(false)}
                  className={buttonStyles.secondary}
                >
                  取消
                </button>
                <button
                  onClick={handleAddLiveSource}
                  disabled={
                    !newLiveSource.name ||
                    !newLiveSource.key ||
                    !newLiveSource.url ||
                    isLoading('addLiveSource')
                  }
                  className={`w-full sm:w-auto px-4 py-2 ${!newLiveSource.name || !newLiveSource.key || !newLiveSource.url || isLoading('addLiveSource') ? buttonStyles.disabled : buttonStyles.success}`}
                >
                  {isLoading('addLiveSource') ? '添加中...' : '添加'}
                </button>
              </div>
            </div>
          )}

          {/* 编辑直播源表单 */}
          {editingLiveSource && !showAddForm && (
            <div
              ref={editFormRef}
              className='scroll-mt-28 rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4 dark:border-gray-700 dark:bg-gray-900'
            >
              <div className='flex items-center justify-between'>
                <h5 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                  编辑直播源: {editingLiveSource.name}
                </h5>
                <button
                  onClick={handleCancelEdit}
                  aria-label='取消编辑直播源'
                  className='text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                >
                  ✕
                </button>
              </div>
              <div className='admin-form-grid'>
                <div>
                  <label
                    htmlFor='live-edit-name'
                    className='block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1'
                  >
                    名称
                  </label>
                  <input
                    id='live-edit-name'
                    type='text'
                    value={editingLiveSource.name}
                    onChange={(e) =>
                      setEditingLiveSource((prev) =>
                        prev ? { ...prev, name: e.target.value } : null,
                      )
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </div>
                <div>
                  <label
                    htmlFor='live-edit-key'
                    className='block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1'
                  >
                    Key (不可编辑)
                  </label>
                  <input
                    id='live-edit-key'
                    type='text'
                    value={editingLiveSource.key}
                    disabled
                    className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                  />
                </div>
                <div>
                  <label
                    htmlFor='live-edit-url'
                    className='block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1'
                  >
                    M3U 地址
                  </label>
                  <input
                    id='live-edit-url'
                    type='text'
                    value={editingLiveSource.url}
                    onChange={(e) =>
                      setEditingLiveSource((prev) =>
                        prev ? { ...prev, url: e.target.value } : null,
                      )
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </div>
                <div>
                  <label
                    htmlFor='live-edit-epg'
                    className='block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1'
                  >
                    节目单地址（选填）
                  </label>
                  <input
                    id='live-edit-epg'
                    type='text'
                    value={editingLiveSource.epg}
                    onChange={(e) =>
                      setEditingLiveSource((prev) =>
                        prev ? { ...prev, epg: e.target.value } : null,
                      )
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </div>
                <div>
                  <label
                    htmlFor='live-edit-ua'
                    className='block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1'
                  >
                    自定义 UA（选填）
                  </label>
                  <input
                    id='live-edit-ua'
                    type='text'
                    value={editingLiveSource.ua}
                    onChange={(e) =>
                      setEditingLiveSource((prev) =>
                        prev ? { ...prev, ua: e.target.value } : null,
                      )
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </div>

                {/* TVBox 模式开关 (编辑) */}
                <div>
                  <label className='block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    强制识别为 TVBox 源
                  </label>
                  <div className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 flex items-center'>
                    <button
                      type='button'
                      role='switch'
                      aria-label='强制识别为 TVBox 源'
                      aria-checked={Boolean(editingLiveSource.isTvBox)}
                      onClick={() =>
                        setEditingLiveSource((prev) =>
                          prev ? { ...prev, isTvBox: !prev.isTvBox } : null,
                        )
                      }
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                        editingLiveSource.isTvBox
                          ? 'bg-blue-600 focus:ring-blue-500'
                          : 'bg-gray-200 dark:bg-gray-700 focus:ring-gray-500'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          editingLiveSource.isTvBox
                            ? 'translate-x-6'
                            : 'translate-x-1'
                        }`}
                      />
                    </button>
                    <span className='ml-3 text-sm text-gray-500 dark:text-gray-400'>
                      {editingLiveSource.isTvBox ? '已开启' : '已关闭'}
                    </span>
                  </div>
                </div>
              </div>

              <div className='flex justify-end space-x-2'>
                <button
                  onClick={handleCancelEdit}
                  className={buttonStyles.secondary}
                >
                  取消
                </button>
                <button
                  onClick={handleEditLiveSource}
                  disabled={
                    !editingLiveSource.name ||
                    !editingLiveSource.url ||
                    isLoading('editLiveSource')
                  }
                  className={`${!editingLiveSource.name || !editingLiveSource.url || isLoading('editLiveSource') ? buttonStyles.disabled : buttonStyles.success}`}
                >
                  {isLoading('editLiveSource') ? '保存中...' : '保存'}
                </button>
              </div>
            </div>
          )}

          {filteredSources.length === 0 ? (
            <AdminEmptyState
              icon={Radio}
              title={
                liveSources.length === 0 ? '还没有直播源' : '没有匹配的直播源'
              }
              description={
                liveSources.length === 0
                  ? '添加播放列表地址，或导入已有的 JSON、M3U 文件。'
                  : '尝试其他关键词，或清除状态筛选。'
              }
            >
              <button
                type='button'
                onClick={
                  liveSources.length === 0
                    ? () => setShowAddForm(true)
                    : () => {
                        setSourceQuery('');
                        setStatusFilter('all');
                      }
                }
                className={buttonStyles.secondary}
              >
                {liveSources.length === 0 ? '添加直播源' : '清除筛选'}
              </button>
            </AdminEmptyState>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              autoScroll={false}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            >
              <div
                className='admin-table-wrap max-h-[36rem] overflow-auto'
                data-table='live-source-list'
              >
                <table className='admin-table'>
                  <thead className='sticky top-0 z-10'>
                    <tr>
                      <th className='w-9'>
                        <span className='sr-only'>排序</span>
                      </th>
                      <th scope='col'>名称 / Key</th>
                      <th scope='col'>播放列表 / UA</th>
                      <th scope='col'>节目单地址</th>
                      <th scope='col'>频道数</th>
                      <th scope='col'>状态</th>
                      <th scope='col'>操作</th>
                    </tr>
                  </thead>
                  <SortableContext
                    items={filteredSources.map((source) => source.key)}
                    strategy={verticalListSortingStrategy}
                  >
                    <tbody>
                      {filteredSources.map((source) => (
                        <LiveSourceRow
                          key={source.key}
                          source={source}
                          sortingDisabled={hasSourceFilters}
                          isLoading={isLoading}
                          onToggleEnable={handleToggleEnable}
                          onEdit={openEditForm}
                          onDelete={handleDelete}
                        />
                      ))}
                    </tbody>
                  </SortableContext>
                </table>
              </div>
            </DndContext>
          )}
          <div className='admin-inline-note flex flex-wrap items-center justify-between gap-2'>
            <span className='tabular-nums'>
              显示 {filteredSources.length} / {liveSources.length} 个直播源
            </span>
            {hasSourceFilters ? (
              <button
                type='button'
                onClick={() => {
                  setSourceQuery('');
                  setStatusFilter('all');
                }}
                className='admin-inline-link'
              >
                清除筛选以调整排序
              </button>
            ) : (
              <span>拖动行首手柄调整顺序，保存后生效。</span>
            )}
          </div>
        </div>
      </AdminSection>
      {orderChanged && (
        <AdminSaveBar description='排序尚未保存。保存后，新的排列顺序才会生效。'>
          <button
            type='button'
            onClick={() => {
              setLiveSources(config.LiveConfig ?? []);
              setOrderChanged(false);
            }}
            disabled={isLoading('saveLiveSourceOrder')}
            className={buttonStyles.secondary}
          >
            还原排序
          </button>
          <button
            type='button'
            onClick={handleSaveOrder}
            disabled={isLoading('saveLiveSourceOrder')}
            className={buttonStyles.primary}
          >
            {isLoading('saveLiveSourceOrder') ? '保存中…' : '保存排序'}
          </button>
        </AdminSaveBar>
      )}
      <details className='admin-live-stats'>
        <summary>
          <Activity size={16} aria-hidden='true' />
          播放连接统计
          <span className='admin-table-meta ml-auto tabular-nums'>
            已检测 {corsStats.totalChecked} 项
          </span>
        </summary>
        <div className='admin-section p-4 space-y-4'>
          <dl className='grid grid-cols-3 gap-4 text-sm tabular-nums'>
            <div>
              <dt className='admin-table-meta'>总检测数</dt>
              <dd className='mt-1 text-lg font-semibold'>
                {corsStats.totalChecked}
              </dd>
            </div>
            <div>
              <dt className='admin-table-meta'>支持直连</dt>
              <dd className='mt-1 text-lg font-semibold text-green-700 dark:text-green-400'>
                {corsStats.directCount}
              </dd>
            </div>
            <div>
              <dt className='admin-table-meta'>需要代理</dt>
              <dd className='mt-1 text-lg font-semibold'>
                {corsStats.proxyCount}
              </dd>
            </div>
          </dl>
          <div className='flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-3 dark:border-gray-700'>
            <p className='admin-inline-note max-w-xl'>
              {corsStats.totalChecked > 0
                ? '统计来自当前浏览器的直播播放检测。检测缓存有效期为 7 天。'
                : '暂无检测记录。播放直播频道后，系统会检测跨域访问支持情况并在此记录。'}
            </p>
            {corsStats.totalChecked > 0 && (
              <button
                type='button'
                onClick={handleClearCorsCache}
                className={buttonStyles.secondary}
              >
                清除检测缓存
              </button>
            )}
          </div>
        </div>
      </details>
      {/* 通用弹窗组件 */}
      <AlertModal
        isOpen={alertModal.isOpen}
        onClose={hideAlert}
        type={alertModal.type}
        title={alertModal.title}
        message={alertModal.message}
        timer={alertModal.timer}
        showConfirm={alertModal.showConfirm}
        showUndo={alertModal.showUndo}
        onUndo={alertModal.onUndo}
        undoTimer={alertModal.undoTimer}
      />

      {showM3UImportForm &&
        createPortal(
          <div className='admin-dialog-overlay fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4'>
            <div
              ref={m3uDialogRef}
              className='admin-dialog flex w-full max-w-2xl flex-col overflow-hidden'
              role='dialog'
              aria-modal='true'
              aria-labelledby='live-m3u-import-title'
            >
              <div className='admin-section-header'>
                <div>
                  <h2 id='live-m3u-import-title'>导入 M3U/M3U8</h2>
                  <p>支持 M3U、M3U8 和 JSON 格式。</p>
                </div>
                <button
                  type='button'
                  onClick={() => setShowM3UImportForm(false)}
                  aria-label='关闭直播源导入'
                  className={buttonStyles.secondary}
                >
                  <X size={16} aria-hidden='true' />
                </button>
              </div>
              <LiveSourceImportForm
                onImport={handleM3UImport}
                onCancel={() => setShowM3UImportForm(false)}
              />
            </div>
          </div>,
          document.body,
        )}

      {/* 导入模态框 */}
      {/* 直播源导入导出模态框 */}
      <ImportExportModal
        isOpen={liveImportExportModal.isOpen}
        mode={liveImportExportModal.mode}
        onClose={() =>
          setLiveImportExportModal({ isOpen: false, mode: 'import' })
        }
        onImport={handleImportLiveSources}
        onExport={handleExportLiveSources}
        result={liveImportExportModal.result}
        entityName='直播源'
        arrayFormatDescription='用于直播源列表，支持批量导入直播源'
        configFormatDescription='用于配置文件编辑器，可直接粘贴到 lives 字段'
        configFormatExample='{"lives": {...}}'
        arrayFilenameHint='live_sources_YYYYMMDD_HHMMSS.json'
        configFilenameHint='live_config_YYYYMMDD_HHMMSS.json'
      />
    </div>
  );
};

export default LiveSourceConfig;
