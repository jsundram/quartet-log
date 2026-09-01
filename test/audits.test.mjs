// Unit tests for the data-quality audits in scripts/.
//
// Two things shape this file.
//
// The audits are functions over Row objects, so most of what follows is a
// table of cases. Anything that classifies an instrument, strips an annotation
// or splits the Others? column is imported from src/dataProcessor.js by the
// audits themselves and tested there — the retired Python port had local
// copies of all three, two of them silently wrong, and mirror tests that
// missed it because they sampled inputs where both answers agreed. There is
// nothing left here to mirror.
//
// More importantly, the real PLAYER_ALIASES / PLAYER_ABBREVIATIONS live in
// src/aliases.js, which is gitignored and machine-specific: the real tables
// locally, the empty stub in CI. A test that read them would pass in both
// places while testing two different things. So every function that consumes a
// table takes it as a required argument and throws without one — a structural
// guarantee rather than a convention, which is what the Python suite's autouse
// fixture had to be. Only scripts/lib/cli.mjs reads the real file, only on a
// command-line run, and the last test in this file holds that line.
//
// Placeholder names come from a published list (Alice/Bob/Carol, then Atlantic
// hurricane names), never from the log, and are not screened against it — see
// CLAUDE.md on why filtering would leak more than a collision does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { processRow } from '../src/dataProcessor.js';
import { parseCsv } from '../scripts/lib/parseCsv.mjs';
import { buildViews, viewsHeader } from '../scripts/lib/views.mjs';
import {
    ANY_CLASS, baseToken, candidateIndex, candidatesFor, collectAppearances,
    isFullName, namesByFirst, rowPeople,
} from '../scripts/lib/people.mjs';
import { ambiguityReport, groupVariants, runAliasAudit } from '../scripts/audit_aliases.mjs';
import {
    datestamp, expectedSize, hasKeyboardAnnotation, loggedPeople, mentionsKeyboard,
} from '../scripts/audit_ensembles.mjs';
import {
    droppedOthers, EXTRA_STRING_RE, needsTheExtraPlayer, sessionWindowReport, workKey,
} from '../scripts/audit_fillforward.mjs';

const HEADERS = ['Timestamp', 'Composer', 'Work Title', 'Which Part',
    'Player 1', 'Player 2', 'Player 3', 'Others?', 'Location', 'Comments'];

/** One CSV-shaped row, the shape every view is built from. */
function raw({
    ts = '1/1/2024 10:00:00', composer = 'Haydn', title = '76#1', part = 'V1',
    p1 = '', p2 = '', p3 = '', others = '', location = 'Home', comments = '',
} = {}) {
    return Object.fromEntries(HEADERS.map((h, i) => [h,
        [ts, composer, title, part, p1, p2, p3, others, location, comments][i]]));
}

/** One processed Row, as every audit sees it. */
const row = fields => processRow(raw(fields));

const NO_TABLES = { aliases: {}, abbreviations: {} };

// ------------------------------------------------------------------ views --

test('the written view is what was typed and the filled view is the room', () => {
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alice', p2: 'Bob', p3: 'Carol' }),
        raw({ ts: '1/1/2024 11:00:00' })];
    const { written, filled } = buildViews(rows, NO_TABLES);
    // As written the continuation row is blank — there is no cell to edit.
    assert.equal(written[1].player1, '');
    // As filled it names the room, which is the evidence.
    assert.equal(filled[1].player1, 'Alice');
});

test('written and filled are index-aligned', () => {
    // Attribution (#27) pairs a row as written against the same row as filled,
    // by index. Out of order they would report the wrong cell.
    const rows = [raw({ ts: '3/1/2024 10:00:00', p1: 'Carol' }),
        raw({ ts: '1/1/2024 10:00:00', p1: 'Alice' }),
        raw({ ts: '2/1/2024 10:00:00', p1: 'Bob' })];
    const { written, filled } = buildViews(rows, NO_TABLES);
    assert.deepEqual(written.map(r => Number(r.timestamp)),
        filled.map(r => Number(r.timestamp)));
    assert.deepEqual(written.map(r => r.player1), ['Alice', 'Bob', 'Carol']);
});

test('the filled view fills from the sheet only, never from the abbreviations', () => {
    // "nothing but the sheet's own repetition": an abbreviation expanded there
    // would put a name in a cell the sheet never typed, and the written/filled
    // pair exists precisely to keep those two apart.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alice Hart' }),
        raw({ ts: '1/1/2024 11:00:00', p1: 'A' })];
    const tables = { aliases: {}, abbreviations: { A: 'Bob Jones' } };
    const { filled, processed } = buildViews(rows, tables);
    assert.equal(filled[1].player1, 'A');
    assert.equal(processed[1].player1, 'Bob Jones');
});

test('the processed view drops partial movements and the others keep them', () => {
    const rows = [raw({ ts: '1/1/2024 10:00:00', title: '76#1', p1: 'Alice' }),
        raw({ ts: '1/1/2024 11:00:00', title: '17#2:I', p1: 'Bob' })];
    const { written, filled, processed } = buildViews(rows, NO_TABLES);
    assert.equal(written.length, 2);
    assert.equal(filled.length, 2);
    assert.deepEqual(processed.map(r => r.work.title), ['76#1']);
});

test('the processed view applies the alias table and the others do not', () => {
    const rows = [raw({ p1: 'Alice' })];
    const tables = { aliases: { Alice: { upper: 'Alice Hart' } }, abbreviations: {} };
    const { written, filled, processed } = buildViews(rows, tables);
    assert.equal(written[0].player1, 'Alice');
    assert.equal(filled[0].player1, 'Alice');
    assert.equal(processed[0].player1, 'Alice Hart');
});

test('one short row does not cost the file its filled view', () => {
    // A truncated line has fewer fields than headers. Left undefined, they slip
    // past processRow's `=== undefined` guard and the first .trim() throws —
    // one malformed line costing every row its filled view, and a third of the
    // raw sheet is continuation rows that then look answerless.
    const csv = `${HEADERS.join(',')}\n`
        + '1/1/2024 10:00:00,Haydn,76#1,V1,Alice,Bob,Carol,,Home,\n'
        + '1/1/2024 11:00:00,Haydn,76#2,V1\n';
    const { filled } = buildViews(parseCsv(csv), NO_TABLES);
    assert.equal(filled.length, 2);
    assert.equal(filled[1].player1, 'Alice');
});

test('a row with an unparseable timestamp is dropped and said so', () => {
    // Every section reads the rows the loader returns, so a silent drop would
    // shrink the counts below and leave the printed row total disagreeing with
    // the file. In a data-quality audit an unparseable timestamp is a finding.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alice' }),
        raw({ ts: 'not a date', p1: 'Bob' })];
    const views = buildViews(rows, NO_TABLES);
    assert.equal(views.written.length, 1);
    assert.equal(views.dropped, 1);
    assert.match(viewsHeader(views, views.written).join('\n'),
        /1 row\(s\) have a timestamp that will not parse/);
});

test('the header counts the view the audit read, not a view it ignored', () => {
    const rows = [raw({ ts: '1/1/2024 10:00:00', title: '76#1' }),
        raw({ ts: '1/1/2024 11:00:00', title: '17#2:I' })];
    const views = buildViews(rows, NO_TABLES);
    assert.match(viewsHeader(views, views.written)[0], /^Rows: 2/);
    assert.match(viewsHeader(views, views.processed)[0], /^Rows: 1/);
});

test('building a view without name tables throws rather than guessing', () => {
    // The guarantee this whole file rests on: a caller that forgets a table
    // fails loudly instead of quietly reading the machine's real one.
    assert.throws(() => buildViews([raw({ p1: 'Alice' })], {}), TypeError);
});

// ------------------------------------------------------------- row people --

test('rowPeople labels every cell with its seat', () => {
    assert.deepEqual(
        rowPeople(row({ p1: 'Alice', p2: '-', p3: 'Bob', others: 'Carol (vc); Dexter (v2)' }), {}),
        [{ name: 'Alice', cls: 'upper', seat: 'p1' },
            { name: 'Bob', cls: 'cello', seat: 'p3' },
            { name: 'Carol', cls: 'cello', seat: 'o0' },
            { name: 'Dexter', cls: 'upper', seat: 'o1' }]);
});

test('rowPeople reads a slot annotation as the class', () => {
    // The annotation states the class; the column only implies it.
    assert.deepEqual(rowPeople(row({ p3: 'Alice (p)' }), {}),
        [{ name: 'Alice', cls: 'upper', seat: 'p3' }]);
    // ...but only when it names an instrument. "(sub)" is a note, and honoring
    // it would reclass the player out of the cello column.
    assert.deepEqual(rowPeople(row({ p3: 'Alice (sub)' }), {}),
        [{ name: 'Alice', cls: 'cello', seat: 'p3' }]);
});

test('rowPeople expands from the injected abbreviation table', () => {
    assert.deepEqual(rowPeople(row({ p1: 'A', p2: 'Bob' }), { A: 'Alice' })
        .map(p => p.name), ['Alice', 'Bob']);
});

test('rowPeople expands a slot abbreviation but never an Others? one', () => {
    // fillForward walks only player1/2/3 and location, and
    // normalizePlayerNames runs canonicalize — not the abbreviation table —
    // over othersList. So a single-letter Others? entry stays literal in the
    // app and is counted as its own person; expanding it here would make the
    // variant and ambiguity counts describe a sheet that does not exist, and
    // send a reader to edit a cell that actually reads "A".
    assert.deepEqual(
        rowPeople(row({ p1: 'A', others: 'A (v2)' }), { A: 'Alice' }).map(p => p.name),
        ['Alice', 'A']);
});

test('rowPeople demands an abbreviation table', () => {
    assert.throws(() => rowPeople(row({ p1: 'Alice' })), TypeError);
});

test('rowPeople reads the processed view through its parsed fields', () => {
    // normalizePlayerNames moves each slot's annotation into playerInstruments
    // and the Others? column into othersList. A reader that only looked at the
    // raw cells would lose the annotation's class on that view.
    const [processedRow] = buildViews(
        [raw({ p3: 'Alice (p)', others: 'Bob (vc)' })], NO_TABLES).processed;
    assert.deepEqual(rowPeople(processedRow, {}),
        [{ name: 'Alice', cls: 'upper', seat: 'p3' },
            { name: 'Bob', cls: 'cello', seat: 'o0' }]);
});

test('nobody is their own teammate', () => {
    // Someone written in a slot AND in Others? — how the rows that overflow the
    // quartet layout get logged — must not land in their own circle, or a bare
    // name beside its own full form scores a point for being the person already
    // named in that row.
    const rows = [row({ p1: 'Alice Hart', p2: 'Bob', others: 'Alice Hart (v2)' })];
    const { circles } = candidateIndex(collectAppearances(rows, {}));
    assert.deepEqual([...circles.get('Alice Hart')], ['Bob']);
});

// --------------------------------------------------------- candidate index --

test('candidates are keyed by instrument class', () => {
    // PLAYER_ALIASES is class-keyed, so the candidate set must be too.
    // Otherwise a cello-slot bare name draws the upper-class person of the same
    // first name, whose larger circle then wins, and the CORRECT class-keyed
    // alias gets reported as crediting the wrong person.
    const rows = [row({ p1: 'Alice Hart', p3: 'Alice Bek' })];
    const { byFirst } = candidateIndex(collectAppearances(rows, {}));
    assert.deepEqual([...candidatesFor(byFirst, 'alice', 'upper')], ['Alice Hart']);
    assert.deepEqual([...candidatesFor(byFirst, 'alice', 'cello')], ['Alice Bek']);
});

test('a one-letter surname is an abbreviation, not a rival', () => {
    // "Alice H" is Alice Hart with the surname abbreviated. Admitting it as a
    // candidate invents a rival for the real person.
    const rows = [row({ p1: 'Alice Hart' }), row({ p1: 'Alice H' })];
    const { byFirst } = candidateIndex(collectAppearances(rows, {}));
    assert.deepEqual([...candidatesFor(byFirst, 'alice', 'upper')], ['Alice Hart']);
    assert.equal(isFullName('Alice H'), false);
    assert.equal(isFullName('Alice H.'), false);
    assert.equal(isFullName('Alice Hart'), true);
});

test('bare names are not candidates', () => {
    const rows = [row({ p1: 'Alice Hart' }), row({ p1: 'Alice' })];
    const { byFirst } = candidateIndex(collectAppearances(rows, {}));
    assert.deepEqual([...candidatesFor(byFirst, 'alice', 'upper')], ['Alice Hart']);
});

test('an unparsed annotation is not a candidate', () => {
    // stripParens and parseOthers strip only a TRAILING "(...)", so a stray
    // character after the annotation — "Zelda Quinton (va2)?" — keeps it
    // inside the name. Admitted as a full name it rivals its own clean form:
    // the reader is told to confirm against a person who does not exist, and
    // the phantom (always thinly "written") lands in every unruled list,
    // where it can demote a genuine edit-this-cell finding.
    const rows = [row({ p1: 'Zelda Quinton' }),
        row({ p1: 'Bob', others: 'Zelda Quinton (va2)?' })];
    const { byFirst } = candidateIndex(collectAppearances(rows, {}));
    assert.deepEqual([...candidatesFor(byFirst, 'zelda', 'upper')], ['Zelda Quinton']);
    assert.equal(isFullName('Zelda Quinton (va2)?'), false);
});

test('an unclassified full name is still a candidate', () => {
    // A full name in an unannotated Others? cell has no class of its own, but
    // it is still a person with that first name. Indexed under the pseudo-class
    // so it reaches both the per-name list and any subject's candidate set —
    // the two halves of the report must not disagree about who exists.
    const rows = [row({ p1: 'Alice Hart' }), row({ p1: 'Bob', others: 'Alice Bek' })];
    const { byFirst } = candidateIndex(collectAppearances(rows, {}));
    assert.deepEqual([...candidatesFor(byFirst, 'alice', ANY_CLASS)].sort(),
        ['Alice Bek', 'Alice Hart']);
    assert.deepEqual([...candidatesFor(byFirst, 'alice', 'upper')].sort(),
        ['Alice Bek', 'Alice Hart']);
    assert.deepEqual([...candidatesFor(byFirst, 'alice', null)].sort(),
        ['Alice Bek', 'Alice Hart']);
});

test('circles and written counts come from the rows given', () => {
    const rows = [row({ p1: 'Alice Hart', p2: 'Bob', p3: 'Carol' }),
        row({ p1: 'Alice Hart', p2: 'Dexter', p3: 'Carol' })];
    const { circles, written } = candidateIndex(collectAppearances(rows, {}));
    assert.deepEqual([...circles.get('Alice Hart')].sort(), ['Bob', 'Carol', 'Dexter']);
    assert.equal(written.get('Alice Hart'), 2);
});

test('circles read the filled view while counts read the written one', () => {
    // The two answer different questions about the same rows.
    //
    // Who someone played with is a fact about the room, and fill-forward is how
    // the sheet states it: on the written view a continuation row names nobody,
    // so a full name in its Others? cell would carry an empty circle however
    // many sessions it played. How often a name was TYPED is the opposite —
    // counting fill-forward there lets one typing clear an attestation
    // threshold several times over.
    const rows = [];
    for (let i = 1; i <= 6; i++) {
        rows.push(raw({ ts: `${i}/1/2024 10:00:00`, p1: 'Bob Smith', p2: 'Carol Jones', p3: 'Dan Ray' }));
        // Named only on the continuation row, which states no players itself.
        rows.push(raw({ ts: `${i}/1/2024 11:00:00`, others: 'Zoe Hart' }));
    }
    const { written, filled } = buildViews(rows, NO_TABLES);
    const index = candidateIndex(collectAppearances(written, {}),
        collectAppearances(filled, {}));
    assert.deepEqual([...index.circles.get('Zoe Hart')].sort(),
        ['Bob Smith', 'Carol Jones', 'Dan Ray']);
    assert.equal(index.written.get('Zoe Hart'), 6);   // typed six times, not thirty
});

test('baseToken groups a name with its own short form', () => {
    assert.equal(baseToken('Alice Hart'), 'alice');
    assert.equal(baseToken(' alice '), 'alice');
});

test('namesByFirst is the class-blind view the did-you-mean hint needs', () => {
    // A drifted canonical spelling can hide in either class, so hazard 3's
    // "did you mean" hint searches both. (The hazard-2 alias-key check is the
    // opposite: the table resolves per class, so it reads byFirst directly.)
    const rows = [row({ p1: 'Alice Hart', p3: 'Alice Bek' })];
    const { byFirst } = candidateIndex(collectAppearances(rows, {}));
    assert.deepEqual([...(namesByFirst(byFirst).get('alice') ?? [])].sort(),
        ['Alice Bek', 'Alice Hart']);
});

// ------------------------------------------------------- ambiguity buckets --

const ambiguity = (rows, aliases = {}) =>
    ambiguityReport(collectAppearances(rows, {}), { aliases, abbreviations: {} }).join('\n');

test('an unclassified bare name reaches the per-name list', () => {
    // It was reported per ENTRY under the pseudo-class but never counted per
    // NAME, so the summary — which reads the per-name number — could not see it.
    const rows = [row({ p1: 'Alice Hart' }), row({ p1: 'Alice Bek' }),
        row({ p1: 'Beryl', others: 'Alice' })];
    assert.match(ambiguity(rows), /bare names in the sheet with 2\+ candidates \(1\)/);
});

test('an unclassified subject prints as the pseudo-class, not as null', () => {
    // cls is null for an unannotated Others? entry — every namesake is in
    // play — and printing a literal [null] beside every other line's [upper] is
    // not what that means.
    const rows = [row({ p1: 'Alice Hart' }), row({ p1: 'Alice Bek' }),
        row({ p1: 'Beryl', others: 'Alice' })];
    const out = ambiguity(rows);
    assert.doesNotMatch(out, /\[null/);
    assert.match(out, /'Alice' *\[any/);
});

test('a surname the sheet never writes is the backup bucket', () => {
    // The gitignored table is the only record of it, which is a standing risk.
    const out = ambiguity([row({ p1: 'Alice', p2: 'Bob Jones' })],
        { Alice: { upper: 'Alice Hart' } });
    assert.match(out, /ONLY record of a surname \(1\)/);
    assert.match(out, /absent and unrelated \(0\)/);
});

test('a live alias is reported as neither', () => {
    // A canonical name the sheet resolves to is working, not broken. Reporting
    // it sends you to delete a live alias — the failure this section prevents.
    const out = ambiguity([row({ p1: 'Alberto Stone', p2: 'Beryl Stone' })],
        { 'Alberto Stone': { upper: 'Al Stone' } });
    assert.match(out, /ONLY record of a surname \(0\)/);
    assert.match(out, /absent and unrelated \(0\)/);
});

test('a drifted spelling is the bug bucket', () => {
    const out = ambiguity([row({ p1: 'Dexter Stone', p2: 'Ernesto Stone' })],
        { Chantal: { upper: 'Chantal Stone' } });
    assert.match(out, /absent and unrelated \(1\)/);
});

test('an alias whose canonical has no surname is not the backup bucket', () => {
    // "The ONLY record of a surname" cannot describe a mapping whose target
    // is a bare name — {"Bo Karlsson": {upper: "Bo"}} records no surname, so
    // feeding it to the "back up src/aliases.js" summary line inflates a
    // count that means something else. When its target leaves the sheet it
    // is a stale entry, which is the suspect bucket's job (and where the
    // did-you-mean hint lives).
    const out = ambiguity([row({ p1: 'Dexter Stone' })],
        { 'Bo Karlsson': { upper: 'Bo' } });
    assert.match(out, /ONLY record of a surname \(0\)/);
    assert.match(out, /absent and unrelated \(1\)/);
});

test('an alias keyed on an ambiguous first name is reported', () => {
    const out = ambiguity([row({ p1: 'Alice Hart', p2: 'Alice Bek' })],
        { Alice: { upper: 'Alice Hart' } });
    assert.match(out, /aliases keyed on an ambiguous first name \(1\)/);
    assert.match(out, /'Alice'\s+\[upper\] -> 'Alice Hart'/);
    assert.match(out, /could also be: Alice Bek/);
});

test('a class-keyed pair of namesakes is not an ambiguous alias key', () => {
    // { "Jo": { upper: ..., cello: ... } } is the shape the class-keyed table
    // exists for: a bare upper "Jo" resolves to Jo Alpha and a cello one to
    // Jo Beta, correctly, by construction. The class-blind check flagged it —
    // and the count feeds the SUMMARY line, where it reads as work to do.
    const out = ambiguity([row({ p1: 'Jo Alpha', p3: 'Jo Beta' })],
        { Jo: { upper: 'Jo Alpha', cello: 'Jo Beta' } });
    assert.match(out, /aliases keyed on an ambiguous first name \(0\)/);
});

test('an unclassified namesake is a rival in every class', () => {
    // A full name in an unannotated Others? cell has no class of its own, so
    // it could be the bare "Jo" in any slot — hazard 2 must count it the way
    // hazard 1 does, or the two sections disagree about who exists.
    const out = ambiguity(
        [row({ p1: 'Jo Alpha', others: 'Jo Gamma' })],
        { Jo: { upper: 'Jo Alpha' } });
    assert.match(out, /aliases keyed on an ambiguous first name \(1\)/);
    assert.match(out, /could also be: Jo Gamma/);
});

test('the pseudo-class never reaches the alias proposal or the review table', () => {
    // canonicalize only ever looks up 'upper'/'cello'. A proposed { any: ... }
    // entry is inert when pasted, then makes the name read as handled on the
    // next run, and is re-proposed forever because alreadyAliased can never be
    // true for it.
    const rows = [];
    for (let i = 1; i <= 3; i++) {
        rows.push(raw({ ts: `${i}/1/2024 10:00:00`, p1: 'Bob Smith', p2: 'Carol Jones',
            p3: 'Dan Ray', others: 'Zoe Hart' }));
    }
    rows.push(raw({ ts: '5/1/2024 10:00:00', p1: 'Bob Smith', p2: 'Carol Jones',
        p3: 'Dan Ray', others: 'Zoe' }));
    const out = runAliasAudit(buildViews(rows, NO_TABLES), NO_TABLES).join('\n');
    // The pseudo-class is in the index — that is its job — but the paste-ready
    // block and the REVIEW table must never offer it.
    const proposal = out.slice(out.indexOf('PLAYER_ALIASES proposal'));
    assert.doesNotMatch(proposal, new RegExp(`${ANY_CLASS}:`));
    const review = out.slice(out.indexOf('REVIEW:'), out.indexOf('=== AMBIGUITY'));
    assert.doesNotMatch(review, new RegExp(`\\[${ANY_CLASS}`));
});

test('two full names sharing a first token are never proposed as one person', () => {
    // `sorted` is descending by token count, so a variant can tie the
    // canonical's length but never exceed it — and an equal-length FULL name
    // is not an abbreviation, it is a second person (the AMBIGUITY hazard).
    // Proposing it merges two people in every people statistic, from a block
    // advertised as paste-ready. Same guard reviewReport already had.
    const rows = [];
    for (let i = 1; i <= 3; i++) {
        rows.push(raw({ ts: `${i}/1/2024 10:00:00`,
            p1: 'Alice Hart', p2: 'Zoe Hart', p3: 'Carol Ray' }));
        rows.push(raw({ ts: `${i}/2/2024 10:00:00`,
            p1: 'Alice Bek', p2: 'Zoe', p3: 'Carol Ray' }));
    }
    const out = runAliasAudit(buildViews(rows, NO_TABLES), NO_TABLES).join('\n');
    // The two Alices share Carol (overlap 33%, above the 20% threshold), so
    // without the guard one is proposed as an alias of the other.
    assert.doesNotMatch(out, /propose 'Alice (Hart|Bek)'/);
    assert.match(out, /≠ person\s+'Alice (Hart|Bek)'/);
    const block = out.slice(out.indexOf('PLAYER_ALIASES proposal'));
    assert.doesNotMatch(block, /"Alice/);
    // The guard is about equal length, not about sharing a token: the bare
    // 'Zoe' (fewer tokens, same 33% overlap) still proposes into 'Zoe Hart'.
    assert.match(out, /propose 'Zoe' \[upper\] → 'Zoe Hart'/);
    assert.match(block, /"Zoe": \{ upper: "Zoe Hart" \}/);
});

test('an initialled surname proposes into the full name', () => {
    // "Zelda Q" is Zelda Quinton with the surname abbreviated — isFullName's
    // own rule — not a second Zelda. The equal-length guard must not fire on
    // it: attribution skips 2-token subjects and bars 1-char-surname
    // candidates, so a guard on token count alone left the initialled form
    // aliasable by no tool and counted as its own person in every people
    // statistic, forever. The full name outranks it as canonical even when
    // the initialled form is written more often.
    const rows = [
        raw({ ts: '1/1/2024 10:00:00', p1: 'Zelda Quinton', p2: 'Beryl Ray', p3: 'Carol Fox' }),
        raw({ ts: '2/1/2024 10:00:00', p1: 'Zelda Q', p2: 'Beryl Ray', p3: 'Carol Fox' }),
        raw({ ts: '3/1/2024 10:00:00', p1: 'Zelda Q', p2: 'Beryl Ray', p3: 'Carol Fox' }),
    ];
    const out = runAliasAudit(buildViews(rows, NO_TABLES), NO_TABLES).join('\n');
    assert.match(out, /propose 'Zelda Q' \[upper\] → 'Zelda Quinton'/);
    assert.doesNotMatch(out, /≠ person\s+'Zelda Q'/);
    const review = out.slice(out.indexOf('REVIEW:'), out.indexOf('=== AMBIGUITY'));
    assert.match(review, /'Zelda Q'.*→\s+'Zelda Quinton'/);
    const block = out.slice(out.indexOf('PLAYER_ALIASES proposal'));
    assert.match(block, /"Zelda Q": \{ upper: "Zelda Quinton" \}/);
});

test('a shorter name that is not a prefix is a second person, not an alias', () => {
    // abbreviates() must test tokens, not count them: 'Mary Smith' has fewer
    // tokens than 'Mary Jane Wilson' but abbreviates nothing of it, and at
    // 100% teammate overlap the paste-ready block merged the two people —
    // exactly what the ≠ person branch exists to prevent.
    const rows = [
        raw({ ts: '1/1/2024 10:00:00', p1: 'Mary Jane Wilson', p2: 'Bob Kerr', p3: 'Carol Diaz' }),
        raw({ ts: '2/1/2024 10:00:00', p1: 'Mary Smith', p2: 'Bob Kerr', p3: 'Carol Diaz' }),
    ];
    const out = runAliasAudit(buildViews(rows, NO_TABLES), NO_TABLES).join('\n');
    assert.match(out, /≠ person\s+'Mary Smith'/);
    assert.doesNotMatch(out, /propose 'Mary Smith'/);
    const block = out.slice(out.indexOf('PLAYER_ALIASES proposal'));
    assert.doesNotMatch(block, /"Mary Smith"/);
    // The REVIEW eyeball list must not offer the pair either.
    const review = out.slice(out.indexOf('REVIEW:'), out.indexOf('=== AMBIGUITY'));
    assert.doesNotMatch(review, /'Mary Smith'/);
});

test('an initialled surname with two possible expansions is not proposed', () => {
    // abbreviates() admits 'Zelda Q' → 'Zelda Quinton', so the ambiguity gate
    // must cover initialled variants too: with 'Zelda Quiller' also in the
    // sheet, proposing the more frequent expansion hands out exactly the
    // guess the ≠ person line above it says cannot be made — and the
    // AMBIGUITY section cannot catch it, since its bare-name list is
    // single-token only.
    const rows = [];
    for (let i = 1; i <= 3; i++) {
        rows.push(raw({ ts: `1/${i}/2024 10:00:00`,
            p1: 'Zelda Quinton', p2: 'Beryl Ray', p3: 'Carol Fox' }));
    }
    rows.push(raw({ ts: '2/1/2024 10:00:00', p1: 'Zelda Quiller', p2: 'Beryl Ray', p3: 'Carol Fox' }));
    rows.push(raw({ ts: '3/1/2024 10:00:00', p1: 'Zelda Q', p2: 'Beryl Ray', p3: 'Carol Fox' }));
    const out = runAliasAudit(buildViews(rows, NO_TABLES), NO_TABLES).join('\n');
    assert.match(out, /≠ ambiguous\s+'Zelda Q' \[upper\].*'Zelda Quiller' or 'Zelda Quinton'/);
    assert.doesNotMatch(out, /propose 'Zelda Q'/);
    assert.doesNotMatch(out.slice(out.indexOf('PLAYER_ALIASES proposal')), /"Zelda Q"/);

    // The gate matches candidates by the same prefix test as the proposal:
    // a namesake the initial cannot expand to is no rival, so it must not
    // block the proposal (nor appear as a could-be).
    const withXu = [...rows.slice(0, 3),
        raw({ ts: '2/1/2024 10:00:00', p1: 'Zelda Xu', p2: 'Dan Ray', p3: 'Ernesto Fox' }),
        raw({ ts: '3/1/2024 10:00:00', p1: 'Zelda Q', p2: 'Beryl Ray', p3: 'Carol Fox' })];
    const out2 = runAliasAudit(buildViews(withXu, NO_TABLES), NO_TABLES).join('\n');
    assert.match(out2, /propose 'Zelda Q' \[upper\] → 'Zelda Quinton'/);
});

test('a bare name with two candidates is never proposed', () => {
    // The AMBIGUITY section says an alias can only guess one of them; the
    // paste-ready block must not hand out that guess. Pasting it would
    // convert the hazard-1 finding into a silent hazard-2 and make the next
    // run report the name as handled.
    const rows = [
        raw({ ts: '1/1/2024 10:00:00', p1: 'Alice Hart', p2: 'Beryl Ray', p3: 'Carol Fox' }),
        raw({ ts: '2/1/2024 10:00:00', p1: 'Alice', p2: 'Beryl Ray', p3: 'Carol Fox' }),
        raw({ ts: '3/1/2024 10:00:00', p1: 'Alice Bek', p2: 'Dan Ray', p3: 'Ernesto Fox' }),
    ];
    const out = runAliasAudit(buildViews(rows, NO_TABLES), NO_TABLES).join('\n');
    // The bare 'Alice' clears the overlap threshold against Alice Hart, so
    // without the gate it is proposed — while the AMBIGUITY section lists it.
    assert.match(out, /bare names in the sheet with 2\+ candidates \(1\)/);
    assert.match(out, /≠ ambiguous\s+'Alice' \[upper\].*Alice Bek.*Alice Hart/);
    assert.doesNotMatch(out, /propose 'Alice'/);
    const block = out.slice(out.indexOf('PLAYER_ALIASES proposal'));
    assert.doesNotMatch(block, /"Alice"/);
});

test('variant grouping keys on the first token', () => {
    const rows = [row({ p1: 'Alice Hart', p2: 'Alice', p3: 'Bob Jones' })];
    const groups = groupVariants(collectAppearances(rows, {}));
    assert.deepEqual([...(groups.get('alice') ?? [])].map(v => v.name).sort(),
        ['Alice', 'Alice Hart']);
    assert.deepEqual([...(groups.get('bob') ?? [])].map(v => v.name), ['Bob Jones']);
});

// ------------------------------------------------------------- ensembles --

const QUARTETS = new Set([workKey('Haydn', '50#5')]);

test('expectedSize reads the title, then an instrumentation phrase', () => {
    for (const [title, comments, need, stated] of [
        ['Piano Quintet', '', 5, true],
        ['Sextet 1', '', 6, true],
        ['K478', 'Piano Quartet', 4, true],
        ['K478', 'Notturno for Piano Trio', 3, true],
        // An arrangement title carries two ensemble words and puts what was
        // PLAYED last; sizing it from the first filed the row under the
        // section the report says to trust ("title states the ensemble").
        ['Octet arr. as quintet', '', 5, true],
        ['Symphony 7 arr for octet as quintet', '', 5, true],
        // Prose, not instrumentation: a bare ensemble word means nothing here.
        ['K478', 'quintets were averted briefly', 4, false],
        ['K478', 'more piano the second time', 4, false],
        ['76#1', '', 4, false],
    ]) {
        assert.deepEqual(expectedSize(row({ title, comments }), new Set()),
            { need, stated }, `${title} / ${comments}`);
    }
});

test('a catalogued quartet ignores prose about another piece', () => {
    // "Post-Mexican food after piano quartet afternoon" parses as an
    // instrumentation phrase. The row settles it: this work is a string
    // quartet, so whatever the comment is about, it is not this piece.
    const comments = 'Post-Mexican food after piano quartet afternoon';
    const r = row({ composer: 'Haydn', title: '50#5', comments });
    assert.deepEqual(expectedSize(r, QUARTETS), { need: 4, stated: false });
    assert.equal(mentionsKeyboard(r, QUARTETS), false);
    // The same comment on an uncatalogued work is still trusted.
    assert.equal(expectedSize(row({ title: 'K478', comments }), QUARTETS).stated, true);
});

test('mentionsKeyboard trusts the title and gates the comment', () => {
    for (const [title, comments, expected] of [
        ['Piano Quartet', '', true],
        ['K478', 'Piano Quartet', true],
        ['76#1', 'more piano the second time', false],
        ['76#1', '', false],
    ]) {
        assert.equal(mentionsKeyboard(row({ title, comments }), new Set()), expected,
            `${title} / ${comments}`);
    }
});

test('hasKeyboardAnnotation reads slots as well as Others?', () => {
    assert.equal(hasKeyboardAnnotation(row({ p3: 'Alice (p)' })), true);
    assert.equal(hasKeyboardAnnotation(row({ others: 'Alice (piano)' })), true);
    assert.equal(hasKeyboardAnnotation(row({ p3: 'Alice (vc)' })), false);
    assert.equal(hasKeyboardAnnotation(row({ p3: 'Alice' })), false);
    // A parenthetical naming no instrument is not an annotation at all.
    assert.equal(hasKeyboardAnnotation(row({ p1: 'Alice (sub)' })), false);
});

test('a slot annotation the app cannot read is not a keyboard annotation', () => {
    // The question this section asks is whether the APP sees a keyboard here,
    // because its whole point is that an unseen pianist is counted as a string
    // player. instrumentFromSlot refuses "(klavier)" — it is not in the app's
    // instrument vocabulary — so normalizePlayerNames leaves that player in
    // their positional class and the row genuinely still needs annotating.
    // Reading the parenthetical directly, as the retired Python port did, would
    // call the row handled while the app went on miscounting it.
    assert.equal(hasKeyboardAnnotation(row({ p1: 'Alice (klavier)' })), false);
    // In Others? there is no such gate — parseOthers keeps any parenthetical,
    // and so does the app — so the same word does mark a keyboard player there.
    assert.equal(hasKeyboardAnnotation(row({ others: 'Alice (klavier)' })), true);
});

test('loggedPeople counts the logger and ignores empty seats', () => {
    // "-" marks a seat the work does not have; it is not a person.
    assert.equal(loggedPeople(row({ p1: 'Alice', p2: '-', p3: 'Bob' })), 3);
    assert.equal(loggedPeople(
        row({ p1: 'Alice', p2: 'Bob', p3: 'Carol', others: 'Dexter (v2)' })), 5);
});

test('datestamp survives an unpadded timestamp', () => {
    // csvFormat writes M/D/YYYY H:mm:ss, so a fixed slice cuts into the time.
    assert.equal(datestamp(row({ ts: '1/1/2024 1:05:00' })), '1/1/2024');
    assert.equal(datestamp(row({ ts: '12/31/2024 13:05:00' })), '12/31/2024');
});

// ---------------------------------------------------------- fill-forward --

test('a blank is a ditto mark however long the break', () => {
    // Ported from the retired branch with #24's behaviour (issue #26): the
    // window governs the shorthand rule only, never a blank cell.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alice', p2: 'Bob', p3: 'Carol' }),
        raw({ ts: '1/1/2024 20:00:00' })];
    assert.equal(buildViews(rows, NO_TABLES).filled[1].player1, 'Alice');
});

test('the session-window report measures shorthand, not blanks', () => {
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alberto Stone' }),
        raw({ ts: '1/1/2024 11:00:00', p1: 'Alberto' })];
    const out = sessionWindowReport(buildViews(rows, NO_TABLES), {}).join('\n');
    assert.match(out, /1 shorthand entries; 1 inside the window/);
    assert.match(out, /'Alberto Stone'/);
});

test('the session-window report says so when nothing constrains the value', () => {
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alberto Stone' })];
    assert.match(sessionWindowReport(buildViews(rows, NO_TABLES), {}).join('\n'),
        /unconstrained/);
});

test('the session-window gap is measured from the row above, as fillForward does', () => {
    // fillForward advances its time anchor on EVERY row whose cell is not "-",
    // blank continuation rows included. Measuring from the row where the full
    // name was TYPED reports a gap the app never used — and ~39% of raw rows
    // are blank continuation rows, so the two differ on exactly the sessions
    // this section exists to describe.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Grace Brown', p2: 'Beryl', p3: 'Carol' }),
        raw({ ts: '1/1/2024 12:00:00' }),
        raw({ ts: '1/1/2024 15:00:00' }),
        raw({ ts: '1/1/2024 16:00:00', p1: 'Grace', p2: 'Beryl', p3: 'Carol' })];
    const views = buildViews(rows, NO_TABLES);
    // The app expanded it: the gap it saw was 1h, from the blank row above.
    assert.equal(views.filled[3].player1, 'Grace Brown');
    const out = sessionWindowReport(views, {}).join('\n');
    assert.match(out, /1 shorthand entries; 1 inside the window/);
    assert.match(out, /1\.00h.*\[expanded\]/);
});

test('an expanded shorthand does not become the reference entry', () => {
    // fillForward keeps `prevEntry` when it expands, so a second short form
    // later in the session still abbreviates the FULL name. Advancing the
    // reference to the short form hid every repeat after the first — three of
    // them on the real sheet.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Grace Brown', p2: 'Beryl', p3: 'Carol' }),
        raw({ ts: '1/1/2024 11:00:00', p1: 'Grace', p2: 'Beryl', p3: 'Carol' }),
        raw({ ts: '1/1/2024 12:00:00', p1: 'Grace', p2: 'Beryl', p3: 'Carol' })];
    const views = buildViews(rows, NO_TABLES);
    assert.deepEqual(views.filled.map(r => r.player1),
        ['Grace Brown', 'Grace Brown', 'Grace Brown']);
    assert.match(sessionWindowReport(views, {}).join('\n'),
        /2 shorthand entries; 2 inside the window/);
});

test('the session-window report expands an abbreviation the way the app does', () => {
    // "A" is not a word-boundary prefix of "Alice Hart", so it falls to the
    // abbreviation branch and "Alice" — not "A" — becomes the reference the
    // next short form is compared against.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Bob Jones' }),
        raw({ ts: '1/1/2024 11:00:00', p1: 'A' }),
        raw({ ts: '1/1/2024 12:00:00', p1: 'Alice' })];
    const views = buildViews(rows, NO_TABLES);
    assert.match(sessionWindowReport(views, { A: 'Alice Hart' }).join('\n'),
        /1 shorthand entries; 1 inside the window/);
    // Without the table "A" would stand as its own name and nothing follows it.
    assert.match(sessionWindowReport(views, {}).join('\n'),
        /No shorthand entries in this file/);
});

test('a prefix that is also an abbreviation follows the app outside the window', () => {
    // fillForward gates its prefix branch on the window and falls through to
    // the abbreviation table. Consulting the prefix rule first said "left as
    // typed" for a cell the app rewrote from the table — and made "J" the
    // reference instead of "Jane Doe", so the later "Jane" was compared
    // against the wrong name and never reported as shorthand at all.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'J Smith' }),
        raw({ ts: '1/1/2024 20:00:00', p1: 'J' }),
        raw({ ts: '1/1/2024 21:00:00', p1: 'Jane' })];
    const tables = { aliases: {}, abbreviations: { J: 'Jane Doe' } };
    const views = buildViews(rows, tables);
    // What the app does with the same table: outside the window "J" expands
    // from the table, and "Jane" then abbreviates the expansion.
    assert.deepEqual(views.processed.map(r => r.player1),
        ['J Smith', 'Jane Doe', 'Jane Doe']);
    const out = sessionWindowReport(views, tables.abbreviations).join('\n');
    assert.match(out, /2 shorthand entries; 1 inside the window/);
    assert.match(out, /10\.00h.*-> 'Jane Doe'\s+\[expanded via table\]/);
    assert.match(out, /1\.00h.*-> 'Jane Doe'\s+\[expanded\]/);
});


test('the session-window report measures the location column too', () => {
    // fillForward applies the same window-gated prefix rule to all four
    // columns it walks. A report measuring only the players would say a
    // window change was free while it silently stopped a location shorthand
    // from expanding.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alice', location: 'Oak Hall' }),
        raw({ ts: '1/1/2024 13:30:00', p1: 'Alice', location: 'Oak' })];
    const views = buildViews(rows, NO_TABLES);
    // The app really does expand it — 3.5h is inside the 4h window.
    assert.equal(views.filled[1].location, 'Oak Hall');
    const out = sessionWindowReport(views, {}).join('\n');
    assert.match(out, /1 shorthand entries; 1 inside the window/);
    assert.match(out, /3\.50h.*-> 'Oak Hall'\s+\[expanded\]/);
});

test('extra-string parts are the ones a quartet cannot seat', () => {
    for (const [part, isExtra] of [
        ['va2', true], ['vc2', true], ['vla2', true], ['v3', true],
        // A quartet HAS a second violin seat, so an Others? "v2" is a fifth
        // body in the room and the next quartet has nowhere to put them either.
        ['v2', false], ['v1', false], ['va', false], ['vc', false],
    ]) {
        assert.equal(EXTRA_STRING_RE.test(part), isExtra, part);
    }
});

test('needsTheExtraPlayer suppresses only on positive evidence', () => {
    const quartets = new Set([workKey('Haydn', '76#1')]);
    const r = row({ composer: 'Haydn', title: '76#1' });
    for (const [others, needed] of [
        ['Alice (p)', true],                    // a pianist has no seat either way
        ['Alice (va2)', false],                 // a quartet has no second viola
        ['Alice (va2); Bob (vc2)', false],
        ['Alice (v2)', true],                   // ...but it has no spare v2 chair
        ['Alice', true],                        // unannotated: not inferable
        ['Alice (v1, on II, III)', false],      // scoped to this piece; must not carry
        // One scoped entry must not silence the rest of the line: the pianist
        // is still dropped by the next row.
        ['Alice (v1, on II, III); Bob (p)', true],
        // The entry split is paren-aware, so a comma inside an annotation does
        // not tear an entry in half and leave a fragment arguing for itself.
        ['Alice (va2, doubling, second half)', false],
        // A trailing separator leaves an empty fragment, which names nobody
        // and must not defeat the suppression — parseOthers filters the same
        // way. Reporting it sends someone to "fix" correct data.
        ['Alice (va2);', false],
        ['Alice (va2), ', false],
        ['Alice (va2); -', false],
    ]) {
        assert.equal(needsTheExtraPlayer(r, others, new Set(), quartets), needed, others);
    }
});

// Uncatalogued works, so needsTheExtraPlayer always says "report".
const NO_CATALOG = /** @type {[Set<string>, Set<string>]} */ ([new Set(), new Set()]);

test('a blank continuation row that loses its anchor Others? is reported', () => {
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alice', p2: 'Bob', p3: 'Carol',
        others: 'Dan Fox (p)' }),
        raw({ ts: '1/1/2024 11:00:00' })];
    const sessions = droppedOthers(buildViews(rows, NO_TABLES), ...NO_CATALOG);
    assert.equal(sessions.length, 1);
    assert.equal((sessions[0].anchor.others ?? '').trim(), 'Dan Fox (p)');
    assert.equal(sessions[0].rows.length, 1);
});

test('a "-"-only row does not steal the anchor', () => {
    // "-" states a seat is EMPTY, not who is playing: fillForward neither
    // fills nor advances on it, so the later blank row still inherits the
    // 10:00 group — and still loses 'Dan Fox (p)'. With the "-" row as
    // anchor (it carries no Others?), that drop was never reported, and the
    // shape is the ordinary "trio, no cellist" continuation row.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alice', p2: 'Bob', p3: 'Carol',
        others: 'Dan Fox (p)' }),
        raw({ ts: '1/1/2024 11:00:00', p1: '-' }),
        raw({ ts: '1/1/2024 12:00:00' })];
    const views = buildViews(rows, NO_TABLES);
    // The app really does inherit the 10:00 group across the "-" row.
    assert.equal(views.filled[2].player1, 'Alice');
    const sessions = droppedOthers(views, ...NO_CATALOG);
    assert.equal(sessions.length, 1);
    assert.equal((sessions[0].anchor.others ?? '').trim(), 'Dan Fox (p)');
    // BOTH rows are continuations of the 10:00 anchor. The "-" row's blank
    // slots are filled from it and its Others? is lost just like the
    // all-blank row's — "-" types no player, so the re-typed-cast rationale
    // for skipping does not cover it, and requiring every slot to be blank
    // hid exactly the "trio, no cellist" shape this fixture is.
    assert.deepEqual(sessions[0].rows.map(r => r.timestamp.getHours()), [11, 12]);
});

test('an all-"-" row is not a continuation', () => {
    // Every seat stated empty: fillForward fills nothing, so nothing is
    // inherited and there is no drop to report. (It does not take the anchor
    // either — see above.)
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alice', p2: 'Bob', p3: 'Carol',
        others: 'Dan Fox (p)' }),
        raw({ ts: '1/1/2024 11:00:00', p1: '-', p2: '-', p3: '-' })];
    assert.equal(droppedOthers(buildViews(rows, NO_TABLES), ...NO_CATALOG).length, 0);
});

test('a row that re-types a player takes the anchor', () => {
    // A re-typed cast may be deliberately dropping the extra person, so the
    // blank row after it inherits from IT (which has no Others?) and nothing
    // is reported — the conservative rule the module header promises.
    const rows = [raw({ ts: '1/1/2024 10:00:00', p1: 'Alice', p2: 'Bob', p3: 'Carol',
        others: 'Dan Fox (p)' }),
        raw({ ts: '1/1/2024 11:00:00', p1: 'Alice' }),
        raw({ ts: '1/1/2024 12:00:00' })];
    assert.equal(droppedOthers(buildViews(rows, NO_TABLES), ...NO_CATALOG).length, 0);
});

test('an uncatalogued work is always reported', () => {
    // Suppress only on positive evidence; an unknown work is not evidence.
    assert.equal(needsTheExtraPlayer(row({ composer: 'Haydn', title: 'Unlisted' }),
        'Alice (va2)', new Set(), new Set([workKey('Haydn', '76#1')])), true);
});

// ------------------------------------------------- the injection guarantee --

test('an audit invoked through a symlinked path still runs', () => {
    // Node's ESM loader realpaths import.meta.url, but resolve() does not
    // resolve symlinks. Compared without realpath the two never match, and
    // runAudit returns having done nothing — at exit 0, so audit_all.sh's
    // `set -euo pipefail` cannot see it and a SUMMARY of blank counts reads
    // as "nothing to fix". This is the ordinary case on macOS
    // (/tmp -> /private/tmp) and for any checkout under a symlinked directory.
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'ql-audit-'));
    try {
        const csv = join(dir, 'rows.csv');
        writeFileSync(csv, `${HEADERS.join(',')}\n`
            + '1/1/2024 10:00:00,Haydn,76#1,V1,Alice,Bob,Carol,,Home,\n');
        const link = join(dir, 'repo');
        symlinkSync(repo, link);
        const out = execFileSync('node',
            [join(link, 'scripts', 'audit_fillforward.mjs'), csv],
            { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
        assert.match(out, /^Rows: 1/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('no audit module reaches the real alias file at import time', () => {
    // src/aliases.js is gitignored and machine-specific. An audit module that
    // imported it (directly, or via src/config.js) would make every test that
    // imports the module depend on which machine it runs on — the failure this
    // repo has already had twice. scripts/lib/cli.mjs is the one reader, and it
    // imports dynamically, inside a function only a command-line run calls.
    for (const file of ['scripts/audit_aliases.mjs', 'scripts/audit_ensembles.mjs',
        'scripts/audit_fillforward.mjs', 'scripts/attribution.mjs',
        'scripts/lib/people.mjs', 'scripts/lib/views.mjs']) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /^import .*(config|aliases)\.js/m,
            `${file} must take its name tables as an argument`);
    }
});

test('every table-dependent entry point warns when the tables are the stub', () => {
    // With the stub, alias-aware counts inflate and the session-window
    // section can call a real shorthand entry "unconstrained" — artefacts of
    // the missing file, not findings about the sheet. warnIfStub is the flag
    // for that, and it can only fire from the entry point, which reads the
    // real tables; a behavioural test would depend on which machine it runs
    // on, so pin the wiring in the source instead. audit_ensembles is exempt:
    // an unexpanded letter still occupies a seat, so its counts do not move
    // with the tables.
    for (const file of ['scripts/audit_aliases.mjs', 'scripts/audit_fillforward.mjs',
        'scripts/attribution.mjs']) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        assert.match(source, /warnIfStub\(tables\)/,
            `${file}'s entry point must call warnIfStub`);
    }
});
