'use client';

import { Megaphone, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';

import styles from './AnnouncementDialog.module.css';

import MarkdownContent from './MarkdownContent';

interface AnnouncementDialogProps {
  announcement: string;
  isOpen: boolean;
  onClose: () => void;
  siteName?: string;
  preview?: boolean;
}

export default function AnnouncementDialog({
  announcement,
  isOpen,
  onClose,
  siteName,
  preview = false,
}: AnnouncementDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;

    const previousFocus = document.activeElement;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;

    // The native modal makes the page inert and keeps keyboard focus inside.
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    // Start long announcements at the heading instead of scrolling to the footer.
    titleRef.current?.focus({ preventScroll: true });

    return () => {
      dialog.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;

        const focusable = event.currentTarget.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;

        // Also wrap at the boundaries in browsers that otherwise focus their chrome.
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === titleRef.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header className={styles.header}>
        <span className={styles.icon}>
          <Megaphone size={20} aria-hidden='true' />
        </span>
        <div className={styles.heading}>
          <h2 id={titleId} ref={titleRef} tabIndex={-1}>
            {preview ? '公告预览' : '站点公告'}
          </h2>
          {siteName && <p>{siteName}</p>}
        </div>
        <button
          type='button'
          className={styles.close}
          onClick={onClose}
          aria-label={preview ? '关闭预览' : '关闭公告'}
        >
          <X size={20} aria-hidden='true' />
        </button>
      </header>

      <div
        className={styles.body}
        role='region'
        aria-label='公告内容'
        tabIndex={0}
      >
        <MarkdownContent>{announcement}</MarkdownContent>
      </div>

      <footer className={styles.footer}>
        <p>{preview ? '预览当前内容，保存后生效' : '公告更新后会再次提醒'}</p>
        <button type='button' className={styles.confirm} onClick={onClose}>
          {preview ? '关闭预览' : '我知道了'}
        </button>
      </footer>
    </dialog>
  );
}
