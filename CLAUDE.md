# CLAUDE.md

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

**Tests:**
```bash
npm test
```
Uses Node's built-in `node:test` runner against `test/*.mjs`. No external test deps. Tests cover `src/dataProcessor.js` helpers (alias normalization, partial-movement filtering, aggregate stats, etc.).

**Deploy:**
Push to `main` → GitHub Actions workflow (`.github/workflows/deploy.yml`) runs `npm test`, builds, deploys to GitHub Pages. Site lives at https://log.quartetroulette.com.

**Offline / service worker:** see `static/CLAUDE.md` (loads when you work under `static/`).

## Upstream: pwa-starter

This repo shares patterns with [pwa-starter](https://github.com/jsundram/pwa-starter) (local: `~/Dropbox/Code/pwa-starter`), which vendors files **by copy**, not by dependency. Provenance is tracked by a one-line stamp comment near the top of a copied file (`// pwa-starter: <file> @ <sha>`), audited by `python3 scripts/check-downstream.py ~/Dropbox/Code` run from that repo. There is no git remote, submodule, or shared history between the two.

- **Never add a `pwa-starter:` stamp to a file here.** `src/app.js`, `src/pullToRefresh.js`, and `static/sw.js` are *independent implementations*, not vendored copies — a file-level stamp would report them behind every upstream commit regardless of relevance. The checker listing them under "unstamped copies" is expected and correct; leave them there. This is recorded in pwa-starter's `PROPAGATE.md`.
- **`src/pullToRefresh.js` is the ancestor** — pwa-starter's version was written *from* it.
- **Flow is two-way.** This repo originated the cache-first paint and the empty-payload guard that later became upstream's `ddd9ab8`. When something here turns out to be general, **port it up to pwa-starter first** rather than leaving it downstream and relying on memory.
- Adopting an upstream fix is a **hand-port**, reviewed by eye — the layouts differ (its `sw.js` is at repo root, ours is `static/sw.js`).

## Architecture Overview

Vanilla JavaScript + D3.js v7 SPA. No framework. Each user configures their own published Google Sheet URL (stored in localStorage). The site fetches that CSV on each visit, with a localStorage cache fallback (5s timeout) so it works on flaky networks. Three hash-routed in-page views (`#main`, `#calendar`, `#dashboard`) plus the static `about.html`; hash routing lives in `NavigationComponent`, and `App.initializeUI` calls `applyInitialView()` so a landing `#<view>` hash is honored.

### Gotchas

- **Never cache an empty response.** Both network paths in `DataService` reject a valid-but-empty (0-row) result instead of caching it — persisting `[]` would poison the cache-first boot (`readCache()` would serve `[]` and `fillForward()` would throw on every subsequent launch). `fetchCSV` falls back to cache; `fetchFresh` throws so `revalidate()` keeps the painted UI.
- **Dashboard charts render at 1:1 pixel scale** (viewBox = measured pixel dims), deliberately, so mobile gets bigger fonts/bars instead of scaled-down ones. They re-render on window resize and on `notifyShown()` (fires when the view first becomes visible after init while hidden).
- **Cross-filter rule**: each dashboard chart applies every filter *except* its own dimension.
- **`DateFilterWidget` uses class-based selectors scoped to its mount point**, not IDs, so the Home and Dashboard instances can coexist.
- **`static/css/viz.css` is the canonical source for the V1/V2/VA part colors** (`--color-part-{v1|v2|va}`); `src/config.js` reads them through `getCssColor`, never hardcodes them.
- **Theme init is deliberately split**: a synchronous inline `<script>` in `index.html` / `md/_pandoc_template.html` sets `data-theme` before first paint to avoid FOUC, then `initTheme()` re-applies it and attaches the matchMedia watcher after the bundle loads.

### Initialization sequence

Boot is **cache-first** so a returning visitor (especially an installed PWA against the slow, cross-origin published Sheet) sees real data on first paint instead of an empty shell:

1. `loadWorkCatalog()` loads `all_works.json` + `haydn_peters.json` in parallel — required before any data processing/filtering.
2. `DataService.readCache()`: if last-known data is in localStorage, `renderInitial()` paints the whole UI from it immediately, `finishBoot()` wires pull-to-refresh + the keep-fresh loop, and `revalidate()` fetches the sheet in the background — re-rendering in place **only if `fetchFresh()` reports the data changed** (guards against a needless flash). If there's no cache (first-ever launch), it shows the loading indicator and awaits `fetchCSV()` instead.
3. `renderInitial()` → `processData()` (`fillForward` → `normalizePlayerNames` → filter incompletes) → `setBegin()` → `initializeUI()` mounts components (menu, part buttons, date filter, tabs, calendar, dashboard).
4. `filterData("date")` populates the Player dropdown and renders the initial view.
5. `NavigationComponent.applyInitialView()` honors any `#<view>` hash in the landing URL (e.g. `/index.html#dashboard`).

`revalidate()` is the single re-fetch path for background refreshes too (foreground-resume, the 5-min poll, and pull-to-refresh all call it). Its change-guard means an unchanged sheet updates only the status line; `_rerenderData()` (the in-place calendar/dashboard/tabs rebuild) runs only when the data actually moved, and it preserves the current view/tab/filters.

### Filter change notifications

`NavigationComponent` calls `onFilterChange(filterType)` with one of `"part"` / `"date"` / `"player"`. App's `filterData(filterType)` reads all three filters, computes `filteredData`, and pushes it to every composer tab plus the ALL tab.

The Player dropdown refreshes only on `"date"` / `"part"` changes (not `"player"`), shows players with ≥20 entries in the filtered dataset, and preserves the current selection even if it would drop below 20.

### Player name handling

**Canonical names**: `PLAYER_ALIASES` in `src/config.js` is **instrument-class-aware** because some short names refer to different people on different instruments (e.g. `Jen` on violin/viola is Jen Hsiao, on cello is Jen Minnich). Shape:
```js
{ "Jen": { upper: "Jen Hsiao", cello: "Jen Minnich" } }
```
Classes: `upper` (V1, V2, VA, VLA — violin/viola alias as one person) and `cello` (VC, never aliases with upper). Per-instrument aliasing happens at ingestion (`normalizePlayerNames`) so all downstream consumers see canonical names. `peopleKeysFor()` keys the unique-people set by canonical name (no class suffix), so a multi-instrumentalist like Henry Weinberger on both piano and cello correctly collapses to one person.

**Player slot conventions**: `player1`/`player2` are always "upper" class, `player3` is always "cello" — derived from the user's own part (V1/V2/VA). `stripParens` removes inline `(instrument)` annotations like `Lois Shapiro (piano)` from player slots before aliasing.

**Others? column**: free-form, parsed by `parseOthers`. Entries are separated by `;` or `,` **at paren depth 0** (paren-aware split, so commas inside an annotation don't tear an entry in half). Each entry is `Name`, `Name (instrument)`, or `Name (instrument, comment)`. Inside the parens, the **first** comma separates the instrument code from a free-form comment — later commas stay in the comment (e.g. `Isaac (v1, shadowing on II, III)` → instrument `v1`, comment ignored). The instrument string classifies via `classOf` (`vc*` → cello, else upper). The parsed list is attached as `othersList` on each row; the raw `others` string stays untouched for the CSV-download path.

**Audit script** (`scripts/audit_aliases.py`) reads an exported CSV (default `archive/data.csv`, gitignored) and surfaces candidate aliases by lowercased first-token grouping + teammate-overlap. Reads `PLAYER_ALIASES` live from `src/config.js` via a `node -e` subshell — single source of truth, no manual sync.

**Fetch scripts** (both read source URL from `.dev-data-url`, both gitignore their outputs):
- `scripts/fetch_processed.mjs` — fetches the sheet, runs the same `fillForward` + `normalizePlayerNames` + drop-incompletes pipeline as the in-browser "Download Data" button, writes `archive/data.csv` in the matching CSV format. This is the file `audit_aliases.py` defaults to.
- `scripts/fetch_raw.sh` — `curl`s the raw published CSV verbatim to `archive/data-raw.csv` (no JS processing, partial-movements included, names un-normalized).

### Calendar specifics

Per-year stats column shows five numbers (Pieces, Unique Pieces, People played with, Playing Days, Longest Streak) at `cellSize*2` through `cellSize*6`, with tooltips wired via `attachStatTooltip` (works on hover and tap). The stat values + tooltip copy live in `_yearStatDefs`, shared by both layouts (horizontal right-hand column and fullscreen below-grid rows) so they can't drift. The legend SVG is sized to exactly `10 * cellSize` wide and uses CSS `width: min(170px, 17%)` + `margin-left: min(40.5px, 4.05%)` so it tracks the calendar grid's first 10 cells across all viewport widths.

**Fullscreen (vertical) mode**: an expand button (network-graph style: `.network-fullscreen-btn` for looks + `.calendar-fullscreen-btn` for placement) toggles a lightbox where the grid renders transposed (`renderYearGroupsVertical`) — weeks run down, days across — with the cell size fitted so a whole year fills the viewport height (54 week rows: a leap year starting Saturday spans 54 Sunday-weeks). Year columns run chronologically left→right and the container opens scrolled to its right edge, so the current year is in view and panning left walks back in time. Legend + recent stats are omitted to give the grid every pixel. Entering also calls `requestFullscreen()` on `<html>` — NOT on `#calendar`, because browsers render only the fullscreen element's subtree and the tooltip div is a `<body>` child — with every failure path silently falling back to the fixed `100dvh` overlay CSS (older iOS, installed PWAs). Esc or the collapse button exits both native fullscreen and the lightbox; a gesture-exit from *native* fullscreen deliberately leaves the lightbox open (auto-closing on `fullscreenchange` closed everything whenever a browser bounced the request). A window `resize` listener re-fits the grid on rotation / chrome show-hide.

**Re-render contract**: calendar rebuilds (`rerender()`, App's `_rerenderData`) remove only `.calendar-gen`-tagged nodes from `#calendar`, so the static `<h1>` in index.html survives. Anything `createCalendar` appends must carry the `calendar-gen` class.

**Tooltips**: the shared `.tooltip` CSS clamps to the viewport (`max-width`/`max-height` + scroll; sticky close button so it can't scroll away), and `positionTooltip` computes in client coordinates before converting to page coordinates, so day tooltips stay fully on-screen on phones and inside the fullscreen overlay.

### Theme system contract

When adding a new component that bakes color values at render time (e.g. d3 `.attr('fill', getCssColor('--…'))`), it MUST re-render on theme change. The pattern is:

1. Expose a method that rebuilds the component's DOM with fresh color reads — `rerender()` on `CalendarComponent` is the reference.
2. App's `onThemeChange()` calls `invalidateColorCache()` FIRST (so the next `getCssColor` reads the new resolved value), then invokes each component's rerender.
3. Components driven purely by CSS variables — i.e. no JS reads of color values, all `var(--…)` in stylesheets — update for free via the cascade and need no JS plumbing.

The dashboard and the per-tab work-square renders already pick up new colors because they re-render on every filter change; `onThemeChange()` calls them directly (dashboard) or via `filterData("date")` (tabs). The calendar is the special case because it bakes the d3 interpolator + canvas legend ramp at construction.

### Browser compatibility

Bundle targets live in `build.sh` (`--target=`). They're driven by `Array.at()` usage, plus CSS `min()` and `:has()`, which need Safari 15.4+.

## Markdown pages (pandoc)

See `md/CLAUDE.md` (loads when you work under `md/`).

## Conventions and preferences

- **Python**: use `uv run --with <pkg> python ...` for one-off scripts/tools. Don't try `pip install`. The user keeps Python environments isolated via `uv`.
- **Don't destructively overwrite user-supplied assets**: when transforming images/data/etc. the user shared, write the result to a NEW path (e.g. `*-redacted.png`) so the source can be re-used for iteration. Only overwrite the source when the user explicitly asks for in-place editing.
- **Verify before claiming done**: for behaviour changes, run `npm test` and (where applicable) sanity-check via `node --check <file>` and/or rebuild and inspect. For markdown changes, run pandoc and grep the output to confirm.
- **Commit scope**: prefer focused commits with clear messages over kitchen-sink commits. Recent history has examples like "add player-name normalization and unique-people yearly stat" — feature-scoped, present-tense imperative.

## Gitignored / untracked things to know

- `archive/data.csv` — full CSV used by the audit script. Refresh via `scripts/fetch_processed.mjs` (mirrors the in-browser "Download Data" output). Personal data; gitignored.
- `archive/data-raw.csv` — raw unprocessed sheet, refreshed via `scripts/fetch_raw.sh`. Personal data; gitignored.
- `archive/*.zip` — pre-existing deploy snapshots; gitignored via `*.zip`.
- `alias-output.txt` — output of `audit_aliases.py` if redirected; gitignored.
- `.dev-data-url` — single-line Google Sheets CSV URL used by `build.sh` (dev mode only) to print a preconfigured `?data=…` URL. Personal; gitignored.
- `last_deploy/` — build output; gitignored.
- `md/*.html` — pandoc previously wrote here; now writes directly to `last_deploy/`. The `md/*.html` glob is still gitignored as a safety net, with `!md/_pandoc_template.html` exception.
