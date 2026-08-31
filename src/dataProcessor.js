// @ts-check

/**
 * Parsed "Work Title" cell (parseWork output).
 * @typedef {Object} Work
 * @property {string} title - the raw sheet title, e.g. "76#2" or "17#2:I"
 * @property {number} catalog - opus/K./D. number; NaN when unparseable
 * @property {number|null} number - number within the opus ("#N"), or null
 * @property {boolean} incomplete - title contains ":" (partial movements)
 */

/**
 * Parsed "Others?" entry (parseOthers output; `class` added at
 * normalizePlayerNames time).
 * @typedef {Object} OtherPlayer
 * @property {string} name
 * @property {string|null} instrument - the code inside "(...)", or null
 * @property {'upper'|'cello'|null} [class] - classOf(instrument)
 */

/**
 * One processed play row — the canonical shape flowing through the whole
 * app (processRow output, enriched by fillForward / normalizePlayerNames).
 * The nullable fields are null only on the placeholder rows createEmptyRow
 * makes for never-played catalog works; sheet-derived rows always carry
 * strings and a real Date.
 * @typedef {Object} Row
 * @property {Date|null} timestamp
 * @property {string} composer
 * @property {Work} work
 * @property {string|null} part - "V1" | "V2" | "VA" | rarer values ("VA2", ...)
 * @property {string|null} player1 - upper slot (see SLOT_CLASS)
 * @property {string|null} player2 - upper slot
 * @property {string|null} player3 - cello slot
 * @property {string|null} others - raw "Others?" cell (kept for CSV export)
 * @property {string|null} location
 * @property {string} comments
 * @property {(string|null)[]} [playerInstruments] - per-slot "(instrument)"
 *   annotations, attached by normalizePlayerNames; null where a slot had none
 * @property {OtherPlayer[]} [othersList] - attached by normalizePlayerNames
 */

// Slot semantics from extractUniquePlayers below:
//   player1, player2 → upper (V1/V2/VA, depending on user's part)
//   player3          → cello (always)
const SLOT_CLASS = /** @type {const} */ (['upper', 'upper', 'cello']);

/**
 * @param {string|null|undefined} instrumentStr
 * @returns {'upper'|'cello'|null}
 */
// Instrument annotations arrive as free text from two places: an
// "(instrument)" suffix on a player slot, and each entry in the Others?
// column. Loggers write terse codes (vc, va2) AND spelled-out names (cello,
// viola), so both readers below share these patterns instead of each growing
// its own prefix checks and drifting apart. The (?![a-z]) guards are what
// stop "c" from swallowing "clarinet" and "va" from swallowing "violin".
// Unnumbered violin (violin/vn/vln) deliberately matches neither: it says
// nothing about which violin seat, so it buckets as OTHER rather than guess.
const CELLO_INSTRUMENT = /^(?:vc|vlc|cello|violoncello|c)(?![a-z])/;
const VIOLA_INSTRUMENT = /^(?:vla|viola|va)(?![a-z])/;
const VIOLIN_INSTRUMENT = /^(?:v[12]|violin|vn|vln)(?![a-z])/;
// Everything else the log has actually named, plus the obvious neighbours.
// Part-wise these all bucket as OTHER, so this list never has to be right
// about WHICH instrument — only about instrument-or-not, which is what
// instrumentFromSlot needs to tell an annotation from a note (see there).
const OTHER_INSTRUMENT = new RegExp('^(?:' + [
    'p|pf|pno|piano|fortepiano|harpsichord|hpsi?|organ|keys?|keyboard',
    'fl|flute|ob|oboe|cl|clarinet|bsn|bassoon|sax|rec|recorder',
    'hn|horn|tpt|trumpet|tbn|trombone|tuba',
    'db|bass|contrabass|guitar|gtr|lute|harp',
    'voice|sop|soprano|alto|mezzo|ten|tenor|bari|baritone',
].join('|') + ')(?![a-z])');

// "asst v2" / "ast v2" is a v2 seat — drop the assistant prefix before matching.
/** @param {string} s */
function normalizeInstrument(s) {
    return s.toLowerCase().trim().replace(/^as?st\s+/, '');
}

export function classOf(instrumentStr) {
    if (!instrumentStr) return null;
    return CELLO_INSTRUMENT.test(normalizeInstrument(instrumentStr)) ? 'cello' : 'upper';
}

// Does this free-text string name an instrument at all? Only player slots ask:
// an Others? entry's parenthetical is an instrument by convention, but a slot's
// is just as often a note — "(sub)", "(guest)", "(Bob's teacher)" — and classOf
// answers 'upper' for every one of those. Reading a note as an instrument would
// silently reclass the player: "(sub)" in the cello slot aliases as an upper
// player (the wrong person, where a short name means two people) and drops out
// of the VC column. Unrecognized parentheticals therefore fall back to the seat.
/** @param {string|null|undefined} instrumentStr */
function namesAnInstrument(instrumentStr) {
    const s = normalizeInstrument(instrumentStr || '');
    return !!s && (CELLO_INSTRUMENT.test(s) || VIOLA_INSTRUMENT.test(s)
        || VIOLIN_INSTRUMENT.test(s) || OTHER_INSTRUMENT.test(s));
}

// The name tables are arguments, never module state. This file used to
// default them to the deployment's real tables (the gitignored src/aliases.js,
// via config.js), which made every caller that omitted the argument read
// whatever was on that machine: real people locally, the empty stub in CI. A
// test could pass in one place and fail in the other for reasons no one could
// see in the test. Now the wiring lives with the callers that know which
// tables they mean — DataService.processData and scripts/fetch_processed.mjs
// — and forgetting one throws instead of quietly reading personal data.
/**
 * @param {string|null} name
 * @param {'upper'|'cello'|null} cls
 * @param {Record<string, import('./aliases.stub.js').AliasEntry>} aliases
 * @returns {string|null}
 */
export function canonicalize(name, cls, aliases) {
    if (!aliases) throw new TypeError('canonicalize: pass an alias table (use {} for none)');
    if (!name) return name;
    return (cls && aliases[name]?.[cls]) ?? name;
}

// Strip a trailing "(instrument)" annotation from a name. Used for player
// slots where the user occasionally annotates non-string players inline
// (e.g. "Alice Hart (piano)" in Player 1). The instrument info is dropped.
/**
 * @param {string|null} name
 * @returns {string|null}
 */
export function stripParens(name) {
    if (!name) return name;
    const m = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : name;
}

// Pull the "(instrument)" suffix off a player-slot value, mirroring the
// Others?-entry shape: inside the parens the first comma separates the
// instrument code from a free-form comment, so "Alice Hart (vc, doubling)"
// yields "vc". Returns null when the slot carries no annotation — and also
// when the parenthetical is a note rather than an instrument, so only an
// annotation that classifies can override the seat (see namesAnInstrument).
/**
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
export function instrumentFromSlot(name) {
    const m = (name || '').match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (!m) return null;
    const inside = m[2];
    const commaIdx = inside.indexOf(',');
    const instrument = (commaIdx >= 0 ? inside.slice(0, commaIdx) : inside).trim();
    return namesAnInstrument(instrument) ? instrument : null;
}

// Split `s` on `,` or `;` at paren depth 0 only — so commas inside a
// "(instrument, comment)" annotation don't tear an entry in half.
// Exported because scripts/audit_fillforward.mjs needs the same entry
// boundaries while keeping each entry's full parenthetical — parseOthers
// discards the comment half, and that comment is what tells the audit an
// entry was scoped to particular movements. Sharing the split is the point:
// a second copy of it in the audit is exactly the drift issue #25 removed.
/** @param {string} s */
export function splitOutsideParens(s) {
    /** @type {string[]} */
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (c === ',' || c === ';')) {
            parts.push(s.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(s.slice(start));
    return parts;
}

// Format: "Name (instrument, comment); Name (instrument)" — separators `,` or
// `;` between entries, paren-aware so commas inside the annotation don't
// split. Inside the parens the first comma separates the instrument code
// from a free-form comment ("v2, on III", "vc, doubling", "v1, shadowing on
// II, III"); only the instrument piece is kept on the parsed entry, and
// further commas inside the comment are tolerated.
/**
 * @param {string|null|undefined} others
 * @returns {OtherPlayer[]}
 */
export function parseOthers(others) {
    if (!others) return [];
    return splitOutsideParens(others)
        .map(s => s.trim())
        .filter(s => s && s !== '-')
        .map(s => {
            const m = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
            if (!m) return { name: s, instrument: null };
            const inside = m[2];
            const commaIdx = inside.indexOf(',');
            const instrument = (commaIdx >= 0 ? inside.slice(0, commaIdx) : inside).trim();
            return { name: m[1].trim(), instrument };
        });
}

/**
 * @param {Row[]} data
 * @param {Record<string, import('./aliases.stub.js').AliasEntry>} aliases
 * @returns {Row[]}
 */
export function normalizePlayerNames(data, aliases) {
    if (!aliases) throw new TypeError('normalizePlayerNames: pass an alias table (use {} for none)');
    data.forEach(d => {
        // A slot may carry an "(instrument)" annotation. When it does, it wins
        // over the slot's positional class: ensembles the quartet layout has no
        // seats for — piano trios and quartets above all — put people in
        // whichever column is free, so a pianist or cellist can land in an
        // upper slot. Classifying by what they played beats classifying by
        // which column they landed in. Unannotated slots are unchanged.
        const slotInstruments = [d.player1, d.player2, d.player3].map(instrumentFromSlot);
        d.playerInstruments = slotInstruments;
        d.player1 = canonicalize(stripParens(d.player1), classOf(slotInstruments[0]) ?? SLOT_CLASS[0], aliases);
        d.player2 = canonicalize(stripParens(d.player2), classOf(slotInstruments[1]) ?? SLOT_CLASS[1], aliases);
        d.player3 = canonicalize(stripParens(d.player3), classOf(slotInstruments[2]) ?? SLOT_CLASS[2], aliases);
        d.othersList = parseOthers(d.others).map(o => {
            const cls = classOf(o.instrument);
            // o.name is a non-empty string, so canonicalize returns a string
            // (the alias hit or the name itself), never null.
            const name = /** @type {string} */ (canonicalize(o.name, cls, aliases));
            return { name, instrument: o.instrument, class: cls };
        });
    });
    return data;
}

// Canonical-name keys for "unique people" counting. Disambiguation between
// same-bare-name-different-instrument people (e.g. "Jo Alpha" vs "Jo Beta")
// is handled by PLAYER_ALIASES at canonicalization time — bare "Jo" becomes
// "Jo Alpha" in upper slots and "Jo Beta" in cello slots, which are
// already distinct names. One person playing multiple instruments (e.g.
// "Hank Field" on piano + cello) collapses correctly to a single name.
/**
 * @param {Row} d
 * @returns {string[]}
 */
export function peopleKeysFor(d) {
    const keys = [];
    [d.player1, d.player2, d.player3].forEach(p => {
        if (p && p !== '-') keys.push(p);
    });
    d.othersList?.forEach(o => { if (o.name) keys.push(o.name); });
    return keys;
}

// Maps a raw "Which Part" value to one of the three dashboard part buckets.
// V1 / V2 stay as-is; anything starting with "VA" (VA, VA1, VA2, ...) folds
// to "VA"; anything else is excluded (returns null). Kept local to the
// dashboard so it doesn't perturb the global part filter / processRow
// semantics elsewhere.
/**
 * @param {string|null} part
 * @returns {'V1'|'V2'|'VA'|null}
 */
export function normalizeDashboardPart(part) {
    if (!part) return null;
    if (part === 'V1' || part === 'V2') return part;
    if (part.startsWith('VA')) return 'VA';
    return null;
}

// Days since the Unix epoch for the local calendar day containing `ts`.
// Feeding the local Y/M/D through Date.UTC makes consecutive calendar days
// differ by exactly 1 regardless of DST — differencing local-midnight
// timestamps would make a spring-forward day only 23h and misjudge adjacency.
// Lets computeAggregateStats measure both distinct playing days and the
// longest consecutive run. Avoids pulling d3 in here so the function stays
// unit-testable under node:test.
/** @param {Date} ts */
function dayOrdinal(ts) {
    return Math.floor(Date.UTC(ts.getFullYear(), ts.getMonth(), ts.getDate()) / 86400000);
}

// Longest run of consecutive day ordinals in `days` (a Set or array of
// integer day numbers, as produced by dayOrdinal), plus how many distinct runs tie
// for the longest and where the most recent of them begins. Returns
// { length, count, start } with `start` in the same units as the input
// (null for empty input). Feeds the streak tooltips.
/**
 * @param {Iterable<number>} days
 * @returns {{ length: number, count: number, start: number|null }}
 */
export function longestRunInfo(days) {
    const sorted = Array.from(new Set(days)).sort((a, b) => a - b);
    let best = 0, count = 0;
    /** @type {number|null} */ let bestStart = null;
    let run = 0;
    /** @type {number|null} */ let runStart = null;
    /** @type {number|null} */ let prev = null;
    for (const d of sorted) {
        if (prev !== null && d === prev + 1) {
            run += 1;
        } else {
            run = 1;
            runStart = d;
        }
        // A run passes through each length exactly once, so `run === best`
        // fires at most once per run: a later run tying the record bumps the
        // count and takes over `start` (most recent wins); beating the
        // record resets both.
        if (run > best) {
            best = run; count = 1; bestStart = runStart;
        } else if (run === best) {
            count += 1; bestStart = runStart;
        }
        prev = d;
    }
    return { length: best, count, start: bestStart };
}

// "M/D/YYYY" start date of the most recent longest streak, with the number
// of equal-length streaks appended when there's a tie — e.g. "7/10/2026 (3)".
// Empty string when there's no streak. `start` must be a Date whose UTC
// fields hold the local calendar day (the maxStreakInfo convention below).
/**
 * @param {{ count: number, start: Date|null }} info
 * @returns {string}
 */
export function formatStreakStart({ count, start }) {
    if (!start) return '';
    const date = `${start.getUTCMonth() + 1}/${start.getUTCDate()}/${start.getUTCFullYear()}`;
    return count > 1 ? `${date} (${count})` : date;
}

// Canonical unique-counting keys for computeAggregateStats.
/**
 * @param {Row} d
 * @returns {string|null} key for unique-piece counting, null if untitled
 */
function workKey(d) {
    return d.work?.title ? `${d.composer}|${d.work.title}` : null;
}

// Unique parts key on the raw part value, so a quintet played on VA and
// again on VA2 counts as two parts of the same work (VA1 is already folded
// into VA at processRow time).
/**
 * @param {Row} d
 * @returns {string|null} key for unique-part counting, null if untitled or partless
 */
function workPartKey(d) {
    const key = workKey(d);
    return key && d.part ? `${key}|${d.part}` : null;
}

// Aggregate stats over an arbitrary slice of piece rows. Used by the calendar
// header ("Last 365 days"), the dashboard KPI tiles, and the ALL tab. The
// streak is scoped to whatever slice is passed in — a run is only counted
// within the window/filter these rows represent.
/**
 * @param {Row[]} rows
 * @returns {{ pieces: number, uniquePieces: number, uniqueParts: number,
 *             uniquePeople: number, daysPlayed: number, maxStreak: number,
 *             maxStreakInfo: { count: number, start: Date|null } }}
 */
export function computeAggregateStats(rows) {
    const works = new Set();
    const parts = new Set();
    const people = new Set();
    const days = new Set();
    rows.forEach(d => {
        const wk = workKey(d);
        if (wk) works.add(wk);
        const pk = workPartKey(d);
        if (pk) parts.add(pk);
        peopleKeysFor(d).forEach(k => people.add(k));
        if (d.timestamp) days.add(dayOrdinal(d.timestamp));
    });
    const streak = longestRunInfo(days);
    return {
        pieces: rows.length,
        uniquePieces: works.size,
        uniqueParts: parts.size,
        uniquePeople: people.size,
        daysPlayed: days.size,
        maxStreak: streak.length,
        // Start of the most recent longest run as a Date at UTC midnight of
        // the local calendar day (read it with getUTC* accessors — inverse
        // of dayOrdinal), plus how many runs tie for that length.
        maxStreakInfo: {
            count: streak.count,
            start: streak.start === null ? null : new Date(streak.start * 86400000),
        },
    };
}

// Co-occurrence network helpers. The spreadsheet owner is already excluded
// from peopleKeysFor — player1/player2/player3 are the OTHER three quartet
// members (the user's slot is implicit in d.part, never listed in any
// player slot). So these helpers consume peopleKeysFor directly, with no
// user-identity inference needed.

// Count pieces per musician. Each musician counts once per row even
// if they appear twice (e.g. duplicate othersList entry).
/**
 * @param {Row[]} rows
 * @returns {{ name: string, count: number }[]}
 */
export function computeNodeCounts(rows) {
    const counts = new Map();
    rows.forEach(d => {
        const seen = new Set(peopleKeysFor(d));
        seen.forEach(name => counts.set(name, (counts.get(name) ?? 0) + 1));
    });
    return Array.from(counts, ([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// For every unordered pair (a < b lexicographically) of musicians in the
// same piece where both endpoints are in allowedSet, count co-occurrences.
/**
 * @param {Row[]} rows
 * @param {Set<string>} allowedSet
 * @returns {{ source: string, target: string, weight: number }[]}
 */
export function computeEdgeCounts(rows, allowedSet) {
    const counts = new Map();
    rows.forEach(d => {
        const people = Array.from(new Set(peopleKeysFor(d)))
            .filter(n => allowedSet.has(n))
            .sort();
        for (let i = 0; i < people.length; i++) {
            for (let j = i + 1; j < people.length; j++) {
                const key = `${people[i]}\t${people[j]}`;
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
        }
    });
    return Array.from(counts, ([key, weight]) => {
        const [source, target] = key.split('\t');
        return { source, target, weight };
    });
}

// Build the network: nodes are musicians with at least `minCount` pieces,
// edges are co-occurrences between those nodes. `minCount` is the user-facing
// threshold from the dashboard slider; a value of 1 includes every musician
// who appeared at all.
/**
 * @param {Row[]} rows
 * @param {number} [minCount]
 */
export function buildNetworkData(rows, minCount = 1) {
    const allNodes = computeNodeCounts(rows);
    const nodes = allNodes.filter(n => n.count >= minCount);
    const allowed = new Set(nodes.map(n => n.name));
    const edges = computeEdgeCounts(rows, allowed);
    return { nodes, edges };
}

// Smallest piece-count threshold that keeps the rendered node set under
// `maxNodes`. Used as the initial slider value so the graph opens at a
// density the layout can handle. Returns 1 (= include everyone) when there
// are fewer musicians than the cap. When there are ties at the cap boundary,
// bumps the threshold by one so we stay at or under the cap.
/**
 * @param {Row[]} rows
 * @param {number} [maxNodes]
 * @returns {number}
 */
export function defaultMinPiecesForGraph(rows, maxNodes = 50) {
    const counts = computeNodeCounts(rows).map(n => n.count);
    if (counts.length <= maxNodes) return 1;
    const cutoff = counts[maxNodes - 1];
    // If the next musician past the cap is tied, bump to exclude the tie
    // so we don't overshoot.
    if (counts[maxNodes] === cutoff) return cutoff + 1;
    return cutoff;
}

// What part did the person in this row's player slot play? The user's own
// part determines the cohort: e.g. when the user plays V1, their player1 is
// the V2 player, player2 is the VA player, player3 is the cellist. VA2 rows
// (quintets with the user on second viola) follow the sheet convention of
// listing the violins and cello in the slots with the other violist under
// Others — same mapping as VA. Read only through slotPartsFor below, which
// layers slot annotations on top; undefined for any other part value.
const SLOT_TO_PART = {
    V1: ['V2', 'VA', 'VC'],
    V2: ['V1', 'VA', 'VC'],
    VA: ['V1', 'V2', 'VC'],
    VA2: ['V1', 'V2', 'VC'],
};

// Map a free-text instrument string (from the "Others?" column) to a part
// bucket. Handles common shapes: v1, V1, v2, va, va2, vla, vc, vc2, plus
// "asst v2" assistant notation. Anything unrecognized — piano, harpsichord,
// blanks — bucketed as OTHER.
/**
 * @param {string|null|undefined} instrument
 * @returns {'V1'|'V2'|'VA'|'VC'|'OTHER'}
 */
export function partFromInstrument(instrument) {
    if (!instrument) return 'OTHER';
    const s = normalizeInstrument(instrument);
    if (CELLO_INSTRUMENT.test(s)) return 'VC';
    if (VIOLA_INSTRUMENT.test(s)) return 'VA';
    if (s.startsWith('v1')) return 'V1';
    if (s.startsWith('v2')) return 'V2';
    return 'OTHER';
}

// Which part each of the three player slots represents on this row. The seat
// the quartet layout implies (SLOT_TO_PART) is the default; an "(instrument)"
// annotation on the slot overrides it, because ensembles the layout has no
// seats for put people in whichever column is free. Entries are null where
// neither is known — an unannotated slot on a row whose own part isn't one of
// the four the layout covers. Shared by every consumer so the charts, the
// Player dropdown and the dropdown's filter cannot disagree about one row.
/**
 * @param {Row} d
 * @returns {('V1'|'V2'|'VA'|'VC'|'OTHER'|null)[]}
 */
export function slotPartsFor(d) {
    const slotParts = SLOT_TO_PART[d.part];
    return [0, 1, 2].map(i => {
        const annotated = d.playerInstruments?.[i];
        if (annotated) return partFromInstrument(annotated);
        return slotParts ? slotParts[i] : null;
    });
}

// Argmax over a part-breakdown vector: which instrument did this musician
// play most? Ties broken by V1 → V2 → VA → VC → OTHER (the iteration order).
// Used by the chord view to group musicians into instrument blocks.
// Canonical part display/stacking order, shared by the dashboard's stacked
// bars, the network views' grouping, and predominantPart's tie-breaking.
export const PART_ORDER = /** @type {const} */ (['V1', 'V2', 'VA', 'VC', 'OTHER']);
/**
 * @param {Partial<Record<'V1'|'V2'|'VA'|'VC'|'OTHER', number>>|null|undefined} parts
 * @returns {'V1'|'V2'|'VA'|'VC'|'OTHER'|null}
 */
export function predominantPart(parts) {
    if (!parts) return null;
    /** @type {'V1'|'V2'|'VA'|'VC'|'OTHER'|null} */
    let best = null;
    let bestCount = -1;
    for (const part of PART_ORDER) {
        const c = parts[part] ?? 0;
        if (c > bestCount) {
            best = part;
            bestCount = c;
        }
    }
    return bestCount > 0 ? best : null;
}

// For every musician, count how many pieces they played in each part.
// player1/2/3 slots are mapped via slotPartsFor; othersList entries use the
// parsed instrument string. The returned breakdown vectors sum to the
// musician's total appearance count (including any OTHER, like piano).
/**
 * @param {Row[]} rows
 * @returns {Map<string, Record<'V1'|'V2'|'VA'|'VC'|'OTHER', number>>}
 */
export function computePartBreakdownPerMusician(rows) {
    /** @type {Map<string, Record<'V1'|'V2'|'VA'|'VC'|'OTHER', number>>} */
    const result = new Map();
    /**
     * @param {string} name
     * @param {'V1'|'V2'|'VA'|'VC'|'OTHER'} part
     */
    const bump = (name, part) => {
        let parts = result.get(name);
        if (!parts) {
            parts = { V1: 0, V2: 0, VA: 0, VC: 0, OTHER: 0 };
            result.set(name, parts);
        }
        parts[part]++;
    };
    rows.forEach(d => {
        const slotParts = slotPartsFor(d);
        [d.player1, d.player2, d.player3].forEach((name, i) => {
            if (!name || name === '-') return;
            // A row with neither an annotation nor a known seat contributes
            // nothing, exactly as before.
            if (slotParts[i]) bump(name, /** @type {'V1'} */ (slotParts[i]));
        });
        d.othersList?.forEach(o => {
            if (o.name) bump(o.name, partFromInstrument(o.instrument));
        });
    });
    return result;
}

// For every composer, count how many pieces the user played in each part
// (V1/V2/VA via normalizeDashboardPart; anything else buckets to OTHER).
// The returned breakdown vectors sum to the composer's total piece count,
// so the dashboard's Top Composers bar can stack by the user's own part.
/**
 * @param {Row[]} rows
 * @returns {Map<string, Record<'V1'|'V2'|'VA'|'OTHER', number>>}
 */
export function computePartBreakdownPerComposer(rows) {
    /** @type {Map<string, Record<'V1'|'V2'|'VA'|'OTHER', number>>} */
    const result = new Map();
    rows.forEach(d => {
        let parts = result.get(d.composer);
        if (!parts) {
            parts = { V1: 0, V2: 0, VA: 0, OTHER: 0 };
            result.set(d.composer, parts);
        }
        const part = normalizeDashboardPart(d.part);
        parts[part ?? 'OTHER']++;
    });
    return result;
}

// Build short display labels from canonical names. Group by first token: if
// the first token is unique, that's the label; if two share, fall back to
// "First L." (first-token + last-name's initial); if those still collide,
// fall back to the full canonical name.
/**
 * @param {{ name: string }[]} nodes
 * @returns {Map<string, string>} canonical name → display label
 */
export function disambiguateLabels(nodes) {
    /** @type {Map<string, string>} */
    const labels = new Map();
    /** @type {Map<string, string[]>} */
    const byFirst = new Map();
    nodes.forEach(n => {
        const first = n.name.split(/\s+/)[0];
        if (!byFirst.has(first)) byFirst.set(first, []);
        byFirst.get(first)?.push(n.name);
    });
    byFirst.forEach((names, first) => {
        if (names.length === 1) {
            labels.set(names[0], first);
            return;
        }
        const shortByLastInitial = new Map();
        names.forEach(name => {
            const parts = name.split(/\s+/);
            const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] : '';
            const short = lastInitial ? `${first} ${lastInitial}.` : first;
            if (!shortByLastInitial.has(short)) shortByLastInitial.set(short, []);
            shortByLastInitial.get(short).push(name);
        });
        shortByLastInitial.forEach((sharingNames, short) => {
            if (sharingNames.length === 1) {
                labels.set(sharingNames[0], short);
            } else {
                sharingNames.forEach(name => labels.set(name, name));
            }
        });
    });
    return labels;
}

// Pick the widest label that fits `maxWidth`, walking `candidates` from the
// preferred (longest) form down. `measure` returns the rendered pixel width
// of a string — injected so this stays pure and testable; the dashboard
// passes an SVG <text> node's getComputedTextLength(). When nothing fits,
// the last (shortest) candidate is clipped with an ellipsis, so a label is
// never silently cut off by the viewport edge.
//
// A measure() that returns 0 (the element isn't rendered — a hidden view)
// makes the first candidate "fit", which is the right degradation: the full
// name, exactly as before, and the caller re-renders when the view is shown.
/**
 * @param {string[]} candidates preferred form first, shortest form last
 * @param {number} maxWidth
 * @param {(s: string) => number} measure
 * @returns {string}
 */
export function fitText(candidates, maxWidth, measure) {
    const options = candidates.filter(c => c);
    if (options.length === 0) return '';
    for (const candidate of options) {
        if (measure(candidate) <= maxWidth) return candidate;
    }
    const shortest = options[options.length - 1];
    for (let n = shortest.length - 1; n > 0; n--) {
        const clipped = shortest.slice(0, n) + '…';
        if (measure(clipped) <= maxWidth) return clipped;
    }
    return '…';
}

/**
 * @param {string} title
 * @returns {Work}
 */
export function parseWork(title) {
    // Incompletely played works are usually noted like e.g. 17#2:I.
    let incomplete = title.indexOf(":") != -1;

    const pound = title.indexOf('#');
    const number = pound == -1 ? null : parseInt(title.substr(pound + 1));
    /** @type {number} */
    let catalog;

    if (number === null)
        catalog = parseInt(title);
    else {
        catalog = parseInt(title.substr(0, pound));
    }
    if (isNaN(catalog)) {
        catalog = parseInt(title.substr(1));
    }

    return {
        "title": title,
        "incomplete": incomplete,
        "catalog": catalog,
        "number": number
    };
}

// Prepare freshly-parsed rows for the processing pipeline: drop rows whose
// Timestamp failed to parse (an Invalid Date's value is NaN, which passes
// truthiness checks and silently corrupts fillForward's session-window math
// and the streak calculations) and sort the survivors by timestamp
// ascending. Nothing upstream guarantees sheet order — one backdated row at
// the top of the sheet would otherwise mis-anchor BEGIN (`data[0]`) and
// produce negative time deltas in fillForward. Sort is stable, so rows
// sharing a timestamp keep their sheet order. Does not mutate the input
// array. Returns { rows, dropped } where `dropped` counts the removed
// invalid-timestamp rows (callers may want to log it).
/**
 * @param {Row[]} rows
 * @returns {{ rows: Row[], dropped: number }}
 */
export function prepareRows(rows) {
    const kept = rows.filter(
        /** @type {(r: Row) => r is Row & { timestamp: Date }} */
        (r => r.timestamp instanceof Date && !Number.isNaN(r.timestamp.getTime())));
    kept.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return { rows: kept, dropped: rows.length - kept.length };
}

// Sheet columns processRow reads. Checked up front so a renamed/missing
// column in the sheet fails with a clear error naming the column, instead of
// a bare TypeError (or worse, silent undefineds for the unguarded reads).
// The Others column is handled separately: the live sheet's header is
// "Others?", but exports written before the header fix (csvFormat.js) used
// "Others" — accept either spelling so old exports still re-ingest.
const REQUIRED_COLUMNS = [
    'Timestamp', 'Composer', 'Work Title', 'Which Part',
    'Player 1', 'Player 2', 'Player 3', 'Location', 'Comments',
];

/**
 * @param {Record<string, string|undefined>} d - one raw CSV row (header → cell)
 * @returns {Row}
 */
export function processRow(d) {
    const missing = REQUIRED_COLUMNS.filter(c => d[c] === undefined);
    const others = d["Others?"] ?? d["Others"];
    if (others === undefined) missing.push('Others?');
    if (missing.length) {
        throw new Error(`Row is missing expected column(s): ${missing.join(', ')}`);
    }
    // The guard above proved every column read below is present; narrow the
    // types for tsc (it can't see through the REQUIRED_COLUMNS loop).
    const r = /** @type {Record<string, string>} */ (d);
    // part is identity-bearing (it keys workPartKey), so trim before the
    // VA1 fold — stray whitespace would otherwise mint a phantom part.
    const part = r["Which Part"].trim();
    return {
        "timestamp": new Date(r.Timestamp),
        "composer": r.Composer.trim(),
        "work": parseWork(r["Work Title"].trim()),
        "part": part == "VA1" ? "VA" : part,
        "player1": r["Player 1"].trim(),
        "player2": r["Player 2"].trim(),
        "player3": r["Player 3"].trim(),
        "others": /** @type {string} */ (others).trim(),
        "location": r.Location.trim(),
        "comments": r.Comments.trim()
    };
}

// Two consecutive rows in the same column count as one "session" when they
// are less than this many hours apart. Within a session, shorthand entries
// (empty cells, name prefixes) refer back to the previous entry.
export const SESSION_WINDOW_HOURS = 4;

// Does `entry` refer to the same person/place as `prevEntry` (the last full
// value seen in this column)? True when:
//   - `entry` is empty — a blank cell inside the session window is a ditto
//     mark ("same as the row above");
//   - `entry` equals `prevEntry` exactly;
//   - `prevEntry` starts with `entry` followed by a word boundary — "Fred"
//     abbreviates a previous "Fred Brown". The boundary requirement is what
//     keeps "Fred" from silently merging with a previous "Freddy": a
//     prefix that ends mid-word is a different name, not an abbreviation.
// Exported so scripts/audit_fillforward.mjs can measure SESSION_WINDOW_HOURS
// against the log with the app's own predicate rather than a copy of it. That
// report's whole claim is "here is what fillForward does at each gap", so a
// second implementation of the prefix rule would be the one thing able to make
// it quietly untrue.
/**
 * @param {string} entry
 * @param {string} prevEntry
 */
export function refersToPrevEntry(entry, prevEntry) {
    if (entry === '' || entry === prevEntry) return true;
    return prevEntry.startsWith(entry) && /\s/.test(prevEntry[entry.length]);
}

// Expand shorthand in the player/location columns. The sheet convention is to
// write a value in full once, then abbreviate while the session continues:
// a blank cell or a leading-prefix of the previous entry (e.g. "Fred" after
// "Fred Brown") repeats it, and the single-letter PLAYER_ABBREVIATIONS
// (e.g. "I" → a configured first name) expand regardless of the window. "-" means
// "nobody in this slot": it is left as-is and does not advance the session
// anchor, so shorthand can still refer past it to the last real entry.
//
// Cell semantics, pinned by tests:
//   "-"    → no player; untouched.
//   ""     → a ditto mark: always filled from the previous entry, however
//            long the gap. It never becomes the reference entry itself.
//   prefix → same-session prefix-at-a-word-boundary of the previous entry:
//            expanded to it. Otherwise treated as a new value.
//
// Rows must be in chronological order (prepareRows guarantees this). A
// negative time delta would mean unsorted input; it is deliberately treated
// as "not the same session" rather than being allowed to slip under the
// window the way any negative number satisfies `hours < 4`.
/**
 * One cell's fill-forward decision, as it was made.
 *
 * Reported rather than re-derived. The audit that measures where the session
 * window actually bites used to mirror the loop below — same columns, same
 * seeding, same branch order — and every review round found the mirror
 * disagreeing with the original somewhere (the gap measured from the wrong
 * row, a branch taken ungated, the location column missing). A trace makes
 * the divergence impossible instead of testable: there is one loop, and the
 * reader of the report sees what the app did.
 *
 * `reference` is the entry this cell was compared against, captured before
 * the branch could advance it — the `new` branch leaves the cell as typed and
 * still needs to name the fuller entry it declined to expand into.
 * @typedef {Object} FillDecision
 * @property {Row} row
 * @property {string} column - one of player1/player2/player3/location
 * @property {'ditto'|'shorthand'|'table'|'new'} branch - which rule fired
 * @property {string} entry - the trimmed cell as typed
 * @property {string} reference - the entry compared against, pre-branch
 * @property {number} gap - hours since the row holding `reference`
 * @property {string} result - what the cell now holds
 */

/**
 * @param {Row[]} data - MUST be in chronological order (see prepareRows)
 * @param {Record<string, string>} abbreviations
 * @param {(d: FillDecision) => void} [onDecision] - called once per filled
 *   cell, in column-then-row order. The app passes nothing; the audit passes
 *   a collector so it can report on the run instead of reproducing it.
 * @returns {Row[]}
 */
export function fillForward(data, abbreviations, onDecision) {
    if (!abbreviations) throw new TypeError('fillForward: pass an abbreviation table (use {} for none)');
    if (!data.length) return data;
    ["player1", "player2", "player3", "location"].forEach(column => {
        let prev = data[0];
        let prevEntry = prev[column];

        data.slice(1).forEach(row => {
            const entry = row[column].trim();
            if (entry != '-') {
                // What the reference entry was BEFORE this row's branch could
                // move it: the branch that leaves an entry as typed still
                // needs to report the fuller name it declined to expand into.
                const reference = prevEntry;
                // Number(Date) = ms epoch; rows here come from the sheet, so
                // timestamps are real Dates (nulls exist only on
                // createEmptyRow placeholders, which never enter fillForward).
                const hours = (Number(row.timestamp) - Number(prev.timestamp)) / 1000 / 60 / 60;
                const sameSession = hours >= 0 && hours < SESSION_WINDOW_HOURS;
                let branch;
                if (entry === '') {
                    // A blank is a ditto mark, and it is one however long the
                    // break was: nobody starts a session by leaving the names
                    // out, so a blank cell can only mean "same as above". "-"
                    // is how the sheet says "nobody in this seat" (handled
                    // above), which is what keeps the two distinguishable.
                    // Time-gating this instead cost a whole evening: one
                    // dinner-break gap made the row take its own empty value,
                    // and that empty value then anchored every row after it.
                    row[column] = prevEntry;
                    branch = 'ditto';
                } else if (sameSession && refersToPrevEntry(entry, prevEntry)) {
                    // A written-out shorthand IS gated, because it is an
                    // inference rather than a ditto: "Peter" abbreviates the
                    // "Peter Ouyang" from an hour ago, but next month it is
                    // just as likely to be a different Peter.
                    row[column] = prevEntry;
                    branch = 'shorthand';
                } else if (Object.prototype.hasOwnProperty.call(abbreviations, entry)) {
                    prevEntry = abbreviations[entry];
                    row[column] = prevEntry;
                    branch = 'table';
                } else {
                    prevEntry = entry;
                    row[column] = entry;
                    branch = 'new';
                }
                if (onDecision) {
                    onDecision({
                        row, column, branch, entry, reference,
                        gap: hours, result: row[column],
                    });
                }
                prev = row;
            }
        });
    });
    return data;
}

/**
 * Placeholder row for a catalog work with no plays (null timestamp/players).
 * @param {string} composer
 * @param {string} title
 * @returns {Row}
 */
export function createEmptyRow(composer, title) {
    return {
        "timestamp": null,
        "composer": composer,
        "work": parseWork(title),
        "part": null,
        "player1": null,
        "player2": null,
        "player3": null,
        "others": null,
        "location": null,
        "comments": ""
    };
}

// Minimum entries for a player to appear in the Player filter dropdown: the
// dropdown is for filtering by the people you play with REGULARLY; below
// this floor it fills up with one-off guests and reading-party stands.
export const PLAYER_DROPDOWN_MIN_ENTRIES = 20;

/**
 * @param {Row[]} data
 * @returns {string[]} "Name.part" keys (e.g. "Alice.v1") for the dropdown
 */
export function extractUniquePlayers(data) {
    /** @type {Map<string, number>} */
    const playerCounts = new Map();

    data.forEach(d => {
        const slotParts = slotPartsFor(d);
        [d.player1, d.player2, d.player3].forEach((name, i) => {
            // "-" means "nobody in this slot" (see fillForward), so it is
            // not a person the dropdown could filter by — same exclusion
            // peopleKeysFor applies.
            if (!name || name === '-' || !slotParts[i]) return;
            const player = `${name}.${slotParts[i].toLowerCase()}`;
            playerCounts.set(player, (playerCounts.get(player) || 0) + 1);
        });
    });

    // Filter to the dropdown-worthy regulars only
    const filteredPlayers = Array.from(playerCounts.entries())
        .filter(([, count]) => count >= PLAYER_DROPDOWN_MIN_ENTRIES)
        .map(([player]) => player)
        .sort();

    return filteredPlayers;
}

// Stacked-bar segments for a ranked row's part breakdown, in PART_ORDER.
// `d.parts` maps part → count (computePartBreakdownPer*); rows without a
// breakdown get a single unkeyed segment (defensive fallback for callers
// that omit it). Returns [{ part, count, x0 }] with x0 the running offset.
export function stackedPartSegments(d) {
    if (!d.parts) return [{ part: null, count: d.count, x0: 0 }];
    const result = [];
    let cum = 0;
    PART_ORDER.forEach(part => {
        const c = d.parts[part] ?? 0;
        if (c > 0) {
            result.push({ part, count: c, x0: cum });
            cum += c;
        }
    });
    return result;
}

// --- Player-filter matching (the Player dropdown's core semantics) -------
//
// Selections are "Name.instrument" tokens (extractUniquePlayers). A row
// matches when EVERY selected person matches on AT LEAST ONE of their
// selected instruments (AND across people, OR across one person's
// instruments). Instrument slots are relative to the user's own part: e.g.
// when the user played V1, player1 is the V2 chair — unless the slot says
// otherwise (slotPartsFor), which is the same rule the charts read.

export function checkSinglePlayerMatch(d, playerName, instrument) {
    const slotParts = slotPartsFor(d);
    return [d.player1, d.player2, d.player3].some((name, i) =>
        slotParts[i]?.toLowerCase() === instrument && name === playerName);
}

export function checkPlayersMatch(d, selectedPlayers) {
    // No selection = "ANY".
    if (selectedPlayers.length === 0) return true;

    // Group tokens by person: ["Alice.v1","Alice.v2","Bob.va"]
    //   => { Alice: ["v1","v2"], Bob: ["va"] }
    const playerGroups = new Map();
    for (const p of selectedPlayers) {
        const [name, instrument] = p.split(".");
        if (!playerGroups.has(name)) playerGroups.set(name, []);
        playerGroups.get(name).push(instrument);
    }

    for (const [name, instruments] of playerGroups) {
        const anyInstrumentMatches = instruments.some(inst =>
            checkSinglePlayerMatch(d, name, inst)
        );
        if (!anyInstrumentMatches) return false;
    }
    return true;
}

// --- Network slider state machine ----------------------------------------
//
// Pure transition function for the min-pieces slider. `prev` is
// { userMinCount, lastSelection, preSelectionMinCount } (nulls on first
// render); `rows` the filtered dataset; `selection` the selected musician or
// null. Returns the next state plus the derived { max, effectiveMin }.
//
// Rules (pinned by tests): the slider max is the 5th-ranked musician's count
// so the top 5 always qualify; entering/swapping a selection overrides
// userMinCount with the ~50-node default for the subset (backing up the
// pre-selection value); exiting restores the backup; first render seeds from
// the 50-node default; effectiveMin is userMinCount clamped to [1, max]
// without mutating it, so widening the filter restores the user's setting.
export function computeSliderSync(prev, rows, selection) {
    const counts = computeNodeCounts(rows);
    const idx = Math.min(4, counts.length - 1);
    const max = Math.max(1, counts[idx]?.count ?? 1);

    let { userMinCount, lastSelection, preSelectionMinCount } = prev;
    if (selection && selection !== lastSelection) {
        if (lastSelection === null) {
            preSelectionMinCount = userMinCount;
        }
        userMinCount = defaultMinPiecesForGraph(rows);
    } else if (!selection && lastSelection !== null) {
        if (preSelectionMinCount !== null) {
            userMinCount = preSelectionMinCount;
            preSelectionMinCount = null;
        }
    } else if (userMinCount === null) {
        userMinCount = Math.max(1, Math.min(max, defaultMinPiecesForGraph(rows)));
    }

    return {
        userMinCount,
        lastSelection: selection ?? null,
        preSelectionMinCount,
        max,
        effectiveMin: Math.max(1, Math.min(max, userMinCount)),
    };
}
