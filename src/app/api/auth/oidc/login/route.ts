/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { isSecureAccountRequest } from '@/lib/account-policy';
import { getConfig } from '@/lib/config';
import { getOIDCProvider } from '@/lib/oidc-registration-session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    let providerId = searchParams.get('provider') || 'default';

    const config = await getConfig();

    console.log('[OIDC Login] Provider ID requested:', providerId);

    const oidcConfig = getOIDCProvider(config, providerId);

    // 检查是否启用OIDC登录
    if (!oidcConfig || !oidcConfig.enabled) {
      return NextResponse.json(
        { error: 'OIDC登录未启用或找不到指定的 Provider' },
        { status: 403 },
      );
    }
    // The default choice must still use that provider's OAuth parameters.
    providerId = oidcConfig.id || 'default';

    // 检查OIDC配置
    if (!oidcConfig.authorizationEndpoint || !oidcConfig.clientId) {
      return NextResponse.json(
        { error: 'OIDC配置不完整，请配置Authorization Endpoint和Client ID' },
        { status: 500 },
      );
    }

    // 生成state参数用于防止CSRF攻击
    const state = crypto.randomUUID();

    // 使用环境变量SITE_BASE，或从请求头获取真实的origin
    let origin: string;
    if (process.env.SITE_BASE) {
      // 1. 优先使用环境变量
      origin = process.env.SITE_BASE;
    } else if (request.headers.get('x-forwarded-host')) {
      // 2. 使用反向代理的域名（生产环境）
      const proto = request.headers.get('x-forwarded-proto') || 'https';
      const host = request.headers.get('x-forwarded-host');
      origin = `${proto}://${host}`;
    } else {
      // 3. 使用请求的 origin（本地开发）
      origin = request.nextUrl.origin;
      // 本地开发：将 0.0.0.0 替换为 localhost（OAuth 提供商不接受 0.0.0.0）
      origin = origin.replace('://0.0.0.0:', '://localhost:');
    }

    const redirectUri = `${origin}/api/auth/oidc/callback`;

    // 构建授权URL
    const authUrl = new URL(oidcConfig.authorizationEndpoint);

    // 微信使用 appid 而不是 client_id
    if (providerId === 'wechat') {
      authUrl.searchParams.set('appid', oidcConfig.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'snsapi_login'); // 微信网站应用使用 snsapi_login
      authUrl.searchParams.set('state', state);
    } else if (providerId === 'apple') {
      // Apple Sign In 参数
      authUrl.searchParams.set('client_id', oidcConfig.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'name email'); // Apple 使用 name email
      authUrl.searchParams.set('response_mode', 'form_post'); // Apple 推荐使用 form_post
      authUrl.searchParams.set('state', state);
    } else if (providerId === 'facebook') {
      // Facebook OAuth 参数
      authUrl.searchParams.set('client_id', oidcConfig.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'public_profile email'); // Facebook 使用 public_profile email
      authUrl.searchParams.set('state', state);
    } else if (providerId === 'github') {
      // GitHub OAuth 参数（不支持 openid scope）
      authUrl.searchParams.set('client_id', oidcConfig.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'read:user user:email'); // GitHub 使用 read:user user:email
      authUrl.searchParams.set('state', state);
    } else {
      // 标准 OIDC 参数
      authUrl.searchParams.set('client_id', oidcConfig.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid profile email');
      authUrl.searchParams.set('state', state);
    }

    // 将state和provider ID存储到cookie中
    const response = NextResponse.redirect(authUrl);

    // 存储 state 和 provider ID
    const sessionData = JSON.stringify({
      state,
      providerId,
    });

    response.cookies.set('oidc_state', sessionData, {
      path: '/',
      httpOnly: true,
      secure: isSecureAccountRequest(request),
      sameSite: providerId === 'apple' ? 'none' : 'lax',
      maxAge: 600, // 10分钟
    });

    return response;
  } catch (error) {
    console.error('OIDC登录发起失败:', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
