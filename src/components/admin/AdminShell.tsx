'use client';

import {
  ChevronRight,
  ExternalLink,
  Menu,
  Moon,
  Search,
  Sun,
  Tv,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { getAuthInfoFromBrowserCookie } from '@/lib/auth';
import { CURRENT_VERSION } from '@/lib/version';

import { useSite } from '@/components/SiteProvider';

import type {
  AdminNavigationItem,
  AdminRole,
  AdminSectionId,
} from './admin-navigation';
import {
  ADMIN_OVERVIEW,
  getAdminNavigation,
  getAdminSectionHref,
} from './admin-navigation';

export default function AdminShell({
  active,
  role,
  onNavigate,
  children,
}: {
  active: AdminNavigationItem;
  role: AdminRole | null;
  onNavigate: (id: AdminSectionId) => void;
  children: ReactNode;
}) {
  const { siteName } = useSite();
  const { resolvedTheme, setTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [username, setUsername] = useState('');
  const [mounted, setMounted] = useState(false);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const desktopSearchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const groups = getAdminNavigation(role);
  const currentGroup = groups.find((group) =>
    group.items.some((item) => item.id === active.id),
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (item: AdminNavigationItem) =>
    `${item.label} ${item.description}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  const visibleGroups = groups
    .map((group) => ({ ...group, items: group.items.filter(matches) }))
    .filter((group) => group.items.length > 0);

  useEffect(() => {
    setMounted(true);
    setUsername(getAuthInfoFromBrowserCookie()?.username || '管理员');
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (window.matchMedia('(max-width: 767px)').matches) {
          drawerRef.current?.showModal();
          mobileSearchRef.current?.focus();
        } else {
          desktopSearchRef.current?.focus();
        }
      }
    };
    const closeDrawerOnDesktop = () => {
      if (window.matchMedia('(min-width: 768px)').matches)
        drawerRef.current?.close();
    };
    window.addEventListener('keydown', handleKey);
    window.addEventListener('resize', closeDrawerOnDesktop);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', closeDrawerOnDesktop);
    };
  }, []);

  function navigate(event: MouseEvent<HTMLAnchorElement>, id: AdminSectionId) {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    onNavigate(id);
    drawerRef.current?.close();
  }

  const navLink = (item: AdminNavigationItem) => {
    const Icon = item.icon;
    return (
      <a
        key={item.id}
        href={getAdminSectionHref(item.id)}
        className='admin-nav-link'
        aria-current={active.id === item.id ? 'page' : undefined}
        onClick={(event) => navigate(event, item.id)}
      >
        <Icon size={18} strokeWidth={1.75} aria-hidden='true' />
        <span>{item.label}</span>
        {active.id === item.id && (
          <span className='admin-nav-current' aria-hidden='true' />
        )}
      </a>
    );
  };

  const navigation = (mobile: boolean) => (
    <>
      <div className='admin-sidebar-search'>
        <Search size={16} aria-hidden='true' />
        <input
          ref={mobile ? mobileSearchRef : desktopSearchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder='搜索功能'
          aria-label='搜索后台功能'
          type='search'
        />
        {!query && <kbd>Ctrl K</kbd>}
      </div>
      <nav className='admin-sidebar-navigation' aria-label='后台功能导航'>
        {matches(ADMIN_OVERVIEW) && (
          <div className='admin-nav-overview'>{navLink(ADMIN_OVERVIEW)}</div>
        )}
        {visibleGroups.map((group) => (
          <div className='admin-nav-group' key={group.label}>
            <p>{group.label}</p>
            {group.items.map(navLink)}
          </div>
        ))}
        {!matches(ADMIN_OVERVIEW) && visibleGroups.length === 0 && (
          <div className='admin-nav-empty' role='status'>
            未找到相关功能
            <button type='button' onClick={() => setQuery('')}>
              清除搜索
            </button>
          </div>
        )}
      </nav>
      <div className='admin-sidebar-footer'>
        <span>MiaoTV</span>
        <span>v{CURRENT_VERSION}</span>
      </div>
    </>
  );

  return (
    <div className='admin-page' translate='no'>
      <a className='admin-skip-link' href='#admin-content'>
        跳至工作区
      </a>
      <header className='admin-topbar'>
        <div className='admin-topbar-brand'>
          <button
            type='button'
            className='admin-icon-button admin-mobile-menu'
            aria-label='打开后台导航'
            onClick={() => drawerRef.current?.showModal()}
          >
            <Menu size={21} />
          </button>
          <Link
            href='/admin'
            className='admin-brand'
            onClick={(event) => navigate(event, 'overview')}
          >
            <span className='admin-brand-mark'>
              <Tv size={21} strokeWidth={2} />
            </span>
            <span>{siteName}</span>
          </Link>
          <span className='admin-brand-label'>管理后台</span>
        </div>
        <div className='admin-topbar-breadcrumb' aria-hidden='true'>
          <span>{currentGroup?.label || '概览'}</span>
          <ChevronRight size={14} />
          <strong>{active.label}</strong>
        </div>
        <div className='admin-topbar-actions'>
          <Link href='/' className='admin-front-link' aria-label='返回前台'>
            <ExternalLink size={16} />
            <span>返回前台</span>
          </Link>
          <button
            type='button'
            className='admin-icon-button'
            aria-label={
              mounted && resolvedTheme === 'dark'
                ? '切换浅色主题'
                : '切换深色主题'
            }
            onClick={() =>
              setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
            }
          >
            {mounted && resolvedTheme === 'dark' ? (
              <Sun size={18} />
            ) : (
              <Moon size={18} />
            )}
          </button>
          <div
            className='admin-account'
            aria-label={`${username}，${role === 'owner' ? '站长' : '管理员'}`}
          >
            <span className='admin-avatar'>
              {username.charAt(0).toUpperCase() || 'A'}
            </span>
            <span className='admin-account-text'>
              <strong>{username || '管理员'}</strong>
              <small>{role === 'owner' ? '站长' : '管理员'}</small>
            </span>
          </div>
        </div>
      </header>
      <aside className='admin-sidebar'>{navigation(false)}</aside>
      <dialog
        ref={drawerRef}
        className='admin-navigation-dialog'
        aria-label='后台导航'
        onClick={(event) => {
          if (event.target === event.currentTarget) drawerRef.current?.close();
        }}
      >
        <div className='admin-drawer-panel'>
          <div className='admin-drawer-heading'>
            <strong>后台导航</strong>
            <button
              type='button'
              className='admin-icon-button'
              aria-label='关闭后台导航'
              onClick={() => drawerRef.current?.close()}
            >
              <X size={20} />
            </button>
          </div>
          {navigation(true)}
        </div>
      </dialog>
      <div className='admin-workspace' id='admin-content' tabIndex={-1}>
        <div className='admin-workspace-inner'>
          <div className='admin-page-heading'>
            <div>
              <h1>{active.label}</h1>
              <p>{active.description}</p>
            </div>
            <span className='admin-role-badge'>
              {role === 'owner' ? '站长工作区' : '管理员工作区'}
            </span>
          </div>
          {children}
          <footer className='admin-workspace-footer'>
            <span>{siteName} 管理后台</span>
            <span>v{CURRENT_VERSION}</span>
          </footer>
        </div>
      </div>
    </div>
  );
}
