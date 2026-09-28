'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  CheckCircle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  MessageSquare,
  Shield,
  User,
  UserPlus,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import {
  getRegistrationMode,
  type RegistrationPolicy,
  sanitizeRedirect,
  validateRegistrationProfile,
} from '@/lib/account-policy';
import { useRegistrationPolicy } from '@/hooks/useRegistrationPolicy';

import { useSite } from '@/components/SiteProvider';
import { ThemeToggle } from '@/components/ThemeToggle';

import RegisterDisabledPage from './RegisterDisabledPage';

type RegisterPageClientProps = RegistrationPolicy;

function RegisterForm(initialPolicy: RegisterPageClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: currentPolicy, refetch } = useRegistrationPolicy(initialPolicy);
  const policy = currentPolicy ?? initialPolicy;
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [source, setSource] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focusedInput, setFocusedInput] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const showInviteCode = policy.requireApproval || policy.requireInviteCode;
  const activeInviteCode = showInviteCode ? inviteCode : '';
  const mode = getRegistrationMode(policy, activeInviteCode);
  const requireApproval = mode === 'approval';
  const requireInviteCode = policy.requireInviteCode;

  const { siteName } = useSite();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (loading || success) return;
    setError(null);
    setSuccess(null);

    if (!username || !password || !confirmPassword) {
      setError('请填写完整信息');
      return;
    }

    const profile = validateRegistrationProfile(
      {
        email,
        source: requireApproval ? source : undefined,
        inviteCode: activeInviteCode,
      },
      policy,
    );
    if (profile.error) {
      setError(profile.error);
      return;
    }

    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          confirmPassword,
          email: profile.email || undefined,
          source: profile.source || undefined,
          inviteCode: profile.inviteCode || undefined,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setError(null);
        if (data.pending) {
          setSuccess('注册成功！请等待管理员审核，结果将通过邮件通知。');
        } else {
          setSuccess('注册成功！正在跳转...');
          // Upstash 需要额外延迟等待数据同步
          const delay = data.needDelay ? 2500 : 1500;
          setTimeout(() => {
            const redirect = sanitizeRedirect(searchParams.get('redirect'));
            router.replace(redirect);
          }, delay);
        }
      } else {
        setError(data.error ?? '注册失败');
        void refetch();
      }
    } catch {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  if (!policy.allowRegister && !success) {
    return <RegisterDisabledPage reason='管理员已关闭用户注册功能' />;
  }

  return (
    <div
      translate='no'
      className='relative min-h-screen flex items-center justify-center p-4 overflow-hidden bg-gray-50 dark:bg-zinc-950 transition-colors duration-500'
    >
      {/* 极简背景装饰 */}
      <div className='absolute inset-0 overflow-hidden pointer-events-none'>
        <motion.div
          animate={{ scale: [1, 1.1, 1], rotate: [0, 5, 0] }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
          className='absolute -top-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-gradient-to-br from-blue-200/20 to-purple-200/20 dark:from-blue-900/10 dark:to-purple-900/10 blur-[100px]'
        />
        <motion.div
          animate={{ scale: [1, 1.2, 1], rotate: [0, -5, 0] }}
          transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
          className='absolute bottom-[10%] left-[10%] w-[40%] h-[60%] rounded-full bg-gradient-to-tr from-indigo-200/20 to-cyan-200/20 dark:from-indigo-900/10 dark:to-cyan-900/10 blur-[100px]'
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
        <div className='text-center mb-8'>
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
            创建您的新账户
          </motion.p>
          <p
            id='registration-mode'
            className='mt-3 text-sm text-gray-500 dark:text-gray-400'
          >
            {mode === 'invite'
              ? '有效邀请码注册后直接登录，无需审核。邮箱选填。'
              : requireApproval
                ? '请填写邮箱和来源，提交后等待审核。也可使用有效邀请码免审核注册。'
                : '注册后直接登录，邮箱选填，可用于找回密码。'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className='space-y-4'>
          {/* 用户名 */}
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 }}
          >
            <div
              className={`relative group transition-all duration-300 ${
                focusedInput === 'username' ? 'scale-[1.02]' : ''
              }`}
            >
              <div className='absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none'>
                <User
                  className={`h-5 w-5 transition-colors duration-300 ${
                    focusedInput === 'username'
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-400'
                  }`}
                />
              </div>
              <input
                id='username'
                type='text'
                autoComplete='username'
                aria-label='用户名'
                className='block w-full pl-10 pr-3 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm sm:text-base dark:text-gray-100'
                placeholder='用户名'
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onFocus={() => setFocusedInput('username')}
                onBlur={() => setFocusedInput(null)}
              />
            </div>
          </motion.div>

          {/* 密码组 */}
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.35 }}
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
                aria-label='设置密码'
                className='block w-full pl-10 pr-10 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm dark:text-gray-100'
                placeholder='设置密码'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={() => setFocusedInput('password')}
                onBlur={() => setFocusedInput(null)}
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

          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.4 }}
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
                aria-label='确认密码'
                className='block w-full pl-10 pr-10 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm dark:text-gray-100'
                placeholder='确认密码'
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onFocus={() => setFocusedInput('confirmPassword')}
                onBlur={() => setFocusedInput(null)}
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

          {showInviteCode && (
            <div>
              <label
                htmlFor='inviteCode'
                className='mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300'
              >
                {requireInviteCode
                  ? '邀请码（必填）'
                  : '邀请码（选填，可免审核）'}
              </label>
              <div className='relative'>
                <Shield className='absolute left-3 top-3.5 h-5 w-5 text-gray-400' />
                <input
                  id='inviteCode'
                  type='text'
                  required={requireInviteCode}
                  autoComplete='off'
                  autoCapitalize='characters'
                  spellCheck={false}
                  aria-describedby='registration-mode'
                  placeholder={
                    requireInviteCode
                      ? '填写邀请码（必填）'
                      : '邀请码（选填，可免审核）'
                  }
                  value={inviteCode}
                  onChange={(event) =>
                    setInviteCode(event.target.value.toUpperCase())
                  }
                  className='block w-full rounded-xl border-none bg-white py-3 pl-10 pr-3 text-sm ring-1 ring-gray-200 focus:ring-2 focus:ring-gray-900 dark:bg-zinc-900 dark:text-gray-100 dark:ring-zinc-800 dark:focus:ring-white'
                />
              </div>
            </div>
          )}

          {/* 邮箱 */}
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.45 }}
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
                maxLength={254}
                required={requireApproval}
                aria-label={
                  requireApproval ? '邮箱（审核必填）' : '邮箱（选填）'
                }
                autoComplete='email'
                className='block w-full pl-10 pr-3 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm sm:text-base dark:text-gray-100'
                placeholder={
                  requireApproval ? '填写邮箱（审核必填）' : '填写邮箱（选填）'
                }
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={() => setFocusedInput('email')}
                onBlur={() => setFocusedInput(null)}
              />
            </div>
          </motion.div>

          {/* 来源 */}
          {requireApproval && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.5 }}
            >
              <div
                className={`relative group transition-all duration-300 ${
                  focusedInput === 'source' ? 'scale-[1.02]' : ''
                }`}
              >
                <div className='absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none'>
                  <MessageSquare
                    className={`h-5 w-5 transition-colors duration-300 ${
                      focusedInput === 'source'
                        ? 'text-gray-900 dark:text-white'
                        : 'text-gray-400'
                    }`}
                  />
                </div>
                <input
                  id='source'
                  type='text'
                  required={requireApproval}
                  maxLength={500}
                  aria-label={
                    requireApproval ? '来源（审核必填）' : '来源（选填）'
                  }
                  className='block w-full pl-10 pr-24 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm sm:text-base dark:text-gray-100'
                  placeholder='填写来源'
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  onFocus={() => setFocusedInput('source')}
                  onBlur={() => setFocusedInput(null)}
                />
                {requireApproval && (
                  <span className='absolute right-3 top-1/2 -translate-y-1/2 text-[10px] sm:text-xs text-red-500 font-medium bg-red-50 dark:bg-red-950/30 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50'>
                    必填，需审核
                  </span>
                )}
              </div>
            </motion.div>
          )}

          {/* 提示组 */}
          <AnimatePresence>
            {error && (
              <motion.div
                role='alert'
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className='flex items-center gap-2 p-3 rounded-lg bg-red-50/50 dark:bg-red-900/10 text-red-600 dark:text-red-400 text-sm border border-red-100/50 dark:border-red-900/50'
              >
                <AlertCircle className='h-4 w-4 shrink-0' />
                <p>{error}</p>
              </motion.div>
            )}
            {success && (
              <motion.div
                role='status'
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className='flex items-center gap-2 p-3 rounded-lg bg-green-50/50 dark:bg-green-900/10 text-green-600 dark:text-green-400 text-sm border border-green-100/50 dark:border-green-900/50'
              >
                <CheckCircle className='h-4 w-4 shrink-0' />
                <p>{success}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 注册按钮 */}
          <motion.button
            type='submit'
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            disabled={
              !username || !password || !confirmPassword || loading || !!success
            }
            className='relative w-full overflow-hidden rounded-xl bg-gray-900 dark:bg-white text-white dark:text-black py-3.5 text-sm font-semibold shadow-lg shadow-gray-900/10 dark:shadow-white/5 hover:shadow-xl hover:scale-[1.01] active:scale-[0.99] transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed'
          >
            <div className='flex items-center justify-center gap-2'>
              {loading ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : success ? (
                <span>注册成功</span>
              ) : (
                <>
                  <UserPlus className='h-4 w-4' />
                  <span>{requireApproval ? '提交审核申请' : '立即注册'}</span>
                </>
              )}
            </div>
          </motion.button>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className='text-center mt-6'
          >
            <a
              href='/login'
              className='text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors'
            >
              已有账户？{' '}
              <span className='underline underline-offset-4 decoration-gray-300 dark:decoration-zinc-700 hover:decoration-gray-900 dark:hover:decoration-white transition-all'>
                立即登录
              </span>
            </a>
          </motion.div>
        </form>
      </motion.div>
    </div>
  );
}

export default function RegisterPageClient(props: RegisterPageClientProps) {
  return (
    <div
      translate='no'
      className='fixed inset-0 z-50 overflow-y-auto bg-gray-50 dark:bg-zinc-950'
    >
      <Suspense
        fallback={<div className='min-h-screen bg-gray-50 dark:bg-zinc-950' />}
      >
        <RegisterForm {...props} />
      </Suspense>
    </div>
  );
}
