'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type MouseEvent, type ReactNode, useTransition } from 'react';

interface FastLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  /**
   * Force a full page refresh instead of SPA navigation.
   * Useful for pages that need to bypass React's rendering pipeline.
   */
  forceRefresh?: boolean;
  /**
   * Keep navigation interruptible and show feedback while the route is loading.
   */
  useTransitionNav?: boolean;
  /**
   * Additional onClick handler
   */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Accessibility label
   */
  'aria-label'?: string;
  'aria-current'?: 'page';
  /**
   * Target attribute for opening in new tab
   */
  target?: string;
  /**
   * Rel attribute for security when using target="_blank"
   */
  rel?: string;
}

/**
 * FastLink - High-performance navigation component
 *
 * Supports three navigation modes:
 * 1. Default: SPA navigation with prefetch disabled
 * 2. forceRefresh: Hard browser navigation bypassing React
 * 3. useTransitionNav: Non-blocking navigation with pending feedback
 */
export function FastLink({
  href,
  children,
  className,
  forceRefresh = false,
  useTransitionNav = false,
  onClick,
  'aria-label': ariaLabel,
  'aria-current': ariaCurrent,
  target,
  rel,
}: FastLinkProps) {
  const router = useRouter();
  const [isPending, startNavigation] = useTransition();

  // Handle click events
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Call custom onClick handler if provided
    onClick?.(e);
    if (e.defaultPrevented) return;

    // Respect modifier keys for opening in new tabs
    const isModifiedClick =
      e.button > 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      (target && target !== '_self');

    if (isModifiedClick) {
      // Let the browser handle modified clicks naturally
      return;
    }

    // External links - let browser handle naturally
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) {
      return;
    }

    // Prevent default navigation
    e.preventDefault();

    // Mode 1: Force refresh - bypass React entirely
    if (forceRefresh) {
      window.location.assign(href);
      return;
    }

    // Mode 2: Transition navigation - non-blocking
    if (useTransitionNav) {
      startNavigation(() => {
        router.push(href);
      });
      return;
    }

    // Mode 3: Default - standard Next.js navigation
    router.push(href);
  };

  return (
    <Link
      href={href}
      onClick={handleClick}
      className={
        isPending
          ? `${className ?? ''} relative cursor-progress opacity-70`
          : className
      }
      prefetch={false}
      aria-label={ariaLabel}
      aria-current={ariaCurrent}
      aria-busy={isPending || undefined}
      target={target}
      rel={target === '_blank' ? rel || 'noopener noreferrer' : rel}
    >
      {children}
      {isPending && (
        <>
          <span
            aria-hidden='true'
            className='pointer-events-none absolute right-1 top-1 h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none'
          />
          <span role='status' className='sr-only'>
            正在打开…
          </span>
        </>
      )}
    </Link>
  );
}
