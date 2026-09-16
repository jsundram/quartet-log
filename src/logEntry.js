// @ts-check
// The log form's model: what a new row holds, what the sheet will make of it,
// and what the app already knows that can fill it in. Pure and DOM-free —
// logComponent renders it, logStore persists it, the tests exercise it.
//
// Everything here exists because the app has the whole log in memory at entry
// time and Google Forms does not. That is the only real difference between
// this form and the one it replaces.
import { withInstrument } from './csvFormat.js';
import {
    SLOT_TO_PART, stripParens, instrumentFromSlot, splitOutsideParens,
    SESSION_WINDOW_HOURS, peopleKeysFor, refersToPrevEntry, parseWork,
} from './dataProcessor.js';

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

// The seats a logger can say they were on — the app's own vocabulary (howto
// section 5). It used to be formConfig's list of one user's radio options,
// which coupled what anyone could log to how the reference form was built.
//
// VC is deliberately absent: a cellist logger is not supported yet, and the
// gap is in the reader, not here. SLOT_TO_PART has no VC key and SLOT_CLASS
// hardcodes slot 3 as the cello, both of which encode "the logger is not the
// cellist" — for a cellist the other three are V1/V2/VA, so slot 3 holds a
// violist who would be aliased in the wrong class and counted in the wrong
// column. Offering the button before that is fixed would write rows the reader
// misreads; leaving it off means a cellist cannot log, which is the failure
// worth having (howto section 1 says so out loud).
export const PART_CHOICES = /** @type {const} */ (['V1', 'V2', 'VA1', 'VA2']);

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
// `Others?` is deliberately absent: the SHEET cannot ditto it, which is why
// the form carries the extras itself and writes them out on every row (see
// LogComponent.defaultOthersCell).
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
    // Trimmed on every field, not just the carried ones: toFormBody trims what
    // it submits and processRow trims what it reads back, so an untrimmed copy
    // here would describe a row the sheet does not hold. logStore.isSameRow
    // compares composer and title with ===, and a false MISS is the expensive
    // direction — it leaves the local copy shadowing the sheet for 12 hours,
    // which is exactly what defeats fixing a name in the sheet afterwards.
    for (const f of FIELDS) out[f] = (out[f] ?? '').trim();
    for (const f of CARRIED) out[f] = entry[f].trim() || carried[f] || '';
    return out;
}

/**
 * Blocking problems, as FIELD KEYS. The form validates its three required
 * questions server-side and `mode: 'no-cors'` means we never see the
 * rejection, so an unchecked submission fails silently and invisibly.
 *
 * Keys rather than labels because the caller needs both: `LABELS[f]` for the
 * message, and the field itself to mark and focus. Deriving the keys a second
 * time at the call site is how the two drift apart.
 * @param {Entry} entry @returns {string[]}
 */
export function missingFields(entry) {
    return REQUIRED_FIELDS.filter(f => !entry[f].trim());
}

// Exported because the confirmation screen raises it for any italic row in the
// SITTING, not only for the piece just submitted — one sentence, two callers.
export const PARTIAL_MOVEMENT_NOTE = 'A “:” marks a partial movement — the sheet keeps it, '
    + 'but this app leaves it out of its charts and its counts.';

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
    if (parseWork(entry.title).incomplete) out.push(PARTIAL_MOVEMENT_NOTE);
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

/**
 * The composers this log actually plays, most-played first — the chip row's
 * content, so the common case is one tap on something already on screen rather
 * than a scroll through a picker.
 *
 * Taken from the DATA, not the catalog: a composer entered through "Other"
 * earns a chip once it's played, and a catalogued one never played doesn't
 * take up a tap target. The catalog is still the full list behind "More".
 * @param {Row[]} rows @param {number} [limit] @returns {string[]}
 */
export function frequentComposers(rows, limit = 6) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const d of rows) tally(counts, d.composer);
    return byFrequency(counts).slice(0, limit);
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

// --- Slot parts -------------------------------------------------------------
//
// The three player slots are positional: which part each holds is implied by
// your own part (SLOT_TO_PART). That works until the ensemble changes shape —
// a fifth player arrives, you move from violin to viola, everyone shifts one
// seat over — and then the only way to say so was to retype the same four
// names into different columns.
//
// So the form stopped being three columns and became a roster. Every name
// field, seat or `Others?` alike, is one person and the part they played, and
// the mapping of those onto the sheet's columns is the FORM's job (rowPlan):
// whoever is on a part a column holds is written in that column, and everyone
// else is written in `Others?` with the same "(code)" annotation the sheet has
// always used. Nothing about the data at rest changes shape. What changes is
// that "he moved to va2 and she took v1" is two dropdowns rather than four
// retyped names.
//
// Both dropdowns therefore offer the same list — every part except your own,
// since the one part nobody else can be on is yours. A column still never
// carries a tag for a part it cannot hold (issue #41): the form moves that
// person to `Others?` rather than tagging the column, which is what the
// convention in howto section 5 says out loud.

/** @typedef {{ key: string, label: string, code: string, reads: string[] }} SlotPart */

// Every part a name field can be put on. VA1 and VA are distinct keys because
// the sheet writes both, and BY_KEY covers the lot: slotCell turns a key back
// into the code it writes, and partLabel back into the text a dropdown shows.
/** @type {SlotPart[]} */
const PARTS = [
    { key: 'V1', label: 'V1', code: 'v1', reads: ['v1'] },
    { key: 'V2', label: 'V2', code: 'v2', reads: ['v2'] },
    { key: 'V3', label: 'V3', code: 'v3', reads: ['v3'] },
    { key: 'V4', label: 'V4', code: 'v4', reads: ['v4'] },
    { key: 'VA', label: 'VA', code: 'va', reads: ['va', 'vla', 'viola'] },
    { key: 'VA1', label: 'VA1', code: 'va1', reads: ['va1', 'vla1', 'viola1'] },
    { key: 'VA2', label: 'VA2', code: 'va2', reads: ['va2', 'vla2', 'viola2'] },
    { key: 'VC', label: 'VC', code: 'vc', reads: ['vc', 'vc1', 'vlc', 'vlc1', 'c', 'cello', 'cello1', 'violoncello'] },
    { key: 'VC2', label: 'VC2', code: 'vc2', reads: ['vc2', 'vlc2', 'cello2'] },
    // Strings high to low, then the keyboard, then the winds. Bass is here and
    // flute is not because this log has eleven basses in it and no flutes at
    // all — the catalog is the instruments the rep actually uses, and anything
    // it lacks still round-trips as the raw code the cell holds.
    { key: 'BASS', label: 'Bass', code: 'bass', reads: ['bass', 'contrabass', 'db', 'cb'] },
    { key: 'P', label: 'Piano', code: 'p', reads: ['p', 'pf', 'pno', 'piano'] },
    { key: 'CL', label: 'Clarinet', code: 'cl', reads: ['cl', 'clar', 'clarinet'] },
];

// Every spelling the sheet is allowed to have used, to the part it names.
// Built from the catalog so a part and the words for it are declared in one
// place and cannot come apart.
const BY_SPELLING = new Map(PARTS.flatMap(p => p.reads.map(r => [r, p.key])));

const BY_KEY = new Map(PARTS.map(p => [p.key, p]));

/**
 * What an `Others?` row's dropdown offers: any part but your own.
 *
 * A name field says which PART someone played, not which column they are in —
 * rowPlan decides that from the part — so this is the whole catalog. The
 * version of this that gave a seat only the three parts its columns hold meant
 * the arrangement on screen had to be the arrangement in the sheet, so a
 * quintet, a part swap or a move from violin to viola was still typed out name
 * by name.
 *
 * Your own part is the one thing left out: you are already on it, and offering
 * it would invite a row that says two people played the same part with no way
 * to tell which of them you are. `VA1` and `VA2` are separate keys, so a second
 * violist is offered `VA1` and the first is offered `VA2`.
 *
 * Which means the **unnumbered `VA` goes with them**. On `VA1` it names the
 * same chair you are in, and `processRow` folds `VA1` to `VA` anyway, so
 * offering both records two violists on one part and no way to say which is
 * you. On `VA2` it is the first violist said vaguely, and `VA1` says it. A
 * carried `(va)` is still offered on the seat that holds it — as a
 * passthrough, like any value the list leaves out — so nothing already written
 * is rewritten.
 *
 * A fresh array every call: this is handed to a caller, and a module-level list
 * returned as-is is one any caller could sort or splice in place.
 * @param {string} part your own part
 * @returns {SlotPart[]}
 */
export function rosterParts(part) {
    const mine = OWN_SEAT[part] ?? [part];
    return PARTS.filter(p => !mine.includes(p.key));
}

/**
 * What a player COLUMN offers: the string chairs, and nothing else.
 *
 * The columns hold a quartet, and the move they have to make easy is the one
 * that actually happens between two pieces — everybody shifts within their own
 * family (v1↔v2, va1↔va2, vc1↔vc2) when a sextet reads a second sextet. Six
 * keys cover that, and after your own part comes off, four or five are on the
 * dropdown.
 *
 * Everything else is an `Others?` part and is reachable from there, including
 * the promotion back INTO a column: a pianist set to `VC` is written in the
 * cello column. What the short list costs is the other direction — moving a
 * column player OUT to a part this list lacks, which means clearing the name
 * field and adding them as an extra by hand. In this log that is the pianists
 * (8 rows in 3465, five people who play both) and an octet's `v3`/`v4` (~16
 * rows). A tap target on every row for either is the worse trade.
 *
 * A value the list lacks is still offered on the seat that holds it, as a
 * passthrough — so a legacy `(piano)` column goes on saying Piano.
 * @param {string} part your own part
 * @returns {SlotPart[]}
 */
export function seatParts(part) {
    return rosterParts(part).filter(p => SEAT_KEYS.includes(p.key));
}

// The string chairs a quartet has, plus the second viola and second cello a
// sextet adds — the parts a player column is allowed to offer.
const SEAT_KEYS = ['V1', 'V2', 'VA', 'VA2', 'VC', 'VC2'];

// Every spelling of the chair you are sitting in, for the parts that have more
// than one. Only the violas do: `VA` is either of them said vaguely.
const OWN_SEAT = {
    VA: ['VA', 'VA1'],
    VA1: ['VA', 'VA1'],
    VA2: ['VA', 'VA2'],
};

/**
 * The code an option key writes into the cell. A key the catalog does not know
 * is a raw annotation being passed through, and passes through here too.
 * @param {string|null|undefined} key
 * @returns {string|null|undefined}
 */
export function partCode(key) {
    return BY_KEY.get(/** @type {string} */ (key))?.code ?? key;
}

/**
 * The label an option key shows. The counterpart to partCode, and needed for
 * the same reason: the key a dropdown offers as a passthrough may still be one
 * the catalog knows — your own part, left out of the list — and "Piano" reads
 * better than "P".
 * @param {string} key
 * @returns {string}
 */
export function partLabel(key) {
    return BY_KEY.get(key)?.label ?? key;
}

/**
 * Which part an annotation names, or null when it says something this form
 * cannot say back — `(hn)`, `(klavier)`, `(vc Shadow)`, `(va3)`.
 *
 * **Looked up, never inferred.** Every caller here uses the answer to REWRITE
 * a cell: a seat writes its part back as a code, and an `Others?` row on a
 * column's part is moved into that column with the tag dropped. So the only
 * safe answer is one where the key says everything the text did, and the way
 * to be sure of that is to have written the spelling down (`reads`, above)
 * rather than to work it out.
 *
 * This replaced a list of prefix-matching patterns, which is where four
 * separate defects came from and every one of them silently rewrote a cell:
 * `va3` read as VA and came back as a bare name in the viola column, a third
 * violist recorded as the first; `cello2` read as VC; `vc Shadow` read as VC
 * and lost the word; `viola1` read as VA, turning the first violist into "a
 * violist". Each fix narrowed the patterns and the next one found another gap,
 * because a pattern answers for text nobody has ever written. A table answers
 * only for text somebody has.
 *
 * The reader's own classifier (`partFromInstrument`, `classOf`) still matches
 * loosely, and should: it is asking what a row MEANS for the charts, never
 * what to write back, so a near miss costs a bucket rather than a name.
 * @param {string|null|undefined} annotation
 * @returns {string|null}
 */
export function slotPartKey(annotation) {
    return BY_SPELLING.get((annotation ?? '').toLowerCase().trim()) ?? null;
}

/**
 * The part each seat holds when nothing overrides it. `VA1` is folded because
 * processRow folds it before anything downstream sees the row, so the form has
 * to read the same table the same way.
 * @param {string} part your own part, in the form's vocabulary
 * @returns {(string|null)[]}
 */
export function impliedSlotParts(part) {
    return SLOT_TO_PART[part === 'VA1' ? 'VA' : part] ?? [null, null, null];
}

/**
 * What to write in one player slot.
 *
 * The rule that makes the whole thing worth having: a part changed on a seat
 * whose name field is blank MATERIALISES the carried name, because a blank
 * cell is a ditto mark and would repeat the old part with it. That is exactly
 * the retyping this replaces — you change the part, the form writes the name.
 *
 * Conversely a cell that would come out identical to the one above is left
 * blank, so the sheet keeps dittoing as it always has and only rows that
 * actually say something new carry text.
 *
 * @param {object} a
 * @param {string} a.typed what is in the name field (blank means "as before")
 * @param {string} a.carried the cell this slot would ditto, annotation included
 * @param {string|null} a.chosen selected part key, or a raw code passed through
 * @param {string|null} a.implied the part the seat implies
 * @returns {string} the cell to submit
 */
export function slotCell({ typed, carried = '', chosen, implied }) {
    const written = (typed ?? '').trim();
    // "-" is "nobody in this seat" (howto section 5), not a person to annotate.
    if (written === '-') return '-';

    // The guard has to sit BELOW the carry fallback as well as above it: a
    // trio leaves "-" in seat 3, stripParens leaves it alone, and a part
    // picked on that empty seat would otherwise materialise it as "- (vc2)"
    // — a phantom cellist named "-" in the unique-people stats, since
    // peopleKeysFor only skips the bare "-".
    const name = written || stripParens(carried) || '';
    if (!name || name === '-') return written;

    const annotate = chosen && chosen !== implied;
    const code = partCode(chosen);
    const desired = annotate ? `${name} (${code})` : name;
    // Identical to the row above: leave it blank and let fillForward ditto,
    // which is how every row in this sheet has always been written.
    return desired === carried.trim() ? '' : desired;
}

/**
 * The name a field holds: what was typed, else what it dittos.
 * @param {string|null|undefined} typed @param {string|null|undefined} carried
 * @returns {string}
 */
function seatName(typed, carried) {
    return (typed ?? '').trim() || (stripParens(carried ?? '') ?? '').trim();
}

/**
 * What a column holds when nobody on the roster is on its part.
 *
 * It cannot be left blank: a blank is a ditto mark, so the person who just
 * moved off that part would come straight back in it. `-` is how the sheet
 * says "nobody here" (howto section 5).
 *
 * **A `-` above is not a `-` this blank would repeat.** `fillForward` skips a
 * `-` row without advancing what it repeats, so a blank under one reaches
 * PAST it to the last real name: `Dave` then `-` then blank reads back as
 * `Dave | - | Dave`. Leave the cello chair empty for a second piece and the
 * sheet puts the cellist back in it — beside the `Others?` entry the form is
 * still writing for them, one person on two parts, on every row that follows.
 * So the only cell that may be left blank is one with nothing above it at all.
 * @param {string} typed @param {string} carried
 * @returns {string}
 */
function emptyCell(typed, carried) {
    // A typed "-" is the logger saying it, and keeps its own case: a written
    // "-" and a dittoed one are different cells.
    if ((typed ?? '').trim() === '-') return '-';
    return (carried ?? '').trim() ? '-' : '';
}

/**
 * The part an `Others?` row is on — but only when the cell says exactly what a
 * dropdown writes, and carries nothing else.
 *
 * A row's part decides whether it is promoted into a column, and promotion
 * rewrites the cell: the column implies the part, so the tag goes away with
 * it. That is right when the tag says the part and NOTHING else — `vc`, and
 * equally `cello` or `violoncello`, which is what the dropdown beside it
 * already reads as VC. It is wrong the moment there is more in there to lose:
 * `Louisa (vc Shadow)` reads as a cellist, and promoting her would move her
 * into the cello column, drop the word "Shadow" and displace whoever the
 * column was dittoing. `(vc1/2)` and `(asst v2)` are the same story, and a
 * comment — `Laura (v2, shadowing on I)` — is prose, which a column has
 * nowhere to put.
 *
 * A row whose tag names no part stays put, and so does one carrying a
 * comment: prose is something a column has nowhere to put.
 * @param {OtherRow} row
 * @returns {string|null}
 */
export function othersKey(row) {
    return (row.comment ?? '').trim() ? null : slotPartKey(row.instrument);
}


/**
 * The one element, or nothing. A choice between two is not a choice.
 * @template T @param {T[]} list @returns {T|undefined}
 */
function only(list) {
    return list.length === 1 ? list[0] : undefined;
}

/** @typedef {{ name: string, key: string|null, seat: number|null, row: OtherRow|null }} Claim */

/**
 * The row the roster makes: three seat cells and the `Others?` rows.
 *
 * Every name field is a claim — this person played this part — and the sheet's
 * columns are where the form puts them. The columns are POSITIONAL and mean
 * what your own part implies, so:
 *
 *   - whoever is on a part a column holds is written in that column, with no
 *     annotation, wherever on the form they were typed. Two people swapping
 *     parts swap columns; a violinist who moved to viola moves column; a fifth
 *     player typed into `Others?` on `v1` is written in the `V1` column.
 *   - everyone else is written in `Others?` with the `(code)` the sheet has
 *     always used, which is where a second violist or a pianist belongs
 *     (howto section 5). A column never gains a tag for a part it cannot hold.
 *   - a column nobody is on is written `-`, since a blank would ditto the
 *     person who just moved off it.
 *
 * Two cases are left exactly where they were typed rather than moved. An
 * annotation no option can express (`(hn)`) is passed through on its own seat,
 * because rewriting a cell we cannot read is worse than leaving it. And when
 * two people claim one part, the one already in that column keeps it and the
 * other is annotated where it sits: a duplicate is not an arrangement, and
 * moving a third person nobody spoke about would be a guess.
 *
 * @param {object} a
 * @param {string[]} a.typed what is in each seat's name field
 * @param {string[]} a.carried the cell each seat would ditto, annotation included
 * @param {(string|null)[]} a.chosen the part each seat is on
 * @param {(string|null)[]} a.implied the part each column holds
 * @param {OtherRow[]} [a.others] the `Others?` rows, as the editor has them
 * @returns {{ cells: string[], others: OtherRow[], parts: (string|null)[], dropped: OtherRow[] }}
 *   `dropped` is the extras rows a seat of the same name superseded — said out
 *   loud, because the rule cannot tell a stale re-seed from a second person of
 *   that name and only the logger can.
 *   `parts[i]` is what the person written into column i is playing, null where
 *   nobody is. It is published rather than re-derived because the name in a
 *   column need not be the one typed there: pairing cell i with the part field
 *   i was SET to would print a swap backwards.
 */
export function rowPlan({ typed, carried, chosen, implied, others = [] }) {
    /** @type {Claim[]} */
    const claims = [];
    [0, 1, 2].forEach(i => {
        const name = seatName(typed[i], carried[i]);
        // "-" is "nobody in this seat", not a person. It holds no part, and it
        // must not out-argue someone who does.
        if (!name || name === '-') return;
        claims.push({ name, key: chosen[i] ?? null, seat: i, row: null });
    });
    others.forEach(row => {
        const name = (row.name ?? '').trim();
        if (!name) return;
        claims.push({ name, key: othersKey(row), seat: null, row });
    });

    // Before the Part row is tapped the columns mean nothing, so nothing can
    // be placed by part and nothing is moved out of a column either.
    const layout = implied.some(Boolean);
    /** @type {(Claim|null)[]} */
    const placed = [null, null, null];
    const taken = new Set();
    // The part decides the column. Where more than one person claims it, in
    // this order:
    //
    //   1. whoever is already sitting in that column — the cell dittos, and
    //      nothing moves that does not have to;
    //   2. failing that, the only SEAT claim, because after a swap nobody is
    //      "already" in the column their part now belongs to. Without this
    //      step a swap plus any second claim on one of the swapped parts
    //      evicted a column player into `Others?` with a tag and wrote `-`
    //      over the chair they were sitting in;
    //   3. failing that, the only claim there is, which is how an extra is
    //      promoted into a column.
    //
    // Two seat claims with neither in the column is genuinely under-determined
    // — nobody is placed, and both are annotated where they sit.
    implied.forEach((part, i) => {
        if (!part) return;
        const on = claims.filter(c => c.key === part);
        const pick = on.find(c => c.seat === i)
            ?? only(on.filter(c => c.seat !== null))
            ?? only(on);
        if (pick) { placed[i] = pick; taken.add(pick); }
    });
    // Everyone the parts did not place stays in the seat they were typed in —
    // no part chosen yet, an annotation this app cannot read, a duplicate
    // claim — unless the part they are on is one no column holds, which is
    // what `Others?` is for.
    claims.forEach(c => {
        if (taken.has(c) || c.seat === null || placed[c.seat]) return;
        if (layout && c.key && BY_KEY.has(c.key) && !implied.includes(c.key)) return;
        placed[c.seat] = c;
        taken.add(c);
    });

    const cells = placed.map((c, i) => (c
        ? slotCell({
            // A claim that stays in its own seat keeps that field's text
            // verbatim, so a blank goes on dittoing. One that moved is
            // materialised: the cell it lands in dittos somebody else.
            typed: c.seat === i ? typed[i] : c.name,
            carried: carried[i],
            chosen: c.key,
            implied: implied[i],
        })
        : emptyCell(typed[i], carried[i])));
    // What the person in each column is playing. For a claim the part placed
    // it is implied[i] by construction; for one left where it was typed it is
    // whatever the dropdown beside it says, which is what the cell was
    // annotated with.
    const parts = placed.map((c, i) => (c ? (c.key ?? implied[i]) : null));

    // The rows that stayed in `Others?` are passed through untouched, comment
    // and all; the seats that left are appended in seat order.
    //
    // **Nobody is written into the row twice**, and where one person has two
    // claims the SEATS win — a name the seats claim supersedes an extras row
    // of that name, whichever part each of them names, and whether the seat
    // ends in a column or is moved out of one.
    //
    // The seats win because the extras are the half that goes stale: they are
    // re-seeded from the sitting on every piece, so last piece's `Dave (va2)`
    // is still sitting there when Dave takes a chair this time, or when his
    // seat is moved to `VA2` and back out. And the two disagreeing about the
    // part is the NORMAL shape of that (in the column on `VA`, in the row on
    // `va2`), so matching them on the part is matching on the thing that
    // differs: keep both and the sheet gets one person twice — on every row
    // of the sitting, since the next piece seeds its extras from this one.
    // Dropping the stale row is the half that heals.
    //
    // A row carrying a COMMENT survives regardless: that is prose somebody
    // wrote rather than a re-seed, and the freeform box is the only other
    // place for it. The box itself is never deduped either — it is not passed
    // in here at all — and it does not need to be, because it does not
    // re-seed: what is in it was typed for the piece in front of you (see
    // LogComponent.seedOthers). And two SEAT claims of one name are both
    // written — the logger typed that name into two chairs, and there is
    // nothing to choose between them.
    // Which row is the stale one cannot be known here, only guessed, and the
    // guess is wrong when two people share a written name — a reading day with
    // two Alices, one dittoing in a column and one hand-added at the piano.
    // The log is first-name-only for fourteen people and `attribution.mjs`
    // exists because several share one, so that is a real day, not a
    // hypothesis. Hence `dropped`: the caller says out loud what was left out,
    // and the one case the rule gets wrong is a sentence on the screen rather
    // than a person missing from the sheet.
    const seatNames = new Set(claims.filter(c => c.seat !== null)
        .map(c => c.name.toLowerCase()));
    /** @type {OtherRow[]} */
    const dropped = [];
    const othersOut = others.filter(row => {
        if (claims.some(c => c.row === row && taken.has(c))) return false;   // promoted
        const stale = !(row.comment ?? '').trim()
            && seatNames.has((row.name ?? '').trim().toLowerCase());
        if (stale) dropped.push(row);
        return !stale;
    });
    const said = (/** @type {string} */ name, /** @type {string} */ code) =>
        `${name.trim().toLowerCase()} (${(code ?? '').trim().toLowerCase()})`;
    const already = new Set(othersOut.map(r => said(r.name ?? '', r.instrument ?? '')));
    claims.forEach(c => {
        if (taken.has(c) || c.seat === null) return;
        const code = /** @type {string} */ (partCode(c.key) ?? '');
        if (already.has(said(c.name, code))) return;
        already.add(said(c.name, code));
        othersOut.push({ name: c.name, instrument: code, comment: '' });
    });
    // Every dropped row is reported, including one a demoted seat then
    // re-appends word for word. That case reads oddly — the cell does hold the
    // text — but it cannot be told from the case this exists for: a second
    // person of that name, whose row is gone and whose replacement text
    // belongs to somebody else. The two are identical strings and differ only
    // in who they mean, which is the same thing `attribution.mjs` exists to
    // decide and cannot be decided here. Noise beats silence, the preview
    // shows the row beside the note, and the note says which row was removed
    // rather than claiming the text is absent.
    return { cells, others: othersOut, parts, dropped };
}

/**
 * The seat parts after one seat is set to `key`.
 *
 * The three columns hold three different parts, so a part taken from another
 * seat hands that seat the one this one gave up: changing a single dropdown
 * says "these two swapped", which is the thing that happens. Left alone, the
 * sheet gets a row with two second violins and no first — and rowPlan can only
 * annotate that, because a duplicate is not an arrangement of anything.
 *
 * That hand-back is a trade, so it needs TWO chairs: the part given up and the
 * part taken both have to be ones the columns hold. A part that is a person's
 * rather than a chair's — `P`, `VA2`, `VC2`, a code this app cannot read — is
 * nobody's to trade, and handing it either direction records an instrument
 * somebody never played, with their name field untouched:
 *
 *   - give one away: move the pianist's seat to V2, and the person already on
 *     V2 is now the pianist — written into `Others?` as one.
 *   - take one: move a seat onto the second violist's `VA2`, and SHE is written
 *     `(v1)` — the same bug mirrored, and the one this guard first missed.
 *
 * `VC2` is worse than wrong data, since `classOf` reads it as the cello class
 * and a bare first name there can normalize to a different person entirely.
 * Either way the other seat keeps the part it was on, and rowPlan annotates the
 * duplicate claim where it sits.
 *
 * A part no other seat holds displaces nothing; that seat is simply on it now.
 * Neither does one that two other seats hold: from an already-duplicated state
 * (a legacy row can carry one in) there is no single partner to trade with, and
 * picking the first would move a third person nobody spoke about.
 *
 * @param {object} a
 * @param {(string|null)[]} a.chosen the part each seat is on
 * @param {(string|null)[]} a.implied the part each column holds
 * @param {number} a.seat the seat being changed
 * @param {string} a.key the part it is being set to
 * @returns {(string|null)[]}
 */
export function setSlotPart({ chosen, implied, seat, key }) {
    const next = [...chosen];
    next[seat] = key;
    const vacated = chosen[seat];
    const clashes = chosen.filter((p, j) => j !== seat && p === key);
    const partner = chosen.findIndex((p, j) => j !== seat && p === key);
    // Before the Part row is tapped no seat is on anything: the partner goes
    // back to holding nothing, which slotParts reads as "whatever the seat
    // implies" — the right answer either way.
    const trade = clashes.length === 1
        && (!vacated || (implied.includes(vacated) && implied.includes(key)));
    if (trade) next[partner] = vacated;
    return next;
}

/**
 * The part each slot should show before the user touches anything: whatever
 * the carried cell says, falling back to the seat's own implication. Reading
 * the carried annotation is what makes a role stick across a session — a
 * violinist moved to V2 stays on V2 for the next piece, like their name does.
 * @param {Entry} carried carriedForward() output, annotations attached
 * @param {string} part your own part
 * @returns {(string|null)[]}
 */
export function defaultSlotParts(carried, part) {
    const implied = impliedSlotParts(part);
    return ['player1', 'player2', 'player3'].map((f, i) => {
        const annotation = instrumentFromSlot(carried[f]);
        // An annotation no option can express is passed through as itself, so
        // submitting cannot rewrite it into something else. Both halves of the
        // form ask slotPartKey, which answers only for spellings the catalog
        // has written down — see the note there.
        return annotation ? (slotPartKey(annotation) ?? annotation) : implied[i];
    });
}

// --- Others? rows -----------------------------------------------------------
//
// `Others?` has always been free text of the shape "Name (instrument, comment)",
// and the app reads the instrument for both aliasing and the part breakdown. It
// was still hand-typed after the seats gained a part control, which made the
// one column where a pianist or a second cellist is MOST likely to appear the
// only one where saying so meant remembering the syntax.
//
// These parse and re-serialise that text losslessly. `parseOthers` in
// dataProcessor deliberately discards the comment half — it only wants the
// instrument — so an editor built on it would silently delete "(vc, doubling
// on IV)" the first time a row was touched. This keeps all three parts.

/** @typedef {{ name: string, instrument: string, comment: string }} OtherRow */

/**
 * @param {string|null|undefined} others
 * @returns {OtherRow[]}
 */
export function parseOthersRows(others) {
    if (!others) return [];
    // The same entry boundaries the app uses, paren-aware, so a comma inside
    // an annotation cannot tear an entry in half.
    return splitOutsideParens(others)
        .map(s => s.trim())
        .filter(s => s && s !== '-')
        .map(s => {
            const m = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
            if (!m) return { name: s, instrument: '', comment: '' };
            const inside = m[2];
            const comma = inside.indexOf(',');
            return {
                name: m[1].trim(),
                instrument: (comma >= 0 ? inside.slice(0, comma) : inside).trim(),
                comment: comma >= 0 ? inside.slice(comma + 1).trim() : '',
            };
        });
}

/**
 * Back to the cell. Semicolons between entries (the convention the column has
 * always used), and the instrument/comment pair rebuilt in the order the
 * reader expects.
 * @param {OtherRow[]} rows
 * @returns {string}
 */
export function serializeOthersRows(rows) {
    return rows
        .map(r => ({
            name: (r.name ?? '').trim(),
            inside: [(r.instrument ?? '').trim(), (r.comment ?? '').trim()].filter(Boolean).join(', '),
        }))
        // A row with no name is one the user started and left; it says nothing.
        .filter(r => r.name)
        .map(r => (r.inside ? `${r.name} (${r.inside})` : r.name))
        .join('; ');
}

/**
 * A row's `Others?` cell with each name in its canonical form.
 *
 * The raw cell is what normalizePlayerNames deliberately leaves alone (the
 * CSV-download path wants it untouched), while sessionPeople offers the
 * canonical names from `othersList`. Seeding the rows from the raw text makes
 * the two disagree exactly where PLAYER_ALIASES does its job: the chip for
 * "Peter Ouyang" is offered although "Pete" is already on the row, and tapping
 * it writes the same person in twice — over-counting the ensemble, which is
 * what audit_ensembles and attribution exist to chase. It cannot fail in CI or
 * in the e2e, where src/aliases.js is the empty stub and the two views are
 * identical; it fires only on a device with a populated table.
 *
 * Positional, because both parsers split the same string with the same
 * paren-aware boundaries and the same filter, so entry i is entry i. The
 * comments only the raw cell carries are kept; a length mismatch means an
 * assumption broke, and the raw cell is then the honest answer.
 */
export function canonicalOthersCell(/** @type {any} */ row) {
    const raw = parseOthersRows(row?.others ?? '');
    const canon = row?.othersList ?? [];
    if (!raw.length || raw.length !== canon.length) return row?.others ?? '';
    return serializeOthersRows(raw.map((r, i) => ({ ...r, name: canon[i].name || r.name })));
}

/**
 * The rows the editor can express, and the text it cannot.
 *
 * A row is a name and an instrument. An entry carrying a COMMENT — "Laura
 * (v2, shadowing on I)" — has prose in it, and prose wants a text field, not a
 * dropdown. Rather than drop the comment or grow a third control per row,
 * those entries go to the freeform box verbatim and are merged back at write
 * time, so every shape the column has ever held survives a round trip.
 * @param {string|null|undefined} others
 * @returns {{ rows: OtherRow[], freeform: string }}
 */
export function splitOthersCell(others) {
    const all = parseOthersRows(others);
    return {
        rows: all.filter(r => !r.comment),
        freeform: serializeOthersRows(all.filter(r => r.comment)),
    };
}

/**
 * @param {OtherRow[]} rows
 * @param {string} freeform
 * @returns {string} the Others? cell
 */
export function mergeOthersCell(rows, freeform) {
    return [serializeOthersRows(rows), (freeform ?? '').trim()]
        .filter(Boolean).join('; ');
}

/**
 * The rows belonging to the sitting that is still going: walk back from the
 * newest while each gap stays inside the window, the same chain fillForward
 * follows. Empty once the last row is older than the window, because then
 * there is no session to be in.
 * Generic in the row shape because it reads nothing but `timestamp`: the same
 * loop windows the fetched rows and the merged piece list the confirmation
 * screen builds, rather than that list getting a second copy of this walk.
 * @template {{ timestamp: Date|null }} T
 * @param {T[]} rows chronological, as prepareRows leaves them
 * @param {Date} [now]
 * @param {number} [windowHours]
 * @returns {T[]}
 */
export function sessionRows(rows, now = new Date(), windowHours = SESSION_WINDOW_HOURS) {
    const span = windowHours * 3600_000;
    /** @type {T[]} */
    const out = [];
    let edge = now.getTime();
    for (let i = rows.length - 1; i >= 0; i--) {
        const at = rows[i].timestamp?.getTime();
        if (at == null || edge - at > span) break;
        out.unshift(rows[i]);
        edge = at;
    }
    return out;
}

/**
 * Who is already here, most recently seen first, with whatever instrument they
 * were last logged on. The second sextet of an afternoon has the same people
 * as the first, and asking someone to retype them is the same failure as
 * asking them to retype a seat.
 * @param {Row[]} rows @param {Date} [now]
 * @returns {{ name: string, instrument: string }[]}
 */
export function sessionPeople(rows, now = new Date()) {
    /** @type {Map<string, string>} */
    const seen = new Map();
    // Delete before set: a Map keeps FIRST-insertion order, so re-seeing
    // someone would otherwise leave them where they first appeared and the
    // list would be ordered by first sighting, not last.
    const note = (/** @type {string} */ name, /** @type {string} */ instrument) => {
        seen.delete(name);
        seen.set(name, instrument);
    };
    for (const d of sessionRows(rows, now)) {
        for (const name of [d.player1, d.player2, d.player3]) {
            const s = (name ?? '').trim();
            if (s && s !== '-') note(s, '');
        }
        // Others? last within a row, so someone logged both ways keeps the
        // instrument that entry named rather than the seat's blank.
        for (const o of d.othersList ?? []) {
            if (o.name) note(o.name, o.instrument ?? '');
        }
    }
    return [...seen].reverse().map(([name, instrument]) => ({ name, instrument }));
}

/**
 * A piece of the current sitting, from either side of the lag.
 * @typedef {Object} Piece
 * @property {Date} timestamp
 * @property {string} composer
 * @property {string} title
 * @property {string} part
 * @property {string[]} people - everyone on the row, seats and Others? alike
 * @property {boolean} landed - is it in the app's copy of the sheet yet
 * @property {boolean} partial - a movement rather than a whole piece, so the
 *   app's copy will never hold it however long anyone waits
 * @property {boolean} queued - still in the outbox, not yet sent
 */

// VA1 is a spelling of VA, folded by processRow on the way in. A local
// submission has not been through processRow, so fold it here or the same
// seat reads as two different parts either side of the lag.
const foldPart = (/** @type {string} */ part) => (part.trim() === 'VA1' ? 'VA' : part.trim());

const workKey = (/** @type {string} */ composer, /** @type {string} */ title) =>
    (title ? `${composer}|${title}` : null);

// How a piece is recognised as "the same one" across the three records that
// hold it. Trimmed, because they do not agree on whitespace: the outbox holds
// the entry as TYPED (blanks left blank, so the sheet's own fillForward dittos
// them) while the sitting record holds `resolveCarry`'s output, which trims
// every field. A title typed with a trailing space matched neither the queue
// nor itself, and a piece still on the device was painted as sent.
const pieceKey = (/** @type {string} */ composer, /** @type {string} */ title) =>
    `${(composer ?? '').trim()}|${(title ?? '').trim()}`;

/**
 * The pieces logged in the sitting so far: the rows the app already has, plus
 * the submissions this device made that the published sheet has not caught up
 * with. One list, oldest first, each piece saying which side of the lag it is
 * on — which is the whole point, since "it is saved but not showing yet" is
 * the thing the form has never been able to say.
 *
 * A submission is paired off against a fetched row by composer and title, one
 * for one: pairing by identity alone would hide the second reading of a piece
 * played twice in an evening behind the first one's row. Only the pieces the
 * window keeps are paired, so a submission from this morning that the sheet
 * never took is neither dragged into tonight nor allowed to claim one of
 * tonight's rows.
 *
 * @param {Row[]} rows the app's own rows, chronological
 * @param {{ at: number, entry: Entry }[]} submissions store.recentAll(), oldest first
 * @param {{ entry: Entry }[]} [queued] store.pending(), oldest first — what has
 *   not left the device. A partial movement is never in `rows`, so this is the
 *   only thing that can say whether it got anywhere.
 * @param {Date} [now]
 * @returns {Piece[]}
 */
export function sessionPieces(rows, submissions, queued = [], now = new Date()) {
    // Window the two sources TOGETHER, on timestamps alone. The chain can run
    // back THROUGH a submission the sheet has not taken yet: log a piece
    // offline at 17:30 and the fetched row from 14:00 is more than a window
    // away from 20:00, but not from the piece bridging them. Windowing the
    // fetched rows on their own first dropped exactly those rows — the same
    // sitting, reported short. Every row becomes a mark, but only the marks
    // the chain keeps are read for their people and their work, which is the
    // part that costs anything.
    /** @type {{ timestamp: Date|null, row: Row|null, sub: { at: number, entry: Entry }|null }[]} */
    const marks = [
        ...rows.map(d => ({ timestamp: d.timestamp, row: d, sub: null })),
        ...submissions.map(s => ({ timestamp: new Date(s.at), row: null, sub: s })),
        // A row whose timestamp never parsed sorts to the front, where the
        // walk below stops at it exactly as it always did.
    ].sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));

    /** @type {Piece[]} */
    const landed = [];
    /** @type {{ at: number, entry: Entry }[]} */
    const sent = [];
    for (const m of sessionRows(marks, now)) {
        if (m.row) {
            landed.push({
                // sessionRows stops at the first mark without a timestamp, so
                // everything it returns has one — which tsc cannot see.
                timestamp: /** @type {Date} */ (m.timestamp),
                composer: m.row.composer,
                title: m.row.work?.title ?? '',
                part: m.row.part ?? '',
                people: peopleKeysFor(m.row),
                landed: true,
                partial: parseWork(m.row.work?.title ?? '').incomplete,
                queued: false,
            });
        } else if (m.sub) {
            sent.push(m.sub);
        }
    }
    // How many fetched rows each (composer, title) has this sitting. Each one
    // accounts for exactly one submission; the rest are still on their way.
    /** @type {Map<string, number>} */
    const accounted = new Map();
    for (const p of landed) {
        const k = pieceKey(p.composer, p.title);
        accounted.set(k, (accounted.get(k) ?? 0) + 1);
    }
    /** @type {Piece[]} */
    const waiting = [];
    for (const { at, entry } of sent) {
        const k = pieceKey(entry.composer, entry.title);
        const seen = accounted.get(k) ?? 0;
        if (seen > 0) { accounted.set(k, seen - 1); continue; }
        waiting.push({
            timestamp: new Date(at),
            composer: entry.composer,
            title: entry.title,
            part: foldPart(entry.part),
            people: [
                ...[entry.player1, entry.player2, entry.player3]
                    .map(n => (stripParens(n) ?? '').trim()).filter(n => n && n !== '-'),
                ...parseOthersRows(entry.others).map(r => r.name).filter(Boolean),
            ],
            landed: false,
            partial: parseWork(entry.title).incomplete,
            queued: false,
        });
    }
    // Which of those are still in the outbox. Counted rather than matched by
    // identity, for the same reason the pairing above is: two readings of one
    // piece in an evening share a key. Consumed NEWEST first, because flush
    // sends oldest first — with one of two copies gone, the one still waiting
    // is the later one.
    /** @type {Map<string, number>} */
    const inOutbox = new Map();
    for (const q of queued) {
        const k = pieceKey(q.entry.composer, q.entry.title);
        inOutbox.set(k, (inOutbox.get(k) ?? 0) + 1);
    }
    for (let i = waiting.length - 1; i >= 0; i--) {
        const k = pieceKey(waiting[i].composer, waiting[i].title);
        const n = inOutbox.get(k) ?? 0;
        if (n > 0) { inOutbox.set(k, n - 1); waiting[i].queued = true; }
    }
    return [...landed, ...waiting].sort((a, b) => +a.timestamp - +b.timestamp);
}

// Does the log already know this person under this name? Exact match, or the
// name is a word-boundary prefix of one it holds — the same test fillForward
// uses to decide that "Alice" written under "Alice Hart" is the same person.
// It is what keeps a carried-forward first name out of the new-people count
// without this module reaching for the alias table, which is deliberately not
// available outside the two wiring points that own it.
function knownPerson(/** @type {string} */ name, /** @type {Set<string>} */ known) {
    if (known.has(name)) return true;
    for (const n of known) if (refersToPrevEntry(name, n)) return true;
    return false;
}

/**
 * What these pieces add to the log's aggregate counts, measured against rows
 * that do not contain them.
 *
 * The same shape `computeAggregateStats` reports, and keyed the same way
 * (untitled works count for nothing, a part counts per work, a partial
 * movement counts for nothing at all because `processData` drops it), so the
 * number under a tile and the number on it are answering one question. Used twice:
 * for what a sitting added to the totals, and for what the submissions the
 * sheet has not published yet would add if it had.
 *
 * @param {Piece[]} pieces
 * @param {Row[]} baseRows the log without them
 * @returns {{ pieces: number, uniquePieces: number, uniqueParts: number, uniquePeople: number }}
 */
export function countNew(pieces, baseRows) {
    const works = new Set();
    const parts = new Set();
    // A Set, not a list: knownPerson scans it once per candidate, and the
    // regulars appear on hundreds of rows.
    const people = new Set();
    for (const d of baseRows) {
        for (const name of peopleKeysFor(d)) people.add(name);
        const wk = workKey(d.composer, d.work?.title ?? '');
        if (!wk) continue;
        works.add(wk);
        if (d.part) parts.add(`${wk}|${d.part}`);
    }
    const out = { pieces: 0, uniquePieces: 0, uniqueParts: 0, uniquePeople: 0 };
    for (const p of pieces) {
        // A movement reaches the sheet and is then dropped from every view in
        // this app. Counting it here would leave the tiles permanently one
        // ahead of the dashboard they are borrowed from.
        if (p.partial) continue;
        out.pieces++;
        const wk = workKey(p.composer, p.title);
        if (wk) {
            if (!works.has(wk)) { works.add(wk); out.uniquePieces++; }
            if (p.part && !parts.has(`${wk}|${p.part}`)) { parts.add(`${wk}|${p.part}`); out.uniqueParts++; }
        }
        for (const name of p.people) {
            if (knownPerson(name, people)) continue;
            people.add(name);
            out.uniquePeople++;
        }
    }
    return out;
}
