#!/usr/bin/env bash
# Push the local src/aliases.js to the PLAYER_ALIASES_JS GitHub Actions
# secret, so the next deploy builds with the current alias tables.
#
# The deploy workflow (.github/workflows/deploy.yml) materializes
# src/aliases.js from that secret — nothing syncs it automatically, so run
# this after editing src/aliases.js (e.g. from scripts/audit_aliases.mjs's
# proposal block) or the deployed site keeps normalizing with stale tables.
#
# Refuses to push an empty/stub table so a fresh clone can't blank the
# secret by accident.
set -euo pipefail
cd "$(dirname "$0")/.."

FILE=src/aliases.js

if ! command -v gh >/dev/null; then
    echo "error: gh CLI not found — install it (brew install gh) and run 'gh auth login'." >&2
    exit 1
fi

if [ ! -f "$FILE" ]; then
    echo "error: $FILE not found. It is gitignored; see 'Alias privacy' in CLAUDE.md." >&2
    exit 1
fi

# Validate before pushing: must import cleanly and hold non-empty tables.
node --input-type=module -e '
import("./src/aliases.js")
    .then((m) => {
        const aliases = Object.keys(m.PLAYER_ALIASES ?? {}).length;
        const abbrevs = Object.keys(m.PLAYER_ABBREVIATIONS ?? {}).length;
        if (aliases + abbrevs === 0) {
            console.error("error: src/aliases.js has empty tables (the stub copy?) — refusing to push.");
            process.exit(1);
        }
        console.log(`Validated src/aliases.js: ${aliases} aliases, ${abbrevs} abbreviations.`);
    })
    .catch((e) => {
        console.error("error: could not import src/aliases.js: " + e.message);
        process.exit(1);
    });
'

gh secret set PLAYER_ALIASES_JS < "$FILE"
echo "PLAYER_ALIASES_JS secret updated. The next push to main deploys with these tables."
