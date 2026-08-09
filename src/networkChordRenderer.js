import * as d3 from "d3";
import { getCssColor, getPartColor } from './config.js';
import { escapeHtml } from './escapeHtml.js';
import { predominantPart, PART_ORDER } from './dataProcessor.js';

// Chord-diagram renderer for the musician network. Pure render layer:
// MusicianNetworkComponent builds the ctx (state, sizing, selection,
// tooltip callbacks) and this module draws into
// #dashboardMusicianNetworkChord. See musicianNetworkComponent.js for the
// state machine and chrome.
//
// ctx: {
//   width (container width), s (sizing knobs), state ({nodes, edges,
//   labels, ...}), selected (musician name or null), showNames,
//   attachTooltip, attachHoverTooltip, attachClickToggle, nodeTooltipHtml
// }

// Greedy de-overlap for chord arc labels: walk groups around the circle,
// tracking the tangential right edge of the last shown label, and hide any
// label whose left edge would intrude on it. Effect on dense arcs: roughly
// alternating labels (show one, skip the next), which beats a wall of
// overlapping text; the tooltip still has the full name for hidden arcs.
// Pure — exported for tests (via musicianNetworkComponent's re-export).
// `groups` are d3.chord() groups ({startAngle, endAngle}), fontFor(group)
// → px, labelRadius the label ring radius.
export function chordLabelVisibility(groups, fontFor, labelRadius) {
    const visible = new Array(groups.length).fill(true);
    let lastShownEnd = -Infinity;
    groups.forEach((d, i) => {
        const font = fontFor(d);
        const mid = (d.startAngle + d.endAngle) / 2;
        const halfAngular = (font / 2) / labelRadius;
        if (mid - halfAngular >= lastShownEnd) {
            visible[i] = true;
            lastShownEnd = mid + halfAngular;
        } else {
            visible[i] = false;
        }
    });
    return visible;
}

export function renderChord(ctx) {
    const { width: containerWidth, s, state, selected, showNames } = ctx;
    const root = d3.select('#dashboardMusicianNetworkChord');
    const { nodes, edges, labels } = state;

    // Group musicians by predominant instrument (V1 → V2 → VA → VC → OTHER),
    // sorted by piece count desc within each block. The chord layout then
    // arranges them in this order around the circle so each instrument
    // family occupies a contiguous arc segment.
    const order = PART_ORDER;
    const ordered = nodes.slice().sort((a, b) => {
        const pa = predominantPart(a.parts) ?? 'OTHER';
        const pb = predominantPart(b.parts) ?? 'OTHER';
        const oa = order.indexOf(pa);
        const ob = order.indexOf(pb);
        if (oa !== ob) return oa - ob;
        return b.count - a.count;
    });

    const N = ordered.length;
    const indexOf = new Map(ordered.map((n, i) => [n.name, i]));

    // Build symmetric co-occurrence matrix.
    const matrix = Array.from({ length: N }, () => new Array(N).fill(0));
    edges.forEach(e => {
        const a = e.source.name ?? e.source;
        const b = e.target.name ?? e.target;
        const i = indexOf.get(a);
        const j = indexOf.get(b);
        if (i === undefined || j === undefined) return;
        matrix[i][j] = e.weight;
        matrix[j][i] = e.weight;
    });

    // Square container, capped by both the section width and the per-
    // breakpoint design size. The chord diagram inscribes a circle into it.
    const diameter = Math.min(containerWidth, s.chordDiameter);
    const outerRadius = (diameter / 2) - s.chordLabelPad;
    const innerRadius = outerRadius - s.chordArcThickness;

    const chord = d3.chord()
        .padAngle(0.015)
        .sortGroups(null)
        .sortSubgroups(null);
    const layout = chord(matrix);
    const arcGen = d3.arc().innerRadius(innerRadius).outerRadius(outerRadius);
    const ribbonGen = d3.ribbon().radius(innerRadius);

    const otherFill = getCssColor('--color-part-fallback');
    const selectedStroke = getCssColor('--color-text-dark') || getCssColor('--color-text-primary');

    const arcFill = (i) => {
        const part = predominantPart(ordered[i].parts) ?? 'OTHER';
        return part === 'OTHER' ? otherFill : getPartColor(part);
    };
    // Blended ribbon color (per request). If it ends up muddy on real data
    // we can swap to a neutral gray here without touching the rest.
    const ribbonFill = (i, j) => d3.interpolateRgb(arcFill(i), arcFill(j))(0.5);

    root.selectAll('*').remove();
    const svg = root.append('svg')
        .attr('width', diameter)
        .attr('height', diameter)
        .attr('viewBox', `${-diameter / 2} ${-diameter / 2} ${diameter} ${diameter}`)
        .style('display', 'block');

    // Ribbons (chords) — drawn first so arcs sit on top.
    const chordSel = svg.append('g').attr('class', 'network-chords')
        .selectAll('path')
        .data(layout, d => `${ordered[d.source.index].name}::${ordered[d.target.index].name}`)
        .join('path')
        .attr('class', 'network-chord')
        .attr('d', ribbonGen)
        .attr('fill', d => ribbonFill(d.source.index, d.target.index))
        .attr('fill-opacity', d => {
            if (!selected) return 0.45;
            const a = ordered[d.source.index].name;
            const b = ordered[d.target.index].name;
            return (a === selected || b === selected) ? 0.75 : 0.04;
        });
    ctx.attachTooltip(chordSel, (event, d) => {
        const a = ordered[d.source.index].name;
        const b = ordered[d.target.index].name;
        const w = matrix[d.source.index][d.target.index];
        return `<h4>${escapeHtml(a)} · ${escapeHtml(b)}</h4><ul><li>${w} piece${w === 1 ? '' : 's'} together</li></ul>`;
    });

    // Outer arcs + labels.
    const arcG = svg.append('g').attr('class', 'network-arcs')
        .selectAll('g.network-arc-group')
        .data(layout.groups, d => ordered[d.index].name)
        .join('g')
        .attr('class', 'network-arc-group');

    const arcPathSel = arcG.append('path')
        .attr('class', 'network-arc')
        .attr('d', arcGen)
        .attr('fill', d => arcFill(d.index))
        .attr('opacity', d => {
            const name = ordered[d.index].name;
            return !selected || name === selected ? 1 : 0.35;
        })
        .attr('stroke', d => ordered[d.index].name === selected ? selectedStroke : 'none')
        .attr('stroke-width', d => ordered[d.index].name === selected ? 2 : 0);

    // Transparent hit arc, sized to the visible arc (chordHitPad = 0) on
    // desktop and padded outward on touch. Sits on top of the visible arc
    // so it captures pointer events; visible arc has pointer-events:none
    // so it doesn't double-fire.
    arcPathSel.attr('pointer-events', 'none');
    const arcHitGen = d3.arc()
        .innerRadius(Math.max(0, innerRadius - s.chordHitPad))
        .outerRadius(outerRadius + s.chordHitPad);
    const arcHitSel = arcG.append('path')
        .attr('class', 'network-arc-hit')
        .attr('d', arcHitGen)
        .attr('fill', 'transparent')
        .attr('pointer-events', 'all');
    ctx.attachClickToggle(arcHitSel, d => ordered[d.index].name);
    ctx.attachHoverTooltip(arcHitSel, (event, d) => ctx.nodeTooltipHtml(ordered[d.index]));

    // Radial labels just outside the arcs. The conditional rotate(180)
    // flips text on the left half of the circle so it always reads
    // outward-to-inward rather than upside-down.
    //
    // Font size: cap each label at the per-arc tangential budget
    // (arcAngular × labelRadius), clamped to a floor — adjacent labels
    // compete tangentially, not radially. If even the floor doesn't
    // fit, the greedy visibility pass below alternately hides labels
    // so survivors stay legible.
    const labelRadius = outerRadius + 6;
    const MIN_LABEL_FONT = 7;
    const fontFor = (d) => {
        const arcAngular = d.endAngle - d.startAngle;
        return Math.max(MIN_LABEL_FONT, Math.min(s.chordLabelFont, arcAngular * labelRadius));
    };

    const visible = chordLabelVisibility(layout.groups, fontFor, labelRadius);

    arcG.append('text')
        .attr('class', 'network-arc-label')
        .attr('data-arc-index', (d, i) => i)
        .attr('font-size', fontFor)
        .attr('dy', '0.32em')
        .attr('transform', d => {
            const angleDeg = (d.startAngle + d.endAngle) / 2 * 180 / Math.PI - 90;
            const flip = angleDeg > 90;
            return `rotate(${angleDeg}) translate(${labelRadius})${flip ? ' rotate(180)' : ''}`;
        })
        .attr('text-anchor', d => {
            const angleDeg = (d.startAngle + d.endAngle) / 2 * 180 / Math.PI - 90;
            return angleDeg > 90 ? 'end' : 'start';
        })
        .attr('opacity', d => {
            const name = ordered[d.index].name;
            return !selected || name === selected ? 1 : 0.35;
        })
        .attr('font-weight', d => ordered[d.index].name === selected ? 'bold' : 'normal')
        // Text content is always populated; hidden labels are display:none
        // so chord hover can unhide the two endpoint labels (and re-hide
        // them on leave) without rewriting any DOM text.
        .style('display', (d, i) => visible[i] ? null : 'none')
        .text(d => showNames ? (labels.get(ordered[d.index].name) || ordered[d.index].name) : '');

    // Chord hover surfaces the two endpoint labels even when they were
    // hidden by the de-overlap pass — useful for tracing a ribbon back to
    // both musicians. Namespaced so it doesn't trample attachTooltip's
    // own mouseenter/leave handlers on the same selection.
    const labelTextSel = svg.select('g.network-arcs').selectAll('text.network-arc-label');
    const showEndpoints = (event, d) => {
        [d.source.index, d.target.index].forEach(idx => {
            labelTextSel.filter(`[data-arc-index="${idx}"]`).style('display', null);
        });
    };
    const restoreEndpoints = (event, d) => {
        [d.source.index, d.target.index].forEach(idx => {
            if (!visible[idx]) {
                labelTextSel.filter(`[data-arc-index="${idx}"]`).style('display', 'none');
            }
        });
    };
    chordSel
        .on('mouseenter.labels', showEndpoints)
        .on('mouseleave.labels', restoreEndpoints);
}
