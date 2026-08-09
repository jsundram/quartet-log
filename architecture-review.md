# Architectural Evaluation: musiclog (quartet-log)

*Reviewed 2026-08-08. Method: three parallel deep-reads (data layer, UI layer, build/deploy/PWA infra) with the highest-impact claims verified by direct inspection.*

**TL;DR:** This is a two-culture codebase. The data core, service worker, and boot sequence are genuinely excellent — pure, tested, with written failure-mode rationale that most professional teams don't produce. The component layer never received that discipline: it's untested (a structural problem, not just an omission), duplicated in four-plus places, and scatters state across nine owners including the DOM itself. The review also surfaced about a dozen concrete bugs, two significant: real people's names shipped in a public repo/bundle, and a data-export/audit pipeline that silently drops a whole column. The right direction is not a framework — it's extending the discipline that already exists in `dataProcessor.js` outward.

---

## 1. What this codebase gets right

**A pure, tested data core.** `src/dataProcessor.js` is the model citizen: ~26 exported pure functions, no DOM, no d3, one import, backed by 921 lines of tests. The tests name the historical bugs they pin (e.g. the Top-Musicians parity regression, the "top-1 was being stripped" network case), and a comment at `dataProcessor.js:112` explicitly says `dayOrdinal` avoids d3 "so the function stays unit-testable" — the discipline is deliberate, and it paid off. The DST-safe day math (local Y/M/D routed through `Date.UTC`) is correct and regression-tested.

**Failure-mode reasoning written down where it matters.** The never-cache-an-empty-response guard exists in *both* fetch paths with precise rationale about cache poisoning (`dataService.js:44-48, 111-113`). The byte-equality revalidate guard prevents needless repaints. The service worker (`static/sw.js`) is unusually careful: bounded network waits, cache-write gating on `!ok || redirected || 206`, `allSettled` precache so one missing file doesn't abort install, and self-exclusion of `sw.js` from interception so the version probe works.

**The SW tests are exemplary.** `test/sw.test.mjs` evaluates the worker source with injected fakes, uses a hand-rolled deterministic clock to assert "still pending at 2999ms, resolved at 3001ms," and its cache mock deliberately honors `{ignoreSearch}` so removing that option turns a test red — tests that pin what they claim, per the commit message.

**Smart, minimal infrastructure.** Zero npm dependencies. Content-hash-derived SW version (no hand-bumped constant), and because the catalog hash is `--define`d into the bundle, a data-only change moves the bundle hash too. The 44-line no-store dev proxy exists for a documented reason (esbuild's server can't set headers). Tests run under a pinned TZ locally and in CI so timezone bugs can't pass in one and fail in the other.

**Real design contracts, documented.** The theme re-render contract (invalidate color cache first, then re-render), the dashboard's cross-filter `DIMENSIONS` registry with a "how to add a chart" comment, the `.calendar-gen` re-render contract, `_yearStatDefs` shared between both calendar layouts so they can't drift, and the instrument-class-aware alias design (the two-Jens problem) — all thought through and written down. CLAUDE.md is living architecture documentation of a quality most teams never achieve.

## 2. Big mistakes

**Real names in a public repo and public bundle.** `PLAYER_ALIASES` (`src/config.js:64-107`) maps short names to ~40 real people's full names. The repo is public, and config.js is bundled into the JS served to every visitor of the site. This is internally inconsistent: `archive/data.csv` is gitignored as "personal data," the sheet URL is deliberately kept in `.dev-data-url` and localStorage-only — but the social graph of who the author plays with is published. The `__WORKS_VERSION__` `--define` mechanism already in `build.sh` is the template for the fix (gitignored `aliases.js` + checked-in stub).

**The export/audit pipeline silently drops a column.** `fetch_processed.mjs:72` and `downloadCSV` (`app.js:520`) write the header as `Others`, but `processRow` reads `d["Others?"]` (`dataProcessor.js:418`) and `audit_aliases.py:135` reads `row.get("Others?")` — whose documented default input is exactly the file written with the wrong header. So the alias audit sees zero non-quartet-slot musicians on its default input, with no error, and the exported CSV can't be re-ingested by the pipeline that produced it. This is the concrete cost of the CSV-writing logic being duplicated in two files.

**`fillForward` is the subtlest function in the codebase and has zero tests.** Confirmed by direct read (`dataProcessor.js:424-446`): the match is unanchored substring (`prevEntry.indexOf(entry) != -1`), so "Chris" after "Christina" within 4 hours silently merges two people. Out-of-order rows produce *negative* hours, which pass `hours < 4`. And nothing anywhere sorts the data — `setBegin(this.data[0].timestamp)` assumes row 0 is earliest, so one backdated row at the top of the sheet mis-anchors the whole calendar.

**`build.sh` has no `set -e` and its exit status is the final `ls`.** CI runs `./build.sh --prod` as the deploy step; a failed pandoc, `cp`, `sed`, or `mv` inside `hash_and_rename` still yields a green deploy of a broken site. The SW's `allSettled` precache would then quietly paper over the missing file.

**Unescaped sheet data flows into `.html()` everywhere.** Every tooltip builds markup by string concatenation from sheet-supplied values (work titles, names, locations, *comments*) — `tabComponent.js:416-428`, `calendarComponent.js:734-758`, etc. Combined with the "Copy setup link" feature (which hands a `?data=<sheet-url>` link to someone else), this upgrades self-XSS to a delivery vector. One `escapeHtml` helper fixes all of it.

**Most of `src/` is structurally untestable, and it's an accident of import style.** Only `dataProcessor.js` and `calendarComponent.js` use `.js` extensions in their imports; every other module uses extensionless specifiers only esbuild resolves, so `node --test` can't import them (verified: `import('./src/dashboardComponent.js')` fails on `Cannot find module '.../src/config'`). That — plus constructors that do DOM work and `d3` as a bare global — is *why* test coverage stops at the data layer. The coverage cliff is a symptom; the module hygiene is the cause.

## 3. Gray areas

- **SW asset-pinning hole.** The cache version derives only from bundle + CSS hashes. `d3.v7.min.js`, the icons, and `site.webmanifest` are unhashed and cache-first; change one of them *alone* and `sw.js` is byte-identical → no update event → the old asset is pinned forever in installed PWAs. The D3-update path lands exactly in this hole. Also `setup.html`/`howto.html` are emitted by the build but missing from the hand-maintained `SHELL` list, so they 503 offline. Low frequency, real consequence.
- **Concurrency around `revalidate()`.** Pull-to-refresh, the visibility handler, and the 5-minute poll can overlap with no in-flight guard; two interleaved fetches can compute `changed` against each other's writes and drop a genuine update. Rare, self-healing on next poll — but it's the kind of bug you'll never reproduce on demand.
- **First-ever-load race** (confirmed): on a slow first load with no cache, the 5s timeout rejects with "No cached data available" while the still-inflight `d3.csv` later resolves, populates the cache, and resolves a promise nobody's listening to. User sees an error; a reload fixes it mysteriously.
- **localStorage quota.** The log only grows; no `setItem` is wrapped in try/catch. On quota exhaustion the app serves stale data forever, styled as if fresh, with no user-visible signal. All background-refresh failures are console-only generally — the status line keeps saying "updated N minutes ago."
- **Toolchain drift is real, not theoretical.** esbuild 0.28.1 local vs 0.24.2 in CI, node 26 vs 20, versions hand-declared in three places, no `engines`/`.nvmrc`. Local prod builds differ from CI builds today. Also: no PR-triggered CI at all — the repo uses PRs, but tests run only post-merge, immediately before deploying.
- **Home and Dashboard filters silently diverge** — two independent `DateFilterWidget` instances, part state in the DOM on one side and in `state.selections` on the other. Possibly intentional; worth a deliberate decision either way.
- **Vendored D3 of uncertain vintage** (file mtime 2023-12; the comment says 7.9.0, which shipped later) with no integrity hash and no audit surface.

## 4. Low-hanging fruit

Roughly in value-per-effort order:

1. `set -euo pipefail` + `command -v` preflight in `build.sh` — a morning's work, closes the green-broken-deploy hole.
2. Fix the `Others` header in both writers (or make readers accept both) — restores the audit script's documented behavior.
3. Add `.js` extensions to all imports — mechanical, immediately unlocks testing everything.
4. `escapeHtml` in the tooltip paths.
5. Sort data by timestamp after parse — retires the row-0 assumption and the negative-hours case in one move.
6. Anchor `fillForward`'s match (exact or word-boundary) and write its tests; also test `processRow` and `parseWork` (currently zero tests, and `parseWork.incomplete` gates a global filter).
7. Fix the Random button's stale closure (`tabComponent.js:196-200` — the handler binds first-render data and is never rebound, contradicting its own comment).
8. Delete confirmed dead things: `#daytooltip` (unused despite three comments claiming the calendar uses it — and its absence from the dismissal logic is why calendar tooltips can't be dismissed by tapping elsewhere on touch), `md/md2html.sh` (drifted flags, writes into `md/` — the exact fswatch-loop footgun `build.sh` was fixed to avoid), `CACHE_KEY_PREFIX`, the stale entries in TabComponent's dismissal allowlist.
9. Guard empty `this.data` (`data[0].timestamp` throws today if every row is a partial movement), and wrap `localStorage.setItem` with a user-visible staleness signal.
10. A 15-line PR workflow that runs `npm test`; pin GitHub Actions to SHAs; add `engines` + `.nvmrc`.

## 5. Larger opportunities

**Extend the dataProcessor pattern outward — a presenter layer.** The single highest-leverage refactor. Enormous amounts of *pure* computation are trapped inside render functions: the five stat definitions (copy-pasted verbatim in three files), `checkPlayersMatch` (the app's core domain semantics, stranded on `App`), `sizing()` (duplicated wholesale in two files), `segmentsOf`, the chord-label de-overlap, table sort comparators, `processComposerData`. Extract them into pure modules and the test-coverage story changes from "3 UI functions tested" to "everything but the d3 plumbing tested."

**One tooltip module.** There are four implementations; only the calendar's clamps to the viewport correctly. Consolidating also fixes the architectural inversion where `TabComponent`'s constructor owns a hardcoded allowlist of other components' CSS classes for tap-dismissal (two entries of which are already stale and never match).

**Split the two megafiles along their existing seams.** `app.js` (609 lines) is at least five things: SetupView, UpdateChecker (which regex-parses `sw.js` — a fragile textual coupling), FilterEngine, StatusBar, CsvExporter. `musicianNetworkComponent.js` (934 lines) is a state machine plus three complete chart renderers.

**Centralize filter/view state.** Not a framework — a single plain state object with a change notification, replacing DOM-as-truth (`.part-btn.active`, `.active-tab`), the `window.data` global, and the two divergent date widgets. This also enables fixing the confirmed non-idempotent re-init path (error → re-enter URL → duplicate tabs, buttons, and document listeners) and the fan-out that re-renders ~20 hidden composer tabs on every filter change.

**Generate the SW `SHELL` from the build output.** A glob over `last_deploy/` closes both the manifest drift and the unhashed-asset pinning hole at once, and lets `V` cover everything.

**A typed-and-linted floor.** `// @ts-check` + JSDoc (esbuild already tolerates it) plus eslint would have caught several of the confirmed bugs (the `Others` header drift, `parseInt` → `NaN` flowing through `catalog`) at zero runtime cost. One Playwright smoke test — boot against a fixture CSV, click through the three views — would cover the entire category ("does the site actually load") that 1,200 lines of unit tests can't.

## 6. Alternatives to DIY

Honest answer: **the DIY choice is justified here, and most alternatives only replace the parts already done best.**

- **Looker Studio** connects natively to the same Google Sheet, free, shareable — but it can do only the dashboard subset. No transposed fullscreen calendar, no part-aware chord diagram, no alias normalization, no PWA/offline.
- **Observable Framework** is the credible middle ground: d3-native (the code ports nearly as-is), static-site output still hostable on Pages, data loaders that would replace `dataService`, and reactivity that would replace the hand-rolled filter plumbing. For an eventual rewrite, this is the substrate to pick.
- **Grafana / Metabase / Superset** all want a server and a database and give less bespoke viz than exists now. Wrong shape for this project.
- **Vite + a lightweight framework (Svelte, Lit)** isn't an alternative product, just a more robust DIY substrate — trading the zero-dependency posture (a real asset) for reactivity and componentization mostly obtainable from the refactors in §5.

The things that make this app worth using — the calendar, the network/chord views, the instrument-class alias pipeline, offline-first against a flaky cross-origin sheet — are precisely the things no off-the-shelf tool provides. The robustness gap is not "DIY vs product"; it's the component layer lagging the data layer, which is fixable in place.

## 7. Free-form observations

- **The comment culture is the best thing here.** Comments explain *failure modes* ("persisting `[]` would poison the cache-first boot"), not mechanics. The empty-cache rationale, the fullscreen-on-`<html>`-not-`#calendar` explanation, the dev-proxy header rationale — this is what code comments are for, and it's rare.
- **The codebase knows what good looks like — it just applied it unevenly.** `dataProcessor.js`, `sw.js` + its tests, `dateFilterWidget.js`, and `themeManager.js` are one culture; `app.js`, `tabComponent.js`, and the tooltip quadruplication are another. Every recommendation in this report amounts to "do to the second group what you already did to the first."
- **Several comments are actively wrong**, which is worse than absent: three separate comments claim the calendar uses `#daytooltip` (it doesn't); `handleRandomSelection`'s comment claims it respects current filters (the stale closure means it doesn't); `catalog.js:33`'s comment points at the wrong line.
- **Accessibility is the weakest surface.** Tabs without tab semantics, a `<div>` hamburger and `<div>` combobox that keyboard users cannot operate at all, charts invisible to screen readers, tooltip close controls that are unfocusable `<span>`s, and `initial-scale=.75` shrinking text for everyone. For a personal tool this may be an accepted trade; it should at least be a *decided* one.
- **The `>= 20` player threshold, the 4-hour session window, and the 5s timeout** are load-bearing product decisions buried as unnamed literals. Name them.
- **`window.data` still ships**, and the `if (!ALL_WORKS)` guard in `dataService.processData` protects a value the function never uses — small fossils worth sweeping.
- Overall: for a solo, zero-dependency, vanilla-JS project, this is well above the bar. The bugs found are real but nearly all live in the seams *between* well-built parts — duplicated writers drifting, tested core wrapped in untested shell. Closing seams, not rebuilding, is the work.
