/**
 * CongressContactFinder — embeddable member contact URL lookup.
 * Data: bundled members.json from unitedstates/congress-legislators.
 */
(function (global) {
  "use strict";

  var DATA_URL = "members.json";
  var cache = null;
  var cachePromise = null;

  function normalizeName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s,.'-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripHonorifics(value) {
    return normalizeName(value)
      .replace(/^(rep\.?|senator|sen\.?|congress(?:wo)?man|the honorable)\s+/i, "")
      .trim();
  }

  function scoreMatch(query, member) {
    var q = stripHonorifics(query);
    if (!q) return 0;
    var names = [member.name].concat(member.aliases || []);
    var best = 0;
    for (var i = 0; i < names.length; i++) {
      var n = normalizeName(names[i]);
      if (!n) continue;
      if (n === q) return 100;
      if (n.indexOf(q) !== -1 || q.indexOf(n) !== -1) best = Math.max(best, 80);
      var qParts = q.replace(/,/g, " ").split(/\s+/).filter(Boolean);
      var nParts = n.replace(/,/g, " ").split(/\s+/).filter(Boolean);
      if (qParts.length && nParts.length) {
        var lastQ = qParts[qParts.length - 1];
        var lastN = nParts[nParts.length - 1];
        if (lastQ === lastN) {
          var firstHit = qParts.some(function (p) {
            return nParts.indexOf(p) !== -1 && p !== lastQ;
          });
          best = Math.max(best, firstHit ? 70 : 40);
        }
      }
    }
    return best;
  }

  function findMembers(data, query) {
    var scored = [];
    var members = (data && data.members) || [];
    for (var i = 0; i < members.length; i++) {
      var s = scoreMatch(query, members[i]);
      if (s >= 40) scored.push({ score: s, member: members[i] });
    }
    scored.sort(function (a, b) {
      return b.score - a.score || a.member.name.localeCompare(b.member.name);
    });
    return scored;
  }

  function resolveDataUrl(base) {
    if (!base) return DATA_URL;
    return String(base).replace(/\/?$/, "/") + DATA_URL;
  }

  function loadData(options) {
    options = options || {};
    if (cache) return Promise.resolve(cache);
    if (cachePromise) return cachePromise;
    var url = options.dataUrl || resolveDataUrl(options.baseUrl);
    cachePromise = fetch(url, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("Could not load member data (" + res.status + ")");
        return res.json();
      })
      .then(function (data) {
        cache = data;
        return data;
      })
      .catch(function (err) {
        cachePromise = null;
        throw err;
      });
    return cachePromise;
  }

  function lookup(name, options) {
    return loadData(options).then(function (data) {
      var matches = findMembers(data, name);
      return {
        query: name,
        match: matches[0] ? matches[0].member : null,
        score: matches[0] ? matches[0].score : 0,
        alternatives: matches.slice(1, 4).map(function (m) {
          return m.member;
        }),
        source: data.source,
        generated: data.generated,
      };
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderResult(target, result) {
    var el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) return;
    if (!result || !result.match) {
      el.innerHTML =
        '<div class="ccf-root ccf-miss">' +
        '<p class="ccf-label">Contact website</p>' +
        '<p class="ccf-empty">No current member found for “' +
        escapeHtml(result && result.query ? result.query : "") +
        '”.</p>' +
        (result && result.alternatives && result.alternatives.length
          ? '<p class="ccf-hint">Try: ' +
            result.alternatives
              .map(function (m) {
                return escapeHtml(m.name);
              })
              .join(", ") +
            "</p>"
          : "") +
        "</div>";
      return;
    }
    var m = result.match;
    var url = m.contactUrl;
    el.innerHTML =
      '<div class="ccf-root ccf-hit">' +
      '<p class="ccf-label">Official contact website</p>' +
      '<p class="ccf-name">' +
      escapeHtml(m.name) +
      (m.chamber || m.state
        ? ' <span class="ccf-meta">(' +
          escapeHtml([m.chamber, m.state].filter(Boolean).join(", ")) +
          ")</span>"
        : "") +
      "</p>" +
      '<p class="ccf-url"><a href="' +
      escapeHtml(url) +
      '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(url) +
      "</a></p>" +
      "</div>";
  }

  function ensureStyles() {
    if (document.getElementById("ccf-embed-styles")) return;
    var style = document.createElement("style");
    style.id = "ccf-embed-styles";
    style.textContent =
      ".ccf-root{font:14px/1.4 system-ui,Segoe UI,sans-serif;color:#1a1a1a;max-width:36rem}" +
      ".ccf-label{margin:0 0 .25rem;font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;color:#555}" +
      ".ccf-name{margin:0 0 .35rem;font-weight:600}" +
      ".ccf-meta{font-weight:400;color:#555}" +
      ".ccf-url{margin:0;word-break:break-all}" +
      ".ccf-url a{color:#0b57d0;text-decoration:underline}" +
      ".ccf-empty{margin:0;color:#7a1f1f}" +
      ".ccf-hint{margin:.35rem 0 0;color:#555;font-size:.9em}" +
      ".ccf-loading{margin:0;color:#555}";
    document.head.appendChild(style);
  }

  function readNameFromLocation() {
    var params = new URLSearchParams(global.location.search || "");
    var fromQuery = params.get("name") || params.get("member") || "";
    if (fromQuery) return fromQuery;
    var hash = (global.location.hash || "").replace(/^#/, "");
    if (!hash) return "";
    if (hash.indexOf("=") !== -1) {
      var hp = new URLSearchParams(hash);
      return hp.get("name") || hp.get("member") || "";
    }
    return decodeURIComponent(hash);
  }

  function mount(selectorOrElement, options) {
    options = options || {};
    ensureStyles();
    var el =
      typeof selectorOrElement === "string"
        ? document.querySelector(selectorOrElement)
        : selectorOrElement;
    if (!el) return Promise.reject(new Error("Mount target not found"));
    var name =
      options.name ||
      el.getAttribute("data-name") ||
      el.getAttribute("data-member") ||
      readNameFromLocation();
    el.innerHTML = '<div class="ccf-root"><p class="ccf-loading">Looking up…</p></div>';
    if (!name) {
      el.innerHTML =
        '<div class="ccf-root ccf-miss"><p class="ccf-empty">Provide a member name (query, hash, data-name, or options.name).</p></div>';
      return Promise.resolve(null);
    }
    return lookup(name, options)
      .then(function (result) {
        renderResult(el, result);
        return result;
      })
      .catch(function (err) {
        el.innerHTML =
          '<div class="ccf-root ccf-miss"><p class="ccf-empty">' +
          escapeHtml(err.message || "Lookup failed") +
          "</p><p class="ccf-hint">Serve this folder over HTTP (file:// fetch of JSON is often blocked).</p></div>";
        throw err;
      });
  }

  function autoMount() {
    var nodes = document.querySelectorAll("[data-congress-contact], .congress-contact-finder");
    for (var i = 0; i < nodes.length; i++) {
      mount(nodes[i]);
    }
    if (document.body && document.body.getAttribute("data-congress-embed") === "page") {
      var host = document.getElementById("ccf-embed-root") || document.body;
      mount(host);
    }
  }

  var api = {
    lookup: lookup,
    mount: mount,
    loadData: loadData,
    readNameFromLocation: readNameFromLocation,
  };

  global.CongressContactFinder = api;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoMount);
  } else {
    autoMount();
  }
})(typeof window !== "undefined" ? window : this);
