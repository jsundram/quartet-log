import { PLAYER_ABBREVIATIONS, PLAYER_ALIASES } from './config.js';

// Slot semantics from extractUniquePlayers below:
//   player1, player2 → upper (V1/V2/VA, depending on user's part)
//   player3          → cello (always)
const SLOT_CLASS = ['upper', 'upper', 'cello'];

export function classOf(instrumentStr) {
    if (!instrumentStr) return null;
    return instrumentStr.toLowerCase().trim().startsWith('vc') ? 'cello' : 'upper';
}

// `aliases` defaults to the deployment's real table (gitignored
// src/aliases.js via config.js); tests inject placeholder fixtures so they
// don't depend on its contents.
export function canonicalize(name, cls, aliases = PLAYER_ALIASES) {
    if (!name) return name;
    return (cls && aliases[name]?.[cls]) ?? name;
}

// Strip a trailing "(instrument)" annotation from a name. Used for player
// slots where the user occasionally annotates non-string players inline
// (e.g. "Alice Hart (piano)" in Player 1). The instrument info is dropped.
export function stripParens(name) {
    if (!name) return name;
    const m = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : name;
}

// Split `s` on `,` or `;` at paren depth 0 only — so commas inside a
// "(instrument, comment)" annotation don't tear an entry in half.
function splitOutsideParens(s) {
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

export function normalizePlayerNames(data, aliases = PLAYER_ALIASES) {
    data.forEach(d => {
        d.player1 = canonicalize(stripParens(d.player1), SLOT_CLASS[0], aliases);
        d.player2 = canonicalize(stripParens(d.player2), SLOT_CLASS[1], aliases);
        d.player3 = canonicalize(stripParens(d.player3), SLOT_CLASS[2], aliases);
        d.othersList = parseOthers(d.others).map(o => {
            const cls = classOf(o.instrument);
            return { name: canonicalize(o.name, cls, aliases), instrument: o.instrument, class: cls };
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
function dayOrdinal(ts) {
    return Math.floor(Date.UTC(ts.getFullYear(), ts.getMonth(), ts.getDate()) / 86400000);
}

// Longest run of consecutive day ordinals in `days` (a Set or array of
// integer day numbers, as produced by dayOrdinal), plus how many distinct runs tie
// for the longest and where the most recent of them begins. Returns
// { length, count, start } with `start` in the same units as the input
// (null for empty input). Feeds the streak tooltips.
export function longestRunInfo(days) {
    const sorted = Array.from(new Set(days)).sort((a, b) => a - b);
    let best = 0, count = 0, bestStart = null;
    let run = 0, runStart = null, prev = null;
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
export function formatStreakStart({ count, start }) {
    if (!start) return '';
    const date = `${start.getUTCMonth() + 1}/${start.getUTCDate()}/${start.getUTCFullYear()}`;
    return count > 1 ? `${date} (${count})` : date;
}

// Aggregate stats over an arbitrary slice of piece rows. Used by the calendar
// header ("Last 365 days"), the dashboard KPI tiles, and the ALL tab. The
// streak is scoped to whatever slice is passed in — a run is only counted
// within the window/filter these rows represent.
export function computeAggregateStats(rows) {
    const works = new Set();
    const people = new Set();
    const days = new Set();
    rows.forEach(d => {
        if (d.work?.title) works.add(`${d.composer}|${d.work.title}`);
        peopleKeysFor(d).forEach(k => people.add(k));
        if (d.timestamp) days.add(dayOrdinal(d.timestamp));
    });
    const streak = longestRunInfo(days);
    return {
        pieces: rows.length,
        uniquePieces: works.size,
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
// the V2 player, player2 is the VA player, player3 is the cellist. Mirrors
// the table in extractUniquePlayers. Returns null for non-canonical user
// parts (e.g. quintets logged as VA2) — the slot mapping is undefined there.
const SLOT_TO_PART = {
    V1: ['V2', 'VA', 'VC'],
    V2: ['V1', 'VA', 'VC'],
    VA: ['V1', 'V2', 'VC'],
};

// Map a free-text instrument string (from the "Others?" column) to a part
// bucket. Handles common shapes: v1, V1, v2, va, va2, vla, vc, vc2, plus
// "asst v2" assistant notation. Anything unrecognized — piano, harpsichord,
// blanks — bucketed as OTHER.
export function partFromInstrument(instrument) {
    if (!instrument) return 'OTHER';
    const s = instrument.toLowerCase().trim().replace(/^as?st\s+/, '');
    if (s.startsWith('vc')) return 'VC';
    if (s.startsWith('vla') || s.startsWith('va')) return 'VA';
    if (s.startsWith('v1')) return 'V1';
    if (s.startsWith('v2')) return 'V2';
    return 'OTHER';
}

// Argmax over a part-breakdown vector: which instrument did this musician
// play most? Ties broken by V1 → V2 → VA → VC → OTHER (the iteration order).
// Used by the chord view to group musicians into instrument blocks.
const PRED_ORDER = ['V1', 'V2', 'VA', 'VC', 'OTHER'];
export function predominantPart(parts) {
    if (!parts) return null;
    let best = null;
    let bestCount = -1;
    for (const part of PRED_ORDER) {
        const c = parts[part] ?? 0;
        if (c > bestCount) {
            best = part;
            bestCount = c;
        }
    }
    return bestCount > 0 ? best : null;
}

// For every musician, count how many pieces they played in each part.
// player1/2/3 slots are mapped via SLOT_TO_PART; othersList entries use the
// parsed instrument string. The returned breakdown vectors sum to the
// musician's total appearance count (including any OTHER, like piano).
export function computePartBreakdownPerMusician(rows) {
    const result = new Map();
    const bump = (name, part) => {
        let parts = result.get(name);
        if (!parts) {
            parts = { V1: 0, V2: 0, VA: 0, VC: 0, OTHER: 0 };
            result.set(name, parts);
        }
        parts[part]++;
    };
    rows.forEach(d => {
        const slotParts = SLOT_TO_PART[d.part];
        if (slotParts) {
            [d.player1, d.player2, d.player3].forEach((name, i) => {
                if (name && name !== '-') bump(name, slotParts[i]);
            });
        }
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
export function computePartBreakdownPerComposer(rows) {
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
export function disambiguateLabels(nodes) {
    const labels = new Map();
    const byFirst = new Map();
    nodes.forEach(n => {
        const first = n.name.split(/\s+/)[0];
        if (!byFirst.has(first)) byFirst.set(first, []);
        byFirst.get(first).push(n.name);
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

export function parseWork(title) {
    // Incompletely played works are usually noted like e.g. 17#2:I.
    let incomplete = title.indexOf(":") != -1;

    const pound = title.indexOf('#');
    const number = pound == -1 ? null : parseInt(title.substr(pound + 1));
    let catalog = null;

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
export function prepareRows(rows) {
    const kept = rows.filter(r =>
        r.timestamp instanceof Date && !Number.isNaN(r.timestamp.getTime()));
    kept.sort((a, b) => a.timestamp - b.timestamp);
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

export function processRow(d) {
    const missing = REQUIRED_COLUMNS.filter(c => d[c] === undefined);
    const others = d["Others?"] ?? d["Others"];
    if (others === undefined) missing.push('Others?');
    if (missing.length) {
        throw new Error(`Row is missing expected column(s): ${missing.join(', ')}`);
    }
    return {
        "timestamp": new Date(d.Timestamp),
        "composer": d.Composer.trim(),
        "work": parseWork(d["Work Title"].trim()),
        "part": d["Which Part"] == "VA1" ? "VA" : d["Which Part"],
        "player1": d["Player 1"].trim(),
        "player2": d["Player 2"].trim(),
        "player3": d["Player 3"].trim(),
        "others": others.trim(),
        "location": d.Location.trim(),
        "comments": d.Comments.trim()
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
//   - `prevEntry` starts with `entry` followed by a word boundary — "Chris"
//     abbreviates a previous "Chris Smith". The boundary requirement is what
//     keeps "Chris" from silently merging with a previous "Christina": a
//     prefix that ends mid-word is a different name, not an abbreviation.
function refersToPrevEntry(entry, prevEntry) {
    if (entry === '' || entry === prevEntry) return true;
    return prevEntry.startsWith(entry) && /\s/.test(prevEntry[entry.length]);
}

// Expand shorthand in the player/location columns. The sheet convention is to
// write a value in full once, then abbreviate while the session continues:
// a blank cell or a leading-prefix of the previous entry (e.g. "Chris" after
// "Chris Smith") repeats it, and the single-letter PLAYER_ABBREVIATIONS
// (e.g. "I" → a configured first name) expand regardless of the window. "-" means
// "nobody in this slot": it is left as-is and does not advance the session
// anchor, so shorthand can still refer past it to the last real entry.
//
// Cell semantics, pinned by tests:
//   "-"    → no player; untouched.
//   ""     → within SESSION_WINDOW_HOURS of the previous non-"-" row: filled
//            with the previous entry. Outside the window: left empty, and
//            becomes the new (empty) reference entry.
//   prefix → same-session prefix-at-a-word-boundary of the previous entry:
//            expanded to it. Otherwise treated as a new value.
//
// Rows must be in chronological order (prepareRows guarantees this). A
// negative time delta would mean unsorted input; it is deliberately treated
// as "not the same session" rather than being allowed to slip under the
// window the way any negative number satisfies `hours < 4`.
export function fillForward(data, abbreviations = PLAYER_ABBREVIATIONS) {
    if (!data.length) return data;
    ["player1", "player2", "player3", "location"].forEach(column => {
        let prev = data[0];
        let prevEntry = prev[column];

        data.slice(1).forEach(row => {
            const entry = row[column].trim();
            if (entry != '-') {
                const hours = (row.timestamp - prev.timestamp) / 1000 / 60 / 60;
                const sameSession = hours >= 0 && hours < SESSION_WINDOW_HOURS;
                if (sameSession && refersToPrevEntry(entry, prevEntry)) {
                    row[column] = prevEntry;
                } else if (abbreviations.hasOwnProperty(entry)) {
                    prevEntry = abbreviations[entry];
                    row[column] = prevEntry;
                } else {
                    prevEntry = entry;
                    row[column] = entry;
                }
                prev = row;
            }
        });
    });
    return data;
}

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

export function extractUniquePlayers(data) {
    const playerCounts = new Map();

    data.forEach(d => {
        let players = [];
        if (d.part === "V1") {
            if (d.player1) players.push(d.player1 + ".v2");
            if (d.player2) players.push(d.player2 + ".va");
            if (d.player3) players.push(d.player3 + ".vc");
        } else if (d.part === "V2") {
            if (d.player1) players.push(d.player1 + ".v1");
            if (d.player2) players.push(d.player2 + ".va");
            if (d.player3) players.push(d.player3 + ".vc");
        } else if (d.part === "VA") {
            if (d.player1) players.push(d.player1 + ".v1");
            if (d.player2) players.push(d.player2 + ".v2");
            if (d.player3) players.push(d.player3 + ".vc");
        }

        players.forEach(player => {
            playerCounts.set(player, (playerCounts.get(player) || 0) + 1);
        });
    });

    // Filter to the dropdown-worthy regulars only
    const filteredPlayers = Array.from(playerCounts.entries())
        .filter(([player, count]) => count >= PLAYER_DROPDOWN_MIN_ENTRIES)
        .map(([player, count]) => player)
        .sort();

    return filteredPlayers;
}
