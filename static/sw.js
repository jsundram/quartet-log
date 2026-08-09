// Service worker: offline app shell.
//
// This is a TEMPLATE. scripts/gen_sw.mjs (run by build.sh --prod) writes the
// deployable copy, substituting two tokens: the version placeholder inside
// `const V` becomes "ql-<hash>" — a hash over the CONTENT of every precached
// asset (it doubles as the cache name) — and the placeholder entry in SHELL
// becomes the precache list, generated from the deploy directory's actual
// contents.
//
// Because V covers every asset, ANY deploy that changes anything — code, CSS,
// catalog data, an icon, the manifest — produces a new V, which evicts the
// stale cache on `activate`. No hand-bumped version constant, no
// hand-maintained file list to forget. It also writes version.json next to
// sw.js so clients can probe the deployed version without parsing this file.
//
// Dev builds don't emit this file; app.js only registers a SW off localhost, so
// esbuild's live-reload server is never intercepted.

const V = "__SW_VERSION__";

// Everything the app needs to boot offline — generated from the deploy
// directory's contents, so nothing the build emits can be missing from it.
// Cross-origin data (the published Google Sheets CSV) is deliberately never
// precached — it passes straight to the network and the app does its own
// stale-while-revalidate against localStorage.
const SHELL = ["__SW_SHELL__"];

// Top-up-and-verify the precache: add whatever SHELL entries cache V is
// missing, then report whether the shell is now complete. allSettled +
// individual adds keep one failed file (say about.html on a build that didn't
// emit it) from aborting the rest the way cache.addAll would — but that
// forfeits addAll's atomicity, so activate only collects the previous
// generation once this reports true (hand-ported from pwa-starter dd763ca's
// offline family: per-file precache must land together with
// repair-before-collect + a gated collect). Without the gate, a flaky-network
// install could leave a partial shell AND destroy the last complete one — the
// installed-PWA, offline-cold, missing-bundle blank-app case.
async function ensureShell() {
  const c = await caches.open(V);
  const missing = [];
  for (const u of SHELL) if (!(await c.match(u))) missing.push(u);
  if (missing.length) {
    await Promise.allSettled(missing.map(u => c.add(new Request(u, { cache: "reload" }))));
    for (const u of missing) if (!(await c.match(u))) return false;
  }
  return true;
}

self.addEventListener("install", e => {
  // skipWaiting even when incomplete: the new SW may take over, because old
  // cache generations survive until the shell verifies complete (below) and
  // caches.match() spans all of them — offline keeps working off the previous
  // shell in the meantime.
  e.waitUntil(ensureShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  // Repair-before-collect: retry whatever install couldn't fetch, and evict
  // other generations only once the new shell verifies complete. While it
  // doesn't, the old caches stay on as the offline fallback; online traffic
  // tops up cache V per-request (cachePut) and forceUpdate clears everything,
  // so a lingering extra generation is bounded and harmless.
  e.waitUntil(
    ensureShell()
      .then(complete => complete
        ? caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
        : undefined)
      .then(() => self.clients.claim())
  );
});

// Bound every network wait: fetch() only rejects on a REAL network
// failure, so on "lie-fi" (a slow-but-alive link — weak cell signal, a
// half-answering captive portal) it just hangs, and an unbounded network-first
// respondWith() hangs with it — WebKit paints a blank page, no error, while
// truly-offline works fine (fast rejection → cache fallback). Hand-ported from
// pwa-starter 77fcb35: its sw.js went cache-first, but this app keeps
// network-first ON PURPOSE (a fresh deploy shows on the next reload, and the
// content-hashed V makes that the natural freshness path) — so the fix here is
// the bounds and the never-undefined contract, not the strategy.
//   WARM (3s): after this, if the cache can answer, serve it — a slightly
//     stale page beats waiting on a dead-slow link.
//   COLD (15s total): nothing cached (first run, or an evicted cache) — the
//     network is the only real answer, so give it longer, but never forever:
//     the floor is offlineFallback()'s honest page, not a permanent blank.
const NET_TIMEOUT_MS = 3000;
const NET_TIMEOUT_COLD_MS = 15000;

// Reject `promise` if it hasn't settled within `ms`. The underlying fetch is
// untouched — racing a timer against it doesn't abort it — so the caller keeps
// it alive under waitUntil. clearTimeout on settle so a resolved fetch doesn't
// hold a pending timer (and the SW) awake for the rest of the window.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("network timeout")), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// Cache-write gate (pwa-starter's 2ed87e9 fix, previously missing here): a 404
// or a mid-deploy 502 is a RESOLVED fetch, so the old ungated put() overwrote a
// good cached copy with an error body that then survived as the offline
// fallback until the next deploy. Redirected responses can't satisfy a
// navigation, and put() throws on a 206. (Same-origin only reaches this —
// cross-origin returned early — so no opaque-response exemption is needed.)
function cachePut(req, resp) {
  if (!resp.ok || resp.redirected || resp.status === 206) return;
  const copy = resp.clone();
  caches.open(V).then(c => c.put(req, copy)).catch(() => {});
}

// ignoreSearch lets the precached all_works.json satisfy the app's versioned
// all_works.json?v=<hash> request. Never rejects — this runs inside the offline
// catch, the last stop before offlineFallback(), and a throw there escapes as a
// rejected respondWith(): the same blank screen this file exists to prevent.
function cacheMatch(req) {
  return caches.match(req, { ignoreSearch: true }).catch(() => undefined);
}

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);

  // cache.put() rejects for anything but GET, and a form POST is
  // mode === "navigate" — it must not walk into the live branch.
  if (e.request.method !== "GET") return;

  // Cross-origin (the published Google Sheet, quartetroulette.com links, …):
  // straight to network, never touch the cache.
  if (u.origin !== location.origin) return;

  // Never intercept or cache the SW script itself or version.json. The update
  // check probes them (no-store) to read the live version off the server;
  // interception would hand back a previously-cached copy and the check would
  // never see a new deploy. Let both always go straight to network.
  if (u.pathname.endsWith("/sw.js") || u.pathname.endsWith("/version.json")) return;

  // Same-origin JSON (the work catalogs): stale-while-revalidate, ported from
  // pwa-starter e88a743. Boot blocks on these files before first paint, and a
  // cached copy is correct by construction — all_works.json is
  // content-addressed (?v=<hash>, satisfied via ignoreSearch from the bare
  // precached entry) and V hashes every asset — so serve the cache instantly
  // (a cold boot on lie-fi skips the warm bound entirely) and refresh in the
  // background. The refresh writes under the BARE pathname so it replaces the
  // precached entry; stored under ?v=<hash> it would lose every future
  // ignoreSearch match to the older bare entry and pile up per-hash copies.
  if (u.pathname.endsWith(".json")) {
    e.respondWith((async () => {
      const cached = await cacheMatch(e.request);
      const net = fetch(e.request).then(resp => { cachePut(u.origin + u.pathname, resp); return resp; });
      if (cached) {
        e.waitUntil(net.catch(() => {}));
        return cached;
      }
      try {
        // Nothing cached (first run, or an evicted cache): the network is the
        // only real answer — cold-bounded like the live branch, never a hang.
        return await withTimeout(net, NET_TIMEOUT_COLD_MS);
      } catch {
        e.waitUntil(net.catch(() => {}));
        return offlineFallback(e.request);
      }
    })());
    return;
  }

  // HTML + navigations are network-first so a fresh deploy shows up the
  // moment you're online; they fall back to cache offline. Content-hashed
  // JS/CSS and images are immutable, so they're cache-first for speed.
  const live = e.request.mode === "navigate" || u.pathname.endsWith("/") || u.pathname.endsWith(".html");

  if (live) {
    e.respondWith((async () => {
      const net = fetch(e.request).then(resp => {
        cachePut(e.request, resp);
        // An error response is still a RESOLVED fetch: prefer a good cached
        // copy over handing the app an error body. (status 0 with type
        // "opaqueredirect" is a navigation's redirect:"manual" fetch seeing a
        // healthy 301 — the browser must get it back to follow it, so it is
        // NOT an error here.)
        if (!resp.ok && resp.type !== "opaqueredirect") {
          return cacheMatch(e.request).then(r => r || resp);
        }
        return resp;
      });
      try {
        return await withTimeout(net, NET_TIMEOUT_MS);   // warm bound
      } catch {
        // Timeout or offline. Park the fetch (a timeout doesn't abort it) so a
        // late success still lands in the cache for next time, and its
        // rejection is swallowed instead of leaking.
        e.waitUntil(net.catch(() => {}));
        const cached = await cacheMatch(e.request)
          || (e.request.mode === "navigate" ? await cacheMatch("./index.html") : null);
        if (cached) return cached;
        try {
          // Nothing cached: the network is the only real answer — wait out the
          // rest of the cold bound, then end at a REAL Response. Never a hang,
          // never undefined: WebKit paints a blank page for both.
          return await withTimeout(net, NET_TIMEOUT_COLD_MS - NET_TIMEOUT_MS);
        } catch {
          return offlineFallback(e.request);
        }
      }
    })());
  } else {
    e.respondWith(
      cacheMatch(e.request).then(r => {
        if (r) return r;
        const net = fetch(e.request).then(resp => { cachePut(e.request, resp); return resp; });
        // Bounded like the live branch's cold path: a cache miss means the network is the only
        // real answer, but the hang matters MORE here than for the skeleton this is ported
        // from — content-hashed bundles route through this branch, so a fresh index.html can
        // reference a new bundle-<hash>.js that isn't cached yet, and on lie-fi that script
        // fetch hanging is a blank app with the HTML already painted. Fail visibly (504) so
        // the page's own error handling gets a turn; a late success still lands in the cache.
        return withTimeout(net, NET_TIMEOUT_COLD_MS)
          .catch(() => { e.waitUntil(net.catch(() => {})); return offlineFallback(e.request); });
      })
    );
  }
});

// Terminal fallback: always a real Response, never undefined (resolving
// respondWith() to undefined fails the navigation in WebKit — "Returned
// response is null" — and iOS paints a blank white screen). Navigations get a
// readable page; subresources get a plain 504 so a script request fails
// cleanly instead of parsing HTML. CSS is inline and colors are hardcoded on
// purpose: this page renders precisely when the cached stylesheet isn't there.
function offlineFallback(req) {
  if (req.mode !== "navigate") {
    return new Response("", { status: 504, statusText: "Offline" });
  }
  return new Response(
    `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Offline — musiclog</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#fafafa;color:#222;font:16px/1.5 system-ui,-apple-system,sans-serif}
  main{max-width:22em;padding:2em;text-align:center}
  h1{font-size:1.15em;margin:0 0 .6em}
  p{margin:.6em 0;color:#555}
  button{margin-top:1.2em;border:0;border-radius:999px;padding:.7em 1.3em;
         background:#333;color:#fff;font-size:1em;cursor:pointer}
  @media (prefers-color-scheme:dark){ body{background:#1a1a1a;color:#eee} p{color:#aaa}
                                      button{background:#555} }
</style>
<main>
  <h1>Offline, and nothing cached yet</h1>
  <p>The offline copy of musiclog hasn't been stored on this device — or the system reclaimed
     it to free up space.</p>
  <p>Open it once with a connection and it will rebuild itself for offline use.</p>
  <button onclick="location.reload()">Try again</button>
</main>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
