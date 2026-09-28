'use client';

import { ExternalLink, Eye } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useContext, useEffect, useState } from 'react';

import { AdminConfig, DEFAULT_CRON_CONFIG } from '@/lib/admin.types';
import {
  OPTIONAL_FEATURES,
  type OptionalFeature,
} from '@/lib/optional-features';

import { AdminPanelVisibilityContext } from './AdminPortal';
import {
  AdminEmptyState,
  AdminSaveBar,
  AdminSection,
  AdminTabs,
} from './AdminPrimitives';
import {
  AlertModal,
  CronConfig,
  showError,
  showSuccess,
  SiteConfig,
  useAlertModal,
  useLoadingState,
} from './shared';

const AnnouncementDialog = dynamic(
  () => import('@/components/AnnouncementDialog'),
);

const SITE_SETTING_TABS = [
  { id: 'general', label: '基础信息' },
  { id: 'data', label: '数据与图片代理' },
  { id: 'playback', label: '搜索与播放' },
  { id: 'scheduled', label: '定时任务' },
  { id: 'tmdb', label: 'TMDB' },
] as const;

type SiteSettingsTab = (typeof SITE_SETTING_TABS)[number]['id'];

function SiteToggle({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className='admin-toggle-row'>
      <div>
        <label htmlFor={id}>{label}</label>
        {description && (
          <p id={id + '-description'} className='admin-field-hint'>
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type='button'
        role='switch'
        aria-checked={checked}
        aria-describedby={description ? id + '-description' : undefined}
        onClick={onChange}
        className='admin-switch'
      >
        <span aria-hidden='true' />
      </button>
    </div>
  );
}

function ProxyField({
  id,
  label,
  description,
  options,
  value,
  onChange,
  customLabel,
  customValue,
  customPlaceholder,
  customHint,
  onCustomChange,
  credit,
}: {
  id: string;
  label: string;
  description: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  customLabel: string;
  customValue: string;
  customPlaceholder: string;
  customHint: string;
  onCustomChange: (value: string) => void;
  credit?: { text: string; url: string } | null;
}) {
  return (
    <div className='admin-field'>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={id + '-description'}
        className='admin-input'
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p id={id + '-description'} className='admin-field-hint'>
        {description}
      </p>
      {credit && (
        <a
          href={credit.url}
          target='_blank'
          rel='noopener noreferrer'
          className='admin-inline-link'
        >
          {credit.text}
          <ExternalLink size={12} aria-hidden='true' />
        </a>
      )}
      {value === 'custom' && (
        <div className='admin-field'>
          <label htmlFor={id + '-url'}>{customLabel}</label>
          <input
            id={id + '-url'}
            type='text'
            value={customValue}
            placeholder={customPlaceholder}
            onChange={(event) => onCustomChange(event.target.value)}
            aria-describedby={id + '-url-description'}
            className='admin-input'
          />
          <p id={id + '-url-description'} className='admin-field-hint'>
            {customHint}
          </p>
        </div>
      )}
    </div>
  );
}

const SiteConfigComponent = ({
  config,
  refreshConfig,
}: {
  config: AdminConfig | null;
  refreshConfig: () => Promise<void>;
}) => {
  const { alertModal, showAlert, hideAlert } = useAlertModal();
  const { isLoading, withLoading } = useLoadingState();
  const [activeTab, setActiveTab] = useState<SiteSettingsTab>('general');
  const [showAnnouncementPreview, setShowAnnouncementPreview] = useState(false);
  const panelVisible = useContext(AdminPanelVisibilityContext);
  const initialSiteConfig = config?.SiteConfig;
  const initialDoubanConfig = config?.DoubanConfig;
  const initialCronConfig = config?.CronConfig;
  const [siteSettings, setSiteSettings] = useState<SiteConfig>({
    SiteName: '',
    Announcement: '',
    SearchDownstreamMaxPage: 1,
    SiteInterfaceCacheTime: 7200,
    DoubanProxyType: 'direct',
    DoubanProxy: '',
    DoubanImageProxyType: 'direct',
    DoubanImageProxy: '',
    BangumiApiType: 'cmliussss',
    BangumiApiProxy: '',
    BangumiImageProxyType: 'cmliussss',
    BangumiImageProxy: '',
    EnablePuppeteer: false, // 默认关闭 Puppeteer
    DoubanCookies: '', // 默认无 Cookies
    DisableYellowFilter: false,
    ShowAdultContent: false,
    FluidSearch: true,
    EnableWebLive: true,
    // TMDB配置默认值
    TMDBApiKey: '',
    TMDBLanguage: 'zh-CN',
    EnableTMDBActorSearch: false,
  });

  // Cron 配置状态
  const [cronSettings, setCronSettings] =
    useState<CronConfig>(DEFAULT_CRON_CONFIG);

  // 豆瓣数据源选项
  const doubanDataSourceOptions = [
    { value: 'direct', label: '直连（服务器直接请求豆瓣）' },
    { value: 'cors-proxy-zwei', label: 'Cors Proxy By Zwei' },
    {
      value: 'cmliussss-cdn-tencent',
      label: '豆瓣 CDN By CMLiussss（腾讯云）',
    },
    { value: 'cmliussss-cdn-ali', label: '豆瓣 CDN By CMLiussss（阿里云）' },
    { value: 'cmliussss-unified', label: '豆瓣 CDN By CMLiussss（统一域名）' },
    { value: 'custom', label: '自定义代理' },
  ];

  // Bangumi API 代理选项
  const bangumiApiTypeOptions = [
    { value: 'server', label: '服务端转发（默认，访问官方 api.bgm.tv）' },
    {
      value: 'cmliussss',
      label: 'Bangumi 反代 By CMLiussss（解决服务器被墙）',
    },
    { value: 'corsapi', label: 'Cloudflare Worker 代理 By Smone' },
    { value: 'sakura', label: '桜色镜像站（bangumi.lol，第三方镜像）' },
    { value: 'custom', label: '自定义反代地址' },
  ];

  // Bangumi 图片代理选项
  const bangumiImageProxyTypeOptions = [
    { value: 'server', label: '服务器代理（默认，由服务器代理请求）' },
    { value: 'cmliussss', label: 'Bangumi 图片 CDN By CMLiussss' },
    { value: 'corsapi', label: 'Cloudflare Worker 代理 By Smone' },
    { value: 'sakura', label: '桜色镜像站（bangumi.lol，第三方镜像）' },
    { value: 'direct', label: '直连（浏览器直接请求 lain.bgm.tv）' },
    { value: 'custom', label: '自定义代理' },
  ];

  // 豆瓣图片代理选项
  const doubanImageProxyTypeOptions = [
    { value: 'direct', label: '直连（浏览器直接请求豆瓣）' },
    { value: 'server', label: '服务器代理（由服务器代理请求豆瓣）' },
    { value: 'img3', label: '豆瓣官方精品 CDN（阿里云）' },
    {
      value: 'cmliussss-cdn-tencent',
      label: '豆瓣 CDN By CMLiussss（腾讯云）',
    },
    { value: 'cmliussss-cdn-ali', label: '豆瓣 CDN By CMLiussss（阿里云）' },
    { value: 'baidu', label: '百度图片代理（境内CDN，Chrome可能触发下载）' },
    { value: 'custom', label: '自定义代理' },
  ];

  // 获取感谢信息
  const getThanksInfo = (dataSource: string) => {
    switch (dataSource) {
      case 'cors-proxy-zwei':
        return {
          text: 'Thanks to @Zwei',
          url: 'https://github.com/bestzwei',
        };
      case 'cmliussss-cdn-tencent':
      case 'cmliussss-cdn-ali':
      case 'cmliussss-unified':
        return {
          text: 'Thanks to @CMLiussss',
          url: 'https://github.com/cmliu',
        };
      default:
        return null;
    }
  };

  useEffect(() => {
    if (initialSiteConfig) {
      setSiteSettings({
        ...initialSiteConfig,
        DoubanProxyType: initialSiteConfig.DoubanProxyType || 'direct',
        DoubanProxy: initialSiteConfig.DoubanProxy || '',
        DoubanImageProxyType:
          initialSiteConfig.DoubanImageProxyType || 'direct',
        DoubanImageProxy: initialSiteConfig.DoubanImageProxy || '',
        BangumiApiType: initialSiteConfig.BangumiApiType || 'cmliussss',
        BangumiApiProxy: initialSiteConfig.BangumiApiProxy || '',
        BangumiImageProxyType:
          initialSiteConfig.BangumiImageProxyType || 'cmliussss',
        BangumiImageProxy: initialSiteConfig.BangumiImageProxy || '',
        EnablePuppeteer: initialDoubanConfig?.enablePuppeteer || false,
        DoubanCookies: initialDoubanConfig?.cookies || '',
        DisableYellowFilter: initialSiteConfig.DisableYellowFilter || false,
        ShowAdultContent: initialSiteConfig.ShowAdultContent || false,
        FluidSearch: initialSiteConfig.FluidSearch ?? true,
        EnableWebLive: initialSiteConfig.EnableWebLive ?? true,
        // TMDB配置
        TMDBApiKey: initialSiteConfig.TMDBApiKey || '',
        TMDBLanguage: initialSiteConfig.TMDBLanguage || 'zh-CN',
        EnableTMDBActorSearch: initialSiteConfig.EnableTMDBActorSearch || false,
      });
    }
  }, [initialSiteConfig, initialDoubanConfig]);

  // 加载 Cron 配置
  useEffect(() => {
    if (initialCronConfig) {
      setCronSettings({
        enableAutoRefresh:
          initialCronConfig.enableAutoRefresh ??
          DEFAULT_CRON_CONFIG.enableAutoRefresh,
        maxRecordsPerRun:
          initialCronConfig.maxRecordsPerRun ??
          DEFAULT_CRON_CONFIG.maxRecordsPerRun,
        onlyRefreshRecent:
          initialCronConfig.onlyRefreshRecent ??
          DEFAULT_CRON_CONFIG.onlyRefreshRecent,
        recentDays:
          initialCronConfig.recentDays ?? DEFAULT_CRON_CONFIG.recentDays,
        onlyRefreshOngoing:
          initialCronConfig.onlyRefreshOngoing ??
          DEFAULT_CRON_CONFIG.onlyRefreshOngoing,
      });
    }
  }, [initialCronConfig]);

  // 处理豆瓣数据源变化
  const handleDoubanDataSourceChange = (value: string) => {
    setSiteSettings((prev) => ({
      ...prev,
      DoubanProxyType: value,
    }));
  };

  // 处理豆瓣图片代理变化
  const handleDoubanImageProxyChange = (value: string) => {
    setSiteSettings((prev) => ({
      ...prev,
      DoubanImageProxyType: value,
    }));
  };

  // 保存站点配置
  const handleSave = async () => {
    await withLoading('saveSiteConfig', async () => {
      try {
        const resp = await fetch('/api/admin/site', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...siteSettings,
            cronConfig: cronSettings, // 添加 Cron 配置
          }),
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.error || `保存失败: ${resp.status}`);
        }

        const data = await resp.json();

        showSuccess('保存成功', showAlert);
        await refreshConfig();

        // 🔥 如果API返回shouldReload标志，自动刷新页面使配置立即生效（解决Docker缓存问题）
        if (data.shouldReload) {
          setTimeout(() => {
            window.location.reload();
          }, 1000); // 1秒后刷新，让用户看到成功提示
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : '保存失败', showAlert);
        throw err;
      }
    });
  };

  if (!config) {
    return (
      <AdminEmptyState
        title='正在加载站点设置'
        description='正在读取站点配置，请稍候。'
      />
    );
  }

  return (
    <div className='admin-stack'>
      <AdminTabs
        items={SITE_SETTING_TABS}
        value={activeTab}
        onChange={setActiveTab}
        label='站点设置分类'
      />

      {activeTab === 'general' && (
        <AdminSection
          title='基础信息'
          description='管理站点对外展示的名称与公告。'
        >
          <div className='admin-form-grid'>
            <div className='admin-field'>
              <label htmlFor='admin-site-name'>站点名称</label>
              <input
                id='admin-site-name'
                type='text'
                value={siteSettings.SiteName}
                onChange={(event) =>
                  setSiteSettings((previous) => ({
                    ...previous,
                    SiteName: event.target.value,
                  }))
                }
                className='admin-input'
              />
              <p className='admin-field-hint'>
                用于导航栏、页面标题等站点标识。
              </p>
            </div>
            <div className='admin-field admin-field-wide'>
              <div className='flex items-center justify-between gap-3'>
                <label
                  htmlFor='admin-site-announcement'
                  className='text-[length:var(--text-admin-sm)] font-medium text-[var(--color-admin-ink)]'
                >
                  站点公告
                </label>
                <button
                  type='button'
                  className='admin-button admin-button-secondary h-11 shrink-0'
                  aria-haspopup='dialog'
                  disabled={!siteSettings.Announcement.trim()}
                  onClick={() => setShowAnnouncementPreview(true)}
                >
                  <Eye size={15} aria-hidden='true' />
                  预览公告
                </button>
              </div>
              <textarea
                id='admin-site-announcement'
                aria-describedby='admin-site-announcement-hint'
                value={siteSettings.Announcement}
                onChange={(event) =>
                  setSiteSettings((previous) => ({
                    ...previous,
                    Announcement: event.target.value,
                  }))
                }
                rows={8}
                className='admin-input'
                placeholder={
                  '## 站点通知\n\n在这里填写公告，支持 **加粗**、列表和 [链接](https://example.com)。'
                }
              />
              <p id='admin-site-announcement-hint' className='admin-field-hint'>
                支持 Markdown
                标题、列表、链接、图片、表格和代码块。留空则不显示公告。
              </p>
            </div>
          </div>
        </AdminSection>
      )}

      {activeTab === 'data' && (
        <div className='admin-stack'>
          <AdminSection
            title='数据与图片代理'
            description='分别设置豆瓣与 Bangumi 的数据和封面图片访问方式。'
          >
            <div className='admin-form-grid'>
              <ProxyField
                id='admin-douban-data'
                label='豆瓣数据代理'
                description='选择获取豆瓣影视详情、评分等数据的方式。'
                options={doubanDataSourceOptions}
                value={siteSettings.DoubanProxyType}
                onChange={handleDoubanDataSourceChange}
                customLabel='豆瓣代理地址'
                customValue={siteSettings.DoubanProxy}
                customPlaceholder='https://proxy.example.com/fetch?url='
                customHint='填写自定义代理服务器地址。'
                onCustomChange={(value) =>
                  setSiteSettings((previous) => ({
                    ...previous,
                    DoubanProxy: value,
                  }))
                }
                credit={getThanksInfo(siteSettings.DoubanProxyType)}
              />
              <ProxyField
                id='admin-douban-image'
                label='豆瓣图片代理'
                description='选择获取豆瓣封面图片的方式。'
                options={doubanImageProxyTypeOptions}
                value={siteSettings.DoubanImageProxyType}
                onChange={handleDoubanImageProxyChange}
                customLabel='豆瓣图片代理地址'
                customValue={siteSettings.DoubanImageProxy}
                customPlaceholder='https://proxy.example.com/fetch?url='
                customHint='填写自定义图片代理服务器地址。'
                onCustomChange={(value) =>
                  setSiteSettings((previous) => ({
                    ...previous,
                    DoubanImageProxy: value,
                  }))
                }
                credit={getThanksInfo(siteSettings.DoubanImageProxyType)}
              />
              <ProxyField
                id='admin-bangumi-data'
                label='Bangumi 数据代理'
                description='服务器无法访问 api.bgm.tv 时，可切换到可用反代。'
                options={bangumiApiTypeOptions}
                value={siteSettings.BangumiApiType || 'cmliussss'}
                onChange={(value) =>
                  setSiteSettings((previous) => ({
                    ...previous,
                    BangumiApiType: value,
                  }))
                }
                customLabel='Bangumi 反代地址'
                customValue={siteSettings.BangumiApiProxy || ''}
                customPlaceholder='https://bgm-proxy.example.com'
                customHint='使用与 api.bgm.tv 路径兼容的地址，不含末尾斜杠。'
                onCustomChange={(value) =>
                  setSiteSettings((previous) => ({
                    ...previous,
                    BangumiApiProxy: value,
                  }))
                }
                credit={
                  siteSettings.BangumiApiType === 'cmliussss'
                    ? {
                        text: 'Thanks to @CMLiussss',
                        url: 'https://github.com/cmliu',
                      }
                    : null
                }
              />
              <ProxyField
                id='admin-bangumi-image'
                label='Bangumi 图片代理'
                description='选择访问 lain.bgm.tv 番剧封面的方式。'
                options={bangumiImageProxyTypeOptions}
                value={siteSettings.BangumiImageProxyType || 'cmliussss'}
                onChange={(value) =>
                  setSiteSettings((previous) => ({
                    ...previous,
                    BangumiImageProxyType: value,
                  }))
                }
                customLabel='Bangumi 图片代理地址'
                customValue={siteSettings.BangumiImageProxy || ''}
                customPlaceholder='https://proxy.example.com/fetch?url='
                customHint='图片 URL 将以编码形式拼接在此地址后面。'
                onCustomChange={(value) =>
                  setSiteSettings((previous) => ({
                    ...previous,
                    BangumiImageProxy: value,
                  }))
                }
                credit={
                  siteSettings.BangumiImageProxyType === 'cmliussss'
                    ? {
                        text: 'Thanks to @CMLiussss',
                        url: 'https://github.com/cmliu',
                      }
                    : null
                }
              />
            </div>
          </AdminSection>
          <AdminSection
            title='豆瓣认证'
            description='配置认证 Cookies，以访问豆瓣 Web 页面获取完整数据。'
          >
            <div className='admin-field'>
              <label htmlFor='admin-douban-cookies'>豆瓣认证 Cookies</label>
              <textarea
                id='admin-douban-cookies'
                value={siteSettings.DoubanCookies || ''}
                onChange={(event) =>
                  setSiteSettings((previous) => ({
                    ...previous,
                    DoubanCookies: event.target.value,
                  }))
                }
                placeholder='bid=xxx; dbcl2="xxx"; ck=xxx; frodotk_db="xxx"; ...'
                rows={3}
                spellCheck={false}
                className='admin-input'
                aria-describedby='admin-douban-cookies-description'
              />
              <p
                id='admin-douban-cookies-description'
                className='admin-field-hint'
              >
                建议包含 dbcl2、frodotk_db、ck 等认证字段。
              </p>
            </div>
          </AdminSection>
        </div>
      )}

      {activeTab === 'playback' && (
        <div className='admin-stack'>
          <AdminSection
            title='搜索与播放'
            description='调整搜索范围、缓存时间和网页中的内容展示。'
          >
            <div className='admin-stack'>
              <div className='admin-form-grid'>
                <div className='admin-field'>
                  <label htmlFor='admin-search-max-pages'>
                    搜索接口可拉取最大页数
                  </label>
                  <input
                    id='admin-search-max-pages'
                    type='number'
                    min={1}
                    value={siteSettings.SearchDownstreamMaxPage}
                    onChange={(event) =>
                      setSiteSettings((previous) => ({
                        ...previous,
                        SearchDownstreamMaxPage: Number(event.target.value),
                      }))
                    }
                    className='admin-input'
                  />
                </div>
                <div className='admin-field'>
                  <label htmlFor='admin-site-cache-time'>
                    站点接口缓存时间（秒）
                  </label>
                  <input
                    id='admin-site-cache-time'
                    type='number'
                    min={1}
                    value={siteSettings.SiteInterfaceCacheTime}
                    onChange={(event) =>
                      setSiteSettings((previous) => ({
                        ...previous,
                        SiteInterfaceCacheTime: Number(event.target.value),
                      }))
                    }
                    className='admin-input'
                  />
                </div>
              </div>
              <div>
                <SiteToggle
                  id='admin-fluid-search'
                  label='启用流式搜索'
                  description='搜索结果实时返回，减少等待完整结果的时间。'
                  checked={siteSettings.FluidSearch}
                  onChange={() =>
                    setSiteSettings((previous) => ({
                      ...previous,
                      FluidSearch: !previous.FluidSearch,
                    }))
                  }
                />
                <SiteToggle
                  id='admin-web-live'
                  label='启用网页直播'
                  description='控制网页中的直播入口与播放页面，直播源在直播源管理中维护。'
                  checked={siteSettings.EnableWebLive}
                  onChange={() =>
                    setSiteSettings((previous) => ({
                      ...previous,
                      EnableWebLive: !previous.EnableWebLive,
                    }))
                  }
                />
                <SiteToggle
                  id='admin-keyword-filter'
                  label='启用关键词过滤'
                  description='过滤包含敏感关键词的视频分类；关闭后显示所有分类。'
                  checked={!siteSettings.DisableYellowFilter}
                  onChange={() =>
                    setSiteSettings((previous) => ({
                      ...previous,
                      DisableYellowFilter: !previous.DisableYellowFilter,
                    }))
                  }
                />
                <SiteToggle
                  id='admin-adult-content'
                  label='显示成人内容'
                  description='显示被标记为成人资源的视频源内容；关闭后自动过滤。'
                  checked={siteSettings.ShowAdultContent}
                  onChange={() =>
                    setSiteSettings((previous) => ({
                      ...previous,
                      ShowAdultContent: !previous.ShowAdultContent,
                    }))
                  }
                />
              </div>
            </div>
          </AdminSection>
          <AdminSection
            title='可选功能'
            description='以下功能默认关闭，可根据站点使用需求开启。'
          >
            <div className='admin-form-grid'>
              {(
                Object.entries(OPTIONAL_FEATURES) as [OptionalFeature, string][]
              ).map(([key, label]) => (
                <SiteToggle
                  key={key}
                  id={'admin-optional-' + key}
                  label={label}
                  checked={siteSettings[key] === true}
                  onChange={() =>
                    setSiteSettings((previous) => ({
                      ...previous,
                      [key]: previous[key] !== true,
                    }))
                  }
                />
              ))}
            </div>
          </AdminSection>
        </div>
      )}

      {activeTab === 'scheduled' && (
        <AdminSection
          title='播放记录与收藏更新'
          description='设置自动更新的范围与处理数量，控制定时任务的请求量。'
        >
          <div className='admin-stack'>
            <SiteToggle
              id='admin-cron-enabled'
              label='启用自动刷新播放记录和收藏'
              description='每天凌晨 1 点更新剧集信息；关闭可减少服务器出站流量。'
              checked={cronSettings.enableAutoRefresh}
              onChange={() =>
                setCronSettings((previous) => ({
                  ...previous,
                  enableAutoRefresh: !previous.enableAutoRefresh,
                }))
              }
            />
            <div className='admin-form-grid'>
              <div className='admin-field'>
                <label htmlFor='admin-cron-max-records'>
                  每次最多处理记录数
                </label>
                <input
                  id='admin-cron-max-records'
                  type='number'
                  min={10}
                  max={1000}
                  value={cronSettings.maxRecordsPerRun}
                  onChange={(event) =>
                    setCronSettings((previous) => ({
                      ...previous,
                      maxRecordsPerRun: Number(event.target.value),
                    }))
                  }
                  className='admin-input'
                  aria-describedby='admin-cron-max-records-description'
                />
                <p
                  id='admin-cron-max-records-description'
                  className='admin-field-hint'
                >
                  每次处理 10–1,000 条，避免集中发起过多请求。
                </p>
              </div>
              {cronSettings.onlyRefreshRecent && (
                <div className='admin-field'>
                  <label htmlFor='admin-cron-recent-days'>最近活跃天数</label>
                  <input
                    id='admin-cron-recent-days'
                    type='number'
                    min={1}
                    max={365}
                    value={cronSettings.recentDays}
                    onChange={(event) =>
                      setCronSettings((previous) => ({
                        ...previous,
                        recentDays: Number(event.target.value),
                      }))
                    }
                    className='admin-input'
                    aria-describedby='admin-cron-recent-days-description'
                  />
                  <p
                    id='admin-cron-recent-days-description'
                    className='admin-field-hint'
                  >
                    仅更新此时间范围内活跃的记录，支持 1–365 天。
                  </p>
                </div>
              )}
            </div>
            <div>
              <SiteToggle
                id='admin-cron-recent-only'
                label='仅刷新最近活跃的记录'
                description='跳过长时间未观看的播放记录和收藏。'
                checked={cronSettings.onlyRefreshRecent}
                onChange={() =>
                  setCronSettings((previous) => ({
                    ...previous,
                    onlyRefreshRecent: !previous.onlyRefreshRecent,
                  }))
                }
              />
              <SiteToggle
                id='admin-cron-ongoing-only'
                label='仅刷新连载中的剧集'
                description='跳过已完结剧集，减少不必要的更新请求。'
                checked={cronSettings.onlyRefreshOngoing}
                onChange={() =>
                  setCronSettings((previous) => ({
                    ...previous,
                    onlyRefreshOngoing: !previous.onlyRefreshOngoing,
                  }))
                }
              />
            </div>
          </div>
        </AdminSection>
      )}

      {activeTab === 'tmdb' && (
        <AdminSection
          title='TMDB 演员搜索'
          description='连接 TMDB，让用户按演员名字查找相关影视作品。'
        >
          <div className='admin-stack'>
            <div className='admin-form-grid'>
              <div className='admin-field'>
                <label htmlFor='admin-tmdb-key'>TMDB API Key</label>
                <input
                  id='admin-tmdb-key'
                  type='password'
                  value={siteSettings.TMDBApiKey || ''}
                  onChange={(event) =>
                    setSiteSettings((previous) => ({
                      ...previous,
                      TMDBApiKey: event.target.value,
                    }))
                  }
                  placeholder='请输入 TMDB API Key'
                  autoComplete='off'
                  className='admin-input'
                />
                <p className='admin-field-hint'>
                  可前往{' '}
                  <a
                    href='https://www.themoviedb.org/settings/api'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='admin-inline-link'
                  >
                    TMDB 官网
                    <ExternalLink size={12} aria-hidden='true' />
                  </a>{' '}
                  申请 API Key。
                </p>
              </div>
              <div className='admin-field'>
                <label htmlFor='admin-tmdb-language'>TMDB 语言</label>
                <select
                  id='admin-tmdb-language'
                  value={siteSettings.TMDBLanguage || 'zh-CN'}
                  onChange={(event) =>
                    setSiteSettings((previous) => ({
                      ...previous,
                      TMDBLanguage: event.target.value,
                    }))
                  }
                  className='admin-input'
                >
                  <option value='zh-CN'>中文（简体）</option>
                  <option value='zh-TW'>中文（繁体）</option>
                  <option value='en-US'>英语</option>
                  <option value='ja-JP'>日语</option>
                  <option value='ko-KR'>韩语</option>
                </select>
              </div>
            </div>
            <SiteToggle
              id='admin-tmdb-search'
              label='启用 TMDB 演员搜索'
              description='开启后，用户可在搜索页面按演员名字查找影视作品。'
              checked={siteSettings.EnableTMDBActorSearch ?? false}
              onChange={() =>
                setSiteSettings((previous) => ({
                  ...previous,
                  EnableTMDBActorSearch: !previous.EnableTMDBActorSearch,
                }))
              }
            />
            <p className='admin-status-note'>
              直连 TMDB 较慢或不稳定时，可在视频源的代理设置中启用 Cloudflare
              Worker 代理转发。
            </p>
          </div>
        </AdminSection>
      )}

      <AdminSaveBar description='所有页签的修改会一并保存。'>
        <button
          type='button'
          onClick={handleSave}
          disabled={isLoading('saveSiteConfig')}
          aria-busy={isLoading('saveSiteConfig')}
          className='admin-button admin-button-primary'
        >
          {isLoading('saveSiteConfig') ? '保存中…' : '保存站点设置'}
        </button>
      </AdminSaveBar>

      {showAnnouncementPreview && panelVisible && (
        <AnnouncementDialog
          announcement={siteSettings.Announcement}
          siteName={siteSettings.SiteName}
          isOpen={showAnnouncementPreview}
          onClose={() => setShowAnnouncementPreview(false)}
          preview
        />
      )}

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

export default SiteConfigComponent;
