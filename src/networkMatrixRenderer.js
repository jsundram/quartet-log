import * as d3 from "d3";
import { getCssColor } from './config.js';

// Adjacency-matrix renderer for the musician network. Pure render layer:
// MusicianNetworkComponent builds the ctx (state, sizing, selection,
// tooltip callbacks) and this module draws into
// #dashboardMusicianNetworkMatrix. See musicianNetworkComponent.js for the
// state machine and chrome.
//
// ctx: {
//   width (container width), s (sizing knobs), state ({nodes, edges,
//   labels, ...}), selected (musician name or null), showNames,
//   attachTooltip, attachHoverTooltip, attachClickToggle,
//   nodeTooltipHtml, cellTooltipHtml
// }

function truncate(text, maxWidthPx, fontPx) {
    const charWidth = fontPx * 0.6;
    const maxChars = Math.max(2, Math.floor(maxWidthPx / charWidth));
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 1) + '…';
}

export function renderMatrix(ctx) {
    // showNames destructured to a plain local so the d3 .each callbacks
    // (where `this` is the DOM element) can still gate name rendering off
    // the toggle.
    const { width: containerWidth, s, state, selected, showNames } = ctx;
    const root = d3.select('#dashboardMusicianNetworkMatrix');
    const { nodes, edges, labels, maxEdgeWeight } = state;
    const n = nodes.length;

    const labelGutter = s.matrixLabelGutter;
    const availableForCells = containerWidth - labelGutter - 4;
    // Clamped both ways: shrinks to matrixCellMin (horizontal scroll
    // when the matrix exceeds container width), and capped at
    // matrixCellMax so a sparse matrix (after selecting a musician
    // and only ~10 cells remain) doesn't blow up into giant squares.
    const cellSize = Math.max(
        s.matrixCellMin,
        Math.min(s.matrixCellMax, Math.floor(availableForCells / n))
    );
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
        .text(d => showNames ? truncate(labels.get(d.name), labelGutter - 10, s.matrixLabelFont) : '')
        .each(function (d) {
            d3.select(this).append('title').text(showNames ? d.name : '');
        });
    ctx.attachClickToggle(rowLabelSel, d => d.name);
    ctx.attachHoverTooltip(rowLabelSel, (event, d) => ctx.nodeTooltipHtml(d));

    // Column labels (top gutter), rotated -90° so they read bottom-up
    // with the head tilted left. Perfectly vertical (vs. tilted) avoids
    // the rightmost label running off the gutter at the matrix edge.
    // dominant-baseline=central puts the text's vertical center on the
    // column center; text-anchor=start anchors the first letter just
    // above the grid so reading direction is bottom→top.
    const colLabelSel = svg.append('g').attr('class', 'matrix-col-labels')
        .selectAll('text')
        .data(nodes)
        .join('text')
        .attr('class', 'matrix-label')
        .attr('transform', (d, i) => {
            const cx = labelGutter + i * cellSize + cellSize / 2;
            const cy = labelGutter - 6;
            return `translate(${cx}, ${cy}) rotate(-90)`;
        })
        .attr('text-anchor', 'start')
        .attr('dominant-baseline', 'central')
        .attr('font-size', s.matrixLabelFont)
        .attr('fill', d => d.name === selected ? selectedLabelColor : labelColor)
        .attr('font-weight', d => d.name === selected ? 'bold' : 'normal')
        .attr('opacity', d => !selected || d.name === selected ? 1 : 0.5)
        .text(d => showNames ? truncate(labels.get(d.name), labelGutter - 10, s.matrixLabelFont) : '')
        .each(function (d) {
            d3.select(this).append('title').text(showNames ? d.name : '');
        });
    ctx.attachClickToggle(colLabelSel, d => d.name);
    ctx.attachHoverTooltip(colLabelSel, (event, d) => ctx.nodeTooltipHtml(d));

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
    ctx.attachTooltip(cellSel, (event, d) => ctx.cellTooltipHtml(d));

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
