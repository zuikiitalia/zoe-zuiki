import type { Context } from 'hono';
import type { Env } from '../config';
import { phoneHash } from '../analytics/db';
import { costSql, ensureSystemUsageTable } from '../analytics/usage';
import { DASHBOARD_HTML } from './dashboardPage';

const DAY_MS = 86_400_000;
// Costo ricalcolato dai token al listino attuale (vedi costSql): anche le righe storiche
// salvate con prezzi vecchi vengono mostrate al prezzo corretto.
const COST = costSql();
// Le righe review_* in api_calls sono un residuo del vecchio tracciamento (di fatto mai
// salvate per via della FOREIGN KEY): se ce ne fossero, le contiamo come review.
const API_SOURCE = `CASE WHEN conv_id LIKE 'review_%' THEN 'review' ELSE 'conversation' END`;

// Tutte le date sono in UTC, come nella Console Anthropic.
function parseRange(url: URL): { fromMs: number; toMs: number } {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const now = Date.now();
  const todayStart = now - (now % DAY_MS);
  let fromMs = from ? Date.parse(from + 'T00:00:00Z') : todayStart - 29 * DAY_MS;
  let toMs = to ? Date.parse(to + 'T00:00:00Z') + DAY_MS - 1 : todayStart + DAY_MS - 1;
  if (Number.isNaN(fromMs)) fromMs = todayStart - 29 * DAY_MS;
  if (Number.isNaN(toMs)) toMs = todayStart + DAY_MS - 1;
  if (fromMs > toMs) [fromMs, toMs] = [toMs - (toMs % DAY_MS), fromMs + DAY_MS - 1];
  return { fromMs, toMs };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Spesa totale (tutte le fonti) in una finestra.
async function totalCost(db: D1Database, fromMs: number, toMs: number): Promise<number> {
  const r = await db.prepare(`
    SELECT COALESCE(SUM(cost), 0) AS cost FROM (
      SELECT ${COST} AS cost FROM api_calls WHERE ts BETWEEN ? AND ?
      UNION ALL
      SELECT ${COST} AS cost FROM system_api_calls WHERE ts BETWEEN ? AND ?
    )`).bind(fromMs, toMs, fromMs, toMs).first<{ cost: number }>();
  return r?.cost ?? 0;
}

type D1Database = NonNullable<Env['ZOE_DB']>;

export async function handleDashboardAPI(c: Context<{ Bindings: Env }>): Promise<Response> {
  const db = c.env.ZOE_DB;
  if (!db) return c.json({ error: 'no_db' }, 503);
  // Le query di costo uniscono api_calls e system_api_calls: la seconda va creata se manca.
  await ensureSystemUsageTable(db).catch(() => {});

  const url = new URL(c.req.url);
  const path = url.pathname.replace(/.*\/dashboard\/api/, '');
  const { fromMs, toMs } = parseRange(url);

  // GET /overview — tutti i dati della panoramica in una richiesta
  if (path === '/overview') {
    const spanMs = toMs - fromMs + 1;
    const prevFrom = fromMs - spanMs;
    const prevTo = fromMs - 1;
    const now = Date.now();
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const elapsedDays = Math.max((now - monthStart) / DAY_MS, 0.5);

    const [daily, bySource, byModel, conv, prevConv, msgs, tickets, ticketCats, sentiment, tools,
      prevTotal, mtd, trackingSince] = await Promise.all([
      db.prepare(`
        SELECT day, source, SUM(cost) AS cost FROM (
          SELECT date(ts/1000,'unixepoch') AS day, ${API_SOURCE} AS source, ${COST} AS cost
            FROM api_calls WHERE ts BETWEEN ? AND ?
          UNION ALL
          SELECT date(ts/1000,'unixepoch') AS day, source, ${COST} AS cost
            FROM system_api_calls WHERE ts BETWEEN ? AND ?
        ) GROUP BY day, source`).bind(fromMs, toMs, fromMs, toMs).all<{ day: string; source: string; cost: number }>(),
      db.prepare(`
        SELECT source, SUM(cost) AS cost, COUNT(*) AS calls FROM (
          SELECT ${API_SOURCE} AS source, ${COST} AS cost FROM api_calls WHERE ts BETWEEN ? AND ?
          UNION ALL
          SELECT source, ${COST} AS cost FROM system_api_calls WHERE ts BETWEEN ? AND ?
        ) GROUP BY source ORDER BY cost DESC`).bind(fromMs, toMs, fromMs, toMs).all(),
      db.prepare(`
        SELECT model, SUM(cost) AS cost, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens FROM (
          SELECT model, ${COST} AS cost, input_tokens, output_tokens, cache_read_tokens
            FROM api_calls WHERE ts BETWEEN ? AND ?
          UNION ALL
          SELECT model, ${COST} AS cost, input_tokens, output_tokens, cache_read_tokens
            FROM system_api_calls WHERE ts BETWEEN ? AND ?
        ) GROUP BY model ORDER BY cost DESC`).bind(fromMs, toMs, fromMs, toMs).all(),
      db.prepare(`
        SELECT COUNT(DISTINCT conv_id) AS conversations, COALESCE(SUM(${COST}),0) AS cost, COUNT(*) AS calls,
               COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
               COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens
        FROM api_calls WHERE ts BETWEEN ? AND ? AND conv_id NOT LIKE 'review_%'`).bind(fromMs, toMs)
        .first<{ conversations: number; cost: number; calls: number; input_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }>(),
      db.prepare(`SELECT COUNT(DISTINCT conv_id) AS conversations FROM api_calls
        WHERE ts BETWEEN ? AND ? AND conv_id NOT LIKE 'review_%'`).bind(prevFrom, prevTo).first<{ conversations: number }>(),
      db.prepare(`
        SELECT
          SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) AS customer,
          SUM(CASE WHEN role='assistant' AND content NOT LIKE '[Operatore CC]%' AND content NOT LIKE '[Notifica Zuiki]%'
                   AND content NOT LIKE '(silenzio intenzionale%' THEN 1 ELSE 0 END) AS zoe,
          SUM(CASE WHEN role='assistant' AND content LIKE '[Operatore CC]%' THEN 1 ELSE 0 END) AS operator
        FROM messages WHERE ts BETWEEN ? AND ?`).bind(fromMs, toMs).first<{ customer: number; zoe: number; operator: number }>(),
      db.prepare(`SELECT COUNT(*) AS n FROM conversations
        WHERE ticket_id IS NOT NULL AND last_ts BETWEEN ? AND ?`).bind(fromMs, toMs).first<{ n: number }>(),
      db.prepare(`SELECT ticket_category AS category, COUNT(*) AS count FROM conversations
        WHERE ticket_category IS NOT NULL AND last_ts BETWEEN ? AND ?
        GROUP BY ticket_category ORDER BY count DESC`).bind(fromMs, toMs).all(),
      db.prepare(`SELECT COALESCE(sentiment,'unknown') AS sentiment, COUNT(*) AS count FROM conversations
        WHERE last_ts BETWEEN ? AND ? GROUP BY COALESCE(sentiment,'unknown')`).bind(fromMs, toMs).all(),
      db.prepare(`SELECT tool_name, COUNT(*) AS calls, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes
        FROM tool_calls WHERE ts BETWEEN ? AND ? GROUP BY tool_name ORDER BY calls DESC`).bind(fromMs, toMs).all(),
      totalCost(db, prevFrom, prevTo),
      totalCost(db, monthStart, now),
      db.prepare(`SELECT MIN(ts) AS ts FROM system_api_calls`).first<{ ts: number | null }>(),
    ]);

    // Una riga per ogni giorno del periodo, anche quelli senza spesa.
    const dayMap = new Map<string, Record<string, number | string>>();
    for (let t = fromMs - (fromMs % DAY_MS); t <= toMs; t += DAY_MS) {
      dayMap.set(isoDay(t), { day: isoDay(t), conversation: 0, review: 0, sentiment: 0, reranker: 0 });
    }
    let total = 0;
    for (const r of daily.results ?? []) {
      const row = dayMap.get(r.day);
      if (row) row[r.source] = ((row[r.source] as number) || 0) + (r.cost || 0);
      total += r.cost || 0;
    }

    const convCount = conv?.conversations ?? 0;
    const cacheDen = (conv?.cache_read_tokens ?? 0) + (conv?.input_tokens ?? 0) + (conv?.cache_creation_tokens ?? 0);
    return c.json({
      range: { from: isoDay(fromMs), to: isoDay(toMs) },
      tracking_since: trackingSince?.ts ?? null,
      kpis: {
        total_cost: total,
        prev_total_cost: prevTotal,
        conversations: convCount,
        prev_conversations: prevConv?.conversations ?? 0,
        conv_cost: conv?.cost ?? 0,
        avg_cost_per_conversation: convCount ? (conv?.cost ?? 0) / convCount : 0,
        calls: conv?.calls ?? 0,
        zoe_replies: msgs?.zoe ?? 0,
        customer_messages: msgs?.customer ?? 0,
        operator_messages: msgs?.operator ?? 0,
        tickets: tickets?.n ?? 0,
        cache_hit_rate: cacheDen ? (conv?.cache_read_tokens ?? 0) / cacheDen : 0,
        mtd_cost: mtd,
        projected_month_cost: (mtd / elapsedDays) * daysInMonth,
      },
      daily: Array.from(dayMap.values()),
      by_source: bySource.results ?? [],
      by_model: byModel.results ?? [],
      sentiment: sentiment.results ?? [],
      tickets: ticketCats.results ?? [],
      tools: tools.results ?? [],
    });
  }

  // GET /top-conversations — le 10 conversazioni più costose del periodo
  if (path === '/top-conversations') {
    const rows = await db.prepare(`
      SELECT a.conv_id, SUM(${COST}) AS cost, COUNT(*) AS calls, MIN(a.ts) AS first_ts, MAX(a.ts) AS last_ts,
             (SELECT phone_full FROM conversations c WHERE c.id = a.conv_id) AS phone_full
      FROM api_calls a
      WHERE a.ts BETWEEN ? AND ? AND a.conv_id NOT LIKE 'review_%'
      GROUP BY a.conv_id ORDER BY cost DESC LIMIT 10`).bind(fromMs, toMs).all();
    return c.json({ conversations: rows.results ?? [] });
  }

  // GET /high-cost-users?threshold=10 — clienti oltre la soglia €/giorno (ultimi 30 giorni)
  if (path === '/high-cost-users') {
    const threshold = Math.max(0, parseFloat(url.searchParams.get('threshold') ?? '10'));
    const since = Date.now() - 30 * DAY_MS;
    const rows = await db.prepare(`
      SELECT ph AS phone_hash, day, SUM(cost) AS day_cost, COUNT(*) AS calls,
        (SELECT phone_full FROM conversations c2 WHERE c2.phone_hash = ph AND c2.phone_full IS NOT NULL
          ORDER BY c2.last_ts DESC LIMIT 1) AS phone_full
      FROM (
        SELECT substr(conv_id, 1, 16) AS ph, date(ts/1000,'unixepoch') AS day, ${COST} AS cost
        FROM api_calls WHERE ts >= ? AND conv_id NOT LIKE 'review_%'
      ) GROUP BY ph, day HAVING day_cost >= ? ORDER BY day_cost DESC LIMIT 50`).bind(since, threshold).all<{ phone_full: string | null }>();
    const users = rows.results ?? [];
    const { isZoeBlocked } = await import('../storage/kvStore');
    const withStatus = await Promise.all(users.map(async (u) => ({
      ...u,
      blocked: u.phone_full && c.env.ZOE_KV ? await isZoeBlocked(c.env.ZOE_KV, u.phone_full) : false,
    })));
    return c.json({ threshold, users: withStatus });
  }

  // GET /customers?from&to&page&sort=recent|cost&q=numero — clienti attivi nel periodo
  if (path === '/customers') {
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const limit = 50;
    const sort = url.searchParams.get('sort') === 'cost' ? 'cost DESC' : 'last_seen DESC';
    const qDigits = (url.searchParams.get('q') ?? '').replace(/\D/g, '');
    const phoneFilter = qDigits ? `AND c.phone_full LIKE ?` : '';
    const binds: unknown[] = [fromMs, toMs, fromMs, toMs];
    if (qDigits) binds.push(`%${qDigits}%`);
    const rows = await db.prepare(`
      WITH spend AS (
        SELECT substr(conv_id, 1, 16) AS ph, SUM(${COST}) AS cost
        FROM api_calls WHERE ts BETWEEN ? AND ? AND conv_id NOT LIKE 'review_%' GROUP BY ph
      )
      SELECT c.phone_hash,
        MAX(c.phone_full) AS phone_full,
        COUNT(*) AS sessions,
        SUM(c.user_turns) AS user_turns,
        MIN(c.first_ts) AS first_seen,
        MAX(c.last_ts) AS last_seen,
        SUM(CASE WHEN c.ticket_id IS NOT NULL THEN 1 ELSE 0 END) AS tickets,
        (SELECT id FROM conversations c2 WHERE c2.phone_hash = c.phone_hash ORDER BY c2.last_ts DESC LIMIT 1) AS latest_conv_id,
        (SELECT sentiment FROM conversations c2 WHERE c2.phone_hash = c.phone_hash ORDER BY c2.last_ts DESC LIMIT 1) AS latest_sentiment,
        COALESCE(MAX(s.cost), 0) AS cost
      FROM conversations c LEFT JOIN spend s ON s.ph = c.phone_hash
      WHERE c.last_ts >= ? AND c.first_ts <= ? ${phoneFilter}
      GROUP BY c.phone_hash ORDER BY ${sort} LIMIT ? OFFSET ?`)
      .bind(...binds, limit + 1, page * limit).all();
    const list = rows.results ?? [];
    return c.json({ customers: list.slice(0, limit), page, limit, has_more: list.length > limit });
  }

  // GET /conversation/:id — dettaglio conversazione + intero thread del cliente
  const convMatch = path.match(/^\/conversation\/(.+)$/);
  if (convMatch) {
    const id = decodeURIComponent(convMatch[1]!);
    const conv = await db.prepare(`SELECT * FROM conversations WHERE id=?`).bind(id).first<{ phone_hash: string }>();
    if (!conv) return c.json({ error: 'not_found' }, 404);
    const [apiCalls, toolCalls, messages, sessions, findings] = await Promise.all([
      db.prepare(`SELECT ts, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, iteration, stop_reason,
        ${COST} AS cost_usd FROM api_calls WHERE conv_id=? ORDER BY ts`).bind(id).all(),
      db.prepare(`SELECT ts, tool_name, success, duration_ms FROM tool_calls WHERE conv_id=? ORDER BY ts`).bind(id).all(),
      db.prepare(`SELECT role, content, ts FROM messages WHERE phone_hash=? ORDER BY ts ASC`).bind(conv.phone_hash).all(),
      db.prepare(`SELECT id, first_ts, last_ts, user_turns, assistant_turns, sentiment, ticket_id, ticket_category
        FROM conversations WHERE phone_hash=? ORDER BY first_ts DESC`).bind(conv.phone_hash).all(),
      db.prepare(`SELECT category, severity, problem, suggestion, analysis_date
        FROM review_findings WHERE phone_hash=? ORDER BY created_at DESC LIMIT 20`).bind(conv.phone_hash).all(),
    ]);
    return c.json({
      conversation: conv,
      api_calls: apiCalls.results ?? [],
      tool_calls: toolCalls.results ?? [],
      messages: messages.results ?? [],
      sessions: sessions.results ?? [],
      findings: findings.results ?? [],
    });
  }

  // GET /findings — review qualità degli ultimi 30 giorni
  if (path === '/findings') {
    const rows = await db.prepare(`
      SELECT id, conv_id, analysis_date, category, severity, problem, suggestion
      FROM review_findings
      WHERE analysis_date >= date('now', '-30 days')
      ORDER BY analysis_date DESC, CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 500`).all();
    return c.json({ findings: rows.results ?? [] });
  }

  // GET /investigate?phone=...&limit=3 — traccia completa delle ultime conversazioni di un numero
  if (path === '/investigate') {
    const phoneParam = url.searchParams.get('phone') ?? '';
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '3', 10) || 3, 1), 20);
    if (!phoneParam) return c.json({ error: 'missing phone' }, 400);
    // Lo storico può aver salvato l'hash di forme diverse del numero (+39…, 39…, 10 cifre).
    const digits = phoneParam.replace(/\D/g, '');
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    const with39 = last10.length === 10 ? '39' + last10 : digits;
    const variants = Array.from(new Set([digits, last10, with39, '+' + with39, '+' + digits]));
    const hashes = await Promise.all(variants.map((v) => phoneHash(v)));
    let ph = hashes[0]!;
    let convs: Record<string, unknown>[] = [];
    for (const candidate of hashes) {
      const r = await db.prepare('SELECT * FROM conversations WHERE phone_hash = ? ORDER BY last_ts DESC LIMIT ?')
        .bind(candidate, limit).all();
      if ((r.results ?? []).length > 0) { ph = candidate; convs = r.results ?? []; break; }
    }
    const conversations = await Promise.all(convs.map(async (conv) => {
      const convId = conv.id as string;
      const [msgs, tools, apis, thoughts] = await Promise.all([
        db.prepare('SELECT role, content, ts FROM messages WHERE phone_hash = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC')
          .bind(ph, conv.first_ts as number, (conv.last_ts as number) + 120_000).all(),
        db.prepare('SELECT ts, tool_name, success, input_json, output_json, duration_ms FROM tool_calls WHERE conv_id = ? ORDER BY ts ASC')
          .bind(convId).all(),
        db.prepare(`SELECT ts, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, iteration, stop_reason,
          ${COST} AS cost_usd FROM api_calls WHERE conv_id = ? ORDER BY ts ASC`).bind(convId).all(),
        db.prepare('SELECT ts, iteration, text FROM assistant_thoughts WHERE conv_id = ? ORDER BY ts ASC').bind(convId).all(),
      ]);
      return {
        ...conv,
        messages: msgs.results ?? [],
        tool_calls: tools.results ?? [],
        api_calls: apis.results ?? [],
        thoughts: thoughts.results ?? [],
      };
    }));
    return c.json({ phone_hash: ph, conversations });
  }

  // GET /image-searches — ricerche per immagine (numeri sperimentali)
  if (path === '/image-searches') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);
    const rows = await db.prepare(`
      SELECT id, conv_id, ts, source, suffix, candidates_json, reranked, rerank_winner, rerank_confidence,
             rerank_reasoning, final_handle, final_title, found_but_oos
      FROM fashion_clip_searches WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?`)
      .bind(fromMs, toMs, limit).all().catch(() => ({ results: [] }));
    return c.json({ searches: rows.results ?? [] });
  }

  // POST /block-user {phone} — esclude il numero da Zoe (gestione solo umana, permanente)
  // POST /unblock-user {phone} — riattiva Zoe per il numero
  if (path === '/block-user' || path === '/unblock-user') {
    if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405);
    if (!c.env.ZOE_KV) return c.json({ error: 'no_kv' }, 503);
    const body = await c.req.json<{ phone?: string }>().catch(() => ({} as { phone?: string }));
    const phone = String(body.phone ?? '').trim();
    if (!phone) return c.json({ error: 'missing_phone' }, 400);
    const kv = await import('../storage/kvStore');
    if (path === '/block-user') await kv.blockZoeUser(c.env.ZOE_KV, phone);
    else await kv.unblockZoeUser(c.env.ZOE_KV, phone);
    return c.json({ ok: true, phone, blocked: path === '/block-user' });
  }

  // POST /run-review — esegue subito la review qualità (normalmente gira ogni notte)
  if (path === '/run-review') {
    if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405);
    if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: 'no_anthropic_key' }, 503);
    const { runDailyReview } = await import('../analytics/dailyReview');
    return c.json(await runDailyReview(db, c.env.ANTHROPIC_API_KEY));
  }

  return c.json({ error: 'not_found' }, 404);
}

export function handleDashboardHTML(_c: Context<{ Bindings: Env }>): Response {
  return new Response(DASHBOARD_HTML, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}
