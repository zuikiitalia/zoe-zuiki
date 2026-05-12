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
}

export interface ConversationUpdate {
  convId: string;
  phoneHash: string;
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
      (id, phone_hash, first_ts, last_ts, user_turns, assistant_turns,
       total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cost_usd,
       ticket_id, ticket_category, ticket_reason, ticket_urgency, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      last_ts = excluded.last_ts,
      user_turns = excluded.user_turns,
      assistant_turns = excluded.assistant_turns,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read_tokens = excluded.total_cache_read_tokens,
      total_cost_usd = excluded.total_cost_usd,
      ticket_id = COALESCE(excluded.ticket_id, conversations.ticket_id),
      ticket_category = COALESCE(excluded.ticket_category, conversations.ticket_category),
      ticket_reason = COALESCE(excluded.ticket_reason, conversations.ticket_reason),
      ticket_urgency = COALESCE(excluded.ticket_urgency, conversations.ticket_urgency),
      updated_at = excluded.updated_at
  `).bind(
    data.convId, data.phoneHash, data.firstTs, data.lastTs,
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

export async function insertToolCall(db: D1Database, convId: string, call: ToolCallData): Promise<void> {
  const id = `${convId}_${call.toolName}_${Date.now()}`;
  await db.prepare(`
    INSERT OR IGNORE INTO tool_calls (id, conv_id, ts, tool_name, success)
    VALUES (?,?,?,?,?)
  `).bind(id, convId, Date.now(), call.toolName, call.success ? 1 : 0).run();
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
