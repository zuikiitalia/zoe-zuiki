# Onboarding agente — progetto Zoe (assistente WhatsApp di Zuiki)

Questo file è scritto per essere letto da un agente AI (Claude Code) che entra in una sessione di lavoro su questo repo. Se sei un essere umano, ti basta `README.md` + `CONTRIBUTING.md` — questo qui è verboso di proposito perché serve a un agente che non ha contesto.

**Regola d'oro per l'agente**: leggi questo file per intero, conferma con un riepilogo (vedi sezione finale), e attendi istruzioni esplicite dal collaboratore prima di toccare qualunque file. Non aprire PR, non eseguire comandi destructive, non modificare codice finché non te lo dicono.

---

## 1. Cosa è Zoe e perché esiste

Zoe è l'assistente WhatsApp che fa customer service per **Zuiki**, brand italiano di fashion e-commerce (linea donna) con 165 negozi fisici e shop online su zuiki.it. Risponde a domande di clienti su: stato ordine, disponibilità prodotti, resi/cambi, indicazioni sui negozi, problemi ordine. È live in produzione dal 2026-04-24 ed è già stata iterata con feedback reale di clienti.

URL produzione: https://zoe-zuiki.simone-8d7.workers.dev

## 2. Repo

- GitHub: `github.com/simnun/zoe-zuiki` (privato)
- Collaboratori: `simnun` (Simone Nunziata, founder Zuiki, project owner) e `aldoinnamorato` (Aldo, dev). Stessi diritti, entrambi possono mergiare PR.
- Branch principale: `main`
- Convention: branch per feature → PR → merge → auto-deploy via GitHub Actions

## 3. Stack tecnico

- **Runtime**: Cloudflare Workers, TypeScript strict
- **HTTP framework**: Hono
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`), modello `claude-sonnet-4-6`, con prompt caching ephemeral e tool use multimodale (testo + immagini base64)
- **E-commerce**: Shopify Admin GraphQL API 2025-01, scope read-only su orders/products
- **WhatsApp gateway**: Spoki (`https://api.spoki.com/api/1/`)
- **Storage**: Cloudflare KV namespace `ZOE_KV` (conversation history, Shopify access token, rate-limit counters, OAuth state)
- **Testing**: vitest, 14 unit test che mockano tutte le API esterne
- **CI/CD**: GitHub Actions (auto-deploy on merge to main), token Cloudflare in GitHub Secrets

## 4. Architettura del flusso

1. Cliente manda messaggio WhatsApp → Spoki manda webhook v2 al Worker (`POST /webhook/spoki?secret=...`)
2. Handler verifica HMAC, estrae testo + URL immagini, controlla allowlist e rate limit
3. Carica conversation history da KV
4. `processMessage` costruisce: system prompt cached + history + nuovo messaggio (con prefisso `[Sistema — ora attuale: ...]` e immagini scaricate in base64)
5. Chiama Claude con 5 tool disponibili. Loop tool max 5 iter (`MAX_TOOL_ITERATIONS`)
6. Risposta finale: split su `\n\n` in max 2 messaggi distinti per simulare conversazione naturale, send via Spoki, save in KV
7. Marker anti-loop `[NO_REPLY]`: se Claude lo emette, non si manda nulla (anti-spam su off-topic ripetuti)

## 5. Mappa file

```
src/
  index.ts                      # entrypoint Hono, route registration
  config.ts                     # Env interface, costanti (CLAUDE_MODEL, MAX_HISTORY_MESSAGES, RATE_LIMIT, ...)
  handlers/
    spokiWebhook.ts             # webhook Spoki v2 (extract, allowlist, rate-limit, save)
    shopifyInstall.ts           # OAuth Shopify install redirect
    shopifyCallback.ts          # OAuth callback con HMAC verify
  orchestrator/
    claudeOrchestrator.ts       # processMessage, tool loop, image base64, [NO_REPLY], time injection
    toolDefinitions.ts          # i 5 tool per Claude
  clients/
    shopifyClient.ts            # GraphQL Shopify; pickup detection; STATUS tag parsing; cross-ref con catalogo negozi
    spokiClient.ts              # sendSpokiMessage, createSpokiTicket
  storage/
    kvStore.ts                  # conversation, token, OAuth state, rate limit
  prompts/
    systemPrompt.ts             # ~3.5k token in italiano, regole tono + policy + scenari
  data/
    stores.ts                   # catalogo statico dei 165 negozi (auto-generato dal Google Sheet interno)
  utils/
    logger.ts                   # logger strutturato JSON (mascheramento phone last-4)
    security.ts                 # verify HMAC Shopify, verify webhook secret Spoki
tests/
  smoke.test.ts                 # 14 unit test (vitest)
.github/workflows/
  deploy.yml                    # CI/CD: vitest + tsc + wrangler deploy on push main
wrangler.toml                   # config Worker (account_id, KV id, NESSUN segreto in chiaro)
CONTRIBUTING.md                 # workflow team (per umani)
README.md                       # overview
PROGETTO.md                     # spec originale (riferimento storico)
ONBOARDING.md                   # questo file
```

## 6. Stato attuale (al 2026-05-04)

- **Worker live**: versione v958b6d48 in produzione
- **PR #1 aperta** (branch `setup-auto-deploy`): aggiunge GitHub Actions per auto-deploy. Da mergiare per attivare deploy condiviso. Token Cloudflare già in GitHub Secrets.
- **Verifica live pendente**: il fix recente di pickup detection (ordine con metafield "Pavia Corso Cavour" che veniva trattato come consegna a casa) va testato live dopo che PR #1 è mergiata e il deploy nuovo è online.
- **Aldo onboarding in corso**: configurazione team appena completata. Tutti i segreti vivono nei sistemi corretti, nessuno deve avere `.dev.vars` con valori reali sul Mac quando si lavora via claude.ai/code.

## 7. Convenzioni NON DEROGABILI

### Git
- **Mai push diretto su `main`**. Sempre branch + PR + merge. Il sandbox blocca i tentativi.
- **Mai `git push --force`** su branch condivisi.
- **Mai skip pre-commit hooks** (`--no-verify`).
- **Mai aggiungere `Co-Authored-By: Claude...`** nei commit message — il sandbox blocca queste attribuzioni come "fabricated content".
- Commit message: italiano, prima riga concisa (sotto 70 char), paragrafo successivo opzionale che spiega il **perché**, non solo il cosa.
- Una PR per task. Niente PR-monstre con 10 cose mescolate.

### Sicurezza
- **Mai committare** segreti, token, API key, `.dev.vars`, `.env`, file di credenziali.
- **Mai mettere segreti in `wrangler.toml`**. I segreti del Worker vivono solo come Cloudflare Worker secrets (`wrangler secret put`).
- **Se vedi una stringa che sembra un token** in un diff o in un file da committare, fermati e segnalalo prima di procedere.
- L'unico segreto in GitHub Secrets è `CLOUDFLARE_API_TOKEN`, usato dalle Actions.

### Code style
- TypeScript strict mode, evitare `any` salvo casi giustificati e commentati.
- **Logger strutturato**: mai `console.log` diretto. Sempre `logger.info/warn/error(event_name, details, phone?)` da `src/utils/logger.ts`. Il phone è loggato come last-4 only (privacy).
- **Niente nuove dipendenze npm** senza giustificazione esplicita: il bundle è leggero, manteniamolo così.
- **Test obbligatori** per nuova logica di business in `tests/smoke.test.ts`. Mock di tutte le API esterne (`vi.stubGlobal('fetch', ...)`).
- I 14 test devono restare verdi. Aggiungerne sì, romperne no.

### Deploy
- Auto-deploy via GitHub Actions al merge su `main` (attivo dopo merge PR #1). Gate: `vitest run` + `tsc --noEmit` PRIMA di `wrangler deploy`. Se rompi i gate, il deploy non parte.
- Niente `wrangler deploy` manuale come prassi (audit trail). Solo emergenze.

## 8. Conoscenze di dominio non ovvie dal codice

### Spoki (verificato live, NON quello dei doc generici online)
- Endpoint send: `POST https://api.spoki.com/api/1/messages/send/`, body `{type: "Message", content_type: "Text", phone, text}`
- Endpoint ticket: `POST https://api.spoki.com/api/1/tickets/`
- Webhook payload v2 reale: `{event: "message.inbound", data: {from_phone, to_phone, text, content_type, direction, mediamessage_set: [...]}}`
- **Le URL immagini Spoki sono firmate con `?key=...`** e i server Anthropic NON riescono a fetcharle. Il Worker le scarica nel container, converte in base64 (max 4.5MB), e le passa a Claude come blocco `image` inline. **Non tentare di passare URL direttamente a Claude.**

### Shopify
- Numeri ordine formato `#NNNNNN`. La query GraphQL `query: "name:NNNNNN email:..."` filtra per **prefisso**, non match esatto: nel codice c'è doppia verifica sull'email per evitare match falsi.
- **Detection pickup vs home**: si cerca un metafield la cui `key` contiene "pickup" (case-insensitive, regex `/pickup/i`). Se esiste con valore non vuoto → `delivery_method = "pickup"`. Il namespace varia (`custom`, `app--xxx`, ...). C'è logging diagnostico `shopify_order_metafields_seen` per debug.
- **Cross-reference negozio**: per pickup, si fa matching per token overlap del label/raw del metafield contro `ZUIKI_STORES` (catalogo locale). Risultato in `pickup_store_match`. Bonus per match esatto sulla città.
- **Stato ordine**: dai tag formato `STATUS:NAME:DD/MM/YYYY:HHMM`, ordinati cronologicamente. Questi PREVALGONO sul `displayFulfillmentStatus` di Shopify (che è spesso impreciso).
- **Per pickup**, il tag `SHIPPED` significa "in transito verso il negozio", NON spedito al cliente. Confondere i due è un bug visto in produzione (vedi PR di pickup detection).
- **Tracking**: presente solo per home delivery. Per pickup è sempre `[]`.

### Orchestratore Claude
- System prompt ~3.5k token statico → passato come blocco `{type: 'text', text: SYSTEM_PROMPT, cache_control: {type: 'ephemeral'}}` per beneficiare del cache 5-min (~90% sconto sui token di prompt sui follow-up).
- **Time awareness**: prima del messaggio utente si inietta `[Sistema — ora attuale (Italia): <weekday DD month YYYY HH:MM>]` formattato in `Europe/Rome`. Claude lo usa per ragionare su "stasera", "domani", "fra 2 ore", orari negozi.
- **Marker anti-loop `[NO_REPLY]`**: il prompt istruisce Claude a emetterlo dopo 2 rifiuti consecutivi su tema fuori-ambito (es. provocazioni, off-topic insistenti). Quando arriva, il Worker non manda nulla ma salva un placeholder in history per mantenere il pattern alternato user/assistant.
- **Lingua e tono**: italiano, conversazionale, max 1-2 emoji per messaggio (☺️ nel saluto iniziale ammesso). NO trattini lunghi (—), NO link markdown, NO bullet list nelle risposte. Risposte fluide, brevi, max 2 messaggi separati da `\n\n`.

### Limiti noti (probabili PR future)
- Ricerca prodotti Shopify è full-text sul `title`: query come "jeans neri" spesso ritornano 0 perché il colore è una variant. Il prompt insegna a cercare per categoria + fallback URL `zuiki.it/search?q=...`.
- Inventario per taglia/colore richiede `get_product_by_handle`, non `search_products`.
- Niente check inventario per negozio fisico (richiederebbe Shopify Locations API).

## 9. Convenzioni operative

- **Lingua**: italiano per chat, commit, PR description, codice di business. I commenti tecnici nel codice possono essere in italiano.
- **Telemetria**: ogni evento significativo va loggato con `logger.{info,warn,error}('event_name', {key: value}, phone)`. Eventi standard già esistenti: `webhook_received`, `claude_api_call`, `tool_call`, `rate_limited`, `no_reply_triggered`, `shopify_order_metafields_seen`, ecc.
- **Privacy**: `logger` maschera il numero di telefono mostrando solo last-4 digit. Mai loggare full phone, full name, full email del cliente nei dettagli.

## 10. Cosa fare ora (prima azione obbligatoria)

**Non fare nessuna modifica.** Il tuo primo task è confermare di aver assorbito il briefing. Rispondi al collaboratore con:

1. **Riepilogo (max 8 righe)** di cosa hai capito del progetto e dello stato attuale.
2. **3 cose** del briefing che ti sembrano più rilevanti.
3. **Prima azione logica** che vedresti sensata fare (per orientarti — non implementarla ancora).
4. **Eventuali contraddizioni** che noti tra il briefing e quello che leggi nei file (puoi scorrere i file per controllare, ma niente edit).

Poi attendi istruzioni esplicite dal collaboratore (Simone `simnun` o Aldo `aldoinnamorato`) prima di toccare qualunque file.
