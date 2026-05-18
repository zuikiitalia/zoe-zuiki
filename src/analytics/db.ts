import type { D1Database } from '@cloudflare/workers-types';
import { computeCostUsd } from './costs';

// Genera un ID stabile per la conversazione: hash(phone) + '_' + firstMessageTs.
// phone_hash è SHA-256 troncato a 16 hex per privacy.
export async function phoneHash(phone: string): Promise<string> {
  const enc = new TextEncoder().encode(phone);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 16);
}

export async function getOrCreateConvId(db: D1Database, phone: string, firstTs: number): Promise<string> {
  const hash = await phoneHash(phone);
  return `${hash}_${firstTs}`;
}

export interface ApiCallData {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
  iteration: number;
  stopReason: string;
}

export interface ToolCallData {
  toolName: string;
  success: boolean;
  inputJson?: string;
  outputJson?: string;
  durationMs?: number;
}

export interface ConversationUpdate {
  convId: string;
  phoneHash: string;
  phoneFull?: string | null;
  firstTs: number;
  lastTs: number;
  userTurns: number;
  assistantTurns: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCostUsd?: number;
  ticketId?: string | null;
  ticketCategory?: string | null;
  ticketReason?: string | null;
  ticketUrgency?: string | null;
}

export async function upsertConversation(db: D1Database, data: ConversationUpdate): Promise<void> {
  await db.prepare(`
    INSERT INTO conversations
      (id, phone_hash, phone_full, first_ts, last_ts, user_turns, assistant_turns,
       total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cost_usd,
       ticket_id, ticket_category, ticket_reason, ticket_urgency, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      last_ts = excluded.last_ts,
      user_turns = excluded.user_turns,
      assistant_turns = excluded.assistant_turns,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read_tokens = excluded.total_cache_read_tokens,
      total_cost_usd = excluded.total_cost_usd,
      phone_full = COALESCE(excluded.phone_full, conversations.phone_full),
      ticket_id = COALESCE(excluded.ticket_id, conversations.ticket_id),
      ticket_category = COALESCE(excluded.ticket_category, conversations.ticket_category),
      ticket_reason = COALESCE(excluded.ticket_reason, conversations.ticket_reason),
      ticket_urgency = COALESCE(excluded.ticket_urgency, conversations.ticket_urgency),
      updated_at = excluded.updated_at
  `).bind(
    data.convId, data.phoneHash, data.phoneFull ?? null, data.firstTs, data.lastTs,
    data.userTurns, data.assistantTurns,
    data.totalInputTokens, data.totalOutputTokens, data.totalCacheReadTokens, data.totalCostUsd,
    data.ticketId ?? null, data.ticketCategory ?? null, data.ticketReason ?? null, data.ticketUrgency ?? null,
    data.lastTs
  ).run();
}

export async function insertApiCall(db: D1Database, convId: string, call: ApiCallData): Promise<void> {
  const cost = computeCostUsd(call.model, call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheCreationTokens);
  const id = `${convId}_${Date.now()}_${call.iteration}`;
  await db.prepare(`
    INSERT OR IGNORE INTO api_calls
      (id, conv_id, ts, model, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, cost_usd, latency_ms, iteration, stop_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, convId, Date.now(), call.model,
    call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheCreationTokens,
    cost, call.latencyMs, call.iteration, call.stopReason
  ).run();
}

export async function insertThought(
  db: D1Database,
  convId: string,
  iteration: number,
  text: string
): Promise<void> {
  const id = `${convId}_thought_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await db
    .prepare(`INSERT OR IGNORE INTO assistant_thoughts (id, conv_id, ts, iteration, text) VALUES (?,?,?,?,?)`)
    .bind(id, convId, Date.now(), iteration, text.slice(0, 8000))
    .run();
}

export async function insertToolCall(db: D1Database, convId: string, call: ToolCallData): Promise<void> {
  const id = `${convId}_${call.toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await db.prepare(`
    INSERT OR IGNORE INTO tool_calls (id, conv_id, ts, tool_name, success, input_json, output_json, duration_ms)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(
    id, convId, Date.now(), call.toolName, call.success ? 1 : 0,
    call.inputJson ?? null, call.outputJson ?? null, call.durationMs ?? null
  ).run();
}

// === Storia permanente messaggi (no scadenza) ===
// Ogni messaggio (cliente, Zoe, operatore CC, automazione) viene salvato in D1.
// Quando Zoe deve rispondere, carichiamo l'intera storia per il phone_hash.

export interface StoredMsgRow {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

export async function appendMessage(
  db: D1Database,
  phoneHashStr: string,
  role: 'user' | 'assistant',
  content: string,
  ts: number
): Promise<void> {
  // ID univoco: phoneHash + ts + role + nonce. INSERT OR IGNORE evita duplicati su retry.
  const nonce = Math.random().toString(36).slice(2, 7);
  const id = `${phoneHashStr}_${ts}_${role}_${nonce}`;
  await db.prepare(
    `INSERT OR IGNORE INTO messages (id, phone_hash, ts, role, content) VALUES (?,?,?,?,?)`
  ).bind(id, phoneHashStr, ts, role, content).run();
}

export async function loadFullHistory(
  db: D1Database,
  phoneHashStr: string
): Promise<StoredMsgRow[]> {
  const res = await db.prepare(
    `SELECT role, content, ts FROM messages WHERE phone_hash = ? ORDER BY ts ASC`
  ).bind(phoneHashStr).all<{ role: string; content: string; ts: number }>();
  return (res.results ?? []).map(r => ({
    role: r.role === 'user' ? 'user' : 'assistant',
    content: r.content,
    ts: r.ts,
  }));
}

export interface FashionClipSearchData {
  source: string;
  suffix?: string;
  candidatesJson: string;
  reranked: boolean;
  rerankWinner?: string;
  rerankConfidence?: number;
  rerankReasoning?: string;
  finalHandle?: string;
  finalTitle?: string;
  foundButOos: boolean;
}

export async function insertFashionClipSearch(
  db: D1Database,
  convId: string,
  data: FashionClipSearchData
): Promise<void> {
  const id = `${convId}_fcs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await db.prepare(`
    INSERT OR IGNORE INTO fashion_clip_searches
      (id, conv_id, ts, source, suffix, candidates_json, reranked,
       rerank_winner, rerank_confidence, rerank_reasoning, final_handle, final_title, found_but_oos)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, convId, Date.now(),
    data.source, data.suffix ?? null,
    data.candidatesJson,
    data.reranked ? 1 : 0,
    data.rerankWinner ?? null, data.rerankConfidence ?? null, data.rerankReasoning ?? null,
    data.finalHandle ?? null, data.finalTitle ?? null,
    data.foundButOos ? 1 : 0
  ).run();
}

export async function updateSentiment(
  db: D1Database,
  convId: string,
  sentiment: string,
  note: string
): Promise<void> {
  await db.prepare(
    `UPDATE conversations SET sentiment = ?, sentiment_note = ? WHERE id = ?`
  ).bind(sentiment, note, convId).run();
}
