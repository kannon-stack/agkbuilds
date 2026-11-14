#!/usr/bin/env bash
# Bring the whole local Hermes stack back after a container restart
# (restarts kill the model server and gateway; installs, models and config persist).
# Usage: ./start-all.sh [4b|9b]   (default 4b)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIZE="${1:-4b}"
"$HERE/start-llm-server.sh" "$SIZE"
"$HERE/start-hermes-gateway.sh"
echo "Stack is up. Try: cd /root/work && hermes -z 'say hi'   (first turn takes a few minutes on CPU)"
