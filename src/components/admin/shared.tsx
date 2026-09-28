/* eslint-disable no-console */

'use client';

import { AlertCircle, AlertTriangle, CheckCircle } from 'lucide-react';
import { pinyin } from 'pinyin-pro';
import { useEffect, useState } from 'react';
import { createPortal } from '@/components/admin/AdminPortal';

import { AdminConfig } from '@/lib/admin.types';
import { type OptionalFeature } from '@/lib/optional-features';

export const buttonStyles = {
  primary: 'admin-button admin-button-primary',
  success: 'admin-button admin-button-primary',
  danger: 'admin-button admin-button-danger',
  secondary: 'admin-button admin-button-secondary',
  warning: 'admin-button admin-button-warning',
  primarySmall: 'admin-button admin-button-small admin-button-text',
  successSmall: 'admin-button admin-button-small admin-button-text',
  dangerSmall: 'admin-button admin-button-small admin-button-danger-ghost',
  secondarySmall: 'admin-button admin-button-small admin-button-secondary',
  warningSmall: 'admin-button admin-button-small admin-button-warning',
  roundedPrimary: 'admin-button admin-button-small admin-button-text',
  roundedSuccess: 'admin-button admin-button-small admin-button-text',
  roundedDanger: 'admin-button admin-button-small admin-button-danger-ghost',
  roundedSecondary: 'admin-button admin-button-small admin-button-secondary',
  roundedWarning: 'admin-button admin-button-small admin-button-warning',
  roundedPurple: 'admin-button admin-button-small admin-button-text',
  disabled: 'admin-button admin-button-disabled',
  disabledSmall: 'admin-button admin-button-small admin-button-disabled',
  toggleOn: 'admin-switch-on',
  toggleOff: 'admin-switch-off',
  toggleThumb: 'admin-switch-thumb',
  toggleThumbOn: 'translate-x-6',
  toggleThumbOff: 'translate-x-1',
  quickAction: 'admin-button admin-button-small admin-button-secondary',
};

export const generateKeyFromName = (name: string): string => {
  if (!name) return '';

  const initials = name
    .split('')
    .map((char) => {
      if (/[a-zA-Z]/.test(char)) return char.toUpperCase();
      if (/[0-9]/.test(char)) return char;
      const result = pinyin(char, { pattern: 'first', toneType: 'none' });
      return result || char;
    })
    .join('');

  return initials || name.substring(0, 4).toUpperCase();
};

export interface AlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'success' | 'error' | 'warning';
  title: string;
  message?: string;
  timer?: number;
  showConfirm?: boolean;
  showUndo?: boolean; // 新增：显示撤销按钮
  onUndo?: () => void; // 新增：撤销回调
  undoTimer?: number; // 新增：撤销倒计时（毫秒）
}

export const AlertModal = ({
  isOpen,
  onClose,
  type,
  title,
  message,
  timer,
  showConfirm = false,
  showUndo = false,
  onUndo,
  undoTimer = 5000,
}: AlertModalProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [isUndone, setIsUndone] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true);
      setIsUndone(false);

      // 如果有撤销功能，启动倒计时
      if (showUndo && undoTimer) {
        setCountdown(Math.ceil(undoTimer / 1000));
        const countdownInterval = setInterval(() => {
          setCountdown((prev) => {
            if (prev <= 1) {
              clearInterval(countdownInterval);
              return 0;
            }
            return prev - 1;
          });
        }, 1000);

        const closeTimer = setTimeout(() => {
          if (!isUndone) {
            onClose();
          }
        }, undoTimer);

        return () => {
          clearInterval(countdownInterval);
          clearTimeout(closeTimer);
        };
      } else if (timer) {
        // 普通定时关闭
        const closeTimer = setTimeout(() => {
          onClose();
        }, timer);
        return () => clearTimeout(closeTimer);
      }
    } else {
      setIsVisible(false);
    }
  }, [isOpen, timer, showUndo, undoTimer, onClose, isUndone]);

  const handleUndo = () => {
    setIsUndone(true);
    if (onUndo) {
      onUndo();
    }
    onClose();
  };

  if (!isOpen) return null;

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle className='w-8 h-8 text-green-500' />;
      case 'error':
        return <AlertCircle className='w-8 h-8 text-red-500' />;
      case 'warning':
        return <AlertTriangle className='w-8 h-8 text-yellow-500' />;
      default:
        return null;
    }
  };

  const getBgColor = () => {
    switch (type) {
      case 'success':
        return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800';
      case 'error':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
      case 'warning':
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
      default:
        return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800';
    }
  };

  return createPortal(
    <div
      className={`fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
    >
      <div
        className={`bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full border ${getBgColor()} transition-all duration-200 ${isVisible ? 'scale-100' : 'scale-95'}`}
      >
        <div className='p-6 text-center'>
          <div className='flex justify-center mb-4'>{getIcon()}</div>

          <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2'>
            {title}
          </h3>

          {message && (
            <p className='text-gray-600 dark:text-gray-400 mb-4'>{message}</p>
          )}

          {/* 撤销按钮和倒计时 */}
          {showUndo && countdown > 0 && (
            <div className='space-y-3'>
              <div className='flex items-center justify-center gap-2 text-sm text-gray-600 dark:text-gray-400'>
                <span>将在 {countdown} 秒后执行</span>
              </div>
              <div className='flex gap-2 justify-center'>
                <button
                  onClick={handleUndo}
                  className={`px-4 py-2 text-sm font-medium ${buttonStyles.warning}`}
                >
                  撤销
                </button>
                <button
                  onClick={onClose}
                  className={`px-4 py-2 text-sm font-medium ${buttonStyles.secondary}`}
                >
                  关闭
                </button>
              </div>
            </div>
          )}

          {/* 普通确认按钮 */}
          {showConfirm && !showUndo && (
            <button
              onClick={onClose}
              className={`px-4 py-2 text-sm font-medium ${buttonStyles.primary}`}
            >
              确定
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export const useAlertModal = () => {
  const [alertModal, setAlertModal] = useState<{
    isOpen: boolean;
    type: 'success' | 'error' | 'warning';
    title: string;
    message?: string;
    timer?: number;
    showConfirm?: boolean;
    showUndo?: boolean;
    onUndo?: () => void;
    undoTimer?: number;
  }>({
    isOpen: false,
    type: 'success',
    title: '',
  });

  const showAlert = (config: Omit<typeof alertModal, 'isOpen'>) => {
    setAlertModal({ ...config, isOpen: true });
  };

  const hideAlert = () => {
    setAlertModal((prev) => ({ ...prev, isOpen: false }));
  };

  return { alertModal, showAlert, hideAlert };
};

export const showError = (
  message: string,
  showAlert?: (config: any) => void,
) => {
  if (showAlert) {
    showAlert({ type: 'error', title: '错误', message, showConfirm: true });
  } else {
    console.error(message);
  }
};

export const showSuccess = (
  message: string,
  showAlert?: (config: any) => void,
) => {
  if (showAlert) {
    showAlert({ type: 'success', title: '成功', message, timer: 2000 });
  } else {
    console.log(message);
  }
};

export interface LoadingState {
  [key: string]: boolean;
}

export const useLoadingState = () => {
  const [loadingStates, setLoadingStates] = useState<LoadingState>({});

  const setLoading = (key: string, loading: boolean) => {
    setLoadingStates((prev) => ({ ...prev, [key]: loading }));
  };

  const isLoading = (key: string) => loadingStates[key] || false;

  const withLoading = async (
    key: string,
    operation: () => Promise<any>,
  ): Promise<any> => {
    setLoading(key, true);
    try {
      const result = await operation();
      return result;
    } finally {
      setLoading(key, false);
    }
  };

  return { loadingStates, setLoading, isLoading, withLoading };
};

export interface SiteConfig extends Pick<
  AdminConfig['SiteConfig'],
  OptionalFeature
> {
  SiteName: string;
  Announcement: string;
  SearchDownstreamMaxPage: number;
  SiteInterfaceCacheTime: number;
  DoubanProxyType: string;
  DoubanProxy: string;
  DoubanImageProxyType: string;
  DoubanImageProxy: string;
  DisableYellowFilter: boolean;
  ShowAdultContent: boolean;
  FluidSearch: boolean;
  EnableWebLive: boolean;
  EnablePuppeteer: boolean; // 豆瓣 Puppeteer 开关
  DoubanCookies?: string; // 豆瓣认证 Cookies
  // TMDB配置
  TMDBApiKey?: string;
  TMDBLanguage?: string;
  EnableTMDBActorSearch?: boolean;
  // Bangumi API 代理
  BangumiApiType?: string;
  BangumiApiProxy?: string;
  // Bangumi 图片代理
  BangumiImageProxyType?: string;
  BangumiImageProxy?: string;
}

export interface CronConfig {
  enableAutoRefresh: boolean;
  maxRecordsPerRun: number;
  onlyRefreshRecent: boolean;
  recentDays: number;
  onlyRefreshOngoing: boolean;
}

export interface DataSource {
  name: string;
  key: string;
  api: string;
  detail?: string;
  disabled?: boolean;
  from: 'config' | 'custom';
  is_adult?: boolean;
  type?: 'vod' | 'shortdrama'; // 视频源类型：vod=普通视频，shortdrama=短剧
  weight?: number; // 优先级权重：0-100，数字越大优先级越高，默认50
}

export interface LiveDataSource {
  name: string;
  key: string;
  url: string;
  ua?: string;
  epg?: string;
  isTvBox?: boolean;
  channelNumber?: number;
  disabled?: boolean;
  from: 'config' | 'custom';
}

export interface CustomCategory {
  name?: string;
  type: 'movie' | 'tv';
  query: string;
  disabled?: boolean;
  from: 'config' | 'custom';
}
