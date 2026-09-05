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

/**
 * The last row submitted from this device, as the sheet will hold it (blanks
 * already resolved against what they dittoed). Read back as the carry-forward
 * source while it is newer than anything in the fetched data — between a
 * submit and the published CSV catching up, this device knows more than the
 * sheet does.
 * @param {Entry} resolved
 */
export function setRecent(resolved) {
    write(RECENT_KEY, { at: Date.now(), entry: resolved });
}

/**
 * @param {Date|null|undefined} dataThrough timestamp of the newest fetched row
 * @returns {Entry|null} the local submission the data hasn't caught up to yet
 */
export function recent(dataThrough) {
    const saved = read(RECENT_KEY, null);
    if (!saved?.entry) return null;
    if (dataThrough && dataThrough.getTime() >= saved.at) return null;
    return blankEntry(saved.entry);
}
