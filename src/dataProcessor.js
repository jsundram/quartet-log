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
