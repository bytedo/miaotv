

import { AdminConfig } from './admin.types';
import { getLocalOwnerIdentity } from './auth.server';
import { getConfig } from './config';
import { dbManager } from './db';
import { EmbyClient } from './emby.client';
import { canManageEmbySources, getEmbyTargetPolicy } from './emby-source';
import { isOptionalFeatureEnabled } from './optional-features';

interface EmbySourceConfig {
  key: string;
  name: string;
  enabled: boolean;
  ServerURL: string;
  ApiKey?: string;
  Username?: string;
  Password?: string;
  UserId?: string;
  AuthToken?: string;
  Libraries?: string[];
  LastSyncTime?: number;
  ItemCount?: number;
  isDefault?: boolean;
  isPublic?: boolean; // 管理员公共源，对所有用户可见
  // 高级流媒体选项
  removeEmbyPrefix?: boolean;
  appendMediaSourceId?: boolean;
  transcodeMp4?: boolean;
  proxyPlay?: boolean; // 视频播放代理开关
  embyAuthorizationHeader?: string; // 自定义 X-Emby-Authorization 头
}

class EmbyManager {
  private static instance: EmbyManager;
  private clients: Map<string, { signature: string; client: EmbyClient }> = new Map();
  // 用户级客户端缓存: stable UID -> Map<key, EmbyClient>
  private userClients: Map<string, Map<string, { signature: string; client: EmbyClient }>> = new Map();

  private constructor() {}

  static getInstance(): EmbyManager {
    if (!EmbyManager.instance) {
      EmbyManager.instance = new EmbyManager();
    }
    return EmbyManager.instance;
  }

  /**
   * 从配置中获取所有Emby源（支持新旧格式）- 已废弃，保留用于向后兼容
   * @deprecated 使用 getSourcesForUser 替代
   */
  private async getSources(): Promise<EmbySourceConfig[]> {
    const config = await getConfig();
    if (!isOptionalFeatureEnabled(config, 'EnableEmby')) return [];

    // 如果是新格式（Sources数组）
    if (config.EmbyConfig?.Sources && Array.isArray(config.EmbyConfig.Sources)) {
      return config.EmbyConfig.Sources;
    }

    // 如果是旧格式（单源配置），转换为数组格式
    const embyConfig = config.EmbyConfig as any;
    if (embyConfig?.ServerURL) {
      return [{
        key: 'default',
        name: 'Emby',
        enabled: embyConfig.Enabled ?? false,
        ServerURL: embyConfig.ServerURL,
        ApiKey: embyConfig.ApiKey,
        Username: embyConfig.Username,
        Password: embyConfig.Password,
        UserId: embyConfig.UserId,
        AuthToken: embyConfig.AuthToken,
        Libraries: embyConfig.Libraries,
        LastSyncTime: embyConfig.LastSyncTime,
        ItemCount: embyConfig.ItemCount,
        isDefault: true,
      }];
    }

    return [];
  }

  /**
   * 获取用户的 Emby 源配置
   * 合并策略：用户私人源 + 管理员公共源（isPublic: true）
   * 用户私人源优先（相同 key 时覆盖公共源）
   * @param identity 已解析的稳定身份
   */
  private async getSourcesForUser(identity: { uid: string; username: string }): Promise<EmbySourceConfig[]> {
    const config = await getConfig();
    if (!isOptionalFeatureEnabled(config, 'EnableEmby')) return [];
    // 获取管理员公共源
    const adminSources = await this.getSources();
    const publicSources = canManageEmbySources(config, identity.username)
      ? adminSources
      : adminSources.filter(s => s.isPublic === true);

    // Local storage has no server-side private source data.
    if ((process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') !== 'localstorage') {
      const userConfig = await dbManager.getUserEmbyConfig(identity.uid);
      const userSources: EmbySourceConfig[] = (userConfig?.sources && Array.isArray(userConfig.sources))
        ? userConfig.sources
        : [];

      // 合并：用户私人源优先，公共源补充（key 不重复）
      const userKeys = new Set(userSources.map(s => s.key));
      const mergedPublic = publicSources.filter(s => !userKeys.has(s.key));
      const merged = [...userSources, ...mergedPublic];

      return merged;
    }

    return publicSources;
  }

  private async resolveUser(userRef: string): Promise<{ uid: string; username: string }> {
    if ((process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage') {
      const owner = getLocalOwnerIdentity();
      if (userRef === owner.uid) return owner;
      throw new Error('用户身份已失效，请重新登录');
    }
    // An absent UID must not fall through to another account's numeric username.
    const identity = await dbManager.getUserIdentityByUid(userRef);
    if (!identity) throw new Error('用户身份已失效，请重新登录');
    return identity;
  }

  /**
   * 获取指定key的EmbyClient（用户级）
   * @param userRef 稳定 UID（兼容历史 UUID）
   * @param key Emby源的key，如果不指定则使用默认源
   */
  async getClientForUser(userRef: string, key?: string): Promise<EmbyClient> {
    const identity = await this.resolveUser(userRef);
    const sources = await this.getSourcesForUser(identity);

    if (sources.length === 0) {
      throw new Error('未配置 Emby 源');
    }

    // 如果没有指定key，使用默认源（第一个或标记为default的）
    if (!key) {
      const defaultSource = sources.find(s => s.isDefault) || sources[0];
      key = defaultSource.key;
    }

    // 获取或创建用户的客户端缓存
    if (!this.userClients.has(identity.uid)) {
      this.userClients.set(identity.uid, new Map());
    }
    const userClientMap = this.userClients.get(identity.uid)!;

    const sourceConfig = sources.find(s => s.key === key);
    if (!sourceConfig) throw new Error(`未找到 Emby 源: ${key}`);
    if (!sourceConfig.enabled) throw new Error(`Emby 源已禁用: ${sourceConfig.name}`);
    const policy = getEmbyTargetPolicy(await getConfig(), sourceConfig.ServerURL, identity.username);
    const signature = JSON.stringify([sourceConfig, policy]);
    if (userClientMap.get(key)?.signature !== signature) {
      userClientMap.set(key, { signature, client: new EmbyClient(sourceConfig, policy) });
    }

    return userClientMap.get(key)!.client;
  }

  /**
   * 获取用户所有启用的Emby源配置
   * @param userRef 稳定 UID（兼容历史 UUID）
   */
  async getEnabledSourcesForUser(userRef: string): Promise<EmbySourceConfig[]> {
    const sources = await this.getSourcesForUser(await this.resolveUser(userRef));
    return sources.filter(s => s.enabled);
  }

  /**
   * 检查用户是否配置了Emby
   * @param userRef 稳定 UID（兼容历史 UUID）
   */
  async hasEmbyForUser(userRef: string): Promise<boolean> {
    const sources = await this.getSourcesForUser(await this.resolveUser(userRef));
    return sources.some(s => s.enabled && s.ServerURL);
  }

  /**
   * 清除用户的客户端缓存
   * @param uid 稳定 UID，如果不提供则清除所有缓存
   */
  clearUserCache(uid?: string) {
    if (uid) {
      this.userClients.delete(uid);
    } else {
      this.userClients.clear();
    }
  }

  /**
   * 获取指定key的EmbyClient（向后兼容，使用全局配置）
   * @param key Emby源的key，如果不指定则使用默认源
   * @deprecated 使用 getClientForUser 替代
   */
  async getClient(key?: string): Promise<EmbyClient> {
    const sources = await this.getSources();

    if (sources.length === 0) {
      throw new Error('未配置 Emby 源');
    }

    // 如果没有指定key，使用默认源（第一个或标记为default的）
    if (!key) {
      const defaultSource = sources.find(s => s.isDefault) || sources[0];
      key = defaultSource.key;
    }

    const sourceConfig = sources.find(s => s.key === key);
    if (!sourceConfig) throw new Error(`未找到 Emby 源: ${key}`);
    if (!sourceConfig.enabled) throw new Error(`Emby 源已禁用: ${sourceConfig.name}`);
    const signature = JSON.stringify(sourceConfig);
    if (this.clients.get(key)?.signature !== signature) {
      this.clients.set(key, {
        signature,
        client: new EmbyClient(sourceConfig, { allowedPrivateOrigins: [new URL(sourceConfig.ServerURL).origin] }),
      });
    }

    return this.clients.get(key)!.client;
  }

  /**
   * 获取所有启用的EmbyClient
   */
  async getAllClients(): Promise<Map<string, { client: EmbyClient; config: EmbySourceConfig }>> {
    const sources = await this.getSources();
    const enabledSources = sources.filter(s => s.enabled);
    const result = new Map<string, { client: EmbyClient; config: EmbySourceConfig }>();

    for (const source of enabledSources) {
      result.set(source.key, {
        client: await this.getClient(source.key),
        config: source,
      });
    }

    return result;
  }

  /**
   * 获取所有启用的Emby源配置
   */
  async getEnabledSources(): Promise<EmbySourceConfig[]> {
    const sources = await this.getSources();
    return sources.filter(s => s.enabled);
  }

  /**
   * 检查是否配置了Emby
   */
  async hasEmby(): Promise<boolean> {
    const sources = await this.getSources();
    return sources.some(s => s.enabled && s.ServerURL);
  }

  /**
   * 清除缓存的客户端实例
   */
  clearCache() {
    this.clients.clear();
    this.userClients.clear();
  }
}

export const embyManager = EmbyManager.getInstance();

/**
 * 配置迁移函数：将旧格式配置迁移到新格式
 */
export function migrateEmbyConfig(config: AdminConfig): AdminConfig {
  // 如果已经是新格式，直接返回
  if (config.EmbyConfig?.Sources) {
    return config;
  }

  // 如果是旧格式，迁移到新格式
  const embyConfig = config.EmbyConfig as any;
  if (embyConfig && embyConfig.ServerURL) {
    config.EmbyConfig = {
      Sources: [{
        key: 'default',
        name: 'Emby',
        enabled: embyConfig.Enabled ?? false,
        ServerURL: embyConfig.ServerURL || '',
        ApiKey: embyConfig.ApiKey,
        Username: embyConfig.Username,
        Password: embyConfig.Password,
        UserId: embyConfig.UserId,
        AuthToken: embyConfig.AuthToken,
        Libraries: embyConfig.Libraries,
        LastSyncTime: embyConfig.LastSyncTime,
        ItemCount: embyConfig.ItemCount,
        isDefault: true,
        // 高级选项默认值
        removeEmbyPrefix: false,
        appendMediaSourceId: false,
        transcodeMp4: false,
        proxyPlay: false,
      }],
    };
  }

  return config;
}
