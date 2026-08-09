// @ts-check
// URL configuration management for localStorage-based data source

const STORAGE_KEY = 'quartetlog_data_url';

/**
 * Check if a URL is configured
 */
export function hasDataUrl() {
    return localStorage.getItem(STORAGE_KEY) !== null;
}

/**
 * Get the configured data URL from localStorage
 * @returns {string|null}
 */
export function getDataUrl() {
    return localStorage.getItem(STORAGE_KEY);
}

/**
 * Save a data URL to localStorage and clear any old cached data
 * @param {string} url
 */
export function setDataUrl(url) {
    // Clear old cache before setting new URL
    clearCachedData();
    localStorage.setItem(STORAGE_KEY, url);
}

/**
 * Remove the configured URL and clear cached data
 */
export function clearDataUrl() {
    clearCachedData();
    localStorage.removeItem(STORAGE_KEY);
}

/**
 * Clear cached CSV data from localStorage.
 *
 * The DataService cache is keyed by the sheet URL itself (envelope format),
 * historically with a sibling `<url>_timestamp` key (legacy two-key format).
 * Match cache keys with the same predicate that admits data URLs in the first
 * place (isValidGoogleSheetsUrl) so every acceptable host form is covered —
 * the old substring check ('docs.google.com') missed other *.google.com hosts
 * — and only remove `_timestamp` keys whose base key is such a URL, instead
 * of blanket-deleting every `*_timestamp` key in storage.
 *
 * Exported for tests; app code reaches it via setDataUrl/clearDataUrl.
 */
export function clearCachedData() {
    const TS_SUFFIX = '_timestamp';
    /** @param {string} key */
    const isCacheKey = (key) =>
        isValidGoogleSheetsUrl(key) ||
        (key.endsWith(TS_SUFFIX) &&
            isValidGoogleSheetsUrl(key.slice(0, -TS_SUFFIX.length)));

    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && isCacheKey(key)) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
}

/**
 * Build a mobile-setup link from a data URL: <origin><pathname>?data=<encoded>.
 * encodeURIComponent ensures the embedded Google Sheets URL (which has its
 * own ?gid=…&single=true&output=csv) survives parsing on the receiving end.
 * @param {string} dataUrl
 * @returns {string}
 */
export function buildMobileSetupLink(dataUrl) {
    const base = window.location.origin + window.location.pathname;
    return base + '?data=' + encodeURIComponent(dataUrl);
}

/**
 * Mobile-setup-from-desktop-link flow: if the current page URL has ?data=<url>,
 * validate, persist to localStorage, and strip the param from history so it
 * doesn't re-process on reload or linger in browser history. Returns true if
 * a valid URL was consumed.
 *
 * Persistent (not session-only) on purpose — this is for one-time setup of a
 * second device, not for sharing with others. The companion "Copy mobile
 * setup link" button on the setup view generates the URLs this consumes.
 */
export function consumeDataParam() {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('data');
    if (!url || !isValidGoogleSheetsUrl(url)) return false;

    // Avoid clearing the cache via setDataUrl when the link points at the
    // URL that's already configured (e.g. re-opening the same setup link).
    if (getDataUrl() !== url) {
        setDataUrl(url);
    }

    // Strip ?data=… from the URL.
    params.delete('data');
    const newSearch = params.toString();
    const newUrl = window.location.pathname
        + (newSearch ? '?' + newSearch : '')
        + window.location.hash;
    window.history.replaceState(null, '', newUrl);

    return true;
}

/**
 * Validate that a URL is a valid Google Sheets CSV export URL
 * @param {unknown} url
 * @returns {boolean}
 */
export function isValidGoogleSheetsUrl(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }

    try {
        const parsed = new URL(url);

        // Check domain is google.com
        if (!parsed.hostname.endsWith('google.com')) {
            return false;
        }

        // Check path contains /spreadsheets/
        if (!parsed.pathname.includes('/spreadsheets/')) {
            return false;
        }

        // Check for output=csv parameter
        if (parsed.searchParams.get('output') !== 'csv') {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}
