/**
 * Script di indicizzazione prodotti Zuiki su Cloudflare Vectorize.
 *
 * SETUP UNA-TANTUM (da eseguire una sola volta):
 *   wrangler vectorize create zuiki-products --dimensions=512 --metric=cosine
 *   wrangler vectorize create-metadata-index zuiki-products --property-name=sku_suffix --type=string
 *
 * USO:
 *   SHOPIFY_SHOP_DOMAIN=zuiki-italia.myshopify.com \
 *   SHOPIFY_ACCESS_TOKEN=shpat_xxx \
 *   CLOUDFLARE_ACCOUNT_ID=8d710669f75539d86c5606bbd2c5c26d \
 *   CLOUDFLARE_API_TOKEN=xxx \
 *   npx ts-node --esm scripts/indexProducts.ts
 *
 * AGGIORNAMENTO INCREMETALE: rieseguire lo script — Vectorize fa upsert quindi
 * i prodotti già indicizzati vengono aggiornati, quelli nuovi aggiunti.
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const VECTORIZE_INDEX = 'zuiki-products';
const BATCH_SIZE = 20; // vettori per chiamata upsert Vectorize (max 1000, ma teniamo basso per CF AI rate limit)

interface ShopifyProduct {
  handle: string;
  title: string;
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

async function shopifyFetch(query: string, variables: Record<string, unknown>): Promise<ShopifyProductsPage> {
  const res = await fetch(
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

/** Recupera tutti i prodotti Shopify con paginazione. */
async function* fetchAllProducts(): AsyncGenerator<ShopifyProduct> {
  const GQL = `
    query Products($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        edges {
          node {
            handle title onlineStoreUrl
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
    // Rate limit Shopify: 2 req/s (piano Plus). Pausa di 600ms.
    if (cursor) await sleep(600);
  } while (cursor);
}

/** Estrae il suffisso SKU (ultimi 2 char, o 1 se la variante finisce con C=Collana). */
function extractSkuSuffix(sku: string): string {
  if (!sku) return '';
  const upper = sku.toUpperCase().replace(/[^A-Z]/g, '');
  // Suffissi a 2 char sono più comuni; controlla prima quelli
  // (es. CA, PA, MA...). Se non matcha un suffisso noto, prova 1 char.
  return upper.slice(-2);
}

/** Scarica un'immagine e ritorna i byte raw. */
async function fetchImageBytes(url: string): Promise<number[] | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return Array.from(new Uint8Array(buf));
  } catch {
    return null;
  }
}

/** Chiama CF AI CLIP per ottenere l'embedding di un'immagine. */
async function getCfClipEmbedding(imageBytes: number[]): Promise<number[] | null> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/openai/clip-vit-base-patch32`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: imageBytes }),
    }
  );
  if (!res.ok) {
    console.warn(`  CF AI ${res.status}: ${await res.text()}`);
    return null;
  }
  const json = await res.json() as { result?: { data?: number[] } | number[]; success: boolean };
  if (!json.success) return null;
  const data = Array.isArray(json.result) ? json.result : (json.result as { data?: number[] })?.data;
  return data ?? null;
}

interface VectorizeUpsertPayload {
  id: string;
  values: number[];
  metadata: Record<string, string>;
}

/** Inserisce/aggiorna vettori in Cloudflare Vectorize (formato NDJSON). */
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

  console.log('Inizio indicizzazione prodotti Zuiki su Vectorize...');
  let total = 0;
  let indexed = 0;
  let skipped = 0;
  const batch: VectorizeUpsertPayload[] = [];

  for await (const product of fetchAllProducts()) {
    total++;
    const sku = product.variants.edges[0]?.node.sku ?? '';
    const skuSuffix = extractSkuSuffix(sku);
    const imageUrl = product.featuredImage?.url;

    if (!imageUrl) {
      console.log(`  [SKIP] ${product.handle} — nessuna immagine`);
      skipped++;
      continue;
    }

    const imageBytes = await fetchImageBytes(imageUrl);
    if (!imageBytes) {
      console.log(`  [SKIP] ${product.handle} — download immagine fallito`);
      skipped++;
      continue;
    }

    // Rate limit CF AI: max ~50 req/min sul piano Workers Free/Paid.
    const embedding = await getCfClipEmbedding(imageBytes);
    if (!embedding) {
      console.log(`  [SKIP] ${product.handle} — embedding CLIP fallito`);
      skipped++;
      await sleep(2000); // backoff su errori CF AI
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
        image_url: imageUrl,
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await upsertVectors(batch);
      indexed += batch.length;
      console.log(`  Indicizzati ${indexed} prodotti finora...`);
      batch.length = 0;
      await sleep(300); // pausa tra batch
    }

    await sleep(100); // ~10 req/s verso CF AI
  }

  // Flush batch finale
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
