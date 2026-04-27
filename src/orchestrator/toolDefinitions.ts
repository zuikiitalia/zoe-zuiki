import type Anthropic from '@anthropic-ai/sdk';

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'get_order_by_number_and_email',
    description:
      "Recupera i dettagli di un ordine Shopify verificando che numero d'ordine ed email corrispondano. USARE SEMPRE QUESTO per verificare un ordine, mai solo il numero. Se i dati non corrispondono, ritorna error: 'not_found' e Zoe deve dire al cliente 'Non riesco a trovare nessun ordine con questi dati'.",
    input_schema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description:
            "Numero ordine visibile al cliente (es. '259134' o '#259134'). Rimuovi il # se presente.",
        },
        email: {
          type: 'string',
          description: 'Email del cliente come digitata (case insensitive).',
        },
      },
      required: ['order_number', 'email'],
    },
  },
  {
    name: 'search_products',
    description:
      "Cerca prodotti nel catalogo Zuiki. Usalo quando il cliente chiede 'avete X?' o vuole un'info su un articolo. NOTA: il search di Shopify è full-text sul TITOLO del prodotto, non sui colori delle varianti. I titoli sono in genere generici (es. 'Jeans Push Up', 'Giacca Effetto Pelle') senza il colore. Per max risultati: 1) prima prova con la categoria + caratteristica chiave (es. 'jeans push up' invece di 'jeans nero'), 2) se 0 risultati, riprova con SOLO la categoria (es. 'jeans'). I colori specifici sono varianti, vanno chiesti al cliente sull'articolo trovato.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Termine di ricerca. Preferisci la categoria o lo stile (es. 'jeans', 'giacca pelle', 'top manica corta'). Evita di mettere il colore che spesso non è nel titolo.",
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product_by_handle',
    description:
      'Recupera i dettagli completi di un prodotto specifico, inclusi varianti (taglie) e disponibilità.',
    input_schema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: "Handle del prodotto (ultima parte dell'URL su zuiki.it)",
        },
      },
      required: ['handle'],
    },
  },
  {
    name: 'search_stores',
    description:
      "Cerca i negozi fisici Zuiki per città, regione, o nome. Usalo quando il cliente chiede 'avete un negozio a X?', 'dov'è il negozio più vicino a X?', 'quanti negozi a Napoli?'. Ritorna fino a 15 negozi con nome, indirizzo, città, telefono, orari. Zuiki ha 165 negozi in Italia su 18 regioni. NON inventare negozi: se il tool non trova nulla, dì al cliente di controllare lo store locator ufficiale.",
    input_schema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: "Città o comune esatto (es. 'Napoli', 'Roma'). Case insensitive, match parziale.",
        },
        region: {
          type: 'string',
          description: "Regione italiana (es. 'Campania', 'Lazio'). Case insensitive.",
        },
        query: {
          type: 'string',
          description: "Ricerca libera su nome del negozio o indirizzo (es. 'Via Toledo', 'C.C. Campania', 'Vulcano Buono'). Usalo se la richiesta non è per città/regione ma per un centro commerciale o una via specifica.",
        },
      },
    },
  },
  {
    name: 'open_support_ticket',
    description:
      "Apri un ticket di supporto al team umano. Usalo quando (a) il cliente lo chiede, (b) serve un'azione di scrittura su Shopify, (c) problema tecnico, (d) reclamo con toni legali. Ritorna conferma apertura ticket.",
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Motivo del ticket',
          enum: [
            'order_cancel',
            'order_modify',
            'wrong_item',
            'refund_delay',
            'payment_issue',
            'legal_complaint',
            'package_not_delivered',
            'other',
          ],
        },
        details: {
          type: 'string',
          description:
            'Dettagli aggiuntivi utili al team (ordine, problema specifico, ecc.)',
        },
        urgency: {
          type: 'string',
          enum: ['normal', 'high'],
          description:
            'high solo per: reclami legali, articoli errati, pacchi non consegnati, contestazioni pagamento',
        },
      },
      required: ['reason', 'details', 'urgency'],
    },
  },
];
