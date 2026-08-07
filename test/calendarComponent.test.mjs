import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    isLeapYear,
    daysInYear,
    dayOfYearUTC,
    longestPlayingStreak,
} from '../src/calendarComponent.js';
import { computeAggregateStats } from '../src/dataProcessor.js';

describe('isLeapYear', () => {
    it('flags years divisible by 4 but not 100', () => {
        assert.equal(isLeapYear(2024), true);
        assert.equal(isLeapYear(2020), true);
        assert.equal(isLeapYear(2023), false);
    });

    it('rejects years divisible by 100 but not 400 (centennials)', () => {
        assert.equal(isLeapYear(1900), false);
        assert.equal(isLeapYear(2100), false);
    });

    it('accepts years divisible by 400', () => {
        assert.equal(isLeapYear(2000), true);
        assert.equal(isLeapYear(2400), true);
    });
});

describe('daysInYear', () => {
    it('returns 366 for leap years, 365 otherwise', () => {
        assert.equal(daysInYear(2024), 366);
        assert.equal(daysInYear(2025), 365);
        assert.equal(daysInYear(2000), 366);
        assert.equal(daysInYear(1900), 365);
    });
});

describe('dayOfYearUTC', () => {
    it('returns 1 for Jan 1', () => {
        assert.equal(dayOfYearUTC(new Date(Date.UTC(2026, 0, 1))), 1);
    });

    it('returns 365 for Dec 31 in a non-leap year', () => {
        assert.equal(dayOfYearUTC(new Date(Date.UTC(2025, 11, 31))), 365);
    });

    it('returns 366 for Dec 31 in a leap year', () => {
        assert.equal(dayOfYearUTC(new Date(Date.UTC(2024, 11, 31))), 366);
    });

    it('handles the leap-day boundary correctly', () => {
        assert.equal(dayOfYearUTC(new Date(Date.UTC(2024, 1, 29))), 60); // Feb 29 2024
        assert.equal(dayOfYearUTC(new Date(Date.UTC(2024, 2, 1))), 61);  // Mar 1 2024
        assert.equal(dayOfYearUTC(new Date(Date.UTC(2025, 2, 1))), 60);  // Mar 1 2025 (non-leap)
    });
});

describe('longestPlayingStreak', () => {
    // Dense day-value array for consecutive days starting Jan 1: exactly the
    // shape createCalendar builds via d3.timeDay.range, one entry per calendar
    // day whether or not anything was played. Index i is day i+1 of the month.
    const denseDays = (counts) =>
        counts.map((value, i) => ({ date: new Date(2026, 0, i + 1), value }));

    it('returns 0 for an empty array', () => {
        assert.equal(longestPlayingStreak([]), 0);
    });

    it('returns 0 for a missing year rather than throwing', () => {
        // yearQ.get(year) is undefined for a year with no days; the sibling
        // stat defs degrade to 0 via `?? 0`, so this one must not throw either.
        assert.equal(longestPlayingStreak(undefined), 0);
    });

    it('returns 0 when no day was played', () => {
        assert.equal(longestPlayingStreak(denseDays([0, 0, 0, 0])), 0);
    });

    it('counts a single playing day as a streak of 1', () => {
        assert.equal(longestPlayingStreak(denseDays([0, 1, 0])), 1);
    });

    it('breaks the run on an unplayed day and keeps the longest', () => {
        //                                     1  2  3     5        8  9
        assert.equal(longestPlayingStreak(denseDays([1, 1, 1, 0, 2, 0, 0, 1, 1])), 3);
    });

    it('counts a run that ends on the last day', () => {
        // Regression guard: an implementation that only flushes `run` into
        // `best` when it hits a zero would report 1 here, never seeing the
        // trailing run close.
        assert.equal(longestPlayingStreak(denseDays([1, 0, 1, 1, 1, 1])), 4);
    });

    it('counts a run that starts on the first day', () => {
        assert.equal(longestPlayingStreak(denseDays([1, 1, 0, 1])), 2);
    });

    it('counts every day when the whole span was played', () => {
        assert.equal(longestPlayingStreak(denseDays([3, 1, 4, 1, 5])), 5);
    });

    it('ignores how many pieces were played, only whether any were', () => {
        assert.equal(
            longestPlayingStreak(denseDays([9, 1, 7])),
            longestPlayingStreak(denseDays([1, 1, 1])),
        );
    });

    // The calendar reads adjacency positionally off a dense array; dataProcessor
    // infers it arithmetically from a sparse set of day ordinals. Two algorithms,
    // one definition of "streak" — this pins them together so a change to either
    // side's notion of a playing day can't drift past the other unnoticed.
    it('agrees with computeAggregateStats over the same days', () => {
        const counts = [1, 1, 0, 2, 1, 1, 1, 0, 1, 0, 0, 3, 3];
        const days = denseDays(counts);

        // One row per piece on each played day — the sparse view of the same span.
        const rows = days.flatMap(d => Array.from({ length: d.value }, () => ({
            timestamp: d.date,
            composer: 'Haydn',
            work: { title: '17#1' },
            player1: 'Alice', player2: 'Bob', player3: 'Carol',
            others: '',
        })));

        assert.equal(longestPlayingStreak(days), 4);          // Jan 4-7
        assert.equal(computeAggregateStats(rows).maxStreak, longestPlayingStreak(days));
    });
});
