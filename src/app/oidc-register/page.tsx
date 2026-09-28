'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  getRegistrationMode,
  validateRegistrationProfile,
} from '@/lib/account-policy';
import { CURRENT_VERSION } from '@/lib/version';
import { useRegistrationPolicy } from '@/hooks/useRegistrationPolicy';

import { useSite } from '@/components/SiteProvider';
import { ThemeToggle } from '@/components/ThemeToggle';

import RegisterDisabledPage from '@/app/register/RegisterDisabledPage';

function OIDCRegisterForm() {
  const router = useRouter();
  const { data: currentPolicy, refetch } = useRegistrationPolicy();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [source, setSource] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oidcInfo, setOidcInfo] = useState<{
    email?: string;
    name?: string;
    trust_level?: number;
    requireApproval: boolean;
    requireInviteCode: boolean;
  } | null>(null);
  const policy = currentPolicy ?? {
    allowRegister: true,
    requireApproval: oidcInfo?.requireApproval ?? false,
    requireInviteCode: oidcInfo?.requireInviteCode ?? false,
  };
  const showInviteCode = policy.requireApproval || policy.requireInviteCode;
  const activeInviteCode = showInviteCode ? inviteCode : '';
  const mode = getRegistrationMode(policy, activeInviteCode);
  const requireApproval = mode === 'approval';

  const { siteName } = useSite();

  // 检查OIDC session
  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch('/api/auth/oidc/session-info', {
          cache: 'no-store',
        });
        if (res.ok) {
          const data = await res.json();
          setOidcInfo(data);
          setEmail(data.email || '');
        } else {
          const data = await res.json().catch(() => ({}));
          router.replace(
            '/login?error=' +
              encodeURIComponent(data.error || 'OIDC会话已过期'),
          );
        }
      } catch (error) {
        console.error('检查session失败:', error);
        router.replace('/login');
      }
    };

    checkSession();
  }, [router]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!oidcInfo || loading || success) return;
    setError(null);

    if (!username) {
      setError('请输入用户名');
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

    try {
      setLoading(true);
      const res = await fetch('/api/auth/oidc/complete-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          email: profile.email,
          source: profile.source,
          inviteCode: profile.inviteCode,
        }),
      });

      if (res.ok) {
        const data = await res.json();

        // Pending accounts never receive a login cookie.
        if (data.pending) {
          setError(null);
          setSuccess('注册成功！请等待管理员审核，结果将通过邮件通知。');
          return;
        }
        setSuccess('注册成功！正在跳转...');

        // 不需要审核，Upstash 需要额外延迟等待数据同步
        const delay = data.needDelay ? 1500 : 0;

        setTimeout(() => {
          router.replace('/');
        }, delay);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || '注册失败');
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

  if (!oidcInfo) {
    return (
      <div className='relative min-h-screen flex items-center justify-center px-4'>
        <div className='text-gray-500 dark:text-gray-400'>加载中...</div>
      </div>
    );
  }

  return (
    <div
      translate='no'
      className='relative min-h-screen flex items-center justify-center px-4 py-8 overflow-hidden'
    >
      <div className='absolute top-4 right-4'>
        <ThemeToggle />
      </div>
      <div className='relative z-10 w-full max-w-md rounded-3xl bg-gradient-to-b from-white/90 via-white/70 to-white/40 dark:from-zinc-900/90 dark:via-zinc-900/70 dark:to-zinc-900/40 backdrop-blur-xl shadow-2xl p-10 dark:border dark:border-zinc-800'>
        <h1 className='text-green-600 tracking-tight text-center text-3xl font-extrabold mb-2 bg-clip-text drop-shadow-sm'>
          {siteName}
        </h1>
        <p className='text-center text-sm text-gray-600 dark:text-gray-400 mb-8'>
          完成OIDC注册
        </p>
        <p
          id='registration-mode'
          className='mb-6 text-center text-sm text-gray-600 dark:text-gray-400'
        >
          {mode === 'invite'
            ? '有效邀请码注册后直接登录，无需审核。邮箱选填。'
            : requireApproval
              ? '请填写邮箱和来源，提交后等待审核。也可使用有效邀请码免审核注册。'
              : '注册后直接登录，邮箱选填，可用于找回密码。'}
        </p>

        {/* OIDC信息显示 */}
        {oidcInfo && (
          <div className='mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg'>
            <p className='text-sm text-blue-700 dark:text-blue-400'>
              {oidcInfo.email && (
                <>
                  邮箱: <strong>{oidcInfo.email}</strong>
                  <br />
                </>
              )}
              {oidcInfo.name && (
                <>
                  名称: <strong>{oidcInfo.name}</strong>
                  <br />
                </>
              )}
              {oidcInfo.trust_level !== undefined && (
                <>
                  信任等级: <strong>{oidcInfo.trust_level}</strong>
                </>
              )}
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className='space-y-6'>
          <div>
            <label
              htmlFor='username'
              className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
            >
              选择用户名
            </label>
            <input
              id='username'
              type='text'
              autoComplete='username'
              className='block w-full rounded-lg border-0 py-3 px-4 text-gray-900 dark:text-gray-100 shadow-sm ring-1 ring-white/60 dark:ring-white/20 placeholder:text-gray-500 dark:placeholder:text-gray-400 focus:ring-2 focus:ring-green-500 focus:outline-none sm:text-base bg-white/60 dark:bg-zinc-800/60 backdrop-blur'
              placeholder='输入用户名（3-20位字母、数字、下划线）'
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
              用户名只能包含字母、数字、下划线，长度3-20位
            </p>
          </div>

          {showInviteCode && (
            <div>
              <label
                htmlFor='inviteCode'
                className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
              >
                {policy.requireInviteCode
                  ? '邀请码（必填）'
                  : '邀请码（选填，可免审核）'}
              </label>
              <input
                id='inviteCode'
                type='text'
                autoComplete='off'
                autoCapitalize='characters'
                spellCheck={false}
                required={policy.requireInviteCode}
                aria-describedby='registration-mode'
                value={inviteCode}
                onChange={(event) =>
                  setInviteCode(event.target.value.toUpperCase())
                }
                className='block w-full rounded-lg border-0 py-3 px-4 bg-white/60 dark:bg-zinc-800/60 text-gray-900 dark:text-gray-100 ring-1 ring-gray-200 dark:ring-zinc-700 focus:ring-2 focus:ring-green-500'
              />
            </div>
          )}

          <div>
            <label
              htmlFor='email'
              className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
            >
              邮箱{requireApproval ? '（审核必填）' : '（选填）'}
            </label>
            <input
              id='email'
              type='email'
              autoComplete='email'
              maxLength={254}
              required={requireApproval}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className='block w-full rounded-lg border-0 py-3 px-4 bg-white/60 dark:bg-zinc-800/60 text-gray-900 dark:text-gray-100 ring-1 ring-gray-200 dark:ring-zinc-700 focus:ring-2 focus:ring-green-500'
            />
          </div>
          {requireApproval && (
            <div>
              <label
                htmlFor='source'
                className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
              >
                来源（审核必填）
              </label>
              <input
                id='source'
                type='text'
                maxLength={500}
                required
                value={source}
                onChange={(event) => setSource(event.target.value)}
                className='block w-full rounded-lg border-0 py-3 px-4 bg-white/60 dark:bg-zinc-800/60 text-gray-900 dark:text-gray-100 ring-1 ring-gray-200 dark:ring-zinc-700 focus:ring-2 focus:ring-green-500'
              />
            </div>
          )}

          {error && (
            <p role='alert' className='text-sm text-red-600 dark:text-red-400'>
              {error}
            </p>
          )}
          {success && (
            <p
              role='status'
              className='text-sm text-green-600 dark:text-green-400'
            >
              {success}
            </p>
          )}

          <button
            type='submit'
            disabled={!username || loading || !!success}
            className='inline-flex w-full justify-center rounded-lg bg-green-600 py-3 text-base font-semibold text-white shadow-lg transition-all duration-200 hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50'
          >
            {loading
              ? '注册中...'
              : success
                ? '注册成功'
                : requireApproval
                  ? '提交审核申请'
                  : '完成注册'}
          </button>

          {/* 返回登录链接 */}
          <div className='text-center'>
            <a
              href='/login'
              className='text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors'
            >
              返回登录
            </a>
          </div>
        </form>

        {/* 版本信息 */}
        <div className='mt-8 text-center text-xs text-gray-500 dark:text-gray-400'>
          v{CURRENT_VERSION}
        </div>
      </div>
    </div>
  );
}

export default function OIDCRegisterPage() {
  return (
    <div
      translate='no'
      className='fixed inset-0 z-50 overflow-y-auto bg-gray-50 dark:bg-zinc-950'
    >
      <OIDCRegisterForm />
    </div>
  );
}
