#!/usr/bin/env bash
# One-time setup of Hermes Agent + a local CPU LLM backend on Ubuntu 24.04 (root).
# Re-runnable: each step skips work that is already done.
#
#   1. llama-cpp-python (PyPI) in /opt/llm-venv  -> runtime for qwen_tool_server.py
#   2. Qwen3.5 GGUF weights from Hugging Face     -> /root/models
#   3. Hermes Agent via the official installer    -> ~/.hermes, ~/.local/bin/hermes
#   4. configure-hermes.sh, start the model server and the gateway
#
# Usage: ./setup.sh [4b|9b|both]   (default: 4b; "both" downloads both, serves 4b)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHICH="${1:-4b}"

echo "== 1/4 llama-cpp-python"
if ! /opt/llm-venv/bin/python -c "import llama_cpp, fastapi, uvicorn, jinja2" 2>/dev/null; then
  command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/)"; exit 1; }
  uv venv /opt/llm-venv --python 3.13 -q
  # Compiles llama.cpp for this CPU (~10 min on 4 cores); needs build-essential + cmake.
  CMAKE_ARGS="-DGGML_NATIVE=ON" uv pip install --python /opt/llm-venv/bin/python \
    "llama-cpp-python[server]==0.3.36"
fi

echo "== 2/4 model weights"
mkdir -p /root/models
fetch() {  # resumable download from unsloth's GGUF repos
  local size="$1" f="/root/models/Qwen3.5-$1-Q4_K_M.gguf"
  [ -s "$f" ] && { echo "  have $f"; return; }
  curl -fL -C - -o "$f" "https://huggingface.co/unsloth/Qwen3.5-$size-GGUF/resolve/main/Qwen3.5-$size-Q4_K_M.gguf"
}
case "$WHICH" in
  4b) fetch 4B ;; 9b) fetch 9B ;; both) fetch 4B; fetch 9B ;;
  *) echo "usage: $0 [4b|9b|both]"; exit 2 ;;
esac

echo "== 3/4 Hermes Agent"
if ! [ -x "$HOME/.local/bin/hermes" ]; then
  # Official installer; --non-interactive skips the provider wizard (Nous Portal first),
  # browser/computer-use downloads are skipped because they are not needed locally.
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
    | bash -s -- --non-interactive --skip-browser --skip-computer-use
fi
export PATH="$HOME/.local/bin:$PATH"
hermes --version | head -1

echo "== 4/4 configure + start"
SERVE="${WHICH/both/4b}"
"$HERE/configure-hermes.sh" "qwen3.5-$SERVE"
"$HERE/start-llm-server.sh" "$SERVE"
"$HERE/start-hermes-gateway.sh"
echo
echo "Try:  cd /root/work && hermes -z 'List the files here.'"
