#!/usr/bin/env bash
# Start whatever part of the local Hermes stack (model server, gateway) is not running.
# Returns immediately: slow starts happen in a detached background process, because
# loading the model takes ~70 s. Safe to run any number of times.
# Log: /root/llm-logs/autostart.log
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-/root/llm-logs}"; mkdir -p "$LOG_DIR"
export PATH="$HOME/.local/bin:$PATH"
SIZE="${1:-4b}"

# Nothing installed yet (fresh machine): do not trigger downloads here; run setup.sh instead.
for need in /opt/llm-venv/bin/python "$HOME/.local/bin/hermes" "/root/models/Qwen3.5-${SIZE^^}-Q4_K_M.gguf"; do
  [ -e "$need" ] || { echo "Hermes local stack not installed ($need missing); run hermes-local/setup.sh"; exit 0; }
done

# One launch at a time (hook can fire on start, resume, clear and compact in quick succession).
# The lock lives on fd 9, which the background worker holds only while it starts things;
# the long-running servers are started with 9>&- so they never keep it.
exec 9>"$LOG_DIR/autostart.lock"
flock -n 9 || { echo "Hermes local stack is already being started (see $LOG_DIR/autostart.log)."; exit 0; }

need_model=0; need_gateway=0
curl -sf --max-time 3 http://127.0.0.1:8080/v1/models >/dev/null 2>&1 || pgrep -f qwen_tool_server.py >/dev/null || need_model=1
# Capture first: `grep -q` closing the pipe early would trip pipefail (SIGPIPE) and fake a failure.
gw_status="$(hermes gateway status 2>&1 || true)"
case "$gw_status" in *"Gateway is running"*) ;; *) need_gateway=1 ;; esac

if [ $need_model = 0 ] && [ $need_gateway = 0 ]; then
  echo "Hermes local stack already running (model server on :8080, gateway up)."
  exit 0
fi

setsid nohup bash -c "
  echo \"[\$(date -u +%FT%TZ)] autostart: model=$need_model gateway=$need_gateway\"
  [ $need_model = 1 ] && '$HERE/start-llm-server.sh' '$SIZE' 9>&-
  [ $need_gateway = 1 ] && '$HERE/start-hermes-gateway.sh' 9>&-
  echo \"[\$(date -u +%FT%TZ)] autostart: done\"
" >> "$LOG_DIR/autostart.log" 2>&1 < /dev/null &
disown
echo "Hermes local stack was down; starting in background (model server needs ~70 s, then run: cd /root/work && hermes). Progress: $LOG_DIR/autostart.log"
