/* eslint-disable no-console */
'use client';

import {
  Ban,
  Check,
  CheckCircle,
  Copy,
  Plus,
  RefreshCw,
  Ticket,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import {
  CUSTOM_INVITE_CODE_MAX_LENGTH,
  parseCustomInviteCode,
} from '@/lib/invite-code-policy';

import { createPortal } from '@/components/admin/AdminPortal';

interface InviteCode {
  code: string;
  createdBy: string;
  createdAt: string;
  maxUses: number;
  currentUses: number;
  remainingUses: number;
  expiresAt: string;
  expired: boolean;
  disabled: boolean;
  status: 'active' | 'used_up' | 'expired' | 'disabled';
  users: string[];
}

const buttonStyles = {
  primary:
    'px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors',
  success:
    'px-3 py-1.5 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors',
  danger:
    'px-3 py-1.5 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors',
  secondary:
    'px-3 py-1.5 text-sm font-medium bg-gray-600 hover:bg-gray-700 text-white rounded-lg transition-colors',
  dangerSmall:
    'px-2 py-1 text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors',
};

export default function InviteCodeManager() {
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [customCode, setCustomCode] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creationInFlight = useRef(false);
  const [maxUses, setMaxUses] = useState(10);
  const [expiresIn, setExpiresIn] = useState(7); // 天数
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // 加载邀请码列表
  const fetchCodes = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/invites');
      const data = await res.json();
      if (data.ok) {
        setCodes(data.codes);
      }
    } catch (error) {
      console.error('加载邀请码失败:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCodes();
  }, []);

  const closeCreateModal = () => {
    if (creationInFlight.current) return;
    setShowCreateModal(false);
    setCreateError(null);
  };

  // 留空随机生成，填写后使用自定义邀请码。
  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creationInFlight.current) return;
    setCreateError(null);
    const parsed = parseCustomInviteCode(customCode);
    if (parsed.error) {
      setCreateError(parsed.error);
      return;
    }
    creationInFlight.current = true;
    setCreating(true);
    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: parsed.code || undefined,
          maxUses,
          expiresIn: expiresIn * 86400, // 转换为秒
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setShowCreateModal(false);
        setCustomCode('');
        await fetchCodes();
        // 自动复制新生成的邀请码
        try {
          await navigator.clipboard.writeText(data.code);
          setCopiedCode(data.code);
          setTimeout(() => setCopiedCode(null), 2000);
        } catch {
          // 剪贴板权限被拒绝时不影响主流程
        }
      } else {
        setCreateError(data.error || '创建邀请码失败');
      }
    } catch (error) {
      console.error('创建邀请码失败:', error);
      setCreateError('创建邀请码失败，请稍后重试');
    } finally {
      creationInFlight.current = false;
      setCreating(false);
    }
  };

  // 删除邀请码
  const handleDelete = async (code: string) => {
    if (!confirm(`确定要删除邀请码 ${code} 吗？`)) {
      return;
    }

    try {
      setLoading(true);
      const res = await fetch(
        `/api/admin/invites?code=${encodeURIComponent(code)}`,
        {
          method: 'DELETE',
        },
      );
      const data = await res.json();
      if (data.ok) {
        await fetchCodes();
      } else {
        alert(data.error || '删除邀请码失败');
      }
    } catch (error) {
      console.error('删除邀请码失败:', error);
      alert('删除邀请码失败');
    } finally {
      setLoading(false);
    }
  };

  // 禁用/启用邀请码
  const handleToggle = async (code: string, disabled: boolean) => {
    try {
      setLoading(true);
      const res = await fetch(
        `/api/admin/invites?code=${encodeURIComponent(code)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled }),
        },
      );
      const data = await res.json();
      if (data.ok) {
        await fetchCodes();
      } else {
        alert(data.error || '操作失败');
      }
    } catch (error) {
      console.error('切换邀请码状态失败:', error);
      alert('操作失败');
    } finally {
      setLoading(false);
    }
  };

  // 复制邀请码
  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (error) {
      console.error('复制失败:', error);
    }
  };

  // 格式化日期
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className='space-y-4'>
      {/* 头部操作栏 */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <Ticket className='text-blue-500' size={20} />
          <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
            邀请码管理
          </h3>
          <span className='text-sm text-gray-500 dark:text-gray-400'>
            (共 {codes.length} 个邀请码)
          </span>
        </div>
        <div className='flex gap-2'>
          <button
            onClick={fetchCodes}
            disabled={loading}
            className={buttonStyles.secondary}
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className={buttonStyles.success}
          >
            <Plus size={16} className='inline mr-1' />
            创建邀请码
          </button>
        </div>
      </div>

      {/* 邀请码列表 */}
      <div className='overflow-x-auto'>
        <table className='w-full text-sm'>
          <thead className='bg-gray-50 dark:bg-gray-800'>
            <tr>
              <th className='px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300'>
                邀请码
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300'>
                创建者
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300'>
                使用情况
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300'>
                创建时间
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300'>
                过期时间
              </th>
              <th className='px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300'>
                状态
              </th>
              <th className='px-4 py-3 text-right font-medium text-gray-700 dark:text-gray-300'>
                操作
              </th>
            </tr>
          </thead>
          <tbody className='divide-y divide-gray-200 dark:divide-gray-700'>
            {codes.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className='px-4 py-8 text-center text-gray-500 dark:text-gray-400'
                >
                  暂无邀请码，点击“创建邀请码”添加
                </td>
              </tr>
            ) : (
              codes.map((code) => (
                <tr
                  key={code.code}
                  className='hover:bg-gray-50 dark:hover:bg-gray-800/50'
                >
                  <td className='px-4 py-3'>
                    <div className='flex items-center gap-2'>
                      <code className='min-w-0 max-w-64 break-all px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded font-mono text-sm'>
                        {code.code}
                      </code>
                      <button
                        onClick={() => handleCopy(code.code)}
                        className='shrink-0 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400'
                        title='复制'
                      >
                        {copiedCode === code.code ? (
                          <Check size={16} className='text-green-600' />
                        ) : (
                          <Copy size={16} />
                        )}
                      </button>
                    </div>
                  </td>
                  <td className='px-4 py-3 text-gray-700 dark:text-gray-300'>
                    {code.createdBy}
                  </td>
                  <td className='px-4 py-3'>
                    <div className='flex items-center gap-2'>
                      <span className='text-gray-700 dark:text-gray-300'>
                        {code.currentUses} / {code.maxUses}
                      </span>
                      <div className='w-20 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden'>
                        <div
                          className='h-full bg-blue-600 transition-all'
                          style={{
                            width: `${(code.currentUses / code.maxUses) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className='px-4 py-3 text-gray-600 dark:text-gray-400 text-xs'>
                    {formatDate(code.createdAt)}
                  </td>
                  <td className='px-4 py-3 text-gray-600 dark:text-gray-400 text-xs'>
                    {formatDate(code.expiresAt)}
                  </td>
                  <td className='px-4 py-3'>
                    {code.status === 'disabled' ? (
                      <span className='px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'>
                        已禁用
                      </span>
                    ) : code.status === 'expired' ? (
                      <span className='px-2 py-1 text-xs rounded-full bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'>
                        已过期
                      </span>
                    ) : code.status === 'used_up' ? (
                      <span className='px-2 py-1 text-xs rounded-full bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200'>
                        已用完
                      </span>
                    ) : (
                      <span className='px-2 py-1 text-xs rounded-full bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'>
                        可用
                      </span>
                    )}
                  </td>
                  <td className='px-4 py-3 text-right'>
                    <div className='flex items-center justify-end gap-2'>
                      {code.status !== 'expired' &&
                        code.status !== 'used_up' && (
                          <button
                            onClick={() =>
                              handleToggle(code.code, !code.disabled)
                            }
                            className={
                              code.disabled
                                ? buttonStyles.success
                                    .replace('px-3 py-1.5', 'px-2 py-1')
                                    .replace('text-sm', 'text-xs')
                                : buttonStyles.secondary
                                    .replace('px-3 py-1.5', 'px-2 py-1')
                                    .replace('text-sm', 'text-xs')
                            }
                            disabled={loading}
                            title={code.disabled ? '启用' : '禁用'}
                          >
                            {code.disabled ? (
                              <CheckCircle size={14} />
                            ) : (
                              <Ban size={14} />
                            )}
                          </button>
                        )}
                      <button
                        onClick={() => handleDelete(code.code)}
                        className={buttonStyles.dangerSmall}
                        disabled={loading}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 创建邀请码模态框 */}
      {showCreateModal &&
        createPortal(
          <div
            className='fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4'
            onClick={closeCreateModal}
          >
            <form
              role='dialog'
              aria-modal='true'
              aria-labelledby='invite-code-dialog-title'
              onSubmit={handleCreate}
              className='bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto transform transition-all'
              onClick={(e) => e.stopPropagation()}
            >
              <div className='flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700'>
                <h3
                  id='invite-code-dialog-title'
                  className='text-xl font-semibold text-gray-900 dark:text-gray-100'
                >
                  创建邀请码
                </h3>
                <button
                  type='button'
                  aria-label='关闭创建邀请码'
                  onClick={closeCreateModal}
                  disabled={creating}
                  className='text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors'
                >
                  <X size={24} />
                </button>
              </div>

              <div className='p-6 space-y-5'>
                <div>
                  <label
                    htmlFor='custom-invite-code'
                    className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
                  >
                    自定义邀请码（选填）
                  </label>
                  <input
                    id='custom-invite-code'
                    type='text'
                    value={customCode}
                    onChange={(event) => {
                      setCustomCode(event.target.value);
                      setCreateError(null);
                    }}
                    maxLength={CUSTOM_INVITE_CODE_MAX_LENGTH}
                    autoComplete='off'
                    autoCapitalize='characters'
                    spellCheck={false}
                    placeholder='留空自动生成，例如 MIAO-2026'
                    aria-describedby='custom-invite-code-hint'
                    disabled={creating}
                    className='w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all'
                  />
                  <p
                    id='custom-invite-code-hint'
                    className='mt-1.5 text-xs text-gray-500 dark:text-gray-400'
                  >
                    4–32
                    位字母、数字、短横线（-）或下划线（_），不区分大小写。留空生成
                    8 位随机邀请码。
                  </p>
                </div>

                <div>
                  <label
                    htmlFor='invite-max-uses'
                    className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
                  >
                    最大使用次数
                  </label>
                  <input
                    id='invite-max-uses'
                    type='number'
                    required
                    disabled={creating}
                    min='1'
                    max='1000'
                    value={maxUses}
                    onChange={(e) => setMaxUses(Number(e.target.value))}
                    className='w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all'
                  />
                  <p className='mt-1.5 text-xs text-gray-500 dark:text-gray-400'>
                    每个邀请码可以被使用的次数（1-1000）
                  </p>
                </div>

                <div>
                  <label
                    htmlFor='invite-expires-days'
                    className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
                  >
                    有效期（天）
                  </label>
                  <input
                    id='invite-expires-days'
                    type='number'
                    required
                    disabled={creating}
                    min='1'
                    max='365'
                    value={expiresIn}
                    onChange={(e) => setExpiresIn(Number(e.target.value))}
                    className='w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all'
                  />
                  <p className='mt-1.5 text-xs text-gray-500 dark:text-gray-400'>
                    邀请码的有效期限（1-365天）
                  </p>
                </div>
                {createError && (
                  <p
                    role='alert'
                    className='text-sm text-red-600 dark:text-red-400'
                  >
                    {createError}
                  </p>
                )}
              </div>

              <div className='flex gap-3 p-6 border-t border-gray-200 dark:border-gray-700'>
                <button
                  type='submit'
                  disabled={creating}
                  className={
                    buttonStyles.success +
                    ' flex-1 disabled:opacity-50 disabled:cursor-not-allowed'
                  }
                >
                  {creating ? '创建中...' : '创建邀请码'}
                </button>
                <button
                  type='button'
                  onClick={closeCreateModal}
                  disabled={creating}
                  className={
                    buttonStyles.secondary +
                    ' disabled:opacity-50 disabled:cursor-not-allowed'
                  }
                >
                  取消
                </button>
              </div>
            </form>
          </div>,
          document.body,
        )}
    </div>
  );
}
