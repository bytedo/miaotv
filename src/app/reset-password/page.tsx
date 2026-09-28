'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Shield,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { useSite } from '@/components/SiteProvider';
import { ThemeToggle } from '@/components/ThemeToggle';

function ResetPasswordPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focusedInput, setFocusedInput] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const { siteName } = useSite();

  // 如果没有 token，显示错误
  if (!token) {
    return (
      <div className='relative min-h-screen flex items-center justify-center p-4 bg-gray-50 dark:bg-zinc-950'>
        <div className='absolute top-6 right-6 z-20'>
          <ThemeToggle />
        </div>
        <div className='w-full max-w-sm text-center'>
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className='mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-500 shadow-xl shadow-red-500/10'
          >
            <AlertCircle className='h-8 w-8' />
          </motion.div>
          <h2 className='text-xl font-bold text-gray-900 dark:text-white mb-2'>
            无效的重置链接
          </h2>
          <p className='text-gray-500 dark:text-gray-400 mb-8'>
            重置链接无效或已过期，请重新申请密码重置。
          </p>
          <button
            onClick={() => router.push('/forgot-password')}
            className='w-full rounded-xl bg-gray-900 dark:bg-white text-white dark:text-black py-3 text-sm font-semibold hover:opacity-90 transition-opacity'
          >
            重新申请
          </button>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (loading || success) return;
    setError(null);
    setSuccess(null);

    if (!password || !confirmPassword) {
      setError('请填写完整信息');
      return;
    }

    if (password.length < 6) {
      setError('密码长度至少为6位');
      return;
    }

    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess('密码重置成功！正在跳转到登录页...');
        setTimeout(() => {
          router.replace('/login');
        }, 2000);
      } else {
        setError(data.error ?? '重置失败，请稍后重试');
      }
    } catch {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className='relative min-h-screen flex items-center justify-center p-4 overflow-hidden bg-gray-50 dark:bg-zinc-950 transition-colors duration-500'>
      {/* 极简动态背景 */}
      <div className='absolute inset-0 overflow-hidden pointer-events-none'>
        <motion.div
          animate={{
            scale: [1, 1.1, 1],
            rotate: [0, 5, 0],
          }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
          className='absolute -top-[20%] -right-[10%] w-[60%] h-[60%] rounded-full bg-gradient-to-br from-green-200/20 to-emerald-200/20 dark:from-green-900/10 dark:to-emerald-900/10 blur-[120px]'
        />
        <motion.div
          animate={{
            scale: [1, 1.2, 1],
            rotate: [0, -5, 0],
          }}
          transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
          className='absolute bottom-[10%] -left-[10%] w-[50%] h-[70%] rounded-full bg-gradient-to-tr from-cyan-200/20 to-blue-200/20 dark:from-cyan-900/10 dark:to-blue-900/10 blur-[120px]'
        />
      </div>

      <div className='absolute top-6 right-6 z-20'>
        <ThemeToggle />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className='relative z-10 w-full max-w-sm'
      >
        <div className='text-center mb-10'>
          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.5 }}
            className='text-3xl font-bold tracking-tight text-gray-900 dark:text-white mb-2'
          >
            {siteName}
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className='text-sm text-gray-500 dark:text-gray-400'
          >
            设置您的新密码
          </motion.p>
        </div>

        <form onSubmit={handleSubmit} className='space-y-4'>
          {/* 新密码 */}
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 }}
          >
            <div
              className={`relative group transition-all duration-300 ${
                focusedInput === 'password' ? 'scale-[1.02]' : ''
              }`}
            >
              <div className='absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none'>
                <Lock
                  className={`h-5 w-5 transition-colors duration-300 ${
                    focusedInput === 'password'
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-400'
                  }`}
                />
              </div>
              <input
                id='password'
                type={showPassword ? 'text' : 'password'}
                autoComplete='new-password'
                aria-label='设置新密码'
                className='block w-full pl-10 pr-10 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm dark:text-gray-100'
                placeholder='设置新密码'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={() => setFocusedInput('password')}
                onBlur={() => setFocusedInput(null)}
                disabled={!!success}
              />
              <button
                type='button'
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
                className='absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 focus:outline-none'
              >
                {showPassword ? (
                  <Eye className='h-5 w-5' />
                ) : (
                  <EyeOff className='h-5 w-5' />
                )}
              </button>
            </div>
          </motion.div>

          {/* 确认密码 */}
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.35 }}
          >
            <div
              className={`relative group transition-all duration-300 ${
                focusedInput === 'confirmPassword' ? 'scale-[1.02]' : ''
              }`}
            >
              <div className='absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none'>
                <Shield
                  className={`h-5 w-5 transition-colors duration-300 ${
                    focusedInput === 'confirmPassword'
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-400'
                  }`}
                />
              </div>
              <input
                id='confirmPassword'
                type={showConfirmPassword ? 'text' : 'password'}
                autoComplete='new-password'
                aria-label='确认新密码'
                className='block w-full pl-10 pr-10 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm dark:text-gray-100'
                placeholder='确认新密码'
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onFocus={() => setFocusedInput('confirmPassword')}
                onBlur={() => setFocusedInput(null)}
                disabled={!!success}
              />
              <button
                type='button'
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                aria-label={
                  showConfirmPassword ? '隐藏确认密码' : '显示确认密码'
                }
                aria-pressed={showConfirmPassword}
                className='absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 focus:outline-none'
              >
                {showConfirmPassword ? (
                  <Eye className='h-5 w-5' />
                ) : (
                  <EyeOff className='h-5 w-5' />
                )}
              </button>
            </div>
          </motion.div>

          <AnimatePresence>
            {error && (
              <motion.div
                role='alert'
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className='flex items-center gap-2 p-3 rounded-lg bg-red-50/50 dark:bg-red-900/10 text-red-600 dark:text-red-400 text-sm border border-red-100/50 dark:border-red-900/50'
              >
                <AlertCircle className='h-4 w-4 shrink-0' />
                <p>{error}</p>
              </motion.div>
            )}
            {success && (
              <motion.div
                role='status'
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className='flex items-center gap-2 p-3 rounded-lg bg-green-50/50 dark:bg-green-900/10 text-green-600 dark:text-green-400 text-sm border border-green-100/50 dark:border-green-900/50'
              >
                <CheckCircle className='h-4 w-4 shrink-0' />
                <p>{success}</p>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.button
            type='submit'
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            disabled={!password || !confirmPassword || loading || !!success}
            className='relative w-full group overflow-hidden rounded-xl bg-gray-900 dark:bg-white text-white dark:text-black py-3.5 text-sm font-semibold shadow-lg shadow-gray-900/10 dark:shadow-white/5 hover:shadow-xl hover:scale-[1.01] active:scale-[0.99] transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed'
          >
            <div className='flex items-center justify-center gap-2'>
              {loading ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : success ? (
                <span>重置成功</span>
              ) : (
                <>
                  <span>重置密码</span>
                  <ArrowRight className='w-4 h-4 group-hover:translate-x-1 transition-transform' />
                </>
              )}
            </div>
          </motion.button>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className='text-center mt-6'
          >
            <a
              href='/login'
              className='text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors'
            >
              返回登录
            </a>
          </motion.div>
        </form>
      </motion.div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div
      translate='no'
      className='fixed inset-0 z-50 overflow-y-auto bg-gray-50 dark:bg-zinc-950'
    >
      <Suspense
        fallback={<div className='min-h-screen bg-gray-50 dark:bg-zinc-950' />}
      >
        <ResetPasswordPageClient />
      </Suspense>
    </div>
  );
}
