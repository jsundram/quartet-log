// @ts-check
// Date-range arithmetic for the segmented range picker. Pure calendar math
// with no widget, DOM or config dependency, so it imports nothing — the
// caller injects whatever it needs (see `presetBounds`).

/**
 * The same day-of-month `months` months before `date`, clamped to that
 * month's last day when it is shorter (Mar 31 → Feb 29 in a leap year,
 * Feb 28 otherwise). Time-of-day is preserved.
 *
 * The naive `setMonth(getMonth() - n)` overflows instead of clamping —
 * Mar 31 becomes Feb 31, which Date rolls forward to Mar 2/3, landing the
 * start of the window AFTER the month it should cover. Shifting from the
 * 1st sidesteps that, then the day is set explicitly.
 *
 * @param {Date} date
 * @param {number} months
 * @returns {Date}
 */
export function monthsAgo(date, months) {
    const day = date.getDate();
    const target = new Date(date);
    target.setDate(1);
    target.setMonth(target.getMonth() - months);
    // Day 0 of the following month is the last day of the target month.
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, lastDay));
    return target;
}

/**
 * Midnight at the start of `date`'s day, in local time.
 *
 * Every preset range start is anchored through this, so a window is a whole
 * number of days: asking for 1M at 14:00 on Aug 31 starts at Jul 31 00:00 and
 * counts a session logged that morning. Without it, monthsAgo carries the
 * current clock time onto the boundary day and silently drops the earlier
 * part of it — and since the Custom inputs already anchor at midnight
 * (fromDateInputValue), the same two visible dates meant two different
 * windows depending on which control produced them.
 *
 * @param {Date} date
 * @returns {Date}
 */
export function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * The `[start, end]` bounds of a preset range, as of `now`.
 *
 * Derived on every read rather than cached at click time: a relative range
 * means "the last month", not "the month before the button was pressed".
 * A cached pair goes stale in place — filterRows is inclusive against the
 * end, so a session logged after the click is fetched by revalidate() and
 * then filtered straight back out, and an installed PWA resumed the next
 * morning silently shows "1M as of yesterday". CUSTOM has no entry here
 * because its pair is explicit user input, not a function of the clock.
 *
 * `getBeginDate` is injected and called only by the branches that need it:
 * getBegin() throws until setBegin() has seen data, and the widget is
 * constructed before that happens.
 *
 * @param {string} rangeId
 * @param {Date} now
 * @param {() => Date} getBeginDate
 * @returns {[Date, Date]}
 */
export function presetBounds(rangeId, now, getBeginDate) {
    let start;

    switch (rangeId) {
        case 'ALL':
            // Already the 1st of a month at midnight (setBegin normalizes it),
            // so the startOfDay below is a no-op here rather than evidence
            // that getBegin() can return an arbitrary time.
            start = getBeginDate();
            break;
        case 'YTD':
            start = new Date(now.getFullYear(), 0, 1);
            break;
        case '1Y':
            start = monthsAgo(now, 12);
            break;
        case '6M':
            start = monthsAgo(now, 6);
            break;
        case '1M':
            start = monthsAgo(now, 1);
            break;
        default:
            start = getBeginDate();
    }

    return [startOfDay(start), now];
}
