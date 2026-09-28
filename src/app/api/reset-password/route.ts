/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAccountAccessError, normalizeEmail } from '@/lib/account-policy';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  getPasswordResetCredentialVersion,
  verifyAndConsumePasswordResetToken,
} from '@/lib/password-reset-tokens';

export const runtime = 'nodejs';

// 读取存储类型环境变量，默认 localstorage
const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | 'kvrocks'
    | 'sqlite'
    | undefined) || 'localstorage';

export async function POST(req: NextRequest) {
  try {
    // localStorage 模式不支持找回密码
    if (STORAGE_TYPE === 'localstorage') {
      return NextResponse.json(
        { error: 'localStorage 模式不支持找回密码' },
        { status: 400 },
      );
    }

    const { token, password } = await req.json();

    // 验证参数
    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: '无效的重置链接' }, { status: 400 });
    }

    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: '请输入新密码' }, { status: 400 });
    }

    // 验证密码长度
    if (password.length < 6) {
      return NextResponse.json({ error: '密码长度至少为6位' }, { status: 400 });
    }

    console.log('[ResetPassword] 收到密码重置请求');

    // 验证并消费令牌
    const tokenData = await verifyAndConsumePasswordResetToken(token);

    if (!tokenData) {
      console.log('[ResetPassword] 令牌无效或已过期');
      return NextResponse.json(
        { error: '重置链接无效或已过期，请重新申请' },
        { status: 400 },
      );
    }

    // 检查用户是否存在
    const identity = await db.getUserIdentityByUid(tokenData.uid);
    const userExists = identity && await db.checkUserExist(identity.uid);
    if (!identity || !userExists) {
      console.log('[ResetPassword] 用户不存在');
      return NextResponse.json(
        { error: '重置链接无效或已过期，请重新申请' },
        { status: 400 },
      );
    }

    const config = await getConfig();
    const configuredUser = config.UserConfig.Users.find(
      (user) => user.uid ? user.uid === identity.uid : user.username === identity.username,
    );
    const storedUser = await db.getUserInfoV2(identity.uid);
    const accessError = getAccountAccessError(configuredUser, storedUser);
    if (accessError) {
      return NextResponse.json({ error: accessError }, { status: 403 });
    }
    const currentEmail = await db.getUserEmail(identity.uid);
    const credential = await db.getUserCredential(identity.uid);
    if (
      identity.username === process.env.USERNAME ||
      normalizeEmail(
        currentEmail || storedUser?.email || configuredUser?.email,
      ) !== normalizeEmail(tokenData.email) ||
      !credential ||
      getPasswordResetCredentialVersion(credential) !==
        tokenData.credentialVersion
    ) {
      return NextResponse.json(
        { error: '重置链接无效或已过期，请重新申请' },
        { status: 400 },
      );
    }

    // 更新密码
    await db.changePassword(identity.uid, password, {
      credential,
      email: normalizeEmail(
        currentEmail || storedUser?.email || configuredUser?.email,
      ),
    });

    console.log('[ResetPassword] 密码重置成功');

    return NextResponse.json({
      success: true,
      message: '密码重置成功，请使用新密码登录',
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'ACCOUNT_CHANGED') {
      return NextResponse.json(
        { error: '账户信息已变化，请重新申请重置链接' },
        { status: 400 },
      );
    }
    console.error('[ResetPassword] 接口异常:', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
