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
