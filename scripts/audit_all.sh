#!/usr/bin/env bash
# Run every data-quality audit against a freshly fetched copy of the sheet.
#
# One input: archive/data-raw.csv, the sheet exactly as it was typed. Each
# audit derives the view it needs in-process (scripts/lib/views.mjs) and says
# in its own header which one it read, so nothing here has to choose:
#
#   audit_aliases      the WRITTEN view. Every question it asks is about what a
#                      human typed — how often a full name was spelled out,
#                      which cells still hold a bare one, whether an alias key
#                      is still in the sheet.
#   audit_ensembles    the PROCESSED view, the app's own pipeline. On the
#                      written view every continuation row states no players
#                      and would look under-logged.
#   audit_fillforward  the WRITTEN view by necessity. It looks for exactly the
#                      blank player slots that mark a continuation row, and
#                      fill-forward is what erases them.
#   attribution        WRITTEN for the subjects (a finding asks you to edit a
#                      cell, and only that view has cells) and FILLED for the
#                      evidence (who was in the room). Its own module, printer
#                      and entry point — `npm run attribution` — because its
#                      findings decay and the descriptive audits can batch. It
#                      is run here too so one command still gives the whole
#                      picture.
#
# archive/data.csv is no longer an input: the processed view is derived here
# from the raw file rather than read from a second path that could be a
# different snapshot. scripts/fetch_processed.mjs still writes it, for the
# "Download Data" round-trip it exists to mirror.
#
# Usage: npm run audit            fetch fresh, then audit
#        npm run audit -- --no-fetch    audit whatever is already in archive/
set -euo pipefail
cd "$(dirname "$0")/.."

FETCH=1
for arg in "$@"; do
    [ "$arg" = "--no-fetch" ] && FETCH=0
done

# The audits import src/config.js, which re-exports the gitignored
# src/aliases.js; on a fresh clone that file does not exist yet.
node scripts/ensure_aliases.mjs

if [ "$FETCH" = 1 ]; then
    if [ ! -f .dev-data-url ]; then
        echo "error: .dev-data-url not found — cannot fetch." >&2
        echo "Put your published-CSV URL in it, or pass --no-fetch to audit" >&2
        echo "whatever is already in archive/." >&2
        exit 1
    fi
    ./scripts/fetch_raw.sh
    echo
fi

RAW=archive/data-raw.csv
if [ ! -f "$RAW" ]; then
    echo "error: $RAW missing — run without --no-fetch." >&2
    exit 1
fi

rule() { printf '\n%s\n%s\n%s\n' "$(printf '=%.0s' {1..72})" "  $1" "$(printf '=%.0s' {1..72})"; }

# An audit that printed nothing is a failure, and `set -euo pipefail` cannot
# see one that exited 0 (a symlinked invocation path used to do exactly that).
# Without this the SUMMARY below prints blank counts, and a run that examined
# nothing reads as a run that found nothing.
run() {
    local out=$1; shift
    node "$@" | tee "$out"
    if [ ! -s "$out" ]; then
        echo "error: $2 produced no output — refusing to summarize it." >&2
        exit 1
    fi
}

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

rule "PLAYER NAMES        scripts/audit_aliases.mjs"
run "$OUT/aliases.txt" scripts/audit_aliases.mjs "$RAW"

rule "ENSEMBLE HEADCOUNT  scripts/audit_ensembles.mjs"
run "$OUT/ensembles.txt" scripts/audit_ensembles.mjs "$RAW"

rule "DROPPED BY FILL-FORWARD   scripts/audit_fillforward.mjs"
run "$OUT/fillforward.txt" scripts/audit_fillforward.mjs "$RAW"

rule "WHICH PERSON      scripts/attribution.mjs"
run "$OUT/attribution.txt" scripts/attribution.mjs "$RAW"

# The full output runs to hundreds of lines, most of it groups that are fine.
# This is the part worth reading on a routine run: what needs a decision, and
# which decisions decay if left (only you know who "Alice" was last month).
# Each audit heads its sections "<label> (<n>)"; pull the n off the first
# line matching the label. Every count comes from the run above — one process
# per audit, no second pass against a different view.
count() { grep -E "$1" "$2" | head -1 | grep -oE '\([0-9]+\)' | tr -d '()'; }
rule "SUMMARY"
printf '  %-46s %s\n' \
  "bare names with 2+ candidates (NEEDS MEMORY)" "$(count 'bare names in the sheet with 2\+ candidates' "$OUT/aliases.txt")" \
  "aliases keyed on an ambiguous first name" "$(count 'aliases keyed on an ambiguous first name' "$OUT/aliases.txt")"
printf '  %-46s %s\n' \
  "aliases that are a surname's only record" "$(count 'ONLY record of a surname' "$OUT/aliases.txt") (back up src/aliases.js)" \
  "aliases pointing at an unrelated name" "$(count 'absent and unrelated' "$OUT/aliases.txt")"
printf '  %-46s %s\n' \
  "under-logged, ensemble stated (NEEDS MEMORY)" "$(count 'title states the ensemble' "$OUT/ensembles.txt")" \
  "piano works with nobody marked at the keyboard" "$(count 'UNANNOTATED PIANO WORKS' "$OUT/ensembles.txt")"
printf '  %-46s %s\n' \
  "rows that dropped an Others? player (mechanical)" \
  "$(grep -oE '^[0-9]+ rows in' "$OUT/fillforward.txt" | grep -oE '[0-9]+' | head -1)"
printf '  %-46s %s\n' \
  "bare entries to edit in the sheet" "$(count 'edit this cell' "$OUT/attribution.txt")" \
  "bare entries nobody has decided (NEEDS MEMORY)" "$(count 'answer this now' "$OUT/attribution.txt")"
echo
echo "  Lines marked NEEDS MEMORY are the ones that get harder to answer the"
echo "  longer they wait. The rest can safely accumulate — a dropped Others?"
echo "  player is recoverable from the row above it whenever you get to it."
