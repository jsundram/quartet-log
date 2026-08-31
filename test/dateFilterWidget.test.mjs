import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { monthsAgo, startOfDay } from '../src/dateFilterWidget.js';

// Local-time date, formatted the way the widget's date inputs are.
function ymd(d) {
    return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
    ].join('-');
}

describe('monthsAgo', () => {
    it('keeps the same day of month when the target month is long enough', () => {
        assert.equal(ymd(monthsAgo(new Date(2025, 7, 15), 1)), '2025-07-15');
        assert.equal(ymd(monthsAgo(new Date(2025, 7, 1), 1)), '2025-07-01');
        assert.equal(ymd(monthsAgo(new Date(2025, 7, 31), 1)), '2025-07-31');
    });

    it('clamps to the last day when the target month is shorter', () => {
        // Mar 31 → Feb 28 in a common year, Feb 29 in a leap year.
        assert.equal(ymd(monthsAgo(new Date(2025, 2, 31), 1)), '2025-02-28');
        assert.equal(ymd(monthsAgo(new Date(2024, 2, 31), 1)), '2024-02-29');
        // Mar 29/30 clamp too, but only in a common year.
        assert.equal(ymd(monthsAgo(new Date(2025, 2, 30), 1)), '2025-02-28');
        assert.equal(ymd(monthsAgo(new Date(2025, 2, 29), 1)), '2025-02-28');
        assert.equal(ymd(monthsAgo(new Date(2024, 2, 29), 1)), '2024-02-29');
        // 31-day month back to a 30-day one.
        assert.equal(ymd(monthsAgo(new Date(2025, 6, 31), 1)), '2025-06-30');
        assert.equal(ymd(monthsAgo(new Date(2025, 9, 31), 1)), '2025-09-30');
    });

    it('crosses the year boundary', () => {
        assert.equal(ymd(monthsAgo(new Date(2025, 0, 31), 1)), '2024-12-31');
        assert.equal(ymd(monthsAgo(new Date(2025, 0, 1), 1)), '2024-12-01');
    });

    it('preserves time of day', () => {
        const start = monthsAgo(new Date(2025, 2, 31, 13, 45, 30, 250), 1);
        assert.equal(ymd(start), '2025-02-28');
        assert.equal(start.getHours(), 13);
        assert.equal(start.getMinutes(), 45);
        assert.equal(start.getSeconds(), 30);
        assert.equal(start.getMilliseconds(), 250);
    });

    it('does not mutate its argument', () => {
        const d = new Date(2025, 2, 31);
        monthsAgo(d, 1);
        assert.equal(ymd(d), '2025-03-31');
    });

    it('handles multi-month offsets', () => {
        // The 6M range: Aug 31 back six months lands in February, so it
        // clamps for the same reason 1M does.
        assert.equal(ymd(monthsAgo(new Date(2025, 7, 31), 6)), '2025-02-28');
        assert.equal(ymd(monthsAgo(new Date(2024, 7, 31), 6)), '2024-02-29');
        assert.equal(ymd(monthsAgo(new Date(2025, 7, 15), 6)), '2025-02-15');
        assert.equal(ymd(monthsAgo(new Date(2025, 2, 31), 6)), '2024-09-30');
        assert.equal(ymd(monthsAgo(new Date(2025, 7, 15), 12)), '2024-08-15');
    });

    it('clamps the leap day for the 1Y range', () => {
        // setFullYear() would overflow Feb 29 -> Mar 1 of the prior year,
        // silently dropping Feb 28 from the window.
        assert.equal(ymd(monthsAgo(new Date(2028, 1, 29), 12)), '2027-02-28');
        assert.equal(ymd(monthsAgo(new Date(2028, 1, 29), 48)), '2024-02-29');
    });
});

describe('startOfDay', () => {
    it('zeroes the time of day', () => {
        const d = startOfDay(new Date(2025, 7, 31, 14, 30, 12, 500));
        assert.equal(ymd(d), '2025-08-31');
        assert.equal(d.getHours(), 0);
        assert.equal(d.getMinutes(), 0);
        assert.equal(d.getSeconds(), 0);
        assert.equal(d.getMilliseconds(), 0);
    });

    it('leaves a date already at midnight alone', () => {
        const d = startOfDay(new Date(2025, 0, 1));
        assert.equal(d.getTime(), new Date(2025, 0, 1).getTime());
    });

    it('does not mutate its argument', () => {
        const d = new Date(2025, 7, 31, 14, 0, 0);
        startOfDay(d);
        assert.equal(d.getHours(), 14);
    });

    it('includes a session logged earlier on the boundary day', () => {
        // The reason the anchor exists: 1M clicked at 14:00 on Aug 31 must
        // still count a session logged at 10:00 on Jul 31.
        const start = startOfDay(monthsAgo(new Date(2025, 7, 31, 14, 0), 1));
        const session = new Date(2025, 6, 31, 10, 0);
        assert.ok(start <= session, 'boundary-day session falls inside the window');
    });
});
