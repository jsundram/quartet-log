import { PLAYER_ABBREVIATIONS, PLAYER_ALIASES } from './config.js';

// Slot semantics from extractUniquePlayers below:
//   player1, player2 → upper (V1/V2/VA, depending on user's part)
//   player3          → cello (always)
const SLOT_CLASS = ['upper', 'upper', 'cello'];

export function classOf(instrumentStr) {
    if (!instrumentStr) return null;
    return instrumentStr.toLowerCase().trim().startsWith('vc') ? 'cello' : 'upper';
}

export function canonicalize(name, cls) {
    if (!name) return name;
    return (cls && PLAYER_ALIASES[name]?.[cls]) ?? name;
}

// Strip a trailing "(instrument)" annotation from a name. Used for player
// slots where the user occasionally annotates non-string players inline
// (e.g. "Lois Shapiro (piano)" in Player 1). The instrument info is dropped.
export function stripParens(name) {
    if (!name) return name;
    const m = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : name;
}

// Format is "Name (instrument); Name (instrument)" — usually well-adhered.
// Also handles "," as a fallback separator and fragments without parens.
export function parseOthers(others) {
    if (!others) return [];
    return others
        .split(/[;,]/)
        .map(s => s.trim())
        .filter(s => s && s !== '-')
        .map(s => {
            const m = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
            return m
                ? { name: m[1].trim(), instrument: m[2].trim() }
                : { name: s, instrument: null };
        });
}

export function normalizePlayerNames(data) {
    data.forEach(d => {
        d.player1 = canonicalize(stripParens(d.player1), SLOT_CLASS[0]);
        d.player2 = canonicalize(stripParens(d.player2), SLOT_CLASS[1]);
        d.player3 = canonicalize(stripParens(d.player3), SLOT_CLASS[2]);
        d.othersList = parseOthers(d.others).map(o => {
            const cls = classOf(o.instrument);
            return { name: canonicalize(o.name, cls), instrument: o.instrument, class: cls };
        });
    });
    return data;
}

// Canonical-name keys for "unique people" counting. Disambiguation between
// same-bare-name-different-instrument people (e.g. Jen Hsiao vs Jen Minnich)
// is handled by PLAYER_ALIASES at canonicalization time — bare "Jen" becomes
// "Jen Hsiao" in upper slots and "Jen Minnich" in cello slots, which are
// already distinct names. One person playing multiple instruments (e.g.
// Henry Weinberger on piano + cello) collapses correctly to a single name.
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

// Floor a timestamp to its local-time day. Avoids pulling d3 in here so
// computeAggregateStats stays unit-testable under node:test.
function dayKey(ts) {
    return new Date(ts.getFullYear(), ts.getMonth(), ts.getDate()).getTime();
}

// Aggregate stats over an arbitrary slice of session rows. Used by both
// the calendar header ("Last 365 days") and the ALL tab.
export function computeAggregateStats(rows) {
    const works = new Set();
    const people = new Set();
    const days = new Set();
    rows.forEach(d => {
        if (d.work?.title) works.add(`${d.composer}|${d.work.title}`);
        peopleKeysFor(d).forEach(k => people.add(k));
        if (d.timestamp) days.add(dayKey(d.timestamp));
    });
    return {
        pieces: rows.length,
        uniquePieces: works.size,
        uniquePeople: people.size,
        daysPlayed: days.size,
    };
}

// Co-occurrence network helpers. The spreadsheet owner is already excluded
// from peopleKeysFor — player1/player2/player3 are the OTHER three quartet
// members (the user's slot is implicit in d.part, never listed in any
// player slot). So these helpers consume peopleKeysFor directly, with no
// user-identity inference needed.

// Count sessions per musician. Each musician counts once per row even
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
// same session where both endpoints are in allowedSet, count co-occurrences.
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

// Build the network: nodes are musicians with at least `minCount` sessions,
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

// Median session count across all musicians in the dataset. Used as the
// initial slider value so the graph opens at a balanced midpoint by default.
export function medianNodeCount(rows) {
    const counts = computeNodeCounts(rows).map(n => n.count);
    if (counts.length === 0) return 1;
    return counts[Math.floor(counts.length / 2)];
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

// For every musician, count how many sessions they played in each part.
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

export function processRow(d) {
    return {
        "timestamp": new Date(d.Timestamp),
        "composer": d.Composer.trim(),
        "work": parseWork(d["Work Title"].trim()),
        "part": d["Which Part"] == "VA1" ? "VA" : d["Which Part"],
        "player1": d["Player 1"].trim(),
        "player2": d["Player 2"].trim(),
        "player3": d["Player 3"].trim(),
        "others": d["Others?"].trim(),
        "location": d.Location.trim(),
        "comments": d.Comments.trim()
    };
}

export function fillForward(data) {
    ["player1", "player2", "player3", "location"].forEach(column => {
        let prev = data[0];
        let prevEntry = prev[column];

        data.slice(1).forEach(row => {
            const entry = row[column].trim();
            if (entry != '-') {
                const hours = (row.timestamp - prev.timestamp) / 1000 / 60 / 60;
                if (hours < 4 && prevEntry.indexOf(entry) != -1) {
                    row[column] = prevEntry;
                } else if (PLAYER_ABBREVIATIONS.hasOwnProperty(entry)) {
                    prevEntry = PLAYER_ABBREVIATIONS[entry];
                    row[column] = prevEntry;
                } else {
                    prevEntry = entry;
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

    // Filter to only include players with 20+ entries
    const filteredPlayers = Array.from(playerCounts.entries())
        .filter(([player, count]) => count >= 20)
        .map(([player, count]) => player)
        .sort();

    return filteredPlayers;
}
