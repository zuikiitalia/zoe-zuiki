from __future__ import annotations

from pathlib import Path
from typing import Any

import requests
from PIL import Image as PILImage, ImageDraw
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import HRFlowable, Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.platypus.flowables import KeepTogether

from config import get_cache_dir, resource_path, get_active_profile
from negozi import pdf_store_label


def safe_filename(value: str) -> str:
    keep = []
    for ch in value:
        if ch.isalnum() or ch in "-_ .":
            keep.append(ch)
        else:
            keep.append("_")
    return "".join(keep).strip(" ._") or "file"


def create_placeholder(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = PILImage.new("RGB", (300, 380), "white")
    draw = ImageDraw.Draw(img)
    draw.rectangle((10, 10, 290, 370), outline=(180, 180, 180), width=3)
    draw.text((95, 175), "No image", fill=(120, 120, 120))
    img.save(path, "PNG")
    return path


def download_image(url: str, key: str) -> Path:
    cache = get_cache_dir() / "images"
    cache.mkdir(parents=True, exist_ok=True)
    placeholder = cache / "placeholder.png"
    if not placeholder.exists():
        create_placeholder(placeholder)
    if not url:
        return placeholder
    ext = ".jpg"
    lowered = url.lower().split("?")[0]
    if lowered.endswith(".png"):
        ext = ".png"
    elif lowered.endswith(".webp"):
        ext = ".webp"
    out = cache / f"{safe_filename(key)}{ext}"
    if out.exists() and out.stat().st_size > 0:
        return out
    try:
        response = requests.get(url, timeout=20)
        response.raise_for_status()
        out.write_bytes(response.content)
        # Verifica e converte formati non graditi da ReportLab.
        with PILImage.open(out) as img:
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")
            converted = out.with_suffix(".jpg")
            img.thumbnail((900, 1200))
            rgb = img.convert("RGB")
            rgb.save(converted, "JPEG", quality=88)
            return converted
    except Exception:
        return placeholder


def estrai_citta(negozio_stringa: str) -> str:
    if not negozio_stringa:
        return ""
    tokens = negozio_stringa.strip().split()
    if not tokens:
        return ""
    stop_words = {
        "via", "v.", "v.le", "viale", "piazza", "p.za", "p.zza",
        "corso", "c.so", "c.c.", "cc", "centro", "galleria", "outlet",
        "largo", "vicolo", "strada", "sp", "ss", "km",
    }
    citta_tokens: list[str] = []
    for tok in tokens:
        tok_low = tok.lower().rstrip(",.")
        if tok_low in stop_words or tok[0].isdigit():
            break
        citta_tokens.append(tok)
    return " ".join(citta_tokens) if citta_tokens else negozio_stringa


def euro(value: float | int | str) -> str:
    try:
        number = float(value)
        return f"€ {number:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    except Exception:
        return str(value)


def build_pdf_data(cambio: Any, negozio: Any | None, profile: dict[str, Any] | None = None) -> dict[str, Any]:
    profile = profile or get_active_profile()
    brand = str(profile.get("brand") or profile.get("name") or "Zuiki")
    negozio_display = pdf_store_label(negozio, cambio.negozio_grezzo, brand=brand)
    indirizzo = getattr(negozio, "indirizzo", "") or cambio.negozio_grezzo
    articoli = []
    for art in cambio.articoli:
        foto = download_image(art.foto_url, f"{cambio.rma}_{art.line_item_id}")
        articoli.append({
            "descrizione": art.nome,
            "sku": art.sku,
            "colore": art.colore,
            "taglia": art.taglia,
            "prezzo": euro(art.prezzo),
            "prezzo_num": float(art.prezzo or 0),
            "quantita": int(art.quantita or 1),
            "motivo": art.motivo,
            "foto": str(foto),
        })
    totale_pezzi = sum(int(art.get("quantita") or 0) for art in articoli)
    totale_euro = sum(float(art.get("prezzo_num") or 0) * int(art.get("quantita") or 0) for art in articoli)

    return {
        "rma_id": cambio.rma,
        "ordine_numero": cambio.order_number,
        "ordine_data": cambio.order_date_display,
        "richiesta_data": cambio.created_at_display,
        "cliente_nome": cambio.cliente_nome,
        "negozio": cambio.negozio_grezzo,
        "negozio_display": negozio_display,
        "negozio_indirizzo": indirizzo,
        "motivo": articoli[0]["motivo"] if articoli else "",
        "articoli": articoli,
        "totale_pezzi": totale_pezzi,
        "totale_euro": totale_euro,
        "brand": brand,
    }


def genera_pdf(dati: dict[str, Any], output_path: str | Path, logo_path: str | Path | None = None) -> Path:
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    logo = Path(logo_path) if logo_path else resource_path("assets/logo_loveskin.png" if str(dati.get("brand", "")).lower() == "loveskin" else "assets/logo_zuiki.png")
    brand = str(dati.get("brand") or "") or "Shop Online"
    negozio_display = dati.get("negozio_display") or f"{brand} {estrai_citta(dati.get('negozio', ''))}"
    indirizzo = dati.get("negozio_indirizzo") or dati.get("negozio", "")

    doc = SimpleDocTemplate(
        str(output_path), pagesize=A4,
        leftMargin=18*mm, rightMargin=18*mm,
        topMargin=13*mm, bottomMargin=13*mm,
        title=f"Autorizzazione Cambio - Ordine #{dati['ordine_numero']}",
        author=str(dati.get("brand") or ""),
    )

    styles = getSampleStyleSheet()
    style_titolo = ParagraphStyle("Titolo", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=16, alignment=TA_CENTER, spaceAfter=4, textColor=colors.black, leading=20)
    style_sottotitolo = ParagraphStyle("Sub", parent=styles["Normal"], fontName="Helvetica", fontSize=10, alignment=TA_CENTER, textColor=colors.HexColor("#555555"), spaceAfter=12)
    style_label = ParagraphStyle("Label", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=9.5, textColor=colors.black, spaceAfter=3)
    style_valore = ParagraphStyle("Val", parent=styles["Normal"], fontName="Helvetica", fontSize=10.5, textColor=colors.black, spaceAfter=5, leading=13)
    style_sezione = ParagraphStyle("Sez", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, textColor=colors.black, spaceAfter=8, spaceBefore=8, leading=15)
    style_body = ParagraphStyle("Body", parent=styles["Normal"], fontName="Helvetica", fontSize=11.5, textColor=colors.HexColor("#222222"), spaceAfter=8, leading=16, alignment=TA_JUSTIFY)
    style_note = ParagraphStyle("Note", parent=styles["Normal"], fontName="Helvetica-Oblique", fontSize=10, textColor=colors.HexColor("#555555"), spaceAfter=4, leading=13)

    story = []
    if logo.exists():
        logo_img = Image(str(logo), width=50*mm, height=15*mm, kind="proportional")
        logo_img.hAlign = "CENTER"
        story.append(logo_img)
        story.append(Spacer(1, 7*mm))

    story.append(Paragraph("AUTORIZZAZIONE AL CAMBIO IN NEGOZIO", style_titolo))
    story.append(Paragraph(f"Ordine #{dati['ordine_numero']} &nbsp;&nbsp;·&nbsp;&nbsp; {dati['rma_id']}", style_sottotitolo))
    story.append(HRFlowable(width="100%", thickness=0.8, color=colors.black, spaceBefore=2, spaceAfter=10))

    dati_tab = Table([
        [Paragraph("CLIENTE", style_label), Paragraph("NEGOZIO SELEZIONATO", style_label)],
        [Paragraph(dati.get("cliente_nome", ""), style_valore), Paragraph(negozio_display, style_valore)],
        [Spacer(1, 2*mm), Spacer(1, 2*mm)],
        [Paragraph("DATA ORDINE", style_label), Paragraph("DATA RICHIESTA CAMBIO", style_label)],
        [Paragraph(dati.get("ordine_data", ""), style_valore), Paragraph(dati.get("richiesta_data", ""), style_valore)],
    ], colWidths=[86*mm, 86*mm])
    dati_tab.setStyle(TableStyle([
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (0,0), (-1,-1), 0),
        ("RIGHTPADDING", (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 3),
        ("TOPPADDING", (0,0), (-1,-1), 0),
    ]))
    story.append(dati_tab)
    story.append(Spacer(1, 8*mm))

    story.append(Paragraph("ARTICOLI AUTORIZZATI AL CAMBIO", style_sezione))
    header = [Paragraph(x, style_label) for x in ["Foto", "Descrizione", "SKU", "Colore / Taglia", "Motivo", "Prezzo", "Qtà"]]
    rows = [header]
    for art in dati.get("articoli", []):
        foto = Image(art["foto"], width=13*mm, height=17*mm, kind="proportional")
        rows.append([
            foto,
            Paragraph(art.get("descrizione", ""), style_valore),
            Paragraph(art.get("sku", ""), style_valore),
            Paragraph(f"{art.get('colore', '')} / {art.get('taglia', '')}".strip(" /"), style_valore),
            Paragraph(art.get("motivo", ""), style_valore),
            Paragraph(f"<b>{art.get('prezzo', '')}</b>", style_valore),
            Paragraph(str(art.get("quantita", "")), style_valore),
        ])
    tab_art = Table(rows, colWidths=[15*mm, 31*mm, 24*mm, 23*mm, 42*mm, 20*mm, 13*mm], repeatRows=1)
    tab_art.setStyle(TableStyle([
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("ALIGN", (5,0), (6,-1), "CENTER"),
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#F2F2F2")),
        ("LINEBELOW", (0,0), (-1,0), 0.5, colors.HexColor("#999999")),
        ("LINEBELOW", (0,1), (-1,-1), 0.3, colors.HexColor("#DDDDDD")),
        ("LEFTPADDING", (0,0), (-1,-1), 4),
        ("RIGHTPADDING", (0,0), (-1,-1), 4),
        ("TOPPADDING", (0,0), (-1,-1), 4),
        ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ]))
    story.append(tab_art)

    totale_pezzi = int(dati.get("totale_pezzi") or 0)
    totale_euro = float(dati.get("totale_euro") or 0)
    if totale_pezzi >= 2:
        total_table = Table([[
            Paragraph("Totale pezzi autorizzati al cambio", style_label),
            Paragraph(f"{totale_pezzi} pezzi", style_valore),
            Paragraph("Totale valore articoli", style_label),
            Paragraph(f"<b>{euro(totale_euro)}</b>", style_valore),
        ]], colWidths=[55*mm, 30*mm, 48*mm, 35*mm])
        total_table.setStyle(TableStyle([
            ("BACKGROUND", (0,0), (-1,-1), colors.HexColor("#F7F7F7")),
            ("BOX", (0,0), (-1,-1), 0.4, colors.HexColor("#CCCCCC")),
            ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
            ("ALIGN", (1,0), (1,0), "CENTER"),
            ("ALIGN", (3,0), (3,0), "CENTER"),
            ("LEFTPADDING", (0,0), (-1,-1), 6),
            ("RIGHTPADDING", (0,0), (-1,-1), 6),
            ("TOPPADDING", (0,0), (-1,-1), 5),
            ("BOTTOMPADDING", (0,0), (-1,-1), 3),
        ]))
        story.append(Spacer(1, 4*mm))
        story.append(total_table)

    story.append(Spacer(1, 10*mm))

    condizioni = [
        "Per effettuare il cambio in negozio è necessario esibire la <b>conferma d'ordine</b> e la <b>presente autorizzazione</b>. In assenza di tali documenti non sarà possibile procedere.",
        "I capi da rendere devono essere <b>integri e provvisti di cartellino</b>.",
        f"Il cambio potrà essere effettuato esclusivamente presso il <b>negozio selezionato</b> (<b>{negozio_display}</b> — {indirizzo}), entro e non oltre <font color='#CC0000'><b>7 giorni</b></font> dalla ricezione della presente comunicazione.",
        "Non è previsto alcun <b>rimborso</b> né l'emissione di <b>buoni</b> presso il punto vendita.",
    ]
    conditions_flow = [
        HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#CCCCCC"), spaceAfter=7),
        Paragraph("CONDIZIONI PER EFFETTUARE IL CAMBIO", style_sezione),
    ]
    conditions_flow.extend(Paragraph(f"•&nbsp;&nbsp; {c}", style_body) for c in condizioni)
    conditions_flow.append(Spacer(1, 3*mm))
    conditions_flow.append(Paragraph("<b>N.B.</b> Eventuali variazioni di prezzo tra l'acquisto e il cambio dipendono dalla scontistica in vigore al momento del cambio.", style_note))
    story.append(KeepTogether(conditions_flow))
    story.append(Spacer(1, 8*mm))
    story.append(HRFlowable(width="40%", thickness=0.5, color=colors.HexColor("#CCCCCC"), hAlign="CENTER"))

    doc.build(story)
    return output_path
