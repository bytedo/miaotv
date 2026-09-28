import { NextRequest, NextResponse } from 'next/server';

import { getProxyPrincipal, ProxySourceError } from '@/lib/proxy-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // 强制动态渲染

// 普通用户也可以访问的 TVBox 配置接口
// 只返回 TVBox 安全配置，不返回完整的管理配置
export async function GET(request: NextRequest) {
  try {
    const { config, username } = await getProxyPrincipal(request);
    if (!username) throw new ProxySourceError('Unauthorized', 401);
    const securityConfig = config.TVBoxSecurityConfig || {
      enableAuth: false,
      token: '',
      enableIpWhitelist: false,
      allowedIPs: [],
      enableRateLimit: false,
      rateLimit: 60
    };

    // 🔑 获取当前用户的专属配置
    const currentUser = config.UserConfig.Users.find(u => u.username === username);
    const isAdministrator = username === process.env.USERNAME || currentUser?.role === 'admin';
    const userTvboxToken = currentUser?.tvboxToken || '';
    const userEnabledSources = currentUser?.tvboxEnabledSources || [];

    // 获取所有可用源（用于管理界面选择）
    const allSources = (config.SourceConfig || [])
      .filter(s => !s.disabled && (isAdministrator || userEnabledSources.length === 0 || userEnabledSources.includes(s.key)))
      .map(s => ({ key: s.key, name: s.name }));

    // 只返回 TVBox 安全配置和站点名称（不返回其他敏感信息）
    return NextResponse.json({
      securityConfig: isAdministrator ? securityConfig : {
        enableAuth: securityConfig.enableAuth,
        token: '',
        enableIpWhitelist: securityConfig.enableIpWhitelist,
        allowedIPs: [],
        enableRateLimit: securityConfig.enableRateLimit,
        rateLimit: securityConfig.rateLimit,
      },
      siteName: config.SiteConfig?.SiteName || 'MoonTV',
      // 🔑 新增：用户专属信息
      userToken: userTvboxToken,
      userEnabledSources: userEnabledSources,
      allSources: allSources
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const status = error instanceof ProxySourceError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof ProxySourceError ? error.message : 'Internal Server Error' },
      { status, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
}
