'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle,
  Loader2,
  Mail,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useSite } from '@/components/SiteProvider';
import { ThemeToggle } from '@/components/ThemeToggle';
import { isValidEmail, normalizeEmail } from '@/lib/account-policy';

function ForgotPasswordForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focusedInput, setFocusedInput] = useState<string | null>(null);

  const { siteName } = useSite();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (loading || success) return;
    setError(null);
    setSuccess(null);

    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      setError('请输入邮箱地址');
      return;
    }

    // 验证邮箱格式
    if (!isValidEmail(normalizedEmail)) {
      setError('请输入有效的邮箱地址');
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail }),
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess(
          '如果该邮箱已注册，您将收到一封密码重置邮件。请检查您的收件箱。',
        );
      } else {
        setError(data.error ?? '请求失败，请稍后重试');
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
          className='absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-gradient-to-br from-amber-200/20 to-orange-200/20 dark:from-amber-900/10 dark:to-orange-900/10 blur-[120px]'
        />
        <motion.div
          animate={{
            scale: [1, 1.2, 1],
            rotate: [0, -5, 0],
          }}
          transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
          className='absolute bottom-[10%] -right-[10%] w-[50%] h-[70%] rounded-full bg-gradient-to-tr from-blue-200/20 to-indigo-200/20 dark:from-blue-900/10 dark:to-indigo-900/10 blur-[120px]'
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
            找回您的密码
          </motion.p>
        </div>

        <form onSubmit={handleSubmit} className='space-y-4'>
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 }}
          >
            <div
              className={`relative group transition-all duration-300 ${
                focusedInput === 'email' ? 'scale-[1.02]' : ''
              }`}
            >
              <div className='absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none'>
                <Mail
                  className={`h-5 w-5 transition-colors duration-300 ${
                    focusedInput === 'email'
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-400'
                  }`}
                />
              </div>
              <input
                id='email'
                type='email'
                autoComplete='email'
                aria-label='邮箱地址'
                maxLength={254}
                className='block w-full pl-10 pr-3 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm sm:text-base dark:text-gray-100'
                placeholder='请输入注册时使用的邮箱'
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={() => setFocusedInput('email')}
                onBlur={() => setFocusedInput(null)}
                disabled={!!success}
              />
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
                className='flex items-start gap-2 p-3 rounded-lg bg-green-50/50 dark:bg-green-900/10 text-green-600 dark:text-green-400 text-sm border border-green-100/50 dark:border-green-900/50'
              >
                <CheckCircle className='h-4 w-4 shrink-0 mt-0.5' />
                <p>{success}</p>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.button
            type='submit'
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            disabled={!email || loading || !!success}
            className='relative w-full group overflow-hidden rounded-xl bg-gray-900 dark:bg-white text-white dark:text-black py-3.5 text-sm font-semibold shadow-lg shadow-gray-900/10 dark:shadow-white/5 hover:shadow-xl hover:scale-[1.01] active:scale-[0.99] transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed'
          >
            <div className='flex items-center justify-center gap-2'>
              {loading ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : success ? (
                <span>已发送</span>
              ) : (
                <span>发送重置邮件</span>
              )}
            </div>
          </motion.button>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className='text-center mt-6'
          >
            <button
              type='button'
              onClick={() => router.push('/login')}
              className='group inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors'
            >
              <ArrowLeft className='w-4 h-4 group-hover:-translate-x-1 transition-transform' />
              <span>返回登录</span>
            </button>
          </motion.div>
        </form>
      </motion.div>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <div
      translate='no'
      className='fixed inset-0 z-50 overflow-y-auto bg-gray-50 dark:bg-zinc-950'
    >
      <ForgotPasswordForm />
    </div>
  );
}
