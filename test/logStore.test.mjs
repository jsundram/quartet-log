// The log form's outbox. The ordering guarantee is the point: fillForward
// reads every row against the one above it, so a queue that flushed out of
// order would point a blank seat at the wrong previous row — wrong in exactly
// the way the log cannot notice later.
//
// localStorage is stubbed with a Map-backed object on globalThis, per the
// dataService tests: logStore reads it at call time, never at import time.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    pending, enqueue, drop, flush, setRecent, recent, recentAll, forgetRecent,
    saveDraft, readDraft, clearDraft, clearAll,
} from '../src/logStore.js';
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

test('enqueue says whether the entry actually persisted', () => {
    // Not decoration: flush re-reads storage, so an entry that never landed
    // there is never sent. A caller reading success off the returned list
    // would tell someone a piece was logged that nothing holds and nothing
    // will retry -- and the opaque Forms response can never contradict it.
    assert.deepEqual(enqueue(entry('76#1')).map(q => q.entry.title), ['76#1']);
    ls.throwOnSet = true;
    assert.equal(enqueue(entry('76#2')), null);
});

test('a dropped entry leaves flush with nothing to send, and it says so', async () => {
    ls.throwOnSet = true;
    assert.equal(enqueue(entry('76#1')), null);
    let posts = 0;
    // The shape of the bug this pins: sent 0, remaining 0 -- a clean run that
    // a caller cannot tell from a real one unless enqueue told it.
    assert.deepEqual(await flush(async () => { posts++; }), { sent: 0, remaining: 0 });
    assert.equal(posts, 0);
});

test('flush stops rather than resending an entry it cannot remove', async () => {
    // The loop re-reads the queue each iteration, so a failed removal would
    // hand back the entry just sent and POST it forever. Over-reporting
    // `remaining` once is the cheaper wrong answer.
    ['76#1', '76#2'].forEach(t => enqueue(entry(t)));
    const sentTitles = [];
    const result = await flush(async (e) => {
        // Without the guard this loops forever, so the regression has to fail
        // rather than hang: a run that keeps going is stopped here and shows
        // up as the repeat it is.
        if (sentTitles.length > 2) throw new Error('resending an entry already sent');
        sentTitles.push(e.title);
        ls.throwOnSet = true;      // storage fills up mid-flush
    });
    assert.deepEqual(sentTitles, ['76#1']);
    assert.deepEqual(result, { sent: 1, remaining: 2 });
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

test('two overlapping flushes do not send the same entry twice', async () => {
    // `online`, becoming visible and submit all call flush. Two runs each
    // reading the same head entry means a duplicate row in the sheet, and
    // nothing downstream can tell it from a real one.
    ['76#1', '76#2'].forEach(t => enqueue(entry(t)));
    const sentTitles = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const post = async (e) => { sentTitles.push(e.title); await gate; };

    const first = flush(post);
    const second = flush(post);       // arrives mid-send, must not duplicate
    release();
    await Promise.all([first, second]);

    assert.deepEqual(sentTitles, ['76#1', '76#2']);
    assert.deepEqual(pending(), []);
});

test('an entry queued during a flush goes out in that same run', async () => {
    // Writing a stale snapshot back would have dropped it instead.
    enqueue(entry('76#1'));
    const sentTitles = [];
    const post = async (e) => {
        sentTitles.push(e.title);
        if (e.title === '76#1') enqueue(entry('76#2'));
    };
    const result = await flush(post);
    assert.deepEqual(sentTitles, ['76#1', '76#2']);
    assert.deepEqual(result, { sent: 2, remaining: 0 });
});

test('joining a flush never inherits an answer from a run that did not see the entry', async () => {
    // The tail window: the run's loop is done and `remaining` computed, but
    // `inFlight` is only cleared a microtask later, in the first caller's
    // `finally`. A submit landing in there used to get the previous run's
    // {sent, remaining} -- "Logged" for an entry still sitting in the queue.
    //
    // That window is one microtask wide and its position depends on how many
    // ticks the run takes to settle, so sweep the whole settle sequence rather
    // than guess: the invariant is that a resolved flush never claims an empty
    // queue while one is still waiting.
    for (let ticks = 0; ticks < 10; ticks++) {
        globalThis.localStorage = (ls = makeLocalStorage());
        enqueue(entry('76#1'));
        const sentTitles = [];
        const post = async (e) => { sentTitles.push(e.title); };

        const first = flush(post);
        for (let i = 0; i < ticks; i++) await null;
        enqueue(entry('76#2'));
        const joined = await flush(post);
        await first;

        const at = `tick ${ticks}`;
        assert.equal(joined.remaining, pending().length, at);
        assert.deepEqual(pending(), [], at);
        assert.deepEqual(sentTitles, ['76#1', '76#2'], at);
    }
});

test('forgetRecent drops the copy of a submission whose queued entry was discarded', () => {
    // setRecent runs on every submit, including one the flush could not send.
    // Discarding the queued entry with the x has to forget both, or a row the
    // sheet will never hold goes on driving carry-forward for 12 hours -- and
    // isSameRow can never retire it, because no fetched row will ever match.
    const queued = blankEntry({ composer: 'Haydn', title: '76#1', player1: 'Alice Hart' });
    setRecent(queued);
    setRecent(blankEntry({ composer: 'Mozart', title: 'K421', player1: 'Bob Bek' }));
    forgetRecent(queued);
    assert.deepEqual(recentAll().map(r => r.entry.title), ['K421']);
    assert.equal(recent(null).entry.title, 'K421');
});

test('a draft survives a reload, and a submit retires it', () => {
    // An installed PWA is evicted from memory whenever the phone decides to.
    assert.equal(readDraft(), null);
    saveDraft({ entry: blankEntry({ composer: 'Haydn', title: '76#1' }), othersFree: 'Laura (v2)' });
    assert.equal(readDraft().entry.title, '76#1');
    assert.equal(readDraft().othersFree, 'Laura (v2)');
    clearDraft();
    assert.equal(readDraft(), null);
});

test('a corrupt draft reads as none rather than breaking the form', () => {
    ls.setItem('quartetlog_draft', 'not json');
    assert.equal(readDraft(), null);
    ls.setItem('quartetlog_draft', JSON.stringify({ nothing: true }));
    assert.equal(readDraft(), null);
});

test('clearAll forgets the queue, the sitting and the draft', () => {
    // Log Out hands the browser back. All three carry player names, so
    // leaving any of them would make "log out before sharing your screen"
    // untrue.
    enqueue(entry('76#1'));
    setRecent(blankEntry({ composer: 'Haydn', title: '76#1', player1: 'Alice Hart' }));
    saveDraft({ entry: blankEntry({ composer: 'Haydn', player2: 'Bob Bek' }) });
    clearAll();
    assert.deepEqual(pending(), []);
    assert.deepEqual(recentAll(), []);
    assert.equal(readDraft(), null);
});
