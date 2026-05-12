import type { Context } from 'hono';
import type { Env } from '../config';

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
  if (!checkAuth(c)) return c.json({ error: 'unauthorized' }, 401);
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

  // GET /dashboard/api/conversation/:id
  const convMatch = path.match(/^\/conversation\/(.+)$/);
  if (convMatch) {
    const id = convMatch[1]!;
    const [conv, apiCalls, toolCalls] = await Promise.all([
      c.env.ZOE_DB.prepare(`SELECT * FROM conversations WHERE id=?`).bind(id).first(),
      c.env.ZOE_DB.prepare(`SELECT * FROM api_calls WHERE conv_id=? ORDER BY ts`).bind(id).all(),
      c.env.ZOE_DB.prepare(`SELECT * FROM tool_calls WHERE conv_id=? ORDER BY ts`).bind(id).all(),
    ]);
    if (!conv) return c.json({ error: 'not_found' }, 404);
    return c.json({ conversation: conv, api_calls: apiCalls.results, tool_calls: toolCalls.results });
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
#login{display:flex;align-items:center;justify-content:center;min-height:100vh}
#login-box{background:#fff;border-radius:12px;padding:40px;width:320px;box-shadow:0 4px 20px rgba(0,0,0,.1)}
#login-box h2{margin-bottom:20px;color:#4f46e5;font-size:1.4rem}
#login-box input{width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:.95rem;margin-bottom:12px}
#login-box button{width:100%;padding:11px;background:#4f46e5;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:.95rem;font-weight:600}
#login-box button:hover{background:#4338ca}
#login-err{color:#ef4444;font-size:.85rem;margin-top:8px;display:none}
#app{display:none}
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
.spinner{text-align:center;padding:30px;color:#9ca3af;font-size:.9rem}
</style>
</head>
<body>

<div id="login">
  <div id="login-box">
    <h2>🤖 Zoe Dashboard</h2>
    <input type="password" id="pwd" placeholder="Password" autocomplete="current-password"/>
    <button onclick="doLogin()">Accedi</button>
    <div id="login-err">Password non valida.</div>
  </div>
</div>

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
    <div class="panel" id="conv-panel">
      <h3>Conversazioni</h3>
      <div id="conv-spinner" class="spinner">Caricamento…</div>
      <table id="conv-table" style="display:none">
        <thead><tr>
          <th>Data</th><th>Durata</th><th>Turni</th><th>Ticket</th><th>Categoria</th><th>Sentiment</th><th>Costo</th>
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
let SECRET = '';
let chartModel=null, chartSentiment=null, chartTicket=null, chartTokens=null, chartTools=null;
let convPage=0, convTotal=0;
const LIMIT=50;

function today(){ return new Date().toISOString().slice(0,10); }
function daysAgo(n){ const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function fmt(ts){ return ts ? new Date(ts).toLocaleString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; }
function fmtNum(n){ return n!=null ? Number(n).toLocaleString('it-IT') : '0'; }
function fmtCost(n){ return n!=null ? '$'+Number(n).toFixed(4) : '$0.0000'; }
function dur(a,b){ const m=Math.round((b-a)/60000); if(m<1)return '<1 min'; if(m<60)return m+' min'; return Math.round(m/60)+'h '+m%60+'m'; }

async function api(path){
  const r=await fetch('/dashboard/api'+path,{headers:{Authorization:'Bearer '+SECRET}});
  if(r.status===401){logout();return null;}
  return r.json();
}

function doLogin(){
  SECRET=document.getElementById('pwd').value.trim();
  api('/summary?from='+daysAgo(30)+'&to='+today()).then(data=>{
    if(!data||data.error){document.getElementById('login-err').style.display='block';SECRET='';return;}
    document.getElementById('login').style.display='none';
    document.getElementById('app').style.display='block';
    sessionStorage.setItem('dash_secret',SECRET);
    initFilters();
    reload();
  });
}
document.getElementById('pwd').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});

function logout(){SECRET='';sessionStorage.removeItem('dash_secret');document.getElementById('login').style.display='flex';document.getElementById('app').style.display='none';}

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
  const [summary,convs]=await Promise.all([
    api('/summary?from='+from+'&to='+to),
    loadConvs(from,to,cat,0)
  ]);
  if(summary) renderSummary(summary);
  if(convs) renderConvTable(convs);
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
  let url='/conversations?from='+from+'&to='+to+'&page='+page;
  if(cat) url+='&category='+encodeURIComponent(cat);
  const data=await api(url);
  document.getElementById('conv-spinner').style.display='none';
  return data;
}

function renderConvTable(d){
  const rows=d.conversations||[];
  convTotal=d.total||0;
  const tbody=document.getElementById('conv-tbody');
  tbody.innerHTML=rows.map(r=>\`<tr class="conv-row" onclick="openConv('\${r.id}')">
    <td>\${fmt(r.first_ts)}</td>
    <td>\${dur(r.first_ts,r.last_ts)}</td>
    <td>\${r.user_turns||0}u / \${r.assistant_turns||0}a</td>
    <td>\${r.ticket_id?'<span class="badge badge-ticket">'+r.ticket_id+'</span>':'<span class="badge badge-no-ticket">nessuno</span>'}</td>
    <td>\${r.ticket_category||'—'}</td>
    <td><span class="badge badge-\${r.sentiment||'unknown'}">\${r.sentiment||'?'}</span></td>
    <td>—</td>
  </tr>\`).join('');
  document.getElementById('conv-table').style.display='table';

  const info=\`\${d.page*LIMIT+1}–\${Math.min((d.page+1)*LIMIT,convTotal)} di \${convTotal}\`;
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

  document.getElementById('modal-content').innerHTML=\`
    <dl class="meta-grid">
      <dt>Periodo</dt><dd>\${fmt(c.first_ts)} → \${fmt(c.last_ts)}</dd>
      <dt>Turni</dt><dd>\${c.user_turns||0} utente / \${c.assistant_turns||0} assistente</dd>
      <dt>Sentiment</dt><dd><span class="badge badge-\${c.sentiment||'unknown'}">\${c.sentiment||'?'}</span> \${c.sentiment_note||''}</dd>
      <dt>Ticket</dt><dd>\${c.ticket_id||'—'} \${c.ticket_category?'('+c.ticket_category+')':''}</dd>
      <dt>Motivo</dt><dd>\${c.ticket_reason||'—'}</dd>
      <dt>Urgenza</dt><dd>\${c.ticket_urgency||'—'}</dd>
    </dl>
    <h3 style="font-size:.82rem;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:8px">Chiamate AI (\${calls.length}) — Tot: \${fmtCost(totalCost)} | In: \${fmtNum(totalIn)} | Out: \${fmtNum(totalOut)} | Cache: \${fmtNum(totalCache)}</h3>
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

function closeModal(){document.getElementById('conv-modal').classList.remove('open');}
document.getElementById('conv-modal').addEventListener('click',e=>{if(e.target===document.getElementById('conv-modal'))closeModal();});

// Auto-login da sessionStorage
const saved=sessionStorage.getItem('dash_secret');
if(saved){SECRET=saved;document.getElementById('pwd').value=saved;doLogin();}
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
