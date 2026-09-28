'use client';

import { usePathname } from 'next/navigation';
import { createContext, useContext, useLayoutEffect } from 'react';

export const NavigationLayoutContext = createContext<{
  registerLegacyLayout: (pathname: string) => () => void;
} | null>(null);

export function useLegacyNavigation(enabled: boolean) {
  const navigation = useContext(NavigationLayoutContext);
  const pathname = usePathname();

  useLayoutEffect(() => {
    if (!enabled || !navigation) return;
    return navigation.registerLegacyLayout(pathname);
  }, [enabled, navigation, pathname]);
}
