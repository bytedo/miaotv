/* eslint-disable no-console*/

import { NextRequest, NextResponse } from 'next/server';

import { getAccountAccessError } from '@/lib/account-policy';
import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { verifyPassword } from '@/lib/password';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  // 不支持 localstorage 模式
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储模式修改密码',
      },
      { status: 400 },
    );
  }

  try {
    const body = await request.json();
    const { oldPassword, newPassword } = body;

    // 获取认证信息
    const authInfo = await getVerifiedAuthInfo(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 验证旧密码
    if (!oldPassword || typeof oldPassword !== 'string') {
      return NextResponse.json({ error: '旧密码不得为空' }, { status: 400 });
    }

    // 验证新密码
    if (!newPassword || typeof newPassword !== 'string') {
      return NextResponse.json({ error: '新密码不得为空' }, { status: 400 });
    }

    if (newPassword.length < 6) {
      return NextResponse.json({ error: '新密码至少 6 位' }, { status: 400 });
    }

    if (newPassword === oldPassword) {
      return NextResponse.json(
        { error: '新密码不得与旧密码相同' },
        { status: 400 },
      );
    }

    const username = authInfo.username;

    const config = await getConfig();
    const configuredUser = config.UserConfig.Users.find(
      (user) => user.uid ? user.uid === authInfo.uid : user.username === username,
    );
    const storedUser = await db.getUserInfoV2(authInfo.uid);
    const accessError = getAccountAccessError(configuredUser, storedUser);
    if (accessError) {
      return NextResponse.json({ error: accessError }, { status: 403 });
    }

    // 不允许站长修改密码（站长用户名等于 process.env.USERNAME）
    if (username === process.env.USERNAME) {
      return NextResponse.json(
        { error: '站长不能通过此接口修改密码' },
        { status: 403 },
      );
    }

    // 校验旧密码
    const credential = await db.getUserCredential(authInfo.uid);
    const isValid =
      credential !== null && verifyPassword(oldPassword, credential);
    if (!isValid) {
      return NextResponse.json({ error: '旧密码错误' }, { status: 401 });
    }

    // 修改密码
    await db.changePassword(authInfo.uid, newPassword, { credential });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if ((error as { code?: string }).code === 'ACCOUNT_CHANGED') {
      return NextResponse.json(
        { error: '账户信息已变化，请重新验证旧密码后重试' },
        { status: 409 },
      );
    }
    console.error('修改密码失败:', error);
    return NextResponse.json(
      {
        error: '修改密码失败',
      },
      { status: 500 },
    );
  }
}
