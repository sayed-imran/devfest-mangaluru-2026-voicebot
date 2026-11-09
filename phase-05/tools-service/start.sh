#!/usr/bin/env bash
# macOS / Linux: create .venv on first run, install requirements, start the tools service.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  if ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
    echo "Python 3.10+ is required (found: $("$PY" --version 2>&1 || echo none))." >&2
    echo "Install it (python.org, Homebrew or your package manager) or run: PYTHON=python3.12 ./start.sh" >&2
    exit 1
  fi
  "$PY" -m venv .venv
fi

.venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt
exec .venv/bin/python -m gemma_tools "$@"
