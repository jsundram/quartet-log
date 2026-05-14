// Theme manager. Three states: 'auto' (default, follows OS preference),
// 'light', 'dark'. The current state lives in localStorage under 'theme'
// and is reflected on <html> as `data-theme="light|dark"` (or no attribute
// for 'auto'). CSS in static/css/viz.css responds to both data-theme and
// the prefers-color-scheme media query (see comments there for the cascade).
//
// To avoid a flash of wrong-theme content on load, an inline script in the
// head of index.html (and the pandoc template) reads localStorage and
// applies the attribute synchronously before first paint. This module is
// the runtime source of truth after that.
//
// Components that bake colors at render (e.g. d3 SVG fills computed from
// CSS custom properties) must register a callback via subscribe() so they
// rebuild on theme change. The callback receives no args; it should call
// invalidateColorCache() from config.js before re-reading any colors.
//
// The markdown pages (about.html, howto.html, setup.html) carry an inline
// copy of the cycle + label + persistence logic in md/_pandoc_template.html
// because they don't load the SPA bundle. Both implementations share the
// same localStorage key ('theme') and the same data-theme attribute values,
// so a choice made on either side persists into the other. KEEP THE CYCLE
// ORDER + STORAGE KEY + ATTRIBUTE NAMING IN SYNC across the two files.

const STORAGE_KEY = 'theme';
const VALID_THEMES = ['auto', 'light', 'dark'];

const listeners = new Set();

function readStored() {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID_THEMES.includes(v) ? v : 'auto';
}

function applyAttribute(theme) {
    if (theme === 'auto') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', theme);
    }
}

export function getTheme() {
    return readStored();
}

export function setTheme(theme) {
    if (!VALID_THEMES.includes(theme)) return;
    localStorage.setItem(STORAGE_KEY, theme);
    applyAttribute(theme);
    listeners.forEach(fn => fn());
}

export function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(getTheme()) + 1) % order.length];
    setTheme(next);
    return next;
}

// True if dark mode is currently active — accounts for explicit override
// AND system preference under 'auto'. Use this anywhere you'd otherwise
// reach for matchMedia('(prefers-color-scheme: dark)').matches.
export function isCurrentlyDark() {
    const t = getTheme();
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// One-time setup: re-apply the attribute (the head-script already did this,
// but doing it here too means the module works even if that script is
// removed or fails), and watch for system theme changes so 'auto' users
// see live updates when their OS theme flips.
export function initTheme() {
    applyAttribute(getTheme());
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (getTheme() === 'auto') listeners.forEach(fn => fn());
    });
}
