"""Build slim members.json from unitedstates/congress-legislators current data."""
from __future__ import annotations

import json
import urllib.request
from datetime import date
from pathlib import Path

SOURCE_URL = "https://unitedstates.github.io/congress-legislators/legislators-current.json"
PROJ = Path(__file__).resolve().parent


def normalize_space(value: str) -> str:
    return " ".join(value.split())


def build_aliases(name: dict) -> list[str]:
    official = normalize_space((name.get("official_full") or "").strip())
    first = (name.get("first") or "").strip()
    last = (name.get("last") or "").strip()
    middle = (name.get("middle") or "").strip()
    nickname = (name.get("nickname") or "").strip()
    candidates = [
        official,
        normalize_space(f"{first} {last}"),
        normalize_space(f"{last}, {first}"),
        normalize_space(f"{first} {middle} {last}") if middle else "",
        normalize_space(f"{nickname} {last}") if nickname else "",
        last,
    ]
    aliases: list[str] = []
    for item in candidates:
        if item and item not in aliases:
            aliases.append(item)
    return aliases


def main() -> None:
    raw_path = PROJ / "legislators-current.json"
    if not raw_path.exists():
        print(f"Downloading {SOURCE_URL}")
        with urllib.request.urlopen(SOURCE_URL, timeout=120) as resp:
            raw_path.write_bytes(resp.read())

    data = json.loads(raw_path.read_text(encoding="utf-8"))
    members = []
    missing_url = 0
    for entry in data:
        name = entry.get("name") or {}
        terms = entry.get("terms") or []
        if not terms:
            continue
        term = terms[-1]
        website = (term.get("url") or "").strip()
        contact_form = (term.get("contact_form") or "").strip()
        contact_url = contact_form or website
        if not contact_url:
            missing_url += 1
            continue
        official = normalize_space((name.get("official_full") or "").strip())
        first = (name.get("first") or "").strip()
        last = (name.get("last") or "").strip()
        members.append(
            {
                "name": official or normalize_space(f"{first} {last}"),
                "aliases": build_aliases(name),
                "chamber": "Senate" if term.get("type") == "sen" else "House",
                "state": term.get("state"),
                "party": term.get("party"),
                "bioguide": (entry.get("id") or {}).get("bioguide"),
                "contactUrl": contact_url,
                "websiteUrl": website or None,
                "contactFormUrl": contact_form or None,
            }
        )

    payload = {
        "source": "unitedstates/congress-legislators",
        "sourceUrl": SOURCE_URL,
        "generated": date.today().isoformat(),
        "count": len(members),
        "members": members,
    }
    out = PROJ / "members.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size} bytes, {len(members)} members, missing_url={missing_url})")


if __name__ == "__main__":
    main()
