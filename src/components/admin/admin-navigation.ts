import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  Blocks,
  Database,
  Download,
  FileCode2,
  FolderOpen,
  HardDrive,
  Home,
  KeyRound,
  LayoutDashboard,
  ListVideo,
  Mail,
  MessageSquare,
  Radio,
  ScanLine,
  Settings2,
  ShieldCheck,
  Ticket,
  Tv,
  Users,
  Wrench,
} from 'lucide-react';

export type AdminRole = 'owner' | 'admin';
export type AdminSectionId =
  | 'overview'
  | 'videoSource'
  | 'liveSource'
  | 'categoryConfig'
  | 'sourceTest'
  | 'siteConfig'
  | 'homePageConfig'
  | 'downloadConfig'
  | 'customAdFilter'
  | 'userConfig'
  | 'inviteCodeManager'
  | 'oidcAuthConfig'
  | 'tvboxSecurityConfig'
  | 'trustedNetworkConfig'
  | 'netdiskConfig'
  | 'embyConfig'
  | 'danmuApiConfig'
  | 'emailConfig'
  | 'webhookConfig'
  | 'configFile'
  | 'cacheManager'
  | 'dataMigration'
  | 'performanceMonitor'
  | 'maintenance';

export interface AdminNavigationItem {
  id: AdminSectionId;
  label: string;
  description: string;
  icon: LucideIcon;
  ownerOnly?: boolean;
  transient?: boolean;
}

export const ADMIN_OVERVIEW: AdminNavigationItem = {
  id: 'overview',
  label: '工作台',
  description: '查看站点概况，快速进入常用管理功能。',
  icon: LayoutDashboard,
};

export const ADMIN_NAVIGATION: {
  label: string;
  items: AdminNavigationItem[];
}[] = [
  {
    label: '内容管理',
    items: [
      {
        id: 'videoSource',
        label: '视频源',
        description: '管理视频接口、访问代理与播放优先级。',
        icon: ListVideo,
      },
      {
        id: 'liveSource',
        label: '直播源',
        description: '维护直播订阅、频道列表与节目单。',
        icon: Radio,
      },
      {
        id: 'categoryConfig',
        label: '内容分类',
        description: '设置首页分类及其展示顺序。',
        icon: FolderOpen,
      },
      {
        id: 'sourceTest',
        label: '源检测',
        description: '检查内容源的连接情况与可用性。',
        icon: ScanLine,
        transient: true,
      },
    ],
  },
  {
    label: '站点设置',
    items: [
      {
        id: 'siteConfig',
        label: '站点配置',
        description: '调整站点信息、数据代理、搜索播放与定时任务。',
        icon: Settings2,
      },
      {
        id: 'homePageConfig',
        label: '首页模块',
        description: '选择首页展示的内容模块。',
        icon: Home,
      },
      {
        id: 'downloadConfig',
        label: '离线下载',
        description: '控制站点的离线下载功能。',
        icon: Download,
      },
      {
        id: 'customAdFilter',
        label: '去广告规则',
        description: '维护播放广告过滤规则与脚本。',
        icon: Blocks,
      },
    ],
  },
  {
    label: '用户与安全',
    items: [
      {
        id: 'userConfig',
        label: '用户管理',
        description: '管理账号、用户组、访问权限与注册审核。',
        icon: Users,
      },
      {
        id: 'inviteCodeManager',
        label: '邀请码',
        description: '创建和管理注册邀请码。',
        icon: Ticket,
        ownerOnly: true,
      },
      {
        id: 'oidcAuthConfig',
        label: '第三方登录',
        description: '配置 OIDC 身份提供商与登录方式。',
        icon: KeyRound,
        ownerOnly: true,
      },
      {
        id: 'tvboxSecurityConfig',
        label: 'TVBox 安全',
        description: '管理访问令牌、IP 白名单和请求频率。',
        icon: ShieldCheck,
      },
      {
        id: 'trustedNetworkConfig',
        label: '信任网络',
        description: '配置可信网络的访问策略。',
        icon: ShieldCheck,
        ownerOnly: true,
      },
    ],
  },
  {
    label: '服务集成',
    items: [
      {
        id: 'netdiskConfig',
        label: '网盘搜索',
        description: '连接网盘搜索服务并选择支持的网盘类型。',
        icon: HardDrive,
      },
      {
        id: 'embyConfig',
        label: 'Emby 影库',
        description: '连接和管理私人媒体库。',
        icon: Tv,
      },
      {
        id: 'danmuApiConfig',
        label: '弹幕服务',
        description: '管理弹幕接口与匹配设置。',
        icon: MessageSquare,
        ownerOnly: true,
      },
      {
        id: 'emailConfig',
        label: '邮件通知',
        description: '设置邮件服务器、发件人及通知服务。',
        icon: Mail,
        ownerOnly: true,
      },
      {
        id: 'webhookConfig',
        label: 'Webhook',
        description: '配置事件通知的接收地址。',
        icon: Bell,
        ownerOnly: true,
      },
    ],
  },
  {
    label: '系统维护',
    items: [
      {
        id: 'configFile',
        label: '配置文件',
        description: '管理配置订阅并编辑站点配置文件。',
        icon: FileCode2,
        ownerOnly: true,
      },
      {
        id: 'cacheManager',
        label: '缓存管理',
        description: '查看缓存使用情况并按需清理。',
        icon: Database,
        ownerOnly: true,
        transient: true,
      },
      {
        id: 'dataMigration',
        label: '数据迁移',
        description: '备份、导入与迁移站点数据。',
        icon: Database,
        ownerOnly: true,
        transient: true,
      },
      {
        id: 'performanceMonitor',
        label: '性能监控',
        description: '查看服务性能和资源使用情况。',
        icon: Activity,
        ownerOnly: true,
        transient: true,
      },
      {
        id: 'maintenance',
        label: '维护操作',
        description: '管理站点配置的恢复与重置。',
        icon: Wrench,
        ownerOnly: true,
      },
    ],
  },
];

export function getAdminNavigation(role: AdminRole | null) {
  return ADMIN_NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => role === 'owner' || !item.ownerOnly),
  })).filter((group) => group.items.length > 0);
}

export function resolveAdminSection(
  value: string | null,
  role: AdminRole | null,
): AdminNavigationItem {
  return (
    getAdminNavigation(role)
      .flatMap((group) => group.items)
      .find((item) => item.id === value) || ADMIN_OVERVIEW
  );
}

export function getAdminSectionHref(id: AdminSectionId) {
  return id === 'overview' ? '/admin' : `/admin?section=${id}`;
}
