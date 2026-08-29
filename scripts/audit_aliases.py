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
import io
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

# The class of an Others? entry that names no instrument. Not a real class —
# the app cannot alias such an entry either (canonicalize with a null class is
# a no-op) — but a key it can be indexed under, so it appears in the per-name
# list and can be a candidate for any subject, instead of vanishing.
ANY_CLASS = "any"

# How many times a full name must appear, written out, before its teammate
# circle counts as evidence in attribute_bare_entries. The people most often
# logged bare are exactly the ones whose full name is rarest, so below this a
# non-match means "we have never seen this person named", not "not them".
MIN_WRITTEN_IN_FULL = 5


# Mirrors CELLO_INSTRUMENT in src/dataProcessor.js, including the (?![a-z])
# guard that stops "c" swallowing "clarinet". Tested against the real classOf
# in test/test_audits.py, which is what caught this reading "(cello)" as an
# upper part while the app read it as a cellist.
CELLO_INSTRUMENT = re.compile(r"^(?:vc|vlc|cello|violoncello|c)(?![a-z])", re.I)


def class_of(instrument: str | None) -> str | None:
    if not instrument:
        return None
    # Anchored, any whitespace run — normalizeInstrument in dataProcessor is
    # /^as?st\s+/, and "asst  vc" with two spaces must strip the same way.
    s = re.sub(r"^as?st\s+", "", instrument.lower().strip())
    return "cello" if CELLO_INSTRUMENT.match(s) else "upper"


def slot_annotation_classes(values: set[str]) -> dict[str, str]:
    """{slot value: instrument class} for slot values carrying a parenthetical.

    normalizePlayerNames classes an annotated slot by what it says it played,
    not by which column it landed in — but only when the parenthetical names
    an instrument, so "(sub)" stays positional. Mirroring that here would mean
    a third Python copy of instrumentFromSlot + classOf, this one carrying an
    instrument vocabulary that drifts the moment the JS list is edited. So ask
    the real module instead: the set is tiny (only slots with a parenthetical),
    which is one node call for the whole file.

    Falls back to {} — i.e. positional classing, as before — if node cannot
    answer, since this only refines a heuristic report.
    """
    if not values:
        return {}
    js = (
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>"
        "import('./src/dataProcessor.js').then(m => process.stdout.write("
        "JSON.stringify(Object.fromEntries(JSON.parse(s).map("
        "v => [v, m.classOf(m.instrumentFromSlot(v))])))))"
        ".catch(e => { console.error(e.message); process.exit(1); }))"
    )
    try:
        result = subprocess.run(
            ["node", "-e", js], input=json.dumps(sorted(values)),
            capture_output=True, text=True, check=True, cwd=REPO_ROOT,
        )
        return {k: v for k, v in json.loads(result.stdout).items() if v}
    except (OSError, subprocess.CalledProcessError, ValueError) as e:
        print(f"Note: could not class slot annotations via node ({e}); "
              "falling back to the slot position.", file=sys.stderr)
        return {}


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


def slot_classes_for(rows: list[dict]) -> dict[str, str]:
    """One node call for every slot value in the file that carries a paren."""
    annotated = {
        raw for row in rows for i in range(3)
        if "(" in (raw := (row.get(f"Player {i + 1}") or "").strip())
    }
    return slot_annotation_classes(annotated)


def row_people(row: dict, slot_classes: dict[str, str]) -> list[tuple[str, str, str]]:
    """(name, class, seat) for everyone in one row.

    The single reader of a row's cast, shared by the teammate index below and
    by attribute_bare_entries, so the two cannot disagree about who was there.

    `seat` identifies the cell — "p1".."p3" or "o0", "o1" for the parsed
    Others? entries. Attribution compares the same row before and after
    fill-forward, and needs to drop the subject's OWN cell from the evidence:
    when fill-forward resolved that very cell, comparing by name fails to
    exclude it (the written name is "Peter", the filled one "Peter Chan") and
    the subject is scored as its own stand-mate — for whichever rival happens
    to know the person it actually is.
    """
    people: list[tuple[str, str, str]] = []
    for i in range(3):
        raw = (row.get(f"Player {i + 1}") or "").strip()
        if raw and raw != "-":
            # An instrument annotation states the class; the column only
            # implies it (SLOT_CLASS). Same precedence as the app.
            cls = slot_classes.get(raw) or SLOT_CLASS[i]
            people.append((expand_abbrev(strip_parens(raw)), cls, f"p{i + 1}"))
    # The canonical header is "Others?" (see src/csvFormat.js), but exports
    # written before the header fix used "Others" — accept both.
    for i, (name, instr) in enumerate(
            parse_others(row.get("Others?") or row.get("Others") or "")):
        # class is None when the entry names no instrument. Kept anyway: a
        # name with no instrument still tells you who was in the room, which
        # is what the attribution below reads. Dropping them cost twice —
        # such a name was invisible as a subject (the app counts it as its own
        # person, so it belongs in a bucket) and missing as evidence, which
        # produced false NEEDS MEMORY on rows their presence would settle.
        if name:
            people.append((expand_abbrev(name), class_of(instr), f"o{i}"))
    return people


def fill_forward(rows: list[dict]) -> list[tuple[dict, dict]]:
    """Pair each row as written with the same row after fill-forward.

    The sheet's convention is to spell the group out once and leave the slots
    blank for the rest of the session, so a third of the raw file has empty
    player columns that nonetheless mean "same quartet". Attribution reads a
    bare name's stand-mates as its evidence, and on those rows there are none
    to read — the entry lands in "nobody has decided" while the row above
    names everyone who was there.

    Reading the raw sheet is required because of normalizePlayerNames, not
    fillForward, so run just the latter: the real one, via node, with an empty
    abbreviation table so nothing but the sheet's own repetition is filled in.
    Idempotent on the processed export, which has already been through it.

    Both versions are returned because they answer different questions. The
    filled row says who was in the room, which is the evidence. The row as
    written says which cells exist, which is what a finding can ask you to
    edit — a continuation row has no cell to fix, and reporting one sends you
    to a blank slot. Attribution reads the first and reports the second.
    """
    js = (
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>Promise.all(["
        "import('./src/dataProcessor.js'),import('./src/csvFormat.js')])"
        ".then(([dp,cf])=>{const {rows,dropped}=dp.prepareRows(JSON.parse(s).map(dp.processRow));"
        "const before=cf.serializeRows(rows);dp.fillForward(rows,{});"
        "process.stdout.write(JSON.stringify({before,after:cf.serializeRows(rows),dropped}));})"
        ".catch(e=>{console.error(e.message);process.exit(1);}))"
    )
    try:
        # csv.DictReader fills a short row's missing fields with None and
        # parks extra fields under a None key; processRow's `=== undefined`
        # guard lets null through and the first .trim() throws, so ONE
        # malformed line would cost every row its filled view — and a third of
        # the raw sheet is continuation rows that then look answerless.
        clean = [{k: (v or "") for k, v in r.items() if k} for r in rows]
        result = subprocess.run(
            ["node", "-e", js], input=json.dumps(clean),
            capture_output=True, text=True, check=True, cwd=REPO_ROOT,
        )
        out = json.loads(result.stdout)
        # prepareRows drops rows whose Timestamp will not parse as a Date, and
        # every section of this report now reads the rows it returns — so a
        # silent drop would shrink the variant grouping, the teammate counts
        # and the bare-name counts, and leave the printed row total quietly
        # disagreeing with the file. In a data-quality audit an unparseable
        # timestamp is itself a finding, so say so.
        if out.get("dropped"):
            print(f"\n  !! {out['dropped']} row(s) have a timestamp that will not"
                  " parse and are absent from\n     everything below — they are"
                  " dropped by the app too, so they count for nothing.")
        return list(zip(csv.DictReader(io.StringIO(out["before"])),
                        csv.DictReader(io.StringIO(out["after"]))))
    except (OSError, subprocess.CalledProcessError, ValueError) as e:
        # On stdout, not stderr: this lands inside the report a caller
        # captures, so a degraded run cannot be mistaken for a clean one.
        # Without fill-forward every continuation row loses its cast, and the
        # entries that depended on it inflate the NEEDS MEMORY count — the
        # opposite of what that flag is supposed to mean.
        why = (getattr(e, "stderr", "") or str(e)).strip().splitlines()
        print(f"\n  !! could not fill-forward via node ({why[-1] if why else e}) — continuation rows"
              "\n     lost their cast, so the counts below understate what is"
              "\n     answerable and overstate what needs memory.")
        return [(row, row) for row in rows]


def collect_appearances(rows: list[dict],
                       slot_classes: dict[str, str] | None = None
                       ) -> dict[tuple[str, str], list[list[str]]]:
    """For each (name, class) pair, return list of teammate-lists from each appearance.

    `slot_classes` costs a node subprocess over the whole file, so main computes
    it once and hands the same map to every reader.
    """
    appearances: dict[tuple[str, str], list[list[str]]] = defaultdict(list)
    if slot_classes is None:
        slot_classes = slot_classes_for(rows)
    for row in rows:
        people = row_people(row, slot_classes)
        for name, cls, seat in people:
            # Both tests are needed. The seat drops this very cell; the name
            # drops the SAME person written again elsewhere in the row — a
            # player slot and an Others? entry, which is how the rows that
            # overflow the quartet layout get logged. Without it circles[X]
            # contains X, and a bare name sitting beside its own full form
            # scores a point for being the person already named in that row.
            teammates = [n for n, _c, s2 in people if s2 != seat and n != name]
            appearances[(name, cls if cls is not None else ANY_CLASS)].append(
                teammates)
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


def _is_full_name(name: str) -> bool:
    """A written-out name, not a bare first name and not an initialled one.

    "Peter O" is Peter Ouyang with the surname abbreviated, not a second
    Peter; admitting it as a candidate invents a rival for the real person.
    """
    tokens = name.split()
    return len(tokens) > 1 and len(tokens[-1].rstrip(".")) > 1


def candidate_index(appearances: dict[tuple[str, str], list[list[str]]],
                    circle_appearances: dict[tuple[str, str], list[list[str]]] | None = None
                    ) -> tuple[dict[tuple[str, str], set[str]], dict[str, set[str]], Counter]:
    """Who a bare first name could be, plus the evidence about each.

    One definition, shared by both halves of the ambiguity report, so the
    "fix these in the sheet" list and the per-entry verdicts cannot disagree
    about the same name in the same output.

    Two exclusions, both of which would otherwise invent rivals:
      - a last token of one letter is a surname abbreviated ("Peter O" is
        Peter Ouyang, not a second Peter);
      - candidates are keyed by instrument class, the axis PLAYER_ALIASES is
        keyed on, so a cello-slot "Jo" never draws the upper-class Jo.

    Also returns each full name's teammate circle and how often it was written
    out, and those two want DIFFERENT views of the same rows.

    `written` counts must come from the rows AS WRITTEN: a typed name is
    evidence, an alias-supplied one is the hypothesis under test, and a
    fill-forwarded one is the sheet repeating itself — counting the last would
    let a name typed once in a five-piece session clear MIN_WRITTEN_IN_FULL
    five times over, which is the population the threshold protects against.

    `circles` are the opposite. Who someone played with is a fact about the
    room, and fill-forward is how the sheet states it: on the raw view a
    continuation row names nobody, so a full name written in its Others? cell
    would get an empty circle however many sessions it played, and every bare
    form it could settle would be reported as needing memory instead. Pass
    `circle_appearances` from the FILLED view for that reason.
    """
    if circle_appearances is None:
        circle_appearances = appearances
    by_first: dict[tuple[str, str], set[str]] = defaultdict(set)
    circles: dict[str, set[str]] = defaultdict(set)
    written: Counter = Counter()
    for (name, cls), apps in appearances.items():
        if _is_full_name(name):
            by_first[(base_token(name), cls)].add(name)
            written[name] += len(apps)
    for (name, _cls), apps in circle_appearances.items():
        if _is_full_name(name):
            circles[name].update(teammate_counter(apps))
    return by_first, circles, written


def candidates_for(by_first: dict[tuple[str, str], set[str]],
                   token: str, cls: str | None) -> set[str]:
    """Who a bare name in this class could be.

    Always includes the ANY_CLASS bucket: a full name written in an
    unannotated Others? cell has no class of its own, but it is still a person
    with that first name and so still a candidate. A subject with no class of
    its own draws from every bucket, since nothing narrows it.
    """
    if cls is None or cls == ANY_CLASS:
        return {c for (tok, _cls), names in by_first.items() if tok == token
                for c in names}
    return by_first.get((token, cls), set()) | by_first.get((token, ANY_CLASS), set())


def attribute_bare_entries(pairs: list[tuple[dict, dict]],
                           appearances: dict[tuple[str, str], list[list[str]]],
                           slot_classes: dict[str, str],
                           ) -> tuple[list, list, list, int, int, int]:
    """Decide, per entry, which of several same-first-name people a bare name is.

    "Which Alice was this" reads as a memory problem, and the name alone makes
    it one. The row is not alone though: two people who share a first name
    rarely share a stand, so the OTHER people in the row point at the one who
    was there, long after anyone could recall the evening.

    MUST be measured on the RAW sheet (scripts/fetch_raw.sh -> data-raw.csv).
    On the processed export the evidence has been rewritten by the very table
    under test: normalizePlayerNames has already replaced each bare slot name
    with whatever the alias guessed, so those rows have joined the guessed
    person's circle and vote to confirm the guess. A wrong alias would then
    look settled, and only Others? entries — exported verbatim — could ever
    disagree. Circles are built from explicitly-written full names only, for
    the same reason: a name someone typed in full is evidence, a name an alias
    supplied is the hypothesis.

    Returns (conflicts, unaliased, unsettled, unverified, settled,
    resolved_by_sheet):
      conflicts  the room points somewhere other than the alias, so the entry
                 is credited to the wrong person today. Fix the sheet cell.
      unaliased  the room names someone but no alias covers this bare name, so
                 the app counts the bare form as a separate person in every
                 people stat. Also a sheet fix, and the largest bucket.
      unsettled  no candidate's circle matches AND no alias has ever decided
                 it. Nobody has answered these, and nobody else can: the only
                 entries that truly need memory.
      unverified count of entries with no usable evidence but an alias already
                 standing. Not work — the alias is the best available answer
                 and this run simply cannot second-guess it. Kept apart from
                 `unsettled` because presenting 400 of these as NEEDS MEMORY
                 is as misleading as reporting none.
      settled    count of entries the room settles in agreement with the table.
                 Not listed: nothing to do, and listing them buries the rest.
      resolved_by_sheet
                 count of cells fill-forward already answered, where no table
                 was consulted at all. Kept apart from `settled` so the report
                 does not credit src/aliases.js with fill-forward's work.
    """
    full_by_first, circles, written = candidate_index(
        appearances, collect_appearances([f for _w, f in pairs], slot_classes))

    conflicts, unaliased, unsettled = [], [], []
    unverified = settled = resolved_by_sheet = 0
    for row, filled in pairs:
        # Evidence from the filled row, subjects from the row as written: a
        # continuation row's blank slot is not a cell anyone can go and fix.
        cast = row_people(filled, slot_classes)
        by_seat = {seat: n for n, _c, seat in cast}
        for name, cls, seat in row_people(row, slot_classes):
            if len(name.split()) > 1:
                continue
            candidates = candidates_for(full_by_first, base_token(name), cls)
            if len(candidates) < 2:
                continue
            alias = EXISTING_ALIASES.get(name, {}).get(cls)
            # The table exists for people logged by first name only, nicknames
            # included, so its target may share no first token with the key:
            # "Nick" -> "Nicholas Hart". Scoring only the first-token set left
            # that person out of their own row, so `alias == top[1]` was
            # unreachable and a correctly aliased row landed in `conflicts`,
            # the one bucket that tells the reader to go edit the sheet. The
            # ambiguity gate above still keys on the first-token set, so the
            # alias joins a contest that already exists rather than starting
            # one.
            if alias:
                candidates = candidates | {alias}
            # The sheet may already have answered this itself: fill-forward
            # expands a bare name that abbreviates the previous entry in the
            # session, and the app runs fillForward BEFORE normalizePlayerNames,
            # so no alias ever sees this cell. Nothing to report.
            resolved = by_seat.get(seat, name)
            if resolved != name and base_token(resolved) == base_token(name):
                # Counted apart from `settled`: no table was consulted here,
                # so folding the two would credit the alias file with work
                # fill-forward did.
                resolved_by_sheet += 1
                continue
            # Same two exclusions as the teammate index, for the same reason:
            # seat drops this cell, name drops the SAME person written again
            # elsewhere in the row. Without the name test the subject can be
            # its own evidence — a bare "Alice" in a slot and in Others? scores
            # a point for whichever candidate has played with someone written
            # bare as "Alice", and the report prints the subject as the reason.
            # De-duplicated because two distinct mates for one candidate must
            # not tie with one mate written twice for another.
            mates = list(dict.fromkeys(
                n for n, _c, s2 in cast if s2 != seat and n != name))
            scored = sorted(((len([m for m in mates if m in circles[c]]), c)
                             for c in candidates), reverse=True)
            top, runner = scored[0], scored[1]
            why = [m for m in mates if m in circles[top[1]]]
            # A circle is only evidence if we have one. Someone almost always
            # logged bare has a thin explicit circle, so their FAILURE to match
            # says nothing — and a rival who happens to share one hub mate
            # would win by default. That cuts both ways: a conclusion needs the
            # winner to be attested AND the losers' silence to mean something,
            # so every rival the sheet has barely named is reported as one we
            # could not rule out rather than quietly discarded.
            unruled = sorted(c for _n, c in scored[1:]
                             if written[c] < MIN_WRITTEN_IN_FULL)
            confident = (written[top[1]] >= MIN_WRITTEN_IN_FULL
                         and len(unruled) < len(candidates) - 1
                         and (not alias or alias == top[1]
                              or written.get(alias, 0) >= MIN_WRITTEN_IN_FULL))
            if not top[0] or top[0] == runner[0] or not confident:
                if alias:
                    unverified += 1
                else:
                    # No alias has ever decided this and the room cannot
                    # either. `alias` is not carried: it is None on every
                    # entry that reaches here, by construction.
                    unsettled.append((row, name, cls, sorted(candidates)))
            elif alias and alias != top[1]:
                conflicts.append((row, name, cls, alias, top[1], why, unruled))
            elif alias:
                settled += 1
            else:
                unaliased.append((row, name, cls, top[1], why, unruled))
    return conflicts, unaliased, unsettled, unverified, settled, resolved_by_sheet


def describe_row(row: dict) -> str:
    return (f"{(row.get('Timestamp') or '').split(' ')[0]:>10s} "
            f"{(row.get('Composer') or '').strip():14.14s} "
            f"{(row.get('Work Title') or '').strip():14.14s}")


def report_ambiguity(pairs: list[tuple[dict, dict]],
                     appearances: dict[tuple[str, str], list[list[str]]],
                     slot_classes: dict[str, str]) -> None:
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
    # One candidate definition for the whole section (see candidate_index):
    # by_first is class-keyed for the per-name and per-entry verdicts, and
    # names_by_first is the class-blind view the alias-key checks below want.
    by_first, _circles, _written = candidate_index(appearances)
    names_by_first: dict[str, set[str]] = defaultdict(set)
    for (token, _cls), names in by_first.items():
        names_by_first[token] |= names
    bare_count: Counter = Counter()
    # Two senses of "present", and hazard 3 needs both. `present` is what a
    # human actually typed; `resolved` adds what each of those names becomes
    # after normalizePlayerNames — the alias targets that are live by
    # definition, since the key sits in the sheet driving them.
    present: set[str] = set()
    resolved: set[str] = set()
    for (name, cls), apps in appearances.items():
        present.add(name)
        resolved.add(EXISTING_ALIASES.get(name, {}).get(cls) or name)
        if len(name.split()) == 1:
            bare_count[(name, cls)] += len(apps)
    # Surnames the sheet writes down anywhere: the test for whether this
    # gitignored file is the only place a canonical name's surname exists.
    sheet_surnames = {n.split()[-1].lower() for n in present if len(n.split()) > 1}

    print("\n=== AMBIGUITY: first names that no longer identify one person ===")
    print("(Hazards the variant grouping above cannot see.)")

    # Guard against the trap this section fell into once: archive/data.csv is
    # the PROCESSED export, written after normalizePlayerNames has already
    # replaced every short form with its canonical name. Measured against it, a
    # working alias looks dead — its bare form is gone precisely because the
    # alias did its job — and "pruning dead aliases" then silently un-normalizes
    # the data on the next fetch. Alias liveness can only be read from the raw
    # sheet (scripts/fetch_raw.sh -> archive/data-raw.csv).
    keys = [k for k in EXISTING_ALIASES if len(k.split()) == 1]
    canonicalized = False
    if keys:
        unseen = sum(
            1 for k in keys
            if not any(n == k for n, _ in appearances)
            and any(n == c for m in [EXISTING_ALIASES[k]] for c in m.values()
                    for n, _ in appearances)
        )
        canonicalized = unseen > len(keys) / 2
        if canonicalized:
            print(f"\n  !! {unseen} of {len(keys)} alias keys are absent while their canonical")
            print("     names are present — this input looks like the CANONICALIZED export.")
            print("     Re-run against archive/data-raw.csv before judging any alias dead.")

    # 1. Bare names still in the sheet that several full names could match.
    unresolvable = sorted(
        (
            (n, cls, cnt, sorted(candidates_for(by_first, base_token(n), cls)))
            for (n, cls), cnt in bare_count.items()
            if len(candidates_for(by_first, base_token(n), cls)) >= 2
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

    # 1b. The same hazard read per ENTRY rather than per name, which is what
    # decides whether there is any work to do: a bare name with four possible
    # people is not four problems if the stand says which one it was. Counted
    # per entry, not per row — a camp session's Others? column can hold two
    # ambiguous names, and each is its own cell to fix.
    (conflicts, unaliased, unsettled, unverified, settled,
     resolved_by_sheet) = attribute_bare_entries(pairs, appearances, slot_classes)
    if canonicalized:
        print("\n   !! Attribution below is measured on the CANONICALIZED export, where")
        print("      every bare slot name has already been replaced by whatever the")
        print("      alias guessed. Those rows now vote for the guess, so a wrong alias")
        print("      confirms itself and only Others? entries can disagree. A 0 here is")
        print("      not evidence — re-run against archive/data-raw.csv.")
    print(f"\n-- bare entries whose alias contradicts the room ({len(conflicts)}) --")
    print("   The stand says one person and the alias says another, so these are")
    print("   credited to the wrong one today. Fix the SHEET cell.")
    if not conflicts:
        print("   (none)")
    for row, name, cls, alias, winner, why, unruled in conflicts:
        print(f"   {describe_row(row)}  {name!r} [{cls or 'any'}]")
        print(f"   {'':10s} alias says {alias!r}, the room says {winner!r}"
              f"  (played with {', '.join(why[:3])})")
        if unruled:
            print(f"   {'':10s} could not rule out: {', '.join(unruled)}"
                  f" (written out fewer than {MIN_WRITTEN_IN_FULL} times)")
    print(f"\n-- bare entries the room resolves but no alias covers ({len(unaliased)}) --")
    print("   The app counts the bare form as its own person in every people")
    print("   stat. The room already names them, so this is mechanical: write")
    print("   the full name into the cell (or add the alias, if it is unambiguous).")
    if not unaliased:
        print("   (none)")
    for row, name, cls, winner, why, unruled in unaliased:
        print(f"   {describe_row(row)}  {name!r} [{cls or 'any'}] -> {winner!r}"
              f"  (played with {', '.join(why[:3])})")
        if unruled:
            print(f"   {'':10s} could not rule out: {', '.join(unruled)}"
                  f" (written out fewer than {MIN_WRITTEN_IN_FULL} times)"
                  " — confirm before editing")
    print(f"\n-- bare entries nobody has decided ({len(unsettled)}) --")
    print("   No alias covers them and no circle matches, so these are open")
    print("   questions only you can close. Answer them first — they decay.")
    if not unsettled:
        print("   (none)")
    for row, name, cls, candidates in unsettled:
        print(f"   {describe_row(row)}  {name!r} [{cls or 'any'}]")
        print(f"   {'':10s} candidates: {', '.join(candidates)}")
    print(f"\n   ({settled} more agree with the table and {unverified} have an alias"
          f" standing\n   that this run cannot second-guess; a further"
          f" {resolved_by_sheet} were answered by the\n   sheet itself, where"
          " fill-forward expanded the cell and no alias was consulted.)")

    # 2. Aliases keyed on a first name several people now share. Multi-token
    # keys ("Jo A", "Jo Alpha") are already disambiguated, so skip them.
    risky = sorted(
        (key, mapping, sorted(names_by_first[key.lower()]))
        for key, mapping in EXISTING_ALIASES.items()
        if len(key.split()) == 1 and len(names_by_first.get(key.lower(), ())) >= 2
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
    # Two very different things land here. Recording a surname the sheet never
    # had is the point of the table for anyone logged by first name only, and
    # a surname written nowhere in the sheet is its signature — nicknames
    # ("Bo" -> "Carol Hart") included, since the file is just as much the
    # only record of those. A canonical name whose surname the sheet DOES
    # carry is a spelling that drifted, and only that is a bug — so they are
    # split rather than piled into one count nobody reads.
    expected = [(k, c, n) for k, c, n in dangling
                if n.split()[-1].lower() not in sheet_surnames]
    # A canonical name the sheet resolves to is a working alias, not a broken
    # one — the normal shape of a spelling normalization ("Carol Hart"
    # logged, "Caro Hart" canonical) leaves the target absent from the raw
    # sheet by design. Reporting those sends you to delete a live alias, the
    # failure this whole section was added to prevent. The surname bucket
    # above deliberately keeps the literal test: its question is whether the
    # SHEET records the surname at all, and an alias resolving to it is
    # exactly the case where nothing but this file does.
    suspect = [row for row in dangling
               if row not in expected and row[2] not in resolved]
    print(f"\n-- aliases that are the ONLY record of a surname ({len(expected)}) --")
    print("   Expected for anyone logged by first name only. Back this file up:")
    print("   it is gitignored, so these surnames exist nowhere else.")
    if not expected:
        print("   (none)")
    for key, cls, canon in expected:
        print(f"   {key!r:18s} [{cls:5s}] -> {canon!r}")
    print(f"\n-- aliases whose canonical name is absent and unrelated ({len(suspect)}) --")
    print("   A nickname, or a spelling that changed in the data but not here.")
    if not suspect:
        print("   (none)")
    for key, cls, canon in suspect:
        near = sorted(names_by_first.get(base_token(canon), ()))
        hint = f"   did you mean: {', '.join(near)}" if near else ""
        print(f"   {key!r:18s} [{cls:5s}] -> {canon!r}{hint}")


def main() -> None:
    csv_path = Path(sys.argv[1] if len(sys.argv) > 1 else "archive/data.csv")
    if not csv_path.exists():
        print(f"CSV not found: {csv_path}", file=sys.stderr)
        sys.exit(1)

    # (row as written, row after fill-forward) — see fill_forward.
    pairs = fill_forward(load_rows(csv_path))
    rows = [written for written, _filled in pairs]
    # Every index in this report — variants, teammate counts, bare-name counts,
    # the canonicalized-export detector — is built from the rows AS WRITTEN.
    # Fill-forward synthesises values a human never typed, and each of those
    # readers is asking what was typed: how often a full name was spelled out,
    # which cells still hold a bare one. Only the per-entry evidence lookup in
    # attribute_bare_entries wants the filled view, and it takes it from pairs.
    # One node round-trip for the whole file; every reader shares the result.
    slot_classes = slot_classes_for(rows)
    appearances = collect_appearances(rows, slot_classes)
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
            # ANY_CLASS is an index key, not a class the app can alias on:
            # canonicalize only ever looks up 'upper'/'cello', so a proposed
            # { any: ... } entry is inert when pasted, makes the name read as
            # handled on the next run, and — since already_aliased can never
            # be true for it — is re-proposed forever.
            if cls == ANY_CLASS:
                continue
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
            if len(vs) < 2 or cls == ANY_CLASS:   # see the proposal loop above
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

    report_ambiguity(pairs, appearances, slot_classes)

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
