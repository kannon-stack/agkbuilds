#!/usr/bin/env bash
# Start the local OpenAI-compatible LLM server for Hermes Agent (CPU-only).
#
# Backend: hermes-local/qwen_tool_server.py on top of llama-cpp-python
# (installed from PyPI into /opt/llm-venv). It renders Qwen3.5's native chat
# template and returns structured tool_calls, which Hermes requires.
# Hermes refuses models with < 64K context, so n_ctx is pinned to 65536 and
# the KV cache is quantized to q8_0 (ggml type 8).
#
# Usage:  ./start-llm-server.sh [4b|9b]     (default: 4b)
# Env:    PORT (8080) THREADS (nproc) VENV (/opt/llm-venv) LOG_DIR (/root/llm-logs)
set -euo pipefail

SIZE="${1:-4b}"
case "$SIZE" in
  4b) MODEL=/root/models/Qwen3.5-4B-Q4_K_M.gguf; ALIAS=qwen3.5-4b ;;
  9b) MODEL=/root/models/Qwen3.5-9B-Q4_K_M.gguf; ALIAS=qwen3.5-9b ;;
  *) echo "usage: $0 [4b|9b]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
THREADS="${THREADS:-$(nproc)}"
VENV="${VENV:-/opt/llm-venv}"
LOG_DIR="${LOG_DIR:-/root/llm-logs}"
mkdir -p "$LOG_DIR"

# Stop a previous instance on the same port (either server flavour).
pkill -f "qwen_tool_server.py.*--port $PORT" 2>/dev/null || true
pkill -f "llama_cpp.server.*--port $PORT" 2>/dev/null || true
sleep 1

setsid nohup "$VENV/bin/python" "$HERE/qwen_tool_server.py" \
  --model "$MODEL" --alias "$ALIAS" \
  --n-ctx 65536 --threads "$THREADS" --batch 512 --kv-type 8 \
  --host 127.0.0.1 --port "$PORT" \
  > "$LOG_DIR/llm-server.log" 2>&1 < /dev/null &
disown

echo "Starting $ALIAS on http://127.0.0.1:$PORT/v1 (log: $LOG_DIR/llm-server.log)"
for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null; then
    echo "Ready:"; curl -s "http://127.0.0.1:$PORT/v1/models"; echo
    exit 0
  fi
  sleep 2
done
echo "Server did not become ready; see $LOG_DIR/llm-server.log" >&2
exit 1
