/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/adminAuth';
import { fetchUserEmail, refreshAccessToken } from '@/lib/antigravityPool';

export async function GET(req: Request) {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;

  try {
    const now = new Date();
    await prisma.accountLease.deleteMany({ where: { leaseUntil: { lte: now } } });

    if (process.env.FALLBACK_GEMINI_API_KEY) {
      await prisma.account.upsert({
        where: { id: 'fallback-ai-studio' },
        update: {},
        create: {
          id: 'fallback-ai-studio',
          name: 'Google AI Studio (Fallback)',
          email: 'ai-studio@fallback',
          refreshToken: 'none',
          status: 'fallback',
        },
      });
    }

    const accounts = await prisma.account.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        leases: {
          where: { leaseUntil: { gt: now } },
          orderBy: { leaseUntil: 'desc' },
          take: 1,
        },
      },
    });

    const normalized = accounts.map((account) => ({
      id: account.id,
      name: account.name,
      email: account.email,
      status: account.status,
      lastUsed: account.lastUsed.toISOString(),
      usageCount: account.usageCount,
      hasRefreshToken: !!account.refreshToken,
      quotaStatus: account.quotaStatus,
      quotaResetAt: account.quotaResetAt ? account.quotaResetAt.toISOString() : null,
      quotaMessage: account.quotaMessage,
      quotaCheckedAt: account.quotaCheckedAt ? account.quotaCheckedAt.toISOString() : null,
      leaseUntil: account.leases[0]?.leaseUntil.toISOString() ?? null,
    }));

    return NextResponse.json(normalized);
  } catch (error) {
    console.error('Error fetching accounts:', error);
    return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;

  try {
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }
    if (!refreshToken) {
      return NextResponse.json({ error: 'Refresh token is required' }, { status: 400 });
    }

    let email = body.email || null;
    if (!email) {
      try {
        console.log(`Resolving email dynamically from refresh token...`);
        const { access_token } = await refreshAccessToken(refreshToken);
        email = await fetchUserEmail(access_token);
        console.log(`Resolved email: ${email}`);
      } catch (err: any) {
        console.warn('Failed to dynamically fetch email from refresh token:', err.message);
      }
    }

    const account = await prisma.account.create({
      data: {
        name,
        email,
        refreshToken,
        status: 'active',
      },
    });

    return NextResponse.json({
      id: account.id,
      name: account.name,
      email: account.email,
      status: account.status,
      lastUsed: account.lastUsed.toISOString(),
      usageCount: account.usageCount,
      hasRefreshToken: true,
      quotaStatus: account.quotaStatus,
      quotaResetAt: null,
      quotaMessage: null,
      quotaCheckedAt: null,
      leaseUntil: null,
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating account:', error);
    const message = error instanceof Error ? error.message : 'Failed to create account';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
