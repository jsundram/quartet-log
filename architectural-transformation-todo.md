# Architectural Transformation TODO

**Source:** `./architecture-review.md` (full architectural review, 2026-08-08). This document converts that review into an executable task set.

**Mission:** make the codebase healthier and better tested — fix every confirmed bug, unlock testing of the component layer, harden build/CI, and extend the `dataProcessor.js` discipline (pure, tested, documented) outward — without changing user-visible behavior except where a bug fix requires it.

## How to work

- **Branch:** create one integration branch off `main` (suggested: `architecture-hardening`). Build the work as **stacked diffs**: small, feature-scoped commits/PR-sized units in dependency order, each leaving `npm test` green.
- **Parallelism:** the tracks below are designed to be independent at the top level. Use separate worktrees/agents per track where useful; tracks converge onto the integration branch in the stack order given in "Stacking order" at the bottom. Within a track, tasks are sequential unless marked otherwise.
- **Surface questions at the outset:** read "Decisions already made" and "Open questions to ask the user first" before writing any code. Ask everything in one batch up front.

## Working agreements (bake into every task)

1. `npm test` passes at every stack boundary; new behavior gets tests in the same diff. For behavior changes also `node --check` the touched files and rebuild (`./build.sh --prod` locally) per CLAUDE.md.
2. Follow the repo's commit style: focused, present-tense imperative (see CLAUDE.md "Commit scope").
3. Never commit personal data: `archive/*.csv`, `.dev-data-url`, `alias-output.txt`, and (new in this work) the real `src/aliases.js` stay untracked. If a task would touch them, stop and confirm.
4. No pushes to `main`, no deploys, no git history rewrites without explicit user approval.
5. When deleting/renaming something the review called dead, re-verify it's dead at execution time (the review is a snapshot).
6. Update CLAUDE.md whenever a task changes something CLAUDE.md documents (build flow, testing, aliases, imports).

## Decisions already made (do not re-ask)

- **PLAYER_ALIASES / PLAYER_ABBREVIATIONS**: move to build-time injection. Gitignored `src/aliases.js` holding the real data; checked-in `src/aliases.stub.js` (empty tables, same shape); build resolves real file if present, else stub; CI receives the real file via a GitHub Actions secret. Names remain in git history and in the served bundle — accepted for now; history rewrite is a separate user decision (see open questions).
- **D3**: becomes a real npm dependency (latest v7.x), bundled by esbuild, imported per-module. Provenance = npm registry + `package-lock.json` integrity hashes; vendored `static/js/d3.v7.min.js` and the `<script>` tag are removed.
- **In scope**: everything in Tracks A–F below, including presenter-layer extraction, state centralization, app.js/musicianNetworkComponent splits, `// @ts-check` + eslint + one Playwright smoke test.
- **Explicit non-goals**: the accessibility overhaul (review §7 — tab/combobox semantics, focus traps, SVG ARIA) is deferred; do not scope-creep into it beyond incidental wins (e.g. if the tooltip module makes the close control a `<button>`, fine). Also out: any visual redesign, framework adoption, Observable migration.

## Open questions to ask the user first

1. **Aliases secret mechanics**: the user must create the CI secret (e.g. `PLAYER_ALIASES_JS` containing the file contents) — confirm the name and that they'll add it before the deploy workflow change merges. Until then the deploy would build with the stub (site would show short names). Sequence preference?
2. **History rewrite**: rewrite git history to purge `config.js` alias names (destructive, invalidates clones/PR refs), or accept history as-is? (Default if no answer: accept as-is.)
3. **Node version to pin** in `engines`/`.nvmrc`/CI: recommend current LTS; CI currently uses 20, local runs 26. Which?
4. **devDependencies posture**: D3 decision already ends zero-npm-deps. Confirm it's OK to also add `esbuild`, `eslint`, `typescript` (for `tsc --noEmit` over JSDoc), and `@playwright/test` as devDependencies with a lockfile, and to switch CI from `npm install -g esbuild` to `npm ci`.
5. **`archive/data.csv` regeneration**: after the Others-header fix (B3), the local archive file should be regenerated via `scripts/fetch_processed.mjs` (needs `.dev-data-url`). OK for the agent to run that locally, or will the user?
6. **Optional perf item**: re-rendering ~20 hidden composer tabs on every filter change (review §7) — fix as part of D3-state work, or leave? (Cheap to include; default: include as D4.)

---

## Track A — Build & CI hardening *(independent; start immediately)*

**A1. Make build.sh fail loudly and correctly.** Review §2, §4.1.
- `set -euo pipefail`; `command -v` preflight for esbuild/pandoc (and fswatch only when dev).
- Ensure the script's exit status reflects the build, not the trailing `ls`.
- Fix orphaned fswatch pipelines (trap must kill the `fswatch` processes, not just the `while` subshells).
- Guard `deploy_abs` against empty (`cd "$DEPLOY"` failure must not send pandoc output to `/`).
- Quote `$WATCH_PATHS` handling; remove/reduce the `eval`s; scope the `sed` rewrites to the exact `<script>`/`<link>` lines instead of whole-file global replace.
- Acceptance: intentionally breaking pandoc or `cp` makes `./build.sh --prod` exit non-zero; dev mode still works.

**A2. CI: PRs tested, supply chain pinned, versions single-sourced.** Review §3 (drift), §4.10.
- New workflow: `npm test` on every PR to `main`.
- Pin GitHub Actions to commit SHAs; verify the pandoc .deb by checksum.
- Add `engines` + `.nvmrc` (version per open question 3); CI reads the same pin.
- Tool versions (esbuild, pandoc) declared once (package.json / one env file) and referenced by build.sh, README, and workflows — remove the triple declaration.
- Acceptance: a PR with a failing test shows red before merge; `grep -r "0\.24\.2"` finds one authoritative location.

**A3. Service worker: generated manifest, full-coverage version, tested lifecycle.** Review §3 (pinning hole).
- Replace the hand-maintained `SHELL` list: generate the precache manifest from `last_deploy/` contents at build time (move SW codegen from `sed` to a small Node script so the template stays lintable and the substitution is testable).
- Derive `V` from a hash over *all* precached assets (closes the pinning hole for icons/manifest/D3-successor files; D3 leaves via C1 anyway).
- Ensure everything the build emits and links (`setup.html`, `howto.html`) is precached.
- Add tests for the `install` and `activate` handlers (precache + eviction on `V` change) and for the codegen substitution — extend the existing fake-clock harness in `test/sw.test.mjs`.
- Acceptance: a build that changes only an icon produces a byte-different `sw.js`; new tests cover install/activate.

## Track B — Data-layer correctness *(independent; start immediately)*

**B1. Sort + guard the spine.** Review §2 (fillForward/ordering), §4.5, §4.9.
- Sort rows by timestamp immediately after parse (both browser path and `scripts/fetch_processed.mjs`); drop/flag rows with invalid dates (`Invalid Date` currently passes truthiness checks and corrupts streaks).
- Guard empty datasets: `setBegin`/`this.data[0]`, status-line `data.at(-1)`, `fillForward(data[0])` on empty input.
- Acceptance: tests for out-of-order input, invalid-timestamp rows, and empty/all-incomplete datasets.

**B2. Fix and test `fillForward`; test `processRow`/`parseWork`.** Review §2, §4.6.
- Anchor the match (exact-or-prefix-with-word-boundary, not unanchored `indexOf`); with B1's sort, negative-hours can't occur, but assert non-negative anyway.
- Decide and document the empty-cell fill behavior (currently load-bearing by accident); test it.
- Tests for `processRow` (date parsing, VA1→VA, missing/renamed column → clear error) and `parseWork` (`parseInt` NaN paths, `incomplete` detection) — `incomplete` gates a global filter and has zero tests today.
- Acceptance: a "Chris"/"Christina" fixture no longer merges; suite covers all documented branches.

**B3. Fix the `Others` header drift.** Review §2 (confirmed bug).
- Writers (`src/app.js` downloadCSV, `scripts/fetch_processed.mjs`) emit `Others?` to match the reader; make readers (`processRow`, `audit_aliases.py`) tolerant of both spellings so old exports still load.
- Extract the shared header list + `escapeField` so the two writers can't drift again (single module imported by both — viable once C1 fixes import specifiers; if B3 lands first, at minimum add a test asserting the two header lists are identical).
- Acceptance: round-trip test — export via downloadCSV's code path, re-ingest via `processRow`, identical rows; audit script sees Others entries again.

**B4. localStorage robustness.** Review §3.
- Wrap all `setItem` pairs in try/catch; on quota failure, surface a visible staleness signal instead of silently serving stale-as-fresh; make the data+timestamp writes effectively atomic (single JSON envelope is fine).
- Fix `readCache`: parse-guard covers the `forEach` (valid-JSON-non-array), missing timestamp → no "NaN years ago".
- Fix `clearCachedData` host matching to cover everything `isValidGoogleSheetsUrl` accepts, and stop blanket-deleting unrelated `*_timestamp` keys.
- Acceptance: unit tests with a stubbed localStorage (unlocked by C1) for quota, corrupt cache, and URL-switch cleanup.

**B5. Fetch races.** Review §3 (both confirmed).
- First-load race: when the 5s timeout fires with no cache, don't reject-and-abandon — keep the in-flight fetch as the pending result (timeout only downgrades to cache *if cache exists*).
- Add an in-flight guard to `revalidate()` so pull-to-refresh / visibility / poll can't interleave and drop a genuine change.
- Background-refresh failures update the status line (offline/stale indicator) instead of console-only; stop styling normal cache-serving as an error color.
- Acceptance: tests simulating slow fetch + no cache, and two overlapping revalidates.

## Track C — Module hygiene & test unlocking *(independent start; C1 is a prerequisite for Tracks D and E2)*

**C1. Node-resolvable modules + D3 as a dependency.** Review §2 (untestability), §3 (vendored D3). **Do this first in the track — everything downstream needs it.**
- Add `.js` extensions to every relative import.
- `npm install d3@^7` (latest 7.x): lockfile committed, provenance = registry integrity hash in `package-lock.json`; record the exact version and how to verify (`npm audit signatures` covers registry attestation). Import `d3` (or targeted submodules) in each module that uses it; delete `static/js/d3.v7.min.js`, its `<script>` tag, its `cp` in build.sh, and its `SHELL` entry.
- Switch CI to `npm ci`; move esbuild to a devDependency (coordinates with A2).
- Acceptance: `node -e "import('./src/dashboardComponent.js')"` resolves (DOM calls may still throw — that's D's job; resolution must succeed); prod bundle builds and boots; bundle size noted before/after (tree-shaken D3 should shrink it).

**C2. Escape sheet-derived HTML.** Review §2 (XSS).
- One `escapeHtml` helper; apply at every `.html()` sink that interpolates sheet data or `error.message` (tabComponent, calendarComponent, musicianNetworkComponent, dashboardComponent, app.js). Prefer converting simple cases to `.text()`.
- Acceptance: unit test the helper; fixture row with `<img onerror>` in comments renders inert in the tooltip-building functions.

**C3. Dead code, wrong comments, named constants.** Review §4.8, §7.
- Delete: `#daytooltip` + the three comments claiming the calendar uses it; `md/md2html.sh` and the stale `md/about.html` artifact; `CACHE_KEY_PREFIX`; stale entries in TabComponent's dismissal allowlist; `window.data`; the unused `ALL_WORKS` guard in `dataService.processData`; `longestConsecutiveRun` wrapper (or move to test helper).
- Fix `handleRandomSelection`'s comment via the actual fix in C4; fix `catalog.js:33`'s stale line reference.
- Name the magic numbers: player-dropdown threshold (20), session window (4h), fetch timeout (5s), poll interval — exported constants with a one-line rationale each.
- Acceptance: `grep` shows no references to deleted items; tests still green.

**C4. Random-button stale closure.** Review §4.7 (confirmed bug).
- Rebind or restructure so `handleRandomSelection` reads current `composerData` (store on the instance/element datum rather than closing over first-render data).
- Acceptance: test (post-C1) that two successive `updateTabContent` calls with different data change the candidate pool.

## Track D — Presenter layer, dedup, state *(after C1; internal order D1 → D2 → D3 → D4)*

**D1. One tooltip module.** Review §5.
- Single implementation with the calendar's client-coords + viewport-clamp algorithm (the only correct one of the four); all components use it. Dismissal: replace TabComponent's hardcoded cross-component class allowlist with a registration/ownership model in the tooltip module itself.
- Acceptance: clamp math unit-tested; calendar tooltips dismissible by tapping elsewhere (the currently-broken case).

**D2. Extract pure computation into tested modules.** Review §5 (highest-leverage).
- Shared single sources for: the five stat definitions (×3 copies today), `PART_ORDER` (×4), `sizing()`/breakpoints (×2), CSV headers + `escapeField` (with B3).
- Move to pure, tested modules: `checkPlayersMatch`/`checkSinglePlayerMatch`, `processComposerData`, table sort comparator, `segmentsOf`/stacking math, `_syncSlider`'s state machine, chord-label de-overlap, calendar week/day-of-week totals, `_yearStatDefs` values.
- Acceptance: each extracted function has tests; the three stat-def copies are provably one (grep).

**D3. Split the megafiles; centralize state; idempotent re-init.** Review §5.
- `app.js` → SetupView, UpdateChecker, FilterEngine, StatusBar, CsvExporter modules; `musicianNetworkComponent.js` → state + graph/matrix/chord renderers.
- One plain filter/view state object with change notification; DOM reflects state (kills `.part-btn.active` / `.active-tab` as truth, the two divergent DateFilterWidget states become one source; keep the Home/Dashboard *scopes* behaving as today unless the user says otherwise).
- Re-init path (error → re-enter URL) tears down or reuses cleanly: no duplicate tabs/buttons/listeners; document listeners get teardown handles.
- UpdateChecker stops regex-parsing `sw.js` text (coordinate with A3's codegen — emit the version as a fetchable `version.json` or header instead).
- Acceptance: re-entering a data URL twice yields singular UI; `npm test` + Playwright smoke (E2) pass.

**D4 (optional, per open question 6). Filter fan-out.** Only re-render the visible tab on filter change; render others lazily on tab switch. Acceptance: behavior identical to a user; visible render count drops from ~21 to 1.

## Track E — Tooling floor *(E1 parallel with B/C; E2 after C1, ideally after A2's PR workflow exists)*

**E1. eslint + `// @ts-check` via JSDoc.** Review §5.
- eslint (flat config) with a minimal ruleset; fix or explicitly disable per-line.
- `// @ts-check` + JSDoc types file-by-file, starting with dataProcessor/dataService/config/catalog (the review's confirmed NaN/header bugs are the class this catches); `tsc --noEmit` in CI.
- Acceptance: lint + typecheck green in the PR workflow; at least the data layer fully annotated.

**E2. Playwright smoke test.** Review §5.
- One spec: serve a build, boot against a fixture CSV (use the `?data=` bootstrap with a local fixture URL or stub fetch), assert the three views render (`#main`, `#calendar`, `#dashboard`) and the status line appears. Use Alice/Bob/Carol-style placeholder names in fixtures (repo convention — never real names).
- Runs in PR CI; `@playwright/test` as devDependency.
- Acceptance: intentionally breaking boot (e.g. bad import) turns CI red via this spec.

## Track F — Aliases privacy *(independent; small)*

**F1. Build-time alias injection.** Review §2 (decided: option "build-time injection").
- `src/aliases.js` (real, gitignored) + `src/aliases.stub.js` (checked in, empty tables, same exported shape + JSDoc types); build prefers the real file (esbuild `alias`/resolve or a copy step in build.sh — pick the simplest that works in dev, prod, and tests).
- `config.js` re-exports from the resolved module so no other file changes; `audit_aliases.py`'s `node -e` loader pointed at the resolved file; its output instructions updated (it currently prints a paste-into-config block).
- Deploy workflow materializes the real file from the CI secret (name per open question 1); if absent, build proceeds with stub + a loud warning.
- Purge the real names from `src/config.js` in this diff; document the whole mechanism in CLAUDE.md, including: names remain in git history and in the served bundle (accepted), history rewrite pending user decision.
- Move `PLAYER_ABBREVIATIONS` too (audit_aliases.py re-hardcodes it — load it the same way `PLAYER_ALIASES` is loaded).
- Acceptance: `git grep` of any real full name in tracked files returns nothing; tests pass with the stub; local build with the real file produces today's behavior.

---

## Stacking order (integration branch)

Merge stacks in this order to keep every intermediate state green:

1. **A1** (build.sh) → **A2** (CI/PR workflow — everything after this gets PR checks)
2. **C1** (imports + D3) — the great unblocker
3. **B1–B5** and **F1** and **E1** in parallel stacks on top of C1
4. **C2–C4**, **B3**'s shared-header extraction, **A3** (SW rework)
5. **D1 → D2 → D3 (→ D4)**
6. **E2** (Playwright) — land once D3's re-init/state work stabilizes selectors

## Definition of done

- Every §2 "Big mistakes" and §4 "Low-hanging fruit" item from `architecture-review.md` is fixed or explicitly deferred with a written reason.
- `npm test`, eslint, `tsc --noEmit`, and the Playwright smoke all green in PR CI.
- No real names in tracked files; D3 version + integrity recorded in the lockfile.
- CLAUDE.md updated to describe the new build/test/alias/D3 reality.
- A short CHANGES summary at the top of the final PR stack mapping each diff to the review items it addresses.

## Recommended prompt for the executing instance

> Read `./architectural-transformation-todo.md` and `./architecture-review.md`. Address the issues in the todo document as a set of stacked diffs on a new branch off `main`. Work in parallel to the extent possible to save time, following the document's track structure and stacking order. Surface all questions for me at the outset — including the "Open questions to ask the user first" section — don't wait to run into them. Obey the document's Working agreements: keep `npm test` green at every stack boundary, follow the repo's commit conventions, never commit personal data, and don't push to `main`, deploy, or rewrite history without my approval.
