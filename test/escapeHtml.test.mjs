// escapeHtml + the tooltip-building functions that consume it. The sheet is
// user-authored and "Copy setup link" hands ?data=<sheet-url> links to other
// people, so a hostile value in any sheet cell (comments especially) must
// render inert in every tooltip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../src/escapeHtml.js";
import { buildWorkTooltipHtml } from "../src/tabComponent.js";
import { buildDayTooltipHtml } from "../src/calendarComponent.js";
import { MusicianNetworkComponent } from "../src/musicianNetworkComponent.js";

const XSS = `<img src=x onerror=alert(1)>`;

test("escapeHtml", async (t) => {
    await t.test("escapes the five HTML metacharacters", () => {
        assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`),
            "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    });

    await t.test("escapes & first (no double-escaping)", () => {
        assert.equal(escapeHtml("&lt;"), "&amp;lt;");
    });

    await t.test("stringifies null/undefined/numbers safely", () => {
        assert.equal(escapeHtml(null), "");
        assert.equal(escapeHtml(undefined), "");
        assert.equal(escapeHtml(42), "42");
    });
});

test("buildWorkTooltipHtml renders hostile sheet values inert", () => {
    const d = {
        composer: "Misc",
        work: { title: XSS },
        timestamp: new Date(2024, 2, 3),
        location: XSS,
        part: "V1",
        player1: "Alice", player2: XSS, player3: "Carol",
        comments: `nice session ${XSS}`,
        othersList: [{ name: XSS, instrument: XSS, class: "upper" }],
    };
    const html = buildWorkTooltipHtml(d);
    assert.ok(!html.includes("<img"), "raw <img must not survive");
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "payload must be visible as text");
    assert.ok(html.includes("Alice"), "legit names still render");
    assert.ok(html.includes("<li>+ "), "the Others? line still renders");
    assert.match(html, /<h4><a href="/, "structural markup intact");
});

test("buildDayTooltipHtml renders hostile sheet values inert", () => {
    const d = { date: new Date(2024, 2, 3), value: 2 };
    const sessions = [
        { composer: XSS, work: { title: XSS }, part: "V1", player1: "Alice", player2: XSS, player3: "" },
        { composer: "Haydn", workTitle: "Op. 20 No. 2", part: "V2", player1: "Bob" },
    ];
    const html = buildDayTooltipHtml(d, (date) => date.toLocaleDateString(), sessions);
    assert.ok(!html.includes("<img"), "raw <img must not survive");
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(html.includes("Op. 20 No. 2"), "legit titles still render");
    assert.match(html, /<table class="calendar-tooltip-table">/, "structural markup intact");
});

test("musician-network tooltip builders render hostile names inert", () => {
    const p = MusicianNetworkComponent.prototype;
    const node = p._nodeTooltipHtml.call(
        { _state: { edges: [] } },
        { name: XSS, count: 3, parts: { V1: 3 } },
    );
    const edge = p._edgeTooltipHtml.call({}, { source: XSS, target: "Bob", weight: 2 });
    const cell = p._cellTooltipHtml.call({}, { a: XSS, b: "Bob", weight: 0 });
    for (const html of [node, edge, cell]) {
        assert.ok(!html.includes("<img"), "raw <img must not survive");
        assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    }
    assert.ok(edge.includes("Bob") && cell.includes("Bob"), "legit names still render");
});
