// The log form's outbox. The ordering guarantee is the point: fillForward
// reads every row against the one above it, so a queue that flushed out of
// order would point a blank seat at the wrong previous row — wrong in exactly
// the way the log cannot notice later.
//
// localStorage is stubbed with a Map-backed object on globalThis, per the
// dataService tests: logStore reads it at call time, never at import time.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pending, enqueue, drop, flush, setRecent, recent, recentAll } from '../src/logStore.js';
import { blankEntry } from '../src/logEntry.js';

function makeLocalStorage() {
    const map = new Map();
    return {
        throwOnSet: false,
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) {
            if (this.throwOnSet) throw new Error('QuotaExceededError (simulated)');
            map.set(k, String(v));
        },
        removeItem(k) { map.delete(k); },
        clear() { map.clear(); },
    };
}

let ls;
beforeEach(() => {
    ls = makeLocalStorage();
    globalThis.localStorage = ls;
});

const entry = (title) => blankEntry({ composer: 'Haydn', title, part: 'V1' });

test('enqueue appends and pending reads back in order', () => {
    enqueue(entry('76#1'));
    enqueue(entry('76#2'));
    assert.deepEqual(pending().map(q => q.entry.title), ['76#1', '76#2']);
});

test('flush sends oldest first and empties the queue', async () => {
    ['76#1', '76#2', '76#3'].forEach(t => enqueue(entry(t)));
    const sentTitles = [];
    const result = await flush(async (e) => { sentTitles.push(e.title); });
    assert.deepEqual(sentTitles, ['76#1', '76#2', '76#3']);
    assert.deepEqual(result, { sent: 3, remaining: 0 });
    assert.deepEqual(pending(), []);
});

test('flush stops at the first failure and keeps the rest queued, in order', async () => {
    ['76#1', '76#2', '76#3'].forEach(t => enqueue(entry(t)));
    const sentTitles = [];
    const result = await flush(async (e) => {
        if (e.title === '76#2') throw new Error('offline');
        sentTitles.push(e.title);
    });
    assert.deepEqual(sentTitles, ['76#1']);
    assert.deepEqual(result, { sent: 1, remaining: 2 });
    // Crucially it did NOT skip past the failure to send 76#3: the sheet would
    // then hold 76#3 above 76#2 and read 76#2's blank seats against it.
    assert.deepEqual(pending().map(q => q.entry.title), ['76#2', '76#3']);
});

test('a successful send is persisted immediately, so an interrupt cannot resend', async () => {
    ['76#1', '76#2'].forEach(t => enqueue(entry(t)));
    await flush(async (e) => {
        if (e.title === '76#2') {
            // Mid-flush, the first entry is already gone from storage.
            assert.deepEqual(pending().map(q => q.entry.title), ['76#2']);
            throw new Error('offline');
        }
    });
    assert.deepEqual(pending().map(q => q.entry.title), ['76#2']);
});

test('flush on an empty queue is a no-op', async () => {
    assert.deepEqual(await flush(async () => { throw new Error('never called'); }),
        { sent: 0, remaining: 0 });
});

test('drop removes one entry by id and leaves the order alone', () => {
    ['76#1', '76#2', '76#3'].forEach(t => enqueue(entry(t)));
    const [, second] = pending();
    assert.deepEqual(drop(second.id).map(q => q.entry.title), ['76#1', '76#3']);
});

test('a corrupt or missing queue reads as empty rather than throwing', () => {
    assert.deepEqual(pending(), []);
    ls.setItem('quartetlog_pending', 'not json');
    assert.deepEqual(pending(), []);
    ls.setItem('quartetlog_pending', '{"not":"an array"}');
    assert.deepEqual(pending(), []);
});

test('a blocked localStorage does not break the form', () => {
    // Private-mode Safari throws on write. A log form that refused to open
    // would be worse than one that forgets.
    ls.throwOnSet = true;
    assert.doesNotThrow(() => enqueue(entry('76#1')));
    assert.deepEqual(pending(), []);
});

test('recent with nothing stored is null', () => {
    assert.equal(recent(null), null);
});

test('the sheet wins once it holds the submission, so a later edit is honored', async () => {
    // The scenario this exists for: a name typed wrong, fixed in the sheet
    // afterwards. The form only ever writes, so the correction reaches
    // everything that reads the sheet -- unless this local copy of the
    // submitted row outlives it and goes on describing the typo.
    setRecent(blankEntry({
        composer: 'Haydn', title: '76#3', part: 'V1',
        player1: 'Alise Hart', location: 'Home',
    }));
    // The sheet now holds that row, with the name corrected by hand. Its
    // timestamp is a moment BEFORE setRecent ran, because Forms stamps the row
    // when it receives it and the client saves afterwards -- so "is the row
    // newer than my save" can never be the test.
    const asSheetHasIt = {
        timestamp: new Date(Date.now() - 5000),
        composer: 'Haydn', work: { title: '76#3' }, part: 'V1',
        player1: 'Alice Hart', location: 'Home',
    };
    assert.equal(recent(asSheetHasIt), null);
});

test('the local copy still wins while the published CSV lags behind it', () => {
    setRecent(blankEntry({ composer: 'Haydn', title: '76#3', part: 'V1', player1: 'Alice Hart' }));
    // A different, older piece is still the newest the sheet knows: the CSV is
    // minutes behind and the next piece of a session is logged in seconds.
    const older = {
        timestamp: new Date(Date.now() - 3600_000),
        composer: 'Mozart', work: { title: 'K421' }, part: 'V1', player1: 'Bob Bek',
    };
    assert.equal(recent(older)?.entry.player1, 'Alice Hart');
    assert.equal(recent(null)?.entry.player1, 'Alice Hart');
    // The save time rides along: "is this still the same sitting" needs it,
    // and a synthetic now would make this morning look like a minute ago.
    assert.ok(Date.now() - recent(null).at < 5000);
});

test('every submission of the sitting is remembered, not just the last', () => {
    // The session-people offer is only as deep as this: the published CSV lags
    // by minutes and a sitting logs several pieces in that time, so one
    // remembered row would leave the app blind to the people it most wants to
    // offer back.
    setRecent(blankEntry({ composer: 'Haydn', title: '76#1', others: 'Dana Ellis (p)' }));
    setRecent(blankEntry({ composer: 'Haydn', title: '76#2', others: 'Dana Ellis (p); Erin Fry (vc2)' }));
    setRecent(blankEntry({ composer: 'Haydn', title: '76#3', others: 'Dana Ellis (p)' }));
    assert.deepEqual(recentAll().map(r => r.entry.title), ['76#1', '76#2', '76#3']);
    // Carry-forward still means the newest one.
    assert.equal(recent(null).entry.title, '76#3');
});

test('a single stored submission from an earlier version is not dropped', () => {
    ls.setItem('quartetlog_recent', JSON.stringify({
        at: Date.now(), entry: blankEntry({ composer: 'Haydn', title: '76#1' }),
    }));
    assert.deepEqual(recentAll().map(r => r.entry.title), ['76#1']);
    assert.equal(recent(null).entry.title, '76#1');
});

test('submissions age out, so yesterday is not part of today sitting', () => {
    ls.setItem('quartetlog_recent', JSON.stringify([
        { at: Date.now() - 20 * 3600_000, entry: blankEntry({ title: 'old' }) },
        { at: Date.now(), entry: blankEntry({ title: 'new' }) },
    ]));
    assert.deepEqual(recentAll().map(r => r.entry.title), ['new']);
});
