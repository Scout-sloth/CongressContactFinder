/**
 * CongressContactFinder — embeddable member contact site lookup.
 * Resolves official contact URLs from members.json and embeds the live
 * page only when framing is allowed; otherwise shows a clear open-link fallback.
 * Data: bundled members.json from unitedstates/congress-legislators.
 */
(function (global) {
  "use strict";

  var DATA_URL = "members.json";
  var DEFAULT_FRAME_HEIGHT = 720;
  var FRAME_PROBE_MS = 6000;
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

  function frameHeight(options) {
    var h = options && options.iframeHeight;
    var n = typeof h === "number" ? h : parseInt(h, 10);
    return n > 120 ? n : DEFAULT_FRAME_HEIGHT;
  }

  function notifyHostHeight(rootEl) {
    if (!rootEl || typeof global.parent === "undefined" || global.parent === global) return;
    try {
      var height = Math.ceil(rootEl.getBoundingClientRect().height) + 24;
      if (height < 120) height = 120;
      global.parent.postMessage(
        { source: "congress-contact-finder", type: "resize", height: height },
        "*"
      );
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * Detect whether the contact page actually rendered inside the iframe.
   * Cross-origin SecurityError after load usually means content is present.
   * Readable about:blank (or empty) after load usually means X-Frame-Options /
   * CSP frame-ancestors blocked embedding.
   */
  function watchFrame(iframe, onBlocked, onAllowed) {
    var settled = false;

    function finish(blocked) {
      if (settled) return;
      settled = true;
      if (blocked) onBlocked();
      else onAllowed();
    }

    var timer = setTimeout(function () {
      finish(true);
    }, FRAME_PROBE_MS);

    function inspect() {
      try {
        var doc = iframe.contentDocument;
        var win = iframe.contentWindow;
        if (!win) {
          finish(true);
          return;
        }
        if (doc) {
          var href = "";
          try {
            href = String(win.location.href || "");
          } catch (err) {
            finish(false);
            return;
          }
          if (!href || href === "about:blank") {
            finish(true);
            return;
          }
          var body = doc.body;
          if (body && !String(body.innerHTML || "").trim()) {
            finish(true);
            return;
          }
          finish(false);
          return;
        }
        // null contentDocument without throw → treat as cross-origin success
        finish(false);
      } catch (e) {
        finish(false);
      }
    }

    iframe.addEventListener("load", function () {
      clearTimeout(timer);
      setTimeout(inspect, 75);
    });
    iframe.addEventListener("error", function () {
      clearTimeout(timer);
      finish(true);
    });
  }

  function openActionsHtml(url) {
    return (
      '<div class="ccf-actions">' +
      '<a class="ccf-open-btn" href="' +
      escapeHtml(url) +
      '" target="_blank" rel="noopener noreferrer">Open contact form / website</a>' +
      '<a class="ccf-open-same" href="' +
      escapeHtml(url) +
      '">Open in this window</a>' +
      "</div>"
    );
  }

  function fallbackHtml(url) {
    return (
      '<div class="ccf-fallback">' +
      '<p class="ccf-block-note">This member’s site blocks embedding in other pages (X-Frame-Options / CSP). The live form can’t be shown here — open it directly instead.</p>' +
      openActionsHtml(url) +
      '<p class="ccf-url-line"><span class="ccf-url-label">URL</span> <a href="' +
      escapeHtml(url) +
      '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(url) +
      "</a></p>" +
      "</div>"
    );
  }

  function memberHeaderHtml(m) {
    var meta =
      m.chamber || m.state
        ? ' <span class="ccf-meta">(' +
          escapeHtml([m.chamber, m.state].filter(Boolean).join(", ")) +
          ")</span>"
        : "";
    return (
      '<p class="ccf-label">Official contact website</p>' +
      '<p class="ccf-name">' +
      escapeHtml(m.name) +
      meta +
      "</p>"
    );
  }

  function tearDownFrame(iframe) {
    if (!iframe) return;
    iframe.hidden = true;
    iframe.removeAttribute("src");
    iframe.classList.add("ccf-frame-blocked");
    try {
      iframe.remove();
    } catch (err) {
      /* ignore */
    }
  }

  function renderBlocked(el, m, url) {
    el.innerHTML =
      '<div class="ccf-root ccf-hit ccf-blocked">' +
      memberHeaderHtml(m) +
      fallbackHtml(url) +
      "</div>";
    notifyHostHeight(el.querySelector(".ccf-root") || el);
  }

  function renderResult(target, result, options) {
    options = options || {};
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
      notifyHostHeight(el.querySelector(".ccf-root") || el);
      return;
    }

    var m = result.match;
    var url = m.contactUrl;
    var height = frameHeight(options);
    var knownAllowed = m.frameAllowed === true;
    var knownBlocked = m.frameAllowed === false;

    if (knownBlocked) {
      renderBlocked(el, m, url);
      return;
    }

    // Only mount a tall iframe when framing is known-allowed, or while probing unknown.
    // Keep the iframe hidden until a successful load so blank blocked frames never show.
    el.innerHTML =
      '<div class="ccf-root ccf-hit">' +
      memberHeaderHtml(m) +
      '<div class="ccf-frame-panel">' +
      '<p class="ccf-status ccf-status-loading">Checking whether this contact page can be embedded…</p>' +
      '<iframe class="ccf-site-frame" hidden title="Contact page for ' +
      escapeHtml(m.name) +
      '" loading="eager" referrerpolicy="no-referrer-when-downgrade" style="height:' +
      height +
      'px"></iframe>' +
      '<div class="ccf-fallback-slot" hidden></div>' +
      '<div class="ccf-frame-ok" hidden>' +
      '<p class="ccf-ok-note">Embedded contact page (open in a new tab if the form doesn’t respond inside the frame).</p>' +
      openActionsHtml(url) +
      "</div>" +
      "</div>" +
      "</div>";

    var root = el.querySelector(".ccf-root");
    var iframe = el.querySelector(".ccf-site-frame");
    var fallbackSlot = el.querySelector(".ccf-fallback-slot");
    var okNote = el.querySelector(".ccf-frame-ok");
    var status = el.querySelector(".ccf-status");

    function showFallback() {
      if (status) status.hidden = true;
      tearDownFrame(iframe);
      if (fallbackSlot) {
        fallbackSlot.hidden = false;
        fallbackSlot.innerHTML = fallbackHtml(url);
      }
      if (okNote) okNote.hidden = true;
      notifyHostHeight(root || el);
    }

    function showFrame() {
      if (status) status.hidden = true;
      if (iframe) {
        iframe.hidden = false;
      }
      if (fallbackSlot) fallbackSlot.hidden = true;
      if (okNote) okNote.hidden = false;
      notifyHostHeight(root || el);
    }

    notifyHostHeight(root || el);

    if (!iframe) {
      showFallback();
      return;
    }

    iframe.src = url;
    watchFrame(iframe, showFallback, showFrame);

    // Known-allowed: reveal as soon as the load handler fires via watchFrame.
    // Unknown: stay hidden until watchFrame confirms (or timeout → fallback).
    if (knownAllowed) {
      /* keep hidden until load confirms; avoids flashing a blank box */
    }
  }

  function ensureStyles() {
    if (document.getElementById("ccf-embed-styles")) return;
    var style = document.createElement("style");
    style.id = "ccf-embed-styles";
    style.textContent =
      ".ccf-root{font:14px/1.45 system-ui,Segoe UI,sans-serif;color:#1a1a1a;max-width:52rem}" +
      ".ccf-label{margin:0 0 .25rem;font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;color:#555}" +
      ".ccf-name{margin:0 0 .65rem;font-weight:600}" +
      ".ccf-meta{font-weight:400;color:#555}" +
      ".ccf-frame-panel{margin:0}" +
      ".ccf-status{margin:0 0 .5rem;color:#555}" +
      ".ccf-site-frame{display:block;width:100%;border:1px solid #cfd6de;background:#fff;border-radius:2px}" +
      ".ccf-site-frame[hidden],.ccf-fallback[hidden],.ccf-fallback-slot[hidden],.ccf-frame-ok[hidden],.ccf-status[hidden]{display:none!important}" +
      ".ccf-fallback{margin-top:.15rem;padding:1.1rem 1.15rem;border:2px solid #c9921a;background:#fff8e8;border-radius:4px}" +
      ".ccf-block-note{margin:0 0 .85rem;color:#5c4a12;font-size:1rem;line-height:1.45}" +
      ".ccf-ok-note{margin:.55rem 0 .4rem;color:#555;font-size:.9em}" +
      ".ccf-actions{display:flex;flex-wrap:wrap;gap:.65rem 1rem;align-items:center;margin:0 0 .65rem}" +
      ".ccf-open-btn{display:inline-block;padding:.85rem 1.25rem;background:#1f5f8b;color:#fff!important;text-decoration:none;font-weight:700;font-size:1.05rem;border-radius:4px;box-shadow:0 1px 0 rgba(0,0,0,.08)}" +
      ".ccf-open-btn:hover{background:#184a6c}" +
      ".ccf-open-same{color:#0b57d0;font-weight:600}" +
      ".ccf-url-line{margin:.45rem 0 0;word-break:break-all;font-size:.95em}" +
      ".ccf-url-label{color:#555;margin-right:.25rem;font-weight:600}" +
      ".ccf-url-line a{color:#0b57d0}" +
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

  function readHeightAttr(el) {
    if (!el || !el.getAttribute) return null;
    var raw = el.getAttribute("data-iframe-height") || el.getAttribute("data-height");
    if (!raw) return null;
    var n = parseInt(raw, 10);
    return n > 120 ? n : null;
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
    var heightOpt = options.iframeHeight || readHeightAttr(el);
    var renderOpts = {};
    if (heightOpt) renderOpts.iframeHeight = heightOpt;
    el.innerHTML = '<div class="ccf-root"><p class="ccf-loading">Looking up…</p></div>';
    notifyHostHeight(el.querySelector(".ccf-root") || el);
    if (!name) {
      el.innerHTML =
        '<div class="ccf-root ccf-miss"><p class="ccf-empty">Provide a member name (query, hash, data-name, or options.name).</p></div>';
      notifyHostHeight(el.querySelector(".ccf-root") || el);
      return Promise.resolve(null);
    }
    return lookup(name, options)
      .then(function (result) {
        renderResult(el, result, renderOpts);
        return result;
      })
      .catch(function (err) {
        el.innerHTML =
          '<div class="ccf-root ccf-miss"><p class="ccf-empty">' +
          escapeHtml(err.message || "Lookup failed") +
          "</p><p class="ccf-hint">Serve this folder over HTTP (file:// fetch of JSON is often blocked).</p></div>";
        notifyHostHeight(el.querySelector(".ccf-root") || el);
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
