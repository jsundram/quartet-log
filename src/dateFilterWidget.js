import { getBegin } from './config';

// Segmented date-range filter (All / YTD / 1Y / 6M / Custom) plus inline
// Custom date inputs. Owns its own state and uses class-based selectors
// scoped to its mount point, so multiple instances can coexist on the
// page (e.g. one on Home, one on Dashboard) without colliding.
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

    updateDatesFromRange(rangeId) {
        const now = new Date();
        let start;

        switch (rangeId) {
            case 'ALL':
                start = getBegin();
                break;
            case 'YTD':
                start = new Date(now.getFullYear(), 0, 1);
                break;
            case '1Y':
                start = new Date(now);
                start.setFullYear(start.getFullYear() - 1);
                break;
            case '6M':
                start = new Date(now);
                start.setMonth(start.getMonth() - 6);
                break;
            default:
                start = getBegin();
        }

        this.startDate = start;
        this.endDate = now;
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
        return [this.startDate, this.endDate];
    }
}
