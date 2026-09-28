'use client';

import { AlertCircle, CheckCircle, Plus, Server } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { AdminConfig } from '@/lib/admin.types';

import {
  AdminEmptyState,
  AdminSaveBar,
  AdminSection,
} from './admin/AdminPrimitives';
import { buttonStyles } from './admin/shared';

interface EmbyConfigProps {
  config: AdminConfig | null;
  refreshConfig: () => Promise<void>;
}

const EmbyConfig = ({ config, refreshConfig }: EmbyConfigProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [sources, setSources] = useState<any[]>([]);
  const [editingSource, setEditingSource] = useState<any | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // 表单状态
  const [formData, setFormData] = useState({
    key: '',
    name: '',
    enabled: true,
    isPublic: false,
    ServerURL: '',
    ApiKey: '',
    Username: '',
    Password: '',
    UserId: '',
    removeEmbyPrefix: false,
    appendMediaSourceId: false,
    transcodeMp4: false,
    proxyPlay: false,
    embyAuthorizationHeader: '',
  });
  const [authMode, setAuthMode] = useState<'apikey' | 'password'>('apikey');
  const formRef = useRef<HTMLDivElement>(null);

  // 从配置加载源列表
  useEffect(() => {
    if (config?.EmbyConfig?.Sources) {
      setSources(config.EmbyConfig.Sources);
    }
  }, [config?.EmbyConfig?.Sources]);

  // 显示消息
  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  // 重置表单
  const resetForm = () => {
    setFormData({
      key: '',
      name: '',
      enabled: true,
      isPublic: false,
      ServerURL: '',
      ApiKey: '',
      Username: '',
      Password: '',
      UserId: '',
      removeEmbyPrefix: false,
      appendMediaSourceId: false,
      transcodeMp4: false,
      proxyPlay: false,
      embyAuthorizationHeader: '',
    });
    setEditingSource(null);
    setShowAddForm(false);
    setAuthMode('apikey');
  };

  // 开始编辑
  const handleEdit = (source: any) => {
    setFormData({ ...source });
    if (source.ApiKey) {
      setAuthMode('apikey');
    } else if (source.Username) {
      setAuthMode('password');
    } else {
      setAuthMode('apikey');
    }
    setEditingSource(source);
    setShowAddForm(false);
  };

  // 开始添加
  const handleAdd = () => {
    resetForm();
    setShowAddForm(true);
  };

  // 保存源
  const handleSave = async () => {
    if (!formData.key || !formData.name || !formData.ServerURL) {
      showMessage('error', '请填写必填字段：标识符、名称、服务器地址');
      return;
    }

    // 根据认证方式验证必填字段
    if (authMode === 'apikey') {
      if (!formData.ApiKey) {
        showMessage('error', '使用密钥认证时，API Key 为必填项');
        return;
      }
    } else if (authMode === 'password') {
      if (!formData.Username) {
        showMessage('error', '使用账号认证时，用户名为必填项');
        return;
      }
    }

    if (!editingSource && sources.some((s) => s.key === formData.key)) {
      showMessage('error', '标识符已存在，请使用其他标识符');
      return;
    }

    setIsLoading(true);
    try {
      // 如果没有 UserId，先测试连接获取 UserId
      let dataToSave = { ...formData };
      if (!dataToSave.UserId) {
        const testResponse = await fetch('/api/admin/emby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'test',
            ServerURL: formData.ServerURL,
            ApiKey: formData.ApiKey,
            Username: formData.Username,
            Password: formData.Password,
          }),
        });

        const testResult = await testResponse.json();
        if (!testResult.success) {
          showMessage(
            'error',
            '连接测试失败，请检查配置: ' + (testResult.message || ''),
          );
          setIsLoading(false);
          return;
        }

        if (testResult.userId) {
          dataToSave.UserId = testResult.userId;
        }
      }

      let newSources;
      if (editingSource) {
        newSources = sources.map((s) =>
          s.key === editingSource.key ? dataToSave : s,
        );
      } else {
        newSources = [...sources, dataToSave];
      }

      const response = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          EmbyConfig: { Sources: newSources },
        }),
      });

      if (!response.ok) throw new Error('保存失败');

      await refreshConfig();
      resetForm();
      showMessage('success', editingSource ? '更新成功' : '添加成功');
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 删除源
  const handleDelete = async (source: any) => {
    if (!confirm(`确定要删除 "${source.name}" 吗？`)) return;

    setIsLoading(true);
    try {
      const newSources = sources.filter((s) => s.key !== source.key);

      const response = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          EmbyConfig: { Sources: newSources },
        }),
      });

      if (!response.ok) throw new Error('删除失败');

      await refreshConfig();
      showMessage('success', '删除成功');
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : '删除失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 切换启用状态
  const handleToggleEnabled = async (source: any) => {
    setIsLoading(true);
    try {
      const newSources = sources.map((s) =>
        s.key === source.key ? { ...s, enabled: !s.enabled } : s,
      );

      const response = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          EmbyConfig: { Sources: newSources },
        }),
      });

      if (!response.ok) throw new Error('更新失败');

      await refreshConfig();
      showMessage('success', source.enabled ? '已禁用' : '已启用');
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : '更新失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 测试连接
  const handleTest = async (source: any) => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/admin/emby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'test',
          ServerURL: source.ServerURL,
          ApiKey: source.ApiKey,
          Username: source.Username,
          Password: source.Password,
        }),
      });

      const result = await response.json();
      if (result.success) {
        // 如果测试成功且返回了 userId，更新 formData
        if (
          result.userId &&
          editingSource &&
          editingSource.key === source.key
        ) {
          setFormData((prev) => ({ ...prev, UserId: result.userId }));
        }
        showMessage('success', result.message || 'Emby 连接测试成功');
      } else {
        showMessage('error', result.message || 'Emby 连接测试失败');
      }
    } catch (err) {
      showMessage('error', '连接测试失败');
    } finally {
      setIsLoading(false);
    }
  };

  const revealForm = () => {
    requestAnimationFrame(() => {
      formRef.current?.focus({ preventScroll: true });
      formRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  };

  return (
    <div className='admin-module admin-stack'>
      {message && (
        <div
          className='admin-status-note flex items-start gap-2'
          role={message.type === 'error' ? 'alert' : 'status'}
        >
          {message.type === 'success' ? (
            <CheckCircle size={18} className='shrink-0' aria-hidden='true' />
          ) : (
            <AlertCircle size={18} className='shrink-0' aria-hidden='true' />
          )}
          <span className='min-w-0 break-words'>{message.text}</span>
        </div>
      )}

      {(showAddForm || editingSource) && (
        <div
          ref={formRef}
          tabIndex={-1}
          role='region'
          aria-label={editingSource ? '编辑 Emby 源' : '添加 Emby 源'}
          className='min-w-0 scroll-mt-24 outline-none'
        >
          <AdminSection
            title={editingSource ? '编辑 Emby 源' : '添加 Emby 源'}
            description='填写服务器和认证信息，连接已有的 Emby 媒体库。'
          >
            <div className='admin-stack'>
              <div className='admin-form-grid'>
                <div className='admin-field'>
                  <label htmlFor='admin-emby-key'>标识符 *</label>
                  <input
                    id='admin-emby-key'
                    type='text'
                    value={formData.key}
                    onChange={(e) =>
                      setFormData({ ...formData, key: e.target.value })
                    }
                    disabled={!!editingSource}
                    placeholder='home、office'
                    aria-required='true'
                  />
                  <p className='admin-field-hint'>
                    仅限字母、数字、下划线，创建后不可修改。
                  </p>
                </div>
                <div className='admin-field'>
                  <label htmlFor='admin-emby-name'>显示名称 *</label>
                  <input
                    id='admin-emby-name'
                    type='text'
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                    placeholder='例如：家庭媒体库'
                    aria-required='true'
                  />
                </div>
                <div className='admin-field admin-field-wide'>
                  <label htmlFor='admin-emby-server'>Emby 服务器地址 *</label>
                  <input
                    id='admin-emby-server'
                    type='url'
                    value={formData.ServerURL}
                    onChange={(e) =>
                      setFormData({ ...formData, ServerURL: e.target.value })
                    }
                    placeholder='https://emby.example.com/emby'
                    aria-required='true'
                  />
                  <p className='admin-field-hint'>
                    使用反向代理时，请包含完整路径。
                  </p>
                </div>
                <div className='admin-field admin-field-wide'>
                  <span id='admin-emby-auth-label'>认证方式 *</span>
                  <div
                    className='admin-toolbar-actions'
                    role='group'
                    aria-labelledby='admin-emby-auth-label'
                  >
                    <button
                      type='button'
                      aria-pressed={authMode === 'apikey'}
                      onClick={() => {
                        setAuthMode('apikey');
                        setFormData({
                          ...formData,
                          Username: '',
                          Password: '',
                        });
                      }}
                      className={
                        authMode === 'apikey'
                          ? buttonStyles.primary
                          : buttonStyles.secondary
                      }
                    >
                      密钥认证
                    </button>
                    <button
                      type='button'
                      aria-pressed={authMode === 'password'}
                      onClick={() => {
                        setAuthMode('password');
                        setFormData({ ...formData, ApiKey: '', UserId: '' });
                      }}
                      className={
                        authMode === 'password'
                          ? buttonStyles.primary
                          : buttonStyles.secondary
                      }
                    >
                      账号认证
                    </button>
                  </div>
                </div>
                {authMode === 'apikey' && (
                  <>
                    <div className='admin-field'>
                      <label htmlFor='admin-emby-api-key'>API Key *</label>
                      <input
                        id='admin-emby-api-key'
                        type='password'
                        autoComplete='new-password'
                        value={formData.ApiKey}
                        onChange={(e) =>
                          setFormData({ ...formData, ApiKey: e.target.value })
                        }
                        placeholder='在 Emby 控制台生成的 API 密钥'
                        aria-required='true'
                      />
                    </div>
                    <div className='admin-field'>
                      <label htmlFor='admin-emby-user-id'>
                        用户 ID（可选）
                      </label>
                      <input
                        id='admin-emby-user-id'
                        type='text'
                        value={formData.UserId}
                        onChange={(e) =>
                          setFormData({ ...formData, UserId: e.target.value })
                        }
                        placeholder='留空则自动获取'
                      />
                      <p className='admin-field-hint'>
                        默认获取当前认证用户的 ID，也可手动指定。
                      </p>
                    </div>
                  </>
                )}
                {authMode === 'password' && (
                  <>
                    <div className='admin-field'>
                      <label htmlFor='admin-emby-username'>用户名 *</label>
                      <input
                        id='admin-emby-username'
                        type='text'
                        value={formData.Username}
                        onChange={(e) =>
                          setFormData({ ...formData, Username: e.target.value })
                        }
                        placeholder='Emby 用户名'
                        aria-required='true'
                      />
                    </div>
                    <div className='admin-field'>
                      <label htmlFor='admin-emby-password'>密码（可选）</label>
                      <input
                        id='admin-emby-password'
                        type='password'
                        autoComplete='new-password'
                        value={formData.Password}
                        onChange={(e) =>
                          setFormData({ ...formData, Password: e.target.value })
                        }
                        placeholder='账号没有密码时可留空'
                      />
                    </div>
                  </>
                )}
              </div>

              <div className='admin-form-grid'>
                <div className='admin-toggle-row'>
                  <div>
                    <strong>启用此源</strong>
                    <p className='admin-field-hint'>保存后允许访问此媒体库。</p>
                  </div>
                  <button
                    type='button'
                    role='switch'
                    aria-label='启用此源'
                    aria-checked={formData.enabled ?? false}
                    onClick={() =>
                      setFormData({ ...formData, enabled: !formData.enabled })
                    }
                    className='admin-switch'
                  >
                    <span aria-hidden='true' />
                  </button>
                </div>
                <div className='admin-toggle-row'>
                  <div>
                    <strong>设为公共源</strong>
                    <p className='admin-field-hint'>
                      所有用户的私人媒体库将包含此源。
                    </p>
                  </div>
                  <button
                    type='button'
                    role='switch'
                    aria-label='设为公共源'
                    aria-checked={formData.isPublic ?? false}
                    onClick={() =>
                      setFormData({ ...formData, isPublic: !formData.isPublic })
                    }
                    className='admin-switch'
                  >
                    <span aria-hidden='true' />
                  </button>
                </div>
              </div>

              <details>
                <summary className='cursor-pointer text-sm font-medium'>
                  播放与高级选项
                </summary>
                <div className='admin-form-grid mt-4'>
                  {(
                    [
                      {
                        key: 'removeEmbyPrefix',
                        label: '移除 /emby 前缀',
                        description: '从播放链接中移除 /emby 路径前缀。',
                      },
                      {
                        key: 'appendMediaSourceId',
                        label: '拼接 MediaSourceId',
                        description: '获取媒体源标识并添加到播放链接。',
                      },
                      {
                        key: 'transcodeMp4',
                        label: '转码为 MP4',
                        description: '使用 stream.mp4 格式并移除 Static 参数。',
                      },
                      {
                        key: 'proxyPlay',
                        label: '视频播放代理',
                        description: '通过服务器代理播放视频。',
                      },
                    ] as const
                  ).map((option) => (
                    <div key={option.key} className='admin-toggle-row'>
                      <div>
                        <strong>{option.label}</strong>
                        <p className='admin-field-hint'>{option.description}</p>
                      </div>
                      <button
                        type='button'
                        role='switch'
                        aria-label={option.label}
                        aria-checked={formData[option.key] ?? false}
                        onClick={() =>
                          setFormData({
                            ...formData,
                            [option.key]: !formData[option.key],
                          })
                        }
                        className='admin-switch'
                      >
                        <span aria-hidden='true' />
                      </button>
                    </div>
                  ))}
                  <div className='admin-field admin-field-wide'>
                    <label htmlFor='admin-emby-authorization'>
                      自定义 X-Emby-Authorization
                    </label>
                    <input
                      id='admin-emby-authorization'
                      type='text'
                      value={formData.embyAuthorizationHeader}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          embyAuthorizationHeader: e.target.value,
                        })
                      }
                      placeholder='留空使用默认值'
                    />
                    <p className='admin-field-hint'>
                      需要自定义客户端标识时填写，留空使用默认认证请求标识。
                    </p>
                  </div>
                </div>
              </details>
            </div>
          </AdminSection>
          <AdminSaveBar description='确认连接信息后保存，配置将应用到此媒体源。'>
            <button
              type='button'
              onClick={resetForm}
              disabled={isLoading}
              className={buttonStyles.secondary}
            >
              取消
            </button>
            <button
              type='button'
              onClick={handleSave}
              disabled={isLoading}
              className={buttonStyles.primary}
            >
              {isLoading ? '保存中…' : '保存媒体源'}
            </button>
          </AdminSaveBar>
        </div>
      )}

      <AdminSection
        title='Emby 媒体源'
        description='管理已连接的媒体服务器及其访问方式。'
        action={
          <button
            type='button'
            onClick={() => {
              handleAdd();
              revealForm();
            }}
            disabled={isLoading || showAddForm}
            className={buttonStyles.primary}
          >
            <Plus size={16} aria-hidden='true' /> 添加媒体源
          </button>
        }
      >
        {sources.length === 0 ? (
          <AdminEmptyState
            title='尚未添加 Emby 源'
            description='连接一台 Emby 服务器，集中管理私人或公共媒体库。'
            icon={Server}
          />
        ) : (
          <div className='admin-stack'>
            {sources.map((source) => (
              <div key={source.key} className='admin-toolbar'>
                <div className='min-w-0 flex-1'>
                  <div className='flex min-w-0 flex-wrap items-center gap-2'>
                    <h3 className='min-w-0 break-all text-sm font-semibold'>
                      {source.name}
                    </h3>
                    <span
                      className={`admin-status-badge ${source.enabled ? 'is-enabled' : ''}`}
                    >
                      {source.enabled ? '已启用' : '已禁用'}
                    </span>
                    {source.isPublic && (
                      <span className='admin-status-badge'>公共源</span>
                    )}
                  </div>
                  <p className='admin-table-meta'>标识符：{source.key}</p>
                  <p className='admin-table-meta break-all'>
                    {source.ServerURL}
                  </p>
                </div>
                <div className='admin-toolbar-actions'>
                  <button
                    type='button'
                    onClick={() => handleToggleEnabled(source)}
                    disabled={isLoading}
                    className={buttonStyles.secondarySmall}
                  >
                    {source.enabled ? '禁用' : '启用'}
                  </button>
                  <button
                    type='button'
                    onClick={() => handleTest(source)}
                    disabled={isLoading}
                    className={buttonStyles.primarySmall}
                  >
                    测试
                  </button>
                  <button
                    type='button'
                    onClick={() => {
                      handleEdit(source);
                      revealForm();
                    }}
                    disabled={isLoading}
                    className={buttonStyles.primarySmall}
                  >
                    编辑
                  </button>
                  <button
                    type='button'
                    onClick={() => handleDelete(source)}
                    disabled={isLoading}
                    className={buttonStyles.roundedDanger}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </AdminSection>
    </div>
  );
};

export default EmbyConfig;
