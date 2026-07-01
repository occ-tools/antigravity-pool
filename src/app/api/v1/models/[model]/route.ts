import { NextResponse } from 'next/server';
import { isPublicModelId, MODEL_MAP, MODEL_METADATA } from '@/lib/antigravityPool';

export async function GET(_req: Request, { params }: { params: Promise<{ model: string }> }) {
  const { model } = await params;

  if (!MODEL_MAP[model] && !Object.values(MODEL_MAP).includes(model)) {
    return NextResponse.json({ error: { message: `Model '${model}' not found`, type: 'invalid_request_error' } }, { status: 404 });
  }

  const resolvedModel = MODEL_MAP[model] ?? model;
  const metadata = isPublicModelId(resolvedModel) ? MODEL_METADATA[resolvedModel] : undefined;

  return NextResponse.json({
    id: model,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: metadata?.provider ?? 'antigravity-pool',
    context_length: metadata?.contextLength ?? 1_048_576,
    max_output_tokens: metadata?.maxOutputTokens ?? 65_536,
    canonical: metadata ? resolvedModel : undefined,
  });
}
