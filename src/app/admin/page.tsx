/* eslint-disable no-console */

'use client';

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
import { CheckCircle, GripVertical } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import '@/components/admin/admin.css';

import { AdminConfig, AdminConfigResult } from '@/lib/admin.types';
import {
  persistAdminConfig,
  reconcileAdminConfig,
} from '@/lib/admin-workspace';

import type { AdminSectionId } from '@/components/admin/admin-navigation';
import {
  ADMIN_OVERVIEW,
  getAdminNavigation,
  getAdminSectionHref,
  resolveAdminSection,
} from '@/components/admin/admin-navigation';
import AdminOverview from '@/components/admin/AdminOverview';
import { AdminPanelVisibilityContext } from '@/components/admin/AdminPortal';
import {
  AdminEmptyState,
  AdminSaveBar,
  AdminSection,
} from '@/components/admin/AdminPrimitives';
import AdminShell from '@/components/admin/AdminShell';
import ConfigFileComponent from '@/components/admin/ConfigurationFile';
import LiveSourceConfig from '@/components/admin/LiveSourceManagement';
import PerformanceMonitor from '@/components/admin/PerformanceMonitor';
import {
  AlertModal,
  buttonStyles,
  CustomCategory,
  showError,
  showSuccess,
  useAlertModal,
  useLoadingState,
} from '@/components/admin/shared';
import SiteConfigComponent from '@/components/admin/SiteSettings';
import UserConfig from '@/components/admin/UserManagement';
import VideoSourceConfig from '@/components/admin/VideoSourceManagement';
import CacheManager from '@/components/CacheManager';
import CustomAdFilterConfig from '@/components/CustomAdFilterConfig';
import DanmuApiConfig from '@/components/DanmuApiConfig';
import DataMigration from '@/components/DataMigration';
import EmailConfig from '@/components/EmailConfig';
import EmbyConfig from '@/components/EmbyConfig';
import HomePageConfig from '@/components/HomePageConfig';
import InviteCodeManager from '@/components/InviteCodeManager';
// import ShortDramaConfig from '@/components/ShortDramaConfig'; // 暂时隐藏短剧API配置
import DownloadConfig from '@/components/OfflineDownloadConfig';
import { OIDCAuthConfig } from '@/components/OIDCAuthConfig';
import SourceTestModule from '@/components/SourceTestModule';
import TrustedNetworkConfig from '@/components/TrustedNetworkConfig';
import TVBoxSecurityConfig from '@/components/TVBoxSecurityConfig';
import WebhookConfig from '@/components/WebhookConfig';

const DEFAULT_OIDC_CONFIG: NonNullable<AdminConfig['OIDCAuthConfig']> = {
  enabled: false,
  enableRegistration: false,
  issuer: '',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  userInfoEndpoint: '',
  clientId: '',
  clientSecret: '',
  buttonText: '',
  minTrustLevel: 0,
};
const EMPTY_OIDC_PROVIDERS: NonNullable<AdminConfig['OIDCProviders']> = [];

// 分类配置组件
const CategoryConfig = ({
  config,
  refreshConfig,
}: {
  config: AdminConfig | null;
  refreshConfig: () => Promise<void>;
}) => {
  const { alertModal, showAlert, hideAlert } = useAlertModal();
  const { isLoading, withLoading } = useLoadingState();
  const [categories, setCategories] = useState<CustomCategory[]>(
    config?.CustomCategories || [],
  );
  const [showAddForm, setShowAddForm] = useState(false);
  const [orderChanged, setOrderChanged] = useState(false);
  const [newCategory, setNewCategory] = useState<CustomCategory>({
    name: '',
    type: 'movie',
    query: '',
    disabled: false,
    from: 'config',
  });

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
    if (config?.CustomCategories) {
      setCategories(config.CustomCategories);
      // 进入时重置 orderChanged
      setOrderChanged(false);
    }
  }, [config?.CustomCategories]);

  // 通用 API 请求
  const callCategoryApi = async (body: Record<string, any>) => {
    try {
      const resp = await fetch('/api/admin/category', {
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

  const handleToggleEnable = (query: string, type: 'movie' | 'tv') => {
    const target = categories.find((c) => c.query === query && c.type === type);
    if (!target) return;
    const action = target.disabled ? 'enable' : 'disable';
    withLoading(`toggleCategory_${query}_${type}`, () =>
      callCategoryApi({ action, query, type }),
    ).catch(() => {
      console.error('操作失败', action, query, type);
    });
  };

  const handleDelete = (query: string, type: 'movie' | 'tv') => {
    withLoading(`deleteCategory_${query}_${type}`, () =>
      callCategoryApi({ action: 'delete', query, type }),
    ).catch(() => {
      console.error('操作失败', 'delete', query, type);
    });
  };

  const handleAddCategory = () => {
    if (!newCategory.name || !newCategory.query) return;
    withLoading('addCategory', async () => {
      await callCategoryApi({
        action: 'add',
        name: newCategory.name,
        type: newCategory.type,
        query: newCategory.query,
      });
      setNewCategory({
        name: '',
        type: 'movie',
        query: '',
        disabled: false,
        from: 'custom',
      });
      setShowAddForm(false);
    }).catch(() => {
      console.error('操作失败', 'add', newCategory);
    });
  };

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = categories.findIndex(
      (c) => `${c.query}:${c.type}` === active.id,
    );
    const newIndex = categories.findIndex(
      (c) => `${c.query}:${c.type}` === over.id,
    );
    if (oldIndex < 0 || newIndex < 0) return;
    setCategories((prev) => arrayMove(prev, oldIndex, newIndex));
    setOrderChanged(true);
  };

  const handleSaveOrder = () => {
    const order = categories.map((c) => `${c.query}:${c.type}`);
    withLoading('saveCategoryOrder', () =>
      callCategoryApi({ action: 'sort', order }),
    )
      .then(() => {
        setOrderChanged(false);
      })
      .catch(() => {
        console.error('操作失败', 'sort', order);
      });
  };

  // 可拖拽行封装 (dnd-kit)
  const DraggableRow = ({ category }: { category: CustomCategory }) => {
    const {
      attributes,
      listeners,
      setNodeRef,
      setActivatorNodeRef,
      transform,
      transition,
    } = useSortable({ id: `${category.query}:${category.type}` });

    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
    } as React.CSSProperties;

    return (
      <tr
        ref={setNodeRef}
        style={style}
        className='hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors select-none'
      >
        <td className='px-2 py-4 text-gray-400'>
          <button
            ref={setActivatorNodeRef}
            type='button'
            className='admin-icon-button cursor-grab'
            style={{ touchAction: 'none' }}
            {...attributes}
            {...listeners}
            aria-label={`调整 ${category.name || category.query} 的排序`}
          >
            <GripVertical size={16} aria-hidden='true' />
          </button>
        </td>
        <td className='px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100'>
          {category.name || '-'}
        </td>
        <td className='px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100'>
          <span
            className={`px-2 py-1 text-xs rounded-full ${
              category.type === 'movie'
                ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300'
                : 'bg-purple-100 dark:bg-purple-900/20 text-purple-800 dark:text-purple-300'
            }`}
          >
            {category.type === 'movie' ? '电影' : '电视剧'}
          </span>
        </td>
        <td
          className='px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 max-w-[12rem] truncate'
          title={category.query}
        >
          {category.query}
        </td>
        <td className='px-6 py-4 whitespace-nowrap max-w-[1rem]'>
          <span
            className={`px-2 py-1 text-xs rounded-full ${
              !category.disabled
                ? 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                : 'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-300'
            }`}
          >
            {!category.disabled ? '启用中' : '已禁用'}
          </span>
        </td>
        <td className='px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2'>
          <button
            onClick={() => handleToggleEnable(category.query, category.type)}
            disabled={isLoading(
              `toggleCategory_${category.query}_${category.type}`,
            )}
            className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium ${
              !category.disabled
                ? buttonStyles.roundedDanger
                : buttonStyles.roundedSuccess
            } transition-colors ${isLoading(`toggleCategory_${category.query}_${category.type}`) ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {!category.disabled ? '禁用' : '启用'}
          </button>
          {category.from !== 'config' && (
            <button
              onClick={() => handleDelete(category.query, category.type)}
              disabled={isLoading(
                `deleteCategory_${category.query}_${category.type}`,
              )}
              className={`${buttonStyles.roundedSecondary} ${isLoading(`deleteCategory_${category.query}_${category.type}`) ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              删除
            </button>
          )}
        </td>
      </tr>
    );
  };

  if (!config) {
    return (
      <div className='flex justify-center items-center py-8'>
        <div className='flex items-center gap-3 px-6 py-3 bg-linear-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl border border-blue-200/50 dark:border-blue-700/50 shadow-md'>
          <div className='animate-spin rounded-full h-5 w-5 border-2 border-blue-300 border-t-blue-600 dark:border-blue-700 dark:border-t-blue-400'></div>
          <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
            加载配置中...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-6'>
      {/* 添加分类表单 */}
      <div className='flex items-center justify-between'>
        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
          自定义分类列表
        </h4>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className={`px-3 py-1 text-sm rounded-lg transition-colors ${showAddForm ? buttonStyles.secondary : buttonStyles.success}`}
        >
          {showAddForm ? '取消' : '添加分类'}
        </button>
      </div>

      {showAddForm && (
        <div className='p-4 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 space-y-4'>
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
            <label className='admin-field'>
              <span>分类名称</span>
              <input
                type='text'
                placeholder='例如：高分电影'
                value={newCategory.name}
                onChange={(e) =>
                  setNewCategory((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </label>
            <label className='admin-field'>
              <span>内容类型</span>
              <select
                value={newCategory.type}
                onChange={(e) =>
                  setNewCategory((prev) => ({
                    ...prev,
                    type: e.target.value as 'movie' | 'tv',
                  }))
                }
              >
                <option value='movie'>电影</option>
                <option value='tv'>电视剧</option>
              </select>
            </label>
            <label className='admin-field'>
              <span>搜索关键词</span>
              <input
                type='text'
                placeholder='输入用于筛选内容的关键词'
                value={newCategory.query}
                onChange={(e) =>
                  setNewCategory((prev) => ({ ...prev, query: e.target.value }))
                }
              />
            </label>
          </div>
          <div className='flex justify-end'>
            <button
              onClick={handleAddCategory}
              disabled={
                !newCategory.name ||
                !newCategory.query ||
                isLoading('addCategory')
              }
              className={`w-full sm:w-auto px-4 py-2 ${!newCategory.name || !newCategory.query || isLoading('addCategory') ? buttonStyles.disabled : buttonStyles.success}`}
            >
              {isLoading('addCategory') ? '添加中...' : '添加'}
            </button>
          </div>
        </div>
      )}

      {/* 分类表格 */}
      {categories.length === 0 ? (
        <AdminEmptyState
          title='暂无内容分类'
          description='添加分类后，可以设置内容类型、搜索关键词和显示顺序。'
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          autoScroll={false}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        >
          <div className='admin-table-wrap max-h-[28rem] overflow-auto relative'>
            <table className='admin-table'>
              <thead className='bg-gray-50 dark:bg-gray-900 sticky top-0 z-10'>
                <tr>
                  <th className='w-8' />
                  <th className='px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider'>
                    分类名称
                  </th>
                  <th className='px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider'>
                    类型
                  </th>
                  <th className='px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider'>
                    搜索关键词
                  </th>
                  <th className='px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider'>
                    状态
                  </th>
                  <th className='px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider'>
                    操作
                  </th>
                </tr>
              </thead>
              <SortableContext
                items={categories.map((c) => `${c.query}:${c.type}`)}
                strategy={verticalListSortingStrategy}
              >
                <tbody className='divide-y divide-gray-200 dark:divide-gray-700'>
                  {categories.map((category) => (
                    <DraggableRow
                      key={`${category.query}:${category.type}`}
                      category={category}
                    />
                  ))}
                </tbody>
              </SortableContext>
            </table>
          </div>
        </DndContext>
      )}

      {/* 保存排序按钮 */}
      {orderChanged && (
        <AdminSaveBar description='顺序已调整，保存后应用到前台分类。'>
          <button
            onClick={handleSaveOrder}
            disabled={isLoading('saveCategoryOrder')}
            className={`px-3 py-1.5 text-sm ${isLoading('saveCategoryOrder') ? buttonStyles.disabled : buttonStyles.primary}`}
          >
            {isLoading('saveCategoryOrder') ? '保存中...' : '保存排序'}
          </button>
        </AdminSaveBar>
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
    </div>
  );
};

// 网盘搜索配置组件
const NetDiskConfig = ({
  config,
  refreshConfig,
}: {
  config: AdminConfig | null;
  refreshConfig: () => Promise<void>;
}) => {
  const { alertModal, showAlert, hideAlert } = useAlertModal();
  const { isLoading, withLoading } = useLoadingState();

  const [netDiskSettings, setNetDiskSettings] = useState({
    enabled: true,
    pansouUrl: 'https://so.252035.xyz',
    timeout: 30,
    enabledCloudTypes: [
      'baidu',
      'aliyun',
      'quark',
      'guangya',
      'tianyi',
      'uc',
      'mobile',
      '115',
      'pikpak',
      'xunlei',
      '123',
      'magnet',
      'ed2k',
    ],
    token: '',
    username: '',
    password: '',
  });

  // 网盘类型选项
  const CLOUD_TYPE_OPTIONS = [
    { key: 'baidu', name: '百度网盘', icon: '📁' },
    { key: 'aliyun', name: '阿里云盘', icon: '☁️' },
    { key: 'quark', name: '夸克网盘', icon: '⚡' },
    { key: 'guangya', name: '光鸭云盘', icon: '🦆' },
    { key: 'tianyi', name: '天翼云盘', icon: '📱' },
    { key: 'uc', name: 'UC网盘', icon: '🌐' },
    { key: 'mobile', name: '移动云盘', icon: '📲' },
    { key: '115', name: '115网盘', icon: '💾' },
    { key: 'pikpak', name: 'PikPak', icon: '📦' },
    { key: 'xunlei', name: '迅雷网盘', icon: '⚡' },
    { key: '123', name: '123网盘', icon: '🔢' },
    { key: 'magnet', name: '磁力链接', icon: '🧲' },
    { key: 'ed2k', name: '电驴链接', icon: '🐴' },
  ];

  // 从config加载设置
  useEffect(() => {
    if (config?.NetDiskConfig) {
      setNetDiskSettings({
        enabled: config.NetDiskConfig.enabled ?? true,
        pansouUrl: config.NetDiskConfig.pansouUrl || 'https://so.252035.xyz',
        timeout: config.NetDiskConfig.timeout || 30,
        enabledCloudTypes: config.NetDiskConfig.enabledCloudTypes || [
          'baidu',
          'aliyun',
          'quark',
          'tianyi',
          'uc',
        ],
        token: config.NetDiskConfig.token || '',
        username: config.NetDiskConfig.username || '',
        password: config.NetDiskConfig.password || '',
      });
    }
  }, [config?.NetDiskConfig]);

  // 保存网盘搜索配置
  const handleSave = async () => {
    await withLoading('saveNetDiskConfig', async () => {
      try {
        const response = await fetch('/api/admin/netdisk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(netDiskSettings),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || '保存失败');
        }

        showSuccess('网盘搜索配置保存成功', showAlert);
        await refreshConfig();
      } catch (err) {
        showError(err instanceof Error ? err.message : '保存失败', showAlert);
      }
    });
  };

  // 处理网盘类型选择
  const handleCloudTypeChange = (type: string, enabled: boolean) => {
    setNetDiskSettings((prev) => ({
      ...prev,
      enabledCloudTypes: enabled
        ? [...prev.enabledCloudTypes, type]
        : prev.enabledCloudTypes.filter((t) => t !== type),
    }));
  };

  // 全选/取消全选网盘类型
  const handleSelectAll = (selectAll: boolean) => {
    setNetDiskSettings((prev) => ({
      ...prev,
      enabledCloudTypes: selectAll
        ? CLOUD_TYPE_OPTIONS.map((option) => option.key)
        : [],
    }));
  };

  return (
    <div className='space-y-6'>
      {/* 基础设置 */}
      <div className='bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700 shadow-sm'>
        <div className='mb-6'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2'>
            基础设置
          </h3>
          <div className='flex items-center space-x-2 text-sm text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 rounded-lg'>
            <svg className='h-4 w-4' fill='currentColor' viewBox='0 0 20 20'>
              <path
                fillRule='evenodd'
                d='M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z'
                clipRule='evenodd'
              />
            </svg>
            <span>
              📡 集成开源项目 <strong>PanSou</strong> 提供网盘资源搜索功能
            </span>
            <a
              href='https://github.com/fish2018/pansou'
              target='_blank'
              rel='noopener noreferrer'
              className='text-blue-700 dark:text-blue-300 hover:underline font-medium'
            >
              查看项目
            </a>
          </div>
        </div>

        {/* 启用网盘搜索 */}
        <div className='space-y-4'>
          <div className='flex items-center space-x-3'>
            <label className='flex items-center cursor-pointer'>
              <input
                type='checkbox'
                checked={netDiskSettings.enabled}
                onChange={(e) =>
                  setNetDiskSettings((prev) => ({
                    ...prev,
                    enabled: e.target.checked,
                  }))
                }
                className='w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700'
              />
              <span className='ml-2 text-sm font-medium text-gray-900 dark:text-gray-100'>
                启用网盘搜索功能
              </span>
            </label>
          </div>

          {/* PanSou服务地址 */}
          <div className='space-y-2'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
              PanSou服务地址
            </label>
            <input
              type='url'
              value={netDiskSettings.pansouUrl}
              onChange={(e) =>
                setNetDiskSettings((prev) => ({
                  ...prev,
                  pansouUrl: e.target.value,
                }))
              }
              placeholder='https://so.252035.xyz'
              className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500'
            />
            <div className='flex items-start space-x-2 text-sm text-gray-500 dark:text-gray-400'>
              <div className='flex-1'>
                默认使用公益服务，您也可以填入自己搭建的PanSou服务地址
              </div>
              <a
                href='https://github.com/fish2018/pansou'
                target='_blank'
                rel='noopener noreferrer'
                className='inline-flex items-center px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded-md transition-colors whitespace-nowrap'
              >
                <svg
                  className='h-3 w-3 mr-1'
                  fill='currentColor'
                  viewBox='0 0 20 20'
                >
                  <path
                    fillRule='evenodd'
                    d='M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z'
                    clipRule='evenodd'
                  />
                </svg>
                搭建教程
              </a>
            </div>
          </div>

          {/* 超时设置 */}
          <div className='space-y-2'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
              请求超时时间（秒）
            </label>
            <input
              type='number'
              min='10'
              max='120'
              value={netDiskSettings.timeout}
              onChange={(e) =>
                setNetDiskSettings((prev) => ({
                  ...prev,
                  timeout: parseInt(e.target.value) || 30,
                }))
              }
              className='w-32 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500'
            />
          </div>

          {/* 认证配置 */}
          <div className='space-y-4 pt-2 border-t border-gray-200 dark:border-gray-700'>
            <div>
              <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                认证配置（可选）
              </h4>
              <p className='text-xs text-gray-500 dark:text-gray-400'>
                如果您的 PanSou
                实例启用了认证，填写以下任意一种方式。用户名+密码优先级高于
                Token。
              </p>
            </div>
            <div className='space-y-2'>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
                Bearer Token
              </label>
              <input
                type='password'
                value={netDiskSettings.token}
                onChange={(e) =>
                  setNetDiskSettings((prev) => ({
                    ...prev,
                    token: e.target.value,
                  }))
                }
                placeholder='留空则不使用 Token 认证'
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500'
              />
            </div>
            <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
              <div className='space-y-2'>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
                  用户名
                </label>
                <input
                  type='text'
                  value={netDiskSettings.username}
                  onChange={(e) =>
                    setNetDiskSettings((prev) => ({
                      ...prev,
                      username: e.target.value,
                    }))
                  }
                  placeholder='PanSou 登录用户名'
                  className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500'
                />
              </div>
              <div className='space-y-2'>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
                  密码
                </label>
                <input
                  type='password'
                  value={netDiskSettings.password}
                  onChange={(e) =>
                    setNetDiskSettings((prev) => ({
                      ...prev,
                      password: e.target.value,
                    }))
                  }
                  placeholder='PanSou 登录密码'
                  className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500'
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 支持的网盘类型 */}
      <div className='bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700 shadow-sm'>
        <div className='flex items-center justify-between mb-4'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
            支持的网盘类型
          </h3>
          <div className='space-x-2'>
            <button
              onClick={() => handleSelectAll(true)}
              className={buttonStyles.quickAction}
            >
              全选
            </button>
            <button
              onClick={() => handleSelectAll(false)}
              className={buttonStyles.quickAction}
            >
              清空
            </button>
          </div>
        </div>

        <div className='grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4'>
          {CLOUD_TYPE_OPTIONS.map((option) => (
            <label
              key={option.key}
              className='flex items-center space-x-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors'
            >
              <input
                type='checkbox'
                checked={netDiskSettings.enabledCloudTypes.includes(option.key)}
                onChange={(e) =>
                  handleCloudTypeChange(option.key, e.target.checked)
                }
                className='w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700'
              />
              <span className='text-lg'>{option.icon}</span>
              <span className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                {option.name}
              </span>
            </label>
          ))}
        </div>

        <div className='mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg'>
          <div className='flex items-start space-x-2'>
            <CheckCircle
              size={16}
              className='text-blue-600 dark:text-blue-400 mt-0.5 shrink-0'
            />
            <div className='text-sm text-blue-700 dark:text-blue-300'>
              <p className='font-medium mb-1'>配置说明</p>
              <p>
                选择要在搜索结果中显示的网盘类型。取消选择的类型不会出现在搜索结果中。
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 保存按钮 */}
      <div className='flex justify-end'>
        <button
          onClick={handleSave}
          disabled={isLoading('saveNetDiskConfig')}
          className={`px-4 py-2 ${
            isLoading('saveNetDiskConfig')
              ? buttonStyles.disabled
              : buttonStyles.success
          } rounded-lg transition-colors`}
        >
          {isLoading('saveNetDiskConfig') ? '保存中…' : '保存配置'}
        </button>
      </div>

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
    </div>
  );
};

function AdminLoading() {
  return (
    <div className='admin-page'>
      <div className='admin-loading' role='status'>
        <div className='admin-loading-bar' />
        <span>正在载入管理工作区…</span>
      </div>
    </div>
  );
}

function AdminPageClient() {
  const { alertModal, showAlert, hideAlert } = useAlertModal();
  const { isLoading, withLoading } = useLoadingState();
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<'owner' | 'admin' | null>(null);
  const [showResetConfigModal, setShowResetConfigModal] = useState(false);
  const searchParams = useSearchParams();
  const active = resolveAdminSection(searchParams.get('section'), role);
  const [visitedSections, setVisitedSections] = useState<AdminSectionId[]>([
    'overview',
  ]);

  const fetchConfig = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      setRefreshing(true);
      const response = await fetch('/api/admin/config');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          data.error || '无法读取后台配置，请检查登录状态后重试。',
        );
      }
      const data = (await response.json()) as AdminConfigResult;
      setConfig((current) => reconcileAdminConfig(current, data.Config));
      setRole(data.Role);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取配置失败');
    } finally {
      setRefreshing(false);
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchConfig(true);
  }, [fetchConfig]);
  useEffect(() => {
    setVisitedSections((previous) =>
      previous.includes(active.id) ? previous : [...previous, active.id],
    );
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [active.id]);

  const navigate = (id: AdminSectionId) => {
    if (id !== active.id)
      window.history.pushState(null, '', getAdminSectionHref(id));
  };

  // 新增: 重置配置处理函数
  const handleResetConfig = () => {
    setShowResetConfigModal(true);
  };

  const handleConfirmResetConfig = async () => {
    await withLoading('resetConfig', async () => {
      try {
        const response = await fetch(`/api/admin/reset`);
        if (!response.ok) {
          throw new Error(`重置失败: ${response.status}`);
        }
        showSuccess('重置成功，请刷新页面！', showAlert);
        await fetchConfig();
        setShowResetConfigModal(false);
      } catch (err) {
        showError(err instanceof Error ? err.message : '重置失败', showAlert);
        throw err;
      }
    });
  };

  const saveNotificationConfig = async <
    K extends 'EmailConfig' | 'WebhookConfig',
  >(
    configKey: K,
    notificationConfig: NonNullable<AdminConfig[K]>,
  ) => {
    const channel = configKey === 'EmailConfig' ? 'email' : 'webhook';
    const response = await fetch(`/api/admin/${channel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', config: notificationConfig }),
    });
    const data = (await response.json()) as {
      success?: boolean;
      config?: AdminConfig[K];
      error?: string;
    };
    const savedConfig = data.config;
    if (!response.ok || !data.success || !savedConfig) {
      throw new Error(data.error || '保存通知配置失败');
    }
    setConfig((current) =>
      current ? { ...current, [configKey]: savedConfig } : current,
    );
  };

  const testNotificationConfig = async (
    channel: 'email' | 'webhook',
    testSettings: { testEmail: string } | { url: string },
  ): Promise<{ success: boolean; error?: string }> => {
    const response = await fetch(`/api/admin/${channel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test', ...testSettings }),
    });
    const data = (await response.json()) as {
      success?: boolean;
      error?: string;
    };
    if (!response.ok || !data.success) {
      return { success: false, error: data.error || '发送测试通知失败' };
    }
    return { success: true };
  };

  const renderModule = (id: AdminSectionId): ReactNode => {
    switch (id) {
      case 'overview':
        return config && role ? (
          <AdminOverview
            config={config}
            role={role}
            refreshing={refreshing}
            onRefresh={() => void fetchConfig()}
            onNavigate={navigate}
          />
        ) : null;
      case 'configFile':
        return (
          <ConfigFileComponent config={config} refreshConfig={fetchConfig} />
        );
      case 'siteConfig':
        return (
          <SiteConfigComponent config={config} refreshConfig={fetchConfig} />
        );
      case 'homePageConfig':
        return <HomePageConfig config={config} refreshConfig={fetchConfig} />;
      case 'userConfig':
        return (
          <UserConfig config={config} role={role} refreshConfig={fetchConfig} />
        );
      case 'inviteCodeManager':
        return <InviteCodeManager />;
      case 'oidcAuthConfig':
        return (
          <OIDCAuthConfig
            config={config?.OIDCAuthConfig || DEFAULT_OIDC_CONFIG}
            providers={config?.OIDCProviders || EMPTY_OIDC_PROVIDERS}
            onSave={async (newConfig) => {
              if (!config) return;
              await persistAdminConfig({
                ...config,
                OIDCAuthConfig: newConfig,
              });
              await fetchConfig();
            }}
            onSaveProviders={async (newProviders) => {
              if (!config) return;
              const updatedConfig = {
                ...config,
                OIDCProviders: newProviders,
              };
              // 如果切换到多provider模式，删除旧的单provider配置
              if (newProviders.length > 0) {
                delete updatedConfig.OIDCAuthConfig;
              }
              await persistAdminConfig(updatedConfig);
              await fetchConfig();
            }}
          />
        );
      case 'emailConfig':
        return (
          <EmailConfig
            config={config?.EmailConfig || null}
            onSave={(newConfig) =>
              saveNotificationConfig('EmailConfig', newConfig)
            }
            onTest={(testEmail) =>
              testNotificationConfig('email', { testEmail })
            }
          />
        );
      case 'webhookConfig':
        return (
          <WebhookConfig
            config={config?.WebhookConfig || null}
            onSave={(newConfig) =>
              saveNotificationConfig('WebhookConfig', newConfig)
            }
            onTest={(url) => testNotificationConfig('webhook', { url })}
          />
        );
      case 'videoSource':
        return (
          <VideoSourceConfig config={config} refreshConfig={fetchConfig} />
        );
      case 'sourceTest':
        return <SourceTestModule embedded />;
      case 'liveSource':
        return <LiveSourceConfig config={config} refreshConfig={fetchConfig} />;
      case 'categoryConfig':
        return <CategoryConfig config={config} refreshConfig={fetchConfig} />;
      case 'netdiskConfig':
        return <NetDiskConfig config={config} refreshConfig={fetchConfig} />;
      case 'embyConfig':
        return <EmbyConfig config={config} refreshConfig={fetchConfig} />;
      case 'downloadConfig':
        return <DownloadConfig config={config} refreshConfig={fetchConfig} />;
      case 'customAdFilter':
        return (
          <CustomAdFilterConfig config={config} refreshConfig={fetchConfig} />
        );
      case 'tvboxSecurityConfig':
        return (
          <TVBoxSecurityConfig config={config} refreshConfig={fetchConfig} />
        );
      case 'trustedNetworkConfig':
        return <TrustedNetworkConfig />;
      case 'danmuApiConfig':
        return <DanmuApiConfig config={config} refreshConfig={fetchConfig} />;
      case 'cacheManager':
        return <CacheManager />;
      case 'dataMigration':
        return <DataMigration onRefreshConfig={fetchConfig} />;
      case 'performanceMonitor':
        return <PerformanceMonitor />;
      case 'maintenance':
        return (
          <AdminSection
            title='重置站点配置'
            description='恢复默认站点设置、用户封禁和管理员设置，以及自定义视频源。'
            className='admin-danger-zone'
          >
            <div className='admin-stack'>
              <p className='admin-field-hint'>
                请先在“数据迁移”中导出需要保留的数据。此操作会改变当前已保存的配置。
              </p>
              <div className='admin-toolbar-actions'>
                <button
                  type='button'
                  className='admin-button admin-button-secondary'
                  onClick={() => navigate('dataMigration')}
                >
                  前往数据备份
                </button>
                <button
                  type='button'
                  className='admin-button admin-button-danger-ghost'
                  onClick={handleResetConfig}
                >
                  重置配置
                </button>
              </div>
            </div>
          </AdminSection>
        );
    }
  };

  if (loading) return <AdminLoading />;
  const available = [
    ADMIN_OVERVIEW,
    ...getAdminNavigation(role).flatMap((group) => group.items),
  ];
  const mountedSections = available.filter(
    (item) =>
      item.id === active.id ||
      (!item.transient && visitedSections.includes(item.id)),
  );
  const redesigned = new Set<AdminSectionId>([
    'overview',
    'userConfig',
    'videoSource',
    'liveSource',
    'siteConfig',
    'configFile',
    'maintenance',
    'homePageConfig',
    'embyConfig',
    'sourceTest',
  ]);

  return (
    <AdminShell active={active} role={role} onNavigate={navigate}>
      {error && config && (
        <div className='admin-error-banner' role='alert'>
          <span>{error}</span>
          <button
            type='button'
            className='admin-button admin-button-secondary'
            onClick={() => void fetchConfig()}
            disabled={refreshing}
          >
            重新加载
          </button>
        </div>
      )}
      {!config ? (
        <div className='admin-error' role='alert'>
          <h2>暂时无法载入管理后台</h2>
          <p>{error || '未能读取站点配置，请重新加载。'}</p>
          <button
            type='button'
            className='admin-button admin-button-primary'
            disabled={refreshing}
            onClick={() => void fetchConfig()}
          >
            {refreshing ? '正在重试…' : '重新加载'}
          </button>
        </div>
      ) : (
        mountedSections.map((item) => (
          <AdminPanelVisibilityContext.Provider
            key={item.id}
            value={active.id === item.id}
          >
            <div
              hidden={active.id !== item.id}
              className='admin-module'
              data-module={item.id}
              data-legacy={!redesigned.has(item.id)}
              aria-label={item.label}
            >
              {renderModule(item.id)}
            </div>
          </AdminPanelVisibilityContext.Provider>
        ))
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

      {/* 重置配置确认弹窗 */}
      {active.id === 'maintenance' &&
        showResetConfigModal &&
        createPortal(
          <div
            className='admin-dialog-overlay fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4'
            onClick={() => setShowResetConfigModal(false)}
          >
            <div
              role='dialog'
              aria-modal='true'
              aria-labelledby='admin-reset-title'
              className='admin-dialog bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full'
              onClick={(e) => e.stopPropagation()}
            >
              <div className='p-6'>
                <div className='flex items-center justify-between mb-6'>
                  <h3
                    id='admin-reset-title'
                    className='text-xl font-semibold text-gray-900 dark:text-gray-100'
                  >
                    确认重置配置
                  </h3>
                  <button
                    aria-label='关闭重置确认'
                    onClick={() => setShowResetConfigModal(false)}
                    className='text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors'
                  >
                    <svg
                      className='w-6 h-6'
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
                  <div className='bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 mb-4'>
                    <div className='flex items-center space-x-2 mb-2'>
                      <svg
                        className='w-5 h-5 text-yellow-600 dark:text-yellow-400'
                        fill='none'
                        stroke='currentColor'
                        viewBox='0 0 24 24'
                      >
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          strokeWidth={2}
                          d='M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
                        />
                      </svg>
                      <span className='text-sm font-medium text-yellow-800 dark:text-yellow-300'>
                        此操作会恢复默认配置
                      </span>
                    </div>
                    <p className='text-sm text-yellow-700 dark:text-yellow-400'>
                      此操作将重置用户封禁和管理员设置、自定义视频源，站点配置将重置为默认值，是否继续？
                    </p>
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className='flex justify-end space-x-3'>
                  <button
                    onClick={() => setShowResetConfigModal(false)}
                    className={`px-6 py-2.5 text-sm font-medium ${buttonStyles.secondary}`}
                  >
                    取消
                  </button>
                  <button
                    onClick={handleConfirmResetConfig}
                    disabled={isLoading('resetConfig')}
                    className={`px-6 py-2.5 text-sm font-medium ${isLoading('resetConfig') ? buttonStyles.disabled : buttonStyles.danger}`}
                  >
                    {isLoading('resetConfig') ? '重置中...' : '确认重置'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </AdminShell>
  );
}

export default function AdminPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminPageClient />
    </Suspense>
  );
}
