#!/usr/bin/env node
// @ts-check
// Identify a bare first name from the other players on its row.
//
// PLAYER_ALIASES maps one name to one person, so it cannot help when several
// people share a first name — those rows have to be edited. Reported per NAME
// that reads as a large memory problem: a dozen names, hundreds of entries,
// none of them answerable from the name alone.
//
// The row answers it. Two people who share a first name rarely share
// teammates (overlap runs 0.00–0.08 across this log's ambiguous pairs), so the
// other players on the row identify which one was there, years after anyone
// could recall the evening.
//
// Its own module and entry point, not a section of audit_aliases: these
// findings decay — "which Bob was this" gets harder every month and is
// unanswerable once memory goes — while the descriptive audits can batch. Two
// lifecycles want two cadences, and the descriptive audit goes back to
// describing.
//
// Usage: node scripts/attribution.mjs [path/to/data-raw.csv]
//        (defaults to archive/data-raw.csv)

import { formatTimestamp } from '../src/csvFormat.js';
import {
    ANY_CLASS, baseToken, candidateIndex, candidatesFor, collectAppearances,
    nameShape, rowPeople,
} from './lib/people.mjs';
import { loadViews, viewsHeader } from './lib/views.mjs';
import { readNameTables, runAudit, warnIfStub } from './lib/cli.mjs';

/** @typedef {import('../src/dataProcessor.js').Row} Row */
/** @typedef {import('./lib/views.mjs').Views} Views */
/** @typedef {import('./lib/views.mjs').NameTables} NameTables */

// How many times a full name must appear, written out, before its teammate
// circle counts as evidence. The people most often logged bare are exactly the
// ones whose full name is rarest, so below this an unnamed rival's silence
// means "never seen", not "not them" — and a positive match is as likely to be
// an accident of who happens to have been named as it is to be the answer.
export const MIN_WRITTEN_IN_FULL = 5;

/**
 * One thing to do about one cell. Named for what the reader does, not for a
 * state of the algorithm: the retired spike had buckets called `settled`,
 * `unverified` and `resolved_by_sheet`, each needing a paragraph of prose, and
 * six of its review findings were the prose disagreeing with the code.
 *
 * @typedef {Object} Finding
 * @property {'edit-this-cell'|'answer-this-now'} action
 * @property {Row} row - the row AS WRITTEN. A finding asks someone to edit a
 *   cell, and only the written view has cells: on the filled view the
 *   continuation rows have been given players nobody typed.
 * @property {string} name - the bare name in the cell
 * @property {string} cls
 * @property {string|null} alias - what the table says today, if anything
 * @property {string|null} winner - who the other players point to. Set on
 *   every edit-this-cell finding, and on an answer-this-now finding where a
 *   gate declined a clear leader; null only when nothing discriminated.
 * @property {string[]} why - the teammates that decided it
 * @property {string[]} unruled - rivals too thinly written out to rule out
 * @property {number|null} winnerWritten - how often the winner's own full name
 *   was written out; null when winner is null. On an answer-this-now finding a
 *   value below MIN_WRITTEN_IN_FULL IS the gate that declined the leader — the
 *   unruled line names rivals only, so without this the one case where every
 *   rival is attested printed a clear leader with no reason it was not acted on.
 * @property {string[]} candidates - everyone who shares the first name
 */

/**
 * @typedef {Object} Attribution
 * @property {Finding[]} findings - ONE list, each carrying its action. Parallel
 *   lists per bucket produced arity and annotation mismatches twice.
 * @property {number} settled - entries the row settles in agreement with the
 *   table. Nothing to do.
 * @property {number} unverified - entries with no usable evidence but an alias
 *   already standing. Also nothing to do: the alias is the best available
 *   answer and this run cannot second-guess it. Presenting hundreds of these
 *   as work is as misleading as reporting none.
 * @property {number} resolvedBySheet - cells fill-forward already answered.
 *   The app fills before it aliases, so no alias ever saw them; counted apart
 *   from `settled` so the report does not credit src/aliases.js with
 *   fill-forward's work.
 */

/**
 * Decide, per entry, which of several same-first-name people a bare name is.
 *
 * Reads the WRITTEN view for subjects and the FILLED view for evidence, and
 * they must be the same rows in the same order (buildViews guarantees this).
 * The written row says which cells exist, which is what a finding can ask you
 * to edit; the filled row says who was in the room, which is the evidence.
 *
 * Both must come from the raw sheet rather than the processed view. On the
 * processed view normalizePlayerNames has already replaced each bare slot name
 * with whatever the alias guessed, so those rows have joined the guessed
 * person's circle and vote to confirm the guess — a wrong alias would look
 * settled, and only Others? entries, exported verbatim, could ever disagree.
 *
 * @param {{ written: Row[], filled: Row[] }} views
 * @param {NameTables} tables
 * @returns {Attribution}
 */
export function attribute({ written, filled }, { aliases, abbreviations }) {
    // Candidates and attestation counts from what a human typed; circles from
    // the room. An alias-supplied name is the hypothesis under test and a
    // fill-forwarded one is the sheet repeating itself, so neither may swell
    // the count that decides whether a name has been written out enough. The
    // circles want the opposite view: on the written view a continuation row
    // names nobody, so a full name in its Others? cell would carry an empty
    // circle however many sessions it played.
    const { byFirst, circles, written: writtenCount } = candidateIndex(
        collectAppearances(written, abbreviations),
        collectAppearances(filled, abbreviations));

    /** @type {Finding[]} */
    const findings = [];
    let settled = 0;
    let unverified = 0;
    let resolvedBySheet = 0;

    written.forEach((row, i) => {
        const cast = rowPeople(filled[i], abbreviations);
        const bySeat = new Map(cast.map(p => [p.seat, p.name]));
        for (const subject of rowPeople(row, abbreviations)) {
            const { name, cls, seat } = subject;
            // Only a bare first name is in question: a written-out name is
            // already an answer, and an unparsed cell names nobody.
            //
            // An INITIALLED name ("Peter O") is a real gap this tool does not
            // cover — the row could decide it the same way it decides a bare
            // one — but covering it is a change in what the tool reports, not
            // a refactor, so it stays out until that is the intent. Naming
            // the shape rather than counting tokens is what makes it a
            // one-word change instead of a fifth private definition.
            if (nameShape(name) !== 'bare') continue;
            let candidates = candidatesFor(byFirst, baseToken(name), cls);
            if (candidates.size < 2) continue;

            const alias = cls ? aliases[name]?.[cls] ?? null : null;
            // The alias's own target competes even when it shares no first
            // token: the table exists for people logged by first name only,
            // nicknames included ("Nick" -> "Nicholas Hart"). Scoring only the
            // first-token set left that person out of their own row, so
            // `alias === winner` was unreachable and a row the table covers
            // correctly landed in the bucket that says "go and edit the
            // sheet". The ambiguity gate above still keys on the first-token
            // set, so the alias joins a contest that already exists rather
            // than starting one.
            if (alias) candidates = new Set([...candidates, alias]);

            // The sheet may already have answered this itself: fill-forward
            // expands a bare name that abbreviates the previous entry in the
            // session, and the app runs fillForward BEFORE
            // normalizePlayerNames, so no alias ever sees this cell. There is
            // no hazard to report, whatever the table would have said.
            const resolved = bySeat.get(seat) ?? name;
            if (resolved !== name && baseToken(resolved) === baseToken(name)) {
                resolvedBySheet++;
                continue;
            }

            // The subject is never its own evidence, and it takes both tests.
            // Seat drops this very cell — which name alone cannot do once
            // fill-forward has rewritten it, since the written "Peter" and the
            // filled "Peter Ouyang" no longer match. Name drops the SAME
            // person written again elsewhere in the row, which seat alone
            // cannot do. De-duplicated because two distinct mates for one
            // candidate must not tie with one mate written twice for another.
            const mates = [...new Set(cast
                .filter(p => p.seat !== seat && p.name !== name)
                .map(p => p.name))];
            const scored = [...candidates]
                .map(c => ({ name: c, score: mates.filter(m => circles.get(c)?.has(m)).length }))
                .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
            const [top, runner] = scored;
            const why = mates.filter(m => circles.get(top.name)?.has(m));

            // A circle is only evidence if we have one, and that cuts both
            // ways: a conclusion needs the winner to be attested AND the
            // losers' silence to mean something. So every rival the sheet has
            // barely named is reported as one we could not rule out rather
            // than quietly discarded — those are the lines asking someone to
            // edit a cell. The alias gate is separate from the rival gate:
            // with three or more candidates the rival gate can pass while the
            // alias's own attestation is all that stands between a thinly
            // named person and being told they are wrong.
            const unruled = scored.slice(1)
                .filter(c => (writtenCount.get(c.name) ?? 0) < MIN_WRITTEN_IN_FULL)
                .map(c => c.name).sort();
            const confident = (writtenCount.get(top.name) ?? 0) >= MIN_WRITTEN_IN_FULL
                && unruled.length < candidates.size - 1
                && (!alias || alias === top.name
                    || (writtenCount.get(alias) ?? 0) >= MIN_WRITTEN_IN_FULL);

            const base = {
                row, name, cls: cls ?? ANY_CLASS, alias,
                candidates: [...candidates].sort(),
            };
            // Nothing here decides it: either two candidates tie, or NOBODY
            // matched — which is a tie at zero, since the scores are sorted
            // and a zero top means every score is zero — or a gate above says
            // the evidence is too thin to act on.
            if (top.score === runner.score || !confident) {
                if (alias) {
                    unverified++;
                } else {
                    // Nobody has answered this and nobody else can. `alias` is
                    // null on every entry that reaches here, by construction.
                    //
                    // Two ways in, and they know different amounts. A tie —
                    // including the all-zero one where nobody matched —
                    // measured nothing that discriminates, so there is nothing
                    // to carry. A gate failure has a clear leading candidate
                    // and knows exactly which rivals it could not rule out;
                    // discarding those made the report tell the reader "no
                    // teammate matches" when a teammate had matched, and hid
                    // the one fact that would let them answer it from memory.
                    const tied = top.score === runner.score;
                    findings.push({
                        ...base,
                        action: 'answer-this-now',
                        winner: tied ? null : top.name,
                        why: tied ? [] : why,
                        unruled: tied ? [] : unruled,
                        winnerWritten: tied ? null : writtenCount.get(top.name) ?? 0,
                    });
                }
            } else if (!alias || alias !== top.name) {
                // Two ways to arrive, one action. With an alias the entry is
                // credited to the wrong person today; without one the app
                // counts the bare form as a separate person in every people
                // statistic. Either way the fix is the same cell.
                findings.push({
                    ...base, action: 'edit-this-cell', winner: top.name, why, unruled,
                    winnerWritten: writtenCount.get(top.name) ?? 0,
                });
            } else {
                settled++;
            }
        }
    });
    return { findings, settled, unverified, resolvedBySheet };
}

/** @param {Row} row */
function describeRow(row) {
    const date = row.timestamp ? formatTimestamp(row.timestamp).split(' ')[0] : '';
    return `${date.padStart(10)} ${(row.composer ?? '').slice(0, 14).padEnd(14)} `
        + `${(row.work.title ?? '').slice(0, 14).padEnd(14)}`;
}

/**
 * @param {Views} views
 * @param {NameTables} tables
 * @returns {string[]}
 */
export function runAttribution(views, tables) {
    const { findings, settled, unverified, resolvedBySheet } = attribute(views, tables);
    const edits = findings.filter(f => f.action === 'edit-this-cell');
    const answers = findings.filter(f => f.action === 'answer-this-now');

    const lines = viewsHeader(views, views.written);
    lines.push('',
        '=== ATTRIBUTION: which person a bare first name was ===',
        'Read from the other players on the row, since two people who share a',
        'first name rarely share teammates. Deliberately conservative: a false',
        'finding sends someone to edit correct data.');

    lines.push('', `-- edit this cell (${edits.length}) --`,
        '   Either the alias credits this entry to the wrong person, or no alias',
        '   covers it and the app counts the bare form as a separate person in',
        '   every people statistic. Write the full name into the SHEET cell.');
    if (!edits.length) lines.push('   (none)');
    for (const f of edits) {
        lines.push(`   ${describeRow(f.row)}  '${f.name}' [${f.cls}]`);
        lines.push(`   ${''.padEnd(10)} ${f.alias
            ? `alias says '${f.alias}', the other players say '${f.winner}'`
            : `the other players say '${f.winner}'; no alias covers it`}`
            + `  (played with ${f.why.slice(0, 3).join(', ')})`);
        if (f.unruled.length) {
            lines.push(`   ${''.padEnd(10)} could not rule out: ${f.unruled.join(', ')}`
                + ` (written out fewer than ${MIN_WRITTEN_IN_FULL} times)`
                + ' — confirm before editing');
        }
    }

    lines.push('', `-- answer this now (${answers.length}) --`,
        '   No alias covers them and the row does not settle them: either nothing',
        '   pointed at one person — a one-off group or a reading party — or the',
        '   evidence was too thin to act on, and the line below says which.',
        '   The only findings that decay: answer them first.');
    if (!answers.length) lines.push('   (none)');
    for (const f of answers) {
        lines.push(`   ${describeRow(f.row)}  '${f.name}' [${f.cls}]`);
        lines.push(`   ${''.padEnd(10)} candidates: ${f.candidates.join(', ')}`);
        // What the run measured but declined to act on. Printed rather than
        // dropped: the gate is there so the tool does not assert, not so the
        // reader is kept from what it saw.
        if (f.winner) {
            lines.push(`   ${''.padEnd(10)} leading candidate '${f.winner}'`
                + `  (played with ${f.why.slice(0, 3).join(', ')})`);
            // The header above promises the reader is told why the run
            // declined to act, and the unruled line names rivals only. When
            // the failing gate is the winner's OWN attestation and every
            // rival is attested, that line is empty — so say it directly.
            if ((f.winnerWritten ?? 0) < MIN_WRITTEN_IN_FULL) {
                lines.push(`   ${''.padEnd(10)} but '${f.winner}' is written out only `
                    + `${f.winnerWritten} time${f.winnerWritten === 1 ? '' : 's'}`
                    + ` (fewer than ${MIN_WRITTEN_IN_FULL}) — too thin to act on`);
            }
            if (f.unruled.length) {
                lines.push(`   ${''.padEnd(10)} could not rule out: ${f.unruled.join(', ')}`
                    + ` (written out fewer than ${MIN_WRITTEN_IN_FULL} times)`);
            }
        } else {
            lines.push(`   ${''.padEnd(10)} no candidate's teammates single one out`);
        }
    }

    // Everything else is deliberately not a finding, and not given buckets
    // with semantics to explain. One line, so the reader can see that the
    // silence above is a result rather than a run that did nothing.
    lines.push('',
        `   (${settled} more agree with the table and ${unverified} have an alias standing`,
        `   that this run cannot second-guess; a further ${resolvedBySheet} were answered by`,
        '   the sheet itself, where fill-forward expanded the cell and no alias',
        '   was consulted.)');
    return lines;
}

await runAudit(import.meta.url, 'archive/data-raw.csv', async csvPath => {
    const tables = await readNameTables();
    warnIfStub(tables);
    return runAttribution(loadViews(csvPath, tables), tables);
});
