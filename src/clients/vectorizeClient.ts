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

const HF_CLIP_URL =
  'https://api-inference.huggingface.co/pipeline/feature-extraction/openai/clip-vit-base-patch32';

/**
 * Calcola CLIP embedding da immagine base64.
 * Ritorna vettore 512-dim o null in caso di errore.
 */
export async function computeImageEmbeddingClip(
  env: Env,
  imageBase64: string,
  mediaType: string = 'image/jpeg'
): Promise<number[] | null> {
  if (!env.HF_API_KEY) return null;
  try {
    const binaryStr = atob(imageBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const res = await fetch(HF_CLIP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.HF_API_KEY}`,
        'Content-Type': mediaType,
      },
      body: bytes,
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn('clip_image_hf_error', { status: res.status, body: body.slice(0, 200) });
      return null;
    }
    const raw = await res.json() as number[] | number[][];
    const embedding = Array.isArray(raw[0]) ? (raw as number[][])[0] : (raw as number[]);
    if (!embedding || embedding.length === 0) return null;
    return embedding;
  } catch (err) {
    logger.error('clip_image_embedding_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Calcola CLIP text embedding via HuggingFace.
 * Usa il ramo testuale di CLIP — stesso spazio 512-dim delle immagini.
 */
export async function computeTextEmbeddingClip(
  env: Env,
  text: string
): Promise<number[] | null> {
  if (!env.HF_API_KEY) return null;
  try {
    const res = await fetch(HF_CLIP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.HF_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: text }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn('clip_text_hf_error', { status: res.status, body: body.slice(0, 200) });
      return null;
    }
    const raw = await res.json() as number[] | number[][];
    const embedding = Array.isArray(raw[0]) ? (raw as number[][])[0] : (raw as number[]);
    if (!embedding || embedding.length === 0) return null;
    return embedding;
  } catch (err) {
    logger.error('clip_text_embedding_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Calcola l'embedding testuale tramite Cloudflare AI (qwen3-embedding-0.6b, 1024-dim).
 * Mantenuto come fallback per indici legacy.
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
