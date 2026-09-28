import type { AdminConfig } from './admin.types';

export async function persistAdminConfig(config: AdminConfig): Promise<void> {
  const response = await fetch('/api/admin/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || '保存第三方登录配置失败');
  }
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameConfigValue(item, right[index]))
    );
  }
  const previous = left as Record<string, unknown>;
  const next = right as Record<string, unknown>;
  const keys = Object.keys(previous);
  return (
    keys.length === Object.keys(next).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(next, key) &&
        sameConfigValue(previous[key], next[key]),
    )
  );
}

/** Keep unchanged config branches stable so unrelated saves do not reset form drafts. */
export function reconcileAdminConfig(
  current: AdminConfig | null,
  next: AdminConfig,
): AdminConfig {
  if (!current) return next;
  let changed = Object.keys(current).length !== Object.keys(next).length;
  const entries = Object.entries(next).map(([key, value]) => {
    const previous = current[key as keyof AdminConfig];
    if (sameConfigValue(previous, value)) return [key, previous];
    changed = true;
    return [key, value];
  });
  return changed
    ? (Object.fromEntries(entries) as unknown as AdminConfig)
    : current;
}
