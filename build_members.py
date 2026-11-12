"""Build slim members.json from unitedstates/congress-legislators current data.

Merges social accounts from legislators-social-media.json, phone numbers from
current terms (DC) plus district offices when listed, and any public email
found in source data. Optionally probes each contact URL for X-Frame-Options /
CSP frame-ancestors and stores frameAllowed on every member
(true / false / null when unknown).
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
SOCIAL_URL = "https://unitedstates.github.io/congress-legislators/legislators-social-media.json"
DISTRICT_OFFICES_URL = (
    "https://unitedstates.github.io/congress-legislators/legislators-district-offices.json"
)
PROJ = Path(__file__).resolve().parent
USER_AGENT = "CongressContactFinder/1.0 (+local build; frame-ancestors probe)"
FRAME_ANCESTORS_RE = re.compile(r"(?:^|;)\s*frame-ancestors\s+([^;]+)", re.I)
PHONE_DIGITS_RE = re.compile(r"\D+")


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


def download_if_missing(path: Path, url: str) -> None:
    if path.exists():
        return
    print(f"Downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        path.write_bytes(resp.read())


def extract_email(entry: dict, term: dict) -> str | None:
    """Return a public email only when present in source data — never invent one."""
    for candidate in (
        term.get("email"),
        entry.get("email"),
        (entry.get("id") or {}).get("email"),
    ):
        if isinstance(candidate, str):
            value = candidate.strip()
            if value and "@" in value:
                return value
    return None


def normalize_phone(value: object) -> str | None:
    """Return a trimmed phone string from source data, or None — never invent."""
    if not isinstance(value, str):
        return None
    number = value.strip()
    return number or None


def phone_dedupe_key(number: str) -> str:
    return PHONE_DIGITS_RE.sub("", number)


def district_office_label(office: dict) -> str | None:
    city = (office.get("city") or "").strip()
    state = (office.get("state") or "").strip()
    if city and state:
        return f"{city}, {state}"
    if city:
        return city
    if state:
        return state
    return None


def extract_phones(term: dict, district_offices: list[dict] | None) -> list[dict]:
    """Collect DC + district phones from source only; dedupe by digits."""
    phones: list[dict] = []
    seen: set[str] = set()

    def add(raw: object, label: str | None) -> None:
        number = normalize_phone(raw)
        if not number:
            return
        key = phone_dedupe_key(number)
        if len(key) < 7 or key in seen:
            return
        seen.add(key)
        item: dict[str, str] = {"number": number}
        if label:
            item["label"] = label
        phones.append(item)

    # Current term phone is the DC Capitol office number when present.
    add(term.get("phone"), "DC office")
    for office in district_offices or []:
        add(office.get("phone"), district_office_label(office) or "District office")
    return phones


def load_district_offices_by_bioguide(path: Path) -> dict[str, list[dict]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    by_bio: dict[str, list[dict]] = {}
    for entry in data:
        bio = (entry.get("id") or {}).get("bioguide")
        if bio:
            by_bio[bio] = entry.get("offices") or []
    return by_bio


def mastodon_url(handle: str) -> str | None:
    value = (handle or "").strip()
    if not value:
        return None
    if value.startswith("http://") or value.startswith("https://"):
        return value
    # @user@instance.social → https://instance.social/@user
    if value.startswith("@") and value.count("@") == 2:
        _, user, instance = value.split("@", 2)
        if user and instance:
            return f"https://{instance}/@{user}"
    return None


def build_social_links(social: dict | None) -> dict[str, str]:
    """Map congress-legislators social handles to absolute profile URLs."""
    if not social:
        return {}
    links: dict[str, str] = {}

    twitter = (social.get("twitter") or "").strip().lstrip("@")
    if twitter:
        links["twitter"] = f"https://x.com/{twitter}"

    facebook = (social.get("facebook") or "").strip()
    if facebook:
        if facebook.startswith("http://") or facebook.startswith("https://"):
            links["facebook"] = facebook
        else:
            links["facebook"] = f"https://www.facebook.com/{facebook}"

    youtube_id = (social.get("youtube_id") or "").strip()
    youtube = (social.get("youtube") or "").strip()
    if youtube_id:
        links["youtube"] = f"https://www.youtube.com/channel/{youtube_id}"
    elif youtube:
        if youtube.startswith("http://") or youtube.startswith("https://"):
            links["youtube"] = youtube
        elif youtube.startswith("UC") and len(youtube) >= 20:
            links["youtube"] = f"https://www.youtube.com/channel/{youtube}"
        else:
            handle = youtube.lstrip("@")
            links["youtube"] = f"https://www.youtube.com/@{handle}"

    instagram = (social.get("instagram") or "").strip().lstrip("@")
    if instagram:
        links["instagram"] = f"https://www.instagram.com/{instagram}"

    mastodon = mastodon_url(social.get("mastodon") or "")
    if mastodon:
        links["mastodon"] = mastodon

    return links


def load_social_by_bioguide(path: Path) -> dict[str, dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    by_bio: dict[str, dict] = {}
    for entry in data:
        bio = (entry.get("id") or {}).get("bioguide")
        if bio:
            by_bio[bio] = entry.get("social") or {}
    return by_bio


def previous_frame_allowed(path: Path) -> dict[str, bool | None]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, bool | None] = {}
    for member in data.get("members") or []:
        bio = member.get("bioguide")
        if bio and "frameAllowed" in member:
            out[bio] = member.get("frameAllowed")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skip-frame-probe",
        action="store_true",
        help="Do not probe contact URLs; reuse prior frameAllowed when available, else null.",
    )
    parser.add_argument(
        "--probe-workers",
        type=int,
        default=24,
        help="Concurrent HTTP workers for frame probes (default 24).",
    )
    args = parser.parse_args()

    raw_path = PROJ / "legislators-current.json"
    social_path = PROJ / "legislators-social-media.json"
    district_path = PROJ / "legislators-district-offices.json"
    download_if_missing(raw_path, SOURCE_URL)
    download_if_missing(social_path, SOCIAL_URL)
    download_if_missing(district_path, DISTRICT_OFFICES_URL)

    data = json.loads(raw_path.read_text(encoding="utf-8"))
    social_by_bio = load_social_by_bioguide(social_path)
    district_by_bio = load_district_offices_by_bioguide(district_path)
    out_path = PROJ / "members.json"
    prior_frames = previous_frame_allowed(out_path) if args.skip_frame_probe else {}

    members = []
    missing_url = 0
    with_email = 0
    with_social = 0
    with_phone = 0
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
        bioguide = (entry.get("id") or {}).get("bioguide")
        email = extract_email(entry, term)
        if email:
            with_email += 1
        social = build_social_links(social_by_bio.get(bioguide))
        if social:
            with_social += 1
        phones = extract_phones(term, district_by_bio.get(bioguide))
        if phones:
            with_phone += 1
        members.append(
            {
                "name": official or normalize_space(f"{first} {last}"),
                "aliases": build_aliases(name),
                "chamber": "Senate" if term.get("type") == "sen" else "House",
                "state": term.get("state"),
                "party": term.get("party"),
                "bioguide": bioguide,
                "contactUrl": contact_url,
                "websiteUrl": website or None,
                "contactFormUrl": contact_form or None,
                "email": email,
                "phone": phones[0]["number"] if phones else None,
                "phones": phones,
                "social": social,
                "frameAllowed": prior_frames.get(bioguide) if args.skip_frame_probe else None,
            }
        )

    if args.skip_frame_probe:
        reused = sum(1 for m in members if m["frameAllowed"] is not None)
        print(
            f"Skipping frame probe (--skip-frame-probe); "
            f"reused frameAllowed for {reused}/{len(members)} members."
        )
    else:
        probe_members(members, workers=max(1, args.probe_workers))

    payload = {
        "source": "unitedstates/congress-legislators",
        "sourceUrl": SOURCE_URL,
        "socialSourceUrl": SOCIAL_URL,
        "districtOfficesSourceUrl": DISTRICT_OFFICES_URL,
        "generated": date.today().isoformat(),
        "count": len(members),
        "withEmail": with_email,
        "withPhone": with_phone,
        "withSocial": with_social,
        "frameProbe": not args.skip_frame_probe,
        "members": members,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"Wrote {out_path} ({out_path.stat().st_size} bytes, {len(members)} members, "
        f"with_email={with_email}, with_phone={with_phone}, with_social={with_social}, "
        f"missing_url={missing_url})"
    )


if __name__ == "__main__":
    main()
