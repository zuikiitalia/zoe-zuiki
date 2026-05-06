/**
 * Script di indicizzazione prodotti Zuiki su Cloudflare Vectorize.
 * Usa CLIP (openai/clip-vit-base-patch32, 512 dims) via HuggingFace Inference API.
 * Le immagini dei prodotti vengono embeddite visivamente: stile, colore, forma.
 * Fallback: se un prodotto non ha immagine, usa CLIP text embedding sul titolo.
 *
 * SETUP UNA-TANTUM (da eseguire una sola volta):
 *   wrangler vectorize delete zuiki-products
 *   wrangler vectorize create zuiki-products --dimensions=512 --metric=cosine
 *   wrangler vectorize create-metadata-index zuiki-products --property-name=sku_suffix --type=string
 *
 * USO:
 *   SHOPIFY_SHOP_DOMAIN=zuiki-italia.myshopify.com \
 *   SHOPIFY_ACCESS_TOKEN=shpat_xxx \
 *   CLOUDFLARE_ACCOUNT_ID=8d710669f75539d86c5606bbd2c5c26d \
 *   CLOUDFLARE_API_TOKEN=xxx \
 *   HF_API_KEY=hf_xxx \
 *   npx ts-node --esm scripts/indexProducts.ts
 *
 * AGGIORNAMENTO INCREMENTALE: rieseguire lo script — Vectorize fa upsert quindi
 * i prodotti già indicizzati vengono aggiornati, quelli nuovi aggiunti.
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const HF_API_KEY = process.env.HF_API_KEY!;
const VECTORIZE_INDEX = 'zuiki-products';
const BATCH_SIZE = 50;

const HF_CLIP_URL =
  'https://api-inference.huggingface.co/pipeline/feature-extraction/openai/clip-vit-base-patch32';

interface ShopifyProduct {
  handle: string;
  title: string;
  descriptionHtml: string;
  onlineStoreUrl: string | null;
  featuredImage: { url: string } | null;
  variants: {
    edges: Array<{ node: { sku: string } }>;
  };
}

interface ShopifyProductsPage {
  products: {
    edges: Array<{ node: ShopifyProduct }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function fetchWithRetry(url: string, opts: RequestInit, maxRetries = 5): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, opts);
      return res;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const wait = Math.min(2000 * 2 ** attempt, 30000);
      console.warn(`  Rete: errore (${err instanceof Error ? err.message : String(err)}), retry ${attempt + 1}/${maxRetries} tra ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error('unreachable');
}

async function shopifyFetch(query: string, variables: Record<string, unknown>): Promise<ShopifyProductsPage> {
  const res = await fetchWithRetry(
    `https://${SHOPIFY_DOMAIN}/admin/api/2025-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  const json = await res.json() as { data: ShopifyProductsPage; errors?: unknown };
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function* fetchAllProducts(): AsyncGenerator<ShopifyProduct> {
  const GQL = `
    query Products($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        edges {
          node {
            handle title descriptionHtml onlineStoreUrl
            featuredImage { url }
            variants(first: 1) {
              edges { node { sku } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;

  let cursor: string | null = null;
  let page = 0;
  do {
    const data = await shopifyFetch(GQL, { first: 50, after: cursor });
    page++;
    console.log(`  Pagina ${page}: ${data.products.edges.length} prodotti`);
    for (const edge of data.products.edges) {
      yield edge.node;
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    if (cursor) await sleep(600);
  } while (cursor);
}

function extractSkuSuffix(sku: string): string {
  if (!sku) return '';
  const upper = sku.toUpperCase().replace(/[^A-Z]/g, '');
  return upper.slice(-2);
}

/**
 * Calcola CLIP embedding da immagine URL.
 * Scarica l'immagine e la invia come bytes a HuggingFace CLIP.
 */
async function computeClipImageEmbedding(imageUrl: string, retries = 3): Promise<number[] | null> {
  let imgBytes: Uint8Array | null = null;
  let mediaType = 'image/jpeg';

  // Scarica immagine con retry
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const imgRes = await fetch(imageUrl, { redirect: 'follow' });
      if (!imgRes.ok) {
        console.warn(`  Immagine HTTP ${imgRes.status}: ${imageUrl.slice(0, 80)}`);
        return null;
      }
      const ct = imgRes.headers.get('content-type') ?? '';
      if (/image\/png/i.test(ct)) mediaType = 'image/png';
      else if (/image\/webp/i.test(ct)) mediaType = 'image/webp';
      const buf = await imgRes.arrayBuffer();
      imgBytes = new Uint8Array(buf);
      break;
    } catch (err) {
      if (attempt === retries) {
        console.warn(`  Download immagine fallito: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      await sleep(2000 * 2 ** attempt);
    }
  }
  if (!imgBytes) return null;

  // Invia a HF CLIP
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(HF_CLIP_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          'Content-Type': mediaType,
        },
        body: imgBytes,
      });

      if (res.status === 503) {
        // Modello in avvio (HF warm-up), aspetta e riprova
        const body = await res.json() as { estimated_time?: number };
        const wait = Math.round((body.estimated_time ?? 20) * 1000);
        console.log(`  HF modello in avvio, aspetto ${wait}ms...`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        console.warn(`  HF CLIP ${res.status}: ${body.slice(0, 200)}`);
        if (attempt < retries) { await sleep(3000 * 2 ** attempt); continue; }
        return null;
      }

      const raw = await res.json() as number[] | number[][];
      const embedding = Array.isArray(raw[0]) ? (raw as number[][])[0] : (raw as number[]);
      if (!embedding || embedding.length === 0) return null;
      return embedding;
    } catch (err) {
      if (attempt === retries) {
        console.warn(`  HF CLIP errore: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      await sleep(3000 * 2 ** attempt);
    }
  }
  return null;
}

/**
 * Calcola CLIP text embedding (fallback per prodotti senza immagine).
 */
async function computeClipTextEmbedding(text: string, retries = 3): Promise<number[] | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(HF_CLIP_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: text }),
      });

      if (res.status === 503) {
        const body = await res.json() as { estimated_time?: number };
        const wait = Math.round((body.estimated_time ?? 20) * 1000);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        if (attempt < retries) { await sleep(3000 * 2 ** attempt); continue; }
        console.warn(`  HF CLIP text ${res.status}: ${body.slice(0, 200)}`);
        return null;
      }

      const raw = await res.json() as number[] | number[][];
      const embedding = Array.isArray(raw[0]) ? (raw as number[][])[0] : (raw as number[]);
      if (!embedding || embedding.length === 0) return null;
      return embedding;
    } catch (err) {
      if (attempt === retries) return null;
      await sleep(3000 * 2 ** attempt);
    }
  }
  return null;
}

interface VectorizeUpsertPayload {
  id: string;
  values: number[];
  metadata: Record<string, string>;
}

async function upsertVectors(vectors: VectorizeUpsertPayload[]): Promise<void> {
  const ndjson = vectors.map((v) => JSON.stringify(v)).join('\n');
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/vectorize/v2/indexes/${VECTORIZE_INDEX}/upsert`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: ndjson,
    }
  );
  if (!res.ok) throw new Error(`Vectorize upsert ${res.status}: ${await res.text()}`);
  const json = await res.json() as { result?: { count?: number }; success: boolean };
  if (!json.success) throw new Error(`Vectorize upsert failed: ${JSON.stringify(json)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN || !CF_ACCOUNT || !CF_TOKEN || !HF_API_KEY) {
    console.error('Variabili mancanti: SHOPIFY_SHOP_DOMAIN, SHOPIFY_ACCESS_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, HF_API_KEY');
    process.exit(1);
  }

  console.log('Inizio indicizzazione prodotti Zuiki su Vectorize (CLIP 512-dim)...');
  let total = 0;
  let indexed = 0;
  let skipped = 0;
  const batch: VectorizeUpsertPayload[] = [];

  for await (const product of fetchAllProducts()) {
    total++;
    const sku = product.variants.edges[0]?.node.sku ?? '';
    const skuSuffix = extractSkuSuffix(sku);

    let embedding: number[] | null = null;

    if (product.featuredImage?.url) {
      embedding = await computeClipImageEmbedding(product.featuredImage.url);
      if (!embedding) {
        console.log(`  [IMG_FAIL] ${product.handle} — CLIP immagine fallito, provo testo`);
      }
    }

    if (!embedding) {
      // Fallback: CLIP text embedding sul titolo
      embedding = await computeClipTextEmbedding(product.title);
    }

    if (!embedding) {
      console.log(`  [SKIP] ${product.handle} — embedding fallito`);
      skipped++;
      await sleep(1500);
      continue;
    }

    batch.push({
      id: product.handle,
      values: embedding,
      metadata: {
        handle: product.handle,
        title: product.title,
        sku: sku,
        sku_suffix: skuSuffix,
        url: product.onlineStoreUrl ?? `https://www.zuiki.it/products/${product.handle}`,
        image_url: product.featuredImage?.url ?? '',
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await upsertVectors(batch);
      indexed += batch.length;
      console.log(`  Indicizzati ${indexed} prodotti finora...`);
      batch.length = 0;
      await sleep(200);
    }

    // HF free tier: ~1 req/s per immagine + 1 download → 1000ms di margine
    await sleep(1000);
  }

  if (batch.length > 0) {
    await upsertVectors(batch);
    indexed += batch.length;
  }

  console.log(`\nCompletato. Totale: ${total}, Indicizzati: ${indexed}, Saltati: ${skipped}`);
}

main().catch((err) => {
  console.error('Errore:', err);
  process.exit(1);
});
