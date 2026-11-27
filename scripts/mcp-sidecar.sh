#!/usr/bin/env bash
#
# Start a loopback Streamable HTTP MCP sidecar, resolving credentials from
# 1Password at launch. macOS and Linux.
#
# Runs:
#   op run --env-file <refs> -- bun --watch run <entry> --transport http \
#       --port <port> --host 127.0.0.1
#
# <entry> is scripts/dev-sandbox.ts for sandbox, which pins the site to -99 and refuses a
# conflicting MINDBODY_SITE_ID; and src/index.ts for prod.
#
# Manual use only. Nothing here runs at login, by design: the 1Password unlock
# needs a human, and the sidecar only needs to exist while you are working against
# Mindbody.
#
# The refs file holds `op://` pointers only, never secret values. It is gitignored.
#
# Why a sidecar instead of stdio: a client that spawns `op run` itself dies 60s
# after a locked vault with `error initializing client: authorization timeout`,
# with nothing on screen to explain it. Starting it here moves the failure into a
# terminal you can see, and decouples the secret-holding process from the client.
#
# --background assumes the 1Password app integration is enabled, so the unlock
# prompt is a GUI dialog. If your CLI falls back to a console password prompt,
# that prompt would be invisible: use the default foreground mode instead.
#
# Usage:
#   ./scripts/mcp-sidecar.sh                  # sandbox, foreground
#   ./scripts/mcp-sidecar.sh --profile prod   # LIVE Mindbody site
#   ./scripts/mcp-sidecar.sh --background     # detach and poll /health
#   ./scripts/mcp-sidecar.sh --stop
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

PROFILE="sandbox"
PORT="3000"
BACKGROUND="false"
STOP="false"

usage() {
  cat <<'EOF'
Start a loopback Streamable HTTP MCP sidecar, resolving credentials from 1Password.

Options:
  -p, --profile sandbox|prod   Credential profile (default: sandbox)
      --port <n>               Loopback port (default: 3000)
  -d, --background             Detach, then poll /health until it answers
      --stop                   Stop a running sidecar (kills the process tree)
  -h, --help                   Show this help

Examples:
  ./scripts/mcp-sidecar.sh
  ./scripts/mcp-sidecar.sh --profile prod --background
  ./scripts/mcp-sidecar.sh --stop
EOF
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile|-p)
      if [ $# -lt 2 ]; then echo "--profile needs a value (sandbox|prod)" >&2; exit 2; fi
      PROFILE="$2"; shift 2 ;;
    --port)
      if [ $# -lt 2 ]; then echo "--port needs a value" >&2; exit 2; fi
      PORT="$2"; shift 2 ;;
    --background|-d) BACKGROUND="true"; shift ;;
    --stop)       STOP="true"; shift ;;
    --help|-h)    usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 2 ;;
  esac
done

case "$PROFILE" in
  # Sandbox goes through dev-sandbox.ts, which sets MINDBODY_SITE_ID=-99 in code and refuses a conflicting value.
  sandbox) REFS="$ROOT/.env.op-refs";      ENTRY="$ROOT/scripts/dev-sandbox.ts" ;;
  prod)    REFS="$ROOT/.env.op-refs.prod"; ENTRY="$ROOT/src/index.ts" ;;
  *) echo "Invalid --profile '$PROFILE' (expected sandbox or prod)" >&2; exit 2 ;;
esac

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/mindbody-mcp"
mkdir -p "$STATE_DIR"
PID_FILE="$STATE_DIR/sidecar-$PROFILE.pid"
LOG_OUT="$STATE_DIR/sidecar-$PROFILE.log"
LOG_ERR="$STATE_DIR/sidecar-$PROFILE.err.log"

HEALTH_URL="http://127.0.0.1:$PORT/health"
MCP_URL="http://127.0.0.1:$PORT/mcp"

# The loopback URL is written out here, not read from $HEALTH_URL: rule 6 of the gate
# (docs/quality-gates.md) reads a shell script line by line and refuses a client whose
# target is a variable.
healthy() { curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

port_owner_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true
  fi
}

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

# ------------------------------------------------------------------ --stop
if [ "$STOP" = "true" ]; then
  targets=""
  if [ -f "$PID_FILE" ]; then
    targets="$(tr -dc '0-9' <"$PID_FILE")"
  fi
  owner="$(port_owner_pid)"
  if [ -n "$owner" ] && [ "$owner" != "$targets" ]; then
    targets="$targets $owner"
  fi

  if [ -z "$(echo "$targets" | tr -d ' ')" ]; then
    echo "Nothing listening on 127.0.0.1:$PORT and no pid file at $PID_FILE."
    exit 0
  fi

  for pid in $targets; do
    kill_tree "$pid"
  done
  rm -f "$PID_FILE"
  echo "Stopped sidecar (pid $(echo "$targets" | tr ' ' ',')) on port $PORT."
  exit 0
fi

# ------------------------------------------------------------ pre-flight
if healthy; then
  cat <<EOF
Already running and healthy.
  MCP:    $MCP_URL
  health: $HEALTH_URL
  stop:   $0 --stop
EOF
  exit 0
fi

stale="$(port_owner_pid || true)"
if [ -n "${stale:-}" ]; then
  echo "Port $PORT is held by pid $stale but /health does not answer." >&2
  echo "Stop it first: $0 --stop" >&2
  exit 1
fi

if [ ! -f "$REFS" ]; then
  cat >&2 <<EOF
Missing refs file: $REFS

It must contain only op:// pointers, one per line, e.g.
  MINDBODY_API_KEY=op://<vault>/<item>/MINDBODY_API_KEY

and must be gitignored. See .env.op-refs for the sandbox template.
EOF
  exit 1
fi

for tool in op bun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "'$tool' is not on PATH." >&2
    exit 1
  fi
done

if [ "$PROFILE" = "prod" ]; then
  printf '\033[33mPROFILE: prod - this connects to the LIVE Mindbody site.\033[0m\n'
fi

export MCP_ALLOW_UNAUTHENTICATED=true

OP_ARGS=(
  run --env-file "$REFS" --
  bun --watch run "$ENTRY" --transport http --port "$PORT" --host 127.0.0.1
)

# ------------------------------------------------------------- foreground
if [ "$BACKGROUND" != "true" ]; then
  echo "Starting sidecar (foreground). Unlock 1Password when prompted."
  echo "  MCP:    $MCP_URL"
  echo "  health: $HEALTH_URL"
  echo "  stop:   Ctrl-C, or $0 --stop"
  echo
  exec op "${OP_ARGS[@]}"
fi

# ------------------------------------------------------------- background
echo "Starting sidecar in the background. Unlock 1Password when prompted."

nohup op "${OP_ARGS[@]}" >>"$LOG_OUT" 2>>"$LOG_ERR" &
PID=$!
echo "$PID" >"$PID_FILE"
disown "$PID" 2>/dev/null || true

# 90s: the CLI gives up on a locked vault after 60s, so allow a little beyond it
# for a human to answer the prompt.
elapsed=0
while [ "$elapsed" -lt 90 ]; do
  if healthy; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if ! healthy; then
  echo >&2
  echo "Sidecar did not become healthy within 90s. The HTTP health probe may be missing from PATH; check the log." >&2
  if [ -f "$LOG_ERR" ]; then
    echo '--- last stderr lines ---' >&2
    tail -n 15 "$LOG_ERR" >&2
  fi
  # Clean up rather than leaving a zombie holding the port, which would then trip
  # the pre-flight guard on the next run.
  kill_tree "$PID"
  rm -f "$PID_FILE"
  echo "Cleaned up pid $PID." >&2
  exit 1
fi

cat <<EOF

Sidecar is up.
  MCP:    $MCP_URL
  health: $HEALTH_URL
  pid:    $PID  (recorded in $PID_FILE)
  logs:   $LOG_OUT
          $LOG_ERR
  stop:   $0 --stop

Client config (stdio-only clients):
  { "mcpServers": { "mindbody": { "command": "npx",
      "args": ["-y", "mcp-remote", "$MCP_URL"] } } }
EOF
