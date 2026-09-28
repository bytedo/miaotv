import './globals.css';

import type { Metadata, Viewport } from 'next';
import nextDynamic from 'next/dynamic';
import localFont from 'next/font/local';
import { cookies, headers } from 'next/headers';
import { Suspense } from 'react';
import { Toaster } from 'sonner';

import { isWarningPageRequest } from '@/lib/request-context';

import { ChunkErrorGuard } from '../components/ChunkErrorGuard';
import { DOMErrorBoundary } from '../components/DOMErrorBoundary';
import { GlobalDOMErrorHandler } from '../components/GlobalDOMErrorHandler';
import { GlobalErrorIndicator } from '../components/GlobalErrorIndicator';
import NavigationShell from '../components/NavigationShell';
import { PageLoading } from '../components/PageLoading';
import QueryProvider from '../components/QueryProvider';
import { SiteProvider } from '../components/SiteProvider';
import { ThemeProvider } from '../components/ThemeProvider';
import { DownloadProvider } from '../contexts/DownloadContext';
import { GlobalCacheProvider } from '../contexts/GlobalCacheContext';

// 懒加载非关键 UI 组件，减少首屏 JS 体积（代码分割）
// 未设置 ssr: false，保持服务端渲染兼容性
const TranslationWarningToast = nextDynamic(() =>
  import('../components/TranslationWarningToast').then(
    (m) => m.TranslationWarningToast,
  ),
);
const SessionTracker = nextDynamic(() =>
  import('../components/SessionTracker').then((m) => m.SessionTracker),
);
const RouteWarmup = nextDynamic(() => import('../components/RouteWarmup'));
const DownloadPanel = nextDynamic(() =>
  import('../components/download/DownloadPanel').then((m) => m.DownloadPanel),
);

const inter = localFont({
  src: '../assets/fonts/InterVariable.woff2',
  weight: '100 900',
  display: 'swap',
  fallback: ['system-ui', 'Arial', 'sans-serif'],
});
export const dynamic = 'force-dynamic';

// 动态生成 metadata，支持配置更新后的标题变化
export async function generateMetadata(): Promise<Metadata> {
  // 🔥 调用 cookies() 强制动态渲染，防止 Docker 环境下的缓存问题
  await cookies();

  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  let siteName = process.env.NEXT_PUBLIC_SITE_NAME || 'MiaoTV';
  if (!isWarningPageRequest(await headers())) {
    const { getConfig } = await import('@/lib/config');
    const config = await getConfig();
    if (storageType !== 'localstorage') {
      siteName = config.SiteConfig.SiteName;
    }
  }

  return {
    title: siteName,
    description: '影视聚合',
    manifest: '/manifest.json',
  };
}

export const viewport: Viewport = {
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 🔥 调用 cookies() 强制动态渲染，防止 Docker 环境下的缓存问题
  await cookies();

  if (isWarningPageRequest(await headers())) {
    return (
      <html lang='zh-CN' translate='no' suppressHydrationWarning>
        <body
          translate='no'
          className={`${inter.className} min-h-screen bg-white text-gray-900`}
        >
          {children}
        </body>
      </html>
    );
  }

  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  let siteName = process.env.NEXT_PUBLIC_SITE_NAME || 'MiaoTV';
  let announcement =
    process.env.ANNOUNCEMENT ||
    '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。';

  let doubanProxyType = process.env.NEXT_PUBLIC_DOUBAN_PROXY_TYPE || 'direct';
  let doubanProxy = process.env.NEXT_PUBLIC_DOUBAN_PROXY || '';
  let doubanImageProxyType =
    process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE || 'server';
  let doubanImageProxy = process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY || '';
  let disableYellowFilter =
    process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true';
  let fluidSearch = process.env.NEXT_PUBLIC_FLUID_SEARCH !== 'false';
  let enableWebLive = true;
  let customAdFilterVersion = 0;
  let embyEnabled = false;
  let privateLibraryEnabled = false;
  let optionalFeatures = {
    WEBSR_ENABLED: false,
  };
  let videoProxyEnabled = false;
  let videoProxyUrl = '';
  let customCategories = [] as {
    name: string;
    type: 'movie' | 'tv';
    query: string;
  }[];
  if (storageType !== 'localstorage') {
    const { getConfig } = await import('@/lib/config');
    const config = await getConfig();
    siteName = config.SiteConfig.SiteName;
    announcement = config.SiteConfig.Announcement;

    doubanProxyType = config.SiteConfig.DoubanProxyType;
    doubanProxy = config.SiteConfig.DoubanProxy;
    doubanImageProxyType = config.SiteConfig.DoubanImageProxyType;
    doubanImageProxy = config.SiteConfig.DoubanImageProxy;
    disableYellowFilter = config.SiteConfig.DisableYellowFilter;
    customCategories = config.CustomCategories.filter(
      (category) => !category.disabled,
    ).map((category) => ({
      name: category.name || '',
      type: category.type,
      query: category.query,
    }));
    fluidSearch = config.SiteConfig.FluidSearch;
    enableWebLive = config.SiteConfig.EnableWebLive ?? true;
    customAdFilterVersion = config.SiteConfig?.CustomAdFilterVersion || 0;
    privateLibraryEnabled = config.SiteConfig.EnableEmby === true;
    optionalFeatures = {
      WEBSR_ENABLED: config.SiteConfig.EnableWebSR === true,
    };
    // 检查是否启用了 Emby 功能（支持多源）
    embyEnabled =
      privateLibraryEnabled &&
      !!(
        config.EmbyConfig?.Sources &&
        config.EmbyConfig.Sources.length > 0 &&
        config.EmbyConfig.Sources.some((s) => s.enabled && s.ServerURL)
      );
    videoProxyEnabled = config.VideoProxyConfig?.enabled ?? false;
    videoProxyUrl = config.VideoProxyConfig?.proxyUrl || '';
  }

  // 将运行时配置注入到全局 window 对象，供客户端在运行时读取
  const runtimeConfig = {
    STORAGE_TYPE: process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage',
    DOUBAN_PROXY_TYPE: doubanProxyType,
    DOUBAN_PROXY: doubanProxy,
    DOUBAN_IMAGE_PROXY_TYPE: doubanImageProxyType,
    DOUBAN_IMAGE_PROXY: doubanImageProxy,
    BANGUMI_IMAGE_PROXY_TYPE:
      process.env.NEXT_PUBLIC_BANGUMI_IMAGE_PROXY_TYPE || 'server',
    BANGUMI_IMAGE_PROXY: process.env.NEXT_PUBLIC_BANGUMI_IMAGE_PROXY || '',
    DISABLE_YELLOW_FILTER: disableYellowFilter,
    CUSTOM_CATEGORIES: customCategories,
    FLUID_SEARCH: fluidSearch,
    ENABLE_WEB_LIVE: enableWebLive,
    CUSTOM_AD_FILTER_VERSION: customAdFilterVersion,
    EMBY_ENABLED: embyEnabled,
    PRIVATE_LIBRARY_ENABLED: privateLibraryEnabled,
    ...optionalFeatures,
    VIDEO_PROXY_ENABLED: videoProxyEnabled,
    VIDEO_PROXY_URL: videoProxyUrl,
    // 禁用预告片：Vercel 自动检测，或用户手动设置 DISABLE_HERO_TRAILER=true
    DISABLE_HERO_TRAILER:
      process.env.VERCEL === '1' || process.env.DISABLE_HERO_TRAILER === 'true',
  };

  return (
    <html lang='zh-CN' translate='no' suppressHydrationWarning>
      <head>
        <meta
          name='viewport'
          content='width=device-width, initial-scale=1.0, viewport-fit=cover'
        />
        <meta name='color-scheme' content='light dark' />
        <meta name='google' content='notranslate' />
        {/* iOS PWA 沉浸式状态栏：manifest.json 里的同名字段对 Safari 无效，必须通过 meta 标签设置 */}
        <meta name='apple-mobile-web-app-capable' content='yes' />
        <meta
          name='apple-mobile-web-app-status-bar-style'
          content='black-translucent'
        />
        <link rel='apple-touch-icon' href='/icons/icon-192x192.png' />
        {/* 将配置序列化后直接写入脚本，浏览器端可通过 window.RUNTIME_CONFIG 获取 */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script
          dangerouslySetInnerHTML={{
            // 转义 < 与分隔符，避免站点名/公告等配置内容中的 </script> 提前闭合脚本标签
            __html: `window.RUNTIME_CONFIG = ${JSON.stringify(runtimeConfig)
              .replace(/</g, '\\u003c')
              .replace(/\u2028/g, '\\u2028')
              .replace(/\u2029/g, '\\u2029')};`,
          }}
        />
      </head>
      <body
        translate='no'
        className={`${inter.className} min-h-screen bg-white text-gray-900 dark:bg-black dark:text-gray-200`}
      >
        {/*
          iOS 沉浸式状态栏（black-translucent）下，状态栏图标固定为白色，
          不随亮/暗主题切换。用一条固定深色条带盖住状态栏区域，
          确保任何主题下时间/电量图标都清晰可读。安全区外的设备该高度为 0，不受影响。
        */}
        <div
          className='fixed top-0 left-0 right-0 z-1000 bg-black md:hidden'
          style={{ height: 'env(safe-area-inset-top)' }}
        />
        <ThemeProvider
          attribute='class'
          defaultTheme='system'
          enableSystem
          disableTransitionOnChange
        >
          <QueryProvider>
            <GlobalCacheProvider>
              <DownloadProvider>
                <SiteProvider siteName={siteName} announcement={announcement}>
                  <GlobalDOMErrorHandler />
                  <ChunkErrorGuard />
                  <TranslationWarningToast />
                  <SessionTracker />
                  <RouteWarmup />
                  {/* 导航栏在 layout 层，自动持久化 */}
                  <NavigationShell>
                    <DOMErrorBoundary componentName='PageContent'>
                      <Suspense fallback={<PageLoading />}>{children}</Suspense>
                    </DOMErrorBoundary>
                  </NavigationShell>
                  <GlobalErrorIndicator />
                </SiteProvider>
                <Suspense fallback={null}>
                  <DownloadPanel />
                </Suspense>
              </DownloadProvider>
            </GlobalCacheProvider>
          </QueryProvider>
          <Toaster position='top-center' richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
