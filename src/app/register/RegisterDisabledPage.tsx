'use client';

import { motion } from 'framer-motion';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';

import { ThemeToggle } from '@/components/ThemeToggle';

export default function RegisterDisabledPage({ reason }: { reason: string }) {
  return (
    <div
      translate='no'
      className='fixed inset-0 z-50 overflow-y-auto bg-gray-50 dark:bg-zinc-950'
    >
      <div
        translate='no'
        className='relative min-h-screen flex items-center justify-center p-4 bg-gray-50 dark:bg-zinc-950'
      >
        <div className='absolute top-6 right-6 z-20'>
          <ThemeToggle />
        </div>
        <div className='w-full max-w-sm text-center'>
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className='mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-500 shadow-xl shadow-yellow-500/10'
          >
            <AlertCircle className='h-8 w-8' />
          </motion.div>
          <h2 className='text-xl font-bold text-gray-900 dark:text-white mb-2'>
            注册暂不可用
          </h2>
          <p className='text-gray-500 dark:text-gray-400 mb-8'>
            {reason || '管理员已关闭用户注册功能'}
          </p>
          <Link
            href='/login'
            className='block w-full rounded-xl bg-gray-900 dark:bg-white text-white dark:text-black py-3 text-sm font-semibold hover:opacity-90 transition-opacity'
          >
            返回登录
          </Link>
        </div>
      </div>
    </div>
  );
}
