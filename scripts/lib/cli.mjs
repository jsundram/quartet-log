// @ts-check
// The three lines every audit entry point needs: resolve the input path, load
// the name tables, print the report. Kept together so an audit module is
// importable by tests without running anything on import.

import { existsSync } from 'node:fs';
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
 * Say so when the tables are the empty stub.
 *
 * Every alias-aware count then means something else: no short form resolves,
 * so each looks like a person of its own and every bare entry looks like one
 * nobody has decided. Those are big, alarming numbers, and they are an
 * artefact of the missing file rather than a finding about the sheet.
 * @param {NameTables} tables
 */
export function warnIfStub({ aliases, abbreviations }) {
    if (Object.keys(aliases).length || Object.keys(abbreviations).length) return;
    console.error(
        'Warning: src/aliases.js has empty tables (the stub copy?) — no short\n'
        + 'form resolves, so every one looks like a person of its own and every\n'
        + 'bare entry looks undecided. Put your real tables in src/aliases.js\n'
        + '(gitignored) before trusting this report.');
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
    const self = fileURLToPath(moduleUrl);
    if (!process.argv[1] || resolve(process.argv[1]) !== self) return;
    const csvPath = process.argv[2] ?? defaultPath;
    if (!existsSync(csvPath)) {
        console.error(`CSV not found: ${csvPath}`);
        console.error('Run scripts/fetch_raw.sh (or npm run audit) to fetch the sheet.');
        process.exit(1);
    }
    const lines = await report(csvPath);
    console.log(lines.join('\n'));
}
