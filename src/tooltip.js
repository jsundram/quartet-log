// The one tooltip implementation. Replaces the four per-component copies,
// which had drifted: only the calendar's clamped to the viewport correctly
// (client-coords math, then converted to page coords), and tap-dismissal
// lived in TabComponent's constructor behind a hardcoded allowlist of OTHER
// components' CSS class names — an inversion this module replaces with
// explicit ownership registration (own()/attach()).
//
// All tooltips render into the single body-level #tooltip div (they never
// coexist), which also keeps them visible inside the fullscreen overlays:
// requestFullscreen() is called on <html>, so a <body> child stays renderable.
import * as d3 from "d3";

// Placement for a tooltip of (width × height) triggered at client coords
// (x, y) in a (vw × vh) viewport: prefer below-right of the pointer, flip
// above/left of it when that would overflow, and finally hard-clamp fully
// on-screen. Pure — exported for tests.
export function clampToViewport({ x, y, width, height, vw, vh, margin = 10 }) {
    let left = x + margin;
    let top = y + margin;
    if (left + width > vw) left = x - width - margin;
    if (top + height > vh) top = y - height - margin;
    left = Math.max(margin, Math.min(left, vw - width - margin));
    top = Math.max(margin, Math.min(top, vh - height - margin));
    return { left, top };
}

// True when `node` or any ancestor is in `owned`. Walks parentNode so a
// registered trigger's child (the span inside a stat tile, a tspan in an
// axis label) counts as the trigger. Pure — exported for tests.
export function isOwnedNode(node, owned) {
    for (let n = node; n; n = n.parentNode) {
        if (owned.has(n)) return true;
    }
    return false;
}

class Tooltip {
    constructor() {
        this._owned = new WeakSet();
        this._dismissInstalled = false;
    }

    // Lazy: never touches the DOM at import time (modules load under Node
    // for tests) and tolerates pages without a #tooltip div by creating one.
    _div() {
        let div = d3.select('#tooltip');
        if (div.empty()) {
            div = d3.select('body').append('div')
                .attr('class', 'tooltip')
                .attr('id', 'tooltip')
                .style('display', 'none');
        }
        return div;
    }

    // One document-level listener dismisses on any tap/click that is not
    // inside the tooltip and not on a registered trigger (triggers' own
    // handlers re-show or replace the content). This is what makes every
    // tooltip — including the calendar's, which previously had no
    // tap-outside path at all — dismissible on touch.
    _installDismiss() {
        if (this._dismissInstalled) return;
        this._dismissInstalled = true;
        document.addEventListener('click', (e) => {
            const node = this._div().node();
            if (!node || node.style.display === 'none') return;
            if (node.contains(e.target)) return;
            if (isOwnedNode(e.target, this._owned)) return;
            this.hide();
        });
    }

    // Register elements as tooltip triggers for dismissal purposes only —
    // for callers that manage their own show/hide handlers (gated mouseover
    // logic, click-toggles). Accepts a d3 selection or a single node.
    own(selectionOrNode) {
        this._installDismiss();
        if (selectionOrNode instanceof Element) {
            this._owned.add(selectionOrNode);
            return;
        }
        const owned = this._owned;
        selectionOrNode.each(function () { owned.add(this); });
    }

    // `html` is the tooltip BODY — the close button is prepended here, once,
    // instead of by every caller. maxWidth: stat tooltips cap at 320px; the
    // wide ones (day/work tables) pass null to clear the inline cap and let
    // the CSS viewport clamp govern.
    show(event, html, { maxWidth = null } = {}) {
        this._installDismiss();
        const div = this._div()
            .html(`<span class="tooltip-close">&times;</span>${html}`)
            .style('display', 'block')
            .style('max-width', maxWidth);
        div.select('.tooltip-close').on('click', () => this.hide());

        const rect = div.node().getBoundingClientRect();
        const { left, top } = clampToViewport({
            x: event.clientX, y: event.clientY,
            width: rect.width, height: rect.height,
            vw: window.innerWidth, vh: window.innerHeight,
        });
        // Client coords → page coords for the absolute positioning.
        div.style('left', (left + window.scrollX) + 'px')
            .style('top', (top + window.scrollY) + 'px');
    }

    hide() {
        this._div().style('display', 'none');
    }

    // Convenience for the common trigger shape: show on hover and on
    // tap/click, hide on mouseleave. Registers the selection via own().
    attach(selection, getHtml, { maxWidth = null, hideOnLeave = true, click = true } = {}) {
        this.own(selection);
        const show = (event, d) => {
            const html = getHtml(event, d);
            if (html == null) return; // trigger declined (e.g. empty calendar day)
            this.show(event, html, { maxWidth });
        };
        selection.style('cursor', 'pointer').on('mouseenter.tooltip', show);
        if (hideOnLeave) selection.on('mouseleave.tooltip', () => this.hide());
        if (click) selection.on('click.tooltip', show);
    }
}

// The app-wide instance; every component imports this.
export const tooltip = new Tooltip();
