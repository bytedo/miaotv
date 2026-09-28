/* eslint-disable no-console */


import { db } from '@/lib/db';

import { AdminConfig } from './admin.types';
import { OPTIONAL_FEATURES, type OptionalFeature } from './optional-features';
import { stripRemovedFeatureConfig } from './retired-features';
import { DEFAULT_USER_AGENT } from './user-agent';

export interface ApiSite {
  key: string;
  api: string;
  name: string;
  detail?: string;
}

export interface LiveCfg {
  name: string;
  url: string;
  ua?: string;
  epg?: string; // 节目单
  isTvBox?: boolean;
}

interface ConfigFileStruct {
  cache_time?: number;
  api_site?: {
    [key: string]: ApiSite;
  };
  custom_category?: {
    name?: string;
    type: 'movie' | 'tv';
    query: string;
  }[];
  lives?: {
    [key: string]: LiveCfg;
  };
}

export const API_CONFIG = {
  search: {
    path: '?ac=videolist&wd=',
    pagePath: '?ac=videolist&wd={query}&pg={page}',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
  },
  detail: {
    path: '?ac=videolist&ids=',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
  },
};

// 在模块加载时根据环境决定配置来源
let cachedConfig: AdminConfig;
// 缓存写入时间：超过 TTL 后重新读库，
// 使多实例部署下另一实例修改的配置（封禁、换源、公告等）能自动生效
let cachedConfigAt = 0;
// 正在进行中的读取，避免冷启动时并发请求同时打库
let pendingConfig: Promise<AdminConfig> | null = null;
let cachedConfigRevision = -1;
let pendingConfigRevision = -1;
// Next.js may load separate copies of this module for API routes and RSC pages.
// Share invalidation across those copies without sharing their mutable config.
const configCacheProcess = globalThis as typeof globalThis & {
  __miaotvConfigRevision?: number;
};
function getConfigRevision(): number {
  return configCacheProcess.__miaotvConfigRevision ?? 0;
}
const CONFIG_TTL_MS = 5 * 60 * 1000;
const LEGACY_USER_UID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type ConfigUser = AdminConfig['UserConfig']['Users'][number];

// 从配置文件补充管理员配置
export function refineConfig(adminConfig: AdminConfig): AdminConfig {
  let fileConfig: ConfigFileStruct;
  try {
    fileConfig = JSON.parse(adminConfig.ConfigFile) as ConfigFileStruct;
  } catch (e) {
    fileConfig = {} as ConfigFileStruct;
  }

  // 合并文件中的源信息
  const apiSitesFromFile = Object.entries(fileConfig.api_site || []);

  // 保留所有现有源（包括 custom 和 config），以便保留用户的手动修改
  const currentApiSites = new Map(
    (adminConfig.SourceConfig || []).map((s) => [s.key, s]),
  );

  // 获取配置文件中的所有源 key
  const apiKeysInFile = new Set(apiSitesFromFile.map(([key]) => key));

  // 删除不在配置文件中的 from='config' 的源
  currentApiSites.forEach((source, key) => {
    if (source.from === 'config' && !apiKeysInFile.has(key)) {
      currentApiSites.delete(key);
    }
  });

  // 添加或更新订阅中的所有源
  apiSitesFromFile.forEach(([key, site]) => {
    const existingSource = currentApiSites.get(key);
    if (existingSource) {
      // 如果源已存在，更新基本信息但保留用户手动设置的字段
      existingSource.name = site.name;
      existingSource.api = site.api;
      existingSource.detail = site.detail;
      // 保留用户手动设置的 from、type、is_adult、disabled 等字段
    } else {
      // 添加新的订阅源
      currentApiSites.set(key, {
        key,
        name: site.name,
        api: site.api,
        detail: site.detail,
        from: 'config',
        disabled: false,
        type: 'vod', // 默认为普通视频类型
      });
    }
  });

  // 将 Map 转换回数组
  adminConfig.SourceConfig = Array.from(currentApiSites.values());

  // 覆盖 CustomCategories
  const customCategoriesFromFile = fileConfig.custom_category || [];

  // 保留所有现有自定义分类（包括 custom 和 config），以便保留用户的手动修改
  const currentCustomCategories = new Map(
    (adminConfig.CustomCategories || []).map((c) => [c.query + c.type, c]),
  );

  // 获取配置文件中的所有分类 key
  const categoryKeysInFile = new Set(
    customCategoriesFromFile.map((c) => c.query + c.type),
  );

  // 删除不在配置文件中的 from='config' 的分类
  currentCustomCategories.forEach((category, key) => {
    if (category.from === 'config' && !categoryKeysInFile.has(key)) {
      currentCustomCategories.delete(key);
    }
  });

  // 添加或更新订阅中的所有自定义分类
  customCategoriesFromFile.forEach((category) => {
    const key = category.query + category.type;
    const existedCategory = currentCustomCategories.get(key);
    if (existedCategory) {
      // 如果分类已存在，更新基本信息但保留用户手动设置的字段
      existedCategory.name = category.name;
      existedCategory.query = category.query;
      existedCategory.type = category.type;
      // 保留用户手动设置的 from、disabled 等字段
    } else {
      // 添加新的订阅分类
      currentCustomCategories.set(key, {
        name: category.name,
        type: category.type,
        query: category.query,
        from: 'config',
        disabled: false,
      });
    }
  });

  // 将 Map 转换回数组
  adminConfig.CustomCategories = Array.from(currentCustomCategories.values());

  const livesFromFile = Object.entries(fileConfig.lives || []);

  // 保留所有现有直播源（包括 custom 和 config），以便保留用户的手动修改
  const currentLives = new Map(
    (adminConfig.LiveConfig || []).map((l) => [l.key, l]),
  );

  // 获取配置文件中的所有直播源 key
  const liveKeysInFile = new Set(livesFromFile.map(([key]) => key));

  // 删除不在配置文件中的 from='config' 的直播源
  currentLives.forEach((live, key) => {
    if (live.from === 'config' && !liveKeysInFile.has(key)) {
      currentLives.delete(key);
    }
  });

  // 添加或更新订阅中的所有直播源
  livesFromFile.forEach(([key, site]) => {
    const existingLive = currentLives.get(key);
    if (existingLive) {
      // 如果直播源已存在，更新基本信息但保留用户手动设置的字段
      existingLive.name = site.name;
      existingLive.url = site.url;
      existingLive.ua = site.ua;
      existingLive.epg = site.epg;
      // 保留用户手动设置的 from、disabled、channelNumber 等字段
    } else {
      // 添加新的订阅直播源
      currentLives.set(key, {
        key,
        name: site.name,
        url: site.url,
        ua: site.ua,
        epg: site.epg,
        channelNumber: 0,
        from: 'config',
        disabled: false,
      });
    }
  });

  // 将 Map 转换回数组
  adminConfig.LiveConfig = Array.from(currentLives.values());

  return adminConfig;
}

async function getInitConfig(
  configFile: string,
  subConfig: {
    URL: string;
    AutoUpdate: boolean;
    LastCheck: string;
  } = {
    URL: process.env.NEXT_PUBLIC_SUB_URL || '',
    AutoUpdate: false,
    LastCheck: '',
  },
): Promise<AdminConfig> {
  let cfgFile: ConfigFileStruct;
  try {
    cfgFile = JSON.parse(configFile) as ConfigFileStruct;
  } catch (e) {
    cfgFile = {} as ConfigFileStruct;
  }
  const adminConfig: AdminConfig = {
    ConfigFile: configFile,
    ConfigSubscribtion: subConfig,
    SiteConfig: {
      SiteName: process.env.NEXT_PUBLIC_SITE_NAME || 'MiaoTV',
      Announcement:
        process.env.ANNOUNCEMENT ||
        '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',
      SearchDownstreamMaxPage:
        Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 5,
      SiteInterfaceCacheTime: cfgFile.cache_time || 7200,
      DoubanProxyType: process.env.NEXT_PUBLIC_DOUBAN_PROXY_TYPE || 'direct',
      DoubanProxy: process.env.NEXT_PUBLIC_DOUBAN_PROXY || '',
      DoubanImageProxyType:
        process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE || 'server',
      DoubanImageProxy: process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY || '',
      BangumiApiType: process.env.NEXT_PUBLIC_BANGUMI_API_TYPE || 'cmliussss',
      BangumiApiProxy: process.env.NEXT_PUBLIC_BANGUMI_API_PROXY || '',
      BangumiImageProxyType:
        process.env.NEXT_PUBLIC_BANGUMI_IMAGE_PROXY_TYPE || 'cmliussss',
      BangumiImageProxy: process.env.NEXT_PUBLIC_BANGUMI_IMAGE_PROXY || '',
      DisableYellowFilter:
        process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true',
      ShowAdultContent: false, // 默认不显示成人内容，可在管理面板修改
      FluidSearch: process.env.NEXT_PUBLIC_FLUID_SEARCH !== 'false',
      EnableWebLive: true,
      // TMDB配置默认值
      TMDBApiKey: process.env.TMDB_API_KEY || '',
      TMDBLanguage: 'zh-CN',
      EnableTMDBActorSearch: false, // 默认关闭，需要配置API Key后手动开启
    },
    UserConfig: {
      AllowRegister: true, // 默认允许注册
      Users: [],
    },
    SourceConfig: [],
    CustomCategories: [],
    LiveConfig: [],
    TVBoxProxyConfig: {
      enabled: false,
      proxyUrl:
        process.env.NEXT_PUBLIC_CORSAPI_URL ||
        'https://corsapi.smone.workers.dev',
    },
    VideoProxyConfig: {
      enabled: false,
      proxyUrl:
        process.env.NEXT_PUBLIC_CORSAPI_URL ||
        'https://corsapi.smone.workers.dev',
    },
  };

  // 补充用户信息
  let userNames: string[] = [];
  try {
    userNames = await db.getAllUsers();
  } catch (e) {
    console.error('获取用户列表失败:', e);
  }
  const allUsers = userNames
    .filter((u) => u !== process.env.USERNAME)
    .map((u) => ({
      username: u,
      role: 'user',
      banned: false,
    }));
  allUsers.unshift({
    username: process.env.USERNAME!,
    role: 'owner',
    banned: false,
  });
  adminConfig.UserConfig.Users = allUsers as any;

  // 从配置文件中补充源信息
  Object.entries(cfgFile.api_site || []).forEach(([key, site]) => {
    adminConfig.SourceConfig.push({
      key: key,
      name: site.name,
      api: site.api,
      detail: site.detail,
      from: 'config',
      disabled: false,
    });
  });

  // 从配置文件中补充自定义分类信息
  cfgFile.custom_category?.forEach((category) => {
    adminConfig.CustomCategories.push({
      name: category.name || category.query,
      type: category.type,
      query: category.query,
      from: 'config',
      disabled: false,
    });
  });

  // 从配置文件中补充直播源信息
  Object.entries(cfgFile.lives || []).forEach(([key, live]) => {
    if (!adminConfig.LiveConfig) {
      adminConfig.LiveConfig = [];
    }
    adminConfig.LiveConfig.push({
      key,
      name: live.name,
      url: live.url,
      ua: live.ua,
      epg: live.epg,
      isTvBox: live.isTvBox,
      channelNumber: 0,
      from: 'config',
      disabled: false,
    });
  });

  return adminConfig;
}

export async function getConfig(): Promise<AdminConfig> {
  const revision = getConfigRevision();
  // A process may retain a UUID snapshot while storage migrates to numeric UIDs.
  // Reload it once through storage normalization before any policy reader sees it.
  if (
    cachedConfig && cachedConfigRevision === revision &&
    cachedConfig.UserConfig.Users.some(user =>
      typeof user.uid === 'string' && LEGACY_USER_UID_PATTERN.test(user.uid)
    )
  ) {
    clearConfigCache();
    return getConfig();
  }
  // 命中未过期的内存缓存
  if (
    cachedConfig &&
    cachedConfigRevision === revision &&
    Date.now() - cachedConfigAt < CONFIG_TTL_MS
  ) {
    // Settings handlers edit their snapshot before persisting it. Never expose
    // those uncommitted edits to authentication or other configuration readers.
    return structuredClone(cachedConfig);
  }

  // 已有在途读取则复用，避免并发重复打库
  if (pendingConfig && pendingConfigRevision === revision) {
    return structuredClone(await pendingConfig);
  }

  const request = (async () => {
    // 读 db
    let adminConfig: AdminConfig | null = null;
    try {
      adminConfig = await db.getAdminConfig();
    } catch (e) {
      if (revision !== getConfigRevision()) return getConfig();
      console.error('获取管理员配置失败:', e);
      // Only fall back to a cache that has not been explicitly invalidated.
      if (cachedConfig && cachedConfigRevision === revision) {
        cachedConfigAt = Date.now();
        return cachedConfig;
      }
      throw e;
    }
    if (revision !== getConfigRevision()) return getConfig();

    // db 中无配置，执行一次初始化
    const needInit = !adminConfig;
    if (!adminConfig) {
      adminConfig = await getInitConfig('');
    }
    adminConfig = await configSelfCheck(adminConfig);
    if (revision !== getConfigRevision()) return getConfig();
    // 仅在首次初始化时回写，避免每次缓存过期都产生一次写库
    if (needInit) {
      try {
        await db.saveAdminConfig(adminConfig);
      } catch (e) {
        console.error('保存管理员配置失败:', e);
      }
    }
    // A settings update can race any awaited read; never publish its old result.
    if (revision !== getConfigRevision()) return getConfig();
    cachedConfig = adminConfig;
    cachedConfigAt = Date.now();
    cachedConfigRevision = revision;
    return adminConfig;
  })();

  pendingConfig = request;
  pendingConfigRevision = revision;
  try {
    return structuredClone(await request);
  } finally {
    if (pendingConfig === request) {
      pendingConfig = null;
      pendingConfigRevision = -1;
    }
  }
}

// 清除配置缓存，强制重新从数据库读取
export function clearConfigCache(): void {
  configCacheProcess.__miaotvConfigRevision = getConfigRevision() + 1;
  cachedConfig = null as any;
  cachedConfigAt = 0;
  cachedConfigRevision = -1;
}

export async function configSelfCheck(
  adminConfig: AdminConfig,
): Promise<AdminConfig> {
  // 确保必要的属性存在和初始化
  if (!adminConfig.UserConfig) {
    adminConfig.UserConfig = { AllowRegister: true, Users: [] };
  }
  if (
    !adminConfig.UserConfig.Users ||
    !Array.isArray(adminConfig.UserConfig.Users)
  ) {
    adminConfig.UserConfig.Users = [];
  }

  // 🔥 关键修复：每次都从数据库获取最新的用户列表
  try {
    const dbUsers = await db.getAllUsers();
    const ownerUser = process.env.USERNAME;
    const configuredOwner = adminConfig.UserConfig.Users.find(
      (user) => user.username === ownerUser,
    );

    // 创建用户列表：保留数据库中存在的用户的配置信息
    const resolvedUsers = await Promise.all(
      dbUsers.map(async (username): Promise<ConfigUser | null> => {
        const identity = await db.getUserIdentity(username);
        // A disappeared numeric username must never be retried as another UID.
        if (!identity) return null;
        const userRef = identity.uid;
        const storedEmail = await db.getUserEmail(userRef);
        // 查找现有配置中是否有这个用户
        const existingUserConfig = adminConfig.UserConfig.Users.find(
          (u) => u.uid
            ? u.uid === identity.uid || identity.legacyUids?.includes(u.uid)
            : u.username === identity.username,
        );

        if (existingUserConfig) {
          return {
            ...existingUserConfig,
            uid: identity.uid,
            username: identity.username,
            email: storedEmail || existingUserConfig.email || undefined,
          };
        } else {
          // 新用户，创建默认配置
          let createdAt = Date.now();
          let oidcSub: string | undefined;
          let tags: string[] | undefined;
          let role: 'owner' | 'admin' | 'user' =
            username === ownerUser ? 'owner' : 'user';
          let banned = false;
          let pending = false;
          let email: string | undefined;
          let source: string | undefined;
          let enabledApis: string[] | undefined;

          try {
            // 从数据库V2获取用户信息（OIDC/新版用户）
            const userInfoV2 = await db.getUserInfoV2(userRef);
            if (userInfoV2) {
              createdAt = userInfoV2.createdAt || Date.now();
              oidcSub = userInfoV2.oidcSub;
              tags = userInfoV2.tags;
              role = userInfoV2.role || role;
              banned = userInfoV2.banned || false;
              pending = userInfoV2.pending || false;
              email = userInfoV2.email;
              source = userInfoV2.source;
              enabledApis = userInfoV2.enabledApis;
            }
            email = storedEmail || email;
          } catch (err) {
            // Keep the existing configuration if any account cannot be read.
            // A transient lookup failure must not rebuild it as an unbanned user.
            throw new Error(`无法读取用户 ${username} 的账号信息`, {
              cause: err,
            });
          }

          const newUserConfig: ConfigUser = {
            uid: identity.uid,
            username: identity.username,
            role,
            banned,
            pending,
            createdAt,
          };

          if (email) newUserConfig.email = email.trim().toLowerCase();
          if (source) newUserConfig.source = source;

          if (oidcSub) {
            newUserConfig.oidcSub = oidcSub;
          }
          if (tags && tags.length > 0) {
            newUserConfig.tags = tags;
          }
          if (enabledApis && enabledApis.length > 0) {
            newUserConfig.enabledApis = enabledApis;
          }

          return newUserConfig;
        }
      }),
    );

    const updatedUsers = resolvedUsers.filter((user): user is ConfigUser => user !== null);

    // The environment owner may have no password row. Keep its saved profile
    // when synchronizing database-backed accounts as well.
    if (
      configuredOwner &&
      !updatedUsers.some((user) => user.username === ownerUser)
    ) {
      updatedUsers.push(configuredOwner);
    }

    // 更新用户列表
    adminConfig.UserConfig.Users = updatedUsers;
  } catch (e) {
    console.error('获取最新用户列表失败:', e);
    // 失败时继续使用现有配置
  }
  adminConfig.SiteConfig ||= {} as AdminConfig['SiteConfig'];
  // Preserve the existing live TV feature when upgrading pre-toggle settings.
  adminConfig.SiteConfig.EnableWebLive ??= true;
  for (const feature of Object.keys(OPTIONAL_FEATURES) as OptionalFeature[]) {
    adminConfig.SiteConfig[feature] ??= false;
  }

  // 确保 AllowRegister 有默认值
  if (adminConfig.UserConfig.AllowRegister === undefined) {
    adminConfig.UserConfig.AllowRegister = true;
  }
  if (adminConfig.UserConfig.RequireApproval === undefined) {
    adminConfig.UserConfig.RequireApproval = false;
  }
  if (adminConfig.UserConfig.RequireInviteCode === undefined) {
    adminConfig.UserConfig.RequireInviteCode = false;
  }
  if (!adminConfig.SourceConfig || !Array.isArray(adminConfig.SourceConfig)) {
    adminConfig.SourceConfig = [];
  }
  if (
    !adminConfig.CustomCategories ||
    !Array.isArray(adminConfig.CustomCategories)
  ) {
    adminConfig.CustomCategories = [];
  }
  if (!adminConfig.LiveConfig || !Array.isArray(adminConfig.LiveConfig)) {
    adminConfig.LiveConfig = [];
  }

  // 确保网盘搜索配置有默认值
  if (!adminConfig.NetDiskConfig) {
    adminConfig.NetDiskConfig = {
      enabled: true, // 默认启用
      pansouUrl: 'https://so.252035.xyz', // 默认公益服务
      timeout: 30, // 默认30秒超时
      enabledCloudTypes: ['baidu', 'aliyun', 'quark'], // 默认只启用百度、阿里、夸克三大主流网盘
      token: '',
      username: '',
      password: '',
    };
  }

  // 确保短剧配置有默认值
  if (!adminConfig.ShortDramaConfig) {
    adminConfig.ShortDramaConfig = {
      primaryApiUrl: 'https://tyyszyapi.com/api.php/provide/vod', // 默认主API
      alternativeApiUrl: '', // 默认为空，需要管理员配置
      enableAlternative: false, // 默认关闭备用API
    };
  }

  // 确保下载配置有默认值
  if (!adminConfig.DownloadConfig) {
    adminConfig.DownloadConfig = {
      enabled: true, // 默认启用下载功能
    };
  }

  // 确保豆瓣配置有默认值
  if (!adminConfig.DoubanConfig) {
    adminConfig.DoubanConfig = {
      enablePuppeteer: false, // 默认关闭 Puppeteer（省资源）
    };
  }

  // 确保 Cron 配置有默认值
  if (!adminConfig.CronConfig) {
    adminConfig.CronConfig = {
      enableAutoRefresh: true, // 默认启用自动刷新
      maxRecordsPerRun: 100, // 每次最多处理 100 条记录
      onlyRefreshRecent: true, // 仅刷新最近活跃的记录
      recentDays: 30, // 最近 30 天内活跃
      onlyRefreshOngoing: true, // 仅刷新连载中的剧集
    };
  }

  // 🔥 OIDC 配置迁移：从单 Provider 迁移到多 Provider
  if (adminConfig.OIDCAuthConfig && !adminConfig.OIDCProviders) {
    // 自动识别 Provider ID
    let providerId = 'custom';
    const issuer = adminConfig.OIDCAuthConfig.issuer?.toLowerCase() || '';

    if (issuer.includes('google') || issuer.includes('accounts.google.com')) {
      providerId = 'google';
    } else if (issuer.includes('github')) {
      providerId = 'github';
    } else if (
      issuer.includes('microsoft') ||
      issuer.includes('login.microsoftonline.com')
    ) {
      providerId = 'microsoft';
    } else if (
      issuer.includes('linux.do') ||
      issuer.includes('connect.linux.do')
    ) {
      providerId = 'linuxdo';
    }

    // 迁移到新格式
    adminConfig.OIDCProviders = [
      {
        id: providerId,
        name: adminConfig.OIDCAuthConfig.buttonText || providerId.toUpperCase(),
        enabled: adminConfig.OIDCAuthConfig.enabled,
        enableRegistration: adminConfig.OIDCAuthConfig.enableRegistration,
        issuer: adminConfig.OIDCAuthConfig.issuer,
        authorizationEndpoint: adminConfig.OIDCAuthConfig.authorizationEndpoint,
        tokenEndpoint: adminConfig.OIDCAuthConfig.tokenEndpoint,
        userInfoEndpoint: adminConfig.OIDCAuthConfig.userInfoEndpoint,
        clientId: adminConfig.OIDCAuthConfig.clientId,
        clientSecret: adminConfig.OIDCAuthConfig.clientSecret,
        buttonText: adminConfig.OIDCAuthConfig.buttonText,
        minTrustLevel: adminConfig.OIDCAuthConfig.minTrustLevel || 0,
      },
    ];

    console.log(
      `[Config Migration] Migrated OIDCAuthConfig to OIDCProviders with provider: ${providerId}`,
    );

    // 保留旧配置一段时间以防回滚需要
    // delete adminConfig.OIDCAuthConfig;
  }

  // 站长变更自检
  const ownerUser = process.env.USERNAME;

  // 去重
  const seenUserIds = new Set<string>();
  adminConfig.UserConfig.Users = adminConfig.UserConfig.Users.filter((user) => {
    const userId = user.uid || user.username;
    if (seenUserIds.has(userId)) {
      return false;
    }
    seenUserIds.add(userId);
    return true;
  });
  // 过滤站长
  const originOwnerCfg = adminConfig.UserConfig.Users.find(
    (u) => u.username === ownerUser,
  );
  adminConfig.UserConfig.Users = adminConfig.UserConfig.Users.filter(
    (user) => user.username !== ownerUser,
  );
  // 其他用户不得拥有 owner 权限
  adminConfig.UserConfig.Users.forEach((user) => {
    if (user.role === 'owner') {
      user.role = 'user';
    }
  });
  // 重新添加回站长
  const ownerIdentity = ownerUser ? await db.getUserIdentity(ownerUser) : null;
  adminConfig.UserConfig.Users.unshift({
    ...originOwnerCfg,
    uid: ownerIdentity?.uid || originOwnerCfg?.uid,
    username: ownerUser!,
    role: 'owner',
    banned: false,
    pending: false,
  });

  // 采集源去重
  const seenSourceKeys = new Set<string>();
  adminConfig.SourceConfig = adminConfig.SourceConfig.filter((source) => {
    if (seenSourceKeys.has(source.key)) {
      return false;
    }
    seenSourceKeys.add(source.key);
    return true;
  });

  // 自定义分类去重
  const seenCustomCategoryKeys = new Set<string>();
  adminConfig.CustomCategories = adminConfig.CustomCategories.filter(
    (category) => {
      if (seenCustomCategoryKeys.has(category.query + category.type)) {
        return false;
      }
      seenCustomCategoryKeys.add(category.query + category.type);
      return true;
    },
  );

  // 直播源去重
  const seenLiveKeys = new Set<string>();
  adminConfig.LiveConfig = adminConfig.LiveConfig.filter((live) => {
    if (seenLiveKeys.has(live.key)) {
      return false;
    }
    seenLiveKeys.add(live.key);
    return true;
  });

  return stripRemovedFeatureConfig(adminConfig);
}

export async function resetConfig() {
  let originConfig: AdminConfig | null = null;
  try {
    originConfig = await db.getAdminConfig();
  } catch (e) {
    console.error('获取管理员配置失败:', e);
  }
  if (!originConfig) {
    originConfig = {} as AdminConfig;
  }
  const adminConfig = await getInitConfig(
    originConfig.ConfigFile,
    originConfig.ConfigSubscribtion,
  );
  await db.saveAdminConfig(adminConfig);
  await setCachedConfig(adminConfig);

  return;
}

export async function getCacheTime(): Promise<number> {
  const config = await getConfig();
  return config.SiteConfig.SiteInterfaceCacheTime || 7200;
}

// Helper function to apply VideoProxyConfig to API sites
function applyVideoProxy(sites: ApiSite[], config: AdminConfig): ApiSite[] {
  const proxyConfig = config.VideoProxyConfig;

  // If proxy is not enabled, return sites as-is
  if (!proxyConfig?.enabled || !proxyConfig.proxyUrl) {
    return sites;
  }

  const proxyBaseUrl = proxyConfig.proxyUrl.replace(/\/$/, ''); // Remove trailing slash

  return sites.map((source) => {
    // Extract real API URL (remove old proxy if exists)
    let realApiUrl = source.api;
    const urlMatch = source.api.match(/[?&]url=([^&]+)/);
    if (urlMatch) {
      realApiUrl = decodeURIComponent(urlMatch[1]);
      console.log(
        `[Video Proxy] ${source.name}: Detected old proxy, replacing with new proxy`,
      );
    }

    // Extract source ID from real API URL
    const extractSourceId = (apiUrl: string): string => {
      try {
        const url = new URL(apiUrl);
        const hostname = url.hostname;
        const parts = hostname.split('.');

        // For caiji.xxx.com or api.xxx.com format, take second-to-last part
        if (
          parts.length >= 3 &&
          (parts[0] === 'caiji' ||
            parts[0] === 'api' ||
            parts[0] === 'cj' ||
            parts[0] === 'www')
        ) {
          return parts[parts.length - 2]
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
        }

        // Otherwise take first part (remove zyapi/zy suffix)
        let name = parts[0].toLowerCase();
        name = name
          .replace(/zyapi$/, '')
          .replace(/zy$/, '')
          .replace(/api$/, '');
        return name.replace(/[^a-z0-9]/g, '') || 'source';
      } catch {
        return source.key || source.name.replace(/[^a-z0-9]/g, '');
      }
    };

    const sourceId = extractSourceId(realApiUrl);
    const proxiedApi = `${proxyBaseUrl}/p/${sourceId}?url=${encodeURIComponent(realApiUrl)}`;

    console.log(`[Video Proxy] ${source.name}: ✓ Applied proxy`);

    return {
      ...source,
      api: proxiedApi,
    };
  });
}

export async function getAvailableApiSites(user?: string): Promise<ApiSite[]> {
  const config = await getConfig();

  // 确定成人内容显示权限，优先级：用户 > 用户组 > 全局
  let showAdultContent = config.SiteConfig.ShowAdultContent;

  if (user) {
    const userConfig = config.UserConfig.Users.find((u) => u.username === user);

    if (userConfig) {
      // 用户级别优先
      if (userConfig.showAdultContent !== undefined) {
        showAdultContent = userConfig.showAdultContent;
      }
      // 如果用户没有设置，检查用户组设置
      else if (
        userConfig.tags &&
        userConfig.tags.length > 0 &&
        config.UserConfig.Tags
      ) {
        // 如果用户有多个用户组，只要有一个用户组允许就允许（取并集）
        const hasAnyTagAllowAdult = userConfig.tags.some((tagName) => {
          const tagConfig = config.UserConfig.Tags?.find(
            (t) => t.name === tagName,
          );
          return tagConfig?.showAdultContent === true;
        });
        if (hasAnyTagAllowAdult) {
          showAdultContent = true;
        } else {
          // 检查是否有任何用户组明确禁止
          const hasAnyTagDenyAdult = userConfig.tags.some((tagName) => {
            const tagConfig = config.UserConfig.Tags?.find(
              (t) => t.name === tagName,
            );
            return tagConfig?.showAdultContent === false;
          });
          if (hasAnyTagDenyAdult) {
            showAdultContent = false;
          }
        }
      }
    }
  }

  // 过滤掉禁用的源，如果未启用成人内容则同时过滤掉成人资源
  const allApiSites = config.SourceConfig.filter((s) => {
    if (s.disabled) return false;
    if (!showAdultContent && s.is_adult) return false;
    return true;
  });

  if (!user) {
    return applyVideoProxy(allApiSites, config);
  }

  const userConfig = config.UserConfig.Users.find((u) => u.username === user);
  if (!userConfig) {
    return applyVideoProxy(allApiSites, config);
  }

  // 优先根据用户自己的 enabledApis 配置查找
  if (userConfig.enabledApis && userConfig.enabledApis.length > 0) {
    const userApiSitesSet = new Set(userConfig.enabledApis);
    const userSites = allApiSites
      .filter((s) => userApiSitesSet.has(s.key))
      .map((s) => ({
        key: s.key,
        name: s.name,
        api: s.api,
        detail: s.detail,
      }));
    return applyVideoProxy(userSites, config);
  }

  // 如果没有 enabledApis 配置，则根据 tags 查找
  if (userConfig.tags && userConfig.tags.length > 0 && config.UserConfig.Tags) {
    const enabledApisFromTags = new Set<string>();

    // 遍历用户的所有 tags，收集对应的 enabledApis
    userConfig.tags.forEach((tagName) => {
      const tagConfig = config.UserConfig.Tags?.find((t) => t.name === tagName);
      if (tagConfig && tagConfig.enabledApis) {
        tagConfig.enabledApis.forEach((apiKey) =>
          enabledApisFromTags.add(apiKey),
        );
      }
    });

    if (enabledApisFromTags.size > 0) {
      const tagSites = allApiSites
        .filter((s) => enabledApisFromTags.has(s.key))
        .map((s) => ({
          key: s.key,
          name: s.name,
          api: s.api,
          detail: s.detail,
        }));
      return applyVideoProxy(tagSites, config);
    }
  }

  // 如果都没有配置，返回所有可用的 API 站点
  return applyVideoProxy(allApiSites, config);
}

export async function setCachedConfig(_config: AdminConfig) {
  // Callers persist first. A delayed save acknowledgement may carry an older
  // snapshot, so reload from storage on demand instead of caching its argument.
  clearConfigCache();
}
