import { Hono } from 'hono';
import type { Env } from './config';
import { handleSpokiWebhook } from './handlers/spokiWebhook';
import { handleShopifyInstall } from './handlers/shopifyInstall';
import { handleShopifyCallback } from './handlers/shopifyCallback';
import { handleDashboardHTML, handleDashboardAPI } from './handlers/dashboard';
import { runDailyReview } from './analytics/dailyReview';
import { logger } from './utils/logger';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.post('/webhook/spoki', handleSpokiWebhook);
app.get('/shopify/install', handleShopifyInstall);
app.get('/shopify/callback', handleShopifyCallback);
app.get('/dashboard', handleDashboardHTML);
app.get('/dashboard/api/*', handleDashboardAPI);
app.post('/dashboard/api/*', handleDashboardAPI);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  logger.error('unhandled_error', {
    message: err.message,
    stack: err.stack?.slice(0, 500),
  });
  return c.json({ error: 'internal_error' }, 500);
});

// Cron jobs:
// - "*/30 * * * *" (ogni 30 min): keep-alive HF Space FashionCLIP
// - "0 22 * * *" (giornaliero alle 22:00 UTC): review qualità conversazioni
async function scheduled(event: ScheduledEvent, env: Env): Promise<void> {
  if (event.cron === '0 22 * * *') {
    if (!env.ZOE_DB || !env.ANTHROPIC_API_KEY) {
      logger.warn('daily_review_skipped', { reason: 'missing_bindings' });
      return;
    }
    try {
      const result = await runDailyReview(env.ZOE_DB, env.ANTHROPIC_API_KEY);
      logger.info('daily_review_ok', result);
    } catch (err) {
      logger.error('daily_review_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Default: keep-alive HF Space.
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
  { fetch: app.fetch, scheduled: (event: ScheduledEvent, env: Env) => scheduled(event, env) },
  { request: app.request.bind(app) }
);
