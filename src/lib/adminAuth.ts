import { NextResponse } from 'next/server';

const LOCALHOST_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '[::]',
]);

const LOOPBACK_IPS = new Set([
  '',
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

type AdminRequestOptions = {
  hostname?: string;
  clientIp?: string;
};

function firstClientIp(value: string) {
  return value.split(',')[0]?.trim() ?? '';
}

export function isLocalhost(req: Request, options: AdminRequestOptions = {}): boolean {
  try {
    const url = new URL(req.url);
    const hostname = options.hostname ?? url.hostname;
    const rawClientIp = options.clientIp ?? req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '';
    const clientIp = firstClientIp(rawClientIp);
    return LOCALHOST_HOSTNAMES.has(hostname) && LOOPBACK_IPS.has(clientIp);
  } catch {
    return false;
  }
}

function getProvidedAdminTokens(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const headerToken = (
    req.headers.get('x-antigravity-pool-token') ??
    req.headers.get('x-codex-pool-token') ??
    ''
  ).trim();

  return [bearer, headerToken].filter(Boolean);
}

export function requireAdmin(req: Request, options: AdminRequestOptions = {}): NextResponse | null {
  // Unconditional localhost bypass for local developer convenience
  if (isLocalhost(req, options)) return null;

  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: 'Set ADMIN_TOKEN to enable remote admin access' },
      { status: 401 }
    );
  }

  if (getProvidedAdminTokens(req).some((providedToken) => providedToken === token)) return null;

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
