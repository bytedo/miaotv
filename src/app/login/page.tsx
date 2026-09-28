'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  User,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { sanitizeRedirect } from '@/lib/account-policy';
import { useRegistrationPolicy } from '@/hooks/useRegistrationPolicy';

import {
  detectProvider,
  getProviderButtonStyle,
  getProviderButtonText,
  OIDCProviderLogo,
} from '@/components/OIDCProviderLogos';
import { useSite } from '@/components/SiteProvider';
import { ThemeToggle } from '@/components/ThemeToggle';

function LoginPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: registrationPolicy } = useRegistrationPolicy();
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shouldAskUsername, setShouldAskUsername] = useState(false);
  const [focusedInput, setFocusedInput] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // OIDC 登录状态
  const [oidcProviders, setOidcProviders] = useState<
    Array<{
      id: string;
      name: string;
      buttonText: string;
      issuer: string;
    }>
  >([]);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcButtonText, setOidcButtonText] = useState('使用OIDC登录');
  const [oidcIssuer, setOidcIssuer] = useState<string>('');

  const { siteName } = useSite();

  useEffect(() => {
    setError(searchParams.get('error'));
  }, [searchParams]);

  // 在客户端挂载后设置配置
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const storageType = (window as any).RUNTIME_CONFIG?.STORAGE_TYPE;
      setShouldAskUsername(storageType && storageType !== 'localstorage');
    }
  }, []);

  // 获取 OIDC 配置
  useEffect(() => {
    const fetchOIDCConfig = async () => {
      try {
        const response = await fetch('/api/server-config', { cache: 'no-store' });
        const data = await response.json();

        // 优先使用新的多 Provider 配置
        if (data.OIDCProviders && data.OIDCProviders.length > 0) {
          setOidcProviders(data.OIDCProviders);
          setOidcEnabled(true);
        } else if (data.OIDCConfig?.enabled) {
          // 向后兼容：旧的单 Provider 配置
          setOidcEnabled(true);
          setOidcButtonText(data.OIDCConfig.buttonText || '使用OIDC登录');
          setOidcIssuer(data.OIDCConfig.issuer || '');
        }
      } catch (error) {
        console.log('Failed to fetch server config:', error);
      }
    };

    fetchOIDCConfig();
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (loading) return;
    setError(null);

    if (!password || (shouldAskUsername && !username)) return;

    try {
      setLoading(true);
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          ...(shouldAskUsername ? { username } : {}),
        }),
      });

      if (res.ok) {
        // 记录登入时间
        const loginTime = Date.now();
        try {
          await fetch('/api/user/my-stats', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loginTime }),
          });
          // 更新 localStorage 记录
          localStorage.setItem('lastRecordedLogin', loginTime.toString());
        } catch (error) {
          console.log('记录登入时间失败:', error);
          // 登入时间记录失败不影响正常登录流程
        }

        const redirect = sanitizeRedirect(searchParams.get('redirect'));
        router.replace(redirect);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(
          data.error ?? (res.status === 401 ? '账号或密码错误' : '服务器错误'),
        );
      }
    } catch {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      translate='no'
      className='relative min-h-screen flex items-center justify-center p-4 overflow-hidden bg-gray-50 dark:bg-zinc-950 transition-colors duration-500'
    >
      {/* 极简动态背景 */}
      <div className='absolute inset-0 overflow-hidden pointer-events-none'>
        <motion.div
          animate={{
            scale: [1, 1.1, 1],
            rotate: [0, 5, 0],
          }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
          className='absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-gradient-to-br from-purple-200/20 to-blue-200/20 dark:from-purple-900/10 dark:to-blue-900/10 blur-[120px]'
        />
        <motion.div
          animate={{
            scale: [1, 1.2, 1],
            rotate: [0, -5, 0],
          }}
          transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
          className='absolute bottom-[10%] -right-[10%] w-[50%] h-[70%] rounded-full bg-gradient-to-tr from-emerald-200/20 to-teal-200/20 dark:from-emerald-900/10 dark:to-teal-900/10 blur-[120px]'
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
            欢迎回来，登录您的账户
          </motion.p>
        </div>

        <form onSubmit={handleSubmit} className='space-y-4'>
          <AnimatePresence mode='wait'>
            {shouldAskUsername && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3 }}
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
                    aria-label='账号或邮箱'
                    className='block w-full pl-10 pr-3 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm sm:text-base dark:text-gray-100'
                    placeholder='账号或邮箱'
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onFocus={() => setFocusedInput('username')}
                    onBlur={() => setFocusedInput(null)}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
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
                autoComplete='current-password'
                aria-label='访问密码'
                className='block w-full pl-10 pr-10 py-3 rounded-xl border-none bg-white dark:bg-zinc-900 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.05)] dark:shadow-none ring-1 ring-gray-200 dark:ring-zinc-800 focus:ring-2 focus:ring-gray-900 dark:focus:ring-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 transition-all text-sm sm:text-base dark:text-gray-100'
                placeholder='访问密码'
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
          </AnimatePresence>

          <motion.button
            type='submit'
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            disabled={!password || loading || (shouldAskUsername && !username)}
            className='relative w-full group overflow-hidden rounded-xl bg-gray-900 dark:bg-white text-white dark:text-black py-3.5 text-sm font-semibold shadow-lg shadow-gray-900/10 dark:shadow-white/5 hover:shadow-xl hover:scale-[1.01] active:scale-[0.99] transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed'
          >
            <div className='flex items-center justify-center gap-2'>
              {loading ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : (
                <>
                  <span>立即登录</span>
                  <ArrowRight className='w-4 h-4 group-hover:translate-x-1 transition-transform' />
                </>
              )}
            </div>
          </motion.button>

          {shouldAskUsername && registrationPolicy?.allowRegister && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className='text-center mt-6'
            >
              <a
                href='/register'
                className='group text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors'
              >
                还没有账户？{' '}
                <span className='underline underline-offset-4 decoration-gray-300 dark:decoration-zinc-700 hover:decoration-gray-900 dark:hover:decoration-white transition-all'>
                  注册新账户
                </span>
              </a>
            </motion.div>
          )}

          {shouldAskUsername && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.55 }}
              className='text-center mt-2'
            >
              <a
                href='/forgot-password'
                className='text-sm text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors'
              >
                忘记密码？
              </a>
            </motion.div>
          )}
        </form>

        {/* OIDC 登录 */}
        {oidcEnabled && shouldAskUsername && (
          <div className='mt-6 pt-6 border-t border-gray-200 dark:border-gray-700'>
            <div className='relative'>
              <div className='absolute inset-0 flex items-center'>
                <div className='w-full border-t border-gray-300 dark:border-gray-600'></div>
              </div>
              <div className='relative flex justify-center text-sm'>
                <span className='px-2 bg-white/60 dark:bg-zinc-900/60 text-gray-500 dark:text-gray-400'>
                  或
                </span>
              </div>
            </div>

            {/* 多 Provider 按钮 */}
            {oidcProviders.length > 0 ? (
              <div className='mt-4 space-y-3'>
                {oidcProviders.map((provider) => {
                  // 优先使用 provider.id，如果是自定义provider则从issuer推断
                  const providerId = provider.id.toLowerCase();
                  const detectedProvider = [
                    'google',
                    'github',
                    'microsoft',
                    'facebook',
                    'wechat',
                    'apple',
                    'linuxdo',
                  ].includes(providerId)
                    ? (providerId as
                        | 'google'
                        | 'github'
                        | 'microsoft'
                        | 'facebook'
                        | 'wechat'
                        | 'apple'
                        | 'linuxdo')
                    : detectProvider(provider.issuer || provider.buttonText);
                  const buttonStyle = getProviderButtonStyle(detectedProvider);
                  const customText =
                    provider.buttonText &&
                    provider.buttonText !== '使用OIDC登录'
                      ? provider.buttonText
                      : undefined;
                  const buttonText = getProviderButtonText(
                    detectedProvider,
                    customText,
                  );

                  return (
                    <button
                      key={provider.id}
                      type='button'
                      onClick={() =>
                        (window.location.href = `/api/auth/oidc/login?provider=${encodeURIComponent(provider.id)}`)
                      }
                      className={`w-full inline-flex justify-center items-center rounded-lg py-3 text-base font-semibold shadow-sm transition-all duration-200 ${buttonStyle}`}
                    >
                      <OIDCProviderLogo provider={detectedProvider} />
                      <span className='ml-2'>{buttonText}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              /* 单 Provider 按钮（向后兼容） */
              (() => {
                const provider = detectProvider(oidcIssuer || oidcButtonText);
                const buttonStyle = getProviderButtonStyle(provider);
                const customText =
                  oidcButtonText && oidcButtonText !== '使用OIDC登录'
                    ? oidcButtonText
                    : undefined;
                const buttonText = getProviderButtonText(provider, customText);

                return (
                  <button
                    type='button'
                    onClick={() =>
                      (window.location.href = '/api/auth/oidc/login')
                    }
                    className={`mt-4 w-full inline-flex justify-center items-center rounded-lg py-3 text-base font-semibold shadow-sm transition-all duration-200 ${buttonStyle}`}
                  >
                    <OIDCProviderLogo provider={provider} />
                    <span className='ml-2'>{buttonText}</span>
                  </button>
                );
              })()
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div
      translate='no'
      className='fixed inset-0 z-50 overflow-y-auto bg-gray-50 dark:bg-zinc-950'
    >
      <Suspense
        fallback={<div className='min-h-screen bg-gray-50 dark:bg-zinc-950' />}
      >
        <LoginPageClient />
      </Suspense>
    </div>
  );
}
