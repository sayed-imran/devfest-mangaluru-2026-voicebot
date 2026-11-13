#!/usr/bin/env bash
# Hey Gemma, No Internet — DevFest Mangaluru 2026 workshop setup (macOS / Linux / WSL)
#
#   curl -fsSL https://sayed-imran.github.io/devfest-mangaluru-2026-voicebot/setup.sh | bash
#
# What it does (safe to re-run; anything already present is skipped):
#   1. nvm + Node.js LTS            (no sudo, lives in ~/.nvm)
#   2. Python 3.10+                 (uses yours if it is new enough, else installs one with uv, no sudo)
#   3. clones the workshop repo, runs `npm install` once, and pre-installs the phase 05 Python packages
#
# Options (environment variables):
#   DEVFEST_DIR=~/somewhere   where to clone the repo   (default: ~/devfest-mangaluru-2026-voicebot)
#   SKIP_REPO=1               only install nvm, Node and Python; don't clone or install the workshop

# Everything is inside main(), called on the last line, so a half-downloaded script never runs.
main() {
  set -euo pipefail

  local NVM_VERSION="v0.41.0"
  local NODE_VERSION="24"
  local PYTHON_VERSION="3.12"
  local REPO_URL="https://github.com/sayed-imran/devfest-mangaluru-2026-voicebot.git"
  local DEST="${DEVFEST_DIR:-$HOME/devfest-mangaluru-2026-voicebot}"

  if [ -t 1 ]; then
    B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
  else
    B=""; G=""; Y=""; R=""; D=""; N=""
  fi
  step() { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
  ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
  warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
  die()  { printf '\n%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }

  printf '%sHey Gemma, No Internet%s — DevFest Mangaluru 2026 workshop setup\n' "$B" "$N"

  # ------------------------------------------------------------------ prerequisites
  step "Checking prerequisites"
  local os
  case "$(uname -s)" in
    Darwin) os=mac ;;
    Linux)  os=linux ;;
    *) die "Unsupported OS: $(uname -s). On Windows, use setup.ps1 from the same page." ;;
  esac
  ok "OS: $os ($(uname -m))"

  if [ "$os" = mac ] && ! xcode-select -p >/dev/null 2>&1; then
    # git (and the system python3) are stubs until the Command Line Tools exist.
    xcode-select --install >/dev/null 2>&1 || true
    die "Apple's Command Line Tools are needed for git. An installer window just opened:
   finish it (a few minutes), then run this script again."
  fi

  command -v curl >/dev/null 2>&1 || die "curl is missing. Install it (e.g. sudo apt install curl) and re-run."
  command -v git  >/dev/null 2>&1 || die "git is missing. Install it (e.g. sudo apt install git) and re-run."
  ok "curl and git found"

  # ------------------------------------------------------------------ nvm
  step "nvm (Node Version Manager)"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  # nvm's installer adds itself to your shell profile; make sure that file exists.
  case "${SHELL:-}" in
    */zsh)  [ -f "$HOME/.zshrc" ]  || touch "$HOME/.zshrc" ;;
    */bash) if [ "$os" = mac ]; then [ -f "$HOME/.bash_profile" ] || touch "$HOME/.bash_profile"
            else [ -f "$HOME/.bashrc" ] || touch "$HOME/.bashrc"; fi ;;
  esac

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    ok "already installed in $NVM_DIR"
  else
    mkdir -p "$NVM_DIR"
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash >/dev/null 2>&1 \
      || die "nvm install failed (check your internet connection)."
    ok "installed nvm $NVM_VERSION"
  fi
  # nvm.sh is not written for `set -eu`
  set +eu
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  command -v nvm >/dev/null 2>&1 || die "nvm did not load from $NVM_DIR/nvm.sh"
  ok "nvm $(nvm --version)"

  # ------------------------------------------------------------------ Node.js
  step "Node.js $NODE_VERSION LTS"
  if nvm ls "$NODE_VERSION" >/dev/null 2>&1; then
    ok "Node $NODE_VERSION already installed"
  else
    nvm install "$NODE_VERSION" >/dev/null 2>&1 || die "nvm install $NODE_VERSION failed (check your internet connection)."
    ok "installed Node $NODE_VERSION"
  fi
  nvm use "$NODE_VERSION" >/dev/null || die "nvm use $NODE_VERSION failed."
  nvm alias default "$NODE_VERSION" >/dev/null
  set -eu
  ok "node $(node -v), npm $(npm -v) (set as the default for new terminals)"

  # ------------------------------------------------------------------ Python
  step "Python $PYTHON_VERSION+ (3.10 minimum)"
  # A usable Python must be new enough AND able to create a venv
  # (Debian/Ubuntu ship python3 without venv until python3-venv is installed).
  py_ok() {
    "$1" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1 \
      && "$1" -c 'import venv, ensurepip' >/dev/null 2>&1
  }
  local PY=""
  local cand
  for cand in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$cand" >/dev/null 2>&1 && py_ok "$(command -v "$cand")"; then
      PY="$(command -v "$cand")"; break
    fi
  done

  if [ -n "$PY" ]; then
    ok "using $("$PY" --version) at $PY"
  else
    warn "no Python 3.10+ with venv found; installing Python $PYTHON_VERSION with uv (no sudo)"
    export PATH="$HOME/.local/bin:$PATH"
    if ! command -v uv >/dev/null 2>&1; then
      curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
      export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    fi
    command -v uv >/dev/null 2>&1 || die "uv install failed; install Python 3.10+ from https://www.python.org/downloads/ and re-run."
    uv python install --quiet "$PYTHON_VERSION"
    PY="$(uv python find "$PYTHON_VERSION")"
    py_ok "$PY" || die "Python from uv at $PY is not usable."
    ok "installed $("$PY" --version) at $PY"
  fi

  # ------------------------------------------------------------------ workshop repo
  if [ "${SKIP_REPO:-0}" = 1 ]; then
    step "Skipping the workshop repo (SKIP_REPO=1)"
  else
    step "Workshop repo -> $DEST"
    if [ -d "$DEST/.git" ]; then
      git -C "$DEST" pull --ff-only --quiet || warn "could not fast-forward $DEST; using it as is"
      ok "updated existing clone"
    elif [ -e "$DEST" ]; then
      die "$DEST exists and is not a git clone. Move it away or set DEVFEST_DIR=/another/path."
    else
      git clone --quiet "$REPO_URL" "$DEST"
      ok "cloned"
    fi

    step "npm install (all five phases, one download)"
    (cd "$DEST" && npm_config_update_notifier=false npm install --no-audit --no-fund --loglevel=error)
    ok "node_modules ready"

    step "Phase 05 tools service: Python packages"
    local TS="$DEST/phase-05/tools-service"
    if [ ! -x "$TS/.venv/bin/python" ]; then
      "$PY" -m venv "$TS/.venv"
    fi
    "$TS/.venv/bin/python" -m pip install --disable-pip-version-check -q -r "$TS/requirements.txt"
    ok "$TS/.venv ready ($("$TS/.venv/bin/python" --version))"
  fi

  # ------------------------------------------------------------------ done
  printf '\n%s%s✓ All set.%s\n\n' "$B" "$G" "$N"
  printf '  %sOpen a new terminal%s (so it picks up nvm), then:\n\n' "$B" "$N"
  if [ "${SKIP_REPO:-0}" = 1 ]; then
    printf '    git clone %s\n    cd devfest-mangaluru-2026-voicebot && npm install\n' "$REPO_URL"
  else
    printf '    cd %s\n' "$DEST"
  fi
  printf '    cd phase-01 && npm run dev        %s# http://localhost:3000%s\n\n' "$D" "$N"
  printf '  %sBring headphones. See you at DevFest Mangaluru!%s\n' "$D" "$N"
}

main "$@"
