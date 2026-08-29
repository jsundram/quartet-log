#!/usr/bin/env bash
# Run every data-quality audit against a freshly fetched copy of the sheet.
#
# Each audit needs a different view of the data, and the difference matters:
#
#   audit_aliases     archive/data.csv      processed. fillForward has run, so
#                     (post-fillForward)    every row lists its full group and
#                                           the teammate-overlap heuristic has
#                                           something to work with. It warns on
#                                           its own if a question needs the raw
#                                           sheet instead — alias liveness
#                                           cannot be read from a canonicalized
#                                           export, because a working alias
#                                           looks dead there.
#
#   audit_ensembles   archive/data.csv      processed, for the same reason: on
#                                           the raw sheet every continuation
#                                           row looks under-logged.
#
#   audit_fillforward archive/data-raw.csv  raw by necessity. It looks for the
#                                           blank player slots that mark a
#                                           continuation row, and fillForward
#                                           is exactly what erases them.
#
# Usage: npm run audit            fetch fresh, then audit
#        npm run audit -- --no-fetch    audit whatever is already in archive/
set -euo pipefail
cd "$(dirname "$0")/.."

FETCH=1
for arg in "$@"; do
    [ "$arg" = "--no-fetch" ] && FETCH=0
done

if command -v uv >/dev/null 2>&1; then
    PY=(uv run --python 3.12 python)
else
    PY=(python3)
    echo "note: uv not found, falling back to python3" >&2
fi

if [ "$FETCH" = 1 ]; then
    if [ ! -f .dev-data-url ]; then
        echo "error: .dev-data-url not found — cannot fetch." >&2
        echo "Put your published-CSV URL in it, or pass --no-fetch to audit" >&2
        echo "whatever is already in archive/." >&2
        exit 1
    fi
    node scripts/fetch_processed.mjs
    ./scripts/fetch_raw.sh
    echo
fi

for f in archive/data.csv archive/data-raw.csv; do
    if [ ! -f "$f" ]; then
        echo "error: $f missing — run without --no-fetch." >&2
        exit 1
    fi
done

rule() { printf '\n%s\n%s\n%s\n' "$(printf '=%.0s' {1..72})" "  $1" "$(printf '=%.0s' {1..72})"; }

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

rule "PLAYER NAMES        scripts/audit_aliases.py"
"${PY[@]}" scripts/audit_aliases.py archive/data.csv | tee "$OUT/aliases.txt"

rule "ENSEMBLE HEADCOUNT  scripts/audit_ensembles.py"
"${PY[@]}" scripts/audit_ensembles.py archive/data.csv | tee "$OUT/ensembles.txt"

rule "DROPPED BY FILL-FORWARD   scripts/audit_fillforward.py"
"${PY[@]}" scripts/audit_fillforward.py archive/data-raw.csv | tee "$OUT/fillforward.txt"

# The full output runs to hundreds of lines, most of it groups that are fine.
# This is the part worth reading on a routine run: what needs a decision, and
# which decisions decay if left (only you know who "Alice" was last month).
# Each audit heads its sections "<label> (<n>)"; pull the n off the first
# line matching the label.
count() { grep -E "$1" "$2" | head -1 | grep -oE '\([0-9]+\)' | tr -d '()'; }
n_of() { printf '%s' "$RAWALIAS" | grep -E "$1" | head -1 | grep -oE '\([0-9]+\)' | tr -d '()'; }
# Taken from the raw sheet, not the run above: on a canonicalized export
# every live alias's canonical name is present by construction, so both
# counts collapse to near-nothing there and would read as "nothing to see".
# Kept, not discarded: the summary's bare-entry counts come from this pass, so
# throwing the body away would leave a reader with a number and no way to reach
# the rows behind it. The processed pass prints its own attribution under a
# "not evidence" banner, so it is no substitute.
#
# Warnings go to STDOUT, beside the numbers they qualify. fill_forward prints
# its degradation notice on stdout for that reason, and re-emitting on stderr
# would undo it: `npm run audit > report.txt` is the documented workflow, and a
# degraded run must not read as a clean one in the file.
RAW_OUT="$OUT/aliases-raw.txt"
if ! "${PY[@]}" scripts/audit_aliases.py archive/data-raw.csv > "$RAW_OUT" 2>"$OUT/raw.err"; then
    echo "  !! the raw-sheet pass FAILED — the counts below are missing, not zero:"
fi
# Printed whatever the exit status, because the degradation that matters most
# does not change it: slot_annotation_classes warns and returns {} on a node
# failure, every annotated slot reverts to positional classing, and the class
# keyed candidate sets — and so the verdicts below — quietly differ.
if [ -s "$OUT/raw.err" ]; then sed 's/^/     /' "$OUT/raw.err"; fi
RAWALIAS=$(cat "$RAW_OUT" 2>/dev/null || true)
if printf '%s' "$RAWALIAS" | grep -q 'could not fill-forward'; then
    echo "  !! fill-forward degraded on the raw pass — NEEDS MEMORY below is inflated."
fi

# The bare-entry findings the summary counts, printed from the raw pass so the
# rows are reachable. Everything else in that pass duplicates the run above.
rule "BARE NAMES        scripts/audit_aliases.py archive/data-raw.csv"
sed -n '/^-- bare entries whose alias contradicts the room/,/no alias was consulted/p' \
    "$RAW_OUT" 2>/dev/null || true

rule "SUMMARY"
# From the raw pass, like every other bare-name number here: a bare form an
# alias covers is GONE from the processed export, so its per-name list is
# systematically short — 10 names there against 12 raw, as it stands.
printf '  %-46s %s\n' \
  "bare names with 2+ candidates (for context)" "$(n_of 'bare names in the sheet with 2\+ candidates')" \
  "aliases keyed on an ambiguous first name" "$(n_of 'aliases keyed on an ambiguous first name')"
printf '  %-46s %s\n' \
  "aliases that are a surname's only record" "$(n_of 'ONLY record of a surname') (back up src/aliases.js)" \
  "aliases pointing at an unrelated name" "$(n_of 'absent and unrelated')"
# Also from the raw pass, and for a sharper reason: attribution reads a bare
# name's teammates as evidence, and on the processed export those teammates
# were themselves supplied by the alias under test. A wrong alias would vote
# to confirm itself, so a 0 there is not evidence of anything.
printf '  %-46s %s\n' \
  "bare entries nobody has decided (NEEDS MEMORY)" "$(n_of 'bare entries nobody has decided')" \
  "bare entries whose alias contradicts the room" "$(n_of 'whose alias contradicts the room')" \
  "bare entries resolved but not aliased" "$(n_of 'resolves but no alias covers')"
printf '  %-46s %s\n' \
  "under-logged, ensemble stated (NEEDS MEMORY)" "$(count 'title states the ensemble' "$OUT/ensembles.txt")" \
  "piano works with nobody marked at the keyboard" "$(count 'UNANNOTATED PIANO WORKS' "$OUT/ensembles.txt")"
printf '  %-46s %s\n' \
  "rows that dropped an Others? player (mechanical)" \
  "$(grep -oE '^[0-9]+ rows in' "$OUT/fillforward.txt" | grep -oE '[0-9]+' | head -1)"
echo
echo "  Lines marked NEEDS MEMORY are the ones that get harder to answer the"
echo "  longer they wait. The rest can safely accumulate — a dropped Others?"
echo "  player is recoverable from the row above it whenever you get to it."
