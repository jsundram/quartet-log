#!/usr/bin/env node
// @ts-check
// Audit player-name variants in the music log.
//
// Groups variants by lowercased first token and reports occurrence counts and
// top co-occurring teammates per (variant, class), so you can decide which
// short forms belong in PLAYER_ALIASES — and, in the AMBIGUITY section, which
// must NOT go in because several people now share the name.
//
// Reads the WRITTEN view throughout. Every question here is about what a human
// typed: how often a full name was spelled out, which cells still hold a bare
// one, whether an alias key is still present in the sheet. Fill-forward
// synthesises values nobody typed and normalizePlayerNames replaces short
// forms with the very guesses under test, so either would answer a different
// question than the one being asked.
//
// Usage: node scripts/audit_aliases.mjs [path/to/data-raw.csv]
//        (defaults to archive/data-raw.csv)

import {
    ANY_CLASS, baseToken, candidateIndex, candidatesFor, collectAppearances,
    jaccard, namesByFirst, teammateCounts,
} from './lib/people.mjs';
import { loadViews, viewsHeader } from './lib/views.mjs';
import { readNameTables, runAudit, warnIfStub } from './lib/cli.mjs';

/** @typedef {import('../src/dataProcessor.js').Row} Row */
/** @typedef {import('./lib/views.mjs').Views} Views */
/** @typedef {import('./lib/views.mjs').NameTables} NameTables */
/** @typedef {import('./lib/people.mjs').Appearance} Appearance */

// Quote a name for display. Single quotes unless the name contains one —
// "Loretta O'Sullivan" reads, 'Loretta O'Sullivan' does not.
/** @param {string} s */
const q = s => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s}'`);
/** @param {string} s @param {number} n */
const pad = (s, n) => s.padEnd(n);
/** @param {number} n @param {number} w */
const num = (n, w) => String(n).padStart(w);
/** @param {number} f */
const pct = f => `${Math.round(f * 100)}%`;

// Teammate-overlap above which a short form is proposed as an alias of a
// longer one. Heuristic; every proposal is reviewed by a human before it goes
// anywhere near src/aliases.js.
const OVERLAP_THRESHOLD = 0.20;

/**
 * @param {Record<string, import('../src/aliases.stub.js').AliasEntry>} aliases
 * @param {string} variant
 * @param {string} cls
 */
function alreadyAliased(aliases, variant, cls) {
    return Object.prototype.hasOwnProperty.call(aliases, variant)
        && cls in aliases[variant];
}

/**
 * Variants sharing a first token, grouped for the report below.
 * @typedef {Object} Variant
 * @property {string} name
 * @property {string} cls
 * @property {number} count
 * @property {string[][]} teammates
 */

/**
 * @param {Map<string, Appearance>} appearances
 * @returns {Map<string, Variant[]>} first token → variants sharing it
 */
export function groupVariants(appearances) {
    /** @type {Map<string, Variant[]>} */
    const groups = new Map();
    for (const { name, cls, teammates } of appearances.values()) {
        const token = baseToken(name);
        if (!groups.has(token)) groups.set(token, []);
        /** @type {Variant[]} */ (groups.get(token)).push({
            name, cls, count: teammates.length, teammates,
        });
    }
    return groups;
}

/** @param {Variant[]} variants @returns {Map<string, Variant[]>} */
function byClass(variants) {
    /** @type {Map<string, Variant[]>} */
    const out = new Map();
    for (const v of variants) {
        // ANY_CLASS is an index key, not a class the app can alias on:
        // canonicalize only ever looks up 'upper'/'cello', so a proposed
        // { any: ... } entry is inert when pasted, then makes the name read as
        // handled on the next run, and — since alreadyAliased can never be
        // true for it — is re-proposed forever.
        if (v.cls === ANY_CLASS) continue;
        if (!out.has(v.cls)) out.set(v.cls, []);
        /** @type {Variant[]} */ (out.get(v.cls)).push(v);
    }
    return out;
}

/**
 * The per-first-token variant listing, and the alias proposals it yields.
 * @param {Map<string, Variant[]>} groups
 * @param {NameTables} tables
 * @returns {{ lines: string[], proposals: Map<string, Map<string, string>> }}
 */
export function variantReport(groups, { aliases }) {
    /** @type {string[]} */
    const lines = [];
    /** @type {Map<string, Map<string, string>>} */
    const proposals = new Map();
    for (const token of [...groups.keys()].sort()) {
        const variants = [...(groups.get(token) ?? [])];
        // Only interesting if more than one distinct (name, class) shares the
        // token, and not if the only variation is whitespace.
        const distinctNames = new Set(variants.map(v => v.name));
        if (distinctNames.size <= 1 && variants.length <= 1) continue;
        if (new Set(variants.map(v => v.name.trim())).size <= 1
            && new Set(variants.map(v => v.cls)).size <= 1) continue;

        lines.push(`=== '${token}' (${variants.length} variants) ===`);
        variants.sort((a, b) => b.count - a.count);
        for (const { name, cls, count, teammates } of variants) {
            const top = [...teammateCounts(teammates).entries()]
                .sort((a, b) => b[1] - a[1]).slice(0, 5)
                .map(([n, c]) => `${n}×${c}`).join(', ');
            const marker = alreadyAliased(aliases, name, cls) ? ' *seeded*' : '';
            lines.push(`  ${pad(q(name), 35)} [${pad(cls, 5)}] ${num(count, 4)}×${marker}`
                + `   teammates: ${top}`);
        }

        // Within each class the longest-multi-token name is canonical; shorter
        // names mapping into it need teammate overlap above the threshold.
        for (const [cls, vs] of byClass(variants)) {
            const sorted = [...vs].sort((a, b) =>
                b.name.split(/\s+/).length - a.name.split(/\s+/).length || b.count - a.count);
            const canonical = sorted[0];
            const canonMates = new Set(teammateCounts(canonical.teammates).keys());
            for (const variant of sorted.slice(1)) {
                if (variant.name.trim() === canonical.name.trim()) continue;
                if (alreadyAliased(aliases, variant.name, cls)) continue;
                const overlap = jaccard(canonMates,
                    new Set(teammateCounts(variant.teammates).keys()));
                const evidence = `overlap=${pct(overlap)}, ${variant.count}×`;
                if (overlap >= OVERLAP_THRESHOLD) {
                    if (!proposals.has(variant.name)) proposals.set(variant.name, new Map());
                    /** @type {Map<string, string>} */
                    (proposals.get(variant.name)).set(cls, canonical.name);
                    lines.push(`    → propose ${q(variant.name)} [${cls}] → `
                        + `${q(canonical.name)}  (${evidence})`);
                } else {
                    lines.push(`    ? skip   ${q(variant.name)} [${cls}] vs `
                        + `${q(canonical.name)}  (${evidence})`);
                }
            }
        }
        lines.push('');
    }
    return { lines, proposals };
}

/**
 * Every short variant that MIGHT alias to a longer name in the same class,
 * regardless of teammate overlap, sorted by short-variant count so the
 * high-impact cases triage first. Use this when the auto-proposals miss an
 * obvious one — e.g. short-form data from a different period than the long
 * form, which shares no teammates at all.
 * @param {Map<string, Variant[]>} groups
 * @param {NameTables} tables
 * @returns {string[]}
 */
export function reviewReport(groups, { aliases }) {
    /** @type {{ scount: number, cls: string, short: string, long: string,
     *   lcount: number, overlap: number }[]} */
    const rows = [];
    for (const variants of groups.values()) {
        for (const [cls, vs] of byClass(variants)) {
            if (vs.length < 2) continue;
            for (const short of vs) {
                for (const long of vs) {
                    if (long.name === short.name) continue;
                    if (short.name.split(/\s+/).length >= long.name.split(/\s+/).length) continue;
                    if (alreadyAliased(aliases, short.name, cls)) continue;
                    rows.push({
                        scount: short.count, cls, short: short.name, long: long.name,
                        lcount: long.count,
                        overlap: jaccard(new Set(teammateCounts(short.teammates).keys()),
                            new Set(teammateCounts(long.teammates).keys())),
                    });
                }
            }
        }
    }
    rows.sort((a, b) => b.scount - a.scount || (a.short < b.short ? -1 : a.short > b.short ? 1 : 0));
    const lines = [
        '',
        '=== REVIEW: candidate aliases sorted by short-form count ===',
        '(Eyeball — accept the real ones, ignore homonyms. Format: short → candidate)',
        '',
    ];
    for (const r of rows) {
        lines.push(`  ${r.overlap >= OVERLAP_THRESHOLD ? '✓' : ' '} [${pad(r.cls, 5)}] `
            + `${pad(q(r.short), 30)} (${num(r.scount, 3)}×)  →  ${q(r.long)}  `
            + `(${r.lcount}×, overlap ${pct(r.overlap)})`);
    }
    return lines;
}

/**
 * First names that no longer identify exactly one person.
 *
 * The variant grouping above answers "which short forms belong in
 * PLAYER_ALIASES". This answers the complementary question: which short forms
 * must NOT go in, because an alias maps one name to one person and the sheet
 * now holds several who share it.
 *
 * Three hazards, none of them visible in the grouping above:
 *   1. A bare first name still in the sheet that two or more full names could
 *      match. No alias can express "this row is Alice Hart and that one is
 *      Alice Bek" — the ROWS have to be edited.
 *   2. An existing alias keyed on such a name. It resolves silently, so every
 *      future bare entry lands on whichever person the table names.
 *   3. An alias whose canonical name appears nowhere in the sheet and isn't
 *      what any sheet name resolves to — usually a spelling fix applied to the
 *      data but not here.
 *
 * Hazards 1 and 2 can only fire once a second full name with that first name
 * exists in the data: a short form that is genuinely ambiguous in real life
 * still looks unique here until someone with the same first name gets logged.
 *
 * @param {Map<string, Appearance>} appearances - from the WRITTEN view
 * @param {NameTables} tables
 * @returns {string[]}
 */
export function ambiguityReport(appearances, { aliases }) {
    // One candidate definition for the whole section: byFirst is class-keyed
    // for the per-name verdicts, and namesByFirst is the class-blind view the
    // alias-key checks want, since an alias key is not class-scoped.
    const { byFirst } = candidateIndex(appearances);
    const names = namesByFirst(byFirst);
    /** @type {Map<string, { name: string, cls: string, count: number }>} */
    const bare = new Map();
    // Two senses of "present", and hazard 3 needs both. `present` is what a
    // human actually typed; `resolved` adds what each of those names becomes
    // after normalizePlayerNames — the alias targets that are live by
    // definition, since the key sits in the sheet driving them.
    /** @type {Set<string>} */ const present = new Set();
    /** @type {Set<string>} */ const resolved = new Set();
    for (const { name, cls, teammates } of appearances.values()) {
        present.add(name);
        resolved.add(aliases[name]?.[/** @type {'upper'|'cello'} */ (cls)] ?? name);
        if (name.trim().split(/\s+/).length === 1) {
            const key = `${cls}|${name}`;
            const entry = bare.get(key) ?? { name, cls, count: 0 };
            entry.count += teammates.length;
            bare.set(key, entry);
        }
    }
    // Surnames the sheet writes down anywhere: the test for whether the
    // gitignored table is the only place a canonical name's surname exists.
    const sheetSurnames = new Set([...present]
        .map(n => n.trim().split(/\s+/))
        .filter(t => t.length > 1)
        .map(t => t[t.length - 1].toLowerCase()));

    const lines = [
        '',
        '=== AMBIGUITY: first names that no longer identify one person ===',
        '(Hazards the variant grouping above cannot see.)',
    ];

    // 1. Bare names still in the sheet that several full names could match.
    const unresolvable = [...bare.values()]
        .map(b => ({ ...b, candidates: [...candidatesFor(byFirst, baseToken(b.name), b.cls)].sort() }))
        .filter(b => b.candidates.length >= 2)
        .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    lines.push('', `-- bare names in the sheet with 2+ candidates (${unresolvable.length}) --`,
        '   Fix these in the SHEET; an alias can only guess one of them.');
    if (!unresolvable.length) lines.push('   (none)');
    for (const { name, cls, count, candidates } of unresolvable) {
        const mapped = aliases[name]?.[/** @type {'upper'|'cello'} */ (cls)];
        const note = mapped ? `alias says ${q(mapped)}`
            : 'NO alias — counted as its own person';
        lines.push(`   ${pad(q(name), 18)} [${pad(cls, 5)}] ${num(count, 4)}×   ${note}`);
        lines.push(`   ${pad('', 18)}         candidates: ${candidates.join(', ')}`);
    }

    // 2. Aliases keyed on a first name several people now share. Multi-token
    // keys ("Jo A", "Jo Alpha") are already disambiguated, so skip them.
    const risky = Object.entries(aliases)
        .filter(([key]) => key.trim().split(/\s+/).length === 1
            && (names.get(key.toLowerCase())?.size ?? 0) >= 2)
        .map(([key, mapping]) => ({
            key, mapping, candidates: [...(names.get(key.toLowerCase()) ?? [])].sort(),
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    lines.push('', `-- aliases keyed on an ambiguous first name (${risky.length}) --`,
        '   Each silently resolves future bare entries to one person.');
    if (!risky.length) lines.push('   (none)');
    for (const { key, mapping, candidates } of risky) {
        const targets = Object.entries(mapping).sort()
            .map(([cls, n]) => `${cls}→${n}`).join(', ');
        const others = candidates.filter(c => !Object.values(mapping).includes(c));
        lines.push(`   ${pad(q(key), 18)} ${targets}`);
        lines.push(`   ${pad('', 18)} also in sheet: ${others.join(', ') || '—'}`);
    }

    // 3. Aliases pointing at a name the sheet no longer contains.
    const dangling = Object.entries(aliases)
        .flatMap(([key, mapping]) => Object.entries(mapping)
            .map(([cls, canon]) => ({ key, cls, canon: /** @type {string} */ (canon) })))
        .filter(d => !present.has(d.canon))
        .sort((a, b) => `${a.key}|${a.cls}|${a.canon}`.localeCompare(`${b.key}|${b.cls}|${b.canon}`));
    // Two very different things land here. Recording a surname the sheet never
    // had is the point of the table for anyone logged by first name only, and
    // a surname written nowhere in the sheet is its signature — nicknames
    // ("Bo" -> "Carol Hart") included, since the file is just as much the only
    // record of those. A canonical name whose surname the sheet DOES carry is
    // a spelling that drifted, and only that is a bug — so they are split
    // rather than piled into one count nobody reads.
    const lastToken = (/** @type {string} */ n) => {
        const t = n.trim().split(/\s+/);
        return t[t.length - 1].toLowerCase();
    };
    const expected = dangling.filter(d => !sheetSurnames.has(lastToken(d.canon)));
    // A canonical name the sheet resolves to is a working alias, not a broken
    // one — the normal shape of a spelling normalization ("Carol Hart" logged,
    // "Caro Hart" canonical) leaves the target absent from the sheet by
    // design. Reporting those sends you to delete a live alias, the failure
    // this whole section was added to prevent. The surname bucket above
    // deliberately keeps the literal test: its question is whether the SHEET
    // records the surname at all, and an alias resolving to it is exactly the
    // case where nothing but the table does.
    const suspect = dangling.filter(d => !expected.includes(d) && !resolved.has(d.canon));
    lines.push('', `-- aliases that are the ONLY record of a surname (${expected.length}) --`,
        '   Expected for anyone logged by first name only. Back this file up:',
        '   it is gitignored, so these surnames exist nowhere else.');
    if (!expected.length) lines.push('   (none)');
    for (const { key, cls, canon } of expected) {
        lines.push(`   ${pad(q(key), 18)} [${pad(cls, 5)}] -> ${q(canon)}`);
    }
    lines.push('', `-- aliases whose canonical name is absent and unrelated (${suspect.length}) --`,
        '   A nickname, or a spelling that changed in the data but not here.');
    if (!suspect.length) lines.push('   (none)');
    for (const { key, cls, canon } of suspect) {
        const near = [...(names.get(baseToken(canon)) ?? [])].sort();
        const hint = near.length ? `   did you mean: ${near.join(', ')}` : '';
        lines.push(`   ${pad(q(key), 18)} [${pad(cls, 5)}] -> ${q(canon)}${hint}`);
    }
    return lines;
}

/**
 * The paste-ready block. Seed mappings win over proposals on conflict, since
 * the proposals are heuristic and the table is a decision someone made.
 * @param {NameTables} tables
 * @param {Map<string, Map<string, string>>} proposals
 * @returns {string[]}
 */
export function proposalBlock({ aliases }, proposals) {
    const lines = [
        '',
        '=== PLAYER_ALIASES proposal (paste into src/aliases.js — gitignored; '
        + 'NEVER into a tracked file) ===',
        '',
        'export const PLAYER_ALIASES = {',
    ];
    /** @param {Record<string, string>} merged */
    const body = merged => Object.entries(merged).sort()
        .map(([cls, n]) => `${cls}: "${n}"`).join(', ');
    for (const key of Object.keys(aliases).sort()) {
        const merged = {
            ...Object.fromEntries(proposals.get(key) ?? []),
            ...aliases[key],
        };
        lines.push(`    "${key}": { ${body(merged)} },`);
    }
    for (const key of [...proposals.keys()].sort()) {
        if (Object.prototype.hasOwnProperty.call(aliases, key)) continue;
        lines.push(`    "${key}": { ${body(Object.fromEntries(/** @type {Map<string,string>} */ (proposals.get(key))))} },`);
    }
    lines.push('};');
    if (proposals.size) {
        lines.push('',
            'After updating src/aliases.js, sync the deploy secret so the next',
            'deploy uses the new tables:  ./scripts/push_aliases.sh');
    }
    return lines;
}

/**
 * @param {Views} views
 * @param {NameTables} tables
 * @returns {string[]}
 */
export function runAliasAudit(views, tables) {
    const appearances = collectAppearances(views.written, tables.abbreviations);
    const groups = groupVariants(appearances);
    const lines = viewsHeader(views, views.written,
        `    Unique (name, class) pairs: ${appearances.size}`);
    lines.push('');
    const { lines: variantLines, proposals } = variantReport(groups, tables);
    lines.push(...variantLines);
    lines.push(...reviewReport(groups, tables));
    lines.push(...ambiguityReport(appearances, tables));
    lines.push(...proposalBlock(tables, proposals));
    return lines;
}

await runAudit(import.meta.url, 'archive/data-raw.csv', async csvPath => {
    const tables = await readNameTables();
    warnIfStub(tables);
    return runAliasAudit(loadViews(csvPath, tables), tables);
});
