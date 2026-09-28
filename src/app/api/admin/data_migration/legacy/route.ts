import { NextRequest, NextResponse } from 'next/server';

import { getVerifiedAuthInfo } from '@/lib/auth.server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await getVerifiedAuthInfo(request);
  if (!auth || auth.username !== process.env.USERNAME) {
    return NextResponse.json({ error: '只有站长可以整理旧数据' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (body?.confirm !== true) {
    return NextResponse.json({ error: '请先确认旧数据整理操作' }, { status: 400 });
  }
  try {
    const result = await db.migrateLegacyData();
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '整理失败，可修复问题后重试' },
      { status: 500 },
    );
  }
}
