export function getHomeTab(
  value: string | null,
): 'home' | 'favorites' | 'reminders' {
  return value === 'favorites' || value === 'reminders' ? value : 'home';
}

export function isNavigationItemActive(
  currentPath: string,
  href: string,
): boolean {
  try {
    const current = new URL(currentPath, 'https://miaotv.invalid');
    const item = new URL(href, 'https://miaotv.invalid');
    if (current.origin !== item.origin || current.pathname !== item.pathname)
      return false;
    if (item.pathname === '/') {
      return (
        getHomeTab(current.searchParams.get('tab')) ===
        getHomeTab(item.searchParams.get('tab'))
      );
    }
    for (const [key, value] of item.searchParams) {
      if (current.searchParams.get(key) !== value) return false;
    }
    return true;
  } catch {
    return false;
  }
}
