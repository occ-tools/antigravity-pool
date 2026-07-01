import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';

type RequestWithOptionalIp = NextRequest & { ip?: string };

function requestClientIp(req: NextRequest) {
  return (req as RequestWithOptionalIp).ip ?? req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '';
}

export function proxy(req: NextRequest) {
  // Only intercept /api/admin requests
  if (req.nextUrl.pathname.startsWith('/api/admin')) {
    const unauthorized = requireAdmin(req, {
      hostname: req.nextUrl.hostname,
      clientIp: requestClientIp(req),
    });
    if (unauthorized) return unauthorized;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/admin/:path*'],
};
