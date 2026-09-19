#!/usr/bin/env bash
# Stops the test bot and the OpenCode server it started.
#
# POSIX counterpart of stop-test-bot.ps1. Deliberately narrow: it only touches
# processes that provably belong to the test setup.
#   - OpenCode: whatever listens on the port from e2e/.env (OPENCODE_API_URL).
#     Your working OpenCode on another port is never touched.
#   - Bot: node processes whose pid appears in a log file name inside
#     .tmp/e2e/home/logs. A production bot started from the same dist/ writes to
#     a different home, so it is not matched.
#   - Fault proxy: the node process named in .tmp/e2e/fault-proxy/proxy.pid,
#     only if its command line runs fault-proxy.mjs.
#
# Usage:
#   ./e2e/stop-test-bot.sh

set -uo pipefail

# Git Bash / MSYS cannot see native Windows processes: ps, kill and lsof only
# know about the emulation layer, so this script would report "nothing running"
# while the bot and OpenCode are very much alive. Refuse instead of lying.
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "This script cannot see Windows processes and would report a false clean." >&2
    echo "Use the PowerShell version instead:  .\\e2e\\stop-test-bot.ps1" >&2
    exit 2
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname "$script_dir")"
test_home="$project_root/.tmp/e2e/home"
logs_dir="$test_home/logs"
source_env="$script_dir/.env"
proxy_pid_file="$project_root/.tmp/e2e/fault-proxy/proxy.pid"

# --- OpenCode -------------------------------------------------------------

port=4096
if [ -f "$source_env" ]; then
  api_url="$(grep -E '^[[:space:]]*OPENCODE_API_URL[[:space:]]*=' "$source_env" | tail -n 1 || true)"
  if [ -n "$api_url" ]; then
    parsed="$(printf '%s' "$api_url" | sed -n 's/.*:\([0-9][0-9]*\).*/\1/p')"
    [ -n "$parsed" ] && port="$parsed"
  fi
fi

echo "OpenCode port from config: $port"

find_listener() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p=":$port\$" '$4 ~ p' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1
  fi
}

oc_pid="$(find_listener)"
if [ -n "${oc_pid:-}" ]; then
  echo "  stopping OpenCode: PID $oc_pid"
  kill "$oc_pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$oc_pid" 2>/dev/null || break
    sleep 0.3
  done
  if kill -0 "$oc_pid" 2>/dev/null; then
    echo "  still alive, forcing"
    kill -9 "$oc_pid" 2>/dev/null || true
  fi
  echo "  stopped"
else
  echo "  nothing listening on $port"
fi

# --- Test bot -------------------------------------------------------------

stopped=0
if [ -d "$logs_dir" ]; then
  for log in "$logs_dir"/bot-*.log; do
    [ -e "$log" ] || continue
    bot_pid="$(basename "$log" | sed -n 's/.*_\([0-9][0-9]*\)\.log$/\1/p')"
    [ -n "$bot_pid" ] || continue
    kill -0 "$bot_pid" 2>/dev/null || continue

    args="$(ps -p "$bot_pid" -o args= 2>/dev/null || true)"
    case "$args" in
      *dist/index.js*|*dist\\index.js*) ;;
      *) continue ;;
    esac

    echo "  stopping bot: PID $bot_pid"
    kill "$bot_pid" 2>/dev/null || true
    stopped=$((stopped + 1))
  done
fi

[ "$stopped" -eq 0 ] && echo "  no running test bot found"

# --- Fault proxy ----------------------------------------------------------

proxy_stopped=0
if [ -f "$proxy_pid_file" ]; then
  proxy_pid="$(tr -d '[:space:]' < "$proxy_pid_file")"
  if [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null; then
    args="$(ps -p "$proxy_pid" -o args= 2>/dev/null || true)"
    case "$args" in
      *fault-proxy.mjs*)
        echo "  stopping fault proxy: PID $proxy_pid"
        kill "$proxy_pid" 2>/dev/null || true
        proxy_stopped=1
        echo "  stopped"
        ;;
    esac
  fi
  rm -f "$proxy_pid_file"
fi

[ "$proxy_stopped" -eq 0 ] && echo "  no fault proxy running"

# --- Result ---------------------------------------------------------------

sleep 0.5
echo
if [ -n "$(find_listener)" ]; then
  echo "WARNING: port $port is still in use."
else
  echo "Port $port is free."
fi
