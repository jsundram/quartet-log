# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working with this repository.

## Build, Test, Deploy

**Development** (watch mode + local server + on-save test reruns):
```bash
./build.sh                # port 8000 by default
./build.sh --port 8001    # override port
```
Outputs to `./last_deploy/` with sourcemaps. Uses `fswatch` (`brew install fswatch`) to re-copy static assets when `index.html` / `CNAME` / `static/` / `md/` change, and to re-run tests on `src/` / `test/` changes (compact dot-reporter output).

**Production build:**
```bash
./build.sh --prod
```
Runs `npm test` first; aborts on failure. Outputs minified bundle to `./last_deploy/`.

**Tests:**
```bash
npm test
```
Uses Node's built-in `node:test` runner against `test/*.mjs`. No external test deps. Tests cover `src/dataProcessor.js` helpers (alias normalization, partial-movement filtering, aggregate stats, etc.).

**Deploy:**
Push to `main` → GitHub Actions workflow (`.github/workflows/deploy.yml`) runs `npm test`, builds, deploys to GitHub Pages. Site lives at https://log.quartetroulette.com.

**Dependencies (system):**
- Node 20+ (for `node:test`)
- esbuild 0.24.2
- pandoc 3.6.2 (with `gfm+attributes+implicit_figures` extensions)
- fswatch (optional, for dev mode)

## Architecture Overview

Vanilla JavaScript + D3.js v7 SPA. No framework. Each user configures their own published Google Sheet URL (stored in localStorage). The site fetches that CSV on each visit, with a localStorage cache fallback (5s timeout) so it works on flaky networks.

### Views (hash-routed)

The SPA has three in-page views and one external page, all reachable from the hamburger menu:

- **`#main`** (Home) — composer tabs, filterable lists, sortable per-composer data tables, ALL tab with aggregate stats + flat table.
- **`#calendar`** — GitHub-contributions-style year grid; per-year stats column; "Last 365 days" header; per-day tooltips.
- **`#dashboard`** — cross-filter charts: stacked part bar (V1/V2/VA) + horizontal top-composers bar chart. Clicking one filters the other.
- **`about.html`** — static markdown page (linked from menu; renders as a separate page).

Hash routing lives in `NavigationComponent`: menu clicks set `window.location.hash`, a `hashchange` listener calls `applyView()`. The initial hash on page load is honored via `applyInitialView()` called from `App.initializeUI`.

### Component map

**Orchestration:**
- `App` (`src/app.js`) — owns data, instantiates and wires components, runs `filterData()`.

**Data layer:**
- `DataService` (`src/dataService.js`) — CSV fetch + localStorage cache. Calls `fillForward` then `normalizePlayerNames`, then filters out partial-movement entries (titles containing `:`).
- `dataProcessor` (`src/dataProcessor.js`) — pure functions only. Highlights:
  - `parseWork`, `processRow`, `fillForward`, `createEmptyRow`
  - `normalizePlayerNames` (applies `PLAYER_ALIASES` per slot class)
  - `peopleKeysFor(d)` — canonical-name keys for unique-people counting
  - `computeAggregateStats(rows)` — `{ pieces, uniquePieces, uniquePeople, daysPlayed }`; used by both Calendar's "Last 365 days" and the ALL tab
  - `normalizeDashboardPart(part)` — folds `VA1`/`VA2`/`VA…` → `VA` for the Dashboard pie/bar
  - `parseOthers`, `stripParens`, `classOf`, `canonicalize` (helpers)
  - `extractUniquePlayers` — for the Player dropdown
- `tableComponent` (`src/tableComponent.js`) — sortable HTML data tables. `getColumnsForComposer` includes the composer column for `MISC` and `ALL` only.

**UI:**
- `NavigationComponent` (`src/navigationComponent.js`) — hamburger menu (native dismiss: outside-click + Escape), segmented Part buttons (V1/V2/VA/ANY), Player multiselect dropdown, view switching + hash routing. Delegates the date range to `DateFilterWidget`.
- `DateFilterWidget` (`src/dateFilterWidget.js`) — reusable segmented date range picker (`All` / `YTD` / `1Y` / `6M` / `Custom`). Class-based selectors scoped to mount point so multiple instances can coexist; Home and Dashboard each have their own.
- `TabComponent` (`src/tabComponent.js`) — per-composer tab content + ALL tab. `updateTabContent` early-returns to `updateAllTabContent` for the special ALL tab. Random-button suggestion respects current filters (uses `filteredPlays`).
- `CalendarComponent` (`src/calendarComponent.js`) — calendar grid, legend, per-year stats column, "Last 365 days" header (uses `renderRecentStats` → `computeAggregateStats`). Legend SVG and grid are width-coupled via CSS.
- `DashboardComponent` (`src/dashboardComponent.js`) — owns `{ selectedPart, selectedComposer }` plus its own `DateFilterWidget`. Re-renders both charts on any mutation (cheap at this data size). Cross-filter rule: each chart applies every filter except its own dimension. Charts measure live container width and render at 1:1 pixel scale (viewBox = pixel dims) so mobile gets bigger fonts/bars instead of scaled-down ones; re-renders on window resize and on `notifyShown()` (fires when the view first becomes visible after init while hidden).

### Initialization sequence

1. `loadWorkCatalog()` loads `all_works.json` + `haydn_peters.json` in parallel — required before any data filtering.
2. `DataService.fetchCSV()` → `processData()` runs `fillForward` → `normalizePlayerNames` → filter incompletes.
3. UI components mount (menu, part buttons, date filter, tabs, calendar, dashboard).
4. `filterData("date")` populates the Player dropdown and renders the initial view.
5. `NavigationComponent.applyInitialView()` honors any `#<view>` hash in the landing URL (e.g. `/index.html#dashboard`).

### Filter change notifications

`NavigationComponent` calls `onFilterChange(filterType)` with one of:
- `"part"` — part buttons changed
- `"date"` — date range changed
- `"player"` — player selection changed

App's `filterData(filterType)` reads all three filters, computes `filteredData`, and pushes it to every composer tab (plus the ALL tab):
```js
[...COMPOSERS, ALL_TAB].forEach(c => tabComponent.updateTabContent(c, part, filteredData, this.data));
```

The Player dropdown refreshes only on `"date"` / `"part"` changes (not `"player"`), shows players with ≥20 entries in the filtered dataset, and preserves the current selection even if it would drop below 20.

### Player name handling

**Canonical names**: `PLAYER_ALIASES` in `src/config.js` is **instrument-class-aware** because some short names refer to different people on different instruments (e.g. `Jen` on violin/viola is Jen Hsiao, on cello is Jen Minnich). Shape:
```js
{ "Jen": { upper: "Jen Hsiao", cello: "Jen Minnich" } }
```
Classes: `upper` (V1, V2, VA, VLA — violin/viola alias as one person) and `cello` (VC, never aliases with upper). Per-instrument aliasing happens at ingestion (`normalizePlayerNames`) so all downstream consumers see canonical names. `peopleKeysFor()` keys the unique-people set by canonical name (no class suffix), so a multi-instrumentalist like Henry Weinberger on both piano and cello correctly collapses to one person.

**Player slot conventions**: `player1`/`player2` are always "upper" class, `player3` is always "cello" — derived from the user's own part (V1/V2/VA). `stripParens` removes inline `(instrument)` annotations like `Lois Shapiro (piano)` from player slots before aliasing.

**Others? column**: free-form, parsed by `parseOthers` (splits on `;` or `,`, extracts `Name (instrument)`). The instrument string classifies via `classOf` (`vc*` → cello, else upper). The parsed list is attached as `othersList` on each row; the raw `others` string stays untouched for the CSV-download path.

**Audit script** (`scripts/audit_aliases.py`) reads an exported CSV (default `archive/data.csv`, gitignored) and surfaces candidate aliases by lowercased first-token grouping + teammate-overlap. Reads `PLAYER_ALIASES` live from `src/config.js` via a `node -e` subshell — single source of truth, no manual sync.

### Calendar specifics

Per-year stats column shows four numbers (Pieces, Unique Pieces, People played with, Playing Days) at `cellSize*2` through `cellSize*5`, with tooltips wired via `attachStatTooltip` (works on hover and tap). The legend SVG is sized to exactly `10 * cellSize` wide and uses CSS `width: min(170px, 17%)` + `margin-left: min(40.5px, 4.05%)` so it tracks the calendar grid's first 10 cells across all viewport widths.

### Configuration files

- **`src/urlConfig.js`** — `getDataUrl` / `setDataUrl` / `hasDataUrl` / `isValidGoogleSheetsUrl` / `clearDataUrl`. URL persists in localStorage.
- **`src/config.js`** — `getBegin` / `setBegin`, `getCssColor(token)` / `getPartColor(part)` (read colors from CSS custom properties on `:root`; the canonical source for V1/V2/VA part colors lives in `static/css/viz.css` as `--color-part-{v1|v2|va}`), `PLAYER_ABBREVIATIONS` (single-letter expansion: I→Isaac, E→Elaine, S→Shay, J→Josh), `PLAYER_ALIASES` (instrument-class-keyed), `CALENDAR_CONFIG`.
- **`src/catalog.js`** — `ALL_WORKS` and `HAYDN_PETERS` (loaded in parallel from `all_works.json` and `haydn_peters.json`), `COMPOSERS` set, `ALL_TAB` / `isAllTab` / `isMiscTab` helpers, `getPetersVolume(work)` for Haydn tooltip suffix, `generateQuartetRouletteUrl(d)` per-composer URL builder.

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

- `archive/data.csv` — locally-exported full CSV used by the audit script. Personal data; gitignored.
- `archive/*.zip` — pre-existing deploy snapshots; gitignored via `*.zip`.
- `alias-output.txt` — output of `audit_aliases.py` if redirected; gitignored.
- `last_deploy/` — build output; gitignored.
- `md/*.html` — pandoc previously wrote here; now writes directly to `last_deploy/`. The `md/*.html` glob is still gitignored as a safety net, with `!md/_pandoc_template.html` exception.
