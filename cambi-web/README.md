# Cambi PDF — versione web

Versione web (browser) dell'app desktop **ZuikiCambi**. Stesse funzioni:
scegli il profilo, scarichi i cambi in negozio da Rich Returns, selezioni il
negozio (con match automatico), generi il PDF di autorizzazione e prepari il
testo mail per Gmail.

È fatta con [Streamlit](https://streamlit.io). La logica (API, match negozi,
PDF, mail) è la stessa dell'app desktop; cambia solo l'interfaccia.

---

## File

| File | Cosa fa | Rispetto al desktop |
| --- | --- | --- |
| `app.py` | Interfaccia web | **nuovo** (sostituisce `gui.py` + `main.py`) |
| `config.py` | Profili, URL, cache, secrets | adattato per il web |
| `api_richreturns.py` | Chiamate a Rich Returns | invariato |
| `negozi.py` | Lista negozi + match | invariato |
| `pdf_generator.py` | Genera il PDF | invariato |
| `email_helper.py` | Testo mail | invariato |
| `assets/` | Loghi per il PDF | da riempire (vedi `assets/README.md`) |

Non servono più `PySide6`, `shiboken6`, `pyinstaller` (erano per la finestra desktop).

---

## Provare in locale (facoltativo)

```bash
cd cambi-web
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .streamlit/secrets.toml.example .streamlit/secrets.toml   # poi metti i token
streamlit run app.py
```

Si apre da solo su http://localhost:8501.

---

## Mettere online GRATIS con Streamlit Community Cloud

1. **Carica il codice su GitHub** (questa cartella `cambi-web/`).
2. Vai su **https://share.streamlit.io** e accedi con GitHub.
3. **New app** → scegli il repository, il branch e come *Main file path* indica
   `cambi-web/app.py`.
4. **Advanced settings → Secrets**: incolla il contenuto (con i valori veri) di
   `.streamlit/secrets.toml.example` — `app_password`, `zuiki_token`,
   `loveskin_token`, ecc. Restano cifrati sul server, non finiscono su GitHub.
5. **Deploy**. In un paio di minuti ottieni un link tipo
   `https://<nome>.streamlit.app` da condividere col team.

Per aggiornare l'app in futuro basta modificare il codice e fare `git push`:
Streamlit ridistribuisce da solo.

---

## Sicurezza

- I **token** non sono nel codice: stanno nei *secrets* del server.
- L'accesso è protetto da **password** (`app_password` nei secrets). Con password
  vuota l'accesso è libero: mettine sempre una se l'app è pubblica su internet.
- I **loghi** e la lista negozi sono pubblici, nessun dato sensibile nel repo.

---

## Copiare i loghi

Copia `logo_zuiki.png` e `logo_loveskin.png` dalla cartella `assets/`
dell'app desktop dentro `cambi-web/assets/`. Vedi `assets/README.md`.
