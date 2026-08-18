// The catalog's tab helpers: multi-composer tab detection (shape-based),
// title prefixing, display labels, and quartetroulette link suppression.
// installCatalog is the test seam — a fixture catalog goes in, the same
// helpers the tabs run against come out. Reset to null after each test so
// other test files keep seeing the not-loaded (permissive) behavior.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    installCatalog,
    isMultiComposerTab,
    getComposersForTab,
    getWorksForTab,
    getComposerForWork,
    getOriginalWorkTitle,
    getDisplayLabel,
    generateQuartetRouletteUrl,
} from '../src/catalog.js';

// Miniature of the real shape: single-composer keys are string arrays;
// MISC and 5+ are arrays of single-key { composer: titles[] } objects.
const FIXTURE = {
    Haydn: ['20#2', '76#1'],
    Mozart: ['K421', 'K465'],
    '5+': [
        { Mozart: ['K515', 'K516'] },
        { Tchaikovsky: ['Souvenir'] },
    ],
    MISC: [
        { Debussy: ['Quartet'] },
        { Britten: ['1', '2'] },
    ],
};

afterEach(() => installCatalog(null));

test('isMultiComposerTab detects the array-of-objects shape', () => {
    installCatalog(FIXTURE);
    assert.equal(isMultiComposerTab('MISC'), true);
    assert.equal(isMultiComposerTab('5+'), true);
    assert.equal(isMultiComposerTab('Haydn'), false);
    assert.equal(isMultiComposerTab('ALL'), false);     // not a catalog key
    installCatalog(null);
    assert.equal(isMultiComposerTab('MISC'), false);    // pre-load: safe, no throw
});

test('tab helpers: composers, prefixed works, and round-tripping', () => {
    installCatalog(FIXTURE);
    assert.deepEqual(getComposersForTab('Haydn'), ['Haydn']);
    assert.deepEqual(getComposersForTab('5+'), ['Mozart', 'Tchaikovsky']);
    assert.deepEqual(getWorksForTab('Haydn'), ['20#2', '76#1']);
    assert.deepEqual(getWorksForTab('5+'),
        ['Mozart-K515', 'Mozart-K516', 'Tchaikovsky-Souvenir']);
    // Prefixed titles split back into composer + original title.
    assert.equal(getComposerForWork('5+', 'Tchaikovsky-Souvenir'), 'Tchaikovsky');
    assert.equal(getOriginalWorkTitle('5+', 'Tchaikovsky-Souvenir'), 'Souvenir');
    assert.equal(getComposerForWork('Haydn', '20#2'), 'Haydn');
    assert.equal(getOriginalWorkTitle('Haydn', '20#2'), '20#2');
});

test('getDisplayLabel: single-work composers show as just the composer', () => {
    installCatalog(FIXTURE);
    assert.equal(getDisplayLabel('5+', 'Tchaikovsky-Souvenir'), 'Tchaikovsky');
    assert.equal(getDisplayLabel('MISC', 'Debussy-Quartet'), 'Debussy');
    // Multiple works keep the prefixed form; single-composer tabs untouched.
    assert.equal(getDisplayLabel('5+', 'Mozart-K515'), 'Mozart-K515');
    assert.equal(getDisplayLabel('MISC', 'Britten-1'), 'Britten-1');
    assert.equal(getDisplayLabel('Haydn', '20#2'), '20#2');
});

test('generateQuartetRouletteUrl links quartets, suppresses the rest', () => {
    installCatalog(FIXTURE);
    const row = (composer, title, catalog = NaN) =>
        ({ composer, work: { title, catalog, number: null, incomplete: false } });
    // Own-tab quartet and MISC quartet get links.
    assert.equal(generateQuartetRouletteUrl(row('Mozart', 'K421', 421)),
        'https://quartetroulette.com/mozart-k-421');
    assert.match(generateQuartetRouletteUrl(row('Debussy', 'Quartet')),
        /^https:\/\/quartetroulette\.com\/debussy-quartet\/$/);
    // 5+-only works and unknown composers get null (tooltip renders unlinked).
    assert.equal(generateQuartetRouletteUrl(row('Mozart', 'K515')), null);
    assert.equal(generateQuartetRouletteUrl(row('Tchaikovsky', 'Souvenir')), null);
    assert.equal(generateQuartetRouletteUrl(row('Strauss', 'Capriccio sextet')), null);
    // Catalog not loaded: permissive (link built) so tests elsewhere and
    // pre-load callers keep the old behavior.
    installCatalog(null);
    assert.match(generateQuartetRouletteUrl(row('Mozart', 'K515')), /^https:/);
});
