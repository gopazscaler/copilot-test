#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

function ensure_node() {
  if command -v node >/dev/null 2>&1; then
    return
  fi

  echo "[INFO] Node.js not found. Installing Node.js LTS via Homebrew..."
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew not found. Install Node.js LTS from https://nodejs.org and re-run." >&2
    exit 1
  fi

  brew install node
}

function ensure_dependencies() {
  if [ ! -f package.json ]; then
    npm init -y >/dev/null 2>&1
  fi
  if [ ! -d node_modules/playwright ]; then
    npm install playwright
  fi
  npx playwright install
}

ensure_node
ensure_dependencies

PARALLELISM="${1:-2}"
if ! [[ "$PARALLELISM" =~ ^[0-9]+$ ]] || [ "$PARALLELISM" -lt 1 ]; then
  PARALLELISM=2
fi

MARKER_FILE="$SCRIPT_DIR/copilot_login_done"
NEEDS_LOGIN=1

if [ -f "$MARKER_FILE" ]; then
  echo "[INFO] Login marker found; verifying existing session..."
  set +e
  AUTH_CHECK_ONLY=1 LOGIN_ONLY=0 HEADLESS=true PARALLELISM="$PARALLELISM" node ./copilot_test.js
  AUTH_EXIT=$?
  set -e
  echo "[INFO] Auth-check exit code $AUTH_EXIT"
  if [ "$AUTH_EXIT" -eq 0 ]; then
    NEEDS_LOGIN=0
    echo "[INFO] Session valid; skipping login-only run."
  elif [ "$AUTH_EXIT" -eq 2 ]; then
    echo "[INFO] Session invalid; login required."
  elif [ "$AUTH_EXIT" -eq 130 ]; then
    echo "[INFO] Auth check cancelled by user (Ctrl+C)."
    exit 130
  else
    echo "Auth check failed (exit code $AUTH_EXIT)." >&2
    exit "$AUTH_EXIT"
  fi
fi

if [ "$NEEDS_LOGIN" -eq 1 ]; then
  echo "[INFO] Starting login-only run (headful)..."
  set +e
  AUTH_CHECK_ONLY=0 LOGIN_ONLY=1 HEADLESS=false PARALLELISM="$PARALLELISM" node ./copilot_test.js
  LOGIN_EXIT=$?
  set -e
  echo "[INFO] Login-only run finished with exit code $LOGIN_EXIT"
  if [ "$LOGIN_EXIT" -eq 130 ]; then
    echo "[INFO] Login-only run cancelled by user (Ctrl+C)."
    exit 130
  fi
  if [ "$LOGIN_EXIT" -ne 0 ]; then
    echo "Login-only run failed (exit code $LOGIN_EXIT)." >&2
    exit "$LOGIN_EXIT"
  fi
  touch "$MARKER_FILE"
fi

echo "[INFO] Starting main run (headless)..."
AUTH_CHECK_ONLY=0 LOGIN_ONLY=0 HEADLESS=true PARALLELISM="$PARALLELISM" node ./copilot_test.js
MAIN_EXIT=$?
if [ "$MAIN_EXIT" -ne 0 ]; then
  echo "[INFO] Main run exited with code $MAIN_EXIT"
  exit "$MAIN_EXIT"
fi
