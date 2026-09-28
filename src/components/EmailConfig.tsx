'use client';

import { Check, Mail, Send, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { AdminConfig } from '@/lib/admin.types';

type EmailSettings = NonNullable<AdminConfig['EmailConfig']>;

// 邮箱配置组件 Props
interface EmailConfigProps {
  config: EmailSettings | null;
  onSave: (config: EmailSettings) => Promise<void>;
  onTest: (testEmail: string) => Promise<{ success: boolean; error?: string }>;
}

// 默认配置
const defaultConfig: EmailSettings = {
  enabled: false,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: '',
  smtpPass: '',
  senderName: '',
  senderEmail: '',
};

export default function EmailConfig({
  config,
  onSave,
  onTest,
}: EmailConfigProps) {
  const savedConfig = { ...defaultConfig, ...config };
  const savedConfigSnapshot = JSON.stringify(savedConfig);
  const [formData, setFormData] = useState(savedConfig);
  const [saveRevision, setSaveRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
  } | null>(null);
  const [saveResult, setSaveResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    // 按保存值同步，避免其他面板刷新时覆盖当前未保存的编辑。
    setFormData(JSON.parse(savedConfigSnapshot) as EmailSettings);
  }, [savedConfigSnapshot, saveRevision]);

  const hasUnsavedChanges = (
    Object.keys(defaultConfig) as Array<keyof typeof defaultConfig>
  ).some((key) => formData[key] !== savedConfig[key]);

  // 处理输入变更
  const handleChange = (
    field: keyof typeof defaultConfig,
    value: string | number | boolean,
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setSaveResult(null);
    setTestResult(null);
  };

  // 保存配置
  const handleSave = async () => {
    if (
      !Number.isInteger(formData.smtpPort) ||
      formData.smtpPort < 1 ||
      formData.smtpPort > 65535
    ) {
      setSaveResult({
        success: false,
        message: 'SMTP 端口必须是 1 到 65535 之间的整数',
      });
      return;
    }
    setLoading(true);
    setSaveResult(null);
    try {
      await onSave(formData);
      // 返回值相同时，也恢复服务端规范化和遮罩后的字段。
      setSaveRevision((revision) => revision + 1);
      setSaveResult({ success: true, message: '配置已保存' });
    } catch (error) {
      setSaveResult({
        success: false,
        message: error instanceof Error ? error.message : '保存失败',
      });
    } finally {
      setLoading(false);
    }
  };

  // 测试邮件发送
  const handleTest = async () => {
    if (hasUnsavedChanges) {
      setTestResult({ success: false, error: '请先保存配置，再发送测试邮件' });
      return;
    }
    if (!testEmail.trim()) {
      setTestResult({ success: false, error: '请输入测试邮箱地址' });
      return;
    }
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await onTest(testEmail.trim());
      setTestResult(result);
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : '发送测试邮件失败',
      });
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <fieldset
      aria-label='邮件通知配置'
      disabled={loading || testLoading}
      className='min-w-0 space-y-6'
    >
      {/* 启用开关 */}
      <div className='flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg'>
        <div>
          <h3 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            启用邮件通知
          </h3>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-0.5'>
            用于注册待审核、审核结果通知和密码重置邮件
          </p>
        </div>
        <button
          type='button'
          role='switch'
          aria-label='启用邮件通知'
          aria-checked={formData.enabled}
          onClick={() => handleChange('enabled', !formData.enabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            formData.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              formData.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* SMTP 配置 */}
      <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
        <div>
          <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
            SMTP 服务器
          </label>
          <input
            type='text'
            aria-label='SMTP 服务器'
            maxLength={253}
            value={formData.smtpHost}
            onChange={(e) => handleChange('smtpHost', e.target.value)}
            placeholder='例如: smtp.qq.com'
            className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent'
          />
        </div>
        <div>
          <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
            SMTP 端口
          </label>
          <input
            type='number'
            aria-label='SMTP 端口'
            min={1}
            max={65535}
            step={1}
            value={Number.isNaN(formData.smtpPort) ? '' : formData.smtpPort}
            onChange={(e) => handleChange('smtpPort', e.target.valueAsNumber)}
            className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent'
          />
        </div>
        <div>
          <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
            SMTP 用户名
          </label>
          <input
            type='text'
            aria-label='SMTP 用户名'
            autoComplete='off'
            maxLength={320}
            value={formData.smtpUser}
            onChange={(e) => handleChange('smtpUser', e.target.value)}
            placeholder='通常是邮箱地址'
            className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent'
          />
        </div>
        <div>
          <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
            SMTP 密码
          </label>
          <input
            type='password'
            aria-label='SMTP 密码'
            autoComplete='new-password'
            maxLength={4096}
            value={formData.smtpPass}
            onChange={(e) => handleChange('smtpPass', e.target.value)}
            placeholder='部分服务需要授权码'
            className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent'
          />
          <p className='mt-1 text-xs text-gray-500'>
            ****** 表示已保存密码，保持原样即可保留。
          </p>
        </div>
        <div>
          <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
            发件人名称
          </label>
          <input
            type='text'
            aria-label='发件人名称'
            maxLength={128}
            value={formData.senderName}
            onChange={(e) => handleChange('senderName', e.target.value)}
            placeholder='显示在邮件中的发件人名称'
            className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent'
          />
        </div>
        <div>
          <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
            发件人邮箱
          </label>
          <input
            type='email'
            aria-label='发件人邮箱'
            maxLength={254}
            value={formData.senderEmail}
            onChange={(e) => handleChange('senderEmail', e.target.value)}
            placeholder='发件邮箱地址'
            className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent'
          />
        </div>
      </div>

      {/* SSL/TLS 开关 */}
      <div className='flex items-center gap-3'>
        <button
          type='button'
          role='switch'
          aria-label='使用直连 SSL/TLS'
          aria-checked={formData.smtpSecure}
          onClick={() => handleChange('smtpSecure', !formData.smtpSecure)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            formData.smtpSecure ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              formData.smtpSecure ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
        <span className='text-sm text-gray-700 dark:text-gray-300'>
          使用直连 SSL/TLS（通常为 465 端口）
        </span>
      </div>

      {/* 保存按钮 */}
      <div className='flex items-center gap-4'>
        <button
          onClick={handleSave}
          disabled={loading || testLoading}
          className='flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors'
        >
          <Check className='w-4 h-4' />
          {loading ? '保存中...' : '保存配置'}
        </button>
        {saveResult && (
          <span
            role='status'
            className={`text-sm ${
              saveResult.success ? 'text-green-600' : 'text-red-600'
            }`}
          >
            {saveResult.message}
          </span>
        )}
      </div>

      {/* 测试邮件 */}
      <div className='pt-4 border-t border-gray-200 dark:border-gray-700'>
        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-3'>
          测试邮件发送
        </h4>
        <p className='mb-3 text-xs text-gray-500'>
          测试使用已保存的配置，修改后请先保存。带账号的非直连 TLS 连接使用
          STARTTLS 加密。
        </p>
        <div className='flex items-center gap-3'>
          <div className='relative flex-1'>
            <Mail className='absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400' />
            <input
              type='email'
              aria-label='测试邮箱地址'
              maxLength={254}
              value={testEmail}
              onChange={(e) => {
                setTestEmail(e.target.value);
                setTestResult(null);
              }}
              placeholder='输入测试邮箱'
              className='w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent'
            />
          </div>
          <button
            onClick={handleTest}
            disabled={
              testLoading || loading || !config?.enabled || hasUnsavedChanges
            }
            className='flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white text-sm font-medium rounded-lg transition-colors'
          >
            <Send className='w-4 h-4' />
            {testLoading ? '发送中...' : '发送测试'}
          </button>
        </div>
        {testResult && (
          <div
            role='status'
            className={`mt-3 p-3 rounded-lg text-sm flex items-center gap-2 ${
              testResult.success
                ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
            }`}
          >
            {testResult.success ? (
              <Check className='w-4 h-4' />
            ) : (
              <X className='w-4 h-4' />
            )}
            {testResult.success
              ? '测试邮件发送成功！'
              : testResult.error || '测试邮件发送失败'}
          </div>
        )}
        {!formData.enabled && (
          <p className='mt-2 text-xs text-gray-500'>请先启用邮件通知功能</p>
        )}
      </div>
    </fieldset>
  );
}
