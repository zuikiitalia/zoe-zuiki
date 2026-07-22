"""Cambi PDF — versione web (Streamlit).

Replica il flusso dell'app desktop:
  profilo → tabella cambi → dettaglio + negozio (match automatico + ricerca)
  → Genera PDF (scaricabile) → Testo mail (da copiare in Gmail).

La logica (API Rich Returns, match negozi, generazione PDF, testo mail) è
riusata identica dai moduli originali: api_richreturns, negozi, pdf_generator,
email_helper.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import pandas as pd
import streamlit as st

import config
from api_richreturns import CambioInNegozio, RichReturnsClient, RichReturnsError
from email_helper import prepara_testo_email
from negozi import (
    Negozio, combo_store_label, load_negozi, match_negozio,
    store_info_label, store_location_label,
)
from pdf_generator import build_pdf_data, genera_pdf, safe_filename

st.set_page_config(page_title="Cambi PDF", page_icon="🔁", layout="wide")


# --------------------------------------------------------------------------
# Accesso con password (una sola password condivisa per il team)
# --------------------------------------------------------------------------
def check_password() -> bool:
    if not config.APP_PASSWORD:
        return True  # nessuna password configurata: accesso libero
    if st.session_state.get("auth_ok"):
        return True

    st.title("🔁 Cambi PDF")
    st.caption("Area riservata — inserisci la password del team.")
    with st.form("login"):
        pwd = st.text_input("Password", type="password")
        submitted = st.form_submit_button("Entra")
    if submitted:
        if pwd == config.APP_PASSWORD:
            st.session_state.auth_ok = True
            st.rerun()
        else:
            st.error("Password errata.")
    return False


if not check_password():
    st.stop()


# --------------------------------------------------------------------------
# Profilo attivo
# --------------------------------------------------------------------------
def build_active_profile() -> dict:
    profiles = config.get_profiles()
    labels = {p["id"]: p["name"] for p in profiles}
    ids = [p["id"] for p in profiles]

    with st.sidebar:
        st.header("Impostazioni")
        active_id = st.selectbox(
            "Profilo",
            options=ids,
            format_func=lambda pid: labels.get(pid, pid),
            key="active_profile_id",
        )
        profile = dict(next(p for p in profiles if p["id"] == active_id))

        # Token: dai secrets se presente, altrimenti chiedilo (per sessione).
        token_from_secret = bool(profile.get("token"))
        if token_from_secret:
            st.success("Token API configurato ✔", icon="🔑")
            with st.expander("Usa un altro token (solo per questa sessione)"):
                override = st.text_input(
                    "Token Rich Returns", type="password", key=f"tok_{active_id}"
                )
                if override.strip():
                    profile["token"] = override.strip()
        else:
            profile["token"] = st.text_input(
                "Token Rich Returns", type="password", key=f"tok_{active_id}",
                help="Il token del profilo. Puoi salvarlo nei secrets del server per non doverlo reinserire.",
            ).strip()

    config.set_runtime_profile(profile)
    return profile


profile = build_active_profile()


# --------------------------------------------------------------------------
# Caricamento dati (cambi + negozi)
# --------------------------------------------------------------------------
def do_load(profile: dict, refresh_negozi: bool) -> None:
    with st.spinner(f"Caricamento dati {profile.get('name', '')}…"):
        negozi = load_negozi(refresh=refresh_negozi, profile=profile)
        client = RichReturnsClient(str(profile.get("token") or ""))
        cambi = client.get_cambi_in_negozio(limit=100, status="Pending")
    st.session_state.cambi = cambi
    st.session_state.negozi = negozi
    st.session_state.loaded_profile_id = profile["id"]


with st.sidebar:
    st.divider()
    col_a, col_b = st.columns(2)
    reload_cambi = col_a.button("🔄 Aggiorna cambi", use_container_width=True)
    reload_stores = col_b.button("🏬 Aggiorna negozi", use_container_width=True)
    if st.session_state.get("auth_ok") or not config.APP_PASSWORD:
        if st.button("Esci", use_container_width=True):
            st.session_state.clear()
            st.rerun()

if not str(profile.get("token") or "").strip():
    st.title("🔁 Cambi PDF")
    st.info("Inserisci il **token Rich Returns** nella barra laterale a sinistra per iniziare.", icon="👈")
    st.stop()

# Auto-load al primo accesso o al cambio profilo; ricarica su richiesta.
need_autoload = (
    "cambi" not in st.session_state
    or st.session_state.get("loaded_profile_id") != profile["id"]
)
try:
    if reload_stores:
        do_load(profile, refresh_negozi=True)
    elif reload_cambi or need_autoload:
        do_load(profile, refresh_negozi=False)
except (RichReturnsError, Exception) as exc:  # noqa: BLE001 — mostriamo qualunque errore all'utente
    st.error(f"Errore durante il caricamento: {exc}")
    st.stop()

cambi: list[CambioInNegozio] = st.session_state.get("cambi", [])
negozi: list[Negozio] = st.session_state.get("negozi", [])


# --------------------------------------------------------------------------
# Intestazione + ricerca + tabella cambi
# --------------------------------------------------------------------------
st.title("🔁 Cambi PDF")
st.caption(
    f"Profilo **{profile.get('name')}** · {len(cambi)} cambi in negozio · {len(negozi)} negozi caricati"
)

query = st.text_input("🔎 Cerca ordine, cliente, RMA o negozio", key="order_search").strip().lower()


def matches(cambio: CambioInNegozio, q: str) -> bool:
    if not q:
        return True
    haystack = " ".join([
        cambio.order_number, cambio.rma, cambio.cliente_nome,
        cambio.customer_email, cambio.negozio_grezzo,
    ]).lower()
    return q in haystack


filtered = [c for c in cambi if matches(c, query)]

if not filtered:
    st.warning("Nessun cambio corrisponde alla ricerca." if query else "Nessun cambio in negozio da elaborare.")
    st.stop()

table_rows = []
for c in filtered:
    totale_pezzi = sum(int(a.quantita or 1) for a in c.articoli)
    table_rows.append({
        "Data": c.created_at_display,
        "Ordine": f"#{c.order_number}",
        "RMA": c.rma,
        "Cliente": c.cliente_nome,
        "Negozio richiesto": c.negozio_grezzo or "—",
        "Pezzi": totale_pezzi,
    })
df = pd.DataFrame(table_rows)

st.markdown("#### Cambi in negozio")
event = st.dataframe(
    df,
    use_container_width=True,
    hide_index=True,
    on_select="rerun",
    selection_mode="single-row",
    key="cambi_table",
    column_config={"Pezzi": st.column_config.NumberColumn(width="small")},
)

selected_rows = event.selection.rows if event and event.selection else []
if not selected_rows:
    st.info("Seleziona una riga dalla tabella per vedere il dettaglio e generare il PDF.", icon="👆")
    st.stop()

cambio = filtered[selected_rows[0]]


# --------------------------------------------------------------------------
# Dettaglio cambio + selezione negozio
# --------------------------------------------------------------------------
left, right = st.columns([1, 1])

with left:
    st.markdown("#### Dettaglio cambio")
    st.markdown(f"**Ordine:** #{cambio.order_number}")
    st.markdown(f"**RMA:** {cambio.rma}")
    st.markdown(f"**Cliente:** {cambio.cliente_nome}")
    st.markdown(f"**Email cliente:** {cambio.customer_email}")
    st.markdown(f"**Negozio scritto dal cliente:** {cambio.negozio_grezzo or 'Non trovato'}")

    st.markdown("**Articoli autorizzati al cambio:**")
    art_rows = [{
        "Descrizione": a.nome,
        "SKU": a.sku,
        "Variante": a.variante,
        "Prezzo": f"{a.prezzo:.2f} €",
        "Qtà": a.quantita,
        "Motivo": a.motivo,
    } for a in cambio.articoli]
    st.dataframe(pd.DataFrame(art_rows), use_container_width=True, hide_index=True)

with right:
    st.markdown("#### Negozio selezionato")

    # Match automatico sul negozio scritto dal cliente.
    best, score = match_negozio(cambio.negozio_grezzo, negozi)
    if best is not None:
        st.success(f"Match automatico: **{best.display_name}** ({score * 100:.0f}%)", icon="✅")
        default_index = negozi.index(best)
    else:
        st.warning("Nessun match affidabile: cerca e seleziona il negozio manualmente.", icon="⚠️")
        default_index = 0

    store_key = f"store_choice_{cambio.rma}"
    chosen_idx = st.selectbox(
        "Negozio (scrivi per cercare: codice, nome, città, via…)",
        options=list(range(len(negozi))),
        format_func=lambda i: combo_store_label(negozi[i]),
        index=default_index,
        key=store_key,
    )
    negozio = negozi[chosen_idx]

    st.markdown(f"**Codice negozio:** {(negozio.codice or '-').strip().upper()}")
    st.markdown(f"**Località:** {store_location_label(negozio)}")
    st.markdown(f"**Info:** {store_info_label(negozio)}")


# --------------------------------------------------------------------------
# Azioni: Genera PDF + Testo mail
# --------------------------------------------------------------------------
st.divider()
c1, c2 = st.columns(2)
gen_pdf = c1.button("📄 Genera PDF", type="primary", use_container_width=True)
gen_mail = c2.button("✉️ Testo mail", use_container_width=True)

if gen_pdf:
    try:
        with st.spinner("Genero il PDF…"):
            data = build_pdf_data(cambio, negozio, profile)
            out_name = safe_filename(
                f"Autorizzazione_Cambio_Ordine_{cambio.order_number}_{cambio.rma}.pdf"
            )
            out_path = Path(tempfile.mkdtemp()) / out_name
            genera_pdf(data, out_path, config.get_profile_logo_path(profile))
            st.session_state.pdf_bytes = out_path.read_bytes()
            st.session_state.pdf_name = out_name
            st.session_state.pdf_for = cambio.rma
    except Exception as exc:  # noqa: BLE001
        st.error(f"Errore nella generazione del PDF: {exc}")

if st.session_state.get("pdf_for") == cambio.rma and st.session_state.get("pdf_bytes"):
    st.download_button(
        "⬇️ Scarica il PDF",
        data=st.session_state.pdf_bytes,
        file_name=st.session_state.pdf_name,
        mime="application/pdf",
        use_container_width=True,
    )

if gen_mail:
    draft = prepara_testo_email(
        to=cambio.customer_email,
        cc=negozio.email if negozio else "",
        order_number=cambio.order_number,
        attachment_path=st.session_state.get("pdf_name", "Autorizzazione_Cambio.pdf"),
        brand=str(profile.get("brand") or profile.get("name") or ""),
        fixed_cc=str(profile.get("fixed_cc") or ""),
    )
    st.markdown("#### Testo mail per Gmail")
    mc1, mc2 = st.columns(2)
    mc1.text_input("A", value=draft.to, key="mail_to")
    mc2.text_input("CC", value=draft.cc, key="mail_cc")
    st.text_input("Oggetto", value=draft.subject, key="mail_subject")
    st.text_area("Corpo mail", value=draft.body, height=220, key="mail_body")
    st.caption("Ricordati di allegare il PDF scaricato prima di inviare la mail.")
