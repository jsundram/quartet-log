# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Deploy Commands

**Development (watch mode with local server):**
```bash
./build.sh
```
Outputs to `./last_deploy/` with sourcemaps, serves content, and watches for changes.

**Production build:**
```bash
./build.sh --prod
```
Outputs minified bundle to `./last_deploy/`.

**Deploy to S3:**
```bash
./deploy.sh
```
Syncs `./last_deploy/` to S3 (must run production build first!).

**Dependencies:**
- esbuild 0.24.2
- pandoc 3.6.2

## Architecture Overview

This is a music session log visualization built with vanilla JavaScript and D3.js v7 (no React/Angular/Vue). Data is fetched directly from a Google Sheets CSV export.

### Component Architecture

The app follows a component-based pattern with vanilla JS classes:

**`App` (src/app.js)** - Main orchestrator
- Initializes all components
- Manages data flow and filtering
- Coordinates between components via callback pattern

**Data Layer:**
- `DataService` - Fetches CSV from Google Sheets, implements localStorage caching with 5s timeout fallback
- `dataProcessor` - Pure functions for transforming raw CSV rows, forward-filling player names, extracting unique players

**UI Components:**
- `NavigationComponent` - Radio buttons (part filter), date range sliders, player dropdown, hamburger menu
- `TabComponent` - Composer tabs (Haydn, Mozart, Beethoven, etc.)
- `TableComponent` - Sortable data table for each composer
- `CalendarComponent` - Calendar visualization

### Key Data Flow Patterns

**Initialization sequence:**
1. Load work catalog (`all_works.json`) first - required for data filtering
2. Fetch and cache CSV data from Google Sheets
3. Initialize UI components (navigation, tabs, calendar)
4. Call `filterData("date")` to populate player dropdown and filter initial view

**Filter change notifications:**
Navigation components explicitly notify what changed:
- Radio buttons → `onFilterChange("part")`
- Date sliders → `onFilterChange("date")`
- Player dropdown → `onFilterChange("player")`

**Player dropdown behavior:**
- Only refreshes when date/part filters change (not when player changes)
- Shows players with 20+ entries in the current filtered dataset
- Preserves currently selected player even if they fall below the 20-entry threshold (handled in `NavigationComponent.populatePlayerDropdown()`)

**Player name formatting:**
Players are suffixed with their instrument based on the part being played:
- When part = "V1": player1 → ".v2", player2 → ".va", player3 → ".vc"
- When part = "V2": player1 → ".v1", player2 → ".va", player3 → ".vc"
- When part = "VA": player1 → ".v1", player2 → ".v2", player3 → ".vc"

This ensures cellists named "Josh" are distinct from violists named "Josh" (e.g., "Josh.vc" vs "Josh.va").

### Configuration Files

**`src/config.js`** - Global constants:
- `DATA_URL` - Google Sheets CSV export URL
- `BEGIN` - Start date for all data (2016-07-01)
- `PART_COLORS` - Color coding for V1/V2/VA parts
- `PLAYER_ABBREVIATIONS` - Short name → full name mappings

**`src/catalog.js`** - Composer metadata:
- `ALL_WORKS` - Work catalog loaded from `all_works.json`
- `COMPOSERS` - Set of all composer names
- `generateQuartetRouletteUrl()` - Generates links to QuartetRoulette.com

### Browser Compatibility

Bundle targets: Chrome 92+, Firefox 90+, Safari 15.4+, Edge 92+ (Jul 2021+ for most browsers, Mar 2022 for Safari). This is driven by usage of `Array.at()` in `calendarComponent.js`.

