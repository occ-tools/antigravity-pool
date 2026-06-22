import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const LOCALHOST_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '[::]',
]);

function isLocalhost(req: NextRequest): boolean {
  try {
    const hostname = req.nextUrl.hostname;
    const clientIp = (req as any).ip || req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '';
    const isLocalIp = !clientIp || clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
    return LOCALHOST_HOSTNAMES.has(hostname) && isLocalIp;
  } catch {
    return true;
  }
}

export function proxy(req: NextRequest) {
  // Only intercept /api/admin requests
  if (req.nextUrl.pathname.startsWith('/api/admin')) {
    // Unconditional localhost bypass for local developer convenience
    if (isLocalhost(req)) return NextResponse.next();

    const token = process.env.ADMIN_TOKEN;
    if (!token) {
      return NextResponse.json(
        { error: 'Set ADMIN_TOKEN environment variable to enable remote admin access' },
        { status: 401 }
      );
    }

    const auth = req.headers.get('authorization') || '';
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    const headerToken = req.headers.get('x-antigravity-pool-token') || req.headers.get('x-codex-pool-token') || '';

    if (bearer === token || headerToken === token) {
      return NextResponse.next();
    }

    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/admin/:path*'],
};
