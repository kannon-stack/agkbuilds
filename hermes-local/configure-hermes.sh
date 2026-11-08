#!/usr/bin/env bash
# Point an installed Hermes Agent at the local LLM server and keep every
# model call on localhost. Idempotent: safe to re-run.
#
# Usage:  ./configure-hermes.sh [model-alias]   (default: qwen3.5-4b)
# Needs:  hermes on PATH (~/.local/bin), server from start-llm-server.sh.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

ALIAS="${1:-qwen3.5-4b}"
PORT="${PORT:-8080}"
WORKDIR="${WORKDIR:-/root/work}"
CFG="${HERMES_HOME:-$HOME/.hermes}/config.yaml"
mkdir -p "$WORKDIR"

set_kv() { hermes config set "$1" "$2" >/dev/null && printf '  %-44s = %s\n' "$1" "$2"; }

echo "Model: local OpenAI-compatible endpoint"
set_kv model.provider custom            # set first: it clears a stale base_url
set_kv model.base_url "http://127.0.0.1:$PORT/v1"
set_kv model.default "$ALIAS"
set_kv model.context_length 65536       # must equal the server's n_ctx (Hermes floor: 64K)
set_kv model.streaming true

echo "Agent behaviour tuned for slow CPU inference"
set_kv agent.reasoning_effort none      # thinking tokens cost minutes on CPU; /reasoning to raise
set_kv agent.max_turns 100
set_kv compression.threshold 0.75
set_kv compression.context_total_ceiling_seconds 1800
set_kv memory.nudge_interval 20         # fewer background reviews competing for the one slot
set_kv skills.creation_nudge_interval 20
set_kv delegation.max_concurrent_children 1

echo "Auxiliary tasks pinned to the main (local) model"
# 'main' resolves to the main custom endpoint (agent/auxiliary_client.py).
# hermes doctor (v0.23.0) still reports "Unknown provider 'main'"; that is cosmetic.
set_kv auxiliary.compression.provider main
set_kv auxiliary.compression.timeout 900
set_kv auxiliary.compression.no_progress_timeout 600
set_kv auxiliary.approval.provider main
set_kv auxiliary.approval.timeout 300
set_kv auxiliary.vision.provider main
set_kv auxiliary.title_generation.enabled false

echo "Local terminal backend, approvals on"
set_kv terminal.backend local
set_kv terminal.cwd "$WORKDIR"
set_kv terminal.timeout 600
set_kv terminal.home_mode real
set_kv approvals.mode manual            # a 4B model should not judge command risk

echo "No silent cloud fallbacks"
set_kv web.keyless_fallback false
set_kv security.allow_lazy_installs false

echo "Timeouts for minutes-long CPU prefill (~/.hermes/.env)"
set_kv HERMES_API_TIMEOUT 3600
set_kv HERMES_STREAM_READ_TIMEOUT 3600
set_kv HERMES_LOCAL_STREAM_STALE_TIMEOUT 3600

# Toolsets that need cloud keys or a browser, or that bloat the prompt
# (every enabled tool schema is prefilled on CPU each new session).
DISABLED='[delegation, connections, browser-use, browser, vision, web, image_gen, tts, computer_use, video, video_gen]'
if grep -qE '^  disabled_toolsets:' "$CFG"; then
  sed -i -E "s|^  disabled_toolsets:.*|  disabled_toolsets: $DISABLED|" "$CFG"
else
  sed -i "/^agent:/a\\  disabled_toolsets: $DISABLED" "$CFG"
fi
grep -qE '^fallback_providers:' "$CFG" || printf '\nfallback_providers: []\n' >> "$CFG"
echo "  agent.disabled_toolsets = $DISABLED"
echo "  fallback_providers = []"

echo
echo "Done. Restart the gateway to apply:  ./start-hermes-gateway.sh"
