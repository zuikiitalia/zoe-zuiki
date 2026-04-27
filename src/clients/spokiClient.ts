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
  order_cancel: "Richiesta cancellazione ordine",
  order_modify: "Richiesta modifica ordine",
  wrong_item: "Articolo errato o difettoso",
  refund_delay: "Ritardo rimborso",
  payment_issue: "Problema pagamento",
  legal_complaint: "Reclamo legale",
  package_not_delivered: "Pacco non consegnato",
  other: "Richiesta supporto",
};

const PRIORITY_BY_URGENCY: Record<string, string> = {
  normal: "Medium",
  high: "High",
};

export interface CreateTicketInput {
  phone: string;
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
    description: input.details,
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
