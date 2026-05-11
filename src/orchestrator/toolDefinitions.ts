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
      "Cerca prodotti nel catalogo Zuiki. Usalo quando il cliente chiede 'avete X?' o vuole un'info su un articolo. Se il cliente fornisce uno SKU (codice tipo 'Z8401GI', 'B6E211TS'): passalo DIRETTAMENTE come query — il sistema prova automaticamente sku: filter se la ricerca testuale dà 0 risultati. Per ricerche libere: il search è full-text sul TITOLO (es. 'Jeans Push Up', 'Giacca Effetto Pelle'), non sui colori. Strategia: 1) prova categoria + caratteristica chiave, 2) se 0 risultati riprova con solo la categoria. I colori sono varianti, vanno chiesti al cliente sull'articolo trovato.",
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
    name: 'check_store_availability',
    description:
      "Controlla in quali negozi fisici Zuiki e' disponibile un prodotto in una specifica taglia/variante. Usalo quando il cliente chiede 'avete X in negozio?', 'in che negozio trovo X?', 'X e' disponibile a Milano?'. PRIMA chiama get_product_by_handle per ottenere il barcode della variante (taglia) richiesta, POI chiama questo tool con quel barcode. Opzionale: filtra per regione/provincia/citta' per mostrare solo i negozi rilevanti. Ritorna la lista dei negozi con stock > 0 ordinata per quantita' decrescente, con codice, nome, regione, provincia, quantita'. Se il cliente vuole indirizzo/orari/maps di un negozio specifico, usa POI search_stores con il nome del negozio.",
    input_schema: {
      type: 'object',
      properties: {
        barcode: {
          type: 'string',
          description: "Barcode (EAN) della variante del prodotto, ottenuto da get_product_by_handle (campo variants[].barcode). E' specifico per taglia/colore: non confondere con SKU.",
        },
        region: {
          type: 'string',
          description: "Filtra solo i negozi in questa regione (es. 'Lombardia', 'Campania'). Case insensitive, match parziale.",
        },
        province: {
          type: 'string',
          description: "Filtra solo i negozi in questa provincia (es. 'Milano', 'Napoli'). Case insensitive, match parziale.",
        },
        max_results: {
          type: 'number',
          description: 'Massimo numero di negozi da ritornare (default 15). Usalo per limitare la risposta quando non c\'e\' filtro geografico.',
        },
      },
      required: ['barcode'],
    },
  },
  {
    name: 'open_support_ticket',
    description:
      "Apri un ticket di supporto al team umano. Usalo quando (a) il cliente lo chiede, (b) serve un'azione di scrittura su Shopify, (c) problema tecnico, (d) reclamo con toni legali. Ritorna conferma apertura ticket.",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Categoria principale del ticket',
          enum: [
            'ordine',
            'spedizione',
            'reso_rimborso',
            'prodotto',
            'pagamento',
            'reclamo',
            'richiesta_umano',
            'amministrativo',
            'tecnico',
          ],
        },
        reason: {
          type: 'string',
          description: 'Motivo specifico del ticket — scegli il più preciso',
          enum: [
            // ordine
            'ordine_cancellazione',
            'ordine_modifica_indirizzo',
            'ordine_modifica_taglia_colore',
            'ordine_stato_non_aggiornato',
            // spedizione
            'spedizione_pacco_non_consegnato',
            'spedizione_ritardo',
            'spedizione_tracking_bloccato',
            'spedizione_indirizzo_errato',
            // reso_rimborso
            'rimborso_non_ricevuto',
            'richiesta_reso',
            'cambio_taglia_colore',
            // prodotto
            'prodotto_articolo_errato',
            'prodotto_difettoso_danneggiato',
            'prodotto_disponibilita_futura',
            // pagamento
            'pagamento_contestazione_addebito',
            'pagamento_non_riuscito',
            'pagamento_codice_sconto',
            // reclamo
            'reclamo_legale',
            'reclamo_esperienza_negativa',
            'reclamo_social_recensione',
            // richiesta_umano
            'cliente_richiede_operatore',
            // amministrativo
            'richiesta_fattura',
            'richiesta_b2b_collaborazione',
            // tecnico
            'problema_checkout',
            'problema_account',
            // fallback
            'altro',
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
      required: ['category', 'reason', 'details', 'urgency'],
    },
  },
];
