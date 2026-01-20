# Quartet Log

A visualization tool for tracking string quartet sessions. Log what you play, see your progress through the repertoire, and get suggestions for what to play next.

**Live site:** [log.quartetroulette.com](https://log.quartetroulette.com)

## Features

- Track quartet sessions with composer, work, players, and date
- Visualize plays per work across Haydn, Mozart, Beethoven, and other composers
- Calendar view showing session frequency over time
- Filter by part (V1/V2/VA), date range, and player
- "Quartet Roulette" random work picker weighted by recency
- Works with any Google Sheets data source

## Setup

1. Create a Google Sheet with your quartet session data
2. Publish it to the web as CSV (File → Share → Publish to web)
3. Visit the site and paste your CSV URL

See [setup.html](https://log.quartetroulette.com/setup.html) for detailed instructions.

## Development

**Prerequisites:**
- esbuild 0.24.2
- pandoc 3.6.2

**Run locally:**
```bash
./build.sh
```
This starts a dev server with watch mode at `http://localhost:8000`.

**Production build:**
```bash
./build.sh --prod
```

## Deployment

Deployment to GitHub Pages is automatic on push to main via GitHub Actions.

## Related

- [QuartetRoulette.com](https://quartetroulette.com) - Choose what to play next
- [How To Make a Chamber Music Log](https://quip.com/0Fy0AQTJIQmd/How-to-Make-a-Chamber-Music-Log) - Guide to setting up your own tracking sheet

## License

MIT
