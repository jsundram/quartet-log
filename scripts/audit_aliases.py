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
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_alias_tables() -> tuple[dict[str, dict[str, str]], dict[str, str]]:
    """Read PLAYER_ALIASES + PLAYER_ABBREVIATIONS from src/aliases.js by
    asking Node to evaluate it.

    Single source of truth: the JS module. Prevents drift between the
    runtime aliases and what this audit considers "already covered".
    The real tables live in the gitignored src/aliases.js;
    scripts/ensure_aliases.mjs is run first so a fresh clone gets the
    empty stub instead of an import error — the audit warns below if the
    tables it loaded are empty (i.e. you're auditing against the stub).
    """
    js = (
        "import('./src/aliases.js')"
        ".then(m => process.stdout.write(JSON.stringify("
        "{aliases: m.PLAYER_ALIASES, abbreviations: m.PLAYER_ABBREVIATIONS})))"
        ".catch(e => { console.error(e.message); process.exit(1); })"
    )
    try:
        subprocess.run(
            ["node", "scripts/ensure_aliases.mjs"],
            capture_output=True, text=True, check=True, cwd=REPO_ROOT,
        )
        result = subprocess.run(
            ["node", "-e", js],
            capture_output=True, text=True, check=True, cwd=REPO_ROOT,
        )
    except FileNotFoundError:
        print("node is not on PATH — install Node.js to run the audit.", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"Failed to load alias tables from src/aliases.js:\n{e.stderr}",
              file=sys.stderr)
        sys.exit(1)
    tables = json.loads(result.stdout)
    return tables["aliases"], tables["abbreviations"]


EXISTING_ALIASES, ABBREVIATIONS = load_alias_tables()

if not EXISTING_ALIASES and not ABBREVIATIONS:
    print(
        "Warning: src/aliases.js has empty tables (the stub copy?) — every\n"
        "variant will look new and abbreviations won't expand. Put your real\n"
        "tables in src/aliases.js (gitignored) before trusting this audit.",
        file=sys.stderr,
    )

# Slot semantics from src/dataProcessor.js
SLOT_CLASS = ["upper", "upper", "cello"]


def class_of(instrument: str | None) -> str | None:
    if not instrument:
        return None
    return "cello" if instrument.lower().strip().startswith("vc") else "upper"


def _split_outside_parens(s: str) -> list[str]:
    """Split on ',' or ';' at paren depth 0 — mirrors splitOutsideParens
    in src/dataProcessor.js so a comma inside a "(instrument, comment)"
    annotation doesn't tear an entry in half."""
    parts: list[str] = []
    depth = 0
    start = 0
    for i, c in enumerate(s):
        if c == "(":
            depth += 1
        elif c == ")":
            depth = max(0, depth - 1)
        elif depth == 0 and c in ",;":
            parts.append(s[start:i])
            start = i + 1
    parts.append(s[start:])
    return parts


def parse_others(others: str) -> list[tuple[str, str | None]]:
    """Mirror parseOthers in src/dataProcessor.js: paren-aware top-level
    split, then inside the parens the first comma separates the instrument
    code from a free-form comment (only the instrument is kept)."""
    if not others:
        return []
    out = []
    for frag in _split_outside_parens(others):
        frag = frag.strip()
        if not frag or frag == "-":
            continue
        m = re.match(r"^(.+?)\s*\(([^)]+)\)\s*$", frag)
        if m:
            inside = m.group(2)
            comma_idx = inside.find(",")
            instrument = (inside[:comma_idx] if comma_idx >= 0 else inside).strip()
            out.append((m.group(1).strip(), instrument))
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
        # The canonical header is "Others?" (see src/csvFormat.js), but
        # exports written before the header fix used "Others" — accept both.
        for name, instr in parse_others(row.get("Others?") or row.get("Others") or ""):
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
    """Lowercased first whitespace-stripped token — groups 'Jo', 'Jo Alpha', 'jo ' together."""
    parts = name.strip().split()
    return parts[0].lower() if parts else name.lower()


def already_aliased(variant: str, cls: str) -> bool:
    return variant in EXISTING_ALIASES and cls in EXISTING_ALIASES[variant]


def report_ambiguity(appearances: dict[tuple[str, str], list[list[str]]]) -> None:
    """Flag first names that no longer identify exactly one person.

    The variant grouping above answers "which short forms belong in
    PLAYER_ALIASES". This answers the complementary question: which short
    forms must NOT go in, because an alias maps one name to one person and
    the sheet now holds several people who share it.

    Three hazards, none of them visible in the grouping above:
      1. A bare first name still in the sheet that two or more full names
         could match. No alias can express "this row is Alice Hart and that
         one is Alice Bek" — the ROWS have to be edited.
      2. An existing alias keyed on such a name. It resolves silently, so
         every future bare entry lands on whichever person the table names.
      3. An alias whose canonical name appears nowhere in the sheet —
         usually a spelling fix that was applied to the data but not here.

    Caveat: hazards 1 and 2 can only fire once the second full name shows up
    in the data. A short form that is genuinely ambiguous in real life still
    looks unique here until someone with the same first name gets logged.
    """
    full_by_first: dict[str, set[str]] = defaultdict(set)
    bare_count: Counter = Counter()
    present: set[str] = set()
    for (name, cls), apps in appearances.items():
        present.add(name)
        if len(name.split()) > 1:
            full_by_first[base_token(name)].add(name)
        else:
            bare_count[(name, cls)] += len(apps)

    print("\n=== AMBIGUITY: first names that no longer identify one person ===")
    print("(Hazards the variant grouping above cannot see.)")

    # 1. Bare names still in the sheet that several full names could match.
    unresolvable = sorted(
        (
            (n, cls, cnt, sorted(full_by_first[base_token(n)]))
            for (n, cls), cnt in bare_count.items()
            if len(full_by_first.get(base_token(n), ())) >= 2
        ),
        key=lambda r: (-r[2], r[0]),
    )
    print(f"\n-- bare names in the sheet with 2+ candidates ({len(unresolvable)}) --")
    print("   Fix these in the SHEET; an alias can only guess one of them.")
    if not unresolvable:
        print("   (none)")
    for name, cls, count, candidates in unresolvable:
        mapped = EXISTING_ALIASES.get(name, {}).get(cls)
        note = f"alias says {mapped!r}" if mapped else "NO alias — counted as its own person"
        print(f"   {name!r:18s} [{cls:5s}] {count:4d}×   {note}")
        print(f"   {'':18s}         candidates: {', '.join(candidates)}")

    # 2. Aliases keyed on a first name several people now share. Multi-token
    # keys ("Jo A", "Jo Alpha") are already disambiguated, so skip them.
    risky = sorted(
        (key, mapping, sorted(full_by_first[key.lower()]))
        for key, mapping in EXISTING_ALIASES.items()
        if len(key.split()) == 1 and len(full_by_first.get(key.lower(), ())) >= 2
    )
    print(f"\n-- aliases keyed on an ambiguous first name ({len(risky)}) --")
    print("   Each silently resolves future bare entries to one person.")
    if not risky:
        print("   (none)")
    for key, mapping, candidates in risky:
        targets = ", ".join(f"{cls}→{n}" for cls, n in sorted(mapping.items()))
        others = [c for c in candidates if c not in mapping.values()]
        print(f"   {key!r:18s} {targets}")
        print(f"   {'':18s} also in sheet: {', '.join(others) or '—'}")

    # 3. Aliases pointing at a name the sheet no longer contains.
    dangling = sorted(
        (key, cls, canon)
        for key, mapping in EXISTING_ALIASES.items()
        for cls, canon in mapping.items()
        if canon not in present
    )
    print(f"\n-- aliases whose canonical name is absent from the sheet ({len(dangling)}) --")
    print("   Renamed or respelled in the data but not here?")
    if not dangling:
        print("   (none)")
    for key, cls, canon in dangling:
        near = sorted(full_by_first.get(base_token(canon), ()))
        hint = f"   did you mean: {', '.join(near)}" if near else ""
        print(f"   {key!r:18s} [{cls:5s}] -> {canon!r}{hint}")


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

    report_ambiguity(appearances)

    # Final paste-ready PLAYER_ALIASES block
    print("\n=== PLAYER_ALIASES proposal (paste into src/aliases.js — gitignored; NEVER into a tracked file) ===\n")
    print("export const PLAYER_ALIASES = {")
    # Re-emit the seed first, folding in any newly proposed classes for
    # existing keys (seed mappings win on conflict — proposals are heuristic).
    for k in sorted(EXISTING_ALIASES):
        merged = {**proposals.get(k, {}), **EXISTING_ALIASES[k]}
        body = ", ".join(f'{cls}: "{n}"' for cls, n in sorted(merged.items()))
        print(f'    "{k}": {{ {body} }},')
    for k in sorted(proposals):
        if k in EXISTING_ALIASES:
            continue
        body = ", ".join(f'{cls}: "{n}"' for cls, n in sorted(proposals[k].items()))
        print(f'    "{k}": {{ {body} }},')
    print("};")

    if proposals:
        print(
            "\nAfter updating src/aliases.js, sync the deploy secret so the next\n"
            "deploy uses the new tables:  ./scripts/push_aliases.sh"
        )


if __name__ == "__main__":
    main()
