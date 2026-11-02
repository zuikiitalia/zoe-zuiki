import type { Context } from 'hono';
import type { Env } from '../config';
import { INTER_MESSAGE_DELAY_MS, MAX_CLAUDE_HISTORY_MESSAGES, MSG_DEBOUNCE_WINDOW_MS } from '../config';
import { verifySpokiWebhook } from '../utils/security';
import { bufferInbound, claimBurst } from '../storage/inboundBuffer';
import { logger } from '../utils/logger';
import { normalizePhone } from '../utils/phone';
import {
  loadConversation,
  saveConversation,
  checkAndIncrementRateLimit,
  isHumanActive,
  markHumanActive,
  clearHumanActive,
  isOurOutboundEcho,
  isZoeBlocked,
  type StoredMessage,
} from '../storage/kvStore';
import { processMessage } from '../orchestrator/claudeOrchestrator';
import { sendSpokiMessage, createSpokiTicket } from '../clients/spokiClient';
import { phoneHash, upsertConversation, updateSentiment, appendMessage, loadFullHistory, ensureConversation } from '../analytics/db';
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
  // Tipo Spoki: "Message" (umano o API), "Template" / "whatsapp_campaign" (automazione),
  // "Note" (nota interna).
  spokiType: string;
  // ID del messaggio Spoki: per il match deterministico (usato solo come fallback).
  spokiId: string | null;
  // sender.is_service (V1 webhook): true = inviato via API (Zoe), false = operatore umano.
  // null = sender assente nel payload (V2 senza expand).
  isService: boolean | null;
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
  // type Spoki: distingue "Message" (umano o API), "Template" (automazione), "Note" (nota), ecc.
  const spokiType = String(data.type ?? message.kind ?? '');
  // ID del messaggio Spoki (fallback per echo detection).
  const idRaw = data.id ?? data.message_id ?? data.external_id ?? message.id ?? p.id;
  const spokiId = idRaw !== undefined && idRaw !== null ? String(idRaw) : null;
  // sender.is_service: true = inviato via API (Zoe), false = operatore umano.
  // Presente nel payload V1; in V2 richiede expand "sender".
  const sender = (data.sender ?? {}) as Record<string, unknown>;
  const isService = typeof sender.is_service === 'boolean' ? sender.is_service : null;
  return { phone: String(phoneRaw), text, contentType, spokiType, spokiId, isService };
}

// Estrae phone e tag name dal payload contact_tag.created / contact_tag.deleted.
// Struttura reale verificata dalla Spoki API doc (2026-05-17):
//   { event: "contact_tag.created", data: { contact: { phone }, tag: { name } } }
function extractTagEvent(payload: unknown): { phone: string; tag: string } | null {
  const p = payload as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;
  const contact = (data.contact ?? {}) as Record<string, unknown>;
  const tagObj = (data.tag ?? {}) as Record<string, unknown>;
  const phone = String(contact.phone ?? '').trim();
  const tag = String(tagObj.name ?? '').toLowerCase().trim();
  if (!phone || !tag) return null;
  return { phone, tag };
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

    // TAG EVENTS: l'operatore aggiunge/rimuove il tag "zoe_pausa" dal contatto in Spoki.
    // Questo è il meccanismo ufficiale per segnalare a Zoe di tacere/riprendere.
    // Zero ambiguità: azione esplicita dell'operatore, nessun rischio di false positive.
    const event = String((payload as Record<string, unknown>).event ?? '');
    if (event === 'contact_tag.created') {
      const t = extractTagEvent(payload);
      if (t?.tag === 'zoe_pausa') {
        await markHumanActive(env.ZOE_KV, t.phone);
        logger.info('zoe_paused_via_tag', {}, t.phone);
      }
      return;
    }
    if (event === 'contact_tag.deleted') {
      const t = extractTagEvent(payload);
      if (t?.tag === 'zoe_pausa') {
        await clearHumanActive(env.ZOE_KV, t.phone);
        logger.info('zoe_resumed_via_tag', {}, t.phone);
      }
      return;
    }

    // OUTBOUND: messaggio mandato da Zuiki → cliente.
    // Logica di classificazione (priorità decrescente):
    //
    //  1. Note interne → ignora sempre (non visibili al cliente)
    //  2. sender.is_service === true → inviato via API o automazione Spoki (mai umano)
    //       - type Template/campaign → salva in history come [Notifica Zuiki]
    //       - type Message (Zoe via API) → ignora (già salvato nel flusso principale)
    //  3. sender.is_service === false + type Message → operatore umano → markHumanActive
    //  4. sender.is_service === null (V2 senza expand) → fallback hash/tipo
    const direction = getDirection(payload);
    if (direction === 'outbound') {
      const out = extractOutbound(payload);
      if (!out) {
        logger.info('webhook_outbound_ignored', {});
        return;
      }

      const t = out.spokiType.toLowerCase();

      // 1. Note interne
      if (t === 'note') {
        logger.info('outbound_note_ignored', {}, out.phone);
        return;
      }

      const isAutomationType = t === 'template' || t === 'whatsapp_campaign' || t === 'campaign';

      // Helper: salva messaggio outbound in history (D1 + KV)
      const saveOutboundToHistory = async (content: string) => {
        const now = Date.now();
        if (env.ZOE_DB) {
          const pHashOut = await phoneHash(out.phone);
          await appendMessage(env.ZOE_DB, pHashOut, 'assistant', content, now)
            .catch((e) => logger.error('d1_append_outbound_failed', { error: String(e) }, out.phone));
        }
        const prev = await loadConversation(env.ZOE_KV, out.phone);
        await saveConversation(env.ZOE_KV, out.phone, [
          ...prev,
          { role: 'assistant', content, ts: now },
        ]);
      };

      // 2. API / automazione Spoki (is_service === true)
      if (out.isService === true) {
        if (isAutomationType) {
          // Automazione Spoki (es. "Ordine Spedito", "IN Giacenza") → salva per contesto
          await saveOutboundToHistory(`[Notifica Zuiki]: ${out.text}`);
          logger.info('outbound_automation_saved', { type: out.spokiType, chars: out.text.length }, out.phone);
        } else {
          // Zoe via API (type Message) → già salvato nel flusso principale, non duplicare
          logger.info('outbound_zoe_api_ignored', { type: out.spokiType, chars: out.text.length }, out.phone);
        }
        return;
      }

      // 3. Operatore umano: sender.is_service === false → SEMPRE operatore, indipendentemente
      // dal type (Message digitato O Template cliccato dall'operatore in Spoki UI).
      // Verificato con payload reale 2026-05-18: operatore clicca "invia template" →
      // sender.is_service:false + sender.email/firstname/surname dell'operatore.
      // Le automazioni Spoki (Shopify Ordine Spedito ecc.) usano sender system con is_service:true.
      if (out.isService === false) {
        const tag = isAutomationType ? '[Operatore CC - Template]' : '[Operatore CC]';
        await saveOutboundToHistory(`${tag}: ${out.text}`);
        await markHumanActive(env.ZOE_KV, out.phone);
        logger.info('human_operator_detected', { chars: out.text.length, type: out.spokiType }, out.phone);
        return;
      }

      // 4. Fallback: is_service === null (V2 senza expand "sender")
      if (isAutomationType) {
        await saveOutboundToHistory(`[Notifica Zuiki]: ${out.text}`);
        logger.info('outbound_automation_saved_fallback', { type: out.spokiType }, out.phone);
        return;
      }
      // type Message senza is_service: usa hash detection come ultima risorsa
      const isEcho = await isOurOutboundEcho(env.ZOE_KV, out.phone, out.text, out.spokiId);
      if (isEcho) {
        logger.info('outbound_zoe_echo_hash_fallback', { spoki_id: out.spokiId ?? 'none' }, out.phone);
        return;
      }
      // Non è nostro echo e is_service sconosciuto → trattare come operatore per sicurezza
      await saveOutboundToHistory(`[Operatore CC]: ${out.text}`);
      await markHumanActive(env.ZOE_KV, out.phone);
      logger.info('outbound_unknown_marked_human', { type: out.spokiType, chars: out.text.length }, out.phone);
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

    // HARD BLOCK: utente escluso da Zoe tramite dashboard (gestione solo umana, permanente).
    if (await isZoeBlocked(env.ZOE_KV, phone)) {
      logger.info('zoe_blocked_hard_block', { content_type: contentType }, phone);
      return;
    }

    // HARD BLOCK: se un operatore umano ha preso la conversazione, Zoe non risponde mai.
    // Nessun hint, nessuna delega a Claude: blocco immediato e definitivo.
    const humanActive = await isHumanActive(env.ZOE_KV, phone);
    if (humanActive) {
      logger.info('human_active_hard_block', { content_type: contentType }, phone);
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

    // DEBOUNCE MESSAGGI CONCATENATI: alcuni clienti spezzano un unico concetto in più
    // messaggi ravvicinati (es. numero d'ordine e poi email). Registriamo il messaggio,
    // aspettiamo una finestra di silenzio e solo l'ultima esecuzione del gruppo risponde,
    // unendo tutti i messaggi in un solo turno. Su D1 (consistente e atomico): con KV
    // le letture vecchie facevano rispondere a ogni messaggio separatamente.
    if (env.ZOE_DB) {
      const myId = await bufferInbound(env.ZOE_DB, phone, text, images);
      await new Promise((res) => setTimeout(res, MSG_DEBOUNCE_WINDOW_MS));
      const parts = await claimBurst(env.ZOE_DB, phone, myId);
      if (!parts) {
        // È arrivato un messaggio più recente: risponderà quell'esecuzione a tutto il gruppo.
        logger.info('debounce_superseded', {}, phone);
        return;
      }
      if (parts.length > 1) {
        const combinedText = parts.map((m) => m.text).filter(Boolean).join('\n');
        const combinedImages = parts.flatMap((m) => m.images);
        logger.info('debounce_combined', { parts: parts.length, chars: combinedText.length, images: combinedImages.length }, phone);
        text = combinedText || text;
        images = combinedImages;
      }
    }

    // Carichiamo l'intera storia con il cliente da D1 (permanente, no scadenza).
    // KV come fallback se D1 non disponibile.
    const pHash = env.ZOE_DB ? await phoneHash(phone) : '';
    let history: StoredMessage[];
    if (env.ZOE_DB && pHash) {
      const rows = await loadFullHistory(env.ZOE_DB, pHash).catch(() => []);
      history = rows.map(r => ({ role: r.role, content: r.content, ts: r.ts }));
      // Fallback: se D1 è vuoto (es. conversazione iniziata prima della migrazione),
      // proviamo a recuperare la storia dal KV.
      if (history.length === 0) {
        history = await loadConversation(env.ZOE_KV, phone);
      }
    } else {
      history = await loadConversation(env.ZOE_KV, phone);
    }

    const isNewCustomer = history.length === 0;
    const firstTs = !isNewCustomer ? (history[0]?.ts ?? Date.now()) : Date.now();
    const convId = pHash ? `${pHash}_${firstTs}` : '';

    // La riga della conversazione deve esistere PRIMA che l'orchestratore registri
    // costi, tool call e pensieri (FOREIGN KEY in D1). Prima veniva creata solo a fine
    // turno, e i costi del primo turno di ogni cliente nuovo andavano persi.
    if (env.ZOE_DB && convId) {
      await ensureConversation(env.ZOE_DB, convId, pHash, normalizePhone(phone), firstTs)
        .catch((e) => logger.error('d1_ensure_conversation_failed', { error: String(e) }, phone));
    }

    // Tronca la storia inviata a Claude: D1 ha la storia completa (per dashboard e analytics)
    // ma Claude riceve solo gli ultimi MAX_CLAUDE_HISTORY_MESSAGES per evitare timeout/token limits.
    const historyForClaude = history.slice(-MAX_CLAUDE_HISTORY_MESSAGES);

    let replies: string[];
    try {
      replies = await processMessage(env, phone, text, historyForClaude, undefined, images, convId || undefined, humanActive);
    } catch (err) {
      logger.error(
        'orchestrator_failed',
        { error: err instanceof Error ? err.message : String(err) },
        phone
      );
      // Errore tecnico: apri ticket immediato per intervento operatore CC.
      const ticketId = `ZOE-ERR-${Date.now()}`;
      await createSpokiTicket(env, {
        phone,
        category: 'tecnico',
        reason: 'altro',
        details: `Errore tecnico automatico durante elaborazione messaggio: ${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}`,
        urgency: 'normal',
        zoeTicketId: ticketId,
      }).catch((e) => logger.error('emergency_ticket_failed', { error: String(e) }, phone));
      replies = [
        '✅ Ho richiesto l\'intervento di un assistente del customer care. Verrai contattato qui in chat non appena sarà il tuo turno (lun-ven 8-17). Se scrivi fuori orario ti rispondono alla riapertura.',
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
      const placeholder = '(silenzio intenzionale: marker [NO_REPLY] emesso da Claude)';
      const updated: StoredMessage[] = [
        ...history,
        // Cliente nuovo: il primo messaggio prende il timestamp usato per convId, così al
        // turno successivo history[0].ts === firstTs e la conversazione non si spezza in due.
        { role: 'user', content: userContent, ts: isNewCustomer ? firstTs : now },
        { role: 'assistant' as const, content: placeholder, ts: now },
      ];
      await saveConversation(env.ZOE_KV, phone, updated);
      // Persistenza D1.
      if (env.ZOE_DB && pHash) {
        await appendMessage(env.ZOE_DB, pHash, 'user', userContent, isNewCustomer ? firstTs : now).catch(() => {});
        await appendMessage(env.ZOE_DB, pHash, 'assistant', placeholder, now).catch(() => {});
      }
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
        // Cliente nuovo: il primo messaggio prende il timestamp usato per convId, così al
        // turno successivo history[0].ts === firstTs e la conversazione non si spezza in due.
        { role: 'user', content: userContent, ts: isNewCustomer ? firstTs : now },
        ...sentReplies.map((r) => ({ role: 'assistant' as const, content: r, ts: now })),
      ];
      await saveConversation(env.ZOE_KV, phone, updated);
      // Persistenza D1 (no scadenza).
      if (env.ZOE_DB && pHash) {
        await appendMessage(env.ZOE_DB, pHash, 'user', userContent, isNewCustomer ? firstTs : now).catch(() => {});
        for (const r of sentReplies) {
          await appendMessage(env.ZOE_DB, pHash, 'assistant', r, now).catch(() => {});
        }
      }

      // Scrivi dati analytics in D1 (awaited: siamo dentro waitUntil, non blocca il client).
      if (env.ZOE_DB && convId) {
        const userTurns = updated.filter(m => m.role === 'user').length;
        const assistantTurns = updated.filter(m => m.role === 'assistant').length;

        await upsertConversation(env.ZOE_DB, {
          convId,
          phoneHash: pHash,
          phoneFull: normalizePhone(phone),
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
          await analyzeSentiment(env.ANTHROPIC_API_KEY, updated, env.ZOE_DB, convId).then(result =>
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
