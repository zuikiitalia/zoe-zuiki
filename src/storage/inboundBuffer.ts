import type { D1Database } from '@cloudflare/workers-types';

// Raccolta dei messaggi ravvicinati di un cliente (debounce), su D1.
//
// Prima usavamo KV, ma KV è eventualmente consistente (le letture possono restare
// vecchie fino a ~60s) e non ha operazioni atomiche: due messaggi mandati a pochi
// secondi venivano spesso elaborati separatamente. D1 invece è consistente e
// DELETE ... RETURNING è atomico: una sola esecuzione può "prendersi" il gruppo.

export interface InboundPart { id: string; ts: number; text: string; images: string[] }

// Messaggi più vecchi di così nel buffer sono avanzi di un'esecuzione interrotta:
// non vanno incollati al turno corrente.
const STALE_MS = 120_000;

const ready = new WeakMap<D1Database, Promise<void>>();

function ensureTable(db: D1Database): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS inbound_buffer (
        id TEXT PRIMARY KEY,
        phone_key TEXT NOT NULL,
        ts INTEGER NOT NULL,
        text TEXT,
        images_json TEXT
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_inbound_buffer_phone_ts ON inbound_buffer(phone_key, ts)`),
    ]).then(() => undefined).catch((err) => { ready.delete(db); throw err; });
    ready.set(db, p);
  }
  return p;
}

function phoneKey(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

// Registra il messaggio in arrivo e ritorna il suo id.
export async function bufferInbound(db: D1Database, phone: string, text: string, images: string[]): Promise<string> {
  await ensureTable(db);
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await db.prepare(`INSERT INTO inbound_buffer (id, phone_key, ts, text, images_json) VALUES (?,?,?,?,?)`)
    .bind(id, phoneKey(phone), Date.now(), text, JSON.stringify(images)).run();
  return id;
}

// Dopo la finestra di attesa: se il nostro è l'ultimo messaggio arrivato, prende
// atomicamente tutti i messaggi del gruppo e li ritorna in ordine. Ritorna null se
// è arrivato un messaggio più recente (sarà quell'esecuzione a rispondere) o se
// un'altra esecuzione ha già preso il gruppo.
export async function claimBurst(db: D1Database, phone: string, myId: string): Promise<InboundPart[] | null> {
  const key = phoneKey(phone);
  const latest = await db.prepare(
    `SELECT id FROM inbound_buffer WHERE phone_key = ? ORDER BY ts DESC, id DESC LIMIT 1`
  ).bind(key).first<{ id: string }>();
  if (!latest || latest.id !== myId) return null;

  const taken = await db.prepare(
    `DELETE FROM inbound_buffer WHERE phone_key = ? RETURNING id, ts, text, images_json`
  ).bind(key).all<{ id: string; ts: number; text: string | null; images_json: string | null }>();
  const rows = taken.results ?? [];
  if (!rows.some((r) => r.id === myId)) return null;

  const cutoff = Date.now() - STALE_MS;
  return rows
    .filter((r) => r.ts >= cutoff || r.id === myId)
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
    .map((r) => {
      let images: string[] = [];
      try { images = JSON.parse(r.images_json ?? '[]') as string[]; } catch { images = []; }
      return { id: r.id, ts: r.ts, text: r.text ?? '', images };
    });
}
