// Tests for TabComponent's pure logic. The Random button's stale-closure bug
// (handler bound once at creation, freezing the first render's data) was
// fixed by rebinding on every updateRandomButton call; these tests pin the
// extracted pickRandomWork weighting so the suggestion's behavior — including
// "different data ⇒ different candidate pool" — can't regress silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRandomWork, buildWorkTooltipHtml } from "../src/tabComponent.js";

// Fixtures use placeholder titles only (repo convention: nothing from
// PLAYER_ALIASES / real data in test fixtures).
const BEGIN = new Date(2024, 0, 1);
const NOW = new Date(2024, 6, 1); // 182 days after BEGIN

// Local-time dates (suite runs under TZ=America/New_York): a "YYYY-MM-DD"
// string would parse as UTC midnight = the previous local day and skew
// d3.timeDay counts.
const play = (y, m, d) => ({ timestamp: new Date(y, m - 1, d) });
const pool = (entries) => new Map(entries);

test("pickRandomWork", async (t) => {
    await t.test("returns null for an empty pool", () => {
        assert.equal(pickRandomWork(pool([]), NOW, BEGIN, 0.5), null);
    });

    await t.test("picks deterministically with an injected random value", () => {
        const p = pool([
            ["Quartet A", [play(2024, 6, 25)]], // 6 days ago  → weight 6
            ["Quartet B", [play(2024, 2, 1)]], // 151 days ago → weight 151
        ]);
        // r = 0 lands in the first work's cumulative range even at weight 6.
        assert.equal(pickRandomWork(p, NOW, BEGIN, 0).title, "Quartet A");
        // r near 1 lands in the heavier (least-recently-played) work.
        assert.equal(pickRandomWork(p, NOW, BEGIN, 0.999).title, "Quartet B");
    });

    await t.test("weights least-recently-played works more heavily", () => {
        const p = pool([
            ["Recent", [play(2024, 6, 30)]],  // weight 1
            ["Stale", [play(2024, 1, 2)]],   // weight 181
        ]);
        // Anything past r*total = 1 selects Stale: even r = 0.01 → 1.82 > 1.
        assert.equal(pickRandomWork(p, NOW, BEGIN, 0.01).title, "Stale");
    });

    await t.test("never-played works fall back to begin (max weight) and get the 'not played' display", () => {
        const p = pool([["Unplayed", []]]);
        const got = pickRandomWork(p, NOW, BEGIN, 0.5);
        assert.equal(got.title, "Unplayed");
        assert.equal(got.display, "Unplayed - not played in this view!");
    });

    await t.test("played works get the days-ago display", () => {
        const p = pool([["Quartet A", [play(2024, 6, 21)]]]);
        assert.equal(pickRandomWork(p, NOW, BEGIN, 0).display,
            "Quartet A - (last played 10 days ago)");
    });

    await t.test("uses the LAST play in the list as the most recent", () => {
        const p = pool([["Quartet A", [play(2024, 1, 15), play(2024, 6, 26)]]]);
        assert.equal(pickRandomWork(p, NOW, BEGIN, 0).daysAgo, 5);
    });

    await t.test("a changed pool changes the candidates (the stale-closure regression)", () => {
        // Same injected random, two different pools — as delivered by two
        // successive updateTabContent calls under different filters.
        const before = pool([["Only In Before", [play(2024, 3, 1)]]]);
        const after = pool([["Only In After", [play(2024, 3, 1)]]]);
        assert.equal(pickRandomWork(before, NOW, BEGIN, 0.5).title, "Only In Before");
        assert.equal(pickRandomWork(after, NOW, BEGIN, 0.5).title, "Only In After");
    });

    await t.test("all-zero weights (everything played today) still returns a work", () => {
        const p = pool([["Today A", [play(2024, 7, 1)]], ["Today B", [play(2024, 7, 1)]]]);
        assert.equal(pickRandomWork(p, NOW, BEGIN, 0.5).title, "Today A");
    });
});

// The 5+ tab's quintet/sextet rows keep their extra players in the free-form
// "Others?" column; without them the tooltip's three fixed slots understate
// who played. Rendered from othersList (canonicalized) on every tab.
test("buildWorkTooltipHtml others line", async (t) => {
    const row = (othersList) => ({
        composer: "Mozart",
        work: { title: "K515" },
        timestamp: new Date(2024, 2, 3),
        part: "V1",
        player1: "Alice", player2: "Bob", player3: "Carol",
        othersList,
    });

    await t.test("lists Others? players with their instrument", () => {
        const html = buildWorkTooltipHtml(row([
            { name: "Dave", instrument: "va", class: "upper" },
            { name: "Erin", instrument: null, class: "upper" },
        ]));
        assert.ok(html.includes("<li>+ Dave (va), Erin</li>"), html);
    });

    await t.test("omits the line when there are no others", () => {
        assert.ok(!buildWorkTooltipHtml(row([])).includes("+ "));
        assert.ok(!buildWorkTooltipHtml(row(undefined)).includes("+ "));
    });

    await t.test("keeps the slot players on their own line", () => {
        const html = buildWorkTooltipHtml(row([{ name: "Dave", instrument: "vc", class: "cello" }]));
        assert.ok(html.includes("<li>Alice, Bob, Carol</li>"), html);
    });
});
