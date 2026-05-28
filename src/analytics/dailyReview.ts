import type { D1Database } from '@cloudflare/workers-types';
import Anthropic from '@anthropic-ai/sdk';
import { insertApiCall } from './db';
import { computeCostUsd } from './costs';
import { logger } from '../utils/logger';

// Opus 4.7 per la review giornaliera: il job non è latency-sensitive e la qualità
// dell'analisi è critica (i findings guidano gli update del prompt).
const REVIEW_MODEL = 'claude-opus-4-7';

const REVIEW_SYSTEM = `Sei un revisore di qualità per Zoe, un AI customer care su WhatsApp per Zuiki.

Analizza la conversazione fornita e identifica problemi SPECIFICI in cui Zoe poteva fare meglio. Cerca tra questi pattern noti:
- missed_ticket: cliente chiede aiuto/parlare con umano/esprime frustrazione ma Zoe non apre ticket
- wrong_refusal: Zoe rifiuta dicendo "non sono stata pensata per questo" o simili quando la richiesta è in ambito (ordine, prodotto, reso, negozio Zuiki)
- ambiguous_language: Zoe usa termini ambigui (es. "email" invece di "indirizzo email") che confondono il cliente
- missed_context: Zoe ignora informazioni che il cliente le ha fornito (numero ordine, screenshot, testo email, dettagli in messaggi precedenti)
- silent_stop: Zoe smette di rispondere quando dovrebbe ancora rispondere o aprire ticket
- false_promise: Zoe promette esiti che non può garantire (rimborsi specifici, tempistiche, eccezioni)
- repetitive: Zoe ripete la stessa risposta senza progredire
- meta_excuse: Zoe dà scuse di sistema ("catalogo non aggiornato", "errore del sistema") invece di risolvere
- other: altro problema rilevante

Rispondi SOLO con JSON, niente testo extra. Array di problemi. Se Zoe ha gestito bene la conversazione, ritorna [].

Formato per ogni problema:
{"category":"<pattern>","severity":"low|medium|high","problem":"<max 200 char>","suggestion":"<max 200 char>","excerpt":"<max 200 char>"}

NOTA: i messaggi taggati [Operatore CC] o [Notifica Zuiki] NON sono di Zoe — non penalizzarla per quelli. Valuta solo i messaggi "assistant" senza tag come scritti da Zoe.`;

interface Finding {
  category: string;
  severity: string;
  problem: string;
  suggestion: string;
  excerpt: string;
}

// Esegue la review delle conversazioni del giorno precedente (00:00–23:59 di ieri,
// in UTC per semplicità). Salva i findings in D1 nella tabella review_findings.
export async function runDailyReview(
  db: D1Database,
  anthropicApiKey: string
): Promise<{ analyzed: number; findings: number }> {
  const now = new Date();
  const today00 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterday00 = today00 - 24 * 60 * 60 * 1000;
  const dateStr = new Date(yesterday00).toISOString().slice(0, 10);

  const convs = await db.prepare(
    `SELECT id, phone_hash FROM conversations WHERE last_ts >= ? AND last_ts < ?`
  ).bind(yesterday00, today00).all<{ id: string; phone_hash: string }>();

  const anthropic = new Anthropic({ apiKey: anthropicApiKey });
  let analyzed = 0;
  let totalFindings = 0;

  // Conv ID sintetico per aggregare i costi della review nel DB (formato riconoscibile)
  const reviewConvId = `review_${dateStr}`;

  for (const conv of convs.results ?? []) {
    try {
      // Carica solo i messaggi degli ultimi 7 giorni (non tutta la storia del cliente)
      const since7d = yesterday00 - 6 * 24 * 60 * 60 * 1000;
      const msgRows = await db.prepare(
        `SELECT role, content FROM messages WHERE phone_hash = ? AND ts >= ? ORDER BY ts ASC`
      ).bind(conv.phone_hash, since7d).all<{ role: string; content: string }>();
      const messages = msgRows.results ?? [];
      if (messages.length < 2) continue;

      const convText = messages
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');

      const t0 = Date.now();
      const resp = await anthropic.messages.create({
        model: REVIEW_MODEL,
        max_tokens: 1024,
        system: REVIEW_SYSTEM,
        messages: [{ role: 'user', content: convText.slice(0, 30_000) }],
      });

      // Traccia il costo nel DB così appare nel dashboard
      const usage = resp.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      await insertApiCall(db, reviewConvId, {
        model: REVIEW_MODEL,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        latencyMs: Date.now() - t0,
        iteration: 0,
        stopReason: resp.stop_reason ?? 'end_turn',
      }).catch(() => {});

      const text = resp.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('');

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        analyzed++;
        continue;
      }

      let findings: Finding[];
      try {
        findings = JSON.parse(match[0]) as Finding[];
      } catch {
        analyzed++;
        continue;
      }

      for (const f of findings) {
        const id = `${conv.id}_${dateStr}_${Math.random().toString(36).slice(2, 9)}`;
        await db.prepare(`
          INSERT OR IGNORE INTO review_findings
            (id, conv_id, phone_hash, analysis_date, category, severity, problem, suggestion, conv_excerpt, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).bind(
          id, conv.id, conv.phone_hash, dateStr,
          (f.category ?? 'other').slice(0, 30),
          (f.severity ?? 'medium').slice(0, 10),
          (f.problem ?? '').slice(0, 500),
          (f.suggestion ?? '').slice(0, 500),
          (f.excerpt ?? '').slice(0, 500),
          Date.now()
        ).run();
        totalFindings++;
      }
      analyzed++;
    } catch (err) {
      logger.error('review_conv_failed', {
        conv_id: conv.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('daily_review_done', { date: dateStr, analyzed, findings: totalFindings });
  return { analyzed, findings: totalFindings };
}
