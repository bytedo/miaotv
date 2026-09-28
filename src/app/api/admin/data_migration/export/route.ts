/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';
import { promisify } from 'util';
import { gzip } from 'zlib';

import { AccountBackup, accountProfile } from '@/lib/account-backup';
import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { SimpleCrypto } from '@/lib/crypto';
import { db } from '@/lib/db';
import { CURRENT_VERSION } from '@/lib/version';

export const runtime = 'nodejs';

const gzipAsync = promisify(gzip);

export async function POST(req: NextRequest) {
  try {
    // 检查存储类型
    const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
    if (storageType === 'localstorage') {
      return NextResponse.json(
        { error: '不支持本地存储进行数据迁移' },
        { status: 400 },
      );
    }

    // 验证身份和权限
    const authInfo = await getVerifiedAuthInfo(req);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    // 检查用户权限（只有站长可以导出数据）
    if (authInfo.username !== process.env.USERNAME) {
      return NextResponse.json(
        { error: '权限不足，只有站长可以导出数据' },
        { status: 401 },
      );
    }

    const config = await db.getAdminConfig();
    if (!config) {
      return NextResponse.json({ error: '无法获取配置' }, { status: 500 });
    }

    // 解析请求体获取密码
    const { password } = await req.json();
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: '请提供加密密码' }, { status: 400 });
    }

    // Capture immutable identities before collecting any per-user data.
    const identities = await db.getAllUserIdentities();
    const exportedProfiles: typeof config.UserConfig.Users = [];
    // 收集所有数据
    const exportData = {
      schemaVersion: 3,
      timestamp: new Date().toISOString(),
      serverVersion: CURRENT_VERSION,
      data: {
        // 管理员配置
        adminConfig: {
          ...config,
          UserConfig: { ...config.UserConfig, Users: exportedProfiles },
        },
        // 所有用户数据
        userData: Object.create(null) as { [uid: string]: any },
      },
    };

    // 为每个用户收集数据
    for (const identity of identities) {
      const username = identity.username;
      const uid = identity.uid;
      const userInfoV2 = await db.getUserInfoV2(uid);
      const configuredProfile = config.UserConfig.Users.find((user) =>
        user.uid ? user.uid === uid : user.username === username,
      );
      const account: AccountBackup = {
        version: 1,
        credential: await db.getUserCredential(uid),
        email: (await db.getUserEmail(uid)) || configuredProfile?.email || null,
        profile: accountProfile({ ...userInfoV2, ...configuredProfile, uid }),
      };
      if (username === process.env.USERNAME) account.profile.role = 'owner';
      exportedProfiles.push({
        ...configuredProfile,
        ...account.profile,
        uid,
        username,
        email: account.email || undefined,
      });
      const userData = {
        uid,
        username: identity.username,
        account,
        // 播放记录
        playRecords: await db.getAllPlayRecords(uid),
        // 收藏夹
        favorites: await db.getAllFavorites(uid),
        // 想看（即将上映提醒）
        reminders: await db.getAllReminders(uid),
        // 搜索历史
        searchHistory: await db.getSearchHistory(uid),
        // 跳过片头片尾配置
        skipConfigs: await db.getAllSkipConfigs(uid),
        // V2用户信息（包含 oidcSub, role, tags, enabledApis 等）
        userInfoV2: { username: identity.username, ...account.profile },
        // 登录统计（loginCount, firstLoginTime, lastLoginTime）
        loginStats: await getUserLoginStats(uid),
      };

      exportData.data.userData[uid] = userData;
    }

    // Renames, deletions and restores can happen while the data is being read.
    // Return a retryable error instead of a backup mixing different identities.
    const currentIdentities = await db.getAllUserIdentities();
    const currentByUid = new Map(
      currentIdentities.map((identity) => [identity.uid, identity]),
    );
    if (
      currentIdentities.length !== identities.length ||
      identities.some((identity) => {
        const current = currentByUid.get(identity.uid);
        return (
          !current ||
          current.username !== identity.username ||
          current.storageKey !== identity.storageKey ||
          (current.sessionVersion ?? 0) !== (identity.sessionVersion ?? 0)
        );
      })
    ) {
      return NextResponse.json(
        { error: '导出期间账号发生变化，请重新导出' },
        { status: 409 },
      );
    }

    // 将数据转换为JSON字符串
    const jsonData = JSON.stringify(exportData);

    // 先压缩数据
    const compressedData = await gzipAsync(jsonData);

    // 使用提供的密码加密压缩后的数据
    const encryptedData = SimpleCrypto.encrypt(
      compressedData.toString('base64'),
      password,
    );

    // 生成文件名
    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const filename = `moontv-backup-${timestamp}.dat`;

    // 返回加密的数据作为文件下载
    return new NextResponse(encryptedData, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': encryptedData.length.toString(),
      },
    });
  } catch (error) {
    console.error('数据导出失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '导出失败' },
      { status: 500 },
    );
  }
}

// 辅助函数：获取用户登录统计（通过数据库直接访问）
async function getUserLoginStats(uid: string): Promise<{
  loginCount: number;
  firstLoginTime: number;
  lastLoginTime: number;
  lastLoginDate: number;
} | null> {
  try {
    const identity = await db.getUserIdentityByUid(uid);
    if (!identity) return null;
    const storage = (db as any).storage;
    if (storage && typeof storage.client?.get === 'function') {
      const loginStatsKey = `user_login_stats:${identity.storageKey}`;
      const statsData = await storage.client.get(loginStatsKey);

      if (statsData) {
        // 处理不同存储类型的返回格式
        if (typeof statsData === 'string') {
          // KVRocks/Redis 返回字符串
          return JSON.parse(statsData);
        } else {
          // Upstash 返回对象
          return statsData as any;
        }
      }
    }
    return null;
  } catch (error) {
    console.error(`获取用户 ${uid} 登录统计失败:`, error);
    return null;
  }
}
