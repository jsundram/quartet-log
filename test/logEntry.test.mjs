// The log form's model. Everything here is what the form knows that the
// Google Form it replaces cannot: what a blank cell will become, which column
// refuses to repeat itself, and who the log has already met.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    blankEntry, carriedForward, resolveCarry, missingFields,
    warnings, knownPlayers, knownLocations, nextInSession, frequentComposers, LABELS,
    impliedSlotParts, slotCell, slotPartKey, defaultSlotParts, canonicalOthersCell,
    rowPlan, setSlotPart,
    PART_CHOICES, rosterParts, seatParts, partCode, partLabel,
    parseOthersRows, serializeOthersRows, splitOthersCell, mergeOthersCell,
    sessionRows, sessionPeople, sessionPieces, countNew, PARTIAL_MOVEMENT_NOTE,
} from '../src/logEntry.js';
import { SLOT_TO_PART } from '../src/dataProcessor.js';

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

test('resolveCarry trims, so the remembered copy matches the row the sheet holds', () => {
    // toFormBody trims what it submits and processRow trims what it reads back,
    // so an untrimmed copy describes a row that does not exist. logStore's
    // isSameRow compares composer and title with ===, and a false miss leaves
    // the local copy shadowing the sheet for 12 hours -- which is exactly what
    // defeats correcting a name in the sheet afterwards.
    const resolved = resolveCarry(
        blankEntry({ composer: ' Haydn ', title: '76#3 ', comments: ' fun ' }),
        carriedForward(null));
    assert.equal(resolved.title, '76#3');
    assert.equal(resolved.composer, 'Haydn');
    assert.equal(resolved.comments, 'fun');
});

test('resolveCarry leaves an explicitly empty seat empty', () => {
    // "-" is a seat the work does not have (howto section 5). It is a written
    // value, so it must survive rather than be dittoed over.
    const resolved = resolveCarry(blankEntry({ player2: '-' }), carriedForward(row()));
    assert.equal(resolved.player2, '-');
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
    // Others? clears here too; the extras come back from the sitting itself
    // (LogComponent.defaultOthersCell), not from the entry being reset.
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
    // And a CARRIED "-": the previous row was a trio, so seat 3 holds "-".
    // Picking VC2 on that empty seat fires the materialise-the-carried-name
    // rule, which would otherwise write "- (vc2)" -- a phantom cellist named
    // "-", since peopleKeysFor only skips the bare "-".
    assert.equal(slotCell({ typed: '', carried: '-', chosen: 'VC2', implied: 'VC' }), '');
    assert.equal(slotCell({ typed: '', carried: '-', chosen: 'VC', implied: 'VC' }), '');
    // Nothing carried and nothing typed: still nothing.
    assert.equal(slotCell({ typed: '', carried: '', chosen: 'V1', implied: 'V1' }), '');
});

test('an annotation the options cannot express passes through unrewritten', () => {
    // The sheet carries instruments neither list offers. Re-serialising one
    // into the nearest option would silently rewrite the record.
    assert.equal(slotPartKey('hn'), null);
    assert.equal(
        slotCell({ typed: '', carried: 'Erin Fry (hn)', chosen: 'hn', implied: 'V2' }),
        '');
    assert.equal(
        slotCell({ typed: 'Erin Fry', carried: '', chosen: 'hn', implied: 'V2' }),
        'Erin Fry (hn)');
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
    // va1 is an Others? option -- the first violist, logged by the second --
    // so it is its own key rather than folding into VA.
    assert.equal(slotPartKey('va1'), 'VA1');
    assert.equal(slotPartKey('vla1'), 'VA1');
    // vc1 is nobody's extra: Player 3 always holds it, so it keeps folding.
    assert.equal(slotPartKey('vc1'), 'VC');
    // Octet violins and the wind rep, which used to come back as null and be
    // offered as raw passthrough text instead of matching their own option.
    assert.equal(slotPartKey('v3'), 'V3');
    assert.equal(slotPartKey('v4'), 'V4');
    assert.equal(slotPartKey('cl'), 'CL');
    assert.equal(slotPartKey('clarinet'), 'CL');
    // Bass is in the catalog and flute is not: this log holds eleven of the
    // one and none of the other. An instrument with no key round-trips as the
    // raw code, which is the passthrough every dropdown offers.
    assert.equal(slotPartKey('bass'), 'BASS');
    assert.equal(slotPartKey('cb'), 'BASS');
    assert.equal(slotPartKey('flute'), null);
    assert.equal(slotPartKey('oboe'), null);
    // "cb" must not read as the cello: the (?![a-z]) guard is what stops it,
    // the same way it stops "c" matching clarinet.
    // The (?![a-z]) guards still hold: "c" is cello, "cl" is not.
    assert.equal(slotPartKey('c'), 'VC');
});

test('an extra is offered every part but your own', () => {
    // A name field says which PART someone played, and which column that lands
    // in is rowPlan's answer -- so an extra's list is the whole catalog. The
    // version that gave a seat only the three parts its columns hold meant the
    // arrangement on screen had to be the arrangement in the sheet, so a
    // quintet or a swap was still typed out name by name.
    const keys = part => rosterParts(part).map(p => p.key);
    const ALL = ['V1', 'V2', 'V3', 'V4', 'VA', 'VA1', 'VA2', 'VC', 'VC2', 'BASS', 'P', 'CL'];
    assert.deepEqual(keys(''), ALL);
    // Your own part is the one thing left out: you are already on it, and a row
    // saying two people played it cannot say which of them is you.
    assert.deepEqual(keys('V1'), ALL.filter(k => k !== 'V1'));
    assert.deepEqual(keys('V2'), ALL.filter(k => k !== 'V2'));
    // VA1 and VA2 are separate keys, so the second violist is offered the
    // first's part and the first is offered the second's.
    assert.ok(keys('VA1').includes('VA2'));
    assert.ok(keys('VA2').includes('VA1'));
    // And the unnumbered VA goes with your own: on VA1 it names the chair you
    // are in -- processRow folds VA1 to VA, so a row offering both records two
    // violists on one part with no way to say which is you -- and on VA2 it is
    // the first violist said vaguely, which VA1 says.
    assert.deepEqual(keys('VA1'), ALL.filter(k => k !== 'VA1' && k !== 'VA'));
    assert.deepEqual(keys('VA'), ALL.filter(k => k !== 'VA1' && k !== 'VA'));
    assert.deepEqual(keys('VA2'), ALL.filter(k => k !== 'VA2' && k !== 'VA'));
    // Every key writes the code the sheet has always held.
    for (const p of rosterParts('')) assert.equal(partCode(p.key), p.code);
    assert.deepEqual(rosterParts('').map(p => p.code),
        ['v1', 'v2', 'v3', 'v4', 'va', 'va1', 'va2', 'vc', 'vc2', 'bass', 'p', 'cl']);
    // A raw annotation the catalog does not know passes through as itself,
    // both ways -- the dropdown offers it, and submitting writes it back.
    assert.equal(partCode('klavier'), 'klavier');
    assert.equal(partLabel('klavier'), 'klavier');
    // partLabel covers the keys too: a part offered as a passthrough (your own,
    // carried in from a row that named it) should still read "Piano".
    assert.equal(partLabel('P'), 'Piano');
    assert.equal(partLabel('VA2'), 'VA2');
});

test('a player column offers the string chairs, and nothing else', () => {
    // The columns hold a quartet, and the move they exist to make easy is the
    // one that happens between two pieces: everybody shifts within their own
    // family when a sextet reads a second sextet. Six keys cover that, and
    // your own part comes off the same way it does for an extra.
    const keys = part => seatParts(part).map(p => p.key);
    assert.deepEqual(keys(''), ['V1', 'V2', 'VA', 'VA2', 'VC', 'VC2']);
    assert.deepEqual(keys('V1'), ['V2', 'VA', 'VA2', 'VC', 'VC2']);
    assert.deepEqual(keys('VA1'), ['V1', 'V2', 'VA2', 'VC', 'VC2']);
    assert.deepEqual(keys('VA2'), ['V1', 'V2', 'VC', 'VC2']);
    // Piano, the winds and an octet's v3/v4 are Others? parts. Nobody moves
    // into them from a column often enough to earn a tap target on every row:
    // in this log, the pianists are 8 rows in 3465 and v3/v4 about 16.
    for (const k of ['P', 'CL', 'BASS', 'V3', 'V4', 'VA1']) {
        assert.ok(!keys('V1').includes(k), `${k} is not a column part`);
        assert.ok(rosterParts('V1').some(p => p.key === k), `${k} is an Others? part`);
    }
    // Both lists are views of one catalog, so a key writes the same code
    // whichever dropdown it came from.
    for (const p of seatParts('V1')) assert.equal(partCode(p.key), p.code);
});

test('rosterParts hands out a fresh array, never the module constant', () => {
    // It is handed to a caller, and a module-level list returned as-is is one
    // any caller could sort or splice in place.
    const a = rosterParts('V1');
    a.length = 0;
    assert.equal(rosterParts('V1').length, 11);
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
    const odd = carriedForward(row({ playerInstruments: [null, 'hn', null] }));
    assert.deepEqual(defaultSlotParts(odd, 'VA'), ['V1', 'hn', 'VC']);
});

// --- The row the roster makes ------------------------------------------------
// Every name field is a person and the part they played; the sheet is three
// positional columns and a cell of extras. Which of the two a name lands in is
// rowPlan's answer, and this section pins it.

// The three seats, as the form has them: what is typed, what each would ditto,
// the part each is set to. Own part VA throughout, so the columns hold V1/V2/VC.
function plan(over = {}) {
    return rowPlan({
        typed: ['', '', ''], carried: ['', '', ''],
        chosen: ['V1', 'V2', 'VC'], implied: ['V1', 'V2', 'VC'],
        others: [],
        ...over,
    });
}

// Most cases care only about what the sheet receives.
function seats(over = {}) {
    return plan(over).cells;
}

// ...and the cell the extras come out as.
function extras(over = {}) {
    return serializeOthersRows(plan(over).others);
}

test('the plan says which part each written column is on, not which it was set to', () => {
    // The confirmation screen names the line-up it recorded, and it is the
    // third reader of this plan. The name in a column need not be the one
    // typed there -- after a swap the names have moved -- so pairing cell i
    // with the part field i was SET to prints the swap backwards.
    const swapped = plan({
        typed: ['Dana Ellis', 'Erin Fry', ''],
        carried: ['', '', 'Carol Diaz'],
        chosen: ['V2', 'V1', 'VC'],
    });
    assert.deepEqual(swapped.cells, ['Erin Fry', 'Dana Ellis', '']);
    assert.deepEqual(swapped.parts, ['V1', 'V2', 'VC']);

    // Someone on a part no column holds is not in a column at all: their part
    // is reported with them, in the extras.
    const moved = plan({
        typed: ['Dana Ellis', 'Erin Fry', 'Carol Diaz'],
        chosen: ['V1', 'VA2', 'VC'],
    });
    assert.deepEqual(moved.parts, ['V1', null, 'VC']);
    assert.equal(serializeOthersRows(moved.others), 'Erin Fry (va2)');

    // Nothing chosen yet -- every render before the Part row is tapped.
    const carried = ['Alice Hart', 'Bob Bek', 'Carol Diaz'];
    assert.deepEqual(plan({ carried, chosen: [null, null, null] }).parts, ['V1', 'V2', 'VC']);
    assert.deepEqual(
        plan({ carried, chosen: [null, null, null], implied: [null, null, null] }).parts,
        [null, null, null]);
    // And a column nobody is on reports nobody, rather than the part it holds.
    assert.deepEqual(plan({ carried: ['Alice Hart', '', ''] }).parts, ['V1', null, null]);
});

test('two violinists swapping are written in seat order, not annotated', () => {
    // The shape that was reported: a row reading "Dana Ellis (v2), Erin Fry
    // (v1)" where the sheet's own way to say it is "Erin Fry, Dana Ellis".
    assert.deepEqual(seats({
        typed: ['Dana Ellis', 'Erin Fry', ''],
        chosen: ['V2', 'V1', 'VC'],
    }), ['Erin Fry', 'Dana Ellis', '']);
});

test('a swap on seats nobody retyped moves the carried names', () => {
    // Both cells materialise: leaving either blank would ditto the row above,
    // which is the order being swapped out of.
    assert.deepEqual(seats({
        carried: ['Alice Hart', 'Bob Bek', 'Carol Diaz'],
        chosen: ['V2', 'V1', 'VC'],
    }), ['Bob Bek', 'Alice Hart', '']);
    // Seat 3 is untouched, so it dittos as it always has.
});

test('a swap across the classes moves the names too', () => {
    // The cellist is playing V1 and the first violin is on cello; slot 3 is
    // the cello seat, so that is where the cellist goes.
    assert.deepEqual(seats({
        typed: ['Alice Hart', '', 'Carol Diaz'],
        chosen: ['VC', 'V2', 'V1'],
    }), ['Carol Diaz', '', 'Alice Hart']);
});

test('a row already holding an annotated swap is normalised by the next one', () => {
    // defaultSlotParts reads those annotations, so this is what the seats look
    // like with nothing touched: the parts are unchanged and the names move to
    // the columns that imply them. A row the old behaviour wrote (or one typed
    // into the Google Form) stops propagating instead of dittoing forward.
    const carried = carriedForward(row({ playerInstruments: ['v2', 'v1', null] }));
    const chosen = defaultSlotParts(carried, 'VA');
    assert.deepEqual(chosen, ['V2', 'V1', 'VC']);
    assert.deepEqual(seats({
        carried: [carried.player1, carried.player2, carried.player3], chosen,
    }), ['Bob Bek', 'Alice Hart', '']);
});

test('the fifth player arriving is two dropdowns, not four retyped names', () => {
    // The session this was reported from. Three of you have been playing
    // quartets all afternoon; a fifth arrives, takes V1, and you move from
    // violin to viola. Every name on the form is still right and every one of
    // them is now in the wrong place: the violist you were sitting beside is a
    // second viola, the second violin moves over, and the new arrival takes a
    // column that was never his.
    //
    // Nobody is retyped. The violist's dropdown says VA2 and he is written into
    // Others?; the new arrival is typed once, on V1, and is written into the
    // column that holds it.
    const carried = ['Jess Lin', 'Arjun', 'Paul Mattal'];
    const got = plan({
        carried,
        // Own part is now VA1, so the columns hold V1 / V2 / VC.
        chosen: ['V2', 'VA2', 'VC'], implied: ['V1', 'V2', 'VC'],
        others: [{ name: 'Andrew Wong', instrument: 'v1', comment: '' }],
    });
    assert.deepEqual(got.cells, ['Andrew Wong', 'Jess Lin', '']);
    assert.equal(serializeOthersRows(got.others), 'Arjun (va2)');
    // And the next piece asks for nothing at all: the names are in the columns
    // their parts imply, so every seat dittos and the extra is written out
    // again -- which is what the sheet's own rows look like.
    assert.deepEqual(seats({
        carried: ['Andrew Wong', 'Jess Lin', 'Paul Mattal'],
        chosen: ['V1', 'V2', 'VC'], implied: ['V1', 'V2', 'VC'],
        others: [{ name: 'Arjun', instrument: 'va2', comment: '' }],
    }), ['', '', '']);
});

test('a part no column holds moves that person into Others?', () => {
    // The rule the columns have always had (howto section 5): the three are
    // the quartet's parts and everyone past them is an extra with a tag. A
    // column never gains a tag for a part it cannot hold -- the form moves the
    // person instead, which is the whole difference between this and writing
    // "Bob Bek (va2)" into the second column and leaving it there.
    const got = plan({
        typed: ['Alice Hart', 'Bob Bek', 'Dana Ellis'],
        chosen: ['V1', 'VA2', 'P'],
    });
    assert.deepEqual(got.cells, ['Alice Hart', '', '']);
    assert.equal(serializeOthersRows(got.others), 'Bob Bek (va2); Dana Ellis (p)');
});

test('a column nobody is on is written out, never left blank', () => {
    // A blank is a ditto mark, so a column the row above filled would repeat
    // the person who just moved off it -- in a part they are no longer on.
    assert.deepEqual(seats({
        carried: ['Alice Hart', 'Bob Bek', 'Carol Diaz'],
        chosen: ['V2', 'VA2', 'VC'],
    }), ['-', 'Alice Hart', '']);
    // With nothing above to repeat, blank already says it, and "-" would be
    // text the sheet does not need.
    assert.deepEqual(seats({
        typed: ['Alice Hart', '', ''],
        chosen: ['V2', 'V2', 'VC'],
    }), ['', 'Alice Hart', '']);
});

test('an extra is promoted only when the cell says exactly what a dropdown writes', () => {
    // Promotion rewrites the cell: the column implies the part, so the tag
    // goes away with it. That is right for the code this form wrote and wrong
    // for anything hand-typed around one -- "Louisa (vc Shadow)" reads as a
    // cellist, and promoting her would move her into the cello column, drop
    // the word Shadow and displace whoever the column was dittoing.
    const shadow = [{ name: 'Louisa', instrument: 'vc Shadow', comment: '' }];
    const got = plan({ carried: ['Alice Hart', 'Bob Bek', 'Carol Diaz'], others: shadow });
    assert.deepEqual(got.cells, ['', '', '']);
    assert.equal(serializeOthersRows(got.others), 'Louisa (vc Shadow)');
    // A comment on a promotable code is the same story -- it has prose in it,
    // and a column has nowhere to put prose.
    assert.equal(extras({
        carried: ['Alice Hart', 'Bob Bek', ''],
        others: [{ name: 'Louisa', instrument: 'vc', comment: 'shadowing on I' }],
    }), 'Louisa (vc, shadowing on I)');
});

test('an extra who is on a column part is written in that column', () => {
    // The mirror of the move out, and what lets a new arrival be typed once
    // rather than typed over somebody. The row keeps its extras in order and
    // loses only the one that was promoted.
    const got = plan({
        carried: ['Alice Hart', 'Bob Bek', 'Carol Diaz'],
        chosen: ['VA2', 'V2', 'VC'],
        others: [
            { name: 'Dana Ellis', instrument: 'p', comment: '' },
            { name: 'Erin Fry', instrument: 'v1', comment: '' },
        ],
    });
    assert.deepEqual(got.cells, ['Erin Fry', '', '']);
    assert.equal(serializeOthersRows(got.others), 'Dana Ellis (p); Alice Hart (va2)');
});

test('nobody is written into the row twice, in either direction', () => {
    // Both directions happen now that a name can move between a column and
    // Others?. The extras are re-seeded from the sitting on every piece, so a
    // fifth player who takes a chair this time is typed into the seat while
    // their extras row is still sitting there. The column wins: it is
    // positional and it dittos forward, and the extras row is the stale copy
    // the seeding left behind.
    const over = {
        typed: ['', 'Dave Ellis', ''],
        carried: ['Alice Hart', 'Bob Bek', 'Carol Diaz'],
        chosen: ['V1', 'V2', 'VC'], implied: ['V1', 'V2', 'VC'],
        others: [{ name: 'Dave Ellis', instrument: 'va2', comment: '' }],
    };
    const got = plan(over);
    assert.deepEqual(got.cells, ['', 'Dave Ellis', '']);
    assert.equal(serializeOthersRows(got.others), '');
    // A row carrying a comment is kept even so: that is prose somebody wrote,
    // not a re-seed, and there is nowhere else for it to go.
    assert.equal(extras({
        ...over,
        others: [{ name: 'Dave Ellis', instrument: 'va2', comment: 'doubling' }],
    }), 'Dave Ellis (va2, doubling)');
    // The other direction, which the first version of this guard covered on
    // its own: a seat moved into Others? is not appended beside itself.
    assert.equal(extras({
        carried: ['Alice Hart', 'Bob Bek', 'Carol Diaz'],
        chosen: ['V1', 'VA2', 'VC'], implied: ['V1', 'V2', 'VC'],
        others: [{ name: 'Bob Bek', instrument: 'va2', comment: '' }],
    }), 'Bob Bek (va2)');
});

test('a legacy tag carried in a column moves that person out of it', () => {
    // The one case nobody asked for: (vc2) on the cello seat is inherited from
    // the row above with no user action at all, and the next row moves her to
    // Others? and writes the cello column empty. The part is unchanged -- she
    // is a second cellist either way -- and the row stops contradicting
    // SLOT_TO_PART, which is what the reader and the spreadsheet both go by.
    const got = plan({
        carried: ['Alice Hart', 'Bob Bek', 'Carol Diaz (vc2)'],
        chosen: ['V2', 'V1', 'VC2'],
    });
    assert.deepEqual(got.cells, ['Bob Bek', 'Alice Hart', '-']);
    assert.equal(serializeOthersRows(got.others), 'Carol Diaz (vc2)');
});

test('a typed name takes the part shown beside it, not the column it sits in', () => {
    // Raised in review, and kept deliberately: a carried row that already holds
    // an annotated swap leaves the dropdowns reading V2/V1 with nothing the
    // logger touched, so two NEW names typed into those seats come out
    // transposed -- you type into "Player 1" and Player 1 receives the other.
    //
    // It is still what the form says on screen. The part beside the first field
    // reads V2, so the person typed there played V2 and belongs in the V2
    // column; the pair (field, dropdown) is the claim, and which column carries
    // it is this form's business. Nor is the claim new: before the parts could
    // move anyone this same entry wrote "Dana Ellis (v2) | Erin Fry (v1)" --
    // the identical statement, in the shape this change exists to stop writing.
    // What puts a part on a seat whose person just changed is defaultSlotParts,
    // which did so before this too; that is the rule to revisit if the
    // transposition is ever judged the wrong call.
    const carried = carriedForward(row({ playerInstruments: ['v2', 'v1', null] }));
    assert.deepEqual(seats({
        typed: ['Dana Ellis', 'Erin Fry', ''],
        carried: [carried.player1, carried.player2, carried.player3],
        chosen: defaultSlotParts(carried, 'VA'),
    }), ['Erin Fry', 'Dana Ellis', '']);
});

test('two people claiming one part are annotated, not moved', () => {
    // Under-determined: two claims on V2 and none on V1, so who is on V1?
    // The seat that already IS the V2 column keeps it and the other is
    // annotated where it sits -- "Alice is on V2" is at least true, and moving
    // a third person nobody spoke about would be a guess. setSlotPart is what
    // keeps the form out of this state.
    assert.deepEqual(seats({
        typed: ['Alice Hart', 'Bob Bek', ''],
        chosen: ['V2', 'V2', 'VC'],
    }), ['Alice Hart (v2)', 'Bob Bek', '']);
});

test('an annotation no option can read is left exactly where it is', () => {
    // Rewriting a cell we cannot read is worse than leaving it: the code could
    // be a part, an instrument or a note, and the form has no business
    // guessing which.
    assert.deepEqual(seats({
        carried: ['Alice Hart (hn)', 'Bob Bek', 'Carol Diaz'],
        chosen: ['hn', 'V2', 'VC'],
    }), ['', '', '']);
});

test('an empty chair stays an empty chair', () => {
    // A trio's "-" in the cello seat: it is nobody, so it holds no part and
    // never argues with someone who does. Here the V1 player moves to cello,
    // and the "-" has to be written into the column they left.
    assert.deepEqual(seats({
        carried: ['Alice Hart', 'Bob Bek', '-'],
        chosen: ['VC', 'V2', 'V1'],
    }), ['-', '', 'Alice Hart']);
    // The other direction: the column holding "-" is the one left alone, so it
    // keeps dittoing rather than writing it out again.
    assert.deepEqual(seats({
        carried: ['Alice Hart', 'Bob Bek', '-'],
        chosen: ['V2', 'V1', 'VC'],
    }), ['Bob Bek', 'Alice Hart', '']);
});

test('no part chosen yet leaves every seat alone', () => {
    // Own part is what the columns mean; before it is picked there is nothing
    // to place anyone against, and nobody is moved out of a column either.
    assert.deepEqual(seats({
        typed: ['Alice Hart', 'Bob Bek', ''],
        chosen: [null, null, null], implied: [null, null, null],
    }), ['Alice Hart', 'Bob Bek', '']);
    assert.equal(extras({
        typed: ['Alice Hart', '', ''],
        chosen: ['P', null, null], implied: [null, null, null],
    }), '');
});

// The seats a quartet layout implies, for the setSlotPart cases below.
const SEAT_PARTS = ['V1', 'V2', 'VC'];
const setPart = (chosen, seat, key, implied = SEAT_PARTS) =>
    setSlotPart({ chosen, implied, seat, key });

test('setSlotPart hands the other seat the part this one gave up', () => {
    // One dropdown means "these two swapped" -- the state rowPlan writes by
    // moving the names, reached in one tap instead of two.
    assert.deepEqual(setPart(['V1', 'V2', 'VC'], 0, 'V2'), ['V2', 'V1', 'VC']);
    assert.deepEqual(setPart(['V1', 'V2', 'VC'], 2, 'V1'), ['VC', 'V2', 'V1']);
    // A part no other seat holds displaces nothing.
    assert.deepEqual(setPart(['V1', 'V2', 'VC'], 1, 'VA2'), ['V1', 'VA2', 'VC']);
    // Setting a seat to what it already holds is not a clash with itself.
    assert.deepEqual(setPart(['V1', 'V2', 'VC'], 0, 'V1'), ['V1', 'V2', 'VC']);
    // Before the Part row is tapped no seat holds anything, so there is
    // nothing to clash with.
    assert.deepEqual(setPart([null, null, null], 0, 'V1', [null, null, null]),
        ['V1', null, null]);
    // And the seat that gives a part up goes back to holding nothing, which
    // slotParts reads as the part its seat implies.
    assert.deepEqual(setPart(['V1', null, null], 1, 'V1', [null, null, null]),
        [null, 'V1', null]);
});

test('a part that belonged to a person is not handed to another seat', () => {
    // The pianist's seat moves to V2. Nobody swapped with anybody: the part
    // given up was that person's, not the chair's, so handing (p) over would
    // record an instrument the next player never played -- with their name
    // field untouched, and with no way for them to know.
    assert.deepEqual(setPart(['P', 'V2', 'VC'], 0, 'V2'), ['V2', 'V2', 'VC']);
    // (vc2) is worse than wrong: classOf reads it as the CELLO class, so the
    // displaced name would alias in a class it never played in.
    assert.deepEqual(setPart(['V1', 'V2', 'VC2'], 2, 'V2'), ['V1', 'V2', 'V2']);
    // A code the option list cannot express is the same story.
    assert.deepEqual(setPart(['cl', 'V2', 'VC'], 0, 'V2'), ['V2', 'V2', 'VC']);

    // And the same rule TAKING rather than giving, which is the mirror the
    // first version of this guard missed. A seat moved onto the second
    // violist's VA2 must not write her (v1): she is not trading chairs, she is
    // a second viola, and in the VC2 case the class she aliases in would change
    // with her part.
    assert.deepEqual(setPart(['V1', 'VA2', 'VC'], 0, 'VA2'), ['VA2', 'VA2', 'VC']);
    assert.deepEqual(setPart(['V1', 'V2', 'VC2'], 0, 'VC2'), ['VC2', 'V2', 'VC2']);
    assert.deepEqual(setPart(['P', 'V2', 'VC'], 1, 'P'), ['P', 'P', 'VC']);

    // Two seats already claim one part -- a legacy row can carry that in --
    // so there is no single partner to trade with, and picking the first would
    // move a third person nobody spoke about.
    assert.deepEqual(setPart(['V2', 'V2', 'VC'], 2, 'V2'), ['V2', 'V2', 'V2']);
    // What the sheet then gets: the duplicate claim is annotated, and the seat
    // nobody spoke about dittos rather than gaining an instrument.
    assert.deepEqual(seats({
        carried: ['Dana Ellis (p)', 'Bob Bek', 'Carol Diaz'],
        chosen: ['V2', 'V2', 'VC'],
    }), ['Dana Ellis (v2)', '', '']);
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

test('canonicalOthersCell replaces the raw names with the canonical ones', () => {
    // The raw cell is what normalizePlayerNames leaves alone; othersList is
    // what it rewrote. Seeding the next piece's extras from the raw text made
    // the two disagree exactly where PLAYER_ALIASES does its job, so the chip
    // for the canonical name was offered for a person already on the row and
    // tapping it wrote them in twice. This can never fail in CI, where the
    // alias table is the empty stub -- hence a fixture that states both views.
    assert.equal(canonicalOthersCell({
        others: 'Pete (vc)',
        othersList: [{ name: 'Peter Ouyang', instrument: 'vc' }],
    }), 'Peter Ouyang (vc)');

    // The comment only the raw cell carries survives.
    assert.equal(canonicalOthersCell({
        others: 'Pete (vc, doubling on IV); Bob Bek',
        othersList: [{ name: 'Peter Ouyang', instrument: 'vc' }, { name: 'Bob Bek', instrument: null }],
    }), 'Peter Ouyang (vc, doubling on IV); Bob Bek');
});

test('canonicalOthersCell falls back to the raw cell when the two views disagree', () => {
    // Positional alignment is the whole basis for the rewrite; if it does not
    // hold, an assumption broke and the sheet's own text is the honest answer
    // rather than a guess at which name maps to which.
    assert.equal(canonicalOthersCell({ others: 'Pete (vc); Bob Bek', othersList: [{ name: 'Peter Ouyang' }] }),
        'Pete (vc); Bob Bek');
    assert.equal(canonicalOthersCell({ others: '', othersList: [] }), '');
    assert.equal(canonicalOthersCell(null), '');
    assert.equal(canonicalOthersCell(undefined), '');
});

test('the part buttons are the app own vocabulary, and VC is not in it yet', () => {
    // This used to be formConfig's list of one user's radio options, which
    // coupled what anyone could log to how the reference form was built.
    //
    // VC's absence is load-bearing rather than an oversight: SLOT_TO_PART has
    // no VC key and SLOT_CLASS hardcodes slot 3 as the cello, so a cellist's
    // row would put a violist in the cello slot. Offering the button before
    // the reader can take it would write rows nothing downstream reads back
    // correctly.
    assert.deepEqual([...PART_CHOICES], ['V1', 'V2', 'VA1', 'VA2']);
    assert.equal(PART_CHOICES.includes('VC'), false);
    assert.equal(SLOT_TO_PART.VC, undefined);
});

// The sitting as the interstitial reports it: what the app already has, plus
// what this device sent that the published sheet has not caught up with.
const hoursAgo = (h) => new Date(Date.UTC(2026, 0, 2, 12) - h * 3600_000);
const NOW = new Date(Date.UTC(2026, 0, 2, 12));

const submission = (h, over = {}) => ({
    at: hoursAgo(h).getTime(),
    entry: blankEntry({
        composer: 'Haydn', title: '76#3', part: 'V1',
        player1: 'Alice Hart', player2: 'Bob Bek', player3: 'Carol Diaz',
        location: 'Home', ...over,
    }),
});

test('sessionPieces marks which side of the lag each piece is on', () => {
    const rows = [row({ timestamp: hoursAgo(2), work: { title: '20#2' } })];
    const pieces = sessionPieces(rows, [submission(1, { title: '76#3' })], [], NOW);
    assert.deepEqual(pieces.map(p => [p.title, p.landed]), [['20#2', true], ['76#3', false]]);
    // The people come along either way: the tiles count them.
    assert.deepEqual(pieces[1].people, ['Alice Hart', 'Bob Bek', 'Carol Diaz']);
});

test('sessionPieces drops a submission the app has already fetched', () => {
    const rows = [row({ timestamp: hoursAgo(1), work: { title: '76#3' } })];
    const pieces = sessionPieces(rows, [submission(1)], [], NOW);
    assert.deepEqual(pieces.map(p => [p.title, p.landed]), [['76#3', true]]);
});

test('sessionPieces pairs one for one, so a piece played twice shows twice', () => {
    // Pairing by identity alone would hide the second reading behind the
    // first one's row and under-count the evening.
    const rows = [row({ timestamp: hoursAgo(2), work: { title: '76#3' } })];
    const pieces = sessionPieces(rows, [submission(2), submission(1)], [], NOW);
    assert.deepEqual(pieces.map(p => p.landed), [true, false]);
});

test('sessionPieces re-windows the merged list', () => {
    // A submission the sheet never took, from this morning: outside the
    // window, so it is not part of tonight however long it is remembered.
    const pieces = sessionPieces([], [submission(9), submission(0.5)], [], NOW);
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0].landed, false);
    assert.deepEqual(sessionPieces([], [], [], NOW), []);
});

test('sessionPieces lets a submission bridge back to an earlier fetched row', () => {
    // One source at a time is not the sitting: log a piece offline at 17:30
    // and the 14:00 row the sheet already has is more than a window away from
    // 20:00, but not from the piece between them. fillForward would chain all
    // three, so windowing the fetched rows on their own first reported the
    // evening short by its first piece.
    const rows = [row({ timestamp: hoursAgo(6), work: { title: '20#1' } })];
    const pieces = sessionPieces(rows, [
        submission(2.5, { title: '76#1' }), submission(0, { title: '76#2' }),
    ], [], NOW);
    assert.deepEqual(pieces.map(p => [p.title, p.landed]),
        [['20#1', true], ['76#1', false], ['76#2', false]]);
    // Still bounded: with nothing to bridge the gap, the 14:00 row is its own
    // sitting and tonight is the submission alone.
    assert.deepEqual(sessionPieces(rows, [submission(0, { title: '76#2' })], [], NOW)
        .map(p => p.title), ['76#2']);
});

test('sessionPieces folds VA1 to VA, as processRow does on the way in', () => {
    // Otherwise one seat reads as two different parts either side of the lag.
    const [piece] = sessionPieces([], [submission(1, { part: 'VA1' })], [], NOW);
    assert.equal(piece.part, 'VA');
});

test('countNew scores a sitting against a log that does not contain it', () => {
    const base = [
        row({ work: { title: '76#3' }, part: 'V1' }),
        row({ work: { title: '20#2' }, part: 'V1' }),
    ];
    const pieces = sessionPieces([], [
        submission(2, { title: '76#3', part: 'V2' }),   // known work, new part
        submission(1, { title: '33#1', part: 'V1' }),   // new work and part
    ], [], NOW);
    assert.deepEqual(countNew(pieces, base),
        { pieces: 2, uniquePieces: 1, uniqueParts: 2, uniquePeople: 0 });
});

test('countNew does not call a carried first name a new person', () => {
    // fillForward's own rule: "Alice" under "Alice Hart" is the same person.
    // Without it every sitting that carries a seat forward would report a
    // stranger — and the alias table that would settle it is deliberately
    // out of reach here.
    const base = [row({ player1: 'Alice Hart', player2: 'Bob Bek', player3: 'Carol Diaz' })];
    const same = sessionPieces([], [submission(1, { player1: 'Alice' })], [], NOW);
    assert.equal(countNew(same, base).uniquePeople, 0);
    // A name that merely starts the same is a different person, not a
    // shorthand — the word boundary is what says so.
    const other = sessionPieces([], [submission(1, { player1: 'Ali' })], [], NOW);
    assert.equal(countNew(other, base).uniquePeople, 1);
    const guest = sessionPieces([], [submission(1, { others: 'Dana Ellis (p)' })], [], NOW);
    assert.equal(countNew(guest, base).uniquePeople, 1);
});

test('countNew ignores an untitled work, as computeAggregateStats does', () => {
    const pieces = sessionPieces([], [submission(1, { title: '' })], [], NOW);
    assert.deepEqual(countNew(pieces, []),
        { pieces: 1, uniquePieces: 0, uniqueParts: 0, uniquePeople: 3 });
});

test('a partial movement says whether it was sent, since it can never land', () => {
    // processData drops a ":" title, so the app's copy of the sheet will never
    // hold one however long anyone waits. Left as "not landed" its dot sat
    // hollow forever under a note promising it would fill in shortly.
    const sub = submission(1, { title: '76#1: I' });
    const [sent] = sessionPieces([], [sub], [], NOW);
    assert.equal(sent.partial, true);
    assert.equal(sent.landed, false);
    assert.equal(sent.queued, false);

    // Still in the outbox: that is the one state where a movement has not got
    // anywhere, and the only state its dot can honestly report as unfinished.
    const [held] = sessionPieces([], [sub], [{ entry: sub.entry }], NOW);
    assert.equal(held.queued, true);

    // A whole piece is never marked partial, either side of the lag.
    const [whole] = sessionPieces([], [submission(1)], [], NOW);
    assert.equal(whole.partial, false);
    assert.equal(sessionPieces([row({ timestamp: hoursAgo(1) })], [], [], NOW)[0].partial, false);
});

test('the outbox is matched newest first, since flush sends oldest first', () => {
    // Two readings of one piece, one already gone: the copy still waiting is
    // the later one, so marking the earlier would put the hollow dot on the
    // row that is safely in the sheet.
    const twice = [submission(2, { title: '76#1' }), submission(1, { title: '76#1' })];
    const pieces = sessionPieces([], twice, [{ entry: twice[0].entry }], NOW);
    assert.deepEqual(pieces.map(p => p.queued), [false, true]);
});

test('countNew leaves partial movements out, as computeAggregateStats does', () => {
    // Counting one would leave the confirmation's tiles permanently a piece
    // ahead of the dashboard they are borrowed from.
    const pieces = sessionPieces([], [
        submission(2, { title: '76#1' }),
        submission(1, { title: '76#2: I' }),
    ], [], NOW);
    assert.deepEqual(countNew(pieces, []),
        { pieces: 1, uniquePieces: 1, uniqueParts: 1, uniquePeople: 3 });
    // It is still in the sitting, though — you played it and you logged it.
    assert.equal(pieces.length, 2);
});

test('warnings reads the same partial-movement rule parseWork does', () => {
    assert.deepEqual(warnings(blankEntry({ title: '76#1' })), []);
    const [note] = warnings(blankEntry({ title: '76#1: I' }));
    assert.match(note, /partial movement/);
    assert.match(note, /counts/);
});

test('the outbox matches the sitting record though their whitespace disagrees', () => {
    // submit() enqueues the entry as TYPED — blanks left blank so the sheet's
    // own fillForward dittos them — and remembers resolveCarry's output, which
    // trims every field. A title typed with a trailing space keyed the two
    // records differently, so a piece still sitting in the outbox fell through
    // to the partial branch and was painted with a filled "Sent to your sheet"
    // tick: the exact false confidence this screen exists to remove.
    const typed = blankEntry({ composer: 'Haydn', title: '76#1: I ', part: 'V1' });
    const remembered = resolveCarry(typed, {});
    const [piece] = sessionPieces([], [{ at: hoursAgo(1).getTime(), entry: remembered }],
        [{ entry: typed }], NOW);
    assert.equal(piece.queued, true);
    assert.equal(piece.partial, true);

    // The same disagreement must not hide a fetched row either.
    const landed = sessionPieces(
        [row({ timestamp: hoursAgo(1), composer: 'Haydn', work: { title: '76#1' } })],
        [{ at: hoursAgo(1).getTime(), entry: resolveCarry(blankEntry({ composer: 'Haydn ', title: ' 76#1' }), {}) }],
        [], NOW);
    assert.deepEqual(landed.map(p => p.landed), [true]);
});

test('warnings and the confirmation share one partial-movement sentence', () => {
    // The screen has to raise it for any italic row in the sitting, not only
    // for the piece just submitted, so the string cannot live in warnings()
    // alone.
    assert.deepEqual(warnings(blankEntry({ title: '76#1: I' })), [PARTIAL_MOVEMENT_NOTE]);
});

test('a sitting is windowed from a moment, so an old one can still be read back', () => {
    // The confirmation screen can sit on a phone for hours and repaints on
    // every revalidate, so the moment it windows from is the moment the piece
    // was logged rather than whenever the repaint happens. Asked about now,
    // the same sitting is gone — which is what emptied the list under a green
    // tick and zeroed every delta.
    const sub = submission(1);
    const asLogged = sessionPieces([], [sub], [], new Date(sub.at));
    assert.equal(asLogged.length, 1);
    const hoursLater = new Date(sub.at + 5 * 3600_000);
    assert.deepEqual(sessionPieces([], [sub], [], hoursLater), []);
});
