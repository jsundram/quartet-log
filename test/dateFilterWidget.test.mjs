import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DateFilterWidget } from '../src/dateFilterWidget.js';
import { setBegin } from '../src/config.js';
import { monthsAgo } from '../src/dateRange.js';

// The one place the widget itself has to be loaded: everything below is
// about the wiring between the range id and the arithmetic, which the pure
// tests in dateRange.test.mjs can't see. No DOM is needed — root() is only
// called from render()/handleRangeClick, so the constructor and getRange()
// run fine under node:test.

function ymd(d) {
    return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
    ].join('-');
}

function widget(defaultRange) {
    return new DateFilterWidget('#nonexistent', () => {}, { defaultRange });
}

describe('DateFilterWidget range wiring', () => {
    it('gives each preset the start its id names', () => {
        const now = new Date();
        assert.equal(ymd(widget('1M').getRange()[0]), ymd(monthsAgo(now, 1)));
        assert.equal(ymd(widget('6M').getRange()[0]), ymd(monthsAgo(now, 6)));
        assert.equal(ymd(widget('1Y').getRange()[0]), ymd(monthsAgo(now, 12)));
        assert.equal(ymd(widget('YTD').getRange()[0]), ymd(new Date(now.getFullYear(), 0, 1)));
    });

    it('anchors preset starts at midnight', () => {
        for (const id of ['1M', '6M', '1Y', 'YTD']) {
            assert.equal(widget(id).getRange()[0].getHours(), 0, `${id} start is midnight`);
        }
    });

    it('re-derives a preset window on every read', async () => {
        // The bug this guards: endDate frozen at click time, so a session
        // logged after the range was chosen is fetched by revalidate() and
        // then filtered straight back out by the inclusive end bound.
        const w = widget('1M');
        const first = w.getRange()[1];
        await new Promise(r => setTimeout(r, 5));
        assert.ok(w.getRange()[1] > first, 'end tracks the clock between reads');
    });

    it('serves CUSTOM from the explicit pair instead of the clock', () => {
        const w = widget('1M');
        w.currentRange = 'CUSTOM';
        w.startDate = new Date(2024, 0, 1);
        w.endDate = new Date(2024, 1, 1, 23, 59, 59, 999);
        const [start, end] = w.getRange();
        assert.equal(ymd(start), '2024-01-01');
        assert.equal(ymd(end), '2024-02-01');
    });

    it('reads the data start only for ALL', () => {
        // getBegin() throws until setBegin() has seen data, and App constructs
        // NavigationComponent (hence this widget) before calling setBegin.
        assert.doesNotThrow(() => widget('1M'), 'relative ranges never touch BEGIN');
        setBegin(new Date(2019, 4, 17, 9, 30));
        // setBegin normalizes to the 1st of the month at midnight, so ALL's
        // startOfDay wrapper is a no-op here.
        assert.equal(ymd(widget('ALL').getRange()[0]), '2019-05-01');
    });
});
