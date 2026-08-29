#!/usr/bin/env node
// @ts-check
// Audit ensemble headcounts in the music log.
//
// Every row implies an ensemble size: a piano trio needs 3 players, a quartet
// 4, a quintet 5. When fewer people are logged than the work needs, somebody
// went unrecorded — most often the pianist, because the sheet's three player
// slots model a string quartet and a piano ensemble has no seat for them.
//
// Reads the PROCESSED view — the app's own pipeline. On the written view every
// continuation row states no players at all and would look under-logged; the
// processed view is where each row carries its full group.
//
// Two independent problems, reported separately:
//
//   UNDER-LOGGED   fewer people in the row than the work requires. The missing
//                  person is absent from every stat. Only you can fill these
//                  in, and reconstructing from memory years later is guesswork
//                  — a row that is honestly incomplete beats an invented one.
//
//   UNANNOTATED    a piano work where nobody carries a "(piano)"-style
//                  annotation. The headcount may be right while the pianist
//                  sits in a string seat, so they are counted as a violinist or
//                  a cellist. Fixable in place: annotate the slot, e.g.
//                  "Alice Hart" -> "Alice Hart (p)".
//
//                  It can only see a piano work that SAYS so. all_works.json
//                  carries no piano repertoire, so a row titled with a bare
//                  catalogue number ("K478") and no comment naming the ensemble
//                  is invisible here however it is logged. Read 0 as "none of
//                  the ones we can identify", not "none".
//
// Usage: node scripts/audit_ensembles.mjs [path/to/data-raw.csv]
//        (defaults to archive/data-raw.csv)

import { instrumentFromSlot, parseOthers } from '../src/dataProcessor.js';
import { formatTimestamp } from '../src/csvFormat.js';
import { loadViews, viewsHeader } from './lib/views.mjs';
import { loadCatalog, rowWorkKey } from './audit_fillforward.mjs';
import { readNameTables, runAudit } from './lib/cli.mjs';

/** @typedef {import('../src/dataProcessor.js').Row} Row */
/** @typedef {import('./lib/views.mjs').Views} Views */

// Ensemble words that appear in Work Title, mapped to how many people play.
const ENSEMBLE_SIZES = {
    duo: 2, duet: 2, trio: 3, quartet: 4, quintet: 5,
    sextet: 6, septet: 7, octet: 8, nonet: 9,
};
const ENSEMBLE_WORDS = Object.keys(ENSEMBLE_SIZES).join('|');
const ENSEMBLE_RE = new RegExp(ENSEMBLE_WORDS, 'i');
// Comments are prose, and this is a music log: "more piano the second time" is
// a dynamic, "quintets were averted" is a joke, "Is this a wind quintet" is
// musing about a work's origin. A bare ensemble word there means nothing. Only
// an instrumentation phrase — the instrument immediately before the ensemble
// word, as in "Piano Quartet" or "Notturno for Piano Trio" — is trustworthy.
const COMMENT_ENSEMBLE_RE = new RegExp(
    '\\b(piano|klavier|harpsichord|fortepiano|clarinet|horn|oboe|flute|'
    + `bassoon)\\s+(${ENSEMBLE_WORDS})\\b`, 'i');
// "wind" and "string" are deliberately absent: in a string-chamber log they
// name a work's ORIGIN rather than what was played — "Wind Octet are quintet"
// is Mozart's K406, an octet arranged as a quintet, and sizing it at 8 is
// wrong. A genuine wind ensemble would fall back to the quartet default, which
// is the honest answer for a row this log was never shaped to describe.
// Two different jobs, two different patterns. Work titles are matched loosely
// ("Brahms Piano Quartet 1"); instrument annotations are matched anchored, so
// the "p" shorthand this log actually uses is recognized without "p" swallowing
// every instrument that merely starts with one.
const TITLE_KEYBOARD_RE = /piano|klavier|harpsichord|fortepiano/i;
const ANNOT_KEYBOARD_RE =
    /^(?:p|pf|pno|piano|klavier|fortepiano|harpsichord|keyboard|organ)(?![a-z])/i;

/**
 * The instrumentation phrase in Comments, if this row's own title hasn't
 * already settled the question.
 *
 * Requiring an instrument immediately before the ensemble word keeps most
 * prose out, but not all of it: "Post-Mexican food after piano quartet
 * afternoon" is syntactically an instrumentation phrase and reads as one.
 * What rules it out is the row itself — the work is a catalogued string
 * quartet, so whatever the comment is talking about, it isn't this piece.
 * The catalog is the only thing that can say so, and it says it for the one
 * real false positive in the log without touching any other row.
 *
 * An empty catalog (missing all_works.json) just disables the gate.
 * @param {Row} row
 * @param {Set<string>} quartets
 * @returns {RegExpMatchArray|null}
 */
export function commentEnsemble(row, quartets) {
    if (quartets.has(rowWorkKey(row))) return null;
    return (row.comments ?? '').match(COMMENT_ENSEMBLE_RE);
}

/**
 * (people the work needs, whether it was stated rather than assumed).
 *
 * Work Title is often a catalogue number — "K478", "20#4" — with the ensemble
 * named only in Comments ("Piano Quartet"), so both fields are searched.
 * Absent any ensemble word we assume a quartet, which is the log's bread and
 * butter, but flag the assumption so those rows triage separately.
 * @param {Row} row
 * @param {Set<string>} quartets
 * @returns {{ need: number, stated: boolean }}
 */
export function expectedSize(row, quartets) {
    const inTitle = (row.work.title ?? '').match(ENSEMBLE_RE);
    if (inTitle) {
        return { need: sizeOf(inTitle[0]), stated: true };
    }
    const inComment = commentEnsemble(row, quartets);
    if (inComment) return { need: sizeOf(inComment[2]), stated: true };
    return { need: 4, stated: false };
}

/** @param {string} word */
function sizeOf(word) {
    return ENSEMBLE_SIZES[/** @type {keyof typeof ENSEMBLE_SIZES} */ (word.toLowerCase())];
}

/**
 * A keyboard work? Work Title is authoritative; Comments only counts when the
 * keyboard word sits in an instrumentation phrase about this work.
 * @param {Row} row
 * @param {Set<string>} quartets
 * @returns {boolean}
 */
export function mentionsKeyboard(row, quartets) {
    if (TITLE_KEYBOARD_RE.test(row.work.title ?? '')) return true;
    const m = commentEnsemble(row, quartets);
    return !!m && TITLE_KEYBOARD_RE.test(m[1]);
}

/**
 * The logger plus everyone they recorded. '-' marks a seat the work doesn't
 * have, and is not a person (mirrors peopleKeysFor).
 * @param {Row} row
 * @returns {number}
 */
export function loggedPeople(row) {
    const slots = [row.player1, row.player2, row.player3]
        .filter(s => (s ?? '').trim() !== '' && (s ?? '').trim() !== '-').length;
    const others = (row.othersList ?? parseOthers(row.others)).length;
    return 1 + slots + others;
}

/**
 * Every instrument annotation in the row: the three player slots and each
 * Others? entry.
 *
 * The app's own reader, not a looser local one. instrumentFromSlot rejects a
 * parenthetical that names no instrument ("(sub)", "(guest)"), and the only
 * question asked here is "is this the keyboard" — which is no for every such
 * note anyway, so deferring costs nothing and removes a vocabulary that would
 * drift the moment the JS list is edited.
 * @param {Row} row
 * @returns {(string|null)[]}
 */
function annotations(row) {
    const slots = [row.player1, row.player2, row.player3];
    return [
        ...slots.map((s, i) => row.playerInstruments?.[i] ?? instrumentFromSlot(s)),
        ...(row.othersList ?? parseOthers(row.others)).map(o => o.instrument),
    ];
}

/**
 * Is anyone in the row marked as the keyboard player? Player slots count as
 * well as Others?, since an annotated slot is honored by the app (see
 * instrumentFromSlot in src/dataProcessor.js).
 * @param {Row} row
 * @returns {boolean}
 */
export function hasKeyboardAnnotation(row) {
    return annotations(row).some(i => !!i && ANNOT_KEYBOARD_RE.test(i));
}

/**
 * Date only. csvFormat writes month, day and hour unpadded, so a fixed slice
 * would cut into the time for most of the year; split on the space instead.
 * The date is the only thing that finds the row in the sheet.
 * @param {Row} row
 * @returns {string}
 */
export function datestamp(row) {
    return row.timestamp ? formatTimestamp(row.timestamp).split(' ')[0] : '';
}

/** @param {Row} row */
function describe(row) {
    const slots = [row.player1, row.player2, row.player3]
        .map(s => (s ?? '').trim() || '∅').join(' | ');
    const others = (row.others ?? '').trim() || '∅';
    return `part=${pad(row.part ?? '?', 4)} slots=[${slots}]  others=${others}`;
}

/** @param {string} s @param {number} n */
const pad = (s, n) => s.padEnd(n);
/** @param {string} s @param {number} n */
const fit = (s, n) => s.slice(0, n).padEnd(n);

/**
 * @param {Views} views
 * @returns {string[]}
 */
export function runEnsembleAudit(views) {
    const { processed } = views;
    const { quartets } = loadCatalog();

    /** @type {{ row: Row, need: number, got: number }[]} */
    const explicitShort = [];
    /** @type {{ row: Row, need: number, got: number }[]} */
    const assumedShort = [];
    /** @type {Row[]} */
    const unannotated = [];
    for (const row of processed) {
        const { need, stated } = expectedSize(row, quartets);
        const got = loggedPeople(row);
        if (got < need) (stated ? explicitShort : assumedShort).push({ row, need, got });
        if (mentionsKeyboard(row, quartets) && !hasKeyboardAnnotation(row)) {
            unannotated.push(row);
        }
    }

    const lines = viewsHeader(views, processed);
    lines.push('');

    lines.push(`=== UNDER-LOGGED: title states the ensemble (${explicitShort.length}) ===`,
        'Someone is missing from these rows. Reconstruct only what you\'re sure of.',
        '');
    for (const { row, need, got } of explicitShort) {
        lines.push(`  ${pad(datestamp(row), 10)} ${fit(row.composer ?? '', 14)} `
            + `${fit(row.work.title ?? '', 26)} needs ${need}, logged ${got}`);
        lines.push(`             ${describe(row)}`);
    }

    lines.push('', `=== UNANNOTATED PIANO WORKS (${unannotated.length}) ===`,
        'Headcount may be fine, but nobody is marked as the keyboard player,',
        'so they are counted as a string player. Annotate the slot in place.',
        '');
    for (const row of unannotated) {
        lines.push(`  ${pad(datestamp(row), 10)} ${fit(row.composer ?? '', 14)} `
            + `${fit(row.work.title ?? '', 26)} ${describe(row)}`);
    }

    lines.push('',
        `=== UNDER-LOGGED: ensemble assumed to be a quartet (${assumedShort.length}) ===`,
        'The title names no ensemble, so 4 is a guess — duos, sight-reading',
        'sessions and partial groups land here legitimately. Skim, don\'t trust.',
        '');
    /** @type {Map<number, number>} */
    const counts = new Map();
    for (const { got } of assumedShort) counts.set(got, (counts.get(got) ?? 0) + 1);
    for (const got of [...counts.keys()].sort((a, b) => a - b)) {
        lines.push(`  ${String(counts.get(got)).padStart(4)} rows logged ${got} of an assumed 4`);
    }
    return lines;
}

await runAudit(import.meta.url, 'archive/data-raw.csv', async csvPath =>
    runEnsembleAudit(loadViews(csvPath, await readNameTables())));
