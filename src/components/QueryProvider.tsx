'use client';

import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { usePathname } from 'next/navigation';
import type * as React from 'react';
import { useEffect, useSyncExternalStore } from 'react';

import {
  type Favorite,
  type PlayRecord,
  type Reminder,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { getClientAccountKey, getQueryClient } from '@/lib/get-query-client';

function subscribeToAccountChanges(onChange: () => void) {
  const cookieStore = (window as Window & { cookieStore?: EventTarget })
    .cookieStore;
  window.addEventListener('focus', onChange);
  window.addEventListener('pageshow', onChange);
  window.addEventListener('storage', onChange);
  window.addEventListener('userAccountChanged', onChange);
  document.addEventListener('visibilitychange', onChange);
  cookieStore?.addEventListener('change', onChange);
  // Cookie Store is not available in every browser; cover changes in another tab.
  const interval = setInterval(onChange, 1000);
  return () => {
    clearInterval(interval);
    window.removeEventListener('focus', onChange);
    window.removeEventListener('pageshow', onChange);
    window.removeEventListener('storage', onChange);
    window.removeEventListener('userAccountChanged', onChange);
    document.removeEventListener('visibilitychange', onChange);
    cookieStore?.removeEventListener('change', onChange);
  };
}

const getServerAccountKey = () => null;

/**
 * Storage events carry complete records; publish them once to the shared cache.
 */
function GlobalCacheInvalidator({ accountKey }: { accountKey: string | null }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (getClientAccountKey() !== accountKey) return;
    // 设置全局 queryClient 实例供 db.client.ts 使用
    if (typeof window !== 'undefined') {
      (window as any).__queryClient = queryClient;
      (window as any).__queryClientAccountKey = accountKey;
    }

    const unsubscribePlayRecords = subscribeToDataUpdates<
      Record<string, PlayRecord>
    >('playRecordsUpdated', (records) => {
      if (getClientAccountKey() !== accountKey) return;
      queryClient.setQueryData(['playRecords'], records);
    });

    const unsubscribeFavorites = subscribeToDataUpdates<
      Record<string, Favorite>
    >('favoritesUpdated', (favorites) => {
      if (getClientAccountKey() !== accountKey) return;
      queryClient.setQueryData(['favorites'], favorites);
    });

    const unsubscribeReminders = subscribeToDataUpdates<
      Record<string, Reminder>
    >('remindersUpdated', (reminders) => {
      if (getClientAccountKey() !== accountKey) return;
      queryClient.setQueryData(['reminders'], reminders);
    });

    return () => {
      unsubscribePlayRecords();
      unsubscribeFavorites();
      unsubscribeReminders();
      if ((window as any).__queryClient === queryClient) {
        delete (window as any).__queryClient;
        delete (window as any).__queryClientAccountKey;
      }
    };
  }, [accountKey, queryClient]);

  return null;
}

/**
 * QueryProvider - TanStack Query 全局状态管理提供者
 *
 * 功能：
 * - 为整个应用提供 QueryClient 实例
 * - 启用 React Query DevTools（仅开发环境）
 * - 管理全局数据缓存和请求状态
 * - 全局监听数据更新事件，统一更新缓存
 *
 * 使用场景：
 * - 在 layout.tsx 中包裹 children
 * - 所有子组件都可以使用 useQuery/useMutation hooks
 */
export default function QueryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Client navigation after login must recheck the cookie before rendering queries.
  usePathname();
  const accountKey = useSyncExternalStore(
    subscribeToAccountChanges,
    getClientAccountKey,
    getServerAccountKey,
  );
  // 获取 QueryClient 实例（浏览器端单例，服务端每次新建）
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider key={accountKey || 'anonymous'} client={queryClient}>
      <GlobalCacheInvalidator accountKey={accountKey} />
      {children}
      {/* 开发工具入口避开移动端底部导航。 */}
      {process.env.NODE_ENV === 'development' && (
        <div className='fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-3 z-40 md:bottom-3'>
          <ReactQueryDevtools initialIsOpen={false} buttonPosition='relative' />
        </div>
      )}
    </QueryClientProvider>
  );
}
