// The catalog's tab helpers: multi-composer tab detection (shape-based),
// title prefixing, display labels, and quartetroulette link suppression.
// installCatalog is the test seam — a fixture catalog goes in, the same
// helpers the tabs run against come out. Reset to null after each test so
// other test files keep seeing the not-loaded (permissive) behavior.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    installCatalog,
    isMultiComposerTab,
    getComposersForTab,
    getWorksForTab,
    getComposerForWork,
    getOriginalWorkTitle,
    getDisplayLabel,
    generateQuartetRouletteUrl,
    composerWorkIndex,
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
        // In the catalog, absent from quartetroulette.com: no URL pattern.
        { Borodin: ['2'] },
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
    // A MISC composer the site doesn't cover: null, not a link to its
    // homepage, which is what the old `|| ''` path fallback produced.
    assert.equal(generateQuartetRouletteUrl(row('Borodin', '2', 2)), null);
    // Catalog not loaded: permissive (link built) so tests elsewhere and
    // pre-load callers keep the old behavior.
    installCatalog(null);
    assert.match(generateQuartetRouletteUrl(row('Mozart', 'K515')), /^https:/);
});

test('composerWorkIndex flattens the multi-composer tabs back into composers', () => {
    installCatalog(FIXTURE);
    const index = composerWorkIndex();
    // Every composer, whatever tab carried it — the log form offers all of
    // them, not just the ones with a tab of their own.
    assert.deepEqual(Object.keys(index).sort(),
        ['Borodin', 'Britten', 'Debussy', 'Haydn', 'Mozart', 'Tchaikovsky']);
    // Titles are UNPREFIXED: "Debussy-Quartet" is a tab-scoped display key,
    // while the sheet cell holds the bare title.
    assert.deepEqual(index.Debussy, ['Quartet']);
    // A composer appearing in both its own tab and a multi-composer one gets
    // both sets, which is what its work picker should suggest.
    assert.deepEqual(index.Mozart, ['K421', 'K465', 'K515', 'K516']);
});

test('composerWorkIndex throws before the catalog loads', () => {
    assert.throws(() => composerWorkIndex(), /not loaded/);
});

// Against the SHIPPED catalog, not a fixture: whether a MISC composer gets a
// link is a claim about quartetroulette.com's coverage, and the only place
// that claim can be wrong is the real pair of files. Smetana and Verdi each
// had a URL pattern whose every link 404'd — the site has no page for them
// under that naming or any other — and nothing failed, because a 404 is
// invisible until someone clicks. Borodin was never covered either.
test('MISC composers the site does not cover render unlinked', () => {
    const works = JSON.parse(
        readFileSync(new URL('../static/data/all_works.json', import.meta.url), 'utf8'));
    installCatalog(works);
    // Only the composer decides whether a link is offered; the work fields
    // shape the path, so a stand-in title is enough to ask the question.
    const linked = c => generateQuartetRouletteUrl(
        { composer: c, work: { title: works.MISC.find(o => o[c])[c][0] } }) !== null;

    const uncovered = ['Borodin', 'Smetana', 'Verdi'];
    for (const c of uncovered) {
        assert.equal(linked(c), false, `${c} has no page on quartetroulette.com`);
    }
    // Everyone else in MISC is covered and must keep their link.
    const rest = works.MISC.flatMap(Object.keys).filter(c => !uncovered.includes(c));
    assert.ok(rest.length > 0, 'MISC should still carry covered composers');
    for (const c of rest) {
        assert.equal(linked(c), true, `${c} should link to quartetroulette.com`);
    }
});
