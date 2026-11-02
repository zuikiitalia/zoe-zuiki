// Helper condivisi dai test: un D1 finto sopra SQLite in memoria, con lo schema di
// produzione e le FOREIGN KEY attive come su Cloudflare D1.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';

// D1 finto sopra SQLite in memoria, con lo schema di produzione e le FOREIGN KEY
// attive come su Cloudflare D1. Le query della dashboard girano davvero.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
  };
};

export function makeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(readFileSync('src/analytics/schema.sql', 'utf8'));
  // Migrazioni applicate in produzione da /api/migrate (vedi src/handlers/investigate.ts).
  raw.exec('ALTER TABLE tool_calls ADD COLUMN input_json TEXT');
  raw.exec('ALTER TABLE tool_calls ADD COLUMN output_json TEXT');
  raw.exec('ALTER TABLE tool_calls ADD COLUMN duration_ms INTEGER');
  raw.exec('CREATE TABLE IF NOT EXISTS assistant_thoughts (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, ts INTEGER NOT NULL, iteration INTEGER, text TEXT NOT NULL)');
  raw.exec('CREATE TABLE IF NOT EXISTS fashion_clip_searches (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT, suffix TEXT, candidates_json TEXT, reranked INTEGER DEFAULT 0, rerank_winner TEXT, rerank_confidence REAL, rerank_reasoning TEXT, final_handle TEXT, final_title TEXT, found_but_oos INTEGER DEFAULT 0)');
  const norm = (p: unknown[]) => p.map((v) => (v === undefined ? null : v));
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    first: async () => raw.prepare(sql).get(...norm(params)) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...norm(params)), success: true }),
    run: async () => { raw.prepare(sql).run(...norm(params)); return { success: true }; },
  });
  return {
    raw,
    prepare: (sql: string) => stmt(sql),
    batch: async (list: Array<{ run(): Promise<unknown> }>) => {
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database & { raw: InstanceType<typeof DatabaseSync> };
}

export function makeKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
  } as unknown as KVNamespace;
}

