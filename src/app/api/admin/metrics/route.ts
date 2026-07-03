import { prisma } from '@/lib/prisma';
import type { Account, AccountLease } from '@/lib/prisma';
import { requireAdmin } from '@/lib/adminAuth';
import { NextResponse } from 'next/server';

type MonitorMetrics = {
  timestamp: string;
  last1h: {
    total429: number;
    totalRequests: number;
    errorRate: number;
    averageLatency: number;
    accounts: Array<{ name: string; count429: number; total: number; rate: number }>;
  };
  accounts: Array<{
    name: string;
    email: string | null;
    status: string;
    quotaStatus: string;
    quotaResetAt: string | null;
    leaseUntil: string | null;
  }>;
  alert: {
    triggered: boolean;
    threshold: number;
    reason?: string;
  };
};

export async function GET(req: Request) {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;

  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    await prisma.accountLease.deleteMany({ where: { leaseUntil: { lte: now } } });

    const [rawAccounts, logs] = await Promise.all([
      prisma.account.findMany({
        orderBy: { name: 'asc' },
        include: {
          leases: {
            where: { leaseUntil: { gt: now } },
            orderBy: { leaseUntil: 'desc' },
            take: 1,
          },
        },
      }),
      prisma.requestLog.findMany({
        where: {
          timestamp: { gte: oneHourAgo },
        },
        include: {
          account: true,
        },
      }),
    ]);
    const accounts = rawAccounts as Array<Account & { leases: AccountLease[] }>;

    const totalRequests = logs.length;
    const total429 = logs.filter((l) => l.statusCode === 429).length;
    const totalErrors = logs.filter((l) => l.statusCode >= 400).length;
    const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
    
    const sumLatency = logs.reduce((sum, l) => sum + l.latency, 0);
    const averageLatency = totalRequests > 0 ? Math.round(sumLatency / totalRequests) : 0;

    // Build per-account breakdown of request counts in the last 1h
    const accountStatsMap = new Map<string, { count429: number; total: number }>();
    for (const acc of accounts) {
      accountStatsMap.set(acc.name, { count429: 0, total: 0 });
    }

    for (const log of logs) {
      const accountName = log.account?.name ?? '未知';
      const current = accountStatsMap.get(accountName) || { count429: 0, total: 0 };
      current.total += 1;
      if (log.statusCode === 429) {
        current.count429 += 1;
      }
      accountStatsMap.set(accountName, current);
    }

    const last1hAccounts = Array.from(accountStatsMap.entries()).map(([name, data]) => ({
      name,
      count429: data.count429,
      total: data.total,
      rate: data.total > 0 ? (data.count429 / data.total) * 100 : 0,
    }));

    const metrics: MonitorMetrics = {
      timestamp: now.toISOString(),
      last1h: {
        total429,
        totalRequests,
        errorRate: Math.round(errorRate * 10) / 10,
        averageLatency,
        accounts: last1hAccounts,
      },
      accounts: accounts.map((acc) => ({
        name: acc.name,
        email: acc.email,
        status: acc.status || 'unknown',
        quotaStatus: acc.quotaStatus || 'unknown',
        quotaResetAt: acc.quotaResetAt?.toISOString() ?? null,
        leaseUntil: acc.leases[0]?.leaseUntil.toISOString() ?? null,
      })),
      alert: {
        triggered: false,
        threshold: 20, // 20% error rate trigger
      },
    };

    // Alert: High error rate (above 20%) in last hour
    if (errorRate > 20 && totalRequests >= 5) {
      metrics.alert.triggered = true;
      metrics.alert.reason = `Global error rate in last hour is high: ${Math.round(errorRate)}% (${totalErrors}/${totalRequests} requests)`;
    }

    // Alert: All accounts exhausted
    const primaryAccounts = accounts.filter((a) => a.id !== 'fallback-ai-studio');
    const activeAccounts = primaryAccounts.filter(
      (a) => a.status === 'active' && a.quotaStatus !== 'exhausted'
    );
    if (primaryAccounts.length > 0 && activeAccounts.length === 0) {
      metrics.alert.triggered = true;
      metrics.alert.reason = `All ${primaryAccounts.length} primary account(s) are exhausted or invalid`;
    }

    // Alert: Invalid accounts needing login
    const invalidCount = accounts.filter((a) => a.status === 'invalid').length;
    if (invalidCount > 0) {
      metrics.alert.triggered = true;
      metrics.alert.reason = `${invalidCount} account(s) have invalid credentials and require update`;
    }

    return NextResponse.json(metrics);
  } catch (error) {
    console.error('Error fetching metrics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch metrics' },
      { status: 500 }
    );
  }
}
