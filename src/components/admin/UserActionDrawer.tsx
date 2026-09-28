'use client';

import { AlertCircle, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useContext, useEffect, useId, useRef } from 'react';

import './user-action-drawer.css';

import { AdminPanelVisibilityContext, createPortal } from './AdminPortal';

export interface UserActionDrawerProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  closeDisabled?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  state?: 'idle' | 'loading' | 'error' | 'success';
  statusMessage?: string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(element: HTMLElement) {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const style = window.getComputedStyle(element);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    element.getClientRects().length > 0
  );
}

function getFocusable(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled, [aria-disabled="true"]') &&
      isVisible(element),
  );
}

/** A sheet below existing admin confirmation dialogs, never a second modal layer. */
export function UserActionDrawer({
  open,
  title,
  description,
  onClose,
  children,
  header,
  footer,
  closeDisabled = false,
  returnFocusRef,
  fallbackFocusRef,
  state = 'idle',
  statusMessage,
}: UserActionDrawerProps) {
  const panelVisible = useContext(AdminPanelVisibilityContext);
  const active = open && panelVisible;
  const titleId = useId();
  const descriptionId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closingDisabled = closeDisabled || state === 'loading';
  const callbacks = useRef({
    onClose,
    closeDisabled: closingDisabled,
    returnFocusRef,
    fallbackFocusRef,
  });

  // Updating parent callbacks or user details must not reset focus in an open form.
  useEffect(() => {
    callbacks.current = {
      onClose,
      closeDisabled: closingDisabled,
      returnFocusRef,
      fallbackFocusRef,
    };
  }, [onClose, closingDisabled, returnFocusRef, fallbackFocusRef]);

  useEffect(() => {
    if (!active) return;
    const drawer = drawerRef.current;
    const overlay = overlayRef.current;
    if (!drawer || !overlay) return;

    const previousFocus =
      callbacks.current.returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const page = document.querySelector<HTMLElement>('.admin-page');
    const pageWasInert = page?.inert ?? false;
    const previousOverflowY = document.body.style.overflowY;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    if (scrollbarWidth > 0) {
      const padding = parseFloat(
        window.getComputedStyle(document.body).paddingRight,
      );
      document.body.style.paddingRight = `${padding + scrollbarWidth}px`;
    }
    document.body.style.overflowY = 'hidden';
    if (page) page.inert = true;

    let lastFocused: HTMLElement | null = null;
    let blockingOverlay: HTMLElement | null = null;

    function findBlockingOverlay() {
      // Some older admin feedback panels do not yet declare role="dialog".
      const candidates = document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], dialog[open], [data-admin-portal] > *',
      );
      let found: HTMLElement | null = null;
      for (const candidate of candidates) {
        if (
          candidate === overlay ||
          overlay.contains(candidate) ||
          candidate.contains(overlay) ||
          !isVisible(candidate)
        ) {
          continue;
        }
        const style = window.getComputedStyle(candidate);
        if (
          candidate.matches(
            '[role="dialog"], [role="alertdialog"], dialog[open]',
          ) ||
          (style.position === 'fixed' &&
            Number.parseInt(style.zIndex, 10) >= 50)
        ) {
          found = candidate;
        }
      }
      return found;
    }

    function focusInside() {
      if (lastFocused?.isConnected && isVisible(lastFocused)) {
        lastFocused.focus({ preventScroll: true });
        return;
      }
      const body = drawer.querySelector<HTMLElement>('.admin-user-drawer-body');
      const preferred = drawer.querySelector<HTMLElement>(
        '[data-drawer-autofocus]',
      );
      const target =
        (preferred && isVisible(preferred) ? preferred : null) ??
        (body ? getFocusable(body)[0] : null) ??
        drawer;
      target.focus({ preventScroll: true });
    }

    function syncLayers() {
      const next = findBlockingOverlay();
      const changed = next !== blockingOverlay;
      blockingOverlay = next;
      if (drawer.inert !== Boolean(next)) drawer.inert = Boolean(next);
      if (next) {
        if (drawer.getAttribute('aria-hidden') !== 'true') {
          drawer.setAttribute('aria-hidden', 'true');
        }
        if (changed) getFocusable(next)[0]?.focus({ preventScroll: true });
      } else {
        if (drawer.hasAttribute('aria-hidden'))
          drawer.removeAttribute('aria-hidden');
        if (changed) focusInside();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || findBlockingOverlay()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!callbacks.current.closeDisabled) callbacks.current.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable(drawer);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
        drawer.focus({ preventScroll: true });
        return;
      }
      const current = document.activeElement;
      if (
        !drawer.contains(current) ||
        current === drawer ||
        (event.shiftKey && current === first) ||
        (!event.shiftKey && current === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    }

    function handleFocusIn(event: FocusEvent) {
      if (findBlockingOverlay()) return;
      if (
        event.target instanceof HTMLElement &&
        drawer.contains(event.target)
      ) {
        lastFocused = event.target;
      } else {
        focusInside();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', handleFocusIn);
    const observer = new MutationObserver(syncLayers);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'inert'],
    });
    const frame = requestAnimationFrame(() => {
      syncLayers();
      if (!blockingOverlay) focusInside();
    });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', handleFocusIn);
      document.body.style.overflowY = previousOverflowY;
      document.body.style.paddingRight = previousPaddingRight;
      if (page) page.inert = pageWasInert;
      const focusTarget =
        previousFocus?.isConnected && isVisible(previousFocus)
          ? previousFocus
          : callbacks.current.fallbackFocusRef?.current;
      if (focusTarget?.isConnected && isVisible(focusTarget)) {
        focusTarget.focus({ preventScroll: true });
      }
    };
  }, [active]);

  if (!active || typeof document === 'undefined') return null;

  const StatusIcon =
    state === 'error'
      ? AlertCircle
      : state === 'success'
        ? CheckCircle2
        : LoaderCircle;

  return createPortal(
    <div
      ref={overlayRef}
      className='admin-user-drawer-overlay'
      role='presentation'
      onClick={(event) => {
        if (event.target === event.currentTarget && !closingDisabled) onClose();
      }}
    >
      <section
        ref={drawerRef}
        className='admin-user-drawer'
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        data-state={state}
        tabIndex={-1}
      >
        <div className='admin-user-drawer-topbar'>
          <div className='admin-user-drawer-heading'>
            <h2 id={titleId} className='admin-user-drawer-title'>
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className='admin-user-drawer-description'>
                {description}
              </p>
            )}
          </div>
          <button
            type='button'
            className='admin-user-drawer-close'
            aria-label='关闭用户操作'
            title='关闭用户操作'
            disabled={closingDisabled}
            onClick={onClose}
          >
            <X size={20} aria-hidden='true' />
          </button>
        </div>
        {header && <div className='admin-user-drawer-header'>{header}</div>}
        {state !== 'idle' && statusMessage && (
          <div
            className='admin-user-drawer-notice'
            data-state={state}
            role={state === 'error' ? 'alert' : 'status'}
          >
            <StatusIcon size={17} aria-hidden='true' />
            <span>{statusMessage}</span>
          </div>
        )}
        <div className='admin-user-drawer-body' aria-busy={state === 'loading'}>
          {children}
        </div>
        {footer && <div className='admin-user-drawer-footer'>{footer}</div>}
      </section>
    </div>,
    document.body,
  );
}

export default UserActionDrawer;
