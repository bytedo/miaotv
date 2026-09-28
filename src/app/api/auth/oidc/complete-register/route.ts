/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import {
  AccountRegistrationError,
  createRegisteredAccount,
  findBoundOIDCAccount,
} from '@/lib/account-registration';
import { createSignedAuthCookie } from '@/lib/auth.server';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  decodeOIDCRegistrationSession,
  getOIDCAccountSubject,
  getOIDCBindingCandidates,
  getOIDCProvider,
  getOIDCProviderKey,
} from '@/lib/oidc-registration-session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    if (
      (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') ===
      'localstorage'
    ) {
      return NextResponse.json(
        { error: 'localStorage 模式不支持用户注册' },
        { status: 400 },
      );
    }
    const session = decodeOIDCRegistrationSession(
      request.cookies.get('oidc_session')?.value,
    );
    if (!session) {
      return NextResponse.json(
        { error: 'OIDC会话无效或已过期，请重新登录' },
        { status: 400 },
      );
    }
    const config = await getConfig();
    const provider = getOIDCProvider(config, session.providerId);
    if (
      !provider?.enabled ||
      !provider.enableRegistration ||
      config.UserConfig.AllowRegister === false
    ) {
      return NextResponse.json(
        { error: '管理员已关闭用户注册功能' },
        { status: 403 },
      );
    }
    if (
      getOIDCProviderKey(provider, session.providerId) !== session.providerKey
    ) {
      return NextResponse.json(
        { error: 'OIDC配置已变化，请重新登录' },
        { status: 400 },
      );
    }
    const minTrustLevel = provider.minTrustLevel || 0;
    if ((session.trust_level ?? 0) < minTrustLevel) {
      return NextResponse.json(
        { error: `您的信任等级不满足最低要求(${minTrustLevel})` },
        { status: 403 },
      );
    }

    const body = await request.json();
    const username =
      typeof body?.username === 'string' ? body.username.trim() : '';
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return NextResponse.json(
        { error: '用户名只能包含字母、数字、下划线，长度3-20位' },
        { status: 400 },
      );
    }
    if (
      await findBoundOIDCAccount(
        config,
        getOIDCBindingCandidates(config, session.providerKey, session.sub),
      )
    ) {
      return NextResponse.json(
        { error: '该OIDC账号已被注册，请重新登录' },
        { status: 409 },
      );
    }

    const result = await createRegisteredAccount(config, {
      username,
      password: crypto.randomUUID(),
      oidcSub: getOIDCAccountSubject(session.providerKey, session.sub),
      email: body.email ?? session.email,
      source: body.source,
      inviteCode: body.inviteCode,
    });
    const response = NextResponse.json({
      ok: true,
      pending: result.pending,
      message: result.pending ? '注册成功，请等待管理员审核' : '注册成功',
      needDelay: process.env.NEXT_PUBLIC_STORAGE_TYPE === 'upstash',
    });
    response.cookies.delete('oidc_session');
    if (result.pending) return response;

    const secure =
      request.headers
        .get('x-forwarded-proto')
        ?.split(',')[0]
        .trim()
        .toLowerCase() === 'https' || request.nextUrl.protocol === 'https:';
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
    db.updateUserLoginStats(result.uid, Date.now(), true).catch((error) => {
      console.error('OIDC注册记录登入时间失败:', error);
    });
    return response;
  } catch (error) {
    if (error instanceof AccountRegistrationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    console.error('OIDC注册完成失败:', error);
    return NextResponse.json(
      { error: '注册失败，请稍后重试' },
      { status: 500 },
    );
  }
}
