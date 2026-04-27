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

export default app;
