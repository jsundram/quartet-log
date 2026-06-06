#!/usr/bin/env bash
# Fetch the raw published Google Sheets CSV (no processing) to
# archive/data-raw.csv. Source URL is read from .dev-data-url (single line,
# gitignored). For the processed equivalent of the in-browser "Download Data"
# button, use fetch_processed.mjs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL_FILE="$REPO_ROOT/.dev-data-url"
OUT_FILE="$REPO_ROOT/archive/data-raw.csv"

if [[ ! -f "$URL_FILE" ]]; then
    echo "Missing $URL_FILE - create it with a single line containing the published Google Sheets CSV URL." >&2
    exit 1
fi

URL=$(tr -d '[:space:]' < "$URL_FILE")
curl -sSfL "$URL" -o "$OUT_FILE"
echo "Wrote raw sheet to $OUT_FILE ($(wc -l < "$OUT_FILE" | tr -d ' ') lines)"
