#!/bin/bash
# deps: esbuild, pandoc (versions pinned in package.json / CI workflow)
#       fswatch (optional, for live-reload of static assets in dev mode)
#
# Fail loudly: any failed command (pandoc, cp, sed, mv, esbuild) must fail
# the build — CI runs `./build.sh --prod` as the deploy step, and a silent
# partial failure would deploy a broken site with a green check.
set -euo pipefail

DEPLOY="./last_deploy"

# Parse flags: --prod, --port <n>
PROD=false
PORT=8000
while [[ $# -gt 0 ]]; do
    case "$1" in
        --prod) PROD=true; shift ;;
        --port) PORT="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

# Preflight: fail fast with a clear message instead of partway through the
# build with a confusing one. fswatch is optional (dev nicety, checked later).
for tool in esbuild pandoc node npm; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Error: required tool '$tool' not found on PATH." >&2
        exit 1
    fi
done

# Convert markdown to HTML and copy all static assets to $DEPLOY.
# Safe to call repeatedly — used both for the initial build and for
# fswatch-driven live reload in dev mode.
copy_assets() {
    # Process markdown files. Write pandoc output DIRECTLY to $DEPLOY rather
    # than into md/ and then moving — otherwise fswatch (watching md/) sees
    # the writes, fires copy_assets again, and we spin in a tight loop.
    local deploy_abs
    if ! deploy_abs="$(cd "$DEPLOY" && pwd)" || [[ -z "$deploy_abs" ]]; then
        echo "Error: deploy directory '$DEPLOY' does not exist." >&2
        return 1
    fi
    pushd md/ > /dev/null
    for md in *.md; do
        f=$(basename "$md" .md)
        pandoc -f gfm+attributes+implicit_figures -t html5 -o "$deploy_abs/$f.html" "$md" \
            --css github-markdown.css \
            --embed-resources -s \
            --metadata title=" " \
            --template _pandoc_template.html
    done
    popd > /dev/null

    # Copy all required files to deploy directory, flattening
    cp index.html "$DEPLOY/"
    cp CNAME "$DEPLOY/"
    cp static/css/viz.css "$DEPLOY/"
    cp static/data/all_works.json "$DEPLOY/"
    cp static/data/haydn_peters.json "$DEPLOY/"

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
# Version constant baked into the bundle so all_works.json fetches carry a
# cache-busting query string (?v=<hash>). Dev mode uses a literal "dev"
# placeholder — esbuild's --watch + dev server serve the latest file on
# disk regardless of query string. In prod we hash the actual JSON content
# so each deploy that changes the catalog gets a fresh URL on iOS et al.
WORKS_VERSION="dev"
if [[ "$PROD" == true ]]; then
    WORKS_VERSION=$(shasum -a 256 "$DEPLOY/all_works.json" | cut -c1-8)
fi

ESBUILD_ARGS=(
    src/app.js
    --bundle
    --target=chrome92,firefox90,safari15.4,edge92
    --format=iife
    --global-name=App
    "--define:__WORKS_VERSION__=\"$WORKS_VERSION\""
    "--outfile=$DEPLOY/bundle.js"
)

if [[ "$PROD" == true ]]; then
    echo "Running tests..."
    npm test || { echo "Tests failed — aborting production build."; exit 1; }
    echo "Building for production..."
    esbuild "${ESBUILD_ARGS[@]}" --minify --tree-shaking=true

    # Content-hash bundle.js and viz.css so iOS homescreen webclips (and any
    # other aggressively-caching layer) don't keep serving stale copies after
    # a deploy. Every change to either file produces a new URL; the next time
    # the cached index.html expires (GH Pages serves `Cache-Control:
    # max-age=600`) the homescreen app fetches the new asset names fresh.
    # Production-only: dev mode keeps the stable names so esbuild --serve +
    # the unhashed <script>/<link> in the source index.html work as-is.
    hash_and_rename() {
        local file="$1"
        local hash base ext
        hash=$(shasum -a 256 "$DEPLOY/$file" | cut -c1-8)
        base="${file%.*}"
        ext="${file##*.}"
        echo "${base}-${hash}.${ext}"
        mv "$DEPLOY/$file" "$DEPLOY/${base}-${hash}.${ext}"
    }
    NEW_BUNDLE=$(hash_and_rename "bundle.js")
    NEW_CSS=$(hash_and_rename "viz.css")

    # Rewrite references in the deployed index.html only — the source file
    # in the working tree stays on stable names. Match the exact src=/href=
    # attributes rather than any occurrence of the filenames, so an unrelated
    # mention (e.g. in a comment or inline script) can never be rewritten.
    # -i.bak is portable across BSD (macOS) and GNU (CI) sed.
    sed -i.bak \
        -e "s|src=\"\./bundle\.js\"|src=\"./$NEW_BUNDLE\"|" \
        -e "s|href=\"\./viz\.css\"|href=\"./$NEW_CSS\"|" \
        "$DEPLOY/index.html"
    rm "$DEPLOY/index.html.bak"
    # Verify the rewrite actually landed — sed exits 0 even when nothing matches.
    grep -q "$NEW_BUNDLE" "$DEPLOY/index.html" || { echo "Error: bundle reference not rewritten in index.html" >&2; exit 1; }
    grep -q "$NEW_CSS" "$DEPLOY/index.html" || { echo "Error: css reference not rewritten in index.html" >&2; exit 1; }
    echo "Content-hashed: $NEW_BUNDLE, $NEW_CSS"

    # Generate the service worker from static/sw.js, injecting the hashed shell
    # filenames + a cache version derived from those hashes. Because the hashes
    # move whenever code / CSS / catalog data change, the SW cache name (V)
    # changes on every meaningful deploy and evicts the stale cache on activate
    # — no hand-bumped version constant to forget. Prod-only: dev serves the
    # unhashed files off esbuild's live server and registers no SW.
    BHASH="${NEW_BUNDLE#bundle-}"; BHASH="${BHASH%.js}"
    CHASH="${NEW_CSS#viz-}"; CHASH="${CHASH%.css}"
    SW_VERSION="ql-${BHASH}-${CHASH}"
    sed \
        -e "s|__SW_VERSION__|$SW_VERSION|g" \
        -e "s|__BUNDLE_JS__|$NEW_BUNDLE|g" \
        -e "s|__CSS_FILE__|$NEW_CSS|g" \
        static/sw.js > "$DEPLOY/sw.js"
    echo "Service worker: $DEPLOY/sw.js ($SW_VERSION)"

    echo -e "\nBuild complete. Files in deploy directory:"
    ls -la "$DEPLOY"
    echo -e "\nBundle size:"
    ls -lh "$DEPLOY"/bundle*.js
else
    echo "Building for development..."

    echo "Running tests (initial)..."
    npm test || echo "[WARNING] Tests are failing — fix before deploying."

    # Background helpers (proxy, fswatch) die with this script (Ctrl-C, etc).
    # $BG_PIDS expands at signal time, so PIDs appended after the trap is set
    # are still covered. The fswatch pipelines are `fswatch | while` — $! is
    # the `while` subshell, and killing only that side orphans the fswatch
    # process (it lingers until its next write hits the broken pipe). pkill
    # by parent PID catches the fswatch side, which is a direct child of
    # this script (both members of a background pipeline are).
    BG_PIDS=""
    trap 'kill $BG_PIDS 2>/dev/null || true; pkill -P $$ -x fswatch 2>/dev/null || true' EXIT INT TERM

    # Watch static assets in the background so that CSS / HTML / markdown /
    # data / favicon edits get re-copied into $DEPLOY without restarting the
    # build. esbuild --watch only re-bundles JS, so we need a separate watcher.
    if command -v fswatch >/dev/null 2>&1; then
        WATCH_PATHS=(index.html CNAME static md)
        # --latency 0.3 debounces rapid bursts of file events into one copy.
        # `|| echo` keeps the watcher alive across a transient failure (e.g.
        # a pandoc syntax error mid-edit) instead of dying under `set -e`.
        fswatch -o --latency 0.3 "${WATCH_PATHS[@]}" | while read -r _; do
            copy_assets || echo "[WARNING] asset copy failed — fix and save again"
        done &
        BG_PIDS="$BG_PIDS $!"
        echo "Watching static assets with fswatch (PID $!)..."

        # Re-run tests on any change under src/ or test/. Dot reporter so each
        # rerun is one compact line instead of 31 ✔'s. TZ matches the npm test
        # script (and thus CI) so timezone-sensitive tests can't pass on save
        # but fail in CI.
        fswatch -o --latency 0.5 src test | while read -r _; do
            echo "[$(date +%H:%M:%S)] JS change — re-running tests..."
            TZ=America/New_York node --test --test-reporter=dot test/*.mjs || true
        done &
        BG_PIDS="$BG_PIDS $!"
        echo "Watching src/ + test/ for tests (PID $!)..."
    else
        echo "Note: install fswatch (\`brew install fswatch\`) to auto-copy static"
        echo "      assets and re-run tests on save during watch mode."
    fi

    # esbuild's dev server can't set response headers and sends no
    # Cache-Control / ETag / Last-Modified, so the browser can silently keep
    # serving a stale bundle.js after a rebuild. esbuild's own docs say to
    # put a proxy in front for header customization, so dev traffic goes
    # through scripts/dev_proxy.mjs on $PORT, which forwards to esbuild on
    # an internal port and stamps Cache-Control: no-store on every response.
    ESBUILD_PORT=$((PORT + 1))
    node scripts/dev_proxy.mjs "$ESBUILD_PORT" "$PORT" &
    BG_PIDS="$BG_PIDS $!"

    echo ""
    echo " > Dev server: http://127.0.0.1:$PORT  (use this, not esbuild's :$ESBUILD_PORT URLs below — only the proxy disables caching)"

    # If a .dev-data-url file exists, print a clickable URL that pre-seeds
    # the Google Sheets source via ?data=<encoded>. urlConfig.consumeDataParam()
    # picks it up on first load and stores it in localStorage. File is gitignored.
    if [[ -f .dev-data-url ]]; then
        DEV_URL=$(head -n 1 .dev-data-url | tr -d '[:space:]')
        if [[ -n "$DEV_URL" ]]; then
            ENCODED=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$DEV_URL")
            echo " > Preconfigured: http://127.0.0.1:$PORT/?data=$ENCODED"
        fi
    fi

    # Run esbuild in the background and `wait` on it rather than in the
    # foreground: bash defers signal traps while a foreground child runs, so
    # a plain `kill <script-pid>` would never reach the cleanup trap (only
    # interactive Ctrl-C, which signals the whole process group, would).
    # Backgrounded + wait, the trap fires promptly and kills every helper.
    # --watch=forever because plain --watch exits when stdin closes, which
    # is exactly what backgrounding does.
    esbuild "${ESBUILD_ARGS[@]}" --sourcemap --watch=forever "--serve=$ESBUILD_PORT" "--servedir=$DEPLOY" &
    BG_PIDS="$BG_PIDS $!"
    wait $!
fi
