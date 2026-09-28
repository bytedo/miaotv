'use client';

import {
  Eye,
  Gauge,
  Info,
  Layers,
  MessageSquare,
  RefreshCw,
  Search,
  Shield,
  Type,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

interface DanmuSettings {
  enabled: boolean; // 启用弹幕主开关
  fontSize: number;
  speed: number;
  opacity: number;
  margin: [number | string, number | string];
  modes: Array<0 | 1 | 2>;
  antiOverlap: boolean;
  visible: boolean;
}

interface DanmuMatchInfo {
  animeTitle: string;
  episodeTitle: string;
}

/** 弹幕加载元数据 */
interface DanmuLoadMeta {
  source: 'init' | 'cache' | 'network' | 'network-retry' | 'empty' | 'error';
  loadedAt: number | null;
  count: number;
}

interface DanmuSettingsPanelProps {
  /** 是否显示面板 */
  isOpen: boolean;
  /** 关闭面板回调 */
  onClose: () => void;
  /** 当前设置 */
  settings: DanmuSettings;
  /** 更新设置回调 */
  onSettingsChange: (settings: Partial<DanmuSettings>) => void;
  /** 弹幕数量 */
  danmuCount?: number;
  /** 是否正在加载 */
  loading?: boolean;
  /** 重新加载回调，返回加载的弹幕数量 */
  onReload?: () => Promise<number>;
  /** 匹配信息（显示片名） */
  matchInfo?: DanmuMatchInfo | null;
  /** 加载元数据 */
  loadMeta?: DanmuLoadMeta;
  /** 错误信息 */
  error?: Error | null;
  /** 是否处于手动匹配覆盖状态 */
  isManualOverridden?: boolean;
  /** 打开手动匹配弹窗 */
  onManualMatch?: () => void;
  /** 清除手动匹配，恢复自动 */
  onClearManualMatch?: () => void;
}

// ============================================================================
// Animated Number Component - 数字滚动动画
// ============================================================================

const AnimatedNumber = memo(function AnimatedNumber({
  value,
}: {
  value: number;
}) {
  const [displayValue, setDisplayValue] = useState(value);
  const prevValueRef = useRef(value);

  useEffect(() => {
    if (prevValueRef.current === value) return;

    const start = prevValueRef.current;
    const end = value;
    const duration = 300;
    const startTime = Date.now();
    let animationFrame = 0;

    const animate = () => {
      const now = Date.now();
      const progress = Math.min((now - startTime) / duration, 1);

      // 使用easeOutCubic缓动
      const easeProgress = 1 - Math.pow(1 - progress, 3);
      const current = start + (end - start) * easeProgress;

      setDisplayValue(Math.round(current));
      prevValueRef.current = current;

      if (progress < 1) {
        animationFrame = requestAnimationFrame(animate);
      } else {
        prevValueRef.current = end;
      }
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [value]);

  return <>{displayValue}</>;
});

// ============================================================================
// Main Component
// ============================================================================

export const DanmuSettingsPanel = memo(function DanmuSettingsPanel({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  danmuCount = 0,
  loading = false,
  onReload,
  matchInfo,
  loadMeta,
  error,
  isManualOverridden = false,
  onManualMatch,
  onClearManualMatch,
}: DanmuSettingsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  closeRef.current = onClose;
  const [isVisible, setIsVisible] = useState(false);
  const [sliderFontSize, setSliderFontSize] = useState(settings.fontSize);
  const [sliderSpeed, setSliderSpeed] = useState(settings.speed);
  const [sliderOpacity, setSliderOpacity] = useState(settings.opacity);
  const [sliderMarginTop, setSliderMarginTop] = useState(() =>
    typeof settings.margin[0] === 'string'
      ? parseFloat(settings.margin[0])
      : settings.margin[0],
  );
  const [sliderMarginBottom, setSliderMarginBottom] = useState(() =>
    typeof settings.margin[1] === 'string'
      ? parseFloat(settings.margin[1])
      : settings.margin[1],
  );
  const [showLoadMeta, setShowLoadMeta] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  // ♿ 检测用户是否偏好减少动画
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) =>
      setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  // 处理打开动画
  useEffect(() => {
    if (isOpen) {
      // 延迟一帧以触发动画
      const frame = requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => cancelAnimationFrame(frame);
    } else {
      setIsVisible(false);
    }
  }, [isOpen]);

  // 处理设置更新
  const handleUpdate = useCallback(
    <K extends keyof DanmuSettings>(key: K, value: DanmuSettings[K]) => {
      onSettingsChange({ [key]: value });
    },
    [onSettingsChange],
  );

  // 滑块 UI 状态与底层引擎设置隔离
  // Note: use margin[0] and margin[1] as primitive deps, not settings.margin (new array ref each render)
  const marginTop = settings.margin[0];
  const marginBottom = settings.margin[1];
  useEffect(() => {
    setSliderFontSize(settings.fontSize);
    setSliderSpeed(settings.speed);
    setSliderOpacity(settings.opacity);
    setSliderMarginTop(
      typeof marginTop === 'string' ? parseFloat(marginTop) : marginTop,
    );
    setSliderMarginBottom(
      typeof marginBottom === 'string'
        ? parseFloat(marginBottom)
        : marginBottom,
    );
  }, [
    settings.fontSize,
    settings.speed,
    settings.opacity,
    marginTop,
    marginBottom,
  ]);

  const commitFontSize = useCallback(() => {
    if (sliderFontSize !== settings.fontSize) {
      handleUpdate('fontSize', sliderFontSize);
    }
  }, [handleUpdate, settings.fontSize, sliderFontSize]);

  const commitSpeed = useCallback(() => {
    if (sliderSpeed !== settings.speed) {
      handleUpdate('speed', sliderSpeed);
    }
  }, [handleUpdate, settings.speed, sliderSpeed]);

  const commitOpacity = useCallback(() => {
    if (Math.abs(sliderOpacity - settings.opacity) > 0.001) {
      handleUpdate('opacity', sliderOpacity);
    }
  }, [handleUpdate, settings.opacity, sliderOpacity]);

  const commitMarginTop = useCallback(() => {
    const rounded = Math.round(sliderMarginTop / 5) * 5;
    const topMargin = rounded === 0 ? 10 : `${rounded}%`;
    handleUpdate('margin', [topMargin, settings.margin[1]]);
  }, [handleUpdate, settings.margin, sliderMarginTop]);

  const commitMarginBottom = useCallback(() => {
    const rounded = Math.round(sliderMarginBottom / 5) * 5;
    const bottomMargin = rounded === 0 ? 10 : `${rounded}%`;
    handleUpdate('margin', [settings.margin[0], bottomMargin]);
  }, [handleUpdate, settings.margin, sliderMarginBottom]);

  // 指针或键盘焦点离开面板时关闭，避免面板遮住页面上的焦点。
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: PointerEvent | FocusEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closeRef.current();
      }
    };

    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('focusin', handleClickOutside);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('focusin', handleClickOutside);
    };
  }, [isOpen]);

  // 打开时聚焦标题，避免移动端自动弹出键盘；关闭后恢复触发位置。
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement;
    const panel = panelRef.current;
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        (document.activeElement === document.body ||
          panel?.contains(document.activeElement))
      ) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      role='dialog'
      aria-labelledby={titleId}
      className={`danmu-settings-panel fixed z-[9999] flex min-h-0 min-w-0 flex-col overflow-hidden transition-[opacity,transform,translate,scale] [&_button]:touch-manipulation [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-green-400 ${
        prefersReducedMotion
          ? 'duration-0' // 无动画模式
          : 'duration-500' // Spring模拟动画
      } ${
        isVisible
          ? 'opacity-100 scale-100 translate-y-0'
          : 'opacity-0 scale-95 translate-y-2'
      }`}
      style={{
        // 🎨 多层深度阴影（Apple风格）
        boxShadow: `
          0 2px 8px rgba(0, 0, 0, 0.1),
          0 8px 32px rgba(0, 0, 0, 0.2),
          0 16px 64px rgba(0, 0, 0, 0.15),
          0 0 0 1px rgba(255, 255, 255, 0.05)
        `,
        // 🎯 Spring动画模拟（cubic-bezier）
        transitionTimingFunction: prefersReducedMotion
          ? 'linear'
          : 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        // 🔥 背景毛玻璃 + 渐变
        background:
          'linear-gradient(135deg, rgba(0, 0, 0, 0.85) 0%, rgba(20, 20, 20, 0.9) 100%)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        borderRadius: '20px',
        border: '1px solid rgba(255, 255, 255, 0.15)',
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {/* 💎 边缘光晕效果 */}
      <div
        className='absolute inset-0 rounded-[20px] pointer-events-none'
        style={{
          background:
            'linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, transparent 50%)',
          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.1)',
        }}
      />

      {/* 头部 - 精致设计 */}
      <div className='relative shrink-0 px-4 py-2 border-b border-white/10'>
        <div
          className='absolute inset-0 opacity-50'
          style={{
            background:
              'linear-gradient(90deg, rgba(16, 185, 129, 0.05) 0%, transparent 100%)',
          }}
        />
        <div className='relative flex min-w-0 items-center gap-2'>
          <div className='p-2 rounded-xl bg-gradient-to-br from-green-500/20 to-emerald-600/20 backdrop-blur-sm'>
            <MessageSquare className='w-4 h-4 text-green-400' />
          </div>
          <div className='min-w-0 flex-1 flex flex-col'>
            <h2
              ref={titleRef}
              id={titleId}
              tabIndex={-1}
              className='font-semibold text-white text-sm tracking-wide outline-none'
            >
              弹幕设置
            </h2>
            <span className='text-[10px] text-gray-400'>Danmaku Settings</span>
          </div>
          <span
            className='shrink-0 px-2.5 py-1 rounded-full text-xs font-semibold bg-gradient-to-r from-green-500/20 to-emerald-600/20 text-green-300 border border-green-500/30 backdrop-blur-sm'
            style={{
              boxShadow: '0 0 12px rgba(16, 185, 129, 0.2)',
            }}
          >
            {loading ? '…' : `${danmuCount}`}
          </span>
          <button
            type='button'
            aria-label='关闭弹幕设置'
            onClick={onClose}
            className='flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-white/10 hover:text-white'
          >
            <X className='w-4 h-4' />
          </button>
        </div>
        <div className='relative flex flex-wrap items-center justify-end gap-1'>
          {/* 加载详情按钮 */}
          {loadMeta && (
            <button
              type='button'
              aria-label='查看弹幕加载详情'
              aria-expanded={showLoadMeta}
              onClick={() => setShowLoadMeta(!showLoadMeta)}
              className={`flex h-11 w-11 items-center justify-center hover:bg-white/10 rounded-xl transition-all duration-200 group active:scale-95 ${
                showLoadMeta ? 'bg-white/10' : ''
              }`}
              style={{
                transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
              }}
              title='查看加载详情'
            >
              <Info
                className={`w-4 h-4 transition-colors ${
                  showLoadMeta
                    ? 'text-green-400'
                    : 'text-gray-400 group-hover:text-gray-200'
                }`}
              />
            </button>
          )}
          {/* 刷新按钮 - 移到顶部 */}
          {onReload && (
            <button
              type='button'
              aria-label='重新加载弹幕'
              onClick={async () => {
                if (isReloading || loading) return;
                setIsReloading(true);
                setReloadError(null);
                try {
                  await onReload();
                } catch (err) {
                  setReloadError(
                    err instanceof Error ? err.message : '弹幕加载失败，请重试',
                  );
                } finally {
                  setIsReloading(false);
                }
              }}
              disabled={loading || isReloading}
              className='flex h-11 w-11 items-center justify-center hover:bg-white/10 rounded-xl transition-all duration-200 group active:scale-95 disabled:opacity-50'
              style={{
                transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
              }}
              title='刷新弹幕'
            >
              <RefreshCw
                className={`w-4 h-4 text-gray-400 transition-all duration-300 ${
                  loading || isReloading
                    ? 'animate-spin text-green-400'
                    : 'group-hover:text-gray-200 group-hover:rotate-180'
                }`}
              />
            </button>
          )}
          {/* 手动匹配按钮 */}
          {onManualMatch && (
            <button
              type='button'
              aria-label='手动匹配弹幕'
              onClick={onManualMatch}
              className='flex h-11 w-11 items-center justify-center hover:bg-white/10 rounded-xl transition-all duration-200 group active:scale-95'
              style={{
                transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
              }}
              title='手动匹配弹幕'
            >
              <Search
                className={`w-4 h-4 transition-colors duration-300 ${
                  isManualOverridden
                    ? 'text-amber-400'
                    : 'text-gray-400 group-hover:text-gray-200'
                }`}
              />
            </button>
          )}
        </div>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain'>
        {/* 加载元数据详情面板 */}
        {showLoadMeta && loadMeta && (
          <div
            className='px-5 py-3 border-b border-white/10'
            style={{
              background: 'rgba(0, 0, 0, 0.2)',
            }}
          >
            <div className='space-y-2 text-xs'>
              <div className='flex items-center justify-between'>
                <span className='text-gray-400'>数据来源</span>
                <span
                  className={`font-medium ${
                    loadMeta.source === 'cache'
                      ? 'text-blue-400'
                      : loadMeta.source === 'network'
                        ? 'text-green-400'
                        : loadMeta.source === 'network-retry'
                          ? 'text-yellow-400'
                          : loadMeta.source === 'error'
                            ? 'text-red-400'
                            : 'text-gray-300'
                  }`}
                >
                  {loadMeta.source === 'cache' && '📦 会话缓存'}
                  {loadMeta.source === 'network' && '🌐 网络请求'}
                  {loadMeta.source === 'network-retry' && '🔄 网络重试'}
                  {loadMeta.source === 'empty' && '📭 空结果'}
                  {loadMeta.source === 'error' && '❌ 请求失败'}
                  {loadMeta.source === 'init' && '⏳ 初始化'}
                </span>
              </div>
              <div className='flex items-center justify-between'>
                <span className='text-gray-400'>弹幕数量</span>
                <span className='text-white font-medium'>
                  {loadMeta.count} 条
                </span>
              </div>
              <div className='flex items-center justify-between'>
                <span className='text-gray-400'>加载时间</span>
                <span className='text-gray-300'>
                  {loadMeta.loadedAt
                    ? new Date(loadMeta.loadedAt).toLocaleTimeString('zh-CN', {
                        hour12: false,
                      })
                    : '尚未加载'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* 内容在短屏和横屏下独立滚动，关闭按钮始终可见。 */}
        <div className='px-4 py-4 space-y-4'>
          {/* 错误提示 */}
          {(error || reloadError) && settings.enabled && (
            <div
              className='px-3 py-2 rounded-xl backdrop-blur-sm'
              style={{
                background:
                  'linear-gradient(90deg, rgba(239, 68, 68, 0.15) 0%, rgba(185, 28, 28, 0.1) 100%)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
              }}
            >
              <p className='text-xs text-red-300 font-medium'>❌ 加载失败</p>
              <p
                role='status'
                className='text-[11px] text-red-400/70 mt-0.5 break-words'
              >
                {error?.message || reloadError}
              </p>
            </div>
          )}

          {/* 匹配信息标签 - 显示片名（只要有matchInfo就显示，不要求danmuCount>0） */}
          {matchInfo && settings.enabled && !error && (
            <div
              className='px-3 py-2 rounded-xl backdrop-blur-sm'
              style={{
                background:
                  'linear-gradient(90deg, rgba(16, 185, 129, 0.15) 0%, rgba(5, 150, 105, 0.1) 100%)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
              }}
            >
              <p
                className='text-xs text-green-300 font-medium whitespace-nowrap overflow-hidden text-ellipsis'
                title={`${matchInfo.animeTitle} - ${matchInfo.episodeTitle}`}
              >
                ✨ {matchInfo.animeTitle}
              </p>
              <p className='text-[11px] text-green-400/70 mt-0.5 truncate'>
                {matchInfo.episodeTitle}
              </p>
            </div>
          )}

          {/* 手动匹配覆盖指示器 */}
          {isManualOverridden && settings.enabled && (
            <div
              className='px-3 py-2 rounded-xl backdrop-blur-sm flex items-center justify-between gap-2'
              style={{
                background:
                  'linear-gradient(90deg, rgba(245, 158, 11, 0.15) 0%, rgba(217, 119, 6, 0.1) 100%)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
              }}
            >
              <div className='min-w-0'>
                <p className='text-xs text-amber-300 font-medium'>
                  手动覆盖模式
                </p>
                <p className='text-[11px] text-amber-400/70 mt-0.5'>
                  当前弹幕源为手动指定
                </p>
              </div>
              {onClearManualMatch && (
                <button
                  type='button'
                  onClick={onClearManualMatch}
                  className='min-h-11 shrink-0 text-[11px] px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 transition-colors'
                >
                  恢复自动
                </button>
              )}
            </div>
          )}

          {/* 启用弹幕主开关 */}
          <div className='flex items-center justify-between py-1'>
            <span className='text-sm font-medium text-gray-200'>启用弹幕</span>
            <button
              type='button'
              role='switch'
              aria-checked={settings.enabled}
              aria-label='启用弹幕'
              onClick={() => handleUpdate('enabled', !settings.enabled)}
              className='inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full'
            >
              <span
                aria-hidden='true'
                className='relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-300'
                style={{
                  background: settings.enabled
                    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                    : '#4b5563',
                  boxShadow: settings.enabled
                    ? '0 0 16px rgba(16, 185, 129, 0.5), inset 0 1px 2px rgba(255, 255, 255, 0.2)'
                    : 'inset 0 2px 4px rgba(0, 0, 0, 0.3)',
                  transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
                }}
              >
                <span
                  className='inline-block h-4 w-4 transform rounded-full bg-white shadow-lg transition-all duration-300'
                  style={{
                    transform: settings.enabled
                      ? 'translateX(22px)'
                      : 'translateX(2px)',
                    transitionTimingFunction:
                      'cubic-bezier(0.34, 1.56, 0.64, 1)',
                  }}
                />
              </span>
            </button>
          </div>

          {/* 只有启用弹幕后才显示其他设置 */}
          {settings.enabled && (
            <>
              {/* 快捷开关行 - 并排紧凑设计 */}
              <div className='grid grid-cols-1 min-[360px]:grid-cols-2 gap-3'>
                {/* 显示开关 */}
                <button
                  type='button'
                  role='switch'
                  aria-checked={settings.visible}
                  aria-label='显示弹幕'
                  onClick={() => handleUpdate('visible', !settings.visible)}
                  className='flex min-h-11 min-w-0 items-center gap-2 px-3 py-2.5 rounded-xl transition-all duration-200 group cursor-pointer'
                  style={{
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.05)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background =
                      'rgba(255, 255, 255, 0.08)';
                    e.currentTarget.style.borderColor =
                      'rgba(255, 255, 255, 0.1)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background =
                      'rgba(255, 255, 255, 0.03)';
                    e.currentTarget.style.borderColor =
                      'rgba(255, 255, 255, 0.05)';
                  }}
                >
                  <Eye className='w-3.5 h-3.5 text-gray-400 shrink-0 transition-colors group-hover:text-gray-300' />
                  <span className='text-xs text-gray-300 font-medium'>
                    显示
                  </span>
                  <span
                    aria-hidden='true'
                    className='ml-auto relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-all duration-300 active:scale-90'
                    style={{
                      background: settings.visible
                        ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                        : '#4b5563',
                      boxShadow: settings.visible
                        ? '0 0 16px rgba(16, 185, 129, 0.4), inset 0 1px 2px rgba(255, 255, 255, 0.2)'
                        : 'inset 0 2px 4px rgba(0, 0, 0, 0.3)',
                      transitionTimingFunction:
                        'cubic-bezier(0.34, 1.56, 0.64, 1)',
                    }}
                  >
                    <span
                      className='inline-block h-4 w-4 transform rounded-full bg-white shadow-lg transition-all duration-300'
                      style={{
                        transform: settings.visible
                          ? 'translateX(18px)'
                          : 'translateX(2px)',
                        transitionTimingFunction:
                          'cubic-bezier(0.34, 1.56, 0.64, 1)',
                      }}
                    />
                  </span>
                </button>

                {/* 防重叠开关 */}
                <button
                  type='button'
                  role='switch'
                  aria-checked={settings.antiOverlap}
                  aria-label='防止弹幕重叠'
                  onClick={() =>
                    handleUpdate('antiOverlap', !settings.antiOverlap)
                  }
                  className='flex min-h-11 min-w-0 items-center gap-2 px-3 py-2.5 rounded-xl transition-all duration-200 group cursor-pointer'
                  style={{
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.05)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background =
                      'rgba(255, 255, 255, 0.08)';
                    e.currentTarget.style.borderColor =
                      'rgba(255, 255, 255, 0.1)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background =
                      'rgba(255, 255, 255, 0.03)';
                    e.currentTarget.style.borderColor =
                      'rgba(255, 255, 255, 0.05)';
                  }}
                >
                  <Shield className='w-3.5 h-3.5 text-gray-400 shrink-0 transition-colors group-hover:text-gray-300' />
                  <span className='text-xs text-gray-300 font-medium'>
                    防重叠
                  </span>
                  <span
                    aria-hidden='true'
                    className='ml-auto relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-all duration-300 active:scale-90'
                    style={{
                      background: settings.antiOverlap
                        ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                        : '#4b5563',
                      boxShadow: settings.antiOverlap
                        ? '0 0 16px rgba(16, 185, 129, 0.4), inset 0 1px 2px rgba(255, 255, 255, 0.2)'
                        : 'inset 0 2px 4px rgba(0, 0, 0, 0.3)',
                      transitionTimingFunction:
                        'cubic-bezier(0.34, 1.56, 0.64, 1)',
                    }}
                  >
                    <span
                      className='inline-block h-4 w-4 transform rounded-full bg-white shadow-lg transition-all duration-300'
                      style={{
                        transform: settings.antiOverlap
                          ? 'translateX(18px)'
                          : 'translateX(2px)',
                        transitionTimingFunction:
                          'cubic-bezier(0.34, 1.56, 0.64, 1)',
                      }}
                    />
                  </span>
                </button>
              </div>

              {/* 滑块设置 - 渐变轨道 */}
              <div className='space-y-3.5'>
                {/* 字号 */}
                <div className='flex items-center gap-3'>
                  <div className='flex items-center gap-1.5 text-xs text-gray-300 w-16 shrink-0'>
                    <Type className='w-3.5 h-3.5 text-gray-400' />
                    <span className='font-medium'>字号</span>
                  </div>
                  <div className='relative min-w-0 flex-1'>
                    <input
                      type='range'
                      aria-label='弹幕字号'
                      min={12}
                      max={48}
                      step={1}
                      value={sliderFontSize}
                      onChange={(e) =>
                        setSliderFontSize(parseFloat(e.target.value))
                      }
                      onPointerUp={commitFontSize}
                      onKeyUp={commitFontSize}
                      onBlur={commitFontSize}
                      className='w-full h-2 rounded-full appearance-none cursor-pointer transition-all'
                      style={{
                        background: `linear-gradient(to right, #10b981 0%, #10b981 ${((sliderFontSize - 12) / (48 - 12)) * 100}%, rgba(75, 85, 99, 0.5) ${((sliderFontSize - 12) / (48 - 12)) * 100}%, rgba(75, 85, 99, 0.5) 100%)`,
                      }}
                    />
                  </div>
                  <span className='text-xs text-green-400 w-12 text-right font-mono font-semibold tabular-nums'>
                    <AnimatedNumber value={sliderFontSize} />
                  </span>
                </div>

                {/* 速度 */}
                <div className='flex items-center gap-3'>
                  <div className='flex items-center gap-1.5 text-xs text-gray-300 w-16 shrink-0'>
                    <Gauge className='w-3.5 h-3.5 text-gray-400' />
                    <span className='font-medium'>速度</span>
                  </div>
                  <div className='relative min-w-0 flex-1'>
                    <input
                      type='range'
                      aria-label='弹幕速度'
                      min={1}
                      max={10}
                      step={1}
                      value={sliderSpeed}
                      onChange={(e) =>
                        setSliderSpeed(parseFloat(e.target.value))
                      }
                      onPointerUp={commitSpeed}
                      onKeyUp={commitSpeed}
                      onBlur={commitSpeed}
                      className='w-full h-2 rounded-full appearance-none cursor-pointer transition-all'
                      style={{
                        background: `linear-gradient(to right, #10b981 0%, #10b981 ${((sliderSpeed - 1) / (10 - 1)) * 100}%, rgba(75, 85, 99, 0.5) ${((sliderSpeed - 1) / (10 - 1)) * 100}%, rgba(75, 85, 99, 0.5) 100%)`,
                      }}
                    />
                  </div>
                  <span className='text-xs text-green-400 w-12 text-right font-mono font-semibold tabular-nums'>
                    <AnimatedNumber value={sliderSpeed} />
                  </span>
                </div>

                {/* 透明度 */}
                <div className='flex items-center gap-3'>
                  <div className='flex items-center gap-1.5 text-xs text-gray-300 w-16 shrink-0'>
                    <Eye className='w-3.5 h-3.5 text-gray-400' />
                    <span className='font-medium'>透明</span>
                  </div>
                  <div className='relative min-w-0 flex-1'>
                    <input
                      type='range'
                      aria-label='弹幕透明度'
                      min={0.1}
                      max={1}
                      step={0.1}
                      value={sliderOpacity}
                      onChange={(e) =>
                        setSliderOpacity(parseFloat(e.target.value))
                      }
                      onPointerUp={commitOpacity}
                      onKeyUp={commitOpacity}
                      onBlur={commitOpacity}
                      className='w-full h-2 rounded-full appearance-none cursor-pointer transition-all'
                      style={{
                        background: `linear-gradient(to right, #10b981 0%, #10b981 ${((sliderOpacity - 0.1) / (1 - 0.1)) * 100}%, rgba(75, 85, 99, 0.5) ${((sliderOpacity - 0.1) / (1 - 0.1)) * 100}%, rgba(75, 85, 99, 0.5) 100%)`,
                      }}
                    />
                  </div>
                  <span className='text-xs text-green-400 w-12 text-right font-mono font-semibold tabular-nums'>
                    {(sliderOpacity * 100).toFixed(0)}%
                  </span>
                </div>

                {/* 上边距 - LunaTV独有功能！ */}
                <div className='flex items-center gap-3'>
                  <div className='flex items-center gap-1.5 text-xs text-gray-300 w-16 shrink-0'>
                    <svg
                      className='w-3.5 h-3.5 text-gray-400'
                      viewBox='0 0 24 24'
                      fill='none'
                      stroke='currentColor'
                    >
                      <path
                        d='M4 4h16M4 8h16'
                        strokeWidth='2'
                        strokeLinecap='round'
                      />
                      <path
                        d='M12 12v8'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeDasharray='2 2'
                      />
                    </svg>
                    <span className='font-medium'>上距</span>
                  </div>
                  <div className='relative min-w-0 flex-1'>
                    <input
                      type='range'
                      aria-label='弹幕上边距'
                      min={0}
                      max={100}
                      step={5}
                      value={sliderMarginTop}
                      onChange={(e) =>
                        setSliderMarginTop(parseFloat(e.target.value))
                      }
                      onPointerUp={commitMarginTop}
                      onKeyUp={commitMarginTop}
                      onBlur={commitMarginTop}
                      className='w-full h-2 rounded-full appearance-none cursor-pointer transition-all'
                      style={{
                        background: `linear-gradient(to right, #10b981 0%, #10b981 ${sliderMarginTop}%, rgba(75, 85, 99, 0.5) ${sliderMarginTop}%, rgba(75, 85, 99, 0.5) 100%)`,
                      }}
                    />
                  </div>
                  <span className='text-xs text-green-400 w-12 text-right font-mono font-semibold tabular-nums'>
                    {sliderMarginTop === 0 ? '无' : `${sliderMarginTop}%`}
                  </span>
                </div>

                {/* 下边距 - LunaTV独有功能！ */}
                <div className='flex items-center gap-3'>
                  <div className='flex items-center gap-1.5 text-xs text-gray-300 w-16 shrink-0'>
                    <svg
                      className='w-3.5 h-3.5 text-gray-400'
                      viewBox='0 0 24 24'
                      fill='none'
                      stroke='currentColor'
                    >
                      <path
                        d='M4 20h16M4 16h16'
                        strokeWidth='2'
                        strokeLinecap='round'
                      />
                      <path
                        d='M12 4v8'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeDasharray='2 2'
                      />
                    </svg>
                    <span className='font-medium'>下距</span>
                  </div>
                  <div className='relative min-w-0 flex-1'>
                    <input
                      type='range'
                      aria-label='弹幕下边距'
                      min={0}
                      max={100}
                      step={5}
                      value={sliderMarginBottom}
                      onChange={(e) =>
                        setSliderMarginBottom(parseFloat(e.target.value))
                      }
                      onPointerUp={commitMarginBottom}
                      onKeyUp={commitMarginBottom}
                      onBlur={commitMarginBottom}
                      className='w-full h-2 rounded-full appearance-none cursor-pointer transition-all'
                      style={{
                        background: `linear-gradient(to right, #10b981 0%, #10b981 ${sliderMarginBottom}%, rgba(75, 85, 99, 0.5) ${sliderMarginBottom}%, rgba(75, 85, 99, 0.5) 100%)`,
                      }}
                    />
                  </div>
                  <span className='text-xs text-green-400 w-12 text-right font-mono font-semibold tabular-nums'>
                    {sliderMarginBottom === 0 ? '无' : `${sliderMarginBottom}%`}
                  </span>
                </div>
              </div>

              {/* 弹幕类型 - 3D卡片效果 */}
              <div>
                <div className='flex items-center gap-1.5 text-xs text-gray-300 mb-3'>
                  <Layers className='w-3.5 h-3.5 text-gray-400' />
                  <span className='font-medium'>弹幕类型</span>
                </div>
                <div className='grid grid-cols-3 gap-2'>
                  {[
                    { value: 0 as const, label: '滚动', icon: '→' },
                    { value: 1 as const, label: '顶部', icon: '↑' },
                    { value: 2 as const, label: '底部', icon: '↓' },
                  ].map((option) => (
                    <button
                      type='button'
                      key={option.value}
                      aria-pressed={settings.modes.includes(option.value)}
                      onClick={() => {
                        const modes = settings.modes.includes(option.value)
                          ? settings.modes.length > 1
                            ? settings.modes.filter((m) => m !== option.value)
                            : settings.modes
                          : [...settings.modes, option.value];
                        handleUpdate('modes', modes as Array<0 | 1 | 2>);
                      }}
                      className='relative min-h-11 py-2 px-2 rounded-xl text-xs font-semibold transition-all duration-300 active:scale-95 overflow-hidden group'
                      style={{
                        background: settings.modes.includes(option.value)
                          ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                          : 'rgba(255, 255, 255, 0.03)',
                        border: settings.modes.includes(option.value)
                          ? '1px solid rgba(16, 185, 129, 0.5)'
                          : '1px solid rgba(255, 255, 255, 0.05)',
                        boxShadow: settings.modes.includes(option.value)
                          ? '0 4px 16px rgba(16, 185, 129, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2)'
                          : 'none',
                        color: settings.modes.includes(option.value)
                          ? '#fff'
                          : '#9ca3af',
                        transitionTimingFunction:
                          'cubic-bezier(0.34, 1.56, 0.64, 1)',
                      }}
                    >
                      <div className='flex flex-col items-center gap-0.5'>
                        <span className='text-base'>{option.icon}</span>
                        <span>{option.label}</span>
                      </div>
                      {settings.modes.includes(option.value) && (
                        <div
                          className='absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300'
                          style={{
                            background:
                              'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, transparent 100%)',
                          }}
                        />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 底部装饰条 */}
      <div
        className='h-1 shrink-0'
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, #10b981 50%, transparent 100%)',
          opacity: 0.3,
        }}
      />

      {/* CSS样式 - 自定义滑块样式 */}
      <style jsx>{`
        .danmu-settings-panel {
          left: max(12px, env(safe-area-inset-left));
          right: max(12px, env(safe-area-inset-right));
          bottom: max(12px, env(safe-area-inset-bottom));
          max-height: calc(
            100dvh - max(12px, env(safe-area-inset-top)) - max(
                12px,
                env(safe-area-inset-bottom)
              )
          );
        }

        @media (min-width: 640px) {
          .danmu-settings-panel {
            left: auto;
            right: max(16px, env(safe-area-inset-right));
            width: 352px;
          }
        }

        @media (min-width: 1024px) and (min-height: 640px) {
          .danmu-settings-panel {
            bottom: max(80px, env(safe-area-inset-bottom));
            max-height: calc(
              100dvh -
                96px - env(safe-area-inset-top) - env(safe-area-inset-bottom)
            );
          }
        }

        input[type='range'] {
          height: 44px;
          background-size: 100% 6px !important;
          background-position: center !important;
          background-repeat: no-repeat !important;
          touch-action: none;
        }

        input[type='range']:focus-visible {
          outline: 2px solid #4ade80;
          outline-offset: 2px;
        }

        input[type='range']::-webkit-slider-thumb {
          appearance: none;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          cursor: pointer;
          box-shadow:
            0 2px 8px rgba(16, 185, 129, 0.5),
            0 0 0 2px rgba(255, 255, 255, 0.1);
          transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        input[type='range']::-webkit-slider-thumb:hover {
          transform: scale(1.2);
          box-shadow:
            0 4px 16px rgba(16, 185, 129, 0.6),
            0 0 0 3px rgba(255, 255, 255, 0.15);
        }

        input[type='range']::-webkit-slider-thumb:active {
          transform: scale(1.1);
        }

        input[type='range']::-moz-range-thumb {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          cursor: pointer;
          border: none;
          box-shadow:
            0 2px 8px rgba(16, 185, 129, 0.5),
            0 0 0 2px rgba(255, 255, 255, 0.1);
          transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        input[type='range']::-moz-range-thumb:hover {
          transform: scale(1.2);
          box-shadow:
            0 4px 16px rgba(16, 185, 129, 0.6),
            0 0 0 3px rgba(255, 255, 255, 0.15);
        }

        /* 尊重用户的减少动画偏好 */
        @media (prefers-reduced-motion: reduce) {
          * {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
      `}</style>
    </div>
  );
});

export default DanmuSettingsPanel;
