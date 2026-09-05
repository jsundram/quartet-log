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
    SESSION_WINDOW_HOURS,
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
// section 5), not a form's option list. formConfig.CHOICES.part happens to
// hold the same four today, but that one describes ONE user's radio question
// and this describes the button row every user sees; driving the UI from the
// former couples what anyone can log to what the reference form was built
// with.
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
// your own part (SLOT_TO_PART). That works until two people swap, or a quintet
// puts a second viola or cello on the stand — and then the only way to say so
// was to retype names into different columns.
//
// The form instead offers a part per slot. The names stay put and carry
// forward as ever; the part is written as the SAME "(code)" annotation the
// sheet has always used, so nothing about the data at rest changes shape.
// Only the codes the app can actually read back are offered: partFromInstrument
// buckets into V1/V2/VA/VC/OTHER, folding va1|va2 to VA and vc1|vc2 to VC. The
// numbered forms are still worth offering, because the SHEET keeps the
// distinction even where the charts group it — that is the point of writing
// them for a quintet.

/** @typedef {{ key: string, label: string, code: string }} SlotPart */

/** @type {SlotPart[]} */
export const SLOT_PARTS = [
    { key: 'V1', label: 'V1', code: 'v1' },
    { key: 'V2', label: 'V2', code: 'v2' },
    { key: 'VA', label: 'VA', code: 'va' },
    { key: 'VA2', label: 'VA2', code: 'va2' },
    { key: 'VC', label: 'VC', code: 'vc' },
    { key: 'VC2', label: 'VC2', code: 'vc2' },
    { key: 'P', label: 'Piano', code: 'p' },
];

const BY_KEY = new Map(SLOT_PARTS.map(p => [p.key, p]));

/**
 * Which option an existing annotation corresponds to, or null when the sheet
 * carries something this list cannot express (`(cl)`, `(hn)`). Null matters:
 * re-serialising an annotation we cannot represent would silently rewrite it,
 * so the caller offers the raw code as its own option instead.
 * @param {string|null|undefined} annotation
 * @returns {string|null}
 */
export function slotPartKey(annotation) {
    const s = (annotation ?? '').toLowerCase().trim();
    if (!s) return null;
    if (/^vc2|^vlc2/.test(s)) return 'VC2';
    if (/^(?:vc|vlc|cello|violoncello|c)(?![a-z])/.test(s)) return 'VC';
    if (/^va2|^vla2/.test(s)) return 'VA2';
    if (/^(?:vla|viola|va)(?![a-z])/.test(s)) return 'VA';
    if (/^v1/.test(s)) return 'V1';
    if (/^v2/.test(s)) return 'V2';
    if (/^(?:p|pf|pno|piano)(?![a-z])/.test(s)) return 'P';
    return null;
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
    const code = BY_KEY.get(/** @type {string} */ (chosen))?.code ?? chosen;
    const desired = annotate ? `${name} (${code})` : name;
    // Identical to the row above: leave it blank and let fillForward ditto,
    // which is how every row in this sheet has always been written.
    return desired === carried.trim() ? '' : desired;
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
        // An annotation this list cannot express is passed through as itself,
        // so submitting cannot rewrite it into something else.
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
 * @param {Row[]} rows chronological, as prepareRows leaves them
 * @param {Date} [now]
 * @param {number} [windowHours]
 * @returns {Row[]}
 */
export function sessionRows(rows, now = new Date(), windowHours = SESSION_WINDOW_HOURS) {
    const span = windowHours * 3600_000;
    /** @type {Row[]} */
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
