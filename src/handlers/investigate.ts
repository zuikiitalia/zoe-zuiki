import type { Context } from 'hono';
import type { Env } from '../config';
import { phoneHash } from '../analytics/db';

function checkKey(c: Context<{ Bindings: Env }>): boolean {
  const key = c.req.header('x-investigate-key');
  return !!c.env.INVESTIGATE_KEY && key === c.env.INVESTIGATE_KEY;
}

export async function handleMigrate(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!checkKey(c)) return c.json({ error: 'unauthorized' }, 401);
  if (!c.env.ZOE_DB) return c.json({ error: 'db_not_configured' }, 503);

  const results: Record<string, string> = {};
  const migrations: Array<{ name: string; sql: string }> = [
    { name: 'add_phone_full', sql: 'ALTER TABLE conversations ADD COLUMN phone_full TEXT' },
    { name: 'tool_input_json', sql: 'ALTER TABLE tool_calls ADD COLUMN input_json TEXT' },
    { name: 'tool_output_json', sql: 'ALTER TABLE tool_calls ADD COLUMN output_json TEXT' },
    { name: 'tool_duration_ms', sql: 'ALTER TABLE tool_calls ADD COLUMN duration_ms INTEGER' },
    { name: 'create_assistant_thoughts', sql: 'CREATE TABLE IF NOT EXISTS assistant_thoughts (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, ts INTEGER NOT NULL, iteration INTEGER, text TEXT NOT NULL)' },
    { name: 'idx_thoughts_conv', sql: 'CREATE INDEX IF NOT EXISTS idx_thoughts_conv ON assistant_thoughts(conv_id, ts)' },
    { name: 'create_fashion_clip_searches', sql: 'CREATE TABLE IF NOT EXISTS fashion_clip_searches (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT, suffix TEXT, candidates_json TEXT, reranked INTEGER DEFAULT 0, rerank_winner TEXT, rerank_confidence REAL, rerank_reasoning TEXT, final_handle TEXT, final_title TEXT, found_but_oos INTEGER DEFAULT 0)' },
    { name: 'idx_fcs_conv', sql: 'CREATE INDEX IF NOT EXISTS idx_fcs_conv ON fashion_clip_searches(conv_id, ts)' },
  ];

  for (const m of migrations) {
    try {
      await c.env.ZOE_DB.prepare(m.sql).run();
      results[m.name] = 'applied';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results[m.name] = msg.includes('duplicate column') ? 'already_applied' : `error: ${msg}`;
    }
  }
  return c.json({ migrations: results });
}

export async function handleInvestigate(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!checkKey(c)) return c.json({ error: 'unauthorized' }, 401);

  if (!c.env.ZOE_DB) {
    return c.json({ error: 'db_not_configured' }, 503);
  }

  const phoneParam = c.req.query('phone') ?? '';
  const limitParam = parseInt(c.req.query('limit') ?? '3', 10);
  if (!phoneParam) {
    return c.json({ error: 'missing phone param' }, 400);
  }

  const db = c.env.ZOE_DB;
  const lim = Math.min(limitParam, 20);
  const digits = phoneParam.replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  const with39 = last10.length === 10 ? '39' + last10 : digits;
  const variants = Array.from(new Set([digits, last10, with39, '+' + with39, '+' + digits]));
  const hashes = await Promise.all(variants.map(v => phoneHash(v)));

  let ph = hashes[0]!;
  let convs: { results?: Record<string, unknown>[] } = { results: [] };
  for (const candidate of hashes) {
    const r = await db
      .prepare('SELECT * FROM conversations WHERE phone_hash = ? ORDER BY first_ts DESC LIMIT ?')
      .bind(candidate, lim)
      .all();
    if ((r.results ?? []).length > 0) {
      ph = candidate;
      convs = r;
      break;
    }
  }

  const conversations = [];
  for (const conv of convs.results ?? []) {
    const convId = conv.id as string;
    const firstTs = conv.first_ts as number;
    const lastTs = conv.last_ts as number;

    const [msgs, tools, apis, thoughts] = await Promise.all([
      db
        .prepare(
          'SELECT role, content, ts FROM messages WHERE phone_hash = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC'
        )
        .bind(ph, firstTs, lastTs + 120_000)
        .all(),
      db
        .prepare(
          'SELECT ts, tool_name, success, input_json, output_json, duration_ms FROM tool_calls WHERE conv_id = ? ORDER BY ts ASC'
        )
        .bind(convId)
        .all(),
      db
        .prepare(
          'SELECT ts, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, iteration, stop_reason, cost_usd FROM api_calls WHERE conv_id = ? ORDER BY ts ASC'
        )
        .bind(convId)
        .all(),
      db
        .prepare(
          'SELECT ts, iteration, text FROM assistant_thoughts WHERE conv_id = ? ORDER BY ts ASC'
        )
        .bind(convId)
        .all(),
    ]);

    conversations.push({
      id: convId,
      first_ts: firstTs,
      last_ts: lastTs,
      user_turns: conv.user_turns,
      assistant_turns: conv.assistant_turns,
      total_cost_usd: conv.total_cost_usd,
      total_input_tokens: conv.total_input_tokens,
      total_output_tokens: conv.total_output_tokens,
      total_cache_read_tokens: conv.total_cache_read_tokens,
      ticket_id: conv.ticket_id,
      ticket_category: conv.ticket_category,
      ticket_reason: conv.ticket_reason,
      ticket_urgency: conv.ticket_urgency,
      sentiment: conv.sentiment,
      sentiment_note: conv.sentiment_note,
      messages: msgs.results ?? [],
      tool_calls: tools.results ?? [],
      api_calls: apis.results ?? [],
      thoughts: thoughts.results ?? [],
    });
  }

  return c.json({ phone_hash: ph, conversations });
}
