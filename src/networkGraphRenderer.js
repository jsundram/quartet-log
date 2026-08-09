import * as d3 from "d3";
import { getCssColor, getPartColor } from './config.js';
import { PART_ORDER } from './dataProcessor.js';

// Force-directed graph renderer for the musician network. Pure render
// layer: MusicianNetworkComponent builds the ctx (state, sizing, selection,
// tooltip callbacks) and this module draws into
// #dashboardMusicianNetworkGraph. See musicianNetworkComponent.js for the
// state machine and chrome.
//
// ctx: {
//   width, s (sizing knobs), state ({nodes, edges, labels, maxNodeCount,
//   maxEdgeWeight}), selected (musician name or null), showNames,
//   minEdgeWeight, attachTooltip, attachHoverTooltip, attachClickToggle,
//   nodeTooltipHtml, edgeTooltipHtml
// }

export function renderGraph(ctx) {
    const { width, s, state, selected, showNames, minEdgeWeight } = ctx;
    const root = d3.select('#dashboardMusicianNetworkGraph');
    const height = s.graphHeight;
    const { nodes: stateNodes, edges: stateEdges, labels, maxNodeCount, maxEdgeWeight } = state;

    // Local mutable copies — d3-force rewrites source/target to node refs
    // and mutates x/y, vx/vy on the node objects.
    const nodes = stateNodes.map(n => ({ ...n, label: labels.get(n.name) }));
    const edges = stateEdges.map(e => ({ ...e }));

    const radiusScale = d3.scaleSqrt()
        .domain([1, Math.max(1, maxNodeCount)])
        .range(s.nodeRadiusRange);
    const widthScale = d3.scaleSqrt()
        .domain([minEdgeWeight, Math.max(minEdgeWeight, maxEdgeWeight)])
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
    const isEdgeIncident = e => selected && (
        (e.source.name ?? e.source) === selected || (e.target.name ?? e.target) === selected
    );

    // Pie-arc helpers for the node breakdown. Each non-zero part bucket
    // becomes one slice. The slices add up to the node's total piece
    // count so the pie fills the full node circle.
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

    // Defs for the Voronoi hit layer's per-node clip circles. The hit
    // group itself is appended below, AFTER the edges, so that taps
    // inside a node's clip circle hit the node and not an edge passing
    // through (edges can still catch taps outside any clip circle).
    const delaunay = d3.Delaunay.from(nodes, d => d.x, d => d.y);
    const voronoi = delaunay.voronoi([0, 0, width, height]);
    const clipIdFor = i => `network-hit-clip-${i}`;
    const defsSel = svg.append('defs');
    defsSel.selectAll('clipPath')
        .data(nodes)
        .join('clipPath')
        .attr('id', (d, i) => clipIdFor(i))
        .append('circle')
        .attr('cx', d => d.x)
        .attr('cy', d => d.y)
        .attr('r', s.nodeHitClipRadius);

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
    ctx.attachTooltip(linkSel, (event, d) => ctx.edgeTooltipHtml(d));

    // Voronoi hit layer above the edges — each node's hit region is its
    // Voronoi cell clipped to a circle around the node center, so taps
    // anywhere in that circle hit the node, even when an edge passes
    // through. Outside any clip circle this layer is transparent to
    // events so edges below remain clickable for their tooltip.
    const hitSel = svg.append('g').attr('class', 'network-hit')
        .selectAll('path')
        .data(nodes)
        .join('path')
        .attr('d', (d, i) => voronoi.renderCell(i))
        .attr('clip-path', (d, i) => `url(#${clipIdFor(i)})`)
        .attr('fill', 'transparent')
        .attr('pointer-events', 'all');
    ctx.attachClickToggle(hitSel, d => d.name);
    ctx.attachHoverTooltip(hitSel, (event, d) => ctx.nodeTooltipHtml(d));

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
    });

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
        .text(d => showNames ? d.label : '');
}
