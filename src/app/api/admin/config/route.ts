import { revalidatePath } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

import {
  getRegistrationPolicy,
  type RegistrationSettings,
} from '@/lib/account-policy';
import { AdminConfig, AdminConfigResult } from '@/lib/admin.types';
import { getAdminRoleFromRequest } from '@/lib/admin-auth';
import { clearConfigCache, getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  maskEmailConfig,
  maskWebhookConfig,
  NotificationConfigError,
  parseEmailConfig,
  parseWebhookConfig,
} from '@/lib/notification-config';
import { stripRemovedFeatureConfig } from '@/lib/retired-features';

export const runtime = 'nodejs';

const registrationKeys = [
  'AllowRegister',
  'RequireApproval',
  'RequireInviteCode',
] as const;
const registrationWriteState = globalThis as typeof globalThis & {
  __miaotvRegistrationSettingsWriteTail?: Promise<void>;
};

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function supportsStorage() {
  return (
    (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') !== 'localstorage'
  );
}

export async function GET(request: NextRequest) {
  if (!supportsStorage())
    return reply({ error: '不支持本地存储进行管理员配置' }, 400);

  try {
    const role = await getAdminRoleFromRequest(request);
    if (!role) return reply({ error: 'Unauthorized' }, 401);

    const config = stripRemovedFeatureConfig(await getConfig());
    if (role === 'owner') {
      if (config.EmailConfig)
        config.EmailConfig = maskEmailConfig(config.EmailConfig) ?? undefined;
      if (config.WebhookConfig)
        config.WebhookConfig =
          maskWebhookConfig(config.WebhookConfig) ?? undefined;
    } else {
      // Notification configuration belongs to the owner. Webhook URLs can
      // themselves contain credentials, so omit the entire section for admins.
      delete config.EmailConfig;
      delete config.WebhookConfig;
    }
    const result: AdminConfigResult = { Role: role, Config: config };
    return reply(result);
  } catch {
    return reply({ error: '获取管理员配置失败' }, 500);
  }
}

// Registration switches update only their own fields. A stale settings page
// must not overwrite account approvals or unrelated site/notification settings.
export async function PATCH(request: NextRequest) {
  if (!supportsStorage())
    return reply({ error: '不支持本地存储进行管理员配置' }, 400);

  let releaseWrite: (() => void) | undefined;
  try {
    if ((await getAdminRoleFromRequest(request)) !== 'owner')
      return reply({ error: '只有站长可以修改配置' }, 403);

    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return reply({ error: '请求内容须为有效 JSON' }, 400);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return reply({ error: '注册设置格式错误' }, 400);
    const entries = Object.entries(input);
    if (
      entries.length === 0 ||
      entries.some(
        ([key, value]) =>
          !registrationKeys.some((allowed) => allowed === key) ||
          typeof value !== 'boolean',
      )
    )
      return reply({ error: '仅支持修改注册、审核和邀请码布尔开关' }, 400);

    const previousWrite =
      registrationWriteState.__miaotvRegistrationSettingsWriteTail;
    registrationWriteState.__miaotvRegistrationSettingsWriteTail =
      new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    await previousWrite;

    const config = structuredClone(await getConfig());
    config.UserConfig = {
      ...config.UserConfig,
      ...(input as RegistrationSettings),
    };
    await db.saveAdminConfig(config);
    clearConfigCache();
    revalidatePath('/', 'layout');
    return reply({
      success: true,
      ...getRegistrationPolicy(config.UserConfig),
    });
  } catch {
    return reply({ error: '保存注册设置失败' }, 500);
  } finally {
    releaseWrite?.();
  }
}

export async function POST(request: NextRequest) {
  if (!supportsStorage())
    return reply({ error: '不支持本地存储进行管理员配置' }, 400);

  try {
    if ((await getAdminRoleFromRequest(request)) !== 'owner')
      return reply({ error: '只有站长可以修改配置' }, 403);

    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return reply({ error: '请求内容须为有效 JSON' }, 400);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return reply({ error: '配置格式错误' }, 400);
    const submitted = input as AdminConfig;
    if (
      !submitted.SiteConfig ||
      typeof submitted.SiteConfig !== 'object' ||
      Array.isArray(submitted.SiteConfig) ||
      !submitted.UserConfig ||
      typeof submitted.UserConfig !== 'object' ||
      !Array.isArray(submitted.UserConfig.Users) ||
      !Array.isArray(submitted.SourceConfig) ||
      !Array.isArray(submitted.CustomCategories)
    )
      return reply({ error: '配置格式错误' }, 400);
    if (
      registrationKeys.some(
        (key) =>
          submitted.UserConfig[key] !== undefined &&
          typeof submitted.UserConfig[key] !== 'boolean',
      )
    )
      return reply({ error: '注册开关必须为布尔值' }, 400);

    const previous = await getConfig();
    const config = stripRemovedFeatureConfig(submitted);
    // A full-config save can come from another settings panel. Preserve omitted
    // notification sections and resolve masked credentials before persistence.
    if (submitted.EmailConfig !== undefined) {
      config.EmailConfig = parseEmailConfig(
        submitted.EmailConfig,
        previous.EmailConfig,
      );
    } else if (previous.EmailConfig) {
      config.EmailConfig = previous.EmailConfig;
    }
    if (submitted.WebhookConfig !== undefined) {
      config.WebhookConfig = parseWebhookConfig(
        submitted.WebhookConfig,
        previous.WebhookConfig,
      );
    } else if (previous.WebhookConfig) {
      config.WebhookConfig = previous.WebhookConfig;
    }

    await db.saveAdminConfig(config);
    clearConfigCache();
    revalidatePath('/', 'layout');
    return reply({ success: true });
  } catch (error) {
    return error instanceof NotificationConfigError
      ? reply({ error: error.message }, 400)
      : reply({ error: '保存配置失败' }, 500);
  }
}
