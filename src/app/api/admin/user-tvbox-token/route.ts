import { NextRequest, NextResponse } from 'next/server';

import { getAdminRoleFromRequest } from '@/lib/admin-auth';
import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { clearConfigCache, getConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

// 生成随机 Token
function generateToken(length = 32): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// POST - 为用户生成/更新 TVBox Token 和源权限
export async function POST(request: NextRequest) {
  try {
    const authInfo = await getVerifiedAuthInfo(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { username, targetUid, tvboxEnabledSources, regenerateToken } = body;

    if (
      (!username && !targetUid) ||
      (targetUid !== undefined && (typeof targetUid !== 'string' || !targetUid))
    ) {
      return NextResponse.json(
        { error: 'User identity is required' },
        { status: 400 },
      );
    }

    // 获取当前配置
    const config = await getConfig();

    // 检查权限：只有 owner 和 admin 可以管理用户 Token
    const currentRole = await getAdminRoleFromRequest(request);
    if (!currentRole) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    // Resolve historical UUIDs before comparing the canonical configuration UID.
    // An unknown explicit UID must never fall back to the supplied username.
    const targetIdentity = targetUid ? await db.getUserIdentityByUid(targetUid) : null;
    if (targetUid && !targetIdentity) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const targetUser = config.UserConfig.Users.find((u) =>
      targetUid ? u.uid === targetIdentity?.uid : u.username === username,
    );
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // admin 不能修改 owner 和其他 admin 的配置
    const isSelf =
      authInfo.uid && targetUser.uid
        ? authInfo.uid === targetUser.uid
        : authInfo.username === targetUser.username;
    if (
      currentRole === 'admin' &&
      (targetUser.role === 'owner' || (targetUser.role === 'admin' && !isSelf))
    ) {
      return NextResponse.json(
        { error: 'Cannot modify admin or owner users' },
        { status: 403 },
      );
    }

    // 生成或保留 Token
    if (regenerateToken || !targetUser.tvboxToken) {
      targetUser.tvboxToken = generateToken();
    }

    // 更新源权限
    if (Array.isArray(tvboxEnabledSources)) {
      targetUser.tvboxEnabledSources = tvboxEnabledSources;
    }

    // 保存配置
    await db.saveAdminConfig(config);
    clearConfigCache();

    return NextResponse.json({
      success: true,
      token: targetUser.tvboxToken,
      enabledSources: targetUser.tvboxEnabledSources || [],
    });
  } catch (error) {
    console.error('Update user TVBox token failed:', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 },
    );
  }
}

// DELETE - 删除用户的 TVBox Token
export async function DELETE(request: NextRequest) {
  try {
    const authInfo = await getVerifiedAuthInfo(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const username = searchParams.get('username');
    const targetUid = searchParams.get('targetUid');

    if ((!username && !targetUid) || targetUid === '') {
      return NextResponse.json(
        { error: 'User identity is required' },
        { status: 400 },
      );
    }

    // 获取当前配置
    const config = await getConfig();

    // 检查权限
    const currentRole = await getAdminRoleFromRequest(request);
    if (!currentRole) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    // Resolve historical UUIDs before comparing the canonical configuration UID.
    // An unknown explicit UID must never fall back to the supplied username.
    const targetIdentity = targetUid ? await db.getUserIdentityByUid(targetUid) : null;
    if (targetUid && !targetIdentity) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const targetUser = config.UserConfig.Users.find((u) =>
      targetUid ? u.uid === targetIdentity?.uid : u.username === username,
    );
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // admin 不能修改 owner 和其他 admin 的配置
    const isSelf =
      authInfo.uid && targetUser.uid
        ? authInfo.uid === targetUser.uid
        : authInfo.username === targetUser.username;
    if (
      currentRole === 'admin' &&
      (targetUser.role === 'owner' || (targetUser.role === 'admin' && !isSelf))
    ) {
      return NextResponse.json(
        { error: 'Cannot modify admin or owner users' },
        { status: 403 },
      );
    }

    // 删除 Token 和源权限
    delete targetUser.tvboxToken;
    delete targetUser.tvboxEnabledSources;

    // 保存配置
    await db.saveAdminConfig(config);
    clearConfigCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete user TVBox token failed:', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 },
    );
  }
}
