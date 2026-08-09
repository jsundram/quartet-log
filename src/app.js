import * as d3 from "d3";
import { COMPOSERS, ALL_TAB, DEFAULT_COMPOSER, loadWorkCatalog } from './catalog.js';
import { setBegin, invalidateColorCache } from './config.js';
import { DataService } from './dataService.js';
import { extractUniquePlayers } from './dataProcessor.js';
import { filterRows } from './filterEngine.js';
import { NavigationComponent } from './navigationComponent.js';
import { TabComponent } from './tabComponent.js';
import { CalendarComponent } from './calendarComponent.js';
import { DashboardComponent } from './dashboardComponent.js';
import { TableComponent } from './tableComponent.js';
import { hasDataUrl, getDataUrl, consumeDataParam, buildMobileSetupLink } from './urlConfig.js';
import { initTheme, subscribe as subscribeTheme } from './themeManager.js';
import { PullToRefresh } from './pullToRefresh.js';
import { SetupView, flashLabel } from './setupView.js';
import { checkVersion, forceUpdate } from './updateChecker.js';
import { downloadCSV } from './csvExporter.js';
import * as statusBar from './statusBar.js';

// Background-style auto refresh: while the app is visible we re-fetch the
// sheet every FOREGROUND_POLL_MS, and we also re-fetch on visibilitychange
// when the app comes back to the foreground if the cached data is older than
// STALE_AFTER_MS. iOS standalone PWAs can't use Background Sync (unsupported)
// so this is the best "data stays fresh on its own" we can do.
const STALE_AFTER_MS = 5 * 60 * 1000;
const FOREGROUND_POLL_MS = 5 * 60 * 1000;

export class App {
    constructor() {
        this.dataService = new DataService();
        this.navigationComponent = new NavigationComponent(
            (filterType) => this.filterData(filterType),
            () => downloadCSV(this.data),
            (view) => this.handleViewChange(view),
        );
        this.navigationComponent.onCopyConfig = () => this.handleCopyConfigLink();
        this.tableComponent = new TableComponent();
        this.tabComponent = new TabComponent(this.tableComponent);
        this.calendarComponent = new CalendarComponent();
        this.dashboardComponent = new DashboardComponent();
        this.pullToRefresh = new PullToRefresh({ onRefresh: () => this.revalidate() });
        this.setupView = new SetupView({ onSubmit: () => this.initialize() });
        // Lazy tab rendering (see filterData): tabs whose content is stale
        // under the latest filter, rendered only when they become visible.
        this._dirtyTabs = new Set();
        this._pendingFilter = null;
        this.tabComponent.onTabShown = (composer) => this._renderTabIfDirty(composer);
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
            this.setupView.show();
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

    // Menu "Copy setup link": same as the setup-screen button, but the URL
    // comes from localStorage (the user is already logged in) instead of the
    // input field. Flashes feedback on the menu item's label span (flashing
    // the whole <a> would clobber its icon).
    handleCopyConfigLink() {
        const label = d3.select('.menu-item[data-view="copy-config"] span');
        const url = getDataUrl();
        if (!url) {
            flashLabel(label, 'No URL set');
            return;
        }
        const link = buildMobileSetupLink(url);
        navigator.clipboard.writeText(link).then(
            () => flashLabel(label, 'Copied!'),
            () => flashLabel(label, 'Copy failed'),
        );
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
            statusBar.showNoData();
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

    // Mount (or re-mount) the whole UI. Every step is idempotent, so the
    // re-init path — error → re-enter URL → initialize() again — rebuilds a
    // singular UI instead of stacking duplicate tabs/buttons/listeners.
    async initializeUI() {
        this.navigationComponent.createMenu();
        this.navigationComponent.createRadioButtons();
        this.navigationComponent.createDateFilter();

        this.tabComponent.createTabs();
        this.tabComponent.showTab(DEFAULT_COMPOSER);

        // Calendar: clear any previous render's nodes first (same contract
        // as _rerenderData) so a re-init doesn't stack calendars.
        d3.select('#calendar').selectAll(':scope > .calendar-gen').remove();
        this.calendarComponent.createCalendar(this.data);

        // Dashboard owns its own date-range state; init() once, then data
        // refreshes go through setData.
        if (this.dashboardComponent.mounted) {
            this.dashboardComponent.setData(this.data);
        } else {
            this.dashboardComponent.init(this.data);
        }

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
                statusBar.showLoading();
                const result = await this.dataService.fetchCSV();
                this.renderInitial(result);
                this.updateDataStatus(result.timestamp, result.source, result);
                this.finishBoot();
            }
        } catch (error) {
            console.error('Error initializing application:', error);
            statusBar.showError(error, {
                onReconfigure: () => this.setupView.show(getDataUrl() || ''),
            });
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
            statusBar.showNoData();
            return;
        }
        setBegin(this.data[0].timestamp);
        // Only remove component-generated nodes — the static <h1>
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
        this.navigationComponent.onForceUpdate = () => forceUpdate();
        checkVersion();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this._maybeRefresh();
                checkVersion();
            }
        });
        setInterval(() => this._maybeRefresh(), FOREGROUND_POLL_MS);
    }

    updateDataStatus(timestamp, source, { cacheWriteFailed = false, offline = false } = {}) {
        // Empty dataset: showNoData already owns the status line, and the
        // last-session read below would have nothing to show.
        if (!this.data?.length) return;
        statusBar.showFreshness({
            timestamp, source, cacheWriteFailed, offline,
            lastSessionTimestamp: this.data[this.data.length - 1].timestamp,
            formatTimeSince: (t) => this.dataService.formatTimeSince(t),
        });
    }

    filterData(filterType) {
        const [start, end] = this.navigationComponent.getSelectedDates();
        const part = this.navigationComponent.getSelectedPart();
        const players = this.navigationComponent.getSelectedPlayers();

        const { datePartFiltered, filtered } = filterRows(this.data, { part, start, end, players });

        // Only update player dropdown if date or part changed, not player
        if (filterType === "date" || filterType === "part") {
            this.navigationComponent.populatePlayerDropdown(extractUniquePlayers(datePartFiltered));
        }

        // Render ONLY the visible tab now; mark the rest dirty and render
        // them on demand when the user switches to them (~21 hidden tab
        // renders per filter change previously — now exactly one).
        this._pendingFilter = { part, filtered };
        this._dirtyTabs = new Set([...COMPOSERS, ALL_TAB]);
        this._renderTabIfDirty(this.tabComponent.activeTab ?? DEFAULT_COMPOSER);
    }

    _renderTabIfDirty(composer) {
        if (!this._pendingFilter || !this._dirtyTabs.has(composer)) return;
        const { part, filtered } = this._pendingFilter;
        this.tabComponent.updateTabContent(composer, part, filtered, this.data);
        this._dirtyTabs.delete(composer);
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
