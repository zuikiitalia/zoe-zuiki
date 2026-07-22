from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

DEFAULT_FIXED_CC = "a.giugliano@zuiki.it"


def build_email_body(brand: str) -> str:
    brand = (brand or "").strip() or "Shop Online"
    return f"""Salve,

in allegato trova l'autorizzazione al cambio in negozio relativa alla sua richiesta.

La invitiamo a prenderne visione e a presentarla, insieme alla conferma d'ordine, presso il negozio selezionato entro 7 giorni dalla ricezione della presente comunicazione.

Un saluto da {brand}."""


@dataclass(frozen=True)
class EmailDraftText:
    to: str
    cc: str
    subject: str
    body: str
    attachment_path: Path

    def as_full_text(self) -> str:
        return (
            f"A: {self.to}\n"
            f"CC: {self.cc}\n"
            f"Oggetto: {self.subject}\n"
            f"Allegato: {self.attachment_path}\n\n"
            f"{self.body}"
        )


def merge_cc(*values: str) -> str:
    emails: list[str] = []
    seen: set[str] = set()
    for value in values:
        for part in (value or "").replace(";", ",").split(","):
            email = part.strip()
            if not email:
                continue
            key = email.lower()
            if key not in seen:
                seen.add(key)
                emails.append(email)
    return "; ".join(emails)


def prepara_testo_email(to: str, cc: str, order_number: str, attachment_path: str | Path, brand: str = "Zuiki", fixed_cc: str = DEFAULT_FIXED_CC) -> EmailDraftText:
    attachment = Path(attachment_path)
    subject = f"Autorizzazione al cambio in negozio - Ordine #{order_number}"
    return EmailDraftText(
        to=to,
        cc=merge_cc(cc, fixed_cc),
        subject=subject,
        body=build_email_body(brand),
        attachment_path=attachment,
    )


def salva_testo_email(draft: EmailDraftText) -> Path:
    out_path = draft.attachment_path.with_suffix(".txt")
    out_path.write_text(draft.as_full_text(), encoding="utf-8")
    return out_path
