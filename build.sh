#!/bin/bash
# deps: esbuild 0.24.2, pandoc 3.6.2
#       fswatch (optional, for live-reload of static assets in dev mode)
#
DEPLOY="./last_deploy"

# Check for production flag
PROD=$([[ "$1" == "--prod" ]] && echo true || echo false)

# Convert markdown to HTML and copy all static assets to $DEPLOY.
# Safe to call repeatedly — used both for the initial build and for
# fswatch-driven live reload in dev mode.
copy_assets() {
    # Process markdown files
    pushd md/ > /dev/null
    for md in *.md; do
        f=$(basename "$md" .md)
        pandoc -f gfm -t html5 -o "$f.html" "$md" \
            --css github-markdown.css \
            --embed-resources -s \
            --metadata title=" " \
            --template _pandoc_template.html
    done
    popd > /dev/null

    # Generated HTML pages
    mv md/TODO.html "$DEPLOY/"
    mv md/about.html "$DEPLOY/"
    mv md/setup.html "$DEPLOY/"
    mv md/howto.html "$DEPLOY/"

    # Copy all required files to deploy directory, flattening
    cp index.html "$DEPLOY/"
    cp CNAME "$DEPLOY/"
    cp static/css/viz.css "$DEPLOY/"
    cp static/data/all_works.json "$DEPLOY/"

    # wget -O d3.v7.min.js https://unpkg.com/d3@7.9.0/dist/d3.min.js
    cp static/js/d3.v7.min.js "$DEPLOY/"

    # Favicon files (including manifest)
    cp -r static/favicon/* "$DEPLOY/"

    echo "[$(date +%H:%M:%S)] Copied assets to $DEPLOY"
}

# Ensure deploy directory exists and is clean
rm -rf "$DEPLOY"
mkdir -p "$DEPLOY"

# Initial copy of all static assets
copy_assets

# The browser targets were arrived at by noticing that the array.at()
# method (used in calendarComponent.js) was added in:
#   * Chrome 92 (Jul 2021)
#   * Firefox 90 (Jul 2021)
#   * Safari 15.4 (Mar 2022)
#   * Edge 92 (Jul 2021)
BASE_ESBUILD_CMD="esbuild src/app.js \
    --bundle \
    --target=chrome92,firefox90,safari15.4,edge92 \
    --format=iife \
    --global-name=App \
    --outfile=$DEPLOY/bundle.js"

if [[ "$PROD" == true ]]; then
    echo "Building for production..."
    eval "$BASE_ESBUILD_CMD \
        --minify \
        --tree-shaking=true"
else
    echo "Building for development..."

    # Watch static assets in the background so that CSS / HTML / markdown /
    # data / favicon edits get re-copied into $DEPLOY without restarting the
    # build. esbuild --watch only re-bundles JS, so we need a separate watcher.
    if command -v fswatch >/dev/null 2>&1; then
        WATCH_PATHS="index.html CNAME static md"
        # --latency 0.3 debounces rapid bursts of file events into one copy.
        fswatch -o --latency 0.3 $WATCH_PATHS | while read _; do
            copy_assets
        done &
        FSWATCH_PID=$!
        # Make sure the watcher dies when this script exits (Ctrl-C, etc).
        trap 'kill $FSWATCH_PID 2>/dev/null' EXIT INT TERM
        echo "Watching static assets with fswatch (PID $FSWATCH_PID)..."
    else
        echo "Note: install fswatch (\`brew install fswatch\`) to auto-copy"
        echo "      CSS / HTML / data / favicon changes during watch mode."
    fi

    eval "$BASE_ESBUILD_CMD \
        --sourcemap \
        --watch \
        --servedir=$DEPLOY"
fi

echo -e "\nBuild complete. Files in deploy directory:"
ls -la $DEPLOY
echo -e "\nBundle size:"
ls -lh $DEPLOY/bundle.js
