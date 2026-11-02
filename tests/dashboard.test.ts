import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { computeCostUsd } from '../src/analytics/costs';
import { ensureConversation, insertApiCall, phoneHash } from '../src/analytics/db';
import { insertSystemApiCall } from '../src/analytics/usage';
import { makeD1, makeKV } from './helpers';

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

describe('prezzi', () => {
  it('Opus 4.7 usa il listino reale ($5/$25), non quello vecchio ($15/$75)', () => {
    expect(computeCostUsd('claude-opus-4-7', 1_000_000, 0, 0, 0)).toBeCloseTo(5);
    expect(computeCostUsd('claude-opus-4-7', 0, 1_000_000, 0, 0)).toBeCloseTo(25);
  });
  it('riconosce i modelli con suffisso di data (sentiment su Haiku 4.5)', () => {
    expect(computeCostUsd('claude-haiku-4-5-20251001', 1_000_000, 0, 0, 0)).toBeCloseTo(1);
  });
  it('Sonnet 5.5: $2/$10, cache $0.20 lettura e $2.50 scrittura', () => {
    expect(computeCostUsd('claude-sonnet-5-5', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(2 + 10 + 0.2 + 2.5);
  });
});

describe('tracciamento costi con FOREIGN KEY (come su D1)', () => {
  it('senza la riga conversazione il costo viene rifiutato: era la causa della spesa mancante', async () => {
    const db = makeD1();
    await expect(insertApiCall(db, 'nuovo_123', {
      model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
      latencyMs: 1, iteration: 0, stopReason: 'end_turn',
    })).rejects.toThrow();
  });

  it('con ensureConversation prima, il costo viene salvato', async () => {
    const db = makeD1();
    await ensureConversation(db, 'nuovo_123', 'abc', '393330000000', Date.now());
    await insertApiCall(db, 'nuovo_123', {
      model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
      latencyMs: 1, iteration: 0, stopReason: 'end_turn',
    });
    const r = db.raw.prepare('SELECT COUNT(*) AS n FROM api_calls').get() as { n: number };
    expect(r.n).toBe(1);
  });

  it('le chiamate di sistema (review, sentiment, reranker) finiscono nella loro tabella', async () => {
    const db = makeD1();
    await insertSystemApiCall(db, 'review', 'claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 0 }, 5);
    await insertSystemApiCall(db, 'sentiment', 'claude-haiku-4-5-20251001', { input_tokens: 1_000_000 }, 5);
    const rows = db.raw.prepare('SELECT source, cost_usd FROM system_api_calls ORDER BY source').all() as Array<{ source: string; cost_usd: number }>;
    expect(rows.map((r) => r.source)).toEqual(['review', 'sentiment']);
    expect(rows[0]!.cost_usd).toBeCloseTo(2);
    expect(rows[1]!.cost_usd).toBeCloseTo(1);
  });
});

describe('API dashboard su SQLite reale', () => {
  async function seeded() {
    const db = makeD1();
    const phone = '393331112222';
    const ph = await phoneHash(phone);
    const convId = `${ph}_1000`;
    const now = Date.now();
    db.raw.prepare(`INSERT INTO conversations (id, phone_hash, phone_full, first_ts, last_ts, user_turns, assistant_turns,
      ticket_id, ticket_category, sentiment, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(convId, ph, phone, now - 1000, now, 3, 3, 'T1', 'reso', 'satisfied', now);
    // Riga storica salvata col prezzo vecchio: 1M token input Opus 4.7 = $15 salvati, $5 reali.
    db.raw.prepare(`INSERT INTO api_calls (id, conv_id, ts, model, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, cost_usd, latency_ms, iteration, stop_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('a1', convId, now, 'claude-opus-4-7', 1_000_000, 0, 0, 0, 15, 100, 0, 'end_turn');
    db.raw.prepare(`INSERT INTO api_calls (id, conv_id, ts, model, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, cost_usd, latency_ms, iteration, stop_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('a2', convId, now, 'claude-sonnet-5-5', 0, 1_000_000, 0, 0, 10, 100, 1, 'end_turn');
    db.raw.prepare(`INSERT INTO tool_calls (id, conv_id, ts, tool_name, success) VALUES (?,?,?,?,?)`)
      .run('t1', convId, now, 'get_order_by_number_and_email', 1);
    db.raw.prepare(`INSERT INTO messages (id, phone_hash, ts, role, content) VALUES (?,?,?,?,?)`).run('m1', ph, now - 900, 'user', 'Ciao <b>ordine</b>');
    db.raw.prepare(`INSERT INTO messages (id, phone_hash, ts, role, content) VALUES (?,?,?,?,?)`).run('m2', ph, now - 800, 'assistant', 'Ciao! Controllo subito');
    db.raw.prepare(`INSERT INTO messages (id, phone_hash, ts, role, content) VALUES (?,?,?,?,?)`).run('m3', ph, now - 700, 'assistant', '[Operatore CC]: ci penso io');
    db.raw.prepare(`INSERT INTO review_findings (id, conv_id, phone_hash, analysis_date, category, severity, problem, suggestion, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run('f1', convId, ph, today, 'missed_ticket', 'high', 'Ticket non aperto', 'Aprire ticket', now);
    await insertSystemApiCall(db, 'review', 'claude-sonnet-5-5', { input_tokens: 1_000_000 }, 5);
    const env = { ZOE_DB: db, ZOE_KV: makeKV(), ANTHROPIC_API_KEY: 'sk-ant-test' };
    const app = (await import('../src/index')).default;
    return { db, env, app, convId, phone };
  }

  it('/overview somma tutte le fonti a prezzi corretti', async () => {
    const { app, env } = await seeded();
    const res = await app.request(`/dashboard/api/overview?from=${yesterday}&to=${today}`, {}, env);
    expect(res.status).toBe(200);
    const d = await res.json() as {
      kpis: Record<string, number>; daily: Array<Record<string, number | string>>;
      by_source: Array<{ source: string; cost: number }>; tracking_since: number | null;
      sentiment: unknown[]; tickets: unknown[]; tools: unknown[];
    };
    // $5 (Opus 4.7 ricalcolato) + $10 (Sonnet output) + $2 (review)
    expect(d.kpis.total_cost).toBeCloseTo(17);
    expect(d.kpis.conversations).toBe(1);
    expect(d.kpis.zoe_replies).toBe(1);
    expect(d.kpis.operator_messages).toBe(1);
    expect(d.kpis.tickets).toBe(1);
    const bySource = Object.fromEntries(d.by_source.map((r) => [r.source, r.cost]));
    expect(bySource.conversation).toBeCloseTo(15);
    expect(bySource.review).toBeCloseTo(2);
    const todayRow = d.daily.find((r) => r.day === today)!;
    expect(todayRow.conversation as number).toBeCloseTo(15);
    expect(todayRow.review as number).toBeCloseTo(2);
    expect(d.daily.length).toBe(2);
    expect(d.tracking_since).not.toBeNull();
    expect(d.sentiment.length).toBe(1);
    expect(d.tools.length).toBe(1);
  });

  it('gli altri endpoint rispondono con dati coerenti', async () => {
    const { app, env, convId, phone } = await seeded();
    const q = `from=${yesterday}&to=${today}`;

    const top = await (await app.request(`/dashboard/api/top-conversations?${q}`, {}, env)).json() as { conversations: Array<{ cost: number }> };
    expect(top.conversations[0]!.cost).toBeCloseTo(15);

    const cust = await (await app.request(`/dashboard/api/customers?${q}&sort=cost&q=3331112`, {}, env)).json() as { customers: Array<{ cost: number; phone_full: string }> };
    expect(cust.customers).toHaveLength(1);
    expect(cust.customers[0]!.phone_full).toBe(phone);
    expect(cust.customers[0]!.cost).toBeCloseTo(15);

    const conv = await (await app.request(`/dashboard/api/conversation/${encodeURIComponent(convId)}`, {}, env)).json() as { messages: unknown[]; api_calls: Array<{ cost_usd: number }> };
    expect(conv.messages).toHaveLength(3);
    expect(conv.api_calls[0]!.cost_usd).toBeCloseTo(5);

    const inv = await (await app.request(`/dashboard/api/investigate?phone=3331112222`, {}, env)).json() as { conversations: unknown[] };
    expect(inv.conversations).toHaveLength(1);

    const high = await (await app.request(`/dashboard/api/high-cost-users?threshold=10`, {}, env)).json() as { users: Array<{ day_cost: number; blocked: boolean }> };
    expect(high.users).toHaveLength(1);
    expect(high.users[0]!.blocked).toBe(false);

    const blk = await app.request(`/dashboard/api/block-user`, { method: 'POST', body: JSON.stringify({ phone }), headers: { 'Content-Type': 'application/json' } }, env);
    expect(blk.status).toBe(200);
    const high2 = await (await app.request(`/dashboard/api/high-cost-users?threshold=10`, {}, env)).json() as { users: Array<{ blocked: boolean }> };
    expect(high2.users[0]!.blocked).toBe(true);

    const find = await (await app.request(`/dashboard/api/findings`, {}, env)).json() as { findings: unknown[] };
    expect(find.findings).toHaveLength(1);

    const img = await app.request(`/dashboard/api/image-searches?${q}`, {}, env);
    expect(img.status).toBe(200);
  });
});

describe('pagina dashboard', () => {
  it('il JavaScript della pagina è sintatticamente valido', async () => {
    const app = (await import('../src/index')).default;
    const res = await app.request('/dashboard', {}, { ZOE_KV: makeKV() });
    expect(res.status).toBe(200);
    const html = await res.text();
    const start = html.indexOf('<script>');
    const end = html.lastIndexOf('</script>');
    expect(start).toBeGreaterThan(0);
    // Un errore di sintassi qui bloccherebbe l'intera dashboard (incidente di luglio).
    expect(() => new vm.Script(html.slice(start + 8, end))).not.toThrow();
  });

  it('il template non contiene backtick o dollaro-graffa (romperebbero lo String.raw)', () => {
    const src = readFileSync('src/handlers/dashboardPage.ts', 'utf8');
    const body = src.slice(src.indexOf('String.raw`') + 'String.raw`'.length, src.lastIndexOf('`;'));
    expect(body.includes('`')).toBe(false);
    expect(body.includes('$' + '{')).toBe(false);
  });
});
