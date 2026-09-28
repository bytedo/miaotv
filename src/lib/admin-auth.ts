import { NextRequest } from 'next/server';

import { getAccountAccessError } from '@/lib/account-policy';
import { AdminConfig } from '@/lib/admin.types';
import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

export type AdminRole = 'owner' | 'admin';

async function resolveRoleFromConfig(
  config: AdminConfig,
  username: string,
  uid?: string,
): Promise<AdminRole | null> {
  if (username === process.env.USERNAME) {
    return 'owner';
  }

  const user = config.UserConfig.Users.find((u) =>
    uid && u.uid ? u.uid === uid : u.username === username,
  );
  if (
    !user ||
    user.role !== 'admin' ||
    !(await db.checkUserExist(uid || username))
  ) {
    return null;
  }

  const storedUser = await db.getUserInfoV2(uid || username);
  return getAccountAccessError(user, storedUser) ? null : 'admin';
}

export async function getAdminRoleFromRequest(
  request: NextRequest,
): Promise<AdminRole | null> {
  const authInfo = await getVerifiedAuthInfo(request);
  if (!authInfo) {
    return null;
  }

  const username = authInfo.username;
  if (!username) {
    return null;
  }

  if (username === process.env.USERNAME) {
    return 'owner';
  }

  const config = await getConfig();
  return resolveRoleFromConfig(config, username, authInfo.uid);
}

export async function ensureAdmin(request: NextRequest): Promise<AdminRole> {
  const role = await getAdminRoleFromRequest(request);
  if (!role) {
    throw new Error('UNAUTHORIZED');
  }
  return role;
}
