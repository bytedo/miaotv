'use client';

import { Heart } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import ModernNav from './ModernNav';
import { NavigationLayoutContext } from './NavigationLayoutContext';
import { useSite } from './SiteProvider';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

// 不需要导航栏的独立路由
const STANDALONE_ROUTES = [
  '/admin',
  '/login',
  '/register',
  '/oidc-register',
  '/forgot-password',
  '/reset-password',
  '/warning',
  '/source-test',
];

export function isStandaloneRoute(pathname: string) {
  return STANDALONE_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

function ModernNavigation() {
  const { siteName } = useSite();

  return (
    <>
      {/* Modern Navigation - Top (Desktop) & Bottom (Mobile) */}
      <ModernNav />

      {/* 移动端头部 - Logo和用户菜单 */}
      <div
        className='md:hidden fixed left-0 right-0 z-40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md shadow-sm'
        style={{ top: 'env(safe-area-inset-top)' }}
      >
        <div className='flex items-center justify-between h-11 px-4'>
          {/* Logo */}
          <Link
            href='/'
            className='text-base font-bold bg-linear-to-r from-cyan-600 via-sky-600 to-blue-600 dark:from-cyan-400 dark:via-sky-400 dark:to-blue-400 bg-clip-text text-transparent'
          >
            {siteName}
          </Link>

          {/* 收藏夹、主题切换和用户菜单 */}
          <div className='flex items-center gap-1.5'>
            <Link
              href='/?tab=favorites'
              className='relative p-1.5 rounded-full text-gray-600 hover:text-red-500 dark:text-gray-300 dark:hover:text-red-400 transition-all duration-300 hover:scale-110 group'
              aria-label='收藏夹'
            >
              <Heart className='h-5 w-5 group-hover:scale-110 transition-transform duration-300' />
            </Link>
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </div>
    </>
  );
}

export default function NavigationShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [legacyLayout, setLegacyLayout] = useState<{
    pathname: string;
    owner: symbol;
  } | null>(null);
  const registerLegacyLayout = useCallback((route: string) => {
    const owner = Symbol('legacy-layout');
    setLegacyLayout({ pathname: route, owner });
    return () => {
      setLegacyLayout((current) => (current?.owner === owner ? null : current));
    };
  }, []);
  const navigation = useMemo(
    () => ({ registerLegacyLayout }),
    [registerLegacyLayout],
  );
  const isModern =
    !isStandaloneRoute(pathname) && legacyLayout?.pathname !== pathname;

  return (
    <NavigationLayoutContext.Provider value={navigation}>
      {isModern && <ModernNavigation />}
      {/* 固定导航占位之外，移动端留 1.5rem、桌面端留 4rem 内容间距。 */}
      <main
        className={
          isModern
            ? 'w-full min-h-screen pt-[calc(4.25rem+env(safe-area-inset-top))] md:pt-32 pb-16 md:pb-8'
            : 'w-full min-h-screen'
        }
      >
        <div
          className={
            isModern
              ? 'w-full max-w-[2560px] mx-auto px-4 sm:px-6 md:px-8 lg:px-12 xl:px-16 2xl:px-20'
              : 'contents'
          }
        >
          {children}
        </div>
      </main>
    </NavigationLayoutContext.Provider>
  );
}
