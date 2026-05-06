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
    name: 'find_similar_product',
    description: `Cerca nel catalogo Zuiki il prodotto visivamente più simile all'immagine inviata dal cliente. Usalo SOLO quando il cliente ha inviato una foto di un capo o accessorio (da social, competitor, o foto personale) e vuole trovare qualcosa di simile da Zuiki. NON usarlo per ricerche testuali: in quel caso usa search_products.

COME IDENTIFICARE IL category_suffix dall'immagine:
Abbigliamento: AB=Abito, AJ=Abito Jeans, BE=Bermuda, BJ=Bermuda Jeans, BO=Body, CA=Camicia, CB=Ciabatta, CD=Cardigan, CJ=Camicia Jeans, CN=Canotta, CP=Cappotto, CS=Casacca, CT=Costume, CV=Coprispalle, FE=Felpa, GB=Giubbino, GI=Giacca, GJ=Giubbino Jeans, GL=Gilet, GN=Gonna Jeans, GO=Gonna, GP=Giacca Ecopelle, GU=Guanti, IN=Infradito, LG=Leggings, MA=Maglia, PA=Pantaloni, PE=Pelliccia, PI=Piumino, PJ=Pantaloni Jeans, PR=Pareo, RE=Reggiseno Costume, RG=Reggiseno, SB=Slip Costume, SC=Sciarpa, SH=Shorts, SJ=Shorts Jeans, SM=Smanicato, SP=Spolverino, SR=Scarpe, TO=Top, TS=T-Shirt, TU=Tuta
Accessori: AN=Anello, BC=Bracciale, BR=Borsa, C=Collana, CI=Cintura, CZ=Calze, FR=Fermacapelli, FS=Fascia, OC=Occhiali, OR=Orecchini, PC=Portachiavi, SE=Set
Se non identificabile con certezza, lascia vuoto per cercare su tutto il catalogo.`,
    input_schema: {
      type: 'object',
      properties: {
        category_suffix: {
          type: 'string',
          description: "Suffisso SKU della categoria rilevata nell'immagine (es. 'CA' per camicia, 'PA' per pantaloni). Lascia vuoto se incerto.",
        },
        visual_description: {
          type: 'string',
          description: "Descrizione dettagliata del capo nell'immagine in italiano: tipo di capo, colori, fantasia/trama, stile, dettagli (es. 'camicia maniche lunghe fantasia floreale azzurra su fondo bianco colletto classico chiusura bottoni'). Più è ricca, migliore è la ricerca. OBBLIGATORIA quando il cliente ha mandato un'immagine.",
        },
        search_keywords: {
          type: 'string',
          description: "1-2 parole chiave semplici per il link di ricerca alternativo su zuiki.it (es. 'camicia floreale', 'pantalone fluido').",
        },
      },
      required: ['visual_description', 'search_keywords'],
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
