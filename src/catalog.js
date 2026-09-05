// @ts-check
import * as d3 from "d3";

/** @typedef {import('./dataProcessor.js').Row} Row */
/** @typedef {import('./dataProcessor.js').Work} Work */

/**
 * The catalog's per-composer work lists: composer → array of work titles,
 * except multi-composer tabs (MISC, 5+), whose value is an array of
 * single-key objects ({ composer: titles[] }) — see getComposersForTab/
 * getWorksForTab. The tab set is data-driven: adding another multi-composer
 * tab is a JSON-only change.
 * @typedef {string[] | Record<string, string[]>[]} CatalogEntry
 * @typedef {Record<string, CatalogEntry>} WorkCatalog
 */

// This will be populated when catalog loads
/** @type {Set<string>|null} */
export let COMPOSERS = null;
/** @type {WorkCatalog|null} */
export let ALL_WORKS = null;
// Old Peters Edition volume lookup for Haydn quartets. Keys are like
// "017_1" for Op.17#1, or "042"/"103" when there's no opus number.
// Values are 1..4 (volume) or null (not in any Peters volume).
/** @type {Record<string, number|null>|null} */
export let HAYDN_PETERS = null;

// Default composer for initial tab display
export const DEFAULT_COMPOSER = 'Haydn';

// URL generation patterns for each composer
/** @type {Record<string, (d: Row) => string>} */
const COMPOSER_URL_PATTERNS = {
    'Bartok': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Beethoven': d => `${d.composer.toLowerCase()}-opus-${d.work.catalog}${d.work.number ? "-" + d.work.number : ""}/`,
    'Boccherini': () => 'Boccherini/',
    'Brahms': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Britten': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Debussy': d => `${d.composer.toLowerCase()}-quartet/`,
    'Dvorak': d => `${d.composer.toLowerCase()}-opus-${d.work.catalog}/`,
    'Grieg': d => `${d.composer.toLowerCase()}-quartet/`,
    'Haydn': d => `${d.composer.toLowerCase()}-opus-${d.work.catalog}${d.work.number ? "-" + d.work.number : ""}/`,
    'Mendelssohn': d => `${d.composer.toLowerCase()}-opus-${d.work.catalog}${d.work.number ? "-" + d.work.number : ""}/`,
    'Mozart': d => `mozart-k-${d.work.catalog}`,
    'Prokofiev': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Ravel': d => `${d.composer.toLowerCase()}-quartet/`,
    'Schubert': d => `schubert-d-${d.work.catalog}/`,
    'Schumann': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Shostakovich': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Smetana': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Tchaikovsky': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Verdi': d => `${d.composer.toLowerCase()}-quartet/`,
    // Quiet loadWorkCatalog's missing-pattern warning. Was the number 1,
    // which satisfied the truthiness check there but would have CRASHED
    // generateQuartetRouletteUrl (`(1)?.(d)` throws — optional chaining only
    // guards null/undefined, not non-functions) had any row carried the
    // composer "MISC". A no-op pattern keeps both callers safe.
    'MISC': () => '',
    '5+': () => ''
};

// Does quartetroulette.com have a page for this row's work? The site covers
// quartets only, i.e. the works in the composer's own tab list plus MISC —
// works that exist solely in other multi-composer tabs (5+) would
// 404. Permissive when the catalog hasn't loaded (tests build tooltips
// without it); in the app every tooltip renders post-load.
/** @param {Row} d */
function hasQuartetRoulettePage(d) {
    if (!ALL_WORKS) return true;
    const own = ALL_WORKS[d.composer];
    if (Array.isArray(own) && own.some(w => w === d.work.title)) return true;
    const misc = ALL_WORKS.MISC;
    return Array.isArray(misc) && misc.some(obj =>
        /** @type {Record<string, string[]>} */ (obj)[d.composer]?.includes(d.work.title));
}

/**
 * @param {Row} d
 * @returns {string|null} the quartetroulette.com link, or null when the
 *   site has no page for this work (non-quartet rep — callers skip the link)
 */
export function generateQuartetRouletteUrl(d) {
        if (!hasQuartetRoulettePage(d)) return null;
        const base = 'https://quartetroulette.com/';
        return base + (COMPOSER_URL_PATTERNS[d.composer]?.(d) || '');
}

// Asset version for all_works.json, baked in at build time via esbuild
// --define (see build.sh). Appended as a query string so iOS homescreen
// webclips and other aggressive caches refetch after deploys that change
// the catalog. haydn_peters.json is treated as static and doesn't need it.
// The typeof guard keeps the module importable under plain Node (tests),
// where no bundler defines the constant; esbuild's --define rewrites the
// identifier inside typeof too, so the bundle still gets the baked value.
const WORKS_VERSION = typeof __WORKS_VERSION__ === "undefined" ? "dev" : __WORKS_VERSION__;

export async function loadWorkCatalog() {
    try {
        const [works, peters] = await Promise.all([
            d3.json(`all_works.json?v=${WORKS_VERSION}`),
            d3.json('haydn_peters.json'),
        ]);
        installCatalog(works, peters);
    } catch (error) {
        console.error('Error loading work catalog:', error);
        throw error;
    }
}

// The assignment half of loadWorkCatalog, split out as a seam: production
// boot fetches then installs; tests install a fixture catalog directly so
// the tab helpers below are exercisable under node:test (mirrors the
// injected-`aliases` pattern in dataProcessor). Pass nulls to reset.
/**
 * @param {WorkCatalog|null} works
 * @param {Record<string, number|null>|null} [peters]
 */
export function installCatalog(works, peters = null) {
    ALL_WORKS = works;
    HAYDN_PETERS = peters;
    COMPOSERS = works ? new Set(Object.keys(works)) : null;

    // Validate that we have URL patterns for all composers
    COMPOSERS?.forEach(composer => {
        if (!COMPOSER_URL_PATTERNS[composer]) {
            console.warn(`Missing URL pattern for composer: ${composer}`);
        }
    });
}

const PETERS_ROMAN = ['', 'I', 'II', 'III', 'IV'];

// Returns the Roman-numeral Peters volume for a Haydn work, or null.
// Key format: 3-digit zero-padded opus, optional "_N" for the number within.
/**
 * @param {Work|null|undefined} work
 * @returns {string|null}
 */
export function getPetersVolume(work) {
    if (!HAYDN_PETERS || !work || work.catalog == null) return null;
    const opus = String(work.catalog).padStart(3, '0');
    const key = work.number != null ? `${opus}_${work.number}` : opus;
    const vol = HAYDN_PETERS[key];
    return vol ? PETERS_ROMAN[vol] : null;
}

// The catalog after loadWorkCatalog has resolved. The tab helpers below all
// run against a mounted UI, which only exists post-load; the throw turns a
// violated assumption into a clear error instead of a bare TypeError on null.
/** @returns {WorkCatalog} */
function loadedCatalog() {
    if (!ALL_WORKS) throw new Error('Work catalog not loaded — call loadWorkCatalog() first');
    return ALL_WORKS;
}

// Helper functions for handling multi-composer tabs (MISC, 5+)

// Shape-based: a tab is multi-composer when its catalog entry is an array
// of { composer: titles[] } objects rather than plain title strings. Safe
// pre-load (returns false), so DOM-free callers (tests) don't throw.
/** @param {string} tabName */
export function isMultiComposerTab(tabName) {
    const entry = ALL_WORKS?.[tabName];
    return Array.isArray(entry) && entry.length > 0 && typeof entry[0] !== 'string';
}

// The ALL tab is built outside the work catalog and shows aggregate stats +
// a flat data table across whatever passes the Date / Part / Player filters.
export const ALL_TAB = 'ALL';

/** @param {string} tabName */
export function isAllTab(tabName) {
    return tabName === ALL_TAB;
}

/**
 * @param {string} tabName
 * @returns {string[]}
 */
export function getComposersForTab(tabName) {
    if (!isMultiComposerTab(tabName)) {
        return [tabName];
    }
    // Multi-composer entries are arrays of objects, each with one key (the
    // composer name)
    const entry = /** @type {Record<string, string[]>[]} */ (loadedCatalog()[tabName]);
    return entry.map(obj => Object.keys(obj)[0]);
}

/**
 * @param {string} tabName
 * @returns {string[]}
 */
export function getWorksForTab(tabName) {
    if (!isMultiComposerTab(tabName)) {
        return /** @type {string[]} */ (loadedCatalog()[tabName]);
    }
    // Flatten the multi-composer structure and prepend composer names to
    // avoid title collisions, e.g. "Quartet" becomes "Debussy-Quartet" and
    // "Ravel-Quartet" in MISC.
    const entry = /** @type {Record<string, string[]>[]} */ (loadedCatalog()[tabName]);
    return entry.flatMap(obj => {
        const composer = Object.keys(obj)[0];
        const works = obj[composer];
        return works.map(work => `${composer}-${work}`);
    });
}

/**
 * @param {string} tabName
 * @param {string} workTitle
 * @returns {string}
 */
export function getComposerForWork(tabName, workTitle) {
    if (!isMultiComposerTab(tabName)) {
        return tabName;
    }
    // Work titles for multi-composer tabs are prefixed: "Debussy-Quartet"
    const dashIndex = workTitle.indexOf('-');
    if (dashIndex === -1) return tabName; // fallback
    return workTitle.substring(0, dashIndex);
}

// What the work-row label should SHOW. Data stays keyed by the full
// prefixed title; this only affects the rendered text. In a multi-composer
// tab, a composer with exactly one work displays as just the composer —
// "Tchaikovsky-Souvenir" reads as "Tchaikovsky" and the full title lives in
// the tooltip. Composers with several works keep the prefixed form.
/**
 * @param {string} tabName
 * @param {string} workTitle
 * @returns {string}
 */
export function getDisplayLabel(tabName, workTitle) {
    if (!isMultiComposerTab(tabName)) return workTitle;
    const composer = getComposerForWork(tabName, workTitle);
    const entry = /** @type {Record<string, string[]>[]} */ (loadedCatalog()[tabName]);
    const works = entry.find(obj => Object.keys(obj)[0] === composer)?.[composer];
    return works?.length === 1 ? composer : workTitle;
}

/**
 * @param {string} tabName
 * @param {string} workTitle
 * @returns {string}
 */
export function getOriginalWorkTitle(tabName, workTitle) {
    if (!isMultiComposerTab(tabName)) {
        return workTitle;
    }
    // Strip the composer prefix: "Debussy-Quartet" → "Quartet"
    const dashIndex = workTitle.indexOf('-');
    if (dashIndex === -1) return workTitle; // fallback
    return workTitle.substring(dashIndex + 1);
}

/**
 * Every composer the catalog knows, mapped to that composer's work titles —
 * the multi-composer tabs flattened back into their members, and titles
 * UNPREFIXED (the "Debussy-" of getWorksForTab is a tab-scoped display key,
 * while a sheet cell holds the bare title). The log form's two pickers read
 * this: the composer list, and the works to suggest once one is chosen.
 * @returns {Record<string, string[]>}
 */
export function composerWorkIndex() {
    /** @type {Record<string, string[]>} */
    const index = {};
    const add = (/** @type {string} */ composer, /** @type {string[]} */ titles) => {
        index[composer] = [...(index[composer] ?? []), ...titles];
    };
    for (const [tab, entry] of Object.entries(loadedCatalog())) {
        if (isMultiComposerTab(tab)) {
            for (const obj of /** @type {Record<string, string[]>[]} */ (entry)) {
                const composer = Object.keys(obj)[0];
                add(composer, obj[composer]);
            }
        } else {
            add(tab, /** @type {string[]} */ (entry));
        }
    }
    return index;
}
