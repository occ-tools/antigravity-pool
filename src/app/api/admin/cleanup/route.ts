import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';

export async function POST(req: Request) {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;

  try {
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, ['scripts/clean-cache.js'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });

    child.unref();

    return NextResponse.json(
      {
        status: 'cleanup_started',
        message: 'Cache cleanup script initiated.',
        startedAt: new Date().toISOString(),
      },
      { status: 202 } // 202 Accepted (async operation)
    );
  } catch (error) {
    console.error('Cleanup error:', error);
    return NextResponse.json(
      { error: 'Failed to start cleanup', details: String(error) },
      { status: 500 }
    );
  }
}
