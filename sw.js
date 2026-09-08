'use strict';

const CACHE_NAME = 'skoop-app-aigen-1788897558586';

const NETWORK_ONLY_HOSTS = [
  'timeapi.io',
  'worldtimeapi.org',
  'api.openweathermap.org',
  'openweathermap.org',
  'api.weatherapi.com',
  'wttr.in',
];

// ---------------------------------------------------------------------------
// Refresh window: when refresh=true is seen on any request, all subsequent
// fetches for the next 10 seconds also bypass cache. This cascades refresh
// from index.html to all sub-resources (data.json, CSS, images, etc.)
// without relying on Referer headers which are unreliable in iframes.
// ---------------------------------------------------------------------------
let refreshWindowUntil = 0;

function isInRefreshWindow() {
  return Date.now() < refreshWindowUntil;
}

function startRefreshWindow() {
  refreshWindowUntil = Date.now() + 10000; // 10 second window
}

function isNetworkOnly(url) {
  try {
    const host = new URL(url).hostname;
    return NETWORK_ONLY_HOSTS.some(h => host.includes(h));
  } catch (_) {
    return false;
  }
}

function isIndexHtml(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' || u.pathname.endsWith('/index.html');
  } catch (_) {
    return false;
  }
}

function hasRefreshParam(url) {
  try {
    return new URL(url).searchParams.get('refresh') === 'true';
  } catch (_) {
    return false;
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('refresh');
    u.searchParams.delete('ts');
    u.searchParams.delete('_cb');
    return u.toString();
  } catch (_) {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Install — pre-cache index.html only. All other assets are cached on first fetch.
// ---------------------------------------------------------------------------
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.add('./index.html')).catch(() => {})
  );
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Activate — delete any caches from previous deployments of this app.
// ---------------------------------------------------------------------------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('skoop-app-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ---------------------------------------------------------------------------
// Fetch
//
// Strategy priority:
//   1. Non-GET requests            — pass through unchanged
//   2. Network-only hosts          — always fetch from network, never cache
//   3. ?refresh=true (or window)   — bust cache entry, fetch fresh, re-cache
//   4. index.html                  — network-first (picks up new deployments)
//   5. Everything else             — cache-first, fallback to network then cache
// ---------------------------------------------------------------------------
self.addEventListener('fetch', event => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = request.url;

  // 1. Network-only (live data APIs — never cache)
  if (isNetworkOnly(url)) {
    event.respondWith(fetch(request));
    return;
  }

  // 2. ?refresh=true OR inside refresh window — bust cache, fetch fresh, re-cache
  const explicitRefresh = hasRefreshParam(url);
  if (explicitRefresh || isInRefreshWindow()) {
    // If this is the explicit refresh=true request, start the window
    // so all subsequent sub-resource fetches also get refreshed
    if (explicitRefresh) startRefreshWindow();

    const normalized = normalizeUrl(url);
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        await cache.delete(normalized);
        try {
          // cache: 'no-store' bypasses the browser's HTTP cache so we
          // actually hit the server, not a stale HTTP-cached S3 response
          const fresh = await fetch(normalized, { cache: 'no-store' });
          if (fresh.ok) await cache.put(normalized, fresh.clone());
          return fresh;
        } catch (_) {
          const cached = await cache.match(normalized);
          return cached || new Response('Offline', { status: 503 });
        }
      })
    );
    return;
  }

  // 3. index.html — network-first so new deployments are picked up immediately
  if (isIndexHtml(url)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // 4. All other assets — cache-first
  const normalizedUrl = normalizeUrl(url);
  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(normalizedUrl);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(normalizedUrl, response.clone());
        return response;
      } catch (_) {
        return new Response('Offline', { status: 503 });
      }
    })
  );
});
