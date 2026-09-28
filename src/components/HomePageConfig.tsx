'use client';

import { AlertCircle, CheckCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AdminConfig } from '@/lib/admin.types';

import { AdminSaveBar, AdminSection } from './admin/AdminPrimitives';
import { buttonStyles } from './admin/shared';

interface HomePageConfigProps {
  config: AdminConfig | null;
  refreshConfig: () => Promise<void>;
}

const ToggleSwitch = ({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
}) => (
  <div className='admin-toggle-row'>
    <div>
      <strong>{label}</strong>
      <p className='admin-field-hint'>{description}</p>
    </div>
    <button
      type='button'
      role='switch'
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className='admin-switch'
    >
      <span aria-hidden='true' />
    </button>
  </div>
);

const HomePageConfig = ({ config, refreshConfig }: HomePageConfigProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const [homePageSettings, setHomePageSettings] = useState({
    showHeroBanner: true,
    showContinueWatching: true,
    showUpcomingReleases: true,
    showHotMovies: true,
    showHotTvShows: true,
    showNewAnime: true,
    showHotVariety: true,
    showHotShortDramas: true,
  });

  useEffect(() => {
    if (config?.HomePageConfig) {
      setHomePageSettings({
        showHeroBanner: config.HomePageConfig.showHeroBanner ?? true,
        showContinueWatching:
          config.HomePageConfig.showContinueWatching ?? true,
        showUpcomingReleases:
          config.HomePageConfig.showUpcomingReleases ?? true,
        showHotMovies: config.HomePageConfig.showHotMovies ?? true,
        showHotTvShows: config.HomePageConfig.showHotTvShows ?? true,
        showNewAnime: config.HomePageConfig.showNewAnime ?? true,
        showHotVariety: config.HomePageConfig.showHotVariety ?? true,
        showHotShortDramas: config.HomePageConfig.showHotShortDramas ?? true,
      });
    }
  }, [config?.HomePageConfig]);

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/admin/homepage-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(homePageSettings),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '保存失败');
      }

      showMessage('success', '首页模块配置保存成功');
      await refreshConfig();
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setHomePageSettings({
      showHeroBanner: true,
      showContinueWatching: true,
      showUpcomingReleases: true,
      showHotMovies: true,
      showHotTvShows: true,
      showNewAnime: true,
      showHotVariety: true,
      showHotShortDramas: true,
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
          <span>{message.text}</span>
        </div>
      )}
      <AdminSection
        title='首页模块'
        description='选择首页显示的内容，关闭后对应模块将隐藏。'
        action={
          <span className='admin-count-badge'>
            已选择 {Object.values(homePageSettings).filter(Boolean).length} / 8
            项
          </span>
        }
      >
        <div className='admin-form-grid'>
          <ToggleSwitch
            checked={homePageSettings.showHeroBanner}
            onChange={(checked) =>
              setHomePageSettings((prev) => ({
                ...prev,
                showHeroBanner: checked,
              }))
            }
            label='首页轮播'
            description='顶部的推荐内容轮播'
          />
          <ToggleSwitch
            checked={homePageSettings.showContinueWatching}
            onChange={(checked) =>
              setHomePageSettings((prev) => ({
                ...prev,
                showContinueWatching: checked,
              }))
            }
            label='继续观看'
            description='最近观看的影片与播放进度'
          />
          <ToggleSwitch
            checked={homePageSettings.showUpcomingReleases}
            onChange={(checked) =>
              setHomePageSettings((prev) => ({
                ...prev,
                showUpcomingReleases: checked,
              }))
            }
            label='即将上映'
            description='近期即将上线的影片'
          />
          <ToggleSwitch
            checked={homePageSettings.showHotMovies}
            onChange={(checked) =>
              setHomePageSettings((prev) => ({
                ...prev,
                showHotMovies: checked,
              }))
            }
            label='热门电影'
            description='近期热门电影推荐'
          />
          <ToggleSwitch
            checked={homePageSettings.showHotTvShows}
            onChange={(checked) =>
              setHomePageSettings((prev) => ({
                ...prev,
                showHotTvShows: checked,
              }))
            }
            label='热门剧集'
            description='近期热门电视剧推荐'
          />
          <ToggleSwitch
            checked={homePageSettings.showNewAnime}
            onChange={(checked) =>
              setHomePageSettings((prev) => ({
                ...prev,
                showNewAnime: checked,
              }))
            }
            label='新番放送'
            description='当前播出的动画番剧'
          />
          <ToggleSwitch
            checked={homePageSettings.showHotVariety}
            onChange={(checked) =>
              setHomePageSettings((prev) => ({
                ...prev,
                showHotVariety: checked,
              }))
            }
            label='热门综艺'
            description='近期热门综艺节目'
          />
          <ToggleSwitch
            checked={homePageSettings.showHotShortDramas}
            onChange={(checked) =>
              setHomePageSettings((prev) => ({
                ...prev,
                showHotShortDramas: checked,
              }))
            }
            label='热门短剧'
            description='近期热门短剧推荐'
          />
        </div>
      </AdminSection>
      <AdminSaveBar description='保存后应用到首页。恢复默认会重新选中全部模块。'>
        <button
          type='button'
          onClick={handleReset}
          disabled={isLoading}
          className={buttonStyles.secondary}
        >
          恢复默认
        </button>
        <button
          type='button'
          onClick={handleSave}
          disabled={isLoading}
          className={buttonStyles.primary}
        >
          {isLoading ? '保存中…' : '保存配置'}
        </button>
      </AdminSaveBar>
    </div>
  );
};

export default HomePageConfig;
