'use client';

import { ArrowLeft, Monitor, Smartphone } from 'lucide-react';
import Link from 'next/link';

import PageLayout from '@/components/PageLayout';
import { useSite } from '@/components/SiteProvider';

export default function DownloadPage() {
  const { siteName } = useSite();

  return (
    <PageLayout>
      <main className='mx-auto max-w-3xl px-4 py-8 sm:px-6'>
        <Link
          href='/'
          className='mb-8 inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
        >
          <ArrowLeft aria-hidden='true' className='h-4 w-4' />
          返回首页
        </Link>

        <h1 className='mb-3 text-3xl font-bold text-gray-900 dark:text-white'>
          在你的设备上使用 {siteName}
        </h1>
        <p className='mb-8 leading-7 text-gray-600 dark:text-gray-400'>
          用浏览器打开本站即可观看。目前公开项目提供 Web 版，尚未发布独立的
          Android、Windows 或 Apple 客户端安装包。
        </p>

        <div className='space-y-6'>
          <section className='rounded-xl border border-gray-200 p-6 dark:border-gray-800'>
            <h2 className='mb-3 flex items-center gap-2 text-lg font-semibold'>
              <Smartphone aria-hidden='true' className='h-5 w-5' />
              手机和平板
            </h2>
            <p className='leading-7 text-gray-600 dark:text-gray-400'>
              iPhone 和 iPad 可在 Safari 的分享菜单中选择“添加到主屏幕”。Android
              可在浏览器菜单中查找“安装应用”或“添加到主屏幕”。选项是否出现取决于浏览器和本站的
              HTTPS 配置。
            </p>
          </section>

          <section className='rounded-xl border border-gray-200 p-6 dark:border-gray-800'>
            <h2 className='mb-3 flex items-center gap-2 text-lg font-semibold'>
              <Monitor aria-hidden='true' className='h-5 w-5' />
              电脑
            </h2>
            <p className='leading-7 text-gray-600 dark:text-gray-400'>
              使用近期版本的 Chrome、Edge、Firefox 或 Safari。Chrome 和 Edge
              若显示安装入口，也可以将本站作为独立窗口打开。
            </p>
          </section>
        </div>

        <p className='mt-6 text-sm leading-6 text-gray-500 dark:text-gray-400'>
          添加到主屏幕后仍需联网访问本站，视频播放也依赖配置的内容来源。
        </p>
      </main>
    </PageLayout>
  );
}
