/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/adminAuth';
import { getWindowsCredential, fetchUserEmail, refreshAccessToken } from '@/lib/antigravityPool';

function stringFromCredential(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getCredentialEmail(credData: any): string | null {
  const candidates = [
    credData?.email,
    credData?.account?.email,
    credData?.token?.email,
    credData?.user?.email,
  ];
  const email = candidates.map(stringFromCredential).find((candidate) => candidate.includes('@'));
  return email || null;
}

function getCredentialAccessToken(credData: any): string {
  return stringFromCredential(credData?.token?.access_token);
}

export async function POST(req: Request) {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;

  try {
    console.log('Attempting to import active Windows credentials...');
    const credJsonStr = await getWindowsCredential();
    if (!credJsonStr) {
      return NextResponse.json(
        { error: '未在 Windows 凭据管理器中找到 "gemini:antigravity" 凭据。请确保您已登录。' },
        { status: 404 }
      );
    }

    let credData: any;
    try {
      credData = JSON.parse(credJsonStr);
    } catch {
      return NextResponse.json(
        { error: '解析凭据 JSON 失败。' },
        { status: 500 }
      );
    }

    const refreshToken = credData?.token?.refresh_token;
    if (!refreshToken) {
      return NextResponse.json(
        { error: '凭据中未找到 refresh_token。' },
        { status: 400 }
      );
    }

    let email = getCredentialEmail(credData);
    let refreshError: string | null = null;

    const localAccessToken = getCredentialAccessToken(credData);
    if (!email && localAccessToken) {
      try {
        email = await fetchUserEmail(localAccessToken);
      } catch (emailErr) {
        const message = emailErr instanceof Error ? emailErr.message : '无法读取本地 access token 对应邮箱';
        console.warn('Failed to resolve email from local access token:', message);
      }
    }

    try {
      const refreshed = await refreshAccessToken(refreshToken);
      email = await fetchUserEmail(refreshed.access_token);
    } catch (err) {
      refreshError = err instanceof Error ? err.message : '无法刷新本地凭据';
      console.warn('Imported local credential without OAuth refresh:', refreshError);
    }

    // Check if account already exists
    const existing = await prisma.account.findFirst({
      where: { refreshToken },
    });

    if (existing) {
      const resolvedEmail = email || existing.email;
      const updated = await prisma.account.update({
        where: { id: existing.id },
        data: {
          name: resolvedEmail || existing.name,
          email: resolvedEmail,
          status: 'active',
          quotaStatus: 'unknown',
          quotaResetAt: null,
          quotaMessage: null,
          quotaCheckedAt: null,
        },
      });

      return NextResponse.json({
        success: true,
        message: refreshError
          ? '本地 Active 凭据已导入；配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET 后可执行自检与刷新。'
          : '凭据已存在，已刷新账号状态',
        healthCheckAvailable: !refreshError,
        account: {
          id: updated.id,
          name: updated.name,
          email: updated.email,
          status: updated.status,
        }
      });
    }

    // Create new account entry
    const name = email || 'Imported Keyring Account';
    const account = await prisma.account.create({
      data: {
        name,
        email,
        refreshToken,
        status: 'active',
      }
    });

    return NextResponse.json({
      success: true,
      message: refreshError
        ? '本地 Active 凭据已导入；配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET 后可执行自检与刷新。'
        : '凭据成功导入！',
      healthCheckAvailable: !refreshError,
      account: {
        id: account.id,
        name: account.name,
        email: account.email,
        status: account.status,
      }
    });
  } catch (error) {
    console.error('Failed to import local credential:', error);
    const message = error instanceof Error ? error.message : 'Import failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
