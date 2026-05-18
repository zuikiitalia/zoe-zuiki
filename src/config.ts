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
  ALLOWLIST_PHONES?: string;
  BETA_PHONES?: string;
  HF_SPACE_URL?: string;
  AI?: Ai;
  PRODUCT_VECTORS?: VectorizeIndex;
  // D1 database per analytics (conversazioni, token, costi, sentiment).
  ZOE_DB?: D1Database;
  // Password per accedere alla dashboard (Bearer token).
  DASHBOARD_SECRET?: string;
  // Chiave segreta per l'endpoint /api/investigate (debug conversazioni).
  INVESTIGATE_KEY?: string;
  // RichReturns API key — se non configurata, Zoe usa il comportamento statico per i resi.
  RICHRETURNS_API_KEY?: string;
}

export const CLAUDE_MODEL = 'claude-opus-4-7';
export const CLAUDE_MAX_TOKENS = 1024;
export const MAX_HISTORY_MESSAGES = 20;
// Messaggi inviati a Claude: D1 carica la storia completa ma mandiamo solo gli ultimi N.
// Evita timeout e limiti token su conversazioni lunghe (cliente con mesi di chat).
export const MAX_CLAUDE_HISTORY_MESSAGES = 80;
export const CONVERSATION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const RATE_LIMIT_TTL_SECONDS = 60 * 60;
export const RATE_LIMIT_MAX_PER_HOUR = 30;
export const MAX_TOOL_ITERATIONS = 5;
export const INTER_MESSAGE_DELAY_MS = 800;
export const SHOPIFY_API_VERSION = '2025-01';
export const SHOPIFY_OAUTH_SCOPES =
  'read_orders,read_all_orders,read_customers,read_products,read_inventory,read_fulfillments,read_draft_orders';
