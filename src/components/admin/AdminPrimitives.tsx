'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function AdminTabs<T extends string>({
  items,
  value,
  onChange,
  label = '功能视图',
}: {
  items: readonly { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label?: string;
}) {
  return (
    <nav className='admin-tabs' aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type='button'
          className='admin-tab'
          aria-pressed={item.id === value}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined && <span>{item.count}</span>}
        </button>
      ))}
    </nav>
  );
}

export function AdminSection({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`admin-section ${className}`}>
      <div className='admin-section-header'>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      <div className='admin-section-body'>{children}</div>
    </section>
  );
}

export function AdminSaveBar({
  description,
  children,
}: {
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className='admin-save-bar'>
      <p>{description || '修改完成后保存，使配置生效。'}</p>
      <div className='admin-save-actions'>{children}</div>
    </div>
  );
}

export function AdminEmptyState({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div className='admin-empty-state'>
      {Icon && <Icon size={26} aria-hidden='true' />}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
