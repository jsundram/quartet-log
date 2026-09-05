// @ts-check
// The log form's model: what a new row holds, what the sheet will make of it,
// and what the app already knows that can fill it in. Pure and DOM-free —
// logComponent renders it, logStore persists it, the tests exercise it.
//
// Everything here exists because the app has the whole log in memory at entry
// time and Google Forms does not. That is the only real difference between
// this form and the one it replaces.
import { withInstrument } from './csvFormat.js';

/** @typedef {import('./dataProcessor.js').Row} Row */
/** @typedef {Record<string, string>} Entry */

// The sheet's columns after Timestamp, in sheet order. The order is
// load-bearing twice over: it is the order Forms asks its questions in, which
// is how parsePrefilledLink maps entry ids to columns, and LABELS below must
// stay in step with CSV_HEADERS (test/logEntry.test.mjs pins both).
export const FIELDS = /** @type {const} */ ([
    'composer', 'title', 'part', 'player1', 'player2', 'player3',
    'others', 'location', 'comments',
]);

// The form's own required questions. Forms enforces them server-side and the
// opaque response means a rejection is invisible, so the client mirrors them.
export const REQUIRED_FIELDS = /** @type {const} */ (['composer', 'title', 'part']);

// Sheet columns, for messages that have to name a field the user can see.
export const LABELS = {
    composer: 'Composer', title: 'Work Title', part: 'Which Part',
    player1: 'Player 1', player2: 'Player 2', player3: 'Player 3',
    others: 'Others?', location: 'Location', comments: 'Comments',
};

// The fields fillForward repeats from the row above when left blank.
// `Others?` is deliberately absent — see othersReminder.
export const CARRIED = /** @type {const} */ (['player1', 'player2', 'player3', 'location']);

/** @param {Partial<Entry>} [seed] @returns {Entry} */
export function blankEntry(seed = {}) {
    return Object.fromEntries(FIELDS.map(f => [f, seed[f] ?? ''])); }

/**
 * What a blank field in this entry will end up meaning. fillForward reads a
 * blank player or location cell as a ditto mark for the row above (howto §6),
 * so the honest thing to show is not a pre-filled input the user must clear
 * but the value that arrives if they type nothing — placeholder text over an
 * input that submits empty, exactly as writing the row by hand would.
 * @param {Row|Entry|null|undefined} last
 * @returns {Entry}
 */
export function carriedForward(last) {
    if (!last) return blankEntry();
    // A Row has had its "(instrument)" annotations split off into a parallel
    // array; re-attach them so the placeholder shows the cell as it was typed.
    const ann = /** @type {Row} */ (last).playerInstruments ?? [];
    const slot = (/** @type {string} */ f, /** @type {number} */ i) =>
        withInstrument(/** @type {Record<string, string>} */ (last)[f] ?? '', ann[i]) ?? '';
    return blankEntry({
        player1: slot('player1', 0),
        player2: slot('player2', 1),
        player3: slot('player3', 2),
        location: /** @type {Record<string, string>} */ (last).location ?? '',
    });
}

/**
 * What the sheet will hold once fillForward has run: a blank seat takes the
 * carried value, a written one replaces it. The app needs this to keep its own
 * placeholders honest between a submit and the sheet catching up — the
 * published CSV lags by minutes, and the next piece of a session is logged in
 * seconds.
 * @param {Entry} entry @param {Entry} carried @returns {Entry}
 */
export function resolveCarry(entry, carried) {
    const out = blankEntry(entry);
    for (const f of CARRIED) out[f] = entry[f].trim() || carried[f] || '';
    return out;
}

/**
 * The one thing that does NOT repeat. `Others?` is per-row, so a fifth player
 * has to be retyped on every piece they played; howto §6 calls this the single
 * most common way someone goes missing from the log, and it is what
 * `npm run audit` looks for first. The form is the only place that can ask
 * before the row is written rather than months after.
 * @param {Entry} entry @param {Row|Entry|null|undefined} last
 * @returns {string|null} the previous row's Others? cell, when it's worth re-offering
 */
export function othersReminder(entry, last) {
    const prev = (/** @type {Record<string, string>} */ (last)?.others ?? '').trim();
    return prev && prev !== '-' && !entry.others.trim() ? prev : null;
}

/**
 * Blocking problems, as field labels. The form validates its three required
 * questions server-side and `mode: 'no-cors'` means we never see the
 * rejection, so an unchecked submission fails silently and invisibly.
 * @param {Entry} entry @returns {string[]}
 */
export function missingFields(entry) {
    return REQUIRED_FIELDS.filter(f => !entry[f].trim())
        .map(f => /** @type {Record<string, string>} */ (LABELS)[f]);
}

/**
 * Non-blocking things worth saying out loud before the row is written.
 * @param {Entry} entry @returns {string[]}
 */
export function warnings(entry) {
    const out = [];
    // processData drops titles containing ':' as partial movements, so the row
    // reaches the sheet and then vanishes from every view in this app. That is
    // correct behaviour and a genuine surprise; say so rather than let the
    // piece look unlogged.
    if (entry.title.includes(':')) {
        out.push('A “:” marks a partial movement — the sheet keeps it, this app hides it.');
    }
    return out;
}

// Autocomplete sources, most-used first: a datalist renders in list order, and
// the people you play with weekly should not sit below the ones you met once.
/** @param {Map<string, number>} counts @returns {string[]} */
function byFrequency(counts) {
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

/** @param {Map<string, number>} counts @param {string|null|undefined} name */
function tally(counts, name) {
    const s = (name ?? '').trim();
    // "-" is "nobody in this seat" (fillForward), not a person.
    if (s && s !== '-') counts.set(s, (counts.get(s) ?? 0) + 1);
}

/**
 * Every name the log knows, seats and `Others?` alike — a pianist logged in
 * Others? is exactly as retypeable as a violinist in a seat. Names are the
 * canonical post-alias forms, so picking one from the list is what stops the
 * bare-first-name ambiguity that scripts/attribution.mjs exists to chase.
 * @param {Row[]} rows @returns {string[]}
 */
export function knownPlayers(rows) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const d of rows) {
        tally(counts, d.player1); tally(counts, d.player2); tally(counts, d.player3);
        for (const o of d.othersList ?? []) tally(counts, o.name);
    }
    return byFrequency(counts);
}

/** @param {Row[]} rows @returns {string[]} */
export function knownLocations(rows) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const d of rows) tally(counts, d.location);
    return byFrequency(counts);
}

/**
 * What to leave on screen after a successful submit. A session is logged piece
 * by piece, so the fields that describe the SESSION (composer, part, where you
 * are) stay and the ones that describe the PIECE clear. The seats clear too —
 * blank means "same people", which is both the truth and the shortest path to
 * the next row.
 * @param {Entry} entry @returns {Entry}
 */
export function nextInSession(entry) {
    return blankEntry({ composer: entry.composer, part: entry.part });
}
