/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAdminRoleFromRequest } from '@/lib/admin-auth';
import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { clearConfigCache, getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { sendApprovalEmail, sendRejectionEmail } from '@/lib/emailService';
import { isUserUid } from '@/lib/user-identity';

export const runtime = 'nodejs';

// 支持的操作类型
const ACTIONS = [
  'add',
  'ban',
  'unban',
  'setAdmin',
  'cancelAdmin',
  'changePassword',
  'changeUsername',
  'deleteUser',
  'updateUserApis',
  'userGroup',
  'updateUserGroups',
  'batchUpdateUserGroups',
  'approve',
  'reject',
] as const;

const accountWriteState = globalThis as typeof globalThis & {
  __miaotvAdminAccountWriteTail?: Promise<void>;
};

async function acquireAccountWrite(): Promise<() => void> {
  const previous = accountWriteState.__miaotvAdminAccountWriteTail;
  let release!: () => void;
  accountWriteState.__miaotvAdminAccountWriteTail = new Promise<void>(
    (resolve) => {
      release = resolve;
    },
  );
  await previous;
  return release;
}

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储进行管理员配置',
      },
      { status: 400 },
    );
  }

  let releaseAccountWrite: (() => void) | undefined;
  try {
    const body = await request.json();

    const authInfo = await getVerifiedAuthInfo(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const username = authInfo.username;

    let {
      targetUsername, // 目标用户名
      targetPassword, // 目标用户密码（仅在添加用户时需要）
      action,
    } = body as {
      targetUsername?: string;
      targetPassword?: string;
      action?: (typeof ACTIONS)[number];
    };
    let { targetUid } = body as { targetUid?: string };

    if (targetUid !== undefined && !isUserUid(targetUid)) {
      return NextResponse.json({ error: '用户标识格式错误' }, { status: 400 });
    }

    if (!action || !ACTIONS.includes(action)) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    // 用户组操作和批量操作不需要targetUsername
    if (
      !targetUsername &&
      !targetUid &&
      !['userGroup', 'batchUpdateUserGroups'].includes(action)
    ) {
      return NextResponse.json({ error: '缺少目标用户名' }, { status: 400 });
    }

    // Serialize this process's read-modify-write cycle so duplicate approvals
    // observe the saved decision and concurrent account edits do not overwrite.
    releaseAccountWrite = await acquireAccountWrite();

    // 获取配置与存储
    let adminConfig = await getConfig();

    // 判定操作者角色
    const operatorRole = await getAdminRoleFromRequest(request);
    if (!operatorRole) {
      return NextResponse.json({ error: '权限不足' }, { status: 401 });
    }

    if (targetUid) {
      const identity = await db.getUserIdentityByUid(targetUid);
      if (!identity) {
        return NextResponse.json({ error: '目标用户不存在' }, { status: 404 });
      }
      targetUid = identity.uid;
    }

    // 查找目标用户条目（用户组操作和批量操作不需要）
    let targetEntry: any = null;
    let isTargetAdmin = false;

    if (
      !['userGroup', 'batchUpdateUserGroups'].includes(action) &&
      (targetUsername || targetUid)
    ) {
      targetEntry = adminConfig.UserConfig.Users.find((u) =>
        targetUid ? u.uid === targetUid : u.username === targetUsername,
      );

      if (targetUid) {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }
        targetUsername = targetEntry.username;
      }

      if (
        targetEntry &&
        targetEntry.role === 'owner' &&
        !['changePassword', 'updateUserApis', 'updateUserGroups'].includes(
          action,
        )
      ) {
        return NextResponse.json({ error: '无法操作站长' }, { status: 400 });
      }

      // 权限校验逻辑
      isTargetAdmin = targetEntry?.role === 'admin';
    }

    const targetUserRef = targetUid || targetEntry?.uid || targetUsername;
    const isSelfTarget =
      authInfo.uid && targetEntry?.uid
        ? authInfo.uid === targetEntry.uid
        : username === targetUsername;
    if (targetEntry?.role === 'owner' && operatorRole !== 'owner') {
      return NextResponse.json(
        { error: '仅站长可修改站长账号的配置' },
        { status: 403 },
      );
    }
    if (
      ![
        'changePassword',
        'changeUsername',
        'deleteUser',
        'updateUserApis',
        'userGroup',
        'updateUserGroups',
        'batchUpdateUserGroups',
      ].includes(action) &&
      isSelfTarget
    ) {
      return NextResponse.json(
        { error: '无法对自己进行此操作' },
        { status: 400 },
      );
    }

    switch (action) {
      case 'add': {
        if (targetEntry || (await db.getUserIdentity(targetUsername!))) {
          return NextResponse.json({ error: '用户已存在' }, { status: 400 });
        }
        if (!targetPassword) {
          return NextResponse.json(
            { error: '缺少目标用户密码' },
            { status: 400 },
          );
        }

        // 获取用户组信息
        const { userGroup } = body as { userGroup?: string };
        const uid = await db.allocateUserUid();
        const createdAt = Date.now();
        const tags = userGroup?.trim() ? [userGroup] : undefined;
        await db.createUserV2(
          targetUsername!,
          targetPassword,
          'user',
          tags,
          undefined,
          undefined,
          undefined,
          { uid, createdAt },
        );

        // 更新配置
        const newUser: any = {
          uid,
          username: targetUsername!,
          role: 'user',
          createdAt,
        };

        // 如果指定了用户组，添加到tags中
        if (tags) newUser.tags = tags;

        adminConfig.UserConfig.Users.push(newUser);
        targetEntry =
          adminConfig.UserConfig.Users[adminConfig.UserConfig.Users.length - 1];
        break;
      }
      case 'ban': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }
        if (isTargetAdmin) {
          // 目标是管理员
          if (operatorRole !== 'owner') {
            return NextResponse.json(
              { error: '仅站长可封禁管理员' },
              { status: 401 },
            );
          }
        }
        targetEntry.banned = true;
        break;
      }
      case 'unban': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }
        if (isTargetAdmin) {
          if (operatorRole !== 'owner') {
            return NextResponse.json(
              { error: '仅站长可操作管理员' },
              { status: 401 },
            );
          }
        }
        targetEntry.banned = false;
        break;
      }
      case 'setAdmin': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }
        if (targetEntry.role === 'admin') {
          return NextResponse.json(
            { error: '该用户已是管理员' },
            { status: 400 },
          );
        }
        if (operatorRole !== 'owner') {
          return NextResponse.json(
            { error: '仅站长可设置管理员' },
            { status: 401 },
          );
        }
        targetEntry.role = 'admin';
        break;
      }
      case 'cancelAdmin': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }
        if (targetEntry.role !== 'admin') {
          return NextResponse.json(
            { error: '目标用户不是管理员' },
            { status: 400 },
          );
        }
        if (operatorRole !== 'owner') {
          return NextResponse.json(
            { error: '仅站长可取消管理员' },
            { status: 401 },
          );
        }
        targetEntry.role = 'user';
        break;
      }
      case 'changePassword': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }
        if (!targetPassword) {
          return NextResponse.json({ error: '缺少新密码' }, { status: 400 });
        }

        // 权限检查：不允许修改站长密码
        if (targetEntry.role === 'owner') {
          return NextResponse.json(
            { error: '无法修改站长密码' },
            { status: 401 },
          );
        }

        if (isTargetAdmin && operatorRole !== 'owner' && !isSelfTarget) {
          return NextResponse.json(
            { error: '仅站长可修改其他管理员密码' },
            { status: 401 },
          );
        }

        await db.changePassword(targetUserRef!, targetPassword);
        break;
      }
      case 'changeUsername': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }
        if (
          targetEntry.role === 'owner' ||
          targetUsername === process.env.USERNAME
        ) {
          return NextResponse.json(
            { error: '站长用户名由环境配置管理，无法在此修改' },
            { status: 403 },
          );
        }
        if (isTargetAdmin && operatorRole !== 'owner' && !isSelfTarget) {
          return NextResponse.json(
            { error: '仅站长可修改其他管理员的用户名' },
            { status: 403 },
          );
        }
        const newUsername =
          typeof body.newUsername === 'string' ? body.newUsername.trim() : '';
        if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,20}$/.test(newUsername)) {
          return NextResponse.json(
            { error: '用户名只能包含汉字、字母、数字和下划线，长度2-20位' },
            { status: 400 },
          );
        }
        if (newUsername === targetUsername) {
          return NextResponse.json(
            { error: '新用户名不能与当前用户名相同' },
            { status: 400 },
          );
        }
        if (newUsername === process.env.USERNAME) {
          return NextResponse.json(
            { error: '该用户名已被使用' },
            { status: 409 },
          );
        }
        if (!targetEntry.uid) {
          return NextResponse.json(
            { error: '用户标识尚未就绪，请刷新后重试' },
            { status: 409 },
          );
        }

        const identity = await db.renameUser(
          targetEntry.uid,
          newUsername,
          targetUsername,
        );
        clearConfigCache();
        const requiresRelogin = isSelfTarget;
        const response = NextResponse.json(
          {
            ok: true,
            uid: identity.uid,
            username: identity.username,
            requiresRelogin,
          },
          { headers: { 'Cache-Control': 'no-store' } },
        );
        if (requiresRelogin) {
          response.cookies.delete('user_auth');
          response.cookies.delete('auth');
        }
        // Identity changes are already durable. Do not save the older full
        // configuration here and overwrite another account's current profile.
        return response;
      }
      case 'deleteUser': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }

        // 权限检查：站长可删除所有用户（除了自己），管理员可删除普通用户
        if (isSelfTarget) {
          return NextResponse.json({ error: '不能删除自己' }, { status: 400 });
        }

        if (isTargetAdmin && operatorRole !== 'owner') {
          return NextResponse.json(
            { error: '仅站长可删除管理员' },
            { status: 401 },
          );
        }

        await db.deleteUser(targetUserRef!);

        // 从配置中移除用户
        const userIndex = adminConfig.UserConfig.Users.findIndex(
          (u) => u.username === targetUsername,
        );
        if (userIndex > -1) {
          adminConfig.UserConfig.Users.splice(userIndex, 1);
        }

        break;
      }
      case 'updateUserApis': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }

        const { enabledApis, showAdultContent } = body as {
          enabledApis?: string[];
          showAdultContent?: boolean;
        };

        // 权限检查：站长可配置所有人的采集源，管理员可配置普通用户和自己的采集源
        if (isTargetAdmin && operatorRole !== 'owner' && !isSelfTarget) {
          return NextResponse.json(
            { error: '仅站长可配置其他管理员的采集源' },
            { status: 401 },
          );
        }

        // 更新用户的采集源权限
        if (enabledApis && enabledApis.length > 0) {
          targetEntry.enabledApis = enabledApis;
        } else {
          // 如果为空数组或未提供，则删除该字段，表示无限制
          delete targetEntry.enabledApis;
        }

        // 更新用户的成人内容显示权限
        if (showAdultContent !== undefined) {
          targetEntry.showAdultContent = showAdultContent;
        }

        break;
      }
      case 'userGroup': {
        // 用户组管理操作
        const { groupAction, groupName, enabledApis, showAdultContent } =
          body as {
            groupAction: 'add' | 'edit' | 'delete';
            groupName: string;
            enabledApis?: string[];
            showAdultContent?: boolean;
          };

        if (!adminConfig.UserConfig.Tags) {
          adminConfig.UserConfig.Tags = [];
        }

        switch (groupAction) {
          case 'add': {
            // 检查用户组是否已存在
            if (adminConfig.UserConfig.Tags.find((t) => t.name === groupName)) {
              return NextResponse.json(
                { error: '用户组已存在' },
                { status: 400 },
              );
            }
            adminConfig.UserConfig.Tags.push({
              name: groupName,
              enabledApis: enabledApis || [],
              showAdultContent: showAdultContent || false,
            });
            break;
          }
          case 'edit': {
            const groupIndex = adminConfig.UserConfig.Tags.findIndex(
              (t) => t.name === groupName,
            );
            if (groupIndex === -1) {
              return NextResponse.json(
                { error: '用户组不存在' },
                { status: 404 },
              );
            }
            adminConfig.UserConfig.Tags[groupIndex].enabledApis =
              enabledApis || [];
            if (showAdultContent !== undefined) {
              adminConfig.UserConfig.Tags[groupIndex].showAdultContent =
                showAdultContent;
            }
            break;
          }
          case 'delete': {
            const groupIndex = adminConfig.UserConfig.Tags.findIndex(
              (t) => t.name === groupName,
            );
            if (groupIndex === -1) {
              return NextResponse.json(
                { error: '用户组不存在' },
                { status: 404 },
              );
            }

            // 查找使用该用户组的所有用户
            const affectedUsers: string[] = [];
            adminConfig.UserConfig.Users.forEach((user) => {
              if (user.tags && user.tags.includes(groupName)) {
                affectedUsers.push(user.username);
                // 从用户的tags中移除该用户组
                user.tags = user.tags.filter((tag) => tag !== groupName);
                // 如果用户没有其他标签了，删除tags字段
                if (user.tags.length === 0) {
                  delete user.tags;
                }
              }
            });

            // 删除用户组
            adminConfig.UserConfig.Tags.splice(groupIndex, 1);

            // 记录删除操作的影响
            console.log(
              `删除用户组 "${groupName}"，影响用户: ${
                affectedUsers.length > 0 ? affectedUsers.join(', ') : '无'
              }`,
            );

            break;
          }
          default:
            return NextResponse.json(
              { error: '未知的用户组操作' },
              { status: 400 },
            );
        }
        break;
      }
      case 'updateUserGroups': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }

        const { userGroups } = body as { userGroups: string[] };

        // 权限检查：站长可配置所有人的用户组，管理员可配置普通用户和自己的用户组
        if (isTargetAdmin && operatorRole !== 'owner' && !isSelfTarget) {
          return NextResponse.json(
            { error: '仅站长可配置其他管理员的用户组' },
            { status: 400 },
          );
        }

        // 更新用户的用户组
        if (userGroups && userGroups.length > 0) {
          targetEntry.tags = userGroups;
        } else {
          // 如果为空数组或未提供，则删除该字段，表示无用户组
          delete targetEntry.tags;
        }

        break;
      }
      case 'batchUpdateUserGroups': {
        const { usernames, userUids, userGroups } = body as {
          usernames?: string[];
          userUids?: string[];
          userGroups: string[];
        };
        const references = userUids ?? usernames;
        if (
          !Array.isArray(references) ||
          references.length === 0 ||
          references.some((reference) =>
            userUids
              ? !isUserUid(reference)
              : typeof reference !== 'string' || !reference,
          )
        ) {
          return NextResponse.json(
            { error: '缺少有效的用户标识列表' },
            { status: 400 },
          );
        }
        const targetUsers = await Promise.all(
          [...new Set(references)].map(async (reference) => {
            const uid = userUids
              ? (await db.getUserIdentityByUid(reference))?.uid
              : undefined;
            return adminConfig.UserConfig.Users.find((user) =>
              userUids
                ? !!uid && user.uid === uid
                : user.username === reference,
            );
          }),
        );
        if (targetUsers.some((user) => !user)) {
          return NextResponse.json(
            { error: '部分用户已不存在，请刷新后重试' },
            { status: 404 },
          );
        }

        // 权限检查：站长可批量配置所有人的用户组，管理员只能批量配置普通用户
        if (operatorRole !== 'owner') {
          for (const targetUser of targetUsers) {
            if (
              targetUser &&
              targetUser.role !== 'user' &&
              !(authInfo.uid && targetUser.uid
                ? authInfo.uid === targetUser.uid
                : targetUser.username === username)
            ) {
              return NextResponse.json(
                { error: `管理员无法操作用户 ${targetUser.username}` },
                { status: 400 },
              );
            }
          }
        }

        // 批量更新用户组
        for (const targetUser of targetUsers) {
          if (targetUser) {
            if (userGroups && userGroups.length > 0) {
              targetUser.tags = userGroups;
            } else {
              // 如果为空数组或未提供，则删除该字段，表示无用户组
              delete targetUser.tags;
            }
          }
        }

        break;
      }
      case 'approve': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }
        if (!targetEntry.pending) {
          return NextResponse.json(
            { error: '该用户不需要审核' },
            { status: 400 },
          );
        }
        // 审核通过，移除 pending 状态
        targetEntry.pending = false;

        // 发送审核通过邮件
        break;
      }
      case 'reject': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 },
          );
        }

        if (!targetEntry.pending) {
          return NextResponse.json(
            { error: '该用户不需要审核' },
            { status: 400 },
          );
        }
        if (isTargetAdmin && operatorRole !== 'owner') {
          return NextResponse.json(
            { error: '仅站长可操作管理员' },
            { status: 403 },
          );
        }

        // 删除用户
        await db.deleteUser(targetUserRef!);

        // 从配置中移除用户
        const userIndex = adminConfig.UserConfig.Users.findIndex(
          (u) => u.username === targetUsername,
        );
        if (userIndex > -1) {
          adminConfig.UserConfig.Users.splice(userIndex, 1);
        }
        break;
      }
      default:
        return NextResponse.json({ error: '未知操作' }, { status: 400 });
    }

    // 将更新后的配置写入数据库
    await db.saveAdminConfig(adminConfig);

    // 清除配置缓存，强制下次重新从数据库读取
    clearConfigCache();
    releaseAccountWrite();
    releaseAccountWrite = undefined;

    // Notifications do not roll back an already saved approval or deletion.
    try {
      if (targetEntry?.email && action === 'approve') {
        await sendApprovalEmail(targetEntry.email, targetUsername!);
      } else if (targetEntry?.email && action === 'reject') {
        await sendRejectionEmail(
          targetEntry.email,
          targetUsername!,
          body.reason,
        );
      }
    } catch (error) {
      console.error('账号审核结果通知发送失败:', error);
    }

    return NextResponse.json(
      { ok: true },
      {
        headers: {
          'Cache-Control': 'no-store', // 管理员配置不缓存
        },
      },
    );
  } catch (error) {
    const identityCode =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
    const identityStatus: Record<string, number> = {
      INVALID_USERNAME: 400,
      INVALID_UID: 400,
      OWNER_PROTECTED: 400,
      USER_NOT_FOUND: 404,
      USERNAME_EXISTS: 409,
      UID_EXISTS: 409,
      IDENTITY_CONFLICT: 409,
      STALE_USERNAME: 409,
    };
    if (identityStatus[identityCode]) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : '用户身份已变更，请刷新后重试',
        },
        { status: identityStatus[identityCode] },
      );
    }
    console.error('用户管理操作失败:', error);
    return NextResponse.json(
      {
        error: '用户管理操作失败',
        details: (error as Error).message,
      },
      { status: 500 },
    );
  } finally {
    releaseAccountWrite?.();
  }
}
