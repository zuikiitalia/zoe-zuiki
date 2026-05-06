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

/**
 * Calcola l'embedding testuale di una query tramite Cloudflare AI (qwen3-embedding-0.6b, 1024-dim).
 * Restituisce null se il binding AI non è disponibile o la call fallisce.
 */
export async function computeTextEmbedding(
  env: Env,
  text: string
): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (env.AI as any).run('@cf/qwen/qwen3-embedding-0.6b', {
      text,
    }) as { data: number[][] } | number[][];
    const data = Array.isArray(result) ? result : result?.data;
    const embedding = Array.isArray(data?.[0]) ? data[0] : null;
    if (!embedding || embedding.length === 0) return null;
    return embedding;
  } catch (err) {
    logger.error('text_embedding_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Interroga Vectorize con un embedding e ritorna i prodotti più simili.
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
