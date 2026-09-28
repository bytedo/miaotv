'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { createPortal as createReactPortal } from 'react-dom';

export const AdminPanelVisibilityContext = createContext(true);

function AdminPortal({
  children,
  container,
}: {
  children: ReactNode;
  container: Element | DocumentFragment;
}) {
  const visible = useContext(AdminPanelVisibilityContext);
  return createReactPortal(
    <div
      data-admin-portal=''
      aria-hidden={!visible || undefined}
      style={{ display: visible ? 'contents' : 'none' }}
    >
      {children}
    </div>,
    container,
  );
}

/** Portals follow their workspace panel while preserving dialog input on navigation. */
export function createPortal(
  children: ReactNode,
  container: Element | DocumentFragment,
  key?: string | null,
) {
  return (
    <AdminPortal key={key} container={container}>
      {children}
    </AdminPortal>
  );
}
