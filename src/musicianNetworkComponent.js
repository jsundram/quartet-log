import { getCssColor, getPartColor } from './config';
import {
    buildNetworkData,
    disambiguateLabels,
    computeNodeCounts,
    medianNodeCount,
    computePartBreakdownPerMusician,
} from './dataProcessor';

// Tabbed view of the musician co-occurrence network: a force-directed
// graph and an adjacency matrix over the same top-N node set.
//
// Both views consume the cached `_state` recomputed in render(), so
// switching tabs is free. The user (spreadsheet owner) is excluded
// implicitly via the userKey passed in by DashboardComponent.

const MIN_EDGE_WEIGHT = 2;
const MOBILE_BREAKPOINT = 600;
const MAX_DESIGN_WIDTH = 720;

function sizing(width) {
    const mobile = width < MOBILE_BREAKPOINT;
    return {
        mobile,
        graphHeight: mobile ? 380 : 460,
        nodeRadiusRange: mobile ? [5, 18] : [6, 22],
        edgeWidthRange: mobile ? [0.5, 4] : [0.75, 6],
        labelFont: mobile ? 11 : 12,
        labelDx: mobile ? 8 : 10,
        chargeStrength: mobile ? -180 : -260,
        linkDistance: mobile ? 55 : 75,
        matrixCellMin: mobile ? 14 : 18,
        matrixLabelGutter: mobile ? 70 : 90,
        matrixLabelFont: mobile ? 10 : 11,
        tabPad: mobile ? '7px 10px' : '6px 14px',
    };
}

export class MusicianNetworkComponent {
    constructor(opts) {
        this.getFilteredRows = opts.getFilteredRows;
        this.measureWidth = opts.measureWidth;
        this.onToggleMusician = opts.onToggleMusician;
        this.getSelectedMusician = opts.getSelectedMusician;
        this.activeView = 'graph';
        this.mountSelector = null;
        this.tooltipDiv = null;
        // The slider has two values:
        //   userMinCount   — what the user set; only changes on slider input.
        //   _effectiveMin  — userMinCount clamped to the current filtered max;
        //                    this is what actually drives the network and the
        //                    slider's displayed value.
        // Tracking them separately means selecting a musician (which shrinks
        // the filtered max) doesn't permanently lower the slider — clearing
        // the selection restores the user's original value.
        this.userMinCount = null;
        this._effectiveMin = 1;
        this._state = null;
    }

    init(mountSelector) {
        this.mountSelector = mountSelector;
        this.tooltipDiv = d3.select('#tooltip');

        const root = d3.select(mountSelector);
        root.selectAll('.network-tab-btn').on('click', (event) => {
            const view = event.currentTarget.getAttribute('data-view');
            this.setView(view);
        });

        // Slider live-updates on drag; force layout is fast at any reasonable
        // node count so re-rendering per input event stays responsive.
        root.select('#networkMinCount').on('input', (event) => {
            this.userMinCount = Math.max(1, parseInt(event.currentTarget.value, 10) || 1);
            this.render();
        });
    }

    _syncSliderLabel(value) {
        d3.select(this.mountSelector).select('.network-threshold-value')
            .text(value);
    }

    // Sync the slider to the current filter. On first render we seed
    // userMinCount from the median of the visible musicians. The effective
    // (displayed + active) value is userMinCount clamped to [1, max]; we
    // never mutate userMinCount on clamp, so widening the filter restores
    // the user's original setting.
    //
    // Max is the 5th-ranked musician's count (not the top-1's), so even at
    // the densest setting the graph always includes the top 5 musicians.
    // Falls back to the smallest qualifying count when fewer than 5 exist.
    _syncSlider(rows) {
        const counts = computeNodeCounts(rows);
        const idx = Math.min(4, counts.length - 1);
        const max = Math.max(1, counts[idx]?.count ?? 1);
        if (this.userMinCount === null) {
            this.userMinCount = Math.max(1, Math.min(max, medianNodeCount(rows)));
        }
        this._effectiveMin = Math.max(1, Math.min(max, this.userMinCount));
        const slider = d3.select(this.mountSelector).select('#networkMinCount');
        slider.attr('max', max);
        slider.property('value', this._effectiveMin);
        this._syncSliderLabel(this._effectiveMin);
    }

    setView(view) {
        if (view === this.activeView) return;
        this.activeView = view;
        const root = d3.select(this.mountSelector);
        root.selectAll('.network-tab-btn').classed('active', function () {
            return this.getAttribute('data-view') === view;
        });
        d3.select('#dashboardMusicianNetworkGraph')
            .style('display', view === 'graph' ? null : 'none');
        d3.select('#dashboardMusicianNetworkMatrix')
            .style('display', view === 'matrix' ? null : 'none');
        this.render();
    }

    render() {
        const rows = this.getFilteredRows();
        this._syncSlider(rows);
        this._recomputeState(rows);

        const width = Math.min(MAX_DESIGN_WIDTH, this.measureWidth());
        const s = sizing(width);

        const caption = d3.select(this.mountSelector).select('.network-caption');
        if (this._state.nodes.length === 0) {
            caption.text(`No musicians at this threshold (≥ ${this._effectiveMin} session${this._effectiveMin === 1 ? '' : 's'}).`);
            d3.select('#dashboardMusicianNetworkGraph').selectAll('*').remove();
            d3.select('#dashboardMusicianNetworkMatrix').selectAll('*').remove();
            return;
        }

        const n = this._state.nodes.length;
        if (this.activeView === 'graph') {
            caption.text(`${n} co-player${n === 1 ? '' : 's'} · edges shown when ≥ ${MIN_EDGE_WEIGHT} shared sessions`);
            this._renderGraph(width, s);
        } else {
            caption.text(`${n} co-player${n === 1 ? '' : 's'} · diagonal omitted · cell shade = sessions played together`);
            this._renderMatrix(width, s);
        }
    }

    _recomputeState(rows) {
        const { nodes: rawNodes, edges: rawEdges } = buildNetworkData(rows, this._effectiveMin);
        const edges = rawEdges.filter(e => e.weight >= MIN_EDGE_WEIGHT);

        // Drop isolated nodes after cutoff (no edges to other top-N nodes).
        const endpoints = new Set();
        edges.forEach(e => { endpoints.add(e.source); endpoints.add(e.target); });
        const nodesNoBreakdown = rawNodes.filter(n => endpoints.has(n.name));

        // Per-musician part vector so graph nodes can render as pies and
        // tooltips can show the breakdown.
        const breakdown = computePartBreakdownPerMusician(rows);
        const nodes = nodesNoBreakdown.map(n => ({ ...n, parts: breakdown.get(n.name) }));

        const labels = disambiguateLabels(nodes);
        const maxNodeCount = nodes.reduce((m, n) => Math.max(m, n.count), 0);
        const maxEdgeWeight = edges.reduce((m, e) => Math.max(m, e.weight), 0);

        this._state = { nodes, edges, labels, maxNodeCount, maxEdgeWeight };
    }

    // ---------------- Graph ----------------

    _renderGraph(width, s) {
        const root = d3.select('#dashboardMusicianNetworkGraph');
        const height = s.graphHeight;
        const { nodes: stateNodes, edges: stateEdges, labels, maxNodeCount, maxEdgeWeight } = this._state;

        // Local mutable copies — d3-force rewrites source/target to node refs
        // and mutates x/y, vx/vy on the node objects.
        const nodes = stateNodes.map(n => ({ ...n, label: labels.get(n.name) }));
        const edges = stateEdges.map(e => ({ ...e }));

        const radiusScale = d3.scaleSqrt()
            .domain([1, Math.max(1, maxNodeCount)])
            .range(s.nodeRadiusRange);
        const widthScale = d3.scaleSqrt()
            .domain([MIN_EDGE_WEIGHT, Math.max(MIN_EDGE_WEIGHT, maxEdgeWeight)])
            .range(s.edgeWidthRange);

        const nodeRadius = n => radiusScale(n.count);
        const labelHalfWidth = n => (n.label.length * s.labelFont * 0.3);

        const sim = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(edges)
                .id(d => d.name)
                .distance(s.linkDistance)
                .strength(d => 0.05 + 0.25 * d.weight / Math.max(1, maxEdgeWeight)))
            .force('charge', d3.forceManyBody().strength(s.chargeStrength))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('x', d3.forceX(width / 2).strength(0.04))
            .force('y', d3.forceY(height / 2).strength(0.07))
            .force('collide', d3.forceCollide(d => nodeRadius(d) + labelHalfWidth(d) + 4));

        sim.stop();
        for (let i = 0; i < 300; i++) sim.tick();

        // Clamp positions inside the SVG so labels never get clipped.
        const margin = 8;
        nodes.forEach(n => {
            const r = nodeRadius(n);
            const lw = labelHalfWidth(n) * 2 + s.labelDx;
            n.x = Math.max(r + margin, Math.min(width - r - lw - margin, n.x));
            n.y = Math.max(r + margin, Math.min(height - r - margin, n.y));
        });

        // Pick label side: prefer right; flip to left if label would overshoot.
        nodes.forEach(n => {
            const r = nodeRadius(n);
            const lw = labelHalfWidth(n) * 2;
            n.labelOnRight = (n.x + r + s.labelDx + lw) <= (width - margin);
        });

        const edgeColor = getCssColor('--color-border-strong') || getCssColor('--color-text-secondary');
        const selectedStroke = getCssColor('--color-text-dark') || getCssColor('--color-text-primary');
        const sliceStroke = getCssColor('--color-bg-primary');
        const otherFill = getCssColor('--color-part-fallback');
        const selected = this.getSelectedMusician ? this.getSelectedMusician() : null;
        const isEdgeIncident = e => selected && (
            (e.source.name ?? e.source) === selected || (e.target.name ?? e.target) === selected
        );

        // Pie-arc helpers for the node breakdown. Each non-zero part bucket
        // becomes one slice. The slices add up to the node's total session
        // count so the pie fills the full node circle.
        const PART_ORDER = ['V1', 'V2', 'VA', 'VC', 'OTHER'];
        const pieGen = d3.pie().value(d => d.count).sort(null);
        const slicesFor = (n) => {
            const parts = n.parts ?? { V1: 0, V2: 0, VA: 0, VC: 0, OTHER: 0 };
            const entries = PART_ORDER
                .map(part => ({ part, count: parts[part] ?? 0 }))
                .filter(p => p.count > 0);
            // Fallback for the unlikely empty-vector case: paint as a single
            // accent-colored disc so the node is still visible.
            if (entries.length === 0) entries.push({ part: null, count: 1 });
            return pieGen(entries);
        };
        const sliceFill = (part) => {
            if (part === null) return getCssColor('--color-accent');
            if (part === 'OTHER') return otherFill;
            return getPartColor(part);
        };

        // Build SVG fresh each render — node count is small and re-laying out
        // is the dominant cost; redraw is negligible.
        root.selectAll('*').remove();
        const svg = root.append('svg')
            .attr('width', width)
            .attr('height', height)
            .attr('viewBox', `0 0 ${width} ${height}`)
            .style('display', 'block');

        const linkSel = svg.append('g').attr('class', 'network-edges')
            .selectAll('line')
            .data(edges)
            .join('line')
            .attr('class', 'network-edge')
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y)
            .attr('stroke', edgeColor)
            .attr('stroke-width', d => widthScale(d.weight))
            .attr('stroke-opacity', d => {
                const base = 0.25 + 0.45 * (d.weight / Math.max(1, maxEdgeWeight));
                if (!selected) return base;
                return isEdgeIncident(d) ? base : 0.08;
            });
        this._attachTooltip(linkSel, (event, d) => this._edgeTooltipHtml(d));

        // Each node is a <g> at (x, y) with pie slices + a selection-outline
        // circle + a transparent overlay that absorbs clicks/hovers (so a
        // single handler set serves the whole node regardless of which slice
        // the user lands on).
        const nodeG = svg.append('g').attr('class', 'network-nodes')
            .selectAll('g.network-node')
            .data(nodes, d => d.name)
            .join('g')
            .attr('class', 'network-node')
            .attr('transform', d => `translate(${d.x}, ${d.y})`)
            .attr('opacity', d => !selected || d.name === selected ? 1 : 0.35);

        nodeG.each(function (d) {
            const r = nodeRadius(d);
            const arcGen = d3.arc().innerRadius(0).outerRadius(r);
            const g = d3.select(this);
            g.selectAll('path.network-slice')
                .data(slicesFor(d), s => s.data.part ?? 'fallback')
                .join('path')
                .attr('class', 'network-slice')
                .attr('d', arcGen)
                .attr('fill', s => sliceFill(s.data.part))
                .attr('stroke', sliceStroke)
                .attr('stroke-width', 0.5)
                .attr('pointer-events', 'none');
            g.selectAll('circle.network-node-outline')
                .data([d])
                .join('circle')
                .attr('class', 'network-node-outline')
                .attr('r', r)
                .attr('fill', 'none')
                .attr('stroke', d.name === selected ? selectedStroke : 'none')
                .attr('stroke-width', d.name === selected ? 2 : 0)
                .attr('pointer-events', 'none');
            g.selectAll('circle.network-node-hit')
                .data([d])
                .join('circle')
                .attr('class', 'network-node-hit')
                .attr('r', r)
                .attr('fill', 'transparent');
        });

        const hitSel = nodeG.selectAll('circle.network-node-hit');
        this._attachClickToggle(hitSel, d => d.name);
        this._attachHoverTooltip(hitSel, (event, d) => this._nodeTooltipHtml(d));

        svg.append('g').attr('class', 'network-labels')
            .selectAll('text')
            .data(nodes)
            .join('text')
            .attr('class', 'network-label')
            .attr('font-size', s.labelFont)
            .attr('x', d => d.labelOnRight ? d.x + nodeRadius(d) + s.labelDx : d.x - nodeRadius(d) - s.labelDx)
            .attr('y', d => d.y)
            .attr('dy', '0.32em')
            .attr('text-anchor', d => d.labelOnRight ? 'start' : 'end')
            .attr('opacity', d => !selected || d.name === selected ? 1 : 0.35)
            .attr('font-weight', d => d.name === selected ? 'bold' : 'normal')
            .text(d => d.label);
    }

    _nodeTooltipHtml(n) {
        const { edges } = this._state;
        const partners = edges.filter(e =>
            (e.source.name ?? e.source) === n.name ||
            (e.target.name ?? e.target) === n.name
        ).length;
        const parts = n.parts ?? {};
        const breakdown = ['V1', 'V2', 'VA', 'VC', 'OTHER']
            .filter(p => (parts[p] ?? 0) > 0)
            .map(p => `${p === 'OTHER' ? 'Other' : p} ×${parts[p]}`)
            .join(' · ');
        const breakdownLi = breakdown ? `<li>${breakdown}</li>` : '';
        return `<h4>${n.name}</h4><ul><li>${n.count} session${n.count === 1 ? '' : 's'}</li>${breakdownLi}<li>${partners} co-player${partners === 1 ? '' : 's'} shown</li></ul>`;
    }

    _edgeTooltipHtml(e) {
        const a = e.source.name ?? e.source;
        const b = e.target.name ?? e.target;
        return `<h4>${a} · ${b}</h4><ul><li>${e.weight} sessions together</li></ul>`;
    }

    // ---------------- Matrix ----------------

    _renderMatrix(containerWidth, s) {
        const root = d3.select('#dashboardMusicianNetworkMatrix');
        const { nodes, edges, labels, maxEdgeWeight } = this._state;
        const n = nodes.length;

        const labelGutter = s.matrixLabelGutter;
        const availableForCells = containerWidth - labelGutter - 4;
        const cellSize = Math.max(s.matrixCellMin, Math.floor(availableForCells / n));
        const gridSize = cellSize * n;
        const svgWidth = labelGutter + gridSize;
        const svgHeight = labelGutter + gridSize;

        // Build a {name → index} map and a sparse {key → weight} map.
        const index = new Map(nodes.map((node, i) => [node.name, i]));
        const weights = new Map();
        edges.forEach(e => {
            const a = e.source.name ?? e.source;
            const b = e.target.name ?? e.target;
            const i = index.get(a);
            const j = index.get(b);
            if (i === undefined || j === undefined) return;
            weights.set(`${i},${j}`, e.weight);
            weights.set(`${j},${i}`, e.weight);
        });

        // Quantile-based color: each cell's shade is set by its rank among
        // all positive co-occurrence counts, not by absolute magnitude. The
        // distribution is heavily right-skewed (a few very strong pairs, a
        // long tail of weak ones), so a linear scale compresses the tail
        // into indistinguishable near-zero greens. Ranks spread the cells
        // evenly across the ramp. The ramp itself starts at 0.15 (a clearly
        // green tint, not near-white) so the lightest filled cell stays
        // distinguishable from empty cells. Tooltip gives exact counts.
        const positiveWeights = edges.map(e => e.weight);
        const ramp = t => d3.interpolateGreens(0.15 + 0.85 * t);
        const color = positiveWeights.length > 0
            ? d3.scaleSequentialQuantile(ramp).domain(positiveWeights)
            : d3.scaleSequential(ramp).domain([0, 1]);
        const emptyFill = getCssColor('--color-bg-stripe') || getCssColor('--color-bg-secondary');
        const labelColor = getCssColor('--color-text-secondary');
        const selectedLabelColor = getCssColor('--color-text-primary');
        const selected = this.getSelectedMusician ? this.getSelectedMusician() : null;

        root.selectAll('*').remove();
        const svg = root.append('svg')
            .attr('width', svgWidth)
            .attr('height', svgHeight)
            .attr('viewBox', `0 0 ${svgWidth} ${svgHeight}`)
            .style('display', 'block');

        // Row labels (left gutter), aligned to row centers.
        const rowLabelSel = svg.append('g').attr('class', 'matrix-row-labels')
            .selectAll('text')
            .data(nodes)
            .join('text')
            .attr('class', 'matrix-label')
            .attr('x', labelGutter - 6)
            .attr('y', (d, i) => labelGutter + i * cellSize + cellSize / 2)
            .attr('dy', '0.32em')
            .attr('text-anchor', 'end')
            .attr('font-size', s.matrixLabelFont)
            .attr('fill', d => d.name === selected ? selectedLabelColor : labelColor)
            .attr('font-weight', d => d.name === selected ? 'bold' : 'normal')
            .attr('opacity', d => !selected || d.name === selected ? 1 : 0.5)
            .text(d => this._truncate(labels.get(d.name), labelGutter - 10, s.matrixLabelFont))
            .each(function (d) {
                d3.select(this).append('title').text(d.name);
            });
        this._attachClickToggle(rowLabelSel, d => d.name);
        this._attachHoverTooltip(rowLabelSel, (event, d) => this._nodeTooltipHtml(d));

        // Column labels (top gutter), rotated -45°.
        const colLabelSel = svg.append('g').attr('class', 'matrix-col-labels')
            .selectAll('text')
            .data(nodes)
            .join('text')
            .attr('class', 'matrix-label')
            .attr('transform', (d, i) => {
                const cx = labelGutter + i * cellSize + cellSize / 2;
                const cy = labelGutter - 6;
                return `translate(${cx}, ${cy}) rotate(-45)`;
            })
            .attr('text-anchor', 'start')
            .attr('font-size', s.matrixLabelFont)
            .attr('fill', d => d.name === selected ? selectedLabelColor : labelColor)
            .attr('font-weight', d => d.name === selected ? 'bold' : 'normal')
            .attr('opacity', d => !selected || d.name === selected ? 1 : 0.5)
            .text(d => this._truncate(labels.get(d.name), labelGutter - 10, s.matrixLabelFont))
            .each(function (d) {
                d3.select(this).append('title').text(d.name);
            });
        this._attachClickToggle(colLabelSel, d => d.name);
        this._attachHoverTooltip(colLabelSel, (event, d) => this._nodeTooltipHtml(d));

        // Cells. Build a flat array of {i, j, a, b, weight}; skip diagonal.
        const cells = [];
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                cells.push({
                    i, j,
                    a: nodes[i].name,
                    b: nodes[j].name,
                    weight: weights.get(`${i},${j}`) ?? 0,
                });
            }
        }

        const cellSel = svg.append('g').attr('class', 'matrix-cells')
            .selectAll('rect')
            .data(cells)
            .join('rect')
            .attr('class', 'matrix-cell')
            .attr('x', d => labelGutter + d.j * cellSize)
            .attr('y', d => labelGutter + d.i * cellSize)
            .attr('width', cellSize)
            .attr('height', cellSize)
            .attr('fill', d => d.weight === 0 ? emptyFill : color(d.weight));
        this._attachTooltip(cellSel, (event, d) => this._cellTooltipHtml(d));

        // Diagonal placeholder rects (no fill, no tooltip).
        svg.append('g').attr('class', 'matrix-diagonal')
            .selectAll('rect')
            .data(nodes)
            .join('rect')
            .attr('class', 'matrix-cell-empty')
            .attr('x', (d, i) => labelGutter + i * cellSize)
            .attr('y', (d, i) => labelGutter + i * cellSize)
            .attr('width', cellSize)
            .attr('height', cellSize)
            .attr('fill', 'transparent');
    }

    _cellTooltipHtml(c) {
        if (c.weight === 0) {
            return `<h4>${c.a} · ${c.b}</h4><ul><li>No sessions together</li></ul>`;
        }
        return `<h4>${c.a} · ${c.b}</h4><ul><li>${c.weight} session${c.weight === 1 ? '' : 's'} together</li></ul>`;
    }

    _truncate(text, maxWidthPx, fontPx) {
        const charWidth = fontPx * 0.6;
        const maxChars = Math.max(2, Math.floor(maxWidthPx / charWidth));
        if (text.length <= maxChars) return text;
        return text.slice(0, maxChars - 1) + '…';
    }

    // ---------------- Tooltip plumbing ----------------

    // Hover + click → tooltip. Used for elements that don't represent a
    // single musician (graph edges, matrix cells).
    _attachTooltip(selection, getHtml) {
        const show = (event, d) => this._showTooltip(event, getHtml(event, d));
        selection
            .style('cursor', 'pointer')
            .on('mouseenter', show)
            .on('mouseleave', () => this._hideTooltip())
            .on('click', show);
    }

    // Hover → tooltip (desktop only); click is handled separately by
    // _attachClickToggle. Used for graph nodes and matrix axis labels so
    // clicking toggles the dashboard's musician selection.
    _attachHoverTooltip(selection, getHtml) {
        const show = (event, d) => this._showTooltip(event, getHtml(event, d));
        selection
            .style('cursor', 'pointer')
            .on('mouseenter', show)
            .on('mouseleave', () => this._hideTooltip());
    }

    _attachClickToggle(selection, getName) {
        selection.on('click', (event, d) => {
            event.stopPropagation();
            this._hideTooltip();
            if (this.onToggleMusician) this.onToggleMusician(getName(d));
        });
    }

    _showTooltip(event, html) {
        this.tooltipDiv
            .html(`<span class="tooltip-close">&times;</span>${html}`)
            .style('display', 'block');
        this.tooltipDiv.select('.tooltip-close')
            .on('click', () => this._hideTooltip());
        this._positionTooltip(event);
    }

    _positionTooltip(event) {
        const node = this.tooltipDiv.node();
        const rect = node.getBoundingClientRect();
        const margin = 10;
        let left = event.pageX + margin;
        let top = event.pageY + margin;
        if (left + rect.width > window.innerWidth) {
            left = Math.max(margin, event.pageX - rect.width - margin);
        }
        if (top + rect.height > window.innerHeight) {
            top = Math.max(margin, event.pageY - rect.height - margin);
        }
        this.tooltipDiv.style('left', left + 'px').style('top', top + 'px');
    }

    _hideTooltip() {
        this.tooltipDiv.style('display', 'none');
    }
}
