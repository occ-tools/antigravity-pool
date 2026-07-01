import { NextResponse } from 'next/server';
import { MODEL_METADATA, PUBLIC_MODEL_IDS } from '@/lib/antigravityPool';

export async function GET() {
  const models = PUBLIC_MODEL_IDS.map((modelId) => ({
    id: modelId,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: MODEL_METADATA[modelId].provider,
    context_length: MODEL_METADATA[modelId].contextLength,
    max_output_tokens: MODEL_METADATA[modelId].maxOutputTokens,
  }));

  return NextResponse.json({
    object: 'list',
    data: models,
  });
}
