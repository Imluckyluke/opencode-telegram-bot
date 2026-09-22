#!/bin/bash
set -eu
: "${PORT:=4096}"
export OPENCODE_API_URL="http://127.0.0.1:${PORT}"
: "${OPENCODE_SERVER_USERNAME:=opencode}"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then echo "missing TELEGRAM_BOT_TOKEN"; exit 1; fi
if [ -z "${TELEGRAM_ALLOWED_USER_ID:-}" ]; then echo "missing TELEGRAM_ALLOWED_USER_ID"; exit 1; fi
if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ] || [ "${OPENCODE_SERVER_PASSWORD}" = "changeme" ]; then echo "set real OPENCODE_SERVER_PASSWORD"; exit 1; fi

mkdir -p "$HOME/.config/opencode" /app/data/logs /app/data/run /workspace "${TMPDIR:-/app/data/tmp}"
echo "entrypoint: storage ready (HOME=$HOME)"
[ -f "$HOME/.config/opencode/opencode.json" ] || cp /app/opencode.json "$HOME/.config/opencode/opencode.json"

# Optional GitHub access for the agent (GH_TOKEN set in Railway Variables).
# Fine-grained PAT with Contents:read/write on selected repos only. Never logs the token.
if [ -n "${GH_TOKEN:-}" ]; then
  git config --global user.name "${GIT_USER_NAME:-opencode-bot}" >/dev/null 2>&1
  git config --global user.email "${GIT_USER_EMAIL:-opencode-bot@local}" >/dev/null 2>&1
  git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' >/dev/null 2>&1
  git config --global --add safe.directory /workspace >/dev/null 2>&1
fi

start_server() {
  (cd /workspace && opencode serve --hostname 0.0.0.0 --port "$PORT") &
  SERVER_PID=$!
  echo "entrypoint: opencode starting (pid=$SERVER_PID), waiting for $OPENCODE_API_URL"
}

start_bot() {
  node dist/index.js &
  BOT_PID=$!
  echo "entrypoint: bot starting (pid=$BOT_PID)"
}

trap 'SHUTDOWN=1; kill $SERVER_PID $BOT_PID 2>/dev/null; wait' TERM INT

# Supervise both children: a crash used to take down the whole container
# (wait -n). Now only the failed child is restarted; the survivor keeps
# running so chat state and SSE streams are not needlessly dropped.
SHUTDOWN=""
RESTARTS=0
start_server
# wait for initial readiness before starting the bot (bounded, see below)
READY_ATTEMPT=0
for i in $(seq 1 60); do
  READY_ATTEMPT=$i
  if curl -sf --max-time 5 -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" "$OPENCODE_API_URL/app" >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "entrypoint: opencode wait finished after ${READY_ATTEMPT}s"
echo "entrypoint: disk state: $(df -h /app/data 2>/dev/null | tail -1 || echo unavailable)"

if [ -f dist/index.js ]; then
  echo "entrypoint: starting bot ($(node --version))"
else
  echo "entrypoint: FATAL dist/index.js missing, cannot start bot"
  exit 1
fi
start_bot

while [ -z "$SHUTDOWN" ]; do
  wait -n
  STATUS=$?
  if [ -n "$SHUTDOWN" ]; then
    break
  fi
  RESTARTS=$((RESTARTS + 1))
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "entrypoint: opencode server died (status=$STATUS, restarts=$RESTARTS), restarting it"
    start_server
  fi
  if ! kill -0 "$BOT_PID" 2>/dev/null; then
    echo "entrypoint: bot died (status=$STATUS, restarts=$RESTARTS), restarting it"
    start_bot
  fi
  sleep 2
done

echo "entrypoint: shutting down"
kill $SERVER_PID $BOT_PID 2>/dev/null || true
wait
exit 0
