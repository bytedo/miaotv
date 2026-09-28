/* eslint-disable no-console */

import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { promisify } from 'util';
import { gunzip } from 'zlib';

import {
  assignAccountRestoreUids,
  prepareAccountRestore,
  validateBackupConfiguration,
} from '@/lib/account-backup';
import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { configSelfCheck, setCachedConfig } from '@/lib/config';
import { SimpleCrypto } from '@/lib/crypto';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

const gunzipAsync = promisify(gunzip);

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

    // 检查用户权限（只有站长可以导入数据）
    if (authInfo.username !== process.env.USERNAME) {
      return NextResponse.json(
        { error: '权限不足，只有站长可以导入数据' },
        { status: 401 },
      );
    }

    // 解析表单数据
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const password = formData.get('password') as string;

    if (!file) {
      return NextResponse.json({ error: '请选择备份文件' }, { status: 400 });
    }

    if (!password) {
      return NextResponse.json({ error: '请提供解密密码' }, { status: 400 });
    }

    // 读取文件内容
    const encryptedData = await file.text();

    // 解密数据
    let decryptedData: string;
    try {
      decryptedData = SimpleCrypto.decrypt(encryptedData, password);
    } catch {
      return NextResponse.json(
        { error: '解密失败，请检查密码是否正确' },
        { status: 400 },
      );
    }

    // 解压缩数据
    const compressedBuffer = Buffer.from(decryptedData, 'base64');
    const decompressedBuffer = await gunzipAsync(compressedBuffer);
    const decompressedData = decompressedBuffer.toString();

    // 解析JSON数据
    let importData: any;
    try {
      importData = JSON.parse(decompressedData);
    } catch {
      return NextResponse.json({ error: '备份文件格式错误' }, { status: 400 });
    }

    // 验证数据格式
    if (
      !importData.data ||
      !importData.data.adminConfig ||
      !importData.data.userData ||
      typeof importData.data.userData !== 'object' ||
      Array.isArray(importData.data.userData)
    ) {
      return NextResponse.json({ error: '备份文件格式无效' }, { status: 400 });
    }

    const userData = importData.data.userData;
    // Preflight the whole credential set before the existing destructive import.
    let accounts: ReturnType<typeof prepareAccountRestore>;
    try {
      validateBackupConfiguration(importData.data.adminConfig);
      accounts = prepareAccountRestore(
        userData,
        importData.schemaVersion,
        importData.data.adminConfig.UserConfig?.Users,
        process.env.USERNAME,
        authInfo.uid,
      );
      await assignAccountRestoreUids(
        accounts,
        (uid) => db.allocateUserUid(uid),
        process.env.USERNAME,
        authInfo.uid,
      );
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : '账号备份无效' },
        { status: 400 },
      );
    }

    // Preserve other per-user settings while restoring validated account state.
    const users = importData.data.adminConfig.UserConfig?.Users;
    if (Array.isArray(users)) {
      importData.data.adminConfig.UserConfig.Users = users.map((user: any) => {
        const account = accounts.get(user.username);
        return account
          ? { ...user, ...account.profile, email: account.email || undefined }
          : user;
      });
    }

    await db.clearAllData();

    // Create account metadata, then restore the encoded credential verbatim.
    // A random temporary secret never makes an empty-password account usable.
    for (const [username, account] of accounts) {
      await db.createUserV2(
        username,
        randomBytes(32).toString('hex'),
        account.profile.role,
        account.profile.tags,
        account.profile.oidcSub,
        account.profile.enabledApis,
        account.email || undefined,
        {
          uid: account.profile.uid,
          allowLegacyUsername: true,
          banned: account.profile.banned,
          pending: account.profile.pending,
          source: account.profile.source,
          createdAt: account.profile.createdAt,
        },
      );
      if (account.credential !== null) {
        await db.restoreUserCredential(
          account.profile.uid!,
          account.credential,
        );
      }
    }

    // 步骤2：导入管理员配置并进行自检查
    // 此时数据库中已有用户，configSelfCheck 可以正确获取用户列表并保留备份中的用户配置
    importData.data.adminConfig = await configSelfCheck(
      importData.data.adminConfig,
    );
    await db.saveAdminConfig(importData.data.adminConfig);
    await setCachedConfig(importData.data.adminConfig);

    // 步骤3：导入用户的其他数据（播放记录、收藏、登录统计等）
    for (const [key, rawUser] of Object.entries(userData)) {
      const user = rawUser as any;
      const username = importData.schemaVersion === 3 ? user.username : key;
      const uid = accounts.get(username)!.profile.uid!;

      // 导入播放记录（带数据升级）
      if (user.playRecords) {
        for (const [key, record] of Object.entries(user.playRecords)) {
          // 数据升级：确保所有必需字段存在
          const recordData = record as any;
          const upgradedRecord = {
            ...recordData,
            // 确保 type 字段存在（旧版本可能没有）
            type: recordData.type || undefined,
            // 确保 douban_id 字段存在
            douban_id: recordData.douban_id || undefined,
            // 确保 remarks 字段存在
            remarks: recordData.remarks || undefined,
            // 确保 original_episodes 字段存在
            original_episodes: recordData.original_episodes || undefined,
          };
          await (db as any).storage.setPlayRecord(uid, key, upgradedRecord);
        }
      }

      // 导入收藏夹（带数据升级）
      if (user.favorites) {
        for (const [key, favorite] of Object.entries(user.favorites)) {
          // 数据升级：确保所有必需字段存在
          const favoriteData = favorite as any;
          const upgradedFavorite = {
            ...favoriteData,
            // 确保 origin 字段存在
            origin: favoriteData.origin || 'vod',
            // 确保 type 字段存在
            type: favoriteData.type || undefined,
            // 确保 releaseDate 字段存在
            releaseDate: favoriteData.releaseDate || undefined,
            // 确保 remarks 字段存在
            remarks: favoriteData.remarks || undefined,
          };
          await (db as any).storage.setFavorite(uid, key, upgradedFavorite);
        }
      }

      // 导入想看（即将上映提醒）（带数据升级）
      if (user.reminders) {
        for (const [key, reminder] of Object.entries(user.reminders)) {
          // 数据升级：确保所有必需字段存在
          const reminderData = reminder as any;
          const upgradedReminder = {
            ...reminderData,
            // 确保 origin 字段存在
            origin: reminderData.origin || 'vod',
            // 确保 type 字段存在
            type: reminderData.type || undefined,
            // 确保 releaseDate 字段存在（提醒必须有上映日期）
            releaseDate: reminderData.releaseDate || '',
            // 确保 remarks 字段存在
            remarks: reminderData.remarks || undefined,
          };
          await (db as any).storage.setReminder(uid, key, upgradedReminder);
        }
      }

      // 导入搜索历史
      if (user.searchHistory && Array.isArray(user.searchHistory)) {
        for (const keyword of user.searchHistory.reverse()) {
          // 反转以保持顺序
          await db.addSearchHistory(uid, keyword);
        }
      }

      // 导入跳过片头片尾配置
      if (user.skipConfigs) {
        for (const [key, skipConfig] of Object.entries(user.skipConfigs)) {
          const [source, id] = key.split('+');
          if (source && id) {
            await db.setSkipConfig(uid, source, id, skipConfig as any);
          }
        }
      }

      // 导入登录统计（恢复 loginCount, firstLoginTime, lastLoginTime）
      if (user.loginStats) {
        try {
          const storage = (db as any).storage;
          if (storage && typeof storage.client?.set === 'function') {
            const identity = await db.getUserIdentityByUid(uid);
            if (!identity) throw new Error('用户身份已发生变化');
            const loginStatsKey = `user_login_stats:${identity.storageKey}`;
            const statsData = JSON.stringify(user.loginStats);
            await storage.client.set(loginStatsKey, statsData);
            console.log(`已恢复用户 ${username} 的登录统计:`, user.loginStats);
          }
        } catch (error) {
          console.error(`恢复用户 ${username} 登录统计失败:`, error);
        }
      }
    }

    return NextResponse.json({
      message: '数据导入成功',
      importedUsers: Object.keys(userData).length,
      timestamp: importData.timestamp,
      serverVersion:
        typeof importData.serverVersion === 'string'
          ? importData.serverVersion
          : '未知版本',
    });
  } catch (error) {
    console.error('数据导入失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '导入失败' },
      { status: 500 },
    );
  }
}
