'use client';

import {
  Ban,
  Check,
  Database,
  KeyRound,
  ShieldCheck,
  ShieldOff,
  Trash2,
  TvMinimal,
  UserPen,
  Users,
  X,
} from 'lucide-react';

import type { AdminConfig } from '@/lib/admin.types';

type DrawerEditView = 'rename' | 'password' | 'groups' | 'sources' | 'tvbox';
type DrawerUser = AdminConfig['UserConfig']['Users'][number] & { uid?: string };

export interface UserDrawerOverviewProps {
  user: DrawerUser;
  config: AdminConfig;
  isSelf: boolean;
  canManage: boolean;
  canEditCredentials: boolean;
  canModerate: boolean;
  canChangeRole: boolean;
  busy: boolean;
  onEdit: (view: DrawerEditView) => void;
  onToggleAdmin: () => void;
  onToggleBan: () => void;
  onDelete: () => void;
  onApprove: () => void;
  onReject: () => void;
}

function formatCreatedAt(createdAt?: number) {
  if (!createdAt || !Number.isFinite(createdAt)) return '未记录';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function sourceNames(sources: AdminConfig['SourceConfig']) {
  if (sources.length === 0) return '暂无可用采集源';
  const names = sources.slice(0, 3).map((source) => source.name || source.key);
  return `${names.join('、')}${sources.length > 3 ? ' 等' : ''}`;
}

export function UserDrawerOverview({
  user,
  config,
  isSelf,
  canManage,
  canEditCredentials,
  canModerate,
  canChangeRole,
  busy,
  onEdit,
  onToggleAdmin,
  onToggleBan,
  onDelete,
  onApprove,
  onReject,
}: UserDrawerOverviewProps) {
  const groups = (config.UserConfig.Tags ?? []).filter((group) =>
    user.tags?.includes(group.name),
  );
  const groupSources = new Set(
    groups.flatMap((group) => group.enabledApis ?? []),
  );
  const personalSources = new Set(user.enabledApis ?? []);
  const inheritedAdultContent = groups.some(
    (group) => group.showAdultContent === true,
  )
    ? true
    : groups.some((group) => group.showAdultContent === false)
      ? false
      : config.SiteConfig.ShowAdultContent;
  const showAdultContent = user.showAdultContent ?? inheritedAdultContent;
  const availableSources = config.SourceConfig.filter(
    (source) => !source.disabled && (showAdultContent || !source.is_adult),
  );
  const allowedSources =
    personalSources.size > 0
      ? personalSources
      : groupSources.size > 0
        ? groupSources
        : null;
  const effectiveSources = allowedSources
    ? availableSources.filter((source) => allowedSources.has(source.key))
    : availableSources;
  const sourceSummary =
    personalSources.size > 0
      ? `个人配置 · ${effectiveSources.length} 个源`
      : groupSources.size > 0
        ? `继承用户组 · ${effectiveSources.length} 个源`
        : '全部可用源';
  const tvboxSourceKeys = new Set(user.tvboxEnabledSources ?? []);
  const tvboxSources = config.SourceConfig.filter(
    (source) =>
      !source.disabled &&
      (tvboxSourceKeys.size === 0 || tvboxSourceKeys.has(source.key)),
  );
  const roleLabel =
    user.role === 'owner'
      ? '站长'
      : user.role === 'admin'
        ? '管理员'
        : '普通用户';
  const statusLabel = user.pending ? '待审核' : user.banned ? '已封禁' : '正常';
  const editableActions: Array<{
    view: DrawerEditView;
    label: string;
    icon: typeof Users;
  }> = [
    ...(canEditCredentials
      ? [
          { view: 'rename' as const, label: '修改用户名', icon: UserPen },
          { view: 'password' as const, label: '修改密码', icon: KeyRound },
        ]
      : []),
    ...(canManage
      ? [
          { view: 'groups' as const, label: '配置用户组', icon: Users },
          { view: 'sources' as const, label: '配置采集源权限', icon: Database },
          { view: 'tvbox' as const, label: '配置 TVBox', icon: TvMinimal },
        ]
      : []),
  ];
  const firstAction =
    editableActions[0]?.view ??
    (user.pending && canModerate
      ? 'approve'
      : canChangeRole
        ? 'role'
        : canModerate
          ? 'ban'
          : null);
  const canAct = editableActions.length > 0 || canChangeRole || canModerate;

  return (
    <div className='admin-user-overview'>
      <div className='admin-user-profile'>
        <span className='admin-user-profile-avatar' aria-hidden='true'>
          {Array.from(user.username.trim())[0]?.toLocaleUpperCase() || 'U'}
        </span>
        <div className='admin-user-profile-copy'>
          <div className='admin-user-profile-title'>
            <h3>{user.username}</h3>
            {isSelf && (
              <span className='admin-user-badge' data-tone='muted'>
                当前账号
              </span>
            )}
          </div>
          <p className='admin-user-profile-email'>
            {user.email?.trim() || 'null'}
          </p>
          <div className='admin-user-profile-badges'>
            <span
              className='admin-user-badge'
              data-tone={user.role === 'user' ? 'muted' : 'primary'}
            >
              {roleLabel}
            </span>
            <span
              className='admin-user-badge'
              data-tone={
                user.pending ? 'warning' : user.banned ? 'danger' : 'success'
              }
            >
              {statusLabel}
            </span>
          </div>
        </div>
      </div>

      <dl className='admin-user-facts'>
        <dt>ID</dt>
        <dd className='admin-user-identity-value'>{user.uid || '未分配'}</dd>
        <dt>注册时间</dt>
        <dd>{formatCreatedAt(user.createdAt)}</dd>
        <dt>来源 / 理由</dt>
        <dd className='admin-user-source-reason'>
          {user.source?.trim() || '未记录'}
        </dd>
      </dl>

      {editableActions.length > 0 && (
        <section className='admin-user-overview-section'>
          <h3>账号设置</h3>
          <div className='admin-user-action-grid' aria-busy={busy}>
            {editableActions.map(({ view, label, icon: Icon }) => (
              <button
                type='button'
                key={view}
                className='admin-button admin-button-secondary'
                disabled={busy}
                data-drawer-autofocus={
                  !busy && firstAction === view ? true : undefined
                }
                onClick={() => onEdit(view)}
              >
                <Icon size={16} aria-hidden='true' />
                {label}
              </button>
            ))}
          </div>
          {!canEditCredentials && user.role === 'owner' && (
            <p className='admin-user-note'>
              站长的用户名和登录密码由站点配置维护。
            </p>
          )}
        </section>
      )}

      <section className='admin-user-overview-section'>
        <h3>权限与访问</h3>
        <dl className='admin-user-facts'>
          <dt>用户组</dt>
          <dd>
            {user.tags?.length ? (
              <div className='admin-user-table-groups'>
                {Array.from(new Set(user.tags)).map((tag) => (
                  <span
                    key={tag}
                    className='admin-user-badge'
                    data-tone='muted'
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : (
              <span className='admin-user-note'>未分配用户组</span>
            )}
          </dd>
          <dt>采集源权限</dt>
          <dd>
            <strong className='admin-user-access-summary'>
              {sourceSummary}
            </strong>
            <p className='admin-user-note'>{sourceNames(effectiveSources)}</p>
          </dd>
          <dt>TVBox</dt>
          <dd>
            <span
              className='admin-user-badge'
              data-tone={user.tvboxToken ? 'success' : 'muted'}
            >
              {user.tvboxToken ? '已设置 Token' : '未设置 Token'}
            </span>
            <p className='admin-user-note'>
              {tvboxSourceKeys.size
                ? `指定 ${tvboxSources.length} 个启用源`
                : '使用全部启用源'}
            </p>
            <p className='admin-user-note'>{sourceNames(tvboxSources)}</p>
          </dd>
        </dl>
      </section>

      {user.pending && canModerate && (
        <section className='admin-user-overview-section'>
          <h3>注册审核</h3>
          <div className='admin-user-action-grid' aria-busy={busy}>
            <button
              type='button'
              className='admin-button admin-button-primary'
              disabled={busy}
              data-drawer-autofocus={
                !busy && firstAction === 'approve' ? true : undefined
              }
              onClick={onApprove}
            >
              <Check size={16} aria-hidden='true' />
              通过审核
            </button>
            <button
              type='button'
              className='admin-button admin-button-secondary'
              disabled={busy}
              onClick={onReject}
            >
              <X size={16} aria-hidden='true' />
              拒绝申请
            </button>
          </div>
        </section>
      )}

      {(canChangeRole || canModerate) && (
        <section className='admin-user-overview-section'>
          <h3>账号管理</h3>
          <div className='admin-user-action-grid' aria-busy={busy}>
            {canChangeRole && (
              <button
                type='button'
                className='admin-button admin-button-secondary'
                disabled={busy}
                data-drawer-autofocus={
                  !busy && firstAction === 'role' ? true : undefined
                }
                onClick={onToggleAdmin}
              >
                {user.role === 'admin' ? (
                  <ShieldOff size={16} aria-hidden='true' />
                ) : (
                  <ShieldCheck size={16} aria-hidden='true' />
                )}
                {user.role === 'admin' ? '取消管理员' : '设为管理员'}
              </button>
            )}
            {canModerate && (
              <>
                <button
                  type='button'
                  className={`admin-button ${user.banned ? 'admin-button-secondary' : 'admin-button-warning'}`}
                  disabled={busy}
                  data-drawer-autofocus={
                    !busy && firstAction === 'ban' ? true : undefined
                  }
                  onClick={onToggleBan}
                >
                  <Ban size={16} aria-hidden='true' />
                  {user.banned ? '解除封禁' : '封禁用户'}
                </button>
                <button
                  type='button'
                  className='admin-button admin-button-danger-ghost'
                  disabled={busy}
                  onClick={onDelete}
                >
                  <Trash2 size={16} aria-hidden='true' />
                  删除用户
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {!canAct && (
        <p className='admin-user-note'>
          {user.role === 'owner'
            ? '站长账号由站点配置维护。'
            : '当前权限仅可查看此账号的资料。'}
        </p>
      )}
    </div>
  );
}

export default UserDrawerOverview;
