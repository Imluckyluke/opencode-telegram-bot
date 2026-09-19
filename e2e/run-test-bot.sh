#!/usr/bin/env bash
# Starts the bot against an isolated home so e2e runs never touch the real
# .env / settings.json / logs of the working copy.
#
# POSIX counterpart of run-test-bot.ps1.
#
# Usage:
#   ./e2e/run-test-bot.sh
#   ./e2e/run-test-bot.sh --skip-build
#   ./e2e/run-test-bot.sh --fault-proxy     # route Bot API calls through e2e/fault-proxy.mjs

set -euo pipefail

skip_build=0
fault_proxy=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    --fault-proxy) fault_proxy=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--skip-build] [--fault-proxy]" >&2
      exit 2
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(dirname "$script_dir")"
test_home="$project_root/.tmp/e2e/home"
source_env="$script_dir/.env"
runtime_env="$test_home/.env"
proxy_dir="$project_root/.tmp/e2e/fault-proxy"
proxy_pid_file="$proxy_dir/proxy.pid"
proxy_port=8765
proxy_root="http://127.0.0.1:$proxy_port"

test_env_value() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$source_env" | tail -n 1 |
    sed -e "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//" -e 's/[[:space:]]*$//' \
      -e "s/^[\"']//" -e "s/[\"']\$//" || true
}

stop_leftover_fault_proxy() {
  [ -f "$proxy_pid_file" ] || return 0
  local proxy_pid args
  proxy_pid="$(tr -d '[:space:]' < "$proxy_pid_file")"
  if [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null; then
    args="$(ps -p "$proxy_pid" -o args= 2>/dev/null || true)"
    case "$args" in
      *fault-proxy.mjs*)
        echo "Stopping fault proxy left from a previous launch: PID $proxy_pid"
        kill "$proxy_pid" 2>/dev/null || true
        ;;
    esac
  fi
  rm -f "$proxy_pid_file"
}

if [ ! -d "$test_home" ]; then
  mkdir -p "$test_home"
  echo "Created test home: $test_home"
fi

if [ ! -f "$source_env" ]; then
  cp "$script_dir/.env.example" "$source_env"
  echo "Created $source_env from e2e/.env.example."
  echo "Fill in TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID, then run again."
  exit 1
fi

# e2e/.env is the single source of truth. The test home holds runtime state
# only (settings.json, logs), so the config is re-synced on every launch.
cp "$source_env" "$runtime_env"

# dotenv does not override variables that already exist in the environment, so
# anything inherited from the parent shell would silently win over the test
# config. Clear every key the test .env defines.
while IFS= read -r line; do
  case "$line" in
    [A-Za-z_]*=*) unset "${line%%=*}" 2>/dev/null || true ;;
  esac
done < "$runtime_env"

# The bot rejects TELEGRAM_PROXY_URL together with TELEGRAM_API_ROOT, and the
# fault proxy cannot tunnel through a SOCKS/HTTP proxy itself.
if [ "$fault_proxy" -eq 1 ] && [ -n "$(test_env_value TELEGRAM_PROXY_URL)" ]; then
  echo "--fault-proxy cannot be used while e2e/.env sets TELEGRAM_PROXY_URL." >&2
  exit 1
fi

if [ "$skip_build" -eq 0 ]; then
  echo "Building..."
  (cd "$project_root" && npm run build)
fi

export OPENCODE_TELEGRAM_HOME="$test_home"

if [ "$fault_proxy" -eq 1 ]; then
  stop_leftover_fault_proxy
  mkdir -p "$proxy_dir"

  # A stand that reaches Telegram through its own reverse proxy keeps doing so:
  # that root becomes the fault proxy's upstream.
  upstream="$(test_env_value TELEGRAM_API_ROOT)"
  [ -n "$upstream" ] || upstream="https://api.telegram.org"

  proxy_output="$proxy_dir/proxy-output.log"
  nohup node "$script_dir/fault-proxy.mjs" --port "$proxy_port" --upstream "$upstream" \
    > "$proxy_output" 2>&1 &

  ready=0
  for _ in $(seq 1 20); do
    if node -e "fetch('$proxy_root/__fault/state').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
      ready=1
      break
    fi
    sleep 0.25
  done
  if [ "$ready" -eq 0 ]; then
    echo "Fault proxy did not come up on port $proxy_port. See $proxy_output" >&2
    exit 1
  fi

  # exec below replaces this shell, so the variable reaches the bot process only.
  export TELEGRAM_API_ROOT="$proxy_root"
fi

echo
echo "Test home : $test_home"
echo "Logs      : $test_home/logs"
echo "Settings  : $test_home/settings.json"
if [ "$fault_proxy" -eq 1 ]; then
  echo "Proxy     : $proxy_root -> $upstream (control: $proxy_root/__fault/state)"
  echo "Call log  : $proxy_dir"
fi
echo

exec node "$project_root/dist/index.js"
