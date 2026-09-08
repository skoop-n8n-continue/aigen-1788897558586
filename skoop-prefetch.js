(function () {
  'use strict';

  // Skip on save-data flag or very slow connections.
  var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn && (conn.saveData ||
      conn.effectiveType === 'slow-2g' ||
      conn.effectiveType === '2g')) return;

  // How long to wait after window load before the first prefetch.
  var BOOT_DELAY_MS  = 2000;
  // Idle gap inserted between each prefetch request so we don't race
  // with real user-driven network activity.
  var BATCH_DELAY_MS = 500;
  // Hard cap to avoid unbounded queues on very large data documents.
  var MAX_QUEUE      = 200;

  // Matches common image / video / audio / font file extensions.
  var ASSET_EXT_RE = /\.(jpe?g|png|gif|webp|svg|avif|mp4|webm|mov|ogg|mp3|wav|woff2?|ttf|otf)(\?[^"'\s]*)?$/i;

  function isAssetUrl(v) {
    if (typeof v !== 'string' || v.length < 5 || v.length > 1000) return false;
    // The extension test is the primary guard — asset filenames end in a known
    // media extension regardless of whether the value is a full URL, a
    // root-relative path, an app-relative path, or a bare filename stored in
    // data.json (e.g. "brand_hero_abc123.png" or "assets/slide2-bg.webp").
    if (!ASSET_EXT_RE.test(v)) return false;
    // Exclude non-image data URIs (data:text/..., data:application/...).
    var lo = v.toLowerCase();
    if (lo.startsWith('data:') && !lo.startsWith('data:image')) return false;
    return true;
  }

  // Recursively walk a JSON value and collect every string that looks
  // like an asset URL.  Covers nested configurator collections, arrays
  // of slides, etc.
  function extractUrls(obj, out, depth) {
    if (out.size >= MAX_QUEUE || depth > 8) return;
    if (typeof obj === 'string') {
      if (isAssetUrl(obj)) out.add(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) extractUrls(obj[i], out, depth + 1);
      return;
    }
    if (obj !== null && typeof obj === 'object') {
      var vals = Object.values(obj);
      for (var j = 0; j < vals.length; j++) extractUrls(vals[j], out, depth + 1);
    }
  }

  // Scan DOM elements for asset references that are already in the markup
  // (including hidden slides / off-screen elements the app has not yet
  // rendered to the viewport).
  function scanDom(out) {
    var i, el, u;

    // Standard src attributes
    var srcEls = document.querySelectorAll('img[src],video[src],source[src],audio[src]');
    for (i = 0; i < srcEls.length; i++) {
      if (isAssetUrl(srcEls[i].src)) out.add(srcEls[i].src);
    }

    // data-src — lazy-loaded images not yet swapped into src
    var dsEls = document.querySelectorAll('[data-src]');
    for (i = 0; i < dsEls.length; i++) {
      u = dsEls[i].getAttribute('data-src');
      if (isAssetUrl(u)) out.add(u);
    }

    // srcset — responsive image candidates
    var ssEls = document.querySelectorAll('[srcset]');
    for (i = 0; i < ssEls.length; i++) {
      var parts = ssEls[i].getAttribute('srcset').split(',');
      for (var p = 0; p < parts.length; p++) {
        u = parts[p].trim().split(/\s+/)[0];
        if (isAssetUrl(u)) out.add(u);
      }
    }

    // Inline style background-image: url(...)
    var stEls = document.querySelectorAll('[style]');
    for (i = 0; i < stEls.length; i++) {
      var style = stEls[i].getAttribute('style') || '';
      var ms = style.match(/url\(\s*['"]?([^'"\)\s]+)['"]?\s*\)/gi);
      if (ms) {
        for (var m = 0; m < ms.length; m++) {
          u = ms[m].replace(/^url\(\s*['"]?/, '').replace(/['"]?\s*\)$/, '');
          if (isAssetUrl(u)) out.add(u);
        }
      }
    }
  }

  // Build the full prefetch queue.
  // Priority: data.json (covers ALL pages/slides) → DOM scan (covers
  // hardcoded assets in apps that have no data.json).
  function collectAssets() {
    var out = new Set();

    // If skoop-live.js already intercepted the app's own fetch('data.json')
    // call and stashed the parsed result, read it for free.
    var stashed = window.__skoop_initial_data__;

    // __skoop_initial_data__ is a Promise (set by the skoop-live.js fetch shim)
    // that resolves to the parsed data.json object.  We must .then() it, not
    // read it directly.
    if (stashed) {
      return Promise.resolve(stashed).then(function (data) {
        if (data) extractUrls(data, out, 0);
        scanDom(out);
        return Array.from(out).slice(0, MAX_QUEUE);
      });
    }

    // Otherwise try fetching data.json ourselves.  Silently skip if it does
    // not exist (apps with no configurator).
    return fetch('./data.json', { cache: 'default' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function ()  { return null; })
      .then(function (data) {
        if (data) extractUrls(data, out, 0);
        scanDom(out);
        return Array.from(out).slice(0, MAX_QUEUE);
      });
  }

  // ── Navigation pause ────────────────────────────────────────────────────────
  // When the user navigates to a new route, we abort the in-flight prefetch
  // and pause the queue so the new page's real assets get full bandwidth.
  // After a short settle period we resume where we left off.
  var paused = false;
  var currentAbort = null;
  var resumeTimer = null;

  function pauseFor(ms) {
    paused = true;
    // Abort whatever is currently downloading
    if (currentAbort) { try { currentAbort.abort(); } catch (_) {} }
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(function () { paused = false; }, ms);
  }

  // hashchange covers hash-router SPAs; popstate covers history-API SPAs.
  window.addEventListener('hashchange', function () { pauseFor(3000); });
  window.addEventListener('popstate',   function () { pauseFor(3000); });

  // Prefetch a single URL, yielding CPU to requestIdleCallback first so we
  // do not compete with the page's own work.
  function prefetchOne(url) {
    return new Promise(function (resolve) {
      function doFetch() {
        if (paused) { return setTimeout(resolve, 200); } // skip slot, retry next iteration

        var abort = new AbortController();
        currentAbort = abort;

        var opts = { cache: 'default', signal: abort.signal };
        // priority: 'low' tells the browser/network layer to deprioritize this
        // request behind anything the page itself initiates (Chrome 101+, Safari 17.2+;
        // silently ignored in older browsers).
        opts.priority = 'low';
        // Cross-origin assets (S3, CDN) — use no-cors to avoid CORS errors.
        // The response is opaque but is still cached by the service worker
        // (sw.js) and served from cache on subsequent loads.
        try {
          if (new URL(url, location.href).origin !== location.origin) {
            opts.mode = 'no-cors';
          }
        } catch (_) {}

        fetch(url, opts)
          .catch(function () {})
          .then(function () {
            currentAbort = null;
            setTimeout(resolve, BATCH_DELAY_MS);
          });
      }

      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(doFetch, { timeout: 10000 });
      } else {
        setTimeout(doFetch, 100);
      }
    });
  }

  // Sequential loop so at most one prefetch is in-flight at a time.
  // Re-checks connection + paused flag before each asset.
  async function prefetchAll(urls) {
    for (var i = 0; i < urls.length; i++) {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c && (c.saveData || c.effectiveType === 'slow-2g' || c.effectiveType === '2g')) return;
      // If paused (navigation in progress), wait in short increments until clear
      while (paused) { await new Promise(function(r){ setTimeout(r, 200); }); }
      await prefetchOne(urls[i]);
    }
  }

  function start() {
    // Start asset discovery immediately after the boot delay — do NOT gate
    // this on requestIdleCallback.  Signage apps have ongoing JS activity
    // (clocks, timers, live-preview polling) that would delay or prevent a
    // startup idle callback from firing.  The per-fetch requestIdleCallback
    // inside prefetchOne is the right place to yield: each individual asset
    // download waits for an idle moment, but discovery itself is lightweight
    // DOM/JSON work that completes in under a millisecond.
    collectAssets().then(function (urls) {
      if (urls.length > 0) prefetchAll(urls);
    });
  }

  if (document.readyState === 'complete') {
    setTimeout(start, BOOT_DELAY_MS);
  } else {
    window.addEventListener('load', function () { setTimeout(start, BOOT_DELAY_MS); });
  }
})();
