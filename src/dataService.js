import { getDataUrl } from './urlConfig';
import { ALL_WORKS} from './catalog';
import { processRow, fillForward, normalizePlayerNames } from './dataProcessor';

export class DataService {
    constructor() {
        this.data = null;
    }

    async fetchCSV() {
        const dataUrl = getDataUrl();
        if (!dataUrl) {
            throw new Error('No data URL configured');
        }

        const cachedData = localStorage.getItem(dataUrl);
        const cachedTimestamp = localStorage.getItem(`${dataUrl}_timestamp`);
        const timeoutDuration = 5000;

        return new Promise((resolve, reject) => {
            const useCached = () => {
                if (cachedData) {
                    console.log(`Using cached data from ${new Date(parseInt(cachedTimestamp))}`);
                    let parsed = JSON.parse(cachedData);
                    parsed.forEach(d => d.timestamp = new Date(d.timestamp));
                    resolve({
                        parsed,
                        timestamp: parseInt(cachedTimestamp),
                        source: 'cache'
                    });
                } else {
                    reject(new Error('No cached data available'));
                }
            };

            const timeoutId = setTimeout(useCached, timeoutDuration);

            d3.csv(dataUrl, processRow)
                .then(d => {
                    clearTimeout(timeoutId);
                    const timestamp = Date.now();
                    localStorage.setItem(dataUrl, JSON.stringify(d));
                    localStorage.setItem(`${dataUrl}_timestamp`, timestamp.toString());
                    resolve({
                        parsed: d,
                        timestamp,
                        source: 'fresh'
                    });
                })
                .catch(error => {
                    clearTimeout(timeoutId);
                    useCached();
                });
        });
    }

    // Synchronous read of the last-known data from localStorage, or null when
    // there's nothing cached. Drives the cache-first boot paint: a returning
    // visitor sees their data immediately instead of staring at an empty shell
    // while the (cross-origin, often slow) published Sheet is fetched.
    readCache() {
        const dataUrl = getDataUrl();
        if (!dataUrl) return null;

        const cachedData = localStorage.getItem(dataUrl);
        if (!cachedData) return null;

        let parsed;
        try {
            parsed = JSON.parse(cachedData);
        } catch {
            return null;  // corrupt cache: behave as if there were none
        }
        parsed.forEach(d => d.timestamp = new Date(d.timestamp));

        return {
            parsed,
            timestamp: parseInt(localStorage.getItem(`${dataUrl}_timestamp`)),
            source: 'cache',
        };
    }

    // Network-only fetch (no timeout race, no cache fallback): pulls the sheet,
    // writes it back to the localStorage cache, and reports whether the raw
    // data changed vs what was cached. Callers use `changed` to skip a needless
    // re-render when the sheet is byte-identical to last time (the common case
    // between launches), which is what keeps the background revalidate from
    // flashing the UI. Rejects on network failure — the caller decides whether
    // to keep showing the stale copy.
    async fetchFresh() {
        const dataUrl = getDataUrl();
        if (!dataUrl) {
            throw new Error('No data URL configured');
        }

        const d = await d3.csv(dataUrl, processRow);
        const serialized = JSON.stringify(d);
        // Compare against the still-stored previous serialization before we
        // overwrite it. Both sides are JSON.stringify of d3.csv(processRow)
        // output, so key order is stable and the equality is reliable.
        const changed = serialized !== localStorage.getItem(dataUrl);
        const timestamp = Date.now();
        localStorage.setItem(dataUrl, serialized);
        localStorage.setItem(`${dataUrl}_timestamp`, timestamp.toString());

        return { parsed: d, timestamp, source: 'fresh', changed };
    }

    processData(rawData) {
        if (!ALL_WORKS) {
            throw new Error('Work catalog not initialized');
        }

        let processedData = fillForward(rawData);
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
