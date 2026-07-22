from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
import unicodedata


import requests

from config import RICH_RETURNS_BASE_URL


class RichReturnsError(Exception):
    pass


@dataclass
class ArticoloCambio:
    nome: str
    sku: str
    variante: str
    colore: str
    taglia: str
    prezzo: float
    quantita: int
    motivo: str
    nota: str
    foto_url: str
    line_item_id: str


@dataclass
class CambioInNegozio:
    rma: str
    status: str
    created_at: str
    updated_at: str
    order_number: str
    order_date: str
    customer_email: str
    customer_first_name: str
    customer_last_name: str
    customer_mobile: str
    negozio_grezzo: str
    articoli: list[ArticoloCambio] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def cliente_nome(self) -> str:
        return f"{self.customer_first_name} {self.customer_last_name}".strip()

    @property
    def created_at_display(self) -> str:
        return format_datetime_it(self.created_at)

    @property
    def order_date_display(self) -> str:
        return format_datetime_it(self.order_date)


def format_datetime_it(value: str | None) -> str:
    if not value:
        return ""
    try:
        normalized = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        return dt.strftime("%d/%m/%Y")
    except Exception:
        return value[:10]


def split_variant(variant_name: str | None) -> tuple[str, str]:
    if not variant_name:
        return "", ""
    parts = [p.strip() for p in str(variant_name).split("/")]
    if len(parts) >= 2:
        return parts[0], " / ".join(parts[1:])
    return variant_name.strip(), ""


def normalize_key(value: Any) -> str:
    """Normalizza testi con emoji/stili Unicode usati da Rich Returns."""
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.lower()
    text = " ".join(text.replace("\n", " ").split())
    return text


def clean_store_value(value: Any) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value)).strip()
    if not text or text in {"-", "✅", "true", "false"}:
        return ""
    return " ".join(text.split())


def answer_to_value(answer: Any) -> str:
    """Estrae il valore da formati diversi dell'API Rich Returns."""
    if isinstance(answer, dict):
        for key in ("value", "answer", "text", "note"):
            value = clean_store_value(answer.get(key))
            if value:
                return value
    return clean_store_value(answer)


def looks_like_store_question(question: Any) -> bool:
    q = normalize_key(question)
    # La domanda vista a pannello e in API contiene sempre 'negozio';
    # teniamo anche sinonimi nel caso Rich Returns cambi label.
    return (
        "negozio" in q
        or "punto vendita" in q
        or "store" in q
        or "shop" in q
        or ("cambio" in q and "dove" in q)
    )


def recursive_find_store(obj: Any) -> str:
    """Cerca il negozio anche se Rich Returns sposta le additional questions."""
    if isinstance(obj, dict):
        # Caso classico: {"Domanda negozio": {"type": "note", "value": "..."}}
        for key, value in obj.items():
            if looks_like_store_question(key):
                found = answer_to_value(value)
                if found:
                    return found
            # Caso alternativo: {"question": "...negozio...", "value": "..."}
            if normalize_key(key) in {"question", "label", "title", "name"} and looks_like_store_question(value):
                for value_key in ("value", "answer", "text", "note"):
                    found = answer_to_value(obj.get(value_key))
                    if found:
                        return found
        for value in obj.values():
            found = recursive_find_store(value)
            if found:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = recursive_find_store(value)
            if found:
                return found
    return ""


def extract_store_text(return_obj: dict[str, Any], products: list[dict[str, Any]]) -> str:
    """Trova il negozio indicato dal cliente nelle additional questions.

    Nei dati reali il campo può comparire dentro Products[n].returnItemExtraNote,
    ma in alcuni pending Rich Returns lo espone con chiavi/strutture leggermente diverse.
    Per questo la ricerca è volutamente più robusta e normalizza i testi Unicode.
    """
    # Prima cerchiamo nei prodotti, perché lì abbiamo già visto la domanda negozio.
    for product in products:
        found = recursive_find_store(product.get("returnItemExtraNote") or {})
        if found:
            return found

    # Poi cerchiamo comunque dentro tutto l'oggetto return, per compatibilità.
    found = recursive_find_store(return_obj)
    if found:
        return found

    return ""


def parse_cambi_in_negozio(payload: dict[str, Any]) -> list[CambioInNegozio]:
    output: list[CambioInNegozio] = []
    returns = payload.get("returns") or []

    for item in returns:
        products = item.get("Products") or []
        cambio_products = [
            p for p in products
            if str(p.get("returnItemResolution", "")).strip() == "refundToCustom1"
        ]
        if not cambio_products:
            continue

        negozio_grezzo = extract_store_text(item, cambio_products) or extract_store_text(item, products)
        articoli: list[ArticoloCambio] = []
        for p in cambio_products:
            colore, taglia = split_variant(p.get("variantName"))
            try:
                prezzo = float(p.get("lineItemPrice") or 0)
            except Exception:
                prezzo = 0.0
            try:
                quantita = int(p.get("returnItemQuantity") or 1)
            except Exception:
                quantita = 1
            articoli.append(ArticoloCambio(
                nome=str(p.get("productName") or ""),
                sku=str(p.get("variantSku") or ""),
                variante=str(p.get("variantName") or ""),
                colore=colore,
                taglia=taglia,
                prezzo=prezzo,
                quantita=quantita,
                motivo=str(p.get("returnItemReason") or ""),
                nota=str(p.get("returnItemNote") or ""),
                foto_url=str(p.get("productImageUrl") or ""),
                line_item_id=str(p.get("lineItemId") or ""),
            ))

        output.append(CambioInNegozio(
            rma=str(item.get("rma") or ""),
            status=str(item.get("status") or ""),
            created_at=str(item.get("createdAt") or ""),
            updated_at=str(item.get("updatedAt") or ""),
            order_number=str(item.get("orderNumber") or ""),
            order_date=str(item.get("orderDate") or ""),
            customer_email=str(item.get("customerEmail") or ""),
            customer_first_name=str(item.get("customerFirstName") or ""),
            customer_last_name=str(item.get("customerLastName") or ""),
            customer_mobile=str(item.get("customerMobile") or ""),
            negozio_grezzo=negozio_grezzo,
            articoli=articoli,
            raw=item,
        ))
    return output


class RichReturnsClient:
    def __init__(self, token: str, timeout: int = 30) -> None:
        self.token = token.strip()
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        if not self.token:
            raise RichReturnsError("Token API Rich Returns mancante. Apri Impostazioni e inseriscilo.")
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def list_returns(self, status: str = "Pending", limit: int = 100, order: str = "DESC") -> dict[str, Any]:
        params = {"status": status, "limit": limit, "order": order}
        try:
            response = requests.get(
                RICH_RETURNS_BASE_URL,
                params=params,
                headers=self._headers(),
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise RichReturnsError(f"Errore di rete Rich Returns: {exc}") from exc

        if response.status_code == 401:
            raise RichReturnsError("Token non valido o non autorizzato. Verifica il token API.")
        if response.status_code >= 400:
            raise RichReturnsError(f"Errore API Rich Returns {response.status_code}: {response.text[:500]}")
        try:
            return response.json()
        except ValueError as exc:
            raise RichReturnsError("Risposta API non valida: non è JSON.") from exc

    def get_cambi_in_negozio(self, limit: int = 100, status: str = "Pending") -> list[CambioInNegozio]:
        return parse_cambi_in_negozio(self.list_returns(status=status, limit=limit))
