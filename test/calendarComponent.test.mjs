import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    isLeapYear,
    daysInYear,
    dayOfYearUTC,
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
