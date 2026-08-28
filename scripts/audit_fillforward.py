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


def session_window_report(rows: list[dict]) -> None:
    """Check SESSION_WINDOW_HOURS against the log instead of asserting it.

    The window does NOT bound how long a session may run. It bounds the gap
    between one logged piece and the next, so an all-day session logged as you
    go never approaches it however long the day was — the measurement below is
    of consecutive-entry gaps, not of sessions.

    What it costs to be too short is worse than one row. A continuation row
    outside the window falls through to the branch that assigns the entry it
    was given — an empty string — and that empty string becomes the anchor for
    everything after it, so the rest of the day inherits nothing. A dinner
    break can therefore blank an entire evening. Those follow-on rows are
    counted here, since they are the real cost of the constant.
    """
    gaps, outside = [], []
    prev = None
    for row in rows:
        if prev is not None:
            gap = (row["_t"] - prev["_t"]).total_seconds() / 3600
            if gap >= 0 and all(s == "" for s in slots(row)):
                gaps.append(gap)
                if gap >= SESSION_WINDOW_HOURS:
                    outside.append((gap, row))
        prev = row
    if not gaps:
        return
    ordered = sorted(gaps)

    def pct(p: float) -> float:
        return ordered[min(len(ordered) - 1, int(len(ordered) * p / 100))]

    print(f"\n=== SESSION WINDOW (currently {SESSION_WINDOW_HOURS}h) ===")
    print(f"Gaps between a continuation row and the one before it, {len(gaps)} of them.")
    print("This is the gap between consecutive entries, not the length of a")
    print("session: an all-day session logged as you go never approaches it.\n")
    print("  median {:.2f}h   p90 {:.2f}h   p99 {:.2f}h   max {:.2f}h".format(
        pct(50), pct(90), pct(99), max(ordered)))
    print("\n  window   continuation rows left outside")
    for w in (1, 2, 3, 4, 6, 12, 24):
        n = sum(1 for g in ordered if g >= w)
        mark = "  <- current" if w == SESSION_WINDOW_HOURS else ""
        print(f"  {w:2d}h      {n:4d}  ({n / len(ordered):.1%}){mark}")
    print("\nAnything in the flat part of that curve behaves alike; the value only")
    print("matters where the curve is still falling.")

    if not outside:
        print("\nNo continuation row falls outside the window.")
        return
    print(f"\n{len(outside)} row(s) fall outside it, and each blanks the rows after it")
    print("until someone types a name again:")
    index = {id(r): i for i, r in enumerate(rows)}
    for gap, row in outside:
        i = index[id(row)]
        trailing = 0
        for nxt in rows[i + 1:]:
            if not all(s == "" for s in slots(nxt)):
                break
            trailing += 1
        print(f"   after a {gap:.2f}h gap  {label(row)}")
        if trailing:
            print(f"   {'':17s} + {trailing} following row(s) inherit the blank")


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "archive/data-raw.csv")
    if not path.exists():
        print(f"CSV not found: {path}\nRun scripts/fetch_raw.sh first.",
              file=sys.stderr)
        sys.exit(1)
    rows = load(path)
    session_window_report(rows)
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
