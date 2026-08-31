import * as d3 from "d3";
import { getBegin } from './config.js';
import { presetBounds } from './dateRange.js';

// Segmented date-range filter (All / YTD / 1Y / 6M / 1M / Custom) plus inline
// Custom date inputs. Owns its own state and uses class-based selectors
// scoped to its mount point, so multiple instances can coexist on the
// page (e.g. one on Home, one on Dashboard) without colliding.
//
// The range arithmetic lives in ./dateRange.js; this class is the chrome
// around it plus the CUSTOM pair, which is the one range the clock doesn't
// determine.

export class DateFilterWidget {
    constructor(mountSelector, onRangeChange, { defaultRange = '1Y' } = {}) {
        this.mountSelector = mountSelector;
        this.onRangeChange = onRangeChange;
        this.currentRange = defaultRange;
        this.startDate = null;
        this.endDate = null;
        this.updateDatesFromRange(this.currentRange);
    }

    root() {
        return d3.select(this.mountSelector);
    }

    render() {
        const root = this.root();
        // Idempotent: wipe any prior render so re-mounts don't stack widgets.
        root.html('');

        const container = root.append('div').attr('class', 'date-filter-container');

        const buttonGroup = container.append('div').attr('class', 'date-range-buttons');

        const ranges = [
            { id: 'ALL', label: 'All' },
            { id: 'YTD', label: 'YTD' },
            { id: '1Y', label: '1Y' },
            { id: '6M', label: '6M' },
            { id: '1M', label: '1M' },
            { id: 'CUSTOM', label: 'Custom' },
        ];

        ranges.forEach(r => {
            buttonGroup.append('button')
                .attr('type', 'button')
                .attr('class', `date-range-btn${r.id === this.currentRange ? ' active' : ''}`)
                .attr('data-range', r.id)
                .text(r.label)
                .on('click', () => this.handleRangeClick(r.id));
        });

        const customContainer = container.append('div')
            .attr('class', 'custom-date-range')
            .style('display', 'none');

        customContainer.append('input')
            .attr('type', 'date')
            .attr('class', 'custom-date-input custom-date-start')
            .attr('aria-label', 'Start date')
            .on('change', () => this.handleCustomDateChange());

        customContainer.append('span')
            .attr('class', 'custom-date-sep')
            .text('→');

        customContainer.append('input')
            .attr('type', 'date')
            .attr('class', 'custom-date-input custom-date-end')
            .attr('aria-label', 'End date')
            .on('change', () => this.handleCustomDateChange());
    }

    handleRangeClick(rangeId) {
        this.currentRange = rangeId;
        const root = this.root();
        root.selectAll('.date-range-btn').classed('active', function () {
            return d3.select(this).attr('data-range') === rangeId;
        });

        const customContainer = root.select('.custom-date-range');

        if (rangeId === 'CUSTOM') {
            const minStr = this.toDateInputValue(getBegin());
            const maxStr = this.toDateInputValue(new Date());
            root.select('.custom-date-start')
                .attr('min', minStr)
                .attr('max', maxStr)
                .property('value', this.toDateInputValue(this.startDate));
            root.select('.custom-date-end')
                .attr('min', minStr)
                .attr('max', maxStr)
                .property('value', this.toDateInputValue(this.endDate));
            customContainer.style('display', 'flex');
        } else {
            customContainer.style('display', 'none');
            this.updateDatesFromRange(rangeId);
            this.onRangeChange();
        }
    }

    handleCustomDateChange() {
        const root = this.root();
        const startStr = root.select('.custom-date-start').property('value');
        const endStr = root.select('.custom-date-end').property('value');
        if (!startStr || !endStr) return;

        const start = this.fromDateInputValue(startStr);
        const end = this.fromDateInputValue(endStr, true);
        if (start > end) return;

        this.startDate = start;
        this.endDate = end;
        this.onRangeChange();
    }

    // Seeds the stored pair so a later CUSTOM click has sensible defaults to
    // prefill its inputs with. Preset ranges do NOT read the stored pair —
    // getRange() re-derives them, so they can't go stale between clicks.
    updateDatesFromRange(rangeId) {
        const [start, end] = presetBounds(rangeId, new Date(), getBegin);
        this.startDate = start;
        this.endDate = end;
    }

    toDateInputValue(date) {
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    fromDateInputValue(str, endOfDay = false) {
        const [y, m, d] = str.split('-').map(Number);
        return endOfDay
            ? new Date(y, m - 1, d, 23, 59, 59, 999)
            : new Date(y, m - 1, d);
    }

    getRange() {
        // CUSTOM is an explicit pair the user typed; everything else is a
        // window relative to right now, so it is derived per read rather
        // than served from whenever the button was last pressed.
        if (this.currentRange === 'CUSTOM') return [this.startDate, this.endDate];
        return presetBounds(this.currentRange, new Date(), getBegin);
    }
}
