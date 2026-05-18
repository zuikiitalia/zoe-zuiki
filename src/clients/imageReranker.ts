import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../config';
import type { SimilarProductMatch } from './vectorizeClient';
import { logger } from '../utils/logger';

const RERANK_MODEL = 'claude-sonnet-4-6';
export const RERANK_CONFIDENCE_THRESHOLD = 0.5;
const MAX_CANDIDATES = 5;

export interface RerankResult {
  best_handle: string;
  confidence: number;
  reasoning: string;
}

/**
 * Usa Claude Sonnet 4.6 vision per scegliere il miglior match tra i candidati Vectorize.
 * Ritorna null se la confidence è sotto soglia o se la chiamata fallisce.
 */
export async function rerankCandidates(
  env: Env,
  userImageBase64: string,
  userImageMediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
  candidates: SimilarProductMatch[],
  phone: string
): Promise<RerankResult | null> {
  if (!env.ANTHROPIC_API_KEY || candidates.length === 0) return null;

  const top = candidates.slice(0, MAX_CANDIDATES);
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const content: Anthropic.ContentBlockParam[] = [];

  content.push({
    type: 'text',
    text: `A customer sent this photo looking for a similar product in our fashion catalog. Compare the customer photo to the ${top.length} candidate products shown below. Pick the best visual match based on: garment silhouette, fabric texture (solid/knit/lace/etc.), sleeve/cut style, color family, and overall look. Ignore small differences in color variants.`,
  });

  content.push({
    type: 'image',
    source: { type: 'base64', media_type: userImageMediaType, data: userImageBase64 },
  });

  for (let i = 0; i < top.length; i++) {
    const c = top[i]!;
    content.push({
      type: 'text',
      text: `\nCandidate ${i + 1} (handle: "${c.handle}"): ${c.title} — vector similarity ${Math.round(c.similarity * 100)}%`,
    });
    if (c.image_url) {
      try {
        content.push({
          type: 'image',
          source: { type: 'url', url: c.image_url } as Anthropic.URLImageSource,
        });
      } catch {
        // skip if URL image fails
      }
    }
  }

  content.push({
    type: 'text',
    text: '\nRespond ONLY with a valid JSON object (no markdown fences, no extra text):\n{"best_index": <0-based integer>, "best_handle": "<handle string>", "confidence": <float 0.0–1.0>, "reasoning": "<one concise sentence>"}',
  });

  try {
    const response = await anthropic.messages.create(
      {
        model: RERANK_MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content }],
      },
      { signal: AbortSignal.timeout(20_000) }
    );

    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('rerank_parse_failed', { raw: raw.slice(0, 300) }, phone);
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      best_index?: number;
      best_handle?: string;
      confidence?: number;
      reasoning?: string;
    };

    const bestHandle =
      parsed.best_handle ??
      top[typeof parsed.best_index === 'number' ? parsed.best_index : 0]?.handle ??
      '';
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

    logger.info('rerank_result', {
      best_handle: bestHandle,
      confidence,
      reasoning: (parsed.reasoning ?? '').slice(0, 200),
      below_threshold: confidence < RERANK_CONFIDENCE_THRESHOLD,
    }, phone);

    if (confidence < RERANK_CONFIDENCE_THRESHOLD) return null;

    return { best_handle: bestHandle, confidence, reasoning: parsed.reasoning ?? '' };
  } catch (err) {
    logger.error('rerank_failed', {
      error: err instanceof Error ? err.message : String(err),
    }, phone);
    return null;
  }
}
