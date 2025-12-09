// This will be populated when catalog loads
export let COMPOSERS = null;
export let ALL_WORKS = null;

// Default composer for initial tab display
export const DEFAULT_COMPOSER = 'Haydn';

// URL generation patterns for each composer
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
    'MISC': 1  // quiet the warning on line 44
};

export function generateQuartetRouletteUrl(d) {
        const base = 'https://quartetroulette.com/';
        return base + (COMPOSER_URL_PATTERNS[d.composer]?.(d) || '');
}

export async function loadWorkCatalog() {
    try {
        ALL_WORKS = await d3.json('all_works.json');
        COMPOSERS = new Set(Object.keys(ALL_WORKS));

        // Validate that we have URL patterns for all composers
        COMPOSERS.forEach(composer => {
            if (!COMPOSER_URL_PATTERNS[composer]) {
                console.warn(`Missing URL pattern for composer: ${composer}`);
            }
        });
    } catch (error) {
        console.error('Error loading work catalog:', error);
        throw error;
    }
}

// Helper functions for handling MISC tab

export function isMiscTab(tabName) {
    return tabName === 'MISC';
}

export function getComposersForTab(tabName) {
    if (!isMiscTab(tabName)) {
        return [tabName];
    }
    // MISC is an array of objects, each with one key (the composer name)
    return ALL_WORKS.MISC.map(obj => Object.keys(obj)[0]);
}

export function getWorksForTab(tabName) {
    if (!isMiscTab(tabName)) {
        return ALL_WORKS[tabName];
    }
    // Flatten the MISC structure and prepend composer names to avoid title collisions
    // e.g., "Quartet" becomes "Debussy-Quartet" and "Ravel-Quartet"
    return ALL_WORKS.MISC.flatMap(obj => {
        const composer = Object.keys(obj)[0];
        const works = obj[composer];
        return works.map(work => `${composer}-${work}`);
    });
}

export function getComposerForWork(tabName, workTitle) {
    if (!isMiscTab(tabName)) {
        return tabName;
    }
    // Work titles for MISC are prefixed with composer: "Debussy-Quartet"
    const dashIndex = workTitle.indexOf('-');
    if (dashIndex === -1) return tabName; // fallback
    return workTitle.substring(0, dashIndex);
}

export function getOriginalWorkTitle(tabName, workTitle) {
    if (!isMiscTab(tabName)) {
        return workTitle;
    }
    // Strip the composer prefix: "Debussy-Quartet" → "Quartet"
    const dashIndex = workTitle.indexOf('-');
    if (dashIndex === -1) return workTitle; // fallback
    return workTitle.substring(dashIndex + 1);
}
