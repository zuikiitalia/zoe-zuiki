// Dashboard Zoe 2.0 — pagina servita da GET /dashboard.
//
// REGOLE PER CHI MODIFICA QUESTO FILE (verificate da tests/dashboard.test.ts):
// - Il contenuto è un String.raw: il JavaScript del browser NON deve contenere
//   backtick né la sequenza dollaro-graffa, altrimenti si rompe il template TypeScript.
// - Il DOM si costruisce con el()/textContent, mai concatenando HTML: i messaggi dei
//   clienti vengono così mostrati come testo e non possono iniettare markup.
// - Niente onclick inline con stringhe annidate: si usano addEventListener o <details>.
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zoe AI · Dashboard</title>
<style>
:root{
  color-scheme: light;
  --page:#f9f9f7; --surface:#fcfcfb; --surface-2:#f3f2ee;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --link:#256abf; --focus:#2a78d6;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100;
  --good:#0ca30c; --warn:#fab219; --serious:#ec835a; --crit:#d03b3b; --neutral:#c3c2b7;
  --good-ink:#006300; --crit-ink:#b42d2d;
  --bubble-user:#ffffff; --bubble-zoe:#e3f4e8; --bubble-op:#fdf0d2; --bubble-auto:#e3edfb;
}
@media (prefers-color-scheme: dark){
  :root{
    color-scheme: dark;
    --page:#0d0d0d; --surface:#1a1a19; --surface-2:#232321;
    --ink:#f0efec; --ink-2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
    --link:#86b6ef; --focus:#3987e5;
    --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
    --good-ink:#0ca30c; --crit-ink:#e66767;
    --bubble-user:#232321; --bubble-zoe:#17321f; --bubble-op:#3a2f12; --bubble-auto:#16263c;
  }
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--link)}
button,input,select{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.num,td.num,.tick{font-variant-numeric:tabular-nums}

/* Barra superiore */
.top{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--border)}
.top-in{max-width:1280px;margin:0 auto;padding:12px 16px;display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center}
.brand{font-weight:700;font-size:16px;letter-spacing:-.01em;white-space:nowrap}
.brand span{color:var(--muted);font-weight:500}
.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
.tab{border:0;background:transparent;padding:7px 11px;border-radius:7px;color:var(--ink-2);cursor:pointer;white-space:nowrap}
.tab:hover{background:var(--surface-2)}
.tab[aria-selected="true"]{background:var(--surface-2);color:var(--ink);font-weight:600}
.range{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-left:auto}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface);max-width:100%}
#presets{overflow-x:auto;scrollbar-width:none}
@media (max-width:600px){
  .range{width:100%;margin-left:0;min-width:0}
  #presets{display:flex;width:100%}
  #presets button{flex:1 1 auto;padding:6px 6px;font-size:13px}
}
.seg button{border:0;background:transparent;padding:6px 10px;cursor:pointer;color:var(--ink-2);white-space:nowrap}
.seg button+button{border-left:1px solid var(--border)}
.seg button[aria-pressed="true"]{background:var(--surface-2);color:var(--ink);font-weight:600}
.dates{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:13px}
.dates input{border:1px solid var(--border);border-radius:7px;padding:5px 7px;background:var(--surface)}
.btn{border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:6px 12px;cursor:pointer}
.btn:hover{background:var(--surface-2)}
.btn.primary{background:var(--ink);color:var(--page);border-color:var(--ink)}
.btn.danger{color:var(--crit-ink)}
.btn[disabled]{opacity:.5;cursor:default}

main{max-width:1280px;margin:0 auto;padding:16px 16px 48px}
.note{color:var(--muted);font-size:12.5px;margin:0 0 12px}
.banner{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border);border-left:4px solid var(--warn);background:var(--surface);border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:13.5px}
.banner b{font-weight:600}
section[hidden]{display:none}
.grid{display:grid;gap:14px}
.g2{grid-template-columns:repeat(2,minmax(0,1fr))}
.g3{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:900px){.g2,.g3{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;min-width:0}
.card h2{font-size:14px;margin:0;font-weight:650}
.card-h{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;margin-bottom:12px}
.card-sub{color:var(--muted);font-size:12.5px;margin-top:2px}
.mt{margin-top:14px}

/* KPI */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.kpi-label{color:var(--ink-2);font-size:12.5px}
.kpi-value{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:4px}
.kpi-sub{color:var(--muted);font-size:12.5px;margin-top:2px}

/* Grafico */
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-bottom:8px;font-size:12.5px;color:var(--ink-2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.chart{position:relative;width:100%}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.chart .grid-l{stroke:var(--grid);stroke-width:1}
.chart .axis-l{stroke:var(--axis);stroke-width:1}
.chart .tick{fill:var(--muted);font-size:11px}
.chart .col{transition:opacity .12s}
.tip{position:absolute;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:9px 11px;font-size:12.5px;box-shadow:0 6px 20px rgba(0,0,0,.12);min-width:190px;z-index:5}
.tip-h{font-weight:600;margin-bottom:6px}
.tip-r{display:flex;align-items:center;gap:8px;justify-content:space-between;color:var(--ink-2)}
.tip-r b{color:var(--ink);font-weight:600}
.tip-t{border-top:1px solid var(--border);margin-top:6px;padding-top:6px}

/* Barre classificate */
.rb-row{display:grid;grid-template-columns:minmax(90px,38%) 1fr auto;gap:10px;align-items:center;padding:5px 0}
.rb-label{color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rb-track{height:8px;background:var(--surface-2);border-radius:4px;overflow:hidden}
.rb-bar{height:100%;background:var(--s1);border-radius:0 4px 4px 0}
.rb-val{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.rb-val small{color:var(--muted);margin-left:6px}

/* Barra segmentata (sentiment) */
.segbar{display:flex;height:26px;gap:2px;border-radius:6px;overflow:hidden;margin:6px 0 12px}
.segbar div{height:100%}
.seg-legend{display:flex;flex-direction:column;gap:7px}
.seg-legend .it{display:grid;grid-template-columns:auto 1fr auto auto;gap:10px;align-items:center}
.seg-legend .lab{color:var(--ink-2)}
.seg-legend .val{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.seg-legend .cnt{color:var(--muted);font-variant-numeric:tabular-nums;min-width:3.5em;text-align:right}

/* Tabelle */
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--muted);font-weight:500;font-size:12px;padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
tbody tr.click{cursor:pointer}
tbody tr.click:hover{background:var(--surface-2)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.muted{color:var(--muted)}
.ink2{color:var(--ink-2)}
.empty{color:var(--muted);padding:18px 0;text-align:center}
.err{color:var(--crit-ink);padding:12px 0}
.loading{color:var(--muted);padding:18px 0;text-align:center}

/* Badge di stato: sempre icona + testo, mai solo colore */
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600;white-space:nowrap;border:1px solid var(--border)}
.badge .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.pill{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:2px 9px;font-size:12px;margin:2px 4px 2px 0;color:var(--ink-2)}

.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.toolbar input[type=text],.toolbar input[type=search],.toolbar select{border:1px solid var(--border);border-radius:8px;padding:6px 9px;background:var(--surface)}
.toolbar input[type=text],.toolbar input[type=search]{min-width:220px;flex:1}
.pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px;color:var(--muted);font-size:12.5px}

/* Thread conversazione */
.thread{display:flex;flex-direction:column;gap:8px;max-height:56vh;overflow-y:auto;padding:12px;background:var(--surface-2);border-radius:10px}
.msg{max-width:82%;padding:8px 11px;border-radius:10px;border:1px solid var(--border);white-space:pre-wrap;word-break:break-word}
.msg .meta{font-size:11px;color:var(--muted);margin-bottom:3px;font-weight:600}
.msg.user{align-self:flex-start;background:var(--bubble-user)}
.msg.zoe{align-self:flex-end;background:var(--bubble-zoe)}
.msg.op{align-self:flex-end;background:var(--bubble-op)}
.msg.auto{align-self:flex-end;background:var(--bubble-auto)}

/* Timeline indagine */
.tl{display:flex;flex-direction:column;gap:6px}
.tl-ev{font-size:12.5px;color:var(--ink-2);padding-left:10px;border-left:2px solid var(--grid)}
.tl-ev summary{cursor:pointer}
.tl-ev pre{white-space:pre-wrap;word-break:break-all;background:var(--surface-2);border-radius:8px;padding:8px;font-size:11.5px;max-height:280px;overflow:auto;margin:6px 0}
.conv-block{border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:12px}

/* Modale */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:flex-start;justify-content:center;padding:4vh 12px;z-index:50;overflow-y:auto}
.modal.open{display:flex}
.modal-box{background:var(--surface);border-radius:14px;width:min(860px,100%);padding:20px;position:relative;border:1px solid var(--border)}
.modal-x{position:absolute;top:10px;right:12px;border:0;background:transparent;font-size:22px;cursor:pointer;color:var(--muted)}
.meta-grid{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:13px;margin:10px 0 14px}
.meta-grid dt{color:var(--muted)}
.meta-grid dd{margin:0}
h3.sec{font-size:12.5px;color:var(--muted);font-weight:600;margin:16px 0 8px;text-transform:uppercase;letter-spacing:.04em}
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <div class="brand">Zoe AI <span>· Dashboard</span></div>
    <nav class="tabs" role="tablist" aria-label="Sezioni">
      <button class="tab" role="tab" data-tab="overview">Panoramica</button>
      <button class="tab" role="tab" data-tab="costs">Costi</button>
      <button class="tab" role="tab" data-tab="quality">Qualità</button>
      <button class="tab" role="tab" data-tab="customers">Clienti</button>
      <button class="tab" role="tab" data-tab="images">Ricerca immagini</button>
    </nav>
    <div class="range">
      <div class="seg" id="presets" role="group" aria-label="Periodo">
        <button data-p="7d">7 giorni</button>
        <button data-p="30d">30 giorni</button>
        <button data-p="month">Mese corrente</button>
        <button data-p="prev">Mese scorso</button>
      </div>
      <div class="dates">
        <input type="date" id="f-from" aria-label="Dal">
        <span>→</span>
        <input type="date" id="f-to" aria-label="Al">
      </div>
    </div>
  </div>
</header>

<main>
  <p class="note">Costi in USD ricalcolati al listino attuale · date in UTC, come nella Console Anthropic.</p>
  <div id="banner"></div>

  <section id="tab-overview" data-section="overview">
    <div class="kpis" id="kpis"></div>
    <div class="card">
      <div class="card-h">
        <div><h2>Spesa giornaliera per fonte</h2><div class="card-sub" id="daily-sub"></div></div>
        <div class="seg" role="group" aria-label="Vista">
          <button data-view="chart" aria-pressed="true">Grafico</button>
          <button data-view="table" aria-pressed="false">Tabella</button>
        </div>
      </div>
      <div class="legend" id="daily-legend"></div>
      <div class="chart" id="daily-chart"></div>
      <div class="tbl-wrap" id="daily-table" hidden></div>
    </div>
    <div class="card mt">
      <div class="card-h">
        <div><h2>Clienti con spesa elevata</h2><div class="card-sub">Oltre 10 USD in un solo giorno, ultimi 30 giorni. Puoi escludere il numero da Zoe: da quel momento risponde solo un operatore.</div></div>
      </div>
      <div id="alerts"></div>
    </div>
  </section>

  <section id="tab-costs" data-section="costs" hidden>
    <div class="grid g2">
      <div class="card">
        <div class="card-h"><div><h2>Spesa per fonte</h2><div class="card-sub">Chi consuma il budget nel periodo</div></div></div>
        <div id="by-source"></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Spesa per modello</h2><div class="card-sub" id="model-sub">Tutte le fonti</div></div></div>
        <div id="by-model"></div>
      </div>
    </div>
    <div class="card mt">
      <div class="card-h"><div><h2>Conversazioni più costose</h2><div class="card-sub">Clicca una riga per aprire la conversazione</div></div></div>
      <div class="tbl-wrap" id="top-convs"></div>
    </div>
  </section>

  <section id="tab-quality" data-section="quality" hidden>
    <div class="grid g3">
      <div class="card">
        <div class="card-h"><div><h2>Sentiment dei clienti</h2><div class="card-sub">Conversazioni attive nel periodo</div></div></div>
        <div id="sentiment"></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Ticket per categoria</h2></div></div>
        <div id="tickets"></div>
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Strumenti usati da Zoe</h2></div></div>
        <div id="tools"></div>
      </div>
    </div>
    <div class="card mt">
      <div class="card-h">
        <div><h2>Review qualità</h2><div class="card-sub">Problemi trovati dall'analisi notturna, ultimi 30 giorni</div></div>
        <button class="btn" id="run-review">Esegui la review ora</button>
      </div>
      <div class="toolbar" style="margin-bottom:10px">
        <select id="f-sev" aria-label="Severità">
          <option value="">Tutte le severità</option>
          <option value="high">Alta</option>
          <option value="medium">Media</option>
          <option value="low">Bassa</option>
        </select>
        <select id="f-cat" aria-label="Categoria"><option value="">Tutte le categorie</option></select>
      </div>
      <div class="tbl-wrap" id="findings"></div>
    </div>
  </section>

  <section id="tab-customers" data-section="customers" hidden>
    <div class="card">
      <div class="card-h"><div><h2>Indaga un numero</h2><div class="card-sub">Messaggi, ragionamenti, strumenti e costi delle ultime conversazioni</div></div></div>
      <form class="toolbar" id="inv-form">
        <input type="text" id="inv-phone" inputmode="tel" placeholder="es. 3334443334 o +393334443334" aria-label="Numero">
        <select id="inv-limit" aria-label="Quante conversazioni">
          <option value="1">Ultima</option>
          <option value="3" selected>Ultime 3</option>
          <option value="10">Ultime 10</option>
        </select>
        <button class="btn primary" type="submit">Cerca</button>
      </form>
      <div id="inv-result"></div>
    </div>
    <div class="card mt">
      <div class="card-h">
        <div><h2>Clienti</h2><div class="card-sub">Attivi nel periodo · clicca una riga per il thread completo</div></div>
        <div class="toolbar">
          <input type="search" id="cust-q" placeholder="Filtra per numero" aria-label="Filtra per numero">
          <select id="cust-sort" aria-label="Ordina">
            <option value="recent">Più recenti</option>
            <option value="cost">Più costosi</option>
          </select>
        </div>
      </div>
      <div class="tbl-wrap" id="customers"></div>
      <div class="pager"><span id="cust-page"></span><button class="btn" id="cust-prev">← Prec</button><button class="btn" id="cust-next">Succ →</button></div>
    </div>
  </section>

  <section id="tab-images" data-section="images" hidden>
    <div class="card">
      <div class="card-h"><div><h2>Ricerche per immagine</h2><div class="card-sub">Numeri sperimentali: candidati trovati, scelta del reranker e risultato finale</div></div></div>
      <div class="tbl-wrap" id="images"></div>
    </div>
  </section>
</main>

<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="modal-box">
    <button class="modal-x" id="modal-x" aria-label="Chiudi">×</button>
    <h2 id="modal-title" style="margin:0;font-size:16px">Conversazione</h2>
    <div id="modal-body"></div>
  </div>
</div>

<script>
(function () {
  'use strict';

  var SOURCES = [
    { key: 'conversation', label: 'Risposte di Zoe', color: 'var(--s1)' },
    { key: 'review', label: 'Review notturna', color: 'var(--s2)' },
    { key: 'sentiment', label: 'Analisi sentiment', color: 'var(--s3)' },
    { key: 'reranker', label: 'Ricerca per immagine', color: 'var(--s4)' }
  ];
  var SOURCE_LABEL = {};
  SOURCES.forEach(function (s) { SOURCE_LABEL[s.key] = s.label; });
  var SENT = {
    satisfied: { label: 'Soddisfatti', one: 'Soddisfatto', icon: '✓', color: 'var(--good)' },
    partial: { label: 'Parziali', one: 'Parziale', icon: '~', color: 'var(--warn)' },
    unsatisfied: { label: 'Insoddisfatti', one: 'Insoddisfatto', icon: '✕', color: 'var(--crit)' },
    unknown: { label: 'Non classificati', one: 'Non classificato', icon: '?', color: 'var(--neutral)' }
  };
  var SEV = {
    high: { label: 'Alta', color: 'var(--crit)' },
    medium: { label: 'Media', color: 'var(--serious)' },
    low: { label: 'Bassa', color: 'var(--neutral)' }
  };
  var TOOL_LABEL = {
    get_order_by_number_and_email: 'Stato ordine',
    search_products: 'Ricerca prodotti',
    get_product_by_handle: 'Dettaglio prodotto',
    check_availability: 'Disponibilità',
    check_store_availability: 'Disponibilità in negozio',
    find_similar_product: 'Ricerca per immagine',
    open_support_ticket: 'Apertura ticket',
    get_return_status: 'Stato reso',
    search_stores: 'Ricerca negozi'
  };

  var TICKET_LABEL = {
    ordine: 'Ordine', spedizione: 'Spedizione', reso_rimborso: 'Reso e rimborso', prodotto: 'Prodotto',
    pagamento: 'Pagamento', reclamo: 'Reclamo', richiesta_umano: 'Richiesta operatore',
    amministrativo: 'Amministrativo', tecnico: 'Tecnico', altro: 'Altro'
  };
  var FINDING_LABEL = {
    missed_ticket: 'Ticket non aperto', wrong_refusal: 'Rifiuto sbagliato', ambiguous_language: 'Linguaggio ambiguo',
    missed_context: 'Contesto ignorato', silent_stop: 'Smette di rispondere', false_promise: 'Promessa non garantita',
    repetitive: 'Risposte ripetitive', meta_excuse: 'Scuse di sistema', other: 'Altro'
  };
  function humanize(code) { var t = String(code || '').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); }
  function ticketLabel(c) { return TICKET_LABEL[c] || humanize(c); }
  function findingLabel(c) { return FINDING_LABEL[c] || humanize(c); }
  function modelLabel(m) {
    var mm = String(m || '').match(/^claude-([a-z]+)-(\d+)-(\d+)/);
    return mm ? mm[1].charAt(0).toUpperCase() + mm[1].slice(1) + ' ' + mm[2] + '.' + mm[3] : String(m);
  }

  // ---------- utilità ----------
  function $(id) { return document.getElementById(id); }
  function add(n, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(n, x); }); return; }
    if (typeof c === 'string' || typeof c === 'number') { n.appendChild(document.createTextNode(String(c))); return; }
    n.appendChild(c);
  }
  function el(tag, props) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'text') n.textContent = v;
        else if (k === 'class') n.className = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function fill(host) { clear(host); for (var i = 1; i < arguments.length; i++) add(host, arguments[i]); }
  function loading(host) { fill(host, el('div', { class: 'loading', text: 'Caricamento…' })); }
  function empty(text) { return el('div', { class: 'empty', text: text || 'Nessun dato nel periodo selezionato.' }); }
  function failed(host, err) { fill(host, el('div', { class: 'err', text: 'Errore nel caricamento: ' + (err && err.message ? err.message : err) })); }

  var fmtUsd2 = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var fmtUsd4 = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 4 });
  function money(v) { return fmtUsd2.format(Number(v) || 0); }
  function moneyFine(v) { v = Number(v) || 0; return v !== 0 && Math.abs(v) < 0.995 ? fmtUsd4.format(v) : fmtUsd2.format(v); }
  function moneyAxis(v) {
    var digits = v >= 100 ? 0 : (v >= 10 ? 0 : (v >= 1 ? 1 : 2));
    return '$' + v.toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: digits });
  }
  function num(v) { return (Number(v) || 0).toLocaleString('it-IT'); }
  function pct(v) { return ((Number(v) || 0) * 100).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + '%'; }
  function when(ts) {
    if (!ts) return '—';
    return new Date(Number(ts)).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function clock(ts) { return new Date(Number(ts)).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function dayLabel(iso, long) {
    var p = iso.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return d.toLocaleDateString('it-IT', long ? { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function phoneLabel(full, hash) { return full ? '+' + full : (hash ? String(hash).slice(0, 10) + '…' : '—'); }
  function deltaText(cur, prev) {
    if (!prev) return 'nessun dato nel periodo precedente';
    var d = (cur - prev) / prev;
    return (d >= 0 ? '▲ +' : '▼ −') + pct(Math.abs(d)) + ' rispetto al periodo precedente';
  }
  function badge(label, color) {
    return el('span', { class: 'badge' }, el('span', { class: 'dot', style: 'background:' + color }), label);
  }

  // ---------- stato e periodo ----------
  var state = { from: '', to: '', preset: 'month', tab: 'overview', overview: null, overviewKey: '', loaded: {}, custPage: 0, findings: [] };
  function iso(d) { return d.toISOString().slice(0, 10); }
  function utcToday() { var n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); }
  function presetRange(p) {
    var t = utcToday(), y = t.getUTCFullYear(), m = t.getUTCMonth();
    if (p === '7d') return [iso(new Date(t.getTime() - 6 * 864e5)), iso(t)];
    if (p === '30d') return [iso(new Date(t.getTime() - 29 * 864e5)), iso(t)];
    if (p === 'prev') return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
    return [iso(new Date(Date.UTC(y, m, 1))), iso(t)];
  }
  function rangeQuery() { return 'from=' + state.from + '&to=' + state.to; }
  function rangeKey() { return state.from + '|' + state.to; }
  function api(path, opts) {
    return fetch('/dashboard/api' + path, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function getOverview() {
    var key = rangeKey();
    if (state.overview && state.overviewKey === key) return state.overview;
    state.overviewKey = key;
    state.overview = api('/overview?' + rangeQuery());
    return state.overview;
  }

  function setRange(from, to, preset) {
    state.from = from; state.to = to; state.preset = preset || '';
    $('f-from').value = from; $('f-to').value = to;
    Array.prototype.forEach.call(document.querySelectorAll('#presets button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-p') === state.preset ? 'true' : 'false');
    });
    state.loaded = {};
    state.custPage = 0;
    writeHash();
    loadTab(state.tab);
  }

  function writeHash() {
    var h = '#' + state.tab + (state.preset ? '&p=' + state.preset : '&from=' + state.from + '&to=' + state.to);
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  function readHash() {
    var parts = location.hash.replace(/^#/, '').split('&'), out = {};
    if (parts[0] && parts[0].indexOf('=') < 0) out.tab = parts[0];
    parts.forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); });
    return out;
  }

  // ---------- tab ----------
  var LOADERS = {
    overview: loadOverviewTab,
    costs: loadCostsTab,
    quality: loadQualityTab,
    customers: loadCustomers,
    images: loadImages
  };
  function showTab(name) {
    if (!LOADERS[name]) name = 'overview';
    state.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === name ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('main section'), function (s) {
      s.hidden = s.getAttribute('data-section') !== name;
    });
    writeHash();
    loadTab(name);
  }
  function loadTab(name) {
    if (state.loaded[name]) { if (name === 'overview') redrawDaily(); return; }
    state.loaded[name] = true;
    LOADERS[name]();
  }

  // ---------- banner tracciamento ----------
  function renderBanner(ov) {
    var host = clear($('banner'));
    var since = ov.tracking_since;
    var fromMs = Date.parse(state.from + 'T00:00:00Z');
    if (since && fromMs >= since) return;
    var text = since
      ? 'Il tracciamento completo dei costi è attivo dal ' + when(since) + '. Prima di quella data il database perdeva circa un terzo delle chiamate (primo turno dei clienti nuovi, review notturna, sentiment): per quei giorni fa fede la Console Anthropic.'
      : 'Il tracciamento completo dei costi non ha ancora registrato dati: partirà con le prime chiamate dopo il deploy. Fino ad allora la spesa mostrata è sottostimata di circa un terzo; fa fede la Console Anthropic.';
    add(host, el('div', { class: 'banner', role: 'note' }, el('span', { 'aria-hidden': 'true', text: '⚠' }), el('div', null, el('b', { text: 'Dati di costo incompleti. ' }), text)));
  }

  // ---------- panoramica ----------
  function loadOverviewTab() {
    loading($('kpis'));
    loading($('daily-chart'));
    getOverview().then(function (ov) {
      renderBanner(ov);
      renderKpis(ov.kpis);
      state.daily = ov.daily;
      renderDaily();
    }).catch(function (e) { failed($('kpis'), e); clear($('daily-chart')); });
    loadAlerts();
  }

  function kpi(label, value, sub, title) {
    return el('div', { class: 'kpi', title: title || null },
      el('div', { class: 'kpi-label', text: label }),
      el('div', { class: 'kpi-value', text: value }),
      sub ? el('div', { class: 'kpi-sub', text: sub }) : null);
  }
  function renderKpis(k) {
    var share = k.conversations ? k.tickets / k.conversations : 0;
    fill($('kpis'),
      kpi('Spesa nel periodo', money(k.total_cost), deltaText(k.total_cost, k.prev_total_cost)),
      kpi('Proiezione mese corrente', money(k.projected_month_cost), 'speso finora: ' + money(k.mtd_cost), 'Spesa da inizio mese divisa per i giorni trascorsi, moltiplicata per i giorni del mese'),
      kpi('Conversazioni', num(k.conversations), deltaText(k.conversations, k.prev_conversations)),
      kpi('Costo per conversazione', moneyFine(k.avg_cost_per_conversation), 'media · ' + num(k.calls) + ' chiamate al modello'),
      kpi('Risposte di Zoe', num(k.zoe_replies), num(k.customer_messages) + ' messaggi dei clienti · ' + num(k.operator_messages) + ' di operatori'),
      kpi('Ticket aperti', num(k.tickets), pct(share) + ' delle conversazioni')
    );
  }

  var dailyView = 'chart';
  function renderDaily() {
    var rows = state.daily || [];
    var totals = {};
    var grand = 0;
    SOURCES.forEach(function (s) { totals[s.key] = 0; });
    rows.forEach(function (r) { SOURCES.forEach(function (s) { totals[s.key] += r[s.key] || 0; grand += r[s.key] || 0; }); });
    var active = SOURCES.filter(function (s) { return totals[s.key] > 0; });
    if (!active.length) active = [SOURCES[0]];
    $('daily-sub').textContent = dayLabel(state.from, true) + ' – ' + dayLabel(state.to, true) + ' · totale ' + money(grand);
    fill($('daily-legend'), active.map(function (s) {
      return el('span', null, el('i', { class: 'sw', style: 'background:' + s.color }), s.label + ' · ' + money(totals[s.key]));
    }));
    if (!grand) { fill($('daily-chart'), empty('Nessuna spesa registrata nel periodo.')); }
    else if (dailyView === 'chart') stackedChart($('daily-chart'), rows, active);
    renderDailyTable(rows, active);
    $('daily-chart').hidden = dailyView !== 'chart';
    $('daily-table').hidden = dailyView !== 'table';
  }
  function redrawDaily() { if (state.daily && dailyView === 'chart') renderDaily(); }

  function renderDailyTable(rows, series) {
    var head = el('tr', null, el('th', { text: 'Giorno' }), series.map(function (s) { return el('th', { class: 'num', text: s.label }); }), el('th', { class: 'num', text: 'Totale' }));
    var body = rows.slice().reverse().map(function (r) {
      var t = 0;
      var cells = series.map(function (s) { t += r[s.key] || 0; return el('td', { class: 'num', text: money(r[s.key]) }); });
      return el('tr', null, el('td', { text: dayLabel(r.day, true) }), cells, el('td', { class: 'num', text: money(t) }));
    });
    fill($('daily-table'), el('table', null, el('thead', null, head), el('tbody', null, body)));
  }

  function niceTicks(max, count) {
    if (!(max > 0)) return [0, 1];
    var raw = max / count;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var r = raw / mag;
    var step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
    var out = [];
    for (var v = 0; v < max + step * 0.999 && out.length < 12; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  function roundTop(x, y, w, h, r) {
    return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
  }

  function stackedChart(host, rows, series) {
    clear(host);
    var W = Math.max(320, Math.round(host.clientWidth || 720));
    var H = W < 560 ? 220 : 280, L = 52, R = 10, T = 12, B = 28;
    var pw = W - L - R, ph = H - T - B;
    var max = 0;
    rows.forEach(function (r) {
      var s = 0;
      series.forEach(function (se) { s += r[se.key] || 0; });
      r._total = s;
      if (s > max) max = s;
    });
    var ticks = niceTicks(max, 4);
    var top = ticks[ticks.length - 1] || 1;
    var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'Spesa giornaliera per fonte, in dollari' });
    ticks.forEach(function (v) {
      var y = T + ph - (v / top) * ph;
      root.appendChild(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: v === 0 ? 'axis-l' : 'grid-l' }));
      var t = svg('text', { x: L - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' });
      t.textContent = moneyAxis(v);
      root.appendChild(t);
    });
    var n = rows.length;
    var band = pw / Math.max(n, 1);
    var bw = Math.max(2, Math.min(26, band * 0.62));
    var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));
    var cols = [];
    var tip = el('div', { class: 'tip', hidden: true });

    rows.forEach(function (r, i) {
      var cx = L + band * i + band / 2;
      var x = cx - bw / 2;
      var base = T + ph;
      var g = svg('g', { class: 'col' });
      var segs = series.filter(function (se) { return (r[se.key] || 0) > 0; });
      segs.forEach(function (se, j) {
        var h = (r[se.key] / top) * ph;
        var y = base - h;
        var gap = j > 0 ? 2 : 0;
        var hh = Math.max(0, h - gap);
        if (hh > 0.3) {
          var isTop = j === segs.length - 1;
          var shape = isTop
            ? svg('path', { d: roundTop(x, y, bw, hh, Math.min(4, bw / 2, hh)) })
            : svg('rect', { x: x, y: y, width: bw, height: hh });
          shape.setAttribute('style', 'fill:' + se.color);
          g.appendChild(shape);
        }
        base = y;
      });
      root.appendChild(g);
      cols.push(g);
      if (i % every === 0) {
        var lab = svg('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'tick' });
        lab.textContent = dayLabel(r.day);
        root.appendChild(lab);
      }
      var hit = svg('rect', { x: L + band * i, y: T, width: band, height: ph, fill: 'transparent' });
      hit.addEventListener('mouseenter', function () { focusCol(i, cx); });
      hit.addEventListener('click', function () { focusCol(i, cx); });
      root.appendChild(hit);
    });
    root.addEventListener('mouseleave', function () {
      tip.hidden = true;
      cols.forEach(function (g) { g.style.opacity = 1; });
    });

    function focusCol(i, cx) {
      var r = rows[i];
      cols.forEach(function (g, k) { g.style.opacity = k === i ? 1 : 0.35; });
      fill(tip,
        el('div', { class: 'tip-h', text: dayLabel(r.day, true) }),
        r._total ? series.slice().reverse().filter(function (se) { return (r[se.key] || 0) > 0; }).map(function (se) {
          return el('div', { class: 'tip-r' }, el('span', null, el('i', { class: 'sw', style: 'background:' + se.color + ';margin-right:6px' }), se.label), el('b', { text: money(r[se.key]) }));
        }) : el('div', { class: 'muted', text: 'Nessuna spesa' }),
        r._total ? el('div', { class: 'tip-r tip-t' }, el('span', { text: 'Totale' }), el('b', { text: money(r._total) })) : null);
      tip.hidden = false;
      var scale = host.clientWidth / W;
      var left = cx * scale + 12;
      if (left + tip.offsetWidth > host.clientWidth) left = cx * scale - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = (T * scale) + 'px';
    }
    host.appendChild(root);
    host.appendChild(tip);
  }

  function loadAlerts() {
    var host = $('alerts');
    loading(host);
    api('/high-cost-users?threshold=10').then(function (d) {
      var users = d.users || [];
      if (!users.length) { fill(host, el('div', { class: 'empty', text: '✓ Nessun cliente oltre 10 USD in un giorno negli ultimi 30 giorni.' })); return; }
      var rows = users.map(function (u) {
        var btn = u.phone_full
          ? el('button', { class: 'btn' + (u.blocked ? '' : ' danger'), text: u.blocked ? 'Riattiva Zoe' : 'Escludi da Zoe', onclick: function () { toggleBlock(u, this); } })
          : el('span', { class: 'muted', text: 'numero non disponibile' });
        return el('tr', null,
          el('td', null, u.phone_full ? el('a', { href: '#', text: phoneLabel(u.phone_full), onclick: function (e) { e.preventDefault(); investigatePhone(u.phone_full); } }) : phoneLabel(null, u.phone_hash)),
          el('td', { text: dayLabel(u.day, true) }),
          el('td', { class: 'num' }, el('b', { text: money(u.day_cost) })),
          el('td', { class: 'num', text: num(u.calls) }),
          el('td', null, u.blocked ? badge('Esclusa · gestione umana', 'var(--crit)') : badge('Zoe attiva', 'var(--good)')),
          el('td', { class: 'num' }, btn));
      });
      fill(host, el('div', { class: 'tbl-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Cliente' }), el('th', { text: 'Giorno' }), el('th', { class: 'num', text: 'Spesa' }), el('th', { class: 'num', text: 'Chiamate' }), el('th', { text: 'Stato' }), el('th'))),
        el('tbody', null, rows))));
    }).catch(function (e) { failed(host, e); });
  }
  function toggleBlock(u, btn) {
    var blocking = !u.blocked;
    var msg = blocking
      ? 'Escludere +' + u.phone_full + ' da Zoe? Zoe smetterà di rispondere a questo numero e la conversazione andrà gestita da un operatore.'
      : 'Riattivare Zoe per +' + u.phone_full + '?';
    if (!confirm(msg)) return;
    btn.disabled = true;
    api(blocking ? '/block-user' : '/unblock-user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: u.phone_full }) })
      .then(function () { loadAlerts(); })
      .catch(function (e) { alert('Operazione non riuscita: ' + e.message); btn.disabled = false; });
  }

  // ---------- costi ----------
  function rankedBars(host, items, fmt) {
    clear(host);
    if (!items.length) { host.appendChild(empty()); return; }
    var max = Math.max.apply(null, items.map(function (i) { return i.value; })) || 1;
    items.forEach(function (it) {
      host.appendChild(el('div', { class: 'rb-row', title: it.title || null },
        el('div', { class: 'rb-label', text: it.label }),
        el('div', { class: 'rb-track' }, el('div', { class: 'rb-bar', style: 'width:' + Math.max(1, it.value / max * 100) + '%' })),
        el('div', { class: 'rb-val' }, fmt(it.value), it.sub ? el('small', { text: it.sub }) : null)));
    });
  }
  function loadCostsTab() {
    loading($('by-source')); loading($('by-model')); loading($('top-convs'));
    getOverview().then(function (ov) {
      renderBanner(ov);
      var total = ov.by_source.reduce(function (a, r) { return a + (r.cost || 0); }, 0);
      var srcHost = clear($('by-source'));
      if (!ov.by_source.length) srcHost.appendChild(empty());
      else {
        var rows = ov.by_source.map(function (r) {
          var meta = SOURCES.filter(function (s) { return s.key === r.source; })[0] || { label: r.source, color: 'var(--neutral)' };
          return el('tr', null,
            el('td', null, el('i', { class: 'sw', style: 'background:' + meta.color + ';margin-right:8px' }), meta.label),
            el('td', { class: 'num', text: num(r.calls) }),
            el('td', { class: 'num', text: total ? pct(r.cost / total) : '—' }),
            el('td', { class: 'num' }, el('b', { text: money(r.cost) })));
        });
        srcHost.appendChild(el('table', null,
          el('thead', null, el('tr', null, el('th', { text: 'Fonte' }), el('th', { class: 'num', text: 'Chiamate' }), el('th', { class: 'num', text: 'Quota' }), el('th', { class: 'num', text: 'Spesa' }))),
          el('tbody', null, rows, el('tr', null, el('td', null, el('b', { text: 'Totale' })), el('td'), el('td'), el('td', { class: 'num' }, el('b', { text: money(total) }))))));
      }
      rankedBars($('by-model'), ov.by_model.map(function (m) {
        return { label: modelLabel(m.model), value: m.cost || 0, sub: num(m.calls) + ' chiamate', title: m.model + ' · ' + num(m.input_tokens) + ' token input · ' + num(m.output_tokens) + ' output · ' + num(m.cache_read_tokens) + ' da cache' };
      }), money);
      $('model-sub').textContent = 'Tutte le fonti · cache del prompt sulle risposte di Zoe: ' + pct(ov.kpis.cache_hit_rate) + ' dei token di input';
    }).catch(function (e) { failed($('by-source'), e); clear($('by-model')); });

    api('/top-conversations?' + rangeQuery()).then(function (d) {
      var list = d.conversations || [];
      if (!list.length) { fill($('top-convs'), empty()); return; }
      var rows = list.map(function (c) {
        return el('tr', { class: 'click', onclick: function () { openConv(c.conv_id); } },
          el('td', { class: 'mono', text: phoneLabel(c.phone_full, c.conv_id) }),
          el('td', { text: when(c.first_ts) }),
          el('td', { text: when(c.last_ts) }),
          el('td', { class: 'num', text: num(c.calls) }),
          el('td', { class: 'num' }, el('b', { text: money(c.cost) })));
      });
      fill($('top-convs'), el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Cliente' }), el('th', { text: 'Prima chiamata' }), el('th', { text: 'Ultima chiamata' }), el('th', { class: 'num', text: 'Chiamate' }), el('th', { class: 'num', text: 'Spesa' }))),
        el('tbody', null, rows)));
    }).catch(function (e) { failed($('top-convs'), e); });
  }

  // ---------- qualità ----------
  function loadQualityTab() {
    loading($('sentiment')); loading($('tickets')); loading($('tools'));
    getOverview().then(function (ov) {
      renderSentiment(ov.sentiment || []);
      rankedBars($('tickets'), (ov.tickets || []).map(function (t) { return { label: ticketLabel(t.category), value: t.count, title: t.category }; }), num);
      rankedBars($('tools'), (ov.tools || []).map(function (t) {
        var rate = t.calls ? t.successes / t.calls : 0;
        return { label: TOOL_LABEL[t.tool_name] || t.tool_name, value: t.calls, sub: pct(rate) + ' ok', title: t.tool_name };
      }), num);
    }).catch(function (e) { failed($('sentiment'), e); clear($('tickets')); clear($('tools')); });
    loadFindings();
  }
  function renderSentiment(rows) {
    var host = clear($('sentiment'));
    var counts = {}, total = 0;
    rows.forEach(function (r) { var k = SENT[r.sentiment] ? r.sentiment : 'unknown'; counts[k] = (counts[k] || 0) + r.count; total += r.count; });
    if (!total) { host.appendChild(empty()); return; }
    var order = ['satisfied', 'partial', 'unsatisfied', 'unknown'].filter(function (k) { return counts[k]; });
    host.appendChild(el('div', { class: 'segbar', role: 'img', 'aria-label': 'Distribuzione del sentiment' },
      order.map(function (k) { return el('div', { style: 'flex:' + counts[k] + ';background:' + SENT[k].color, title: SENT[k].label + ': ' + counts[k] }); })));
    host.appendChild(el('div', { class: 'seg-legend' }, order.map(function (k) {
      return el('div', { class: 'it' },
        el('span', { class: 'badge' }, el('span', { class: 'dot', style: 'background:' + SENT[k].color }), SENT[k].icon),
        el('span', { class: 'lab', text: SENT[k].label }),
        el('span', { class: 'val', text: pct(counts[k] / total) }),
        el('span', { class: 'cnt', text: num(counts[k]) + ' conv.' }));
    })));
  }
  function loadFindings() {
    loading($('findings'));
    api('/findings').then(function (d) {
      state.findings = d.findings || [];
      var cats = {};
      state.findings.forEach(function (f) { cats[f.category] = 1; });
      var sel = $('f-cat'), cur = sel.value;
      fill(sel, el('option', { value: '', text: 'Tutte le categorie' }), Object.keys(cats).sort().map(function (c) { return el('option', { value: c, text: findingLabel(c) }); }));
      sel.value = cur;
      renderFindings();
    }).catch(function (e) { failed($('findings'), e); });
  }
  function renderFindings() {
    var sev = $('f-sev').value, cat = $('f-cat').value;
    var list = state.findings.filter(function (f) { return (!sev || f.severity === sev) && (!cat || f.category === cat); });
    if (!list.length) { fill($('findings'), empty('Nessun problema rilevato con questi filtri.')); return; }
    var rows = list.map(function (f) {
      var s = SEV[f.severity] || SEV.low;
      return el('tr', null,
        el('td', { class: 'mono', text: f.analysis_date }),
        el('td', null, badge(s.label, s.color)),
        el('td', { text: findingLabel(f.category), title: f.category }),
        el('td', { text: f.problem || '' }),
        el('td', { class: 'ink2', text: f.suggestion || '' }),
        el('td', null, f.conv_id ? el('button', { class: 'btn', text: 'Apri', onclick: function () { openConv(f.conv_id); } }) : null));
    });
    fill($('findings'), el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Data' }), el('th', { text: 'Severità' }), el('th', { text: 'Categoria' }), el('th', { text: 'Problema' }), el('th', { text: 'Suggerimento' }), el('th'))),
      el('tbody', null, rows)));
  }

  // ---------- clienti ----------
  function loadCustomers() {
    var host = $('customers');
    loading(host);
    var q = $('cust-q').value.replace(/\D/g, '');
    api('/customers?' + rangeQuery() + '&page=' + state.custPage + '&sort=' + $('cust-sort').value + (q ? '&q=' + q : '')).then(function (d) {
      var list = d.customers || [];
      $('cust-prev').disabled = state.custPage === 0;
      $('cust-next').disabled = !d.has_more;
      $('cust-page').textContent = 'Pagina ' + (state.custPage + 1);
      if (!list.length) { fill(host, empty('Nessun cliente attivo nel periodo.')); return; }
      var rows = list.map(function (c) {
        var s = SENT[c.latest_sentiment] || SENT.unknown;
        return el('tr', { class: 'click', onclick: function () { openConv(c.latest_conv_id); } },
          el('td', { class: 'mono', text: phoneLabel(c.phone_full, c.phone_hash) }),
          el('td', null, when(c.last_seen), el('div', { class: 'muted', text: 'cliente dal ' + when(c.first_seen) })),
          el('td', { class: 'num', text: num(c.user_turns) }),
          el('td', { class: 'num', text: c.tickets ? num(c.tickets) : '—' }),
          el('td', null, badge(s.icon + ' ' + s.one, s.color)),
          el('td', { class: 'num' }, el('b', { text: moneyFine(c.cost) })));
      });
      fill(host, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Cliente' }), el('th', { text: 'Ultima attività' }), el('th', { class: 'num', text: 'Messaggi' }), el('th', { class: 'num', text: 'Ticket' }), el('th', { text: 'Sentiment' }), el('th', { class: 'num', text: 'Spesa nel periodo' }))),
        el('tbody', null, rows)));
    }).catch(function (e) { failed(host, e); });
  }

  function investigatePhone(phone) {
    showTab('customers');
    $('inv-phone').value = phone;
    runInvestigate();
    $('inv-phone').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function runInvestigate() {
    var host = $('inv-result');
    var phone = $('inv-phone').value.trim();
    if (!phone) { fill(host, el('div', { class: 'err', text: 'Inserisci un numero.' })); return; }
    loading(host);
    api('/investigate?phone=' + encodeURIComponent(phone) + '&limit=' + $('inv-limit').value).then(function (d) {
      var convs = d.conversations || [];
      if (!convs.length) { fill(host, empty('Nessuna conversazione trovata per questo numero. Prova con o senza il prefisso 39.')); return; }
      fill(host, convs.map(renderInvestigation));
    }).catch(function (e) { failed(host, e); });
  }
  function msgKind(m) {
    var c = m.content || '';
    if (m.role === 'user') return { who: 'Cliente', cls: 'user', text: c };
    if (c.indexOf('[Operatore CC]:') === 0) return { who: 'Operatore', cls: 'op', text: c.replace(/^\[Operatore CC\]:\s*/, '') };
    if (c.indexOf('[Notifica Zuiki]:') === 0) return { who: 'Notifica automatica', cls: 'auto', text: c.replace(/^\[Notifica Zuiki\]:\s*/, '') };
    return { who: 'Zoe', cls: 'zoe', text: c };
  }
  function bubble(m) {
    var k = msgKind(m);
    return el('div', { class: 'msg ' + k.cls }, el('div', { class: 'meta', text: k.who + ' · ' + when(m.ts) }), k.text);
  }
  function renderInvestigation(c) {
    var events = [];
    (c.messages || []).forEach(function (m) { events.push({ ts: m.ts, t: 'msg', d: m }); });
    (c.tool_calls || []).forEach(function (x) { events.push({ ts: x.ts, t: 'tool', d: x }); });
    (c.api_calls || []).forEach(function (x) { events.push({ ts: x.ts, t: 'api', d: x }); });
    (c.thoughts || []).forEach(function (x) { events.push({ ts: x.ts, t: 'thought', d: x }); });
    events.sort(function (a, b) { return a.ts - b.ts; });
    var cost = (c.api_calls || []).reduce(function (a, x) { return a + (x.cost_usd || 0); }, 0);
    var tl = el('div', { class: 'tl' }, events.map(function (e) {
      var d = e.d;
      if (e.t === 'msg') return bubble(d);
      if (e.t === 'tool') {
        return el('details', { class: 'tl-ev' },
          el('summary', null, clock(d.ts) + ' · strumento ', el('b', { text: TOOL_LABEL[d.tool_name] || d.tool_name }), ' ' + (d.success ? '✓' : '✕') + (d.duration_ms ? ' · ' + d.duration_ms + ' ms' : '')),
          el('div', { class: 'muted', text: 'Input' }), el('pre', { text: d.input_json || '—' }),
          el('div', { class: 'muted', text: 'Output' }), el('pre', { text: d.output_json || '—' }));
      }
      if (e.t === 'thought') {
        return el('details', { class: 'tl-ev' },
          el('summary', null, clock(d.ts) + ' · ragionamento: ' + String(d.text || '').slice(0, 90) + (String(d.text || '').length > 90 ? '…' : '')),
          el('pre', { text: d.text || '' }));
      }
      return el('div', { class: 'tl-ev muted', text: clock(d.ts) + ' · modello ' + d.model + ' · in ' + num(d.input_tokens) + ' · out ' + num(d.output_tokens) + ' · cache ' + num(d.cache_read_tokens) + ' · ' + num(d.latency_ms) + ' ms · ' + moneyFine(d.cost_usd) });
    }));
    return el('div', { class: 'conv-block' },
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px 14px;align-items:baseline;margin-bottom:10px' },
        el('b', { text: when(c.first_ts) + ' → ' + when(c.last_ts) }),
        el('span', { class: 'muted', text: num(c.user_turns) + ' messaggi cliente · spesa ' + moneyFine(cost) }),
        c.ticket_id ? badge('Ticket ' + c.ticket_id, 'var(--s1)') : null,
        el('button', { class: 'btn', text: 'Apri thread completo', onclick: function () { openConv(c.id); } })),
      tl);
  }

  // ---------- ricerca immagini ----------
  function loadImages() {
    var host = $('images');
    loading(host);
    api('/image-searches?' + rangeQuery() + '&limit=100').then(function (d) {
      var list = d.searches || [];
      if (!list.length) { fill(host, empty('Nessuna ricerca per immagine nel periodo.')); return; }
      var rows = list.map(function (r) {
        var cands = [];
        try { cands = JSON.parse(r.candidates_json || '[]'); } catch (e) { cands = []; }
        var top1 = cands[0] || {};
        var changed = r.reranked && r.rerank_winner && r.rerank_winner !== top1.handle;
        return el('tr', null,
          el('td', { class: 'mono', text: when(r.ts) }),
          el('td', null, el('span', { class: 'pill', text: (r.source || '?') + (r.suffix ? ' · ' + r.suffix : '') })),
          el('td', null,
            el('details', null,
              el('summary', null, el('span', { class: 'mono', text: top1.handle || '—' }), top1.similarity ? el('span', { class: 'muted', text: ' ' + Math.round(top1.similarity * 100) + '%' }) : null),
              el('ol', { style: 'margin:6px 0 0;padding-left:18px' }, cands.slice(0, 10).map(function (c) {
                return el('li', { class: 'mono', text: c.handle + ' (' + Math.round((c.similarity || 0) * 100) + '%)' });
              })))),
          el('td', null, r.reranked ? badge('✓ ' + Math.round((r.rerank_confidence || 0) * 100) + '%', 'var(--good)') : el('span', { class: 'muted', text: '—' }),
            r.rerank_reasoning ? el('div', { class: 'muted', style: 'font-size:12px;margin-top:4px', text: String(r.rerank_reasoning).slice(0, 140) }) : null),
          el('td', null, el('span', { class: 'mono', text: r.final_handle || '—' }),
            changed ? el('div', { class: 'muted', style: 'font-size:12px', text: 'scelto al posto di ' + top1.handle }) : null,
            r.found_but_oos ? badge('Esaurito', 'var(--serious)') : null,
            r.final_title ? el('div', { class: 'muted', style: 'font-size:12px', text: String(r.final_title).slice(0, 60) }) : null),
          el('td', null, el('button', { class: 'btn', text: 'Apri', onclick: function () { openConv(r.conv_id); } })));
      });
      fill(host, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Ora' }), el('th', { text: 'Sorgente' }), el('th', { text: 'Primo candidato' }), el('th', { text: 'Reranker' }), el('th', { text: 'Risultato' }), el('th'))),
        el('tbody', null, rows)));
    }).catch(function (e) { failed(host, e); });
  }

  // ---------- modale conversazione ----------
  function openConv(id) {
    if (!id) return;
    var body = $('modal-body');
    $('modal').classList.add('open');
    $('modal-title').textContent = 'Conversazione';
    loading(body);
    api('/conversation/' + encodeURIComponent(id)).then(function (d) {
      var c = d.conversation || {};
      var calls = d.api_calls || [];
      var cost = calls.reduce(function (a, x) { return a + (x.cost_usd || 0); }, 0);
      var s = SENT[c.sentiment] || SENT.unknown;
      $('modal-title').textContent = phoneLabel(c.phone_full, c.phone_hash);
      var tools = {};
      (d.tool_calls || []).forEach(function (t) { tools[t.tool_name] = (tools[t.tool_name] || 0) + 1; });
      fill(body,
        el('dl', { class: 'meta-grid' },
          el('dt', { text: 'Sessione' }), el('dd', { text: when(c.first_ts) + ' → ' + when(c.last_ts) }),
          el('dt', { text: 'Sessioni del cliente' }), el('dd', { text: num((d.sessions || []).length) }),
          el('dt', { text: 'Sentiment' }), el('dd', null, badge(s.icon + ' ' + s.one, s.color), c.sentiment_note ? el('span', { class: 'muted', text: ' ' + c.sentiment_note }) : null),
          el('dt', { text: 'Ticket' }), el('dd', { text: c.ticket_id ? c.ticket_id + (c.ticket_category ? ' · ' + ticketLabel(c.ticket_category) : '') : '—' }),
          el('dt', { text: 'Spesa sessione' }), el('dd', { text: moneyFine(cost) + ' · ' + num(calls.length) + ' chiamate al modello' })),
        (d.findings || []).length ? [el('h3', { class: 'sec', text: 'Problemi rilevati dalla review' }),
          (d.findings || []).map(function (f) {
            var sv = SEV[f.severity] || SEV.low;
            return el('div', { style: 'border-left:3px solid ' + sv.color + ';padding:6px 10px;margin-bottom:8px;background:var(--surface-2);border-radius:6px' },
              el('div', { class: 'muted', style: 'font-size:12px', text: f.analysis_date + ' · ' + findingLabel(f.category) + ' · severità ' + sv.label.toLowerCase() }),
              el('div', { text: f.problem || '' }),
              el('div', { class: 'ink2', text: 'Suggerimento: ' + (f.suggestion || '') }));
          })] : null,
        el('h3', { class: 'sec', text: 'Thread completo (' + num((d.messages || []).length) + ' messaggi)' }),
        (d.messages || []).length ? el('div', { class: 'thread' }, (d.messages || []).map(bubble)) : empty('Nessun messaggio salvato per questo cliente.'),
        Object.keys(tools).length ? [el('h3', { class: 'sec', text: 'Strumenti usati' }), el('div', null, Object.keys(tools).map(function (k) { return el('span', { class: 'pill', text: (TOOL_LABEL[k] || k) + ' × ' + tools[k] }); }))] : null);
      var thread = body.querySelector('.thread');
      if (thread) thread.scrollTop = thread.scrollHeight;
    }).catch(function (e) { failed(body, e); });
  }
  function closeModal() { $('modal').classList.remove('open'); }

  // ---------- eventi ----------
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#presets button'), function (b) {
    b.addEventListener('click', function () { var p = b.getAttribute('data-p'); var r = presetRange(p); setRange(r[0], r[1], p); });
  });
  ['f-from', 'f-to'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var f = $('f-from').value, t = $('f-to').value;
      if (f && t) setRange(f <= t ? f : t, f <= t ? t : f, '');
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
    b.addEventListener('click', function () {
      dailyView = b.getAttribute('data-view');
      Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      renderDaily();
    });
  });
  $('inv-form').addEventListener('submit', function (e) { e.preventDefault(); runInvestigate(); });
  var qTimer = null;
  $('cust-q').addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { state.custPage = 0; loadCustomers(); }, 300); });
  $('cust-sort').addEventListener('change', function () { state.custPage = 0; loadCustomers(); });
  $('cust-prev').addEventListener('click', function () { if (state.custPage > 0) { state.custPage--; loadCustomers(); } });
  $('cust-next').addEventListener('click', function () { state.custPage++; loadCustomers(); });
  $('f-sev').addEventListener('change', renderFindings);
  $('f-cat').addEventListener('change', renderFindings);
  $('run-review').addEventListener('click', function () {
    var b = this;
    if (!confirm('Eseguire subito la review qualità sulle conversazioni di ieri? Usa il modello e ha un piccolo costo.')) return;
    b.disabled = true; b.textContent = 'Review in corso…';
    api('/run-review', { method: 'POST' }).then(function (r) {
      alert('Review completata: ' + r.analyzed + ' conversazioni analizzate, ' + r.findings + ' problemi trovati.');
      loadFindings();
    }).catch(function (e) { alert('Review non riuscita: ' + e.message); })
      .then(function () { b.disabled = false; b.textContent = 'Esegui la review ora'; });
  });
  $('modal-x').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  var rz = null;
  window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(redrawDaily, 150); });

  // ---------- avvio ----------
  var h = readHash();
  var preset = h.p || (h.from && h.to ? '' : 'month');
  var r0 = preset ? presetRange(preset) : [h.from, h.to];
  state.tab = LOADERS[h.tab] ? h.tab : 'overview';
  state.from = r0[0]; state.to = r0[1]; state.preset = preset;
  $('f-from').value = state.from; $('f-to').value = state.to;
  Array.prototype.forEach.call(document.querySelectorAll('#presets button'), function (b) {
    b.setAttribute('aria-pressed', b.getAttribute('data-p') === state.preset ? 'true' : 'false');
  });
  showTab(state.tab);
})();
</script>
</body>
</html>
`;
