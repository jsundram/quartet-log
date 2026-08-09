// @ts-check
// Global configuration constants

// BEGIN is computed from data - first day of month containing earliest data point
/** @type {Date|null} */
let _begin = null;

/** @returns {Date} */
export function getBegin() {
    if (!_begin) {
        throw new Error('BEGIN not initialized - call setBegin() with data first');
    }
    return _begin;
}

/** @param {Date} earliestDate */
export function setBegin(earliestDate) {
    // Set to first day of the month containing the earliest date
    _begin = new Date(earliestDate.getFullYear(), earliestDate.getMonth(), 1);
}

// Color reads. Colors live in CSS custom properties on :root (see
// static/css/viz.css). `getCssColor` reads a token by name; `getPartColor`
// is the part-specific convenience that callers used to import as
// PART_COLORS. Memoized after first read — themeManager.subscribe should
// call invalidateColorCache() before re-rendering on a theme change so the
// next read picks up the new resolved value.
/** @type {Map<string, string>} */
const _colorCache = new Map();

/**
 * @param {string} token - CSS custom property name, e.g. '--color-part-v1'
 * @returns {string}
 */
export function getCssColor(token) {
    const cached = _colorCache.get(token);
    if (cached !== undefined) return cached;
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(token)
        .trim();
    _colorCache.set(token, value);
    return value;
}

export function invalidateColorCache() {
    _colorCache.clear();
}

/**
 * @param {string|null} part
 * @returns {string}
 */
export function getPartColor(part) {
    /** @type {Record<string, string>} */
    const tokens = {
        V1: '--color-part-v1',
        V2: '--color-part-v2',
        VA: '--color-part-va',
        VC: '--color-part-vc',
    };
    const token = part ? tokens[part] : undefined;
    return token ? getCssColor(token) : getCssColor('--color-part-fallback');
}

// Player-name tables (PLAYER_ALIASES: short name → per-instrument-class
// canonical full name; PLAYER_ABBREVIATIONS: single letter → short name).
// The tables are personal data — real people's full names — so they are
// NOT tracked: they live in the gitignored src/aliases.js, created from
// src/aliases.stub.js (empty tables + typedefs documenting the shape) by
// scripts/ensure_aliases.mjs when missing. build.sh and `npm test`
// (pretest) run that script; the deploy workflow materializes the real
// file from the PLAYER_ALIASES_JS Actions secret. Re-exported here so all
// consumers keep importing from config.js. See src/aliases.stub.js for
// the full mechanism description.
export { PLAYER_ALIASES, PLAYER_ABBREVIATIONS } from './aliases.js';

// Calendar configurations
export const CALENDAR_CONFIG = {
    width: 1000,  // Extra width for day-of-week totals column
    cellSize: 17,
    height: 17 * 10  // Extra row for weekly totals
};
