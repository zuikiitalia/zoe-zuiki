import type { Env } from '../config';
import { logger } from '../utils/logger';

export interface SimilarProductMatch {
  handle: string;
  title: string;
  sku: string;
  sku_suffix: string;
  url: string;
  image_url: string;
  similarity: number;
}

const HF_SPACE_EMBED_PATH = '/run/embed';

/**
 * Chiama lo HF Space FashionCLIP con un'immagine base64.
 * Ritorna vettore 512-dim normalizzato o null.
 */
export async function computeImageEmbeddingFashionCLIP(
  env: Env,
  imageBase64: string,
): Promise<number[] | null> {
  if (!env.HF_SPACE_URL) return null;
  return callFashionCLIPSpace(env, { image_b64: imageBase64, image_url: '', text: '' });
}

/**
 * Chiama lo HF Space FashionCLIP con un testo.
 * Testo e immagini sono nello stesso spazio 512-dim → fallback affidabile.
 */
export async function computeTextEmbeddingFashionCLIP(
  env: Env,
  text: string,
): Promise<number[] | null> {
  if (!env.HF_SPACE_URL) return null;
  return callFashionCLIPSpace(env, { image_b64: '', image_url: '', text });
}

async function callFashionCLIPSpace(
  env: Env,
  input: { image_url: string; image_b64: string; text: string }
): Promise<number[] | null> {
  try {
    const res = await fetch(`${env.HF_SPACE_URL}${HF_SPACE_EMBED_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [input.image_url, input.image_b64, input.text] }),
    });
    if (!res.ok) {
      logger.warn('fashion_clip_space_error', { status: res.status });
      return null;
    }
    const json = await res.json() as { data?: number[][] };
    const embedding = json.data?.[0];
    if (!Array.isArray(embedding) || embedding.length === 0) return null;
    return embedding;
  } catch (err) {
    logger.error('fashion_clip_space_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Interroga Vectorize e ritorna i prodotti più simili.
 * Se skuSuffix è fornito, filtra per categoria (es. "CA" = solo camicie).
 */
export async function findSimilarProducts(
  env: Env,
  embedding: number[],
  skuSuffix?: string,
  topK = 3
): Promise<SimilarProductMatch[]> {
  if (!env.PRODUCT_VECTORS) return [];
  try {
    const options: VectorizeQueryOptions = {
      topK,
      returnMetadata: 'all',
    };
    if (skuSuffix) {
      options.filter = { sku_suffix: skuSuffix };
    }
    const results = await env.PRODUCT_VECTORS.query(embedding, options);
    return results.matches.map((m) => ({
      handle: String(m.metadata?.handle ?? ''),
      title: String(m.metadata?.title ?? ''),
      sku: String(m.metadata?.sku ?? ''),
      sku_suffix: String(m.metadata?.sku_suffix ?? ''),
      url: String(m.metadata?.url ?? ''),
      image_url: String(m.metadata?.image_url ?? ''),
      similarity: m.score,
    }));
  } catch (err) {
    logger.error('vectorize_query_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
