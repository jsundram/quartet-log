// Unit tests for scripts/attribution.mjs.
//
// Each case below is a rule from #27, and each rule exists because its absence
// produced a specific wrong finding on the real log. They are worth reading as
// documentation of why the heuristic is shaped the way it is; several took a
// review round each to find.
//
// Fixtures go through the real buildViews, so fillForward runs on them exactly
// as it runs on the sheet. That is deliberate — the written/filled split is
// the thing most of these rules turn on — and it is why `seatless` marks an
// unused seat "-" rather than leaving it blank: a blank is a ditto mark and
// would inherit the row above, which is not what these fixtures mean.
//
// The name tables are injected, never imported: src/aliases.js is gitignored
// and machine-specific, so a test that read it would pass here and mean
// something else in CI. See the header of test/audits.test.mjs.
//
// Placeholder names come from a published list (Alice/Bob/Carol, then Atlantic
// hurricane names) and are not screened against the log — see CLAUDE.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildViews } from '../scripts/lib/views.mjs';
import {
    attribute, MIN_WRITTEN_IN_FULL, runAttribution,
} from '../scripts/attribution.mjs';

const HEADERS = ['Timestamp', 'Composer', 'Work Title', 'Which Part',
    'Player 1', 'Player 2', 'Player 3', 'Others?', 'Location', 'Comments'];

function raw({
    ts = '1/1/2024 10:00:00', composer = 'Haydn', title = '76#1', part = 'V1',
    p1 = '', p2 = '', p3 = '', others = '', location = 'Home', comments = '',
} = {}) {
    return Object.fromEntries(HEADERS.map((h, i) => [h,
        [ts, composer, title, part, p1, p2, p3, others, location, comments][i]]));
}

/**
 * A row whose unnamed seats are "-" — the sheet's own "nobody in this seat",
 * which fillForward leaves alone and rowPeople does not count as a person.
 */
const seatless = fields => raw({ p1: '-', p2: '-', p3: '-', ...fields });

/** `n` rows naming `name` alongside `mate`, so its circle counts as evidence. */
const attested = (name, mate, { n = MIN_WRITTEN_IN_FULL, month = 1 } = {}) =>
    Array.from({ length: n }, (_, i) => seatless({
        ts: `${month}/${i + 1}/2024 10:00:00`, p1: name, p2: mate, p3: 'Carol',
    }));

const NO_TABLES = { aliases: {}, abbreviations: {} };
const tablesFor = aliases => ({ aliases, abbreviations: {} });

/** Run attribution over `rows`; `patchFilled` edits the filled view in place. */
function run(rows, aliases = {}, patchFilled) {
    const views = buildViews(rows, NO_TABLES);
    if (patchFilled) patchFilled(views.filled);
    return attribute(views, tablesFor(aliases));
}

/** The two same-first-name candidates most cases here contend between. */
const twoAlices = () => [
    ...attested('Alice Hart', 'Beryl', { month: 1 }),
    ...attested('Alice Bek', 'Chantal', { month: 2 }),
];

const SUBJECT_TS = '6/1/2024 10:00:00';

// ------------------------------------------------------------- the shape --

test('attribution returns one list of findings, each carrying its action', () => {
    // Not parallel lists per bucket: that produced arity and annotation
    // mismatches twice in the retired spike.
    const result = run([...twoAlices(),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })]);
    assert.deepEqual(Object.keys(result).sort(),
        ['findings', 'resolvedBySheet', 'settled', 'unverified']);
    assert.ok(result.findings.every(f =>
        f.action === 'edit-this-cell' || f.action === 'answer-this-now'));
});

// ----------------------------------------------------------- the outcomes --

test('the row agreeing with the alias is not a finding', () => {
    const { findings, settled, unverified } = run(
        [...twoAlices(), seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })],
        { Alice: { upper: 'Alice Hart' } });
    assert.deepEqual(findings, []);
    assert.equal(settled, 1);
    assert.equal(unverified, 0);
});

test('the row contradicting the alias is an edit', () => {
    const { findings } = run(
        [...twoAlices(), seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Chantal', p3: 'Carol' })],
        { Alice: { upper: 'Alice Hart' } });
    assert.equal(findings.length, 1);
    const [f] = findings;
    assert.equal(f.action, 'edit-this-cell');
    assert.deepEqual([f.name, f.cls, f.alias, f.winner],
        ['Alice', 'upper', 'Alice Hart', 'Alice Bek']);
    assert.ok(f.why.includes('Chantal'));
    assert.deepEqual(f.unruled, []);
});

test('the row resolving a name no alias covers is also an edit', () => {
    // The app counts the bare form as a separate person in every people
    // statistic, so this is real work — and folding it into the reassurance
    // line would hide the largest actionable, non-decaying group there is.
    const { findings, settled } = run(
        [...twoAlices(), seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })]);
    assert.equal(settled, 0);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, 'edit-this-cell');
    assert.equal(findings[0].alias, null);
    assert.equal(findings[0].winner, 'Alice Hart');
});

test('no evidence and no alias is the only thing that needs memory', () => {
    const { findings } = run([...twoAlices(),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Dexter', p3: 'Ernesto' })]);
    assert.equal(findings.length, 1);
    const [f] = findings;
    assert.equal(f.action, 'answer-this-now');
    assert.deepEqual([f.name, f.cls], ['Alice', 'upper']);
    assert.deepEqual(f.candidates, ['Alice Bek', 'Alice Hart']);
});

test('no evidence but an alias standing is counted, not reported', () => {
    // Presenting hundreds of these as work is as misleading as reporting none:
    // the alias is the best available answer and this run has nothing to
    // second-guess it with.
    const { findings, unverified } = run(
        [...twoAlices(), seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Dexter', p3: 'Ernesto' })],
        { Alice: { upper: 'Alice Hart' } });
    assert.deepEqual(findings, []);
    assert.equal(unverified, 1);
});

test('a tie settles nothing', () => {
    const rows = [...attested('Alice Hart', 'Beryl', { month: 1 }),
        ...attested('Alice Bek', 'Beryl', { month: 2 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })];
    const { findings } = run(rows);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, 'answer-this-now');
});

test("the alias's own target competes for its own row", () => {
    // The table exists for people logged by first name only, nicknames
    // included, so its target may share no first token with the key. Scoring
    // only the first-token set left that person out of their own row:
    // `alias === winner` was unreachable, so a correctly aliased row could
    // never settle and landed in the bucket telling the reader to edit a cell.
    const rows = [...attested('Nick Adams', 'Dexter', { month: 1 }),
        ...attested('Nick Bailey', 'Chantal', { month: 2 }),
        ...attested('Nicholas Hart', 'Dexter', { month: 3 }),
        seatless({ ts: SUBJECT_TS, p1: 'Nick', p2: 'Dexter', p3: 'Gaston' })];
    // Nicholas Hart is the only candidate who has played with Gaston.
    rows.push(seatless({ ts: '3/6/2024 10:00:00', p1: 'Nicholas Hart', p2: 'Gaston', p3: 'Carol' }));
    const { findings, settled } = run(rows, { Nick: { upper: 'Nicholas Hart' } });
    assert.deepEqual(findings, []);
    assert.equal(settled, 1);
});

test('a cello-slot bare name never draws the upper-class namesake', () => {
    // Candidates are keyed by instrument class, as PLAYER_ALIASES is.
    // Otherwise the upper Jo's larger circle wins and the report calls the
    // correct class-keyed alias wrong.
    const rows = [
        ...Array.from({ length: 5 }, (_, i) => seatless({
            ts: `1/${i + 1}/2024 10:00:00`, p1: 'Jo Alpha', p2: 'Beryl', p3: 'Carol Jones' })),
        ...Array.from({ length: 5 }, (_, i) => seatless({
            ts: `2/${i + 1}/2024 10:00:00`, p1: 'Dexter', p2: 'Ernesto', p3: 'Jo Beta' })),
        ...Array.from({ length: 5 }, (_, i) => seatless({
            ts: `3/${i + 1}/2024 10:00:00`, p1: 'Gaston', p2: 'Hanna', p3: 'Jo Gamma' })),
        // The subject's stand-mates are Jo Alpha's circle, plus one of Jo
        // Beta's. Class-keyed, Jo Beta wins on that one and agrees with the
        // table; class-blind, Jo Alpha wins on two and contradicts it.
        seatless({ ts: SUBJECT_TS, p1: 'Beryl', p2: 'Carol Jones', p3: 'Jo', others: 'Dexter' }),
    ];
    const { findings, settled } = run(rows, { Jo: { cello: 'Jo Beta' } });
    assert.deepEqual(findings, []);
    assert.equal(settled, 1);
});

// -------------------------------------------------------------- the gates --

test('a thinly written winner is not trusted', () => {
    // A circle is only evidence if we have one. Below the threshold a positive
    // match is as likely to be an accident of who happens to have been named.
    const rows = [...attested('Alice Hart', 'Beryl', { n: 1, month: 1 }),
        ...attested('Alice Bek', 'Chantal', { month: 2 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })];
    const { findings } = run(rows);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, 'answer-this-now');
});

test('a thinly written alias target is not contradicted', () => {
    // The people most often logged bare are the ones whose full name is
    // rarest. Their FAILURE to match means "never seen named", not "not them",
    // and is no basis for telling anyone to edit the sheet.
    const rows = [...attested('Alice Hart', 'Beryl', { n: 1, month: 1 }),
        ...attested('Alice Bek', 'Chantal', { month: 2 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Chantal', p3: 'Carol' })];
    const { findings, unverified } = run(rows, { Alice: { upper: 'Alice Hart' } });
    assert.deepEqual(findings, []);
    assert.equal(unverified, 1);
});

test('the alias gate is separate from the rival gate', () => {
    // With two candidates a thin alias target IS the only rival, so the rival
    // gate happens to cover it. Add a third, attested candidate and the rival
    // gate passes — leaving the alias's own attestation as the only thing
    // between a thinly-named person and being told they are wrong.
    const rows = [
        ...attested('Alice Hart', 'Beryl', { n: 1, month: 1 }),   // alias target, barely named
        ...attested('Alice Bek', 'Chantal', { month: 2 }),        // the winner
        ...attested('Alice Chan', 'Dexter', { month: 3 }),        // attested, does not match
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Chantal', p3: 'Carol' })];
    const { findings, unverified } = run(rows, { Alice: { upper: 'Alice Hart' } });
    assert.deepEqual(findings, []);
    assert.equal(unverified, 1);
});

test('a verdict needs at least one rival the sheet has named', () => {
    // With every rival unattested there is nothing to rule out. This is the
    // case most likely to cause a bad edit, because the bucket it would land
    // in tells you to write a name into the cell.
    const rows = [...attested('Alice Hart', 'Beryl', { month: 1 }),
        ...attested('Alice Bek', 'Chantal', { n: 1, month: 2 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })];
    const { findings } = run(rows);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, 'answer-this-now');
});

test('rivals that cannot be ruled out are disclosed, not discarded', () => {
    // Partial knowledge yields a finding that says what it does not know.
    const rows = [...twoAlices(),
        ...attested('Alice Chan', 'Dexter', { n: 4, month: 3 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })];
    const { findings } = run(rows);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].winner, 'Alice Hart');
    assert.deepEqual(findings[0].unruled, ['Alice Chan']);
});

// ------------------------------------------------------------ the evidence --

test('evidence comes from the filled row', () => {
    // A continuation row's cast is only stated above it. Without the filled
    // view an Others? entry on such a row has no stand-mates to read and falls
    // into the bucket labelled "needs memory", while the row above names
    // everyone who was there — the exact failure this feature exists to
    // remove.
    const rows = [...twoAlices(),
        seatless({ ts: SUBJECT_TS, p1: 'Alice Hart', p2: 'Beryl', p3: 'Carol' }),
        // A continuation row: blank seats, so fill-forward states the group.
        raw({ ts: '6/1/2024 11:00:00', others: 'Alice (v2)' })];
    const views = buildViews(rows, NO_TABLES);
    assert.equal(views.filled.at(-1).player1, 'Alice Hart');

    const { findings } = attribute(views, NO_TABLES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, 'edit-this-cell');
    assert.equal(findings[0].winner, 'Alice Hart');
    // ...and the finding names the CONTINUATION row, the cell that holds the
    // bare name, not the row above that supplied the evidence.
    assert.equal(findings[0].row.others, 'Alice (v2)');

    // Read the room off the written view instead and there is nothing to go on.
    const blind = attribute({ written: views.written, filled: views.written }, NO_TABLES);
    assert.equal(blind.findings[0].action, 'answer-this-now');
});

test('a candidate established on a continuation row still has a circle', () => {
    // The raw sheet's own convention — state the quartet on the first row of a
    // session, name the extra player in Others? on the next — so a candidate
    // established that way must not arrive with an empty circle.
    const rows = [];
    for (let i = 1; i <= 6; i++) {
        rows.push(seatless({ ts: `${i}/1/2024 10:00:00`,
            p1: 'Bob Smith', p2: 'Carol Jones', p3: 'Dan Ray' }));
        rows.push(raw({ ts: `${i}/1/2024 11:00:00`, others: 'Zoe Hart' }));
    }
    for (let i = 1; i <= 5; i++) {
        rows.push(seatless({ ts: `${i}/15/2024 10:00:00`,
            p1: 'Zoe Bek', p2: 'Erin Vale', p3: 'Fay Nunn' }));
    }
    rows.push(seatless({ ts: '12/1/2024 10:00:00',
        p1: 'Zoe', p2: 'Bob Smith', p3: 'Carol Jones' }));
    const { findings } = run(rows);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, 'edit-this-cell');
    assert.equal(findings[0].winner, 'Zoe Hart');
});

test('one typing does not clear the threshold once per continuation row', () => {
    // Circles come from the filled view and attestation counts from the
    // written one, and this is where those two part company. A name typed once
    // at the head of a six-piece session appears in six FILLED rows; counted
    // there it would clear MIN_WRITTEN_IN_FULL five times over on a single
    // typing, and the threshold protects exactly the population — people
    // almost always logged bare — that this would wave through.
    const rows = [seatless({ ts: '1/1/2024 10:00:00',
        p1: 'Alice Hart', p2: 'Beryl', p3: 'Carol' })];
    for (let i = 1; i <= 5; i++) {
        rows.push(raw({ ts: `1/1/2024 ${10 + i}:00:00`, title: `76#${i + 1}` }));
    }
    rows.push(...attested('Alice Bek', 'Chantal', { month: 2 }));
    rows.push(seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' }));

    const views = buildViews(rows, NO_TABLES);
    // The circle IS built from all six rows — that half is the point of the
    // filled view — so Alice Hart out-matches Alice Bek two mates to one.
    assert.equal(views.filled[3].player1, 'Alice Hart');

    // ...and it still does not settle, because the name was typed once.
    const { findings } = attribute(views, NO_TABLES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, 'answer-this-now');
});

test('the subject is never its own evidence', () => {
    // The same person can occupy two cells, and one of them is the subject.
    // Without the name test the bare subject scores for whichever candidate
    // has played with someone written bare the same way — and the report
    // prints the subject itself as the reason.
    const rows = [...attested('Alice Hart', 'Beryl', { month: 1 }),
        // Alice Bek has played with someone written bare as "Alice".
        ...Array.from({ length: 5 }, (_, i) => seatless({
            ts: `2/${i + 1}/2024 10:00:00`, p1: 'Alice Bek', p2: 'Alice', p3: 'Fernand' })),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Gaston', others: 'Alice (v2)' })];
    const { findings } = run(rows);
    // No finding may cite the subject's own name as the reason for itself.
    // That covers the bare "Alice" cells in Alice Bek's own rows too, which
    // are subjects in their own right and settle on Fernand.
    assert.ok(findings.every(f => !f.why.includes('Alice')));
    // The two cells of the last row hold each other's only "evidence", so with
    // that removed nothing settles them.
    const here = findings.filter(f =>
        Number(f.row.timestamp) === Number(new Date(SUBJECT_TS)));
    assert.equal(here.length, 2);
    assert.ok(here.every(f => f.action === 'answer-this-now'));
});

test("the subject's own seat is excluded positionally", () => {
    // Evidence is the filled row; the subject is the row as written. Whatever
    // sits in the subject's own cell in the filled view is not a stand-mate,
    // and a name comparison cannot say so once that cell differs from what was
    // written. Left in, it scores for whichever RIVAL has played with it. The
    // pair is patched by hand because in the app this path is also caught by
    // the sheet-resolved skip below; the exclusion has to be right on its own.
    const rows = [...twoAlices(),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })];
    const { findings } = run(rows, {}, filled => {
        // In Alice Bek's circle, not Alice Hart's.
        filled.at(-1).player1 = 'Chantal';
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].winner, 'Alice Hart');
    assert.ok(!findings[0].why.includes('Chantal'));
});

test('a cell the sheet resolved itself is not reported', () => {
    // fillForward runs BEFORE normalizePlayerNames, so no alias ever sees that
    // cell. There is no hazard to report, whatever the table would have said.
    const rows = [...twoAlices(),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Chantal', p3: 'Carol' })];
    const { findings, settled, resolvedBySheet } = run(
        rows, { Alice: { upper: 'Alice Hart' } },
        filled => { filled.at(-1).player1 = 'Alice Hart'; });
    assert.deepEqual(findings, []);
    // Counted apart from `settled`: no table was consulted, so folding them
    // together would credit src/aliases.js with work fill-forward did.
    assert.equal(settled, 0);
    assert.equal(resolvedBySheet, 1);
});

test('one person in two cells does not vote twice', () => {
    // The score means "how many of this candidate's circle were here". Someone
    // written in a slot AND in Others? would otherwise count twice, and two
    // distinct mates for one candidate could tie with one duplicated mate for
    // another — dumping a settleable entry into "answer this now".
    const rows = [
        // Hart has TWO distinct mates in the subject row; Bek has one, written
        // twice. Deduped that is 2-1 for Hart; counted raw it is 2-2, a tie.
        ...Array.from({ length: 5 }, (_, i) => seatless({
            ts: `1/${i + 1}/2024 10:00:00`, p1: 'Alice Hart', p2: 'Beryl', p3: 'Dexter' })),
        ...Array.from({ length: 5 }, (_, i) => seatless({
            ts: `2/${i + 1}/2024 10:00:00`, p1: 'Alice Bek', p2: 'Chantal', p3: 'Fernand' })),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Chantal',
            others: 'Chantal (v2); Dexter (va)' })];
    const { findings } = run(rows);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, 'edit-this-cell');
    assert.equal(findings[0].winner, 'Alice Hart');
});

test('an Others? entry naming no instrument is still a subject', () => {
    // The app counts that bare form as its own person, so it belongs in a
    // finding. No alias can reach it either — canonicalize with a null class
    // is a no-op — so every namesake is in play and only the cell can be fixed.
    const rows = [...twoAlices(),
        seatless({ ts: SUBJECT_TS, p1: 'Beryl', others: 'Alice' })];
    const { findings } = run(rows);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].name, 'Alice');
    assert.equal(findings[0].alias, null);
});

test('an Others? entry naming no instrument is still evidence', () => {
    // A name with no instrument still says who was in the room. Dropping it
    // produced a false "needs memory" on rows its presence settles.
    const rows = [...twoAlices(),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', others: 'Beryl' })];
    const { findings } = run(rows);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, 'edit-this-cell');
    assert.equal(findings[0].winner, 'Alice Hart');
});

test('a gate failure keeps the evidence it measured', () => {
    // Two ways into answer-this-now, and they know different amounts. A gate
    // failure has a clear leading candidate and knows which rivals it could
    // not rule out; discarding those told the reader "no teammate matches"
    // when a teammate had matched, and hid the one fact that would let them
    // answer it from memory months later.
    const rows = [...attested('Alice Hart', 'Beryl', { month: 1 }),
        ...attested('Alice Bek', 'Chantal', { n: 1, month: 2 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })];
    const { findings } = run(rows);
    assert.equal(findings.length, 1);
    const [f] = findings;
    assert.equal(f.action, 'answer-this-now');
    assert.equal(f.winner, 'Alice Hart');
    assert.deepEqual(f.why, ['Beryl', 'Carol']);
    assert.deepEqual(f.unruled, ['Alice Bek']);
});

test('a tie carries no evidence, because it measured nothing that separates', () => {
    const rows = [...attested('Alice Hart', 'Beryl', { month: 1 }),
        ...attested('Alice Bek', 'Beryl', { month: 2 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })];
    const { findings } = run(rows);
    assert.equal(findings[0].action, 'answer-this-now');
    assert.equal(findings[0].winner, null);
    assert.deepEqual([findings[0].why, findings[0].unruled], [[], []]);
});

// --------------------------------------------------------------- the report --

const report = (rows, aliases = {}) =>
    runAttribution(buildViews(rows, NO_TABLES), tablesFor(aliases)).join('\n');

test('unruled rivals are labelled by what was measured', () => {
    // The gate is `written < MIN_WRITTEN_IN_FULL`, so a rival named four times
    // in full is not "never written out" — and these are the lines whose whole
    // job is "confirm before editing".
    const out = report([...twoAlices(),
        ...attested('Alice Chan', 'Dexter', { n: 4, month: 3 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })]);
    assert.doesNotMatch(out, /never written out/);
    assert.match(out, new RegExp(`fewer than ${MIN_WRITTEN_IN_FULL} times`));
});

test('the report prints what a gate failure measured, and says so when nothing did', () => {
    const gated = report([...attested('Alice Hart', 'Beryl', { month: 1 }),
        ...attested('Alice Bek', 'Chantal', { n: 1, month: 2 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })]);
    assert.doesNotMatch(gated, /no candidate's teammates single one out/);
    assert.match(gated, /leading candidate 'Alice Hart' {2}\(played with Beryl, Carol\)/);
    assert.match(gated, /could not rule out: Alice Bek/);
    // Here the winner is attested — the failing gate is the rival one, which
    // the line above names — so the winner's-own-attestation line stays out.
    assert.doesNotMatch(gated, /is written out only/);

    const tied = report([...attested('Alice Hart', 'Beryl', { month: 1 }),
        ...attested('Alice Bek', 'Beryl', { month: 2 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })]);
    assert.match(tied, /no candidate's teammates single one out/);
    assert.doesNotMatch(tied, /leading candidate/);
});

test("the report names the failing gate when it is the winner's own attestation", () => {
    // The section header promises "the line below says which" gate declined
    // to act, but the unruled line names RIVALS only. When the leader is the
    // thinly-written one and every rival is attested, unruled is empty — a
    // clear leader with matching evidence printed with no reason at all.
    const out = report([...attested('Alice Hart', 'Beryl', { n: 1, month: 1 }),
        ...attested('Alice Bek', 'Chantal', { month: 2 }),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })]);
    assert.match(out, /leading candidate 'Alice Hart'/);
    assert.doesNotMatch(out, /could not rule out/);
    assert.match(out,
        /but 'Alice Hart' is written out only 1 time \(fewer than 5\) — too thin to act on/);
});

test('an unclassified subject prints as the pseudo-class, not as null', () => {
    const out = report([...twoAlices(),
        seatless({ ts: SUBJECT_TS, p1: 'Beryl', others: 'Alice' })]);
    assert.doesNotMatch(out, /\[null\]/);
    assert.match(out, /'Alice' \[any\]/);
});

test('the report counts what it did not report', () => {
    // One reassurance line, not buckets with semantics to explain — that is
    // where six of the retired spike's findings came from. But it has to be
    // there: silence should read as a result, not as a run that did nothing.
    const out = report([...twoAlices(),
        seatless({ ts: SUBJECT_TS, p1: 'Alice', p2: 'Beryl', p3: 'Carol' })],
    { Alice: { upper: 'Alice Hart' } });
    assert.match(out, /-- edit this cell \(0\) --/);
    assert.match(out, /-- answer this now \(0\) --/);
    assert.match(out, /\(1 more agree with the table and 0 have an alias standing/);
});
