// Service worker: offline app shell.
//
// This is a TEMPLATE. build.sh (--prod only) copies it to the deploy root and
// substitutes three tokens with the content-hashed filenames produced by that
// build:
//   __SW_VERSION__  → "ql-<bundlehash>-<csshash>" (the cache name)
//   __BUNDLE_JS__   → bundle-<hash>.js
//   __CSS_FILE__    → viz-<hash>.css
//
// Because the hashes change whenever the code, the CSS, or the catalog data
// change (the catalog version is baked into bundle.js via esbuild --define, so
// a data change changes the bundle hash too), V changes on every meaningful
// deploy. A new V is what evicts the stale cache on `activate` — so there's no
// hand-bumped version constant to forget: the build's content hashes drive it.
//
// Dev builds don't emit this file; app.js only registers a SW off localhost, so
// esbuild's live-reload server is never intercepted.

const V = "__SW_VERSION__";

// Everything the app needs to boot offline. Cross-origin data (the Google
// Sheets CSV) is deliberately NOT here — it passes straight to the network and
// the app does its own stale-while-revalidate against localStorage.
const SHELL = [
  "./", "./index.html",
  "./__BUNDLE_JS__", "./__CSS_FILE__",
  "./d3.v7.min.js",
  "./all_works.json", "./haydn_peters.json",
  "./about.html",
  "./site.webmanifest",
  "./apple-touch-icon.png", "./favicon-32x32.png", "./favicon-16x16.png",
  "./android-chrome-192x192.png", "./android-chrome-512x512.png", "./maskable-512x512.png",
];

self.addEventListener("install", e => {
  // allSettled + individual adds: a single missing optional file (say about.html
  // on a build that didn't emit it) must not abort the whole precache the way
  // cache.addAll would.
  e.waitUntil(
    caches.open(V)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);

  // Cross-origin (the published Google Sheet, quartetroulette.com links, …):
  // straight to network, never touch the cache.
  if (u.origin !== location.origin) return;

  // Never intercept or cache the SW script itself. app.js's update check probes
  // ./sw.js?_=<ts> (no-store) to read the live version off the server; because
  // .js is otherwise cache-first with ignoreSearch below, a probe would get a
  // previously-cached sw.js served back and the version check would never see a
  // new deploy. Let it always go straight to network.
  if (u.pathname.endsWith("/sw.js")) return;

  // HTML + JSON + navigations are network-first so a fresh deploy or a fresh
  // catalog shows up the moment you're online; they fall back to cache offline.
  // ignoreSearch lets the precached all_works.json satisfy the app's
  // versioned all_works.json?v=<hash> request. Content-hashed JS/CSS and images
  // are immutable, so they're cache-first for speed.
  const live = e.request.mode === "navigate" || u.pathname.endsWith("/") || /\.(html|json)$/.test(u.pathname);

  if (live) {
    e.respondWith(
      fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(V).then(c => c.put(e.request, copy));
        return resp;
      }).catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("./index.html"))
      )
    );
  } else {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(V).then(c => c.put(e.request, copy));
        return resp;
      }))
    );
  }
});
