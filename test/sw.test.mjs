// Behavioral tests for static/sw.js — the offline / "lie-fi" contract added with the
// pwa-starter 77fcb35 hand-port: the network-first live branch is BOUNDED (warm 3s / cold 15s),
// respondWith() never resolves undefined or hangs, and cache writes are gated on resp.ok.
//
// Loads the TEMPLATE unmodified (the __SW_VERSION__/__BUNDLE_JS__ tokens are just strings here)
// under mocked SW globals and a FAKE clock, so the timeout bounds run deterministically and
// instantly. Runs under the repo's usual harness:  npm test  (node --test test/*.mjs).
// A hung handler shows up as a failed test: node's runner fails tests still pending when the
// event loop drains.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---- fake clock ------------------------------------------------------------
let now = 0;
let nextTimer = 1;
const timers = new Map();
const fakeSetTimeout = (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + (ms || 0), fn }); return id; };
const fakeClearTimeout = (id) => { timers.delete(id); };
const flush = async (n = 60) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
async function tick(ms) {
  const target = now + ms;
  await flush();
  for (;;) {
    let dueId = null, dueAt = Infinity;
    for (const [id, t] of timers) if (t.at <= target && t.at < dueAt) { dueId = id; dueAt = t.at; }
    if (dueId === null) break;
    const t = timers.get(dueId);
    timers.delete(dueId);
    now = t.at;
    t.fn();
    await flush();
  }
  now = target;
  await flush();
}

// ---- mocked SW environment -------------------------------------------------
const BASE = "https://viz.runningwithdata.com/musiclog/";
const b = (p) => BASE + p;

let fetchMode = "ok";        // "ok" | "slow" | "offline" | "redirect" | "late"
let fetchStatus = 200;
let fetchProps = {};         // extra response props for "ok" mode (redirected, type, …)
let lateResolve = null;      // "late" mode: settles the pending fetch on demand
let fetchCalls = 0;
const CACHE = new Map();     // url (search stripped) -> response; models ignoreSearch matching

const makeResponse = (body, { status = 200, redirected = false, type = "basic" } = {}) => ({
  _body: body, status, ok: status >= 200 && status < 300, redirected, type,
  clone() { return makeResponse(body, { status, redirected, type }); },
});
const keyOf = (r) => {
  const u = new URL(typeof r === "string" ? r : r.url, self.location);
  return u.origin + u.pathname + u.search;            // full URL; ignoreSearch is an OPTION, below
};
const stripSearch = (k) => k.split("?")[0];
// Honors the options argument the way the real Cache API does, so the suite genuinely pins that
// the source passes { ignoreSearch: true } — a mock that always ignored the query would stay
// green if that option were dropped from cacheMatch().
const matchIn = (store, r, opts) => {
  const k = keyOf(r);
  if (store.has(k)) return store.get(k);
  if (opts && opts.ignoreSearch) {
    const base = stripSearch(k);
    for (const [key, v] of store) if (stripSearch(key) === base) return v;
  }
  return undefined;
};
const req = (url, mode = "no-cors") => ({ url, method: "GET", mode });

const self = {
  location: new URL(BASE + "sw.js"),
  registration: {},
  clients: { claim: async () => {} },
  skipWaiting: async () => {},
  _listeners: {},
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
};
const location = self.location;
const ResponseCtor = function (body, init = {}) { return makeResponse(body, { status: init.status || 200 }); };

const cacheApi = {
  async match(r, opts) { return matchIn(CACHE, r, opts); },
  async put(r, resp) { CACHE.set(keyOf(r), resp); },
};
const caches = {
  async open() { return cacheApi; },
  async match(r, opts) { return matchIn(CACHE, r, opts); },
  async keys() { return ["ql-testhash-testcss"]; },
  async delete() { return true; },
};
const fetchImpl = async (r) => {
  fetchCalls++;
  if (fetchMode === "offline") throw new Error("offline");
  if (fetchMode === "slow") return new Promise(() => {});   // never settles → only a timeout ends it
  if (fetchMode === "late") return new Promise((res) => { lateResolve = res; });   // settles when the test says so
  if (fetchMode === "redirect") return makeResponse("", { status: 0, type: "opaqueredirect" });
  return makeResponse("NET:" + keyOf(r), { status: fetchStatus, ...fetchProps });
};

// ---- load the template under those globals ---------------------------------
const src = readFileSync(new URL("../static/sw.js", import.meta.url), "utf8");
new Function("self", "location", "caches", "fetch", "Response", "URL", "setTimeout", "clearTimeout", src)(
  self, location, caches, fetchImpl, ResponseCtor, URL, fakeSetTimeout, fakeClearTimeout,
);
const fetchHandler = self._listeners.fetch[0];

function start(request) {
  let settle;
  const done = new Promise((res) => (settle = res));
  fetchHandler({ request, respondWith: (p) => Promise.resolve(p).then(settle), waitUntil() {} });
  return done;
}
async function intercepts(request) {
  let called = false;
  fetchHandler({ request, respondWith: () => { called = true; }, waitUntil() {} });
  await flush();
  return called;
}
const bodyOf = (r) => (r ? (r._body ?? "(generated page)") : "(undefined!)");
const isPending = async (p) => (await Promise.race([p.then(() => false), flush().then(() => true)]));

beforeEach(() => { CACHE.clear(); fetchMode = "ok"; fetchStatus = 200; fetchProps = {}; lateResolve = null; fetchCalls = 0; now = 0; timers.clear(); });

// ---- the network-first happy path ------------------------------------------
test("online nav → network response (network-first kept on purpose)", async () => {
  const r = await start(req(BASE, "navigate"));
  assert.equal(bodyOf(r), "NET:" + BASE);
  assert.equal(fetchCalls, 1);
});

test("a 404 does not poison the cache, and the cached copy is served instead", async () => {
  CACHE.set(keyOf(b("about.html")), makeResponse("GOOD_ABOUT"));
  fetchStatus = 404;
  const r = await start(req(b("about.html"), "navigate"));
  assert.equal(bodyOf(r), "GOOD_ABOUT");                      // cached copy, not the error body
  assert.equal(bodyOf(CACHE.get(keyOf(b("about.html")))), "GOOD_ABOUT");   // write was gated
});

test("online nav + 301 → opaqueredirect passed through for the browser to follow", async () => {
  fetchMode = "redirect";
  const r = await start(req(b("wrapped"), "navigate"));
  assert.equal(r.type, "opaqueredirect");
});

// ---- offline (fast rejection) ----------------------------------------------
test("offline nav with a cached page → cached copy", async () => {
  fetchMode = "offline";
  CACHE.set(keyOf(BASE), makeResponse("CACHED_ROOT"));
  const r = await start(req(BASE, "navigate"));
  assert.equal(bodyOf(r), "CACHED_ROOT");
});

test("offline nav, page uncached → index.html shell fallback", async () => {
  fetchMode = "offline";
  CACHE.set(keyOf(b("index.html")), makeResponse("CACHED_INDEX"));
  const r = await start(req(b("some-view"), "navigate"));
  assert.equal(bodyOf(r), "CACHED_INDEX");
});

test("offline nav, NOTHING cached → real offline page, never undefined", async () => {
  fetchMode = "offline";
  const r = await start(req(BASE, "navigate"));
  assert.equal(r.status, 503);
});

test("offline uncached json subresource → real 504, never undefined", async () => {
  fetchMode = "offline";
  const r = await start(req(b("haydn_peters.json")));
  assert.equal(r.status, 504);
});

test("ignoreSearch: precached all_works.json answers the versioned request offline", async () => {
  fetchMode = "offline";
  CACHE.set(keyOf(b("all_works.json")), makeResponse("CACHED_WORKS"));
  const r = await start(req(b("all_works.json?v=abc123")));
  assert.equal(bodyOf(r), "CACHED_WORKS");
});

// ---- catalog JSON: stale-while-revalidate (pwa-starter e88a743) -------------
// Boot blocks on these files before first paint; a cached copy is correct by
// construction (V hashes every asset), so it's served instantly — no warm-bound
// wait on lie-fi — with a background refresh keyed by the bare pathname.
test("cached catalog JSON on lie-fi → served instantly, revalidation still fired", async () => {
  fetchMode = "slow";
  CACHE.set(keyOf(b("all_works.json")), makeResponse("CACHED_WORKS"));
  const r = await start(req(b("all_works.json?v=abc123")));   // no tick(): zero timer waits
  assert.equal(bodyOf(r), "CACHED_WORKS");
  assert.equal(fetchCalls, 1, "background revalidation must still hit the network");
});

test("JSON revalidation replaces the precached entry under the bare pathname", async () => {
  CACHE.set(keyOf(b("all_works.json")), makeResponse("STALE_WORKS"));
  const r = await start(req(b("all_works.json?v=new")));
  assert.equal(bodyOf(r), "STALE_WORKS");                     // this load: the cached copy
  await flush();
  assert.equal(                                               // next load: the fresh one
    bodyOf(CACHE.get(keyOf(b("all_works.json")))),
    "NET:" + keyOf(b("all_works.json?v=new")));
  assert.equal(CACHE.has(keyOf(b("all_works.json?v=new"))), false,
    "stored under ?v= it would lose every ignoreSearch match to the bare entry");
});

test("uncached JSON on lie-fi → cold-bounded 504, not a hang", async () => {
  fetchMode = "slow";
  const p = start(req(b("haydn_peters.json")));
  await tick(14999);
  assert.equal(await isPending(p), true, "cold bound applies — nothing cached to serve earlier");
  await tick(2);
  assert.equal((await p).status, 504);
});

// ---- lie-fi: the bounds this port exists for -------------------------------
test("warm lie-fi nav → cached copy at the 3s bound, not a hang", async () => {
  fetchMode = "slow";
  CACHE.set(keyOf(BASE), makeResponse("CACHED_ROOT"));
  const p = start(req(BASE, "navigate"));
  await tick(2999);
  assert.equal(await isPending(p), true, "must still be waiting on the network just before 3s");
  await tick(2);
  assert.equal(bodyOf(await p), "CACHED_ROOT");
});

test("cold lie-fi nav → bounded at 15s total, honest fallback", async () => {
  fetchMode = "slow";
  const p = start(req(BASE, "navigate"));
  await tick(14999);
  assert.equal(await isPending(p), true, "cold path gets the full 15s");
  await tick(2);
  assert.equal((await p).status, 503);
});

// ---- immutable assets (else branch) ----------------------------------------
test("cached content-hashed bundle → cache-first, 0 fetches", async () => {
  fetchMode = "slow";
  CACHE.set(keyOf(b("bundle-abc.js")), makeResponse("CACHED_BUNDLE"));
  const r = await start(req(b("bundle-abc.js")));
  assert.equal(bodyOf(r), "CACHED_BUNDLE");
  assert.equal(fetchCalls, 0);
});

test("uncached asset offline → real 504", async () => {
  fetchMode = "offline";
  const r = await start(req(b("favicon-32x32.png")));
  assert.equal(r.status, 504);
});

// The cache-miss fetch in this branch is bounded too: content-hashed bundles live here, so a
// fresh index.html referencing a not-yet-cached bundle-<hash>.js on lie-fi must fail visibly
// (blank-app-with-painted-HTML was the one remaining unbounded path).
test("uncached bundle + lie-fi → bounded 504 at 15s, not a hang", async () => {
  fetchMode = "slow";
  const p = start(req(b("bundle-new.js")));
  await tick(14999);
  assert.equal(await isPending(p), true, "cold bound applies — no cached copy to serve earlier");
  await tick(2);
  assert.equal((await p).status, 504);
});

// ---- the remaining cachePut gates + the parked-fetch claim ------------------
test("redirected response is served but not cached", async () => {
  fetchProps = { redirected: true };
  const r = await start(req(b("photo.png")));
  assert.equal(r.redirected, true);
  await flush();
  assert.equal(CACHE.has(keyOf(b("photo.png"))), false);
});

test("206 partial is served but not cached (resp.ok is true for a 206)", async () => {
  fetchStatus = 206;
  const r = await start(req(b("photo.png")));
  assert.equal(r.status, 206);
  await flush();
  assert.equal(CACHE.has(keyOf(b("photo.png"))), false);
});

test("late lie-fi success still lands in the cache (the parked fetch)", async () => {
  fetchMode = "late";
  const p = start(req(b("some-view"), "navigate"));
  await tick(15001);
  assert.equal((await p).status, 503);                       // timed out to the offline page...
  lateResolve(makeResponse("LATE_BODY", { status: 200 }));   // ...then the network finally answers
  await flush();
  assert.equal(bodyOf(CACHE.get(keyOf(b("some-view")))), "LATE_BODY");
});

// ---- pass-throughs ----------------------------------------------------------
test("sw.js version probe → not intercepted", async () => {
  assert.equal(await intercepts(req(b("sw.js?_=123"))), false);
});

test("POST → not intercepted", async () => {
  assert.equal(await intercepts({ url: BASE, method: "POST", mode: "navigate" }), false);
});
