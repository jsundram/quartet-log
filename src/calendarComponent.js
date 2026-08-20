import * as d3 from "d3";
import { getBegin, CALENDAR_CONFIG, getCssColor } from './config.js';
import { computeAggregateStats } from './dataProcessor.js';
import { isCurrentlyDark } from './themeManager.js';
import { escapeHtml } from './escapeHtml.js';
import { tooltip } from './tooltip.js';
import { buildAggregateStatDefs } from './statDefs.js';

// Body of a day tooltip (date heading, piece count, plays table). Pure and
// exported for tests: every sheet-derived cell (composer, work title, part,
// player names) is escaped.
export function buildDayTooltipHtml(d, formatDate, sessionData) {
    const pieces = d.value === 1 ? "piece" : "pieces";
    let html = `<h4>${escapeHtml(formatDate(d.date))}</h4>`;
    html += `<p>${d.value} ${pieces} played</p>`;

    if (sessionData && sessionData.length > 0) {
        html += `<table class="calendar-tooltip-table">`;
        html += `<thead><tr><th>Composer</th><th>Work</th><th>Part</th><th>Players</th></tr></thead>`;
        html += `<tbody>`;
        sessionData.forEach(session => {
            const composer = session.composer || '';
            const work = session.work?.title || session.workTitle || '';
            const part = session.part || '';
            const players = [session.player1, session.player2, session.player3]
                .filter(p => p)
                .join(', ');
            html += `<tr>`;
            html += `<td>${escapeHtml(composer)}</td>`;
            html += `<td>${escapeHtml(work)}</td>`;
            html += `<td>${escapeHtml(part)}</td>`;
            html += `<td>${escapeHtml(players)}</td>`;
            html += `</tr>`;
        });
        html += `</tbody></table>`;
    }
    return html;
}

// Year math for the per-year stat tooltips. UTC-based to match the way the
// calendar groups days (d.date.getUTCFullYear()), so "what year" / "what day
// of year" stays consistent with the bucket the data was assigned to.
export function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

export function daysInYear(year) {
    return isLeapYear(year) ? 366 : 365;
}

// Per-week piece totals for one year's day-value array. 54 slots: a leap
// year starting on Saturday spans 54 Sunday-weeks. Pure — exported for tests.
export function calculateWeekTotals(values, timeWeek) {
    const weekTotals = new Array(54).fill(0);
    values.forEach(d => {
        const weekNum = timeWeek.count(d3.utcYear(d.date), d.date);
        if (weekNum < 54) {
            weekTotals[weekNum] += d.value;
        }
    });
    return weekTotals;
}

// Count of playing days per weekday (0=Sunday … 6=Saturday). Pure —
// exported for tests.
export function calculateDayOfWeekTotals(values) {
    const dayTotals = new Array(7).fill(0);
    values.forEach(d => {
        if (d.value > 0) {
            const dayOfWeek = d.date.getUTCDay();
            dayTotals[dayOfWeek]++;
        }
    });
    return dayTotals;
}

// 1-based day of year: Jan 1 → 1, Dec 31 → 365 (or 366 in leap years).
export function dayOfYearUTC(date) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 1);
    const ms = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start;
    return Math.floor(ms / 86400000) + 1;
}

export class CalendarComponent {
    constructor() {
        this.width = CALENDAR_CONFIG.width;
        this.cellSize = CALENDAR_CONFIG.cellSize;
        this.height = CALENDAR_CONFIG.height;

        // Lightbox / fullscreen mode (same pattern as MusicianNetworkComponent).
        // When on, #calendar fills the viewport via the .fullscreen CSS class
        // and the grid renders in the transposed vertical layout, sized so a
        // whole year fits the viewport height.
        this._isFullscreen = false;
        this._escHandler = null;
        this._resizeHandler = null;
    }

    // Called on theme change. Clears the existing calendar DOM and rebuilds
    // with whatever color values the CSS now resolves to (the d3 SVG fills
    // and the canvas-rendered legend gradient are both baked at build time
    // so they need a fresh pass). Only removes nodes this component created
    // (.calendar-gen) — the static <h1> in index.html stays.
    rerender() {
        if (!this.data) return;
        d3.select("#calendar").selectAll(":scope > .calendar-gen").remove();
        this.createCalendar(this.data);
    }

    createCalendar(data) {
        this.data = data;
        const formatDate = d3.utcFormat("%x");
        const formatDay = i => "SMTWTFS"[i];
        const formatMonth = d3.utcFormat("%b");
        const timeWeek = d3.utcSunday;
        const countDay = i => i;

        // Process data for calendar view. `data` has already had partial-movement
        // entries filtered out (DataService.processData), so every count here —
        // value, weekly/monthly/yearly totals, unique pieces — is whole-pieces-only.
        const now = new Date();
        const sessions = new Map(d3.group(data, d => d3.timeDay(d.timestamp).getTime()));
        const v = d => sessions.get(d.getTime())?.length ?? 0;
        const days = d3.timeDay.range(getBegin(), now).map(d => ({date: d, value: v(d)}));

        // Color scale for calendar. In dark mode we invert interpolateGreens
        // (high counts map to the *light* end, low counts to dark) so busy
        // days read as bright cells glowing against the dark bg. Theme can
        // change at runtime via themeManager; rerender() rebuilds the whole
        // calendar (including this scale) when that happens.
        const interpolator = isCurrentlyDark()
            ? (t => d3.interpolateGreens(1 - t))
            : d3.interpolateGreens;
        const color = d3.scaleSequential(interpolator).domain([0, 10]);

        // Group by year
        const years = d3.groups(days, d => d.date.getUTCFullYear()).reverse();

        // Per-year aggregate stats, derived from the same computeAggregateStats
        // that feeds the ALL tab, Dashboard KPI tiles, and "Last 365 days"
        // header — so the per-year numbers agree with the rest of the app by
        // construction. Rows are bucketed into years by the same expression
        // the grid uses for days (d3.timeDay(...).getUTCFullYear()), so the
        // stat column can't disagree with the band it renders beside, and the
        // streak is scoped to the band's slice — it splits at the band
        // boundary (local New Year's at UTC-and-west offsets; east of UTC the
        // grid's bands run Jan 2–Jan 1, and the split follows them). Future-
        // dated rows are dropped to mirror the grid's day range ending today
        // (and renderRecentStats' `timestamp <= now` upper bound); seeding
        // from `years` gives every rendered band an entry by construction.
        const yearRows = d3.group(data.filter(d => d.timestamp <= now),
            d => d3.timeDay(d.timestamp).getUTCFullYear());
        const yearStats = new Map(years.map(([y]) =>
            [y, computeAggregateStats(yearRows.get(y) ?? [])]));

        const container = d3.select("#calendar");

        // Expand / exit-fullscreen button. Rebuilt on every render pass so
        // its icon + label always match the current mode.
        this._appendFullscreenButton(container);

        const config = {
            timeWeek,
            formatDay,
            formatMonth,
            formatDate,
            countDay,
            color,
            sessions,
            yearStats
        };

        // Fullscreen: transposed layout — weeks run down, days across, one
        // narrow column per year, panning horizontally across years
        // (chronological, oldest leftmost; opens scrolled to the current
        // year at the right edge). Sized so a full year fits the viewport
        // height. Legend + recent stats are omitted to give the grid every
        // pixel.
        if (this._isFullscreen) {
            this.renderYearGroupsVertical(container, years, config);
            return;
        }

        // Top row: legend + last-365-days summary side by side.
        const top = container.append("div")
            .attr("class", "calendar-top calendar-gen");

        this.createLegend({
            parent: top,
            color,
            title: "# Quartets Played",
            // SVG is exactly 10 calendar cells wide (no internal padding).
            // CSS positions / sizes it to track the calendar's first 10 cells.
            width: 10 * this.cellSize,
            tickValues: [0, 2, 4, 6, 8, 10],
            tickFormat: i => (i == 10) ? "10+" : d3.format("d")(i)
        });

        this.renderRecentStats(top, data, 365);

        // Create calendar SVG
        const svg = container.append("svg")
            .attr("class", "calendar-gen")
            .attr("width", this.width)
            .attr("height", this.height * years.length)
            .attr("viewBox", [0, 0, this.width, this.height * years.length])
            .attr("style", "max-width: 100%; height: auto; font: 10px sans-serif;");

        this.renderYearGroups(svg, years, config);
    }

    // Expand/collapse control shared with the network graph's look
    // (.network-fullscreen-btn); .calendar-fullscreen-btn only positions it.
    _appendFullscreenButton(container) {
        const label = this._isFullscreen ? 'Exit full screen' : 'Expand to full screen';
        const iconAttrs = 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
        const icon = this._isFullscreen
            ? `<svg ${iconAttrs}><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`
            : `<svg ${iconAttrs}><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`;
        container.append("button")
            .attr("type", "button")
            .attr("class", "calendar-gen network-fullscreen-btn calendar-fullscreen-btn")
            .attr("title", label)
            .attr("aria-label", label)
            .html(icon)
            .on("click", () => this._toggleFullscreen());
    }

    // Mirrors MusicianNetworkComponent._toggleFullscreen: #calendar becomes a
    // fixed overlay via the .fullscreen class, the page behind is frozen, and
    // the calendar re-renders in the vertical layout fitted to the viewport.
    _toggleFullscreen() {
        this._isFullscreen = !this._isFullscreen;
        d3.select("#calendar").classed("fullscreen", this._isFullscreen);
        document.body.classList.toggle("calendar-fullscreen-open", this._isFullscreen);
        this.hideTooltip();

        if (this._isFullscreen) {
            this._escHandler = (e) => {
                if (e.key === "Escape") this._toggleFullscreen();
            };
            document.addEventListener("keydown", this._escHandler);
            // Re-fit on rotation / mobile browser-chrome show-hide / native
            // fullscreen entry+exit (both fire a resize). Note: a gesture
            // exit from *native* fullscreen deliberately leaves the lightbox
            // open — the 100dvh overlay still covers the visible viewport,
            // and the collapse button / Esc remain the explicit way out.
            this._resizeHandler = () => this.rerender();
            window.addEventListener("resize", this._resizeHandler);
            this._requestNativeFullscreen();
        } else {
            if (this._escHandler) {
                document.removeEventListener("keydown", this._escHandler);
                this._escHandler = null;
            }
            if (this._resizeHandler) {
                window.removeEventListener("resize", this._resizeHandler);
                this._resizeHandler = null;
            }
            this._exitNativeFullscreen();
        }
        this.rerender();
    }

    // Native fullscreen (progressive enhancement): hides the browser chrome
    // entirely so the grid gets the whole physical screen. Where the API is
    // unavailable or refused, the fixed-overlay + 100dvh CSS still covers
    // the visible viewport, so every failure path is silently ignored.
    //
    // Fullscreen is requested on <html>, NOT on #calendar: browsers render
    // only the fullscreen element's subtree, and the tooltip div is a child
    // of <body>, so fullscreening #calendar would make tooltips invisible.
    _fullscreenElement() {
        return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
    }

    _requestNativeFullscreen() {
        const el = document.documentElement;
        const request = el.requestFullscreen || el.webkitRequestFullscreen;
        try {
            request?.call(el, { navigationUI: "hide" })?.catch?.(() => {});
        } catch { /* older engines throw synchronously — fall back to CSS overlay */ }
    }

    _exitNativeFullscreen() {
        if (!this._fullscreenElement()) return;
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        try {
            exit?.call(document)?.catch?.(() => {});
        } catch { /* ignore */ }
    }

    renderYearGroups(svg, years, config) {
        const { timeWeek, formatDay, formatMonth, formatDate, countDay, color, sessions } = config;

        const year = svg.selectAll("g")
            .data(years)
            .join("g")
            .attr("transform", (d, i) => `translate(40.5,${this.height * i + this.cellSize * 1.5})`);

        // Year label
        year.append("text")
            .attr("x", -5)
            .attr("y", -5)
            .attr("font-weight", "bold")
            .attr("text-anchor", "end")
            .text(([key]) => key);

        // Day of week labels
        year.append("g")
            .attr("text-anchor", "end")
            .selectAll()
            .data(d3.range(7))
            .join("text")
            .attr("x", -5)
            .attr("y", i => (countDay(i) + 0.5) * this.cellSize)
            .attr("dy", "0.31em")
            .text(formatDay);

        // Day-of-week totals (count of days played per weekday)
        year.append("g")
            .attr("text-anchor", "middle")
            .selectAll()
            .data(([, values]) => calculateDayOfWeekTotals(values))
            .join("text")
            .attr("x", this.cellSize * 53 + this.cellSize / 2)
            .attr("y", (d, i) => (countDay(i) + 0.5) * this.cellSize)
            .attr("dy", "0.31em")
            .attr("fill", getCssColor('--color-text-chart'))
            .attr("font-size", "9px")
            .text(d => d > 0 ? d : "");

        // Per-year stats (shifted right to make room for day-of-week totals).
        // One stacked bare number per stat; the tooltip explains which is which.
        const statDefs = this._yearStatDefs(config);
        // The year band is a fixed CALENDAR_CONFIG.height (10 cells) with
        // stats at cellSize*(2 + i): rows 0..6 fit, an eighth would silently
        // spill into the next year's band. Fail loudly in dev instead.
        console.assert(statDefs.length <= Math.floor(this.height / this.cellSize) - 3,
            'per-year stat column overflows its year band');
        statDefs.forEach((def, i) => {
            const statText = year.append("g")
                .attr("text-anchor", "start")
                .selectAll()
                .data(([year]) => [year])
                .join("text")
                    .attr("x", () => this.cellSize*54 + 10)
                    .attr("y", () => this.cellSize*(2 + i))
                    .attr("dy", ".31em")
                    .text(year => def.value(year));
            this.attachStatTooltip(statText, def.title, def.desc);
        });

        // Calendar cells
        this.renderCalendarCells(year, timeWeek, countDay, color, formatDate, sessions);

        // Add month paths and labels
        this.renderMonthLabels(year, timeWeek, formatMonth);

        // Weekly totals at bottom of each column
        year.append("g")
            .selectAll()
            .data(([, values]) => calculateWeekTotals(values, timeWeek))
            .join("text")
            .attr("x", (d, i) => i * this.cellSize + this.cellSize / 2)
            .attr("y", 7 * this.cellSize + 12)
            .attr("text-anchor", "middle")
            .attr("fill", getCssColor('--color-text-chart'))
            .attr("font-size", "8px")
            .text(d => d > 0 ? d : "");
    }

    // The six per-year stats (value + tooltip content), shared by the
    // horizontal layout's right-hand column and the vertical layout's
    // below-grid rows so the numbers and explanations can't drift apart.
    // Each def wraps buildAggregateStatDefs over config.yearStats (per-year
    // computeAggregateStats output), so the values AND the tooltip copy are
    // single-sourced with the ALL tab, Dashboard KPI tiles, and "Last 365
    // days" header — a metric or copy change in statDefs.js lands here too.
    // Only the current-year projection suffixes below are calendar-specific.
    _yearStatDefs({ yearStats }) {
        const defsFor = year => buildAggregateStatDefs(yearStats.get(year), `in ${year}`);
        // Tooltip suffixes only the calendar shows, keyed by the def's short
        // label so a reorder in statDefs.js can't misattach them.
        const extras = {
            Pieces: year => {
                const today = new Date();
                if (year !== today.getUTCFullYear()) return '';
                const elapsed = Math.max(1, dayOfYearUTC(today));
                const projected = Math.floor(yearStats.get(year).pieces * daysInYear(year) / elapsed);
                return `On track for: ${projected}`;
            },
            Days: year => {
                const today = new Date();
                const denom = year === today.getUTCFullYear()
                    ? Math.max(1, dayOfYearUTC(today))
                    : daysInYear(year);
                const pct = (yearStats.get(year).daysPlayed / denom * 100).toFixed(1);
                return `${pct}% of days`;
            },
        };
        // A zero-stats template supplies the def count and short labels (the
        // per-year defs differ only in the values interpolated).
        return buildAggregateStatDefs(computeAggregateStats([])).map((t, i) => ({
            // The vertical layout prints this after the bold number ("12 pieces").
            label: t.short.toLowerCase(),
            value: year => defsFor(year)[i].value,
            title: year => defsFor(year)[i].title,
            desc: year => {
                const desc = defsFor(year)[i].desc;
                const extra = extras[t.short]?.(year);
                return extra ? `${desc}<br><br>${extra}` : desc;
            },
        }));
    }

    // Fullscreen layout: the calendar transposed — days of week across the
    // top (7 columns), weeks running down (up to 54 rows), so a whole year
    // fits the viewport height on a portrait phone. One column per year,
    // most recent leftmost; the container pans horizontally across years.
    renderYearGroupsVertical(container, years, config) {
        const { timeWeek, formatDay, formatMonth, formatDate, countDay, color, sessions } = config;
        const statDefs = this._yearStatDefs(config);

        // Chronological left-to-right (the shared `years` array is newest-
        // first for the horizontal layout's top-down stacking). The container
        // is scrolled to its right edge below, so the newest year is what's
        // on screen when the lightbox opens.
        const yearsAsc = years.slice().reverse();

        // Fit the cell size to the viewport height. 54 week rows (a leap
        // year starting on Saturday spans 54 Sunday-weeks, e.g. 2000).
        const ROWS = 54;
        const node = container.node();
        const cs = getComputedStyle(node);
        const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const availH = (node.clientHeight || window.innerHeight) - padV;
        const topMargin = 42;   // year label + day-of-week header
        const statRowH = 14;
        const bottomMargin = 16 + statDefs.length * statRowH + 8; // dow totals + stat rows
        const cell = Math.max(7, Math.min(20, Math.floor((availH - topMargin - bottomMargin) / ROWS)));
        const leftMargin = 30;  // month labels + monthly totals
        const rightPad = 22;    // weekly totals
        const stride = leftMargin + 7 * cell + rightPad + 14;

        const svgH = topMargin + ROWS * cell + bottomMargin;
        const svgW = yearsAsc.length * stride;
        const svg = container.append("svg")
            .attr("class", "calendar-gen")
            .attr("width", svgW)
            .attr("height", svgH)
            .attr("viewBox", [0, 0, svgW, svgH])
            .attr("style", "font: 10px sans-serif;");

        const year = svg.selectAll("g")
            .data(yearsAsc)
            .join("g")
            .attr("transform", (d, i) => `translate(${i * stride + leftMargin},${topMargin})`);

        // Year label centered over the 7-day grid
        year.append("text")
            .attr("x", 3.5 * cell)
            .attr("y", -26)
            .attr("text-anchor", "middle")
            .attr("font-weight", "bold")
            .attr("font-size", "13px")
            .text(([key]) => key);

        // Day of week labels across the top
        year.append("g")
            .attr("text-anchor", "middle")
            .selectAll()
            .data(d3.range(7))
            .join("text")
            .attr("x", i => (countDay(i) + 0.5) * cell)
            .attr("y", -8)
            .text(formatDay);

        // Calendar cells (transposed: x = day of week, y = week)
        this.renderCalendarCells(year, timeWeek, countDay, color, formatDate, sessions, { cellSize: cell, vertical: true });

        // Month dividers, labels and totals down the left side
        this.renderMonthLabelsVertical(year, timeWeek, formatMonth, cell);

        // Weekly totals to the right of each week row
        year.append("g")
            .attr("text-anchor", "start")
            .selectAll()
            .data(([, values]) => calculateWeekTotals(values, timeWeek))
            .join("text")
            .attr("x", 7 * cell + 4)
            .attr("y", (d, i) => (i + 0.5) * cell)
            .attr("dy", "0.31em")
            .attr("fill", getCssColor('--color-text-chart'))
            .attr("font-size", "8px")
            .text(d => d > 0 ? d : "");

        // Day-of-week totals below the grid
        year.append("g")
            .attr("text-anchor", "middle")
            .selectAll()
            .data(([, values]) => calculateDayOfWeekTotals(values))
            .join("text")
            .attr("x", (d, i) => (countDay(i) + 0.5) * cell)
            .attr("y", ROWS * cell + 12)
            .attr("fill", getCssColor('--color-text-chart'))
            .attr("font-size", "9px")
            .text(d => d > 0 ? d : "");

        // Per-year stats below the day-of-week totals. Unlike the horizontal
        // layout's bare-number column, there's room for a short label here.
        const statY = ROWS * cell + 30;
        statDefs.forEach((def, i) => {
            const statText = year.append("g")
                .attr("text-anchor", "start")
                .selectAll()
                .data(([year]) => [year])
                .join("text")
                    .attr("x", 0)
                    .attr("y", statY + i * statRowH);
            statText.append("tspan")
                .attr("font-weight", "bold")
                .text(year => def.value(year));
            statText.append("tspan")
                .attr("fill", getCssColor('--color-text-chart'))
                .text(` ${def.label}`);
            this.attachStatTooltip(statText, def.title, def.desc);
        });

        // Open at the right edge: the newest (current) year is in view first,
        // and panning left walks back through time. Runs after the SVG is in
        // the DOM so scrollWidth is final (browser clamps to the max).
        node.scrollLeft = node.scrollWidth;
    }

    renderMonthLabelsVertical(year, timeWeek, formatMonth, cell) {
        const month = year.append("g")
            .selectAll()
            .data(([, values]) => {
                const months = d3.utcMonths(d3.utcMonth(values[0].date), values.at(-1).date);
                return months.map(m => ({ month: m, yearValues: values }));
            })
            .join("g");

        month.filter((d, i) => i).append("path")
            .attr("fill", "none")
            .attr("stroke", getCssColor('--color-border-month-divider'))
            .attr("stroke-width", 3)
            .attr("d", d => this.pathMonthVertical(d.month, cell));

        const labelY = d => timeWeek.count(d3.utcYear(d.month), timeWeek.ceil(d.month)) * cell;

        month.append("text")
            .attr("x", -4)
            .attr("y", d => labelY(d) + 9)
            .attr("text-anchor", "end")
            .text(d => formatMonth(d.month));

        // Monthly totals (days.pieces) under the month label
        month.append("text")
            .attr("x", -4)
            .attr("y", d => labelY(d) + 19)
            .attr("text-anchor", "end")
            .attr("fill", getCssColor('--color-text-chart'))
            .attr("font-size", "8px")
            .text(d => {
                const monthStart = d.month;
                const monthEnd = d3.utcMonth.offset(d.month, 1);
                const monthData = d.yearValues.filter(v => v.date >= monthStart && v.date < monthEnd);
                const days = monthData.filter(v => v.value > 0).length;
                const pieces = d3.sum(monthData, v => v.value);
                return `${days}.${pieces}`;
            });
    }

    // pathMonth with x/y swapped: the boundary line drawn above each month.
    pathMonthVertical(t, cell) {
        const d = t.getUTCDay();
        const w = d3.utcSunday.count(d3.utcYear(t), t);
        return `${d === 0 ? `M0,${w * cell}`
            : `M0,${(w + 1) * cell}H${d * cell}V${w * cell}`}H${7 * cell}`;
    }

    renderCalendarCells(year, timeWeek, countDay, color, formatDate, sessions, { cellSize = this.cellSize, vertical = false } = {}) {
        const week = d => timeWeek.count(d3.utcYear(d.date), d.date);
        const dow = d => countDay(d.date.getUTCDay());
        year.append("g")
            .selectAll()
            .data(([, values]) => values)
            .join("rect")
            .attr("width", cellSize - 1)
            .attr("height", cellSize - 1)
            .attr("x", d => (vertical ? dow(d) : week(d)) * cellSize + 0.5)
            .attr("y", d => (vertical ? week(d) : dow(d)) * cellSize + 0.5)
            .attr("fill", d => d.value == 0 ? getCssColor('--color-bg-empty-cell') : color(d.value))
            .call(sel => tooltip.attach(sel, (event, d) => {
                if (d.value === 0) return null; // no tooltip for empty days
                return buildDayTooltipHtml(d, formatDate, sessions.get(d.date.getTime()));
            }));
    }

    renderMonthLabels(year, timeWeek, formatMonth) {
        const cellSize = this.cellSize;

        const month = year.append("g")
            .selectAll()
            .data(([, values]) => {
                // Attach year values to each month for stats calculation
                const months = d3.utcMonths(d3.utcMonth(values[0].date), values.at(-1).date);
                return months.map(m => ({ month: m, yearValues: values }));
            })
            .join("g");

        month.filter((d, i) => i).append("path")
            .attr("fill", "none")
            .attr("stroke", getCssColor('--color-border-month-divider'))
            .attr("stroke-width", 3)
            .attr("d", d => this.pathMonth(d.month));

        month.append("text")
            .attr("x", d => timeWeek.count(d3.utcYear(d.month), timeWeek.ceil(d.month)) * cellSize + 2)
            .attr("y", -5)
            .text(d => formatMonth(d.month));

        // Monthly totals (days|pieces) - right aligned at month end
        month.append("text")
            .attr("x", d => {
                // Get the last day of this month (one day before first of next month)
                const lastDayOfMonth = d3.utcDay.offset(d3.utcMonth.offset(d.month, 1), -1);
                const endWeek = d3.utcSunday.count(d3.utcYear(d.month), lastDayOfMonth);
                // Position at right edge of that week's column
                return (endWeek + 1) * cellSize - 2;
            })
            .attr("y", -5)
            .attr("text-anchor", "end")
            .attr("fill", getCssColor('--color-text-chart'))
            .attr("font-size", "9px")
            .text(d => {
                const monthStart = d.month;
                const monthEnd = d3.utcMonth.offset(d.month, 1);
                const monthData = d.yearValues.filter(v => v.date >= monthStart && v.date < monthEnd);
                const days = monthData.filter(v => v.value > 0).length;
                const pieces = d3.sum(monthData, v => v.value);
                return `${days}.${pieces}`;
            });
    }

    pathMonth(t) {
        const d = t.getUTCDay();
        const w = d3.utcSunday.count(d3.utcYear(t), t);
        return `${d === 0 ? `M${w * this.cellSize},0`
            : `M${(w + 1) * this.cellSize},0V${d * this.cellSize}H${w * this.cellSize}`}V${7 * this.cellSize}`;
    }

    // https://stackoverflow.com/questions/64803258/¬
    createLegend({
        parent = d3.select("#calendar"),
        color,
        title,
        tickSize = 6,
        width = 320,
        height = 44 + tickSize,
        marginTop = 18,
        marginRight = 0,
        marginBottom = 16 + tickSize,
        marginLeft = 0,
        ticks = width / 64,
        tickFormat,
        tickValues
    } = {}) {
        const svg = parent.append("svg")
            .attr("width", width)
            .attr("height", height)
            .attr("viewBox", [0, 0, width, height])
            .attr("preserveAspectRatio", "xMinYMid meet")
            .style("overflow", "visible")
            .style("display", "block")
            .style("font", "10px sans-serif");

        let x;

        if (color.interpolator) {
            x = Object.assign(
                color.copy().interpolator(d3.interpolateRound(marginLeft, width - marginRight)),
                { range() { return [marginLeft, width - marginRight]; }}
            );

            svg.append("image")
                .attr("x", marginLeft)
                .attr("y", marginTop)
                .attr("width", width - marginLeft - marginRight)
                .attr("height", height - marginTop - marginBottom)
                .attr("preserveAspectRatio", "none")
                .attr("xlink:href", this.ramp(color.interpolator()).toDataURL());

            if (!x.ticks) {
                if (tickValues === undefined) {
                    const n = Math.round(ticks + 1);
                    tickValues = d3.range(n).map(i => d3.quantile(color.domain(), i / (n - 1)));
                }
                if (typeof tickFormat !== "function") {
                    tickFormat = d3.format(tickFormat === undefined ? ",f" : tickFormat);
                }
            }
        }

        svg.append("g")
            .attr("transform", `translate(0,${height - marginBottom})`)
            .call(d3.axisBottom(x)
                .ticks(ticks, typeof tickFormat === "string" ? tickFormat : undefined)
                .tickFormat(typeof tickFormat === "function" ? tickFormat : undefined)
                .tickSize(tickSize)
                .tickValues(tickValues))
            .call(g => g.select(".domain").remove())
            .call(g => g.append("text")
                .attr("x", marginLeft)
                .attr("y", marginTop + marginBottom - height - 6)
                .attr("fill", "currentColor")
                .attr("text-anchor", "start")
                .attr("font-weight", "bold")
                .attr("font-size", "11px")
                .text(title));
    }

    ramp(color, n = 256) {
        const canvas = document.createElement('canvas');
        canvas.width = n;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        for (let i = 0; i < n; ++i) {
            context.fillStyle = color(i / (n - 1));
            context.fillRect(i, 0, 1, 1);
        }
        return canvas;
    }

    hideTooltip() {
        tooltip.hide();
    }

    renderRecentStats(parent, data, days) {
        const now = new Date();
        const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        const recent = data.filter(d => d.timestamp >= cutoff && d.timestamp <= now);
        const agg = computeAggregateStats(recent);
        // Full labels on desktop, dashboard-style short labels on mobile (the
        // two are toggled by a CSS media query, mirroring the dashboard tiles)
        // so six metrics stay clear where there's room and stay compact on a
        // phone, where the row wraps (.recent-stats-row is flex-wrap: wrap).
        // The tap/hover tooltip spells out the full name either way. Defs are
        // single-sourced with the ALL tab and dashboard KPI tiles.
        const stats = buildAggregateStatDefs(agg, `in the last ${days} days`);

        const container = parent.append('div').attr('class', 'recent-stats');
        container.append('h4').text(`Last ${days} days`);
        const row = container.append('div').attr('class', 'recent-stats-row');
        stats.forEach(s => {
            const cell = row.append('div').attr('class', 'recent-stat');
            // Both labels are rendered; CSS shows exactly one per viewport.
            cell.append('span').attr('class', 'recent-stat-label recent-stat-label--long').text(`${s.label}:`);
            cell.append('span').attr('class', 'recent-stat-label recent-stat-label--short').text(`${s.short}:`);
            cell.append('span').attr('class', 'recent-stat-value').text(s.value);
            this.attachStatTooltip(cell, () => s.title, () => s.desc);
        });
    }

    attachStatTooltip(selection, getTitle, getDescription) {
        // Stat titles/descriptions are app-authored constants (no sheet data).
        tooltip.attach(selection,
            (event, year) => `<h4>${getTitle(year)}</h4><p>${getDescription(year)}</p>`,
            { maxWidth: '320px' });
    }
}
