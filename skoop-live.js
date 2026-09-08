'use strict';

// ---------------------------------------------------------------------------
// Fetch shim — intercepts fetch('data.json') for two purposes:
//   1. Tier 2 srcdoc preview: when __skoop_dirty_data__ is set (injected by
//      the configurator into the srcdoc <head>), return it directly so the
//      page renders unsaved changes without an S3 round-trip.
//   2. Normal S3 load: stash a Promise for the data.json response in
//      __skoop_initial_data__ so the runtime can apply all data-bind-*
//      bindings (including show/hide) automatically after init() finishes.
// This shim is in skoop-live.js (not an inline <script>) so it is always
// fresh on each deployment — no stale code risk from agent-copied HTML.
// ---------------------------------------------------------------------------
(function () {
  var dirty = window.__skoop_dirty_data__;
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/(^\.\/)?(data\.json)(\?.*)?$/.test(url) || /(^|\/)data\.json(\?.*)?$/.test(url)) {
        if (dirty) {
          window.__skoop_initial_data__ = Promise.resolve(dirty);
          var body = JSON.stringify(dirty);
          return Promise.resolve(new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }));
        }
        // Normal load: pass through and stash a promise that resolves with the data
        var p = origFetch ? origFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
        window.__skoop_initial_data__ = p.then(function (response) {
          return response.clone().json();
        }).catch(function () { return null; });
        return p;
      }
    } catch (e) {}
    return origFetch ? origFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
  };
})();

/**
 * Skoop Live Preview Runtime
 *
 * Walks data-bind-* attributes on the page and applies values from the data
 * document. Listens for postMessage updates from the parent configurator so
 * unsaved changes can be previewed without reloading the iframe.
 *
 * Bindings supported (path is dot-separated against `sections`):
 *
 *   data-bind-text="storefront.store_name"           → element.textContent
 *   data-bind-html="about_page.about_body"           → element.innerHTML (newlines → <br>)
 *   data-bind-currency="products.0.price"            → "$X.XX"
 *   data-bind-number="app_settings.idle_timeout"     → number formatted
 *   data-bind-percent="products.0.discount"          → "X%"
 *   data-bind-src="storefront.logo"                  → src on img/video/source
 *   data-bind-href="storefront.website_url"          → href on a/link
 *   data-bind-bg-image="hero.background"             → style.backgroundImage url(...)
 *   data-bind-color="app_settings.primary_color"     → style.color
 *   data-bind-bg-color="app_settings.background"     → style.backgroundColor
 *   data-bind-border-color="app_settings.accent"     → style.borderColor
 *   data-bind-show="app_settings.show_prices"        → hidden attribute when false
 *   data-bind-hide="app_settings.compact_mode"       → hidden attribute when true
 *   data-bind-class="app_settings.nav_style"         → adds class "<lastKey>-<value>"
 *   data-bind-attr="aria-label:storefront.store_name" → arbitrary attr (key:path[, key:path])
 *   data-bind-style="--brand-color:brands.0.accent"   → CSS prop or --custom-prop (key:path[, key:path])
 *
 * Color fields (type: "color") on non-collection sections also auto-populate
 * CSS custom properties on :root, named "--<field_key_kebab_case>". This means
 * any color in data.json becomes available in CSS as var(--field-key) without
 * requiring an explicit binding. Per-collection-item CSS variables (a brand's
 * accent color, a category's tint) need data-bind-style to live-update because
 * :root variables can't represent per-item values.
 */

(function () {
  if (window.SkoopLive) return; // idempotent — only one runtime per page

  // ── Module-level live-preview state ────────────────────────────────────────
  // _liveData    — last data document received via postMessage; null on initial load
  // _applyingLiveData — true while we are writing to the DOM; the MutationObserver
  //                     callback skips re-entry when this flag is set
  // _liveObserver — the single MutationObserver instance; created lazily on first
  //                 postMessage, observes document.body subtree for the entire
  //                 configurator session
  var _liveData = null;
  var _applyingLiveData = false;
  var _liveObserver = null;

  // All data-bind-* attribute names — used by the observer to decide whether a
  // mutated element is one we care about.
  var BIND_ATTRS = [
    'data-bind-text', 'data-bind-html', 'data-bind-currency', 'data-bind-number',
    'data-bind-percent', 'data-bind-src', 'data-bind-href', 'data-bind-bg-image',
    'data-bind-color', 'data-bind-bg-color', 'data-bind-border-color',
    'data-bind-show', 'data-bind-hide', 'data-bind-class',
    'data-bind-attr', 'data-bind-style',
  ];

  // Returns true if el (or a close ancestor) carries any data-bind-* attribute.
  // We check up to 2 levels up so characterData mutations (which target the text
  // node, not the element) are mapped back to their bound parent element.
  function hasBoundElement(node) {
    var el = (node && node.nodeType === 3) ? node.parentElement : node;
    for (var depth = 0; depth < 3 && el && el.hasAttribute; depth++, el = el.parentElement) {
      for (var i = 0; i < BIND_ATTRS.length; i++) {
        if (el.hasAttribute(BIND_ATTRS[i])) return true;
      }
    }
    return false;
  }

  // Re-apply bindings from _liveData, guarded against re-entrant calls.
  // Uses Promise.resolve() to defer clearing the guard past the current
  // microtask batch — this ensures observer callbacks triggered by our OWN
  // DOM writes (which are microtasks) see _applyingLiveData = true and skip,
  // while subsequent app-timer-driven mutations are caught correctly.
  function reapplyLiveBindings() {
    if (!_liveData) return;
    _applyingLiveData = true;
    try {
      applyBindings(_liveData.sections || _liveData);
    } catch (e) {}
    var clearFlag = function () { _applyingLiveData = false; };
    if (typeof Promise !== 'undefined') {
      Promise.resolve().then(clearFlag);
    } else {
      setTimeout(clearFlag, 0);
    }
  }

  // Create (or no-op if already running) the MutationObserver that watches for
  // app-timer-driven DOM reversions and immediately re-applies live bindings.
  // Observes attributes (style, hidden, class, src, href), characterData, and
  // childList (for textContent replacements which remove + add text nodes).
  function activateLiveObserver() {
    if (_liveObserver || typeof MutationObserver === 'undefined') return;
    _liveObserver = new MutationObserver(function (mutations) {
      if (_applyingLiveData || !_liveData) return;
      for (var i = 0; i < mutations.length; i++) {
        if (hasBoundElement(mutations[i].target)) {
          reapplyLiveBindings();
          return; // one re-apply covers all mutations in the batch
        }
      }
    });
    var root = document.body || document.documentElement;
    _liveObserver.observe(root, {
      subtree: true,
      attributes: true,
      characterData: true,
      childList: true,  // needed for textContent replacement (removes then adds text node)
    });
  }
  // ── End MutationObserver setup ──────────────────────────────────────────────

  // Resolve a dot-separated path against the sections object. Handles typed
  // field unwrapping (returns .value when the resolved node is a typed field)
  // and collection wrappers (drills into .value array on numeric keys).
  function readPath(sections, pathStr) {
    if (!sections || !pathStr) return undefined;
    var parts = String(pathStr).split('.');
    var obj = sections;
    for (var i = 0; i < parts.length; i++) {
      if (obj === null || obj === undefined) return undefined;
      var key = parts[i];
      // Drill into a typed collection's .value array
      if (obj && obj.type === 'collection' && Array.isArray(obj.value)) {
        if (!isNaN(key)) obj = obj.value[parseInt(key, 10)];
        else obj = obj.value[key];
        continue;
      }
      // Drill into raw arrays
      if (Array.isArray(obj) && !isNaN(key)) {
        obj = obj[parseInt(key, 10)];
        continue;
      }
      obj = obj[key];
    }
    // Unwrap typed field nodes to their .value
    if (obj && typeof obj === 'object' && 'value' in obj && 'type' in obj) {
      return obj.value;
    }
    return obj;
  }

  function kebab(str) {
    return String(str).replace(/_/g, '-');
  }

  function applyColorVariables(sections) {
    if (!sections || typeof sections !== 'object') return [];
    var root = document.documentElement;
    var covered = [];
    for (var sectionKey in sections) {
      var section = sections[sectionKey];
      if (!section || typeof section !== 'object') continue;
      // Skip collections — color vars come from non-collection sections only
      if (section.type === 'collection') continue;
      for (var fieldKey in section) {
        var field = section[fieldKey];
        if (field && field.type === 'color' && typeof field.value === 'string') {
          root.style.setProperty('--' + kebab(fieldKey), field.value);
          // Record the full path so the ACK covers these implicit color bindings
          covered.push(sectionKey + '.' + fieldKey);
        }
      }
    }
    return covered;
  }

  function setSrc(el, value) {
    if (typeof value !== 'string' || !value) return;
    var tag = el.tagName;
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'SOURCE' || tag === 'AUDIO' || tag === 'IFRAME') {
      if (el.src !== value) el.src = value;
    } else {
      el.setAttribute('src', value);
    }
  }

  function applyBindings(sections) {
    if (!sections) return;

    var colorPaths = applyColorVariables(sections);

    var nodeList;

    // Text content
    nodeList = document.querySelectorAll('[data-bind-text]');
    for (var i = 0; i < nodeList.length; i++) {
      var el = nodeList[i];
      var v = readPath(sections, el.getAttribute('data-bind-text'));
      if (v !== undefined && v !== null) el.textContent = String(v);
    }

    // Inner HTML (textarea / multiline) — newlines become <br>
    nodeList = document.querySelectorAll('[data-bind-html]');
    for (var i2 = 0; i2 < nodeList.length; i2++) {
      var el2 = nodeList[i2];
      var v2 = readPath(sections, el2.getAttribute('data-bind-html'));
      if (v2 !== undefined && v2 !== null) {
        var safe = String(v2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        el2.innerHTML = safe.replace(/\n/g, '<br>');
      }
    }

    // Currency formatting
    nodeList = document.querySelectorAll('[data-bind-currency]');
    for (var i3 = 0; i3 < nodeList.length; i3++) {
      var el3 = nodeList[i3];
      var v3 = readPath(sections, el3.getAttribute('data-bind-currency'));
      if (typeof v3 === 'number') el3.textContent = '$' + v3.toFixed(2);
    }

    // Plain number
    nodeList = document.querySelectorAll('[data-bind-number]');
    for (var i4 = 0; i4 < nodeList.length; i4++) {
      var el4 = nodeList[i4];
      var v4 = readPath(sections, el4.getAttribute('data-bind-number'));
      if (typeof v4 === 'number') el4.textContent = String(v4);
    }

    // Percentage
    nodeList = document.querySelectorAll('[data-bind-percent]');
    for (var i5 = 0; i5 < nodeList.length; i5++) {
      var el5 = nodeList[i5];
      var v5 = readPath(sections, el5.getAttribute('data-bind-percent'));
      if (typeof v5 === 'number') el5.textContent = v5 + '%';
    }

    // src
    nodeList = document.querySelectorAll('[data-bind-src]');
    for (var i6 = 0; i6 < nodeList.length; i6++) {
      var el6 = nodeList[i6];
      setSrc(el6, readPath(sections, el6.getAttribute('data-bind-src')));
    }

    // href
    nodeList = document.querySelectorAll('[data-bind-href]');
    for (var i7 = 0; i7 < nodeList.length; i7++) {
      var el7 = nodeList[i7];
      var v7 = readPath(sections, el7.getAttribute('data-bind-href'));
      if (typeof v7 === 'string') el7.setAttribute('href', v7);
    }

    // background-image
    nodeList = document.querySelectorAll('[data-bind-bg-image]');
    for (var i8 = 0; i8 < nodeList.length; i8++) {
      var el8 = nodeList[i8];
      var v8 = readPath(sections, el8.getAttribute('data-bind-bg-image'));
      if (typeof v8 === 'string' && v8) el8.style.backgroundImage = "url('" + v8 + "')";
    }

    // color
    nodeList = document.querySelectorAll('[data-bind-color]');
    for (var i9 = 0; i9 < nodeList.length; i9++) {
      var el9 = nodeList[i9];
      var v9 = readPath(sections, el9.getAttribute('data-bind-color'));
      if (typeof v9 === 'string') el9.style.color = v9;
    }

    // background-color
    nodeList = document.querySelectorAll('[data-bind-bg-color]');
    for (var iA = 0; iA < nodeList.length; iA++) {
      var elA = nodeList[iA];
      var vA = readPath(sections, elA.getAttribute('data-bind-bg-color'));
      if (typeof vA === 'string') elA.style.backgroundColor = vA;
    }

    // border-color
    nodeList = document.querySelectorAll('[data-bind-border-color]');
    for (var iB = 0; iB < nodeList.length; iB++) {
      var elB = nodeList[iB];
      var vB = readPath(sections, elB.getAttribute('data-bind-border-color'));
      if (typeof vB === 'string') elB.style.borderColor = vB;
    }

    // show — hidden when value is falsy (false, 0, "", null, undefined)
    nodeList = document.querySelectorAll('[data-bind-show]');
    for (var iC = 0; iC < nodeList.length; iC++) {
      var elC = nodeList[iC];
      var vC = readPath(sections, elC.getAttribute('data-bind-show'));
      // Coerce to boolean — catches strict false, string "false", 0, null, undefined
      var showC = (vC === 'false' || vC === false || vC === 0 || vC === null || vC === undefined) ? false : !!vC;
      if (!showC) {
        elC.setAttribute('hidden', '');
        elC.style.display = 'none';
      } else {
        elC.removeAttribute('hidden');
        elC.style.display = '';
      }
    }

    // hide — hidden when value is truthy (true, 1, "true")
    nodeList = document.querySelectorAll('[data-bind-hide]');
    for (var iD = 0; iD < nodeList.length; iD++) {
      var elD = nodeList[iD];
      var vD = readPath(sections, elD.getAttribute('data-bind-hide'));
      // Coerce to boolean — catches strict true, string "true", 1
      var hideD = (vD === 'true' || vD === true || vD === 1) ? true : false;
      if (hideD) {
        elD.setAttribute('hidden', '');
        elD.style.display = 'none';
      } else {
        elD.removeAttribute('hidden');
        elD.style.display = '';
      }
    }

    // class — adds class "<lastKey>-<value>", removing previous matching variants
    nodeList = document.querySelectorAll('[data-bind-class]');
    for (var iE = 0; iE < nodeList.length; iE++) {
      var elE = nodeList[iE];
      var pathE = elE.getAttribute('data-bind-class');
      var vE = readPath(sections, pathE);
      if (typeof vE === 'string' && vE) {
        var prefix = (elE.getAttribute('data-bind-class-prefix') || pathE.split('.').pop()) + '-';
        var existing = Array.prototype.slice.call(elE.classList);
        for (var iEx = 0; iEx < existing.length; iEx++) {
          if (existing[iEx].indexOf(prefix) === 0) elE.classList.remove(existing[iEx]);
        }
        elE.classList.add(prefix + vE);
      }
    }

    // Collect every unique path actually present in data-bind-* attributes so
    // we can ACK the parent with the full set of covered paths after applying.
    // This drives automatic Tier 2 fallback in the configurator: if a changed
    // path was not in the ACK set, no binding existed for it, so the configurator
    // triggers a srcdoc reload instead of leaving the preview stale.
    // Also seed with paths covered implicitly by applyColorVariables (no element
    // attribute needed for top-level color fields — the runtime writes :root CSS
    // variables for those automatically, so they should NOT trigger Tier 2).
    var coveredPaths = {};
    for (var iCol = 0; iCol < colorPaths.length; iCol++) {
      coveredPaths[colorPaths[iCol]] = true;
    }
    var allBound = document.querySelectorAll('[data-bind-text],[data-bind-html],[data-bind-currency],[data-bind-number],[data-bind-percent],[data-bind-src],[data-bind-href],[data-bind-bg-image],[data-bind-color],[data-bind-bg-color],[data-bind-border-color],[data-bind-show],[data-bind-hide],[data-bind-class]');
    for (var iCov = 0; iCov < allBound.length; iCov++) {
      var elCov = allBound[iCov];
      var attrs = ['data-bind-text','data-bind-html','data-bind-currency','data-bind-number','data-bind-percent','data-bind-src','data-bind-href','data-bind-bg-image','data-bind-color','data-bind-bg-color','data-bind-border-color','data-bind-show','data-bind-hide','data-bind-class'];
      for (var iA2 = 0; iA2 < attrs.length; iA2++) {
        var av = elCov.getAttribute(attrs[iA2]);
        if (av) coveredPaths[av.trim()] = true;
      }
    }
    // data-bind-attr and data-bind-style have comma-separated "key:path" pairs
    var multiBindAttrs = ['data-bind-attr','data-bind-style'];
    var allMulti = document.querySelectorAll('[data-bind-attr],[data-bind-style]');
    for (var iMul = 0; iMul < allMulti.length; iMul++) {
      for (var iMb = 0; iMb < multiBindAttrs.length; iMb++) {
        var mbVal = allMulti[iMul].getAttribute(multiBindAttrs[iMb]);
        if (!mbVal) continue;
        var mbPairs = mbVal.split(',');
        for (var iMp = 0; iMp < mbPairs.length; iMp++) {
          var mbPair = mbPairs[iMp].trim();
          var mbColon = mbPair.indexOf(':');
          if (mbColon >= 0) coveredPaths[mbPair.slice(mbColon + 1).trim()] = true;
        }
      }
    }

    // arbitrary attributes — "key:path, key2:path2"
    nodeList = document.querySelectorAll('[data-bind-attr]');
    for (var iF = 0; iF < nodeList.length; iF++) {
      var elF = nodeList[iF];
      var spec = elF.getAttribute('data-bind-attr') || '';
      var pairs = spec.split(',');
      for (var iFp = 0; iFp < pairs.length; iFp++) {
        var pair = pairs[iFp].trim();
        if (!pair) continue;
        var colon = pair.indexOf(':');
        if (colon < 0) continue;
        var attrName = pair.slice(0, colon).trim();
        var attrPath = pair.slice(colon + 1).trim();
        var attrVal = readPath(sections, attrPath);
        if (typeof attrVal !== 'undefined' && attrVal !== null) {
          elF.setAttribute(attrName, String(attrVal));
        }
      }
    }

    // Inline styles (incl. CSS custom properties) — "prop:path, prop:path"
    // The most common need is per-element CSS variables for theming, e.g.
    // <div data-bind-style="--brand-color:brands.N.accent_color">. The
    // runtime uses element.style.setProperty which works for both standard
    // CSS properties (color, padding, border-radius, ...) and custom
    // properties (--anything). This is what makes per-card brand theming
    // live-update — without it, top-level :root variables update but per-
    // item ones do not, because :root can only hold a single value per name.
    nodeList = document.querySelectorAll('[data-bind-style]');
    for (var iG = 0; iG < nodeList.length; iG++) {
      var elG = nodeList[iG];
      var styleSpec = elG.getAttribute('data-bind-style') || '';
      var stylePairs = styleSpec.split(',');
      for (var iGp = 0; iGp < stylePairs.length; iGp++) {
        var sPair = stylePairs[iGp].trim();
        if (!sPair) continue;
        var sColon = sPair.indexOf(':');
        if (sColon < 0) continue;
        var propName = sPair.slice(0, sColon).trim();
        var propPath = sPair.slice(sColon + 1).trim();
        var propVal = readPath(sections, propPath);
        if (typeof propVal === 'undefined' || propVal === null) continue;
        try {
          elG.style.setProperty(propName, String(propVal));
        } catch (_) { /* invalid property names silently ignored */ }
      }
    }
    // Send ACK to parent window with the set of data paths covered by
    // data-bind-* attributes. The configurator uses this to decide whether
    // a Tier 2 reload is needed: if the just-changed path is not in the
    // covered set, no binding existed for it and a reload is triggered.
    // The ACK also carries a msgId echoed from the incoming message so the
    // configurator can match it to the pending broadcast.
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'skoop:config_ack',
          paths: Object.keys(coveredPaths),
          msgId: window.__skoop_last_msg_id__ || null,
        }, '*');
      }
    } catch (_) { /* cross-origin parent — ACK silently dropped */ }
  }

  // Public API
  window.SkoopLive = {
    apply: function (data) {
      try {
        var sections = data && data.sections ? data.sections : data;
        applyBindings(sections);
      } catch (err) {
        console.warn('[skoop-live] apply failed:', err);
      }
    },
  };

  // Apply on initial page load — two mechanisms depending on context:
  //
  // 1. Dirty data (srcdoc Tier 2 preview): __skoop_dirty_data__ is set before
  //    the page's script runs, so apply it immediately.
  //
  // 2. Normal S3 load: the fetch shim stashes the data.json response in
  //    __skoop_initial_data__. We watch #app-container for the '.loaded' class
  //    (added by init() when it finishes building the DOM) and apply all
  //    data-bind-* bindings at that point — including show/hide initial states.
  //    This is automatic for every app without requiring any app code change.
  function applyFromInjectedOrFetch() {
    if (window.__skoop_dirty_data__) {
      window.SkoopLive.apply(window.__skoop_dirty_data__);
      return;
    }
    
    function applyDataPromise() {
      if (window.__skoop_initial_data__ && typeof window.__skoop_initial_data__.then === 'function') {
        window.__skoop_initial_data__.then(function (data) {
          if (data) window.SkoopLive.apply(data);
        });
      } else if (window.__skoop_initial_data__) {
        window.SkoopLive.apply(window.__skoop_initial_data__);
      }
    }

    // Watch for .loaded class on #app-container to auto-apply initial bindings
    // once the app's async init() has finished building the DOM.
    var appEl = document.getElementById('app-container');
    if (!appEl) return;
    // Already loaded (e.g. synchronous init)
    if (appEl.classList.contains('loaded')) {
      applyDataPromise();
      return;
    }
    var loadedObs = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        if (mutations[m].target.classList && mutations[m].target.classList.contains('loaded')) {
          loadedObs.disconnect();
          applyDataPromise();
          return;
        }
      }
    });
    loadedObs.observe(appEl, { attributes: true, attributeFilter: ['class'] });
  }

  // Run after the page's main script has had a chance to build the DOM
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(applyFromInjectedOrFetch, 0);
  } else {
    document.addEventListener('DOMContentLoaded', applyFromInjectedOrFetch);
  }

  // Listen for postMessage updates from the parent configurator
  window.addEventListener('message', function (e) {
    if (!e || !e.data || typeof e.data !== 'object') return;
    if (e.data.type !== 'skoop:config_update') return;
    var payload = e.data.data;
    if (!payload) return;
    // Store msgId so applyBindings can echo it in the ACK
    window.__skoop_last_msg_id__ = e.data.msgId || null;
    // Store live data so the MutationObserver can re-apply it when the app's
    // own timer loop reverts our changes (e.g. a clock's setInterval writing
    // style.display from the original closed-over data object every second).
    _liveData = payload;
    // Arm the guard BEFORE applying so observer callbacks triggered by our
    // own DOM writes (delivered as microtasks) see the flag set and skip.
    _applyingLiveData = true;
    window.SkoopLive.apply(payload);
    // Defer clearing the flag past the current microtask batch.
    var clearFlag = function () { _applyingLiveData = false; };
    if (typeof Promise !== 'undefined') {
      Promise.resolve().then(clearFlag);
    } else {
      setTimeout(clearFlag, 0);
    }
    // Start the observer (no-op if already running).
    activateLiveObserver();

    // ── Visibility safety check ───────────────────────────────────────────────
    // After applying show/hide bindings, verify that each element that should
    // be visible actually IS visible. If not, a parent element is blocking it
    // (e.g. app's init() set the container to display:none based on the original
    // data). Since the runtime can't reach parent elements without a binding,
    // request a full Tier 2 reload from the builder so the page re-initializes
    // from the dirty data correctly (intervals started, containers shown, etc.).
    //
    // Detection: el.offsetParent === null whenever the element OR any ancestor
    // has display:none. Since applyBindings already set el.style.display='' and
    // removed hidden on the element itself, offsetParent===null means a PARENT
    // is blocking it. Exception: position:fixed always has null offsetParent
    // even when visible — guard with a getComputedStyle(position) check.
    //
    // Note: getComputedStyle(el).display is NOT suitable here — it returns the
    // element's own display value (e.g. "inline"), not parent cascade visibility.
    // offsetParent correctly reflects ancestor display:none.
    //
    // Only runs on direct postMessage updates (not MutationObserver re-applies).
    // Hiding always succeeds (inline display:none wins over parents), so only
    // "should be shown" elements need the check.
    try {
      if (window.parent && window.parent !== window) {
        var sections = payload.sections || payload;
        var showEls = document.querySelectorAll('[data-bind-show]');
        for (var iV = 0; iV < showEls.length; iV++) {
          var elV = showEls[iV];
          var valV = readPath(sections, elV.getAttribute('data-bind-show'));
          var shouldShowV = !(valV === 'false' || valV === false || valV === 0 || valV === null || valV === undefined);
          if (shouldShowV && elV.offsetParent === null) {
            // offsetParent===null on a "should show" element means an ancestor has
            // display:none. Exclude position:fixed (legitimate null offsetParent).
            var csV = window.getComputedStyle ? window.getComputedStyle(elV) : null;
            if (!csV || (csV.display !== 'none' && csV.position !== 'fixed')) {
              window.parent.postMessage({ type: 'skoop:request_tier2' }, '*');
              break; // one request is enough; the reload will fix all elements
            }
          }
        }
      }
    } catch (_) { /* offsetParent or postMessage unavailable — skip check */ }
  });
})();
