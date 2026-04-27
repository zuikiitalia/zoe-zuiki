import type { Context } from 'hono';
import type { Env } from '../config';
import { SHOPIFY_OAUTH_SCOPES } from '../config';
import { getShopifyAccessToken, setOAuthState } from '../storage/kvStore';
import { generateRandomHex } from '../utils/security';
import { logger } from '../utils/logger';

export async function handleShopifyInstall(c: Context<{ Bindings: Env }>): Promise<Response> {
  const existing = await getShopifyAccessToken(c.env.ZOE_KV);
  if (existing) return c.json({ status: 'already installed' });

  if (!c.env.SHOPIFY_CLIENT_ID || !c.env.SHOPIFY_SHOP_DOMAIN) {
    return c.json({ error: 'missing_shopify_config' }, 500);
  }

  const state = generateRandomHex(16);
  await setOAuthState(c.env.ZOE_KV, state);

  const origin = new URL(c.req.url).origin;
  const redirectUri = `${origin}/shopify/callback`;

  // Nessun grant_options[]=per-user: vogliamo un offline token permanente.
  const params = new URLSearchParams({
    client_id: c.env.SHOPIFY_CLIENT_ID,
    scope: SHOPIFY_OAUTH_SCOPES,
    redirect_uri: redirectUri,
    state,
  });

  const authUrl = `https://${c.env.SHOPIFY_SHOP_DOMAIN}/admin/oauth/authorize?${params.toString()}`;
  logger.info('shopify_install_redirect', { redirect_uri: redirectUri });
  return c.redirect(authUrl, 302);
}
