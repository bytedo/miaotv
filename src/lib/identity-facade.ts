import { randomInt, randomUUID } from 'crypto';

import type { AdminConfig } from './admin.types';
import type { IStorage } from './types';
import {
  type IdentityRegistry,
  isUserUid,
  type UserIdentity,
  type UserIdentityAccess,
  UserIdentityError,
  validateUsername,
} from './user-identity';

type RawStorage = IStorage & Record<string, any>;
type ConfigUser = AdminConfig['UserConfig']['Users'][number] & { uid?: string };

/** Resolve user references once, before dispatching to a legacy storage API. */
export function createIdentityStorage(
  storage: IStorage,
  ownerUsername: () => string | undefined = () => process.env.USERNAME,
): IStorage & UserIdentityAccess {
  const raw = storage as RawStorage;
  const registry: IdentityRegistry = raw.getIdentityRegistry();

  async function ownerIdentity(): Promise<UserIdentity | null> {
    const username = ownerUsername();
    if (!username) return null;
    const existing = await registry.getOwner();
    if (existing?.username === username) return existing;
    const uid = existing?.uid ?? await registry.allocateUid();
    const storageKey =
      existing?.storageKey ||
      ((await registry.isStorageRetired(username)) ? `uid:${uid}` : username);
    return registry.ensure(
      { uid, username, storageKey, sessionVersion: randomInt(1, 2 ** 32) },
      { owner: true },
    );
  }

  async function fromStorageKey(
    storageKey: string,
  ): Promise<UserIdentity | null> {
    const existing = await registry.getByStorageKey(storageKey);
    if (existing) return existing;
    if (await registry.isStorageRetired(storageKey)) return null;
    // A partially created modern account is never adopted as a legacy username.
    if (storageKey.startsWith('uid:') && isUserUid(storageKey.split(':')[1]))
      return null;
    if (!(await raw.checkUserExist(storageKey))) return null;
    return registry.ensure({
      uid: await registry.allocateUid(),
      username: storageKey,
      storageKey,
      sessionVersion: randomInt(1, 2 ** 32),
    });
  }

  async function getUserIdentity(
    username: string,
  ): Promise<UserIdentity | null> {
    if (!username || typeof username !== 'string') return null;
    if (username === ownerUsername()) return ownerIdentity();
    const existing = await registry.getByUsername(username);
    if (existing) return existing;
    // Retired names may be reused, but never adopt their previous data again.
    if (await registry.isUsernameRetired(username)) return null;
    const stored = await registry.getByStorageKey(username);
    if (stored) return stored.username === username ? stored : null;
    return fromStorageKey(username);
  }

  async function resolve(userRef: string): Promise<UserIdentity | null> {
    if (!userRef || typeof userRef !== 'string') return null;
    if (isUserUid(userRef)) {
      return registry.getByUid(userRef);
    }
    if (/^[0-9]+$/.test(userRef)) return null;
    return getUserIdentity(userRef);
  }

  async function requireIdentity(userRef: string): Promise<UserIdentity> {
    const identity = await resolve(userRef);
    if (!identity) throw new UserIdentityError('USER_NOT_FOUND');
    return identity;
  }

  async function identities(): Promise<UserIdentity[]> {
    const owner = await ownerIdentity();
    const result = new Map<string, UserIdentity>();
    if (owner) result.set(owner.uid, owner);
    for (const storageKey of (await raw.getAllUsers()).sort()) {
      const identity = await fromStorageKey(storageKey);
      if (identity) result.set(identity.uid, identity);
    }
    return [...result.values()];
  }

  async function allocateUserUid(preferredUid?: string): Promise<string> {
    if (preferredUid !== undefined) return registry.reserveUid(preferredUid);
    // A fresh database gives the owner the first number. After a clear, defer
    // recreating it so an explicit backup restore can retain the former UID.
    const owner = ownerUsername();
    if (owner && !(await registry.isUsernameRetired(owner))) await ownerIdentity();
    return registry.allocateUid();
  }

  async function createAccount(
    method: 'registerUser' | 'createUserV2',
    username: string,
    args: any[],
  ): Promise<void> {
    const allowLegacyUsername =
      method === 'createUserV2' && args[6]?.allowLegacyUsername === true;
    if (allowLegacyUsername) {
      if (typeof username !== 'string' || !username)
        throw new UserIdentityError('INVALID_USERNAME');
    } else validateUsername(username);
    const preferredUid = method === 'createUserV2' ? args[6]?.uid : undefined;
    if (preferredUid !== undefined && !isUserUid(preferredUid))
      throw new UserIdentityError('INVALID_UID');
    const restoringOwner =
      method === 'createUserV2' &&
      args[1] === 'owner' &&
      username === ownerUsername();
    if (username === ownerUsername() && !restoringOwner)
      throw new UserIdentityError('OWNER_PROTECTED');
    if (!restoringOwner && (await getUserIdentity(username)))
      throw new UserIdentityError('USERNAME_EXISTS');
    const uid = preferredUid !== undefined
      ? await registry.reserveUid(preferredUid)
      : restoringOwner
        ? await registry.allocateUid()
        : await allocateUserUid();
    let storageKey = `uid:${uid}`;
    // Repeated backup restores keep UID but must not reuse a retired namespace
    // that could contain delayed writes from the previous account incarnation.
    if (await registry.isStorageRetired(storageKey))
      storageKey += `:${randomUUID()}`;
    const identity = await registry.ensure(
      {
        uid, username, storageKey, sessionVersion: randomInt(1, 2 ** 32),
        ...(method === 'createUserV2' && args[6]?.legacyUids ? { legacyUids: args[6].legacyUids } : {}),
      },
      { fresh: true, owner: restoringOwner },
    );
    if (preferredUid && identity.uid !== uid)
      throw new UserIdentityError('UID_EXISTS');
    try {
      await raw[method](identity.storageKey, ...args);
      const current = await registry.getByUid(identity.uid);
      if (!current || current.storageKey !== identity.storageKey) {
        await raw.deleteUser(identity.storageKey);
        throw new UserIdentityError('IDENTITY_CONFLICT');
      }
    } catch (error) {
      // A lost transport reply may follow a successful account creation. Keep
      // that binding; never orphan a credential whose write actually succeeded.
      if (!(await raw.checkUserExist(identity.storageKey))) {
        const current = await registry.getByUid(identity.uid);
        if (current?.storageKey === identity.storageKey)
          await registry.remove(identity.uid, identity.storageKey);
      }
      throw error;
    }
  }

  async function normalizedConfig(
    config: AdminConfig,
    saving: boolean,
  ): Promise<AdminConfig> {
    await identities();
    const previous = saving ? await raw.getAdminConfig() : null;
    const users: ConfigUser[] = [];
    const seen = new Set<string>();
    // Explicit UIDs outrank legacy profile rows when both describe one person.
    const candidates = [...(config.UserConfig?.Users ?? [])] as ConfigUser[];
    candidates.sort((a, b) => Number(!!b.uid) - Number(!!a.uid));
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.username !== 'string') continue;
      let identity: UserIdentity | null = null;
      if (candidate.uid !== undefined) {
        identity = isUserUid(candidate.uid)
          ? await registry.getByUid(candidate.uid)
          : null;
        if (!identity) {
          if (saving) throw new UserIdentityError('IDENTITY_CONFLICT');
          continue;
        }
        if (saving && candidate.username !== identity.username) {
          const wasSaved = previous?.UserConfig?.Users?.some(
            (user: ConfigUser) =>
              (user.uid === identity!.uid || !!(user.uid && identity!.legacyUids?.includes(user.uid))) &&
              user.username === candidate.username,
          );
          const retiredUid = await registry.retiredUsernameUid(
            candidate.username,
          );
          if (
            !wasSaved &&
            identity.storageKey !== candidate.username &&
            retiredUid !== identity.uid
          ) {
            throw new UserIdentityError('IDENTITY_CONFLICT');
          }
        }
      } else {
        // Legacy profiles describe a frozen namespace, even if the old login
        // name has since been assigned to a different UID.
        identity = await registry.getByStorageKey(candidate.username);
        if (
          !identity &&
          !(await registry.isStorageRetired(candidate.username))
        ) {
          identity = await getUserIdentity(candidate.username);
        }
      }
      if (!identity || seen.has(identity.uid)) continue;
      seen.add(identity.uid);
      users.push({
        ...candidate,
        uid: identity.uid,
        username: identity.username,
      });
    }
    return { ...config, UserConfig: { ...config.UserConfig, Users: users } };
  }

  const methods: Record<string, (...args: any[]) => Promise<any>> = {
    allocateUserUid,
    getAllUserIdentities: identities,
    getUserIdentity,
    getUserIdentityByUid: (uid: string) =>
      isUserUid(uid) ? registry.getByUid(uid) : Promise.resolve(null),
    isLegacyUsernameRetired: (username: string) =>
      registry.isUsernameRetired(username),
    async renameUser(uid: string, username: string, expectedUsername?: string) {
      if (!isUserUid(uid)) throw new UserIdentityError('INVALID_UID');
      validateUsername(username);
      if (username === ownerUsername())
        throw new UserIdentityError('OWNER_PROTECTED');
      const identity = await registry.getByUid(uid);
      if (!identity) throw new UserIdentityError('USER_NOT_FOUND');
      const occupant = await getUserIdentity(username);
      if (occupant && occupant.uid !== identity.uid)
        throw new UserIdentityError('USERNAME_EXISTS');
      return registry.rename(identity.uid, username, expectedUsername);
    },
    registerUser: (username: string, ...args: any[]) =>
      createAccount('registerUser', username, args),
    createUserV2: (username: string, ...args: any[]) =>
      createAccount('createUserV2', username, args),
    async checkUserExist(userRef: string) {
      const identity = await resolve(userRef);
      if (!identity) return false;
      return (
        identity.uid === (await registry.getOwner())?.uid ||
        raw.checkUserExist(identity.storageKey)
      );
    },
    async verifyUser(userRef: string, password: string) {
      const identity = await resolve(userRef);
      return identity ? raw.verifyUser(identity.storageKey, password) : false;
    },
    async getAllUsers() {
      return (await identities()).map((identity) => identity.username);
    },
    async getUsernameByEmail(email: string) {
      const storageKey = await raw.getUsernameByEmail(email);
      return storageKey
        ? ((await fromStorageKey(storageKey))?.username ?? null)
        : null;
    },
    async getUserByOidcSub(sub: string) {
      const storageKey = await raw.getUserByOidcSub(sub);
      return storageKey
        ? ((await fromStorageKey(storageKey))?.username ?? null)
        : null;
    },
    async getUserInfoV2(userRef: string) {
      const identity = await resolve(userRef);
      if (!identity) return null;
      const info = await raw.getUserInfoV2(identity.storageKey);
      return info
        ? { ...info, uid: identity.uid, username: identity.username }
        : null;
    },
    async getUserPlayStat(userRef: string) {
      const identity = await requireIdentity(userRef);
      return {
        ...(await raw.getUserPlayStat(identity.storageKey)),
        uid: identity.uid,
        username: identity.username,
      };
    },
    async getPlayStats() {
      await identities();
      const stats = await raw.getPlayStats();
      const userStats = [];
      for (const stat of stats.userStats ?? []) {
        const identity = await fromStorageKey(stat.username);
        if (identity)
          userStats.push({
            ...stat,
            uid: identity.uid,
            username: identity.username,
          });
      }
      return { ...stats, userStats };
    },
    async getAdminConfig() {
      const config = await raw.getAdminConfig();
      return config ? normalizedConfig(config, false) : null;
    },
    async setAdminConfig(config: AdminConfig) {
      const normalized = await normalizedConfig(config, true);
      await raw.setAdminConfig(normalized);
      // Callers also cache the object they supplied after a successful save.
      config.UserConfig = normalized.UserConfig;
    },
    async deleteUser(userRef: string) {
      const identity = await resolve(userRef);
      if (!identity) return;
      if (identity.uid === (await registry.getOwner())?.uid)
        throw new UserIdentityError('OWNER_PROTECTED');
      // Revoke identity before deleting data. A concurrent stale write can only
      // reach the retired namespace, never a future account with the same name.
      await registry.remove(identity.uid, identity.storageKey);
      await raw.deleteUser(identity.storageKey);
      await raw.deleteCache('play_stats_summary');
    },
    async clearAllData() {
      const existing = await identities();
      await registry.clear();
      // The environment owner can have viewing data without a password row.
      for (const identity of existing)
        await raw.deleteUser(identity.storageKey);
      await raw.clearAllData();
    },
    async deleteV1Password(userRef: string) {
      const identity = await requireIdentity(userRef);
      if (raw.client?.del) await raw.client.del(`u:${identity.storageKey}:pwd`);
    },
  };
  methods.verifyUserV2 = methods.verifyUser;
  methods.checkUserExistV2 = methods.checkUserExist;

  const nullableReads = new Set([
    'getUserCredential',
    'getUserEmail',
    'getPlayRecord',
    'getFavorite',
    'getReminder',
    'getSkipConfig',
    'getEpisodeSkipConfig',
    'getUserEmbyConfig',
  ]);
  const collectionReads = new Set([
    'getAllPlayRecords',
    'getAllFavorites',
    'getAllReminders',
    'getAllSkipConfigs',
    'getAllEpisodeSkipConfigs',
  ]);
  const userMethods = [
    ...nullableReads,
    ...collectionReads,
    'getSearchHistory',
    'changePassword',
    'restoreUserCredential',
    'setUserEmail',
    'setPlayRecord',
    'deletePlayRecord',
    'deleteAllPlayRecords',
    'setPlayRecordsBatch',
    'setFavorite',
    'deleteFavorite',
    'deleteAllFavorites',
    'setFavoritesBatch',
    'setReminder',
    'deleteReminder',
    'deleteAllReminders',
    'addSearchHistory',
    'deleteSearchHistory',
    'setSkipConfig',
    'deleteSkipConfig',
    'saveEpisodeSkipConfig',
    'deleteEpisodeSkipConfig',
    'updatePlayStatistics',
    'updateUserLoginStats',
    'saveUserEmbyConfig',
    'deleteUserEmbyConfig',
  ];
  for (const method of userMethods) {
    if (typeof raw[method] !== 'function') continue;
    methods[method] = async (userRef: string, ...args: any[]) => {
      const identity = await resolve(userRef);
      if (!identity) {
        if (nullableReads.has(method)) return null;
        if (collectionReads.has(method)) return {};
        if (method === 'getSearchHistory') return [];
        throw new UserIdentityError('USER_NOT_FOUND');
      }
      return raw[method](identity.storageKey, ...args);
    };
  }
  return new Proxy(raw, {
    get(target, property) {
      if (
        typeof property === 'string' &&
        Object.prototype.hasOwnProperty.call(methods, property)
      )
        return methods[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as IStorage & UserIdentityAccess;
}
