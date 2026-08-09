import * as d3 from "d3";
import { getDataUrl } from './urlConfig.js';
import { processRow, prepareRows, fillForward, normalizePlayerNames } from './dataProcessor.js';

export class DataService {
    // `fetchRows` and `timeoutMs` (the network-vs-cache race timeout in
    // fetchCSV, default 5s) are injectable for tests; production callers use
    // `new DataService()`.
    constructor({ fetchRows, timeoutMs = 5000 } = {}) {
        this.data = null;
        this._fetchRows = fetchRows || (url => d3.csv(url, processRow));
        this._timeoutMs = timeoutMs;
        this._inflightFresh = null;
    }

    // --- localStorage cache -------------------------------------------------
    //
    // Cache format: a single JSON envelope { data, timestamp } stored under the
    // data URL as the key. One key means the rows and their fetch timestamp are
    // written atomically — the old two-key format (rows under <url>, ms-epoch
    // under <url>_timestamp) could be torn by a quota failure between the two
    // setItem calls. Reads still accept the legacy two-key format so caches
    // written by earlier versions keep working; writes emit only the envelope
    // (and retire the legacy timestamp key on success).

    // Read + validate whatever is cached for dataUrl. Returns null when there
    // is no cache, the JSON is corrupt, or the shape is unrecognizable. On
    // success returns { rows, timestamp, serializedData }:
    //   rows           — cached rows with row.timestamp rehydrated to Date
    //   timestamp      — fetch time (ms epoch), or null if missing/corrupt
    //   serializedData — JSON of the rows alone, for fetchFresh's `changed` diff
    _readCacheEntry(dataUrl) {
        const raw = localStorage.getItem(dataUrl);
        if (!raw) return null;

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;  // corrupt cache: behave as if there were none
        }

        let rows, timestamp, serializedData;
        if (Array.isArray(parsed)) {
            // Legacy two-key format: rows under <url>, timestamp in a sibling key.
            rows = parsed;
            serializedData = raw;
            timestamp = parseInt(localStorage.getItem(`${dataUrl}_timestamp`), 10);
        } else if (parsed && Array.isArray(parsed.data)) {
            // Envelope format.
            rows = parsed.data;
            serializedData = JSON.stringify(parsed.data);
            timestamp = parsed.timestamp;
        } else {
            return null;  // valid JSON but not a cache we recognize
        }

        // A missing/corrupt timestamp must not leak NaN into "updated NaN
        // years ago" — normalize to null and let formatTimeSince handle it.
        if (!Number.isFinite(timestamp)) timestamp = null;

        rows.forEach(d => d.timestamp = new Date(d.timestamp));
        return { rows, timestamp, serializedData };
    }

    // Persist rows + fetch timestamp as one envelope. Returns true on success,
    // false when the write failed (localStorage quota exhaustion — the log only
    // grows). Callers surface the failure as a staleness signal: the in-memory
    // data is fresh, but the *next* launch will boot from an older cache.
    _writeCache(dataUrl, rows, timestamp) {
        try {
            localStorage.setItem(dataUrl, JSON.stringify({ data: rows, timestamp }));
            localStorage.removeItem(`${dataUrl}_timestamp`);  // retire legacy key
            return true;
        } catch (e) {
            console.error('Failed to write data cache (quota?)', e);
            return false;
        }
    }

    async fetchCSV() {
        const dataUrl = getDataUrl();
        if (!dataUrl) {
            throw new Error('No data URL configured');
        }

        const cached = this._readCacheEntry(dataUrl);

        const network = this._fetchRows(dataUrl).then(d => {
            // A valid-but-empty response (0 rows) is never real data for an
            // active log; treat it like a fetch error — with a cache that means
            // falling back to it rather than overwriting the cache with [].
            // (See fetchFresh for the cache-poisoning rationale.)
            if (!d.length) {
                throw new Error('Empty data response');
            }
            const timestamp = Date.now();
            const cacheWriteFailed = !this._writeCache(dataUrl, d, timestamp);
            return { parsed: d, timestamp, source: 'fresh', cacheWriteFailed };
        });

        // No cache: the network is the only possible source, so keep waiting on
        // the in-flight fetch however long it takes. The old code rejected with
        // "No cached data available" at the 5s timeout while the fetch was
        // still in flight — it would later resolve (and populate the cache)
        // with nobody listening, so the user saw an error that a reload
        // "mysteriously" fixed. The timeout only ever downgrades to cache.
        if (!cached) {
            return network;
        }

        const fromCache = () => {
            console.log(`Using cached data from ${new Date(cached.timestamp)}`);
            return {
                parsed: cached.rows,
                timestamp: cached.timestamp,
                source: 'cache'
            };
        };

        // Race the network against the timeout. On timeout, serve the cache —
        // the network fetch stays in flight and still writes the cache for
        // next launch when it eventually lands (see `network` above).
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => resolve(fromCache()), this._timeoutMs);
            network.then(
                result => { clearTimeout(timeoutId); resolve(result); },
                () => { clearTimeout(timeoutId); resolve(fromCache()); }
            );
        });
    }

    // Synchronous read of the last-known data from localStorage, or null when
    // there's nothing cached (or the cache is corrupt/unrecognizable). Drives
    // the cache-first boot paint: a returning visitor sees their data
    // immediately instead of staring at an empty shell while the (cross-origin,
    // often slow) published Sheet is fetched. `timestamp` may be null when the
    // cached copy has no readable fetch time.
    readCache() {
        const dataUrl = getDataUrl();
        if (!dataUrl) return null;

        const entry = this._readCacheEntry(dataUrl);
        if (!entry) return null;

        return {
            parsed: entry.rows,
            timestamp: entry.timestamp,
            source: 'cache',
        };
    }

    // Network-only fetch (no timeout race, no cache fallback): pulls the sheet,
    // writes it back to the localStorage cache, and reports whether the raw
    // data changed vs what was cached. Callers use `changed` to skip a needless
    // re-render when the sheet is byte-identical to last time (the common case
    // between launches), which is what keeps the background revalidate from
    // flashing the UI. Rejects on network failure — the caller decides whether
    // to keep showing the stale copy. `cacheWriteFailed: true` means the fresh
    // rows could NOT be persisted (quota): the returned data is current, but
    // the next launch will serve an older cache — callers should surface that.
    //
    // In-flight guard: concurrent callers (pull-to-refresh, the visibility
    // handler, and the 5-minute poll can all trigger a revalidate) share one
    // network trip and one result. Without this, two interleaved fetches could
    // each compute `changed` against the other's cache write and drop a
    // genuine update on the floor.
    fetchFresh() {
        if (!this._inflightFresh) {
            this._inflightFresh = this._fetchFreshImpl().finally(() => {
                this._inflightFresh = null;
            });
        }
        return this._inflightFresh;
    }

    async _fetchFreshImpl() {
        const dataUrl = getDataUrl();
        if (!dataUrl) {
            throw new Error('No data URL configured');
        }

        const d = await this._fetchRows(dataUrl);
        // Reject a valid-but-empty response instead of caching it. Persisting []
        // would poison the cache-first boot: readCache() would serve [] and
        // processData()/fillForward() would throw on every subsequent launch
        // until localStorage is cleared. Throwing here (before the write below)
        // leaves the last-good cache intact; revalidate()'s catch keeps the
        // already-painted UI on screen.
        if (!d.length) {
            throw new Error('Empty data response');
        }
        const serialized = JSON.stringify(d);
        // Compare against the still-stored previous serialization before we
        // overwrite it. Both sides are JSON.stringify of processRow output, so
        // key order is stable and the equality is reliable.
        const prev = this._readCacheEntry(dataUrl);
        const changed = serialized !== (prev ? prev.serializedData : null);
        const timestamp = Date.now();
        const cacheWriteFailed = !this._writeCache(dataUrl, d, timestamp);

        return { parsed: d, timestamp, source: 'fresh', changed, cacheWriteFailed };
    }

    processData(rawData) {
        // Sort by timestamp and drop invalid-date rows before anything else —
        // fillForward's session-window math and the row-0-is-earliest
        // assumption (setBegin) both require chronological order.
        const { rows, dropped } = prepareRows(rawData);
        if (dropped) {
            console.warn(`Dropped ${dropped} row(s) with unparseable timestamps`);
        }

        let processedData = fillForward(rows);
        processedData = normalizePlayerNames(processedData);

        // Filter out incomplete works
        return processedData.filter(d => !d.work.incomplete);
    }

    formatTimeSince(previous) {
        const current = Date.now();
        const msPerMinute = 60 * 1000;
        const msPerHour = msPerMinute * 60;
        const msPerDay = msPerHour * 24;
        const msPerMonth = msPerDay * 30;
        const msPerYear = msPerDay * 365;
        const elapsed = current - previous;

        // Guard missing (null/undefined) and unparseable timestamps: without
        // this, a cache with no readable fetch time renders as "NaN years ago"
        // (or, for null — which coerces to 0 — "56 years ago").
        if (previous == null || !Number.isFinite(elapsed)) {
            return 'an unknown time ago';
        }

        if (elapsed < msPerMinute) {
            return 'a few seconds ago';
        } else if (elapsed < msPerHour) {
            return Math.round(elapsed / msPerMinute) + ' minutes ago';
        } else if (elapsed < msPerDay) {
            return Math.round(elapsed / msPerHour) + ' hours ago';
        } else if (elapsed < msPerMonth) {
            return Math.round(elapsed / msPerDay) + ' days ago';
        } else if (elapsed < msPerYear) {
            return Math.round(elapsed / msPerMonth) + ' months ago';
        } else {
            return Math.round(elapsed / msPerYear) + ' years ago';
        }
    }
}
