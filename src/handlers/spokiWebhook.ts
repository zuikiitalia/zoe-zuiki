import type { Context } from 'hono';
import type { Env } from '../config';
import { INTER_MESSAGE_DELAY_MS } from '../config';
import { verifySpokiWebhook } from '../utils/security';
import { logger } from '../utils/logger';
import {
  loadConversation,
  saveConversation,
  checkAndIncrementRateLimit,
  isHumanActive,
  markHumanActive,
  isOurOutboundEcho,
  type StoredMessage,
} from '../storage/kvStore';
import { processMessage } from '../orchestrator/claudeOrchestrator';
import { sendSpokiMessage } from '../clients/spokiClient';
import { phoneHash, upsertConversation, updateSentiment } from '../analytics/db';
import { analyzeSentiment } from '../analytics/sentiment';
import { CLAUDE_MODEL } from '../config';

interface InboundMessage {
  phone: string;
  text: string;
  images: string[];
  contentType: string;
}

interface OutboundMessage {
  phone: string;     // numero del CLIENTE (to_phone in outbound)
  text: string;
  contentType: string;
}

// Estrae direction normalizzato dal payload Spoki.
function getDirection(payload: unknown): 'inbound' | 'outbound' | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;
  const event = p.event as string | undefined;
  const direction = data.direction as string | undefined;
  if (direction) {
    if (/^outbound$/i.test(direction)) return 'outbound';
    if (/^inbound$/i.test(direction)) return 'inbound';
  }
  if (event) {
    if (/outbound|outgoing|sent/i.test(event)) return 'outbound';
    if (/inbound|incoming|received/i.test(event)) return 'inbound';
  }
  return null;
}

// Formato webhook Spoki v2 (verificato live 2026-04-24):
//   { version: 2, event: "message.inbound", data: { from_phone, to_phone, text, content_type, direction, mediamessage_set: [...] } }
function extractInbound(
  payload: unknown,
  ownWhatsappNumber: string | undefined
): InboundMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;

  const event = p.event as string | undefined;
  if (event && !/message\.?inbound|received|incoming/i.test(event)) return null;

  const data = (p.data ?? {}) as Record<string, unknown>;
  const contact = (p.contact ?? {}) as Record<string, unknown>;
  const message = (p.message ?? {}) as Record<string, unknown>;

  const phoneRaw =
    data.from_phone ??
    contact.phone ??
    p.from ??
    p.phone ??
    (p.sender as Record<string, unknown> | undefined)?.phone;

  if (!phoneRaw) return null;

  const textRaw = (data.text ?? message.text ?? p.text ?? p.body ?? message.body ?? '') as string;
  const text = typeof textRaw === 'string' ? textRaw : '';

  const direction = getDirection(payload);
  if (direction === 'outbound') return null;

  const contentType = String(data.content_type ?? message.type ?? p.type ?? 'Text');

  // Accettiamo Text, Image e Audio/Voice (le note vocali vengono trascritte in processAsync).
  const isSupported = /^(text|image|audio|voice)$/i.test(contentType) || /^audio\//i.test(contentType);
  if (!isSupported) {
    // Per ora non gestiamo audio/video/document: accettiamo solo text/image.
    // Altri tipi: ignoriamo (al più Zoe potrebbe rispondere con un fallback, ma è comportamento da concordare).
    return null;
  }

  // Estrai URL media da mediamessage_set (immagini e audio)
  const images: string[] = [];
  const mediaSet = data.mediamessage_set;
  if (Array.isArray(mediaSet)) {
    for (const m of mediaSet) {
      if (!m || typeof m !== 'object') continue;
      const media = (m as Record<string, unknown>).media;
      const mContentType = (m as Record<string, unknown>).content_type as string | undefined;
      if (typeof media === 'string') {
        const isImg = mContentType && /^image\//i.test(mContentType);
        const isAudioMedia = mContentType && /^audio\//i.test(mContentType);
        const isTopLevelAudio = /^audio$/i.test(contentType);
        if (isImg || isAudioMedia || isTopLevelAudio) {
          images.push(media);
        }
      }
    }
  }

  // Se non c'è né testo né immagini utili, ignora
  if (!text && images.length === 0) return null;

  const phone = String(phoneRaw);

  // Anti-loop echo del nostro stesso numero
  if (ownWhatsappNumber && normalizePhone(phone) === normalizePhone(ownWhatsappNumber)) {
    return null;
  }

  return { phone, text, images, contentType };
}

// Estrae un messaggio outbound (Zuiki → cliente). Il "phone" che ci interessa
// è quello del CLIENTE — to_phone in outbound. Serve per riconoscere se è un
// eco di un nostro send (Zoe) o un messaggio mandato da un operatore umano.
function extractOutbound(payload: unknown): OutboundMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (getDirection(payload) !== 'outbound') return null;

  const data = (p.data ?? {}) as Record<string, unknown>;
  const message = (p.message ?? {}) as Record<string, unknown>;

  const phoneRaw =
    data.to_phone ??
    (data.contact as Record<string, unknown> | undefined)?.phone ??
    p.to ??
    p.phone;
  if (!phoneRaw) return null;

  const textRaw = (data.text ?? message.text ?? p.text ?? p.body ?? '') as string;
  const text = typeof textRaw === 'string' ? textRaw.trim() : '';
  if (!text) return null;

  const contentType = String(data.content_type ?? message.type ?? p.type ?? 'Text');
  return { phone: String(phoneRaw), text, contentType };
}

function normalizePhone(p: string): string {
  return p.replace(/\D/g, '');
}

function isPhoneAllowed(phone: string, allowlist: string | undefined): boolean {
  if (!allowlist || !allowlist.trim()) return true;
  const target = normalizePhone(phone);
  const allowed = allowlist
    .split(',')
    .map((s) => normalizePhone(s.trim()))
    .filter((s) => s.length > 0);
  return allowed.includes(target);
}

async function processAsync(env: Env, payload: unknown): Promise<void> {
  try {
    logger.info('webhook_payload_raw', { payload: payload as Record<string, unknown> });

    // OUTBOUND: messaggio mandato da Zuiki → cliente. Distinguere se è eco di Zoe
    // o messaggio da operatore umano. Se umano → flag human_active per 24h.
    const direction = getDirection(payload);
    if (direction === 'outbound') {
      const out = extractOutbound(payload);
      if (!out) {
        logger.info('webhook_outbound_ignored', {});
        return;
      }
      const isEcho = await isOurOutboundEcho(env.ZOE_KV, out.phone, out.text);
      if (isEcho) {
        logger.info('outbound_zoe_echo', { chars: out.text.length }, out.phone);
        return;
      }
      // Operatore umano sta scrivendo → Zoe non risponde più per 24h.
      await markHumanActive(env.ZOE_KV, out.phone);
      logger.info('human_operator_detected', { chars: out.text.length }, out.phone);
      return;
    }

    const extracted = extractInbound(payload, env.WHATSAPP_NUMBER);
    if (!extracted) {
      logger.info('webhook_ignored', {
        keys: payload && typeof payload === 'object' ? Object.keys(payload as object) : [],
      });
      return;
    }
    let { phone, text, images, contentType } = extracted;

    // Se un operatore umano è già attivo su questa chat (ha mandato un outbound
    // non-Zoe nelle ultime 24h), Zoe NON risponde — il customer care gestisce.
    if (await isHumanActive(env.ZOE_KV, phone)) {
      logger.info('skip_human_active', { content_type: contentType }, phone);
      return;
    }

    // Nota vocale: trascrive con Cloudflare Whisper e tratta come testo normale
    if ((/^(audio|voice)$/i.test(contentType) || /^audio\//i.test(contentType)) && env.AI) {
      const audioUrl = extracted.images[0] ?? null; // audio URL in images array
      if (audioUrl) {
        try {
          const audioRes = await fetch(audioUrl);
          if (audioRes.ok) {
            const buf = await audioRes.arrayBuffer();
            const result = await env.AI.run('@cf/openai/whisper', {
              audio: Array.from(new Uint8Array(buf)),
            }) as { text?: string };
            const transcribed = result?.text?.trim();
            if (transcribed) {
              logger.info('voice_transcribed', { chars: transcribed.length }, phone);
              text = transcribed;
              images = [];
              contentType = 'Text';
            }
          }
        } catch (err) {
          logger.error('voice_transcription_failed', {
            error: err instanceof Error ? err.message : String(err),
          }, phone);
          return; // non rispondere se trascrizione fallisce
        }
      }
      // Se non c'è URL audio o trascrizione vuota, ignora
      if (!text) return;
    }

    if (!isPhoneAllowed(phone, env.ALLOWLIST_PHONES)) {
      logger.info('phone_not_in_allowlist', { content_type: contentType }, phone);
      return;
    }

    logger.info(
      'webhook_received',
      { chars: text.length, images: images.length, content_type: contentType },
      phone
    );

    const allowed = await checkAndIncrementRateLimit(env.ZOE_KV, phone);
    if (!allowed) {
      logger.warn('rate_limited', {}, phone);
      return;
    }

    const history = await loadConversation(env.ZOE_KV, phone);

    // Calcola convId per analytics: hash(phone) + '_' + timestamp del primo messaggio.
    const pHash = env.ZOE_DB ? await phoneHash(phone) : '';
    const firstTs = history.length > 0 ? (history[0]?.ts ?? Date.now()) : Date.now();
    const convId = pHash ? `${pHash}_${firstTs}` : '';

    let replies: string[];
    try {
      replies = await processMessage(env, phone, text, history, undefined, images, convId || undefined);
    } catch (err) {
      logger.error(
        'orchestrator_failed',
        { error: err instanceof Error ? err.message : String(err) },
        phone
      );
      replies = [
        'Sto avendo un problema tecnico, riprova tra qualche minuto o scrivi a shoponline@zuiki.it.',
      ];
    }

    // Caso speciale: replies vuoto = marker [NO_REPLY] da Claude (anti-loop).
    // Salviamo comunque il messaggio del cliente in history per non perdere context,
    // e mettiamo un placeholder assistant che indichi "ho deciso di non rispondere".
    if (replies.length === 0) {
      const now = Date.now();
      const userContent = images.length > 0
        ? `${text || '(immagine senza testo)'} [${images.length} immagine/i ricevuta/e]`
        : text;
      const updated: StoredMessage[] = [
        ...history,
        { role: 'user', content: userContent, ts: now },
        // Placeholder breve per non rompere il pattern alternato user/assistant in history.
        // Non viene mai inviato, è solo memoria interna.
        { role: 'assistant' as const, content: '(silenzio intenzionale: ho applicato anti-loop dopo rifiuti consecutivi)', ts: now },
      ];
      await saveConversation(env.ZOE_KV, phone, updated);
      return;
    }

    // Invia prima, poi salva solo le reply effettivamente consegnate a Spoki.
    // Evita di "ricordare" in KV risposte che il cliente non ha ricevuto.
    const sentReplies: string[] = [];
    for (let i = 0; i < replies.length; i++) {
      if (i > 0) await new Promise((res) => setTimeout(res, INTER_MESSAGE_DELAY_MS));
      try {
        await sendSpokiMessage(env, phone, replies[i]!);
        sentReplies.push(replies[i]!);
      } catch (err) {
        logger.error(
          'send_reply_failed',
          { index: i, error: err instanceof Error ? err.message : String(err) },
          phone
        );
        // Interrompi il loop: se il primo messaggio non va, inutile provare il secondo.
        break;
      }
    }

    // Salva la conversazione solo se abbiamo consegnato almeno una reply.
    if (sentReplies.length > 0) {
      const now = Date.now();
      const userContent = images.length > 0
        ? `${text || '(immagine senza testo)'} [${images.length} immagine/i ricevuta/e]`
        : text;
      const updated: StoredMessage[] = [
        ...history,
        { role: 'user', content: userContent, ts: now },
        ...sentReplies.map((r) => ({ role: 'assistant' as const, content: r, ts: now })),
      ];
      await saveConversation(env.ZOE_KV, phone, updated);

      // Scrivi dati analytics in D1 (awaited: siamo dentro waitUntil, non blocca il client).
      if (env.ZOE_DB && convId) {
        const userTurns = updated.filter(m => m.role === 'user').length;
        const assistantTurns = updated.filter(m => m.role === 'assistant').length;

        await upsertConversation(env.ZOE_DB, {
          convId,
          phoneHash: pHash,
          firstTs,
          lastTs: now,
          userTurns,
          assistantTurns,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCostUsd: 0,
        }).catch((e) => { logger.error('d1_upsert_failed', { error: String(e) }); });

        // Sentiment analysis su conversazioni con almeno 4 scambi.
        if (updated.length >= 4 && env.ANTHROPIC_API_KEY) {
          await analyzeSentiment(env.ANTHROPIC_API_KEY, updated).then(result =>
            updateSentiment(env.ZOE_DB!, convId, result.sentiment, result.note)
          ).catch((e) => { logger.error('d1_sentiment_failed', { error: String(e) }); });
        }
      }
    }
  } catch (err) {
    logger.error('webhook_async_failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
    });
  }
}

export async function handleSpokiWebhook(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  if (!verifySpokiWebhook(c.req.raw, c.env.WEBHOOK_SECRET)) {
    logger.warn('webhook_unauthorized', { ip: c.req.header('cf-connecting-ip') ?? 'unknown' });
    return c.json({ error: 'unauthorized' }, 401);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    logger.warn('webhook_invalid_json');
    return c.json({ error: 'invalid_json' }, 400);
  }

  c.executionCtx.waitUntil(processAsync(c.env, payload));
  return c.json({ ok: true });
}
