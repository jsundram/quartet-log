// @ts-check
// Who was in a row, and who a bare first name could be.
//
// One reader of a row's cast, shared by every section that needs one, so the
// "fix these in the sheet" list and the per-entry verdicts cannot disagree
// about the same name in the same output. Everything that classifies an
// instrument, strips an annotation or splits the Others? column is imported
// from src/dataProcessor.js rather than re-derived here: a Python mirror of
// classOf diverged from the app twice and the mirror tests missed it both
// times, because they sampled inputs where the two answers agreed.

import {
    classOf, instrumentFromSlot, parseOthers, stripParens,
} from '../../src/dataProcessor.js';

/** @typedef {import('../../src/dataProcessor.js').Row} Row */

// Slot semantics from src/dataProcessor.js (SLOT_CLASS, which is private).
const SLOT_CLASS = /** @type {const} */ (['upper', 'upper', 'cello']);

// The class of an Others? entry that names no instrument. Not a real class —
// the app cannot alias such an entry either, since canonicalize with a null
// class is a no-op — but a key it can be indexed under, so it appears in the
// per-name list and can be a candidate for any subject instead of vanishing.
// Eight entries in the log are like this, and all eight are full names.
export const ANY_CLASS = 'any';

// (class, name) and (class, first token) keys. The class goes first so the
// separator is unambiguous: a class never contains "|" while a name may
// contain anything else, spaces included.
/** @param {string} cls @param {string} rest */
const key = (cls, rest) => `${cls}|${rest}`;
/** @param {string} k */
const keyTail = k => k.slice(k.indexOf('|') + 1);

/**
 * One person in one cell of one row.
 * @typedef {Object} Person
 * @property {string} name
 * @property {'upper'|'cello'|null} cls - null when nothing states a class
 * @property {string} seat - "p1".."p3" for slots, "o0", "o1"... for Others?
 */

/**
 * (name, class, seat) for everyone in one row.
 *
 * `seat` identifies the cell, which matters because a reader comparing the
 * same row before and after fill-forward has to drop the subject's OWN cell
 * from the evidence: when fill-forward resolved that cell the written name
 * ("Peter") and the filled one ("Peter Ouyang") differ, so comparing by name
 * fails to exclude it and the subject is scored as its own stand-mate.
 *
 * Works on any view. On the processed view normalizePlayerNames has already
 * split each slot's annotation into playerInstruments and parsed the Others?
 * column into othersList, so those are preferred where present; on the
 * written and filled views the raw cells are parsed the same way the app
 * parses them.
 *
 * @param {Row} row
 * @param {Record<string, string>} abbreviations - single-letter expansions.
 *   Required, like the dataProcessor functions it mirrors: a test that
 *   forgets it should fail loudly rather than read the machine's real table.
 * @returns {Person[]}
 */
export function rowPeople(row, abbreviations) {
    if (!abbreviations) {
        throw new TypeError('rowPeople: pass an abbreviation table (use {} for none)');
    }
    /** @param {string} n */
    const expand = n =>
        Object.prototype.hasOwnProperty.call(abbreviations, n) ? abbreviations[n] : n;

    /** @type {Person[]} */
    const people = [];
    [row.player1, row.player2, row.player3].forEach((slot, i) => {
        const raw = (slot ?? '').trim();
        if (!raw || raw === '-') return;
        // An instrument annotation states the class; the column only implies
        // it. Same precedence as normalizePlayerNames — and the annotation
        // only counts when it names an instrument, so "(sub)" stays positional.
        const annotation = row.playerInstruments?.[i] ?? instrumentFromSlot(raw);
        people.push({
            name: expand(/** @type {string} */ (stripParens(raw))),
            cls: classOf(annotation) ?? SLOT_CLASS[i],
            seat: `p${i + 1}`,
        });
    });
    // An entry naming no instrument has no class, and is kept anyway: a name
    // with no instrument still says who was in the room. Dropping them cost
    // twice — such a name was invisible as a subject (the app counts it as its
    // own person, so it belongs in a bucket) and missing as evidence, which
    // produced false "needs memory" findings on rows their presence settles.
    const others = row.othersList ?? parseOthers(row.others);
    others.forEach((o, i) => {
        if (!o.name) return;
        people.push({
            name: expand(o.name),
            cls: o.class ?? classOf(o.instrument),
            seat: `o${i}`,
        });
    });
    return people;
}

/**
 * Every appearance of a (name, class) pair, with the teammates seen each time.
 * @typedef {Object} Appearance
 * @property {string} name
 * @property {string} cls - 'upper' | 'cello' | ANY_CLASS
 * @property {string[][]} teammates - one teammate list per appearance
 */

/**
 * @param {Row[]} rows
 * @param {Record<string, string>} abbreviations
 * @returns {Map<string, Appearance>} keyed by (class, name)
 */
export function collectAppearances(rows, abbreviations) {
    /** @type {Map<string, Appearance>} */
    const appearances = new Map();
    for (const row of rows) {
        const people = rowPeople(row, abbreviations);
        for (const person of people) {
            // The subject is never its own evidence. Excluding by NAME covers
            // both its own cell and the SAME person written again elsewhere in
            // the row — a player slot AND an Others? entry, which is how the
            // rows that overflow the quartet layout get logged. Without it a
            // bare name sitting beside its own full form scores a point for
            // being the person already named in that row.
            //
            // A reader comparing a row as written against the same row as
            // filled needs a second, positional exclusion, because there the
            // subject's own cell may hold a different string ("Peter" written,
            // "Peter Ouyang" filled) and the name test cannot see it. That case
            // does not arise within one row's cast, so `seat` is carried on
            // Person for that reader rather than used here.
            const teammates = people
                .filter(p => p.name !== person.name)
                .map(p => p.name);
            const cls = person.cls ?? ANY_CLASS;
            const k = key(cls, person.name);
            let entry = appearances.get(k);
            if (!entry) {
                entry = { name: person.name, cls, teammates: [] };
                appearances.set(k, entry);
            }
            entry.teammates.push(teammates);
        }
    }
    return appearances;
}

/**
 * How often each teammate was seen across a name's appearances.
 * @param {string[][]} teammateLists
 * @returns {Map<string, number>}
 */
export function teammateCounts(teammateLists) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const list of teammateLists) {
        for (const name of list) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function jaccard(a, b) {
    if (!a.size && !b.size) return 0;
    let shared = 0;
    for (const x of a) if (b.has(x)) shared++;
    return shared / (a.size + b.size - shared);
}

/**
 * Lowercased first whitespace-separated token — groups "Jo", "Jo Alpha" and
 * " jo " together.
 * @param {string} name
 * @returns {string}
 */
export function baseToken(name) {
    const [first] = name.trim().split(/\s+/);
    return (first || name).toLowerCase();
}

/**
 * A written-out name: not a bare first name, and not an initialled one.
 *
 * "Peter O" is Peter Ouyang with the surname abbreviated, not a second Peter.
 * Admitting it as a candidate invents a rival for the real person.
 * @param {string} name
 * @returns {boolean}
 */
export function isFullName(name) {
    const tokens = name.trim().split(/\s+/);
    return tokens.length > 1 && tokens[tokens.length - 1].replace(/\.+$/, '').length > 1;
}

/**
 * Who a bare first name could be, plus the evidence about each.
 *
 * `byFirst` is keyed by (class, first token) because PLAYER_ALIASES is keyed
 * by class: a cello-slot "Jo" must not draw the upper-class Jo, whose larger
 * teammate set would then win and report the correct class-keyed alias as
 * wrong.
 *
 * The other two returns want DIFFERENT views of the same rows, which is why
 * this takes two appearance maps:
 *
 *   `written` counts must come from the rows AS WRITTEN. A typed name is
 *   evidence, an alias-supplied one is the hypothesis under test and a
 *   fill-forwarded one is the sheet repeating itself — counting the last lets
 *   a name typed once in a five-piece session clear an attestation threshold
 *   five times over.
 *
 *   `circles` are the opposite. Who someone played with is a fact about the
 *   room, and fill-forward is how the sheet states it: on the written view a
 *   continuation row names nobody, so a full name written in such a row's
 *   Others? cell carries an empty circle however many sessions it played.
 *
 * @param {Map<string, Appearance>} appearances - from the WRITTEN view
 * @param {Map<string, Appearance>} [circleAppearances] - from the FILLED view;
 *   defaults to `appearances` for the sections that only need the first two
 *   returns and have no filled view to hand.
 * @returns {{
 *   byFirst: Map<string, Set<string>>,
 *   circles: Map<string, Set<string>>,
 *   written: Map<string, number>,
 * }}
 */
export function candidateIndex(appearances, circleAppearances = appearances) {
    /** @type {Map<string, Set<string>>} */
    const byFirst = new Map();
    /** @type {Map<string, Set<string>>} */
    const circles = new Map();
    /** @type {Map<string, number>} */
    const written = new Map();
    for (const { name, cls, teammates } of appearances.values()) {
        if (!isFullName(name)) continue;
        const k = key(cls, baseToken(name));
        if (!byFirst.has(k)) byFirst.set(k, new Set());
        /** @type {Set<string>} */ (byFirst.get(k)).add(name);
        written.set(name, (written.get(name) ?? 0) + teammates.length);
    }
    for (const { name, teammates } of circleAppearances.values()) {
        if (!isFullName(name)) continue;
        if (!circles.has(name)) circles.set(name, new Set());
        const circle = /** @type {Set<string>} */ (circles.get(name));
        for (const mate of teammateCounts(teammates).keys()) circle.add(mate);
    }
    return { byFirst, circles, written };
}

/**
 * Who a bare name in this class could be.
 *
 * Always includes the ANY_CLASS bucket: a full name in an unannotated Others?
 * cell has no class of its own, but it is still a person with that first name
 * and so still a candidate. A subject with no class of its own draws from
 * every bucket, since nothing narrows it.
 * @param {Map<string, Set<string>>} byFirst
 * @param {string} token
 * @param {string|null} cls
 * @returns {Set<string>}
 */
export function candidatesFor(byFirst, token, cls) {
    /** @type {Set<string>} */
    const out = new Set();
    if (cls === null || cls === ANY_CLASS) {
        for (const [k, names] of byFirst) {
            if (keyTail(k) === token) for (const n of names) out.add(n);
        }
        return out;
    }
    for (const k of [key(cls, token), key(ANY_CLASS, token)]) {
        for (const n of byFirst.get(k) ?? []) out.add(n);
    }
    return out;
}

/**
 * Class-blind view of `byFirst`: first token to every full name sharing it.
 * The alias-key checks want this, since an alias key is not class-scoped.
 * @param {Map<string, Set<string>>} byFirst
 * @returns {Map<string, Set<string>>}
 */
export function namesByFirst(byFirst) {
    /** @type {Map<string, Set<string>>} */
    const out = new Map();
    for (const [k, names] of byFirst) {
        const token = keyTail(k);
        if (!out.has(token)) out.set(token, new Set());
        const bucket = /** @type {Set<string>} */ (out.get(token));
        for (const n of names) bucket.add(n);
    }
    return out;
}
