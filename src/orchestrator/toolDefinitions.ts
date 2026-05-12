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
      "Cerca prodotti nel catalogo Zuiki per TITOLO/SKU. Usalo quando il cliente chiede un articolo per nome o SKU. ATTENZIONE: il search è full-text sul TITOLO Shopify (es. 'Jeans Push Up'), NON cerca per colore (i colori sono varianti, non titoli). REGOLE: (1) Se cliente cita uno SKU come 'Z8401GI', 'B6E211TS': passalo direttamente — il sistema usa il filtro sku: in fallback. (2) Per ricerche per COLORE/STILE (es. 't-shirt rossa', 'gonna lunga blu', 'felpa beige'): NON usare search_products con il colore (filtra solo per titolo e dà spesso 0 risultati o risultati irrilevanti). Usa invece find_similar_product passando visual_description='t-shirt rossa' (il sistema fa una ricerca semantica CLIP che capisce il colore visivamente). (3) Per ricerche generiche per categoria ('giacca', 'jeans'): usa pure search_products. (4) Il campo inventory può essere null o 0 senza significare 'esaurito' — è solo che il tracking inventario non è abilitato. Non dichiarare mai 'esaurito' basandoti solo su questo campo.",
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
    description: `Cerca nel catalogo Zuiki il prodotto più simile via ricerca semantica visiva (FashionCLIP). Funziona sia con FOTO inviate dal cliente, sia con DESCRIZIONI TESTUALI quando il cliente specifica colore/stile/dettagli (es. "t-shirt rossa", "gonna lunga blu navy", "felpa beige oversize"). Usalo OBBLIGATORIAMENTE in questi casi:
- Cliente ha mandato una foto di un capo e chiede "ce l'avete?".
- Cliente chiede a parole un capo descrivendo il COLORE (es. "t-shirt rossa", "vestito nero") — search_products fallirebbe perché il colore non è nel titolo, mentre CLIP capisce il colore semanticamente.
- Cliente chiede uno STILE specifico ("oversize", "fluido", "effetto pelle") che potrebbe non essere nel titolo.

NON usarlo per ricerche per nome esplicito di articolo o SKU: in quel caso usa search_products.

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
          description: "Descrizione dettagliata del capo in italiano: tipo, colori, fantasia/trama, stile, dettagli (es. 'camicia maniche lunghe fantasia floreale azzurra colletto classico'). Per ricerche da foto: descrivi quello che vedi. Per ricerche testuali (cliente che chiede a parole un colore/stile): riformula la richiesta come descrizione visiva ricca (es. cliente dice 't-shirt rossa' → visual_description: 't-shirt rossa manica corta donna'). Più dettagli = migliore match.",
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
      "Controlla in quali negozi fisici Zuiki e' disponibile un prodotto in una specifica taglia/variante. Usalo quando il cliente chiede 'avete X in negozio?', 'in che negozio trovo X?', 'X e' disponibile a Milano?', 'c'e' al Vulcano Buono?'. PRIMA chiama get_product_by_handle per ottenere il barcode della variante (taglia) richiesta, POI chiama questo tool con quel barcode. FILTRI (usa quello piu' specifico in base alla richiesta): store_name per un negozio specifico (es. 'Vulcano Buono'), province per una citta'/zona ('Napoli', 'Milano'), region per una regione. Senza filtri ritorna i top 15 per quantita' (potrebbe NON includere il negozio che cerchi se ha poca scorta). Ritorna sempre total_units_nationwide e requested_store_found (true/false se hai usato store_name).",
    input_schema: {
      type: 'object',
      properties: {
        barcode: {
          type: 'string',
          description: "Barcode (EAN) della variante del prodotto, ottenuto da get_product_by_handle (campo variants[].barcode). E' specifico per taglia/colore: non confondere con SKU.",
        },
        store_name: {
          type: 'string',
          description: "Nome (anche parziale o approssimativo) del negozio richiesto dal cliente. Il sistema fa fuzzy match sui 146 negozi Zuiki Siacloud: tollera typo (es. 'Franciacorte' → 'Franciacorta Outlet Village'), nomi parziali (es. 'Borromea' → 'Galleria Borromea Shopping Center'), e abbreviazioni. Passa quello che ha scritto il cliente, tale e quale. RISPOSTE POSSIBILI: (a) match unico → resolved_store contiene il negozio canonico e stores_with_stock dice se ha scorta; (b) ambiguo → la risposta contiene ambiguous_store_name:true e candidates: lista di negozi da far scegliere al cliente; (c) typo grosso non riconosciuto → error: 'store_name_not_recognized'.",
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
