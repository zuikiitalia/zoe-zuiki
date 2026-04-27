import type { Context } from 'hono';
import type { Env } from '../config';
import { verifyShopifyHmac } from '../utils/security';
import { consumeOAuthState, setShopifyAccessToken } from '../storage/kvStore';
import { logger } from '../utils/logger';

export async function handleShopifyCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const params = new URL(c.req.url).searchParams;

  const hmacOk = await verifyShopifyHmac(params, c.env.SHOPIFY_CLIENT_SECRET);
  if (!hmacOk) {
    logger.warn('shopify_callback_bad_hmac');
    return c.text('Invalid HMAC', 401);
  }

  const state = params.get('state');
  if (!state || !(await consumeOAuthState(c.env.ZOE_KV, state))) {
    logger.warn('shopify_callback_bad_state');
    return c.text('Invalid state', 400);
  }

  const code = params.get('code');
  const shop = params.get('shop');
  if (!code || !shop) return c.text('Missing code or shop', 400);

  if (shop !== c.env.SHOPIFY_SHOP_DOMAIN) {
    logger.warn('shopify_callback_shop_mismatch', { shop });
    return c.text('Shop mismatch', 400);
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.SHOPIFY_CLIENT_ID,
      client_secret: c.env.SHOPIFY_CLIENT_SECRET,
      code,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    logger.error('shopify_token_exchange_failed', {
      status: tokenRes.status,
      body: body.slice(0, 500),
    });
    return c.text('Token exchange failed', 500);
  }

  const tokenJson = (await tokenRes.json()) as { access_token: string; scope: string };
  await setShopifyAccessToken(c.env.ZOE_KV, tokenJson.access_token);
  logger.info('shopify_installed', { scope: tokenJson.scope });

  return c.html(
    `<!DOCTYPE html>
<html lang="it">
<head><meta charset="utf-8"><title>Zoe — Installazione completata</title></head>
<body style="font-family: system-ui, -apple-system, sans-serif; padding: 40px; text-align: center;">
  <h1>✅ Installazione completata</h1>
  <p>Puoi chiudere questa pagina.</p>
</body>
</html>`
  );
}
