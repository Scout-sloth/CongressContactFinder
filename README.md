# CongressContactFinder

Embeddable, offline-friendly lookup of a current U.S. Congress member’s **official contact website**, then an attempt to **display that live page inside the embed** when framing is allowed.

## Files

| File | Purpose |
|------|---------|
| `embed.js` | Drop-in script: name → contact URL → embedded site (or fallback) |
| `embed.html` | iframe-friendly host page |
| `members.json` | Bundled current-member contact data (includes `frameAllowed`) |
| `demo.html` | Usage examples |
| `dummy.html` | Fake host page with iframe + data-attribute embeds plugged in |
| `build_members.py` | Refresh `members.json` and probe framing headers |
| `serve.ps1` | Tiny local HTTP server (avoids `file://` CORS) |

## Data source

[unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators) current legislators JSON, published at:

`https://unitedstates.github.io/congress-legislators/legislators-current.json`

For each member, the contact URL is `contact_form` when present, otherwise the official office `url` from their latest term.

Refresh the bundle (also probes `X-Frame-Options` / CSP `frame-ancestors` and writes `frameAllowed`):

```powershell
python .\build_members.py
```

Fast rebuild without network probes (sets `frameAllowed` to null):

```powershell
python .\build_members.py --skip-frame-probe
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

Host pages should give the outer iframe enough height for a usable contact page (~700–800px) when framing works. `embed.html` also posts a resize message so host pages can shrink when only the fallback button is shown (`dummy.html` does this).

```html
<iframe
  src="https://your-host/CongressContactFinder/embed.html?name=Bernie%20Sanders"
  title="Congress contact"
  style="width:100%;height:780px;border:0"></iframe>
```

Also supported: `?member=…`, `#name=…`, or `#Bernie%20Sanders`.

### Drop-in HTML + script (data attribute)

Host `embed.js` and `members.json` on the same origin, then:

```html
<div data-congress-contact data-name="Alexandria Ocasio-Cortez" data-iframe-height="720"></div>
<script src="/CongressContactFinder/embed.js"></script>
```

### Programmatic

```html
<div id="contact"></div>
<script src="/CongressContactFinder/embed.js"></script>
<script>
  CongressContactFinder.mount("#contact", {
    name: "Maria Cantwell",
    iframeHeight: 720
  });
</script>
```

## Behavior

1. Resolve the member from `members.json` by name (`contact_form` preferred, else official `url`).
2. If `frameAllowed` is **false** (from the build-time header probe), skip the iframe and show the fallback immediately.
3. If `frameAllowed` is **true** or unknown, load the contact URL in a tall iframe — but keep that iframe **hidden** until the load succeeds. On block / timeout, remove it and show the fallback.
4. Fallback UI: a large **Open contact form / website** button (new tab), **Open in this window**, the resolved URL, and a short note that the site blocks embedding. The embed does **not** invent or mirror the form HTML.

## Limitations

- **Framing / embedding**: Many House and Senate `.gov` sites send `X-Frame-Options` or CSP `frame-ancestors` that block third-party iframes. `frameAllowed` is a best-effort probe at build time; runtime detection still covers unknowns and sites that change headers.
- **Current members only** (House + Senate in the bundled snapshot).
- **Name matching** is fuzzy (exact / contains / first+last). Nicknames and misspellings may miss; try the official full name.
- **Contact vs website**: prefers `contact_form` when the legislator data includes one; otherwise uses the official site URL.
- **Stale data** until you re-run `build_members.py`.
- Must be served over HTTP(S) with `members.json` reachable next to `embed.js` (or pass `baseUrl` / `dataUrl` in options).
