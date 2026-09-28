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
  CheckCircle2,
  Download,
  GripVertical,
  LoaderCircle,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from '@/components/admin/AdminPortal';

import { AdminConfig } from '@/lib/admin.types';

import ImportExportModal from '@/components/ImportExportModal';

import {
  AdminEmptyState,
  AdminSaveBar,
  AdminSection,
  AdminTabs,
} from './AdminPrimitives';
import {
  AlertModal,
  buttonStyles,
  DataSource,
  generateKeyFromName,
  showError,
  useAlertModal,
  useLoadingState,
} from './shared';

type SourceValidationStatus = {
  text: string;
  className: string;
  icon: string;
  message: string;
} | null;

function VideoSourceRow({
  source,
  selected,
  sortingDisabled,
  validation,
  isLoading,
  onSelect,
  onToggleEnable,
  onToggleAdult,
  onUpdateWeight,
  onEdit,
  onDelete,
}: {
  source: DataSource;
  selected: boolean;
  sortingDisabled: boolean;
  validation: SourceValidationStatus;
  isLoading: (key: string) => boolean;
  onSelect: (key: string, checked: boolean) => void;
  onToggleEnable: (key: string) => void;
  onToggleAdult: (key: string, isAdult: boolean) => void;
  onUpdateWeight: (key: string, weight: number) => void;
  onEdit: (source: DataSource) => void;
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
      className={selected ? 'bg-blue-50/60 dark:bg-blue-950/20' : ''}
    >
      <td className='w-9 px-2'>
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
          className='flex h-8 w-7 touch-none items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-gray-800'
        >
          <GripVertical size={16} aria-hidden='true' />
        </button>
      </td>
      <td className='w-9 px-2'>
        <input
          type='checkbox'
          checked={selected}
          onChange={(event) => onSelect(source.key, event.target.checked)}
          aria-label={`选择 ${source.name}`}
          className='h-4 w-4 rounded border-gray-300 accent-blue-600'
        />
      </td>
      <td className='min-w-36'>
        <div className='font-medium text-gray-900 dark:text-gray-100'>
          {source.name}
        </div>
        <div className='admin-table-meta mt-1 font-mono text-xs'>
          {source.key}
        </div>
      </td>
      <td className='max-w-64'>
        <div className='max-w-64 truncate text-xs' title={source.api}>
          {source.api}
        </div>
        <div
          className='admin-table-meta mt-1 max-w-64 truncate text-xs'
          title={source.detail || undefined}
        >
          {source.detail ? `详情：${source.detail}` : '未设置详情地址'}
        </div>
      </td>
      <td className='whitespace-nowrap'>
        <span
          className={`admin-status-badge ${source.disabled ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' : 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400'}`}
        >
          {source.disabled ? '已禁用' : '已启用'}
        </span>
        <div className='mt-1.5'>
          {validation ? (
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${validation.className}`}
              title={validation.message}
            >
              {validation.icon} {validation.text}
            </span>
          ) : (
            <span className='admin-table-meta text-xs'>未检测</span>
          )}
        </div>
      </td>
      <td className='whitespace-nowrap'>
        <div className='text-xs text-gray-700 dark:text-gray-300'>
          {source.type === 'shortdrama' ? '短剧源' : '普通视频'}
        </div>
        <label className='mt-1.5 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400'>
          <input
            type='checkbox'
            checked={source.is_adult || false}
            onChange={(event) =>
              onToggleAdult(source.key, event.target.checked)
            }
            disabled={isLoading(`toggleAdult_${source.key}`)}
            aria-label={`${source.name} 成人资源标记`}
            className='h-3.5 w-3.5 rounded border-gray-300 accent-blue-600'
          />
          成人标记
        </label>
      </td>
      <td>
        <input
          type='number'
          min='0'
          max='100'
          value={source.weight ?? 50}
          onChange={(event) =>
            onUpdateWeight(source.key, parseInt(event.target.value) || 0)
          }
          aria-label={`${source.name} 权重`}
          className='w-16 rounded border border-gray-300 bg-white px-2 py-1 text-center text-sm tabular-nums text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100'
          title='权重越高，播放时越优先选择该源（0–100）'
        />
      </td>
      <td>
        <div className='admin-row-actions flex items-center justify-end gap-1 whitespace-nowrap'>
          <button
            type='button'
            onClick={() => onEdit(source)}
            className={buttonStyles.roundedPrimary}
          >
            编辑
          </button>
          <button
            type='button'
            onClick={() => onToggleEnable(source.key)}
            disabled={isLoading(`toggleSource_${source.key}`)}
            className={buttonStyles.roundedSecondary}
          >
            {isLoading(`toggleSource_${source.key}`)
              ? '处理中'
              : source.disabled
                ? '启用'
                : '禁用'}
          </button>
          {source.from !== 'config' && (
            <button
              type='button'
              onClick={() => onDelete(source.key)}
              disabled={isLoading(`deleteSource_${source.key}`)}
              className={buttonStyles.roundedDanger}
            >
              {isLoading(`deleteSource_${source.key}`) ? '删除中' : '删除'}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

const VideoSourceConfig = ({
  config,
  refreshConfig,
}: {
  config: AdminConfig | null;
  refreshConfig: () => Promise<void>;
}) => {
  const { alertModal, showAlert, hideAlert } = useAlertModal();
  const { isLoading, withLoading } = useLoadingState();
  const [sources, setSources] = useState<DataSource[]>(
    () => config?.SourceConfig || [],
  );
  const [activeView, setActiveView] = useState<'sources' | 'proxy'>('sources');
  const [sourceQuery, setSourceQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'enabled' | 'disabled'
  >('all');
  const [typeFilter, setTypeFilter] = useState<
    'all' | 'vod' | 'shortdrama' | 'adult'
  >('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [orderChanged, setOrderChanged] = useState(false);
  const [newSource, setNewSource] = useState<DataSource>({
    name: '',
    key: '',
    api: '',
    detail: '',
    disabled: false,
    from: 'config',
  });

  // 编辑视频源状态
  const [editingSource, setEditingSource] = useState<DataSource | null>(null);

  // 🔑 普通视频源代理配置
  const [videoProxySettings, setVideoProxySettings] = useState({
    enabled: false,
    proxyUrl: 'https://corsapi.smone.workers.dev',
  });

  // 代理状态检测
  const [proxyStatus, setProxyStatus] = useState<{
    healthy: boolean;
    responseTime?: number;
    error?: string;
    lastCheck?: string;
  } | null>(null);

  // 批量操作相关状态
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(),
  );

  const filteredSources = useMemo(() => {
    const query = sourceQuery.trim().toLocaleLowerCase();
    return sources.filter((source) => {
      const matchesQuery =
        !query ||
        [source.name, source.key, source.api, source.detail].some((value) =>
          value?.toLocaleLowerCase().includes(query),
        );
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'enabled' ? !source.disabled : source.disabled);
      const matchesType =
        typeFilter === 'all' ||
        (typeFilter === 'adult'
          ? source.is_adult
          : (source.type || 'vod') === typeFilter);
      return matchesQuery && matchesStatus && matchesType;
    });
  }, [sources, sourceQuery, statusFilter, typeFilter]);
  const hasSourceFilters =
    Boolean(sourceQuery.trim()) ||
    statusFilter !== 'all' ||
    typeFilter !== 'all';
  const enabledSourceCount = sources.filter(
    (source) => !source.disabled,
  ).length;

  // 全选只针对当前筛选结果，不修改其他已选项。
  const selectAll = useMemo(() => {
    return (
      filteredSources.length > 0 &&
      filteredSources.every((source) => selectedSources.has(source.key))
    );
  }, [selectedSources, filteredSources]);

  // 导入导出模态框状态
  const [importExportModal, setImportExportModal] = useState<{
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
    mode: 'export',
  });

  // 确认弹窗状态
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    onCancel: () => {},
  });

  // 有效性检测相关状态
  const [showValidationModal, setShowValidationModal] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [validationResults, setValidationResults] = useState<
    Array<{
      key: string;
      name: string;
      status: 'valid' | 'no_results' | 'invalid' | 'validating';
      message: string;
      resultCount: number;
    }>
  >([]);

  const activeDialogId = showAddForm
    ? 'video-source-create-dialog'
    : editingSource
      ? 'video-source-edit-dialog'
      : showValidationModal
        ? 'video-source-validation-dialog'
        : confirmModal.isOpen
          ? 'video-source-confirm-dialog'
          : null;

  useEffect(() => {
    if (!activeDialogId) return;
    const dialog = document.getElementById(activeDialogId);
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const firstField =
      dialog.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled])',
      ) ?? dialog.querySelector<HTMLElement>('button:not([disabled])');
    firstField?.focus();

    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (activeDialogId === 'video-source-create-dialog')
          setShowAddForm(false);
        if (activeDialogId === 'video-source-edit-dialog')
          setEditingSource(null);
        if (activeDialogId === 'video-source-validation-dialog')
          setShowValidationModal(false);
        if (activeDialogId === 'video-source-confirm-dialog') {
          setConfirmModal({
            isOpen: false,
            title: '',
            message: '',
            onConfirm: () => {},
            onCancel: () => {},
          });
        }
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [activeDialogId]);

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
    if (config?.SourceConfig) {
      setSources(config.SourceConfig);
      // 进入时重置 orderChanged
      setOrderChanged(false);
      // 重置选择状态
      setSelectedSources(new Set());
    }
  }, [config?.SourceConfig]);

  // 仅同步代理配置，避免其他模块刷新时覆盖未保存的代理草稿。
  useEffect(() => {
    if (config?.VideoProxyConfig) {
      setVideoProxySettings({
        enabled: config.VideoProxyConfig.enabled ?? false,
        proxyUrl:
          config.VideoProxyConfig.proxyUrl ||
          'https://corsapi.smone.workers.dev',
      });
    }
  }, [config?.VideoProxyConfig]);

  // 通用 API 请求
  const callSourceApi = async (body: Record<string, any>) => {
    try {
      const resp = await fetch('/api/admin/source', {
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
    const target = sources.find((s) => s.key === key);
    if (!target) return;
    const action = target.disabled ? 'enable' : 'disable';
    withLoading(`toggleSource_${key}`, () =>
      callSourceApi({ action, key }),
    ).catch(() => {
      console.error('操作失败', action, key);
    });
  };

  const handleDelete = (key: string) => {
    withLoading(`deleteSource_${key}`, () =>
      callSourceApi({ action: 'delete', key }),
    ).catch(() => {
      console.error('操作失败', 'delete', key);
    });
  };

  const handleToggleAdult = (key: string, is_adult: boolean) => {
    withLoading(`toggleAdult_${key}`, () =>
      callSourceApi({ action: 'update_adult', key, is_adult }),
    ).catch(() => {
      console.error('操作失败', 'update_adult', key);
    });
  };

  // 更新源权重
  const handleUpdateWeight = (key: string, weight: number) => {
    // 限制权重范围 0-100
    const validWeight = Math.max(0, Math.min(100, weight));
    // 立即更新本地状态
    setSources((prev) =>
      prev.map((s) => (s.key === key ? { ...s, weight: validWeight } : s)),
    );
    // 异步保存到后端
    withLoading(`updateWeight_${key}`, () =>
      callSourceApi({ action: 'update_weight', key, weight: validWeight }),
    ).catch(() => {
      console.error('操作失败', 'update_weight', key);
    });
  };

  // 保存普通视频源代理配置
  const handleSaveVideoProxy = async () => {
    try {
      // 验证代理URL
      if (videoProxySettings.enabled && videoProxySettings.proxyUrl) {
        try {
          new URL(videoProxySettings.proxyUrl);
        } catch {
          showAlert({
            type: 'error',
            title: '配置错误',
            message: '代理URL格式不正确',
          });
          return;
        }
      }

      await withLoading('saveVideoProxy', async () => {
        const response = await fetch('/api/admin/video-proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(videoProxySettings),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || '保存失败');
        }

        await refreshConfig();
      });

      showAlert({
        type: 'success',
        title: '保存成功',
        message: '视频源代理配置已保存',
        timer: 2000,
      });
    } catch (error) {
      showAlert({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '保存失败',
      });
    }
  };

  // 检测代理状态
  const handleCheckProxyStatus = async () => {
    try {
      await withLoading('checkProxyStatus', async () => {
        const response = await fetch('/api/proxy-status');
        if (!response.ok) {
          throw new Error('检测失败');
        }

        const data = await response.json();
        setProxyStatus({
          healthy: data.videoProxy.health.healthy,
          responseTime: data.videoProxy.health.responseTime,
          error: data.videoProxy.health.error,
          lastCheck: new Date().toLocaleString('zh-CN'),
        });

        if (data.videoProxy.health.healthy) {
          showAlert({
            type: 'success',
            title: '代理正常',
            message: `响应时间: ${data.videoProxy.health.responseTime}ms`,
            timer: 3000,
          });
        } else {
          showAlert({
            type: 'warning',
            title: '代理异常',
            message: data.videoProxy.health.error || '无法连接到 Worker',
            timer: 3000,
          });
        }
      });
    } catch (error) {
      showAlert({
        type: 'error',
        title: '检测失败',
        message: error instanceof Error ? error.message : '检测失败',
      });
    }
  };

  const handleBatchMarkAdult = async (markAsAdult: boolean) => {
    if (selectedSources.size === 0) {
      showAlert({
        type: 'warning',
        title: '提示',
        message: '请先选择要操作的视频源',
      });
      return;
    }

    const keys = Array.from(selectedSources);
    const action = markAsAdult ? 'batch_mark_adult' : 'batch_unmark_adult';

    try {
      await withLoading(`batchSource_${action}`, () =>
        callSourceApi({ action, keys }),
      );
      showAlert({
        type: 'success',
        title: '操作成功',
        message: `${markAsAdult ? '标记' : '取消标记'}成功！共处理 ${keys.length} 个视频源`,
        timer: 2000,
      });
      setSelectedSources(new Set());
    } catch {
      showAlert({
        type: 'error',
        title: '操作失败',
        message: `${markAsAdult ? '标记' : '取消标记'}失败，请重试`,
        showConfirm: true,
      });
    }
  };

  const handleBatchMarkType = async (type: 'vod' | 'shortdrama') => {
    if (selectedSources.size === 0) {
      showAlert({
        type: 'warning',
        title: '提示',
        message: '请先选择要操作的视频源',
      });
      return;
    }

    const keys = Array.from(selectedSources);
    const action =
      type === 'shortdrama' ? 'batch_mark_shortdrama' : 'batch_mark_vod';
    const typeName = type === 'shortdrama' ? '短剧' : '视频';

    try {
      await withLoading(`batchSource_${action}`, () =>
        callSourceApi({ action, keys, type }),
      );
      showAlert({
        type: 'success',
        title: '操作成功',
        message: `标记为${typeName}类型成功！共处理 ${keys.length} 个视频源`,
        timer: 2000,
      });
      setSelectedSources(new Set());
    } catch {
      showAlert({
        type: 'error',
        title: '操作失败',
        message: `标记为${typeName}类型失败，请重试`,
        showConfirm: true,
      });
    }
  };

  // 一键选中失效视频源（状态为 no_results 或 invalid）
  const handleSelectInvalidSources = useCallback(() => {
    const invalidKeys = validationResults
      .filter((r) => r.status === 'no_results' || r.status === 'invalid')
      .map((r) => r.key);

    if (invalidKeys.length === 0) {
      showAlert({
        type: 'warning',
        title: '没有失效的视频源',
        message: '当前没有检测到失效或无法搜索的视频源',
        timer: 3000,
      });
      return;
    }

    setSelectedSources(new Set(invalidKeys));
    setSourceQuery('');
    setStatusFilter('all');
    setTypeFilter('all');
    showAlert({
      type: 'success',
      title: '已选中失效源',
      message: `已选中 ${invalidKeys.length} 个失效或无法搜索的视频源`,
      timer: 3000,
    });
  }, [validationResults, showAlert]);

  // 获取失效视频源数量
  const invalidSourceCount = useMemo(() => {
    return validationResults.filter(
      (r) => r.status === 'no_results' || r.status === 'invalid',
    ).length;
  }, [validationResults]);

  const handleAddSource = () => {
    if (!newSource.name || !newSource.key || !newSource.api) return;
    withLoading('addSource', async () => {
      await callSourceApi({
        action: 'add',
        key: newSource.key,
        name: newSource.name,
        api: newSource.api,
        detail: newSource.detail,
        is_adult: newSource.is_adult,
        type: newSource.type,
      });
      setNewSource({
        name: '',
        key: '',
        api: '',
        detail: '',
        disabled: false,
        from: 'custom',
        is_adult: false,
        type: 'vod',
      });
      setShowAddForm(false);
    }).catch(() => {
      console.error('操作失败', 'add', newSource);
    });
  };

  // 编辑视频源
  const handleEditSource = (source: DataSource) => {
    setEditingSource({ ...source });
  };

  // 保存编辑的视频源
  const handleSaveEditSource = () => {
    if (
      !editingSource ||
      !editingSource.name ||
      !editingSource.key ||
      !editingSource.api
    )
      return;
    withLoading(`editSource_${editingSource.key}`, async () => {
      await callSourceApi({
        action: 'update',
        key: editingSource.key,
        name: editingSource.name,
        api: editingSource.api,
        detail: editingSource.detail,
        is_adult: editingSource.is_adult,
        type: editingSource.type,
      });
      setEditingSource(null);
    }).catch(() => {
      console.error('编辑视频源失败', editingSource);
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (hasSourceFilters || !over || active.id === over.id) return;
    const oldIndex = sources.findIndex((s) => s.key === active.id);
    const newIndex = sources.findIndex((s) => s.key === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setSources((prev) => arrayMove(prev, oldIndex, newIndex));
    setOrderChanged(true);
  };

  const handleSaveOrder = () => {
    const order = sources.map((s) => s.key);
    withLoading('saveSourceOrder', () =>
      callSourceApi({ action: 'sort', order }),
    )
      .then(() => {
        setOrderChanged(false);
      })
      .catch(() => {
        console.error('操作失败', 'sort', order);
      });
  };

  // 有效性检测函数
  const handleValidateSources = async () => {
    if (!searchKeyword.trim()) {
      showAlert({
        type: 'warning',
        title: '请输入搜索关键词',
        message: '搜索关键词不能为空',
      });
      return;
    }

    await withLoading('validateSources', async () => {
      setIsValidating(true);
      setValidationResults([]); // 清空之前的结果
      setShowValidationModal(false); // 立即关闭弹窗

      // 初始化所有视频源为检测中状态
      const initialResults = sources.map((source) => ({
        key: source.key,
        name: source.name,
        status: 'validating' as const,
        message: '检测中...',
        resultCount: 0,
      }));
      setValidationResults(initialResults);

      try {
        // 使用EventSource接收流式数据
        const eventSource = new EventSource(
          `/api/admin/source/validate?q=${encodeURIComponent(searchKeyword.trim())}`,
        );

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            switch (data.type) {
              case 'start':
                console.log(`开始检测 ${data.totalSources} 个视频源`);
                break;

              case 'source_result':
              case 'source_error':
                // 更新验证结果
                setValidationResults((prev) => {
                  const existing = prev.find((r) => r.key === data.source);
                  if (existing) {
                    return prev.map((r) =>
                      r.key === data.source
                        ? {
                            key: data.source,
                            name:
                              sources.find((s) => s.key === data.source)
                                ?.name || data.source,
                            status: data.status,
                            message:
                              data.status === 'valid'
                                ? '搜索正常'
                                : data.status === 'no_results'
                                  ? '无法搜索到结果'
                                  : '连接失败',
                            resultCount: data.status === 'valid' ? 1 : 0,
                          }
                        : r,
                    );
                  } else {
                    return [
                      ...prev,
                      {
                        key: data.source,
                        name:
                          sources.find((s) => s.key === data.source)?.name ||
                          data.source,
                        status: data.status,
                        message:
                          data.status === 'valid'
                            ? '搜索正常'
                            : data.status === 'no_results'
                              ? '无法搜索到结果'
                              : '连接失败',
                        resultCount: data.status === 'valid' ? 1 : 0,
                      },
                    ];
                  }
                });
                break;

              case 'complete':
                console.log(
                  `检测完成，共检测 ${data.completedSources} 个视频源`,
                );
                eventSource.close();
                setIsValidating(false);
                break;
            }
          } catch (error) {
            console.error('解析EventSource数据失败:', error);
          }
        };

        eventSource.onerror = (error) => {
          console.error('EventSource错误:', error);
          eventSource.close();
          setIsValidating(false);
          showAlert({
            type: 'error',
            title: '验证失败',
            message: '连接错误，请重试',
          });
        };

        // 设置超时，防止长时间等待
        setTimeout(() => {
          if (eventSource.readyState === EventSource.OPEN) {
            eventSource.close();
            setIsValidating(false);
            showAlert({
              type: 'warning',
              title: '验证超时',
              message: '检测超时，请重试',
            });
          }
        }, 60000); // 60秒超时
      } catch (error) {
        setIsValidating(false);
        showAlert({
          type: 'error',
          title: '验证失败',
          message: error instanceof Error ? error.message : '未知错误',
        });
        throw error;
      }
    });
  };

  // 获取有效性状态显示
  const getValidationStatus = (sourceKey: string) => {
    const result = validationResults.find((r) => r.key === sourceKey);
    if (!result) return null;

    switch (result.status) {
      case 'validating':
        return {
          text: '检测中',
          className:
            'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300',
          icon: '⟳',
          message: result.message,
        };
      case 'valid':
        return {
          text: '有效',
          className:
            'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-300',
          icon: '✓',
          message: result.message,
        };
      case 'no_results':
        return {
          text: '无法搜索',
          className:
            'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-300',
          icon: '⚠',
          message: result.message,
        };
      case 'invalid':
        return {
          text: '无效',
          className:
            'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-300',
          icon: '✗',
          message: result.message,
        };
      default:
        return null;
    }
  };

  // 全选/取消全选
  const handleSelectAll = useCallback(
    (checked: boolean) => {
      setSelectedSources((previous) => {
        const next = new Set(previous);
        filteredSources.forEach((source) => {
          if (checked) next.add(source.key);
          else next.delete(source.key);
        });
        return next;
      });
    },
    [filteredSources],
  );

  // 单个选择
  const handleSelectSource = useCallback((key: string, checked: boolean) => {
    setSelectedSources((prev) => {
      const newSelected = new Set(prev);
      if (checked) {
        newSelected.add(key);
      } else {
        newSelected.delete(key);
      }
      return newSelected;
    });
  }, []);

  // 批量操作
  const handleBatchOperation = async (
    action: 'batch_enable' | 'batch_disable' | 'batch_delete',
  ) => {
    if (selectedSources.size === 0) {
      showAlert({
        type: 'warning',
        title: '请先选择要操作的视频源',
        message: '请选择至少一个视频源',
      });
      return;
    }

    const keys = Array.from(selectedSources);
    let confirmMessage = '';
    let actionName = '';

    switch (action) {
      case 'batch_enable':
        confirmMessage = `确定要启用选中的 ${keys.length} 个视频源吗？`;
        actionName = '批量启用';
        break;
      case 'batch_disable':
        confirmMessage = `确定要禁用选中的 ${keys.length} 个视频源吗？`;
        actionName = '批量禁用';
        break;
      case 'batch_delete':
        confirmMessage = `确定要删除选中的 ${keys.length} 个视频源吗？此操作不可恢复！`;
        actionName = '批量删除';
        break;
    }

    // 显示确认弹窗
    setConfirmModal({
      isOpen: true,
      title: '确认操作',
      message: confirmMessage,
      onConfirm: async () => {
        try {
          await withLoading(`batchSource_${action}`, () =>
            callSourceApi({ action, keys }),
          );
          showAlert({
            type: 'success',
            title: `${actionName}成功`,
            message: `${actionName}了 ${keys.length} 个视频源`,
            timer: 2000,
          });
          // 重置选择状态
          setSelectedSources(new Set());
        } catch (err) {
          showAlert({
            type: 'error',
            title: `${actionName}失败`,
            message: err instanceof Error ? err.message : '操作失败',
          });
        }
        setConfirmModal({
          isOpen: false,
          title: '',
          message: '',
          onConfirm: () => {},
          onCancel: () => {},
        });
      },
      onCancel: () => {
        setConfirmModal({
          isOpen: false,
          title: '',
          message: '',
          onConfirm: () => {},
          onCancel: () => {},
        });
      },
    });
  };

  // 导出视频源
  const handleExportSources = (exportFormat: 'array' | 'config' = 'array') => {
    try {
      // 获取要导出的源（如果有选中则导出选中的，否则导出全部）
      const sourcesToExport =
        selectedSources.size > 0
          ? sources.filter((s) => selectedSources.has(s.key))
          : sources;

      if (sourcesToExport.length === 0) {
        showAlert({
          type: 'warning',
          title: '没有可导出的视频源',
          message: '请先添加视频源或选择要导出的视频源',
        });
        return;
      }

      let exportData: any;
      let filename: string;
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

      if (exportFormat === 'array') {
        // 数组格式：[{name, key, api, detail, disabled, is_adult, type, weight}]
        exportData = sourcesToExport.map((source) => ({
          name: source.name,
          key: source.key,
          api: source.api,
          detail: source.detail || '',
          disabled: source.disabled || false,
          is_adult: source.is_adult || false,
          type: source.type || 'vod',
          weight: source.weight ?? 50,
        }));
        filename = `video_sources_${timestamp}.json`;
      } else {
        // 配置文件格式：{"api_site": {"key": {name, api, detail?, is_adult?, type?, weight?}}}
        exportData = { api_site: {} };
        sourcesToExport.forEach((source) => {
          const sourceData: any = {
            name: source.name,
            api: source.api,
          };
          // 只在有值时添加可选字段
          if (source.detail) {
            sourceData.detail = source.detail;
          }
          if (source.is_adult) {
            sourceData.is_adult = source.is_adult;
          }
          if (source.type && source.type !== 'vod') {
            sourceData.type = source.type;
          }
          if (source.weight !== undefined && source.weight !== 50) {
            sourceData.weight = source.weight;
          }
          exportData.api_site[source.key] = sourceData;
        });
        filename = `config_${timestamp}.json`;
      }

      // 创建下载
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showAlert({
        type: 'success',
        title: '导出成功',
        message: `已导出 ${sourcesToExport.length} 个视频源到 ${filename}（${exportFormat === 'array' ? '数组格式' : '配置文件格式'}）`,
        timer: 3000,
      });

      // 关闭模态框
      setImportExportModal({ isOpen: false, mode: 'export' });
    } catch (err) {
      showAlert({
        type: 'error',
        title: '导出失败',
        message: err instanceof Error ? err.message : '未知错误',
      });
    }
  };

  // 导入视频源
  const handleImportSources = async (
    file: File,
    onProgress?: (current: number, total: number) => void,
  ) => {
    try {
      const text = await file.text();
      const importData = JSON.parse(text);

      if (!Array.isArray(importData)) {
        throw new Error('JSON 格式错误：应为数组格式');
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

      const total = importData.length;

      // 逐个导入
      for (let i = 0; i < importData.length; i++) {
        const item = importData[i];

        // 更新进度
        if (onProgress) {
          onProgress(i + 1, total);
        }

        try {
          // 验证必要字段
          if (!item.name || !item.key || !item.api) {
            result.failed++;
            result.details.push({
              name: item.name || '未知',
              key: item.key || '未知',
              status: 'failed',
              reason: '缺少必要字段（name、key 或 api）',
            });
            continue;
          }

          // 检查是否已存在
          const exists = sources.find((s) => s.key === item.key);
          if (exists) {
            result.skipped++;
            result.details.push({
              name: item.name,
              key: item.key,
              status: 'skipped',
              reason: '该 key 已存在，跳过导入',
            });
            continue;
          }

          // 调用API导入
          await callSourceApi({
            action: 'add',
            key: item.key,
            name: item.name,
            api: item.api,
            detail: item.detail || '',
            is_adult: item.is_adult || false,
            type: item.type || 'vod',
            weight: item.weight ?? 50,
          });

          result.success++;
          result.details.push({
            name: item.name,
            key: item.key,
            status: 'success',
          });
        } catch (err) {
          result.failed++;
          result.details.push({
            name: item.name,
            key: item.key,
            status: 'failed',
            reason: err instanceof Error ? err.message : '导入失败',
          });
        }
      }

      // 显示结果
      setImportExportModal({
        isOpen: true,
        mode: 'result',
        result,
      });

      // 如果有成功导入的，刷新配置
      if (result.success > 0) {
        await refreshConfig();
      }
    } catch (err) {
      showAlert({
        type: 'error',
        title: '导入失败',
        message: err instanceof Error ? err.message : '文件解析失败',
      });
      setImportExportModal({ isOpen: false, mode: 'import' });
    }

    return {
      success: 0,
      failed: 0,
      skipped: 0,
      details: [],
    };
  };

  const batchBusy = [
    'batch_enable',
    'batch_disable',
    'batch_delete',
    'batch_mark_adult',
    'batch_unmark_adult',
    'batch_mark_shortdrama',
    'batch_mark_vod',
  ].some((action) => isLoading(`batchSource_${action}`));
  const completedValidationCount = validationResults.filter(
    (result) => result.status !== 'validating',
  ).length;
  const clearSourceFilters = () => {
    setSourceQuery('');
    setStatusFilter('all');
    setTypeFilter('all');
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
        加载视频源配置…
      </div>
    );
  }

  return (
    <div className='admin-module admin-video-sources min-w-0 space-y-5'>
      <AdminTabs
        label='视频源配置视图'
        value={activeView}
        onChange={setActiveView}
        items={[
          { id: 'sources', label: '源列表', count: sources.length },
          { id: 'proxy', label: '代理设置' },
        ]}
      />

      {activeView === 'sources' ? (
        <AdminSection
          title='视频源列表'
          description={`共 ${sources.length} 个视频源，${enabledSourceCount} 个已启用。`}
          action={
            <div className='admin-toolbar-actions flex flex-wrap items-center gap-2'>
              <button
                type='button'
                onClick={() =>
                  setImportExportModal({ isOpen: true, mode: 'import' })
                }
                className={buttonStyles.secondary}
              >
                <Upload size={15} aria-hidden='true' /> 导入
              </button>
              <button
                type='button'
                onClick={() =>
                  setImportExportModal({
                    isOpen: true,
                    mode: 'export',
                  })
                }
                disabled={sources.length === 0}
                className={buttonStyles.secondary}
                title={
                  selectedSources.size > 0
                    ? `导出选中的 ${selectedSources.size} 个视频源`
                    : '导出全部视频源'
                }
              >
                <Download size={15} aria-hidden='true' />
                {selectedSources.size > 0
                  ? `导出已选 (${selectedSources.size})`
                  : '导出'}
              </button>
              <button
                type='button'
                onClick={() => setShowAddForm(true)}
                className={buttonStyles.primary}
              >
                <Plus size={16} aria-hidden='true' /> 添加视频源
              </button>
            </div>
          }
        >
          <div className='space-y-4'>
            <div className='admin-filter-row flex flex-wrap items-center gap-2'>
              <div className='admin-search-field min-w-0 flex-1'>
                <Search size={16} aria-hidden='true' />
                <input
                  type='search'
                  value={sourceQuery}
                  onChange={(event) => setSourceQuery(event.target.value)}
                  placeholder='搜索名称、Key 或接口地址'
                  aria-label='搜索视频源'
                  className='min-w-0 w-full'
                />
              </div>
              <select
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as typeof statusFilter)
                }
                aria-label='筛选视频源状态'
                className='min-w-28 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800'
              >
                <option value='all'>全部状态</option>
                <option value='enabled'>已启用</option>
                <option value='disabled'>已禁用</option>
              </select>
              <select
                value={typeFilter}
                onChange={(event) =>
                  setTypeFilter(event.target.value as typeof typeFilter)
                }
                aria-label='筛选视频源类型'
                className='min-w-28 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800'
              >
                <option value='all'>全部类型</option>
                <option value='vod'>普通视频</option>
                <option value='shortdrama'>短剧源</option>
                <option value='adult'>成人标记</option>
              </select>
              <button
                type='button'
                onClick={() => setShowValidationModal(true)}
                disabled={isValidating || sources.length === 0}
                className={buttonStyles.secondary}
              >
                {isValidating ? (
                  <LoaderCircle
                    size={15}
                    className='animate-spin motion-reduce:animate-none'
                    aria-hidden='true'
                  />
                ) : (
                  <ShieldCheck size={15} aria-hidden='true' />
                )}
                {isValidating ? '检测中…' : '检测全部源'}
              </button>
            </div>

            {selectedSources.size > 0 && (
              <div
                className='admin-bulk-bar flex flex-wrap items-center gap-2'
                role='region'
                aria-label='视频源批量操作'
              >
                <span className='mr-1 text-sm font-medium tabular-nums'>
                  已选 {selectedSources.size} 项
                </span>
                <button
                  type='button'
                  onClick={() => handleBatchOperation('batch_enable')}
                  disabled={batchBusy}
                  className={buttonStyles.secondary}
                >
                  批量启用
                </button>
                <button
                  type='button'
                  onClick={() => handleBatchOperation('batch_disable')}
                  disabled={batchBusy}
                  className={buttonStyles.secondary}
                >
                  批量禁用
                </button>
                <select
                  value=''
                  aria-label='批量标记视频源'
                  disabled={batchBusy}
                  className='rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800'
                  onChange={(event) => {
                    const action = event.target.value;
                    if (action === 'adult') void handleBatchMarkAdult(true);
                    if (action === 'normal') void handleBatchMarkAdult(false);
                    if (action === 'shortdrama' || action === 'vod')
                      void handleBatchMarkType(action);
                  }}
                >
                  <option value='' disabled>
                    批量标记…
                  </option>
                  <option value='shortdrama'>标记为短剧源</option>
                  <option value='vod'>标记为普通视频</option>
                  <option value='adult'>添加成人标记</option>
                  <option value='normal'>取消成人标记</option>
                </select>
                <button
                  type='button'
                  onClick={() => handleBatchOperation('batch_delete')}
                  disabled={batchBusy}
                  className={buttonStyles.danger}
                >
                  批量删除
                </button>
                <button
                  type='button'
                  onClick={() => setSelectedSources(new Set())}
                  className={buttonStyles.secondary}
                >
                  清空选择
                </button>
              </div>
            )}

            {validationResults.length > 0 && (
              <div
                className='admin-inline-note flex flex-wrap items-center justify-between gap-3'
                role='status'
              >
                <div className='flex flex-wrap items-center gap-2 text-sm'>
                  {isValidating ? (
                    <LoaderCircle
                      size={16}
                      className='animate-spin motion-reduce:animate-none'
                      aria-hidden='true'
                    />
                  ) : (
                    <CheckCircle2 size={16} aria-hidden='true' />
                  )}
                  <span className='tabular-nums'>
                    {isValidating
                      ? `正在检测 ${completedValidationCount} / ${validationResults.length}`
                      : `检测完成，共 ${validationResults.length} 个源`}
                  </span>
                  {invalidSourceCount > 0 && (
                    <span className='text-amber-700 dark:text-amber-400'>
                      其中 {invalidSourceCount} 个无法搜索或连接失败
                    </span>
                  )}
                </div>
                {!isValidating && invalidSourceCount > 0 && (
                  <button
                    type='button'
                    onClick={handleSelectInvalidSources}
                    className={buttonStyles.secondary}
                  >
                    选中失效源 ({invalidSourceCount})
                  </button>
                )}
              </div>
            )}

            {filteredSources.length === 0 ? (
              <AdminEmptyState
                icon={Server}
                title={
                  sources.length === 0 ? '还没有视频源' : '没有匹配的视频源'
                }
                description={
                  sources.length === 0
                    ? '添加视频源，或从 JSON 文件批量导入。'
                    : '尝试其他关键词，或清除状态与类型筛选。'
                }
              >
                <button
                  type='button'
                  onClick={
                    sources.length === 0
                      ? () => setShowAddForm(true)
                      : clearSourceFilters
                  }
                  className={buttonStyles.secondary}
                >
                  {sources.length === 0 ? '添加视频源' : '清除筛选'}
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
                  data-table='source-list'
                >
                  <table className='admin-table w-full min-w-[56rem] text-sm'>
                    <thead className='sticky top-0 z-10 bg-gray-50 dark:bg-gray-900'>
                      <tr>
                        <th className='w-9'>
                          <span className='sr-only'>排序</span>
                        </th>
                        <th className='w-9'>
                          <input
                            type='checkbox'
                            checked={selectAll}
                            onChange={(event) =>
                              handleSelectAll(event.target.checked)
                            }
                            aria-label='选择当前筛选结果中的全部视频源'
                            className='h-4 w-4 rounded border-gray-300 accent-blue-600'
                          />
                        </th>
                        <th scope='col'>名称 / Key</th>
                        <th scope='col'>接口地址</th>
                        <th scope='col'>状态 / 检测</th>
                        <th scope='col'>类型</th>
                        <th scope='col'>权重</th>
                        <th scope='col' className='text-right'>
                          操作
                        </th>
                      </tr>
                    </thead>
                    <SortableContext
                      items={filteredSources.map((source) => source.key)}
                      strategy={verticalListSortingStrategy}
                    >
                      <tbody>
                        {filteredSources.map((source) => (
                          <VideoSourceRow
                            key={source.key}
                            source={source}
                            selected={selectedSources.has(source.key)}
                            sortingDisabled={hasSourceFilters}
                            validation={getValidationStatus(source.key)}
                            isLoading={isLoading}
                            onSelect={handleSelectSource}
                            onToggleEnable={handleToggleEnable}
                            onToggleAdult={handleToggleAdult}
                            onUpdateWeight={handleUpdateWeight}
                            onEdit={handleEditSource}
                            onDelete={handleDelete}
                          />
                        ))}
                      </tbody>
                    </SortableContext>
                  </table>
                </div>
              </DndContext>
            )}

            <div className='flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400'>
              <span className='tabular-nums'>
                显示 {filteredSources.length} / {sources.length} 个视频源
              </span>
              {hasSourceFilters ? (
                <button
                  type='button'
                  onClick={clearSourceFilters}
                  className='text-blue-600 hover:underline dark:text-blue-400'
                >
                  清除筛选以调整排序
                </button>
              ) : (
                <span>拖动行首手柄调整排序；权重修改即时生效。</span>
              )}
            </div>
            {orderChanged && (
              <AdminSaveBar description='排序尚未保存。保存后，新的排列顺序才会生效。'>
                <button
                  type='button'
                  onClick={() => {
                    setSources(config.SourceConfig);
                    setOrderChanged(false);
                  }}
                  disabled={isLoading('saveSourceOrder')}
                  className={buttonStyles.secondary}
                >
                  还原排序
                </button>
                <button
                  type='button'
                  onClick={handleSaveOrder}
                  disabled={isLoading('saveSourceOrder')}
                  className={buttonStyles.primary}
                >
                  {isLoading('saveSourceOrder') ? '保存中…' : '保存排序'}
                </button>
              </AdminSaveBar>
            )}
          </div>
        </AdminSection>
      ) : (
        <div className='space-y-4'>
          <AdminSection
            title='视频源代理'
            description='使用 Cloudflare Worker 转发视频接口、播放流与 TMDB 请求。'
          >
            <div className='space-y-6'>
              <div className='flex items-center justify-between gap-6 border-b border-gray-200 pb-5 dark:border-gray-700'>
                <div>
                  <label
                    htmlFor='video-proxy-enabled'
                    className='text-sm font-medium'
                  >
                    启用 Worker 代理
                  </label>
                  <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
                    代理连接失败时自动回退直连。
                  </p>
                </div>
                <input
                  id='video-proxy-enabled'
                  type='checkbox'
                  role='switch'
                  checked={videoProxySettings.enabled}
                  onChange={(event) =>
                    setVideoProxySettings((previous) => ({
                      ...previous,
                      enabled: event.target.checked,
                    }))
                  }
                  className='h-5 w-5 shrink-0 rounded border-gray-300 accent-blue-600'
                />
              </div>
              <div className='admin-field max-w-3xl space-y-2'>
                <label
                  htmlFor='video-proxy-url'
                  className='block text-sm font-medium'
                >
                  Cloudflare Worker 地址
                </label>
                <input
                  id='video-proxy-url'
                  type='url'
                  value={videoProxySettings.proxyUrl}
                  disabled={!videoProxySettings.enabled}
                  onChange={(event) =>
                    setVideoProxySettings((previous) => ({
                      ...previous,
                      proxyUrl: event.target.value,
                    }))
                  }
                  placeholder='https://your-worker.workers.dev'
                  className='w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800'
                  aria-describedby='video-proxy-hint'
                />
                <p
                  id='video-proxy-hint'
                  className='text-xs text-gray-500 dark:text-gray-400'
                >
                  默认使用 https://corsapi.smone.workers.dev，也可填写自行部署的
                  Worker。
                </p>
              </div>
              <details className='admin-inline-note text-sm'>
                <summary className='cursor-pointer font-medium'>
                  代理范围与部署说明
                </summary>
                <ul className='mt-3 list-disc space-y-2 pl-5 text-gray-600 dark:text-gray-400'>
                  <li>
                    加速视频源 API，自动转发查询参数，并为每个源生成独立路径。
                  </li>
                  <li>
                    网页播放的 m3u8 视频流、TMDB 接口及图片请求使用相同代理。
                  </li>
                  <li>Emby 保持直连；TVBox 配置不受此设置影响。</li>
                  <li>
                    自行部署可参考{' '}
                    <a
                      href='https://github.com/SzeMeng76/CORSAPI'
                      target='_blank'
                      rel='noopener noreferrer'
                      className='text-blue-600 underline dark:text-blue-400'
                    >
                      CORSAPI 项目
                    </a>
                    。
                  </li>
                </ul>
              </details>
              <div className='flex flex-wrap items-start justify-between gap-3 border-t border-gray-200 pt-5 dark:border-gray-700'>
                <div>
                  <h3 className='text-sm font-medium'>连接状态</h3>
                  <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
                    检测使用已保存的代理配置。
                  </p>
                </div>
                {proxyStatus ? (
                  <div className='min-w-0 space-y-1.5 text-right text-sm'>
                    <span
                      className={`admin-status-badge ${proxyStatus.healthy ? 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400' : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400'}`}
                    >
                      {proxyStatus.healthy ? '连接正常' : '连接失败'}
                    </span>
                    {proxyStatus.healthy &&
                      proxyStatus.responseTime !== undefined && (
                        <p className='tabular-nums text-gray-600 dark:text-gray-400'>
                          响应时间 {proxyStatus.responseTime} ms
                        </p>
                      )}
                    {!proxyStatus.healthy && proxyStatus.error && (
                      <p className='max-w-lg break-words text-red-600 dark:text-red-400'>
                        {proxyStatus.error}
                      </p>
                    )}
                    <p className='text-xs tabular-nums text-gray-500'>
                      {proxyStatus.lastCheck}
                    </p>
                  </div>
                ) : (
                  <span className='admin-status-badge bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'>
                    尚未检测
                  </span>
                )}
              </div>
            </div>
          </AdminSection>
          <AdminSaveBar description='更改地址后请先保存，再检测连接。'>
            <button
              type='button'
              onClick={handleCheckProxyStatus}
              disabled={
                !videoProxySettings.enabled || isLoading('checkProxyStatus')
              }
              className={buttonStyles.secondary}
            >
              {isLoading('checkProxyStatus') ? '检测中…' : '检测代理状态'}
            </button>
            <button
              type='button'
              onClick={handleSaveVideoProxy}
              disabled={isLoading('saveVideoProxy')}
              className={buttonStyles.primary}
            >
              {isLoading('saveVideoProxy') ? '保存中…' : '保存代理配置'}
            </button>
          </AdminSaveBar>
        </div>
      )}

      {showAddForm &&
        createPortal(
          <div className='admin-modal fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4'>
            <div
              id='video-source-create-dialog'
              role='dialog'
              aria-modal='true'
              aria-labelledby='add-video-source-title'
              className='max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl dark:bg-gray-900'
            >
              <div className='flex items-center justify-between gap-4 border-b border-gray-200 px-6 py-4 dark:border-gray-700'>
                <h3
                  id='add-video-source-title'
                  className='text-lg font-semibold'
                >
                  添加视频源
                </h3>
                <button
                  type='button'
                  onClick={() => setShowAddForm(false)}
                  aria-label='关闭添加视频源'
                  className={buttonStyles.secondary}
                >
                  <X size={16} aria-hidden='true' />
                </button>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  handleAddSource();
                }}
                className='space-y-5 p-6'
              >
                <div className='admin-form-grid grid grid-cols-1 gap-4 sm:grid-cols-2'>
                  <label className='admin-field space-y-2 text-sm'>
                    <span className='block font-medium'>
                      名称 <span className='text-red-600'>*</span>
                    </span>
                    <input
                      type='text'
                      required
                      value={newSource.name}
                      onChange={(event) => {
                        const name = event.target.value;
                        setNewSource((previous) => ({
                          ...previous,
                          name,
                          key: generateKeyFromName(name),
                          is_adult: /^(AV-|成人|伦理|福利|里番|R18)/i.test(
                            name,
                          ),
                        }));
                      }}
                      placeholder='例如：综合影视'
                      className='w-full rounded-md border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800'
                    />
                  </label>
                  <label className='admin-field space-y-2 text-sm'>
                    <span className='block font-medium'>
                      Key <span className='text-red-600'>*</span>
                    </span>
                    <input
                      type='text'
                      required
                      value={newSource.key}
                      onChange={(event) =>
                        setNewSource((previous) => ({
                          ...previous,
                          key: event.target.value,
                        }))
                      }
                      placeholder='视频源唯一标识'
                      className='w-full rounded-md border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800'
                    />
                  </label>
                </div>
                <label className='admin-field block space-y-2 text-sm'>
                  <span className='block font-medium'>
                    API 地址 <span className='text-red-600'>*</span>
                  </span>
                  <input
                    type='text'
                    required
                    value={newSource.api}
                    onChange={(event) =>
                      setNewSource((previous) => ({
                        ...previous,
                        api: event.target.value,
                      }))
                    }
                    placeholder='https://example.com/api.php/provide/vod/'
                    className='w-full rounded-md border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800'
                  />
                </label>
                <label className='admin-field block space-y-2 text-sm'>
                  <span className='block font-medium'>
                    详情地址{' '}
                    <span className='font-normal text-gray-400'>选填</span>
                  </span>
                  <input
                    type='text'
                    value={newSource.detail || ''}
                    onChange={(event) =>
                      setNewSource((previous) => ({
                        ...previous,
                        detail: event.target.value,
                      }))
                    }
                    placeholder='填写详情页基础地址'
                    className='w-full rounded-md border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800'
                  />
                </label>
                <label className='admin-field block space-y-2 text-sm'>
                  <span className='block font-medium'>源类型</span>
                  <select
                    value={newSource.type || 'vod'}
                    onChange={(event) =>
                      setNewSource((previous) => ({
                        ...previous,
                        type: event.target.value as 'vod' | 'shortdrama',
                      }))
                    }
                    className='w-full rounded-md border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800'
                  >
                    <option value='vod'>普通视频</option>
                    <option value='shortdrama'>短剧源</option>
                  </select>
                  {newSource.type === 'shortdrama' && (
                    <p className='text-xs text-gray-500'>
                      系统会自动查找该源的“短剧”或“微短剧”分类。
                    </p>
                  )}
                </label>
                <label className='flex items-center gap-2 text-sm'>
                  <input
                    type='checkbox'
                    checked={newSource.is_adult || false}
                    onChange={(event) =>
                      setNewSource((previous) => ({
                        ...previous,
                        is_adult: event.target.checked,
                      }))
                    }
                    className='h-4 w-4 rounded border-gray-300 accent-blue-600'
                  />
                  标记为成人资源
                </label>
                <div className='flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-700'>
                  <button
                    type='button'
                    onClick={() => setShowAddForm(false)}
                    className={buttonStyles.secondary}
                  >
                    取消
                  </button>
                  <button
                    type='submit'
                    disabled={
                      !newSource.name ||
                      !newSource.key ||
                      !newSource.api ||
                      isLoading('addSource')
                    }
                    className={buttonStyles.primary}
                  >
                    {isLoading('addSource') ? '添加中…' : '添加视频源'}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {/* 编辑视频源弹窗 */}
      {editingSource &&
        createPortal(
          <div className='admin-modal fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4'>
            <div
              id='video-source-edit-dialog'
              role='dialog'
              aria-modal='true'
              aria-labelledby='edit-video-source-title'
              className='bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto'
            >
              <div className='p-6 border-b border-gray-200 dark:border-gray-700'>
                <h3
                  id='edit-video-source-title'
                  className='text-lg font-semibold text-gray-900 dark:text-gray-100'
                >
                  编辑视频源: {editingSource.name}
                </h3>
              </div>
              <div className='p-6 space-y-4'>
                {/* 基本信息 */}
                <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      名称
                    </label>
                    <input
                      id='edit-source-name'
                      aria-label='视频源名称'
                      type='text'
                      value={editingSource.name}
                      onChange={(e) =>
                        setEditingSource((prev) =>
                          prev ? { ...prev, name: e.target.value } : null,
                        )
                      }
                      className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                    />
                  </div>
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      Key（不可修改）
                    </label>
                    <input
                      aria-label='视频源 Key（不可修改）'
                      type='text'
                      value={editingSource.key}
                      disabled
                      className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                    />
                  </div>
                </div>

                {/* API 地址 */}
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                    API 地址
                  </label>
                  <input
                    aria-label='API 地址'
                    type='text'
                    value={editingSource.api}
                    onChange={(e) =>
                      setEditingSource((prev) =>
                        prev ? { ...prev, api: e.target.value } : null,
                      )
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </div>

                {/* Detail 地址 */}
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                    Detail 地址（选填）
                  </label>
                  <input
                    aria-label='详情地址（选填）'
                    type='text'
                    value={editingSource.detail || ''}
                    onChange={(e) =>
                      setEditingSource((prev) =>
                        prev ? { ...prev, detail: e.target.value } : null,
                      )
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  />
                </div>

                {/* 成人资源标记 */}
                <div className='flex items-center space-x-3 p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700'>
                  <label className='flex items-center space-x-2 cursor-pointer'>
                    <input
                      type='checkbox'
                      checked={editingSource.is_adult || false}
                      onChange={(e) =>
                        setEditingSource((prev) =>
                          prev ? { ...prev, is_adult: e.target.checked } : null,
                        )
                      }
                      className='w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500'
                    />
                    <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                      标记为成人资源
                    </span>
                  </label>
                </div>

                {/* 源类型选择 */}
                <div className='p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700'>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                    源类型
                  </label>
                  <div className='flex items-center space-x-4'>
                    <label className='flex items-center space-x-2 cursor-pointer'>
                      <input
                        type='radio'
                        name='editSourceType'
                        checked={editingSource.type !== 'shortdrama'}
                        onChange={() =>
                          setEditingSource((prev) =>
                            prev ? { ...prev, type: 'vod' } : null,
                          )
                        }
                        className='w-4 h-4 text-blue-600'
                      />
                      <span className='text-sm text-gray-700 dark:text-gray-300'>
                        普通视频源
                      </span>
                    </label>
                    <label className='flex items-center space-x-2 cursor-pointer'>
                      <input
                        type='radio'
                        name='editSourceType'
                        checked={editingSource.type === 'shortdrama'}
                        onChange={() =>
                          setEditingSource((prev) =>
                            prev ? { ...prev, type: 'shortdrama' } : null,
                          )
                        }
                        className='w-4 h-4 text-blue-600'
                      />
                      <span className='text-sm text-gray-700 dark:text-gray-300'>
                        短剧源
                      </span>
                    </label>
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className='flex justify-end space-x-3 pt-4 border-t border-gray-200 dark:border-gray-700'>
                  <button
                    onClick={() => setEditingSource(null)}
                    className={buttonStyles.secondary}
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSaveEditSource}
                    disabled={
                      !editingSource.name ||
                      !editingSource.api ||
                      isLoading(`editSource_${editingSource.key}`)
                    }
                    className={
                      !editingSource.name ||
                      !editingSource.api ||
                      isLoading(`editSource_${editingSource.key}`)
                        ? buttonStyles.disabled
                        : buttonStyles.primary
                    }
                  >
                    {isLoading(`editSource_${editingSource.key}`)
                      ? '保存中...'
                      : '保存'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 有效性检测弹窗 */}
      {showValidationModal &&
        createPortal(
          <div
            className='admin-modal fixed inset-0 bg-black/50 flex items-center justify-center z-50'
            onClick={() => setShowValidationModal(false)}
          >
            <div
              id='video-source-validation-dialog'
              role='dialog'
              aria-modal='true'
              aria-labelledby='video-source-validation-title'
              className='bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4'
              onClick={(e) => e.stopPropagation()}
            >
              <h3
                id='video-source-validation-title'
                className='text-lg font-medium text-gray-900 dark:text-gray-100 mb-4'
              >
                视频源有效性检测
              </h3>
              <p className='text-sm text-gray-600 dark:text-gray-400 mb-4'>
                请输入检测用的搜索关键词
              </p>
              <div className='space-y-4'>
                <input
                  type='text'
                  aria-label='检测用搜索关键词'
                  placeholder='请输入搜索关键词'
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                  onKeyDown={(e) =>
                    e.key === 'Enter' && handleValidateSources()
                  }
                />
                <div className='flex justify-end space-x-3'>
                  <button
                    onClick={() => setShowValidationModal(false)}
                    className='px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors'
                  >
                    取消
                  </button>
                  <button
                    onClick={handleValidateSources}
                    disabled={!searchKeyword.trim()}
                    className={`px-4 py-2 ${!searchKeyword.trim() ? buttonStyles.disabled : buttonStyles.primary}`}
                  >
                    开始检测
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

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

      {/* 批量操作确认弹窗 */}
      {confirmModal.isOpen &&
        createPortal(
          <div
            className='admin-modal fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4'
            onClick={confirmModal.onCancel}
          >
            <div
              id='video-source-confirm-dialog'
              role='dialog'
              aria-modal='true'
              aria-labelledby='video-source-confirm-title'
              className='bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full'
              onClick={(e) => e.stopPropagation()}
            >
              <div className='p-6'>
                <div className='flex items-center justify-between mb-4'>
                  <h3
                    id='video-source-confirm-title'
                    className='text-lg font-semibold text-gray-900 dark:text-gray-100'
                  >
                    {confirmModal.title}
                  </h3>
                  <button
                    onClick={confirmModal.onCancel}
                    aria-label='关闭确认操作'
                    className='text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors'
                  >
                    <svg
                      className='w-5 h-5'
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth={2}
                        d='M6 18L18 6M6 6l12 12'
                      />
                    </svg>
                  </button>
                </div>

                <div className='mb-6'>
                  <p className='text-sm text-gray-600 dark:text-gray-400'>
                    {confirmModal.message}
                  </p>
                </div>

                {/* 操作按钮 */}
                <div className='flex justify-end space-x-3'>
                  <button
                    onClick={confirmModal.onCancel}
                    className={`px-4 py-2 text-sm font-medium ${buttonStyles.secondary}`}
                  >
                    取消
                  </button>
                  <button
                    onClick={confirmModal.onConfirm}
                    disabled={
                      isLoading('batchSource_batch_enable') ||
                      isLoading('batchSource_batch_disable') ||
                      isLoading('batchSource_batch_delete')
                    }
                    className={`px-4 py-2 text-sm font-medium ${isLoading('batchSource_batch_enable') || isLoading('batchSource_batch_disable') || isLoading('batchSource_batch_delete') ? buttonStyles.disabled : buttonStyles.primary}`}
                  >
                    {isLoading('batchSource_batch_enable') ||
                    isLoading('batchSource_batch_disable') ||
                    isLoading('batchSource_batch_delete')
                      ? '操作中...'
                      : '确认'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 导入导出模态框 */}
      <ImportExportModal
        isOpen={importExportModal.isOpen}
        mode={importExportModal.mode}
        onClose={() => setImportExportModal({ isOpen: false, mode: 'import' })}
        onImport={handleImportSources}
        onExport={handleExportSources}
        result={importExportModal.result}
      />
    </div>
  );
};

export default VideoSourceConfig;
