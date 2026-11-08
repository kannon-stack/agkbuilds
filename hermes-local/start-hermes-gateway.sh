#!/usr/bin/env bash
# Run the Hermes gateway as a long-lived process in tmux (containers have no
# systemd; an auto-started gateway stops itself when idle). Every `hermes`
# client (CLI, TUI, -z one-shots) attaches to this daemon.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
WORKDIR="${WORKDIR:-/root/work}"
LOG="${LOG_DIR:-/root/llm-logs}/hermes-gateway.log"
mkdir -p "$(dirname "$LOG")" "$WORKDIR"

hermes gateway stop --yes >/dev/null 2>&1 || true
tmux kill-session -t hermes 2>/dev/null || true
tmux new-session -d -s hermes "cd '$WORKDIR' && hermes gateway run 2>&1 | tee -a '$LOG'"
sleep 10
hermes gateway status
echo "Attach to its console with: tmux attach -t hermes   (detach: Ctrl-b d)"
