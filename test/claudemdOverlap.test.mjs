// Tests for the CLAUDE.md overlap screen: scripts/lib/overlap.mjs (scoring)
// and the diff arithmetic in scripts/claudemd_overlap.mjs.
//
// What these are for: the sequence width and the definition of "prose" are
// judgement calls that were tuned against a measured threshold. Nothing else
// notices when one of them drifts — the tool keeps printing percentages either
// way, and they quietly stop meaning what the threshold was set from.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    MIN_CLAIM_CHARS, MIN_CLAIM_TOKENS, SHINGLE_N,
    tokens, shingles, sharedPhrases, proseSyntax, proseBlocks, buildCorpus,
    parseClaims, isScoreable, overlap, bestMatch, median,
} from "../scripts/lib/overlap.mjs";
import { THRESHOLD, addedLines, touches, isBriefing, asMarkdown } from "../scripts/claudemd_overlap.mjs";

test("tokens", async (t) => {
    await t.test("keeps every word, including the short ones a phrase needs", () => {
        assert.deepEqual(tokens("The row holds a name"), ["the", "row", "holds", "a", "name"]);
    });

    await t.test("lowercases and splits on punctuation, so code spans contribute their parts", () => {
        assert.deepEqual(tokens("`scripts/push_aliases.sh` — FillForward()"),
            ["scripts", "push", "aliases", "sh", "fillforward"]);
    });
});

test("shingles", async (t) => {
    await t.test("is every window of SHINGLE_N consecutive words", () => {
        assert.equal(SHINGLE_N, 3);
        assert.deepEqual([...shingles("one two three four")], ["one two three", "two three four"]);
    });

    await t.test("repetition collapses — a phrase said twice is still one phrase", () => {
        assert.deepEqual([...shingles("a b c a b c")], ["a b c", "b c a", "c a b"]);
    });

    await t.test("text shorter than the window yields nothing", () => {
        assert.equal(shingles("two words").size, 0);
    });

    await t.test("takes a width, which is how the 2/3/4 comparison was measured", () => {
        assert.deepEqual([...shingles("one two three", 2)], ["one two", "two three"]);
    });
});

test("proseSyntax", () => {
    assert.equal(proseSyntax("src/app.js"), "js");
    assert.equal(proseSyntax("scripts/gen_sw.mjs"), "js");
    assert.equal(proseSyntax("static/css/viz.css"), "css");
    assert.equal(proseSyntax("build.sh"), "sh");
    assert.equal(proseSyntax(".github/workflows/test.yml"), "sh");
    assert.equal(proseSyntax("md/howto.md"), "md");
    assert.equal(proseSyntax("static/data/all_works.json"), null);
    assert.equal(proseSyntax("static/img/icon.png"), null);
});

test("proseBlocks over source", async (t) => {
    const js = [
        "// The first block explains",              // 1
        "// something across two lines.",           // 2
        "const x = 1;",                             // 3
        "",                                         // 4
        "/**",                                      // 5
        " * A second block.",                       // 6
        " * @param {string} path - where it reads", // 7
        " * @returns {Promise<string[]>}",          // 8
        " */",                                      // 9
        "function f(path) {}",                      // 10
    ].join("\n");

    await t.test("runs of adjacent comment lines are one block, code ends one", () => {
        const blocks = proseBlocks("src/a.js", js);
        assert.equal(blocks.length, 2);
        assert.equal(blocks[0].line, 1);
        assert.equal(blocks[0].text, "The first block explains something across two lines.");
        assert.equal(blocks[1].line, 6);
    });

    await t.test("a JSDoc tag keeps its description and loses its types", () => {
        const doc = proseBlocks("src/a.js", js)[1].text;
        assert.match(doc, /where it reads/);
        // `Promise`, `string` and the parameter name are code that happens to
        // sit in a comment; counting them as prose inflates every score.
        for (const noise of ["Promise", "string", "@param", "@returns", "path"]) {
            assert.ok(!doc.includes(noise), `${noise} leaked into the prose`);
        }
    });

    await t.test("an all-tag block disappears rather than scoring as prose", () => {
        assert.deepEqual(proseBlocks("src/a.js", "/**\n * @typedef {{a: number}} Thing\n */"), []);
    });

    await t.test("a shebang is not prose", () => {
        const blocks = proseBlocks("scripts/a.sh", "#!/usr/bin/env bash\n# Fetches the sheet.\nset -e");
        assert.deepEqual(blocks, [{ line: 2, text: "Fetches the sheet." }]);
    });

    await t.test("css block comments", () => {
        const blocks = proseBlocks("static/css/viz.css", "/* Canonical part colors. */\n:root { --a: 0; }");
        assert.deepEqual(blocks, [{ line: 1, text: "Canonical part colors." }]);
    });

    await t.test("a file with no comments has no prose", () => {
        assert.deepEqual(proseBlocks("src/a.js", "const x = 1;\nexport default x;"), []);
    });

    await t.test("an unreadable syntax contributes nothing", () => {
        assert.deepEqual(proseBlocks("static/data/all_works.json", '{"a": "because instead"}'), []);
    });
});

test("proseBlocks over markdown", async (t) => {
    const md = [
        "# Title",                        // 1
        "",                               // 2
        "A paragraph that wraps",         // 3
        "onto a second line.",            // 4
        "",                               // 5
        "```bash",                        // 6
        "./build.sh --prod  # deploys",   // 7
        "```",                            // 8
        "",                               // 9
        "Another paragraph.",             // 10
    ].join("\n");

    await t.test("paragraphs are blocks, headings fold into the one below", () => {
        const blocks = proseBlocks("md/a.md", md);
        assert.deepEqual(blocks.map((b) => b.text),
            ["Title", "A paragraph that wraps onto a second line.", "Another paragraph."]);
    });

    await t.test("fenced code is skipped — a command is not a claim", () => {
        const text = proseBlocks("md/a.md", md).map((b) => b.text).join(" ");
        assert.ok(!text.includes("build.sh"));
        assert.ok(!text.includes("deploys"));
    });
});

test("buildCorpus drops files with no prose to match against", () => {
    const corpus = buildCorpus([
        { path: "src/a.js", text: "// fillForward resolves a repeated bare name\nconst a = 1;" },
        { path: "src/b.js", text: "const b = 2;" },
        { path: "src/c.js", text: "// two words\n" },  // too short to form a sequence
    ]);
    assert.deepEqual(corpus.map((f) => f.path), ["src/a.js"]);
});

test("parseClaims", async (t) => {
    const md = [
        "# CLAUDE.md",                      // 1
        "",                                 // 2
        "An opening paragraph that",        // 3
        "wraps onto a second line.",        // 4
        "",                                 // 5
        "## Gotchas",                       // 6
        "",                                 // 7
        "- A first bullet that wraps",      // 8
        "  onto a continuation line.",      // 9
        "- A second bullet.",               // 10
        "",                                 // 11
        "```js",                            // 12
        "const notAClaim = true;",          // 13
        "```",                              // 14
        "",                                 // 15
        "A closing paragraph.",             // 16
    ].join("\n");
    const claims = parseClaims(md);

    await t.test("a wrapped bullet is one claim; the next bullet starts another", () => {
        assert.deepEqual(claims.map((c) => c.text), [
            "An opening paragraph that wraps onto a second line.",
            "A first bullet that wraps onto a continuation line.",
            "A second bullet.",
            "A closing paragraph.",
        ]);
    });

    await t.test("each claim carries the section it sits under", () => {
        assert.deepEqual(claims.map((c) => c.section), ["", "Gotchas", "Gotchas", "Gotchas"]);
    });

    await t.test("claims carry the lines they occupy, which is what --check filters on", () => {
        assert.deepEqual(claims.map((c) => [c.start, c.end]), [[3, 4], [8, 9], [10, 10], [16, 16]]);
    });

    await t.test("fenced code is not a claim", () => {
        assert.ok(!claims.some((c) => c.text.includes("notAClaim")));
    });
});

test("isScoreable", async (t) => {
    const claim = (text) => ({ section: "", text, start: 1, end: 1 });
    const long = "The processing order is load-bearing because normalizing before "
        + "filling forward beats local evidence with a global default, on exactly "
        + "the ambiguous rows that matter most here.";

    await t.test("accepts a claim long enough to yield sequences worth a ratio", () => {
        assert.ok(long.length >= MIN_CLAIM_CHARS);
        assert.ok(tokens(long).length >= MIN_CLAIM_TOKENS);
        assert.ok(isScoreable(claim(long)));
    });

    await t.test("rejects a fragment", () => {
        assert.ok(!isScoreable(claim("Short note about the sheet.")));
    });

    await t.test("rejects a long claim of few words — one lucky phrase would dominate it", () => {
        const padded = `supercalifragilistic ${"expialidocious ".repeat(8)}`;
        assert.ok(padded.length >= MIN_CLAIM_CHARS);
        assert.ok(tokens(padded).length < MIN_CLAIM_TOKENS);
        assert.ok(!isScoreable(claim(padded)));
    });
});

test("overlap", async (t) => {
    await t.test("is the share of the claim's sequences the corpus already contains", () => {
        assert.equal(overlap(new Set(["a b c", "b c d", "c d e", "d e f"]),
            new Set(["a b c", "b c d", "x y z"])), 0.5);
    });

    await t.test("is one when the corpus covers the claim, however much else it holds", () => {
        assert.equal(overlap(new Set(["a b c"]), new Set(["a b c", "b c d", "x y z"])), 1);
    });

    await t.test("an empty claim scores zero rather than dividing by zero", () => {
        assert.equal(overlap(new Set(), new Set(["a b c"])), 0);
    });
});

test("sharedPhrases", async (t) => {
    const corpus = shingles("the parenthetical is an instrument by convention but a slot is often a note");

    await t.test("merges adjacent matches back into the whole restated run", () => {
        assert.deepEqual(
            sharedPhrases("A slot's parenthetical is an instrument by convention, mostly.", corpus),
            ["parenthetical is an instrument by convention"]);
    });

    await t.test("reports separate runs separately, longest first", () => {
        const runs = sharedPhrases("a slot is often a note, and the parenthetical is an instrument by convention", corpus);
        assert.deepEqual(runs, ["the parenthetical is an instrument by convention", "a slot is often a note"]);
    });

    await t.test("says nothing when no sequence matches", () => {
        assert.deepEqual(sharedPhrases("nothing here resembles that sentence at all", corpus), []);
    });
});

test("bestMatch", async (t) => {
    const corpus = buildCorpus([
        {
            path: "src/dataProcessor.js",
            text: [
                "// Unrelated: the service worker precaches the shell.",
                "const a = 1;",
                "// fillForward resolves a repeated bare name by matching the",
                "// literal text the logger typed into the column.",
                "const b = 2;",
            ].join("\n"),
        },
        { path: "src/tooltip.js", text: "// Registered triggers, matched by ancestry.\n" },
    ]);
    const claim = {
        section: "Processing",
        text: "fillForward resolves a repeated bare name by matching the literal "
            + "text the logger typed into that column.",
        start: 10,
        end: 11,
    };
    const match = bestMatch(claim, corpus);

    await t.test("names the file whose prose covers most of the claim", () => {
        assert.equal(match.path, "src/dataProcessor.js");
        // One changed word ("into that column" for "into the column") costs the
        // sequences that span it, and nothing else — a rewrite has to be a
        // rewrite to score low.
        assert.ok(match.score > 0.8 && match.score < 1);
    });

    await t.test("names the one block inside it — the ranking alone is not actionable", () => {
        assert.equal(match.block?.line, 3);
    });

    await t.test("reports the shared phrasing, so a flag can be argued with", () => {
        assert.equal(match.shared[0],
            "fillforward resolves a repeated bare name by matching the literal text the logger typed into");
    });

    await t.test("an empty corpus scores zero and names nothing", () => {
        const none = bestMatch(claim, []);
        assert.equal(none.score, 0);
        assert.equal(none.path, "-");
        assert.equal(none.block, null);
    });
});

test("a copied comment scores at or above the threshold, an unrelated one well below", () => {
    // The calibration the measured THRESHOLD assumes. If a change to the
    // sequence width or to what counts as prose breaks either half, the
    // percentages the threshold was set from no longer mean the same thing.
    const source = "The processing order is load-bearing: fillForward resolves a bare "
        + "name against the literal text the logger typed, so normalizing first "
        + "replaces local evidence with a global default.";
    const corpus = buildCorpus([
        { path: "src/dataProcessor.js", text: `// ${source}` },
        { path: "src/tooltip.js", text: "// Dismissal matches registered triggers by ancestry." },
    ]);
    assert.ok(bestMatch({ section: "", text: source, start: 1, end: 1 }, corpus).score >= THRESHOLD);

    const unrelated = "Push to main deploys the site through GitHub Actions, and every "
        + "action in both workflows is pinned to a commit hash rather than a tag.";
    assert.ok(bestMatch({ section: "", text: unrelated, start: 1, end: 1 }, corpus).score < THRESHOLD);
});

test("median", () => {
    assert.equal(median([0.5, 0.1, 0.9]), 0.5);
    assert.equal(median([0.2, 0.4, 0.6, 0.8]), 0.5);
    assert.equal(median([]), 0);
});

test("addedLines", async (t) => {
    await t.test("reads the added side of each hunk header", () => {
        const diff = [
            "diff --git a/CLAUDE.md b/CLAUDE.md",
            "@@ -10,0 +11,3 @@ ## Gotchas",
            "+one", "+two", "+three",
            "@@ -40,2 +44,1 @@",
            "+four",
        ].join("\n");
        assert.deepEqual([...addedLines(diff)].sort((a, b) => a - b), [11, 12, 13, 44]);
    });

    await t.test("a hunk with no count adds exactly one line", () => {
        assert.deepEqual([...addedLines("@@ -3 +7 @@")], [7]);
    });

    await t.test("a pure deletion adds nothing", () => {
        assert.equal(addedLines("@@ -10,4 +9,0 @@").size, 0);
    });

    await t.test("an empty diff adds nothing", () => {
        assert.equal(addedLines("").size, 0);
    });
});

test("touches", async (t) => {
    const claim = { section: "", text: "", start: 10, end: 14 };

    await t.test("fires when a changed line falls inside the claim", () => {
        assert.ok(touches(claim, new Set([12])));
        assert.ok(touches(claim, new Set([10])));
        assert.ok(touches(claim, new Set([14])));
    });

    await t.test("leaves inherited text alone — that is what makes --check converge", () => {
        assert.ok(!touches(claim, new Set([9, 15])));
        assert.ok(!touches(claim, new Set()));
    });
});

test("isBriefing", async (t) => {
    // One predicate for three callers. The editor hook is handed an absolute
    // path by Claude Code; the corpus and the report work in repo-relative
    // ones. A second spelling of this question would answer differently for
    // one of them, and nothing would say so.
    await t.test("matches a briefing file however it is spelled", () => {
        for (const path of [
            "CLAUDE.md",
            "md/CLAUDE.md",
            "/Users/someone/repo/CLAUDE.md",
            "C:\\repo\\scripts\\CLAUDE.md",
        ]) {
            assert.ok(isBriefing(path), `${path} should be a briefing file`);
        }
    });

    await t.test("does not match source, or a name that merely ends the same way", () => {
        for (const path of [
            "src/app.js",
            "README.md",
            "md/howto.md",
            "docs/NOTCLAUDE.md",
            "CLAUDE.md.bak",
        ]) {
            assert.ok(!isBriefing(path), `${path} should not be a briefing file`);
        }
    });
});

test("asMarkdown", async (t) => {
    const out = asMarkdown("12%  CLAUDE.md:3  claim text");

    await t.test("fences the report so the prose survives the checks page", () => {
        assert.match(out, /^## CLAUDE\.md overlap screen\n/);
        assert.ok(out.includes("```\n12%  CLAUDE.md:3  claim text\n```"));
    });

    await t.test("says on the page that it is not a gate", () => {
        assert.match(out, /not a gate/);
    });

    await t.test("leaves a note about the screen itself unfenced, so its code spans render", () => {
        const note = asMarkdown("Could not resolve `origin/main`.", { fenced: false });
        assert.ok(!note.includes("```"));
        assert.ok(note.includes("Could not resolve `origin/main`."));
    });
});

test("THRESHOLD stays in the range the measurement covers", () => {
    // Not a taste check: the table in claudemd_overlap.mjs measured 8-19%, so a
    // value outside it has no evidence behind it.
    assert.ok(THRESHOLD >= 0.08 && THRESHOLD <= 0.19);
});
