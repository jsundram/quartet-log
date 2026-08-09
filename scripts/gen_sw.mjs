// Service-worker codegen: generates <deploy>/sw.js from the static/sw.js
// template, plus <deploy>/version.json.
//
// Replaces the old sed pipeline in build.sh for two structural reasons:
// - The precache SHELL list is generated from the deploy directory's actual
//   contents instead of hand-maintained (setup.html/howto.html were emitted
//   by the build but missing from the list, so they 503'd offline).
// - The cache version V is a hash over the content of EVERY precached asset,
//   not just bundle+CSS. Previously an icon- or manifest-only change left
//   sw.js byte-identical → no update event → the old asset pinned forever in
//   installed PWAs. Now any asset change moves V and evicts the stale cache.
//
// Pure functions are exported for tests; the CLI entry point at the bottom
// does the file I/O.  Usage: node scripts/gen_sw.mjs <deployDir>
// @ts-check
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Never precached: the SW script itself (must always be fetched live so the
// update probe sees new deploys), version.json (same — it IS the update
// probe's target), CNAME (GitHub Pages config, never fetched by the app),
// and sourcemaps (dev-only, huge).
const EXCLUDE = new Set(['sw.js', 'version.json', 'CNAME']);
/** @param {string} name */
const isExcluded = (name) => EXCLUDE.has(name) || name.endsWith('.map');

// The precache list: "./" and "./index.html" first (the navigation fallback
// entries the fetch handler looks up), then everything else sorted for a
// deterministic manifest.
/**
 * @param {string[]} fileNames
 * @returns {string[]}
 */
export function buildShellList(fileNames) {
    const rest = fileNames
        .filter((n) => !isExcluded(n) && n !== 'index.html')
        .sort()
        .map((n) => `./${n}`);
    return ['./', './index.html', ...rest];
}

// V from a hash over (name, content-hash) of every precached file, so ANY
// asset change — icon, manifest, catalog, code — produces a new version.
// Keeps the "ql-" prefix: app.js identifies the installed SW cache by that
// prefix, and _checkVersion compares V strings for equality only.
/**
 * @param {Iterable<[name: string, contentHash: string]>} entries
 * @returns {string}
 */
export function computeVersion(entries) {
    const h = createHash('sha256');
    for (const [name, contentHash] of [...entries].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
        h.update(`${name}:${contentHash}\n`);
    }
    return `ql-${h.digest('hex').slice(0, 16)}`;
}

// Substitute the template's two tokens. The template stays valid, lintable
// JS: __SW_VERSION__ sits inside a string literal and "__SW_SHELL__" is the
// sole element of a real array literal.
/**
 * @param {string} template
 * @param {{ version: string, shell: string[] }} tokens
 * @returns {string}
 */
export function generateSW(template, { version, shell }) {
    for (const token of ['"__SW_SHELL__"', '__SW_VERSION__']) {
        if (!template.includes(token)) throw new Error(`template is missing token ${token}`);
    }
    const out = template
        .replace('"__SW_SHELL__"', shell.map((s) => JSON.stringify(s)).join(', '))
        .replace('__SW_VERSION__', version);
    if (/__SW_[A-Z]+__/.test(out)) throw new Error('unsubstituted token left in generated sw.js');
    return out;
}

/** @param {string} deployDir */
function main(deployDir) {
    // Top-level files only: the build emits a flat deploy dir today. If a
    // future build step emits a subdirectory, its files would be silently
    // un-precached and un-hashed — switch to a recursive walk at that point.
    const files = readdirSync(deployDir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name);
    const hashed = files
        .filter((n) => !isExcluded(n))
        .map((n) => /** @type {[string, string]} */ (
            [n, createHash('sha256').update(readFileSync(join(deployDir, n))).digest('hex')]));
    const version = computeVersion(hashed);
    const shell = buildShellList(files);
    const template = readFileSync(new URL('../static/sw.js', import.meta.url), 'utf8');
    writeFileSync(join(deployDir, 'sw.js'), generateSW(template, { version, shell }));
    writeFileSync(join(deployDir, 'version.json'), JSON.stringify({ version }) + '\n');
    console.log(`Service worker: ${join(deployDir, 'sw.js')} (${version}, ${shell.length} precached)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const dir = process.argv[2];
    if (!dir) { console.error('usage: node scripts/gen_sw.mjs <deployDir>'); process.exit(1); }
    main(dir);
}
