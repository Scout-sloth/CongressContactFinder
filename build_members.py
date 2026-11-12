"""Build slim members.json from unitedstates/congress-legislators current data.

Optionally probes each contact URL for X-Frame-Options / CSP frame-ancestors
and stores frameAllowed on every member (true / false / null when unknown).
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import ssl
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

SOURCE_URL = "https://unitedstates.github.io/congress-legislators/legislators-current.json"
PROJ = Path(__file__).resolve().parent
USER_AGENT = "CongressContactFinder/1.0 (+local build; frame-ancestors probe)"
FRAME_ANCESTORS_RE = re.compile(r"(?:^|;)\s*frame-ancestors\s+([^;]+)", re.I)


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


def _headers_dict(headers) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in headers.items():
        out[str(key).lower()] = str(value)
    return out


def interpret_frame_headers(headers: dict[str, str]) -> bool | None:
    """Return False if framing is clearly blocked, True if clearly allowed, else None."""
    xfo = (headers.get("x-frame-options") or "").strip().lower()
    if xfo in ("deny", "sameorigin"):
        return False
    if xfo.startswith("allow-from"):
        # Legacy allow-from rarely helps third-party hosts; treat as blocked for embeds.
        return False

    csp = headers.get("content-security-policy") or ""
    match = FRAME_ANCESTORS_RE.search(csp)
    if not match:
        # No XFO deny/sameorigin and no frame-ancestors → likely embeddable.
        return True if not xfo else None

    ancestors = match.group(1).strip().lower()
    if ancestors == "*":
        return True
    tokens = ancestors.split()
    # 'none', 'self', or host allowlists without * block arbitrary third-party embeds.
    if "'none'" in tokens:
        return False
    if "*" in tokens:
        return True
    return False


def probe_frame_allowed(url: str, timeout: float = 12.0) -> bool | None:
    ctx = ssl.create_default_context()
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,*/*"}

    def fetch(method: str):
        req = urllib.request.Request(url, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            hdrs = _headers_dict(resp.headers)
            if method == "GET":
                resp.read(256)
            return hdrs

    try:
        try:
            return interpret_frame_headers(fetch("HEAD"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError):
            return interpret_frame_headers(fetch("GET"))
    except Exception:
        return None


def probe_members(members: list[dict], workers: int = 24) -> None:
    total = len(members)
    done = 0
    allowed = blocked = unknown = 0

    def work(member: dict) -> tuple[str, bool | None]:
        return member["bioguide"] or member["name"], probe_frame_allowed(member["contactUrl"])

    print(f"Probing frame headers for {total} contact URLs ({workers} workers)…")
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(work, m): m for m in members}
        for fut in concurrent.futures.as_completed(futures):
            member = futures[fut]
            try:
                _, result = fut.result()
            except Exception:
                result = None
            member["frameAllowed"] = result
            done += 1
            if result is True:
                allowed += 1
            elif result is False:
                blocked += 1
            else:
                unknown += 1
            if done % 50 == 0 or done == total:
                print(f"  {done}/{total} (allowed={allowed}, blocked={blocked}, unknown={unknown})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skip-frame-probe",
        action="store_true",
        help="Do not probe contact URLs; set frameAllowed to null for every member.",
    )
    parser.add_argument(
        "--probe-workers",
        type=int,
        default=24,
        help="Concurrent HTTP workers for frame probes (default 24).",
    )
    args = parser.parse_args()

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
                "frameAllowed": None,
            }
        )

    if args.skip_frame_probe:
        print("Skipping frame probe (--skip-frame-probe); frameAllowed=null for all.")
    else:
        probe_members(members, workers=max(1, args.probe_workers))

    payload = {
        "source": "unitedstates/congress-legislators",
        "sourceUrl": SOURCE_URL,
        "generated": date.today().isoformat(),
        "count": len(members),
        "frameProbe": not args.skip_frame_probe,
        "members": members,
    }
    out = PROJ / "members.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size} bytes, {len(members)} members, missing_url={missing_url})")


if __name__ == "__main__":
    main()
