import type { Env } from '../config';
import { logger } from '../utils/logger';

// Endpoint verificati dalla doc Postman ufficiale Spoki (2026-04-24).
const SPOKI_SEND_URL = 'https://api.spoki.com/api/1/messages/send/';
const SPOKI_TICKETS_URL = 'https://api.spoki.com/api/1/tickets/';

export async function sendSpokiMessage(env: Env, phone: string, text: string): Promise<void> {
  const headers: Record<string, string> = {
    'X-Spoki-Api-Key': env.SPOKI_API_KEY,
    'Content-Type': 'application/json',
  };
  if (env.SPOKI_PRIVATE_TOKEN) {
    headers['Authorization'] = `Bearer ${env.SPOKI_PRIVATE_TOKEN}`;
  }

  const body = {
    type: 'Message',
    content_type: 'Text',
    phone,
    text,
  };

  const res = await fetch(SPOKI_SEND_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    logger.error('spoki_send_failed', { status: res.status, body: errorBody.slice(0, 500) }, phone);
    throw new Error(`Spoki send failed: ${res.status}`);
  }
  logger.info('message_sent', { chars: text.length }, phone);
}

const TICKET_TITLE_BY_REASON: Record<string, string> = {
  // ordine
  ordine_cancellazione: '📦 Cancellazione ordine',
  ordine_modifica_indirizzo: '📦 Modifica indirizzo',
  ordine_modifica_taglia_colore: '📦 Modifica taglia/colore',
  ordine_stato_non_aggiornato: '📦 Stato ordine non aggiornato',
  // spedizione
  spedizione_pacco_non_consegnato: '🚚 Pacco non consegnato',
  spedizione_ritardo: '🚚 Ritardo spedizione',
  spedizione_tracking_bloccato: '🚚 Tracking bloccato',
  spedizione_indirizzo_errato: '🚚 Indirizzo errato',
  // reso_rimborso
  rimborso_non_ricevuto: '💶 Rimborso non ricevuto',
  richiesta_reso: '↩️ Richiesta reso',
  cambio_taglia_colore: '↩️ Cambio taglia/colore',
  // prodotto
  prodotto_articolo_errato: '⚠️ Articolo errato ricevuto',
  prodotto_difettoso_danneggiato: '⚠️ Articolo difettoso/danneggiato',
  prodotto_disponibilita_futura: '🔔 Richiesta disponibilità futura',
  // pagamento
  pagamento_contestazione_addebito: '💳 Contestazione addebito',
  pagamento_non_riuscito: '💳 Pagamento non riuscito',
  pagamento_codice_sconto: '💳 Problema codice sconto',
  // reclamo
  reclamo_legale: '🚨 Reclamo legale',
  reclamo_esperienza_negativa: '💬 Reclamo esperienza',
  reclamo_social_recensione: '💬 Reclamo social/recensione',
  // richiesta umano
  cliente_richiede_operatore: '👤 Cliente chiede operatore',
  // amministrativo
  richiesta_fattura: '🧾 Richiesta fattura',
  richiesta_b2b_collaborazione: '🤝 B2B / Collaborazione',
  // tecnico
  problema_checkout: '🔧 Problema checkout',
  problema_account: '🔧 Problema account',
  // fallback
  altro: '💬 Richiesta supporto',
};

const PRIORITY_BY_URGENCY: Record<string, string> = {
  normal: "Medium",
  high: "High",
};

export interface CreateTicketInput {
  phone: string;
  category: string;
  reason: string;
  details: string;
  urgency: string;
  zoeTicketId: string;
}

/**
 * Crea un ticket nativo nella sezione Ticket di Spoki.
 * Endpoint verificato dalla doc Postman: POST /api/1/tickets/.
 * Ritorna un riferimento (id o reference) al ticket creato, oppure throw in caso di errore.
 */
export async function createSpokiTicket(env: Env, input: CreateTicketInput): Promise<string> {
  const headers: Record<string, string> = {
    'X-Spoki-Api-Key': env.SPOKI_API_KEY,
    'Content-Type': 'application/json',
  };
  if (env.SPOKI_PRIVATE_TOKEN) {
    headers['Authorization'] = `Bearer ${env.SPOKI_PRIVATE_TOKEN}`;
  }

  const title = TICKET_TITLE_BY_REASON[input.reason] ?? TICKET_TITLE_BY_REASON.other!;
  const priority = PRIORITY_BY_URGENCY[input.urgency] ?? 'Medium';

  const body = {
    contact_phone: input.phone,
    title,
    status: 'Open',
    priority,
    description: `[${input.category.toUpperCase()}] ${input.details}`,
    reference: input.zoeTicketId,
  };

  const res = await fetch(SPOKI_TICKETS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Spoki ticket create ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  let ref: string = input.zoeTicketId;
  try {
    const data = (await res.json()) as { id?: number | string; reference?: string };
    if (data?.id !== undefined) ref = String(data.id);
    else if (data?.reference) ref = data.reference;
  } catch {
    // Non fatale: se non riusciamo a parsare la response, usiamo il nostro reference.
  }
  logger.info('spoki_ticket_created', { ticket_ref: ref, reason: input.reason, urgency: input.urgency }, input.phone);
  return ref;
}
