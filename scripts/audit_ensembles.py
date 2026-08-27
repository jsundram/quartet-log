#!/usr/bin/env python3
"""Audit ensemble headcounts in the music-log CSV.

Every row implies an ensemble size: a piano trio needs 3 players, a quartet 4,
a quintet 5. When fewer people are logged than the work needs, somebody went
unrecorded — most often the pianist, because the sheet's three player slots
model a string quartet and a piano ensemble has no seat for them.

Two independent problems, reported separately:

  UNDER-LOGGED   fewer people in the row than the work requires. The missing
                 person is absent from every stat. Only you can fill these in,
                 and reconstructing from memory years later is guesswork — a
                 row that is honestly incomplete beats an invented one.

  UNANNOTATED    a piano work where nobody carries a "(piano)"-style
                 annotation. The headcount may be right while the pianist sits
                 in a string seat, so they are counted as a violinist or a
                 cellist. Fixable in place: annotate the slot, e.g.
                 "Alice Hart" -> "Alice Hart (p)".

Usage: python scripts/audit_ensembles.py [path/to/data.csv]
       (defaults to archive/data.csv)
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit_aliases import load_rows, parse_others  # noqa: E402

# Ensemble words that appear in Work Title, mapped to how many people play.
ENSEMBLE_SIZES = {
    "duo": 2, "duet": 2, "trio": 3, "quartet": 4, "quintet": 5,
    "sextet": 6, "septet": 7, "octet": 8, "nonet": 9,
}
ENSEMBLE_RE = re.compile("|".join(ENSEMBLE_SIZES), re.I)
# Two different jobs, two different patterns. Work titles are matched loosely
# ("Brahms Piano Quartet 1"); instrument annotations are matched anchored, so
# the "p" shorthand this log actually uses is recognized without "p" swallowing
# every instrument that merely starts with one.
TITLE_KEYBOARD_RE = re.compile(r"piano|klavier|harpsichord|fortepiano", re.I)
ANNOT_KEYBOARD_RE = re.compile(
    r"^(?:p|pf|pno|piano|klavier|fortepiano|harpsichord|keyboard|organ)(?![a-z])",
    re.I)


def expected_size(row: dict) -> tuple[int, bool]:
    """(people the work needs, whether it was stated rather than assumed).

    Work Title is often a catalogue number — "K478", "20#4" — with the
    ensemble named only in Comments ("Piano Quartet"), so both fields are
    searched. Absent any ensemble word we assume a quartet, which is the log's
    bread and butter, but flag the assumption so those rows triage separately.
    """
    for field in ("Work Title", "Comments"):
        m = ENSEMBLE_RE.search(row.get(field) or "")
        if m:
            return ENSEMBLE_SIZES[m.group(0).lower()], True
    return 4, False


def mentions_keyboard(row: dict) -> bool:
    """A keyboard work? Same reasoning as expected_size: the giveaway is as
    often in Comments as in Work Title."""
    return any(TITLE_KEYBOARD_RE.search(row.get(f) or "")
               for f in ("Work Title", "Comments"))


def logged_people(row: dict) -> int:
    """The logger plus everyone they recorded. '-' marks a seat the work
    doesn't have, and is not a person (mirrors peopleKeysFor)."""
    slots = sum(
        1 for i in (1, 2, 3)
        if (row.get(f"Player {i}") or "").strip() not in ("", "-")
    )
    others = len(parse_others(row.get("Others?") or row.get("Others") or ""))
    return 1 + slots + others


SLOT_ANNOTATION_RE = re.compile(r"^(.+?)\s*\(([^)]+)\)\s*$")


def slot_instrument(value: str) -> str | None:
    """Mirror instrumentFromSlot in src/dataProcessor.js: pull the
    "(instrument)" suffix off a player slot, keeping only what precedes the
    first comma."""
    m = SLOT_ANNOTATION_RE.match((value or "").strip())
    if not m:
        return None
    inside = m.group(2)
    comma = inside.find(",")
    return (inside[:comma] if comma >= 0 else inside).strip() or None


def has_keyboard_annotation(row: dict) -> bool:
    """Is anyone in the row marked as the keyboard player? Player slots count
    as well as Others?, since an annotated slot is now honored (see
    instrumentFromSlot in src/dataProcessor.js)."""
    instruments = [slot_instrument(row.get(f"Player {i}") or "") for i in (1, 2, 3)]
    instruments += [
        instrument for _, instrument in parse_others(
            row.get("Others?") or row.get("Others") or "")
    ]
    return any(i and ANNOT_KEYBOARD_RE.match(i) for i in instruments)


def describe(row: dict) -> str:
    slots = " | ".join(
        (row.get(f"Player {i}") or "").strip() or "∅" for i in (1, 2, 3))
    others = (row.get("Others?") or row.get("Others") or "").strip() or "∅"
    return (f"part={(row.get('Which Part') or '?'):4s} slots=[{slots}]  "
            f"others={others}")


def main() -> None:
    csv_path = Path(sys.argv[1] if len(sys.argv) > 1 else "archive/data.csv")
    if not csv_path.exists():
        print(f"CSV not found: {csv_path}", file=sys.stderr)
        sys.exit(1)
    rows = load_rows(csv_path)

    explicit_short, assumed_short, unannotated = [], [], []
    for row in rows:
        need, stated = expected_size(row)
        got = logged_people(row)
        if got < need:
            (explicit_short if stated else assumed_short).append((row, need, got))
        if mentions_keyboard(row) and not has_keyboard_annotation(row):
            unannotated.append(row)

    print(f"Rows: {len(rows)}\n")

    print(f"=== UNDER-LOGGED: title states the ensemble ({len(explicit_short)}) ===")
    print("Someone is missing from these rows. Reconstruct only what you're sure of.\n")
    for row, need, got in explicit_short:
        print(f"  {(row.get('Timestamp') or '')[:10]:10s} "
              f"{(row.get('Composer') or ''):14.14s} "
              f"{(row.get('Work Title') or ''):26.26s} needs {need}, logged {got}")
        print(f"             {describe(row)}")

    print(f"\n=== UNANNOTATED PIANO WORKS ({len(unannotated)}) ===")
    print("Headcount may be fine, but nobody is marked as the keyboard player,")
    print("so they are counted as a string player. Annotate the slot in place.\n")
    by_work: Counter = Counter()
    for row in unannotated:
        by_work[(row.get("Composer"), row.get("Work Title"))] += 1
        print(f"  {(row.get('Timestamp') or '')[:10]:10s} "
              f"{(row.get('Composer') or ''):14.14s} "
              f"{(row.get('Work Title') or ''):26.26s} {describe(row)}")

    print(f"\n=== UNDER-LOGGED: ensemble assumed to be a quartet ({len(assumed_short)}) ===")
    print("The title names no ensemble, so 4 is a guess — duos, sight-reading")
    print("sessions and partial groups land here legitimately. Skim, don't trust.\n")
    counts = Counter(got for _, _, got in assumed_short)
    for got, n in sorted(counts.items()):
        print(f"  {n:4d} rows logged {got} of an assumed 4")


if __name__ == "__main__":
    main()
