#!/usr/bin/env node
// @ts-check
// Find rows that lost an Others? player to fill-forward.
//
// fillForward (src/dataProcessor.js) carries player1/2/3 and location down to
// the next row in a session, so a row left blank repeats whoever was there
// before. It does NOT carry `others`. A session logged the natural way — spell
// the group out once, then leave the slots blank for each following piece —
// therefore keeps the quartet but silently drops the second violist, the extra
// cellist, the pianist.
//
// Reads the WRITTEN view: it looks for exactly the blank player slots that
// mark a continuation row, and fill-forward is what erases them.
//
// Only rows whose player slots hold nothing but blanks and "-" — with at
// least one blank — are reported: a blank unambiguously means "same group as
// before" and "-" types no player, it empties a seat. A row that re-types some
// players may be deliberately dropping the extra person, so those are left
// alone. (An all-"-" row states every seat empty, fills nothing, and is not a
// continuation at all.)
//
// Usage: node scripts/audit_fillforward.mjs [path/to/data-raw.csv]
//        (defaults to archive/data-raw.csv)

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
    refersToPrevEntry, SESSION_WINDOW_HOURS, splitOutsideParens,
} from '../src/dataProcessor.js';
import { loadViews, viewsHeader } from './lib/views.mjs';
import { readNameTables, runAudit, warnIfStub } from './lib/cli.mjs';

/** @typedef {import('../src/dataProcessor.js').Row} Row */
/** @typedef {import('./lib/views.mjs').Views} Views */
/** @typedef {import('../src/dataProcessor.js').FillDecision} FillDecision */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = resolve(REPO_ROOT, 'static/data/all_works.json');

// Parts that only exist in an ensemble larger than a quartet. A row naming one
// of these in Others? is a quintet/sextet; the next row need not be. "v2" is
// deliberately NOT here: a quartet has a second violin seat, so an Others? "v2"
// is a fifth body in the room rotating through, and the next quartet still has
// nowhere to put them — exactly the drop worth reporting.
export const EXTRA_STRING_RE = /^(?:va|vla|vc)\s*[2-9]\b|^v\s*[3-9]\b/i;
// A comment scoping the entry to particular movements — "(echoing v2, on I)",
// "(v1, shadowing on II, III)" — describes what someone did in THIS piece. It
// is the opposite of a standing arrangement, so it must not propagate.
const SCOPED_RE = /\bon\s+[IVXivx]+\b|\bmvmts?\b|\bmovements?\b|\bonly\b/i;

/**
 * (works needing 5+ players, works that are plain quartets).
 *
 * The catalog already knows: the "5+" tab lists the quintet and sextet
 * repertoire, every other composer key lists that composer's quartets.
 * @returns {{ big: Set<string>, quartets: Set<string> }}
 */
export function loadCatalog() {
    /** @type {Set<string>} */ const big = new Set();
    /** @type {Set<string>} */ const quartets = new Set();
    if (!existsSync(CATALOG)) return { big, quartets };
    const data = JSON.parse(readFileSync(CATALOG, 'utf8'));
    for (const [tab, entries] of Object.entries(data)) {
        if (tab === '5+') {
            for (const group of /** @type {Record<string, string[]>[]} */ (entries)) {
                for (const [composer, titles] of Object.entries(group)) {
                    for (const title of titles) big.add(workKey(composer, title));
                }
            }
        } else if (Array.isArray(entries) && typeof entries[0] === 'string') {
            for (const title of entries) quartets.add(workKey(tab, title));
        }
    }
    return { big, quartets };
}

/** @param {string} composer @param {string} title */
export function workKey(composer, title) {
    return `${composer.trim()} ${title.trim()}`;
}

/** @param {Row} row */
export function rowWorkKey(row) {
    return workKey(row.composer ?? '', row.work.title ?? '');
}

/**
 * Would the continuation row's work still seat whoever was in Others??
 *
 * Suppress only on positive evidence: the work is a known quartet AND every
 * dropped entry is an extra-string part that a quartet has no seat for. A
 * sextet followed by a quartet really does lose its second viola, and
 * reporting that as a mistake sends someone to "fix" correct data. Anything
 * unrecognised is still reported — a pianist is not inferable this way, and
 * "Horn Trio (with cello)" names no keyboard while needing one.
 * @param {Row} row
 * @param {string} others - the anchor row's Others? cell
 * @param {Set<string>} big
 * @param {Set<string>} quartets
 * @returns {boolean}
 */
export function needsTheExtraPlayer(row, others, big, quartets) {
    const work = rowWorkKey(row);
    if (big.has(work) || !quartets.has(work)) return true;
    /** @type {string[]} */
    const parts = [];
    // Entry boundaries come from the app's own splitter, so a comma inside an
    // annotation cannot tear an entry in half. parseOthers is not usable here:
    // it keeps only the instrument code, and the COMMENT half is what says an
    // entry was scoped to particular movements.
    for (const frag of splitOutsideParens(others)) {
        const t = frag.trim();
        // splitOutsideParens returns every fragment, blank ones included, so a
        // trailing ";" yields a '' that matches no annotation and defeats the
        // `every` below — reporting a correct quintet anchor as a mistake.
        // Filter as parseOthers does: '' and '-' name nobody.
        if (!t || t === '-') continue;
        const m = t.match(/^.+?\(([^)]+)\)/);
        const inside = m ? m[1] : '';
        // A scoped entry argues for nothing: drop it and let the rest of the
        // line decide. Suppressing the whole row on one is what hid the
        // pianist in "Eve (v1, on II, III); Fred (p)" — the second entry is
        // a standing member of the group and the next row loses them.
        if (SCOPED_RE.test(inside)) continue;
        parts.push(inside.split(',')[0].trim());
    }
    // Report unless every surviving entry names a part a quartet has no seat
    // for. A line whose entries were ALL movement-scoped leaves `parts` empty,
    // and `every` is vacuously true on it — which is the answer we want:
    // nothing was dropped that should have carried, so there is nothing to
    // report. An unannotated entry leaves '' in `parts`, which matches no
    // extra-string part, so it reports — a pianist is not inferable this way.
    return !parts.every(p => EXTRA_STRING_RE.test(p));
}

/** @param {Row} row @returns {string[]} */
function slots(row) {
    return [row.player1, row.player2, row.player3].map(s => (s ?? '').trim());
}

/** @param {Row} row */
export function label(row) {
    const t = /** @type {Date} */ (row.timestamp);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    return `${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()} ${hh}:${mm}  `
        + `${(row.composer ?? '').trim()} ${(row.work.title ?? '').trim()}`;
}

/**
 * Check SESSION_WINDOW_HOURS against the log instead of asserting it.
 *
 * Measure what the constant actually governs. A blank cell is a ditto mark
 * and fillForward repeats it however long the gap, so continuation rows are
 * not what the window decides. What it decides is the shorthand rule: a
 * written short form is read as an abbreviation of the fuller name above it
 * only inside the window, and outside it stands as a name of its own. Too
 * long a window merges two people who share a first name; too short a one
 * splits one person in two.
 *
 * So the gaps that matter are the ones at which shorthand is actually
 * typed — a handful in this log, which is why the value is not delicate.
 *
 * The gaps come from fillForward's own decision trace, not from a loop that
 * reproduces it. Reproducing it is what this section used to do, and the
 * mirror was wrong three separate times: it measured the gap from the row
 * where the full name was TYPED rather than from the row above (~39% of raw
 * rows are blank continuation rows, so the two numbers differ on exactly the
 * sessions this section describes); it took the prefix branch ungated, so a
 * cell the app rewrote from the abbreviation table was reported "left as
 * typed"; and it walked only the three player columns while the app applies
 * the same rule to `location`. None of the three can recur: there is one
 * loop now, in fillForward, and this reads what it did.
 *
 * @param {{ fillDecisions: FillDecision[] }} views
 * @returns {string[]}
 */
export function sessionWindowReport({ fillDecisions }) {
    /** @type {{ gap: number, row: Row, full: string, verdict: string }[]} */
    const prefixGaps = [];
    for (const { row, branch, entry, reference, gap, result } of fillDecisions) {
        // A blank is a ditto mark: it repeats however long the gap, so it is
        // not what the window decides. Only a WRITTEN short form is.
        if (branch === 'ditto') continue;
        // `entry === reference` also satisfies refersToPrevEntry and is a
        // repetition, not an abbreviation. This is fillForward's own
        // predicate, imported rather than restated.
        if (!refersToPrevEntry(entry, reference) || entry === reference) continue;
        // Which branch fired IS the verdict. Inside the window the prefix
        // rule expanded it; outside, the table got it first if it knew the
        // entry, and otherwise the short form stood as a name of its own.
        const verdict = branch === 'shorthand' ? 'expanded'
            : branch === 'table' ? 'expanded via table'
                : 'left as typed';
        // The table branch rewrote the cell to its own expansion; the other
        // two are about the reference entry above.
        prefixGaps.push({ gap, row, full: branch === 'table' ? result : reference, verdict });
    }

    const lines = [
        '',
        `=== SESSION WINDOW (currently ${SESSION_WINDOW_HOURS}h) ===`,
        'The window governs one rule only: whether a written short form is',
        'read as an abbreviation of the fuller name above it. A blank cell',
        'repeats regardless of the gap, so continuation rows never depend on',
        'it — only the entries below do.',
        '',
    ];
    if (!prefixGaps.length) {
        lines.push('  No shorthand entries in this file; the value is unconstrained.');
        return lines;
    }
    const inside = prefixGaps.filter(g => g.verdict === 'expanded');
    lines.push(`  ${prefixGaps.length} shorthand entries; ${inside.length} inside the window.`);
    for (const { gap, row, full, verdict } of [...prefixGaps].sort((a, b) => a.gap - b.gap)) {
        lines.push(`   ${gap.toFixed(2).padStart(7)}h  ${label(row)}  -> '${full}'  [${verdict}]`);
    }
    lines.push('', '  Moving the window only changes entries whose gap straddles it.');
    return lines;
}

/**
 * Sessions where a blank continuation row inherited its anchor's players and
 * lost its anchor's Others?.
 * @param {{ written: Row[] }} views
 * @param {Set<string>} big
 * @param {Set<string>} quartets
 * @returns {{ anchor: Row, rows: Row[] }[]}
 */
export function droppedOthers({ written }, big, quartets) {
    /** @type {{ anchor: Row, rows: Row[] }[]} */
    const sessions = [];
    /** @type {Map<Row, { anchor: Row, rows: Row[] }>} */
    const byAnchor = new Map();
    /** @type {Row|null} */
    let anchor = null;
    for (const row of written) {
        // A continuation row may mix "-" with its blanks — the ordinary
        // "trio, no cellist" shape. fillForward fills the blank slots from
        // above and drops the anchor's Others? exactly as it does for an
        // all-blank row, so requiring every slot to be '' hid those losses;
        // "-" types no player, so the re-typed-cast rationale for skipping
        // does not apply to it. At least one blank is still required: an
        // all-"-" row inherits nothing.
        const s = slots(row);
        const blank = s.every(x => x === '' || x === '-') && s.some(x => x === '');
        const others = (row.others ?? '').trim();
        if (anchor) {
            // No window here: fillForward fills a blank cell from the row
            // above however long the gap, so a blank row inherits its anchor's
            // players — and loses its anchor's Others? — whatever the gap. The
            // dinner-break rows this used to skip are exactly the ones worth
            // reporting.
            const gap = (Number(row.timestamp) - Number(anchor.timestamp)) / 3600e3;
            const anchorOthers = (anchor.others ?? '').trim();
            if (blank && !others && anchorOthers && gap >= 0
                && needsTheExtraPlayer(row, anchorOthers, big, quartets)) {
                let session = byAnchor.get(anchor);
                if (!session) {
                    session = { anchor, rows: [] };
                    byAnchor.set(anchor, session);
                    sessions.push(session);
                }
                session.rows.push(row);
            }
        }
        // Only a row that states a cast takes the anchor. "-" states a seat is
        // EMPTY, not who is playing: fillForward neither fills nor advances on
        // it, so a later blank row still inherits the players from above the
        // "-" row — and still loses that row's Others?. Letting a "-"-only row
        // (the ordinary "trio, no cellist" continuation) become the anchor hid
        // every drop that followed it.
        if (others || slots(row).some(s => s !== '' && s !== '-')) anchor = row;
    }
    return sessions;
}

/** @param {Row} row */
const isPartial = row => (row.work.title ?? '').includes(':');

/**
 * The name tables are no longer read here: the session-window section reads
 * the decision trace `buildViews` captured from the run that used them, so
 * the report and the run cannot be told different tables.
 * @param {Views} views
 * @returns {string[]}
 */
export function runFillForwardAudit(views) {
    const { big, quartets } = loadCatalog();
    const lines = viewsHeader(views, views.written);
    lines.push(...sessionWindowReport(views));

    const sessions = droppedOthers(views, big, quartets);
    const total = sessions.reduce((n, s) => n + s.rows.length, 0);
    // processData drops any row whose title contains ':' as a partial movement,
    // so fixing those changes nothing downstream — worth saying rather than
    // sending someone to edit rows that cannot affect a statistic.
    const skippable = sessions.reduce((n, s) => n + s.rows.filter(isPartial).length, 0);
    lines.push(
        '',
        `${total} rows in ${sessions.length} sessions dropped an Others? player.`,
        `${total - skippable} of them affect your stats; the other ${skippable} are `
        + 'partial movements,',
        'which processData drops anyway (marked [partial] below).',
        'Copy the Others? value from the anchor row into each row beneath it.',
        '');
    for (const { anchor, rows } of sessions) {
        lines.push(`  ANCHOR  ${label(anchor)}`);
        lines.push(`          Others? = '${(anchor.others ?? '').trim()}'`);
        for (const row of rows) {
            lines.push(`    fill  ${label(row)}${isPartial(row) ? '  [partial]' : ''}`);
        }
        lines.push('');
    }
    return lines;
}

await runAudit(import.meta.url, 'archive/data-raw.csv', async csvPath => {
    const tables = await readNameTables();
    // The session-window section is table-dependent: with the stub, a real
    // shorthand entry can read as "unconstrained" — an artefact of the
    // missing file, not a finding about the sheet.
    warnIfStub(tables);
    return runFillForwardAudit(loadViews(csvPath, tables));
});
