// Shell-update detection + the force-update hammer. Split out of app.js.
//
// The service-worker cache name IS the deployed version (sw.js: `const V =
// "ql-<hash>"`), so the installed version is just the ql- cache key. The
// latest version comes from version.json, which scripts/gen_sw.mjs emits
// next to sw.js on every prod build and the SW never intercepts/caches —
// this replaces the old approach of regex-parsing the live sw.js source
// (a fragile textual coupling on `const V = "..."`).

// Prefix of the service-worker cache name; also how the installed shell
// version is identified among cache keys.
export const VER_PREFIX = 'ql-';

// Read the deployed version off the server. Cache-busted + no-store so even
// a stale shell can see a new deploy. Returns '' when offline/unavailable —
// callers treat that as "don't know", never as "behind".
async function fetchLatestVersion() {
    try {
        const resp = await fetch('./version.json?_=' + Date.now(), { cache: 'no-store' });
        if (!resp.ok) return '';
        const { version } = await resp.json();
        return typeof version === 'string' ? version : '';
    } catch {
        return '';
    }
}

// Compare the installed shell against the server and surface a tappable
// "update available" row in the menu when they differ. Runs on boot and on
// every foreground resume — the moment iOS wakes a pinned app is exactly
// when we want to check.
export async function checkVersion() {
    const tag = document.getElementById('ver');
    if (!tag) return;

    let installed = '';
    try {
        installed = (await caches.keys()).find(k => k.startsWith(VER_PREFIX)) || '';
    } catch { /* caches unavailable */ }

    // No SW cache yet (dev, or first load before install): keep the row hidden.
    if (!installed) { tag.hidden = true; return; }

    const latest = await fetchLatestVersion();
    const behind = Boolean(latest) && latest !== installed;
    const label = tag.querySelector('[data-ver-label]');
    tag.hidden = false;
    tag.classList.toggle('menu-item--update', behind);
    if (label) label.textContent = behind ? 'Update available' : 'Up to date';
    tag.title = behind
        ? `New version available (${latest}) — tap to update`
        : `Up to date (${installed}) — tap to force refresh`;
}

// The hammer for a wedged home-screen app: drop every cache and reload so
// the service worker reinstalls the current shell from the network. Wired to
// the menu's version row; safe to tap even when already current (just a hard
// refresh that repopulates from the network).
export async function forceUpdate() {
    try {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
    } catch { /* nothing to clear */ }
    window.location.reload();
}
