import * as d3 from "d3";
import { escapeHtml } from './escapeHtml.js';
import { tooltip } from './tooltip.js';
import { MAX_DESIGN_WIDTH, isMobileWidth, isTouchPrimary } from './breakpoints.js';
import {
    buildNetworkData,
    disambiguateLabels,
    defaultMinPiecesForGraph,
    computePartBreakdownPerMusician,
    computeSliderSync,
    PART_ORDER,
} from './dataProcessor.js';
import { renderGraph } from './networkGraphRenderer.js';
import { renderMatrix } from './networkMatrixRenderer.js';
import { renderChord, chordLabelVisibility } from './networkChordRenderer.js';

// Tabbed view of the musician co-occurrence network: a force-directed
// graph and an adjacency matrix over the same top-N node set.
//
// Both views consume the cached `_state` recomputed in render(), so
// switching tabs is free. The user (spreadsheet owner) is excluded
// implicitly via the userKey passed in by DashboardComponent.
//
// This module owns the state machine + chrome (tabs, slider, fullscreen,
// show-names toggle, tooltip plumbing); the actual drawing lives in the
// per-view renderer modules (networkGraphRenderer / networkMatrixRenderer /
// networkChordRenderer), which consume a plain ctx object built here.

const MIN_EDGE_WEIGHT = 2;

// chordLabelVisibility lives with the chord renderer; re-exported here so
// tests (and any other consumer) keep their existing import path.
export { chordLabelVisibility };

function sizing(width) {
    const mobile = isMobileWidth(width);
    // Touch-primary: graph nodes use a Voronoi hit layer clipped to a
    // per-node circle of nodeHitClipRadius; touch gets a generous catchment
    // so taps near a node still register, desktop stays tight so a click in
    // empty space doesn't surprise-select a far-away node. Chord arcs get
    // the radial pad on touch only.
    const touch = isTouchPrimary();
    return {
        mobile,
        touch,
        graphHeight: mobile ? 380 : 460,
        nodeRadiusRange: mobile ? [5, 18] : [6, 22],
        nodeHitClipRadius: touch ? 40 : 22,
        edgeWidthRange: mobile ? [0.5, 4] : [0.75, 6],
        labelFont: mobile ? 11 : 12,
        labelDx: mobile ? 8 : 10,
        chargeStrength: mobile ? -180 : -260,
        linkDistance: mobile ? 55 : 75,
        matrixCellMin: mobile ? 10 : 13,
        matrixCellMax: mobile ? 26 : 36,
        matrixLabelGutter: mobile ? 60 : 78,
        matrixLabelFont: mobile ? 9 : 10,
        chordDiameter: mobile ? 340 : 500,
        chordLabelPad: mobile ? 40 : 60,
        chordArcThickness: mobile ? 9 : 12,
        chordHitPad: touch ? 10 : 0,
        chordLabelFont: mobile ? 10 : 11,
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
        // Selecting a musician (here or in the Top Musicians chart) auto-resets
        // the slider to the 50-node default for that subset so the focused
        // neighborhood opens at a layout-friendly density. The user's prior
        // unfocused value is backed up here and restored on deselect.
        this._lastSelection = null;
        this._preSelectionMinCount = null;
        this._state = null;
        // Lightbox / fullscreen mode. When on, the section's container fills
        // the viewport via the .fullscreen CSS class; we expand the per-view
        // sizing knobs to fill the new room and re-run render(), which
        // re-runs the force simulation for the graph view at the new width.
        this._isFullscreen = false;
        this._escHandler = null;
        // When false, all rendered labels (graph nodes, matrix axes, chord
        // arcs) become empty strings — useful for taking shareable
        // screenshots without leaking real names. Tooltips still work for
        // interactive use; they don't bake into a screenshot.
        this.showNames = true;
    }

    init(mountSelector) {
        this.mountSelector = mountSelector;

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

        root.select('#networkFullscreenBtn').on('click', () => this._toggleFullscreen());

        root.select('#networkShowNames').on('change', (event) => {
            this.showNames = event.currentTarget.checked;
            this.render();
        });
    }

    _toggleFullscreen() {
        this._isFullscreen = !this._isFullscreen;
        const root = d3.select(this.mountSelector);
        root.classed('fullscreen', this._isFullscreen);
        // Freeze the page behind the lightbox (matters on touch devices,
        // where scrolling inside the overlay would otherwise rubber-band
        // the dashboard underneath).
        document.body.classList.toggle('network-fullscreen-open', this._isFullscreen);
        d3.select('#networkFullscreenBtn')
            .attr('aria-label', this._isFullscreen ? 'Exit full screen' : 'Expand to full screen')
            .attr('title', this._isFullscreen ? 'Exit full screen' : 'Expand to full screen');

        if (this._isFullscreen) {
            this._escHandler = (e) => {
                if (e.key === 'Escape') this._toggleFullscreen();
            };
            document.addEventListener('keydown', this._escHandler);
        } else if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
        this.render();
    }

    _syncSliderLabel(value) {
        d3.select(this.mountSelector).select('.network-threshold-value')
            .text(value);
    }

    // Sync the slider to the current filter. On first render we seed
    // userMinCount from defaultMinPiecesForGraph — the smallest threshold
    // that keeps the rendered node set at or under ~50 musicians, since
    // force layouts get hairball-y past that. The effective (displayed +
    // active) value is userMinCount clamped to [1, max]; we never mutate
    // userMinCount on clamp, so widening the filter restores the user's
    // original setting.
    //
    // Max is the 5th-ranked musician's count (not the top-1's), so even at
    // the densest setting the graph always includes the top 5 musicians.
    // Falls back to the smallest qualifying count when fewer than 5 exist.
    _syncSlider(rows) {
        const selection = this.getSelectedMusician ? this.getSelectedMusician() : null;
        // Selection-state transitions (enter/swap/exit and the first-render
        // seed) live in the pure computeSliderSync (see dataProcessor for the
        // rules; they're pinned by tests there).
        const next = computeSliderSync({
            userMinCount: this.userMinCount,
            lastSelection: this._lastSelection,
            preSelectionMinCount: this._preSelectionMinCount,
        }, rows, selection);
        this.userMinCount = next.userMinCount;
        this._lastSelection = next.lastSelection;
        this._preSelectionMinCount = next.preSelectionMinCount;

        this._effectiveMin = next.effectiveMin;
        const slider = d3.select(this.mountSelector).select('#networkMinCount');
        slider.attr('max', next.max);
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
        d3.select('#dashboardMusicianNetworkChord')
            .style('display', view === 'chord' ? null : 'none');
        this.render();
    }

    render() {
        const rows = this.getFilteredRows();
        this._syncSlider(rows);
        this._recomputeState(rows);

        // Dimensions: normal mode is capped by MAX_DESIGN_WIDTH and the
        // breakpoint-default heights from sizing(). Fullscreen reads the
        // expanded container directly and overrides graphHeight / chordDiameter
        // to fill it (matrix scales naturally via cellSize).
        let width;
        let s;
        if (this._isFullscreen) {
            const node = d3.select(this.mountSelector).node();
            const rect = node?.getBoundingClientRect();
            const padding = 40;
            const containerWidth = (rect?.width ?? window.innerWidth) - padding;
            // Measure the actual controls + caption heights so the chord/graph
            // gets the real leftover space between them. The previous fixed
            // 80px reserve was too tight when .network-controls wrapped to two
            // lines, causing the bottom of the chord (and its labels) to slip
            // under the caption row.
            const controlsEl = node?.querySelector('.network-controls');
            const captionEl = node?.querySelector('.network-caption-row');
            const controlsH = controlsEl?.offsetHeight ?? 0;
            const captionH = captionEl?.offsetHeight ?? 0;
            const gapBuffer = 24; // margins / gaps between controls, view, caption
            const containerHeight = (rect?.height ?? window.innerHeight) - padding - controlsH - captionH - gapBuffer;
            width = containerWidth;
            s = sizing(width);
            s.graphHeight = Math.max(s.graphHeight, containerHeight);
            s.chordDiameter = Math.max(s.chordDiameter, Math.min(width, containerHeight));
            s.matrixCellMax = Math.max(s.matrixCellMax, 56);
        } else {
            width = Math.min(MAX_DESIGN_WIDTH, this.measureWidth());
            s = sizing(width);
        }

        const caption = d3.select(this.mountSelector).select('.network-caption');
        if (this._state.nodes.length === 0) {
            caption.text(`No musicians at this threshold (≥ ${this._effectiveMin} piece${this._effectiveMin === 1 ? '' : 's'}).`);
            d3.select('#dashboardMusicianNetworkGraph').selectAll('*').remove();
            d3.select('#dashboardMusicianNetworkMatrix').selectAll('*').remove();
            d3.select('#dashboardMusicianNetworkChord').selectAll('*').remove();
            return;
        }

        // Plain context object consumed by the renderer modules: cached
        // network state + sizing knobs + selection/toggles, plus callbacks
        // into the component's tooltip plumbing so the renderers stay dumb.
        const ctx = {
            width,
            s,
            state: this._state,
            selected: this.getSelectedMusician ? this.getSelectedMusician() : null,
            showNames: this.showNames,
            minEdgeWeight: MIN_EDGE_WEIGHT,
            attachTooltip: (selection, getHtml) => this._attachTooltip(selection, getHtml),
            attachHoverTooltip: (selection, getHtml) => this._attachHoverTooltip(selection, getHtml),
            attachClickToggle: (selection, getName) => this._attachClickToggle(selection, getName),
            nodeTooltipHtml: (n) => this._nodeTooltipHtml(n),
            edgeTooltipHtml: (e) => this._edgeTooltipHtml(e),
            cellTooltipHtml: (c) => this._cellTooltipHtml(c),
        };

        const n = this._state.nodes.length;
        if (this.activeView === 'graph') {
            caption.text(`${n} co-player${n === 1 ? '' : 's'} · edges shown when ≥ ${MIN_EDGE_WEIGHT} shared pieces`);
            renderGraph(ctx);
        } else if (this.activeView === 'matrix') {
            caption.text(`${n} co-player${n === 1 ? '' : 's'} · diagonal omitted · cell shade = pieces played together`);
            renderMatrix(ctx);
        } else {
            caption.text(`${n} co-player${n === 1 ? '' : 's'} · grouped by predominant instrument · ribbon = pieces played together`);
            renderChord(ctx);
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

    // ---------------- Tooltip HTML builders ----------------
    // Kept on the prototype (not in the renderer modules) — they read
    // this._state and are pinned by test/escapeHtml.test.mjs.

    _nodeTooltipHtml(n) {
        const { edges } = this._state;
        const partners = edges.filter(e =>
            (e.source.name ?? e.source) === n.name ||
            (e.target.name ?? e.target) === n.name
        ).length;
        const parts = n.parts ?? {};
        const breakdown = PART_ORDER
            .filter(p => (parts[p] ?? 0) > 0)
            .map(p => `${p === 'OTHER' ? 'Other' : p} ×${parts[p]}`)
            .join(' · ');
        const breakdownLi = breakdown ? `<li>${breakdown}</li>` : '';
        return `<h4>${escapeHtml(n.name)}</h4><ul><li>${n.count} piece${n.count === 1 ? '' : 's'}</li>${breakdownLi}<li>${partners} co-player${partners === 1 ? '' : 's'} shown</li></ul>`;
    }

    _edgeTooltipHtml(e) {
        const a = e.source.name ?? e.source;
        const b = e.target.name ?? e.target;
        return `<h4>${escapeHtml(a)} · ${escapeHtml(b)}</h4><ul><li>${e.weight} pieces together</li></ul>`;
    }

    _cellTooltipHtml(c) {
        if (c.weight === 0) {
            return `<h4>${escapeHtml(c.a)} · ${escapeHtml(c.b)}</h4><ul><li>No pieces together</li></ul>`;
        }
        return `<h4>${escapeHtml(c.a)} · ${escapeHtml(c.b)}</h4><ul><li>${c.weight} piece${c.weight === 1 ? '' : 's'} together</li></ul>`;
    }

    // ---------------- Tooltip plumbing ----------------
    // All rendering/positioning/dismissal lives in the shared tooltip module.

    // Hover + click → tooltip. Used for elements that don't represent a
    // single musician (graph edges, matrix cells, chords).
    _attachTooltip(selection, getHtml) {
        tooltip.attach(selection, getHtml);
    }

    // Hover → tooltip (desktop only); click is handled separately by
    // _attachClickToggle. Used for graph nodes and matrix axis labels so
    // clicking toggles the dashboard's musician selection.
    _attachHoverTooltip(selection, getHtml) {
        tooltip.attach(selection, getHtml, { click: false });
    }

    _attachClickToggle(selection, getName) {
        selection.on('click', (event, d) => {
            event.stopPropagation();
            this._hideTooltip();
            if (this.onToggleMusician) this.onToggleMusician(getName(d));
        });
    }


    _hideTooltip() {
        tooltip.hide();
    }
}
