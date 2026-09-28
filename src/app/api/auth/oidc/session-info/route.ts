import { NextRequest, NextResponse } from 'next/server';

import { getRegistrationPolicy } from '@/lib/account-policy';
import { getConfig } from '@/lib/config';
import {
  decodeOIDCRegistrationSession,
  getOIDCProvider,
  getOIDCProviderKey,
} from '@/lib/oidc-registration-session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
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
    const policy = getRegistrationPolicy(
      config.UserConfig,
      (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') !==
        'localstorage',
    );
    const provider = getOIDCProvider(config, session.providerId);
    if (
      !provider?.enabled ||
      !provider.enableRegistration ||
      !policy.allowRegister
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
    return NextResponse.json(
      {
        email: session.email,
        name: session.name,
        trust_level: session.trust_level,
        ...policy,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
