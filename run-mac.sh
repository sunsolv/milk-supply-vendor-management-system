#!/bin/sh

set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_ROOT"

node_is_compatible() {
  "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19) ? 0 : 1);
  ' >/dev/null 2>&1
}

find_node() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ] && node_is_compatible "$NODE_BIN"; then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    candidate=$(command -v node)
    if node_is_compatible "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  for candidate in \
    /usr/local/opt/node@24/bin/node \
    /usr/local/opt/node@22/bin/node \
    /opt/homebrew/opt/node@24/bin/node \
    /opt/homebrew/opt/node@22/bin/node \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  do
    if [ -x "$candidate" ] && node_is_compatible "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

if ! NODE_EXECUTABLE=$(find_node); then
  echo "Error: Node.js 20.19+, 22.12+, or 24+ is required."
  echo "Set NODE_BIN to a compatible Node executable and try again."
  exit 1
fi

if [ ! -f .env ]; then
  echo "Error: .env is missing. Copy .env.example to .env and configure local values."
  exit 1
fi

if [ ! -d node_modules ] || [ ! -f node_modules/express/package.json ] || [ ! -f node_modules/vite/package.json ]; then
  echo "Error: project dependencies are not installed."
  echo "Run: CI=true pnpm install --frozen-lockfile"
  exit 1
fi

APP_PORT=${PORT:-}
if [ -z "$APP_PORT" ]; then
  APP_PORT=$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' .env | tail -n 1 | tr -d "'\"")
fi
APP_PORT=${APP_PORT:-5173}

case "$APP_PORT" in
  *[!0-9]*|'')
    echo "Error: PORT must be a numeric value."
    exit 1
    ;;
esac

if command -v lsof >/dev/null 2>&1 && lsof -n -P -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Error: port $APP_PORT is already in use. No process was stopped."
  echo "Stop the existing service or set a different PORT in .env."
  exit 1
fi

echo "Using $($NODE_EXECUTABLE --version) from $NODE_EXECUTABLE"
echo "Starting Milk Supply Vendor Management System"
echo "Local URL: http://127.0.0.1:$APP_PORT/"
echo "Press Ctrl-C to stop safely."

# exec lets the server receive Ctrl-C and other termination signals directly.
exec "$NODE_EXECUTABLE" server/index.js
