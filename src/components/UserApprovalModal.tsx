/* eslint-disable no-console */

'use client';

import { Check, Clock, Mail, MessageSquare, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { createPortal } from '@/components/admin/AdminPortal';

// 待审核用户类型
interface PendingUser {
  uid?: string;
  username: string;
  email?: string;
  source?: string;
  createdAt?: number;
  pending?: boolean;
}

// 组件 Props
interface UserApprovalModalProps {
  isOpen: boolean;
  onClose: () => void;
  pendingUsers: PendingUser[];
  onApprove: (uid: string) => Promise<void>;
  onReject: (uid: string, reason?: string) => Promise<void>;
  onRefresh: () => void;
}

export default function UserApprovalModal({
  isOpen,
  onClose,
  pendingUsers,
  onApprove,
  onReject,
  onRefresh,
}: UserApprovalModalProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [rejectUser, setRejectUser] = useState<Pick<
    PendingUser,
    'uid' | 'username'
  > | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  if (!isOpen || !mounted) return null;

  // 审核通过
  const handleApprove = async (user: PendingUser) => {
    if (!user.uid) return;
    const uid = user.uid;
    setLoading(uid + '_approve');
    try {
      await onApprove(uid);
      onRefresh();
    } catch (error) {
      console.error('审核通过失败:', error);
    } finally {
      setLoading(null);
    }
  };

  // 开始拒绝流程
  const handleStartReject = (user: PendingUser) => {
    if (!user.uid) return;
    setRejectUser({ uid: user.uid, username: user.username });
    setRejectReason('');
  };

  // 确认拒绝
  const handleConfirmReject = async () => {
    if (!rejectUser?.uid) return;
    const uid = rejectUser.uid;
    setLoading(uid + '_reject');
    try {
      await onReject(uid, rejectReason || undefined);
      setRejectUser(null);
      setRejectReason('');
      onRefresh();
    } catch (error) {
      console.error('审核拒绝失败:', error);
    } finally {
      setLoading(null);
    }
  };

  // 格式化时间
  const formatDate = (timestamp?: number) => {
    if (!timestamp) return '未知';
    return new Date(timestamp).toLocaleString('zh-CN');
  };

  return createPortal(
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm'>
      <div className='relative w-full max-w-2xl max-h-[80vh] bg-white dark:bg-gray-800 rounded-2xl shadow-2xl overflow-hidden'>
        {/* 头部 */}
        <div className='flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700'>
          <div className='flex items-center gap-3'>
            <div className='p-2 bg-yellow-100 dark:bg-yellow-900/30 rounded-lg'>
              <Clock className='w-5 h-5 text-yellow-600 dark:text-yellow-400' />
            </div>
            <div>
              <h2 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                待审核用户
              </h2>
              <p className='text-sm text-gray-500 dark:text-gray-400'>
                共 {pendingUsers.length} 个用户等待审核
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className='p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors'
          >
            <X className='w-5 h-5' />
          </button>
        </div>

        {/* 列表 */}
        <div className='overflow-y-auto max-h-[60vh] p-4 space-y-3'>
          {pendingUsers.length === 0 ? (
            <div className='text-center py-12 text-gray-500 dark:text-gray-400'>
              <Check className='w-12 h-12 mx-auto mb-3 text-green-500' />
              <p>暂无待审核用户</p>
            </div>
          ) : (
            pendingUsers.map((user) => (
              <div
                key={user.uid || `unassigned-${user.username}`}
                className='p-4 bg-gray-50 dark:bg-gray-700/50 rounded-xl border border-gray-200 dark:border-gray-600'
              >
                <div className='flex items-start justify-between'>
                  {/* 用户信息 */}
                  <div className='flex-1'>
                    <div className='flex items-center gap-2 mb-2'>
                      <span className='font-medium text-gray-900 dark:text-gray-100'>
                        {user.username}
                      </span>
                      {user.pending && (
                        <span className='px-2 py-0.5 text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300 rounded-full'>
                          待审核
                        </span>
                      )}
                    </div>
                    <div className='space-y-1 text-sm text-gray-500 dark:text-gray-400'>
                      {user.email && (
                        <div className='flex items-center gap-2'>
                          <Mail className='w-3.5 h-3.5' />
                          <span>{user.email}</span>
                        </div>
                      )}
                      {user.source && (
                        <div className='flex items-center gap-2'>
                          <MessageSquare className='w-3.5 h-3.5' />
                          <span>来源: {user.source}</span>
                        </div>
                      )}
                      {user.createdAt && (
                        <div className='flex items-center gap-2'>
                          <Clock className='w-3.5 h-3.5' />
                          <span>注册时间: {formatDate(user.createdAt)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className='flex items-center gap-2'>
                    <button
                      onClick={() => handleApprove(user)}
                      disabled={!user.uid || Boolean(loading)}
                      className='flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:bg-green-400 rounded-lg transition-colors'
                    >
                      <Check className='w-4 h-4' />
                      {loading === user.uid + '_approve' ? '处理中...' : '通过'}
                    </button>
                    <button
                      onClick={() => handleStartReject(user)}
                      disabled={!user.uid || Boolean(loading)}
                      className='flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 rounded-lg transition-colors'
                    >
                      <X className='w-4 h-4' />
                      拒绝
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 拒绝原因弹窗 */}
      {rejectUser && (
        <div className='fixed inset-0 z-60 flex items-center justify-center bg-black/30'>
          <div className='w-full max-w-md bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-6'>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
              拒绝用户 {rejectUser.username}
            </h3>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder='可选：输入拒绝原因（会发送给用户）'
              className='w-full h-24 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 resize-none focus:ring-2 focus:ring-red-500 focus:border-transparent'
            />
            <div className='flex justify-end gap-3 mt-4'>
              <button
                onClick={() => setRejectUser(null)}
                className='px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-lg transition-colors'
              >
                取消
              </button>
              <button
                onClick={handleConfirmReject}
                disabled={loading === rejectUser.uid + '_reject'}
                className='px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 rounded-lg transition-colors'
              >
                {loading === rejectUser.uid + '_reject'
                  ? '处理中...'
                  : '确认拒绝'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
