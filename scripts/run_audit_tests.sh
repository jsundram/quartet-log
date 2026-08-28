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

echo "note: uv not found, falling back to python3 -m pytest" >&2
python3 -c "import pytest" 2>/dev/null \
    || python3 -m pip install --quiet --disable-pip-version-check "pytest==$PYTEST_VERSION"
exec python3 -m pytest test/test_audits.py "$@"
