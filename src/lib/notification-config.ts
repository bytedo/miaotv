import { isIP } from 'net';

import { isValidEmail, normalizeEmail } from './account-policy';
import type { AdminConfig } from './admin.types';

export type EmailSettings = NonNullable<AdminConfig['EmailConfig']>;
export type WebhookSettings = NonNullable<AdminConfig['WebhookConfig']>;
export const NOTIFICATION_SECRET_MASK = '******';

export class NotificationConfigError extends Error {
  readonly status = 400;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new NotificationConfigError('配置格式错误');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit: number): string {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new NotificationConfigError(`${label}格式错误`);
  return value.trim();
}

function secret(
  value: unknown,
  previous: string | undefined,
  label: string,
): string {
  if (
    value === NOTIFICATION_SECRET_MASK &&
    (!previous || previous === NOTIFICATION_SECRET_MASK)
  )
    throw new NotificationConfigError(`请填写${label}`);
  const candidate =
    value === undefined || value === NOTIFICATION_SECRET_MASK
      ? previous || ''
      : value;
  if (
    typeof candidate !== 'string' ||
    candidate.length > 4096 ||
    /[\u0000\r\n]/.test(candidate) ||
    candidate === NOTIFICATION_SECRET_MASK
  )
    throw new NotificationConfigError(`${label}格式错误`);
  return candidate;
}

export function parseNotificationEmail(value: unknown): string {
  const email = normalizeEmail(value);
  if (!isValidEmail(email))
    throw new NotificationConfigError('请输入单个有效邮箱地址');
  return email;
}

export function parseEmailConfig(
  value: unknown,
  previous?: EmailSettings,
): EmailSettings {
  const input = record(value);
  if (
    typeof input.enabled !== 'boolean' ||
    typeof input.smtpSecure !== 'boolean'
  )
    throw new NotificationConfigError('邮件开关格式错误');
  if (
    !Number.isInteger(input.smtpPort) ||
    (input.smtpPort as number) < 1 ||
    (input.smtpPort as number) > 65535
  )
    throw new NotificationConfigError('SMTP 端口必须是 1 到 65535 之间的整数');
  const smtpHost = text(input.smtpHost, 'SMTP 服务器', 253);
  if (
    smtpHost &&
    !isIP(smtpHost) &&
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i.test(
      smtpHost,
    )
  )
    throw new NotificationConfigError('SMTP 服务器应填写域名或 IP 地址');
  const smtpUser = text(input.smtpUser, 'SMTP 用户名', 320);
  const smtpPass = secret(input.smtpPass, previous?.smtpPass, 'SMTP 密码');
  const senderName = text(input.senderName, '发件人名称', 128);
  const senderValue = text(input.senderEmail, '发件人邮箱', 254);
  const senderEmail = senderValue ? parseNotificationEmail(senderValue) : '';
  if (input.enabled && (!smtpHost || !senderEmail))
    throw new NotificationConfigError(
      '启用邮件通知前请填写 SMTP 服务器和发件人邮箱',
    );
  if (input.enabled && Boolean(smtpUser) !== Boolean(smtpPass))
    throw new NotificationConfigError(
      'SMTP 用户名和密码须同时填写，匿名 SMTP 可同时留空',
    );
  return {
    enabled: input.enabled,
    smtpHost,
    smtpPort: input.smtpPort as number,
    smtpSecure: input.smtpSecure,
    smtpUser,
    smtpPass,
    senderName,
    senderEmail,
  };
}

export function parseWebhookUrl(value: unknown): string {
  const url = text(value, 'Webhook URL', 8192);
  const authority = /^[a-z]+:\/\/([^/?#]*)/i.exec(url)?.[1] || '';
  const expanded = url.replace(
    /\{(username|email|source|reason|message)\}/g,
    'notification',
  );
  if (!authority || /[{}]/.test(authority) || /[{}]/.test(expanded))
    throw new NotificationConfigError('Webhook URL 格式或变量错误');
  try {
    const parsed = new URL(expanded);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      throw new Error('Invalid webhook URL');
  } catch {
    throw new NotificationConfigError(
      'Webhook URL 须为不含账号密码和片段的 HTTP 或 HTTPS 地址',
    );
  }
  return url;
}

export function parseWebhookConfig(
  value: unknown,
  previous?: WebhookSettings,
): WebhookSettings {
  const input = record(value);
  if (
    typeof input.enabled !== 'boolean' ||
    typeof input.notifyOnRegister !== 'boolean'
  )
    throw new NotificationConfigError('Webhook 开关格式错误');
  const urlValue = text(input.url, 'Webhook URL', 8192);
  const url = urlValue ? parseWebhookUrl(urlValue) : '';
  if (input.enabled && !url)
    throw new NotificationConfigError('启用 Webhook 前请填写 URL');
  const messageTemplate = input.messageTemplate ?? '';
  if (
    typeof messageTemplate !== 'string' ||
    messageTemplate.length > 10000 ||
    /\u0000/.test(messageTemplate)
  )
    throw new NotificationConfigError('消息模板格式错误或超过 10000 字');
  return {
    enabled: input.enabled,
    url,
    secret: secret(input.secret, previous?.secret, 'Webhook 签名密钥'),
    notifyOnRegister: input.notifyOnRegister,
    messageTemplate,
  };
}

export function maskEmailConfig(
  config?: EmailSettings | null,
): EmailSettings | null {
  return config
    ? { ...config, smtpPass: config.smtpPass ? NOTIFICATION_SECRET_MASK : '' }
    : null;
}

export function maskWebhookConfig(
  config?: WebhookSettings | null,
): WebhookSettings | null {
  return config
    ? { ...config, secret: config.secret ? NOTIFICATION_SECRET_MASK : '' }
    : null;
}
