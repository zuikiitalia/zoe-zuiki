import type { D1Database } from '@cloudflare/workers-types';
import { computeCostUsd, PRICING } from './costs';

// Chiamate al modello che NON appartengono a una conversazione cliente
// (review notturna, analisi sentiment, reranker visivo). Vivono in una tabella
// separata senza FOREIGN KEY: in api_calls il vincolo verso conversations faceva
// scartare in silenzio ogni riga con un conv_id fittizio (es. "review_2026-10-26").
export type SystemSource = 'review' | 'sentiment' | 'reranker';

export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

// Crea la tabella al primo uso, una volta per database (cache per istanza di D1).
const tableReady = new WeakMap<D1Database, Promise<void>>();

export function ensureSystemUsageTable(db: D1Database): Promise<void> {
  let ready = tableReady.get(db);
  if (!ready) {
    ready = db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS system_api_calls (
          id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          source TEXT NOT NULL,
          model TEXT NOT NULL,
          conv_id TEXT,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_creation_tokens INTEGER DEFAULT 0,
          cost_usd REAL DEFAULT 0,
          latency_ms INTEGER
        )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_system_api_calls_ts ON system_api_calls(ts)`),
    ]).then(() => undefined).catch((err) => {
      tableReady.delete(db); // riprova alla prossima chiamata
      throw err;
    });
    tableReady.set(db, ready);
  }
  return ready;
}

export async function insertSystemApiCall(
  db: D1Database,
  source: SystemSource,
  model: string,
  usage: UsageLike | undefined,
  latencyMs: number,
  convId?: string,
): Promise<void> {
  await ensureSystemUsageTable(db);
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
  const cost = computeCostUsd(model, input, output, cacheRead, cacheCreate);
  const id = `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await db.prepare(`
    INSERT OR IGNORE INTO system_api_calls
      (id, ts, source, model, conv_id, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd, latency_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, Date.now(), source, model, convId ?? null, input, output, cacheRead, cacheCreate, cost, latencyMs).run();
}

// Espressione SQL che ricalcola il costo di una riga dai token e dal modello,
// usando il listino attuale. Così anche le righe storiche salvate con prezzi
// vecchi (es. Opus 4.7 a $15/$75) vengono mostrate al prezzo corretto.
export function costSql(): string {
  const cases = Object.entries(PRICING)
    // chiavi più lunghe prima, così un prefisso non "ruba" un modello più specifico
    .sort((a, b) => b[0].length - a[0].length)
    .map(([model, p]) =>
      `WHEN model LIKE '${model}%' THEN (input_tokens*${p.input} + output_tokens*${p.output} + cache_read_tokens*${p.cacheRead} + cache_creation_tokens*${p.cacheCreate}) / 1000000.0`
    )
    .join(' ');
  return `(CASE ${cases} ELSE cost_usd END)`;
}
