// The log form's model. Everything here is what the form knows that the
// Google Form it replaces cannot: what a blank cell will become, which column
// refuses to repeat itself, and who the log has already met.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    blankEntry, carriedForward, resolveCarry, othersReminder, missingFields,
    warnings, knownPlayers, knownLocations, nextInSession, frequentComposers, LABELS,
    impliedSlotParts, slotCell, slotPartKey, defaultSlotParts,
    parseOthersRows, serializeOthersRows, splitOthersCell, mergeOthersCell,
    sessionRows, sessionPeople,
} from '../src/logEntry.js';

// A processed row, as normalizePlayerNames leaves it: annotations split off
// into playerInstruments, Others? parsed into othersList.
function row(over = {}) {
    return {
        timestamp: new Date('2026-01-01T12:00:00'),
        composer: 'Haydn', work: { title: '76#3' }, part: 'V1',
        player1: 'Alice Hart', player2: 'Bob Bek', player3: 'Carol Diaz',
        others: '', location: 'Home', comments: '',
        playerInstruments: [null, null, null], othersList: [],
        ...over,
    };
}

test('blankEntry has every sheet column and nothing else', () => {
    const e = blankEntry();
    assert.deepEqual(Object.keys(e).sort(), [
        'comments', 'composer', 'location', 'others',
        'part', 'player1', 'player2', 'player3', 'title',
    ]);
    assert.ok(Object.values(e).every(v => v === ''));
});

test('carriedForward re-attaches the instrument annotation the pipeline split off', () => {
    const carried = carriedForward(row({
        player3: 'Dana Ellis', playerInstruments: [null, null, 'p'],
    }));
    // The placeholder has to show the cell as the logger typed it, since that
    // is what a blank will repeat.
    assert.equal(carried.player3, 'Dana Ellis (p)');
    assert.equal(carried.player1, 'Alice Hart');
    assert.equal(carried.location, 'Home');
});

test('carriedForward on no previous row is blank, not undefined', () => {
    assert.deepEqual(carriedForward(null), blankEntry());
});

test('resolveCarry fills blanks from the carried row and keeps what was typed', () => {
    const entry = blankEntry({ composer: 'Haydn', title: '20#4', part: 'V2', player2: 'Erin Fry' });
    const resolved = resolveCarry(entry, carriedForward(row()));
    assert.equal(resolved.player1, 'Alice Hart');   // blank: dittos
    assert.equal(resolved.player2, 'Erin Fry');     // written: replaces
    assert.equal(resolved.player3, 'Carol Diaz');
    assert.equal(resolved.location, 'Home');
    assert.equal(resolved.title, '20#4');
});

test('resolveCarry leaves an explicitly empty seat empty', () => {
    // "-" is a seat the work does not have (howto section 5). It is a written
    // value, so it must survive rather than be dittoed over.
    const resolved = resolveCarry(blankEntry({ player2: '-' }), carriedForward(row()));
    assert.equal(resolved.player2, '-');
});

test('othersReminder offers the previous row Others?, which never carries itself', () => {
    const last = row({ others: 'Dana Ellis (p)' });
    assert.equal(othersReminder(blankEntry(), last), 'Dana Ellis (p)');
    // Already typed something: no offer.
    assert.equal(othersReminder(blankEntry({ others: 'Someone else' }), last), null);
    // Nothing to repeat.
    assert.equal(othersReminder(blankEntry(), row()), null);
    // "-" is "nobody", not a person to re-offer.
    assert.equal(othersReminder(blankEntry(), row({ others: '-' })), null);
});

test('missingFields mirrors the form required questions, since a rejection is invisible', () => {
    // Field keys, not labels: the caller needs the field to mark and focus as
    // well as a name to print, and deriving the keys twice is how they drift.
    assert.deepEqual(missingFields(blankEntry()), ['composer', 'title', 'part']);
    assert.deepEqual(missingFields(blankEntry()).map(f => LABELS[f]),
        ['Composer', 'Work Title', 'Which Part']);
    assert.deepEqual(missingFields(blankEntry({ composer: 'Haydn', title: '76#3', part: 'V1' })), []);
    // Whitespace is not a value.
    assert.deepEqual(missingFields(blankEntry({ composer: ' ', title: '76#3', part: 'V1' })), ['composer']);
    // Blank players are legal — they are ditto marks, not omissions.
    assert.deepEqual(missingFields(blankEntry({ composer: 'Haydn', title: '76#3', part: 'V1', player1: '' })), []);
});

test('warnings flags a partial movement, which the sheet keeps and the app hides', () => {
    assert.equal(warnings(blankEntry({ title: '76#3:I' })).length, 1);
    assert.deepEqual(warnings(blankEntry({ title: '76#3' })), []);
});

test('knownPlayers ranks by how often someone appears, seats and Others? alike', () => {
    const rows = [
        row(),
        row({ player1: 'Alice Hart', player2: 'Erin Fry', othersList: [{ name: 'Dana Ellis' }] }),
        row({ player1: 'Alice Hart', player2: '-', player3: '' }),
    ];
    const names = knownPlayers(rows);
    assert.equal(names[0], 'Alice Hart');           // three appearances
    assert.ok(names.includes('Dana Ellis'));         // Others? counts
    assert.ok(!names.includes('-'));                 // an empty seat is not a person
    // Carol is in two rows, so she outranks the three singletons, which then
    // tie-break alphabetically — the list is stable across refreshes.
    assert.deepEqual(names.slice(1), ['Carol Diaz', 'Bob Bek', 'Dana Ellis', 'Erin Fry']);
});

test('knownLocations ranks the same way', () => {
    assert.deepEqual(
        knownLocations([row(), row({ location: 'Studio' }), row()]),
        ['Home', 'Studio']);
});

test('nextInSession keeps what describes the session and clears what describes the piece', () => {
    const next = nextInSession(blankEntry({
        composer: 'Haydn', part: 'V1', title: '76#3',
        player1: 'Alice Hart', others: 'Dana Ellis (p)', location: 'Home', comments: 'lovely',
    }));
    assert.equal(next.composer, 'Haydn');
    assert.equal(next.part, 'V1');
    assert.equal(next.title, '');
    assert.equal(next.comments, '');
    // Seats and location clear because blank means "same" — the shortest path
    // to the next row is also the honest one.
    assert.equal(next.player1, '');
    assert.equal(next.location, '');
    // Others? clears too, and othersReminder is what offers it back.
    assert.equal(next.others, '');
});

test('frequentComposers ranks by how often you play them, not by the catalog', () => {
    // The chip row is the one-tap path, so it has to hold the composers this
    // log actually plays. Ranking by the catalog would put a never-played
    // composer on a tap target ahead of a weekly one.
    const rows = [
        row({ composer: 'Haydn' }), row({ composer: 'Haydn' }), row({ composer: 'Haydn' }),
        row({ composer: 'Mozart' }), row({ composer: 'Mozart' }),
        row({ composer: 'Ligeti' }),
    ];
    assert.deepEqual(frequentComposers(rows), ['Haydn', 'Mozart', 'Ligeti']);
    // A composer entered through "Other" earns a chip like any other once it
    // has been played -- the catalog has never heard of Ligeti.
    assert.ok(frequentComposers(rows).includes('Ligeti'));
});

test('frequentComposers caps the row and is empty before there is any data', () => {
    const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].flatMap((c, i) =>
        Array.from({ length: 7 - i }, () => row({ composer: c })));
    assert.deepEqual(frequentComposers(rows), ['A', 'B', 'C', 'D', 'E', 'F']);
    assert.deepEqual(frequentComposers(rows, 2), ['A', 'B']);
    // First launch: no chips, and the picker behind "More" is the whole UI.
    assert.deepEqual(frequentComposers([]), []);
});

// --- Slot parts -------------------------------------------------------------
// The point of the feature: saying who played what without retyping anyone.

test('impliedSlotParts reads the same seat table the app does, VA1 folded', () => {
    assert.deepEqual(impliedSlotParts('VA'), ['V1', 'V2', 'VC']);
    // processRow folds VA1 to VA before anything downstream sees a row, so the
    // form must fold it too or every viola row's seats come out null.
    assert.deepEqual(impliedSlotParts('VA1'), ['V1', 'V2', 'VC']);
    assert.deepEqual(impliedSlotParts('V1'), ['V2', 'VA', 'VC']);
    assert.deepEqual(impliedSlotParts(''), [null, null, null]);
});

test('changing a part on a blank seat materialises the carried name', () => {
    // This is the whole workflow: two violinists swap, and instead of retyping
    // both names into different columns you change one dropdown.
    assert.equal(
        slotCell({ typed: '', carried: 'Alice Hart', chosen: 'V2', implied: 'V1' }),
        'Alice Hart (v2)');
});

test('a slot that would repeat the row above stays blank', () => {
    // The sheet has always been written with blanks dittoing; annotating every
    // cell would churn 1900 rows worth of convention for nothing.
    assert.equal(slotCell({ typed: '', carried: 'Alice Hart', chosen: 'V1', implied: 'V1' }), '');
    assert.equal(slotCell({ typed: '', carried: 'Alice Hart (v2)', chosen: 'V2', implied: 'V1' }), '');
    assert.equal(slotCell({ typed: 'Alice Hart', carried: 'Alice Hart', chosen: 'V1', implied: 'V1' }), '');
});

test('going back to the implied part writes the bare name, clearing the annotation', () => {
    // A blank would ditto "(v2)" forward, so the only way to say "back to V1"
    // is to write the name without it.
    assert.equal(
        slotCell({ typed: '', carried: 'Alice Hart (v2)', chosen: 'V1', implied: 'V1' }),
        'Alice Hart');
});

test('a typed name takes the chosen part, and an empty seat stays empty', () => {
    assert.equal(
        slotCell({ typed: 'Erin Fry', carried: 'Alice Hart', chosen: 'VA2', implied: 'V2' }),
        'Erin Fry (va2)');
    // "-" is "this work has no such seat" (howto section 5), not a person.
    assert.equal(slotCell({ typed: '-', carried: 'Alice Hart', chosen: 'VC2', implied: 'VC' }), '-');
    // Nothing carried and nothing typed: still nothing.
    assert.equal(slotCell({ typed: '', carried: '', chosen: 'V1', implied: 'V1' }), '');
});

test('an annotation the options cannot express passes through unrewritten', () => {
    // The sheet carries instruments this list does not offer. Re-serialising
    // one into the nearest option would silently rewrite the record.
    assert.equal(slotPartKey('cl'), null);
    assert.equal(
        slotCell({ typed: '', carried: 'Erin Fry (cl)', chosen: 'cl', implied: 'V2' }),
        '');
    assert.equal(
        slotCell({ typed: 'Erin Fry', carried: '', chosen: 'cl', implied: 'V2' }),
        'Erin Fry (cl)');
});

test('slotPartKey folds the codes the app folds, and keeps the ones it does not', () => {
    // partFromInstrument buckets va1/va2 into VA and vc1/vc2 into VC, so the
    // charts group them -- but the SHEET keeps the distinction, which is the
    // reason to offer the numbered forms at all.
    assert.equal(slotPartKey('va'), 'VA');
    assert.equal(slotPartKey('vla'), 'VA');
    assert.equal(slotPartKey('va2'), 'VA2');
    assert.equal(slotPartKey('vc'), 'VC');
    assert.equal(slotPartKey('cello'), 'VC');
    assert.equal(slotPartKey('vc2'), 'VC2');
    assert.equal(slotPartKey('v1'), 'V1');
    assert.equal(slotPartKey('piano'), 'P');
    assert.equal(slotPartKey(''), null);
});

test('defaultSlotParts keeps a role across a session, like a name', () => {
    // A violinist moved to V2 last piece is still on V2 for the next one,
    // exactly as their name carries forward -- otherwise the dropdown would
    // have to be re-set on every row of a session.
    const carried = carriedForward(row({
        player1: 'Alice Hart', player2: 'Bob Bek', player3: 'Carol Diaz',
        playerInstruments: ['v2', null, null],
    }));
    assert.deepEqual(defaultSlotParts(carried, 'VA'), ['V2', 'V2', 'VC']);
    // With nothing annotated, the seats mean what the layout says.
    assert.deepEqual(defaultSlotParts(carriedForward(row()), 'VA'), ['V1', 'V2', 'VC']);
    // An unrepresentable annotation comes back as itself, not as a guess.
    const odd = carriedForward(row({ playerInstruments: [null, 'cl', null] }));
    assert.deepEqual(defaultSlotParts(odd, 'VA'), ['V1', 'cl', 'VC']);
});

// --- Others? rows -----------------------------------------------------------

test('Others? rows round-trip losslessly, comment and all', () => {
    // dataProcessor.parseOthers throws the comment away -- it only wants the
    // instrument -- so an editor built on it would delete "(vc, doubling on
    // IV)" the first time a row was touched.
    const raw = 'Dana Ellis (p); Erin Fry (vc2); Carol (v1, shadowing on II, III); Bob Bek';
    const rows = parseOthersRows(raw);
    assert.deepEqual(rows[2], { name: 'Carol', instrument: 'v1', comment: 'shadowing on II, III' });
    assert.deepEqual(rows[3], { name: 'Bob Bek', instrument: '', comment: '' });
    assert.equal(serializeOthersRows(rows), raw);
});

test('Others? rows split on the same boundaries the app reads', () => {
    // Comma-separated entries are legal too, and a comma inside an annotation
    // must not tear an entry in half.
    assert.deepEqual(parseOthersRows('Dana Ellis (vc, doubling on IV), Bob Bek').map(r => r.name),
        ['Dana Ellis', 'Bob Bek']);
    assert.deepEqual(parseOthersRows(''), []);
    // "-" is "nobody", not a person.
    assert.deepEqual(parseOthersRows('-'), []);
});

test('a half-typed Others? row says nothing', () => {
    // The editor adds an empty row when you tap Add; leaving it blank must not
    // put a stray separator or a bare annotation in the cell.
    assert.equal(serializeOthersRows([
        { name: 'Dana Ellis', instrument: 'p', comment: '' },
        { name: '  ', instrument: 'vc', comment: '' },
    ]), 'Dana Ellis (p)');
    assert.equal(serializeOthersRows([]), '');
});

test('an entry with a comment goes to freeform, and merges back unchanged', () => {
    // A row is a name and a dropdown; prose needs a text field. Rather than
    // drop the comment or grow a third control per row, those entries live in
    // the freeform box and rejoin the cell on write.
    const cell = 'Dana Ellis (p); Carol (v1, shadowing on II, III); Erin Fry (vc2)';
    const { rows, freeform } = splitOthersCell(cell);
    assert.deepEqual(rows.map(r => r.name), ['Dana Ellis', 'Erin Fry']);
    assert.equal(freeform, 'Carol (v1, shadowing on II, III)');
    // Order changes (rows first), the content does not.
    assert.equal(mergeOthersCell(rows, freeform),
        'Dana Ellis (p); Erin Fry (vc2); Carol (v1, shadowing on II, III)');
});

test('merging tolerates either half being empty', () => {
    assert.equal(mergeOthersCell([], ''), '');
    assert.equal(mergeOthersCell([], '  Laura (v2, on I)  '), 'Laura (v2, on I)');
    assert.equal(mergeOthersCell([{ name: 'Dana Ellis', instrument: 'p', comment: '' }], ''),
        'Dana Ellis (p)');
});

test('sessionRows follows the same chain fillForward does', () => {
    const at = (h) => new Date(Date.UTC(2026, 0, 2, 12) - h * 3600_000);
    const rows = [
        row({ timestamp: at(30), composer: 'Old' }),      // yesterday
        row({ timestamp: at(3), composer: 'A' }),
        row({ timestamp: at(2), composer: 'B' }),
        row({ timestamp: at(1), composer: 'C' }),
    ];
    const now = new Date(Date.UTC(2026, 0, 2, 12));
    assert.deepEqual(sessionRows(rows, now).map(r => r.composer), ['A', 'B', 'C']);
    // A gap wider than the window ends the session, however recent the rest.
    assert.deepEqual(sessionRows([row({ timestamp: at(30) })], now), []);
    assert.deepEqual(sessionRows([], now), []);
});

test('sessionPeople offers this sitting people, most recent first', () => {
    // The second sextet of an afternoon has the first one's people, and
    // retyping them is the same failure as retyping a seat.
    const at = (h) => new Date(Date.UTC(2026, 0, 2, 12) - h * 3600_000);
    const rows = [
        row({ timestamp: at(3), player1: 'Alice Hart', player2: 'Bob Bek', player3: 'Carol Diaz',
            othersList: [{ name: 'Dana Ellis', instrument: 'p' }] }),
        row({ timestamp: at(1), player1: 'Alice Hart', player2: 'Erin Fry', player3: 'Carol Diaz',
            othersList: [] }),
    ];
    const people = sessionPeople(rows, new Date(Date.UTC(2026, 0, 2, 12)));
    // Last seen first: the latest row's three, then the pianist from earlier,
    // then the violinist who was replaced.
    assert.deepEqual(people.map(p => p.name),
        ['Carol Diaz', 'Erin Fry', 'Alice Hart', 'Dana Ellis', 'Bob Bek']);
    // The instrument they were last logged on comes along, so a pianist added
    // back arrives as a pianist.
    assert.equal(people.find(p => p.name === 'Dana Ellis').instrument, 'p');
    // Nobody here yesterday.
    assert.deepEqual(sessionPeople(rows, new Date(Date.UTC(2026, 0, 5, 12))), []);
});
