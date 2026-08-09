// Tests for the shared tooltip module's pure logic: the viewport-clamp
// placement (previously only the calendar's copy of four implementations got
// this right) and the ownership walk that decides tap-outside dismissal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampToViewport, isOwnedNode } from "../src/tooltip.js";

const VP = { vw: 800, vh: 600 };

test("clampToViewport", async (t) => {
    await t.test("places below-right of the pointer with the margin", () => {
        assert.deepEqual(
            clampToViewport({ x: 100, y: 100, width: 200, height: 100, ...VP }),
            { left: 110, top: 110 });
    });

    await t.test("flips left of the pointer when it would overflow the right edge", () => {
        const { left } = clampToViewport({ x: 700, y: 100, width: 200, height: 100, ...VP });
        assert.equal(left, 700 - 200 - 10);
    });

    await t.test("flips above the pointer when it would overflow the bottom", () => {
        const { top } = clampToViewport({ x: 100, y: 550, width: 200, height: 100, ...VP });
        assert.equal(top, 550 - 100 - 10);
    });

    await t.test("hard-clamps to the top-left margin when flipping is not enough", () => {
        // Pointer near the top-left, tooltip bigger than the space on either
        // side of it: the flip goes negative, the final clamp catches it.
        assert.deepEqual(
            clampToViewport({ x: 5, y: 5, width: 400, height: 300, ...VP }),
            { left: 15, top: 15 });
    });

    await t.test("a flip near the bottom-right corner lands fully on-screen", () => {
        // Pointer at the corner: flip places the tooltip left/above the
        // pointer, already inside the viewport — the hard clamp is a backstop.
        const { left, top } = clampToViewport({ x: 780, y: 590, width: 300, height: 200, ...VP });
        assert.deepEqual({ left, top }, { left: 780 - 300 - 10, top: 590 - 200 - 10 });
        assert.ok(left + 300 <= VP.vw - 10 && top + 200 <= VP.vh - 10, "fully on-screen");
    });

    await t.test("respects a custom margin", () => {
        assert.deepEqual(
            clampToViewport({ x: 0, y: 0, width: 10, height: 10, vw: 100, vh: 100, margin: 4 }),
            { left: 4, top: 4 });
    });
});

test("isOwnedNode", async (t) => {
    // Plain objects with parentNode chains stand in for DOM nodes.
    const owned = new WeakSet();
    const trigger = { parentNode: null };
    const childSpan = { parentNode: trigger };
    const grandchild = { parentNode: childSpan };
    const outsider = { parentNode: null };
    owned.add(trigger);

    await t.test("matches a registered node directly", () => {
        assert.equal(isOwnedNode(trigger, owned), true);
    });

    await t.test("matches through the ancestor chain (child span of a stat tile)", () => {
        assert.equal(isOwnedNode(childSpan, owned), true);
        assert.equal(isOwnedNode(grandchild, owned), true);
    });

    await t.test("rejects unrelated nodes — this is what dismisses the tooltip", () => {
        assert.equal(isOwnedNode(outsider, owned), false);
    });

    await t.test("handles null input", () => {
        assert.equal(isOwnedNode(null, owned), false);
    });
});
