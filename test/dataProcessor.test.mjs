import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseOthers,
    classOf,
    canonicalize,
    stripParens,
    normalizePlayerNames,
    peopleKeysFor,
} from '../src/dataProcessor.js';

// canonicalize tests depend on real entries in PLAYER_ALIASES (Jen, Isaac).
// If those entries are removed, these tests should fail loudly — that's the
// signal the alias map's behavior changed, not a test bug.

describe('stripParens', () => {
    it('drops a trailing parenthetical instrument annotation', () => {
        assert.equal(stripParens('Lois Shapiro (piano)'), 'Lois Shapiro');
        assert.equal(stripParens('Henry (piano)'), 'Henry');
    });

    it('leaves plain names alone', () => {
        assert.equal(stripParens('Henry'), 'Henry');
        assert.equal(stripParens('Mary Carfagna'), 'Mary Carfagna');
    });

    it('handles empty / falsy input without throwing', () => {
        assert.equal(stripParens(''), '');
        assert.equal(stripParens(null), null);
        assert.equal(stripParens(undefined), undefined);
    });

    it('does not strip parens in the middle of a name', () => {
        // Defensive — the regex anchors to end. Middle parens stay.
        assert.equal(stripParens('Foo (a) Bar'), 'Foo (a) Bar');
    });
});

describe('classOf', () => {
    it('returns "cello" for vc-prefixed instruments (any case)', () => {
        assert.equal(classOf('vc'), 'cello');
        assert.equal(classOf('vc2'), 'cello');
        assert.equal(classOf('VC1'), 'cello');
        assert.equal(classOf('  vc  '), 'cello');
    });

    it('returns "upper" for violin/viola/piano/etc.', () => {
        assert.equal(classOf('v1'), 'upper');
        assert.equal(classOf('v2'), 'upper');
        assert.equal(classOf('va'), 'upper');
        assert.equal(classOf('va2'), 'upper');
        assert.equal(classOf('vla'), 'upper');
        assert.equal(classOf('piano'), 'upper');
        assert.equal(classOf('asst v2'), 'upper');
    });

    it('returns null for missing/empty instrument', () => {
        assert.equal(classOf(''), null);
        assert.equal(classOf(null), null);
        assert.equal(classOf(undefined), null);
    });
});

describe('canonicalize', () => {
    it('returns the canonical for a known (name, class) pair', () => {
        assert.equal(canonicalize('Jen', 'upper'), 'Jen Hsiao');
        assert.equal(canonicalize('Jen', 'cello'), 'Jen Minnich');
        assert.equal(canonicalize('Isaac', 'upper'), 'Isaac Krauss');
    });

    it('returns the input when the alias entry has no mapping for the given class', () => {
        // Isaac has only an "upper" alias, not "cello"
        assert.equal(canonicalize('Isaac', 'cello'), 'Isaac');
    });

    it('returns the input when name is not in the alias map', () => {
        assert.equal(canonicalize('Marshall', 'upper'), 'Marshall');
        assert.equal(canonicalize('Elaine', 'cello'), 'Elaine');
    });

    it('skips aliasing when class is null/undefined', () => {
        assert.equal(canonicalize('Jen', null), 'Jen');
        assert.equal(canonicalize('Jen', undefined), 'Jen');
    });

    it('passes empty/falsy names through unchanged', () => {
        assert.equal(canonicalize('', 'upper'), '');
        assert.equal(canonicalize(null, 'upper'), null);
        assert.equal(canonicalize(undefined, 'upper'), undefined);
    });
});

describe('parseOthers', () => {
    it('returns an empty array for empty input', () => {
        assert.deepEqual(parseOthers(''), []);
        assert.deepEqual(parseOthers(null), []);
        assert.deepEqual(parseOthers(undefined), []);
    });

    it('parses a single "Name (instrument)" fragment', () => {
        assert.deepEqual(parseOthers('Lois (piano)'), [
            { name: 'Lois', instrument: 'piano' },
        ]);
    });

    it('parses a bare name with no instrument annotation', () => {
        assert.deepEqual(parseOthers('Clara'), [
            { name: 'Clara', instrument: null },
        ]);
    });

    it('splits on semicolons', () => {
        assert.deepEqual(parseOthers('Louisa (vc2); josh (vc2)'), [
            { name: 'Louisa', instrument: 'vc2' },
            { name: 'josh', instrument: 'vc2' },
        ]);
    });

    it('splits on commas as a fallback separator', () => {
        assert.deepEqual(
            parseOthers('Elaine (vla2), josh (vc2), Nathaniel Jarrett (asst v2)'),
            [
                { name: 'Elaine', instrument: 'vla2' },
                { name: 'josh', instrument: 'vc2' },
                { name: 'Nathaniel Jarrett', instrument: 'asst v2' },
            ],
        );
    });

    it('trims whitespace around fragments', () => {
        assert.deepEqual(parseOthers('  Jess Lin  '), [
            { name: 'Jess Lin', instrument: null },
        ]);
    });

    it('filters out the "-" sentinel and empty fragments', () => {
        assert.deepEqual(parseOthers('-'), []);
        assert.deepEqual(parseOthers('A;;B'), [
            { name: 'A', instrument: null },
            { name: 'B', instrument: null },
        ]);
    });

    it('mixes annotated and bare fragments in one cell', () => {
        assert.deepEqual(parseOthers('A (v2); B'), [
            { name: 'A', instrument: 'v2' },
            { name: 'B', instrument: null },
        ]);
    });
});

describe('normalizePlayerNames', () => {
    const mkRow = (overrides = {}) => ({
        player1: '',
        player2: '',
        player3: '',
        others: '',
        ...overrides,
    });

    it('aliases player1/player2 as upper and player3 as cello', () => {
        const data = [mkRow({ player1: 'Jen', player2: 'Isaac', player3: 'Jen' })];
        normalizePlayerNames(data);
        // Jen[upper] → Jen Hsiao; Isaac[upper] → Isaac Krauss; Jen[cello] → Jen Minnich
        assert.equal(data[0].player1, 'Jen Hsiao');
        assert.equal(data[0].player2, 'Isaac Krauss');
        assert.equal(data[0].player3, 'Jen Minnich');
    });

    it('strips a trailing "(instrument)" from player slots before aliasing', () => {
        const data = [mkRow({ player1: 'Lois Shapiro (piano)', player2: 'Jen (violin)' })];
        normalizePlayerNames(data);
        assert.equal(data[0].player1, 'Lois Shapiro');
        // Jen with class "upper" (player2 slot) resolves via alias to Jen Hsiao
        assert.equal(data[0].player2, 'Jen Hsiao');
    });

    it('attaches a parsed, canonicalized othersList', () => {
        const data = [mkRow({ others: 'Jen (vc2); Marshall (va2)' })];
        normalizePlayerNames(data);
        assert.deepEqual(data[0].othersList, [
            { name: 'Jen Minnich', instrument: 'vc2', class: 'cello' },
            { name: 'Marshall', instrument: 'va2', class: 'upper' },
        ]);
    });

    it('handles a row with empty slots and no Others?', () => {
        const data = [mkRow()];
        normalizePlayerNames(data);
        assert.equal(data[0].player1, '');
        assert.deepEqual(data[0].othersList, []);
    });

    it('returns the input array (for chaining)', () => {
        const data = [mkRow({ player1: 'Marshall' })];
        const result = normalizePlayerNames(data);
        assert.equal(result, data);
    });
});

describe('peopleKeysFor', () => {
    it('returns canonical names from player1/2/3', () => {
        const row = {
            player1: 'Jen Hsiao',
            player2: 'Marshall',
            player3: 'Jen Minnich',
            othersList: [],
        };
        assert.deepEqual(peopleKeysFor(row), ['Jen Hsiao', 'Marshall', 'Jen Minnich']);
    });

    it('skips empty and "-" sentinel player slots', () => {
        const row = {
            player1: 'Marshall',
            player2: '',
            player3: '-',
            othersList: [],
        };
        assert.deepEqual(peopleKeysFor(row), ['Marshall']);
    });

    it('includes othersList entries by canonical name only', () => {
        const row = {
            player1: 'Jen Hsiao',
            player2: '',
            player3: '',
            othersList: [
                { name: 'Lois Shapiro', instrument: 'piano', class: 'upper' },
                { name: 'Jen Minnich', instrument: 'vc2', class: 'cello' },
            ],
        };
        assert.deepEqual(peopleKeysFor(row), ['Jen Hsiao', 'Lois Shapiro', 'Jen Minnich']);
    });

    it('handles a row with no othersList field at all', () => {
        const row = { player1: 'Marshall', player2: '', player3: '' };
        assert.deepEqual(peopleKeysFor(row), ['Marshall']);
    });

    it('Jen Hsiao + Jen Minnich in the same row produce two distinct keys', () => {
        // The whole point of instrument-aware aliasing: the two Jens count as two.
        const data = [
            { player1: 'Jen', player2: 'Marshall', player3: 'Jen', others: '' },
        ];
        normalizePlayerNames(data);
        const keys = peopleKeysFor(data[0]);
        assert.ok(keys.includes('Jen Hsiao'));
        assert.ok(keys.includes('Jen Minnich'));
        assert.equal(new Set(keys).size, 3);
    });

    it('Henry Weinberger on multiple instruments collapses to one key', () => {
        // Same person, different instruments — should NOT split.
        // Henry[upper] aliases to Henry Weinberger; "Henry Weinberger" in Others?
        // stays canonical regardless of class.
        const data = [
            { player1: 'Henry', player2: 'Marshall', player3: 'Stephanie',
              others: 'Henry Weinberger (vc)' },
        ];
        normalizePlayerNames(data);
        const keys = peopleKeysFor(data[0]);
        // Player1's "Henry" canonicalized to "Henry Weinberger"; Others' Henry Weinberger
        // stays as "Henry Weinberger" (already canonical). Both contribute the same key.
        const henryCount = keys.filter(k => k === 'Henry Weinberger').length;
        assert.equal(henryCount, 2); // appears twice in the list...
        assert.equal(new Set(keys).size, 3); // ...but de-dupes in a Set to one person
    });
});
