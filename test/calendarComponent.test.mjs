import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    isLeapYear,
    daysInYear,
    dayOfYearUTC,
    statColumnY,
} from '../src/calendarComponent.js';

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

describe('statColumnY', () => {
    const CS = 17;

    it('centers six stats in the six gaps between the 7 weekday rows', () => {
        // Weekday rows are centered at (0.5 .. 6.5) * cellSize, so their
        // interior gaps sit at 1..6 * cellSize.
        const ys = [0, 1, 2, 3, 4, 5].map(i => statColumnY(i, 6, CS));
        assert.deepEqual(ys, [1, 2, 3, 4, 5, 6].map(n => n * CS));
    });

    it('centers the stack on the grid midpoint for any count', () => {
        for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const ys = Array.from({ length: count }, (_, i) => statColumnY(i, count, CS));
            const mid = (ys[0] + ys[count - 1]) / 2;
            assert.equal(mid, 3.5 * CS, `count=${count}`);
        }
    });

    it('spaces consecutive stats one cell apart', () => {
        assert.equal(statColumnY(1, 6, CS) - statColumnY(0, 6, CS), CS);
    });

    it('puts an odd count on the weekday row centers', () => {
        assert.equal(statColumnY(0, 7, CS), 0.5 * CS);
        assert.equal(statColumnY(6, 7, CS), 6.5 * CS);
    });

    it('keeps the stack inside the 10-cell year band at the 8-stat cap', () => {
        assert.ok(statColumnY(0, 8, CS) >= 0);
        assert.ok(statColumnY(7, 8, CS) <= 10 * CS);
    });
});
