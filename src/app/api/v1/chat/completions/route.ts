/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Account, AccountLease } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  quotaObservationForFailure,
  quotaObservationForSuccess,
  runAntigravityStream,
  runAIStudioStream,
  getTargetModel,
  classifyAccountStatus,
  ACCOUNT_LEASE_MS,
  ACCOUNT_ACQUIRE_TIMEOUT_MS,
  ACCOUNT_ACQUIRE_POLL_MS,
  ACCOUNT_SLOTS_PER_ACCOUNT,
  ACCOUNT_GLOBAL_SLOTS,
  DEFAULT_MODEL_ID,
  MODEL_METADATA,
  isPublicModelId,
  type AntigravityOptions,
} from '@/lib/antigravityPool';

type ContentPart = {
  type?: string;
  text?: string;
  image_url?: unknown;
};

type ToolCall = {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
};

type ChatMessage = {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type FunctionTool = {
  type?: 'function';
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
};

type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | {
      type?: 'function';
      function?: { name?: string };
    };

type ChatCompletionRequest = {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  tools?: FunctionTool[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  temperature?: number;
  max_tokens?: number;
  response_format?: unknown;
  stop?: string | string[];
};

type ParsedToolCall = {
  name: string;
  arguments: unknown;
};

type ParsedAssistantOutput =
  | { kind: 'message'; content: string }
  | { kind: 'tool_calls'; calls: ParsedToolCall[] };

type PromptAttemptResult = {
  result: { ok: boolean; text?: string; message?: string; accountStatus?: string };
  account?: Account;
};

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const typed = part as ContentPart;
          if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
          if (typed.type === 'image_url') return '[image input omitted by proxy]';
        }
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(content);
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizedTools(body: ChatCompletionRequest) {
  return Array.isArray(body.tools)
    ? body.tools.filter((tool) => tool.type === 'function' && typeof tool.function?.name === 'string' && tool.function.name.length > 0)
    : [];
}

function serializeTool(tool: FunctionTool) {
  return {
    type: 'function',
    function: {
      name: tool.function?.name ?? '',
      description: tool.function?.description ?? '',
      parameters: tool.function?.parameters ?? { type: 'object', properties: {} },
    },
  };
}

function toolChoiceInstruction(toolChoice: ToolChoice | undefined): string {
  if (!toolChoice || toolChoice === 'auto') return 'Call a tool only when it is needed. Otherwise answer normally.';
  if (toolChoice === 'none') return 'Do not call tools. Answer normally using the information already available.';
  if (toolChoice === 'required') return 'You must call at least one tool before giving a final answer.';
  const name = toolChoice.function?.name;
  if (name) return `You must call the function named "${name}".`;
  return 'Call a tool only when it is needed. Otherwise answer normally.';
}

function toolProtocolPrompt(tools: FunctionTool[], body: ChatCompletionRequest): string {
  if (!tools.length) return '';

  return [
    'You are behind a proxy that converts your text into OpenAI-compatible tool calls.',
    'The client cannot execute tools unless you emit the exact bridge protocol below.',
    'Do not claim that you ran a command, inspected files, opened a browser, or checked live state unless you called a provided tool.',
    'Available tools are listed as JSON below. Use only these tool names and argument schemas.',
    '<tools>',
    JSON.stringify(tools.map(serializeTool), null, 2),
    '</tools>',
    toolChoiceInstruction(body.tool_choice),
    body.parallel_tool_calls === false
      ? 'Call at most one tool in this turn.'
      : 'You may call multiple tools if that is required.',
    'When a tool call is needed, output exactly one XML block and nothing else:',
    '<codex_pool_tool_calls>[{"name":"tool_name","arguments":{"key":"value"}}]</codex_pool_tool_calls>',
    'The arguments value must be a JSON object. Use an empty object when the tool has no arguments.',
    'After the client returns tool results in later messages, use those results to continue or answer.',
    'When you have enough information to answer the user, do not emit the XML block; answer normally.',
  ].join('\n');
}

function responseFormatInstruction(responseFormat: unknown): string {
  if (!responseFormat || typeof responseFormat !== 'object') return '';

  const format = responseFormat as { type?: unknown; json_schema?: unknown };
  if (format.type === 'json_object') {
    return 'The client requested JSON mode. Return exactly one valid JSON object and no surrounding prose or markdown.';
  }

  if (format.type === 'json_schema') {
    const schema = safeStringify(format.json_schema ?? {});
    return [
      'The client requested structured JSON output.',
      'Return exactly one JSON value that conforms to this schema metadata, with no surrounding prose or markdown:',
      schema,
    ].join('\n');
  }

  return '';
}

function formatMessage(message: ChatMessage): string {
  const role = message.role ?? 'user';
  if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return [
      'assistant tool_calls:',
      safeStringify(message.tool_calls.map((call) => ({
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments,
      }))),
    ].join('\n');
  }

  if (role === 'tool') {
    return [
      `tool result for ${message.name ?? message.tool_call_id ?? 'unknown'}:`,
      contentToText(message.content),
    ].join('\n');
  }

  const name = message.name ? ` (${message.name})` : '';
  return `${role}${name}: ${contentToText(message.content)}`;
}

function buildPrompt(body: ChatCompletionRequest): string {
  const messages = body.messages ?? [];
  const tools = normalizedTools(body);
  const parts = [
    toolProtocolPrompt(tools, body),
    responseFormatInstruction(body.response_format),
    ...messages.map(formatMessage),
  ].filter(Boolean);
  return parts.join('\n\n');
}

function normalizeArguments(value: unknown): unknown {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
    } catch {
      return { value };
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return { value };
}

function extractToolJson(text: string): string {
  const trimmed = text.trim();
  const tagged = trimmed.match(/<codex_pool_tool_calls>([\s\S]*?)<\/codex_pool_tool_calls>/i);
  if (tagged?.[1]) return tagged[1].trim();
  return '';
}

function parseRawToolCalls(value: unknown[] | object | string): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;

  const obj = value as { tool_calls?: unknown; calls?: unknown; name?: unknown; function?: unknown; tool_call?: unknown };
  if (Array.isArray(obj.tool_calls)) return obj.tool_calls;
  if (Array.isArray(obj.calls)) return obj.calls;
  if (obj.tool_call) return parseRawToolCalls(obj.tool_call as any);
  if (typeof obj.name === 'string' || obj.function) return [obj];
  return null;
}

function parseAssistantOutput(text: string, allowedToolNames: Set<string>): ParsedAssistantOutput {
  const candidate = extractToolJson(text);
  if (!candidate) return { kind: 'message', content: text };

  try {
    const rawCalls = parseRawToolCalls(JSON.parse(candidate));
    if (!rawCalls) return { kind: 'message', content: text };

    const calls = rawCalls
      .map((raw) => {
        if (!raw || typeof raw !== 'object') return null;
        const obj = raw as { name?: unknown; function?: { name?: unknown; arguments?: unknown }; arguments?: unknown; input?: unknown; parameters?: unknown };
        const name = typeof obj.name === 'string' ? obj.name : typeof obj.function?.name === 'string' ? obj.function.name : '';
        if (!name || !allowedToolNames.has(name)) return null;
        const args = obj.arguments ?? obj.function?.arguments ?? obj.input ?? obj.parameters ?? {};
        return { name, arguments: normalizeArguments(args) };
      })
      .filter((call): call is ParsedToolCall => call !== null);

    if (calls.length > 0) return { kind: 'tool_calls', calls };
  } catch {
    return { kind: 'message', content: text };
  }

  return { kind: 'message', content: text };
}

function toOpenAIToolCalls(calls: ParsedToolCall[]) {
  const base = Date.now().toString(36);
  return calls.map((call, index) => ({
    id: `call_${base}_${index}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  }));
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function usage(promptText: string, output: ParsedAssistantOutput) {
  const completionText = output.kind === 'tool_calls' ? safeStringify(output.calls) : output.content;
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function textUsage(promptText: string, completionText: string) {
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function statusCodeForAccountStatus(status?: string) {
  if (status === 'exhausted') return 429;
  if (status === 'invalid') return 401;
  return 502;
}

function errorTypeForStatus(status: number) {
  if (status === 429) return 'insufficient_quota';
  if (status === 401 || status === 403) return 'invalid_request_error';
  return 'proxy_error';
}

function maxOutputTokensForModel(modelName: string) {
  const targetModel = getTargetModel(modelName);
  return isPublicModelId(targetModel) ? MODEL_METADATA[targetModel].maxOutputTokens : undefined;
}

function normalizeMaxTokens(modelName: string, maxTokens?: number) {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) return undefined;
  const normalized = Math.max(1, Math.floor(maxTokens));
  const modelLimit = maxOutputTokensForModel(modelName);
  return modelLimit ? Math.min(normalized, modelLimit) : normalized;
}

async function logRequest(accountId: string, model: string, statusCode: number, latency: number, promptTokens: number, completionTokens: number, error?: string) {
  try {
    await prisma.requestLog.create({
      data: {
        accountId,
        model,
        statusCode,
        latency,
        promptTokens,
        completionTokens,
        error: error || null,
      }
    });
  } catch (err) {
    console.error('Failed to log request metrics:', err);
  }
}

async function ensureFallbackAccount() {
  try {
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
  } catch (err) {
    console.error('Failed to ensure fallback account exists:', err);
  }
}

function completionResponse(output: ParsedAssistantOutput, model: string, promptText: string) {
  const created = Math.floor(Date.now() / 1000);
  if (output.kind === 'tool_calls') {
    return NextResponse.json({
      id: `chatcmpl-${created}`,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: toOpenAIToolCalls(output.calls) },
        finish_reason: 'tool_calls',
      }],
      usage: usage(promptText, output),
    });
  }

  return NextResponse.json({
    id: `chatcmpl-${created}`,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: output.content }, finish_reason: 'stop' }],
    usage: usage(promptText, output),
  });
}

function sseChunk(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Shared SSE streaming context — eliminates duplicate keepAlive, sendRole, sendStop/Usage patterns */
function createSSEContext(controller: ReadableStreamDefaultController, responseId: string, created: number, model: string) {
  const encoder = new TextEncoder();
  let closed = false;

  const send = (data: unknown) => {
    if (!closed) controller.enqueue(encoder.encode(sseChunk(data)));
  };

  const closeWithDone = () => {
    if (closed) return;
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
    closed = true;
  };

  const keepAlive = setInterval(() => {
    if (!closed) controller.enqueue(encoder.encode(': keep-alive\n\n'));
  }, 10_000);

  let sentRole = false;
  const sendRole = () => {
    if (sentRole) return;
    sentRole = true;
    send({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  };

  const sendStop = (finishReason: string) => {
    send({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  };

  const sendUsage = (data: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => {
    send({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [], usage: data });
  };

  const sendContent = (text: string) => {
    sendRole();
    send({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  };

  const sendToolCall = (toolCall: { id: string; type: string; function: { name: string; arguments: string } }, index: number) => {
    send({
      id: responseId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { tool_calls: [{ index, id: toolCall.id, type: 'function', function: toolCall.function }] }, finish_reason: null }],
    });
  };

  const sendError = (message: string) => {
    send({ error: { message, type: 'proxy_error' } });
  };

  return {
    send, closeWithDone,
    cleanup: () => { closed = true; clearInterval(keepAlive); },
    sendRole, sendStop, sendUsage, sendContent, sendToolCall, sendError,
    get sentRole() { return sentRole; },
  };
}

/** Result from a single account streaming attempt */
type AccountAttemptResult = {
  ok: boolean;
  account?: Account;
  text?: string;
  message: string;
  accountStatus?: string;
};

/**
 * Iterates accounts with slot-based leasing until one succeeds or all are exhausted.
 * Calls `onChunk(text)` for each chunk of streaming text (may be undefined for non-streaming).
 */
async function withAccountRetry(
  model: string,
  promptText: string,
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
  options?: AntigravityOptions,
): Promise<AccountAttemptResult> {
  const attemptedIds = new Set<string>();
  const startTime = Date.now();
  let lastMessage = 'No active accounts available in the pool.';

  while (true) {
    const claim = await acquireAccountClaim(attemptedIds, signal);
    if (!claim) break;

    attemptedIds.add(claim.account.id);

    try {
      const result = await runAntigravityStream(claim.account, model, promptText, onChunk, signal, options);
      const latency = Date.now() - startTime;

      if (result.ok) {
        await prisma.account.update({ where: { id: claim.account.id }, data: quotaObservationForSuccess() });
        await logRequest(claim.account.id, getTargetModel(model), 200, latency, estimateTokens(promptText), estimateTokens(result.text || ''));
        return { ok: true, account: claim.account, text: result.text, message: '', accountStatus: 'active' };
      }

      lastMessage = result.message || 'Unknown error';
      const code = statusCodeForAccountStatus(result.accountStatus);
      await markAccountFailure(claim.account, code, lastMessage);
      await logRequest(claim.account.id, getTargetModel(model), code, latency, estimateTokens(promptText), 0, lastMessage);

      if (result.emittedText) {
        return { ok: false, account: claim.account, message: lastMessage, accountStatus: result.accountStatus };
      }
    } finally {
      await releaseAccountClaim(claim);
    }
  }

  return { ok: false, message: lastMessage };
}

/**
 * Attempts a request via the AI Studio fallback (paid/gift API key).
 * Returns same shape as withAccountRetry.
 */
async function withFallbackStream(
  model: string,
  promptText: string,
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
  options?: AntigravityOptions,
): Promise<AccountAttemptResult> {
  const fallbackKey = process.env.FALLBACK_GEMINI_API_KEY;
  if (!fallbackKey) return { ok: false, message: 'No fallback API key configured' };

  const startTime = Date.now();
  const result = await runAIStudioStream(fallbackKey, model, promptText, onChunk, signal, options);
  const latency = Date.now() - startTime;
  await ensureFallbackAccount();

  if (result.ok) {
    await logRequest('fallback-ai-studio', getTargetModel(model), 200, latency, estimateTokens(promptText), estimateTokens(result.text || ''));
    return { ok: true, text: result.text, message: '', accountStatus: 'active' };
  }

  await logRequest('fallback-ai-studio', getTargetModel(model), 502, latency, estimateTokens(promptText), 0, result.message);
  return { ok: false, message: result.message || 'AI Studio fallback failed', accountStatus: result.accountStatus };
}

function streamBufferedOutput(promptText: string, model: string, allowedToolNames: Set<string>, signal: AbortSignal, options?: AntigravityOptions) {
  const created = Math.floor(Date.now() / 1000);
  const responseId = `chatcmpl-${created}`;

  const stream = new ReadableStream({
    async start(controller) {
      const { closeWithDone, cleanup, sendRole, sendStop, sendUsage, sendContent, sendToolCall, sendError } = createSSEContext(controller, responseId, created, model);

      try {
        const attemptedIds = new Set<string>();
        let lastMessage = 'No active accounts available in the pool.';
        const startTime = Date.now();
        let sentAnyText = false;

        while (true) {
          const claim = await acquireAccountClaim(attemptedIds, signal);
          if (!claim) break;

          attemptedIds.add(claim.account.id);
          let attemptSentText = false;

          let isBuffering = true;
          let bufferedText = '';
          const toolTag = '<codex_pool_tool_calls>';

          try {
            const result = await runAntigravityStream(claim.account, model, promptText, (text) => {
              if (isBuffering) {
                bufferedText += text;
                const lowerBuf = bufferedText.toLowerCase();

                if (lowerBuf.startsWith('<')) {
                  const prefix = toolTag.substring(0, lowerBuf.length);
                  if (lowerBuf !== prefix && !lowerBuf.startsWith(toolTag)) {
                    isBuffering = false;
                    sendRole();
                    attemptSentText = true;
                    sentAnyText = true;
                    sendContent(bufferedText);
                  }
                } else {
                  isBuffering = false;
                  sendRole();
                  attemptSentText = true;
                  sentAnyText = true;
                  sendContent(bufferedText);
                }
              } else {
                sendRole();
                attemptSentText = true;
                sentAnyText = true;
                sendContent(text);
              }
            }, signal, options);

            const latency = Date.now() - startTime;

            if (result.ok) {
              await prisma.account.update({ where: { id: claim.account.id }, data: quotaObservationForSuccess() });
              const finalResponseText = result.text || bufferedText;

              if (isBuffering) {
                const output = parseAssistantOutput(finalResponseText, allowedToolNames);
                if (output.kind === 'tool_calls') {
                  const toolCalls = toOpenAIToolCalls(output.calls);
                  sendRole();
                  toolCalls.forEach((toolCall, index) => sendToolCall(toolCall, index));
                  sendStop('tool_calls');
                  sendUsage(usage(promptText, output));
                } else {
                  sendRole();
                  sendContent(finalResponseText);
                  sendStop('stop');
                  sendUsage(usage(promptText, output));
                }
              } else {
                sendStop('stop');
                sendUsage(textUsage(promptText, finalResponseText));
              }

              await logRequest(claim.account.id, getTargetModel(model), 200, latency, estimateTokens(promptText), estimateTokens(finalResponseText));
              closeWithDone();
              return;
            }

            lastMessage = result.message || 'Unknown error';
            const code = statusCodeForAccountStatus(result.accountStatus);
            await markAccountFailure(claim.account, code, lastMessage);
            await logRequest(claim.account.id, getTargetModel(model), code, latency, estimateTokens(promptText), estimateTokens(bufferedText), lastMessage);

            if (attemptSentText) {
              sendError(lastMessage);
              closeWithDone();
              return;
            }
          } finally {
            await releaseAccountClaim(claim);
          }
        }

        // Fallback to AI Studio if key is configured
        const fallbackKey = process.env.FALLBACK_GEMINI_API_KEY;
        if (fallbackKey && !sentAnyText) {
          const latencyStart = Date.now();
          let isBuffering = true;
          let bufferedText = '';
          const toolTag = '<codex_pool_tool_calls>';

          const result = await runAIStudioStream(fallbackKey, model, promptText, (text) => {
            if (isBuffering) {
              bufferedText += text;
              const lowerBuf = bufferedText.toLowerCase();

              if (lowerBuf.startsWith('<')) {
                const prefix = toolTag.substring(0, lowerBuf.length);
                if (lowerBuf !== prefix && !lowerBuf.startsWith(toolTag)) {
                  isBuffering = false;
                  sendRole();
                  sentAnyText = true;
                  sendContent(bufferedText);
                }
              } else {
                isBuffering = false;
                sendRole();
                sentAnyText = true;
                sendContent(bufferedText);
              }
            } else {
              sendRole();
              sentAnyText = true;
              sendContent(text);
            }
          }, signal, options);

          const latency = Date.now() - latencyStart;
          if (result.ok) {
            await ensureFallbackAccount();
            const finalResponseText = result.text || bufferedText;

            if (isBuffering) {
              const output = parseAssistantOutput(finalResponseText, allowedToolNames);
              if (output.kind === 'tool_calls') {
                const toolCalls = toOpenAIToolCalls(output.calls);
                sendRole();
                toolCalls.forEach((toolCall, index) => sendToolCall(toolCall, index));
                sendStop('tool_calls');
                sendUsage(usage(promptText, output));
              } else {
                sendRole();
                sendContent(finalResponseText);
                sendStop('stop');
                sendUsage(usage(promptText, output));
              }
            } else {
              sendStop('stop');
              sendUsage(textUsage(promptText, finalResponseText));
            }

            await logRequest('fallback-ai-studio', getTargetModel(model), 200, latency, estimateTokens(promptText), estimateTokens(finalResponseText));
            closeWithDone();
            return;
          } else {
            await ensureFallbackAccount();
            await logRequest('fallback-ai-studio', getTargetModel(model), 502, latency, estimateTokens(promptText), 0, result.message);
            lastMessage = result.message || 'AI Studio fallback failed';
          }
        }

        if (!sentAnyText) {
          sendError(lastMessage);
        }
        closeWithDone();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        sendError(message);
        closeWithDone();
      } finally {
        cleanup();
      }
    },
  });

  return new Response(stream, streamHeaders());
}

function streamHeaders() {
  return {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  };
}

function jsonError(message: string, status = 502) {
  return NextResponse.json({ error: { message, type: errorTypeForStatus(status) } }, { status });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AccountClaim = {
  account: Account;
  lease: AccountLease;
};

async function claimSlot(account: Account, now: Date) {
  const leaseUntil = new Date(Date.now() + ACCOUNT_LEASE_MS);

  for (let slot = 0; slot < ACCOUNT_SLOTS_PER_ACCOUNT; slot += 1) {
    const existing = await prisma.accountLease.findUnique({
      where: { accountId_slot: { accountId: account.id, slot } },
    });

    if (existing) {
      // Transaction-safe updates
      const claimed = await prisma.accountLease.updateMany({
        where: { id: existing.id, leaseUntil: { lte: now } },
        data: { leaseUntil },
      });
      if (claimed.count === 1) {
        return prisma.accountLease.findUniqueOrThrow({ where: { id: existing.id } });
      }
      continue;
    }

    try {
      return await prisma.accountLease.create({
        data: { accountId: account.id, slot, leaseUntil },
      });
    } catch {
      // Slot taken concurrently; retry next
    }
  }

  return null;
}

async function acquireAccountClaim(excludedIds: Set<string>, signal?: AbortSignal): Promise<AccountClaim | null> {
  const deadline = Date.now() + ACCOUNT_ACQUIRE_TIMEOUT_MS;

  while (true) {
    if (signal?.aborted) return null;

    const now = new Date();
    await prisma.accountLease.deleteMany({ where: { leaseUntil: { lte: now } } });
    const activeLeases = await prisma.accountLease.count({ where: { leaseUntil: { gt: now } } });

    if (activeLeases < ACCOUNT_GLOBAL_SLOTS) {
      const accounts = await prisma.account.findMany({
        where: {
          id: excludedIds.size ? { notIn: [...excludedIds] } : undefined,
          OR: [{ status: 'active' }, { status: 'exhausted', quotaResetAt: { lte: now } }],
        },
        orderBy: { lastUsed: 'asc' },
      });

      for (const account of accounts) {
        const lease = await claimSlot(account, now);
        if (!lease) continue;

        await prisma.account.update({
          where: { id: account.id },
          data: {
            status: 'active',
            lastUsed: now,
            usageCount: { increment: 1 },
          },
        });

        return { account, lease };
      }
    }

    if (Date.now() >= deadline) return null;
    await sleep(ACCOUNT_ACQUIRE_POLL_MS);
  }
}

async function releaseAccountClaim(claim: AccountClaim) {
  await prisma.accountLease.deleteMany({ where: { id: claim.lease.id } });
}

async function markAccountFailure(account: Account, statusCode: number, message: string) {
  const accountStatus = classifyAccountStatus(statusCode, message);
  await prisma.account.update({
    where: { id: account.id },
    data: {
      ...(accountStatus ? { status: accountStatus } : {}),
      ...quotaObservationForFailure(statusCode, message),
    },
  });
}

async function runPromptWithRetry(promptText: string, modelName: string, signal?: AbortSignal, options?: AntigravityOptions): Promise<PromptAttemptResult> {
  const accountResult = await withAccountRetry(modelName, promptText, undefined, signal, options);

  if (accountResult.ok && accountResult.account) {
    return { result: { ok: true, text: accountResult.text }, account: accountResult.account };
  }

  // Fallback to AI Studio if key is configured
  const fallbackResult = await withFallbackStream(modelName, promptText, undefined, signal, options);

  if (fallbackResult.ok) {
    const fallbackAccount = await prisma.account.findUnique({ where: { id: 'fallback-ai-studio' } });
    return { result: { ok: true, text: fallbackResult.text }, account: fallbackAccount || undefined };
  }

  return {
    result: { ok: false, text: '', message: fallbackResult.message || accountResult.message },
    account: accountResult.account,
  };
}

function shouldStreamDirectly(stream: boolean, tools: FunctionTool[]) {
  return stream && tools.length === 0;
}

function streamAntigravityText(promptText: string, model: string, signal: AbortSignal, options?: AntigravityOptions) {
  const created = Math.floor(Date.now() / 1000);
  const responseId = `chatcmpl-${created}`;

  const stream = new ReadableStream({
    async start(controller) {
      const { closeWithDone, cleanup, sendStop, sendUsage, sendContent, sendError } = createSSEContext(controller, responseId, created, model);

      let completionText = '';
      let sentAnyText = false;

      try {
        const accountResult = await withAccountRetry(model, promptText, (text) => {
          sentAnyText = true;
          completionText += text;
          sendContent(text);
        }, signal, options);

        if (accountResult.ok) {
          sendStop('stop');
          sendUsage(textUsage(promptText, completionText || accountResult.text || ''));
          closeWithDone();
          return;
        }

        // Fallback to AI Studio
        if (!sentAnyText) {
          const fallbackResult = await withFallbackStream(model, promptText, (text) => {
            sentAnyText = true;
            completionText += text;
            sendContent(text);
          }, signal, options);

          if (fallbackResult.ok) {
            sendStop('stop');
            sendUsage(textUsage(promptText, completionText || fallbackResult.text || ''));
            closeWithDone();
            return;
          }
        }

        if (!sentAnyText) {
          sendError(accountResult.message);
        }
        closeWithDone();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        sendError(message);
        closeWithDone();
      } finally {
        cleanup();
      }
    },
  });

  return new Response(stream, streamHeaders());
}



export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatCompletionRequest;
    const messages = body.messages ?? [];
    const stream = body.stream === true;
    const model = body.model || DEFAULT_MODEL_ID;

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: { message: 'messages must be a non-empty array' } }, { status: 400 });
    }

    const tools = normalizedTools(body);
    const allowedToolNames = new Set(tools.map((tool) => tool.function?.name).filter((name): name is string => Boolean(name)));
    const promptText = buildPrompt(body);
    
    // Clean up expired leases first
    const now = new Date();
    await prisma.accountLease.deleteMany({ where: { leaseUntil: { lte: now } } });

    const activeAccountCount = await prisma.account.count({
      where: { OR: [{ status: 'active' }, { status: 'exhausted', quotaResetAt: { lte: now } }] },
    });

    const fallbackKey = process.env.FALLBACK_GEMINI_API_KEY;
    if (activeAccountCount === 0 && !fallbackKey) {
      return NextResponse.json({
        error: { message: 'No active accounts available in the pool.', type: 'insufficient_quota' },
      }, { status: 429 });
    }

    const options: AntigravityOptions = {
      temperature: body.temperature,
      maxTokens: normalizeMaxTokens(model, body.max_tokens),
      stop: Array.isArray(body.stop) ? body.stop : (typeof body.stop === 'string' ? [body.stop] : undefined),
    };

    if (shouldStreamDirectly(stream, tools)) {
      return streamAntigravityText(promptText, model, req.signal, options);
    }

    if (stream) {
      return streamBufferedOutput(promptText, model, allowedToolNames, req.signal, options);
    }

    const { result } = await runPromptWithRetry(promptText, model, req.signal, options);
    if (!result.ok) return jsonError(result.message || 'Proxy request failed', statusCodeForAccountStatus(result.accountStatus));

    const output = parseAssistantOutput(result.text || '', allowedToolNames);
    return completionResponse(output, model, promptText);
  } catch (error) {
    console.error('Proxy Error:', error);
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    return jsonError(message, 500);
  }
}
