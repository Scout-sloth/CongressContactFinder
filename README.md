# CongressContactFinder

Embeddable, offline-friendly lookup of a current U.S. Congress member’s **official contact website URL**.

## Files

| File | Purpose |
|------|---------|
| `embed.js` | Drop-in script: name → contact URL |
| `embed.html` | iframe-friendly page |
| `members.json` | Bundled current-member contact data |
| `demo.html` | Usage examples |
| `dummy.html` | Fake host page with iframe + data-attribute embeds plugged in |
| `build_members.py` | Refresh `members.json` from the public source |
| `serve.ps1` | Tiny local HTTP server (avoids `file://` CORS) |

## Data source

[unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators) current legislators JSON, published at:

`https://unitedstates.github.io/congress-legislators/legislators-current.json`

For each member, the contact URL is `contact_form` when present, otherwise the official office `url` from their latest term.

Refresh the bundle:

```powershell
python .\build_members.py
```

## Serve locally

Browsers often block `fetch()` of `members.json` from `file://`. Use:

```powershell
.\serve.ps1
```

Then open:

- `http://127.0.0.1:8765/demo.html` — interactive usage examples
- `http://127.0.0.1:8765/dummy.html` — fake host site with the embed snippets already plugged in

## How to embed

### iframe (query param)

```html
<iframe
  src="https://your-host/CongressContactFinder/embed.html?name=Bernie%20Sanders"
  title="Congress contact"
  style="width:100%;height:7rem;border:0"></iframe>
```

Also supported: `?member=…`, `#name=…`, or `#Bernie%20Sanders`.

### Drop-in HTML + script (data attribute)

Host `embed.js` and `members.json` on the same origin, then:

```html
<div data-congress-contact data-name="Alexandria Ocasio-Cortez"></div>
<script src="/CongressContactFinder/embed.js"></script>
```

### Programmatic

```html
<div id="contact"></div>
<script src="/CongressContactFinder/embed.js"></script>
<script>
  CongressContactFinder.mount("#contact", { name: "Maria Cantwell" });
</script>
```

## Limitations

- **Current members only** (House + Senate in the bundled snapshot).
- **Name matching** is fuzzy (exact / contains / first+last). Nicknames and misspellings may miss; try the official full name.
- **Contact vs website**: prefers `contact_form` when the legislator data includes one; otherwise uses the official site URL.
- **Stale data** until you re-run `build_members.py`.
- Must be served over HTTP(S) with `members.json` reachable next to `embed.js` (or pass `baseUrl` / `dataUrl` in options).
