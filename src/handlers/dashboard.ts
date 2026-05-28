import type { Context } from 'hono';
import type { Env } from '../config';
import { phoneHash } from '../analytics/db';

// Helper per verificare auth
function checkAuth(c: Context<{ Bindings: Env }>): boolean {
  const secret = c.env.DASHBOARD_SECRET;
  if (!secret) return false;
  const auth = c.req.header('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return token === secret;
}

function tsToDateRange(from: string | null, to: string | null): { fromMs: number; toMs: number } {
  const fromMs = from ? new Date(from).getTime() : Date.now() - 30 * 24 * 60 * 60 * 1000;
  const toMs = to ? new Date(to).getTime() + 86399999 : Date.now();
  return { fromMs: isNaN(fromMs) ? Date.now() - 30 * 24 * 60 * 60 * 1000 : fromMs, toMs: isNaN(toMs) ? Date.now() : toMs };
}

export async function handleDashboardAPI(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!c.env.ZOE_DB) return c.json({ error: 'no_db' }, 503);

  const url = new URL(c.req.url);
  const path = url.pathname.replace(/.*\/dashboard\/api/, '');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const { fromMs, toMs } = tsToDateRange(from, to);

  // GET /dashboard/api/summary
  if (path === '/summary') {
    const [convRow, modelRows, toolRows, ticketRows, sentimentRows] = await Promise.all([
      c.env.ZOE_DB.prepare(`
        SELECT
          COUNT(DISTINCT c.id) AS total_conversations,
          COUNT(DISTINCT CASE WHEN c.ticket_id IS NOT NULL THEN c.id END) AS with_ticket,
          COUNT(DISTINCT CASE WHEN c.ticket_id IS NULL THEN c.id END) AS without_ticket,
          COALESCE(SUM(a.input_tokens),0) AS total_input_tokens,
          COALESCE(SUM(a.output_tokens),0) AS total_output_tokens,
          COALESCE(SUM(a.cache_read_tokens),0) AS total_cache_read_tokens,
          COALESCE(SUM(a.cost_usd),0) AS total_cost_usd
        FROM conversations c
        LEFT JOIN api_calls a ON a.conv_id = c.id
        WHERE c.first_ts >= ? AND c.first_ts <= ?
      `).bind(fromMs, toMs).first(),

      c.env.ZOE_DB.prepare(`
        SELECT model,
          COUNT(*) AS calls,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cost_usd) AS cost_usd
        FROM api_calls
        WHERE ts >= ? AND ts <= ?
        GROUP BY model ORDER BY cost_usd DESC
      `).bind(fromMs, toMs).all(),

      c.env.ZOE_DB.prepare(`
        SELECT tool_name, COUNT(*) AS calls,
          SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes
        FROM tool_calls WHERE ts >= ? AND ts <= ?
        GROUP BY tool_name ORDER BY calls DESC
      `).bind(fromMs, toMs).all(),

      c.env.ZOE_DB.prepare(`
        SELECT ticket_category, COUNT(*) AS count
        FROM conversations
        WHERE first_ts >= ? AND first_ts <= ? AND ticket_category IS NOT NULL
        GROUP BY ticket_category ORDER BY count DESC
      `).bind(fromMs, toMs).all(),

      c.env.ZOE_DB.prepare(`
        SELECT sentiment, COUNT(*) AS count
        FROM conversations
        WHERE first_ts >= ? AND first_ts <= ?
        GROUP BY sentiment
      `).bind(fromMs, toMs).all(),
    ]);

    return c.json({
      summary: convRow,
      by_model: modelRows.results,
      by_tool: toolRows.results,
      by_ticket_category: ticketRows.results,
      by_sentiment: sentimentRows.results,
    });
  }

  // GET /dashboard/api/conversations?from=&to=&category=&page=
  // GET /dashboard/api/customers — lista raggruppata per phone_hash
  // Mostra UN record per cliente con totali aggregati e ID dell'ultima sessione
  // (utile per aprire il thread completo nel modal).
  if (path === '/customers') {
    const category = url.searchParams.get('category');
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10));
    const limit = 50;
    const catFilter = category ? `AND ticket_category = '${category.replace(/'/g, '')}'` : '';
    const rows = await c.env.ZOE_DB.prepare(`
      SELECT
        phone_hash,
        (SELECT phone_full FROM conversations c3 WHERE c3.phone_hash=conversations.phone_hash AND c3.phone_full IS NOT NULL ORDER BY c3.last_ts DESC LIMIT 1) AS phone_full,
        COUNT(*) AS sessions,
        SUM(user_turns) AS total_user_turns,
        SUM(assistant_turns) AS total_assistant_turns,
        MIN(first_ts) AS first_seen,
        MAX(last_ts) AS last_seen,
        SUM(CASE WHEN ticket_id IS NOT NULL THEN 1 ELSE 0 END) AS tickets_count,
        (SELECT id FROM conversations c2 WHERE c2.phone_hash=conversations.phone_hash ORDER BY c2.last_ts DESC LIMIT 1) AS latest_conv_id,
        (SELECT sentiment FROM conversations c2 WHERE c2.phone_hash=conversations.phone_hash ORDER BY c2.last_ts DESC LIMIT 1) AS latest_sentiment
      FROM conversations
      WHERE first_ts >= ? AND first_ts <= ? ${catFilter}
      GROUP BY phone_hash
      ORDER BY last_seen DESC LIMIT ? OFFSET ?
    `).bind(fromMs, toMs, limit, page * limit).all();
    const countRow = await c.env.ZOE_DB.prepare(`
      SELECT COUNT(DISTINCT phone_hash) AS n FROM conversations
      WHERE first_ts >= ? AND first_ts <= ? ${catFilter}
    `).bind(fromMs, toMs).first<{ n: number }>();
    return c.json({ customers: rows.results, total: countRow?.n ?? 0, page, limit });
  }

  if (path === '/conversations') {
    const category = url.searchParams.get('category');
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10));
    const limit = 50;

    let query: string;
    let bindings: unknown[];

    if (category) {
      query = `
        SELECT id, phone_hash, first_ts, last_ts, user_turns, assistant_turns,
               ticket_id, ticket_category, ticket_reason, ticket_urgency, sentiment, sentiment_note
        FROM conversations
        WHERE first_ts >= ? AND first_ts <= ? AND ticket_category = ?
        ORDER BY last_ts DESC LIMIT ? OFFSET ?
      `;
      bindings = [fromMs, toMs, category, limit, page * limit];
    } else {
      query = `
        SELECT id, phone_hash, first_ts, last_ts, user_turns, assistant_turns,
               ticket_id, ticket_category, ticket_reason, ticket_urgency, sentiment, sentiment_note
        FROM conversations
        WHERE first_ts >= ? AND first_ts <= ?
        ORDER BY last_ts DESC LIMIT ? OFFSET ?
      `;
      bindings = [fromMs, toMs, limit, page * limit];
    }

    const [rows, countRow] = await Promise.all([
      c.env.ZOE_DB.prepare(query).bind(...bindings).all(),
      category
        ? c.env.ZOE_DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE first_ts>=? AND first_ts<=? AND ticket_category=?`).bind(fromMs, toMs, category).first<{ n: number }>()
        : c.env.ZOE_DB.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE first_ts>=? AND first_ts<=?`).bind(fromMs, toMs).first<{ n: number }>(),
    ]);

    return c.json({ conversations: rows.results, total: countRow?.n ?? 0, page, limit });
  }

  // GET /dashboard/api/conversation/:id — dettaglio conv + intero thread messaggi
  const convMatch = path.match(/^\/conversation\/(.+)$/);
  if (convMatch) {
    const id = convMatch[1]!;
    const conv = await c.env.ZOE_DB.prepare(`SELECT * FROM conversations WHERE id=?`).bind(id).first<{
      id: string; phone_hash: string; first_ts: number; last_ts: number;
    }>();
    if (!conv) return c.json({ error: 'not_found' }, 404);
    const [apiCalls, toolCalls, messages, allConvs, findings] = await Promise.all([
      c.env.ZOE_DB.prepare(`SELECT * FROM api_calls WHERE conv_id=? ORDER BY ts`).bind(id).all(),
      c.env.ZOE_DB.prepare(`SELECT * FROM tool_calls WHERE conv_id=? ORDER BY ts`).bind(id).all(),
      // INTERO thread con il cliente (no scadenza, tutti i messaggi)
      c.env.ZOE_DB.prepare(
        `SELECT role, content, ts FROM messages WHERE phone_hash=? ORDER BY ts ASC`
      ).bind(conv.phone_hash).all(),
      // Tutte le conversazioni dello stesso cliente (sessioni)
      c.env.ZOE_DB.prepare(
        `SELECT id, first_ts, last_ts, user_turns, assistant_turns, sentiment, ticket_id, ticket_category
         FROM conversations WHERE phone_hash=? ORDER BY first_ts DESC`
      ).bind(conv.phone_hash).all(),
      c.env.ZOE_DB.prepare(
        `SELECT category, severity, problem, suggestion, analysis_date
         FROM review_findings WHERE phone_hash=? ORDER BY created_at DESC LIMIT 20`
      ).bind(conv.phone_hash).all(),
    ]);
    return c.json({
      conversation: conv,
      api_calls: apiCalls.results,
      tool_calls: toolCalls.results,
      messages: messages.results,
      sessions: allConvs.results,
      findings: findings.results,
    });
  }

  // GET /dashboard/api/findings — review giornaliera, ultimi 30 giorni
  if (path === '/findings') {
    const [findings, summary] = await Promise.all([
      c.env.ZOE_DB.prepare(`
        SELECT id, conv_id, analysis_date, category, severity, problem, suggestion, conv_excerpt
        FROM review_findings
        WHERE analysis_date >= date('now', '-30 days')
        ORDER BY analysis_date DESC,
          CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          created_at DESC
        LIMIT 500
      `).all(),
      c.env.ZOE_DB.prepare(`
        SELECT category, severity, COUNT(*) AS n
        FROM review_findings
        WHERE analysis_date >= date('now', '-30 days')
        GROUP BY category, severity
        ORDER BY n DESC
      `).all(),
    ]);
    return c.json({ findings: findings.results, summary: summary.results });
  }

  // GET /dashboard/api/investigate?phone=... — lookup full trace per numero
  if (path === '/investigate') {
    const phoneParam = url.searchParams.get('phone') ?? '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '3', 10), 20);
    if (!phoneParam) return c.json({ error: 'missing phone' }, 400);

    // Spoki/storia possono aver salvato l'hash di diverse forme del numero (+39…, 39…, 10 cifre).
    // Proviamo tutte le varianti plausibili finché non troviamo conversazioni.
    const digits = phoneParam.replace(/\D/g, '');
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    const with39 = last10.length === 10 ? '39' + last10 : digits;
    const variants = Array.from(new Set([
      digits,            // 393920057593
      last10,            // 3920057593
      with39,            // 393920057593 (idempotente)
      '+' + with39,      // +393920057593  ← formato Spoki più comune
      '+' + digits,
    ]));
    const hashes = await Promise.all(variants.map(v => phoneHash(v)));

    let ph = '';
    let convs: { results?: Record<string, unknown>[] } = { results: [] };
    for (const candidate of hashes) {
      const r = await c.env.ZOE_DB
        .prepare('SELECT * FROM conversations WHERE phone_hash = ? ORDER BY first_ts DESC LIMIT ?')
        .bind(candidate, limit)
        .all();
      if ((r.results ?? []).length > 0) {
        ph = candidate;
        convs = r;
        break;
      }
    }
    if (!ph) ph = hashes[0]!;
    const conversations = [];
    for (const conv of convs.results ?? []) {
      const convId = conv.id as string;
      const firstTs = conv.first_ts as number;
      const lastTs = conv.last_ts as number;
      const [msgs, tools, apis, thoughts] = await Promise.all([
        c.env.ZOE_DB.prepare(
          'SELECT role, content, ts FROM messages WHERE phone_hash = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC'
        ).bind(ph, firstTs, lastTs + 120_000).all(),
        c.env.ZOE_DB.prepare(
          'SELECT ts, tool_name, success, input_json, output_json, duration_ms FROM tool_calls WHERE conv_id = ? ORDER BY ts ASC'
        ).bind(convId).all(),
        c.env.ZOE_DB.prepare(
          'SELECT ts, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, iteration, stop_reason, cost_usd FROM api_calls WHERE conv_id = ? ORDER BY ts ASC'
        ).bind(convId).all(),
        c.env.ZOE_DB.prepare(
          'SELECT ts, iteration, text FROM assistant_thoughts WHERE conv_id = ? ORDER BY ts ASC'
        ).bind(convId).all(),
      ]);
      conversations.push({
        ...conv,
        messages: msgs.results ?? [],
        tool_calls: tools.results ?? [],
        api_calls: apis.results ?? [],
        thoughts: thoughts.results ?? [],
      });
    }
    return c.json({ phone_hash: ph, conversations });
  }

  // GET /dashboard/api/image-searches?from=&to=&limit= — ricerche immagini sperimentali
  if (path === '/image-searches') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
    const rows = await c.env.ZOE_DB.prepare(`
      SELECT f.id, f.conv_id, f.ts, f.source, f.suffix, f.candidates_json,
             f.reranked, f.rerank_winner, f.rerank_confidence, f.rerank_reasoning,
             f.final_handle, f.final_title, f.found_but_oos
      FROM fashion_clip_searches f
      WHERE f.ts >= ? AND f.ts <= ?
      ORDER BY f.ts DESC LIMIT ?
    `).bind(fromMs, toMs, limit).all();
    return c.json({ searches: rows.results ?? [] });
  }

  // GET /dashboard/api/cost-by-source — costi per giorno + sorgente (conversazioni vs review)
  if (path === '/cost-by-source') {
    const days = Math.min(parseInt(url.searchParams.get('days') ?? '30', 10), 90);
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const [byDay, topConvs, perConv] = await Promise.all([
      // Costo per giorno e sorgente
      c.env.ZOE_DB.prepare(`
        SELECT
          date(ts/1000, 'unixepoch') AS day,
          CASE WHEN conv_id LIKE 'review_%' THEN 'review' ELSE 'conversation' END AS source,
          SUM(cost_usd) AS cost,
          COUNT(*) AS calls,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens
        FROM api_calls
        WHERE ts >= ?
        GROUP BY day, source
        ORDER BY day DESC
      `).bind(sinceMs).all(),
      // Top 10 conversazioni più costose
      c.env.ZOE_DB.prepare(`
        SELECT a.conv_id, SUM(a.cost_usd) AS total_cost,
               COUNT(*) AS calls, SUM(a.input_tokens) AS input_tokens,
               c.phone_full, c.first_ts
        FROM api_calls a
        LEFT JOIN conversations c ON c.id = a.conv_id
        WHERE a.ts >= ? AND a.conv_id NOT LIKE 'review_%'
        GROUP BY a.conv_id
        ORDER BY total_cost DESC LIMIT 10
      `).bind(sinceMs).all(),
      // Statistiche per conversazione
      c.env.ZOE_DB.prepare(`
        SELECT
          AVG(s.cost) AS avg_cost,
          MAX(s.cost) AS max_cost,
          SUM(s.cost) AS total_cost,
          COUNT(*) AS conv_count
        FROM (
          SELECT conv_id, SUM(cost_usd) AS cost
          FROM api_calls
          WHERE ts >= ? AND conv_id NOT LIKE 'review_%'
          GROUP BY conv_id
        ) s
      `).bind(sinceMs).first(),
    ]);
    return c.json({
      by_day: byDay.results ?? [],
      top_conversations: topConvs.results ?? [],
      per_conv_stats: perConv,
    });
  }

  // POST /dashboard/api/run-review — trigger manuale (utile per test)
  if (path === '/run-review') {
    if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: 'no_anthropic_key' }, 503);
    const { runDailyReview } = await import('../analytics/dailyReview');
    const result = await runDailyReview(c.env.ZOE_DB, c.env.ANTHROPIC_API_KEY);
    return c.json(result);
  }

  return c.json({ error: 'not_found' }, 404);
}

export function handleDashboardHTML(_c: Context<{ Bindings: Env }>): Response {
  const html = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zoe Analytics Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1a2e;min-height:100vh}
#app{display:block}
header{background:#4f46e5;color:#fff;padding:16px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header h1{font-size:1.2rem;font-weight:700}
.filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-left:auto}
.filters label{font-size:.82rem;opacity:.8}
.filters input[type=date]{padding:6px 10px;border:1px solid rgba(255,255,255,.3);border-radius:6px;background:rgba(255,255,255,.15);color:#fff;font-size:.85rem}
.filters input[type=date]::-webkit-calendar-picker-indicator{filter:invert(1)}
.filters select{padding:6px 10px;border:1px solid rgba(255,255,255,.3);border-radius:6px;background:rgba(255,255,255,.15);color:#fff;font-size:.85rem}
.filters button{padding:7px 16px;background:#fff;color:#4f46e5;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:.85rem}
.filters button:hover{background:#e0e7ff}
main{padding:20px 24px;max-width:1400px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:20px}
.card{background:#fff;border-radius:10px;padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.card .label{font-size:.76rem;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.card .value{font-size:1.7rem;font-weight:700;color:#1a1a2e;margin-top:4px}
.card .sub{font-size:.78rem;color:#9ca3af;margin-top:2px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}
@media(max-width:900px){.grid2,.grid3{grid-template-columns:1fr}}
.panel{background:#fff;border-radius:10px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.panel h3{font-size:.9rem;font-weight:700;color:#374151;margin-bottom:14px;text-transform:uppercase;letter-spacing:.04em}
.chart-wrap{position:relative;height:220px}
table{width:100%;border-collapse:collapse;font-size:.82rem}
thead th{padding:8px 10px;text-align:left;background:#f9fafb;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb}
tbody tr:hover{background:#f9fafb}
tbody td{padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#374151}
.badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:.72rem;font-weight:600}
.badge-satisfied{background:#d1fae5;color:#065f46}
.badge-partial{background:#fef9c3;color:#854d0e}
.badge-unsatisfied{background:#fee2e2;color:#991b1b}
.badge-unknown{background:#f3f4f6;color:#6b7280}
.badge-ticket{background:#e0e7ff;color:#3730a3}
.badge-no-ticket{background:#f3f4f6;color:#6b7280}
.conv-row{cursor:pointer}
.pager{display:flex;gap:8px;margin-top:12px;align-items:center;font-size:.83rem}
.pager button{padding:4px 12px;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;background:#fff}
.pager button:hover{background:#f3f4f6}
.pager button:disabled{opacity:.4;cursor:default}
#conv-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100;align-items:center;justify-content:center}
#conv-modal.open{display:flex}
#conv-box{background:#fff;border-radius:12px;width:min(720px,95vw);max-height:85vh;overflow-y:auto;padding:28px;position:relative}
#conv-box h2{font-size:1rem;font-weight:700;margin-bottom:16px;color:#1a1a2e}
#conv-close{position:absolute;top:16px;right:16px;background:none;border:none;font-size:1.4rem;cursor:pointer;color:#6b7280}
.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;font-size:.82rem}
.meta-grid dt{color:#6b7280;font-weight:600}
.meta-grid dd{color:#374151}
.api-row{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:.78rem;flex-wrap:wrap}
.api-row span{background:#f3f4f6;padding:2px 7px;border-radius:5px;color:#374151}
.tool-pill{display:inline-block;margin:2px;padding:3px 9px;border-radius:9999px;font-size:.75rem;background:#ede9fe;color:#4f46e5;font-weight:600}
.msg-thread{max-height:50vh;overflow-y:auto;padding:10px;background:#f8fafc;border-radius:8px;border:1px solid #e5e7eb;margin-bottom:12px}
.msg{margin-bottom:10px;padding:8px 12px;border-radius:8px;max-width:85%;font-size:.85rem}
.msg-meta{font-size:.7rem;color:#94a3b8;margin-bottom:3px;font-weight:600}
.msg-text{white-space:pre-wrap;word-break:break-word}
.msg-user{background:#fff;border:1px solid #e5e7eb;margin-right:auto}
.msg-zoe{background:#dcfce7;border:1px solid #bbf7d0;margin-left:auto;text-align:left}
.msg-op{background:#fef3c7;border:1px solid #fde68a;margin-left:auto}
.msg-auto{background:#dbeafe;border:1px solid #bfdbfe;margin-left:auto}
.spinner{text-align:center;padding:30px;color:#9ca3af;font-size:.9rem}
</style>
</head>
<body>

<div id="app">
  <header>
    <h1>Zoe Analytics</h1>
    <div class="filters">
      <label>Da</label>
      <input type="date" id="f-from" />
      <label>A</label>
      <input type="date" id="f-to" />
      <select id="f-cat">
        <option value="">Tutte le categorie</option>
      </select>
      <button onclick="reload()">Aggiorna</button>
    </div>
  </header>
  <main>
    <div class="cards" id="cards"></div>
    <div class="grid3" id="charts-row1">
      <div class="panel"><h3>Costo per modello AI</h3><div class="chart-wrap"><canvas id="ch-model"></canvas></div></div>
      <div class="panel"><h3>Sentiment</h3><div class="chart-wrap"><canvas id="ch-sentiment"></canvas></div></div>
      <div class="panel"><h3>Categorie ticket</h3><div class="chart-wrap"><canvas id="ch-ticket"></canvas></div></div>
    </div>
    <div class="grid2" id="charts-row2">
      <div class="panel"><h3>Token per modello</h3><div class="chart-wrap"><canvas id="ch-tokens"></canvas></div></div>
      <div class="panel"><h3>Tool più usati</h3><div class="chart-wrap"><canvas id="ch-tools"></canvas></div></div>
    </div>
    <div class="panel" id="cost-breakdown-panel">
      <h3>💸 Costi per sorgente <button onclick="loadCostBreakdown()" style="float:right;font-size:12px;padding:4px 10px;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer">Aggiorna</button></h3>
      <div id="cost-breakdown-result"><p style="color:#94a3b8;font-size:.84rem">Caricamento…</p></div>
    </div>
    <div class="panel" id="investigate-panel">
      <h3>🔬 Indaga conversazione per numero</h3>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <input type="text" id="inv-phone" placeholder="es. 3334443334 o +393334443334" style="flex:1;min-width:220px;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem"/>
        <select id="inv-limit" style="padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem">
          <option value="1">Ultima</option>
          <option value="3" selected>Ultime 3</option>
          <option value="10">Ultime 10</option>
          <option value="20">Ultime 20</option>
        </select>
        <button onclick="runInvestigate()" style="padding:8px 18px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600">Cerca</button>
      </div>
      <div id="inv-result"></div>
    </div>
    <div class="panel" id="imgsearch-panel">
      <h3>🔍 Ricerche immagini sperimentali <button onclick="loadImageSearches()" style="float:right;font-size:12px;padding:4px 10px;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer">Aggiorna</button></h3>
      <div id="imgsearch-result"><p style="color:#94a3b8;font-size:.84rem">Clicca "Aggiorna" per caricare.</p></div>
    </div>
    <div class="panel" id="findings-panel">
      <h3>🔎 Review qualità (ultimi 30 giorni) <button id="run-review-btn" onclick="runReview()" style="float:right;font-size:12px">Esegui ora</button></h3>
      <div id="findings-summary" style="margin-bottom:12px"></div>
      <table id="findings-table">
        <thead><tr>
          <th>Data</th><th>Severità</th><th>Categoria</th><th>Problema</th><th>Suggerimento</th><th>Conv</th>
        </tr></thead>
        <tbody id="findings-tbody"></tbody>
      </table>
    </div>
    <div class="panel" id="conv-panel">
      <h3>Clienti (raggruppati per numero)</h3>
      <div id="conv-spinner" class="spinner">Caricamento…</div>
      <table id="conv-table" style="display:none">
        <thead><tr>
          <th>Telefono</th><th>Prima/Ultima</th><th>Sessioni</th><th>Turni tot.</th><th>Ticket</th><th>Sentiment ultimo</th>
        </tr></thead>
        <tbody id="conv-tbody"></tbody>
      </table>
      <div class="pager" id="pager">
        <button id="btn-prev" disabled onclick="prevPage()">← Prec</button>
        <span id="pager-info"></span>
        <button id="btn-next" disabled onclick="nextPage()">Succ →</button>
      </div>
    </div>
  </main>
</div>

<div id="conv-modal">
  <div id="conv-box">
    <button id="conv-close" onclick="closeModal()">×</button>
    <h2 id="modal-title">Conversazione</h2>
    <div id="modal-content"></div>
  </div>
</div>

<script>
let chartModel=null, chartSentiment=null, chartTicket=null, chartTokens=null, chartTools=null;
let convPage=0, convTotal=0;
const LIMIT=50;

function today(){ return new Date().toISOString().slice(0,10); }
function daysAgo(n){ const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function fmt(ts){ return ts ? new Date(ts).toLocaleString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; }
function fmtNum(n){ return n!=null ? Number(n).toLocaleString('it-IT') : '0'; }
function fmtCost(n){ return n!=null ? '$'+Number(n).toFixed(4) : '$0.0000'; }
function dur(a,b){ const m=Math.round((b-a)/60000); if(m<1)return '<1 min'; if(m<60)return m+' min'; return Math.round(m/60)+'h '+m%60+'m'; }

async function api(path,opts){
  const r=await fetch('/dashboard/api'+path,opts||{});
  if(!r.ok){const txt=await r.text().catch(()=>'');console.error('API error',r.status,txt.slice(0,200));return null;}
  try{return await r.json();}catch(e){console.error('API json parse error',e);return null;}
}

function initFilters(){
  document.getElementById('f-from').value=daysAgo(30);
  document.getElementById('f-to').value=today();
}

function getFilters(){
  return {from:document.getElementById('f-from').value,to:document.getElementById('f-to').value,cat:document.getElementById('f-cat').value};
}

async function reload(){
  const {from,to,cat}=getFilters();
  convPage=0;
  const [summary,convs,findings]=await Promise.all([
    api('/summary?from='+from+'&to='+to),
    loadConvs(from,to,cat,0),
    api('/findings')
  ]);
  if(summary) renderSummary(summary);
  if(convs) renderConvTable(convs);
  if(findings) renderFindings(findings);
}

function sevBadge(s){
  const colors={high:'#ef4444',medium:'#f59e0b',low:'#94a3b8'};
  const labels={high:'ALTA',medium:'MEDIA',low:'BASSA'};
  return '<span style="background:'+(colors[s]||'#94a3b8')+';color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">'+(labels[s]||s)+'</span>';
}

function renderFindings(data){
  const summary=data.summary||[];
  const sumEl=document.getElementById('findings-summary');
  const totals={high:0,medium:0,low:0,total:0};
  const byCat={};
  summary.forEach(r=>{
    totals[r.severity]=(totals[r.severity]||0)+r.n;
    totals.total+=r.n;
    byCat[r.category]=(byCat[r.category]||0)+r.n;
  });
  const catList=Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<span style="background:#1e293b;padding:3px 8px;border-radius:4px;margin-right:6px;font-size:12px">'+k+': '+v+'</span>').join('');
  sumEl.innerHTML='<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div><strong>'+totals.total+'</strong> problemi (<span style="color:#ef4444">'+totals.high+' alta</span>, <span style="color:#f59e0b">'+totals.medium+' media</span>, <span style="color:#94a3b8">'+totals.low+' bassa</span>)</div><div>'+catList+'</div></div>';

  const findings=data.findings||[];
  const tbody=document.getElementById('findings-tbody');
  tbody.innerHTML=findings.map(f=>'<tr>'+
    '<td>'+f.analysis_date+'</td>'+
    '<td>'+sevBadge(f.severity)+'</td>'+
    '<td style="font-family:monospace;font-size:12px">'+f.category+'</td>'+
    '<td>'+(f.problem||'').replace(/</g,'&lt;')+'</td>'+
    '<td style="color:#94a3b8">'+(f.suggestion||'').replace(/</g,'&lt;')+'</td>'+
    '<td><a href="#" onclick="openConv(\\''+f.conv_id+'\\');return false">apri</a></td>'+
    '</tr>').join('')||'<tr><td colspan="6" style="text-align:center;color:#94a3b8">Nessun problema rilevato</td></tr>';
}

async function runReview(){
  const btn=document.getElementById('run-review-btn');
  btn.disabled=true;btn.textContent='Esecuzione…';
  try{
    const r=await api('/run-review',{method:'POST'});
    if(r) alert('Review completata: '+r.analyzed+' conversazioni analizzate, '+r.findings+' problemi trovati');
    await reload();
  }catch(e){alert('Errore: '+e.message);}
  btn.disabled=false;btn.textContent='Esegui ora';
}

function renderSummary(d){
  const s=d.summary||{};
  document.getElementById('cards').innerHTML=\`
    <div class="card"><div class="label">Conversazioni</div><div class="value">\${fmtNum(s.total_conversations)}</div></div>
    <div class="card"><div class="label">Con ticket</div><div class="value">\${fmtNum(s.with_ticket)}</div><div class="sub">\${fmtNum(s.without_ticket)} senza ticket</div></div>
    <div class="card"><div class="label">Token input</div><div class="value">\${fmtNum(s.total_input_tokens)}</div><div class="sub">Cache: \${fmtNum(s.total_cache_read_tokens)}</div></div>
    <div class="card"><div class="label">Token output</div><div class="value">\${fmtNum(s.total_output_tokens)}</div></div>
    <div class="card"><div class="label">Costo totale</div><div class="value">\${fmtCost(s.total_cost_usd)}</div></div>
  \`;

  // Model cost chart
  const models=d.by_model||[];
  makeOrUpdate('chartModel','ch-model','doughnut',models.map(m=>m.model?.replace('claude-','')?.slice(0,12)),models.map(m=>+(+m.cost_usd).toFixed(4)),['#4f46e5','#7c3aed','#a78bfa','#c4b5fd'],d=>'\$'+d.toFixed(4));

  // Token chart
  makeOrUpdateBar('chartTokens','ch-tokens',models.map(m=>m.model?.replace('claude-','')?.slice(0,12)),[
    {label:'Input',data:models.map(m=>+m.input_tokens),color:'#4f46e5'},
    {label:'Output',data:models.map(m=>+m.output_tokens),color:'#7c3aed'},
    {label:'Cache',data:models.map(m=>+m.cache_read_tokens),color:'#a78bfa'},
  ]);

  // Sentiment chart
  const sentMap={satisfied:'#10b981',partial:'#f59e0b',unsatisfied:'#ef4444',unknown:'#9ca3af'};
  const sents=d.by_sentiment||[];
  const sentLabels=sents.map(s=>s.sentiment);
  const sentData=sents.map(s=>+s.count);
  makeOrUpdate('chartSentiment','ch-sentiment','pie',sentLabels,sentData,sentLabels.map(l=>sentMap[l]||'#9ca3af'),v=>v);

  // Ticket chart
  const tickets=d.by_ticket_category||[];
  const colors=['#4f46e5','#7c3aed','#ec4899','#f59e0b','#10b981','#06b6d4','#ef4444'];
  makeOrUpdate('chartTicket','ch-ticket','doughnut',tickets.map(t=>t.ticket_category||'altro'),tickets.map(t=>+t.count),colors.slice(0,tickets.length),v=>v);

  // Tools chart
  const tools=d.by_tool||[];
  makeOrUpdateBar('chartTools','ch-tools',tools.slice(0,10).map(t=>t.tool_name?.replace('_',' ')?.replace('_',' ')),
    [{label:'Chiamate',data:tools.slice(0,10).map(t=>+t.calls),color:'#4f46e5'}]);

  // Populate category filter
  const catSel=document.getElementById('f-cat');
  const existing=Array.from(catSel.options).map(o=>o.value);
  for(const t of tickets){
    if(t.ticket_category && !existing.includes(t.ticket_category)){
      const o=document.createElement('option');
      o.value=t.ticket_category; o.textContent=t.ticket_category;
      catSel.appendChild(o);
    }
  }
}

function makeOrUpdate(ref,canvasId,type,labels,data,colors,fmtTooltip){
  const ctx=document.getElementById(canvasId).getContext('2d');
  if(window[ref]){window[ref].destroy();}
  window[ref]=new Chart(ctx,{type,data:{labels,datasets:[{data,backgroundColor:colors,borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{font:{size:11},boxWidth:12}},tooltip:{callbacks:{label:ctx=>ctx.label+': '+fmtTooltip(ctx.parsed)}}}}});
}
function makeOrUpdateBar(ref,canvasId,labels,datasets){
  const ctx=document.getElementById(canvasId).getContext('2d');
  if(window[ref]){window[ref].destroy();}
  window[ref]=new Chart(ctx,{type:'bar',data:{labels,datasets:datasets.map(d=>({label:d.label,data:d.data,backgroundColor:d.color+'cc',borderColor:d.color,borderWidth:1}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{font:{size:11},boxWidth:12}}},scales:{x:{ticks:{font:{size:10}}},y:{beginAtZero:true,ticks:{font:{size:10}}}}}});
}

async function loadConvs(from,to,cat,page){
  document.getElementById('conv-spinner').style.display='block';
  document.getElementById('conv-table').style.display='none';
  // Lista raggruppata per cliente (phone_hash).
  let url='/customers?from='+from+'&to='+to+'&page='+page;
  if(cat) url+='&category='+encodeURIComponent(cat);
  const data=await api(url);
  document.getElementById('conv-spinner').style.display='none';
  return data;
}

function renderConvTable(d){
  const rows=d.customers||[];
  convTotal=d.total||0;
  const tbody=document.getElementById('conv-tbody');
  tbody.innerHTML=rows.map(r=>\`<tr class="conv-row" onclick="openConv('\${r.latest_conv_id}')">
    <td style="font-family:monospace;font-size:12px">\${r.phone_full ? '+'+r.phone_full : (r.phone_hash||'').slice(0,12)+'…'}</td>
    <td>\${fmt(r.first_seen)}<br><span style="color:#94a3b8;font-size:11px">\${fmt(r.last_seen)}</span></td>
    <td>\${r.sessions||0}</td>
    <td>\${r.total_user_turns||0}u / \${r.total_assistant_turns||0}a</td>
    <td>\${r.tickets_count>0?'<span class="badge badge-ticket">'+r.tickets_count+'</span>':'<span class="badge badge-no-ticket">0</span>'}</td>
    <td><span class="badge badge-\${r.latest_sentiment||'unknown'}">\${r.latest_sentiment||'?'}</span></td>
  </tr>\`).join('');
  document.getElementById('conv-table').style.display='table';

  const info=\`\${d.page*LIMIT+1}–\${Math.min((d.page+1)*LIMIT,convTotal)} di \${convTotal} clienti\`;
  document.getElementById('pager-info').textContent=info;
  document.getElementById('btn-prev').disabled=d.page===0;
  document.getElementById('btn-next').disabled=(d.page+1)*LIMIT>=convTotal;
}

async function prevPage(){
  convPage=Math.max(0,convPage-1);
  const {from,to,cat}=getFilters();
  const data=await loadConvs(from,to,cat,convPage);
  if(data)renderConvTable(data);
}
async function nextPage(){
  convPage++;
  const {from,to,cat}=getFilters();
  const data=await loadConvs(from,to,cat,convPage);
  if(data)renderConvTable(data);
}

async function openConv(id){
  document.getElementById('conv-modal').classList.add('open');
  document.getElementById('modal-content').innerHTML='<div class="spinner">Caricamento…</div>';
  document.getElementById('modal-title').textContent='Conversazione '+id.slice(0,20)+'…';
  const d=await api('/conversation/'+encodeURIComponent(id));
  if(!d){document.getElementById('modal-content').innerHTML='<p>Errore caricamento.</p>';return;}
  const c=d.conversation||{};
  const calls=d.api_calls||[];
  const tools=d.tool_calls||[];
  const totalCost=calls.reduce((s,a)=>s+(+a.cost_usd||0),0);
  const totalIn=calls.reduce((s,a)=>s+(+a.input_tokens||0),0);
  const totalOut=calls.reduce((s,a)=>s+(+a.output_tokens||0),0);
  const totalCache=calls.reduce((s,a)=>s+(+a.cache_read_tokens||0),0);

  const msgs=d.messages||[];
  const sessions=d.sessions||[];
  const findings=d.findings||[];

  function classifyMsg(m){
    if(m.role==='user') return {who:'Cliente',cls:'msg-user',text:m.content};
    // assistant: distingui via tag in content
    if(m.content.startsWith('[Operatore CC]:')) return {who:'Operatore CC',cls:'msg-op',text:m.content.replace(/^\\[Operatore CC\\]:\\s*/,'')};
    if(m.content.startsWith('[Notifica Zuiki]:')) return {who:'Notifica Zuiki',cls:'msg-auto',text:m.content.replace(/^\\[Notifica Zuiki\\]:\\s*/,'')};
    return {who:'Zoe',cls:'msg-zoe',text:m.content};
  }

  document.getElementById('modal-content').innerHTML=\`
    <dl class="meta-grid">
      <dt>Cliente</dt><dd style="font-family:monospace">\${c.phone_full ? '+'+c.phone_full : ''} <span style="color:#94a3b8;font-size:11px">\${c.phone_hash}</span></dd>
      <dt>Sessione corrente</dt><dd>\${fmt(c.first_ts)} → \${fmt(c.last_ts)}</dd>
      <dt>Tutte le sessioni</dt><dd>\${sessions.length} con questo cliente</dd>
      <dt>Sentiment ultimo</dt><dd><span class="badge badge-\${c.sentiment||'unknown'}">\${c.sentiment||'?'}</span> \${c.sentiment_note||''}</dd>
      <dt>Ticket</dt><dd>\${c.ticket_id||'—'} \${c.ticket_category?'('+c.ticket_category+')':''}</dd>
    </dl>

    \${findings.length?\`<h3 style="font-size:.82rem;font-weight:700;color:#ef4444;text-transform:uppercase;margin:12px 0 8px">⚠️ Findings review qualità (\${findings.length})</h3>
    <div style="margin-bottom:12px">\${findings.map(f=>\`<div style="border-left:3px solid \${f.severity==='high'?'#ef4444':f.severity==='medium'?'#f59e0b':'#94a3b8'};padding:8px 12px;margin-bottom:8px;background:#f8fafc;border-radius:4px">
      <div style="font-size:11px;color:#64748b">\${f.analysis_date} · \${f.category} · \${f.severity}</div>
      <div style="margin:4px 0"><strong>Problema:</strong> \${(f.problem||'').replace(/</g,'&lt;')}</div>
      <div style="color:#475569"><strong>Suggerimento:</strong> \${(f.suggestion||'').replace(/</g,'&lt;')}</div>
    </div>\`).join('')}</div>\`:''}

    <h3 style="font-size:.82rem;font-weight:700;color:#6b7280;text-transform:uppercase;margin:12px 0 8px">Thread completo (\${msgs.length} messaggi)</h3>
    <div class="msg-thread">\${msgs.map(m=>{const k=classifyMsg(m);return \`<div class="msg \${k.cls}"><div class="msg-meta">\${k.who} · \${fmt(m.ts)}</div><div class="msg-text">\${(k.text||'').replace(/</g,'&lt;').replace(/\\n/g,'<br>')}</div></div>\`;}).join('')||'<p style="color:#94a3b8">Nessun messaggio in D1 per questo cliente</p>'}</div>

    <h3 style="font-size:.82rem;font-weight:700;color:#6b7280;text-transform:uppercase;margin:16px 0 8px">Chiamate AI sessione corrente (\${calls.length}) — Tot: \${fmtCost(totalCost)} | In: \${fmtNum(totalIn)} | Out: \${fmtNum(totalOut)} | Cache: \${fmtNum(totalCache)}</h3>
    \${calls.map(a=>\`<div class="api-row">
      <span>#\${a.iteration}</span>
      <span>\${a.model?.replace('claude-','')?.slice(0,14)}</span>
      <span>In:\${fmtNum(a.input_tokens)}</span>
      <span>Out:\${fmtNum(a.output_tokens)}</span>
      <span>Cache:\${fmtNum(a.cache_read_tokens)}</span>
      <span>\${fmtCost(a.cost_usd)}</span>
      <span>\${a.latency_ms}ms</span>
      <span>\${a.stop_reason||'—'}</span>
    </div>\`).join('')}
    <h3 style="font-size:.82rem;font-weight:700;color:#6b7280;text-transform:uppercase;margin:12px 0 8px">Tool usati (\${tools.length})</h3>
    <div>\${tools.map(t=>\`<span class="tool-pill">\${t.tool_name}</span>\`).join('')||'nessuno'}</div>
  \`;
}

const TOOL_ICONS={search_products:'🔍',get_product_by_handle:'📦',check_availability:'🏬',check_store_availability:'🏪',find_similar_product:'✨',get_order_by_name_and_email:'🧾',open_support_ticket:'🎫',get_return_by_rma:'↩️',search_stores:'🗺️',get_store_details:'📍'};

function fmtTime(ts){return new Date(ts).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}

async function runInvestigate(){
  const phone=document.getElementById('inv-phone').value.trim();
  const limit=document.getElementById('inv-limit').value;
  const res=document.getElementById('inv-result');
  if(!phone){res.innerHTML='<p style="color:#ef4444">Inserisci un numero.</p>';return;}
  res.innerHTML='<div class="spinner">Caricamento…</div>';
  const data=await api('/investigate?phone='+encodeURIComponent(phone)+'&limit='+limit);
  if(!data){res.innerHTML='<p style="color:#ef4444">Errore.</p>';return;}
  const convs=data.conversations||[];
  if(!convs.length){res.innerHTML='<p style="color:#94a3b8">Nessuna conversazione trovata per questo numero. (hash provato: '+data.phone_hash+')<br>Prova con/senza prefisso 39.</p>';return;}
  res.innerHTML=convs.map(c=>renderInvConv(c)).join('');
}

function renderInvConv(c){
  const events=[];
  (c.messages||[]).forEach(m=>events.push({ts:m.ts,type:'msg',role:m.role,content:m.content}));
  (c.tool_calls||[]).forEach(t=>events.push({ts:t.ts,type:'tool',name:t.tool_name,success:!!t.success,input_json:t.input_json,output_json:t.output_json,duration_ms:t.duration_ms}));
  (c.api_calls||[]).forEach(a=>events.push({ts:a.ts,type:'api',...a}));
  (c.thoughts||[]).forEach(th=>events.push({ts:th.ts,type:'thought',iteration:th.iteration,text:th.text}));
  events.sort((a,b)=>a.ts-b.ts);
  const timeline=events.map(e=>{
    const t=fmtTime(e.ts);
    if(e.type==='msg'){
      const isUser=e.role==='user';
      const who=isUser?'👤 Cliente':'🤖 Zoe';
      const bg=isUser?'#fff':'#dcfce7';
      const border=isUser?'#e5e7eb':'#bbf7d0';
      const align=isUser?'left':'right';
      const raw=e.content||'';
      const long=raw.length>240;
      const escFull=raw.replace(/</g,'&lt;').replace(/\\n/g,'<br>');
      const escShort=raw.slice(0,240).replace(/</g,'&lt;').replace(/\\n/g,'<br>')+'…';
      const mid='m-'+Math.random().toString(36).slice(2,9);
      const body=long
        ? '<div id="'+mid+'-s" style="font-size:13px;margin-top:3px">'+escShort+' <a href="#" onclick="document.getElementById(\\''+mid+'-s\\').style.display=\\'none\\';document.getElementById(\\''+mid+'-f\\').style.display=\\'block\\';return false" style="color:#4f46e5;font-size:11px">[espandi]</a></div><div id="'+mid+'-f" style="display:none;font-size:13px;margin-top:3px">'+escFull+' <a href="#" onclick="document.getElementById(\\''+mid+'-f\\').style.display=\\'none\\';document.getElementById(\\''+mid+'-s\\').style.display=\\'block\\';return false" style="color:#4f46e5;font-size:11px">[riduci]</a></div>'
        : '<div style="font-size:13px;margin-top:3px">'+escFull+'</div>';
      return '<div style="margin:8px 0;text-align:'+align+'"><div style="display:inline-block;max-width:80%;background:'+bg+';border:1px solid '+border+';border-radius:8px;padding:8px 12px;text-align:left"><div style="font-size:11px;color:#64748b;font-weight:600">'+who+' · '+t+'</div>'+body+'</div></div>';
    }
    if(e.type==='tool'){
      const icon=TOOL_ICONS[e.name]||'🔧';
      const status=e.success?'<span style="color:#10b981">✓</span>':'<span style="color:#ef4444">✗</span>';
      const dur=e.duration_ms?' <span style="color:#94a3b8">'+e.duration_ms+'ms</span>':'';
      let inputSummary='';
      if(e.input_json){
        try{
          const inp=JSON.parse(e.input_json);
          inputSummary=' <span style="color:#4f46e5">'+Object.entries(inp).map(([k,v])=>k+'='+JSON.stringify(v).slice(0,60)).join(' ')+'</span>';
        }catch{ inputSummary=' '+e.input_json.slice(0,120); }
      }
      const detailId='td-'+Math.random().toString(36).slice(2,9);
      const hasDetails=e.input_json||e.output_json;
      const expander=hasDetails?'<a href="#" onclick="document.getElementById(\\''+detailId+'\\').style.display=document.getElementById(\\''+detailId+'\\').style.display===\\'block\\'?\\'none\\':\\'block\\';return false" style="color:#4f46e5;font-size:11px;margin-left:8px">[dettagli]</a>':'';
      const details=hasDetails?'<div id="'+detailId+'" style="display:none;margin:4px 0 4px 24px;padding:8px 10px;background:#1e293b;color:#e2e8f0;border-radius:6px;font-size:11px;font-family:monospace;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto"><div style="color:#94a3b8;margin-bottom:4px">INPUT:</div>'+(e.input_json||'(nessuno)').replace(/</g,'&lt;')+'<div style="color:#94a3b8;margin:8px 0 4px">OUTPUT:</div>'+(e.output_json||'(nessuno)').replace(/</g,'&lt;')+'</div>':'';
      return '<div style="font-size:12px;color:#475569;padding:2px 0;font-family:monospace">  ['+t+'] '+icon+' '+status+' <b>'+e.name+'</b>'+inputSummary+dur+expander+'</div>'+details;
    }
    if(e.type==='thought'){
      const tid='th-'+Math.random().toString(36).slice(2,9);
      const preview=(e.text||'').slice(0,80).replace(/</g,'&lt;').replace(/\\n/g,' ');
      const full=(e.text||'').replace(/</g,'&lt;').replace(/\\n/g,'<br>');
      const more=(e.text||'').length>80?' …':'';
      return '<div style="font-size:12px;color:#7c3aed;padding:3px 0;font-family:monospace">  ['+t+'] 💭 <i>'+preview+more+'</i> <a href="#" onclick="document.getElementById(\\''+tid+'\\').style.display=document.getElementById(\\''+tid+'\\').style.display===\\'block\\'?\\'none\\':\\'block\\';return false" style="color:#4f46e5;font-size:11px">[mostra]</a></div>'+
        '<div id="'+tid+'" style="display:none;margin:4px 0 4px 24px;padding:10px 12px;background:#f5f3ff;border-left:3px solid #7c3aed;border-radius:4px;font-size:13px;color:#4c1d95;font-family:inherit;line-height:1.4">'+full+'</div>';
    }
    const cost=e.cost_usd!=null?'$'+Number(e.cost_usd).toFixed(4):'';
    return '<div style="font-size:11px;color:#94a3b8;padding:1px 0;font-family:monospace">  ['+t+'] 🧠 iter='+e.iteration+' in='+e.input_tokens+' out='+e.output_tokens+' cache='+e.cache_read_tokens+' '+e.latency_ms+'ms '+e.stop_reason+' '+cost+'</div>';
  }).join('');
  const meta='<div style="font-weight:700;font-size:.9rem;color:#1a1a2e;margin-bottom:6px">'+fmt(c.first_ts)+' → '+fmt(c.last_ts)+'</div>'+
    '<div style="font-size:.8rem;color:#6b7280;margin-bottom:10px">'+
    (c.user_turns||0)+'u / '+(c.assistant_turns||0)+'a · '+
    (c.total_cost_usd?fmtCost(c.total_cost_usd):'$0')+' · '+
    (c.ticket_id?'<span class="badge badge-ticket">'+c.ticket_id+' '+(c.ticket_category||'')+'</span>':'no ticket')+' · '+
    '<span class="badge badge-'+(c.sentiment||'unknown')+'">'+(c.sentiment||'?')+'</span>'+
    '</div>';
  return '<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:14px;background:#f8fafc">'+meta+timeline+'</div>';
}

function closeModal(){document.getElementById('conv-modal').classList.remove('open');}
document.getElementById('conv-modal').addEventListener('click',e=>{if(e.target===document.getElementById('conv-modal'))closeModal();});

document.getElementById('inv-phone').addEventListener('keydown',e=>{if(e.key==='Enter')runInvestigate();});

async function loadImageSearches(){

  const {from,to}=getFilters();
  const el=document.getElementById('imgsearch-result');
  el.innerHTML='<div class="spinner">Caricamento…</div>';
  const data=await api('/image-searches?from='+from+'&to='+to+'&limit=50');
  if(!data){el.innerHTML='<p style="color:#ef4444">Errore.</p>';return;}
  const rows=data.searches||[];
  if(!rows.length){el.innerHTML='<p style="color:#94a3b8;font-size:.84rem">Nessuna ricerca immagine nel periodo selezionato.</p>';return;}
  el.innerHTML='<table style="width:100%;border-collapse:collapse;font-size:.79rem"><thead><tr style="background:#f9fafb"><th style="padding:6px 8px;text-align:left;color:#6b7280">Ora</th><th style="padding:6px 8px;text-align:left;color:#6b7280">Sorgente</th><th style="padding:6px 8px;text-align:left;color:#6b7280">Top-1 Vectorize</th><th style="padding:6px 8px;text-align:left;color:#6b7280">Re-rank</th><th style="padding:6px 8px;text-align:left;color:#6b7280">Risultato finale</th><th style="padding:6px 8px;text-align:left;color:#6b7280">Conv</th></tr></thead><tbody>'+
  rows.map(r=>{
    let candidates=[];
    try{candidates=JSON.parse(r.candidates_json||'[]');}catch{}
    const top1=candidates[0]||{};
    const rerankBadge=r.reranked
      ?'<span style="background:#d1fae5;color:#065f46;padding:2px 7px;border-radius:4px;font-size:11px">✓ '+Math.round((r.rerank_confidence||0)*100)+'%</span>'
      :'<span style="color:#94a3b8;font-size:11px">—</span>';
    const rerankChanged=r.reranked&&r.rerank_winner&&r.rerank_winner!==top1.handle;
    const rerankNote=rerankChanged?'<br><span style="color:#f59e0b;font-size:10px">⚡ cambiato da '+top1.handle+'</span>':'';
    const oosBadge=r.found_but_oos?'<span style="background:#fee2e2;color:#991b1b;padding:2px 7px;border-radius:4px;font-size:11px;margin-left:4px">OOS</span>':'';
    const detId='fcs-'+Math.random().toString(36).slice(2,8);
    const candidateList=candidates.slice(0,5).map((c,i)=>'<div style="font-size:10px;color:#64748b">'+(i+1)+'. '+c.handle+' ('+Math.round((c.similarity||0)*100)+'%)</div>').join('');
    return '<tr style="border-bottom:1px solid #f3f4f6">'+
      '<td style="padding:5px 8px;font-size:11px;color:#64748b">'+fmtTime(r.ts)+'</td>'+
      '<td style="padding:5px 8px"><span style="background:#ede9fe;color:#4f46e5;padding:2px 6px;border-radius:4px;font-size:11px">'+(r.source||'?')+(r.suffix?' ('+r.suffix+')':'')+'</span></td>'+
      '<td style="padding:5px 8px"><span style="font-size:12px">'+top1.handle+'</span><span style="color:#94a3b8;font-size:10px;margin-left:4px">'+(top1.similarity?Math.round(top1.similarity*100)+'%':'')+'</span>'+
        '<a href="#" data-toggle="'+detId+'" onclick="toggleDet(this);return false" style="color:#4f46e5;font-size:10px;margin-left:6px">[tutti]</a>'+
        '<div id="'+detId+'" style="display:none">'+candidateList+'</div></td>'+
      '<td style="padding:5px 8px">'+rerankBadge+(r.rerank_reasoning?'<br><span style="font-size:10px;color:#475569">'+r.rerank_reasoning.slice(0,80).replace(/</g,'&lt;')+'</span>':'')+'</td>'+
      '<td style="padding:5px 8px"><span style="font-size:12px">'+(r.final_handle||'—')+'</span>'+rerankNote+oosBadge+'<br><span style="font-size:10px;color:#94a3b8">'+(r.final_title||'').slice(0,40).replace(/</g,'&lt;')+'</span></td>'+
      '<td style="padding:5px 8px"><a href="#" data-conv="'+r.conv_id+'" onclick="openConv(this.dataset.conv);return false" style="color:#4f46e5;font-size:11px">apri</a></td>'+
    '</tr>';
  }).join('')+'</tbody></table>';
}

function toggleDet(el){const id=el.dataset.toggle;const d=document.getElementById(id);d.style.display=d.style.display==='block'?'none':'block';}

async function loadCostBreakdown(){
  const el=document.getElementById('cost-breakdown-result');
  el.innerHTML='<div class="spinner">Caricamento…</div>';
  const data=await api('/cost-by-source?days=30');
  if(!data){el.innerHTML='<p style="color:#ef4444">Errore.</p>';return;}

  const byDay=data.by_day||[];
  const topConvs=data.top_conversations||[];
  const stats=data.per_conv_stats||{};

  // Aggrega per giorno (conv + review separati)
  const dayMap={};
  byDay.forEach(r=>{
    if(!dayMap[r.day])dayMap[r.day]={day:r.day,conversation:0,review:0};
    dayMap[r.day][r.source]=(dayMap[r.day][r.source]||0)+(+r.cost||0);
  });
  const days=Object.values(dayMap).sort((a,b)=>a.day<b.day?-1:1);

  // Totali
  const totConv=byDay.filter(r=>r.source==='conversation').reduce((s,r)=>s+(+r.cost||0),0);
  const totRev=byDay.filter(r=>r.source==='review').reduce((s,r)=>s+(+r.cost||0),0);

  // Giorno più costoso
  const maxDay=days.reduce((m,d)=>((d.conversation+d.review)>(m.conversation+m.review)?d:m),{day:'—',conversation:0,review:0});

  el.innerHTML=\`
  <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px">
    <div class="card" style="flex:1;min-width:140px"><div class="label">Conv (30gg)</div><div class="value" style="font-size:1.3rem">\${fmtCost(totConv)}</div><div class="sub">\${stats.conv_count||0} conv, media \${fmtCost(stats.avg_cost||0)}</div></div>
    <div class="card" style="flex:1;min-width:140px"><div class="label">Review notturna (30gg)</div><div class="value" style="font-size:1.3rem">\${fmtCost(totRev)}</div><div class="sub">Opus analisi qualità</div></div>
    <div class="card" style="flex:1;min-width:140px"><div class="label">Giorno più caro</div><div class="value" style="font-size:1.1rem">\${maxDay.day}</div><div class="sub">\${fmtCost((maxDay.conversation||0)+(maxDay.review||0))}</div></div>
    <div class="card" style="flex:1;min-width:140px"><div class="label">Conv più cara</div><div class="value" style="font-size:1.1rem">\${fmtCost(stats.max_cost||0)}</div><div class="sub">singola conversazione</div></div>
  </div>
  <div style="margin-bottom:14px">
    <div style="font-size:.8rem;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Costo per giorno (ultime 30gg)</div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.8rem">
      <thead><tr style="background:#f9fafb"><th style="padding:5px 8px;text-align:left;color:#6b7280">Giorno</th><th style="padding:5px 8px;text-align:right;color:#4f46e5">Conversazioni</th><th style="padding:5px 8px;text-align:right;color:#7c3aed">Review</th><th style="padding:5px 8px;text-align:right;color:#374151">Totale</th></tr></thead>
      <tbody>\${days.slice().reverse().map(d=>{
        const tot=(d.conversation||0)+(d.review||0);
        const barW=Math.round((tot/((maxDay.conversation||0)+(maxDay.review||0)))*100);
        return '<tr style="border-bottom:1px solid #f3f4f6">'+
          '<td style="padding:4px 8px;font-family:monospace;font-size:11px">'+d.day+'</td>'+
          '<td style="padding:4px 8px;text-align:right;color:#4f46e5">'+fmtCost(d.conversation||0)+'</td>'+
          '<td style="padding:4px 8px;text-align:right;color:#7c3aed">'+fmtCost(d.review||0)+'</td>'+
          '<td style="padding:4px 8px;text-align:right;font-weight:600"><div style="display:flex;align-items:center;gap:6px;justify-content:flex-end"><div style="height:6px;background:#4f46e5;border-radius:3px;width:'+barW+'px;min-width:2px;max-width:80px"></div>'+fmtCost(tot)+'</div></td>'+
        '</tr>';
      }).join('')}</tbody>
    </table></div>
  </div>
  \${topConvs.length?
  '<div><div style="font-size:.8rem;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Top 10 conversazioni più costose</div>'+
  '<table style="width:100%;border-collapse:collapse;font-size:.8rem">'+
  '<thead><tr style="background:#f9fafb"><th style="padding:5px 8px;text-align:left;color:#6b7280">Cliente</th><th style="padding:5px 8px;text-align:right;color:#6b7280">Costo</th><th style="padding:5px 8px;text-align:right;color:#6b7280">Chiamate</th><th style="padding:5px 8px;text-align:right;color:#6b7280">Token in</th><th style="padding:5px 8px;text-align:left;color:#6b7280">Data</th></tr></thead>'+
  '<tbody>'+topConvs.map(c=>'<tr style="border-bottom:1px solid #f3f4f6">'+
    '<td style="padding:4px 8px"><a href="#" data-conv="'+c.conv_id+'" onclick="openConv(this.dataset.conv);return false" style="color:#4f46e5;font-size:11px">'+(c.phone_full?'+'+c.phone_full:c.conv_id.slice(0,16)+'…')+'</a></td>'+
    '<td style="padding:4px 8px;text-align:right;font-weight:600;color:#ef4444">'+fmtCost(c.total_cost)+'</td>'+
    '<td style="padding:4px 8px;text-align:right;color:#6b7280">'+c.calls+'</td>'+
    '<td style="padding:4px 8px;text-align:right;color:#6b7280">'+fmtNum(c.input_tokens)+'</td>'+
    '<td style="padding:4px 8px;font-size:11px;color:#94a3b8">'+fmt(c.first_ts)+'</td>'+
  '</tr>').join('')+
  '</tbody></table></div>'
  :''}\`;
}

initFilters();
reload();
loadCostBreakdown();
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
