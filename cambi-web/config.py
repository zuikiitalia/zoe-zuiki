"""Configurazione per la versione web (Streamlit) di Cambi PDF.

Differenze rispetto alla versione desktop:
- Nessun file di config salvato sul computer dell'utente: i profili di default
  (Zuiki / LoveSkin) sono definiti qui e i token arrivano dai "secrets" del
  server (o vengono inseriti al volo nell'interfaccia).
- La cache (lista negozi, immagini) va in una cartella temporanea scrivibile,
  non nella home dell'utente.
- Il profilo attivo non viene persistito su disco: lo gestisce l'app in memoria
  tramite set_runtime_profile() a ogni richiesta.
"""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

APP_NAME = "Cambi PDF"
RICH_RETURNS_BASE_URL = "https://api.richcommerce.co/v1/returns"
STORE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1Vesq-nOWLezawpf1hfgCsDPCAkVonQ7WApW_29hTi0I/export?format=csv"
LOVESKIN_STORES_JSON_URL = "https://cdn.shopify.com/s/files/1/0672/8453/3322/files/stores_4.json?v=1776950443"

BASE_DIR = Path(__file__).resolve().parent


def _secret(key: str, default: str = "") -> str:
    """Legge un valore dai secrets di Streamlit, se disponibili.

    Non solleva eccezioni se il file secrets non esiste (es. avvio in locale
    senza configurazione): in quel caso ritorna il default.
    """
    try:
        import streamlit as st  # import locale: config.py resta usabile anche senza Streamlit
        return str(st.secrets.get(key, default))
    except Exception:
        return default


# Password unica del team per accedere all'app. Vuota = nessuna password.
APP_PASSWORD = _secret("app_password", "")


def resource_path(relative_path: str) -> Path:
    """Percorso di una risorsa (es. assets/logo_zuiki.png) dentro il progetto."""
    return BASE_DIR / relative_path


def get_cache_dir() -> Path:
    path = Path(tempfile.gettempdir()) / "zuiki_cambi_cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def default_profiles() -> list[dict[str, Any]]:
    return [
        {
            "id": "zuiki",
            "name": "Zuiki",
            "brand": "Zuiki",
            "token": _secret("zuiki_token", ""),
            "stores_type": "csv",
            "stores_url": STORE_SHEET_CSV_URL,
            "logo": "assets/logo_zuiki.png",
            "fixed_cc": _secret("zuiki_fixed_cc", "a.giugliano@zuiki.it"),
        },
        {
            "id": "loveskin",
            "name": "LoveSkin",
            "brand": "LoveSkin",
            "token": _secret("loveskin_token", ""),
            "stores_type": "json",
            "stores_url": LOVESKIN_STORES_JSON_URL,
            "logo": "assets/logo_loveskin.png",
            "fixed_cc": _secret("loveskin_fixed_cc", ""),
        },
    ]


def get_profiles() -> list[dict[str, Any]]:
    return default_profiles()


# --- Profilo attivo (in memoria, per la durata della richiesta) ------------
_ACTIVE_PROFILE: dict[str, Any] | None = None


def set_runtime_profile(profile: dict[str, Any]) -> None:
    global _ACTIVE_PROFILE
    _ACTIVE_PROFILE = dict(profile)


def get_active_profile() -> dict[str, Any]:
    return _ACTIVE_PROFILE or default_profiles()[0]


def get_profile_logo_path(profile: dict[str, Any] | None = None) -> Path:
    profile = profile or get_active_profile()
    logo = str(profile.get("logo") or "assets/logo_zuiki.png")
    return resource_path(logo)
