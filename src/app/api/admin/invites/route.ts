/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { ensureAdmin } from '@/lib/admin-auth';
import { getVerifiedAuthInfo } from '@/lib/auth.server';
import {
  createInviteCode,
  getAllInviteCodes,
  InviteCodeError,
  removeInviteCode,
  toggleInviteCode,
} from '@/lib/invite-code';
import { parseCustomInviteCode } from '@/lib/invite-code-policy';

export const runtime = 'nodejs';

/**
 * GET /api/admin/invites
 * 获取所有邀请码列表（包括已用完、已过期、已禁用的）
 */
export async function GET(req: NextRequest) {
  try {
    // 验证管理员权限
    await ensureAdmin(req);

    const codes = await getAllInviteCodes();

    return NextResponse.json({
      ok: true,
      codes,
      total: codes.length,
    });
  } catch (error) {
    console.error('[Admin Invites] 获取邀请码列表失败:', error);
    if ((error as Error).message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }
    return NextResponse.json({ error: '获取邀请码列表失败' }, { status: 500 });
  }
}

/**
 * POST /api/admin/invites
 * 创建自定义或随机邀请码
 */
export async function POST(req: NextRequest) {
  try {
    // 验证管理员权限
    await ensureAdmin(req);

    // 获取用户名
    const authInfo = await getVerifiedAuthInfo(req);
    if (!authInfo) throw new Error('UNAUTHORIZED');
    const userRef = authInfo.uid || authInfo.username;

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: '请求内容须为有效 JSON' },
        { status: 400 },
      );
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: '邀请码参数格式错误' },
        { status: 400 },
      );
    }
    const { maxUses = 10, expiresIn = 604800 } = body; // 默认10次，7天
    const custom = parseCustomInviteCode(body.code);
    if (custom.error) {
      return NextResponse.json({ error: custom.error }, { status: 400 });
    }

    // 验证参数
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
      return NextResponse.json(
        { error: '使用次数必须在 1-1000 之间' },
        { status: 400 },
      );
    }

    if (
      !Number.isInteger(expiresIn) ||
      expiresIn < 3600 ||
      expiresIn > 31536000
    ) {
      return NextResponse.json(
        { error: '过期时间必须在 1小时-1年 之间' },
        { status: 400 },
      );
    }

    const code = await createInviteCode(
      userRef,
      maxUses,
      expiresIn,
      custom.code || undefined,
    );

    return NextResponse.json({
      ok: true,
      code,
      message: '邀请码生成成功',
    });
  } catch (error) {
    if ((error as Error).message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }
    if (error instanceof InviteCodeError) {
      if (error.code === 'ALREADY_EXISTS') {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error.code === 'INVALID_CODE') {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    console.error('[Admin Invites] 生成邀请码失败:', error);
    return NextResponse.json({ error: '生成邀请码失败' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/invites?code=XXX
 * 删除邀请码
 */
export async function DELETE(req: NextRequest) {
  try {
    // 验证管理员权限
    await ensureAdmin(req);

    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');

    if (!code) {
      return NextResponse.json({ error: '缺少邀请码参数' }, { status: 400 });
    }

    const success = await removeInviteCode(code);

    if (!success) {
      return NextResponse.json({ error: '邀请码不存在' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      message: '邀请码已删除',
    });
  } catch (error) {
    console.error('[Admin Invites] 删除邀请码失败:', error);
    if ((error as Error).message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }
    return NextResponse.json({ error: '删除邀请码失败' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/invites?code=XXX
 * 禁用/启用邀请码
 */
export async function PATCH(req: NextRequest) {
  try {
    // 验证管理员权限
    await ensureAdmin(req);

    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');

    if (!code) {
      return NextResponse.json({ error: '缺少邀请码参数' }, { status: 400 });
    }

    const body = await req.json();
    const { disabled } = body;

    if (typeof disabled !== 'boolean') {
      return NextResponse.json(
        { error: '缺少 disabled 参数' },
        { status: 400 },
      );
    }

    const success = await toggleInviteCode(code, disabled);

    if (!success) {
      return NextResponse.json({ error: '邀请码不存在' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      message: disabled ? '邀请码已禁用' : '邀请码已启用',
    });
  } catch (error) {
    console.error('[Admin Invites] 切换邀请码状态失败:', error);
    if ((error as Error).message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }
    return NextResponse.json({ error: '切换邀请码状态失败' }, { status: 500 });
  }
}
