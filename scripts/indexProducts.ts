/**
 * Script di indicizzazione prodotti Zuiki su Cloudflare Vectorize.
 * Usa embedding testuale (qwen3-embedding-0.6b) sul titolo prodotto + body_html.
 *
 * SETUP UNA-TANTUM (da eseguire una sola volta):
 *   wrangler vectorize create zuiki-products --dimensions=1024 --metric=cosine
 *   wrangler vectorize create-metadata-index zuiki-products --property-name=sku_suffix --type=string
 *
 * USO:
 *   SHOPIFY_SHOP_DOMAIN=zuiki-italia.myshopify.com \
 *   SHOPIFY_ACCESS_TOKEN=shpat_xxx \
 *   CLOUDFLARE_ACCOUNT_ID=8d710669f75539d86c5606bbd2c5c26d \
 *   CLOUDFLARE_API_TOKEN=xxx \
 *   npx ts-node --esm scripts/indexProducts.ts
 *
 * AGGIORNAMENTO INCREMENTALE: rieseguire lo script — Vectorize fa upsert quindi
 * i prodotti già indicizzati vengono aggiornati, quelli nuovi aggiunti.
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const VECTORIZE_INDEX = 'zuiki-products';
const BATCH_SIZE = 50;
const CF_EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b';

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

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function getTextEmbedding(text: string): Promise<number[] | null> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${CF_EMBED_MODEL}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    }
  );
  if (!res.ok) {
    console.warn(`  CF AI ${res.status}: ${await res.text()}`);
    return null;
  }
  const json = await res.json() as { result?: { data?: number[][] }; success: boolean };
  if (!json.success) return null;
  return json.result?.data?.[0] ?? null;
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
    console.error('Variabili d\'ambiente mancanti: SHOPIFY_SHOP_DOMAIN, SHOPIFY_ACCESS_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN');
    process.exit(1);
  }

  console.log('Inizio indicizzazione prodotti Zuiki su Vectorize (text embedding)...');
  let total = 0;
  let indexed = 0;
  let skipped = 0;
  const batch: VectorizeUpsertPayload[] = [];

  for await (const product of fetchAllProducts()) {
    total++;
    const sku = product.variants.edges[0]?.node.sku ?? '';
    const skuSuffix = extractSkuSuffix(sku);
    const description = stripHtml(product.descriptionHtml ?? '');
    const textToEmbed = description
      ? `${product.title}. ${description}`
      : product.title;

    const embedding = await getTextEmbedding(textToEmbed);
    if (!embedding) {
      console.log(`  [SKIP] ${product.handle} — embedding fallito`);
      skipped++;
      await sleep(1000);
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

    await sleep(50); // ~20 req/s verso CF AI
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
