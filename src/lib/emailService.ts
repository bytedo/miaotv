import type { Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';

import { getConfig } from './config';
import {
  NotificationConfigError,
  parseEmailConfig,
  parseNotificationEmail,
} from './notification-config';

interface EmailResult {
  success: boolean;
  error?: string;
}

interface EmailMessage {
  subject: string;
  title: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

function configuredSiteUrl(): URL | undefined {
  const value = process.env.SITE_BASE || process.env.NEXT_PUBLIC_BASE_URL;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid site URL');
    return url;
  } catch {
    throw new NotificationConfigError(
      '请将 SITE_BASE 或 NEXT_PUBLIC_BASE_URL 配置为本站的完整 HTTP 或 HTTPS 地址',
    );
  }
}

function deliveryError(error: unknown): string {
  if (error instanceof NotificationConfigError) return error.message;
  const code =
    error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (code === 'EAUTH') return 'SMTP 身份验证失败，请检查用户名和密码或授权码';
  if (code === 'ETIMEDOUT')
    return 'SMTP 连接超时，请检查服务器地址、端口和网络';
  if (code === 'ESOCKET')
    return 'SMTP 连接或 TLS 校验失败，请检查端口和加密设置';
  if (
    ['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(
      String(code),
    )
  )
    return '无法连接 SMTP 服务器，请检查地址、端口和网络';
  if (code === 'EENVELOPE') return 'SMTP 服务器拒绝发件人或收件人地址';
  return '邮件发送失败，请检查 SMTP 配置和邮箱发送限制';
}

async function sendAccountEmail(
  recipient: string,
  createMessage: (siteName: string) => EmailMessage,
): Promise<EmailResult> {
  let transporter: Transporter | undefined;
  try {
    const config = await getConfig();
    if (!config.EmailConfig?.enabled)
      return { success: false, error: '请先保存并启用邮件通知配置' };
    const settings = parseEmailConfig(config.EmailConfig, config.EmailConfig);
    const to = parseNotificationEmail(recipient);
    const siteName = String(config.SiteConfig?.SiteName || '影视站').replace(
      /[\r\n]/g,
      ' ',
    );
    const message = createMessage(siteName);
    transporter = nodemailer.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpSecure,
      auth: settings.smtpUser
        ? { user: settings.smtpUser, pass: settings.smtpPass }
        : undefined,
      requireTLS: !settings.smtpSecure && Boolean(settings.smtpUser),
      tls: { rejectUnauthorized: true },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const result = await transporter.sendMail({
      from: {
        name: settings.senderName || '系统通知',
        address: settings.senderEmail,
      },
      to,
      subject: message.subject,
      text: message.text,
      html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">${escapeHtml(message.title)}</h2>
        ${message.html}
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #888; font-size: 12px;">此邮件由系统自动发送，请勿回复。</p>
      </div>`,
    });
    if (result?.rejected?.length)
      return { success: false, error: '收件地址被 SMTP 服务器拒绝' };
    return { success: true };
  } catch (error) {
    return { success: false, error: deliveryError(error) };
  } finally {
    transporter?.close();
  }
}

export async function sendRegistrationPendingEmail(
  userEmail: string,
  username: string,
): Promise<EmailResult> {
  return sendAccountEmail(userEmail, (siteName) => ({
    subject: `【${siteName}】注册成功，等待审核`,
    title: `欢迎注册 ${siteName}`,
    html: `<p>您好，<strong>${escapeHtml(username)}</strong>：</p>
      <p>您的账户已注册成功，目前正在等待管理员审核。</p>
      <p>审核通过后，您将收到邮件通知，届时即可正常登录使用。</p>`,
    text: `您好，${username}：您的 ${siteName} 账户已注册成功，正在等待管理员审核。审核通过后将收到邮件通知。`,
  }));
}

export async function sendApprovalEmail(
  userEmail: string,
  username: string,
): Promise<EmailResult> {
  return sendAccountEmail(userEmail, (siteName) => {
    const siteUrl = configuredSiteUrl();
    const loginUrl = siteUrl ? new URL('/login', siteUrl).href : undefined;
    return {
      subject: `【${siteName}】您的账户已通过审核`,
      title: '您的账户已通过审核',
      html: `<p>您好，<strong>${escapeHtml(username)}</strong>：</p>
        <p>您的账户已通过管理员审核，请使用注册时选择的方式登录。</p>
        <p>账号：${escapeHtml(username)}<br>邮箱：${escapeHtml(userEmail)}</p>
        ${loginUrl ? `<p><a href="${escapeHtml(loginUrl)}">立即登录</a></p>` : '<p>请返回本站登录。</p>'}`,
      text: `您好，${username}：您的 ${siteName} 账户已通过审核，请使用注册时选择的方式登录。${loginUrl || '请返回本站登录。'}`,
    };
  });
}

export async function sendRejectionEmail(
  userEmail: string,
  username: string,
  reason?: string,
): Promise<EmailResult> {
  return sendAccountEmail(userEmail, (siteName) => ({
    subject: `【${siteName}】您的注册申请未通过`,
    title: '注册申请未通过',
    html: `<p>您好，<strong>${escapeHtml(username)}</strong>：</p>
      <p>很抱歉，您的注册申请未通过管理员审核。</p>
      ${reason ? `<p><strong>原因：</strong>${escapeHtml(reason)}</p>` : ''}
      <p>如有疑问，请联系网站管理员。</p>`,
    text: `您好，${username}：您的 ${siteName} 注册申请未通过。${reason ? `原因：${reason}。` : ''}如有疑问，请联系网站管理员。`,
  }));
}

export async function testEmailConfig(testEmail: string): Promise<EmailResult> {
  return sendAccountEmail(testEmail, (siteName) => ({
    subject: `【${siteName}】邮件配置测试`,
    title: '邮件配置测试成功',
    html: '<p>如果您收到这封邮件，说明邮件配置正确。</p>',
    text: '如果您收到这封邮件，说明邮件配置正确。',
  }));
}

export async function sendPasswordResetEmail(
  userEmail: string,
  username: string,
  resetToken: string,
): Promise<EmailResult> {
  return sendAccountEmail(userEmail, (siteName) => {
    const siteUrl = configuredSiteUrl();
    if (!siteUrl)
      throw new NotificationConfigError(
        '发送密码重置邮件前，请配置本站 SITE_BASE 或 NEXT_PUBLIC_BASE_URL',
      );
    const resetUrl = new URL('/reset-password', siteUrl);
    resetUrl.searchParams.set('token', resetToken);
    const href = escapeHtml(resetUrl.href);
    return {
      subject: `【${siteName}】密码重置请求`,
      title: '密码重置请求',
      html: `<p>您好，<strong>${escapeHtml(username)}</strong>：</p>
        <p>我们收到了您的密码重置请求。请点击下方链接重置密码：</p>
        <p><a href="${href}">重置密码</a></p>
        <p>此链接将在 15 分钟后失效，且只能使用一次。</p>
        <p>如果无法点击链接，请复制以下地址到浏览器：</p><p>${href}</p>
        <p>如果您没有请求重置密码，请忽略此邮件。</p>`,
      text: `您好，${username}：您申请了重置 ${siteName} 密码。请在 15 分钟内访问 ${resetUrl.href} 。链接只能使用一次；如果并非本人申请，请忽略此邮件。`,
    };
  });
}
