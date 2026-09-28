'use client';

import { useEffect, useState } from 'react';

import { AdminConfig } from '@/lib/admin.types';

import { AdminEmptyState, AdminSaveBar, AdminSection } from './AdminPrimitives';
import {
  AlertModal,
  showError,
  showSuccess,
  useAlertModal,
  useLoadingState,
} from './shared';

const ConfigFileComponent = ({
  config,
  refreshConfig,
}: {
  config: AdminConfig | null;
  refreshConfig: () => Promise<void>;
}) => {
  const { alertModal, showAlert, hideAlert } = useAlertModal();
  const { isLoading, withLoading } = useLoadingState();
  const [configContent, setConfigContent] = useState('');
  const [subscriptionUrl, setSubscriptionUrl] = useState('');
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [lastCheckTime, setLastCheckTime] = useState<string>('');

  const savedConfigFile = config?.ConfigFile;
  const savedSubscription = config?.ConfigSubscribtion;

  useEffect(() => {
    setConfigContent(savedConfigFile || '');
  }, [savedConfigFile]);

  useEffect(() => {
    setSubscriptionUrl(savedSubscription?.URL || '');
    setAutoUpdate(savedSubscription?.AutoUpdate ?? false);
    setLastCheckTime(savedSubscription?.LastCheck || '');
  }, [savedSubscription]);

  const hasUnsavedChanges =
    configContent !== (savedConfigFile || '') ||
    subscriptionUrl !== (savedSubscription?.URL || '') ||
    autoUpdate !== (savedSubscription?.AutoUpdate ?? false) ||
    lastCheckTime !== (savedSubscription?.LastCheck || '');

  // 拉取订阅配置
  const handleFetchConfig = async () => {
    if (!subscriptionUrl.trim()) {
      showError('请输入订阅URL', showAlert);
      return;
    }

    await withLoading('fetchConfig', async () => {
      try {
        const resp = await fetch('/api/admin/config_subscription/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: subscriptionUrl }),
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.error || `拉取失败: ${resp.status}`);
        }

        const data = await resp.json();
        if (data.configContent) {
          setConfigContent(data.configContent);
          // 更新本地配置的最后检查时间
          const currentTime = new Date().toISOString();
          setLastCheckTime(currentTime);
          showSuccess('配置拉取成功', showAlert);
        } else {
          showError('拉取失败：未获取到配置内容', showAlert);
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : '拉取失败', showAlert);
        throw err;
      }
    });
  };

  // 保存配置文件
  const handleSave = async () => {
    await withLoading('saveConfig', async () => {
      try {
        const resp = await fetch('/api/admin/config_file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            configFile: configContent,
            subscriptionUrl,
            autoUpdate,
            lastCheckTime: lastCheckTime || new Date().toISOString(),
          }),
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.error || `保存失败: ${resp.status}`);
        }

        showSuccess('配置文件保存成功', showAlert);
        await refreshConfig();
      } catch (err) {
        showError(err instanceof Error ? err.message : '保存失败', showAlert);
        throw err;
      }
    });
  };

  if (!config) {
    return (
      <AdminEmptyState
        title='正在加载配置文件'
        description='正在读取配置文件与订阅设置，请稍候。'
      />
    );
  }

  return (
    <div className='admin-stack'>
      <div className='admin-config-grid'>
        <AdminSection
          title='配置订阅'
          description='从订阅地址获取视频源与自定义分类。'
        >
          <div className='admin-stack'>
            <div className='admin-field'>
              <label htmlFor='admin-config-subscription'>订阅 URL</label>
              <input
                id='admin-config-subscription'
                type='url'
                value={subscriptionUrl}
                onChange={(event) => setSubscriptionUrl(event.target.value)}
                placeholder='https://example.com/config.json'
                className='admin-input'
                aria-describedby='admin-config-subscription-description'
              />
              <p
                id='admin-config-subscription-description'
                className='admin-field-hint'
              >
                订阅内容为 JSON 格式，使用 Base58 编码。
              </p>
            </div>

            <button
              type='button'
              onClick={handleFetchConfig}
              disabled={isLoading('fetchConfig') || !subscriptionUrl.trim()}
              aria-busy={isLoading('fetchConfig')}
              className='admin-button admin-button-secondary'
            >
              {isLoading('fetchConfig') ? '拉取中…' : '拉取配置'}
            </button>

            <p className='admin-status-note'>
              拉取会更新右侧编辑器的内容，检查后点击“保存配置”才会生效。
            </p>

            <div className='admin-toggle-row'>
              <div>
                <label htmlFor='admin-config-auto-update'>自动更新</label>
                <p
                  id='admin-config-auto-update-description'
                  className='admin-field-hint'
                >
                  保存并启用后，系统会定期拉取最新配置。
                </p>
              </div>
              <button
                id='admin-config-auto-update'
                type='button'
                role='switch'
                aria-checked={autoUpdate}
                aria-describedby='admin-config-auto-update-description'
                onClick={() => setAutoUpdate(!autoUpdate)}
                className='admin-switch'
              >
                <span aria-hidden='true' />
              </button>
            </div>

            <div className='admin-field'>
              <span>最近拉取</span>
              <p className='admin-field-hint'>
                {lastCheckTime
                  ? new Date(lastCheckTime).toLocaleString('zh-CN')
                  : '尚未拉取'}
              </p>
            </div>
          </div>
        </AdminSection>

        <AdminSection
          title='配置编辑器'
          description='编辑 JSON 配置，管理视频源和自定义分类。'
          className='admin-config-editor'
        >
          <div className='admin-field'>
            <label htmlFor='admin-config-content'>配置内容</label>
            <textarea
              id='admin-config-content'
              value={configContent}
              onChange={(event) => setConfigContent(event.target.value)}
              rows={22}
              placeholder='请输入 JSON 格式的配置内容…'
              className='admin-input admin-code-editor'
              spellCheck={false}
              data-gramm={false}
              aria-describedby='admin-config-editor-description'
            />
            <div className='admin-editor-meta'>
              <span>
                {configContent ? configContent.split('\n').length : 0} 行
              </span>
              <span role='status' aria-live='polite'>
                {hasUnsavedChanges ? '有未保存的修改' : '与已保存配置一致'}
              </span>
            </div>
            <p
              id='admin-config-editor-description'
              className='admin-field-hint'
            >
              编辑器内容与订阅设置会一并保存。
            </p>
          </div>
        </AdminSection>
      </div>

      <AdminSaveBar
        description={
          hasUnsavedChanges
            ? '有未保存的修改。保存后应用配置文件与订阅设置。'
            : '拉取或编辑配置后，点击保存使修改生效。'
        }
      >
        <button
          type='button'
          onClick={handleSave}
          disabled={isLoading('saveConfig') || isLoading('fetchConfig')}
          aria-busy={isLoading('saveConfig')}
          className='admin-button admin-button-primary'
        >
          {isLoading('saveConfig') ? '保存中…' : '保存配置'}
        </button>
      </AdminSaveBar>

      <AlertModal
        isOpen={alertModal.isOpen}
        onClose={hideAlert}
        type={alertModal.type}
        title={alertModal.title}
        message={alertModal.message}
        timer={alertModal.timer}
        showConfirm={alertModal.showConfirm}
        showUndo={alertModal.showUndo}
        onUndo={alertModal.onUndo}
        undoTimer={alertModal.undoTimer}
      />
    </div>
  );
};

export default ConfigFileComponent;
