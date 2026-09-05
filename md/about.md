# About

This is a tool for visualizing a personal log of chamber music — mostly string quartets — that you've played. You point it at a Google Sheet (your own log), and it gives you sortable lists by composer, a calendar grid of which days you played, and a small cross-filtered dashboard. The data on display is whatever sheet the current viewer has configured, so this is effectively a different site for every person who uses it.

If you'd like to start logging your own chamber music, follow the **[How to make a chamber music log](./howto.html)** instructions — they walk through creating the Google Form and Sheet that this tool reads.

For the longer story behind the project, see this blog post: **[Data visualization on the go](https://runningwithdata.com/2024/10/10/data-visualization-on-the-go.html)**.

## What's here

- **Home** — sortable lists of every quartet logged, grouped by composer (Haydn, Mozart, Beethoven, …), with quick filters for date range, part (V1 / V2 / VA), and the people played with. The **ALL** tab at the end shows aggregate stats and a flat data table across whatever passes the current filters.
- **Calendar** — a GitHub-contributions-style year grid showing which days you played, with summary stats per year, a "last 365 days" header, and per-day tooltips listing what was played and with whom.
- **Dashboard** — a small set of cross-filtered charts: a stacked bar of which part you play (V1 / V2 / VA) and a horizontal bar chart of top composers. Clicking either chart filters the other.
- **Log a Piece** — an entry form that writes a new row through your own Google Form. It exists because the app has your whole log loaded and the Google Form does not: the composers you play are one tap, names you have used autocomplete, empty seats show who they will repeat, each seat has a part beside it so a swap is a dropdown rather than a retype, and extra players stay for the session instead of needing to be retyped on every piece. Everything but the send works offline; entries made with no signal queue up and go out in order.

## How to use it

The first time you visit, the site asks for the URL of your published Google Sheet — your data, your view. The setup screen links to **[How to make a chamber music log](./howto.html)** if you haven't built one yet. Once you've entered the URL, it's saved to your browser's local storage and the data loads automatically on subsequent visits (with a 5-second cache fallback so it stays usable when the network is flaky).

Filters at the top of Home (date range, part, players) work in combination — they apply across every composer tab and the data table at the bottom of each tab. The Calendar and Dashboard views have their own independent date filters.

The hamburger menu in the top-left has **Log a Piece**, **Download Data** (a CSV export of everything in the current view) and **Log Out** (clears the saved URL so you can re-enter one). Use Log Out before sharing your screen if you want to keep your data private.

To log from the site you also point it at the Google Form that feeds your sheet, once per device — the form's *pre-filled link* carries the field ids, and the how-to walks through it. There is no form built in: this site writes through yours, so your entries go to your spreadsheet and nobody else's.

## Privacy

The site is a static page hosted on GitHub Pages — there's no backend, and there is nowhere for your data to go but Google.

Your data lives in two places: the Google Sheet you point at (whose access you control via Google), and your browser's local storage. Local storage holds the Sheet URL, a cache of the parsed CSV, and — if you use **Log a Piece** — which Google Form to write through, anything queued while you were offline, the pieces logged in the current session, and the piece you are part-way through typing. That last group is what lets a half-filled form survive your phone closing the app.

Traffic goes to Google and nowhere else: the browser fetches the CSV directly from Google, and a logged piece is POSTed straight to your own Google Form, exactly as its own page would. Nothing is sent to me or to any third-party server. **Log Out** clears the saved URL and the cached data from your browser.

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
