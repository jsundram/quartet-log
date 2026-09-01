// @ts-check
// The three lines every audit entry point needs: resolve the input path, load
// the name tables, print the report. Kept together so an audit module is
// importable by tests without running anything on import.

import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** @typedef {import('./views.mjs').NameTables} NameTables */

/**
 * The real PLAYER_ALIASES / PLAYER_ABBREVIATIONS, for a command-line run only.
 *
 * Never call this from a test. src/aliases.js is gitignored and
 * machine-specific — the real tables locally, the empty stub in CI — so a test
 * that reads it passes in both places while testing two different things.
 * Tests build their own NameTables and pass them in.
 * @returns {Promise<NameTables>}
 */
export async function readNameTables() {
    const { PLAYER_ALIASES, PLAYER_ABBREVIATIONS } = await import('../../src/config.js');
    return { aliases: PLAYER_ALIASES, abbreviations: PLAYER_ABBREVIATIONS };
}

/**
 * Is `p` the same file as the already-resolved `self`? A path that does not
 * exist cannot be, and realpathSync throws rather than saying so.
 * @param {string} p
 * @param {string} self
 */
function samePath(p, self) {
    try {
        return realpathSync(resolve(p)) === self;
    } catch {
        return false;
    }
}

/**
 * Say so when the tables are the empty stub.
 *
 * Every alias-aware count then means something else: no short form resolves,
 * so each looks like a person of its own and every bare entry looks like one
 * nobody has decided. Those are big, alarming numbers, and they are an
 * artefact of the missing file rather than a finding about the sheet.
 * @param {NameTables} tables
 */
export function warnIfStub({ aliases, abbreviations }) {
    // EITHER table being empty is worth saying, not only both. `||` meant a
    // half-materialized file — abbreviations populated, aliases {} — passed
    // silently while every alias-aware count (both ambiguity hazards, the
    // NEEDS MEMORY summary lines) was an artefact of the missing half. The
    // two tables also fail differently, so the message names the one that is
    // empty rather than describing a stub the file may not be.
    const empty = [
        !Object.keys(aliases).length && 'PLAYER_ALIASES',
        !Object.keys(abbreviations).length && 'PLAYER_ABBREVIATIONS',
    ].filter(Boolean);
    if (!empty.length) return;
    console.error(
        `Warning: ${empty.join(' and ')} in src/aliases.js `
        + `${empty.length > 1 ? 'are' : 'is'} empty (the stub copy?) — no short\n`
        + 'form resolves through it, so every one looks like a person of its own\n'
        + 'and every bare entry looks undecided. Put your real tables in\n'
        + 'src/aliases.js (gitignored) before trusting this report.');
}

/**
 * Run `report` and print it, but only when this module's file was the one node
 * was asked to execute. Importing an audit for its functions must not run it.
 * @param {string} moduleUrl - the caller's import.meta.url
 * @param {string} defaultPath - CSV to read when argv names none
 * @param {(csvPath: string) => Promise<string[]>|string[]} report
 * @returns {Promise<void>}
 */
export async function runAudit(moduleUrl, defaultPath, report) {
    // Both sides must be realpath'd. Node's ESM loader resolves symlinks
    // before it sets import.meta.url, while resolve() only normalizes "."
    // and ".." — so with any symlink in the invocation path the two never
    // match and the audit returns having done nothing, at exit 0. That is
    // the ordinary case on macOS (/tmp -> /private/tmp) and for any checkout
    // under a symlinked directory, and a silent success is the worst possible
    // failure here: audit_all.sh's `set -euo pipefail` cannot see it, and a
    // SUMMARY of blank counts reads as "nothing to fix".
    const self = realpathSync(fileURLToPath(moduleUrl));
    if (!process.argv[1] || !samePath(process.argv[1], self)) return;
    const csvPath = process.argv[2] ?? defaultPath;
    if (!existsSync(csvPath)) {
        console.error(`CSV not found: ${csvPath}`);
        console.error('Run scripts/fetch_raw.sh (or npm run audit) to fetch the sheet.');
        process.exit(1);
    }
    const lines = await report(csvPath);
    console.log(lines.join('\n'));
}
