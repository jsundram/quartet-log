// @ts-check
// The three views of the log, built once from the raw sheet.
//
// Which view a section reads decides whether it is correct, and every review
// round of the retired spike (#19) found a section reading the wrong one. So
// the view stops being a convention — a file path picked in shell, invisible
// to the code and to the reader — and becomes an input: buildViews derives
// all three from one parse, and every function that reads rows names the view
// it wants by destructuring it out of the Views object. A caller cannot hand
// a bare row list to a reader that needs the filled one.
//
//   written    what a human typed. The only view with cells anyone can edit,
//              and the only honest source for "how often was this name
//              written out".
//   filled     prepareRows + fillForward with an EMPTY abbreviation table, so
//              nothing but the sheet's own repetition is filled in. The
//              evidence for who was in the room: 39% of raw rows are
//              continuation rows that state their players only above.
//   processed  the app's own pipeline — fillForward with the real
//              abbreviations, normalizePlayerNames with the real aliases,
//              then partial-movement rows dropped. What the app sees, and
//              byte-for-byte what scripts/fetch_processed.mjs writes.
//
// `written` and `filled` are index-aligned: both come from prepareRows over
// the same processRow output, so written[i] and filled[i] are the same row
// before and after fill-forward. `processed` is not — it drops the partial
// movements the app drops — so it is never paired against the other two.

import { readFileSync } from 'node:fs';
import {
    processRow, prepareRows, fillForward, normalizePlayerNames,
} from '../../src/dataProcessor.js';
import { parseCsv } from './parseCsv.mjs';

/** @typedef {import('../../src/dataProcessor.js').Row} Row */
/** @typedef {import('../../src/aliases.stub.js').AliasEntry} AliasEntry */

/**
 * The name tables the processed view is built with. Passed in rather than
 * imported so tests can inject their own: src/aliases.js is gitignored and
 * machine-specific (real names locally, the empty stub in CI), so a test that
 * read it would pass in both places while testing two different things.
 * @typedef {Object} NameTables
 * @property {Record<string, AliasEntry>} aliases
 * @property {Record<string, string>} abbreviations
 */

/**
 * @typedef {Object} Views
 * @property {Row[]} written
 * @property {Row[]} filled
 * @property {Row[]} processed
 * @property {number} dropped - rows prepareRows discarded for an unparseable
 *   timestamp. Surfaced, not swallowed: those rows are absent from every
 *   section below AND from the app, so a silent drop leaves the printed row
 *   total quietly disagreeing with the file. In a data-quality audit an
 *   unparseable timestamp is itself a finding.
 */

/**
 * @param {Record<string, string>[]} rawRows - parsed CSV lines
 * @param {NameTables} tables
 * @returns {Views}
 */
export function buildViews(rawRows, { aliases, abbreviations }) {
    // processRow is called once per view: fillForward and normalizePlayerNames
    // mutate their input, so the three views cannot share row objects.
    const written = prepareRows(rawRows.map(processRow));
    const filled = prepareRows(rawRows.map(processRow));
    const processed = prepareRows(rawRows.map(processRow));

    fillForward(filled.rows, {});

    fillForward(processed.rows, abbreviations);
    normalizePlayerNames(processed.rows, aliases);

    return {
        written: written.rows,
        filled: filled.rows,
        processed: processed.rows.filter(d => !d.work.incomplete),
        dropped: written.dropped,
    };
}

/**
 * @param {string} csvPath
 * @param {NameTables} tables
 * @returns {Views}
 */
export function loadViews(csvPath, tables) {
    return buildViews(parseCsv(readFileSync(csvPath, 'utf8')), tables);
}

/**
 * The header every audit prints: how many rows it read, and what it lost.
 *
 * `rows` is the audit's own view, passed rather than assumed: the three views
 * are different lengths (processed drops the partial movements), and a header
 * counting a view the section below never read is the small version of the
 * bug this whole module exists to remove.
 * @param {Views} views
 * @param {Row[]} rows - the view this audit reads
 * @param {string} [suffix] - appended to the row-count line
 * @returns {string[]}
 */
export function viewsHeader({ dropped }, rows, suffix = '') {
    const lines = [`Rows: ${rows.length}${suffix}`];
    if (dropped) {
        lines.push(
            `  !! ${dropped} row(s) have a timestamp that will not parse and are`,
            '     absent from everything below — the app drops them too, so they',
            '     count for nothing until the Timestamp cell is fixed.');
    }
    return lines;
}
