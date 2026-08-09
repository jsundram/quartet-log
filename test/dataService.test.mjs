// Tests for the DataService localStorage cache machinery (and the
// urlConfig cache-clearing that pairs with it): quota-exhaustion handling,
// corrupt/misshapen cache reads, the single-envelope cache format with
// backward compatibility for the legacy two-key format, and precise
// clearCachedData key matching.
//
// localStorage is stubbed with a Map-backed object on globalThis — both
// modules read it at call time, never at import time, so installing the stub
// in beforeEach is sufficient. Runs under the repo's usual harness:
// npm test  (node --test test/*.mjs). Fixture rows use placeholder names
// (Alice/Bob/Carol) per repo convention — never real names.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { DataService } from "../src/dataService.js";
import {
    setDataUrl,
    clearCachedData,
    isValidGoogleSheetsUrl,
} from "../src/urlConfig.js";

// ---- localStorage stub -----------------------------------------------------
function makeLocalStorage() {
    const map = new Map();
    return {
        _map: map,
        throwOnSet: false,          // flip to simulate quota exhaustion
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) {
            if (this.throwOnSet) {
                throw new Error("QuotaExceededError (simulated)");
            }
            map.set(k, String(v));
        },
        removeItem(k) { map.delete(k); },
        clear() { map.clear(); },
        key(i) { return [...map.keys()][i] ?? null; },
        get length() { return map.size; },
    };
}

const SHEET_URL =
    "https://docs.google.com/spreadsheets/d/e/FIXTURE/pub?gid=0&single=true&output=csv";
const TS_KEY = `${SHEET_URL}_timestamp`;

// Rows in the shape the cache stores (post-processRow, JSON round-tripped:
// row.timestamp serializes as an ISO string and is rehydrated on read).
const ROWS = [
    { timestamp: "2026-01-05T19:00:00.000Z", composer: "HAYDN", work: "64/3",
      part: "V1", player1: "Alice", player2: "Bob", player3: "Carol" },
    { timestamp: "2026-01-06T19:00:00.000Z", composer: "MOZART", work: "K. 421",
      part: "V2", player1: "Alice", player2: "Bob", player3: "Carol" },
];

let ls;
beforeEach(() => {
    ls = makeLocalStorage();
    globalThis.localStorage = ls;
    setDataUrl(SHEET_URL);
    ls.throwOnSet = false;
});

// Rows "fetched from the network": same content, but timestamp is a Date, as
// processRow produces. JSON.stringify(fetched) === JSON.stringify(ROWS).
const fetchedRows = () => ROWS.map(r => ({ ...r, timestamp: new Date(r.timestamp) }));
const service = (rows = fetchedRows()) =>
    new DataService({ fetchRows: async () => rows });

// ---- quota exhaustion ------------------------------------------------------

test("fetchFresh: quota failure does not crash and signals staleness", async () => {
    ls.throwOnSet = true;
    const result = await service().fetchFresh();
    assert.equal(result.source, "fresh");
    assert.equal(result.cacheWriteFailed, true);   // the visible-staleness signal
    assert.equal(result.parsed.length, 2);         // fresh data still delivered
    assert.equal(ls.getItem(SHEET_URL), null);     // nothing (torn) was persisted
});

test("fetchFresh: successful write reports cacheWriteFailed false", async () => {
    const result = await service().fetchFresh();
    assert.equal(result.cacheWriteFailed, false);
});

test("fetchCSV: quota failure still resolves fresh, with the staleness flag", async () => {
    ls.throwOnSet = true;
    const result = await service().fetchCSV();
    assert.equal(result.source, "fresh");
    assert.equal(result.cacheWriteFailed, true);
});

// ---- readCache robustness --------------------------------------------------

test("readCache: corrupt JSON behaves as no cache", () => {
    ls.setItem(SHEET_URL, "{not json");
    assert.equal(service().readCache(), null);
});

test("readCache: valid-JSON-but-not-a-cache shapes behave as no cache", () => {
    for (const junk of ['"a string"', "42", "{}", '{"data": "not an array"}']) {
        ls.setItem(SHEET_URL, junk);
        assert.equal(service().readCache(), null, `shape: ${junk}`);
    }
});

test("readCache: legacy two-key format still loads", () => {
    const ts = Date.parse("2026-02-01T00:00:00Z");
    ls.setItem(SHEET_URL, JSON.stringify(ROWS));
    ls.setItem(TS_KEY, String(ts));

    const result = service().readCache();
    assert.equal(result.source, "cache");
    assert.equal(result.timestamp, ts);
    assert.equal(result.parsed.length, 2);
    assert.ok(result.parsed[0].timestamp instanceof Date);
    assert.equal(result.parsed[1].player1, "Alice");
});

test("readCache: legacy format with missing timestamp key yields null, not NaN", () => {
    ls.setItem(SHEET_URL, JSON.stringify(ROWS));  // no _timestamp sibling
    const result = service().readCache();
    assert.equal(result.timestamp, null);
    assert.equal(result.parsed.length, 2);
});

test("formatTimeSince: null/NaN timestamps never render as 'NaN years ago'", () => {
    const svc = service();
    assert.equal(svc.formatTimeSince(null), "an unknown time ago");
    assert.equal(svc.formatTimeSince(undefined), "an unknown time ago");
    assert.equal(svc.formatTimeSince(NaN), "an unknown time ago");
    assert.match(svc.formatTimeSince(Date.now() - 5 * 60 * 1000), /minutes ago/);
});

// ---- envelope format -------------------------------------------------------

test("envelope round-trip: fetchFresh writes one key, readCache reads it back", async () => {
    const written = await service().fetchFresh();

    // One atomic envelope; the legacy timestamp key is not written.
    const stored = JSON.parse(ls.getItem(SHEET_URL));
    assert.deepEqual(Object.keys(stored).sort(), ["data", "timestamp"]);
    assert.equal(ls.getItem(TS_KEY), null);

    const result = service().readCache();
    assert.equal(result.timestamp, written.timestamp);
    assert.equal(result.parsed.length, 2);
    assert.ok(result.parsed[0].timestamp instanceof Date);
    assert.equal(result.parsed[0].timestamp.toISOString(), ROWS[0].timestamp);
});

test("fetchFresh retires the legacy timestamp key on upgrade", async () => {
    ls.setItem(SHEET_URL, JSON.stringify(ROWS));
    ls.setItem(TS_KEY, "12345");
    await service().fetchFresh();
    assert.equal(ls.getItem(TS_KEY), null);
    assert.ok(JSON.parse(ls.getItem(SHEET_URL)).data);
});

test("fetchFresh: `changed` diffs data only, against either cache format", async () => {
    // vs legacy format, identical data → unchanged
    ls.setItem(SHEET_URL, JSON.stringify(ROWS));
    ls.setItem(TS_KEY, "12345");
    assert.equal((await service().fetchFresh()).changed, false);

    // vs the envelope just written, identical data → unchanged even though the
    // envelope's own timestamp differs
    assert.equal((await service().fetchFresh()).changed, false);

    // different data → changed
    const moved = fetchedRows().slice(0, 1);
    assert.equal((await service(moved).fetchFresh()).changed, true);

    // no cache at all → changed
    ls._map.delete(SHEET_URL);
    assert.equal((await service().fetchFresh()).changed, true);
});

// ---- clearCachedData -------------------------------------------------------

test("clearCachedData removes exactly the sheet-cache keys", () => {
    // Two URL forms isValidGoogleSheetsUrl accepts: docs.google.com and
    // another *.google.com host (the old substring match missed the latter).
    const docsUrl = SHEET_URL;
    const otherHostUrl =
        "https://sheets.google.com/spreadsheets/d/e/OTHER/pub?output=csv";
    assert.ok(isValidGoogleSheetsUrl(docsUrl));
    assert.ok(isValidGoogleSheetsUrl(otherHostUrl));

    ls.setItem(docsUrl, "[]");
    ls.setItem(`${docsUrl}_timestamp`, "1");
    ls.setItem(otherHostUrl, "[]");
    ls.setItem(`${otherHostUrl}_timestamp`, "2");
    ls.setItem("quartetlog_cache_old", "x");           // legacy prefixed key

    // Unrelated keys that must survive — including *_timestamp keys that do
    // not belong to a sheet cache (the old code blanket-deleted these), and a
    // google.com URL that is not a valid sheet-CSV URL.
    ls.setItem("theme", "dark");
    ls.setItem("session_timestamp", "999");
    ls.setItem("https://mail.google.com/inbox", "x");

    clearCachedData();

    assert.equal(ls.getItem(docsUrl), null);
    assert.equal(ls.getItem(`${docsUrl}_timestamp`), null);
    assert.equal(ls.getItem(otherHostUrl), null);
    assert.equal(ls.getItem(`${otherHostUrl}_timestamp`), null);
    assert.equal(ls.getItem("quartetlog_cache_old"), null);

    assert.equal(ls.getItem("theme"), "dark");
    assert.equal(ls.getItem("session_timestamp"), "999");
    assert.equal(ls.getItem("https://mail.google.com/inbox"), "x");
    assert.equal(ls.getItem("quartetlog_data_url"), SHEET_URL);  // config survives
});

// ---- fetch races -----------------------------------------------------------

// A promise whose resolve/reject are held by the test.
function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// Observe whether a promise has settled without awaiting it.
function probe(promise) {
    const state = { settled: false };
    promise.then(() => { state.settled = true; }, () => { state.settled = true; });
    return state;
}

const nextTick = () => new Promise(res => setImmediate(res));

test("fetchCSV: no cache + slow fetch → waits past the timeout and resolves fresh", async () => {
    const net = deferred();
    // timeoutMs: 0 — if the timeout could still reject/downgrade with no
    // cache, it would fire long before we resolve the network below.
    const svc = new DataService({ fetchRows: () => net.promise, timeoutMs: 0 });

    const result = svc.fetchCSV();
    const state = probe(result);
    await new Promise(res => setTimeout(res, 5));  // let any 0ms timeout fire
    assert.equal(state.settled, false, "must keep waiting on the in-flight fetch");

    net.resolve(fetchedRows());
    const r = await result;
    assert.equal(r.source, "fresh");
    assert.equal(r.parsed.length, 2);
    assert.ok(ls.getItem(SHEET_URL), "late-arriving fetch still populates the cache");
});

test("fetchCSV: no cache + failing fetch rejects (no cache to fall back to)", async () => {
    const svc = new DataService({
        fetchRows: () => Promise.reject(new Error("network down")),
        timeoutMs: 0,
    });
    await assert.rejects(svc.fetchCSV());
});

test("fetchCSV: with a cache, the timeout downgrades to cache; the late fetch still lands", async () => {
    const ts = Date.now();
    ls.setItem(SHEET_URL, JSON.stringify({ data: ROWS, timestamp: ts }));

    const net = deferred();
    const svc = new DataService({ fetchRows: () => net.promise, timeoutMs: 0 });

    const r = await svc.fetchCSV();
    assert.equal(r.source, "cache");
    assert.equal(r.timestamp, ts);

    // The in-flight fetch keeps going and refreshes the cache for next launch.
    const moved = fetchedRows().slice(0, 1);
    net.resolve(moved);
    await nextTick();
    assert.equal(JSON.parse(ls.getItem(SHEET_URL)).data.length, 1);
});

test("fetchCSV: with a cache, a fast fetch wins the race as fresh", async () => {
    ls.setItem(SHEET_URL, JSON.stringify({ data: ROWS, timestamp: 1 }));
    const svc = new DataService({ fetchRows: async () => fetchedRows(), timeoutMs: 60000 });
    const r = await svc.fetchCSV();
    assert.equal(r.source, "fresh");
});

test("fetchFresh: overlapping calls share one network trip and one result", async () => {
    // Pre-seed the cache so a change is genuinely detectable.
    ls.setItem(SHEET_URL, JSON.stringify({ data: ROWS.slice(0, 1), timestamp: 1 }));

    let calls = 0;
    const net = deferred();
    const svc = new DataService({ fetchRows: () => { calls++; return net.promise; } });

    const p1 = svc.fetchFresh();  // e.g. the 5-minute poll…
    const p2 = svc.fetchFresh();  // …interleaved with pull-to-refresh
    assert.equal(calls, 1, "second caller must not start a second fetch");

    net.resolve(fetchedRows());
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, r2, "both callers get the same result object");
    assert.equal(r1.changed, true, "the genuine change is not dropped");
});

test("fetchFresh: the in-flight guard resets after settling", async () => {
    let calls = 0;
    const svc = new DataService({
        fetchRows: async () => { calls++; return fetchedRows(); },
    });

    await svc.fetchFresh();
    assert.equal((await svc.fetchFresh()).changed, false);  // a real second trip
    assert.equal(calls, 2);

    // …and after a rejection too.
    const failing = new DataService({
        fetchRows: () => Promise.reject(new Error("down")),
    });
    await assert.rejects(failing.fetchFresh());
    await assert.rejects(failing.fetchFresh());
});
