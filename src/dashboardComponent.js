import { getPartColor, getCssColor } from './config';
import { normalizeDashboardPart } from './dataProcessor';
import { DateFilterWidget } from './dateFilterWidget';

// Dashboard view: two interactive crossfilter charts.
//
// - Composer bar chart: top-N composers by play count (with date + part
//   filters applied, NOT composer — that's this chart's dimension).
// - Part stacked bar: V1 / V2 / VA segments (with date + composer filters
//   applied, NOT part).
//
// Selection is single-value per dimension. Clicking the active value
// toggles it off. State is held in `this.state` and mutated only via
// togglePart / toggleComposer / the DateFilterWidget callback; every
// mutation re-renders both charts.

const TOP_COMPOSERS = 20;
const PARTS = ['V1', 'V2', 'VA'];

const MAX_DESIGN_WIDTH = 720;
const MOBILE_BREAKPOINT = 600;

// Sizing knobs chosen per viewport so the SVG is rendered at 1:1 scale
// (viewBox dims = pixel dims), keeping fonts + bar heights readable on
// mobile without distorting desktop.
function sizing(width) {
    const mobile = width < MOBILE_BREAKPOINT;
    return {
        mobile,
        composerRowHeight: mobile ? 32 : 22,
        composerNameFont: mobile ? 14 : 12,
        composerLabelFont: mobile ? 13 : 11,
        composerMargin: mobile
            ? { top: 6, right: 90, bottom: 6, left: 96 }
            : { top: 8, right: 96, bottom: 8, left: 120 },
        partHeight: mobile ? 44 : 36,
        partFont: mobile ? 14 : 12,
    };
}

export class DashboardComponent {
    constructor() {
        this.data = null;
        this.state = {
            selectedPart: null,
            selectedComposer: null,
        };
        this.dateFilter = new DateFilterWidget(
            '#dashboardDateFilter',
            () => this.render(),
        );
        this.mounted = false;
    }

    init(data) {
        this.data = data;
        this.dateFilter.render();
        this.render();
        this.mounted = true;
        // Re-render on resize so the SVG width tracks the viewport (1:1 pixel
        // mapping; otherwise mobile would scale everything down).
        window.addEventListener('resize', () => this.render());
    }

    // Reads the dashboard container's actual width so charts can render at
    // 1:1 scale. Falls back to a usable design width when the view is
    // hidden (display: none → 0). App calls notifyShown() after switching
    // to the dashboard view to trigger a re-render at the real width.
    measureWidth() {
        const node = d3.select('#dashboard').node();
        const rect = node ? node.getBoundingClientRect() : null;
        if (rect && rect.width > 0) return rect.width;
        return Math.min(MAX_DESIGN_WIDTH, Math.max(320, window.innerWidth - 40));
    }

    notifyShown() {
        if (this.mounted) this.render();
    }

    setData(data) {
        this.data = data;
        if (this.mounted) this.render();
    }

    // Apply the dashboard's filters to `this.data`. Exclude flags let each
    // chart drop its own dimension's filter (standard crossfilter pattern).
    filteredRows({ excludePart = false, excludeComposer = false } = {}) {
        const [start, end] = this.dateFilter.getRange();
        const selPart = this.state.selectedPart;
        const selComp = this.state.selectedComposer;
        return this.data.filter(d => {
            if (d.timestamp < start || d.timestamp > end) return false;
            if (!excludePart && selPart && normalizeDashboardPart(d.part) !== selPart) return false;
            if (!excludeComposer && selComp && d.composer !== selComp) return false;
            return true;
        });
    }

    togglePart(part) {
        this.state.selectedPart = this.state.selectedPart === part ? null : part;
        this.render();
    }

    toggleComposer(name) {
        this.state.selectedComposer = this.state.selectedComposer === name ? null : name;
        this.render();
    }

    render() {
        if (!this.data) return;
        this.renderPartBar();
        this.renderComposerChart();
    }

    // ---------------- Part stacked bar ----------------

    renderPartBar() {
        const root = d3.select('#dashboardPartBar');
        const rows = this.filteredRows({ excludePart: true });

        const counts = new Map(PARTS.map(p => [p, 0]));
        let total = 0;
        rows.forEach(d => {
            const p = normalizeDashboardPart(d.part);
            if (p) {
                counts.set(p, counts.get(p) + 1);
                total++;
            }
        });

        if (total === 0) {
            root.selectAll('svg').remove();
            root.selectAll('p.dashboard-empty').data([1])
                .join('p')
                .attr('class', 'dashboard-empty')
                .text('No data in the current filter.');
            return;
        }
        root.selectAll('p.dashboard-empty').remove();

        const data = [];
        let cum = 0;
        PARTS.forEach(p => {
            const count = counts.get(p);
            const pct = count / total;
            data.push({ part: p, count, pct, x0: cum, x1: cum + pct });
            cum += pct;
        });

        const width = Math.min(MAX_DESIGN_WIDTH, this.measureWidth());
        const s = sizing(width);
        const height = s.partHeight;

        // Anchor the segments to the same horizontal band as the composer
        // chart's bar plot area, so the two stacks align visually instead of
        // the part bar stretching to the SVG edges.
        const margin = s.composerMargin;
        const innerWidth = width - margin.left - margin.right;

        const svg = root.selectAll('svg').data([1]).join('svg')
            .attr('width', width)
            .attr('height', height)
            .attr('viewBox', `0 0 ${width} ${height}`)
            .style('display', 'block');

        const sel = this.state.selectedPart;

        const segs = svg.selectAll('g.seg').data(data, d => d.part);
        segs.exit().remove();
        const segsEnter = segs.enter().append('g').attr('class', 'seg');
        segsEnter.append('rect');
        segsEnter.append('text');
        const merged = segsEnter.merge(segs);

        const textDark = getCssColor('--color-text-dark');
        const textLight = getCssColor('--color-text-light');

        merged.select('rect')
            .attr('x', d => margin.left + d.x0 * innerWidth)
            .attr('y', 0)
            .attr('width', d => (d.x1 - d.x0) * innerWidth)
            .attr('height', height)
            .attr('fill', d => getPartColor(d.part))
            .attr('stroke', d => d.part === sel ? textDark : 'none')
            .attr('stroke-width', d => d.part === sel ? 2 : 0)
            .attr('opacity', d => sel && d.part !== sel ? 0.45 : 1)
            .style('cursor', 'pointer')
            .on('click', (event, d) => this.togglePart(d.part));

        merged.select('text')
            // Light cyan V1 needs dark text; V2/VA are dark enough for white.
            .attr('fill', d => d.part === 'V1' ? textDark : textLight)
            .attr('font-size', s.partFont)
            .attr('font-weight', 'bold')
            .attr('text-anchor', 'middle')
            .attr('pointer-events', 'none')
            .attr('x', d => margin.left + (d.x0 + (d.x1 - d.x0) / 2) * innerWidth)
            .attr('y', height / 2)
            .attr('dy', '0.32em')
            // Wide enough → "VA · 10%". Narrow → just "VA". Tiny → nothing.
            .text(d => {
                const segPx = (d.x1 - d.x0) * innerWidth;
                if (segPx >= 56) return `${d.part} · ${Math.round(d.pct * 100)}%`;
                if (segPx >= 22) return d.part;
                return '';
            });
    }

    // ---------------- Composer bar chart ----------------

    renderComposerChart() {
        const root = d3.select('#dashboardComposerChart');
        const rows = this.filteredRows({ excludeComposer: true });

        const counts = d3.rollup(rows, v => v.length, d => d.composer);
        const data = Array.from(counts, ([name, count]) => ({ name, count }))
            .sort((a, b) => d3.descending(a.count, b.count))
            .slice(0, TOP_COMPOSERS);
        const total = d3.sum(data, d => d.count);

        if (data.length === 0) {
            root.selectAll('svg').remove();
            root.selectAll('p.dashboard-empty').data([1])
                .join('p')
                .attr('class', 'dashboard-empty')
                .text('No data in the current filter.');
            return;
        }
        root.selectAll('p.dashboard-empty').remove();

        const width = Math.min(MAX_DESIGN_WIDTH, this.measureWidth());
        const s = sizing(width);
        const margin = s.composerMargin;
        const rowHeight = s.composerRowHeight;
        const innerWidth = width - margin.left - margin.right;
        const innerHeight = data.length * rowHeight;
        const totalHeight = innerHeight + margin.top + margin.bottom;

        const x = d3.scaleLinear()
            .domain([0, d3.max(data, d => d.count)])
            .range([0, innerWidth]);

        const y = d3.scaleBand()
            .domain(data.map(d => d.name))
            .range([0, innerHeight])
            .padding(0.2);

        const svg = root.selectAll('svg').data([1]).join('svg')
            .attr('width', width)
            .attr('height', totalHeight)
            .attr('viewBox', `0 0 ${width} ${totalHeight}`)
            .style('display', 'block');

        const inner = svg.selectAll('g.chart-inner').data([1]).join('g')
            .attr('class', 'chart-inner')
            .attr('transform', `translate(${margin.left}, ${margin.top})`);

        const sel = this.state.selectedComposer;

        // Each row is a <g> holding the name (left), bar, and count label.
        const rowSel = inner.selectAll('g.composer-row').data(data, d => d.name);
        rowSel.exit().remove();
        const rowEnter = rowSel.enter().append('g').attr('class', 'composer-row');
        rowEnter.append('text').attr('class', 'composer-name');
        rowEnter.append('rect').attr('class', 'composer-bar');
        rowEnter.append('text').attr('class', 'composer-label');
        const rows2 = rowEnter.merge(rowSel);

        rows2.attr('transform', d => `translate(0, ${y(d.name)})`);

        const barFill = getCssColor('--color-accent');
        const barFillSelected = getCssColor('--color-accent-selected');
        const textPrimary = getCssColor('--color-text-primary');
        const textPrimarySelected = getCssColor('--color-text-emphasis');
        const textSecondary = getCssColor('--color-text-secondary');

        rows2.select('rect.composer-bar')
            .attr('x', 0)
            .attr('y', 0)
            .attr('height', y.bandwidth())
            .attr('width', d => x(d.count))
            .attr('fill', d => d.name === sel ? barFillSelected : barFill)
            .attr('opacity', d => sel && d.name !== sel ? 0.5 : 1)
            .style('cursor', 'pointer')
            .on('click', (event, d) => this.toggleComposer(d.name));

        rows2.select('text.composer-name')
            .attr('x', -8)
            .attr('y', y.bandwidth() / 2)
            .attr('dy', '0.32em')
            .attr('text-anchor', 'end')
            .attr('font-size', s.composerNameFont)
            .attr('font-weight', d => d.name === sel ? 'bold' : 'normal')
            .attr('fill', d => d.name === sel ? textPrimarySelected : textPrimary)
            .style('cursor', 'pointer')
            .on('click', (event, d) => this.toggleComposer(d.name))
            .text(d => d.name);

        rows2.select('text.composer-label')
            .attr('x', d => x(d.count) + 6)
            .attr('y', y.bandwidth() / 2)
            .attr('dy', '0.32em')
            .attr('font-size', s.composerLabelFont)
            .attr('fill', textSecondary)
            .attr('pointer-events', 'none')
            .text(d => `${((d.count / total) * 100).toFixed(1)}% (${d.count})`);
    }
}
