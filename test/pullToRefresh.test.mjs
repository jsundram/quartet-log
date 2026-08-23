// Tests for the pull-to-refresh gesture guard: the ancestry walk that decides
// whether a downward touch is a page pull or a scroll inside a panel that
// owns it (the open player dropdown's list, a tall tooltip, a lightbox).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startsInScroller } from "../src/pullToRefresh.js";

// Plain objects with parentElement chains stand in for DOM nodes; styleOf
// reads the overflowY each one carries, mirroring getComputedStyle.
const BODY = { tag: "body" };
const styleOf = (el) => (el.style === null ? null : { overflowY: el.style ?? "visible" });

function chain(...specs) {
    // Outermost first; returns the innermost node (the touch target).
    let parentElement = BODY;
    for (const [style, scrollHeight = 100, clientHeight = 100] of specs) {
        parentElement = { style, scrollHeight, clientHeight, parentElement };
    }
    return parentElement;
}

test("startsInScroller", async (t) => {
    await t.test("plain content is a pull, not a scroll", () => {
        assert.equal(startsInScroller(chain(["visible"], ["visible"]), BODY, styleOf), false);
    });

    await t.test("finds an overflowing overflow-y:auto ancestor", () => {
        // The player dropdown: 300px tall, list taller than that. The label
        // the finger lands on is two levels in.
        const target = chain(["auto", 900, 300], ["visible"], ["visible"]);
        assert.equal(startsInScroller(target, BODY, styleOf), true);
    });

    await t.test("matches the touch target itself", () => {
        assert.equal(startsInScroller(chain(["scroll", 900, 300]), BODY, styleOf), true);
    });

    await t.test("a scroller short enough not to overflow is a pull", () => {
        // Few enough players that the list fits: no scroll to steal.
        assert.equal(startsInScroller(chain(["auto", 120, 120]), BODY, styleOf), false);
    });

    await t.test("ignores a one-pixel rounding overflow", () => {
        assert.equal(startsInScroller(chain(["auto", 301, 300]), BODY, styleOf), false);
    });

    await t.test("horizontal-only scrollers stay pullable", () => {
        // The data tables set overflow-x:auto, which the cascade computes as
        // overflow-y:auto — but they don't scroll vertically.
        assert.equal(startsInScroller(chain(["auto", 400, 400], ["visible"]), BODY, styleOf), false);
    });

    await t.test("overflowing but clipped content stays pullable", () => {
        assert.equal(startsInScroller(chain(["hidden", 900, 300]), BODY, styleOf), false);
    });

    await t.test("stops at the boundary node", () => {
        // A scrollable body is the page scroll, which _scrollTop() covers.
        const scrollableBody = { style: "auto", scrollHeight: 900, clientHeight: 300 };
        const target = { style: "visible", scrollHeight: 100, clientHeight: 100, parentElement: scrollableBody };
        assert.equal(startsInScroller(target, scrollableBody, styleOf), false);
    });

    await t.test("walks past nodes with no computed style", () => {
        // A text node can be the touch target; getComputedStyle would throw,
        // so styleOf returns null and the walk continues to its element parent.
        const scroller = { style: "auto", scrollHeight: 900, clientHeight: 300, parentElement: BODY };
        assert.equal(startsInScroller({ style: null, parentElement: scroller }, BODY, styleOf), true);
    });

    await t.test("a detached chain terminates", () => {
        assert.equal(startsInScroller({ style: "visible", scrollHeight: 1, clientHeight: 1, parentElement: null }, BODY, styleOf), false);
    });
});
