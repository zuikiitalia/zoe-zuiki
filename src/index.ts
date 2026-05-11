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
  const hform = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
  const hjson = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Kohana legge $_POST solo da form-urlencoded (non JSON): proviamo prima form-encoded
  function fe(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  const attempts: Array<{ name: string; method: string; url: string; headers?: Record<string,string>; body?: string }> = [
    // === FORM-ENCODED (Kohana $_POST) ===
    { name: 'FORM token only', method: 'POST', url, headers: hform,
      body: fe({ token }) },
    { name: 'FORM barcode+store', method: 'POST', url, headers: hform,
      body: fe({ token, barcode, store }) },
    { name: 'FORM barcode+negozio', method: 'POST', url, headers: hform,
      body: fe({ token, barcode, negozio: store }) },
    { name: 'FORM barcode+cod_negozio', method: 'POST', url, headers: hform,
      body: fe({ token, barcode, cod_negozio: store }) },
    { name: 'FORM barcode+punto_vendita', method: 'POST', url, headers: hform,
      body: fe({ token, barcode, punto_vendita: store }) },
    { name: 'FORM ean+negozio', method: 'POST', url, headers: hform,
      body: fe({ token, ean: barcode, negozio: store }) },
    { name: 'FORM codice_barre+negozio', method: 'POST', url, headers: hform,
      body: fe({ token, codice_barre: barcode, negozio: store }) },
    { name: 'FORM articolo+negozio', method: 'POST', url, headers: hform,
      body: fe({ token, articolo: barcode, negozio: store }) },
    // Forse array PHP: barcode[]=... negozi[]=...
    { name: 'FORM barcodes[]+negozi[]', method: 'POST', url, headers: hform,
      body: `token=${encodeURIComponent(token)}&barcodes[]=${encodeURIComponent(barcode)}&negozi[]=${encodeURIComponent(store)}` },
    { name: 'FORM articoli[]+negozi[]', method: 'POST', url, headers: hform,
      body: `token=${encodeURIComponent(token)}&articoli[]=${encodeURIComponent(barcode)}&negozi[]=${encodeURIComponent(store)}` },
    // GET con query string
    { name: 'GET query barcode+store', method: 'GET',
      url: `${url}?token=${encodeURIComponent(token)}&barcode=${encodeURIComponent(barcode)}&store=${encodeURIComponent(store)}` },
    { name: 'GET query ean+negozio', method: 'GET',
      url: `${url}?token=${encodeURIComponent(token)}&ean=${encodeURIComponent(barcode)}&negozio=${encodeURIComponent(store)}` },
    // === JSON (php://input) fallback ===
    { name: 'JSON barcode+store', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, barcode, store }) },
    { name: 'JSON barcode+negozio', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, barcode, negozio: store }) },
    { name: 'JSON articoli[]+negozi[]', method: 'POST', url, headers: hjson,
      body: JSON.stringify({ token, articoli: [barcode], negozi: [store] }) },
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
