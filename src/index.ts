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
