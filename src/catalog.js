// This will be populated when catalog loads
export let COMPOSERS = null;
export let ALL_WORKS = null;
export let MOZART_WORKS = null;

// Default composer for initial tab display
export const DEFAULT_COMPOSER = 'Haydn';

// URL generation patterns for each composer
const COMPOSER_URL_PATTERNS = {
    'Bartok': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Beethoven': d => `${d.composer.toLowerCase()}-opus-${d.work.catalog}${d.work.number ? "-" + d.work.number : ""}/`,
    'Boccherini': () => 'Boccherini/',
    'Brahms': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Dvorak': d => `${d.composer.toLowerCase()}-opus-${d.work.catalog}/`,
    'Haydn': d => `${d.composer.toLowerCase()}-opus-${d.work.catalog}${d.work.number ? "-" + d.work.number : ""}/`,
    'Mendelssohn': d => `${d.composer.toLowerCase()}-opus-${d.work.catalog}${d.work.number ? "-" + d.work.number : ""}/`,
    'Mozart': d => `mozart-k-${d.work.catalog}`,
    'Schumann': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`,
    'Shostakovich': d => `${d.composer.toLowerCase()}-${d.work.catalog}/`
};

export function generateQuartetRouletteUrl(d) {
        const base = 'https://quartetroulette.com/';
        return base + (COMPOSER_URL_PATTERNS[d.composer]?.(d) || '');
}

export async function loadWorkCatalog() {
    try {
        ALL_WORKS = await d3.json('all_works.json');
        MOZART_WORKS = new Set(ALL_WORKS["Mozart"]);
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
