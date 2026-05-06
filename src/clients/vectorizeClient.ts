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
 * Converte base64 in array di byte (raw image file bytes per CF AI CLIP).
 * CF AI CLIP accetta i byte grezzi del file immagine (JPEG/PNG/WEBP),
 * non i pixel decodificati.
 */
export function base64ToByteArray(base64: string): number[] {
  const binary = atob(base64);
  const result = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i++) {
    result[i] = binary.charCodeAt(i);
  }
  return result;
}

/**
 * Calcola l'embedding CLIP di un'immagine tramite Cloudflare AI.
 * Restituisce null se il binding AI non è disponibile o la call fallisce.
 *
 * Setup richiesto (una-tantum): il binding `AI` deve essere presente in wrangler.toml.
 */
export async function computeImageEmbedding(
  env: Env,
  imageBytes: number[]
): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    // CF AI workers-types non tipizza CLIP in feature-extraction mode.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (env.AI as any).run('@cf/openai/clip-vit-base-patch32', {
      image: imageBytes,
    }) as { data: number[] } | number[];
    // CF AI può restituire { data: [...] } o direttamente l'array.
    const embedding = Array.isArray(result) ? result : result?.data;
    if (!embedding || embedding.length === 0) return null;
    return embedding;
  } catch (err) {
    logger.error('clip_embedding_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Interroga Vectorize con un embedding immagine e ritorna i prodotti più simili.
 * Se skuSuffix è fornito, filtra per categoria (es. "CA" = solo camicie).
 *
 * Setup richiesto (una-tantum):
 *   wrangler vectorize create zuiki-products --dimensions=512 --metric=cosine
 *   wrangler vectorize create-metadata-index zuiki-products --property-name=sku_suffix --type=string
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
