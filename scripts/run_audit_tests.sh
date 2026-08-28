#!/usr/bin/env bash
# Unit tests for the audits in scripts/ (test/test_audits.py).
#
# pytest rather than a hand-rolled runner for one decisive reason:
# audit_aliases resolves PLAYER_ALIASES at IMPORT time from the gitignored
# src/aliases.js, so every test has to inject a known table or it reads real
# names locally and the empty stub in CI. monkeypatch plus an autouse fixture
# makes that impossible to forget; hand-rolling save/restore across ~90 cases
# is where a homemade runner starts reinventing pytest badly. Nothing enters
# package.json: uv fetches pytest per-run, matching the convention in
# CLAUDE.md. Same uv-or-python3 fallback as audit_all.sh so one command works
# on a dev machine and in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

PYTEST_VERSION=9.1.1

# The tests import audit_aliases, which asks node to read src/aliases.js; on a
# fresh clone that file does not exist yet.
node scripts/ensure_aliases.mjs

if command -v uv >/dev/null 2>&1; then
    exec uv run --with "pytest==$PYTEST_VERSION" --python 3.12 \
        pytest test/test_audits.py "$@"
fi

# No uv: build a venv and install the pinned pytest into it. NOT
# `pip install` into the system interpreter — that is PEP-668 marked on
# current Ubuntu, so it would fail the CI step outright, and mutating the
# runner's Python to run a test suite is the wrong trade anyway. NOT
# "use whatever pytest is already importable" either: that is what the
# previous version did, and it made the pin above fictional — CI ran the
# image's pytest and only happened to match. The venv is cached between runs.
echo "note: uv not found, using a cached venv" >&2
VENV="${XDG_CACHE_HOME:-$HOME/.cache}/quartet-log/pytest-$PYTEST_VERSION"
if [ ! -x "$VENV/bin/pytest" ]; then
    rm -rf "$VENV"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet --disable-pip-version-check \
        "pytest==$PYTEST_VERSION"
fi
exec "$VENV/bin/pytest" test/test_audits.py "$@"
