// Tests for the pull-to-refresh gesture guard: the ancestry walk that decides
// whether a downward touch is a page pull or a scroll inside a panel that
// owns it (the open player dropdown's list, a tall tooltip, a lightbox).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PullToRefresh, startsInScroller } from "../src/pullToRefresh.js";

// Plain objects with parentElement chains stand in for DOM nodes; styleOf
// reads the overflowY each one carries, mirroring getComputedStyle.
const BODY = { tag: "body" };
const styleOf = (el) =>
    (el.style === null ? null : { overflowY: el.style ?? "visible", overflowX: el.styleX ?? "visible" });

function chain(...specs) {
    // Outermost first; returns the innermost node (the touch target).
    // Each spec is [overflowY, scrollHeight, clientHeight, overflowX,
    // scrollWidth, clientWidth]; the sizes default to "fits exactly".
    let parentElement = BODY;
    for (const [style, scrollHeight = 100, clientHeight = 100,
                styleX = "visible", scrollWidth = 100, clientWidth = 100] of specs) {
        parentElement = { style, scrollHeight, clientHeight, styleX, scrollWidth, clientWidth, parentElement };
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

    await t.test("a horizontal pan belongs to its scroller too", () => {
        // The tab strip and the date-range buttons are overflow-x:auto and sit
        // right where a pull starts; PTR would otherwise see only the downward
        // drift of a sideways swipe and freeze the pan into a refresh.
        const tabs = chain(["visible", 100, 100, "auto", 900, 390], ["visible"]);
        assert.equal(startsInScroller(tabs, BODY, styleOf), true);
    });

    await t.test("the fullscreen calendar's viewport-fitted grid counts", () => {
        // Year columns pan horizontally; the height is fitted, so there is no
        // vertical overflow to detect and body overflow:hidden pins scrollY.
        const grid = chain(["auto", 844, 844, "auto", 4000, 390]);
        assert.equal(startsInScroller(grid, BODY, styleOf), true);
    });

    await t.test("an overflow-x wrapper that doesn't overflow stays pullable", () => {
        // A narrow table on a wide screen: declared scrollable on both axes by
        // the cascade, actually scrollable on neither.
        assert.equal(startsInScroller(chain(["auto", 400, 400, "auto", 300, 300]), BODY, styleOf), false);
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

test("_onStart bailing mid-pull clears the indicator", () => {
    // A second finger landing inside a scroller part-way through a pull bails
    // out of _onStart; _onEnd() early-returns on a null startY, so anything
    // short of a full _reset() would strand the half-pulled spinner.
    const props = new Map();
    const classes = new Set(["pulling"]);
    const ptr = new PullToRefresh({ onRefresh: async () => {} });
    ptr.indicator = {
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
        style: { setProperty: (k, v) => props.set(k, v) },
    };
    ptr.startY = 100;
    ptr.currentPull = 60;
    ptr._scrollTop = () => 0;
    ptr._startedInScroller = () => true;

    ptr._onStart({ touches: [{ clientY: 200 }], target: {} });

    assert.equal(ptr.startY, null);
    assert.equal(ptr.currentPull, 0);
    assert.equal(classes.has("pulling"), false);
    assert.equal(props.get("--ptr-y"), "0px");
    assert.equal(props.get("--ptr-opacity"), "0");
});
