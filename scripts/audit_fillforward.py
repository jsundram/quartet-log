#!/usr/bin/env python3
"""Find rows that lost an Others? player to fill-forward.

fillForward (src/dataProcessor.js) carries player1/2/3 and location down to
the next row in a session, so a row left blank repeats whoever was there
before. It does NOT carry `others`. A session logged the natural way — spell
the group out once, then leave the slots blank for each following piece —
therefore keeps the quartet but silently drops the second violist, the extra
cellist, the pianist.

MUST run against the RAW sheet (scripts/fetch_raw.sh -> archive/data-raw.csv).
The processed export has already been through fillForward, so the blank slots
that identify a continuation row are gone by then.

Only rows with EVERY player slot blank are reported: those unambiguously mean
"same group as before". A row that re-types some players may be deliberately
dropping the extra person, so those are left alone.

Usage: python scripts/audit_fillforward.py [path/to/data-raw.csv]
       (defaults to archive/data-raw.csv)
"""

from __future__ import annotations

import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SESSION_WINDOW_HOURS = 4  # mirrors SESSION_WINDOW_HOURS in src/dataProcessor.js
CATALOG = Path(__file__).resolve().parent.parent / "static/data/all_works.json"
# Parts that only exist in an ensemble larger than a quartet. A row naming one
# of these in Others? is a quintet/sextet; the next row need not be. "v2" is
# deliberately NOT here: a quartet has a second violin seat, so an Others? "v2"
# is a fifth body in the room rotating through, and the next quartet still has
# nowhere to put them — exactly the drop worth reporting.
EXTRA_STRING_RE = re.compile(r"^(?:va|vla|vc)\s*[2-9]\b|^v\s*[3-9]\b", re.I)
# A comment scoping the entry to particular movements — "(echoing v2, on I)",
# "(v1, shadowing on II, III)" — describes what someone did in THIS piece. It
# is the opposite of a standing arrangement, so it must not propagate.
SCOPED_RE = re.compile(r"\bon\s+[IVXivx]+\b|\bmvmts?\b|\bmovements?\b|\bonly\b",
                       re.I)


def load_catalog() -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    """(works needing 5+ players, works that are plain quartets).

    The catalog already knows: the "5+" tab lists the quintet and sextet
    repertoire, every other composer key lists that composer's quartets.
    """
    if not CATALOG.exists():
        return set(), set()
    data = json.loads(CATALOG.read_text())
    big, quartets = set(), set()
    for key, entries in data.items():
        if key == "5+":
            for group in entries:
                for composer, titles in group.items():
                    big.update((composer, title) for title in titles)
        elif isinstance(entries, list) and entries and isinstance(entries[0], str):
            quartets.update((key, title) for title in entries)
    return big, quartets


def needs_the_extra_player(row: dict, others: str,
                           big: set, quartets: set) -> bool:
    """Would the continuation row's work still seat whoever was in Others??

    Suppress only on positive evidence: the work is a known quartet AND every
    dropped entry is an extra-string part that a quartet has no seat for. A
    sextet followed by a quartet really does lose its second viola, and
    reporting that as a mistake sends someone to "fix" correct data. Anything
    unrecognised is still reported — a pianist is not inferable this way, and
    "Horn Trio (with cello)" names no keyboard while needing one.
    """
    work = ((row.get("Composer") or "").strip(), (row.get("Work Title") or "").strip())
    if work in big or work not in quartets:
        return True
    parts = []
    for frag in re.split(r"[;,](?![^(]*\))", others):
        m = re.match(r"^.+?\(([^)]+)\)", frag.strip())
        inside = m.group(1) if m else ""
        # A scoped entry argues for nothing: drop it and let the rest of the
        # line decide. Suppressing the whole row on one is what hid the
        # pianist in "Eve (v1, on II, III); Fred (p)" — the second entry is
        # a standing member of the group and the next row loses them.
        if SCOPED_RE.search(inside):
            continue
        parts.append(inside.split(",")[0].strip())
    # No unscoped entry left (every one was movement-scoped) means nothing was
    # dropped that should carry, so suppress rather than report.
    return bool(parts) and not all(EXTRA_STRING_RE.match(p) for p in parts)


def load(path: Path) -> list[dict]:
    rows = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            stamp = (row.get("Timestamp") or "").strip()
            try:
                row["_t"] = datetime.strptime(stamp, "%m/%d/%Y %H:%M:%S")
            except ValueError:
                continue
            rows.append(row)
    rows.sort(key=lambda r: r["_t"])
    return rows


def slots(row: dict) -> list[str]:
    return [(row.get(f"Player {i}") or "").strip() for i in (1, 2, 3)]


def label(row: dict) -> str:
    return (f"{row['_t']:%-m/%-d/%Y %H:%M}  "
            f"{(row.get('Composer') or '').strip()} "
            f"{(row.get('Work Title') or '').strip()}")


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "archive/data-raw.csv")
    if not path.exists():
        print(f"CSV not found: {path}\nRun scripts/fetch_raw.sh first.",
              file=sys.stderr)
        sys.exit(1)
    rows = load(path)
    big, quartets = load_catalog()

    sessions: dict[str, list[dict]] = {}
    order: list[str] = []
    anchor = None
    for row in rows:
        blank = all(s == "" for s in slots(row))
        others = (row.get("Others?") or "").strip()
        if anchor is not None:
            gap = (row["_t"] - anchor["_t"]).total_seconds() / 3600
            anchor_others = (anchor.get("Others?") or "").strip()
            if blank and not others and anchor_others \
                    and 0 <= gap < SESSION_WINDOW_HOURS \
                    and needs_the_extra_player(row, anchor_others, big, quartets):
                key = label(anchor)
                if key not in sessions:
                    sessions[key] = []
                    order.append(key)
                sessions[key].append(row)
        if others or any(slots(row)):
            anchor = row

    total = sum(len(v) for v in sessions.values())
    # processData drops any row whose title contains ':' as a partial movement,
    # so fixing those changes nothing downstream — worth saying rather than
    # sending someone to edit rows that cannot affect a statistic.
    def is_partial(row: dict) -> bool:
        return ":" in (row.get("Work Title") or "")
    skippable = sum(1 for v in sessions.values() for r in v if is_partial(r))
    print(f"{total} rows in {len(sessions)} sessions dropped an Others? player.")
    print(f"{total - skippable} of them affect your stats; the other {skippable} are "
          "partial movements,\nwhich processData drops anyway (marked [partial] below).")
    print("Copy the Others? value from the anchor row into each row beneath it.\n")
    for key in order:
        anchor_row = next(r for r in rows if label(r) == key)
        print(f"  ANCHOR  {key}")
        print(f"          Others? = {(anchor_row.get('Others?') or '').strip()!r}")
        for row in sessions[key]:
            mark = "  [partial]" if is_partial(row) else ""
            print(f"    fill  {label(row)}{mark}")
        print()


if __name__ == "__main__":
    main()
