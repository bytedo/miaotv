export interface AdminConfig {
  ConfigSubscribtion: {
    URL: string;
    AutoUpdate: boolean;
    LastCheck: string;
  };
  ConfigFile: string;
  SiteConfig: {
    SiteName: string;
    Announcement: string;
    SearchDownstreamMaxPage: number;
    SiteInterfaceCacheTime: number;
    DoubanProxyType: string;
    DoubanProxy: string;
    DoubanImageProxyType: string;
    DoubanImageProxy: string;
    DisableYellowFilter: boolean;
    ShowAdultContent: boolean; // 是否显示成人内容，默认 false
    FluidSearch: boolean;
    EnableWebLive: boolean;
    EnableEmby?: boolean;
    EnableWebSR?: boolean;
    // TMDB配置
    TMDBApiKey?: string;
    TMDBLanguage?: string;
    EnableTMDBActorSearch?: boolean;
    // Bangumi API 代理
    BangumiApiType?: string;
    BangumiApiProxy?: string;
    // Bangumi 图片代理
    BangumiImageProxyType?: string;
    BangumiImageProxy?: string;
    // 自定义去广告代码
    CustomAdFilterCode?: string;
    CustomAdFilterVersion?: number;
    // 默认用户组
    DefaultUserTags?: string[];
  };
  UserConfig: {
    AllowRegister?: boolean; // 是否允许用户注册，默认 true
    RequireApproval?: boolean; // 无有效邀请码的新注册是否需要审核，默认 false
    RequireInviteCode?: boolean; // 注册是否必须提供有效邀请码；邀请码注册免审核，默认 false
    AutoCleanupInactiveUsers?: boolean; // 是否自动清理非活跃用户，默认 false
    InactiveUserDays?: number; // 非活跃用户保留天数，默认 7
    Users: {
      uid?: string; // 不可变用户标识；旧账号读取时自动补齐并持久化
      username: string;
      role: 'user' | 'admin' | 'owner';
      banned?: boolean;
      pending?: boolean; // 待审核状态 (bytedo 本地功能)
      email?: string; // 用户邮箱 (bytedo 本地功能)
      source?: string; // 注册来源/申请理由 (bytedo 本地功能)
      enabledApis?: string[]; // 优先级高于tags限制（网站内搜索用）
      tags?: string[]; // 多 tags 取并集限制
      createdAt?: number; // 用户注册时间戳
      tvboxToken?: string; // 用户专属的 TVBox Token
      tvboxEnabledSources?: string[]; // TVBox 可访问的源（为空则返回所有源）
      showAdultContent?: boolean; // 用户级别的成人内容显示控制
      oidcSub?: string; // OIDC的唯一标识符(sub字段)
      embyConfig?: {
        sources: Array<{
          key: string;                       // 唯一标识
          name: string;                      // 显示名称
          enabled: boolean;                  // 是否启用
          ServerURL: string;                 // Emby服务器地址
          ApiKey?: string;                   // API Key（推荐方式）
          Username?: string;                 // 用户名
          Password?: string;                 // 密码
          UserId?: string;                   // 用户ID
          AuthToken?: string;                // 认证令牌
          Libraries?: string[];              // 媒体库ID
          removeEmbyPrefix?: boolean;        // 移除/emby前缀
          appendMediaSourceId?: boolean;     // 拼接MediaSourceId参数
          transcodeMp4?: boolean;            // 转码mp4
          proxyPlay?: boolean;               // 视频播放代理
          embyAuthorizationHeader?: string;  // 自定义 X-Emby-Authorization 头
        }>;
      };
    }[];
    Tags?: {
      name: string;
      enabledApis: string[];
      showAdultContent?: boolean; // 用户组级别的成人内容显示控制
    }[];
  };
  SourceConfig: {
    key: string;
    name: string;
    api: string;
    detail?: string;
    from: 'config' | 'custom';
    disabled?: boolean;
    is_adult?: boolean;
    type?: 'vod' | 'shortdrama'; // 视频源类型：vod=普通视频，shortdrama=短剧（系统会自动查找"短剧"分类）
    weight?: number; // 优先级权重：0-100，数字越大优先级越高，默认50。播放时先按权重排序，同权重再按测速结果
  }[];
  CustomCategories: {
    name?: string;
    type: 'movie' | 'tv';
    query: string;
    from: 'config' | 'custom';
    disabled?: boolean;
  }[];
  LiveConfig?: {
    key: string;
    name: string;
    url: string; // m3u 地址
    ua?: string;
    epg?: string; // 节目单
    isTvBox?: boolean;
    from: 'config' | 'custom';
    channelNumber?: number;
    disabled?: boolean;
  }[];
  NetDiskConfig?: {
    enabled: boolean;                    // 是否启用网盘搜索
    pansouUrl: string;                   // PanSou服务地址
    timeout: number;                     // 请求超时时间(秒)
    enabledCloudTypes: string[];         // 启用的网盘类型
    token?: string;                      // PanSou Bearer Token（可选）
    username?: string;                   // PanSou 登录用户名（可选）
    password?: string;                   // PanSou 登录密码（可选）
  };
  TVBoxSecurityConfig?: {
    enableAuth: boolean; // 是否启用Token验证
    token: string; // 访问Token
    enableIpWhitelist: boolean; // 是否启用IP白名单
    allowedIPs: string[]; // 允许的IP地址列表
    enableRateLimit: boolean; // 是否启用频率限制
    rateLimit: number; // 每分钟允许的请求次数
  };
  TVBoxProxyConfig?: {
    enabled: boolean; // 是否为TVBox启用Cloudflare Worker代理
    proxyUrl: string; // Cloudflare Worker代理地址（例如：https://corsapi.smone.workers.dev）
  };
  VideoProxyConfig?: {
    enabled: boolean; // 是否为普通视频源启用Cloudflare Worker代理
    proxyUrl: string; // Cloudflare Worker代理地址（例如：https://corsapi.smone.workers.dev）
  };
  // 旧的单 Provider 配置（保留用于向后兼容）
  OIDCAuthConfig?: {
    enabled: boolean; // 是否启用OIDC登录
    enableRegistration: boolean; // 是否启用OIDC注册
    issuer: string; // OIDC Issuer URL (用于自动发现)
    authorizationEndpoint: string; // 授权端点
    tokenEndpoint: string; // Token端点
    userInfoEndpoint: string; // 用户信息端点
    clientId: string; // OIDC Client ID
    clientSecret: string; // OIDC Client Secret
    buttonText: string; // OIDC登录按钮文字
    minTrustLevel: number; // 最低信任等级（仅LinuxDo网站有效，为0时不判断）
  };
  // 新的多 Provider 配置
  OIDCProviders?: {
    id: string; // Provider ID (google, github, microsoft, linuxdo, custom)
    name: string; // 显示名称
    enabled: boolean; // 是否启用此Provider
    enableRegistration: boolean; // 是否启用注册
    issuer: string; // OIDC Issuer URL
    authorizationEndpoint: string; // 授权端点
    tokenEndpoint: string; // Token端点
    userInfoEndpoint: string; // 用户信息端点
    clientId: string; // Client ID
    clientSecret: string; // Client Secret
    buttonText: string; // 按钮文字
    minTrustLevel: number; // 最低信任等级
  }[];
  ShortDramaConfig?: {
    primaryApiUrl: string; // 主API地址
    alternativeApiUrl: string; // 备用API地址（私密）
    enableAlternative: boolean; // 是否启用备用API
  };
  DownloadConfig?: {
    enabled: boolean; // 是否启用下载功能（全局开关）
  };
  EmailConfig?: {
    // bytedo 本地功能：邮件配置
    enabled: boolean; // 是否启用邮件功能
    smtpHost: string; // SMTP服务器地址
    smtpPort: number; // SMTP端口
    smtpSecure: boolean; // 是否使用SSL/TLS
    smtpUser: string; // SMTP用户名
    smtpPass: string; // SMTP密码
    senderName: string; // 发件人名称
    senderEmail: string; // 发件人邮箱
  };
  WebhookConfig?: {
    // bytedo 本地功能：Webhook 配置
    enabled: boolean; // 是否启用 Webhook
    url: string; // Webhook URL
    secret?: string; // 签名密钥
    notifyOnRegister: boolean; // 新用户注册待审核时通知
    messageTemplate?: string; // 消息模板
  };
  DoubanConfig?: {
    enablePuppeteer: boolean; // 是否启用 Puppeteer 绕过 Challenge（默认 false）
    cookies?: string; // 豆瓣认证 Cookies（包含 dbcl2, frodotk_db, ck 等）
  };
  CronConfig?: {
    enableAutoRefresh: boolean; // 是否启用自动刷新播放记录和收藏（默认 true）
    maxRecordsPerRun: number; // 每次运行最多处理的记录数（默认 100）
    onlyRefreshRecent: boolean; // 仅刷新最近活跃的记录（默认 true）
    recentDays: number; // 最近活跃的天数定义（默认 30）
    onlyRefreshOngoing: boolean; // 仅刷新连载中的剧集（默认 true）
  };
  TrustedNetworkConfig?: {
    enabled: boolean;                    // 是否启用信任网络模式（内网免登录）
    trustedIPs: string[];               // 信任的IP/CIDR列表（如 192.168.0.0/16, 10.0.0.0/8）
    blockAdminAccess?: boolean;          // 是否禁止信任网络访客访问后台（默认 false 保持现状）
  };
  DanmuApiConfig?: {
    enabled: boolean; // 是否启用弹幕API（默认启用）
    useCustomApi: boolean; // 是否使用自定义API（false则使用默认API）
    customApiUrl: string; // 自定义弹幕API地址
    customToken: string; // 自定义API Token
    timeout: number; // 请求超时时间（秒），默认15
  };
  EmbyConfig?: {
    // 多源配置
    Sources?: Array<{
      key: string;                       // 唯一标识，如 'emby1', 'emby2'
      name: string;                      // 显示名称，如 '家庭Emby', '公司Emby'
      enabled: boolean;                  // 是否启用
      ServerURL: string;                 // Emby服务器地址
      ApiKey?: string;                   // API Key（推荐方式）
      Username?: string;                 // 用户名（或使用API Key）
      Password?: string;                 // 密码
      UserId?: string;                   // 用户ID（登录后获取）
      AuthToken?: string;                // 认证令牌（用户名密码登录后获取）
      Libraries?: string[];              // 要显示的媒体库ID（可选，默认全部）
      LastSyncTime?: number;             // 最后同步时间戳
      ItemCount?: number;                // 媒体项数量
      isDefault?: boolean;               // 是否为默认源（用于向后兼容）
      isPublic?: boolean;                // 是否对所有用户开放（公共源）
      // 高级流媒体选项
      removeEmbyPrefix?: boolean;        // 播放链接移除/emby前缀
      appendMediaSourceId?: boolean;     // 拼接MediaSourceId参数
      transcodeMp4?: boolean;            // 转码mp4
      proxyPlay?: boolean;               // 视频播放代理开关
      embyAuthorizationHeader?: string;  // 自定义 X-Emby-Authorization 头
    }>;
  };
  CustomSpiderJar?: string;              // 自定义 Spider JAR URL（全局配置）
  HomePageConfig?: {
    showHeroBanner: boolean;
    showContinueWatching: boolean;
    showUpcomingReleases: boolean;
    showHotMovies: boolean;
    showHotTvShows: boolean;
    showNewAnime: boolean;
    showHotVariety: boolean;
    showHotShortDramas: boolean;
  };
}

export interface AdminConfigResult {
  Role: 'owner' | 'admin';
  Config: AdminConfig;
}

// 🎯 Cron 配置默认值（统一管理，避免多处定义）
export const DEFAULT_CRON_CONFIG = {
  enableAutoRefresh: true,
  maxRecordsPerRun: 50,      // 优化：平衡性能和资源消耗
  onlyRefreshRecent: true,
  recentDays: 21,            // 优化：覆盖最近3周活跃用户
  onlyRefreshOngoing: true,
} as const;
