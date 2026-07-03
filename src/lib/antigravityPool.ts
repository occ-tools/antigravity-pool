/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Account } from '@prisma/client';
import { ProxyAgent, fetch } from 'undici';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  DEFAULT_MODEL_ID,
  HEALTH_CHECK_MODEL_ID,
  MODEL_METADATA,
  PUBLIC_MODEL_IDS,
  isPublicModelId,
  type PublicModelId,
} from '@/lib/modelCatalog';

const execAsync = promisify(exec);

export {
  DEFAULT_MODEL_ID,
  HEALTH_CHECK_MODEL_ID,
  MODEL_METADATA,
  PUBLIC_MODEL_IDS,
  isPublicModelId,
  type PublicModelId,
};

// Load proxy settings from environment
const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const proxyAgent: ProxyAgent | undefined = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

/**
 * Wraps global fetch with optional proxy dispatcher, avoiding `as any` casts.
 * Accepts the same arguments as standard fetch.
 */
function pooledFetch(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1] & { dispatcher?: ProxyAgent }) {
  if (proxyAgent) {
    return fetch(url, { ...init, dispatcher: proxyAgent } as any);
  }
  return fetch(url, init);
}

// Google Cloud Code companion Client ID and Secret (loaded from env)
export const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  if (typeof window === 'undefined') {
    if (process.env.NEXT_PHASE !== 'phase-production-build') {
      console.warn('[Antigravity Pool] Warning: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in environment variables.');
    }
  }
}

function positiveIntegerEnv(name: string, fallback: number, min = 1) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (Number.isInteger(value) && value >= min) return value;

  if (typeof window === 'undefined') {
    console.warn(`[Antigravity Pool] Ignoring invalid ${name}=${raw}; using ${fallback}.`);
  }
  return fallback;
}

// Timeouts and slot controls
export const ANTIGRAVITY_TIMEOUT_MS = positiveIntegerEnv('ANTIGRAVITY_POOL_TIMEOUT_MS', 120_000, 1_000);
export const ACCOUNT_LEASE_MS = positiveIntegerEnv('ANTIGRAVITY_POOL_ACCOUNT_LEASE_MS', 180_000, 1_000);
export const ACCOUNT_ACQUIRE_TIMEOUT_MS = positiveIntegerEnv('ANTIGRAVITY_POOL_ACQUIRE_TIMEOUT_MS', 15_000, 100);
export const ACCOUNT_ACQUIRE_POLL_MS = positiveIntegerEnv('ANTIGRAVITY_POOL_ACQUIRE_POLL_MS', 100, 10);
export const ACCOUNT_SLOTS_PER_ACCOUNT = positiveIntegerEnv('ANTIGRAVITY_POOL_SLOTS_PER_ACCOUNT', 3);
export const ACCOUNT_GLOBAL_SLOTS = positiveIntegerEnv('ANTIGRAVITY_POOL_GLOBAL_SLOTS', 12);

export type AccountStatus = 'active' | 'exhausted' | 'invalid';
export type QuotaStatus = 'available' | 'exhausted' | 'unknown';

export interface AntigravityResult {
  ok: boolean;
  text?: string;
  message?: string;
  accountStatus?: AccountStatus;
  emittedText?: boolean;
}

// Model mapping for converting standard OpenAI-compatible requests to Google's daily companion models
export const MODEL_MAP: Record<string, string> = {
  'gemini-3.1-pro-high': 'gemini-3.1-pro-high',
  'gemini-3.1-pro-medium': 'gemini-3.1-pro-medium',
  'gemini-3.1-pro-low': 'gemini-3.1-pro-low',
  'gemini-3.5-flash-high': 'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-low',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',

  // Fallbacks
  'gemini-1.5-flash': 'gemini-3.5-flash-low',
  'gemini-1.5-pro': 'gemini-3.1-pro-high',
  'claude-3-5-sonnet': 'claude-sonnet-4-6',
  'claude-3-5-sonnet-v2': 'claude-sonnet-4-6',
  'claude-3-5-haiku': 'gemini-3.5-flash-low',
  'claude-3-opus': 'claude-opus-4-6-thinking',
  'gpt-4o-mini': 'gemini-3.5-flash-low',
  'gpt-4o': 'gemini-3.1-pro-high',
  'gpt-4': 'gemini-3.1-pro-high',
  'o1-mini': 'gemini-3.5-flash-low',
  'o1-preview': 'gemini-3.1-pro-high',
};

export function getModelOwner(modelId: string) {
  return modelId.startsWith('claude-') ? 'anthropic-vertex' : 'google-daily-preview';
}

const MODEL_MAP_ENTRIES = Object.entries(MODEL_MAP)
  .sort(([a], [b]) => b.length - a.length);

export function getTargetModel(modelName: string): string {
  const normalized = modelName.toLowerCase();
  for (const [key, val] of MODEL_MAP_ENTRIES) {
    if (normalized.includes(key.toLowerCase())) {
      return val;
    }
  }
  return DEFAULT_MODEL_ID;
}

// Global Memory Cache for Access Tokens to prevent hitting refresh endpoints constantly
interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}
const tokenCache = new Map<string, CachedToken>();
const tokenCacheCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, token] of tokenCache) {
    if (token.expiresAt <= now) tokenCache.delete(key);
  }
}, 60_000);
// Allow cleanup to not keep the process alive
if (tokenCacheCleanupInterval.unref) tokenCacheCleanupInterval.unref();

export function evictTokenCache(accountId: string) {
  tokenCache.delete(accountId);
}

export function clearTokenCache() {
  tokenCache.clear();
}

function createTimeoutSignal(parentSignal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };

  if (parentSignal?.aborted) {
    onAbort();
  } else {
    parentSignal?.addEventListener('abort', onAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ANTIGRAVITY_TIMEOUT_MS);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Performs OAuth direct refresh token grant flow
 */
export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured before refreshing OAuth tokens.');
  }

  const res = await pooledFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }

  if (!res.ok) {
    throw new Error(`Google OAuth refresh failed: ${JSON.stringify(data)}`);
  }
  return {
    access_token: data.access_token,
    expires_in: data.expires_in || 3600,
  };
}

/**
 * Decodes email info from Google API userinfo endpoint
 */
export async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await pooledFetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch user info: ${JSON.stringify(data)}`);
  }
  if (!data.email) {
    throw new Error('Email not found in userinfo response');
  }
  return data.email;
}

/**
 * Resolves access token from memory cache or refreshes via OAuth
 */
const refreshPromises = new Map<string, Promise<string>>();

export async function getOrRefreshAccessToken(accountId: string, refreshToken: string): Promise<string> {
  const cached = tokenCache.get(accountId);
  const now = Date.now();
  // Reuse token if it has at least 5 minutes of life left
  if (cached && cached.expiresAt > now + 300_000) {
    return cached.accessToken;
  }

  // Deduplicate concurrent token refresh promises for the same account
  let promise = refreshPromises.get(accountId);
  if (!promise) {
    promise = (async () => {
      try {
        const { access_token, expires_in } = await refreshAccessToken(refreshToken);
        tokenCache.set(accountId, {
          accessToken: access_token,
          expiresAt: Date.now() + (expires_in * 1000),
        });
        return access_token;
      } finally {
        refreshPromises.delete(accountId);
      }
    })();
    refreshPromises.set(accountId, promise);
  }

  return promise;
}

/**
 * Pulls local active user credential from Windows Credential Manager
 */
export async function getWindowsCredential(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execAsync('powershell -NoProfile -ExecutionPolicy Bypass -File scripts/get-credential.ps1');
    const trimmed = stdout.trim();
    if (trimmed && trimmed.startsWith('{')) {
      return trimmed;
    }
  } catch (err) {
    console.error('Failed to read Windows credential via PowerShell script:', err);
  }
  return null;
}

/**
 * Error categorizer
 */
export function classifyAccountStatus(statusCode: number, message: string): AccountStatus | undefined {
  if (statusCode === 429) return 'exhausted';
  if (statusCode === 401 || statusCode === 403) return 'invalid';

  const lower = message.toLowerCase();
  if (
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('usage limit') ||
    lower.includes('limit exceeded') ||
    lower.includes('429')
  ) {
    return 'exhausted';
  }
  if (
    lower.includes('unauthorized') ||
    lower.includes('invalid_grant') ||
    lower.includes('refresh token expired') ||
    lower.includes('permission denied') ||
    lower.includes('403') ||
    lower.includes('401')
  ) {
    return 'invalid';
  }
  return undefined;
}

function relativeResetAt(message: string, now: Date): Date | null {
  const lower = message.toLowerCase();
  const patterns: Array<[RegExp, number]> = [
    [/(?:try again|retry|reset|available)[^\d]{0,40}(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/, 60 * 60 * 1000],
    [/(?:try again|retry|reset|available)[^\d]{0,40}(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/, 60 * 1000],
    [/(?:try again|retry|reset|available)[^\d]{0,40}(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/, 1000],
    [/retry-after[^\d]{0,20}(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?\b/, 1000],
  ];

  for (const [pattern, multiplier] of patterns) {
    const match = lower.match(pattern);
    if (match?.[1]) {
      return new Date(now.getTime() + Number(match[1]) * multiplier);
    }
  }
  return null;
}

export function quotaObservationForSuccess(now = new Date()) {
  return {
    quotaStatus: 'available' as QuotaStatus,
    quotaResetAt: null,
    quotaMessage: null,
    quotaCheckedAt: now,
  };
}

export function quotaObservationForFailure(statusCode: number, message: string, now = new Date()) {
  const status = classifyAccountStatus(statusCode, message);
  const exhausted = status === 'exhausted';

  return {
    quotaStatus: (exhausted ? 'exhausted' : 'unknown') as QuotaStatus,
    quotaResetAt: exhausted ? relativeResetAt(message, now) : null,
    quotaMessage: message.slice(0, 500),
    quotaCheckedAt: now,
  };
}

export interface AntigravityOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

/**
 * Executes direct stream call using modern global fetch with undici ProxyAgent
 */
export async function runAntigravityStream(
  account: Account,
  modelName: string,
  promptText: string,
  onText?: (text: string) => void,
  signal?: AbortSignal,
  options?: AntigravityOptions
): Promise<AntigravityResult> {
  let accessToken: string;
  try {
    accessToken = await getOrRefreshAccessToken(account.id, account.refreshToken);
  } catch (err: any) {
    console.error(`[OAuth Refresh Error - Account ${account.name}]:`, err.message);
    return { ok: false, message: err.message, accountStatus: 'invalid' };
  }

  const targetModel = getTargetModel(modelName);
  const body: any = {
    model: targetModel,
    request: {
      contents: [
        {
          role: 'user',
          parts: [{ text: promptText }]
        }
      ]
    }
  };

  if (options) {
    const genConfig: any = {};
    if (typeof options.temperature === 'number') {
      genConfig.temperature = options.temperature;
    }
    if (typeof options.maxTokens === 'number') {
      genConfig.maxOutputTokens = options.maxTokens;
    }
    if (Array.isArray(options.stop) && options.stop.length > 0) {
      genConfig.stopSequences = options.stop;
    }
    if (Object.keys(genConfig).length > 0) {
      body.request.generationConfig = genConfig;
    }
  }

  let responseText = '';
  let emittedText = false;

  const timeoutSignal = createTimeoutSignal(signal);
  try {
    const response = await pooledFetch('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity',
      },
      body: JSON.stringify(body),
      signal: timeoutSignal.signal,
      });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[API Error - Account ${account.name}]: ${response.status} - ${errText}`);
      return {
        ok: false,
        message: errText,
        accountStatus: classifyAccountStatus(response.status, errText),
        emittedText
      };
    }

    if (!response.body) {
      return { ok: false, message: 'Upstream returned an empty response body', emittedText };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let partialLine = '';

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) return;

      const jsonStr = trimmed.substring(6).trim();
      if (jsonStr === '[DONE]') return;

      try {
        const data = JSON.parse(jsonStr);
        const candidates = data?.response?.candidates;
        if (Array.isArray(candidates) && candidates.length > 0) {
          const parts = candidates[0]?.content?.parts;
          if (Array.isArray(parts) && parts.length > 0) {
            const text = parts[0]?.text || '';
            if (text) {
              responseText += text;
              emittedText = true;
              if (onText) onText(text);
            }
          }
        }
      } catch (err) {
        console.error('Failed to parse SSE JSON chunk:', jsonStr, err);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = (partialLine + chunk).split('\n');
      partialLine = lines.pop() || '';

      for (const line of lines) {
        handleLine(line);
      }
    }

    if (partialLine) handleLine(partialLine);

    return { ok: true, text: responseText, emittedText };
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return { ok: false, message: timeoutSignal.timedOut ? `Request timed out after ${ANTIGRAVITY_TIMEOUT_MS}ms` : 'Request aborted', emittedText };
    }
    console.error(`[Request Exception - Account ${account.name}]:`, error.message);
    return { ok: false, message: error.message, accountStatus: classifyAccountStatus(502, error.message), emittedText };
  } finally {
    timeoutSignal.cleanup();
  }
}

/**
 * Fallback executor for Google AI Studio API using paid/gift credits (via API Key)
 */
export async function runAIStudioStream(
  apiKey: string,
  modelName: string,
  promptText: string,
  onText?: (text: string) => void,
  signal?: AbortSignal,
  options?: AntigravityOptions
): Promise<AntigravityResult> {
  // Map Google companion models to official AI Studio models
  let targetModel = getTargetModel(modelName);
  if (targetModel.startsWith('gemini-3.5-flash')) {
    targetModel = 'gemini-2.5-flash';
  } else if (targetModel.startsWith('gemini-3.1-pro') || targetModel.startsWith('claude-')) {
    targetModel = 'gemini-2.5-pro';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const body: any = {
    contents: [
      {
        role: 'user',
        parts: [{ text: promptText }]
      }
    ]
  };

  if (options) {
    const genConfig: any = {};
    if (typeof options.temperature === 'number') {
      genConfig.temperature = options.temperature;
    }
    if (typeof options.maxTokens === 'number') {
      genConfig.maxOutputTokens = options.maxTokens;
    }
    if (Array.isArray(options.stop) && options.stop.length > 0) {
      genConfig.stopSequences = options.stop;
    }
    if (Object.keys(genConfig).length > 0) {
      body.generationConfig = genConfig;
    }
  }

  let responseText = '';
  let emittedText = false;

  const timeoutSignal = createTimeoutSignal(signal);
  try {
    const response = await pooledFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity',
      },
      body: JSON.stringify(body),
      signal: timeoutSignal.signal,
      });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[AI Studio Fallback Error]: ${response.status} - ${errText}`);
      return {
        ok: false,
        message: errText,
        emittedText
      };
    }

    if (!response.body) {
      return { ok: false, message: 'AI Studio returned an empty response body', emittedText };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let partialLine = '';

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) return;

      const jsonStr = trimmed.substring(6).trim();
      if (jsonStr === '[DONE]') return;

      try {
        const data = JSON.parse(jsonStr);
        const candidates = data?.candidates || data?.response?.candidates;
        if (Array.isArray(candidates) && candidates.length > 0) {
          const parts = candidates[0]?.content?.parts;
          if (Array.isArray(parts) && parts.length > 0) {
            const text = parts[0]?.text || '';
            if (text) {
              responseText += text;
              emittedText = true;
              if (onText) onText(text);
            }
          }
        }
      } catch (err) {
        console.error('Failed to parse AI Studio SSE JSON chunk:', jsonStr, err);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = (partialLine + chunk).split('\n');
      partialLine = lines.pop() || '';

      for (const line of lines) {
        handleLine(line);
      }
    }

    if (partialLine) handleLine(partialLine);

    return { ok: true, text: responseText, emittedText };
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return { ok: false, message: timeoutSignal.timedOut ? `Request timed out after ${ANTIGRAVITY_TIMEOUT_MS}ms` : 'Request aborted', emittedText };
    }
    console.error(`[AI Studio Exception]:`, error.message);
    return { ok: false, message: error.message, emittedText };
  } finally {
    timeoutSignal.cleanup();
  }
}
