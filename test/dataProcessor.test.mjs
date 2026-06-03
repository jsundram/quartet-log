import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseOthers,
    classOf,
    canonicalize,
    stripParens,
    normalizePlayerNames,
    peopleKeysFor,
    computeAggregateStats,
    normalizeDashboardPart,
    computeNodeCounts,
    computeEdgeCounts,
    buildNetworkData,
    defaultMinPiecesForGraph,
    disambiguateLabels,
    partFromInstrument,
    computePartBreakdownPerMusician,
    predominantPart,
} from '../src/dataProcessor.js';

// Hand-built rows for the network helpers. Reflects the real data model:
// player1/player2/player3 are the OTHER three quartet members — the user
// is implicit via d.part and never listed in any player slot. othersList
// is the normalized form of the "Others?" column.
function row(p1, p2, p3, others = []) {
    return {
        player1: p1,
        player2: p2,
        player3: p3,
        othersList: others.map(name => ({ name, instrument: null, class: null })),
    };
}

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
        assert.equal(canonicalize('Alice', 'cello'), 'Alice');
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
            parseOthers('Alice (vla2), josh (vc2), Nathaniel Jarrett (asst v2)'),
            [
                { name: 'Alice', instrument: 'vla2' },
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

    it('Henry Weinberger on multiple instruments collapses to one key (within Set)', () => {
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

describe('computeAggregateStats', () => {
    const mkRow = (overrides = {}) => normalizePlayerNames([{
        timestamp: new Date('2026-01-01T12:00:00'),
        composer: 'Haydn',
        work: { title: '17#1' },
        player1: '', player2: '', player3: '',
        others: '',
        ...overrides,
    }])[0];

    it('returns zeroed stats for an empty array', () => {
        assert.deepEqual(computeAggregateStats([]), {
            pieces: 0, uniquePieces: 0, uniquePeople: 0, daysPlayed: 0,
        });
    });

    it('counts pieces as raw row count', () => {
        const rows = [mkRow(), mkRow(), mkRow()];
        assert.equal(computeAggregateStats(rows).pieces, 3);
    });

    it('collapses repeats of the same (composer, work.title) into one unique piece', () => {
        const rows = [
            mkRow({ composer: 'Haydn', work: { title: '17#1' } }),
            mkRow({ composer: 'Haydn', work: { title: '17#1' } }),
            mkRow({ composer: 'Haydn', work: { title: '17#2' } }),
            mkRow({ composer: 'Mozart', work: { title: '17#1' } }),
        ];
        // (Haydn,17#1), (Haydn,17#2), (Mozart,17#1) → 3
        assert.equal(computeAggregateStats(rows).uniquePieces, 3);
    });

    it('counts canonical people across player slots and othersList', () => {
        const rows = [
            mkRow({ player1: 'Jen', player2: 'Isaac', player3: 'Jen',
                    others: 'Marshall (va2)' }),
        ];
        // Jen[upper]→Jen Hsiao, Isaac[upper]→Isaac Krauss, Jen[cello]→Jen Minnich, Marshall(va2)→Marshall
        // = 4 distinct people
        assert.equal(computeAggregateStats(rows).uniquePeople, 4);
    });

    it('buckets days by local-time calendar date', () => {
        const rows = [
            mkRow({ timestamp: new Date(2026, 0, 1, 8, 0) }),   // Jan 1 morning
            mkRow({ timestamp: new Date(2026, 0, 1, 22, 0) }),  // Jan 1 evening
            mkRow({ timestamp: new Date(2026, 0, 2, 10, 0) }),  // Jan 2
        ];
        assert.equal(computeAggregateStats(rows).daysPlayed, 2);
    });

    it('skips rows with no timestamp / no work title without crashing', () => {
        const rows = [
            { ...mkRow(), timestamp: null },
            { ...mkRow(), work: null },
            mkRow(),
        ];
        const s = computeAggregateStats(rows);
        assert.equal(s.pieces, 3);
        assert.equal(s.uniquePieces, 1);  // only the third row contributes
        assert.equal(s.daysPlayed, 1);    // only rows with timestamps
    });
});

describe('normalizeDashboardPart', () => {
    it('passes V1 / V2 through unchanged', () => {
        assert.equal(normalizeDashboardPart('V1'), 'V1');
        assert.equal(normalizeDashboardPart('V2'), 'V2');
    });

    it('folds VA, VA1, VA2 into VA', () => {
        assert.equal(normalizeDashboardPart('VA'), 'VA');
        assert.equal(normalizeDashboardPart('VA1'), 'VA');
        assert.equal(normalizeDashboardPart('VA2'), 'VA');
        // Any future "VA*" would also fold; only VA-prefixed strings collapse.
        assert.equal(normalizeDashboardPart('VA3'), 'VA');
    });

    it('returns null for empty / unknown parts', () => {
        assert.equal(normalizeDashboardPart(''), null);
        assert.equal(normalizeDashboardPart(null), null);
        assert.equal(normalizeDashboardPart(undefined), null);
        assert.equal(normalizeDashboardPart('VC'), null);
        assert.equal(normalizeDashboardPart('piano'), null);
    });
});

describe('computeNodeCounts', () => {
    it('counts unique pieces per musician from peopleKeysFor', () => {
        const rows = [
            row('Alice', 'Bob', 'Carol'),
            row('Alice', 'Dave', 'Carol'),
            row('Alice', 'Bob', null),
        ];
        const counts = computeNodeCounts(rows);
        assert.deepEqual(counts, [
            { name: 'Alice', count: 3 },
            { name: 'Bob', count: 2 },
            { name: 'Carol', count: 2 },
            { name: 'Dave', count: 1 },
        ]);
    });

    it('de-dupes within a piece (othersList duplicate)', () => {
        const rows = [row('Alice', null, null, ['Alice'])];
        const counts = computeNodeCounts(rows);
        assert.deepEqual(counts, [{ name: 'Alice', count: 1 }]);
    });

    it('sorts desc by count, asc by name on ties', () => {
        const rows = [
            row('Zach', 'Alice', null),
            row('Bob', 'Alice', null),
        ];
        const counts = computeNodeCounts(rows);
        assert.deepEqual(counts.map(c => c.name), ['Alice', 'Bob', 'Zach']);
    });

    // The Top Musicians dashboard chart uses the same per-piece de-dup over
    // peopleKeysFor. If this invariant ever breaks, the network's node set
    // would diverge from the Top Musicians chart's data — which is the
    // exact bug that surfaced when an inferred "user" was incorrectly
    // filtered out of the network. Lock the contract.
    it('matches per-piece de-duped peopleKeysFor counts (Top Musicians parity)', () => {
        const rows = [
            row('Alice', 'Bob', 'Carol', ['Dave']),
            row('Alice', 'Bob', null),
            row('Bob', 'Carol', null, ['Alice']),
        ];
        const counts = computeNodeCounts(rows);
        const expected = new Map();
        rows.forEach(r => {
            new Set(peopleKeysFor(r)).forEach(name => {
                expected.set(name, (expected.get(name) ?? 0) + 1);
            });
        });
        assert.equal(counts.length, expected.size);
        counts.forEach(({ name, count }) => assert.equal(count, expected.get(name)));
    });
});

describe('computeEdgeCounts', () => {
    it('generates all unordered pairs in a piece', () => {
        const rows = [row('Alice', 'Bob', null, ['Carol'])];
        const allowed = new Set(['Alice', 'Bob', 'Carol']);
        const edges = computeEdgeCounts(rows, allowed);
        assert.equal(edges.length, 3);
        const keys = edges.map(e => `${e.source}-${e.target}`).sort();
        assert.deepEqual(keys, ['Alice-Bob', 'Alice-Carol', 'Bob-Carol']);
    });

    it('increments existing pairs across pieces', () => {
        const rows = [
            row('Alice', 'Bob', null),
            row('Alice', 'Bob', null),
            row('Alice', 'Carol', null),
        ];
        const allowed = new Set(['Alice', 'Bob', 'Carol']);
        const edges = computeEdgeCounts(rows, allowed);
        const ab = edges.find(e => e.source === 'Alice' && e.target === 'Bob');
        const ac = edges.find(e => e.source === 'Alice' && e.target === 'Carol');
        assert.equal(ab.weight, 2);
        assert.equal(ac.weight, 1);
    });

    it('skips pairs where either endpoint is not in allowedSet', () => {
        const rows = [row('Alice', 'Bob', null, ['Eve'])];
        const allowed = new Set(['Alice', 'Bob']);
        const edges = computeEdgeCounts(rows, allowed);
        assert.equal(edges.length, 1);
        assert.equal(edges[0].source, 'Alice');
        assert.equal(edges[0].target, 'Bob');
    });

    it('returns source < target lexicographically', () => {
        const rows = [row('Zach', 'Alice', null)];
        const allowed = new Set(['Zach', 'Alice']);
        const edges = computeEdgeCounts(rows, allowed);
        assert.equal(edges[0].source, 'Alice');
        assert.equal(edges[0].target, 'Zach');
    });
});

describe('buildNetworkData', () => {
    it('drops nodes below minCount', () => {
        const rows = [
            row('Alice', 'Bob', null, ['Carol', 'Dave']),
            row('Alice', 'Bob', null),
            row('Alice', null, null),
        ];
        // Alice=3, Bob=2, Carol=1, Dave=1
        const { nodes } = buildNetworkData(rows, 2);
        assert.deepEqual(nodes.map(n => n.name), ['Alice', 'Bob']);
    });

    it('drops edges whose endpoints are not both in the node set', () => {
        const rows = [
            row('Alice', 'Bob', null, ['Carol']),
            row('Alice', 'Bob', null),
            row('Alice', null, null),
        ];
        // Alice=3, Bob=2, Carol=1. minCount=2 → only Alice + Bob.
        const { edges } = buildNetworkData(rows, 2);
        assert.equal(edges.length, 1);
        assert.equal(edges[0].source, 'Alice');
        assert.equal(edges[0].target, 'Bob');
    });

    it('defaults minCount to 1 (every musician with any piece)', () => {
        const rows = [
            row('Alice', 'Bob', null),
            row('Carol', null, null),
        ];
        const { nodes } = buildNetworkData(rows);
        assert.equal(nodes.length, 3);
    });

    // Regression: a previous iteration "inferred a user" and stripped the
    // top-1 musician from every piece. Lock the invariant that the #1
    // musician by pieces is always included as long as their count meets
    // the threshold.
    it('includes the top-1 musician when their count meets the threshold', () => {
        const rows = [
            row('Alice', 'Bob', 'Carol'),
            row('Alice', 'Dave', 'Carol'),
            row('Alice', 'Bob', 'Frank'),
            row('Alice', 'Greta', 'Hank'),
            row('Bob', 'Dave', null),
        ];
        const counts = computeNodeCounts(rows);
        const { nodes } = buildNetworkData(rows, counts[0].count);
        assert.equal(nodes[0].name, 'Alice');
        // At threshold = top-1's count, only that musician (and any tied)
        // should appear.
        assert.equal(nodes.length, 1);
    });
});

describe('defaultMinPiecesForGraph', () => {
    it('returns 1 when there are fewer musicians than the cap', () => {
        const rows = [
            row('Alice', 'Bob', null),
            row('Alice', 'Carol', null),
        ];
        // 3 musicians, cap=50 → include everyone
        assert.equal(defaultMinPiecesForGraph(rows, 50), 1);
    });

    it('returns 1 for empty data', () => {
        assert.equal(defaultMinPiecesForGraph([], 50), 1);
    });

    it('picks the count at the cap boundary when counts are distinct', () => {
        // Build 5 musicians with distinct piece counts 5, 4, 3, 2, 1.
        const rows = [];
        const names = ['A', 'B', 'C', 'D', 'E'];
        names.forEach((name, i) => {
            const c = names.length - i;
            for (let k = 0; k < c; k++) rows.push(row(name, null, null));
        });
        // With cap=3, the 3rd musician has count 3. T=3 keeps A(5), B(4), C(3) → exactly 3.
        assert.equal(defaultMinPiecesForGraph(rows, 3), 3);
    });

    it('bumps past ties at the cap boundary to stay at or under the cap', () => {
        // 4 musicians with counts [5, 3, 3, 1]. Cap=2: T=3 keeps 3 nodes (>2),
        // so bump to T=4 → keeps only A(5). Stays ≤ 2.
        const rows = [
            row('Alice', null, null), row('Alice', null, null),
            row('Alice', null, null), row('Alice', null, null), row('Alice', null, null),
            row('Bob', null, null), row('Bob', null, null), row('Bob', null, null),
            row('Carol', null, null), row('Carol', null, null), row('Carol', null, null),
            row('Dave', null, null),
        ];
        assert.equal(defaultMinPiecesForGraph(rows, 2), 4);
    });
});

describe('disambiguateLabels', () => {
    it('uses first name when unique', () => {
        const nodes = [{ name: 'Alice Smith' }, { name: 'Bob Jones' }];
        const labels = disambiguateLabels(nodes);
        assert.equal(labels.get('Alice Smith'), 'Alice');
        assert.equal(labels.get('Bob Jones'), 'Bob');
    });

    it('falls back to First L. on first-name collision', () => {
        const nodes = [{ name: 'Jen Hsiao' }, { name: 'Jen Minnich' }];
        const labels = disambiguateLabels(nodes);
        assert.equal(labels.get('Jen Hsiao'), 'Jen H.');
        assert.equal(labels.get('Jen Minnich'), 'Jen M.');
    });

    it('falls back to full name when First L. still collides', () => {
        const nodes = [{ name: 'John Smith' }, { name: 'John Smith Jr' }, { name: 'John Sturges' }];
        const labels = disambiguateLabels(nodes);
        // 'John S.' would match all three (Smith, Smith Jr → "Jr" initial,
        // Sturges → "Sturges" initial). Actually Smith and Sturges both
        // start with S, so John S. matches Smith and Sturges. Smith Jr's
        // last token is "Jr" → "John J." which is unique.
        assert.equal(labels.get('John Smith Jr'), 'John J.');
        assert.equal(labels.get('John Smith'), 'John Smith');
        assert.equal(labels.get('John Sturges'), 'John Sturges');
    });

    it('passes single-token names through unchanged', () => {
        const nodes = [{ name: 'Madonna' }, { name: 'Bob Jones' }];
        const labels = disambiguateLabels(nodes);
        assert.equal(labels.get('Madonna'), 'Madonna');
        assert.equal(labels.get('Bob Jones'), 'Bob');
    });
});

describe('partFromInstrument', () => {
    it('parses canonical V1/V2/VA/VC tags', () => {
        assert.equal(partFromInstrument('v1'), 'V1');
        assert.equal(partFromInstrument('V2'), 'V2');
        assert.equal(partFromInstrument('va'), 'VA');
        assert.equal(partFromInstrument('vc'), 'VC');
    });

    it('handles numbered variants (va2, vc2)', () => {
        assert.equal(partFromInstrument('va2'), 'VA');
        assert.equal(partFromInstrument('vc2'), 'VC');
        assert.equal(partFromInstrument('v1'), 'V1');
    });

    it('treats vla as viola', () => {
        assert.equal(partFromInstrument('vla'), 'VA');
        assert.equal(partFromInstrument('VLA'), 'VA');
        assert.equal(partFromInstrument('vla2'), 'VA');
    });

    it('strips an "asst" or "ast" prefix', () => {
        assert.equal(partFromInstrument('asst v2'), 'V2');
        assert.equal(partFromInstrument('ast v1'), 'V1');
    });

    it('buckets non-string instruments and unknowns as OTHER', () => {
        assert.equal(partFromInstrument('piano'), 'OTHER');
        assert.equal(partFromInstrument('harpsichord'), 'OTHER');
        assert.equal(partFromInstrument(''), 'OTHER');
        assert.equal(partFromInstrument(null), 'OTHER');
        assert.equal(partFromInstrument(undefined), 'OTHER');
    });
});

describe('computePartBreakdownPerMusician', () => {
    // Helper that makes rows with an explicit user part so SLOT_TO_PART
    // can map slot indices correctly.
    const r = (part, p1, p2, p3, others = []) => ({
        part,
        player1: p1,
        player2: p2,
        player3: p3,
        othersList: others.map(([name, instrument]) => ({
            name,
            instrument,
            class: null,
        })),
    });

    it('maps player slots via the user part table', () => {
        const rows = [
            r('V1', 'Alice', 'Bob', 'Carol'), // Alice=V2, Bob=VA, Carol=VC
            r('V2', 'Alice', 'Bob', 'Carol'), // Alice=V1, Bob=VA, Carol=VC
            r('VA', 'Alice', 'Bob', 'Carol'), // Alice=V1, Bob=V2, Carol=VC
        ];
        const breakdown = computePartBreakdownPerMusician(rows);
        assert.deepEqual(breakdown.get('Alice'), { V1: 2, V2: 1, VA: 0, VC: 0, OTHER: 0 });
        assert.deepEqual(breakdown.get('Bob'),   { V1: 0, V2: 1, VA: 2, VC: 0, OTHER: 0 });
        assert.deepEqual(breakdown.get('Carol'), { V1: 0, V2: 0, VA: 0, VC: 3, OTHER: 0 });
    });

    it('attributes othersList entries by parsed instrument', () => {
        const rows = [
            r('V1', null, null, null, [
                ['Dave', 'vc2'],
                ['Eve', 'piano'],
                ['Frank', 'asst v2'],
                ['Greta', 'vla'],
            ]),
        ];
        const breakdown = computePartBreakdownPerMusician(rows);
        assert.deepEqual(breakdown.get('Dave'),  { V1: 0, V2: 0, VA: 0, VC: 1, OTHER: 0 });
        assert.deepEqual(breakdown.get('Eve'),   { V1: 0, V2: 0, VA: 0, VC: 0, OTHER: 1 });
        assert.deepEqual(breakdown.get('Frank'), { V1: 0, V2: 1, VA: 0, VC: 0, OTHER: 0 });
        assert.deepEqual(breakdown.get('Greta'), { V1: 0, V2: 0, VA: 1, VC: 0, OTHER: 0 });
    });

    it('skips rows with non-canonical user parts (e.g. quintet VA2)', () => {
        const rows = [
            r('VA2', 'Alice', 'Bob', 'Carol'),
            r('V1', 'Alice', null, null), // Alice=V2 here
        ];
        const breakdown = computePartBreakdownPerMusician(rows);
        // VA2 row contributes nothing for player1/2/3 (slot mapping undefined),
        // so Alice's only credit is V2 from the V1 row.
        assert.deepEqual(breakdown.get('Alice'), { V1: 0, V2: 1, VA: 0, VC: 0, OTHER: 0 });
        // Bob and Carol from the VA2 row never get registered.
        assert.equal(breakdown.get('Bob'), undefined);
        assert.equal(breakdown.get('Carol'), undefined);
    });

    it('sums to per-musician piece count (parity with computeNodeCounts)', () => {
        const rows = [
            r('V1', 'Alice', 'Bob', 'Carol'),
            r('V2', 'Alice', 'Dave', 'Carol'),
            r('VA', 'Alice', 'Bob', null, [['Eve', 'piano']]),
        ];
        const breakdown = computePartBreakdownPerMusician(rows);
        const sum = b => b.V1 + b.V2 + b.VA + b.VC + b.OTHER;
        assert.equal(sum(breakdown.get('Alice')), 3);
        assert.equal(sum(breakdown.get('Bob')), 2);
        assert.equal(sum(breakdown.get('Carol')), 2);
        assert.equal(sum(breakdown.get('Dave')), 1);
        assert.equal(sum(breakdown.get('Eve')), 1);
    });
});

describe('predominantPart', () => {
    it('returns the part with the most pieces', () => {
        assert.equal(predominantPart({ V1: 10, V2: 3, VA: 0, VC: 0, OTHER: 0 }), 'V1');
        assert.equal(predominantPart({ V1: 0, V2: 0, VA: 0, VC: 12, OTHER: 0 }), 'VC');
        assert.equal(predominantPart({ V1: 0, V2: 0, VA: 0, VC: 0, OTHER: 5 }), 'OTHER');
    });

    it('breaks ties in V1 > V2 > VA > VC > OTHER order', () => {
        assert.equal(predominantPart({ V1: 3, V2: 3, VA: 0, VC: 0, OTHER: 0 }), 'V1');
        assert.equal(predominantPart({ V1: 0, V2: 5, VA: 5, VC: 0, OTHER: 0 }), 'V2');
        assert.equal(predominantPart({ V1: 0, V2: 0, VA: 4, VC: 4, OTHER: 0 }), 'VA');
        assert.equal(predominantPart({ V1: 0, V2: 0, VA: 0, VC: 2, OTHER: 2 }), 'VC');
    });

    it('returns null for null/empty input', () => {
        assert.equal(predominantPart(null), null);
        assert.equal(predominantPart(undefined), null);
        assert.equal(predominantPart({ V1: 0, V2: 0, VA: 0, VC: 0, OTHER: 0 }), null);
    });
});
