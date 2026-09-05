// The log form's model. Everything here is what the form knows that the
// Google Form it replaces cannot: what a blank cell will become, which column
// refuses to repeat itself, and who the log has already met.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    blankEntry, carriedForward, resolveCarry, othersReminder, missingFields,
    warnings, knownPlayers, knownLocations, nextInSession,
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
    assert.deepEqual(missingFields(blankEntry()), ['Composer', 'Work Title', 'Which Part']);
    assert.deepEqual(missingFields(blankEntry({ composer: 'Haydn', title: '76#3', part: 'V1' })), []);
    // Whitespace is not a value.
    assert.deepEqual(missingFields(blankEntry({ composer: ' ', title: '76#3', part: 'V1' })), ['Composer']);
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
