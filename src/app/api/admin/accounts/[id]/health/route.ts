import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/adminAuth';
import {
  quotaObservationForFailure,
  quotaObservationForSuccess,
  HEALTH_CHECK_MODEL_ID,
  runAntigravityStream,
  runAIStudioStream,
} from '@/lib/antigravityPool';

function isOAuthClientConfigError(message?: string) {
  return Boolean(message?.includes('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured'));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    
    if (id === 'fallback-ai-studio') {
      const fallbackKey = process.env.FALLBACK_GEMINI_API_KEY;
      if (!fallbackKey) {
        const updated = await prisma.account.update({
          where: { id },
          data: { status: 'invalid' },
        });
        return NextResponse.json({ ok: false, status: updated.status, message: 'FALLBACK_GEMINI_API_KEY is not configured in .env' }, { status: 409 });
      }
      const result = await runAIStudioStream(fallbackKey, HEALTH_CHECK_MODEL_ID, 'Reply with exactly: ok');
      if (result.ok) {
        const updated = await prisma.account.update({
          where: { id },
          data: { status: 'fallback', ...quotaObservationForSuccess() },
        });
        return NextResponse.json({ ok: true, status: updated.status, message: result.text });
      }
      const updated = await prisma.account.update({
        where: { id },
        data: {
          status: 'fallback',
          ...quotaObservationForFailure(502, result.message || '', new Date()),
        },
      });
      return NextResponse.json({ ok: false, status: updated.status, message: result.message }, { status: 502 });
    }

    const account = await prisma.account.findUnique({ where: { id } });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    if (!account.refreshToken || account.refreshToken === 'none') {
      const updated = await prisma.account.update({ where: { id }, data: { status: 'invalid' } });
      return NextResponse.json({ ok: false, status: updated.status, message: 'Refresh token is missing' }, { status: 409 });
    }

    const result = await runAntigravityStream(account, HEALTH_CHECK_MODEL_ID, 'Reply with exactly: ok');
    if (result.ok) {
      const updated = await prisma.account.update({
        where: { id },
        data: { status: 'active', ...quotaObservationForSuccess() },
      });
      return NextResponse.json({ ok: true, status: updated.status, message: result.text });
    }

    if (isOAuthClientConfigError(result.message)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'oauth_config_missing',
          status: account.status,
          message: '自检需要先配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET；当前账号未被标记为失效。',
        },
        { status: 409 }
      );
    }

    const status = result.accountStatus ?? account.status;
    const statusCode = result.accountStatus === 'exhausted' ? 429 : (result.accountStatus === 'invalid' ? 401 : 502);
    const updated = await prisma.account.update({
      where: { id },
      data: {
        status,
        ...quotaObservationForFailure(statusCode, result.message || '', new Date()),
      },
    });

    return NextResponse.json({ ok: false, status: updated.status, message: result.message }, { status: statusCode });
  } catch (error) {
    console.error('Health check failed:', error);
    const message = error instanceof Error ? error.message : 'Health check failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
