// The #update status line. Split out of app.js: every message the app shows
// there — loading, freshness, offline/stale warnings, empty-data, errors —
// goes through here, so the copy and the color rules live in one place.
import * as d3 from "d3";
import { escapeHtml } from './escapeHtml.js';

function bar() {
    return d3.select('#update').style("margin-left", "10px");
}

export function showLoading() {
    bar().text('Loading data...').style("color", "var(--color-text-tertiary)");
}

// Shown when the sheet loaded but zero rows survived processing (all
// partial movements / unparseable timestamps). Leaves whatever UI exists
// in place; just surfaces the state on the status line.
export function showNoData() {
    bar().text('No usable data found in the sheet (every row was filtered out).')
        .style("color", "var(--color-text-error)");
}

// The freshness line. `cacheWriteFailed` means the fresh data on screen
// could not be persisted (localStorage quota): the NEXT launch will boot
// from an older cache, so say so instead of silently styling it as fresh.
// `offline` means a background refresh failed: what's on screen is the last
// successful fetch, which may be behind the sheet.
//
// Only those two failure states get the error color. Serving from cache is
// NORMAL operation (cache-first boot paints from it on every launch), so it
// renders in the regular status color, not styled as an error.
export function showFreshness({ timestamp, source, cacheWriteFailed = false, offline = false, lastSessionTimestamp, formatTimeSince }) {
    const lastSession = formatTimeSince(lastSessionTimestamp);

    let updateText;
    if (offline) {
        updateText = `Offline? Couldn't refresh — showing data from ${formatTimeSince(timestamp)}`;
    } else if (source === 'cache') {
        updateText = `Data Loaded from cache. Age: ${formatTimeSince(timestamp).replace("ago", "old")}`;
    } else {
        updateText = `Data updated ${formatTimeSince(timestamp)}`;
    }
    if (cacheWriteFailed) {
        updateText += ' (storage full — offline copy may be stale)';
    }

    const warn = cacheWriteFailed || offline;
    bar().text(`${updateText}; last session ${lastSession}`)
        .style("color", warn ? "var(--color-text-error)" : "var(--color-text-tertiary)");
}

// Load-failure line. URL-shaped failures get a "Re-enter data URL" link that
// hands off to the setup view via `onReconfigure`.
export function showError(error, { onReconfigure } = {}) {
    const isUrlError = error.message.includes('No data URL configured') ||
        error.message.includes('No cached data available') ||
        error.message.includes('Failed to fetch');

    if (isUrlError && onReconfigure) {
        bar().html(`Error loading data: ${escapeHtml(error.message)}. <a href="#" id="reconfigureLink">Re-enter data URL</a>`)
            .style("color", "var(--color-text-error)");
        d3.select('#reconfigureLink').on('click', (event) => {
            event.preventDefault();
            onReconfigure();
        });
    } else {
        bar().text(`Error loading data: ${error.message}`)
            .style("color", "var(--color-text-error)");
    }
}
