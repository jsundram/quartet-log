// @ts-check
// The log form's two pieces of local state: entries waiting for a network, and
// the last row this device submitted. Both are localStorage, both survive the
// app being closed between two pieces of the same session — which on a phone
// in a rehearsal room is the normal case, not the edge one.
import { blankEntry } from './logEntry.js';

/** @typedef {import('./logEntry.js').Entry} Entry */
/** @typedef {{ id: string, at: number, entry: Entry }} Queued */

const PENDING_KEY = 'quartetlog_pending';
const RECENT_KEY = 'quartetlog_recent';

// Every read is defensive: localStorage throws in private-mode Safari and can
// hold whatever a previous version wrote. A log form that refuses to open
// because its queue didn't parse would be worse than one that forgets.
/** @param {string} key @param {unknown} fallback */
function read(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
}

/** @param {string} key @param {unknown} value @returns {boolean} */
function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
}

/** @returns {Queued[]} */
export function pending() {
    const list = read(PENDING_KEY, []);
    return Array.isArray(list) ? list : [];
}

/** @param {Entry} entry @returns {Queued[]} */
export function enqueue(entry) {
    const list = [...pending(), { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), entry }];
    write(PENDING_KEY, list);
    return list;
}

/** @param {string} id @returns {Queued[]} */
export function drop(id) {
    const list = pending().filter(q => q.id !== id);
    write(PENDING_KEY, list);
    return list;
}

/**
 * Send what's queued, oldest first, stopping at the first failure.
 *
 * Order is the whole contract: fillForward reads each row against the one
 * above it, so a queue that flushed out of order would hand the sheet a blank
 * seat pointing at the wrong previous row — silent, and wrong in exactly the
 * way the log is least able to notice. Sequential, and persisted after each
 * success so an interrupted flush never resends.
 *
 * The sheet timestamps a row when it ARRIVES, so a queued entry lands at flush
 * time rather than play time. Nothing is written into Comments to compensate —
 * that field is the user's — but each entry keeps its own `at` so the UI can
 * show what is waiting and how long it has been.
 *
 * @param {(entry: Entry) => Promise<void>} post
 * @returns {Promise<{ sent: number, remaining: number }>}
 */
export async function flush(post) {
    const list = pending();
    let sent = 0;
    while (list.length) {
        try { await post(list[0].entry); } catch { break; }
        list.shift();
        sent++;
        write(PENDING_KEY, list);
    }
    return { sent, remaining: list.length };
}

// How long a submission the sheet never took delivery of goes on describing
// the last row. Only reachable when a send was accepted by the transport and
// dropped by Forms anyway (a required field the client thought was filled) —
// the opaque response can't tell us, so the copy expires on its own rather
// than describing a row that does not exist forever.
const RECENT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_RECENT = 60;

/**
 * Submissions made from this device, oldest first.
 *
 * A list rather than just the last one, because the session-people offer is
 * only as deep as this: the published CSV lags by minutes and a sitting logs
 * several pieces in that time, so remembering one row would leave the app
 * blind to the people it most wants to offer back — the second sextet of an
 * afternoon has the first one's players.
 *
 * Entries are as the sheet will hold them (blanks already resolved against
 * what they dittoed), pruned by age on write.
 * @returns {{ at: number, entry: Entry }[]}
 */
function recentList() {
    const saved = read(RECENT_KEY, []);
    // A single object is what earlier versions stored; take it as a list of one
    // rather than dropping a submission on upgrade.
    const list = Array.isArray(saved) ? saved : (saved?.entry ? [saved] : []);
    const floor = Date.now() - RECENT_MAX_AGE_MS;
    return list.filter(r => r?.entry && r.at > floor);
}

/** @param {Entry} resolved */
export function setRecent(resolved) {
    // Capped as well as aged: a long day of logging should not grow the record
    // without bound, and nothing reads further back than the session anyway.
    write(RECENT_KEY, [...recentList(), { at: Date.now(), entry: resolved }].slice(-MAX_RECENT));
}

/**
 * Every remembered submission, as entries with their save times. Callers that
 * ask "who has been here this sitting" need all of them.
 * @returns {{ at: number, entry: Entry }[]}
 */
export function recentAll() {
    return recentList().map(r => ({ at: r.at, entry: blankEntry(r.entry) }));
}

// Is this fetched row the submission we saved? Composer and work title only:
// both are required, so both are always written, while `part` is folded on the
// way in (processRow turns VA1 into VA) and comparing it would report a
// mismatch for every viola row. A false match only means preferring the sheet,
// which is the safe direction; a false MISS is the one that hurts, because it
// leaves the local copy shadowing the sheet.
/** @param {any} row @param {Entry} entry */
function isSameRow(row, entry) {
    return row?.composer === entry.composer && row?.work?.title === entry.title;
}

/**
 * The newest submission the fetched data hasn't caught up to yet, or null once
 * it has.
 *
 * "Caught up" is identity, never the clock. Forms timestamps a row when it
 * RECEIVES it and this device saves a moment later, so the row is always a
 * hair older than the save and "is the sheet newer than my copy" is never true
 * — which left the local copy permanently shadowing the sheet. That matters
 * beyond staleness: correcting a name in the sheet afterwards is the
 * established fix for a typo or a surname learned later, and the placeholder
 * has to show the correction rather than what was originally typed.
 *
 * Returns the save time alongside the entry: callers that ask "is this still
 * the same sitting" need it, and a synthetic `now` would make a submission
 * from this morning look like one from a minute ago.
 *
 * @param {any} lastRow newest row in the fetched data (a processed Row)
 * @returns {{ entry: Entry, at: number }|null}
 */
export function recent(lastRow) {
    const saved = recentList().at(-1);
    if (!saved) return null;
    if (lastRow && isSameRow(lastRow, saved.entry)) return null;
    return { entry: blankEntry(saved.entry), at: saved.at };
}
