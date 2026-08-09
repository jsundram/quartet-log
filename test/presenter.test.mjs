// Tests for the pure computation extracted out of the render layer (D2):
// stat defs, stacked segments, player-filter matching, the network slider
// state machine, table sort comparator, calendar totals, per-tab grouping,
// and chord-label de-overlap. Fixtures use placeholder names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as d3 from "d3";
import { buildAggregateStatDefs } from "../src/statDefs.js";
import {
    PART_ORDER, stackedPartSegments,
    checkPlayersMatch, checkSinglePlayerMatch,
    computeSliderSync, computeNodeCounts,
} from "../src/dataProcessor.js";
import { makeRowComparator } from "../src/tableComponent.js";
import { calculateWeekTotals, calculateDayOfWeekTotals } from "../src/calendarComponent.js";
import { groupPlaysByWork } from "../src/tabComponent.js";
import { chordLabelVisibility } from "../src/musicianNetworkComponent.js";
import { MOBILE_BREAKPOINT, isMobileWidth } from "../src/breakpoints.js";

test("buildAggregateStatDefs", async (t) => {
    const agg = {
        pieces: 42, uniquePieces: 17, uniquePeople: 9, daysPlayed: 30, maxStreak: 5,
        maxStreakInfo: { length: 5, count: 1, start: new Date(Date.UTC(2024, 2, 3)) },
    };

    await t.test("returns the five defs with agg values in order", () => {
        const defs = buildAggregateStatDefs(agg);
        assert.deepEqual(defs.map(d => d.label),
            ['Pieces', 'Unique pieces', 'Unique people', 'Days played', 'Max streak']);
        assert.deepEqual(defs.map(d => d.value), [42, 17, 9, 30, 5]);
        for (const d of defs) assert.ok(d.short && d.title && d.desc);
    });

    await t.test("embeds the window phrase in every title", () => {
        const defs = buildAggregateStatDefs(agg, "in the last 365 days");
        for (const d of defs) assert.match(d.title, /in the last 365 days$/);
    });

    await t.test("streak desc omits the Started suffix when there is no streak", () => {
        const none = buildAggregateStatDefs({ ...agg, maxStreak: 0, maxStreakInfo: { length: 0, count: 0, start: null } });
        assert.doesNotMatch(none.at(-1).desc, /Started:/);
    });
});

test("stackedPartSegments", async (t) => {
    await t.test("stacks in PART_ORDER with running offsets, skipping zeros", () => {
        const segs = stackedPartSegments({ count: 10, parts: { VA: 3, V1: 5, OTHER: 2 } });
        assert.deepEqual(segs, [
            { part: 'V1', count: 5, x0: 0 },
            { part: 'VA', count: 3, x0: 5 },
            { part: 'OTHER', count: 2, x0: 8 },
        ]);
    });

    await t.test("falls back to a single unkeyed segment without a breakdown", () => {
        assert.deepEqual(stackedPartSegments({ count: 7 }),
            [{ part: null, count: 7, x0: 0 }]);
    });

    await t.test("PART_ORDER is the canonical five-part order", () => {
        assert.deepEqual(PART_ORDER, ['V1', 'V2', 'VA', 'VC', 'OTHER']);
    });
});

test("player-filter matching", async (t) => {
    // Slots are relative to the user's part: on a V1 row, player1 = V2 chair,
    // player2 = VA chair, player3 = cello.
    const row = { part: 'V1', player1: 'Alice', player2: 'Bob', player3: 'Carol' };

    await t.test("single-player slot semantics", () => {
        assert.equal(checkSinglePlayerMatch(row, 'Alice', 'v2'), true);
        assert.equal(checkSinglePlayerMatch(row, 'Bob', 'va'), true);
        assert.equal(checkSinglePlayerMatch(row, 'Carol', 'vc'), true);
        assert.equal(checkSinglePlayerMatch(row, 'Alice', 'va'), false);
        assert.equal(checkSinglePlayerMatch(row, 'Mallory', 'vc'), false);
        assert.equal(checkSinglePlayerMatch(row, 'Alice', 'flute'), false);
    });

    await t.test("empty selection matches everything (ANY)", () => {
        assert.equal(checkPlayersMatch(row, []), true);
    });

    await t.test("OR across one person's instruments, AND across people", () => {
        // Alice on v1-or-v2 (v2 matches) AND Carol on vc (matches) → true
        assert.equal(checkPlayersMatch(row, ['Alice.v1', 'Alice.v2', 'Carol.vc']), true);
        // Alice matches but Mallory does not → false
        assert.equal(checkPlayersMatch(row, ['Alice.v2', 'Mallory.vc']), false);
    });
});

test("computeSliderSync", async (t) => {
    // Rows crafted so musicians have distinct piece counts; only relative
    // counts matter. Each row is one piece with three partners.
    const mkRow = (p1, p2, p3, i) => ({
        part: 'V1', player1: p1, player2: p2, player3: p3,
        work: { title: `W${i}` }, composer: 'Haydn',
        timestamp: new Date(2024, 0, 1 + i),
    });
    const names = ['Ann', 'Ben', 'Cy', 'Dee', 'Eve', 'Flo'];
    const rows = [];
    let n = 0;
    // Ann appears in 6 pieces, Ben 5, ... Flo 1.
    names.forEach((name, idx) => {
        for (let i = idx; i < names.length; i++) rows.push(mkRow(name, `X${n}`, `Y${n}`, n++));
    });
    const fresh = { userMinCount: null, lastSelection: null, preSelectionMinCount: null };

    await t.test("max is the 5th-ranked musician's count", () => {
        const counts = computeNodeCounts(rows);
        const next = computeSliderSync(fresh, rows, null);
        assert.equal(next.max, Math.max(1, counts[Math.min(4, counts.length - 1)].count));
    });

    await t.test("first render seeds userMinCount and clamps effectiveMin", () => {
        const next = computeSliderSync(fresh, rows, null);
        assert.notEqual(next.userMinCount, null);
        assert.ok(next.effectiveMin >= 1 && next.effectiveMin <= next.max);
    });

    await t.test("entering a selection backs up the user's value; exiting restores it", () => {
        const before = { userMinCount: 7, lastSelection: null, preSelectionMinCount: null };
        const entered = computeSliderSync(before, rows, 'Ann');
        assert.equal(entered.preSelectionMinCount, 7);
        assert.equal(entered.lastSelection, 'Ann');
        const exited = computeSliderSync(entered, rows, null);
        assert.equal(exited.userMinCount, 7);
        assert.equal(exited.preSelectionMinCount, null);
    });

    await t.test("swapping selection keeps the original backup", () => {
        const entered = computeSliderSync({ userMinCount: 7, lastSelection: null, preSelectionMinCount: null }, rows, 'Ann');
        const swapped = computeSliderSync(entered, rows, 'Ben');
        assert.equal(swapped.preSelectionMinCount, 7);
        const exited = computeSliderSync(swapped, rows, null);
        assert.equal(exited.userMinCount, 7);
    });

    await t.test("dragging within a selection is discarded on deselect", () => {
        const entered = computeSliderSync({ userMinCount: 7, lastSelection: null, preSelectionMinCount: null }, rows, 'Ann');
        const dragged = { ...entered, userMinCount: 2 }; // user dragged the slider
        const exited = computeSliderSync(dragged, rows, null);
        assert.equal(exited.userMinCount, 7);
    });
});

test("makeRowComparator", async (t) => {
    const getValue = (row, key) => key.split('.').reduce((o, k) => o?.[k], row);
    const rows = [
        { work: { title: 'Op. 20 No. 3', catalog: 20, number: 3 }, timestamp: 3 },
        { work: { title: 'Op. 9 No. 1', catalog: 9, number: 1 }, timestamp: 1 },
        { work: { title: 'Op. 20 No. 1', catalog: 20, number: 1 }, timestamp: 2 },
    ];

    await t.test("work.title sorts by catalog then number, not by string", () => {
        const sorted = [...rows].sort(makeRowComparator({ key: 'work.title', direction: 'asc' }, getValue));
        assert.deepEqual(sorted.map(r => r.work.title),
            ['Op. 9 No. 1', 'Op. 20 No. 1', 'Op. 20 No. 3']);
    });

    await t.test("direction desc reverses", () => {
        const sorted = [...rows].sort(makeRowComparator({ key: 'timestamp', direction: 'desc' }, getValue));
        assert.deepEqual(sorted.map(r => r.timestamp), [3, 2, 1]);
    });
});

test("calendar totals", async (t) => {
    const day = (m, d, value) => ({ date: new Date(Date.UTC(2024, m - 1, d)), value });

    await t.test("calculateDayOfWeekTotals counts playing days per weekday", () => {
        // Jan 7 2024 is a Sunday; Jan 8 a Monday.
        const totals = calculateDayOfWeekTotals([
            day(1, 7, 2), day(1, 8, 1), day(1, 14, 1), day(1, 15, 0),
        ]);
        assert.equal(totals[0], 2); // two Sundays played
        assert.equal(totals[1], 1); // one Monday played (Jan 15 had value 0)
        assert.equal(totals.reduce((a, b) => a + b), 3);
    });

    await t.test("calculateWeekTotals sums piece counts into 54 week slots", () => {
        const totals = calculateWeekTotals([day(1, 7, 2), day(1, 8, 3), day(1, 1, 1)], d3.utcSunday);
        assert.equal(totals.length, 54);
        assert.equal(totals[0], 1);      // Jan 1-6 (week 0)
        assert.equal(totals[1], 5);      // Jan 7 + Jan 8 (week 1)
    });
});

test("groupPlaysByWork", async (t) => {
    const rows = [
        { composer: 'Haydn', work: { title: 'Op. 20 No. 2' } },
        { composer: 'Haydn', work: { title: 'Op. 20 No. 2' } },
        { composer: 'Haydn', work: { title: 'Uncatalogued Piece' } },
        { composer: 'Mozart', work: { title: 'K. 421' } },
    ];
    const opts = {
        composers: ['Haydn'],
        works: ['Op. 20 No. 2', 'Op. 76 No. 1'],
        transformTitle: d => d.work.title,
    };

    await t.test("groups by title, keeping only catalog works for the tab's composers", () => {
        const { filteredPlays } = groupPlaysByWork(rows, rows, opts);
        assert.equal(filteredPlays.get('Op. 20 No. 2').length, 2);
        assert.equal(filteredPlays.has('Uncatalogued Piece'), false);
        assert.equal(filteredPlays.has('K. 421'), false);
    });

    await t.test("every catalog title is present, unplayed ones as []", () => {
        const { filteredPlays } = groupPlaysByWork([], rows, opts);
        assert.deepEqual([...filteredPlays.keys()], ['Op. 20 No. 2', 'Op. 76 No. 1']);
        assert.deepEqual(filteredPlays.get('Op. 76 No. 1'), []);
    });
});

test("chordLabelVisibility hides labels that would overlap the previous shown one", () => {
    // Three arcs: two tightly packed, one far away. font 10, radius 100
    // → half-angular ≈ 0.05 rad.
    const groups = [
        { startAngle: 0.00, endAngle: 0.10 },  // mid 0.05 → shown, right edge 0.10
        { startAngle: 0.10, endAngle: 0.14 },  // mid 0.12, left edge 0.07 < 0.10 → hidden
        { startAngle: 1.00, endAngle: 1.20 },  // far away → shown
    ];
    assert.deepEqual(chordLabelVisibility(groups, () => 10, 100), [true, false, true]);
});

test("breakpoints", () => {
    assert.equal(isMobileWidth(MOBILE_BREAKPOINT - 1), true);
    assert.equal(isMobileWidth(MOBILE_BREAKPOINT), false);
});
