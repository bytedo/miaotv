'use client';

import {
  ArrowRight,
  CheckCircle2,
  FileCode2,
  FolderOpen,
  ListVideo,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react';

import {
  getRegistrationMode,
  getRegistrationPolicy,
} from '@/lib/account-policy';
import type { AdminConfig } from '@/lib/admin.types';

import type { AdminRole, AdminSectionId } from './admin-navigation';
import { AdminSection } from './AdminPrimitives';

export default function AdminOverview({
  config,
  role,
  refreshing,
  onRefresh,
  onNavigate,
}: {
  config: AdminConfig;
  role: AdminRole;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: (id: AdminSectionId) => void;
}) {
  const users = config.UserConfig?.Users || [];
  const sources = config.SourceConfig || [];
  const live = config.LiveConfig || [];
  const categories = config.CustomCategories || [];
  const pending = users.filter((user) => user.pending).length;
  const enabledSources = sources.filter((source) => !source.disabled).length;
  const storage = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  const registrationMode = getRegistrationMode(
    getRegistrationPolicy(config.UserConfig),
  );
  const stats = [
    {
      label: '用户总数',
      value: users.length,
      detail: `${users.filter((user) => user.role !== 'user').length} 位管理成员`,
      icon: Users,
      section: 'userConfig',
    },
    {
      label: '视频源',
      value: sources.length,
      detail: `${enabledSources} 个启用中`,
      icon: ListVideo,
      section: 'videoSource',
    },
    {
      label: '直播源',
      value: live.length,
      detail: `${live.filter((source) => !source.disabled).length} 个启用中`,
      icon: Radio,
      section: 'liveSource',
    },
    {
      label: '内容分类',
      value: categories.length,
      detail: `${categories.filter((category) => !category.disabled).length} 个展示中`,
      icon: FolderOpen,
      section: 'categoryConfig',
    },
  ] as const;
  const shortcuts = [
    {
      title: '用户与权限',
      description: '账号管理、用户组和注册审核',
      icon: Users,
      section: 'userConfig',
    },
    {
      title: '视频源管理',
      description: '添加接口、调整顺序和播放优先级',
      icon: ListVideo,
      section: 'videoSource',
    },
    {
      title: '站点配置',
      description: '站点信息、搜索播放和数据代理',
      icon: Settings2,
      section: 'siteConfig',
    },
    {
      title: '直播源管理',
      description: '直播订阅、频道与节目单',
      icon: Radio,
      section: 'liveSource',
    },
  ] as const;
  const statusRows = [
    {
      label: '用户注册',
      enabled: config.UserConfig?.AllowRegister !== false,
      on: '开放注册',
      off: '已关闭',
      section: 'userConfig',
    },
    {
      label: '注册审核',
      enabled: registrationMode === 'approval',
      on: '无邀请码时需要审核',
      off:
        registrationMode === 'closed'
          ? '注册已关闭'
          : registrationMode === 'invite'
            ? '邀请码注册免审核'
            : '无需审核',
      section: 'userConfig',
    },
    {
      label: '网页直播',
      enabled: !!config.SiteConfig?.EnableWebLive,
      on: '已启用',
      off: '已关闭',
      section: 'siteConfig',
    },
    {
      label: '视频源代理',
      enabled: !!config.VideoProxyConfig?.enabled,
      on: '已启用',
      off: '未启用',
      section: 'videoSource',
    },
  ] as const;

  return (
    <div className='admin-overview admin-stack'>
      <div className='admin-overview-toolbar'>
        <span className='admin-sync-state'>
          <span />
          已读取站点配置
        </span>
        <button
          type='button'
          className='admin-button admin-button-secondary'
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? '同步中…' : '刷新概况'}
        </button>
      </div>
      <div className='admin-stat-strip'>
        {stats.map(({ label, value, detail, icon: Icon, section }) => (
          <button
            key={section}
            type='button'
            className='admin-stat'
            onClick={() => onNavigate(section)}
          >
            <div className='admin-stat-label'>
              <span>{label}</span>
              <Icon size={18} strokeWidth={1.75} />
            </div>
            <strong>{value.toLocaleString()}</strong>
            <span className='admin-stat-detail'>
              {detail}
              <ArrowRight size={15} />
            </span>
          </button>
        ))}
      </div>
      <div className='admin-overview-grid'>
        <AdminSection title='常用管理' description='站点日常运营的主要入口。'>
          <div className='admin-shortcuts'>
            {shortcuts.map(({ title, description, icon: Icon, section }) => (
              <button
                type='button'
                key={section}
                className='admin-shortcut'
                onClick={() => onNavigate(section)}
              >
                <span className='admin-shortcut-icon'>
                  <Icon size={20} strokeWidth={1.75} />
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        </AdminSection>
        <AdminSection
          title='待处理事项'
          action={
            <span className='admin-count-badge'>
              {(pending > 0 ? 1 : 0) + (enabledSources === 0 ? 1 : 0)}
            </span>
          }
        >
          <div className='admin-attention-list'>
            {pending > 0 && (
              <button
                type='button'
                className='admin-attention-item'
                onClick={() => onNavigate('userConfig')}
              >
                <span className='admin-attention-dot' />
                <span>
                  <strong>{pending} 个账号等待审核</strong>
                  <small>前往用户管理处理注册申请</small>
                </span>
                <ArrowRight size={16} />
              </button>
            )}
            {enabledSources === 0 && (
              <button
                type='button'
                className='admin-attention-item'
                onClick={() => onNavigate('videoSource')}
              >
                <span className='admin-attention-dot' />
                <span>
                  <strong>尚未启用视频源</strong>
                  <small>添加或启用内容源后即可搜索</small>
                </span>
                <ArrowRight size={16} />
              </button>
            )}
            {pending === 0 && enabledSources > 0 && (
              <div className='admin-attention-clear'>
                <CheckCircle2 size={28} strokeWidth={1.5} />
                <strong>暂无待处理事项</strong>
                <p>没有待审核账号，视频源已启用。</p>
              </div>
            )}
          </div>
          <div className='admin-overview-note'>
            <ShieldCheck size={16} />
            <p>
              当前以{role === 'owner' ? '站长' : '管理员'}
              身份管理站点。功能入口按账号权限显示。
            </p>
          </div>
        </AdminSection>
      </div>
      <div className='admin-overview-grid'>
        <AdminSection title='功能状态' description='当前已保存的主要功能开关。'>
          <div className='admin-state-list'>
            {statusRows.map((row) => (
              <button
                type='button'
                key={row.label}
                onClick={() => onNavigate(row.section)}
              >
                <span>{row.label}</span>
                <span
                  className={`admin-status-badge ${row.enabled ? 'is-enabled' : ''}`}
                >
                  <i />
                  {row.enabled ? row.on : row.off}
                </span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        </AdminSection>
        <AdminSection title='站点信息'>
          <dl className='admin-info-list'>
            <div>
              <dt>站点名称</dt>
              <dd>{config.SiteConfig?.SiteName || 'MiaoTV'}</dd>
            </div>
            <div>
              <dt>数据存储</dt>
              <dd>
                {storage === 'kvrocks'
                  ? 'Kvrocks'
                  : storage === 'localstorage'
                    ? '本地存储'
                    : storage === 'redis'
                      ? 'Redis'
                      : storage}
              </dd>
            </div>
            <div>
              <dt>配置订阅</dt>
              <dd>{config.ConfigSubscribtion?.URL ? '已配置' : '未配置'}</dd>
            </div>
            <div>
              <dt>订阅自动更新</dt>
              <dd>
                {config.ConfigSubscribtion?.AutoUpdate ? '已启用' : '未启用'}
              </dd>
            </div>
          </dl>
          {role === 'owner' && (
            <button
              type='button'
              className='admin-inline-link admin-overview-config-link'
              onClick={() => onNavigate('configFile')}
            >
              <FileCode2 size={16} />
              管理配置文件
              <ArrowRight size={14} />
            </button>
          )}
        </AdminSection>
      </div>
    </div>
  );
}
