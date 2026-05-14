# About

This is a tool for visualizing a personal log of chamber music — mostly string quartets — that you've played. You point it at a Google Sheet (your own log), and it gives you sortable lists by composer, a calendar grid of which days you played, and a small cross-filtered dashboard. The data on display is whatever sheet the current viewer has configured, so this is effectively a different site for every person who uses it.

If you'd like to start logging your own chamber music, follow the **[How to make a chamber music log](./howto.html)** instructions — they walk through creating the Google Form and Sheet that this tool reads.

For the longer story behind the project, see this blog post: **[Data visualization on the go](https://runningwithdata.com/2024/10/10/data-visualization-on-the-go.html)**.

## What's here

- **Home** — sortable lists of every quartet logged, grouped by composer (Haydn, Mozart, Beethoven, …), with quick filters for date range, part (V1 / V2 / VA), and the people played with. The **ALL** tab at the end shows aggregate stats and a flat data table across whatever passes the current filters.
- **Calendar** — a GitHub-contributions-style year grid showing which days you played, with summary stats per year, a "last 365 days" header, and per-day tooltips listing what was played and with whom.
- **Dashboard** — a small set of cross-filtered charts: a stacked bar of which part you play (V1 / V2 / VA) and a horizontal bar chart of top composers. Clicking either chart filters the other.

## How to use it

The first time you visit, the site asks for the URL of your published Google Sheet — your data, your view. The setup screen links to **[How to make a chamber music log](./howto.html)** if you haven't built one yet. Once you've entered the URL, it's saved to your browser's local storage and the data loads automatically on subsequent visits (with a 5-second cache fallback so it stays usable when the network is flaky).

Filters at the top of Home (date range, part, players) work in combination — they apply across every composer tab and the data table at the bottom of each tab. The Calendar and Dashboard views have their own independent date filters.

The hamburger menu in the top-left has **Download Data** (a CSV export of everything in the current view) and **Log Out** (clears the saved URL so you can re-enter one). Use Log Out before sharing your screen if you want to keep your data private.

## Privacy

The site is a static page hosted on GitHub Pages — there's no backend. Your data lives in two places: the Google Sheet you point at (whose access you control via Google), and your browser's local storage, which caches the parsed CSV between visits and stores the Sheet URL. The browser fetches the CSV directly from Google; nothing is sent to me or any third-party server. **Log Out** clears the saved URL and the cached data from your browser.

## How it's built

- **Frontend**: vanilla JavaScript with [D3.js v7](https://d3js.org/) for everything visual. No framework.
- **Bundler**: [esbuild](https://esbuild.github.io/) produces a single `bundle.js`.
- **Markdown pages** (this one and the how-to): rendered with [pandoc](https://pandoc.org/) into self-contained HTML.
- **Data source**: your Google Sheet, published as CSV, fetched at page load with browser local-storage caching.
- **Tests**: a small `node:test` suite covering the data-processing helpers (alias normalization, partial-movement filtering, etc.).
- **Hosting**: GitHub Pages, with automatic deployment on push to `main`.

The code is open source: **[github.com/jsundram/musiclog](https://github.com/jsundram/musiclog)**.

## A bit of history

I started keeping a Google-Form-to-spreadsheet log of my own quartet sessions in 2016, and the visualizations grew from there — first a simple list of pieces I'd played ordered by composer, then over time the calendar grid, the cross-filtered dashboard, and many small refinements like name normalization, partial-movement handling, and mobile-friendly layouts.
