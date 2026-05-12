import {
  MAX_HISTORY_MESSAGES,
  CONVERSATION_TTL_SECONDS,
  RATE_LIMIT_TTL_SECONDS,
  RATE_LIMIT_MAX_PER_HOUR,
} from '../config';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

interface ConversationBlob {
  messages: StoredMessage[];
  lastActivity: number;
}

export async function loadConversation(kv: KVNamespace, phone: string): Promise<StoredMessage[]> {
  const blob = await kv.get<ConversationBlob>(`conversation:${phone}`, 'json');
  return blob?.messages ?? [];
}

export async function saveConversation(
  kv: KVNamespace,
  phone: string,
  messages: StoredMessage[]
): Promise<void> {
  const truncated = messages.slice(-MAX_HISTORY_MESSAGES);
  const blob: ConversationBlob = { messages: truncated, lastActivity: Date.now() };
  await kv.put(`conversation:${phone}`, JSON.stringify(blob), {
    expirationTtl: CONVERSATION_TTL_SECONDS,
  });
}

export async function getShopifyAccessToken(kv: KVNamespace): Promise<string | null> {
  return kv.get('shopify:access_token');
}

export async function setShopifyAccessToken(kv: KVNamespace, token: string): Promise<void> {
  await kv.put('shopify:access_token', token);
}

export async function setOAuthState(kv: KVNamespace, state: string): Promise<void> {
  await kv.put(`oauth:state:${state}`, '1', { expirationTtl: 600 });
}

export async function consumeOAuthState(kv: KVNamespace, state: string): Promise<boolean> {
  const key = `oauth:state:${state}`;
  const val = await kv.get(key);
  if (!val) return false;
  await kv.delete(key);
  return true;
}

export async function checkAndIncrementRateLimit(kv: KVNamespace, phone: string): Promise<boolean> {
  const key = `rate_limit:${phone}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= RATE_LIMIT_MAX_PER_HOUR) return false;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_TTL_SECONDS });
  return true;
}

// === Detection operatore umano attivo ===
// Strategia: ogni volta che Zoe manda un messaggio, salviamo un hash del testo
// in KV (lista degli ultimi 10 invii, TTL 5 min). Quando Spoki fa il webhook
// di un messaggio OUTBOUND, confrontiamo l'hash: se NON è un eco di Zoe
// → l'ha mandato un operatore umano → settiamo human_active per 24h, durante
// cui Zoe non risponde più al cliente.

const HUMAN_ACTIVE_TTL = 60 * 60 * 24; // 24h
const ZOE_SENT_TTL = 60 * 10;           // 10 min: copre eventuali ritardi/retry webhook

interface ZoeSentEntry { hash: string; ts: number }

function quickHash(s: string): string {
  // FNV-1a 32-bit: deterministico, veloce, sufficiente per dedup.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function hashMessageText(text: string): string {
  // Normalizza prima dell'hash: spazi multipli, trim.
  return quickHash(text.replace(/\s+/g, ' ').trim());
}

export async function recordZoeSent(
  kv: KVNamespace,
  phone: string,
  text: string,
  spokiMessageId?: string | null
): Promise<void> {
  const key = `zoe_sent:${phone}`;
  const raw = await kv.get<ZoeSentEntry[]>(key, 'json');
  const list = Array.isArray(raw) ? raw : [];
  list.push({ hash: hashMessageText(text), ts: Date.now() });
  const trimmed = list.slice(-10);
  await kv.put(key, JSON.stringify(trimmed), { expirationTtl: ZOE_SENT_TTL });
  // ID deterministico restituito da Spoki sull'invio: il webhook outbound porta
  // lo stesso ID, quindi il match è certo (non probabilistico né basato sul tempo).
  if (spokiMessageId) {
    await kv.put(`zoe_msg_id:${spokiMessageId}`, '1', { expirationTtl: ZOE_SENT_TTL });
  }
}

export async function isOurOutboundEcho(
  kv: KVNamespace,
  phone: string,
  text: string,
  spokiMessageId?: string | null
): Promise<boolean> {
  // Match deterministico per ID Spoki (se presente nel webhook).
  if (spokiMessageId) {
    const found = await kv.get(`zoe_msg_id:${spokiMessageId}`);
    if (found) return true;
  }
  // Fallback per hash testo (utile se l'ID non è disponibile o se il webhook arriva
  // prima della propagazione KV: l'hash è già scritto comunque).
  const key = `zoe_sent:${phone}`;
  const raw = await kv.get<ZoeSentEntry[]>(key, 'json');
  const list = Array.isArray(raw) ? raw : [];
  const target = hashMessageText(text);
  return list.some(e => e.hash === target);
}

export async function markHumanActive(kv: KVNamespace, phone: string): Promise<void> {
  await kv.put(`human_active:${phone}`, String(Date.now()), { expirationTtl: HUMAN_ACTIVE_TTL });
}

export async function isHumanActive(kv: KVNamespace, phone: string): Promise<boolean> {
  return (await kv.get(`human_active:${phone}`)) !== null;
}

export async function clearHumanActive(kv: KVNamespace, phone: string): Promise<void> {
  await kv.delete(`human_active:${phone}`);
}
