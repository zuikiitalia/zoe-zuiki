export interface Env {
  ZOE_KV: KVNamespace;
  ANTHROPIC_API_KEY: string;
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_CLIENT_SECRET: string;
  SHOPIFY_SHOP_DOMAIN: string;
  SPOKI_API_KEY: string;
  SPOKI_PRIVATE_TOKEN?: string;
  WEBHOOK_SECRET: string;
  TEAM_EMAIL: string;
  WHATSAPP_NUMBER: string;
  // CSV di numeri in formato E.164 (es. "+393349445282,+393385964641").
  // Se presente e non vuota, Zoe risponde SOLO a questi numeri (modalità test/restricted).
  // Se assente o vuota, Zoe risponde a tutti.
  ALLOWLIST_PHONES?: string;
}

export const CLAUDE_MODEL = 'claude-sonnet-4-6';
export const CLAUDE_MAX_TOKENS = 1024;
export const MAX_HISTORY_MESSAGES = 20;
export const CONVERSATION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const RATE_LIMIT_TTL_SECONDS = 60 * 60;
export const RATE_LIMIT_MAX_PER_HOUR = 30;
export const MAX_TOOL_ITERATIONS = 5;
export const INTER_MESSAGE_DELAY_MS = 800;
export const SHOPIFY_API_VERSION = '2025-01';
export const SHOPIFY_OAUTH_SCOPES =
  'read_orders,read_all_orders,read_customers,read_products,read_inventory,read_fulfillments,read_draft_orders';
