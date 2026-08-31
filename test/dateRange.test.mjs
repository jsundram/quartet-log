import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { monthsAgo, startOfDay, presetBounds } from '../src/dateRange.js';

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

describe('presetBounds', () => {
    // Pinned so the expectations are fixed dates rather than restatements of
    // the implementation. Aug 31 14:00 is the interesting clock: a 31st (so
    // 6M has to clamp into February) at a non-midnight time.
    const NOW = new Date(2025, 7, 31, 14, 0, 0);
    const BEGIN = () => new Date(2019, 4, 1);

    it('maps each range id to its own start', () => {
        assert.equal(ymd(presetBounds('ALL', NOW, BEGIN)[0]), '2019-05-01');
        assert.equal(ymd(presetBounds('YTD', NOW, BEGIN)[0]), '2025-01-01');
        assert.equal(ymd(presetBounds('1Y', NOW, BEGIN)[0]), '2024-08-31');
        assert.equal(ymd(presetBounds('6M', NOW, BEGIN)[0]), '2025-02-28');
        assert.equal(ymd(presetBounds('1M', NOW, BEGIN)[0]), '2025-07-31');
    });

    it('anchors every start at midnight, including ALL and YTD', () => {
        for (const id of ['ALL', 'YTD', '1Y', '6M', '1M']) {
            const [start] = presetBounds(id, NOW, BEGIN);
            assert.equal(start.getHours(), 0, `${id} start is midnight`);
            assert.equal(start.getMinutes(), 0, `${id} start is midnight`);
            assert.equal(start.getMilliseconds(), 0, `${id} start is midnight`);
        }
    });

    it('ends at the passed-in now, so the window tracks the clock', () => {
        const [, end] = presetBounds('1M', NOW, BEGIN);
        assert.equal(end.getTime(), NOW.getTime());
        // A later read of the same range covers the newer session.
        const later = new Date(2025, 7, 31, 18, 30);
        const [, laterEnd] = presetBounds('1M', later, BEGIN);
        assert.ok(laterEnd > end);
    });

    it('falls back to the data start for an unknown id', () => {
        assert.equal(ymd(presetBounds('NOPE', NOW, BEGIN)[0]), '2019-05-01');
    });

    it('only asks for the data start when the range needs it', () => {
        // getBegin() throws until setBegin() has seen data, and the widget is
        // constructed before that happens — so the relative ranges must not
        // touch it.
        const boom = () => { throw new Error('getBegin called'); };
        for (const id of ['YTD', '1Y', '6M', '1M']) {
            assert.doesNotThrow(() => presetBounds(id, NOW, boom), `${id} is clock-only`);
        }
        assert.throws(() => presetBounds('ALL', NOW, boom), /getBegin called/);
    });
});
