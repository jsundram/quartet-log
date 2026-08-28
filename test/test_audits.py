"""Unit tests for the data-quality audits in scripts/.

Run with `npm run test:audits` (pytest via uv, nothing installed into the
repo). The node suite globs test/*.mjs, so these sit alongside it without
being picked up by it.

Two things shape this file.

The audits are mostly pure functions over CSV-shaped dicts, so almost
everything here is a table of cases. Where an audit shells out to node —
slot_annotation_classes, fill_forward — the tests call the real bridge rather
than mocking it, since the whole point of those functions is that they defer
to the app's own implementation instead of re-deriving it in Python.

More importantly, audit_aliases loads PLAYER_ALIASES at IMPORT time by asking
node to read src/aliases.js, which is gitignored and machine-specific: the
real tables locally, the empty stub in CI. A test that read them would pass
here and mean something else there. The autouse fixture below replaces both
tables for every test, so no test can depend on which machine it runs on.

Placeholder names come from a published list (Alice/Bob/Carol, then Atlantic
hurricane names), never from the log, and are not screened against it — see
CLAUDE.md on why filtering would leak more than a collision does.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import audit_aliases as aa  # noqa: E402
import audit_ensembles as ae  # noqa: E402
import audit_fillforward as af  # noqa: E402

HEADERS = ["Timestamp", "Composer", "Work Title", "Which Part",
           "Player 1", "Player 2", "Player 3", "Others?", "Location", "Comments"]


def row(ts="1/1/2024 10:00:00", composer="Haydn", title="76#1", part="V1",
        p1="", p2="", p3="", others="", location="Home", comments=""):
    """One CSV-shaped row, the shape every audit actually reads."""
    return dict(zip(HEADERS, [ts, composer, title, part,
                              p1, p2, p3, others, location, comments]))


@pytest.fixture(autouse=True)
def placeholder_tables(monkeypatch):
    """Never let a test see the machine's real src/aliases.js.

    audit_aliases resolves the tables at import, so without this a test would
    read real names locally and the empty stub in CI — passing in both places
    while testing two different things. Individual tests override further.
    """
    monkeypatch.setattr(aa, "EXISTING_ALIASES", {})
    monkeypatch.setattr(aa, "ABBREVIATIONS", {})


def appearances_for(rows, slot_classes=None):
    return aa.collect_appearances(rows, slot_classes or {})


def attribute(rows, aliases=None, filled=None, monkeypatch=None):
    """Run attribution over `rows`, optionally against a different filled view."""
    if aliases is not None:
        aa.EXISTING_ALIASES = aliases
    pairs = list(zip(rows, filled if filled is not None else rows))
    return aa.attribute_bare_entries(pairs, appearances_for(rows), {})


def buckets(rows, aliases=None, filled=None):
    """(conflicts, unaliased, unsettled) — the three that are listed."""
    return attribute(rows, aliases, filled)[:3]


# --------------------------------------------------------------- parsing --

@pytest.mark.parametrize("instrument,expected", [
    ("vc", "cello"), ("vc2", "cello"), ("VC", "cello"),
    ("v1", "upper"), ("va2", "upper"), ("piano", "upper"),
    ("", None), (None, None),
])
def test_class_of(instrument, expected):
    assert aa.class_of(instrument) == expected


@pytest.mark.parametrize("value,expected", [
    ("Alice Hart", "Alice Hart"),
    ("Alice Hart (p)", "Alice Hart"),
    ("Alice Hart (vc, doubling)", "Alice Hart"),
    ("", ""), (None, ""),
])
def test_strip_parens(value, expected):
    assert aa.strip_parens(value) == expected


@pytest.mark.parametrize("others,expected", [
    ("Alice", [("Alice", None)]),
    ("Alice (vc)", [("Alice", "vc")]),
    # First comma inside the parens splits instrument from comment; later
    # commas stay in the comment rather than tearing the entry in half.
    ("Alice (v1, shadowing on II, III)", [("Alice", "v1")]),
    ("Alice (vc); Bob (v2)", [("Alice", "vc"), ("Bob", "v2")]),
    ("Alice, Bob", [("Alice", None), ("Bob", None)]),
    ("", []),
])
def test_parse_others(others, expected):
    assert aa.parse_others(others) == expected


def test_base_token():
    assert aa.base_token("Alice Hart") == "alice"
    assert aa.base_token(" alice ") == "alice"


def test_expand_abbrev_uses_the_injected_table():
    aa.ABBREVIATIONS = {"A": "Alice"}
    assert aa.expand_abbrev("A") == "Alice"
    assert aa.expand_abbrev("Bob") == "Bob"


def test_row_people_labels_every_cell_with_its_seat():
    people = aa.row_people(
        row(p1="Alice", p2="-", p3="Bob", others="Carol (vc); Dexter (v2)"), {})
    assert people == [("Alice", "upper", "p1"), ("Bob", "cello", "p3"),
                      ("Carol", "cello", "o0"), ("Dexter", "upper", "o1")]


def test_row_people_reads_a_slot_annotation_as_the_class():
    # The annotation states the class; the column only implies it.
    people = aa.row_people(row(p3="Alice (p)"), {"Alice (p)": "upper"})
    assert people == [("Alice", "upper", "p3")]


# ------------------------------------------------------- candidate_index --

def test_candidates_are_keyed_by_instrument_class():
    """PLAYER_ALIASES is class-keyed, so the candidate set must be too.

    Otherwise a cello-slot bare name draws the upper-class person of the same
    first name, whose larger circle then wins, and the CORRECT class-keyed
    alias gets reported as crediting the wrong person.
    """
    rows = [row(p1="Alice Hart", p3="Alice Bek")]
    by_first, _circles, _written = aa.candidate_index(appearances_for(rows))
    assert by_first[("alice", "upper")] == {"Alice Hart"}
    assert by_first[("alice", "cello")] == {"Alice Bek"}


def test_a_one_letter_surname_is_an_abbreviation_not_a_rival():
    # "Alice H" is Alice Hart with the surname abbreviated. Admitting it as a
    # candidate invents a rival for the real person.
    rows = [row(p1="Alice Hart"), row(p1="Alice H")]
    by_first, _c, _w = aa.candidate_index(appearances_for(rows))
    assert by_first[("alice", "upper")] == {"Alice Hart"}


def test_bare_names_are_not_candidates():
    rows = [row(p1="Alice Hart"), row(p1="Alice")]
    by_first, _c, _w = aa.candidate_index(appearances_for(rows))
    assert by_first[("alice", "upper")] == {"Alice Hart"}


def test_nobody_is_their_own_teammate():
    """Someone written in a slot AND in Others? — how the rows that overflow
    the quartet layout get logged — must not land in their own circle, or a
    bare name beside its own full form scores a point for being the person
    already named in that row."""
    rows = [row(p1="Alice Hart", p2="Bob", others="Alice Hart (v2)")]
    _b, circles, _w = aa.candidate_index(appearances_for(rows))
    assert "Alice Hart" not in circles["Alice Hart"]
    assert circles["Alice Hart"] == {"Bob"}


def test_circles_and_written_come_from_the_rows_given():
    rows = [row(p1="Alice Hart", p2="Bob", p3="Carol"),
            row(p1="Alice Hart", p2="Dexter", p3="Carol")]
    _b, circles, written = aa.candidate_index(appearances_for(rows))
    assert circles["Alice Hart"] == {"Bob", "Carol", "Dexter"}
    assert written["Alice Hart"] == 2


# -------------------------------------------------- attribution outcomes --

def attested(name, mate, n=aa.MIN_WRITTEN_IN_FULL):
    """n rows naming `name` alongside `mate`, so the circle counts as evidence."""
    return [row(ts=f"1/{i + 1}/2024 10:00:00", p1=name, p2=mate, p3="Carol")
            for i in range(n)]


def test_room_agreeing_with_the_alias_is_settled_not_reported():
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Beryl", p3="Carol")])
    conflicts, unaliased, unsettled, unverified, settled, _rs = attribute(
        rows, {"Alice": {"upper": "Alice Hart"}})
    assert (conflicts, unaliased, unsettled) == ([], [], [])
    assert settled == 1 and unverified == 0


def test_room_contradicting_the_alias_is_reported():
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Chantal", p3="Carol")])
    conflicts, _ua, _us, _uv, _s, _rs = attribute(
        rows, {"Alice": {"upper": "Alice Hart"}})
    assert len(conflicts) == 1
    _row, name, cls, alias, winner, why, unruled = conflicts[0]
    assert (name, cls, alias, winner) == ("Alice", "upper", "Alice Hart", "Alice Bek")
    assert "Chantal" in why and unruled == []


def test_room_resolving_an_unaliased_name_is_its_own_bucket():
    """The app counts a bare form as a separate person, so this is real work.

    Folding it into `settled` hides the largest actionable, non-decaying
    bucket the audit can find.
    """
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Beryl", p3="Carol")])
    _c, unaliased, _us, _uv, settled, _rs = attribute(rows, {})
    assert len(unaliased) == 1 and settled == 0
    _row, name, _cls, winner, _why, _unruled = unaliased[0]
    assert (name, winner) == ("Alice", "Alice Hart")


def test_no_evidence_and_no_alias_is_the_only_bucket_that_needs_memory():
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Dexter", p3="Ernesto")])
    _c, _ua, unsettled, _uv, _s, _rs = attribute(rows, {})
    assert len(unsettled) == 1
    _row, name, cls, candidates = unsettled[0]
    assert (name, cls, candidates) == ("Alice", "upper", ["Alice Bek", "Alice Hart"])


def test_no_evidence_but_an_alias_standing_is_counted_not_reported():
    """Presenting 400 of these as NEEDS MEMORY is as misleading as reporting none.

    The alias is the best available answer and this run has nothing to
    second-guess it with; that is not work.
    """
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Dexter", p3="Ernesto")])
    _c, _ua, unsettled, unverified, _s, _rs = attribute(
        rows, {"Alice": {"upper": "Alice Hart"}})
    assert unsettled == [] and unverified == 1


def test_a_tie_settles_nothing():
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Beryl")
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Beryl", p3="Carol")])
    _c, unaliased, unsettled, _uv, _s, _rs = attribute(rows, {})
    assert unaliased == [] and len(unsettled) == 1


def test_a_nickname_alias_competes_for_its_own_row():
    """The table exists for people logged by first name only, nicknames
    included, so its target may share no first token with the key.

    Scoring only the first-token set left that person out of their own row:
    `alias == top[1]` was unreachable, so a correctly aliased row could never
    be `settled` and landed in `conflicts` — the one bucket whose copy tells
    the reader to go and edit the sheet.
    """
    rows = ([row(ts=f"1/{i + 1}/2024 10:00:00", p1="Nick Adams",
                 p2="Dexter", p3="Carol") for i in range(5)]
            + [row(ts=f"2/{i + 1}/2024 10:00:00", p1="Nick Bailey",
                   p2="Chantal", p3="Fernand") for i in range(5)]
            + [row(ts=f"3/{i + 1}/2024 10:00:00", p1="Nicholas Hart",
                   p2="Dexter", p3="Gaston") for i in range(5)]
            + [row(ts="6/1/2024 10:00:00", p1="Nick", p2="Dexter", p3="Gaston")])
    conflicts, unaliased, unsettled, _uv, settled, _rs = attribute(
        rows, {"Nick": {"upper": "Nicholas Hart"}})
    assert (conflicts, unaliased, unsettled) == ([], [], [])
    assert settled == 1


# ------------------------------------------------------ attribution guards --

def test_a_thinly_written_winner_is_not_trusted():
    """A circle is only evidence if we have one.

    Below MIN_WRITTEN_IN_FULL a positive match is as likely to be an accident
    of who happens to have been named as it is to be the answer.
    """
    rows = (attested("Alice Hart", "Beryl", n=1) + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Beryl", p3="Carol")])
    _c, unaliased, unsettled, _uv, _s, _rs = attribute(rows, {})
    assert unaliased == [] and len(unsettled) == 1


def test_a_thinly_written_alias_target_is_not_contradicted():
    """The people most often logged bare are the ones whose full name is rarest.

    Their FAILURE to match therefore means "never seen named", not "not them",
    and is no basis for telling anyone to edit the sheet.
    """
    rows = (attested("Alice Hart", "Beryl", n=1) + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Chantal", p3="Carol")])
    conflicts, _ua, _us, unverified, _s, _rs = attribute(
        rows, {"Alice": {"upper": "Alice Hart"}})
    assert conflicts == [] and unverified == 1


def test_a_thinly_written_alias_target_is_not_contradicted_with_rivals_to_spare():
    """The alias gate is separate from the rival gate, and only visible here.

    With two candidates a thin alias target IS the only rival, so the rival
    gate happens to cover it. Add a third, attested candidate and the rival
    gate passes — leaving the alias's own attestation as the thing standing
    between a thinly-named person and being told they are wrong.
    """
    rows = (attested("Alice Hart", "Beryl", n=1)      # the alias target, barely named
            + attested("Alice Bek", "Chantal")        # the winner
            + attested("Alice Chan", "Dexter")        # attested, does not match
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Chantal", p3="Carol")])
    conflicts, _ua, _us, unverified, _s, _rs = attribute(
        rows, {"Alice": {"upper": "Alice Hart"}})
    assert conflicts == [] and unverified == 1


def test_a_verdict_needs_at_least_one_rival_the_sheet_has_named():
    """With every rival unattested there is nothing to rule out.

    This is the case most likely to cause a bad edit, because the bucket it
    would land in tells you to write the name into the cell.
    """
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal", n=1)
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Beryl", p3="Carol")])
    _c, unaliased, unsettled, _uv, _s, _rs = attribute(rows, {})
    assert unaliased == [] and len(unsettled) == 1


def test_rivals_that_cannot_be_ruled_out_are_disclosed_not_discarded():
    """Partial knowledge yields a finding that says what it does not know."""
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + attested("Alice Chan", "Dexter", n=1)
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Beryl", p3="Carol")])
    _c, unaliased, _us, _uv, _s, _rs = attribute(rows, {})
    assert len(unaliased) == 1
    *_rest, winner, _why, unruled = unaliased[0]
    assert winner == "Alice Hart" and unruled == ["Alice Chan"]


def test_the_subject_is_never_its_own_evidence():
    """The same person can occupy two cells, and one of them is the subject.

    Without the name test the bare subject scores for whichever candidate has
    played with someone written bare the same way — and the report prints the
    subject itself as the reason. Seat alone cannot catch this; name alone
    cannot catch the fill-forward case below. Both exclusions are needed, in
    both readers.
    """
    rows = ([row(ts=f"1/{i + 1}/2024 10:00:00", p1="Alice Hart",
                 p2="Beryl", p3="Carol") for i in range(5)]
            # Alice Bek has played with someone written bare as "Alice".
            + [row(ts=f"2/{i + 1}/2024 10:00:00", p1="Alice Bek",
                   p2="Alice", p3="Fernand") for i in range(5)]
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Gaston",
                   others="Alice (v2)")])
    _c, unaliased, unsettled, _uv, _s, _rs = attribute(rows, {})
    # No finding may cite the subject's own name as the reason for itself.
    assert all("Alice" not in why for *_r, why, _u in unaliased)
    # The two cells of the last row hold each other's only "evidence", so
    # with that removed nothing settles them.
    assert [r["Timestamp"] for r, *_ in unsettled] == ["6/1/2024 10:00:00"] * 2


def test_the_subjects_own_seat_is_excluded_positionally():
    """Evidence is the filled row; the subject is the row as written.

    Whatever sits in the subject's own cell in the filled view is not a
    stand-mate, and a name comparison cannot say so once that cell differs
    from what was written. Left in, it scores for whichever RIVAL has played
    with it. The pair is built by hand here because in the app this path is
    also caught by the sheet-resolved skip below; the exclusion has to be
    right on its own terms.
    """
    written = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
               + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Beryl", p3="Carol")])
    filled = [dict(r) for r in written]
    filled[-1]["Player 1"] = "Chantal"   # in Alice Bek's circle, not Alice Hart's
    _c, unaliased, _us, _uv, _s, _rs = attribute(written, {}, filled=filled)
    assert len(unaliased) == 1
    *_rest, winner, why, _unruled = unaliased[0]
    assert winner == "Alice Hart"
    assert "Chantal" not in why


def test_a_cell_the_sheet_resolved_itself_is_not_reported():
    """fillForward runs BEFORE normalizePlayerNames, so no alias sees that cell.

    There is no hazard to report, whatever the table would have said.
    """
    written = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
               + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Chantal", p3="Carol")])
    filled = [dict(r) for r in written]
    filled[-1]["Player 1"] = "Alice Hart"
    conflicts, unaliased, unsettled, _uv, settled, resolved_by_sheet = attribute(
        written, {"Alice": {"upper": "Alice Hart"}}, filled=filled)
    assert (conflicts, unaliased, unsettled) == ([], [], [])
    # Counted apart from `settled`: no table was consulted, so folding them
    # together would credit src/aliases.js with work fill-forward did.
    assert (settled, resolved_by_sheet) == (0, 1)


def test_evidence_comes_from_the_filled_row():
    """A continuation row's cast is only stated above it.

    Without the filled view an Others? entry on such a row has no stand-mates
    to read and falls into the bucket labelled NEEDS MEMORY, while the row
    above names everyone who was there.
    """
    written = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
               + [row(ts="6/1/2024 11:00:00", others="Alice (v2)")])
    filled = [dict(r) for r in written]
    filled[-1].update({"Player 1": "Beryl", "Player 2": "Carol"})
    _c, unaliased, unsettled, _uv, _s, _rs = attribute(written, {}, filled=filled)
    assert unsettled == [] and len(unaliased) == 1
    assert unaliased[0][3] == "Alice Hart"


def test_one_person_in_two_cells_does_not_vote_twice():
    """The score means "how many of this candidate's circle were here".

    Someone written in a slot AND in Others? — which happens on exactly the
    rows that push people out of the quartet layout — would otherwise count
    twice, and two distinct mates for one candidate could tie with one
    duplicated mate for another, dumping a settleable entry into NEEDS MEMORY.
    """
    # Hart has TWO distinct mates in the row; Bek has one, written twice.
    # Deduped that is 2-1 for Hart; counted raw it is 2-2, a tie, and the
    # entry falls into NEEDS MEMORY instead of being settled.
    rows = ([row(ts=f"1/{i + 1}/2024 10:00:00", p1="Alice Hart",
                 p2="Beryl", p3="Dexter") for i in range(5)]
            + [row(ts=f"2/{i + 1}/2024 10:00:00", p1="Alice Bek",
                   p2="Chantal", p3="Fernand") for i in range(5)]
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Beryl", p3="Chantal",
                   others="Chantal (v2); Dexter (va)")])
    _c, unaliased, _us, _uv, _s, _rs = attribute(rows, {})
    assert len(unaliased) == 1
    *_rest, winner, why, _unruled = unaliased[0]
    assert winner == "Alice Hart"
    assert why.count("Chantal") <= 1


def test_an_unannotated_others_entry_is_still_a_subject():
    """The app counts that bare form as its own person, so it belongs in a
    bucket. No alias can reach it either — canonicalize with a null class is a
    no-op — so every namesake is in play and only the cell can be fixed."""
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Beryl", others="Alice")])
    _c, unaliased, unsettled, _uv, _s, _rs = attribute(rows, {})
    assert len(unaliased) + len(unsettled) == 1


def test_an_unannotated_others_entry_is_still_evidence():
    """A name with no instrument still says who was in the room.

    Dropping it produced a false NEEDS MEMORY on rows its presence settles —
    the exact failure this feature exists to remove.
    """
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Alice", others="Beryl")])
    _c, unaliased, unsettled, _uv, _s, _rs = attribute(rows, {})
    assert unsettled == [] and len(unaliased) == 1
    assert unaliased[0][3] == "Alice Hart"


# ------------------------------------------------- report_ambiguity buckets --

def test_an_unclassified_subject_prints_as_any_not_none(capsys):
    """cls is None for an unannotated Others? entry — every namesake is in
    play — and printing a literal [None] beside every other line's [upper] is
    not what that means."""
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + [row(ts="6/1/2024 10:00:00", p1="Beryl", others="Alice")])
    aa.report_ambiguity(list(zip(rows, rows)), appearances_for(rows), {})
    out = capsys.readouterr().out
    assert "[None]" not in out
    assert "'Alice' [any]" in out


def test_unruled_rivals_are_labelled_by_what_was_measured(capsys):
    """The gate is `written < MIN_WRITTEN_IN_FULL`, so a rival named four
    times in full is not "never written out" — and these are the lines whose
    whole job is "confirm before editing"."""
    rows = (attested("Alice Hart", "Beryl") + attested("Alice Bek", "Chantal")
            + attested("Alice Chan", "Dexter", n=4)
            + [row(ts="6/1/2024 10:00:00", p1="Alice", p2="Beryl", p3="Carol")])
    aa.report_ambiguity(list(zip(rows, rows)), appearances_for(rows), {})
    out = capsys.readouterr().out
    assert "never written out" not in out
    assert f"fewer than {aa.MIN_WRITTEN_IN_FULL} times" in out


def test_a_surname_the_sheet_never_writes_is_the_backup_bucket(capsys):
    """The gitignored table is the only record of it, which is a standing risk."""
    aa.EXISTING_ALIASES = {"Alice": {"upper": "Alice Hart"}}
    rows = [row(p1="Alice", p2="Bob Jones")]
    aa.report_ambiguity(list(zip(rows, rows)), appearances_for(rows), {})
    out = capsys.readouterr().out
    assert "ONLY record of a surname (1)" in out
    assert "absent and unrelated (0)" in out


def test_a_live_alias_is_reported_as_neither(capsys):
    """A canonical name the sheet resolves to is working, not broken.

    Reporting it sends you to delete a live alias — the failure this section
    was added to prevent.
    """
    aa.EXISTING_ALIASES = {"Alberto Stone": {"upper": "Al Stone"}}
    rows = [row(p1="Alberto Stone", p2="Beryl Stone")]
    aa.report_ambiguity(list(zip(rows, rows)), appearances_for(rows), {})
    out = capsys.readouterr().out
    assert "ONLY record of a surname (0)" in out
    assert "absent and unrelated (0)" in out


def test_a_drifted_spelling_is_the_bug_bucket(capsys):
    aa.EXISTING_ALIASES = {"Chantal": {"upper": "Chantal Stone"}}
    rows = [row(p1="Dexter Stone", p2="Ernesto Stone")]
    aa.report_ambiguity(list(zip(rows, rows)), appearances_for(rows), {})
    assert "absent and unrelated (1)" in capsys.readouterr().out


# ------------------------------------------------------- the node bridges --

def test_slot_annotation_classes_defers_to_the_real_module():
    """A note is not an instrument, and classOf answers 'upper' for both.

    Mirroring the vocabulary in Python would be a fourth copy to drift; this
    asks dataProcessor instead.
    """
    got = aa.slot_annotation_classes(
        {"Alice (piano)", "Bob (vc)", "Carol (cello)", "Dexter (sub)"})
    assert got == {"Alice (piano)": "upper", "Bob (vc)": "cello",
                   "Carol (cello)": "cello"}


def test_slot_annotation_classes_handles_an_empty_set():
    assert aa.slot_annotation_classes(set()) == {}


def test_one_short_row_does_not_cost_the_file_its_filled_view():
    """csv.DictReader pads a short row with None, which processRow's
    `=== undefined` guard lets through until .trim() throws. Node exits 1 and
    the whole file falls back to unfilled — and a third of the raw sheet is
    continuation rows that then look answerless."""
    # Exactly what DictReader hands back for a truncated line: the keys are
    # all there, the missing trailing values are None.
    short = row(ts="1/1/2024 11:00:00")
    for key in ("Others?", "Location", "Comments"):
        short[key] = None
    rows = [row(ts="1/1/2024 10:00:00", p1="Alice", p2="Bob", p3="Carol"), short]
    pairs = aa.fill_forward(rows)
    assert pairs[1][1]["Player 1"] == "Alice"


def test_fill_forward_returns_the_row_as_written_and_as_filled():
    rows = [row(ts="1/1/2024 10:00:00", p1="Alice", p2="Bob", p3="Carol"),
            row(ts="1/1/2024 11:00:00")]
    pairs = aa.fill_forward(rows)
    assert len(pairs) == 2
    written, filled = pairs[1]
    # As written the continuation row is blank — there is no cell to edit.
    assert written["Player 1"] == ""
    # As filled it names the room, which is the evidence.
    assert filled["Player 1"] == "Alice"


# ------------------------------------------------------- audit_ensembles --

@pytest.mark.parametrize("title,comments,expected", [
    ("Piano Quintet", "", (5, True)),
    ("Sextet 1", "", (6, True)),
    ("K478", "Piano Quartet", (4, True)),
    ("K478", "Notturno for Piano Trio", (3, True)),
    # Prose, not instrumentation: a bare ensemble word means nothing here.
    ("K478", "quintets were averted briefly", (4, False)),
    ("K478", "more piano the second time", (4, False)),
    ("76#1", "", (4, False)),
])
def test_expected_size(title, comments, expected):
    assert ae.expected_size(row(title=title, comments=comments), set()) == expected


def test_a_catalogued_quartet_ignores_prose_about_another_piece():
    """"Post-Mexican food after piano quartet afternoon" parses as an
    instrumentation phrase. The row settles it: this work is a string quartet,
    so whatever the comment is about, it is not this piece."""
    quartets = {("Haydn", "50#5")}
    r = row(composer="Haydn", title="50#5",
            comments="Post-Mexican food after piano quartet afternoon")
    assert ae.expected_size(r, quartets) == (4, False)
    assert ae.mentions_keyboard(r, quartets) is False
    # The same comment on an uncatalogued work is still trusted.
    assert ae.expected_size(row(title="K478", comments=r["Comments"]), quartets)[1]


@pytest.mark.parametrize("title,comments,expected", [
    ("Piano Quartet", "", True),
    ("K478", "Piano Quartet", True),
    ("76#1", "more piano the second time", False),
    ("76#1", "", False),
])
def test_mentions_keyboard(title, comments, expected):
    assert ae.mentions_keyboard(row(title=title, comments=comments), set()) is expected


@pytest.mark.parametrize("kwargs,expected", [
    ({"p3": "Alice (p)"}, True),          # annotated slot, which the export now keeps
    ({"others": "Alice (piano)"}, True),
    ({"p3": "Alice (vc)"}, False),
    ({"p3": "Alice"}, False),
])
def test_has_keyboard_annotation(kwargs, expected):
    assert ae.has_keyboard_annotation(row(**kwargs)) is expected


@pytest.mark.parametrize("value,expected", [
    ("Alice (p)", "p"),
    ("Alice (vc, doubling)", "vc"),
    ("Alice", None),
    ("", None),
])
def test_slot_instrument(value, expected):
    assert ae.slot_instrument(value) == expected


def test_logged_people_counts_the_logger_and_ignores_empty_seats():
    # "-" marks a seat the work does not have; it is not a person.
    assert ae.logged_people(row(p1="Alice", p2="-", p3="Bob")) == 3
    assert ae.logged_people(row(p1="Alice", p2="Bob", p3="Carol",
                                others="Dexter (v2)")) == 5


def test_datestamp_survives_an_unpadded_timestamp():
    """csvFormat writes M/D/YYYY H:mm:ss, so a fixed slice cuts into the time."""
    assert ae.datestamp(row(ts="1/1/2024 1:05:00")) == "1/1/2024"
    assert ae.datestamp(row(ts="12/31/2024 13:05:00")) == "12/31/2024"


# ----------------------------------------------------- audit_fillforward --

@pytest.mark.parametrize("part,is_extra", [
    ("va2", True), ("vc2", True), ("vla2", True), ("v3", True),
    # A quartet HAS a second violin seat, so an Others? "v2" is a fifth body
    # in the room and the next quartet has nowhere to put them either.
    ("v2", False), ("v1", False), ("va", False), ("vc", False),
])
def test_extra_string_parts(part, is_extra):
    assert bool(af.EXTRA_STRING_RE.match(part)) is is_extra


def ff_quartet():
    quartets = {("Haydn", "76#1")}
    return row(composer="Haydn", title="76#1"), set(), quartets


@pytest.mark.parametrize("others,needed", [
    ("Alice (p)", True),                       # a pianist has no seat either way
    ("Alice (va2)", False),                    # a quartet has no second viola
    ("Alice (va2); Bob (vc2)", False),
    ("Alice (v2)", True),                      # ...but it has no spare v2 chair
    ("Alice", True),                           # unannotated: not inferable
    ("Alice (v1, on II, III)", False),         # scoped to this piece; must not carry
    # One scoped entry must not silence the rest of the line: the pianist is
    # still dropped by the next row.
    ("Alice (v1, on II, III); Bob (p)", True),
])
def test_needs_the_extra_player(others, needed):
    r, big, quartets = ff_quartet()
    assert af.needs_the_extra_player(r, others, big, quartets) is needed


def test_an_uncatalogued_work_is_always_reported():
    """Suppress only on positive evidence; an unknown work is not evidence."""
    r = row(composer="Haydn", title="Unlisted")
    assert af.needs_the_extra_player(r, "Alice (va2)", set(), {("Haydn", "76#1")})


# --------------------------------------------- mirrors of the JavaScript --
#
# These Python ports exist because the audits cannot import src/. They are the
# things that drift silently, so each is checked against the original by
# running it — this is what caught class_of reading "(cello)" as an upper part
# while the app read it as a cellist. Port anything else, add it here.

def _js(expr, samples):
    """Evaluate `expr` (a dataProcessor export) over samples, in node."""
    import json
    import subprocess
    out = subprocess.run(
        ["node", "-e",
         "import('./src/dataProcessor.js').then(m => process.stdout.write("
         f"JSON.stringify(JSON.parse(process.argv[1]).map(x => {expr}))))",
         json.dumps(samples)],
        capture_output=True, text=True, check=True,
        cwd=Path(__file__).resolve().parent.parent)
    return json.loads(out.stdout)


def test_session_window_hours_matches_the_app():
    assert af.SESSION_WINDOW_HOURS == _js("m.SESSION_WINDOW_HOURS", [0])[0]


def test_class_of_matches_the_app():
    samples = ["vc", "vc2", "cello", "violoncello", "c", "vlc", "Cello",
               "va", "vla", "viola", "v1", "v2", "piano", "p", "clarinet",
               # The assistant prefix is anchored and takes any whitespace run
               # in the app; a literal " " replace here read "asst  vc" as an
               # upper part while the app read it as a cellist.
               "asst v2", "asst vc", "asst  vc", "ast\tvc", "ASST VC", ""]
    assert [aa.class_of(s) for s in samples] == _js("m.classOf(x)", samples)


def test_strip_parens_matches_the_app():
    samples = ["Alice Hart", "Alice Hart (p)", "Alice Hart (vc, doubling)",
               "Alice (Hart)", "Alice", ""]
    assert [aa.strip_parens(s) for s in samples] == _js("m.stripParens(x)", samples)


def test_parse_others_matches_the_app():
    samples = ["Alice (vc); Bob (v2)",
               "Alice (v1, shadowing on II, III)",
               "Alice, Bob",
               "Alice",
               ""]
    js = _js("m.parseOthers(x).map(o => [o.name, o.instrument])", samples)
    ours = [[list(pair) for pair in aa.parse_others(s)] for s in samples]
    assert ours == js


def test_slot_instrument_is_looser_than_the_app_on_purpose():
    """audit_ensembles keeps every parenthetical; instrumentFromSlot drops the
    ones naming no instrument. The difference is inert — the only consumer
    filters for keyboards straight after — and a copy of the JS instrument
    vocabulary would be one more thing to drift."""
    assert ae.slot_instrument("Alice (sub)") == "sub"
    assert _js("m.instrumentFromSlot(x)", ["Alice (sub)"]) == [None]
    assert ae.has_keyboard_annotation(row(p1="Alice (sub)")) is False
