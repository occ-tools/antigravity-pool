import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Configure SQLite for concurrency and auto-seed (server-side only)
if (typeof window === 'undefined') {
  (async () => {
    try {
      await prisma.$connect();
      await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
      await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000;');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[Prisma] Failed to configure SQLite:', message);
    }

    try {
      const count = await prisma.account.count();
      if (count === 0) {
        console.log('[Antigravity Pool] Database is empty. Attempting auto-seeding from local keyring...');
        try {
          const { getWindowsCredential, fetchUserEmail, refreshAccessToken } = await import('./antigravityPool');
          const credJsonStr = await getWindowsCredential();
          if (credJsonStr) {
            const credData = JSON.parse(credJsonStr);
            const refreshToken = credData?.token?.refresh_token;
            if (refreshToken) {
              let email = 'unknown@gmail.com';
              try {
                const { access_token } = await refreshAccessToken(refreshToken);
                email = await fetchUserEmail(access_token);
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.warn('[Antigravity Pool] Auto-seed userinfo resolve failed:', message);
              }
              const name = email !== 'unknown@gmail.com' ? `Keyring Account (${email.split('@')[0]})` : 'Imported Keyring Account';
              await prisma.account.create({
                data: { name, email, refreshToken, status: 'active' }
              });
              console.log(`[Antigravity Pool] ✅ Auto-seeded active account successfully: ${email}`);
            }
          } else {
            console.log('[Antigravity Pool] No active keyring credentials found to auto-seed.');
          }
        } catch (err) {
          console.error('[Antigravity Pool] Failed to auto-seed database:', err);
        }
      }
    } catch (err) {
      console.error('[Antigravity Pool] Database count query failed:', err);
    }
  })();
}
