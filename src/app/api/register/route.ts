/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import {
  AccountRegistrationError,
  createRegisteredAccount,
} from '@/lib/account-registration';
import { createSignedAuthCookie } from '@/lib/auth.server';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

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
    if (STORAGE_TYPE === 'localstorage') {
      return NextResponse.json(
        { error: 'localStorage 模式不支持用户注册' },
        { status: 400 },
      );
    }
    const config = await getConfig();
    if (config.UserConfig.AllowRegister === false) {
      return NextResponse.json(
        { error: '管理员已关闭用户注册功能' },
        { status: 403 },
      );
    }
    const body = await req.json();
    const username =
      typeof body?.username === 'string' ? body.username.trim() : '';
    const password = body?.password;
    if (!username)
      return NextResponse.json({ error: '用户名不能为空' }, { status: 400 });
    if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,20}$/.test(username)) {
      return NextResponse.json(
        { error: '用户名只能包含汉字、字母、数字和下划线，长度2-20位' },
        { status: 400 },
      );
    }
    if (typeof password !== 'string' || !password) {
      return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
    }
    if (password !== body.confirmPassword) {
      return NextResponse.json(
        { error: '两次输入的密码不一致' },
        { status: 400 },
      );
    }
    if (password.length < 6) {
      return NextResponse.json({ error: '密码长度至少6位' }, { status: 400 });
    }

    const result = await createRegisteredAccount(config, {
      username,
      password,
      email: body.email,
      source: body.source,
      inviteCode: body.inviteCode,
    });
    if (result.pending) {
      return NextResponse.json({
        ok: true,
        pending: true,
        message: '注册成功，请等待管理员审核',
      });
    }

    const response = NextResponse.json({
      ok: true,
      pending: false,
      message: '注册成功，已自动登录',
      needDelay: STORAGE_TYPE === 'upstash',
    });
    const secure =
      req.headers
        .get('x-forwarded-proto')
        ?.split(',')[0]
        .trim()
        .toLowerCase() === 'https' || req.nextUrl.protocol === 'https:';
    const identity = await db.getUserIdentityByUid(result.uid);
    if (!identity)
      throw new Error('Registered account identity is unavailable');
    response.cookies.set(
      'user_auth',
      createSignedAuthCookie(identity, { role: 'user' }),
      {
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
        sameSite: 'lax',
        httpOnly: false,
        secure,
      },
    );
    return response;
  } catch (error) {
    if (error instanceof AccountRegistrationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    console.error('注册接口异常', error);
    return NextResponse.json(
      { error: '注册失败，请稍后重试' },
      { status: 500 },
    );
  }
}
