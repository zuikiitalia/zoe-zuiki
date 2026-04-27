# Zoe — Assistente WhatsApp Zuiki

Backend serverless su Cloudflare Workers che fa da ponte tra Spoki (WhatsApp Business API) e Anthropic Claude, con integrazione Shopify per leggere ordini, prodotti e clienti dello store Zuiki.

La specifica completa del progetto è in `PROGETTO.md`. Questo README serve a **manutenere** il progetto dopo la prima messa in produzione.

---

## Architettura in 30 secondi

```
Cliente WhatsApp
      │
      ▼
Spoki ──(webhook)──▶ Cloudflare Worker (questo repo)
                     │
                     ├─▶ Anthropic API (Claude Sonnet 4.6 + tool use)
                     ├─▶ Shopify Admin GraphQL (read-only)
                     └─▶ Spoki API (invio risposta)
```

- **Entry point:** `src/index.ts` (router Hono).
- **Cuore:** `src/orchestrator/claudeOrchestrator.ts` — chiama Claude, esegue i tool, restituisce le risposte da inviare a WhatsApp.
- **System prompt:** `src/prompts/systemPrompt.ts` — identità, tono, regole di formato, scenari di risposta.
- **Persistenza:** Cloudflare KV (`ZOE_KV` binding) per cronologia conversazioni, token Shopify, OAuth state, rate limit.

---

## Setup iniziale (già fatto una volta, per memoria)

```bash
npm install
wrangler login
wrangler kv namespace create ZOE_KV
# copiare l'id restituito in wrangler.toml
```

Secrets da configurare (una alla volta, così non passano dalla chat):

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SHOPIFY_CLIENT_ID
wrangler secret put SHOPIFY_CLIENT_SECRET
wrangler secret put SHOPIFY_SHOP_DOMAIN        # es. zuiki-italia.myshopify.com
wrangler secret put SPOKI_API_KEY
wrangler secret put SPOKI_PRIVATE_TOKEN        # opzionale, solo se Spoki lo richiede
wrangler secret put WEBHOOK_SECRET             # 32 char random, valida i webhook Spoki
wrangler secret put TEAM_EMAIL                 # es. shoponline@zuiki.it
wrangler secret put WHATSAPP_NUMBER            # es. +390230550379
```

Per visualizzare le secret già configurate: `wrangler secret list`.

---

## Sviluppo locale

```bash
npm run dev          # wrangler dev (hot reload su http://localhost:8787)
npm run test         # smoke test con vitest
npm run typecheck    # verifica TypeScript senza emettere output
```

Con `wrangler dev` puoi colpire gli endpoint:

```bash
curl http://localhost:8787/health
curl -X POST "http://localhost:8787/webhook/spoki?secret=$WEBHOOK_SECRET" \
     -H 'content-type: application/json' \
     -d '{"event":"message_received","contact":{"phone":"+393331234567"},"message":{"type":"text","text":"ciao"}}'
```

In locale il Worker usa un KV simulato: le conversazioni non persistono tra riavvii.

---

## Operazioni più frequenti

### 1. Aggiornare il system prompt di Zoe

Modifica `src/prompts/systemPrompt.ts`. Il prompt è una singola costante `SYSTEM_PROMPT`.

Dopo la modifica:

```bash
npm run typecheck
npm run test
npm run deploy
```

Il nuovo prompt è attivo dal deploy successivo. Le conversazioni già in KV non vengono toccate — il system prompt è passato a ogni chiamata Claude, non salvato con la history.

### 2. Aggiungere un nuovo tool

Due file da toccare:

1. **`src/orchestrator/toolDefinitions.ts`** — aggiungi un oggetto all'array `TOOL_DEFINITIONS` con `name`, `description`, `input_schema`. La `description` è ciò che Claude legge per decidere se usare il tool: scrivila chiaramente.

2. **`src/orchestrator/claudeOrchestrator.ts`** — aggiungi un `case` nella funzione `executeTool` che matcha il nome del tool, chiama la logica, ritorna un JSON serializzato (anche in caso di errore).

Se il tool parla con Shopify, mettilo in `src/clients/shopifyClient.ts` (che gestisce già auth token e API version). Se è un servizio nuovo, crea un nuovo file sotto `src/clients/`.

Dopo l'aggiunta:

```bash
npm run test
npm run deploy
```

### 3. Vedere i log in tempo reale

```bash
npm run tail
# oppure: wrangler tail --format pretty
```

I log sono JSON strutturato. Eventi utili da grep:

- `webhook_received` — messaggio in entrata.
- `claude_api_call` — ogni chiamata a Claude, con token e latenza.
- `tool_call` — tool invocato da Claude.
- `tool_execution_failed` — tool Shopify o altro in errore.
- `ticket_opened` — ticket creato dal modello per escalation umana.
- `message_sent` — risposta inviata a Spoki.
- `rate_limited` — numero che ha sforato 30 msg/ora.
- `shopify_callback_bad_hmac` / `shopify_installed` — eventi OAuth.

Per filtrare un numero specifico: `wrangler tail | grep "phone_last4.*1234"`.

### 4. Re-deploy

```bash
npm run deploy
```

Wrangler fa diff delle secret e del KV binding automaticamente. Il Worker è sostituito in atomico — nessun downtime.

Per rollback al deploy precedente:

```bash
wrangler deployments list
wrangler rollback <deployment-id>
```

### 5. Re-installare l'app Shopify

Serve se il token in KV è stato cancellato o se si cambia store domain.

```bash
# cancellare il token attuale
wrangler kv key delete --binding=ZOE_KV "shopify:access_token"
# riaprire l'install nel browser
open https://zoe-zuiki.<subdomain>.workers.dev/shopify/install
```

### 6. Pulire la cronologia di un cliente

```bash
wrangler kv key delete --binding=ZOE_KV "conversation:+393331234567"
```

---

## Struttura del progetto

```
src/
├── index.ts                        # router Hono (4 endpoint)
├── config.ts                       # Env type + costanti
├── prompts/systemPrompt.ts         # system prompt di Zoe
├── handlers/
│   ├── spokiWebhook.ts             # POST /webhook/spoki (waitUntil async)
│   ├── shopifyInstall.ts           # GET  /shopify/install
│   └── shopifyCallback.ts          # GET  /shopify/callback
├── orchestrator/
│   ├── claudeOrchestrator.ts       # loop Claude + tool use (max 5 iter)
│   └── toolDefinitions.ts          # schema dei tool esposti a Claude
├── clients/
│   ├── shopifyClient.ts            # GraphQL Admin API (API version 2025-01)
│   └── spokiClient.ts              # POST messaggio su Spoki
├── storage/kvStore.ts              # wrapper KV: conversation, token, rate limit
└── utils/
    ├── logger.ts                   # log JSON + mascheramento telefono
    └── security.ts                 # HMAC Shopify, verify webhook secret
tests/
└── smoke.test.ts                   # vitest
```

---

## Endpoint del Worker

| Metodo | Path                  | Scopo                                             |
| ------ | --------------------- | ------------------------------------------------- |
| GET    | `/health`             | Health check. Ritorna `{ status: "ok" }`.         |
| POST   | `/webhook/spoki`      | Webhook Spoki per i messaggi in entrata.          |
| GET    | `/shopify/install`    | Avvia il flusso OAuth Shopify.                    |
| GET    | `/shopify/callback`   | Riceve il code OAuth, salva il token in KV.       |

---

## Scelte e assunzioni da verificare al primo test reale

Alcune cose sono state implementate con ipotesi sensate perché la documentazione non era del tutto chiara. Al primo test reale controlla:

1. **Formato webhook Spoki.** Il codice accetta un payload nella forma `{ event, contact: { phone }, message: { type, text } }`, ma è flessibile su campi alternativi (`from`, `body`, ecc.). Al primo webhook ricevuto, il Worker logga il payload intero con evento `webhook_payload_raw`: guardalo e, se la struttura è diversa, adatta `extractInbound()` in `src/handlers/spokiWebhook.ts`.

2. **Endpoint invio Spoki.** È settato su `https://app.spoki.it/api/messages/send` in `src/clients/spokiClient.ts`. Se Spoki risponde 404 o 401, verifica la URL esatta e il formato body nella loro doc Postman e aggiorna lì.

3. **Header autenticazione Spoki.** Di default usa `X-Spoki-Api-Key`. Se anche `SPOKI_PRIVATE_TOKEN` è settata come secret, il client aggiunge anche `Authorization: Bearer <token>`.

4. **OAuth Shopify offline token.** Il codice non passa `grant_options[]=per-user`, così Shopify ritorna un token permanente (offline). Se per qualche motivo vuoi invece un token online (che scade quando l'utente esce), aggiungi `grant_options[]=per-user` nello URL di `shopifyInstall.ts`.

5. **Ticket di supporto.** Per l'MVP il tool `open_support_ticket` logga solo un record strutturato in Cloudflare (evento `ticket_opened`). Il team può filtrare da `wrangler tail` o esportare i log.

   **Miglioria post-MVP (raccomandata):** Spoki ha una sezione **Ticket** nativa nella propria UI. Integrare la creazione ticket direttamente via API Spoki è molto più pulito di email/log, perché i ticket appaiono nello stesso workflow che il team già usa per chattare. Da fare: cercare l'endpoint ticket nella doc Postman Spoki, aggiungere una funzione `createSpokiTicket(reason, details, urgency, customerPhone)` in `src/clients/spokiClient.ts`, chiamarla dentro `executeTool()` caso `open_support_ticket`. Circa 20 righe di codice.

---

## Troubleshooting

**Zoe non risponde a un messaggio WhatsApp.**
1. `wrangler tail` e cerca `webhook_received` con gli ultimi 4 del numero del mittente.
2. Se manca: il webhook Spoki non è arrivato. Verifica in Spoki che il webhook sia attivo e punti al URL giusto con `?secret=<WEBHOOK_SECRET>`.
3. Se c'è `webhook_unauthorized`: il secret in query string è sbagliato.
4. Se c'è `webhook_ignored`: il payload non è stato riconosciuto come messaggio testuale. Guarda `webhook_payload_raw`.
5. Se c'è `rate_limited`: quel numero ha superato 30 msg/ora. Attendere o alzare il limite in `src/config.ts`.
6. Se c'è `orchestrator_failed`: errore sulla chiamata Anthropic. Verifica `ANTHROPIC_API_KEY`.
7. Se c'è `tool_shopify_not_installed`: manca il token. Re-installare su `/shopify/install`.

**Errori 500 su `/shopify/callback`.**
- `shopify_callback_bad_hmac` → secret Shopify sbagliato nelle env.
- `shopify_callback_bad_state` → OAuth scaduto (TTL 10 min) o già consumato. Ripartire da `/shopify/install`.
- `shopify_callback_shop_mismatch` → `SHOPIFY_SHOP_DOMAIN` nelle secret non corrisponde al parametro `shop` del callback.

**Il typecheck fallisce con tipi `KVNamespace` non trovati.**
- Assicurarsi che `@cloudflare/workers-types` sia installato e presente in `tsconfig.json` sotto `"types"`.

---

## Costi

Ogni messaggio ricevuto consuma:
- 1 invocazione Worker (gratis fino a 100k/giorno sul piano Free, altrimenti $5/10M richieste).
- 1-2 read KV + 1 write KV per conversazione.
- 1+ chiamata Anthropic (costo dominante). Il system prompt è ~3.5k token: abilitare prompt caching Anthropic è un'ottimizzazione importante da fare dopo la validazione MVP (riduce il costo del ~90% sul prompt ripetuto).
- 1 chiamata Shopify GraphQL per ogni tool invocato.

Monitor suggerito: guardare `tokens_in`/`tokens_out` negli eventi `claude_api_call`.

---

## Contatti

Problemi o domande sul backend: repo owner (simone@zuiki.it).
Problemi sul numero WhatsApp o webhook Spoki: amministratore Spoki.
Problemi sull'app Shopify: Shopify Partner Dashboard.
