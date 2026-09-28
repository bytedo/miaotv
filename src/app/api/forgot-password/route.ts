/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import {
  getAccountAccessError,
  isValidEmail,
  normalizeEmail,
} from '@/lib/account-policy';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { sendPasswordResetEmail } from '@/lib/emailService';
import { generatePasswordResetToken } from '@/lib/password-reset-tokens';

export const runtime = 'nodejs';

function acceptedResponse() {
  return NextResponse.json({
    success: true,
    message: '如果该邮箱已注册，您将收到一封密码重置邮件',
  });
}

export async function POST(req: NextRequest) {
  try {
    if (
      (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') ===
      'localstorage'
    ) {
      return NextResponse.json(
        { error: 'localStorage 模式不支持找回密码' },
        { status: 400 },
      );
    }

    const body = await req.json();
    const email = normalizeEmail(body?.email);
    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: '请输入有效的邮箱地址' },
        { status: 400 },
      );
    }

    const config = await getConfig();
    let username = await db.getUsernameByEmail(email);
    if (!username) {
      const matches = config.UserConfig.Users.filter(
        (user) => normalizeEmail(user.email) === email,
      );
      if (matches.length !== 1) return acceptedResponse();
      username = matches[0].username;
    }
    const identity = await db.getUserIdentity(username);
    if (
      !identity ||
      username === process.env.USERNAME ||
      !(await db.checkUserExist(identity.uid))
    ) {
      return acceptedResponse();
    }

    const configuredUser = config.UserConfig.Users.find(
      (user) => user.uid ? user.uid === identity.uid : user.username === username,
    );
    const storedUser = await db.getUserInfoV2(identity.uid);
    if (getAccountAccessError(configuredUser, storedUser))
      return acceptedResponse();

    // A stale configuration email must not restore an address the user has changed.
    const storedEmail = normalizeEmail(
      (await db.getUserEmail(identity.uid)) || storedUser?.email,
    );
    if (storedEmail && storedEmail !== email) return acceptedResponse();
    if (!storedEmail) {
      if (normalizeEmail(configuredUser?.email) !== email)
        return acceptedResponse();
      await db.setUserEmail(identity.uid, email);
    }

    const token = await generatePasswordResetToken(identity.uid, email);
    const result = await sendPasswordResetEmail(email, username, token);
    if (!result.success) {
      console.error('[ForgotPassword] 密码重置邮件发送失败');
      await db.deleteCache(`password_reset:${token}`);
    }
    return acceptedResponse();
  } catch (error) {
    console.error('[ForgotPassword] 接口异常:', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
