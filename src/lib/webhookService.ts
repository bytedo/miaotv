import { createHmac } from 'crypto';

import { getConfig } from './config';
import {
  NotificationConfigError,
  parseWebhookConfig,
  type WebhookSettings,
} from './notification-config';
import {
  fetchWithValidatedRedirects,
  ProxyTargetError,
} from './proxy-security';

type WebhookNotificationType =
  | 'new_registration'
  | 'user_approved'
  | 'user_rejected'
  | 'test';

interface WebhookPayload {
  type: WebhookNotificationType;
  timestamp: number;
  data: {
    username: string;
    email?: string;
    source?: string;
    reason?: string;
  };
}

interface WebhookResult {
  success: boolean;
  error?: string;
}

function replaceTemplateVariables(
  template: string,
  data: WebhookPayload['data'],
): string {
  return template.replace(
    /\{(username|email|source|reason)\}/g,
    (_match, key: keyof WebhookPayload['data']) => data[key] || '',
  );
}

function generateDefaultMessage(
  type: WebhookNotificationType,
  data: WebhookPayload['data'],
): string {
  switch (type) {
    case 'new_registration':
      return `[新用户注册待审核]\n用户名: ${data.username}\n邮箱: ${data.email || '未提供'}\n申请理由: ${data.source || '未提供'}`;
    case 'user_approved':
      return `[用户审核通过]\n用户名: ${data.username}`;
    case 'user_rejected':
      return `[用户审核拒绝]\n用户名: ${data.username}\n原因: ${data.reason || '无'}`;
    case 'test':
      return '[通知配置测试]\n这是一条由站长主动发送的 Webhook 测试消息。';
  }
}

async function deliverWebhook(
  settings: WebhookSettings,
  type: WebhookNotificationType,
  data: WebhookPayload['data'],
): Promise<WebhookResult> {
  const message = settings.messageTemplate
    ? replaceTemplateVariables(settings.messageTemplate, data)
    : generateDefaultMessage(type, data);
  const useGet = /\{(username|email|source|reason|message)\}/.test(
    settings.url,
  );
  const url = settings.url.replace(
    /\{(username|email|source|reason|message)\}/g,
    (_match, key: keyof WebhookPayload['data'] | 'message') =>
      encodeURIComponent(key === 'message' ? message : data[key] || ''),
  );
  const payload: WebhookPayload = { type, timestamp: Date.now(), data };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (!useGet && settings.secret)
    headers['X-Webhook-Signature'] = createHmac('sha256', settings.secret)
      .update(body)
      .digest('hex');

  let error = 'Webhook 发送失败';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchWithValidatedRedirects(
        url,
        useGet ? { method: 'GET' } : { method: 'POST', headers, body },
        {
          timeoutMs: 10000,
          maxRedirects: 0,
          allowCrossOriginRedirects: false,
          // The owner explicitly configures this endpoint. Other origins never
          // inherit that grant; loopback and metadata addresses remain blocked.
          allowedPrivateOrigins: [new URL(url).origin],
        },
      );
      await response.body?.cancel().catch(() => {});
      if (response.ok) return { success: true };
      error = `Webhook 返回 HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429)
        return { success: false, error };
    } catch (cause) {
      if (cause instanceof ProxyTargetError)
        return { success: false, error: 'Webhook 地址或重定向被安全规则拒绝' };
      error =
        cause instanceof Error && cause.name === 'AbortError'
          ? 'Webhook 请求超时，请检查接收服务和网络'
          : 'Webhook 连接失败，请检查接收地址和网络';
    }
    if (attempt < 2)
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return { success: false, error };
}

export async function sendWebhookNotification(
  type: WebhookNotificationType,
  data: WebhookPayload['data'],
): Promise<WebhookResult> {
  try {
    const config = await getConfig();
    if (!config.WebhookConfig?.enabled || !config.WebhookConfig.url)
      return { success: false, error: '请先保存并启用 Webhook 配置' };
    if (type === 'new_registration' && !config.WebhookConfig.notifyOnRegister)
      return { success: false, error: '新注册通知未启用' };
    const settings = parseWebhookConfig(
      config.WebhookConfig,
      config.WebhookConfig,
    );
    return await deliverWebhook(settings, type, data);
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof NotificationConfigError
          ? error.message
          : '读取 Webhook 配置失败',
    };
  }
}

export async function sendNewRegistrationWebhook(
  username: string,
  email?: string,
  source?: string,
): Promise<WebhookResult> {
  return sendWebhookNotification('new_registration', {
    username,
    email,
    source,
  });
}

export async function testWebhookConfig(): Promise<WebhookResult> {
  return sendWebhookNotification('test', {
    username: '通知测试',
    email: 'test@example.test',
    source: '这是一条由站长主动发送的测试消息。',
  });
}
