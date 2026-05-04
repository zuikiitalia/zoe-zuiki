# Come lavorare a Zoe — guida per il team

Questo repo è la **fonte unica** del codice di Zoe. Tutto si fa da terminale via Claude Code CLI; il sync con i colleghi passa da git.

## Setup iniziale (una volta sola, sul tuo Mac)

1. **Installa i prerequisiti** (se non ce li hai):
   ```bash
   # Node 20+ (consigliato via nvm o brew)
   brew install node

   # GitHub CLI (per autenticarti su GitHub)
   brew install gh

   # Claude Code CLI
   npm install -g @anthropic-ai/claude-code
   ```

2. **Autentica gh con il tuo account GitHub**:
   ```bash
   gh auth login
   ```

3. **Clona il repo**:
   ```bash
   gh repo clone simnun/zoe-zuiki
   cd zoe-zuiki
   ```

4. **Installa le dipendenze**:
   ```bash
   npm install
   ```

5. **Crea il file `.dev.vars`** in radice (NON va su git, è già in `.gitignore`).
   Le credenziali vere te le passa Simone via canale sicuro:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   SHOPIFY_CLIENT_ID=...
   SHOPIFY_CLIENT_SECRET=...
   SHOPIFY_SHOP_DOMAIN=zuiki-italia.myshopify.com
   SPOKI_API_KEY=...
   WEBHOOK_SECRET=...
   TEAM_EMAIL=shoponline@zuiki.it
   WHATSAPP_NUMBER=+390230550379
   ALLOWLIST_PHONES=+39...,+39...
   ```

6. **Verifica che tutto giri**:
   ```bash
   npx vitest run         # tutti i test devono passare
   npx tsc --noEmit       # niente errori TypeScript
   ```

## Workflow quotidiano (ogni volta che ti metti al lavoro)

```bash
cd ~/path/to/zoe-zuiki

# 1) PRIMA di iniziare, prendi sempre l'ultima versione
git pull

# 2) Crea un branch per il tuo lavoro (così non vi pestate i piedi)
git checkout -b nome-feature        # es. "fix-pickup-detection"

# 3) Avvia Claude Code e lavora
claude

# 4) Quando hai finito (o a fine giornata), salva e condividi:
git add .
git commit -m "Cosa hai fatto, breve"
git push -u origin nome-feature

# 5) Apri una pull request — la persona che NON ha scritto il codice la revisiona
gh pr create --fill

# 6) Dopo che è merged in main, l'altra persona pulla:
git checkout main
git pull
```

## Regola d'oro per non litigare con git

- **Sempre `git pull` prima di iniziare a lavorare.** Se salti questo passo finisci con conflitti scemi.
- **Un branch per task.** Mai lavorare direttamente su `main`.
- **Commit piccoli e frequenti** > commit giganti a fine giornata.
- **Se vedi un conflitto e non sai cosa fare**, fermati e chiedi nell'altro chat — non fare `git push --force`.

## Deploy in produzione (Cloudflare)

**Il deploy è automatico**: ogni merge su `main` fa partire un workflow GitHub Actions che esegue test + typecheck + `wrangler deploy`. Non serve fare nulla a mano. Sia Simone che Aldo hanno gli stessi diritti: chi merga la PR fa partire il deploy.

Cosa controllare dopo aver mergiato:
1. Vai su https://github.com/simnun/zoe-zuiki/actions e verifica che il run "Deploy to Cloudflare" sia verde.
2. Se è rosso: clicca sul run, guarda quale step ha fallito. Tipicamente test rotti o type error.
3. Worker live: https://zoe-zuiki.simone-8d7.workers.dev/health → deve rispondere `{"status":"ok"}`.

### Redeploy manuale (senza nuovo commit)
Se serve riapplicare il deploy senza pushare codice nuovo (raro, es. dopo aver cambiato un secret in Cloudflare):

```bash
gh workflow run "Deploy to Cloudflare" -R simnun/zoe-zuiki
```

### Deploy locale dal terminale (eccezionale)
Da evitare come metodo standard — sporcate l'audit trail. Solo per emergenze. Serve `CLOUDFLARE_API_TOKEN` (chiedere a Simone tramite canale sicuro, non email).

## Cosa NON committare mai

- `.dev.vars` — credenziali locali
- File `*.env` di qualunque tipo
- Token o API key in chiaro nel codice
- Cartella `node_modules/`, `.wrangler/`

Tutto già coperto da `.gitignore`. Se vedete dubbi, chiedete prima.
