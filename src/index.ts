import { Hono } from 'hono';
import type { Env } from './config';
import { handleSpokiWebhook } from './handlers/spokiWebhook';
import { handleShopifyInstall } from './handlers/shopifyInstall';
import { handleShopifyCallback } from './handlers/shopifyCallback';
import { logger } from './utils/logger';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.post('/webhook/spoki', handleSpokiWebhook);
app.get('/shopify/install', handleShopifyInstall);
app.get('/shopify/callback', handleShopifyCallback);

// Endpoint temporaneo per scoprire l'API Siacloud
app.get('/debug/siacloud-discover', async (c) => {
  const base = 'http://serviceszuiki.siacloud.com:8012';
  const token = '36assd671ca452214bdcc0';
  const barcode = '1010000436326';
  const store = 'PFRAN';

  const url = `${base}/siacloudhelper/inventory`;
  const hjson = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const attempts: Array<{ name: string; method: string; url: string; headers?: Record<string,string>; body?: string }> = [
    // POST normale (creazione/scrittura) con vari parametri
    { name: 'POST minimal token', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token }) },
    { name: 'POST con shop_id', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, shop_id: store, barcode }) },
    { name: 'POST con magazzino', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, magazzino: store, barcode }) },
    { name: 'POST con punto_vendita', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, punto_vendita: store, barcode }) },
    { name: 'POST cod_negozio', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, cod_negozio: store, barcode }) },
    // Forse barcode/store come numeri o oggetti
    { name: 'POST barcode num', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, barcodes: [Number(barcode)], stores: [store] }) },
    { name: 'POST nested map', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, query: { [barcode]: [store] } }) },
    // Forse vuole la lista dei prodotti come campo specifico Siacloud
    { name: 'POST articoli/negozi', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, articoli: [barcode], negozi: [store] }) },
    { name: 'POST eans/punti_vendita', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, eans: [barcode], punti_vendita: [store] }) },
    // Forse il "store" non è "PFRAN" ma un id numerico, e PFRAN è un codice diverso
    { name: 'POST barcode + storeCode', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, barcode, storeCode: store }) },
    { name: 'POST barcode + store_code', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, barcode, store_code: store }) },
    // Override GET con varie struttuari
    { name: 'override GET singular', method: 'POST', url, headers: { ...hjson, 'X-HTTP-Method-Override': 'GET' },
      body: JSON.stringify({ token, barcode, store }) },
    { name: 'override GET shop_id', method: 'POST', url, headers: { ...hjson, 'X-HTTP-Method-Override': 'GET' },
      body: JSON.stringify({ token, shop_id: store, barcode }) },
  ];

  const results = [];
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, {
        method: a.method,
        headers: a.headers,
        body: a.body,
        signal: AbortSignal.timeout(6000),
      });
      const text = await res.text();
      // Estrai messaggio errore Kohana: cerca DOPO </style> e prima del backtrace
      let preview = '';
      const afterStyle = text.split('</style>')[1] ?? text;
      const beforeBacktrace = afterStyle.split(/Stack trace|Backtrace|Loaded in|Included files/i)[0] ?? afterStyle;
      // Cerca il messaggio principale: titolo della h1 prima del backtrace
      preview = beforeBacktrace
        .replace(/<style[\s\S]*?<\/style>/g, '')
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });
      results.push({
        name: a.name, status: res.status,
        body_length: text.length,
        body_full: text.slice(0, 500),
        headers: respHeaders,
        body_preview: preview,
        is_json: /^[\s]*[{[]/.test(text),
        has_target_data: text.includes('"1010000436326"') || text.includes('"OK"'),
      });
    } catch (e) {
      results.push({ name: a.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json({ results });
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  logger.error('unhandled_error', {
    message: err.message,
    stack: err.stack?.slice(0, 500),
  });
  return c.json({ error: 'internal_error' }, 500);
});

// Cron job ogni 30 min: pinga lo HF Space FashionCLIP per evitare cold start.
async function scheduled(env: Env): Promise<void> {
  if (!env.HF_SPACE_URL) return;
  try {
    await fetch(`${env.HF_SPACE_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ping' }),
      signal: AbortSignal.timeout(10000),
    });
    logger.info('space_keepalive_ok', {});
  } catch {
    logger.warn('space_keepalive_failed', {});
  }
}

// Esporta sia fetch+scheduled (Cloudflare Workers) sia request (test Hono).
export default Object.assign(
  { fetch: app.fetch, scheduled: (_event: ScheduledEvent, env: Env) => scheduled(env) },
  { request: app.request.bind(app) }
);
