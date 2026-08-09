import * as d3 from "d3";
import { COMPOSERS, ALL_TAB, DEFAULT_COMPOSER, loadWorkCatalog } from './catalog.js';
import { setBegin, invalidateColorCache } from './config.js';
import { DataService } from './dataService.js';
import { extractUniquePlayers, checkPlayersMatch } from './dataProcessor.js';
import { serializeRows } from './csvFormat.js';
import { NavigationComponent } from './navigationComponent.js';
import { TabComponent } from './tabComponent.js';
import { CalendarComponent } from './calendarComponent.js';
import { DashboardComponent } from './dashboardComponent.js';
import { TableComponent } from './tableComponent.js';
import { hasDataUrl, setDataUrl, getDataUrl, isValidGoogleSheetsUrl, consumeDataParam, buildMobileSetupLink } from './urlConfig.js';
import { initTheme, subscribe as subscribeTheme } from './themeManager.js';
import { PullToRefresh } from './pullToRefresh.js';
import { escapeHtml } from './escapeHtml.js';

// Background-style auto refresh: while the app is visible we re-fetch the
// sheet every FOREGROUND_POLL_MS, and we also re-fetch on visibilitychange
// when the app comes back to the foreground if the cached data is older than
// STALE_AFTER_MS. iOS standalone PWAs can't use Background Sync (unsupported)
// so this is the best "data stays fresh on its own" we can do.
const STALE_AFTER_MS = 5 * 60 * 1000;
const FOREGROUND_POLL_MS = 5 * 60 * 1000;

// Prefix of the service-worker cache name (sw.js: `const V = "ql-<hash>-<hash>"`,
// and it opens caches.open(V)). The installed shell version is therefore just the
// ql- cache key; App._checkVersion compares it to the version in the live sw.js.
const VER_PREFIX = 'ql-';

export class App {
    constructor() {
        this.dataService = new DataService();
        this.navigationComponent = new NavigationComponent(
            (filterType) => this.filterData(filterType),
            () => this.downloadCSV(),
            (view) => this.handleViewChange(view),
        );
        this.navigationComponent.onCopyConfig = () => this.handleCopyConfigLink();
        this.tableComponent = new TableComponent();
        this.tabComponent = new TabComponent(this.tableComponent);
        this.calendarComponent = new CalendarComponent();
        this.dashboardComponent = new DashboardComponent();
        this.pullToRefresh = new PullToRefresh({ onRefresh: () => this.revalidate() });
        this.data = null;
        this._lastFetchAt = 0;
        this._booted = false;
        this._uiReady = false;  // set once initializeUI has run against non-empty data
    }

    start() {
        // Initialize theme before any rendering so subscribers + initial
        // CSS reads see the resolved theme. The head-script in index.html
        // already applied the data-theme attribute pre-paint to avoid FOUC;
        // initTheme re-applies it (defense in depth) and starts watching
        // the OS prefers-color-scheme for auto-mode users.
        initTheme();
        subscribeTheme(() => this.onThemeChange());

        // If the page URL has ?data=<encoded Google Sheets URL>, persist it
        // and skip the setup view. Used for one-time setup of a second
        // device (e.g. desktop generates the link → AirDrop/iMessage to
        // phone → opening it on the phone lands here).
        consumeDataParam();

        if (hasDataUrl()) {
            this.initialize();
        } else {
            this.showSetupView();
        }
    }

    // Triggered when the user cycles the theme via the hamburger menu, or
    // when the OS theme flips while we're in 'auto' mode. Rebuild every
    // component that bakes colors at render time. Components driven purely
    // by CSS variables (most of the page) update for free via the cascade.
    onThemeChange() {
        invalidateColorCache();
        if (this.data) {
            this.calendarComponent.rerender();
            this.dashboardComponent.render();
            this.filterData("date"); // refreshes tab content (play-square colors etc.)
        }
    }

    showSetupView(prefillUrl = '') {
        // Hide main content areas
        d3.select('#mainContent').style('display', 'none');
        d3.select('#calendar').style('display', 'none');
        d3.select('#dashboard').style('display', 'none');
        d3.select('#menu').style('display', 'none');
        d3.select('#update').style('display', 'none');

        // Show setup view
        const setupView = d3.select('#setupView');
        setupView.style('display', 'flex');

        // Pre-fill URL if provided
        const input = setupView.select('#dataUrlInput');
        if (prefillUrl) {
            input.property('value', prefillUrl);
        }

        // Clear any previous error
        setupView.select('#setupError').text('').style('display', 'none');

        // Set up form submission
        setupView.select('#setupForm').on('submit', (event) => {
            event.preventDefault();
            this.handleUrlSubmit();
        });

        // "Copy mobile setup link" — generates a pre-configured URL from
        // whatever's in the data URL input and copies it to the clipboard.
        // The user then sends that link to their other device (AirDrop,
        // iMessage, email, etc.) so they don't have to retype the URL.
        setupView.select('#copyMobileLink').on('click', (event) => {
            event.preventDefault();
            this.handleCopyMobileLink();
        });
    }

    handleCopyMobileLink() {
        const input = d3.select('#dataUrlInput');
        const url = input.property('value').trim();
        const errorEl = d3.select('#setupError');

        if (!url) {
            errorEl.html('Enter your CSV URL first, then click Copy. <a href="setup.html">How do I get this URL?</a>')
                .style('display', 'block');
            return;
        }
        if (!isValidGoogleSheetsUrl(url)) {
            errorEl.text('Invalid URL. Please enter a valid Google Sheets CSV export URL (must contain "output=csv") before copying.')
                .style('display', 'block');
            return;
        }

        const mobileLink = buildMobileSetupLink(url);
        navigator.clipboard.writeText(mobileLink).then(
            () => {
                // Flash "Copied!" on the button for ~1.5s.
                const btn = d3.select('#copyMobileLink');
                const original = btn.text().trim();
                btn.text('Copied!');
                setTimeout(() => btn.text(original), 1500);
                errorEl.text('').style('display', 'none');
            },
            (err) => {
                errorEl.text('Could not copy to clipboard: ' + (err.message || err))
                    .style('display', 'block');
            },
        );
    }

    // Menu "Copy setup link": same as the setup-screen button, but the URL
    // comes from localStorage (the user is already logged in) instead of the
    // input field. Flashes feedback on the menu item's label span (flashing
    // the whole <a> would clobber its icon).
    handleCopyConfigLink() {
        const label = d3.select('.menu-item[data-view="copy-config"] span');
        const url = getDataUrl();
        if (!url) {
            this._flashLabel(label, 'No URL set');
            return;
        }
        const link = buildMobileSetupLink(url);
        navigator.clipboard.writeText(link).then(
            () => this._flashLabel(label, 'Copied!'),
            () => this._flashLabel(label, 'Copy failed'),
        );
    }

    // Briefly swap a selection's text, then restore it. Re-entrancy-safe:
    // rapid re-clicks keep the true original (not the flashed text) and reset
    // the timer, so the label never gets stuck on "Copied!".
    _flashLabel(sel, msg) {
        if (sel.empty()) return;
        const node = sel.node();
        if (node._flashOriginal === undefined) node._flashOriginal = sel.text();
        clearTimeout(node._flashTimer);
        sel.text(msg);
        node._flashTimer = setTimeout(() => {
            sel.text(node._flashOriginal);
            node._flashOriginal = undefined;
            node._flashTimer = undefined;
        }, 1500);
    }

    handleUrlSubmit() {
        const input = d3.select('#dataUrlInput');
        const url = input.property('value').trim();
        const errorEl = d3.select('#setupError');

        // Validate URL
        if (!url) {
            errorEl.text('Please enter a URL').style('display', 'block');
            return;
        }

        if (!isValidGoogleSheetsUrl(url)) {
            errorEl.text('Invalid URL. Please enter a Google Sheets CSV export URL (must contain "output=csv")').style('display', 'block');
            return;
        }

        // Save URL and proceed
        setDataUrl(url);
        this.hideSetupView();
        this.initialize();
    }

    hideSetupView() {
        d3.select('#setupView').style('display', 'none');
        d3.select('#mainContent').style('display', 'block');
        d3.select('#menu').style('display', 'block');
        d3.select('#update').style('display', 'block');
    }

    // Build state + the full UI for the first time from a fetched-or-cached
    // result. Everything downstream (calendar, dashboard, tabs) is populated
    // synchronously here so the first paint shows real data, not an empty shell.
    renderInitial(result) {
        this.data = this.dataService.processData(result.parsed);
        this._lastFetchAt = result.timestamp;
        // Every row can get filtered out (all partial movements and/or invalid
        // timestamps): don't build the UI off data[0] / data.at(-1) — say so.
        if (!this.data.length) {
            this.showNoDataState();
            return;
        }
        setBegin(this.data[0].timestamp);  // BEGIN = earliest data point
        this._uiReady = true;
        this.initializeUI();
    }

    // One-time wiring that must run after the first render: pull-to-refresh and
    // the foreground/version keep-fresh loop. Guarded so the cache-first path
    // (which paints, then revalidates) doesn't double-wire when fresh data
    // later lands.
    finishBoot() {
        if (this._booted) return;
        this._booted = true;
        this.pullToRefresh.init();
        this._setupAutoRefresh();
    }

    handleViewChange(view) {
        // The dashboard SVGs size themselves from the live container width,
        // so they need a re-render once the view is actually visible.
        if (view === 'dashboard') this.dashboardComponent.notifyShown();
    }

    async initializeUI() {
        // Initialize navigation components
        this.navigationComponent.createMenu();
        this.navigationComponent.createRadioButtons();
        this.navigationComponent.createDateFilter();

        // Initialize tabs
        this.tabComponent.createTabs();
        this.tabComponent.showTab(DEFAULT_COMPOSER);

        // Initialize calendar view
        this.calendarComponent.createCalendar(this.data);

        // Initialize dashboard view (owns its own date-range state)
        this.dashboardComponent.init(this.data);

        // Initial data filter
        this.filterData("date");  // need players to update

        // Honor any hash in the landing URL (e.g. /index.html#dashboard).
        this.navigationComponent.applyInitialView();
    }

    async initialize() {
        try {
            // The work catalog must load before any data can be processed.
            // Offline this resolves instantly from the SW precache; online it's
            // a quick same-origin fetch.
            await loadWorkCatalog();

            // Cache-first boot: if last-known data is sitting in localStorage,
            // paint the full UI from it *immediately* rather than blocking the
            // first render on a network round-trip to the (cross-origin, often
            // slow) published Google Sheet. We then revalidate in the
            // background and re-render in place only if the sheet actually
            // changed — see revalidate(). This is the whole fix for "nothing
            // shows until server data arrives".
            const cached = this.dataService.readCache();
            if (cached) {
                this.renderInitial(cached);
                this.updateDataStatus(cached.timestamp, cached.source);
                this.finishBoot();
                this.revalidate();  // background; may re-render if data moved
            } else {
                // First-ever launch (or cleared storage): nothing to paint yet,
                // so show the loading indicator and wait on the network, as
                // before. fetchCSV still races a 5s timeout, but with no cache
                // to fall back to it simply surfaces an error if the net fails.
                this.showLoadingState();
                const result = await this.dataService.fetchCSV();
                this.renderInitial(result);
                this.updateDataStatus(result.timestamp, result.source, result);
                this.finishBoot();
            }
        } catch (error) {
            console.error('Error initializing application:', error);
            this.handleError(error);
        }
    }

    // Re-fetch the sheet and, only if the raw data actually changed, re-render
    // every data-dependent view in place (calendar, dashboard, tabs) without
    // reloading the page. The change guard is what makes this safe to run right
    // after a cache-first boot and on every foreground resume / poll /
    // pull-to-refresh: an unchanged sheet (the common case) updates only the
    // status line, never flashing the UI. A network failure leaves whatever's
    // on screen untouched — no fallback to re-rendering the same stale copy.
    async revalidate() {
        let result;
        try {
            result = await this.dataService.fetchFresh();
        } catch (e) {
            console.error('Revalidate failed', e);
            // Surface the failure instead of leaving the status line claiming
            // the data was "updated N minutes ago": show an offline/stale
            // indicator anchored to the last successful fetch.
            this.updateDataStatus(this._lastFetchAt, 'cache', { offline: true });
            return;
        }
        this._lastFetchAt = result.timestamp;
        if (result.changed) {
            if (!this._uiReady) {
                // The previous load yielded zero usable rows, so no UI is
                // mounted — this needs the full initial render, not the
                // in-place rerender.
                this.renderInitial(result);
            } else {
                this.data = this.dataService.processData(result.parsed);
                        this._rerenderData();
            }
        }
        this.updateDataStatus(result.timestamp, result.source, result);
    }

    // In-place re-render of every data-dependent view from the current
    // this.data. Preserves the active view, tab, and filters (it doesn't touch
    // the hash or re-run showTab), so a background data update slots in without
    // yanking the user around.
    _rerenderData() {
        // A refresh can turn a previously non-empty dataset empty (e.g. the
        // sheet now holds only partial movements). Keep the painted UI and
        // flag the situation rather than throwing on data[0].
        if (!this.data.length) {
            this.showNoDataState();
            return;
        }
        setBegin(this.data[0].timestamp);
        // Only remove component-generated nodes — the static <h1> and
        // in index.html stays (matches CalendarComponent.rerender).
        d3.select('#calendar').selectAll(':scope > .calendar-gen').remove();
        this.calendarComponent.createCalendar(this.data);
        this.dashboardComponent.setData(this.data);
        this.filterData('date');
    }

    // Re-fetch only if the page is currently visible and the cached data
    // exceeds the staleness threshold. Used by both the visibilitychange
    // listener and the foreground poll so neither fires when the tab is
    // hidden (timers are paused in background tabs anyway, but the gate
    // keeps the logic explicit) or when the data is already fresh.
    async _maybeRefresh() {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - this._lastFetchAt < STALE_AFTER_MS) return;
        try {
            await this.revalidate();
        } catch (e) {
            console.error('Auto-refresh failed', e);
        }
    }

    _setupAutoRefresh() {
        this.navigationComponent.onForceUpdate = () => this.forceUpdate();
        this._checkVersion();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this._maybeRefresh();
                this._checkVersion();
            }
        });
        setInterval(() => this._maybeRefresh(), FOREGROUND_POLL_MS);
    }

    // Compare the installed service-worker shell against the one on the server
    // and surface a tappable "update available" row in the menu when they differ.
    // The cache name IS the version, so the installed version is just the ql-
    // cache key; the latest is read from the live sw.js (cache-busted + no-store,
    // and sw.js excludes itself from the SW cache) so even a stale shell can tell
    // it's behind. Runs on boot and on every foreground resume — the moment iOS
    // wakes a pinned app is exactly when we want to check.
    async _checkVersion() {
        const tag = document.getElementById('ver');
        if (!tag) return;

        let installed = '';
        try {
            installed = (await caches.keys()).find(k => k.startsWith(VER_PREFIX)) || '';
        } catch { /* caches unavailable */ }

        // No SW cache yet (dev, or first load before install): keep the row hidden.
        if (!installed) { tag.hidden = true; return; }

        let latest = '';
        try {
            const src = await (await fetch('./sw.js?_=' + Date.now(), { cache: 'no-store' })).text();
            latest = (src.match(/const V = "([^"]+)"/) || [])[1] || '';
        } catch { /* offline: leave latest empty → never a false "behind" */ }

        const behind = Boolean(latest) && latest !== installed;
        const label = tag.querySelector('[data-ver-label]');
        tag.hidden = false;
        tag.classList.toggle('menu-item--update', behind);
        if (label) label.textContent = behind ? 'Update available' : 'Up to date';
        tag.title = behind
            ? `New version available (${latest}) — tap to update`
            : `Up to date (${installed}) — tap to force refresh`;
    }

    // The hammer for a wedged home-screen app: drop every cache and reload so the
    // service worker reinstalls the current shell from the network. Wired to the
    // menu's version row; safe to tap even when already current (just a hard
    // refresh that repopulates from the network).
    async forceUpdate() {
        try {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
        } catch { /* nothing to clear */ }
        window.location.reload();
    }

    showLoadingState() {
        d3.select('#update')
            .text('Loading data...')
            .style("margin-left", "10px")
            .style("color", "var(--color-text-tertiary)");
    }

    // Shown when the sheet loaded but zero rows survived processing (all
    // partial movements / unparseable timestamps). Leaves whatever UI exists
    // in place; just surfaces the state on the status line.
    showNoDataState() {
        d3.select('#update')
            .text('No usable data found in the sheet (every row was filtered out).')
            .style("margin-left", "10px")
            .style("color", "var(--color-text-error)");
    }

    // `flags` may be the DataService result object itself — only the named
    // properties are read. `cacheWriteFailed` means the fresh data on screen
    // could not be persisted (localStorage quota): the NEXT launch will boot
    // from an older cache, so say so instead of silently styling it as fresh.
    // `offline` means a background refresh failed: what's on screen is the
    // last successful fetch, which may be behind the sheet.
    //
    // Only those two failure states get the error color. Serving from cache is
    // NORMAL operation (cache-first boot paints from it on every launch), so
    // it renders in the regular status color, not styled as an error.
    updateDataStatus(timestamp, source, { cacheWriteFailed = false, offline = false } = {}) {
        // Empty dataset: showNoDataState already owns the status line, and
        // data.at(-1) below would throw.
        if (!this.data?.length) return;
        const lastSession = this.dataService.formatTimeSince(
            this.data[this.data.length-1].timestamp
        );

        let updateText;
        if (offline) {
            updateText = `Offline? Couldn't refresh — showing data from ${this.dataService.formatTimeSince(timestamp)}`;
        } else if (source === 'cache') {
            updateText = `Data Loaded from cache. Age: ${this.dataService.formatTimeSince(timestamp).replace("ago", "old")}`;
        } else {
            updateText = `Data updated ${this.dataService.formatTimeSince(timestamp)}`;
        }
        if (cacheWriteFailed) {
            updateText += ' (storage full — offline copy may be stale)';
        }

        const warn = cacheWriteFailed || offline;
        d3.select('#update')
            .text(`${updateText}; last session ${lastSession}`)
            .style("margin-left", "10px")
            .style("color", warn ? "var(--color-text-error)" : "var(--color-text-tertiary)");
    }

    filterData(filterType) {
        const dates = this.navigationComponent.getSelectedDates();
        const start = dates[0];
        const end = dates[1];
        const part = this.navigationComponent.getSelectedPart();
        const selectedPlayers = this.navigationComponent.getSelectedPlayers();

        // First filter by date and part only
        const datePartFiltered = this.data.filter(d => {
            const partMatch = ["ANY", d.part].includes(part);
            const dateMatch = start <= d.timestamp && d.timestamp <= end;
            return partMatch && dateMatch;
        });

        // Only update player dropdown if date or part changed, not player
        if (filterType === "date" || filterType === "part") {
            const players = extractUniquePlayers(datePartFiltered);
            this.navigationComponent.populatePlayerDropdown(players);
        }

        // Now apply player filter
        const filteredData = datePartFiltered.filter(d => checkPlayersMatch(d, selectedPlayers));

        // Update all composer tabs (plus the special ALL tab) with filtered data
        [...COMPOSERS, ALL_TAB].forEach(composer => {
            this.tabComponent.updateTabContent(composer, part, filteredData, this.data);
        });
    }

    downloadCSV() {
        if (!this.data) {
            console.error('No data available to download');
            return;
        }

        // Headers, field order, timestamp format, and escaping all come from
        // the shared csvFormat module (also used by scripts/fetch_processed.mjs)
        // so the written header is the reader's "Others?" and the two writers
        // can't drift apart.
        const csvContent = serializeRows(this.data);

        // Create blob and trigger download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);

        link.setAttribute('href', url);
        link.setAttribute('download', `music-log-${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    handleError(error) {
        // Check if this is a URL-related error
        const isUrlError = error.message.includes('No data URL configured') ||
            error.message.includes('No cached data available') ||
            error.message.includes('Failed to fetch');

        if (isUrlError) {
            // Show setup view to let user reconfigure
            d3.select('#update')
                .html(`Error loading data: ${escapeHtml(error.message)}. <a href="#" id="reconfigureLink">Re-enter data URL</a>`)
                .style("margin-left", "10px")
                .style("color", "var(--color-text-error)");

            d3.select('#reconfigureLink').on('click', (event) => {
                event.preventDefault();
                this.showSetupView(getDataUrl() || '');
            });
        } else {
            d3.select('#update')
                .text(`Error loading data: ${error.message}`)
                .style("margin-left", "10px")
                .style("color", "var(--color-text-error)");
        }
    }
}

// Register the service worker for the offline app shell. Prod-only by design:
// dev builds don't emit sw.js and esbuild's live-reload server shouldn't be
// intercepted, so we skip localhost. Registered off the deploy root so its
// scope covers the whole app; failures (e.g. a dev build with no sw.js) are
// swallowed so they never block boot.
if ('serviceWorker' in navigator &&
    location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
}

// Initialize the application
const app = new App();
document.addEventListener('DOMContentLoaded', () => app.start());
