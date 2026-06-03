import { getPartColor, getCssColor } from './config';
import { normalizeDashboardPart, peopleKeysFor } from './dataProcessor';
import { DateFilterWidget } from './dateFilterWidget';
import { MusicianNetworkComponent } from './musicianNetworkComponent';

// Dashboard view: a set of crossfilter charts that all share the same date
// range plus a registry of dimensions. Each chart "owns" one dimension and
// shows data with every OTHER dimension's selection applied — the standard
// crossfilter pattern.
//
// Adding a chart:
//   1. Add an entry to DIMENSIONS with `matches(row, selectedValue)`.
//   2. Add a render method that calls `this.filteredRows(key)` and wires
//      clicks through `this.toggle(key, value)`.
//   3. Call it from `render()` and add a container <div> in index.html.

const TOP_N = 20;
const PARTS = ['V1', 'V2', 'VA'];

// Dimension registry. Selection state lives in this.state.selections[key];
// `matches(row, selectedValue)` returns true if the row should pass the
// dimension's filter when `selectedValue` is selected. `null` means no
// selection — that dimension imposes no filter.
const DIMENSIONS = {
    part:     { matches: (d, sel) => normalizeDashboardPart(d.part) === sel },
    composer: { matches: (d, sel) => d.composer === sel },
    musician: { matches: (d, sel) => peopleKeysFor(d).includes(sel) },
};

const MAX_DESIGN_WIDTH = 720;
const MOBILE_BREAKPOINT = 600;

// Sizing knobs chosen per viewport so the SVG is rendered at 1:1 scale
// (viewBox dims = pixel dims), keeping fonts + bar heights readable on
// mobile without distorting desktop.
function sizing(width) {
    const mobile = width < MOBILE_BREAKPOINT;
    return {
        mobile,
        rankedRowHeight: mobile ? 32 : 22,
        rankedNameFont: mobile ? 14 : 12,
        rankedLabelFont: mobile ? 13 : 11,
        rankedMargin: mobile
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
            selections: Object.fromEntries(Object.keys(DIMENSIONS).map(k => [k, null])),
        };
        this.dateFilter = new DateFilterWidget(
            '#dashboardDateFilter',
            () => this.render(),
        );
        this.networkComponent = new MusicianNetworkComponent({
            getFilteredRows: () => this.filteredRows(null),
            measureWidth: () => this.measureWidth(),
            onToggleMusician: (name) => this.toggle('musician', name),
            getSelectedMusician: () => this.state.selections.musician,
        });
        this.mounted = false;
    }

    init(data) {
        this.data = data;
        document.getElementById('dashboardComposerChartTitle').textContent = `Top ${TOP_N} composers`;
        document.getElementById('dashboardMusicianChartTitle').textContent = `Top ${TOP_N} musicians`;
        this.dateFilter.render();
        this.networkComponent.init('#dashboardMusicianNetwork');
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

    // Rows matching every active selection except `excludeKey`'s (so a chart
    // showing dimension X drops X's own filter and sees everything else).
    filteredRows(excludeKey = null) {
        const [start, end] = this.dateFilter.getRange();
        const sels = this.state.selections;
        return this.data.filter(d => {
            if (d.timestamp < start || d.timestamp > end) return false;
            for (const [key, dim] of Object.entries(DIMENSIONS)) {
                if (key === excludeKey) continue;
                const sel = sels[key];
                if (sel !== null && !dim.matches(d, sel)) return false;
            }
            return true;
        });
    }

    // Toggle a dimension's selection: clicking the active value clears it.
    toggle(key, value) {
        const cur = this.state.selections[key];
        this.state.selections[key] = cur === value ? null : value;
        this.render();
    }

    render() {
        if (!this.data) return;
        this.renderPartBar();
        this.renderComposerChart();
        this.renderMusicianChart();
        this.networkComponent.render();
    }

    // ---------------- Part stacked bar ----------------

    renderPartBar() {
        const root = d3.select('#dashboardPartBar');
        const rows = this.filteredRows('part');

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
            this.renderEmpty(root);
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

        // Anchor the segments to the same horizontal band as the ranked
        // charts' bar plot area, so the stacks align visually instead of
        // the part bar stretching to the SVG edges.
        const margin = s.rankedMargin;
        const innerWidth = width - margin.left - margin.right;

        const svg = root.selectAll('svg').data([1]).join('svg')
            .attr('width', width)
            .attr('height', height)
            .attr('viewBox', `0 0 ${width} ${height}`)
            .style('display', 'block');

        const sel = this.state.selections.part;

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
            .on('click', (event, d) => this.toggle('part', d.part));

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

    // ---------------- Ranked charts ----------------

    renderComposerChart() {
        const rows = this.filteredRows('composer');
        const counts = d3.rollup(rows, v => v.length, d => d.composer);
        const data = Array.from(counts, ([name, count]) => ({ name, count }));
        this.renderRankedBars('#dashboardComposerChart', 'composer', data);
    }

    renderMusicianChart() {
        const rows = this.filteredRows('musician');
        // Each row contributes 1 to every unique musician it contains. A
        // session of 4 musicians gives +1 to each of them, not +4 to one.
        const counts = new Map();
        rows.forEach(d => {
            const seen = new Set(peopleKeysFor(d));
            seen.forEach(name => counts.set(name, (counts.get(name) ?? 0) + 1));
        });
        const data = Array.from(counts, ([name, count]) => ({ name, count }));
        this.renderRankedBars('#dashboardMusicianChart', 'musician', data);
    }

    // Generic top-N horizontal bar chart, parameterized by dimension key.
    // Click toggles `this.state.selections[dimensionKey]`.
    renderRankedBars(rootSelector, dimensionKey, allData) {
        const root = d3.select(rootSelector);
        const data = allData
            .sort((a, b) => d3.descending(a.count, b.count))
            .slice(0, TOP_N);
        const total = d3.sum(data, d => d.count);

        if (data.length === 0) {
            this.renderEmpty(root);
            return;
        }
        root.selectAll('p.dashboard-empty').remove();

        const width = Math.min(MAX_DESIGN_WIDTH, this.measureWidth());
        const s = sizing(width);
        const margin = s.rankedMargin;
        const rowHeight = s.rankedRowHeight;
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

        const sel = this.state.selections[dimensionKey];

        // Each row is a <g> holding the name (left), bar, and count label.
        // Key by name AND dimension so switching the chart's data fully
        // rebuilds DOM (avoids stale rows when totals shift).
        const rowSel = inner.selectAll('g.ranked-row').data(data, d => d.name);
        rowSel.exit().remove();
        const rowEnter = rowSel.enter().append('g').attr('class', 'ranked-row');
        rowEnter.append('text').attr('class', 'ranked-name');
        rowEnter.append('rect').attr('class', 'ranked-bar');
        rowEnter.append('text').attr('class', 'ranked-label');
        const rows2 = rowEnter.merge(rowSel);

        rows2.attr('transform', d => `translate(0, ${y(d.name)})`);

        const barFill = getCssColor('--color-accent');
        const barFillSelected = getCssColor('--color-accent-selected');
        const textPrimary = getCssColor('--color-text-primary');
        const textPrimarySelected = getCssColor('--color-text-emphasis');
        const textSecondary = getCssColor('--color-text-secondary');

        rows2.select('rect.ranked-bar')
            .attr('x', 0)
            .attr('y', 0)
            .attr('height', y.bandwidth())
            .attr('width', d => x(d.count))
            .attr('fill', d => d.name === sel ? barFillSelected : barFill)
            .attr('opacity', d => sel && d.name !== sel ? 0.5 : 1)
            .style('cursor', 'pointer')
            .on('click', (event, d) => this.toggle(dimensionKey, d.name));

        rows2.select('text.ranked-name')
            .attr('x', -8)
            .attr('y', y.bandwidth() / 2)
            .attr('dy', '0.32em')
            .attr('text-anchor', 'end')
            .attr('font-size', s.rankedNameFont)
            .attr('font-weight', d => d.name === sel ? 'bold' : 'normal')
            .attr('fill', d => d.name === sel ? textPrimarySelected : textPrimary)
            .style('cursor', 'pointer')
            .on('click', (event, d) => this.toggle(dimensionKey, d.name))
            .text(d => d.name);

        rows2.select('text.ranked-label')
            .attr('x', d => x(d.count) + 6)
            .attr('y', y.bandwidth() / 2)
            .attr('dy', '0.32em')
            .attr('font-size', s.rankedLabelFont)
            .attr('fill', textSecondary)
            .attr('pointer-events', 'none')
            .text(d => `${((d.count / total) * 100).toFixed(1)}% (${d.count})`);
    }

    renderEmpty(root) {
        root.selectAll('svg').remove();
        root.selectAll('p.dashboard-empty').data([1])
            .join('p')
            .attr('class', 'dashboard-empty')
            .text('No data in the current filter.');
    }
}
