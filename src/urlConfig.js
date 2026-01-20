// URL configuration management for localStorage-based data source

const STORAGE_KEY = 'musiclog_data_url';
const CACHE_KEY_PREFIX = 'musiclog_cache_';

/**
 * Check if a URL is configured
 */
export function hasDataUrl() {
    return localStorage.getItem(STORAGE_KEY) !== null;
}

/**
 * Get the configured data URL from localStorage
 */
export function getDataUrl() {
    return localStorage.getItem(STORAGE_KEY);
}

/**
 * Save a data URL to localStorage and clear any old cached data
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
 * Clear cached CSV data from localStorage
 */
function clearCachedData() {
    // Remove all keys that start with cache prefix or are URLs
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith(CACHE_KEY_PREFIX) ||
            key.includes('docs.google.com') ||
            key.endsWith('_timestamp'))) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
}

/**
 * Validate that a URL is a valid Google Sheets CSV export URL
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
    } catch (e) {
        return false;
    }
}
