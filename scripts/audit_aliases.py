#!/usr/bin/env python3
"""Audit player-name variants in the music-log CSV.

Mirrors slot-class + Others? parsing from src/dataProcessor.js, then groups
variants by lowercased first-token and reports occurrence counts and top
co-occurring teammates per (variant, class) so you can decide which short
forms belong in PLAYER_ALIASES.

Usage: python scripts/audit_aliases.py [path/to/data.csv]
       (defaults to archive/data.csv)
"""

from __future__ import annotations

import csv
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Mirror src/config.js
ABBREVIATIONS = {"I": "Isaac", "E": "Elaine", "S": "Shay", "J": "Josh"}
EXISTING_ALIASES = {
    "Aaron": {"upper": "Aaron Johnson"},
    "Al": {"upper": "Al Leisinger"},
    "Brian": {"upper": "Brian Clague"},
    "Clayton": {"upper": "Clayton Bullock"},
    "Cyrus": {"cello": "Cyrus Behroozi"},
    "David": {"upper": "David Sanders"},
    "Hans": {"cello": "Hans Brightbill"},
    "Helen": {"upper": "Helen Kim"},
    "Henry": {"upper": "Henry Weinberger"},
    "Isaac": {"upper": "Isaac Krauss"},
    "Jen": {"upper": "Jen Hsiao", "cello": "Jen Minnich"},
    "Jennifer Minnich": {"cello": "Jen Minnich"},
    "Jess": {"upper": "Jess Lin"},
    "Josie": {"upper": "Josie Stein"},
    "Justin": {"upper": "Justin Ouellet"},
    "Lauren": {"upper": "Lauren Alter"},
    "Louisa": {"cello": "Louisa Krauss"},
    "Marie": {"upper": "Marie Ihnen"},
    "Matthew": {"upper": "Matthew Liebendorfer"},
    "Paul": {"cello": "Paul Mattal"},
    "Peter": {"upper": "Peter Ouyang"},
    "Peter O": {"upper": "Peter Ouyang"},
    "Sarah": {"upper": "Sarah Emmert"},
    "Susie": {"upper": "Susie Ikeda"},
    "Will": {"upper": "Will Davis"},
}

# Slot semantics from src/dataProcessor.js
SLOT_CLASS = ["upper", "upper", "cello"]


def class_of(instrument: str | None) -> str | None:
    if not instrument:
        return None
    return "cello" if instrument.lower().strip().startswith("vc") else "upper"


def parse_others(others: str) -> list[tuple[str, str | None]]:
    if not others:
        return []
    out = []
    for frag in re.split(r"[;,]", others):
        frag = frag.strip()
        if not frag or frag == "-":
            continue
        m = re.match(r"^(.+?)\s*\(([^)]+)\)\s*$", frag)
        if m:
            out.append((m.group(1).strip(), m.group(2).strip()))
        else:
            out.append((frag, None))
    return out


def expand_abbrev(name: str) -> str:
    return ABBREVIATIONS.get(name, name)


def strip_parens(name: str) -> str:
    """Mirror stripParens in src/dataProcessor.js — drops a trailing (instrument)."""
    m = re.match(r"^(.+?)\s*\(([^)]+)\)\s*$", name or "")
    return m.group(1).strip() if m else (name or "")


def load_rows(path: Path) -> list[dict]:
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        return [r for r in reader if r.get("Timestamp")]


def collect_appearances(rows: list[dict]) -> dict[tuple[str, str], list[list[str]]]:
    """For each (name, class) pair, return list of teammate-lists from each appearance."""
    appearances: dict[tuple[str, str], list[list[str]]] = defaultdict(list)
    for row in rows:
        # Build list of (name, class) seen in this row
        people: list[tuple[str, str]] = []
        for i in range(3):
            raw = (row.get(f"Player {i + 1}") or "").strip()
            if raw and raw != "-":
                people.append((expand_abbrev(strip_parens(raw)), SLOT_CLASS[i]))
        for name, instr in parse_others(row.get("Others?") or ""):
            cls = class_of(instr)
            if name and cls:
                people.append((expand_abbrev(name), cls))
        for name, cls in people:
            teammates = [n for n, _ in people if n != name]
            appearances[(name, cls)].append(teammates)
    return appearances


def teammate_counter(appearances: list[list[str]]) -> Counter:
    c: Counter = Counter()
    for tms in appearances:
        for t in tms:
            c[t] += 1
    return c


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


def base_token(name: str) -> str:
    """Lowercased first whitespace-stripped token — groups 'Jen', 'Jen Hsiao', 'jen ' together."""
    parts = name.strip().split()
    return parts[0].lower() if parts else name.lower()


def already_aliased(variant: str, cls: str) -> bool:
    return variant in EXISTING_ALIASES and cls in EXISTING_ALIASES[variant]


def main() -> None:
    csv_path = Path(sys.argv[1] if len(sys.argv) > 1 else "archive/data.csv")
    if not csv_path.exists():
        print(f"CSV not found: {csv_path}", file=sys.stderr)
        sys.exit(1)

    rows = load_rows(csv_path)
    appearances = collect_appearances(rows)
    print(f"Rows: {len(rows)}    Unique (name, class) pairs: {len(appearances)}\n")

    # Group by base token to find variants
    groups: dict[str, list[tuple[str, str, int, list[list[str]]]]] = defaultdict(list)
    for (name, cls), apps in appearances.items():
        groups[base_token(name)].append((name, cls, len(apps), apps))

    proposals: dict[str, dict[str, str]] = {}

    for base in sorted(groups):
        variants = groups[base]
        # Only interesting if more than one distinct (name, class) shares the base
        distinct_names = {v[0] for v in variants}
        if len(distinct_names) <= 1 and len(variants) <= 1:
            continue
        # Skip if the only variation is whitespace-stripped duplicates of one name
        if len({v[0].strip() for v in variants}) <= 1 and len({v[1] for v in variants}) <= 1:
            continue

        print(f"=== '{base}' ({len(variants)} variants) ===")
        variants.sort(key=lambda v: -v[2])
        for name, cls, count, apps in variants:
            tms = teammate_counter(apps).most_common(5)
            tm_str = ", ".join(f"{n}×{c}" for n, c in tms)
            marker = " *seeded*" if already_aliased(name, cls) else ""
            print(f"  {name!r:35s} [{cls:5s}] {count:4d}×{marker}   teammates: {tm_str}")

        # Propose: within each class, the longest-multi-token name is canonical;
        # shorter names mapping into it require teammate-overlap > threshold.
        by_class: dict[str, list[tuple[str, int, list[list[str]]]]] = defaultdict(list)
        for name, cls, count, apps in variants:
            by_class[cls].append((name, count, apps))

        for cls, vs in by_class.items():
            # Canonical = the variant with the most whitespace-separated tokens,
            # tie-broken by count. Heuristic for full-name preference.
            vs_sorted = sorted(vs, key=lambda v: (-len(v[0].split()), -v[1]))
            canonical_name, canonical_count, canonical_apps = vs_sorted[0]
            canon_tms = set(teammate_counter(canonical_apps))
            for variant_name, vcount, vapps in vs_sorted[1:]:
                if variant_name.strip() == canonical_name.strip():
                    continue  # pure whitespace dup
                v_tms = set(teammate_counter(vapps))
                overlap = jaccard(canon_tms, v_tms)
                # Auto-skip if EXISTING_ALIASES already covers this variant+class
                if already_aliased(variant_name, cls):
                    continue
                # Heuristic threshold; user reviews
                evidence = f"overlap={overlap:.0%}, {vcount}×"
                if overlap >= 0.20:
                    proposals.setdefault(variant_name, {})[cls] = canonical_name
                    print(
                        f"    → propose {variant_name!r} [{cls}] → {canonical_name!r}  ({evidence})"
                    )
                else:
                    print(
                        f"    ? skip   {variant_name!r} [{cls}] vs {canonical_name!r}  ({evidence})"
                    )
        print()

    # Review section: every short variant that *might* alias to a longer name
    # in the same class, regardless of teammate overlap. Sorted by short-variant
    # count desc so you triage high-impact cases first. Already-mapped pairs
    # are excluded. Use this when the auto-proposals miss obvious ones (e.g.
    # short-form data that comes from a different period than the long form).
    print("\n=== REVIEW: candidate aliases sorted by short-form count ===")
    print("(Eyeball — accept the real ones, ignore homonyms. Format: short → candidate)\n")
    review_rows: list[tuple[int, str, str, str, int, float]] = []
    for base, variants in groups.items():
        by_class: dict[str, list[tuple[str, int, list[list[str]]]]] = defaultdict(list)
        for name, cls, count, apps in variants:
            by_class[cls].append((name, count, apps))
        for cls, vs in by_class.items():
            if len(vs) < 2:
                continue
            # Within a class, every shorter variant is a candidate for every longer one.
            for short_name, scount, sapps in vs:
                for long_name, lcount, lapps in vs:
                    if long_name == short_name:
                        continue
                    if len(short_name.split()) >= len(long_name.split()):
                        continue
                    if already_aliased(short_name, cls):
                        continue
                    overlap = jaccard(
                        set(teammate_counter(sapps)), set(teammate_counter(lapps))
                    )
                    review_rows.append((scount, cls, short_name, long_name, lcount, overlap))
    review_rows.sort(key=lambda r: (-r[0], r[2]))
    for scount, cls, short_name, long_name, lcount, overlap in review_rows:
        marker = "✓" if overlap >= 0.20 else " "
        print(
            f"  {marker} [{cls:5s}] {short_name!r:30s} ({scount:3d}×)  →  "
            f"{long_name!r}  ({lcount}×, overlap {overlap:.0%})"
        )

    # Final paste-ready PLAYER_ALIASES block
    print("\n=== PLAYER_ALIASES proposal (paste-ready) ===\n")
    print("export const PLAYER_ALIASES = {")
    # Re-emit the seed first
    for k in sorted(EXISTING_ALIASES):
        body = ", ".join(f'{cls}: "{n}"' for cls, n in sorted(EXISTING_ALIASES[k].items()))
        print(f'    "{k}": {{ {body} }},')
    for k in sorted(proposals):
        if k in EXISTING_ALIASES:
            merged = {**EXISTING_ALIASES[k], **proposals[k]}
            body = ", ".join(f'{cls}: "{n}"' for cls, n in sorted(merged.items()))
            # already emitted above; skip duplicate
            continue
        body = ", ".join(f'{cls}: "{n}"' for cls, n in sorted(proposals[k].items()))
        print(f'    "{k}": {{ {body} }},')
    print("};")


if __name__ == "__main__":
    main()
