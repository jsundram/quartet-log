#!/usr/bin/env node
// @ts-check
// Screens each CLAUDE.md claim against the comment prose of its best-matching
// file, because the dominant waste in a briefing file is not derivable
// listings but the same rationale written twice — once at the site, once here.
// The score is the share of the claim's three-word sequences that already
// appear in that file: shared phrasing, not shared topic.
// Scoring is in lib/overlap.mjs; this file is the corpus, the diff and the
// report.
//
// Usage:
//   node scripts/claudemd_overlap.mjs            whole-file ranking + stats
//   node scripts/claudemd_overlap.mjs --explain  each flag beside what it matched
//   node scripts/claudemd_overlap.mjs --check    only what `git diff --cached` touched
//   node scripts/claudemd_overlap.mjs --check --worktree   ... including unstaged edits
//   ... --quiet                                   print nothing unless something flags
//   node scripts/claudemd_overlap.mjs --hook     read a Claude Code hook payload on
//                                                stdin, answer with its JSON
//   ... --check --base <ref> --markdown          score what a branch changed, as a
//                                                report for $GITHUB_STEP_SUMMARY
//   node scripts/claudemd_overlap.mjs --calibrate re-derive THRESHOLD from a trim commit
//
// --check is the property that makes this converge: inherited text never
// fires, so every flag is answerable by whoever is writing the prose in front
// of them. It warns and exits 0 — see THRESHOLD for why it must not gate.
//
// Three callers, three moments, and the same claims-you-changed rule for each.
// The pre-commit hook takes the index, which is what the commit will contain.
// The editor hook (.claude/settings.json) takes --hook, because at the moment
// prose is written nothing is staged yet, and that is the moment the writer can
// still act on a flag. CI takes --base, which is the merge base, and reports
// into the PR's checks page for whoever reviews it — the only one of the three
// that still fires when nobody installed the hooks.
//
// --hook does its own payload parsing rather than composing jq and grep in the
// settings file. A missing jq does not fail loudly there — the pipeline just
// produces nothing and the hook exits 0 — so on any machine without it the
// screen would silently never run, which is the one failure this whole thing
// exists to avoid. node and git are the only things it needs, and neither can
// be missing where it runs.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
    buildCorpus, parseClaims, isScoreable, bestMatch, median, proseSyntax, SHINGLE_N,
} from './lib/overlap.mjs';

/**
 * Measured, not guessed. Scoring the claims #15 deleted against the ones it
 * kept — every one of those hand-verified as a deliberate keep — gives:
 *
 *     threshold   flags of the deleted   flags of the keeps
 *         8%            79%                   47%
 *        10%            75%                   33%
 *        12%            71%                   23%
 *        15%            61%                   17%
 *        19%            54%                   10%
 *
 * `--calibrate` reprints that table, so it is checkable rather than asserted.
 *
 * 12% is the most sensitive setting whose false-flag rate on known-good claims
 * stays under the one in three that #15 found unusable by hand, which is the
 * same rule the word-overlap screen this replaced was set by — and it beats
 * that screen on both axes at once, where it caught 54% of the deletions while
 * firing on 24% of the keeps. A low-looking number is the point: sharing an
 * eighth of your phrasing with one file is not something independent prose
 * does. Best separation sits a little higher, at 17% (59% and 10%), if the
 * flags ever feel too frequent to read.
 *
 * Re-derive rather than nudge this. A threshold that has to be lowered to
 * catch a particular duplicate is usually one the screen cannot see: it reads
 * phrasing, so a claim genuinely rewritten in other words scores near zero no
 * matter where the line sits, and no setting recovers it.
 */
export const THRESHOLD = 0.12;

// Paths here are repo-relative and every read has to agree with them, so
// anchor both to the top level rather than to wherever this was invoked.
// Resolved lazily: importing this module for its functions must not shell out.
let root = '';
const repoRoot = () => (root ||= execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const git = (...args) => execFileSync('git', ['-C', repoRoot(), ...args], { encoding: 'utf8' });

/** Every tracked file whose prose the screen reads, minus the briefing files. */
function corpusPaths() {
    return git('ls-files').split('\n')
        .filter((p) => p && proseSyntax(p) && !isBriefing(p));
}

/**
 * Is this a briefing file? Absolute paths count: the editor hook is handed one
 * by Claude Code, while everything else here works in repo-relative paths, and
 * two spellings of this question is one of them silently answering differently.
 * @param {string} path
 */
export function isBriefing(path) {
    return /(^|[/\\])CLAUDE\.md$/.test(path);
}

/**
 * The CLAUDE.md files, root first.
 *
 * Untracked ones count. A new nested briefing file is how a claim gets moved
 * out of the root file rather than deleted, and that is duplication scoring as
 * a saving — the failure mode a size budget would have rewarded.
 */
function briefingPaths() {
    return git('ls-files', '--cached', '--others', '--exclude-standard')
        .split('\n').filter((p) => p && isBriefing(p))
        .sort((a, b) => a.split('/').length - b.split('/').length);
}

/** @param {string} path */
function isTracked(path) {
    return git('ls-files', '--', path).trim() !== '';
}

/** @param {string} path */
function readOrEmpty(path) {
    try {
        return readFileSync(join(repoRoot(), path), 'utf8');
    } catch {
        return '';
    }
}

/**
 * The corpus a given briefing file is scored against: for the root file, the
 * whole repo; for a nested one, its own directory. Every briefing file also
 * scores against the *other* briefing files — moving text from the root into
 * `md/CLAUDE.md` is duplication, not a saving, and nothing else would see it.
 * @param {string} briefing
 * @param {string[]} allBriefings
 */
function corpusFor(briefing, allBriefings) {
    const dir = briefing.includes('/') ? briefing.slice(0, briefing.lastIndexOf('/') + 1) : '';
    const paths = corpusPaths().filter((p) => p.startsWith(dir))
        .concat(allBriefings.filter((p) => p !== briefing));
    return buildCorpus(paths.map((path) => ({ path, text: readOrEmpty(path) })));
}

/**
 * The line numbers a unified diff adds, read off its hunk headers.
 *
 * Deliberately the added side only. A claim whose lines were merely deleted
 * around is not a claim anyone is writing, and scoring it would put inherited
 * text back in front of the author — the thing that stops this converging.
 * @param {string} diff
 * @returns {Set<number>}
 */
export function addedLines(diff) {
    /** @type {Set<number>} */
    const lines = new Set();
    for (const header of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(header[1]);
        const count = header[2] === undefined ? 1 : Number(header[2]);
        for (let i = 0; i < count; i++) lines.add(start + i);
    }
    return lines;
}

/**
 * The lines this change adds to `path`: those a branch adds since `base`, those
 * the working tree adds to HEAD, or those staged for the next commit. A file
 * git has never seen is added in its entirety.
 * @param {string} path
 * @param {{worktree: boolean, base: string}} opts
 * @returns {Set<number>}
 */
function changedLines(path, opts) {
    if (!isTracked(path)) {
        return new Set(readOrEmpty(path).split('\n').map((_, i) => i + 1));
    }
    // Three dots, not two: what the branch added, not everything that has
    // happened on the base since it forked. On a busy base the difference is
    // every claim somebody else wrote, put in front of the wrong author.
    const args = opts.base
        ? ['diff', `${opts.base}...HEAD`]
        : ['diff', ...(opts.worktree ? ['HEAD'] : ['--cached'])];
    return addedLines(git(...args, '--unified=0', '--', path));
}

/** @param {import('./lib/overlap.mjs').Claim} claim @param {Set<number>} lines */
export function touches(claim, lines) {
    for (let n = claim.start; n <= claim.end; n++) if (lines.has(n)) return true;
    return false;
}

const pct = (x) => `${Math.round(100 * x)}%`;

/**
 * @param {import('./lib/overlap.mjs').Match} match
 * @param {string} briefing
 * @param {boolean} explain
 */
function format(match, briefing, explain) {
    const { claim, score, path, block, shared } = match;
    const head = `${pct(score).padStart(4)}  ${briefing}:${claim.start}`
        + `  [${claim.section || '—'}]  vs ${path}${block ? `:${block.line}` : ''}`;
    const out = [head, `      ${trim(claim.text, 220)}`];
    if (explain && block) {
        out.push(`      ↳ ${path}:${block.line}`, `        ${trim(block.text, 220)}`);
        // Longest first: one restated sentence settles a flag, and a list of
        // three-word fragments is what the reader would have to reassemble.
        for (const phrase of shared.slice(0, 3)) out.push(`      shared: "${trim(phrase, 200)}"`);
        if (shared.length > 3) out.push(`      shared: +${shared.length - 3} shorter runs`);
    }
    return out.join('\n');
}

/** @param {string} text @param {number} n */
function trim(text, n) {
    return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}

/** @typedef {import('./lib/overlap.mjs').Match & { briefing: string }} Flag */

/**
 * @param {{check: boolean, worktree: boolean, base: string, explain: boolean,
 *   quiet: boolean, markdown: boolean, top: number}} opts
 * @returns {string|null} the report, or null when there is nothing to say
 */
function run(opts) {
    const briefings = briefingPaths();
    /** @type {Flag[]} */
    const flagged = [];
    /** @type {number[]} */
    const scores = [];
    let scored = 0;

    for (const briefing of briefings) {
        // Without --worktree the claims come from the index, which is what the
        // commit will contain. The corpus is the working tree either way: the
        // question is whether this prose restates the code as it now stands.
        const fromIndex = opts.check && !opts.worktree && !opts.base;
        const text = fromIndex ? stagedText(briefing) : readOrEmpty(briefing);
        if (!text) continue;
        let claims = parseClaims(text).filter(isScoreable);
        if (opts.check) {
            const lines = changedLines(briefing, opts);
            if (!lines.size) continue;
            claims = claims.filter((c) => touches(c, lines));
        }
        if (!claims.length) continue;
        const corpus = corpusFor(briefing, briefings);
        for (const claim of claims) {
            const match = bestMatch(claim, corpus);
            scored++;
            scores.push(match.score);
            if (match.score >= THRESHOLD) flagged.push(Object.assign({ briefing }, match));
        }
    }

    if (opts.check && !scored) return null;
    // The editor hook fires on every CLAUDE.md keystroke's worth of edit. A
    // banner saying nothing was found is noise there, and noise is what gets a
    // warn-only check ignored.
    if (opts.quiet && !flagged.length) return null;

    const lines = [];
    const what = `${opts.check ? 'changed claim' : 'claim'}${scored === 1 ? '' : 's'}`;
    lines.push(`${scored} ${what} scored against source comments `
        + `(share of ${SHINGLE_N}-word sequences already there) — `
        + `${flagged.length} at or above ${pct(THRESHOLD)}`
        + (scored ? `, median ${pct(median(scores))}` : ''));
    lines.push('');
    const show = flagged.sort((a, b) => b.score - a.score).slice(0, opts.top);
    for (const m of show) {
        lines.push(format(m, m.briefing, opts.explain || opts.check), '');
    }
    if (flagged.length > show.length) {
        lines.push(`… ${flagged.length - show.length} more at or above ${pct(THRESHOLD)}.`, '');
    }
    if (flagged.length) {
        lines.push('A shared phrase is not a shared claim: on prose somebody has already');
        lines.push('verified by hand this still fires about one time in five. Cut a claim only');
        lines.push('if the comment it matched already makes it, and keep it if it says');
        lines.push('something no single file can.');
        if (!opts.explain && !opts.check) lines.push('Run with --explain to see what each one matched.');
    }
    return opts.markdown ? asMarkdown(lines.join('\n')) : lines.join('\n');
}

/**
 * The same report, for a GitHub step summary. Fenced rather than tabulated:
 * the claim and the comment it matched are what make a flag decidable, and
 * they are prose, which a Markdown table would rewrap into nonsense.
 * @param {string} report
 */
export function asMarkdown(report) {
    return [
        '## CLAUDE.md overlap screen',
        '',
        '```',
        report,
        '```',
        '',
        '_A report, not a gate. Nothing here fails the build._',
        '',
    ].join('\n');
}

/**
 * The staged content of a file — what the commit will contain, which is not
 * what is on disk when only some of the edits are staged.
 * @param {string} path
 */
function stagedText(path) {
    try {
        return git('show', `:${path}`);
    } catch {
        return '';
    }
}

/**
 * Re-derive the THRESHOLD table: score the claims a trim commit deleted
 * against the ones it kept, both against that commit's own corpus.
 *
 * The deleted claims are not all duplicates (that commit also cut derivable
 * file listings) and the kept ones were verified by hand, so read the second
 * column as the rate that matters: how often the screen fires on a claim
 * somebody already decided to keep.
 * @param {string} ref
 */
function calibrate(ref) {
    const at = (rev, path) => {
        try {
            return git('show', `${rev}:${path}`);
        } catch {
            return '';
        }
    };
    let tree;
    try {
        tree = git('ls-tree', '-r', '--name-only', `${ref}^`);
    } catch {
        console.error(`No such commit: ${ref}. Pass the trim commit to calibrate against.`);
        process.exit(1);
    }
    const paths = tree.split('\n').filter((p) => p && proseSyntax(p) && !isBriefing(p));
    const corpus = buildCorpus(paths.map((path) => ({ path, text: at(`${ref}^`, path) })));
    const normalize = (t) => t.replace(/\s+/g, ' ').trim();
    const kept = parseClaims(at(ref, 'CLAUDE.md')).filter(isScoreable);
    const keptText = new Set(kept.map((c) => normalize(c.text)));
    const cut = parseClaims(at(`${ref}^`, 'CLAUDE.md')).filter(isScoreable)
        .filter((c) => !keptText.has(normalize(c.text)));
    const score = (claims) => claims.map((c) => bestMatch(c, corpus).score);
    const cutScores = score(cut);
    const keptScores = score(kept);
    const rate = (scores, t) => `${Math.round(100 * scores.filter((s) => s >= t).length / scores.length)}%`;

    console.log(`${ref}: ${cut.length} claims deleted, ${kept.length} kept, `
        + `scored against ${corpus.length} files as they stood at ${ref}^`);
    console.log(`median deleted ${pct(median(cutScores))}, median kept ${pct(median(keptScores))}\n`);
    console.log('threshold   flags of the deleted   flags of the keeps');
    for (const t of [0.08, 0.1, 0.12, 0.15, 0.19]) {
        console.log(`   ${pct(t).padStart(4)}           ${rate(cutScores, t).padStart(4)}`
            + `                 ${rate(keptScores, t).padStart(4)}`
            + (t === THRESHOLD ? '   <- THRESHOLD' : ''));
    }
}

/**
 * Answer a Claude Code PostToolUse payload: screen the file it just wrote, and
 * hand any flags back as context the writer sees immediately.
 *
 * Silence is the common case and the right one — this fires on every edit.
 */
async function hookMode() {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    let path = '';
    try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        path = payload.tool_input?.file_path ?? payload.tool_response?.filePath ?? '';
    } catch {
        return;
    }
    if (!isBriefing(path)) return;
    // This runs after every edit in the repo. It may say nothing, but it must
    // never fail: a hook that errors turns into noise the writer learns to
    // scroll past, and a screen nobody reads screens nothing.
    /** @type {string|null} */
    let report = null;
    try {
        report = run({
            check: true, worktree: true, base: '', explain: false,
            quiet: true, markdown: false, top: 8,
        });
    } catch {
        return;
    }
    if (!report) return;
    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: report },
    }));
}

/**
 * Was this module the file node was asked to execute? Importing it for its
 * functions must not run it, and must not shell out to git. Both sides are
 * realpath'd and the comparison is guarded — see lib/cli.mjs's runAudit, where
 * a symlinked invocation path made the same check silently never match.
 */
function invokedDirectly() {
    try {
        return !!process.argv[1]
            && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (invokedDirectly()) {
    const argv = process.argv.slice(2);
    if (argv.includes('--hook')) {
        await hookMode();
        process.exit(0);
    }
    const topArg = argv.indexOf('--top');
    const calibrateArg = argv.indexOf('--calibrate');
    if (calibrateArg !== -1) {
        // The trim that produced the table in THRESHOLD's comment.
        calibrate(argv[calibrateArg + 1] ?? 'c2487a2');
        process.exit(0);
    }
    const baseArg = argv.indexOf('--base');
    const report = run({
        check: argv.includes('--check'),
        worktree: argv.includes('--worktree'),
        base: baseArg === -1 ? '' : (argv[baseArg + 1] ?? ''),
        explain: argv.includes('--explain'),
        quiet: argv.includes('--quiet'),
        markdown: argv.includes('--markdown'),
        top: topArg !== -1 && Number.isFinite(Number(argv[topArg + 1]))
            ? Number(argv[topArg + 1])
            : 16,
    });
    if (report) console.log(report);
    // Warn-only, always. The judgement is human and roughly one flag in five is
    // a keep; a check that misfires at that rate gets disabled, and then it
    // screens nothing at all.
    process.exit(0);
}
