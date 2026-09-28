import { randomUUID } from 'crypto';

import {
  getRegistrationPolicy,
  normalizeEmail,
  validateRegistrationProfile,
} from './account-policy';
import type { AdminConfig } from './admin.types';
import { clearConfigCache, getConfig } from './config';
import { db } from './db';
import { sendRegistrationPendingEmail } from './emailService';
import {
  releaseInviteCode,
  useInviteCode as consumeInviteCode,
} from './invite-code';
import { sendNewRegistrationWebhook } from './webhookService';

export class AccountRegistrationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AccountRegistrationError';
  }
}

interface RegistrationInput {
  username: string;
  password: string;
  email?: unknown;
  source?: unknown;
  inviteCode?: unknown;
  oidcSub?: string;
}

export async function findBoundOIDCAccount(
  config: AdminConfig,
  subjects: string[],
): Promise<string | null> {
  const candidates = new Set<string>();
  for (const subject of subjects) {
    const indexed = await db.getUserByOidcSub(subject);
    if (indexed) candidates.add(indexed);
    for (const user of config.UserConfig.Users) {
      if (String(user.oidcSub ?? '') === subject) candidates.add(user.username);
    }
  }
  const matches: string[] = [];
  for (const username of candidates) {
    const identity = await db.getUserIdentity(username);
    if (!identity) continue;
    const stored = await db.getUserInfoV2(identity.uid);
    const configured = config.UserConfig.Users.find(
      (user) => user.username === username,
    );
    // V2 is authoritative. A stale reverse index/config must not sign in a
    // newly recreated V2 account after its old binding has been removed.
    const binding = stored ? stored.oidcSub : configured?.oidcSub;
    if (binding != null && subjects.includes(String(binding))) {
      matches.push(username);
    }
  }
  if (matches.length > 1) {
    throw new AccountRegistrationError('OIDC账号绑定冲突，请联系管理员', 409);
  }
  return matches[0] || null;
}

export async function createRegisteredAccount(
  config: AdminConfig,
  input: RegistrationInput,
): Promise<{ pending: boolean; uid: string }> {
  const policy = getRegistrationPolicy(config.UserConfig);
  if (!policy.allowRegister) {
    throw new AccountRegistrationError('管理员已关闭用户注册功能', 403);
  }
  const profile = validateRegistrationProfile(input, policy);
  if (profile.error) throw new AccountRegistrationError(profile.error);

  const { username, password, oidcSub } = input;
  if (
    username === process.env.USERNAME ||
    config.UserConfig.Users.some((user) => user.username === username) ||
    (await db.getUserIdentity(username))
  ) {
    throw new AccountRegistrationError('该用户名已被注册', 409);
  }
  if (
    profile.email &&
    (config.UserConfig.Users.some(
      (user) => normalizeEmail(user.email) === profile.email,
    ) ||
      (await db.getUsernameByEmail(profile.email)))
  ) {
    throw new AccountRegistrationError('该邮箱已被其他账号关联', 409);
  }

  let inviteReserved = false;
  let accountCreated = false;
  let pending = policy.requireApproval;
  const attemptId = randomUUID();
  const uid = await db.allocateUserUid();
  try {
    if (profile.inviteCode) {
      try {
        inviteReserved = await consumeInviteCode(
          profile.inviteCode,
          uid,
          attemptId,
          { userUid: uid },
        );
      } catch (error) {
        throw new AccountRegistrationError(
          error instanceof Error ? error.message : '邀请码无效',
        );
      }
      if (!inviteReserved) throw new AccountRegistrationError('邀请码无效');
    }
    pending = policy.requireApproval && !inviteReserved;

    const tags = config.SiteConfig.DefaultUserTags?.length
      ? config.SiteConfig.DefaultUserTags
      : undefined;
    await db.createUserV2(
      username,
      password,
      'user',
      tags,
      oidcSub,
      undefined,
      profile.email || undefined,
      { uid, pending, source: profile.source || undefined },
    );
    accountCreated = true;

    clearConfigCache();
    const updatedConfig = await getConfig();
    let user = updatedConfig.UserConfig.Users.find((entry) =>
      entry.uid ? entry.uid === uid : entry.username === username,
    );
    if (!user) {
      user = { uid, username, role: 'user' };
      updatedConfig.UserConfig.Users.push(user);
    }
    user.uid = uid;
    if (profile.email) user.email = profile.email;
    if (profile.source) user.source = profile.source;
    if (oidcSub) user.oidcSub = oidcSub;
    user.pending = pending;
    await db.saveAdminConfig(updatedConfig);
    clearConfigCache();
  } catch (error) {
    // A failed profile write must not leave an approved account behind.
    if (accountCreated) {
      await db.deleteUser(uid);
      clearConfigCache();
    }
    if (inviteReserved)
      await releaseInviteCode(profile.inviteCode, uid, attemptId, {
        userUid: uid,
      });
    throw error;
  }

  if (pending) {
    // Notification delivery does not change the durable pending status.
    await Promise.allSettled([
      sendRegistrationPendingEmail(profile.email, username),
      sendNewRegistrationWebhook(username, profile.email, profile.source),
    ]);
  }
  return { pending, uid };
}
