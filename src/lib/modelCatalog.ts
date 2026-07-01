export const PUBLIC_MODEL_IDS = [
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-medium',
  'gemini-3.1-pro-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
] as const;

export type PublicModelId = (typeof PUBLIC_MODEL_IDS)[number];

export type ModelProvider = 'Google Daily Preview' | 'Anthropic Vertex';

export type ModelMetadata = {
  name: string;
  family: 'Gemini 3.1 Pro' | 'Gemini 3.5 Flash' | 'Claude';
  mode: string;
  provider: ModelProvider;
  contextLength: number;
  maxOutputTokens: number;
  upstreamModel: string;
};

export const MODEL_METADATA: Record<PublicModelId, ModelMetadata> = {
  'gemini-3.1-pro-high': {
    name: 'Gemini 3.1 Pro High',
    family: 'Gemini 3.1 Pro',
    mode: 'High thinking',
    provider: 'Google Daily Preview',
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    upstreamModel: 'gemini-3.1-pro-preview',
  },
  'gemini-3.1-pro-medium': {
    name: 'Gemini 3.1 Pro Medium',
    family: 'Gemini 3.1 Pro',
    mode: 'Medium thinking',
    provider: 'Google Daily Preview',
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    upstreamModel: 'gemini-3.1-pro-preview',
  },
  'gemini-3.1-pro-low': {
    name: 'Gemini 3.1 Pro Low',
    family: 'Gemini 3.1 Pro',
    mode: 'Low thinking',
    provider: 'Google Daily Preview',
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    upstreamModel: 'gemini-3.1-pro-preview',
  },
  'gemini-3.5-flash-high': {
    name: 'Gemini 3.5 Flash High',
    family: 'Gemini 3.5 Flash',
    mode: 'High thinking',
    provider: 'Google Daily Preview',
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    upstreamModel: 'gemini-3.5-flash',
  },
  'gemini-3.5-flash-medium': {
    name: 'Gemini 3.5 Flash Medium',
    family: 'Gemini 3.5 Flash',
    mode: 'Medium thinking',
    provider: 'Google Daily Preview',
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    upstreamModel: 'gemini-3.5-flash',
  },
  'gemini-3.5-flash-low': {
    name: 'Gemini 3.5 Flash Low',
    family: 'Gemini 3.5 Flash',
    mode: 'Low thinking',
    provider: 'Google Daily Preview',
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    upstreamModel: 'gemini-3.5-flash',
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6 Thinking',
    family: 'Claude',
    mode: 'Thinking',
    provider: 'Anthropic Vertex',
    contextLength: 1_000_000,
    maxOutputTokens: 128_000,
    upstreamModel: 'claude-sonnet-4-6',
  },
  'claude-opus-4-6-thinking': {
    name: 'Claude Opus 4.6 Thinking',
    family: 'Claude',
    mode: 'Extended thinking',
    provider: 'Anthropic Vertex',
    contextLength: 1_000_000,
    maxOutputTokens: 128_000,
    upstreamModel: 'claude-opus-4-6',
  },
};

export const DEFAULT_MODEL_ID: PublicModelId = 'gemini-3.5-flash-low';
export const HEALTH_CHECK_MODEL_ID: PublicModelId = 'gemini-3.5-flash-low';

export function isPublicModelId(modelId: string): modelId is PublicModelId {
  return PUBLIC_MODEL_IDS.includes(modelId as PublicModelId);
}
