// @ts-check
// Scoring for the CLAUDE.md overlap screen (scripts/claudemd_overlap.mjs).
// Pure: no fs, no git, no printing, so the tests can pin the judgement calls —
// the sequence width, what counts as prose — without a checkout to score
// against.
//
// What it measures: for each claim in a CLAUDE.md, the share of its three-word
// sequences that already appear in the comment prose of its best-matching
// file. Shared phrasing, not shared topic: the waste this hunts is the same
// rationale written twice, and rewriting rarely re-orders the words.

/** A claim shorter than this is a fragment, not a claim. */
export const MIN_CLAIM_CHARS = 120;

/**
 * Below this many words — roughly two sentences — a claim yields too few
 * sequences to score. Measured: dropping from 25 to 20 pulls in nine more
 * claims and costs six points of separation, because a single coincidental
 * phrase is a large share of a short claim's total.
 */
export const MIN_CLAIM_TOKENS = 25;

/**
 * Sequence width.
 *
 * Measured over the claims #15 deleted and the ones it kept, 2, 3 and 4
 * separate those two populations equally well in aggregate — and differ
 * entirely in headroom. Bigrams sit on a floor of coincidence ("the sheet", "a
 * row", "does not" are everywhere), which lifts the median hand-verified keep
 * to 25% and leaves a real duplicate clearing the loudest keep by only 3x; at
 * three words that margin is 7x. Four is cleaner still but goes blind to a
 * duplicate that changes any word in four, which is most rewriting.
 */
export const SHINGLE_N = 3;

/**
 * Words, lowercased, punctuation dropped.
 *
 * Every word counts, short ones included. At three-word sequences the function
 * words are most of what makes a phrase recognizable, and a stoplist here
 * would match "resolves the bare name" to "resolves a bare name" while also
 * joining phrases that were never adjacent.
 * @param {string} text
 * @returns {string[]}
 */
export function tokens(text) {
    return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

/**
 * The set of `n`-word sequences in `text`.
 * @param {string} text
 * @param {number} [n]
 * @returns {Set<string>}
 */
export function shingles(text, n = SHINGLE_N) {
    const words = tokens(text);
    /** @type {Set<string>} */
    const set = new Set();
    for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(' '));
    return set;
}

/** @typedef {{ line: number, text: string }} Block */

const COMMENT_MARKERS = {
    js: /^\s*(\/\/+|\/\*+|\*+\/?)\s?/,
    css: /^\s*(\/\*+|\*+\/?)\s?/,
    sh: /^\s*#+\s?/,
};

/**
 * Which comment syntax a path uses, or 'md' for prose files.
 * @param {string} path
 * @returns {'js'|'css'|'sh'|'md'|null}
 */
export function proseSyntax(path) {
    if (/\.(js|mjs|ts)$/.test(path)) return 'js';
    if (/\.css$/.test(path)) return 'css';
    if (/\.(sh|yml|yaml)$/.test(path)) return 'sh';
    if (/\.md$/.test(path)) return 'md';
    return null;
}

/**
 * Strip a JSDoc tag and its type expression, keeping any description after it.
 *
 * Type annotations are code that happens to live in a comment, and they repeat
 * verbatim across files — `@param {string} path` is the same three words
 * wherever it appears, so counting them as prose would have every annotated
 * file share sequences with every other. This is the one place that decides,
 * so the screen and its report cannot disagree about what is prose.
 * @param {string} line
 */
function stripJsdocTag(line) {
    const tagged = /^@[a-z-]+\s*/i.exec(line);
    if (!tagged) return line;
    let rest = line.slice(tagged[0].length);
    // The brace expression is nested ({Promise<string[]>}, {{a: number}}), so
    // count depth rather than matching to the first close.
    if (rest.startsWith('{')) {
        let depth = 0, i = 0;
        for (; i < rest.length; i++) {
            if (rest[i] === '{') depth++;
            else if (rest[i] === '}' && --depth === 0) { i++; break; }
        }
        rest = rest.slice(i);
    }
    // What is left is `name - description`, or just a name.
    return rest.replace(/^\s*\[?[\w.$]+\]?\s*(-\s*)?/, '');
}

/**
 * The prose of a file, as contiguous blocks with their starting line.
 *
 * For source, a block is a run of adjacent comment lines; for markdown, a
 * paragraph. Fenced code inside markdown is skipped — a command is not a
 * claim, and every file documenting the same command shares its phrasing.
 * @param {string} path
 * @param {string} text
 * @returns {Block[]}
 */
export function proseBlocks(path, text) {
    const syntax = proseSyntax(path);
    if (!syntax) return [];
    const lines = text.split('\n');
    /** @type {Block[]} */
    const blocks = [];
    /** @type {string[]} */
    let current = [];
    let start = 0;
    let fenced = false;

    const flush = () => {
        const joined = current.join(' ').trim();
        if (joined) blocks.push({ line: start, text: joined });
        current = [];
    };

    lines.forEach((raw, i) => {
        if (/^\s*```/.test(raw)) {
            if (syntax === 'md') { flush(); fenced = !fenced; return; }
        }
        if (fenced) return;
        let content;
        if (syntax === 'md') {
            content = raw.replace(/^#+\s*/, '').trim();
        } else {
            const marker = COMMENT_MARKERS[syntax];
            if (!marker.test(raw) || /^\s*#!/.test(raw)) { flush(); return; }
            content = stripJsdocTag(raw.replace(marker, '').replace(/\s*\*\/\s*$/, '').trim());
        }
        if (!content) { flush(); return; }
        if (!current.length) start = i + 1;
        current.push(content);
    });
    flush();
    return blocks;
}

/** @typedef {{ path: string, phrases: Set<string>, blocks: Block[] }} CorpusFile */

/**
 * @param {{path: string, text: string}[]} files
 * @returns {CorpusFile[]}
 */
export function buildCorpus(files) {
    return files
        .map(({ path, text }) => {
            const blocks = proseBlocks(path, text);
            return { path, blocks, phrases: shingles(blocks.map((b) => b.text).join(' ')) };
        })
        .filter((f) => f.phrases.size > 0);
}

/** @typedef {{ section: string, text: string, start: number, end: number }} Claim */

/**
 * Split a CLAUDE.md into claims: bullets and paragraphs, each tagged with the
 * `##` section it sits under and the lines it occupies (which is what lets
 * --check score only what a commit touched).
 * @param {string} markdown
 * @returns {Claim[]}
 */
export function parseClaims(markdown) {
    const lines = markdown.split('\n');
    /** @type {Claim[]} */
    const claims = [];
    /** @type {string[]} */
    let current = [];
    let start = 0;
    let section = '';
    let fenced = false;

    const flush = (end) => {
        const text = current.join(' ').trim();
        if (text) claims.push({ section, text, start, end });
        current = [];
    };

    lines.forEach((raw, i) => {
        const n = i + 1;
        if (/^\s*```/.test(raw)) { flush(n - 1); fenced = !fenced; return; }
        if (fenced) return;
        if (raw.startsWith('#')) {
            flush(n - 1);
            if (raw.startsWith('## ')) section = raw.slice(3).trim();
            return;
        }
        // A bullet starts a new claim; a blank line ends one. Everything else
        // continues the block, so a wrapped bullet stays one claim.
        const bullet = /^\s*(?:[-*]|\d+\.)\s+/.exec(raw);
        if (bullet) flush(n - 1);
        if (!raw.trim()) { flush(n - 1); return; }
        if (!current.length) start = n;
        current.push(raw.trim().slice(bullet ? bullet[0].trimStart().length : 0));
    });
    flush(lines.length);
    return claims;
}

/** @param {Claim} claim */
export function isScoreable(claim) {
    return claim.text.length >= MIN_CLAIM_CHARS && tokens(claim.text).length >= MIN_CLAIM_TOKENS;
}

/**
 * Share of `claim`'s sequences that `corpus` already contains.
 * @param {Set<string>} claim
 * @param {Set<string>} corpus
 */
export function overlap(claim, corpus) {
    if (!claim.size) return 0;
    let shared = 0;
    for (const phrase of claim) if (corpus.has(phrase)) shared++;
    return shared / claim.size;
}

/**
 * The runs of `claim` that `corpus` already contains, longest first.
 *
 * Adjacent matching sequences overlap by all but one word, so merging them
 * recovers the whole restated phrase instead of reporting it in three-word
 * pieces. This is what a reader decides on: shared words prove nothing, a
 * shared sentence proves everything.
 * @param {string} claim
 * @param {Set<string>} corpus
 * @returns {string[]}
 */
export function sharedPhrases(claim, corpus) {
    const words = tokens(claim);
    /** @type {string[]} */
    const runs = [];
    let from = -1;
    for (let i = 0; i + SHINGLE_N <= words.length + 1; i++) {
        const hit = i + SHINGLE_N <= words.length
            && corpus.has(words.slice(i, i + SHINGLE_N).join(' '));
        if (hit && from === -1) from = i;
        if (!hit && from !== -1) {
            runs.push(words.slice(from, i + SHINGLE_N - 1).join(' '));
            from = -1;
        }
    }
    return runs.sort((a, b) => b.length - a.length);
}

/** @typedef {{ claim: Claim, score: number, path: string, block: Block|null, shared: string[] }} Match */

/**
 * The file whose comment prose restates most of this claim, and the single
 * block within it that restates most — the pair a reader needs to decide
 * whether the claim is a duplicate. The ranking alone is not actionable.
 * @param {Claim} claim
 * @param {CorpusFile[]} corpus
 * @returns {Match}
 */
export function bestMatch(claim, corpus) {
    const phrases = shingles(claim.text);
    /** @type {Match} */
    let best = { claim, score: 0, path: '-', block: null, shared: [] };
    for (const file of corpus) {
        const score = overlap(phrases, file.phrases);
        if (score <= best.score) continue;
        /** @type {Block|null} */
        let block = null;
        let blockScore = 0;
        for (const candidate of file.blocks) {
            const s = overlap(phrases, shingles(candidate.text));
            if (s > blockScore) { blockScore = s; block = candidate; }
        }
        best = {
            claim, score, path: file.path, block,
            shared: sharedPhrases(claim.text, file.phrases),
        };
    }
    return best;
}

/**
 * @param {number[]} values
 */
export function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
