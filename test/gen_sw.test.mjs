// Tests for scripts/gen_sw.mjs (the sw.js codegen) and for the service
// worker's install/activate lifecycle, which the codegen's output drives:
// install must precache exactly the generated SHELL, activate must evict
// every cache except the current V. Complements test/sw.test.mjs, which
// covers the fetch handler's offline/lie-fi contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildShellList, computeVersion, generateSW } from "../scripts/gen_sw.mjs";

const TEMPLATE = readFileSync(new URL("../static/sw.js", import.meta.url), "utf8");

const DEPLOY_FILES = [
    "index.html", "bundle-ab12cd34.js", "viz-ef56ab78.css",
    "all_works.json", "haydn_peters.json",
    "about.html", "howto.html", "setup.html",
    "site.webmanifest", "favicon.ico", "apple-touch-icon.png",
    "sw.js", "version.json", "CNAME", "bundle-ab12cd34.js.map",
];

test("buildShellList", async (t) => {
    const shell = buildShellList(DEPLOY_FILES);

    await t.test("starts with the navigation fallback entries", () => {
        assert.deepEqual(shell.slice(0, 2), ["./", "./index.html"]);
    });

    await t.test("includes every emitted page — setup.html and howto.html too (they used to 503 offline)", () => {
        for (const page of ["./about.html", "./howto.html", "./setup.html"]) {
            assert.ok(shell.includes(page), `${page} missing from shell`);
        }
    });

    await t.test("excludes sw.js, version.json, CNAME, and sourcemaps", () => {
        for (const name of ["./sw.js", "./version.json", "./CNAME", "./bundle-ab12cd34.js.map"]) {
            assert.ok(!shell.includes(name), `${name} must not be precached`);
        }
    });

    await t.test("is deterministic regardless of input order", () => {
        assert.deepEqual(buildShellList([...DEPLOY_FILES].reverse()), shell);
    });
});

test("computeVersion", async (t) => {
    const entries = [["index.html", "aaa"], ["favicon.ico", "bbb"], ["bundle.js", "ccc"]];

    await t.test("has the ql- prefix app.js uses to find the installed cache", () => {
        assert.match(computeVersion(entries), /^ql-[0-9a-f]{16}$/);
    });

    await t.test("is stable across entry order", () => {
        assert.equal(computeVersion([...entries].reverse()), computeVersion(entries));
    });

    await t.test("changes when ANY asset's content changes — including an icon (the old bundle+css-only version missed those)", () => {
        const iconChanged = [["index.html", "aaa"], ["favicon.ico", "XXX"], ["bundle.js", "ccc"]];
        assert.notEqual(computeVersion(iconChanged), computeVersion(entries));
    });

    await t.test("changes when a file is added", () => {
        assert.notEqual(computeVersion([...entries, ["new.png", "ddd"]]), computeVersion(entries));
    });
});

test("generateSW substitution", async (t) => {
    const shell = buildShellList(DEPLOY_FILES);
    const out = generateSW(TEMPLATE, { version: "ql-0123456789abcdef", shell });

    await t.test("leaves no unsubstituted tokens", () => {
        assert.doesNotMatch(out, /__SW_[A-Z]+__/);
    });

    await t.test('substitutes the version into the `const V = "..."` line (the cache name; version.json is the update probe)', () => {
        assert.match(out, /const V = "ql-0123456789abcdef"/);
    });

    await t.test("embeds the full shell list as an array literal", () => {
        const evaluated = evalSW(out);
        assert.deepEqual(evaluated.SHELL, shell);
    });

    await t.test("throws on a template missing its tokens (guards against template drift)", () => {
        assert.throws(() => generateSW("const V = 1;", { version: "x", shell: [] }));
    });
});

// ---- minimal SW-global harness for lifecycle tests -------------------------
// (test/sw.test.mjs has the full fetch-handler harness with a fake clock;
// install/activate need only caches + events.)
function evalSW(source) {
    const state = {
        added: [],            // URLs precached via cache.add
        deleted: [],          // cache names deleted on activate
        existingKeys: [],     // what caches.keys() reports
        skipWaited: false,
        claimed: false,
        listeners: {},
    };
    const cacheApi = {
        async add(req) { state.added.push(typeof req === "string" ? req : req.url); },
        async match() { return undefined; },
        async put() {},
    };
    const caches = {
        async open() { return cacheApi; },
        async keys() { return state.existingKeys; },
        async delete(k) { state.deleted.push(k); return true; },
        async match() { return undefined; },
    };
    const self = {
        location: new URL("https://example.test/sw.js"),
        skipWaiting: async () => { state.skipWaited = true; },
        clients: { claim: async () => { state.claimed = true; } },
        addEventListener(type, fn) { (state.listeners[type] ||= []).push(fn); },
    };
    const RequestCtor = function (url, init = {}) { return { url, ...init }; };
    const ResponseCtor = function (body, init = {}) { return { body, status: init.status || 200 }; };
    // Expose SHELL/V by appending an export hook the template doesn't have.
    let captured = {};
    const src = source + "\n;__capture({ SHELL, V });";
    new Function("self", "location", "caches", "fetch", "Request", "Response", "URL", "setTimeout", "clearTimeout", "__capture", src)(
        self, self.location, caches, async () => ResponseCtor(""), RequestCtor, ResponseCtor, URL,
        (fn) => fn(), () => {}, (x) => { captured = x; },
    );
    return { ...captured, state };
}

function fireAwaitable(listener) {
    let done;
    listener({ waitUntil(p) { done = p; } });
    return done;
}

test("install precaches exactly the generated SHELL and calls skipWaiting", async () => {
    const shell = buildShellList(DEPLOY_FILES);
    const { state } = evalSW(generateSW(TEMPLATE, { version: "ql-1111111111111111", shell }));
    await fireAwaitable(state.listeners.install[0]);
    assert.deepEqual(state.added.sort(), [...shell].sort());
    assert.ok(state.skipWaited, "install must call skipWaiting");
});

test("activate evicts every cache except the current V and claims clients", async () => {
    const shell = buildShellList(DEPLOY_FILES);
    const { state, V } = evalSW(generateSW(TEMPLATE, { version: "ql-2222222222222222", shell }));
    state.existingKeys = ["ql-oldoldoldoldoldo", "ql-2222222222222222", "unrelated-cache"];
    await fireAwaitable(state.listeners.activate[0]);
    assert.deepEqual(state.deleted.sort(), ["ql-oldoldoldoldoldo", "unrelated-cache"]);
    assert.equal(V, "ql-2222222222222222");
    assert.ok(state.claimed, "activate must claim clients");
});
