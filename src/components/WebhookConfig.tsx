'use client';

import { Bell, Send, Shield } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { AdminConfig } from '@/lib/admin.types';

// Webhook 配置类型
type WebhookConfigType = NonNullable<AdminConfig['WebhookConfig']>;

// 组件 Props
interface WebhookConfigProps {
  config: WebhookConfigType | null;
  onSave: (config: WebhookConfigType) => Promise<void>;
  onTest?: (url: string) => Promise<{ success: boolean; error?: string }>;
}

const defaultConfig: WebhookConfigType = {
  enabled: false,
  url: '',
  secret: '',
  notifyOnRegister: true,
  messageTemplate: '',
};

export default function WebhookConfig({
  config,
  onSave,
  onTest,
}: WebhookConfigProps) {
  const savedConfig = { ...defaultConfig, ...config };
  const savedConfigSnapshot = JSON.stringify(savedConfig);
  const [formData, setFormData] = useState<WebhookConfigType>(savedConfig);
  const [saveRevision, setSaveRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    // 按保存值同步，避免其他面板刷新时覆盖当前未保存的编辑。
    setFormData(JSON.parse(savedConfigSnapshot) as WebhookConfigType);
  }, [savedConfigSnapshot, saveRevision]);

  const hasUnsavedChanges = (
    Object.keys(defaultConfig) as Array<keyof WebhookConfigType>
  ).some((key) => formData[key] !== savedConfig[key]);

  const handleChange = <K extends keyof WebhookConfigType>(
    field: K,
    value: WebhookConfigType[K],
  ) => {
    setFormData((previous) => ({ ...previous, [field]: value }));
    setMessage(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await onSave(formData);
      // 返回值相同时，也恢复服务端规范化和遮罩后的字段。
      setSaveRevision((revision) => revision + 1);
      setMessage({ type: 'success', text: '配置保存成功' });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '保存失败',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!formData.url || !onTest) return;
    if (hasUnsavedChanges) {
      setMessage({ type: 'error', text: '请先保存配置，再发送测试通知' });
      return;
    }
    setTesting(true);
    setMessage(null);
    try {
      const result = await onTest(formData.url);
      if (result.success) {
        setMessage({ type: 'success', text: '测试消息发送成功' });
      } else {
        setMessage({ type: 'error', text: result.error || '测试失败' });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '测试失败',
      });
    } finally {
      setTesting(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent';

  return (
    <fieldset
      aria-label='Webhook 通知配置'
      disabled={saving || testing}
      className='min-w-0 space-y-6'
    >
      {/* 启用开关 */}
      <div className='flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg'>
        <div className='flex items-center gap-3'>
          <div className='p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg'>
            <Bell className='w-5 h-5 text-blue-600 dark:text-blue-400' />
          </div>
          <div>
            <div className='font-medium text-gray-900 dark:text-gray-100'>
              启用 Webhook 通知
            </div>
            <div className='text-sm text-gray-500 dark:text-gray-400'>
              通过 Webhook 向管理员发送通知
            </div>
          </div>
        </div>
        <button
          type='button'
          role='switch'
          aria-label='启用 Webhook 通知'
          aria-checked={formData.enabled}
          onClick={() => handleChange('enabled', !formData.enabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
            formData.enabled ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition duration-200 ease-in-out ${
              formData.enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {formData.enabled && (
        <>
          {/* Webhook URL */}
          <div className='space-y-2'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
              Webhook URL
            </label>
            <div className='flex gap-2'>
              <input
                type='url'
                aria-label='Webhook URL'
                maxLength={8192}
                value={formData.url}
                onChange={(e) => handleChange('url', e.target.value)}
                placeholder='https://example.com/webhook'
                className={inputClass}
              />
              {onTest && (
                <button
                  onClick={handleTest}
                  disabled={
                    !config?.enabled ||
                    !formData.url ||
                    hasUnsavedChanges ||
                    testing ||
                    saving
                  }
                  className='px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:bg-gray-400 rounded-lg transition-colors flex items-center gap-2'
                >
                  <Send className='w-4 h-4' />
                  {testing ? '测试中...' : '测试'}
                </button>
              )}
            </div>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              支持变量: {'{message}'} - URL 包含变量时使用 GET 请求，否则使用
              POST 请求
            </p>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              测试使用已保存的配置，修改后请先保存。
            </p>
          </div>

          {/* 消息模板 */}
          <div className='space-y-2'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
              消息模板（可选）
            </label>
            <textarea
              aria-label='Webhook 消息模板'
              maxLength={10000}
              value={formData.messageTemplate}
              onChange={(e) => handleChange('messageTemplate', e.target.value)}
              placeholder='[新用户注册待审核]&#10;用户名: {username}&#10;邮箱: {email}&#10;申请理由: {source}'
              rows={4}
              className='w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono'
            />
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              用于 URL 的 {'{message}'} 变量。支持 {'{username}'} {'{email}'}{' '}
              {'{source}'}，留空使用默认格式。
            </p>
          </div>

          {/* 签名密钥 */}
          <div className='space-y-2'>
            <label className='flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300'>
              <Shield className='w-4 h-4' />
              签名密钥（可选，仅 POST 方式）
            </label>
            <input
              type='password'
              aria-label='Webhook 签名密钥'
              autoComplete='new-password'
              maxLength={4096}
              value={formData.secret}
              onChange={(e) => handleChange('secret', e.target.value)}
              placeholder='用于验证请求来源的密钥'
              className={inputClass}
            />
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              POST 请求使用 HMAC-SHA256 签名。******
              表示已保存密钥，保持原样即可保留。
            </p>
          </div>

          {/* 通知类型 */}
          <div className='space-y-3'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
              通知类型
            </label>
            <label className='flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg cursor-pointer'>
              <input
                type='checkbox'
                checked={formData.notifyOnRegister}
                onChange={(e) =>
                  handleChange('notifyOnRegister', e.target.checked)
                }
                className='w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500'
              />
              <div>
                <div className='font-medium text-gray-900 dark:text-gray-100'>
                  新用户注册待审核
                </div>
                <div className='text-sm text-gray-500 dark:text-gray-400'>
                  有新用户注册并等待审核时发送通知
                </div>
              </div>
            </label>
          </div>
        </>
      )}

      {/* 消息提示 */}
      {message && (
        <div
          role='status'
          className={`p-3 rounded-lg text-sm ${
            message.type === 'success'
              ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
              : 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* 保存按钮 */}
      <div className='flex justify-end'>
        <button
          onClick={handleSave}
          disabled={saving || testing}
          className='px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 rounded-lg transition-colors'
        >
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>
    </fieldset>
  );
}
