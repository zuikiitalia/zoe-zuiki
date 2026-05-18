#!/usr/bin/env python3
"""
investigate.py — tracing Zoe conversations by phone number.

Usage:
  INVESTIGATE_KEY=xxx python scripts/investigate.py 3334443334
  INVESTIGATE_KEY=xxx python scripts/investigate.py +393332603864
  INVESTIGATE_KEY=xxx python scripts/investigate.py 3334443334 --last 5

The INVESTIGATE_KEY secret matches the INVESTIGATE_KEY Worker env var set via:
  wrangler secret put INVESTIGATE_KEY

Options:
  --last N    Show only the last N conversations (default: 3)
  --all       Show all conversations (up to 20)
"""

import sys
import os
import hashlib
import json
import urllib.request
import urllib.error
import argparse
from datetime import datetime, timezone

WORKER_URL = "https://zoe-zuiki.simone-8d7.workers.dev"

TOOL_ICONS = {
    "search_products": "🔍",
    "get_product_by_handle": "📦",
    "check_availability": "🏬",
    "check_store_availability": "🏪",
    "find_similar_product": "✨",
    "get_order_by_name_and_email": "🧾",
    "create_ticket": "🎫",
    "get_return_by_rma": "↩️",
    "search_stores": "🗺️",
    "get_store_details": "📍",
}


def normalize_phone(p: str) -> str:
    return "".join(c for c in p if c.isdigit())


def fmt_ts(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%H:%M:%S")


def fmt_ts_full(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def fetch_investigate(key: str, phone: str, limit: int) -> dict:
    normalized = normalize_phone(phone)
    url = f"{WORKER_URL}/api/investigate?phone={normalized}&limit={limit}"
    req = urllib.request.Request(
        url,
        headers={"x-investigate-key": key},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        if e.code == 401:
            raise RuntimeError("INVESTIGATE_KEY non valida o non configurata nel Worker.")
        if e.code == 503:
            raise RuntimeError("DB non configurato nel Worker (ZOE_DB binding mancante).")
        raise RuntimeError(f"HTTP {e.code}: {err_body}")


def wrap_text(text: str, indent: str, max_width: int = 100) -> str:
    lines = text.split("\n")
    result = []
    for line in lines:
        if len(indent) + len(line) <= max_width:
            result.append(indent + line)
        else:
            words = line.split(" ")
            current = indent
            for word in words:
                if len(current) + len(word) + 1 > max_width and current.strip():
                    result.append(current.rstrip())
                    current = indent + word + " "
                else:
                    current += word + " "
            if current.strip():
                result.append(current.rstrip())
    return "\n".join(result)


def print_conversation(conv: dict) -> None:
    first_ts = conv["first_ts"]
    last_ts = conv["last_ts"]

    print(f"\n{'━' * 70}")
    print(f"  CONVERSAZIONE  {fmt_ts_full(first_ts)}")
    print(f"{'━' * 70}")
    print(f"  ID:        {conv['id']}")
    print(f"  Fine:      {fmt_ts_full(last_ts)}")
    print(f"  Turni:     {conv.get('user_turns', 0)} utente, {conv.get('assistant_turns', 0)} Zoe")
    cost = conv.get("total_cost_usd")
    if cost:
        inp = conv.get("total_input_tokens", 0)
        out = conv.get("total_output_tokens", 0)
        cache = conv.get("total_cache_read_tokens", 0)
        print(f"  Costo:     ${cost:.4f}  (in={inp} out={out} cache={cache} token)")
    if conv.get("ticket_id"):
        print(
            f"  Ticket:    {conv['ticket_id']}  "
            f"cat={conv.get('ticket_category')} | {conv.get('ticket_reason')} | "
            f"urgency={conv.get('ticket_urgency')}"
        )
    sentiment = conv.get("sentiment")
    if sentiment and sentiment != "unknown":
        note = f'  "{conv["sentiment_note"]}"' if conv.get("sentiment_note") else ""
        print(f"  Sentiment: {sentiment}{note}")
    print()

    # Merge timeline by timestamp
    timeline = []
    for m in conv.get("messages", []):
        timeline.append({"ts": m["ts"], "type": "msg", "role": m["role"], "content": m["content"]})
    for t in conv.get("tool_calls", []):
        timeline.append({"ts": t["ts"], "type": "tool", "tool_name": t["tool_name"], "success": bool(t["success"])})
    for a in conv.get("api_calls", []):
        timeline.append({"ts": a["ts"], "type": "api", **a})
    timeline.sort(key=lambda x: x["ts"])

    for event in timeline:
        ts_str = fmt_ts(event["ts"])
        if event["type"] == "msg":
            icon = "👤" if event["role"] == "user" else "🤖"
            content = event["content"]
            if len(content) > 1500:
                content = content[:1500] + f"\n… [+{len(content) - 1500} chars]"
            print(wrap_text(content, f"  [{ts_str}] {icon}  "))
            print()
        elif event["type"] == "tool":
            icon = TOOL_ICONS.get(event["tool_name"], "🔧")
            status = "✓" if event["success"] else "✗"
            print(f"  [{ts_str}]    {icon} {status} {event['tool_name']}")
        elif event["type"] == "api":
            it = event.get("iteration", "?")
            inp = event.get("input_tokens", 0)
            out = event.get("output_tokens", 0)
            cache = event.get("cache_read_tokens", 0)
            lat = event.get("latency_ms", 0)
            stop = event.get("stop_reason", "?")
            cost_usd = event.get("cost_usd") or 0
            print(
                f"  [{ts_str}]    🧠 iter={it}  in={inp} out={out} cache={cache}"
                f"  {lat}ms  stop={stop}  ${cost_usd:.4f}"
            )

    print()


def main():
    parser = argparse.ArgumentParser(description="Indaga conversazione Zoe per numero di telefono")
    parser.add_argument("phone", help="Numero di telefono (qualsiasi formato)")
    parser.add_argument("--last", type=int, default=3, metavar="N", help="Ultime N conversazioni (default: 3)")
    parser.add_argument("--all", action="store_true", help="Tutte le conversazioni (max 20)")
    args = parser.parse_args()

    key = os.environ.get("INVESTIGATE_KEY")
    if not key:
        print("Error: INVESTIGATE_KEY non impostata")
        print("Esporta prima: export INVESTIGATE_KEY=<chiave>")
        sys.exit(1)

    limit = 20 if args.all else args.last
    normalized = normalize_phone(args.phone)

    print(f"\nZoe Log Investigation")
    print(f"Phone:  {normalized}")
    print(f"Worker: {WORKER_URL}")

    try:
        data = fetch_investigate(key, args.phone, limit)
    except RuntimeError as e:
        print(f"\nErrore: {e}")
        sys.exit(1)

    ph = data.get("phone_hash", "")
    convs = data.get("conversations", [])
    print(f"Hash:   {ph}")

    if not convs:
        print(f"\nNessuna conversazione trovata per questo numero.")
        print(f"Possibili motivi:")
        print(f"  • Il numero non ha mai scritto a Zoe")
        print(f"  • Prova variante con/senza prefisso 39 (es. 3332603864 oppure 393332603864)")
        sys.exit(0)

    print(f"\nTrovate {len(convs)} conversazione/i.\n")

    for conv in reversed(convs):  # oldest first
        print_conversation(conv)


if __name__ == "__main__":
    main()
