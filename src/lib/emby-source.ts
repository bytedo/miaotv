import type { AdminConfig } from './admin.types';
import type { ProxyTargetPolicy } from './proxy-security';

export function canManageEmbySources(
  config: AdminConfig,
  username: string,
): boolean {
  return (
    Boolean(username) &&
    (username === process.env.USERNAME ||
      config.UserConfig.Users.some(
        (user) =>
          user.username === username && user.role === 'admin' && !user.banned,
      ))
  );
}

export function getEmbyTargetPolicy(
  config: AdminConfig,
  target: string,
  username: string,
): ProxyTargetPolicy {
  const origin = new URL(target).origin;
  const approved =
    canManageEmbySources(config, username) ||
    config.EmbyConfig?.Sources?.some((source) => {
      if (!source.enabled || !source.isPublic) return false;
      try {
        return new URL(source.ServerURL).origin === origin;
      } catch {
        return false;
      }
    });
  // A user's saved URL is not an administrator's private-network grant.
  return { allowedPrivateOrigins: approved ? [origin] : [] };
}
