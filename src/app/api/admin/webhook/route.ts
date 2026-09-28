import { NextRequest, NextResponse } from 'next/server';

import { getAdminRoleFromRequest } from '@/lib/admin-auth';
import { clearConfigCache, getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  maskWebhookConfig,
  NotificationConfigError,
  parseWebhookConfig,
  parseWebhookUrl,
} from '@/lib/notification-config';
import { testWebhookConfig } from '@/lib/webhookService';

export const runtime = 'nodejs';

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: NextRequest) {
  try {
    if ((await getAdminRoleFromRequest(request)) !== 'owner')
      return reply({ error: '只有站长可以管理 Webhook 通知' }, 403);
    const config = await getConfig();
    return reply({ config: maskWebhookConfig(config.WebhookConfig) });
  } catch {
    return reply({ error: '获取 Webhook 配置失败' }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    if ((await getAdminRoleFromRequest(request)) !== 'owner')
      return reply({ error: '只有站长可以管理 Webhook 通知' }, 403);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return reply({ error: '请求内容须为有效 JSON' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return reply({ error: '请求格式错误' }, 400);
    const input = body as Record<string, unknown>;
    if (input.action === 'test') {
      const url =
        input.url === undefined ? undefined : parseWebhookUrl(input.url);
      const config = await getConfig();
      if (url !== undefined && url !== config.WebhookConfig?.url?.trim())
        return reply({ error: '请先保存 Webhook 配置，再发送测试通知' }, 400);
      const result = await testWebhookConfig();
      return reply(result, result.success ? 200 : 502);
    }
    if (input.action === 'save') {
      if (
        (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') ===
        'localstorage'
      )
        return reply(
          { error: 'localStorage 模式不支持保存 Webhook 配置' },
          400,
        );
      const config = await getConfig();
      const webhookConfig = parseWebhookConfig(
        input.config,
        config.WebhookConfig,
      );
      await db.saveAdminConfig({ ...config, WebhookConfig: webhookConfig });
      clearConfigCache();
      return reply({
        success: true,
        message: '配置已保存',
        config: maskWebhookConfig(webhookConfig),
      });
    }
    return reply({ error: '未知操作' }, 400);
  } catch (error) {
    return error instanceof NotificationConfigError
      ? reply({ error: error.message }, 400)
      : reply({ error: 'Webhook 配置操作失败' }, 500);
  }
}
