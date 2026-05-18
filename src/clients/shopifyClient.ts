import type { Env } from '../config';
import { SHOPIFY_API_VERSION } from '../config';
import { getShopifyAccessToken } from '../storage/kvStore';
import { logger } from '../utils/logger';
import { ZUIKI_STORES, type ZuikiStore } from '../data/stores';

export class ShopifyNotInstalledError extends Error {
  constructor() {
    super('Shopify app not installed yet (no access token in KV)');
    this.name = 'ShopifyNotInstalledError';
  }
}

async function shopifyGraphQL<T = unknown>(
  env: Env,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const token = await getShopifyAccessToken(env.ZOE_KV);
  if (!token) throw new ShopifyNotInstalledError();

  const url = `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify API ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

export interface OrderSummary {
  found: boolean;
  order_number?: string;
  created_at?: string;
  financial_status?: string;
  fulfillment_status?: string;
  total?: { amount: string; currencyCode: string };
  shipping_city?: string;
  shipping_country?: string;
  items?: Array<{ title: string; quantity: number; variant?: string | null }>;
  // Nota dell'ordine Shopify. Rich Returns scrive automaticamente l'RMA qui (es. "RMA-434851103125").
  note?: string;
  // RMA estratto dalla nota tramite regex /RMA-\d+/ (es. "RMA-434851103125"), se presente.
  rma_number?: string;
  // Tracking solo per consegne a domicilio. Per pickup è sempre vuoto.
  tracking?: Array<{ company?: string; number?: string; url?: string; status?: string }>;
  // === Logica consegna ===
  // Se il metafield "Pickup" è compilato → ritiro in negozio.
  delivery_method?: 'pickup' | 'home';
  pickup_store_raw?: string; // valore raw del metafield (es. "#VOMER# Napoli - Via Luca Giordano...")
  pickup_store_code?: string; // codice estratto (es. "VOMER")
  pickup_store_label?: string; // descrizione human-readable senza codice (es. "Napoli - Via Luca Giordano")
  // Riscontro con il catalogo negozi (src/data/stores.ts) sulla base di pickup_store_label/raw.
  pickup_store_match?: {
    name: string;
    region: string;
    city: string;
    address: string;
    tel: string;
    hours_weekday: string;
    hours_saturday: string;
    hours_sunday: string;
    match_score: number; // numero di token sovrapposti (debug)
  };
  // === Stato dai tag STATUS:* ===
  // Tag formato "STATUS:<NAME>:<DD/MM/YYYY>:<HHMM>".
  // L'array è ordinato dal più vecchio al più recente.
  status_history?: Array<{ name: string; date: string; time: string; raw: string }>;
  latest_status?: { name: string; date: string; time: string; raw: string };
  // Tutti i tag raw (utili per audit).
  tags?: string[];
}

interface ParsedStatus {
  name: string;
  date: string;
  time: string;
  raw: string;
  // Per ordinamento cronologico: timestamp Unix derivato da date+time.
  ts: number;
}

function parseStatusTag(tag: string): ParsedStatus | null {
  // Formato: STATUS:NAME:DD/MM/YYYY:HHMM
  // NAME può contenere lettere, underscore E digit (es. "INTRANSIT1") — visto in produzione.
  const m = tag.match(/^STATUS:([A-Z0-9_]+):(\d{2})\/(\d{2})\/(\d{4}):(\d{2})(\d{2})$/i);
  if (!m) return null;
  const [, name, dd, mm, yyyy, hh, mi] = m;
  const ts = Date.UTC(
    parseInt(yyyy!, 10),
    parseInt(mm!, 10) - 1,
    parseInt(dd!, 10),
    parseInt(hh!, 10),
    parseInt(mi!, 10)
  );
  return {
    name: name!.toUpperCase(),
    date: `${dd}/${mm}/${yyyy}`,
    time: `${hh}:${mi}`,
    raw: tag,
    ts,
  };
}

function extractPickupFromMetafield(rawValue: string): {
  code?: string;
  label?: string;
} {
  // Pattern osservato: "#CODE# Città - Indirizzo Via X..."
  const m = rawValue.match(/^#([A-Z0-9]+)#\s*(.*)$/);
  if (m) {
    return { code: m[1]!.toUpperCase(), label: m[2]!.trim() };
  }
  return { label: rawValue.trim() };
}

// Tokenizza una stringa rimuovendo punteggiatura e parole troppo corte/comuni.
function tokenize(s: string): Set<string> {
  const stopwords = new Set(['di', 'la', 'il', 'lo', 'le', 'i', 'gli', 'a', 'al', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'e', 'o', 'via', 'corso', 'piazza', 'cc', 'cs']);
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9àèéìòù\s]/gi, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !stopwords.has(t))
  );
}

// Riscontro: dato il label/raw del pickup, trova il negozio Zuiki più affine.
// Strategia: scoring per token overlap su (city + name + address), tie-break per city match esatto.
function findMatchingStore(label: string, code?: string): {
  store: ZuikiStore;
  score: number;
} | null {
  if (!label && !code) return null;
  const queryTokens = tokenize(`${label} ${code ?? ''}`);
  if (queryTokens.size === 0) return null;

  let best: { store: ZuikiStore; score: number } | null = null;
  for (const store of ZUIKI_STORES) {
    const storeTokens = tokenize(`${store.city} ${store.name} ${store.address} ${store.region}`);
    let score = 0;
    for (const t of queryTokens) if (storeTokens.has(t)) score++;
    // Bonus sostanziale se la città coincide come token
    const cityTokens = tokenize(store.city);
    for (const t of cityTokens) if (queryTokens.has(t)) score += 2;
    if (best === null || score > best.score) best = { store, score };
  }
  // Soglia minima: almeno 2 token in comune (una città sola conta 2 col bonus, va bene).
  if (!best || best.score < 2) return null;
  return best;
}

export async function getOrderByNameAndEmail(
  env: Env,
  orderNumber: string,
  email: string
): Promise<OrderSummary> {
  const clean = orderNumber.replace(/^#/, '').trim();
  const normEmail = email.trim().toLowerCase();

  const query = `
    query GetOrder($q: String!) {
      orders(first: 1, query: $q) {
        edges {
          node {
            id name email createdAt tags note
            displayFinancialStatus displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            shippingAddress { city country }
            lineItems(first: 20) {
              edges { node { title quantity variant { title } } }
            }
            fulfillments {
              trackingInfo { company number url }
              displayStatus
            }
            metafields(first: 30) {
              edges { node { namespace key value } }
            }
          }
        }
      }
    }`;

  const q = `name:${clean} email:${normEmail}`;
  type Resp = {
    orders: {
      edges: Array<{
        node: {
          name: string;
          email: string | null;
          createdAt: string;
          tags: string[];
          note: string | null;
          displayFinancialStatus: string | null;
          displayFulfillmentStatus: string | null;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
          shippingAddress: { city: string | null; country: string | null } | null;
          lineItems: { edges: Array<{ node: { title: string; quantity: number; variant: { title: string } | null } }> };
          fulfillments: Array<{
            displayStatus: string | null;
            trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }>;
          }>;
          metafields: { edges: Array<{ node: { namespace: string; key: string; value: string } }> };
        };
      }>;
    };
  };

  const data = await shopifyGraphQL<Resp>(env, query, { q });
  const node = data.orders?.edges?.[0]?.node;
  if (!node) return { found: false };

  // Defense in depth: confirm email matches (GraphQL `email:` filter is prefix, not exact).
  if ((node.email ?? '').toLowerCase() !== normEmail) return { found: false };

  // === Pickup detection dal metafield ===
  // Diagnostica: registriamo SEMPRE i metafield e i tag che arrivano da Shopify, così se la
  // detection fallisce in produzione abbiamo evidenza di namespace/key/value reali.
  logger.info('shopify_order_metafields_seen', {
    order: node.name,
    metafield_count: node.metafields.edges.length,
    metafields: node.metafields.edges.map((e) => ({
      ns: e.node.namespace,
      key: e.node.key,
      value_preview: typeof e.node.value === 'string' ? e.node.value.slice(0, 80) : null,
    })),
    tag_count: (node.tags ?? []).length,
    tags_preview: (node.tags ?? []).slice(0, 30),
  });

  // Cerchiamo qualunque metafield la cui key contenga "pickup" (case-insensitive).
  // Match permissivo perché in produzione abbiamo visto varianti (es. "Pickup", "pickup_store", ecc.)
  // e il namespace può variare (custom, app--xxx, shopify, ...).
  const pickupMeta = node.metafields.edges.find((e) => /pickup/i.test(e.node.key));
  let deliveryMethod: 'pickup' | 'home' = 'home';
  let pickupStoreRaw: string | undefined;
  let pickupStoreCode: string | undefined;
  let pickupStoreLabel: string | undefined;
  if (pickupMeta && pickupMeta.node.value && pickupMeta.node.value.trim()) {
    deliveryMethod = 'pickup';
    pickupStoreRaw = pickupMeta.node.value;
    const parsed = extractPickupFromMetafield(pickupStoreRaw);
    pickupStoreCode = parsed.code;
    pickupStoreLabel = parsed.label;
  }

  // Riscontro col catalogo negozi (richiesto esplicitamente: cross-ref con ZUIKI_STORES per
  // dare a Zoe nome ufficiale, indirizzo completo e orari del punto vendita di ritiro).
  let pickupStoreMatch: OrderSummary['pickup_store_match'];
  if (deliveryMethod === 'pickup') {
    const matched = findMatchingStore(pickupStoreLabel ?? pickupStoreRaw ?? '', pickupStoreCode);
    if (matched) {
      pickupStoreMatch = {
        name: matched.store.name,
        region: matched.store.region,
        city: matched.store.city,
        address: matched.store.address,
        tel: matched.store.tel,
        hours_weekday: matched.store.hoursWeekday,
        hours_saturday: matched.store.hoursSat,
        hours_sunday: matched.store.hoursSun,
        match_score: matched.score,
      };
    } else {
      logger.warn('pickup_store_no_match', {
        order: node.name,
        raw: pickupStoreRaw,
        label: pickupStoreLabel,
        code: pickupStoreCode,
      });
    }
  }

  // === Status dai tag STATUS:* ===
  const tags = node.tags ?? [];
  const parsedStatuses: ParsedStatus[] = tags
    .map(parseStatusTag)
    .filter((p): p is ParsedStatus => p !== null)
    .sort((a, b) => a.ts - b.ts);
  const statusHistory = parsedStatuses.map(({ name, date, time, raw }) => ({ name, date, time, raw }));
  // Priorità degli stati TERMINALI sulla cronologia: in produzione abbiamo visto casi in cui
  // dopo DELIVERED arrivano tag "stale" (es. DELIVERING fired in ritardo dal carrier). Una volta
  // che un ordine è consegnato/ritirato/annullato, quello stato deve "vincere" come latest_status
  // anche se cronologicamente non è l'ultimo. Stessa logica per pickup (PICKED_UP) e CANCELLED.
  const TERMINAL_STATUSES = ['DELIVERED', 'PICKED_UP', 'CANCELLED'] as const;
  const terminalHit = parsedStatuses.find((s) => (TERMINAL_STATUSES as readonly string[]).includes(s.name));
  const latestStatus = terminalHit
    ? { name: terminalHit.name, date: terminalHit.date, time: terminalHit.time, raw: terminalHit.raw }
    : (parsedStatuses.length > 0 ? statusHistory[statusHistory.length - 1] : undefined);

  return {
    found: true,
    order_number: node.name,
    created_at: node.createdAt,
    financial_status: node.displayFinancialStatus ?? undefined,
    fulfillment_status: node.displayFulfillmentStatus ?? undefined,
    total: node.totalPriceSet?.shopMoney ?? undefined,
    shipping_city: node.shippingAddress?.city ?? undefined,
    shipping_country: node.shippingAddress?.country ?? undefined,
    items: node.lineItems.edges.map((e) => ({
      title: e.node.title,
      quantity: e.node.quantity,
      variant: e.node.variant?.title ?? null,
    })),
    // Per pickup il tracking è sempre vuoto (gestione interna), ma includiamo lo status del fulfillment se presente.
    tracking: deliveryMethod === 'pickup'
      ? []
      : node.fulfillments.flatMap((f) =>
          f.trackingInfo.map((t) => ({
            company: t.company ?? undefined,
            number: t.number ?? undefined,
            url: t.url ?? undefined,
            status: f.displayStatus ?? undefined,
          }))
        ),
    delivery_method: deliveryMethod,
    pickup_store_raw: pickupStoreRaw,
    pickup_store_code: pickupStoreCode,
    pickup_store_label: pickupStoreLabel,
    pickup_store_match: pickupStoreMatch,
    status_history: statusHistory,
    latest_status: latestStatus,
    tags,
    note: node.note ?? undefined,
    rma_number: (node.note?.match(/RMA-\d+/)?.[0]) ?? undefined,
  };
}

export interface ProductSearchResult {
  products: Array<{
    title: string;
    handle: string;
    url: string | null;
    inventory: number | null;
    price?: { amount: string; currencyCode: string };
    image?: string | null;
  }>;
}

export async function searchProducts(env: Env, q: string, limit = 5): Promise<ProductSearchResult> {
  const gql = `
    query SearchProducts($q: String!, $first: Int!) {
      products(first: $first, query: $q) {
        edges {
          node {
            title handle onlineStoreUrl totalInventory
            priceRangeV2 { minVariantPrice { amount currencyCode } }
            featuredImage { url }
          }
        }
      }
    }`;
  type Resp = {
    products: {
      edges: Array<{
        node: {
          title: string;
          handle: string;
          onlineStoreUrl: string | null;
          totalInventory: number | null;
          priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } } | null;
          featuredImage: { url: string } | null;
        };
      }>;
    };
  };

  const mapResult = (data: Resp): ProductSearchResult => ({
    products: data.products.edges.map((e) => ({
      title: e.node.title,
      handle: e.node.handle,
      url: e.node.onlineStoreUrl,
      inventory: e.node.totalInventory,
      price: e.node.priceRangeV2?.minVariantPrice,
      image: e.node.featuredImage?.url ?? null,
    })),
  });

  // Admin API restituisce anche prodotti in Bozza — aggiungi sempre status:active.
  const activeQ = q.includes('status:') ? q : `${q} status:active`;

  // Prima prova ricerca testuale normale.
  const data = await shopifyGraphQL<Resp>(env, gql, { q: activeQ, first: limit });
  if (data.products.edges.length > 0) return mapResult(data);

  // Se 0 risultati e la query sembra uno SKU (es. "Z8401GI", "B6E211TS"),
  // riprova con filtro sku: che cerca sulle varianti del prodotto.
  if (/^[A-Z0-9]{5,12}$/i.test(q.trim())) {
    // Tentativo 1: SKU esatto sulle varianti.
    const skuExact = await shopifyGraphQL<Resp>(env, gql, { q: `sku:${q.trim().toUpperCase()} status:active`, first: limit });
    if (skuExact.products.edges.length > 0) return mapResult(skuExact);
    // Tentativo 2: prefisso SKU (cattura varianti con suffissi tipo -S-MIL, -M-BIA).
    // Solo se il codice base (senza numeri finali) è più corto della query originale.
    const skuBase = q.trim().replace(/\d+[A-Z]{2}$/i, '').toUpperCase(); // es. B6E199TS → B6E199
    if (skuBase.length > 3 && skuBase !== q.trim().toUpperCase()) {
      const skuPrefix = await shopifyGraphQL<Resp>(env, gql, { q: `sku:${skuBase} status:active`, first: limit });
      if (skuPrefix.products.edges.length > 0) return mapResult(skuPrefix);
    }
  }

  return mapResult(data);
}

export interface ProductDetail {
  found: boolean;
  title?: string;
  handle?: string;
  url?: string | null;
  description?: string;
  total_inventory?: number | null;
  price_range?: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  } | null;
  variants?: Array<{
    title: string;
    available: boolean;
    inventory: number | null;
    price: string;
    barcode: string | null;
  }>;
}

export async function getProductByHandle(env: Env, handle: string): Promise<ProductDetail> {
  const query = `
    query GetProduct($handle: String!) {
      productByHandle(handle: $handle) {
        title handle onlineStoreUrl description totalInventory status
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 50) {
          edges { node { title availableForSale inventoryQuantity price barcode } }
        }
      }
    }`;
  type Resp = {
    productByHandle: {
      title: string;
      handle: string;
      onlineStoreUrl: string | null;
      description: string;
      totalInventory: number | null;
      status: string;
      priceRangeV2: ProductDetail['price_range'];
      variants: {
        edges: Array<{
          node: { title: string; availableForSale: boolean; inventoryQuantity: number | null; price: string; barcode: string | null };
        }>;
      };
    } | null;
  };
  const data = await shopifyGraphQL<Resp>(env, query, { handle });
  let p = data.productByHandle;

  // Prodotti in Bozza (DRAFT) o Archiviati (ARCHIVED): trattali come non trovati.
  if (p && p.status !== 'ACTIVE') p = null;

  // Fallback: se l'handle diretto fallisce (handle con suffisso nome prodotto),
  // prova a trovare il prodotto cercando per sku: (handle spesso è il codice SKU).
  if (!p) {
    const skuUpper = handle.toUpperCase();
    const skuQuery = `
      query SearchBySku($q: String!) {
        products(first: 1, query: $q) {
          edges { node {
            title handle onlineStoreUrl description totalInventory
            priceRangeV2 {
              minVariantPrice { amount currencyCode }
              maxVariantPrice { amount currencyCode }
            }
            variants(first: 50) {
              edges { node { title availableForSale inventoryQuantity price barcode } }
            }
          }}
        }
      }`;
    type SkuResp = { products: { edges: Array<{ node: typeof p }> } };
    const skuData = await shopifyGraphQL<SkuResp>(env, skuQuery, { q: `sku:${skuUpper} status:active` });
    p = skuData.products.edges[0]?.node ?? null;
  }

  if (!p) return { found: false };
  return {
    found: true,
    title: p.title,
    handle: p.handle,
    url: p.onlineStoreUrl,
    description: p.description,
    total_inventory: p.totalInventory,
    price_range: p.priceRangeV2,
    variants: p.variants.edges.map((e) => ({
      title: e.node.title,
      available: e.node.availableForSale,
      inventory: e.node.inventoryQuantity,
      price: e.node.price,
      barcode: e.node.barcode,
    })),
  };
}

// ─── BETA: tipi e funzioni arricchite ────────────────────────────────────────

export interface VariantEnriched {
  title: string;
  sku: string;
  barcode: string | null;
  available: boolean;
  inventory: number | null;
  inventory_policy: string;
  price: string;
  options: Record<string, string>;
}

export interface ProductDetailEnriched {
  found: boolean;
  title?: string;
  handle?: string;
  url?: string | null;
  description?: string;
  total_inventory?: number | null;
  product_type?: string;
  vendor?: string;
  tags?: string[];
  price_range?: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  } | null;
  options_available?: Record<string, string[]>;
  variants?: VariantEnriched[];
}

export async function getProductByHandleEnriched(env: Env, handle: string): Promise<ProductDetailEnriched> {
  const query = `
    query GetProductEnriched($handle: String!) {
      productByHandle(handle: $handle) {
        title handle onlineStoreUrl description totalInventory status
        productType vendor tags
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        options { name values }
        variants(first: 100) {
          edges { node {
            title sku barcode availableForSale inventoryQuantity price
            inventoryPolicy
            selectedOptions { name value }
          }}
        }
      }
    }`;

  type VariantNode = {
    title: string; sku: string; barcode: string | null;
    availableForSale: boolean; inventoryQuantity: number | null;
    price: string; inventoryPolicy: string;
    selectedOptions: Array<{ name: string; value: string }>;
  };
  type PNode = {
    title: string; handle: string; onlineStoreUrl: string | null;
    description: string; totalInventory: number | null; status: string;
    productType: string; vendor: string; tags: string[];
    priceRangeV2: ProductDetailEnriched['price_range'];
    options: Array<{ name: string; values: string[] }>;
    variants: { edges: Array<{ node: VariantNode }> };
  };
  type Resp = { productByHandle: PNode | null };

  const data = await shopifyGraphQL<Resp>(env, query, { handle });
  let p = data.productByHandle;
  if (p && p.status !== 'ACTIVE') p = null;

  if (!p) {
    const skuUpper = handle.toUpperCase();
    const skuQuery = `
      query SearchBySkuEnriched($q: String!) {
        products(first: 1, query: $q) {
          edges { node {
            title handle onlineStoreUrl description totalInventory
            productType vendor tags
            priceRangeV2 {
              minVariantPrice { amount currencyCode }
              maxVariantPrice { amount currencyCode }
            }
            options { name values }
            variants(first: 100) {
              edges { node {
                title sku barcode availableForSale inventoryQuantity price
                inventoryPolicy
                selectedOptions { name value }
              }}
            }
          }}
        }
      }`;
    type SkuResp = { products: { edges: Array<{ node: PNode | null }> } };
    const skuData = await shopifyGraphQL<SkuResp>(env, skuQuery, { q: `sku:${skuUpper} status:active` });
    p = skuData.products.edges[0]?.node ?? null;
  }

  if (!p) return { found: false };

  const optionsAvailable: Record<string, string[]> = {};
  for (const opt of p.options) optionsAvailable[opt.name] = opt.values;

  return {
    found: true,
    title: p.title,
    handle: p.handle,
    url: p.onlineStoreUrl,
    description: p.description,
    total_inventory: p.totalInventory,
    product_type: p.productType,
    vendor: p.vendor,
    tags: p.tags,
    price_range: p.priceRangeV2,
    options_available: optionsAvailable,
    variants: p.variants.edges.map((e) => ({
      title: e.node.title,
      sku: e.node.sku,
      barcode: e.node.barcode,
      available: e.node.availableForSale,
      inventory: e.node.inventoryQuantity,
      inventory_policy: e.node.inventoryPolicy,
      price: e.node.price,
      options: Object.fromEntries(e.node.selectedOptions.map((o) => [o.name, o.value])),
    })),
  };
}

export interface ProductSearchItemBeta {
  title: string;
  handle: string;
  url: string | null;
  product_type: string;
  image: string | null;
  price_min: string;
  options_available: Record<string, string[]>;
  variants: Array<{
    sku: string;
    barcode: string | null;
    available: boolean;
    inventory: number | null;
    price: string;
    options: Record<string, string>;
  }>;
}

export interface ProductSearchResultBeta {
  products: ProductSearchItemBeta[];
}

export async function searchProductsBeta(
  env: Env,
  query: string,
  opts: { color?: string; size?: string; product_type?: string; tag?: string; limit?: number } = {}
): Promise<ProductSearchResultBeta> {
  const { color, size, product_type, tag, limit = 5 } = opts;

  const parts: string[] = [];
  if (query.trim()) parts.push(query.trim());
  if (product_type) parts.push(`product_type:"${product_type}"`);
  if (tag) parts.push(`tag:${tag}`);
  const qStr = parts.join(' ');
  const activeQ = qStr.includes('status:') ? qStr : `${qStr} status:active`.trim();

  const gql = `
    query SearchProductsBeta($q: String!, $first: Int!) {
      products(first: $first, query: $q) {
        edges { node {
          title handle onlineStoreUrl productType
          featuredImage { url }
          priceRangeV2 { minVariantPrice { amount currencyCode } }
          options { name values }
          variants(first: 100) {
            edges { node {
              sku barcode availableForSale inventoryQuantity price
              selectedOptions { name value }
            }}
          }
        }}
      }
    }`;

  type VNode = {
    sku: string; barcode: string | null;
    availableForSale: boolean; inventoryQuantity: number | null; price: string;
    selectedOptions: Array<{ name: string; value: string }>;
  };
  type Resp = {
    products: { edges: Array<{ node: {
      title: string; handle: string; onlineStoreUrl: string | null; productType: string;
      featuredImage: { url: string } | null;
      priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } } | null;
      options: Array<{ name: string; values: string[] }>;
      variants: { edges: Array<{ node: VNode }> };
    }}> };
  };

  const data = await shopifyGraphQL<Resp>(env, gql, { q: activeQ, first: 100 });

  let items: ProductSearchItemBeta[] = data.products.edges.map((e) => {
    const n = e.node;
    const optionsAvailable: Record<string, string[]> = {};
    for (const opt of n.options) optionsAvailable[opt.name] = opt.values;
    return {
      title: n.title,
      handle: n.handle,
      url: n.onlineStoreUrl,
      product_type: n.productType,
      image: n.featuredImage?.url ?? null,
      price_min: n.priceRangeV2?.minVariantPrice.amount ?? '',
      options_available: optionsAvailable,
      variants: n.variants.edges.map((ve) => ({
        sku: ve.node.sku,
        barcode: ve.node.barcode,
        available: ve.node.availableForSale,
        inventory: ve.node.inventoryQuantity,
        price: ve.node.price,
        options: Object.fromEntries(ve.node.selectedOptions.map((o) => [o.name, o.value])),
      })),
    };
  });

  if (color) {
    const colorLower = color.toLowerCase().trim();
    items = items.filter((item) =>
      (item.options_available['Colore'] ?? item.options_available['Color'] ?? [])
        .some((c) => c.toLowerCase().includes(colorLower))
    );
  }

  if (size) {
    const sizeLower = size.toLowerCase().trim();
    items = items.filter((item) =>
      item.variants.some(
        (v) =>
          v.available &&
          ((v.options['Taglia'] ?? v.options['Size'] ?? '').toLowerCase() === sizeLower ||
           (v.options['Taglia'] ?? v.options['Size'] ?? '').toLowerCase().includes(sizeLower))
      )
    );
  }

  return { products: items.slice(0, limit) };
}
