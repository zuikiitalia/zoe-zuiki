from __future__ import annotations

import csv
import io
import json
import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterable, Any

import requests

from config import STORE_SHEET_CSV_URL, get_cache_dir, get_active_profile


@dataclass
class Negozio:
    nome: str
    indirizzo: str
    citta: str
    telefono: str
    email: str
    codice: str
    display_name: str
    brand: str = "Zuiki"
    provincia: str = ""
    regione: str = ""

    @property
    def full_text(self) -> str:
        return f"{self.display_name} {self.nome} {self.indirizzo} {self.citta} {self.provincia} {self.regione}".strip()


class NegoziError(Exception):
    pass


GENERIC_WORDS = {
    "zuiki", "loveskin", "negozio", "store", "shop", "punto", "vendita", "presso", "quale",
    "desidera", "effettuare", "cambio", "centro", "commerciale", "c", "cc", "c.c",
    "c.c.", "loc", "localita", "località", "via", "viale", "v", "piazza", "corso",
}


def _fix_mojibake(value: str) -> str:
    value = value or ""
    if "Ã" in value or "Â" in value:
        try:
            return value.encode("latin1", errors="ignore").decode("utf-8", errors="ignore")
        except Exception:
            return value
    return value


def _strip_accents(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in value if not unicodedata.combining(ch))


def _norm(value: str) -> str:
    value = _fix_mojibake(value or "")
    value = unicodedata.normalize("NFKC", value).lower().strip()
    value = _strip_accents(value)
    replacements = {
        "c.c.": " centro commerciale ",
        "c. c.": " centro commerciale ",
        "cc ": " centro commerciale ",
        "c/c": " centro commerciale ",
        "c c ": " centro commerciale ",
        "c c": " centro commerciale ",
        "megalò": " megalo ",
        "megalo": " megalo ",
        "galassia": " galassia ",
        "primavera": " primavera ",
        "vulcano": " vulcano ",
    }
    for old, new in replacements.items():
        value = value.replace(old, new)
    value = re.sub(r"[^a-z0-9\s]", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def _tokens(value: str) -> list[str]:
    out: list[str] = []
    for tok in _norm(value).split():
        if len(tok) < 3:
            continue
        if tok in GENERIC_WORDS:
            continue
        out.append(tok)
    return out


def _is_cc_name(nome: str) -> bool:
    n = _norm(nome)
    return any(token in n for token in ["centro commerciale", "outlet", "parco commerciale", "shopping", "galleria", "megalò", "megalo"])


def is_probably_region_or_province(row: list[str]) -> bool:
    first = (row[0] if row else "").strip()
    if not first:
        return True
    has_email = len(row) > 5 and "@" in row[5]
    has_code = len(row) > 6 and row[6].strip()
    return not (has_email or has_code)


def clean_store_name_for_display(nome: str) -> str:
    n = " ".join((nome or "").split())
    n = re.sub(r"(?i)^centro commerciale\s+", "C.C. ", n).strip()
    return n


def build_display_name(nome: str, citta: str, brand: str = "Zuiki") -> str:
    n = clean_store_name_for_display(nome)
    c = (citta or "").strip()
    b = (brand or "Zuiki").strip()
    n_norm = _norm(n)
    # Se il nome include già il brand, non lo raddoppiamo.
    if b and _norm(b) in n_norm.split():
        return n
    if _is_cc_name(nome):
        return f"{b} {n}" if n else f"{b} {c}".strip()
    if c and (_norm(n) == _norm(c) or not n):
        return f"{b} {c}".strip()
    if b.lower() == "loveskin" and n.startswith("LoveSkin"):
        return n
    return f"{b} {n}".strip() if n else f"{b} {c}".strip()


def pdf_store_label(negozio: Negozio | None, fallback: str = "", brand: str = "Zuiki") -> str:
    if negozio:
        return negozio.display_name
    fallback = clean_store_name_for_display(fallback)
    return f"{brand} {fallback}" if fallback else brand


def combo_store_label(negozio: Negozio) -> str:
    codice = (negozio.codice or "").strip().upper()
    if codice:
        return f"{codice} - {negozio.display_name}"
    return negozio.display_name


def store_location_label(negozio: Negozio | None) -> str:
    if not negozio:
        return "-"
    indirizzo = (negozio.indirizzo or "").strip()
    citta = (negozio.citta or "").strip()
    if indirizzo and citta:
        return f"{indirizzo}  -  {citta}"
    return indirizzo or citta or "-"


def store_info_label(negozio: Negozio | None) -> str:
    if not negozio:
        return "-"
    tel = (negozio.telefono or "").strip()
    email = (negozio.email or "").strip()
    if tel and email:
        return f"{tel}  -  {email}"
    return tel or email or "-"


def parse_negozi_csv(text: str, profile_brand: str = "Zuiki") -> list[Negozio]:
    text = (text or "").replace("\x00", "").lstrip("﻿")
    negozi: list[Negozio] = []
    reader = csv.reader(io.StringIO(text))
    for raw_row in reader:
        row = [_fix_mojibake(cell).strip() for cell in raw_row]
        if len(row) < 7 or is_probably_region_or_province(row):
            continue
        nome = row[0]
        indirizzo = row[1] if len(row) > 1 else ""
        citta = row[2] if len(row) > 2 else ""
        telefono = row[3] if len(row) > 3 else ""
        email = row[5] if len(row) > 5 else ""
        codice = row[6] if len(row) > 6 else ""
        if not nome or not email:
            continue
        negozi.append(Negozio(
            nome=nome,
            indirizzo=indirizzo,
            citta=citta,
            telefono=telefono,
            email=email,
            codice=codice,
            display_name=build_display_name(nome, citta, profile_brand),
            brand=profile_brand,
        ))
    return negozi


def _json_code(item: dict[str, Any]) -> str:
    for key in ("code", "codice", "cod", "storeCode", "id"):
        if item.get(key):
            return str(item.get(key)).strip().upper()[:8]
    # Nel JSON LoveSkin non sempre c'è un codice; meglio lasciarlo vuoto che inventarlo.
    return ""


def parse_negozi_json(text: str, profile_brand: str = "LoveSkin") -> list[Negozio]:
    try:
        data = json.loads((text or "").replace("\x00", ""))
    except Exception as exc:
        raise NegoziError(f"JSON negozi non valido: {exc}") from exc
    if isinstance(data, dict):
        for key in ("stores", "negozi", "data", "items"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        raise NegoziError("Il JSON negozi non contiene una lista di store.")

    negozi: list[Negozio] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        brand = str(item.get("brand") or item.get("b") or profile_brand or "").strip() or profile_brand
        nome = _fix_mojibake(str(item.get("n") or item.get("name") or item.get("nome") or "")).strip()
        indirizzo = _fix_mojibake(str(item.get("a") or item.get("address") or item.get("indirizzo") or "")).strip()
        citta = _fix_mojibake(str(item.get("c") or item.get("city") or item.get("localita") or item.get("località") or "")).strip()
        telefono = str(item.get("tel") or item.get("telefono") or item.get("phone") or "").strip()
        email = str(item.get("email") or item.get("mail") or "").strip()
        codice = _json_code(item)
        provincia = _fix_mojibake(str(item.get("p") or item.get("provincia") or "")).strip()
        regione = _fix_mojibake(str(item.get("r") or item.get("regione") or "")).strip()
        if not nome and not citta:
            continue
        negozi.append(Negozio(
            nome=nome,
            indirizzo=indirizzo,
            citta=citta,
            telefono=telefono,
            email=email,
            codice=codice,
            display_name=build_display_name(nome, citta, brand),
            brand=brand,
            provincia=provincia,
            regione=regione,
        ))
    return negozi


def get_cache_path(profile: dict | None = None) -> Path:
    profile = profile or get_active_profile()
    pid = str(profile.get("id") or "default")
    ext = "json" if str(profile.get("stores_type", "csv")).lower() == "json" else "csv"
    return get_cache_dir() / f"negozi_{pid}.{ext}"


def download_store_text(profile: dict, timeout: int = 30) -> str:
    url = str(profile.get("stores_url") or STORE_SHEET_CSV_URL).strip()
    if not url:
        raise NegoziError("URL lista negozi mancante nel profilo.")
    try:
        response = requests.get(url, timeout=timeout, headers={"User-Agent": "CambiPDF/1.0"})
        response.raise_for_status()
        text = response.content.decode("utf-8-sig", errors="replace")
        text = text.replace("\x00", "").lstrip("﻿")
        if "<html" in text[:500].lower():
            raise NegoziError("La lista negozi ha restituito una pagina HTML invece dei dati.")
        get_cache_path(profile).write_text(text, encoding="utf-8")
        return text
    except requests.RequestException as exc:
        raise NegoziError(f"Impossibile scaricare la lista negozi: {exc}") from exc


def parse_store_text(text: str, profile: dict) -> list[Negozio]:
    kind = str(profile.get("stores_type") or "csv").lower()
    brand = str(profile.get("brand") or profile.get("name") or "Zuiki")
    if kind == "json":
        return parse_negozi_json(text, brand)
    return parse_negozi_csv(text, brand)


def load_negozi(use_cache: bool = True, refresh: bool = False, profile: dict | None = None) -> list[Negozio]:
    profile = profile or get_active_profile()
    cache_path = get_cache_path(profile)
    if refresh or not use_cache or not cache_path.exists():
        try:
            negozi = parse_store_text(download_store_text(profile), profile)
            if not negozi:
                raise NegoziError("Lista negozi scaricata ha zero negozi validi.")
            return negozi
        except Exception:
            if cache_path.exists():
                cached = cache_path.read_text(encoding="utf-8", errors="replace")
                negozi = parse_store_text(cached, profile)
                if negozi:
                    return negozi
            raise
    cached = cache_path.read_text(encoding="utf-8", errors="replace")
    negozi = parse_store_text(cached, profile)
    if not negozi:
        cache_path.unlink(missing_ok=True)
        return parse_store_text(download_store_text(profile), profile)
    return negozi


def _score_store(query: str, negozio: Negozio) -> float:
    q_norm = _norm(query)
    q_tokens = _tokens(query)
    if not q_norm or not q_tokens:
        return 0.0

    name_norm = _norm(negozio.nome)
    city_norm = _norm(negozio.citta)
    display_norm = _norm(negozio.display_name)
    address_norm = _norm(negozio.indirizzo)
    province_norm = _norm(negozio.provincia)

    name_tokens = set(_tokens(negozio.nome))
    city_tokens = set(_tokens(negozio.citta))
    display_tokens = set(_tokens(negozio.display_name))
    address_tokens = set(_tokens(negozio.indirizzo))
    province_tokens = set(_tokens(negozio.provincia))
    all_core_tokens = name_tokens | city_tokens | display_tokens | province_tokens

    q_set = set(q_tokens)
    core_hits = len(q_set & all_core_tokens)
    address_hits = len(q_set & address_tokens)
    core_ratio = core_hits / max(1, len(q_set))

    seq = max(
        SequenceMatcher(None, q_norm, name_norm).ratio(),
        SequenceMatcher(None, q_norm, city_norm).ratio(),
        SequenceMatcher(None, q_norm, province_norm).ratio(),
        SequenceMatcher(None, q_norm, display_norm).ratio(),
        SequenceMatcher(None, q_norm, f"{name_norm} {city_norm}").ratio(),
        SequenceMatcher(None, q_norm, f"{display_norm} {city_norm}").ratio(),
    )

    score = 0.62 * core_ratio + 0.38 * seq
    if (q_set & name_tokens) and (q_set & city_tokens):
        score += 0.28
    if q_set & name_tokens:
        score += 0.16
    if q_set & city_tokens:
        score += 0.10
    if q_set and q_set.issubset(all_core_tokens):
        score += 0.22
    if core_hits == 0 and address_hits > 0:
        score = min(score, 0.42)
    elif address_hits > 0:
        score += min(0.06, address_hits * 0.02)
    if ("centro commerciale" in q_norm or " cc " in f" {q_norm} ") and not _is_cc_name(negozio.nome):
        score -= 0.12
    return max(0.0, min(score, 0.99))


def match_negozio(query: str, negozi: Iterable[Negozio]) -> tuple[Negozio | None, float]:
    q = _norm(query)
    if not q:
        return None, 0.0
    ranked: list[tuple[float, Negozio]] = []
    for negozio in negozi:
        ranked.append((_score_store(query, negozio), negozio))
    ranked.sort(key=lambda x: x[0], reverse=True)
    if not ranked:
        return None, 0.0
    best_score, best = ranked[0]
    second_score = ranked[1][0] if len(ranked) > 1 else 0.0
    if best_score < 0.68:
        return None, best_score
    if best_score - second_score < 0.07 and best_score < 0.86:
        return None, best_score
    return best, best_score
