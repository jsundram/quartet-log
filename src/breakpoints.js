// Shared responsive breakpoints for the chart components. Dashboard and
// MusicianNetwork each keep their own sizing() knob tables (the knobs are
// genuinely different domains), but the breakpoint constants and the
// touch-detection they branch on must be one source so the two SVG systems
// can't disagree about where "mobile" begins.
export const MOBILE_BREAKPOINT = 600;

// Charts render at 1:1 pixel scale (viewBox = pixel dims) up to this width;
// beyond it they stop growing so desktop lines stay readable.
export const MAX_DESIGN_WIDTH = 720;

export function isMobileWidth(width) {
    return width < MOBILE_BREAKPOINT;
}

// Coarse pointer = touch-primary device (hit targets get generous padding).
// Guarded so modules stay importable under plain Node for tests.
export function isTouchPrimary() {
    return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
}
