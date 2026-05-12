/**
 * Script di indicizzazione prodotti Zuiki su Cloudflare Vectorize.
 *
 * Strategia: immagine prodotto → FashionCLIP (HF Space) → embedding 512-dim → Vectorize
 * Fallback: titolo prodotto → FashionCLIP text embedding (stesso spazio 512-dim)
 *
 * FashionCLIP è addestrato su 700k immagini fashion → capisce colori, pattern,
 * stile e dettagli costruttivi dei capi, non solo parole chiave.
 *
 * SETUP (fatto automaticamente dallo script di setup):
 *   Vectorize: zuiki-products, 512-dim, cosine
 *   HF Space: https://aldoinnamorato-zuiki-fashion-clip.hf.space
 *
 * USO:
 *   SHOPIFY_SHOP_DOMAIN=zuiki-italia.myshopify.com \
 *   SHOPIFY_ACCESS_TOKEN=shpat_xxx \
 *   CLOUDFLARE_ACCOUNT_ID=8d710669f75539d86c5606bbd2c5c26d \
 *   CLOUDFLARE_API_TOKEN=xxx \
 *   HF_SPACE_URL=https://aldoinnamorato-zuiki-fashion-clip.hf.space \
 *   npx ts-node --esm scripts/indexProducts.ts
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const HF_SPACE_URL = process.env.HF_SPACE_URL ?? 'https://aldoinnamorato-zuiki-fashion-clip.hf.space';
const VECTORIZE_INDEX = 'zuiki-products';
const BATCH_SIZE = 50;

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
 * Chiama lo HF Space FashionCLIP con image_url o testo.
 * Ritorna vettore 512-dim normalizzato o null.
 */
async function getFashionCLIPEmbedding(
  imageUrl: string | null,
  text: string | null,
  retries = 4
): Promise<number[] | null> {
  const body = imageUrl
    ? { image_url: imageUrl, image_b64: '', text: '' }
    : { image_url: '', image_b64: '', text: text ?? '' };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${HF_SPACE_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 503) {
        // Space in avvio (cold start) — aspetta
        console.log(`  Space in avvio, aspetto 30s... (tentativo ${attempt + 1})`);
        await sleep(30000);
        continue;
      }

      if (!res.ok) {
        const txt = await res.text();
        console.warn(`  FashionCLIP ${res.status}: ${txt.slice(0, 150)}`);
        if (attempt < retries) { await sleep(5000 * (attempt + 1)); continue; }
        return null;
      }

      const json = await res.json() as { embedding?: number[] };
      const embedding = json.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) return null;
      return embedding;
    } catch (err) {
      if (attempt === retries) {
        console.warn(`  FashionCLIP errore: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      await sleep(5000 * (attempt + 1));
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
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN || !CF_ACCOUNT || !CF_TOKEN) {
    console.error('Variabili mancanti: SHOPIFY_SHOP_DOMAIN, SHOPIFY_ACCESS_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN');
    process.exit(1);
  }

  console.log(`Indicizzazione prodotti Zuiki con FashionCLIP (512-dim)...`);
  console.log(`HF Space: ${HF_SPACE_URL}`);

  // Verifica che lo Space sia raggiungibile (warm-up se necessario)
  console.log('Verifica Space FashionCLIP...');
  const testEmb = await getFashionCLIPEmbedding(null, 'test', 5);
  if (!testEmb) {
    console.error('HF Space non raggiungibile. Verifica che sia in esecuzione.');
    process.exit(1);
  }
  console.log(`Space OK — dimensioni embedding: ${testEmb.length}`);

  let total = 0;
  let indexed = 0;
  let skipped = 0;
  let imageEmbeds = 0;
  let textFallback = 0;
  const batch: VectorizeUpsertPayload[] = [];

  for await (const product of fetchAllProducts()) {
    total++;
    const sku = product.variants.edges[0]?.node.sku ?? '';
    const skuSuffix = extractSkuSuffix(sku);

    let embedding: number[] | null = null;

    // 1) Prova con l'immagine del prodotto (matching visivo reale)
    if (product.featuredImage?.url) {
      embedding = await getFashionCLIPEmbedding(product.featuredImage.url, null);
      if (embedding) imageEmbeds++;
    }

    // 2) Fallback: testo del titolo (stesso spazio 512-dim)
    if (!embedding) {
      embedding = await getFashionCLIPEmbedding(null, product.title);
      if (embedding) textFallback++;
    }

    if (!embedding) {
      console.log(`  [SKIP] ${product.handle}`);
      skipped++;
      await sleep(500);
      continue;
    }

    batch.push({
      id: product.handle,
      values: embedding,
      metadata: {
        handle: product.handle,
        title: product.title,
        sku,
        sku_suffix: skuSuffix,
        url: product.onlineStoreUrl ?? `https://www.zuiki.it/products/${product.handle}`,
        image_url: product.featuredImage?.url ?? '',
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await upsertVectors(batch);
      indexed += batch.length;
      console.log(`  ${indexed}/${total} indicizzati | img: ${imageEmbeds}, testo: ${textFallback}`);
      batch.length = 0;
      await sleep(200);
    }

    // Rate limit: 500ms tra prodotti (~120 req/min verso HF Space)
    await sleep(500);
  }

  if (batch.length > 0) {
    await upsertVectors(batch);
    indexed += batch.length;
  }

  console.log(`\nCompletato. Totale: ${total}, Indicizzati: ${indexed}, Saltati: ${skipped}`);
  console.log(`Image embeddings: ${imageEmbeds}, Text fallback: ${textFallback}`);
}

main().catch((err) => {
  console.error('Errore:', err);
  process.exit(1);
});
