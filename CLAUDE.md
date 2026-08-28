# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working with this repository.

## Build, Test, Deploy

**Development** (watch mode + local server + on-save test reruns):
```bash
./build.sh                # port 8000 by default
./build.sh --port 8001    # override port
```
Outputs to `./last_deploy/` with sourcemaps. Uses `fswatch` (`brew install fswatch`) to re-copy static assets when `index.html` / `CNAME` / `static/` / `md/` change, and to re-run tests on `src/` / `test/` changes (compact dot-reporter output).

Dev traffic is served through `scripts/dev_proxy.mjs` on `$PORT`, a tiny `node:http` reverse proxy that forwards to esbuild's server on `$PORT+1` and stamps `Cache-Control: no-store` on every response. esbuild's server can't set headers and sends none, so browsers could otherwise reuse a stale `bundle.js` across same-session navigations (prod doesn't need this — assets there are content-hashed). Use the proxy's URL, not the `:$PORT+1` URLs esbuild prints.

If `.dev-data-url` exists (gitignored, one line), the dev build prints a clickable `Preconfigured: http://127.0.0.1:$PORT/?data=<encoded>` line above esbuild's `Local:` URLs. The app's `consumeDataParam()` (`src/urlConfig.js`) reads `?data=…` on first load and persists it to localStorage, so you skip the setup prompt.

**Production build:**
```bash
./build.sh --prod
```
Runs `npm test` first; aborts on failure. Outputs minified bundle to `./last_deploy/`.

**Tests / checks:**
```bash
npm test            # unit tests (node:test over test/*.mjs)
npm run lint        # eslint flat config (eslint.config.js)
npm run typecheck   # tsc --noEmit over // @ts-check'd files (data layer)
npm run test:e2e    # Playwright boot smoke (build with ./build.sh --prod first)
npm run audit       # data-quality audits against a freshly fetched sheet
npm run audit -- --no-fetch   # ...against whatever is already in archive/
```

`npm run audit` (`scripts/audit_all.sh`) runs all three audits and prints a summary. Each needs a different view of the data and the difference is load-bearing: `audit_aliases` and `audit_ensembles` read the **processed** `archive/data.csv` (post-`fillForward`, so every row lists its full group — on the raw sheet every continuation row would look under-logged), while `audit_fillforward` reads the **raw** `archive/data-raw.csv` by necessity, since it looks for exactly the blank player slots `fillForward` erases. The summary's two alias-target counts come from a second pass over the raw sheet, because on a canonicalized export every canonical name is present by construction and both are always 0 there. They are split by whether the sheet writes that surname down anywhere: if it does not, the alias is the only record of it (the point of the table for anyone logged by first name only, nicknames included), and if it does, the canonical is a spelling that drifted — only the second is ever a bug. A canonical name that some sheet name *resolves* to is a live alias and is reported as neither. The summary also marks which findings decay: bare ambiguous names and under-logged rows need memory and get harder to answer over time, while a dropped `Others?` player is recoverable from the row above it whenever you get to it.
All four run in PR CI (`test.yml`); the Playwright job builds the site and boots it against a fixture CSV (`e2e/smoke.spec.js`). A `pretest`/`pretypecheck` hook materializes `src/aliases.js` from the stub on fresh clones.
Uses Node's built-in `node:test` runner against `test/*.mjs`. No external test deps. Tests cover `src/dataProcessor.js` helpers (alias normalization, partial-movement filtering, aggregate stats, etc.).

**Lint & typecheck:**
```bash
npm run lint       # eslint flat config (eslint.config.js): @eslint/js recommended + env-correct globals
npm run typecheck  # tsc --noEmit over JSDoc types (tsconfig.json); pretypecheck materializes src/aliases.js
```
Both run in PR CI after the tests. eslint covers `src/`, `scripts/`, `test/`, and `static/sw.js` (serviceworker globals); the four components under the concurrent tooltip refactor have a config-scoped `no-unused-vars` suppression (TODO in `eslint.config.js`). Typechecking is opt-in per file via a leading `// @ts-check` comment — currently the data layer (`dataProcessor`, `dataService`, `config`, `catalog`, `csvFormat`, `urlConfig`, `escapeHtml`, `aliases.stub`) and the build scripts (`gen_sw.mjs`, `ensure_aliases.mjs`). The canonical row shape is the `Row` typedef in `src/dataProcessor.js`; reuse it via `import('./dataProcessor.js').Row` in JSDoc. `tsconfig.json` keeps `strict` on but `noImplicitAny` off so imports from unannotated modules (UI components, d3) flow as `any` — see the comment there. Build-time defines (`__WORKS_VERSION__`) are declared in `types/globals.d.ts`.

**Deploy:**
Push to `main` → GitHub Actions workflow (`.github/workflows/deploy.yml`) runs `npm test`, builds, deploys to GitHub Pages. Site lives at https://log.quartetroulette.com.

**Offline / service worker:**
`static/sw.js` is a template; `scripts/gen_sw.mjs` (run by `build.sh --prod`) generates `$DEPLOY/sw.js` plus `$DEPLOY/version.json` from it. The precache `SHELL` list is generated from `last_deploy/`'s actual contents (so nothing the build emits — `setup.html`, `howto.html`, icons — can be missing), excluding only `sw.js` itself, `version.json`, `CNAME`, and sourcemaps. The cache version `V = ql-<hash>` hashes the content of **every** precached asset, so any deploy that changes anything (code, CSS, catalog, an icon, the manifest) moves `V` and evicts the stale cache on `activate` — there's no hand-bumped constant and no hand-maintained file list to forget. Eviction is gated on a verified-complete precache (`ensureShell()`: top-up missing entries, re-check, and only then collect old generations — from pwa-starter dd763ca's offline family), so a flaky-network install can't leave a partial shell after destroying the last complete one; until the shell completes, old caches keep serving offline via `caches.match()`. The codegen's pure functions are unit-tested in `test/gen_sw.test.mjs` along with the install/activate lifecycle. The cross-origin Google Sheet is never cached by the SW (the app keeps its own localStorage stale-while-revalidate). Fetch strategy is split three ways: HTML/navigations are network-first (bounded, falling back to cache), content-hashed JS/CSS/images are cache-first, and same-origin JSON (the work catalogs boot blocks on) is stale-while-revalidate — the cached copy serves instantly and a background refresh writes under the bare pathname so it replaces the precached entry (from pwa-starter e88a743). `src/app.js` registers it, skipping `localhost`/`127.0.0.1` so dev's esbuild live-reload server is never intercepted (dev builds don't emit `sw.js` anyway).

The SW's `fetch` handler early-returns for its own `/sw.js` and for `/version.json` (never intercept/cache them) so the version check below can always read the live copy off the server. The hamburger menu has a hidden `#ver` row that `checkVersion()` (`src/updateChecker.js`, run on boot and every foreground resume) reveals: it reads the installed version from the `ql-` cache key and the latest from `./version.json?_=<ts>` (`no-store`), and when they differ shows an accented "Update available" (`.menu-item--update`) that taps through to `forceUpdate()` — drop all caches + reload, forcing a clean shell reinstall. This is the one-tap escape hatch for a wedged iOS home-screen install (network-first already auto-updates the happy path). Adapted from the [pwa-starter](https://github.com/jsundram/pwa-starter) update tag; unlike that repo's monotonic `app-vN`, ours compares content-hash `V` strings for equality.

**Dependencies:**
- Node 26 (pinned in `.nvmrc` + `engines`; CI reads `.nvmrc`)
- esbuild — devDependency, exact version in `package.json`/`package-lock.json`; `npm install` puts it in `node_modules/.bin`, which `build.sh` prefers over any global install
- pandoc (with `gfm+attributes+implicit_figures` extensions) — version and .deb sha256 single-sourced in `package.json` `"config"`; the deploy workflow reads and checksum-verifies them
- fswatch (optional, for dev mode)

**CI:** `.github/workflows/test.yml` runs `npm ci` + `npm test` + `npm run lint` + `npm run typecheck` on every PR to `main`; `deploy.yml` (push to `main`) tests, builds, and deploys. All actions in both workflows are pinned to commit SHAs.

## Architecture Overview

Vanilla JavaScript + D3.js v7 SPA. No framework. Each user configures their own published Google Sheet URL (stored in localStorage). The site fetches that CSV on each visit, with a localStorage cache fallback (5s timeout) so it works on flaky networks.

### Views (hash-routed)

The SPA has three in-page views and one external page, all reachable from the hamburger menu:

- **`#main`** (Home) — composer tabs, filterable lists, sortable per-composer data tables, ALL tab with aggregate stats + flat table. Tab order/content is data-driven from `all_works.json`: single-composer keys plus multi-composer tabs (`5+`, `MISC`), whose catalog entries are `{ composer: titles[] }` arrays and whose work labels are composer-prefixed (`Mozart-K515`). Adding another multi-composer tab is a JSON-only change (`isMultiComposerTab` detects the shape).
- **`#calendar`** — GitHub-contributions-style year grid; per-year stats column; "Last 365 days" header; per-day tooltips.
- **`#dashboard`** — cross-filter charts: stacked part bar (V1/V2/VA) + horizontal top-composers bar chart. Clicking one filters the other.
- **`about.html`** — static markdown page (linked from menu; renders as a separate page).

Hash routing lives in `NavigationComponent`: menu clicks set `window.location.hash`, a `hashchange` listener calls `applyView()`. The initial hash on page load is honored via `applyInitialView()` called from `App.initializeUI`.

### Component map

**Orchestration:**
- `App` (`src/app.js`) — owns data, instantiates and wires components, runs `filterData()`. The former app.js megafile is split: `setupView.js` (URL setup screen + `flashLabel`), `updateChecker.js` (shell-version probe via `version.json` + `forceUpdate`), `statusBar.js` (every `#update` message: loading/freshness/offline/storage-full/no-data/error), `csvExporter.js` (Download Data), `filterEngine.js` (pure Home filter pipeline). Re-init (error → re-enter URL) is idempotent: every `initializeUI` step rebuilds instead of stacking (menu listeners wired once with teardown handles kept).

**Data layer:**
- `DataService` (`src/dataService.js`) — CSV fetch + localStorage cache. `processData` calls `prepareRows` (sort by timestamp, drop invalid-date rows) then `fillForward` then `normalizePlayerNames`, then filters out partial-movement entries (titles containing `:`). Three fetch entry points: `fetchCSV()` (network races a 5s timeout, falls back to cached copy — used only for the first-ever launch with no cache); `readCache()` (synchronous localStorage read, returns `null` if empty — drives the cache-first boot paint); `fetchFresh()` (network-only, no fallback; writes the cache and returns a `changed` flag by diffing the new serialization against the stored one, so the caller can skip a re-render when the sheet is byte-identical). Both network paths reject a valid-but-empty (0-row) response instead of caching it — persisting `[]` would poison the cache-first boot (`readCache()` would serve `[]` and `fillForward()` would throw on every subsequent launch); `fetchCSV` falls back to cache, `fetchFresh` throws so `revalidate()` keeps the painted UI.
- `dataProcessor` (`src/dataProcessor.js`) — pure functions only, and now literally: the module imports nothing. `fillForward` / `normalizePlayerNames` / `canonicalize` take the name tables as **required** arguments (see "Alias privacy"). Highlights:
  - `parseWork`, `processRow`, `prepareRows` (sort by timestamp + drop invalid-date rows; run before `fillForward` so session-window math sees chronological order), `fillForward`, `createEmptyRow`
  - `normalizePlayerNames` (applies `PLAYER_ALIASES` per slot class)
  - `slotPartsFor(d)` — the part each of the three slots represents: the seat `SLOT_TO_PART` implies, overridden by a slot annotation. The single source for `computePartBreakdownPerMusician`, `extractUniquePlayers` and `checkSinglePlayerMatch`, so the charts, the Player dropdown and its filter cannot disagree about one row
  - `peopleKeysFor(d)` — canonical-name keys for unique-people counting
  - `computeAggregateStats(rows)` — `{ pieces, uniquePieces, uniqueParts, uniquePeople, daysPlayed, maxStreak }`; used by Calendar's "Last 365 days", the Dashboard KPI tiles, and the ALL tab. `maxStreak` is the longest run of consecutive playing days (via `longestRunInfo` over DST-safe day ordinals), scoped to the passed-in slice
  - `longestRunInfo(days)` — `{ length, count, start }` for the longest run of consecutive integer day ordinals in a Set/array
  - `normalizeDashboardPart(part)` — folds `VA1`/`VA2`/`VA…` → `VA` for the Dashboard pie/bar
  - `parseOthers`, `stripParens`, `classOf`, `canonicalize` (helpers)
  - `extractUniquePlayers` — for the Player dropdown
- `csvFormat` (`src/csvFormat.js`) — pure shared CSV-export format: `CSV_HEADERS` (canonical header list — the Others column is spelled `Others?` to match the sheet and `processRow`), `escapeField`, `formatTimestamp`, `rowToFields`, `serializeRows`. `rowToFields` re-attaches each slot's `(instrument)` annotation to the canonical name (`normalizePlayerNames` splits them apart), so the export round-trips losslessly and `audit_ensembles.py` can see an annotated pianist in a string seat. Imported by BOTH writers (`App.downloadCSV` and `scripts/fetch_processed.mjs`) so they can't drift; readers (`processRow`, `scripts/audit_aliases.py`) also accept the legacy `Others` header from pre-fix exports.
- `tableComponent` (`src/tableComponent.js`) — sortable HTML data tables. `getColumnsForComposer` includes the composer column for multi-composer tabs (`5+`, `MISC`) and `ALL` only. Sort comparator is the pure exported `makeRowComparator` (work.title sorts by catalog-then-number, not string order).
- `statDefs` (`src/statDefs.js`) — `buildAggregateStatDefs(agg, windowPhrase)`: the six stat definitions (label/short/value/tooltip copy), single-sourced for the ALL tab, Dashboard KPI tiles, and Calendar recent-stats header.
- `breakpoints` (`src/breakpoints.js`) — `MOBILE_BREAKPOINT`, `MAX_DESIGN_WIDTH`, `isMobileWidth`, `isTouchPrimary`; the chart components' shared responsive constants (their `sizing()` knob tables stay per-component).
- `tooltip` (`src/tooltip.js`) — THE tooltip implementation (see below).

**UI:**
- `NavigationComponent` (`src/navigationComponent.js`) — hamburger menu (native dismiss: outside-click + Escape), segmented Part buttons (V1/V2/VA/ANY), Player multiselect dropdown, view switching + hash routing. Delegates the date range to `DateFilterWidget`.
- `DateFilterWidget` (`src/dateFilterWidget.js`) — reusable segmented date range picker (`All` / `YTD` / `1Y` / `6M` / `Custom`). Class-based selectors scoped to mount point so multiple instances can coexist; Home and Dashboard each have their own.
- `TabComponent` (`src/tabComponent.js`) — per-composer tab content + ALL tab. `updateTabContent` early-returns to `updateAllTabContent` for the special ALL tab. Random-button suggestion respects current filters (pure `pickRandomWork`, rebound on every update); grouping is the pure `groupPlaysByWork`. `activeTab` on the instance is the source of truth (`.active-tab` classes are reflections); `onTabShown` hook drives lazy rendering (below).
- `CalendarComponent` (`src/calendarComponent.js`) — calendar grid, legend, per-year stats column, "Last 365 days" header (uses `renderRecentStats` → `computeAggregateStats`). Legend SVG and grid are width-coupled via CSS.
- `MusicianNetworkComponent` (`src/musicianNetworkComponent.js`) — state machine + chrome (tabs, slider via pure `computeSliderSync`, fullscreen, name toggle, tooltip builders); the three views render via `networkGraphRenderer.js` / `networkMatrixRenderer.js` / `networkChordRenderer.js`, each taking a plain ctx object.
- `DashboardComponent` (`src/dashboardComponent.js`) — owns `{ selectedPart, selectedComposer }` plus its own `DateFilterWidget`. Re-renders both charts on any mutation (cheap at this data size). Cross-filter rule: each chart applies every filter except its own dimension. Charts measure live container width and render at 1:1 pixel scale (viewBox = pixel dims) so mobile gets bigger fonts/bars instead of scaled-down ones; re-renders on window resize and on `notifyShown()` (fires when the view first becomes visible after init while hidden).

### Initialization sequence

Boot is **cache-first** so a returning visitor (especially an installed PWA against the slow, cross-origin published Sheet) sees real data on first paint instead of an empty shell:

1. `loadWorkCatalog()` loads `all_works.json` + `haydn_peters.json` in parallel — required before any data processing/filtering.
2. `DataService.readCache()`: if last-known data is in localStorage, `renderInitial()` paints the whole UI from it immediately, `finishBoot()` wires pull-to-refresh + the keep-fresh loop, and `revalidate()` fetches the sheet in the background — re-rendering in place **only if `fetchFresh()` reports the data changed** (guards against a needless flash). If there's no cache (first-ever launch), it shows the loading indicator and awaits `fetchCSV()` instead.
3. `renderInitial()` → `processData()` (`fillForward` → `normalizePlayerNames` → filter incompletes) → `setBegin()` → `initializeUI()` mounts components (menu, part buttons, date filter, tabs, calendar, dashboard).
4. `filterData("date")` populates the Player dropdown and renders the initial view.
5. `NavigationComponent.applyInitialView()` honors any `#<view>` hash in the landing URL (e.g. `/index.html#dashboard`).

`revalidate()` is the single re-fetch path for background refreshes too (foreground-resume, the 5-min poll, and pull-to-refresh all call it). Its change-guard means an unchanged sheet updates only the status line; `_rerenderData()` (the in-place calendar/dashboard/tabs rebuild) runs only when the data actually moved, and it preserves the current view/tab/filters.

`PullToRefresh` (`src/pullToRefresh.js`, standalone-PWA only) claims a downward drag only when the page is at `scrollY === 0` **and** the touch did not start inside something that scrolls itself. The pure `startsInScroller` walks `e.target`'s ancestors to `<body>` and bails on any element that is declared scrollable (`auto`/`scroll`) on **either** axis and actually overflows on that axis — the open Player dropdown list, a tall tooltip, the tab strip and date-range buttons, the fullscreen lightboxes. It's a structural test, not a class allowlist (same reasoning as the tooltip's ownership walk), so a new scrollable panel is covered for free; an `overflow-x` wrapper that doesn't currently overflow (a narrow table on a wide screen) stays pullable. Both axes matter because PTR sees only the vertical component of a gesture: without the Y check, PTR `preventDefault()`s the first downward move inside the dropdown and the list can't be scrolled back up; without the X check, a sideways swipe with a few pixels of drift freezes the pan and can fire a refresh — which is how the fullscreen calendar behaves, since its height is fitted to the viewport (no vertical overflow to detect) and `body.calendar-fullscreen-open` pins `scrollY` at 0. The cost is that a genuinely vertical pull starting on a horizontally-overflowing strip no longer refreshes; the page around it stays pullable.

### Filter change notifications

`NavigationComponent` calls `onFilterChange(filterType)` with one of:
- `"part"` — part buttons changed (the `VA` button folds explicit second-viola `VA2` rows in via `filterEngine.partMatches`, mirroring the dashboard's `normalizeDashboardPart` fold; `VA2` rows would otherwise be reachable only through `ANY`)
- `"date"` — date range changed
- `"player"` — player selection changed

App's `filterData(filterType)` reads all three filters (part from `navigationComponent.selectedPart` — state, never the DOM), computes `filteredData` via `filterEngine.filterRows`, renders ONLY the visible tab, and marks the rest dirty; `TabComponent.showTab` → `onTabShown` lazily renders a dirty tab when it becomes visible. User-visible behavior is identical to rendering all ~21 tabs, at 1/21 the work.

The Player dropdown refreshes only on `"date"` / `"part"` changes (not `"player"`), shows players with ≥20 entries in the filtered dataset, and preserves the current selection even if it would drop below 20.

### Player name handling

**Canonical names**: `PLAYER_ALIASES` is **instrument-class-aware** because a short name can refer to different people on different instruments (a hypothetical `Jo` on violin/viola could be Jo Alpha while `Jo` on cello is Jo Beta). Shape:
```js
{ "Jo": { upper: "Jo Alpha", cello: "Jo Beta" } }
```
Classes: `upper` (V1, V2, VA, VLA — violin/viola alias as one person) and `cello` (VC, never aliases with upper). Per-instrument aliasing happens at ingestion (`normalizePlayerNames`) so all downstream consumers see canonical names. `peopleKeysFor()` keys the unique-people set by canonical name (no class suffix), so a multi-instrumentalist playing e.g. both piano and cello correctly collapses to one person.

**Alias privacy (build-time injection)**: the real `PLAYER_ALIASES` / `PLAYER_ABBREVIATIONS` tables are ~40 real people's full names — personal data that must never appear in a tracked file (the repo is public). Mechanism:
- `src/aliases.js` — the REAL tables. Gitignored, personal; never commit it.
- `src/aliases.stub.js` — checked in: empty tables with the same exported shape + JSDoc typedefs and the mechanism docs.
- `scripts/ensure_aliases.mjs` — copies the stub to `src/aliases.js` when it's missing (fresh clone, CI). Idempotent, dependency-free. Run automatically by `build.sh` (both modes) and by the npm `pretest` hook, so every entry point works without the personal file — names just pass through un-normalized.
- `src/config.js` re-exports both tables from `./aliases.js`. Exactly two callers read them: `DataService.processData` and `scripts/fetch_processed.mjs`, the app's and the export script's single wiring points.
- Deploy (`.github/workflows/deploy.yml`): a "Materialize player aliases from secret" step before Build writes `src/aliases.js` from the `PLAYER_ALIASES_JS` Actions secret (the file's full contents). If the secret is unset, it prints a `::warning::` and the deployed site shows the sheet's raw short names.
- `scripts/push_aliases.sh` — syncs the local `src/aliases.js` up to the `PLAYER_ALIASES_JS` secret via `gh secret set`. Nothing does this automatically, so run it after editing the tables (the audit script's proposal output reminds you). Validates the file first (must import cleanly, tables non-empty) so a stub copy can't blank the secret.
- **Accepted residue**: the real names remain in git HISTORY (pre-extraction `src/config.js`) and in the SERVED BUNDLE of any deploy that has the secret. Both accepted for now — a history rewrite was explicitly declined.
- Tests cannot depend on the real tables, structurally rather than by convention: `fillForward` / `normalizePlayerNames` / `canonicalize` take the table as a **required** trailing argument and throw without one, so a test that forgets it fails loudly instead of reading real names locally and the empty stub in CI — behaviour that differed by machine and was invisible in the test. Fixtures pass their own table (`{}` for "no normalization"), with placeholder names (Alice/Bob/Carol-style; when more are needed, walk an Atlantic hurricane list in list order). What matters is where a name came FROM, not whether someone in the log happens to share it: a name that arrives from a published list carries no information about the log either way, while *filtering* that list against the log would make the omissions themselves say who is in it. So take the next name on the list and don't check.

**Player slot conventions**: `player1`/`player2` are always "upper" class, `player3` is always "cello" — derived from the user's own part (V1/V2/VA). Quintet rows logged with the user on `VA2` follow the same convention (violins in slots 1–2, cello in slot 3, the other violist under Others), so `SLOT_TO_PART` maps `VA2` like `VA`; a `VA1` part value is normalized to `VA` at `processRow` time. `stripParens` removes inline `(instrument)` annotations like `Alice Hart (piano)` from player slots before aliasing.

**Instrument annotations**: a `(instrument)` suffix may appear on a player slot as well as on an `Others?` entry. On a slot it **overrides the positional class** — but only when it names an instrument. `instrumentFromSlot` returns null for a parenthetical that doesn't (`(sub)`, `(guest)`, `(Bob's teacher)`), because `classOf` answers `upper` for any non-empty string, so honoring one would silently reclass the player — a `(sub)` in the cello slot would alias to the upper-class person of that name and drop out of the VC column. Otherwise `instrumentFromSlot` parses it and `normalizePlayerNames` passes `classOf(annotation) ?? SLOT_CLASS[i]` to `canonicalize`, while `computePartBreakdownPerMusician` prefers `partFromInstrument(annotation)` over `SLOT_TO_PART`. This exists because ensembles the quartet layout has no seats for (piano trios and quartets above all) push people into whichever column is free, so a pianist or cellist can land in an upper slot; classifying by what they played beats classifying by which column they landed in. Unannotated slots behave exactly as before. `classOf` and `partFromInstrument` share the `CELLO_INSTRUMENT` / `VIOLA_INSTRUMENT` patterns so terse codes and spelled-out names agree — `vc`/`cello`/`violoncello`/`c` all read as cello, `va`/`vla`/`viola` as viola. The `(?![a-z])` guards are load-bearing: they stop `c` matching `clarinet` and `va` matching `violin`. Unnumbered violin (`violin`/`vn`/`vln`) deliberately buckets as `OTHER` — it says nothing about which violin seat, so guessing would be worse than admitting ignorance. Keyboard shorthand (`p`/`pf`/`pno`/`piano`) buckets as `OTHER` for parts and `upper` for aliasing. The user-facing convention is documented in `md/howto.md` §5.

**Others? column**: free-form, parsed by `parseOthers`. Entries are separated by `;` or `,` **at paren depth 0** (paren-aware split, so commas inside an annotation don't tear an entry in half). Each entry is `Name`, `Name (instrument)`, or `Name (instrument, comment)`. Inside the parens, the **first** comma separates the instrument code from a free-form comment — later commas stay in the comment (e.g. `Carol (v1, shadowing on II, III)` → instrument `v1`, comment ignored). The instrument string classifies via `classOf` (`vc*` → cello, else upper). The parsed list is attached as `othersList` on each row; the raw `others` string stays untouched for the CSV-download path.

**Audit script** (`scripts/audit_aliases.py`) reads an exported CSV (default `archive/data.csv`, gitignored) and surfaces candidate aliases by lowercased first-token grouping + teammate-overlap. Loads `PLAYER_ALIASES` **and** `PLAYER_ABBREVIATIONS` live from the resolved `src/aliases.js` via a `node -e` subshell (running `ensure_aliases.mjs` first) — single source of truth, no manual sync. It warns when the tables are empty (stub) since the audit is then meaningless, and its paste-ready output block targets `src/aliases.js`, never a tracked file.

`report_ambiguity()` adds the complementary check — not "which short forms belong in the table" but "which must not", because an alias maps one name to one person and the sheet may hold several who share it. Three hazards: (1) a bare first name still in the sheet that 2+ full names could match — unfixable by any alias, the rows themselves need editing, since `PLAYER_ALIASES` is keyed on (name, class) and cannot say "this row is Alice Hart and that one is Alice Bek". `attribute_bare_rows` then answers it per ROW instead of per name, which is what decides whether there is work to do: two people who share a first name almost never share a stand (the candidates' teammate circles in this log are literally disjoint, jaccard 0.00 for every ambiguous pair), so the other players in the row identify the one who was there long after anyone could recall the evening. It reports only the rows that matter — where the room contradicts the alias (the alias is crediting the wrong person; fix the sheet cell) and where no circle matches (a one-off group; the only rows that truly need memory) — and counts the rest. On the real log that turned "11 names need memory" into one row of each; (2) an existing alias keyed on such a name, which silently resolves every future bare entry to whichever person the table names; (3) an alias whose canonical name appears nowhere in the sheet *and* isn't what any sheet name resolves to — usually a spelling fix applied to the data but not to the table, reported with a `did you mean:` hint from the same first token. The liveness test matters: without it, every alias doing its job (its target is absent from the raw sheet by design) reads as needing repair. Hazards 1 and 2 can only fire once a second full name with that first name exists in the data.

**Ensemble audit** (`scripts/audit_ensembles.py`) is the companion to the alias audit: it checks *row completeness* rather than names. Each work title implies a headcount (`trio` 3, `quartet` 4, `quintet` 5, `sextet` 6, `octet` 8 …), and the script reports rows logging fewer people than that, split by whether the title stated the ensemble or the quartet default was assumed (untitled works are numbered string quartets, so 4 is a guess and duos/partial sessions land there legitimately). It separately lists piano works where nobody carries a keyboard annotation — headcount may be right while the pianist sits in a string seat and is counted as a string player; that section can only see a piano work whose title or comment says so, since `all_works.json` carries no piano repertoire. Titles are often bare catalogue numbers, so Comments are read too, but only for an instrumentation phrase (`piano quartet`) and only when the row is **not** a catalogued string quartet — prose like "after piano quartet afternoon" on a Haydn quartet parses as an instrumentation phrase and would otherwise mis-size the row. Imports its parsing helpers from `audit_aliases.py` and the catalog from `audit_fillforward.py` so the three can't drift; `slot_instrument()` deliberately does *not* mirror `instrumentFromSlot`'s instrument-vocabulary gate, since its only consumer filters for keyboards straight afterward.

**Alias maintenance in practice.** The owner's convention is to record a surname only where the first name is ambiguous — 14 people in the log have no surname anywhere, including the three most frequent collaborators. That is deliberate, not an oversight to "fix": a bare `Alice` is unambiguous today and 1908 rows deep. What the alias table exists for is the other case, where a surname is known but was never typed into the sheet; eleven entries are currently the *only* record of one, which is why `npm run audit` names backing up `src/aliases.js` as a standing risk.

New people arrive at roughly 12/month but very unevenly — 1–4 in quiet months, 20–28 after a camp or a trip, since those are where first-name-only entry happens in bulk. The audits differ in how fast their findings decay, and that should drive when they are run: a dropped `Others?` player is recoverable from the row above it whenever anyone gets to it, but "which Bob was this" gets harder every month and is unanswerable once memory goes. So run the alias audit right after any multi-day event and monthly otherwise; the rest can batch. `md/howto.md` §6 carries the upstream fix — a full name on first entry for anyone new, which is what stops the ambiguity being created at all.

**Fetch scripts** (both read source URL from `.dev-data-url`, both gitignore their outputs):
- `scripts/fetch_processed.mjs` — fetches the sheet, runs the same `prepareRows` + `fillForward` + `normalizePlayerNames` + drop-incompletes pipeline as the in-browser "Download Data" button, writes `archive/data.csv` via the same shared writer (`src/csvFormat.js`). This is the file `audit_aliases.py` defaults to.
- `scripts/fetch_raw.sh` — `curl`s the raw published CSV verbatim to `archive/data-raw.csv` (no JS processing, partial-movements included, names un-normalized).

### Calendar specifics

Per-year stats column shows six numbers (Pieces, Unique Pieces, Unique Parts, People played with, Playing Days, Longest Streak) at `cellSize*2` through `cellSize*7`, with tooltips wired via `attachStatTooltip` (works on hover and tap). The stat values + tooltip copy live in `_yearStatDefs`, shared by both layouts (horizontal right-hand column and fullscreen below-grid rows) so they can't drift. The legend SVG is sized to exactly `10 * cellSize` wide and uses CSS `width: min(170px, 17%)` + `margin-left: min(40.5px, 4.05%)` so it tracks the calendar grid's first 10 cells across all viewport widths.

**Fullscreen (vertical) mode**: an expand button (network-graph style: `.network-fullscreen-btn` for looks + `.calendar-fullscreen-btn` for placement) toggles a lightbox where the grid renders transposed (`renderYearGroupsVertical`) — weeks run down, days across — with the cell size fitted so a whole year fills the viewport height (54 week rows: a leap year starting Saturday spans 54 Sunday-weeks). Year columns run chronologically left→right and the container opens scrolled to its right edge, so the current year is in view and panning left walks back in time. Legend + recent stats are omitted to give the grid every pixel. Entering also calls `requestFullscreen()` on `<html>` — NOT on `#calendar`, because browsers render only the fullscreen element's subtree and the tooltip div is a `<body>` child — with every failure path silently falling back to the fixed `100dvh` overlay CSS (older iOS, installed PWAs). Esc or the collapse button exits both native fullscreen and the lightbox; a gesture-exit from *native* fullscreen deliberately leaves the lightbox open (auto-closing on `fullscreenchange` closed everything whenever a browser bounced the request). A window `resize` listener re-fits the grid on rotation / chrome show-hide.

**Re-render contract**: calendar rebuilds (`rerender()`, App's `_rerenderData`) remove only `.calendar-gen`-tagged nodes from `#calendar`, so the static `<h1>` in index.html survives. Anything `createCalendar` appends must carry the `calendar-gen` class.

**Tooltips**: one implementation, `src/tooltip.js` — all components render into the single body-level `#tooltip` div via `tooltip.show/attach`, positioned by the pure `clampToViewport` (client coords, flip-then-clamp, converted to page coords) so tooltips stay on-screen on phones and inside the fullscreen overlays. Tap-outside dismissal is one document listener with an ownership model: trigger elements are registered via `tooltip.own()`/`attach()` (WeakSet, matched by ancestry) — never a class-name allowlist. The shared `.tooltip` CSS still provides the viewport max-width/height + scroll + sticky close button.

### Configuration files

- **`src/urlConfig.js`** — `getDataUrl` / `setDataUrl` / `hasDataUrl` / `isValidGoogleSheetsUrl` / `clearDataUrl`. URL persists in localStorage.
- **`src/config.js`** — `getBegin` / `setBegin`, `getCssColor(token)` / `getPartColor(part)` (read colors from CSS custom properties on `:root`; the canonical source for part colors lives in `static/css/viz.css` as `--color-part-{v1|v2|va|va2|vc}` — `va2` is the medium-blue second-viola color for quintet rows, CVD-validated against v1/v2/va, the only colors it co-occurs with on screen), `invalidateColorCache()` (clear the memo, called by the theme manager on toggle), `PLAYER_ABBREVIATIONS` (single-letter → short-name expansion) and `PLAYER_ALIASES` (instrument-class-keyed) — both re-exported from the gitignored `src/aliases.js` (see "Alias privacy" above), `CALENDAR_CONFIG`.
- **`src/catalog.js`** — `ALL_WORKS` and `HAYDN_PETERS` (loaded in parallel from `all_works.json` and `haydn_peters.json`; `loadWorkCatalog` fetches then hands off to `installCatalog`, the seam `test/catalog.test.mjs` uses to install fixture catalogs), `COMPOSERS` set, `ALL_TAB` / `isAllTab` / `isMultiComposerTab` helpers (the latter is shape-based: a catalog entry that's an array of `{ composer: titles[] }` objects marks a multi-composer tab — `5+`, `MISC`), `getDisplayLabel` (work-row label text: in a multi-composer tab a composer with exactly one work displays as just the composer; data stays keyed by the full prefixed title), `getPetersVolume(work)` for Haydn tooltip suffix, `generateQuartetRouletteUrl(d)` per-composer URL builder — returns `null` for works quartetroulette.com has no page for (anything outside the composer's own quartet list + MISC, i.e. the 5+ rep), and tooltips then render an unlinked header.
- **`src/themeManager.js`** — three-state theme: `auto` (default, follows `prefers-color-scheme`) / `light` / `dark`. Persists to `localStorage.theme`, applies via `<html data-theme="…">` (no attribute for auto). API: `getTheme()`, `setTheme(t)`, `cycleTheme()`, `isCurrentlyDark()` (resolved boolean), `subscribe(fn)` (listener for changes; fires on user toggle AND on system theme flip when in auto). Initial application is split: a synchronous inline `<script>` in `index.html` / `_pandoc_template.html` sets `data-theme` before first paint to avoid FOUC; `initTheme()` re-applies and attaches the matchMedia watcher after the bundle loads.

### Theme system contract

When adding a new component that bakes color values at render time (e.g. d3 `.attr('fill', getCssColor('--…'))`), it MUST re-render on theme change. The pattern is:

1. Expose a method that rebuilds the component's DOM with fresh color reads — `rerender()` on `CalendarComponent` is the reference.
2. App's `onThemeChange()` calls `invalidateColorCache()` FIRST (so the next `getCssColor` reads the new resolved value), then invokes each component's rerender.
3. Components driven purely by CSS variables — i.e. no JS reads of color values, all `var(--…)` in stylesheets — update for free via the cascade and need no JS plumbing.

The dashboard and the per-tab work-square renders already pick up new colors because they re-render on every filter change; `onThemeChange()` calls them directly (dashboard) or via `filterData("date")` (tabs). The calendar is the special case because it bakes the d3 interpolator + canvas legend ramp at construction.

### Browser compatibility

Bundle targets: Chrome 92+, Firefox 90+, Safari 15.4+, Edge 92+. Driven by `Array.at()` usage. CSS uses `min()` and `:has()` which need Safari 15.4+.

## Markdown pages (pandoc)

`md/about.md` and `md/howto.md` are rendered to `about.html` and `howto.html` by pandoc, using `md/_pandoc_template.html`. The template includes inline CSS + a small JS snippet that gives the markdown pages the same hamburger menu + site title chrome as the SPA. Menu items on the static pages link back to `index.html#main` / `#calendar` / `#dashboard` / `about.html` (the `Download Data` and `Log Out` items are omitted since they need SPA context).

Pandoc reads `gfm+attributes+implicit_figures` so `![alt](path){width=600px}` syntax works and images-alone-in-a-paragraph auto-wrap as `<figure>` with the alt text as the caption. The build runs pandoc with output written **directly** to `$DEPLOY/` (not via `md/`) so fswatch on `md/` doesn't see write events and spin in a rebuild loop.

## Conventions and preferences

- **Python**: use `uv run --with <pkg> python ...` for one-off scripts/tools. Don't try `pip install`. The user keeps Python environments isolated via `uv`.
- **`cd`**: don't prepend `cd <current-dir>` to commands that need permission — it triggers redundant prompts. Use absolute paths for files outside the cwd, or `(cd path && cmd)` in a subshell only when the tool genuinely requires a different cwd (e.g. pandoc resolving relative image paths).
- **Don't destructively overwrite user-supplied assets**: when transforming images/data/etc. the user shared, write the result to a NEW path (e.g. `*-redacted.png`) so the source can be re-used for iteration. Only overwrite the source when the user explicitly asks for in-place editing.
- **Verify before claiming done**: for behaviour changes, run `npm test` and (where applicable) sanity-check via `node --check <file>` and/or rebuild and inspect. For markdown changes, run pandoc and grep the output to confirm.
- **Commit scope**: prefer focused commits with clear messages over kitchen-sink commits. Recent history has examples like "add player-name normalization and unique-people yearly stat" — feature-scoped, present-tense imperative.

## Gitignored / untracked things to know

- `archive/data.csv` — full CSV used by the audit script. Refresh via `scripts/fetch_processed.mjs` (mirrors the in-browser "Download Data" output). Personal data; gitignored.
- `archive/data-raw.csv` — raw unprocessed sheet, refreshed via `scripts/fetch_raw.sh`. Personal data; gitignored.
- `archive/*.zip` — pre-existing deploy snapshots; gitignored via `*.zip`.
- `alias-output.txt` — output of `audit_aliases.py` if redirected; gitignored.
- `src/aliases.js` — the REAL `PLAYER_ALIASES` / `PLAYER_ABBREVIATIONS` tables (real people's names). Personal; gitignored. Created from `src/aliases.stub.js` by `scripts/ensure_aliases.mjs` when absent; CI materializes it from the `PLAYER_ALIASES_JS` secret. See "Alias privacy (build-time injection)".
- `.dev-data-url` — single-line Google Sheets CSV URL used by `build.sh` (dev mode only) to print a preconfigured `?data=…` URL. Personal; gitignored.
- `last_deploy/` — build output; gitignored.
- `md/*.html` — pandoc previously wrote here; now writes directly to `last_deploy/`. The `md/*.html` glob is still gitignored as a safety net, with `!md/_pandoc_template.html` exception.
