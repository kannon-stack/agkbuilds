#!/bin/bash
# Restart the local Hermes Agent stack (model server + gateway) when a cloud session
# starts or resumes. A container restart kills both processes; installs, models and
# config persist on disk. Returns immediately; see hermes-local/ensure-running.sh.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
exec "${CLAUDE_PROJECT_DIR:-.}/hermes-local/ensure-running.sh" 4b
