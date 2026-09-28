'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  Cat,
  Clover,
  Film,
  FolderOpen,
  Heart,
  Home,
  MoreHorizontal,
  PlaySquare,
  Radio,
  Search,
  Star,
  Tv,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { isNavigationItemActive } from '@/lib/navigation';
import {
  embyConfigQueryOptions,
  publicEmbySourcesQueryOptions,
} from '@/hooks/useUserMenuQueries';
import { useWebLiveEnabled } from '@/hooks/useWebLiveEnabled';

import { FastLink } from './FastLink';
import { useSite } from './SiteProvider';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

interface NavItem {
  icon: any;
  label: string;
  href: string;
  color: string;
  gradient: string;
}

interface ModernNavProps {
  showAIButton?: boolean;
  onAIButtonClick?: () => void;
}

export default function ModernNav({
  showAIButton = false,
  onAIButtonClick,
}: ModernNavProps = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const active = queryString ? `${pathname}?${queryString}` : pathname;
  const { siteName } = useSite();
  const webLiveEnabled = useWebLiveEnabled();
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<any>(null);
  useEffect(() => {
    setRuntimeConfig((window as any).RUNTIME_CONFIG || {});
  }, []);

  const baseMenuItems: NavItem[] = [
    {
      icon: Home,
      label: '首页',
      href: '/',
      color: 'text-cyan-500',
      gradient: 'from-cyan-500 to-blue-500',
    },
    {
      icon: Search,
      label: '搜索',
      href: '/search',
      color: 'text-blue-500',
      gradient: 'from-blue-500 to-cyan-500',
    },
    {
      icon: Film,
      label: '电影',
      href: '/douban?type=movie',
      color: 'text-red-500',
      gradient: 'from-red-500 to-pink-500',
    },
    {
      icon: Tv,
      label: '剧集',
      href: '/douban?type=tv',
      color: 'text-blue-600',
      gradient: 'from-blue-600 to-indigo-600',
    },
    {
      icon: PlaySquare,
      label: '短剧',
      href: '/shortdrama',
      color: 'text-purple-500',
      gradient: 'from-purple-500 to-violet-500',
    },
    {
      icon: Cat,
      label: '动漫',
      href: '/douban?type=anime',
      color: 'text-pink-500',
      gradient: 'from-pink-500 to-rose-500',
    },
    {
      icon: Clover,
      label: '综艺',
      href: '/douban?type=show',
      color: 'text-orange-500',
      gradient: 'from-orange-500 to-amber-500',
    },
  ];

  // 检查用户是否配置了 Emby
  const embyEnabled =
    runtimeConfig?.EMBY_ENABLED === true ||
    runtimeConfig?.PRIVATE_LIBRARY_ENABLED === true;
  const { data: userEmbyConfig } = useQuery({
    ...embyConfigQueryOptions,
    enabled: embyEnabled,
  });

  // 检查管理员是否设置了公共源
  const { data: publicSourcesData } = useQuery({
    ...publicEmbySourcesQueryOptions,
    enabled: embyEnabled,
  });

  const menuItems = [...baseMenuItems];

  // 直播 - 根据 ENABLE_WEB_LIVE 动态控制
  if (webLiveEnabled) {
    menuItems.push({
      icon: Radio,
      label: '直播',
      href: '/live',
      color: 'text-teal-500',
      gradient: 'from-teal-500 to-cyan-500',
    });
  }

  if (runtimeConfig?.CUSTOM_CATEGORIES?.length > 0) {
    menuItems.push({
      icon: Star,
      label: '自定义',
      href: '/douban?type=custom',
      color: 'text-yellow-500',
      gradient: 'from-yellow-500 to-amber-500',
    });
  }

  // Emby - 用户有私人源 OR 管理员有公共源，都显示导航
  const hasUserEmby = userEmbyConfig?.sources?.some(
    (s: any) => s.enabled && s.ServerURL,
  );
  const hasPublicEmby = (publicSourcesData?.sources?.length ?? 0) > 0;
  const hasEmbyConfig = embyEnabled && (hasUserEmby || hasPublicEmby);

  if (hasEmbyConfig) {
    menuItems.push({
      icon: FolderOpen,
      label: 'Emby',
      href: '/emby',
      color: 'text-indigo-500',
      gradient: 'from-indigo-500 to-purple-500',
    });
  }

  const isActive = (href: string) => {
    return isNavigationItemActive(active, href);
  };

  return (
    <>
      {/* Desktop Top Navigation - 2025 Disney+ Style */}
      <nav className='hidden md:block fixed top-0 left-0 right-0 z-50 bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-b border-gray-200/50 dark:border-gray-700/50'>
        <div className='max-w-[2560px] mx-auto px-4 sm:px-6 md:px-8 lg:px-12 xl:px-16 2xl:px-20'>
          <div className='flex items-center justify-between h-16 gap-4'>
            {/* Logo */}
            <FastLink href='/' className='shrink-0'>
              <div className='text-xl font-bold bg-linear-to-r from-cyan-600 via-sky-600 to-blue-600 dark:from-cyan-400 dark:via-sky-400 dark:to-blue-400 bg-clip-text text-transparent'>
                {siteName}
              </div>
            </FastLink>

            {/* Navigation Items */}
            <div className='flex items-center justify-center gap-1 lg:gap-2 overflow-x-auto scrollbar-hide flex-1 px-4'>
              {menuItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);

                return (
                  <FastLink
                    key={item.label}
                    href={item.href}
                    useTransitionNav
                    aria-current={active ? 'page' : undefined}
                    className='group relative flex items-center gap-2 px-3 lg:px-4 py-2 rounded-full transition-all duration-300 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 whitespace-nowrap shrink-0'
                  >
                    {/* Active indicator */}
                    {active && (
                      <div
                        className={`absolute inset-0 bg-linear-to-r ${item.gradient} opacity-10 rounded-full animate-pulse`}
                      />
                    )}

                    {/* Icon */}
                    <div className='relative'>
                      <Icon
                        className={`w-5 h-5 transition-all duration-300 ${
                          active
                            ? item.color
                            : 'text-gray-600 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-gray-200'
                        } ${active ? 'scale-110' : 'group-hover:scale-110'}`}
                      />
                    </div>

                    {/* Label */}
                    <span
                      className={`text-sm font-medium transition-all duration-300 ${
                        active
                          ? `${item.color} font-semibold`
                          : 'text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-100'
                      }`}
                    >
                      {item.label}
                    </span>

                    {/* Bottom active border */}
                    {active && (
                      <div
                        className={`absolute bottom-0 left-0 right-0 h-0.5 bg-linear-to-r ${item.gradient} rounded-full`}
                      />
                    )}
                  </FastLink>
                );
              })}
            </div>

            {/* Right Side Actions - ✨ AI Button, ❤️ Favorites, Theme Toggle & User Menu */}
            <div className='flex items-center gap-2 shrink-0'>
              {showAIButton && onAIButtonClick && (
                <button
                  onClick={onAIButtonClick}
                  className='relative w-10 h-10 p-2 rounded-full flex items-center justify-center text-gray-600 hover:text-purple-500 dark:text-gray-300 dark:hover:text-purple-400 transition-all duration-300 hover:scale-110 hover:shadow-lg hover:shadow-purple-500/30 dark:hover:shadow-purple-400/30 group'
                  aria-label='AI 推荐'
                >
                  {/* 微光背景效果 */}
                  <div className='absolute inset-0 rounded-full bg-linear-to-br from-purple-400/0 to-purple-600/0 group-hover:from-purple-400/20 group-hover:to-purple-600/20 dark:group-hover:from-purple-300/20 dark:group-hover:to-purple-500/20 transition-all duration-300'></div>
                  <Bot className='w-full h-full relative z-10 group-hover:rotate-12 transition-transform duration-500' />
                </button>
              )}
              {/* 收藏夹入口 */}
              <Link
                href='/?tab=favorites'
                prefetch={false}
                aria-current={isActive('/?tab=favorites') ? 'page' : undefined}
                className='relative w-10 h-10 p-2 rounded-full flex items-center justify-center text-gray-600 hover:text-red-500 dark:text-gray-300 dark:hover:text-red-400 transition-all duration-300 hover:scale-110 hover:shadow-lg hover:shadow-red-500/30 dark:hover:shadow-red-400/30 group'
                aria-label='收藏夹'
              >
                {/* 微光背景效果 */}
                <div className='absolute inset-0 rounded-full bg-linear-to-br from-red-400/0 to-pink-600/0 group-hover:from-red-400/20 group-hover:to-pink-600/20 dark:group-hover:from-red-300/20 dark:group-hover:to-pink-500/20 transition-all duration-300'></div>
                <Heart className='w-full h-full relative z-10 group-hover:scale-110 transition-transform duration-300' />
              </Link>
              <ThemeToggle />
              <UserMenu />
            </div>
          </div>
        </div>
      </nav>

      {/* More Menu Modal - Render outside nav to avoid z-index issues */}
      {showMoreMenu && (
        <div
          className='md:hidden fixed inset-0 bg-black/40 backdrop-blur-sm'
          style={{ zIndex: 2147483647 }}
          onClick={() => setShowMoreMenu(false)}
        >
          <div
            className='absolute bottom-20 left-2 right-2 bg-white/90 dark:bg-gray-900/90 backdrop-blur-3xl rounded-3xl shadow-2xl border border-white/20 dark:border-gray-800/30 overflow-hidden'
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className='flex items-center justify-between px-6 py-4 border-b border-gray-200/50 dark:border-gray-700/50'>
              <h3 className='text-lg font-semibold text-gray-900 dark:text-white'>
                全部分类
              </h3>
              <button
                onClick={() => setShowMoreMenu(false)}
                className='p-2 rounded-full hover:bg-gray-200/50 dark:hover:bg-gray-700/50 transition-colors'
              >
                <X className='w-5 h-5 text-gray-600 dark:text-gray-400' />
              </button>
            </div>

            {/* All menu items in grid */}
            <div className='grid grid-cols-4 gap-4 p-4'>
              {menuItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);

                return (
                  <FastLink
                    key={item.label}
                    href={item.href}
                    useTransitionNav
                    onClick={() => {
                      setShowMoreMenu(false);
                    }}
                    aria-current={active ? 'page' : undefined}
                    className='flex flex-col items-center gap-2 p-3 rounded-2xl transition-all duration-300 active:scale-95 hover:bg-gray-100/50 dark:hover:bg-gray-800/50'
                  >
                    <div
                      className={`flex items-center justify-center w-12 h-12 rounded-2xl ${
                        active
                          ? `bg-linear-to-br ${item.gradient}`
                          : 'bg-gray-100 dark:bg-gray-800'
                      }`}
                    >
                      <Icon
                        className={`w-6 h-6 ${
                          active
                            ? 'text-white'
                            : 'text-gray-600 dark:text-gray-400'
                        }`}
                      />
                    </div>
                    <span
                      className={`text-xs font-medium ${
                        active ? item.color : 'text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {item.label}
                    </span>
                  </FastLink>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Navigation - Netflix Full-Width Style with Light Mode Support */}
      <nav
        className='md:hidden fixed left-0 right-0 z-40 bg-white/80 dark:bg-black/95 backdrop-blur-lg border-t border-black/5 dark:border-white/5 shadow-xl shadow-black/5 dark:shadow-2xl dark:shadow-black/40'
        style={{
          bottom: 0,
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <div className='flex items-center justify-around px-2 py-2'>
          {/* Show first 4 items + More button */}
          {menuItems.slice(0, 4).map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);

            return (
              <FastLink
                key={item.label}
                href={item.href}
                useTransitionNav
                aria-current={active ? 'page' : undefined}
                className='flex flex-col items-center justify-center min-w-[60px] flex-1 py-2 px-1 transition-all duration-200 active:scale-95'
              >
                <Icon
                  className={`w-6 h-6 mb-1 transition-colors duration-200 ${
                    active ? item.color : 'text-gray-600 dark:text-gray-400'
                  }`}
                />
                <span
                  className={`text-[10px] font-medium transition-colors duration-200 ${
                    active ? item.color : 'text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {item.label}
                </span>
              </FastLink>
            );
          })}

          {/* More button */}
          <button
            onClick={() => setShowMoreMenu(true)}
            className='flex flex-col items-center justify-center min-w-[60px] flex-1 py-2 px-1 transition-all duration-200 active:scale-95'
          >
            <MoreHorizontal className='w-6 h-6 mb-1 text-gray-600 dark:text-gray-400' />
            <span className='text-[10px] font-medium text-gray-600 dark:text-gray-400'>
              更多
            </span>
          </button>
        </div>
      </nav>
    </>
  );
}
