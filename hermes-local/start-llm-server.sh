#!/usr/bin/env bash
# Start a local OpenAI-compatible LLM server for Hermes Agent (CPU-only).
#
# Backend: llama-cpp-python's server (installed from PyPI into /opt/llm-venv).
# Hermes requires >= 64K context, so n_ctx is pinned to 65536 and the KV cache
# is quantized to q8_0 (ggml type 8) to keep RAM use reasonable on a 15 GB box.
#
# Usage:  ./start-llm-server.sh [4b|9b]     (default: 4b)
# Logs:   /root/llm-logs/llama-cpp-server.log
set -euo pipefail

SIZE="${1:-4b}"
case "$SIZE" in
  4b) MODEL=/root/models/Qwen3.5-4B-Q4_K_M.gguf; ALIAS=qwen3.5-4b ;;
  9b) MODEL=/root/models/Qwen3.5-9B-Q4_K_M.gguf; ALIAS=qwen3.5-9b ;;
  *) echo "usage: $0 [4b|9b]" >&2; exit 2 ;;
esac

PORT="${PORT:-8080}"
THREADS="${THREADS:-$(nproc)}"
VENV="${VENV:-/opt/llm-venv}"
LOG_DIR="${LOG_DIR:-/root/llm-logs}"
mkdir -p "$LOG_DIR"

# Stop a previous instance on the same port.
pkill -f "llama_cpp.server.*--port $PORT" 2>/dev/null || true
sleep 1

# logits_all must be false: the server default (true) allocates
# n_ctx x vocab floats (~60 GB at 64K context) and crashes.
setsid nohup "$VENV/bin/python" -m llama_cpp.server \
  --model "$MODEL" \
  --model_alias "$ALIAS" \
  --n_ctx 65536 \
  --n_batch 512 \
  --n_threads "$THREADS" \
  --n_threads_batch "$THREADS" \
  --flash_attn true \
  --type_k 8 --type_v 8 \
  --logits_all false \
  --chat_format chatml-function-calling \
  --host 127.0.0.1 --port "$PORT" \
  > "$LOG_DIR/llama-cpp-server.log" 2>&1 < /dev/null &
disown

echo "Starting $ALIAS on http://127.0.0.1:$PORT/v1 (log: $LOG_DIR/llama-cpp-server.log)"
for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null; then
    echo "Ready:"; curl -s "http://127.0.0.1:$PORT/v1/models"; echo
    exit 0
  fi
  sleep 2
done
echo "Server did not become ready; see $LOG_DIR/llama-cpp-server.log" >&2
exit 1
