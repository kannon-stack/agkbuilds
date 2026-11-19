# Hermes Agent on a local CPU backend

This folder runs [Hermes Agent](https://hermes-agent.nousresearch.com/docs) (Nous Research, v0.23.0) entirely against a
self-hosted model. It needs no cloud LLM, API key or GPU. It was built and verified in a CPU-only Ubuntu 24.04
container: root, 4 cores, 15 GB RAM.

For how Hermes works internally, every config knob, and the research behind these choices, see
[`../reports/Hermes Agent local backend setup.md`](../reports/Hermes%20Agent%20local%20backend%20setup.md).

```
hermes CLI / TUI / -z one-shot ──► Hermes gateway daemon (tmux "hermes")
                                        │  provider: custom, terminal backend: local
                                        ▼
                     http://127.0.0.1:8080/v1   qwen_tool_server.py
                                        │  native Qwen3.5 chat template, XML→tool_calls,
                                        │  SSE + keepalives, state checkpoints
                                        ▼
                     llama-cpp-python (PyPI) ── Qwen3.5-4B (or 9B) Q4_K_M GGUF, 64K ctx, q8_0 KV
```

## Quick start

```bash
cd hermes-local
./setup.sh 4b            # one-time: llama-cpp-python, model weights, Hermes installer, config, start
```

After a container restart, nothing is reinstalled; just start both processes again:

```bash
./start-llm-server.sh 4b      # or 9b
./start-hermes-gateway.sh
```

Use it:

```bash
cd /root/work
hermes                                   # interactive CLI (needs a TTY)
hermes --tui                             # full-screen TUI
hermes -z "List the files here and say what each one is."   # one-shot, prints the final answer
python3 test_server.py                   # protocol checks for the model server
```

| Script | What it does |
|---|---|
| `setup.sh` | Idempotent installer for all four steps below |
| `start-llm-server.sh [4b\|9b]` | Starts `qwen_tool_server.py` on `127.0.0.1:8080`; log at `/root/llm-logs/llm-server.log` |
| `configure-hermes.sh [alias]` | Points `~/.hermes/config.yaml` and `.env` at the local server, pins auxiliary tasks to it, trims toolsets and raises timeouts |
| `start-hermes-gateway.sh` | Runs `hermes gateway run` in tmux session `hermes`; log at `/root/llm-logs/hermes-gateway.log` |
| `qwen_tool_server.py` | The OpenAI-compatible model server (see below) |
| `test_server.py` | Checks streaming and non-streaming tool calls, a tool-result round trip, and plain chat |

## Why a custom server instead of llama-server or Ollama

The research report recommends llama.cpp's `llama-server --jinja`. In this environment the sandbox blocked
building llama.cpp from GitHub and running the Ollama install script. That left llama-cpp-python, installed
from PyPI, as the inference runtime.

Its bundled server is **not usable with Hermes and Qwen3.5**:

- `--chat_format chatml-function-calling` drops every tool description and every `role: tool` result. The model
  answered in prose instead of calling tools.
- It rejects streaming whenever tools are present ("Automatic streaming tool choice is not supported").
- It rejects assistant messages with `content: null`.
- Its default `logits_all=true` tries to allocate about 60 GB at a 64K context.

`qwen_tool_server.py` (about 550 lines on top of the llama-cpp-python library) fills those gaps:

- **Native template.** It renders the chat template embedded in the GGUF, so the model sees tools and tool
  results in its trained format.
- **Tool-call parsing.** It turns Qwen's `<tool_call><function=…><parameter=…>` XML into OpenAI `tool_calls`.
  Argument types follow the tool's JSON schema.
- **Streaming.** It streams SSE and sends `: keepalive` comments every 15 s while a long prompt is being
  processed. Content is held back once a tool call starts.
- **State checkpoints.** Qwen3.5 is a hybrid recurrent model, so llama.cpp cannot trim its cache back to a
  shared prefix, and every turn would re-process the whole prompt. The server snapshots per-sequence state at
  the end of each prompt and at the end of the tools block. It then restores the longest snapshot that is an
  exact prefix of the next prompt.
- **Context reporting.** It exposes `/props` and `/v1/models` with `n_ctx = 65536`, so Hermes detects the real
  window. Hermes refuses anything below 64K.

If you can run llama.cpp's own server, it is the more standard choice. Replace step 1 with
`llama-server -m <gguf> --jinja -c 65536 -np 1 -t 4 -fa on --cache-type-k q8_0 --cache-type-v q8_0 --port 8080`
and `configure-hermes.sh` works unchanged. Report section "Step-by-step" has the details.

## Verified results (this container, 2026-11-08)

| Check | Result |
|---|---|
| `hermes --version` | v0.23.0, Python 3.14.9, installed via the official `install.sh --non-interactive --skip-browser --skip-computer-use` |
| `test_server.py`, 4B and 9B | All four checks pass |
| `hermes -z "Reply with exactly: …"` | Correct, 85 s |
| Agent task: run `uname -sr && nproc` in the terminal, write the output to `/root/work/proof.txt`, reply | Correct. Three model turns, two tool calls, file verified, 5 m 29 s on a cold cache |
| New session, `wc -l` task | Correct. Reused the 5,268-token tools checkpoint, 2 m 42 s |
| `hermes dump` | `provider: custom`, every LLM and cloud key `not set`, `terminal: local` |

Approximate Qwen3.5-4B Q4_K_M speed on 4 cores:

| Phase | Speed |
|---|---|
| Prompt processing | 50 tok/s on short prompts, about 30 tok/s around 8K tokens |
| Generation | 3.4–4.9 tok/s |
| First turn of a new session | about 2.5 min |
| Each later turn | 5–15 s plus generation |

The 9B runs at about 3 tok/s generation and roughly half the 4B's prompt speed. Resident memory is about 7 GB
with the 4B and about 8 GB with the 9B, including state checkpoints.

## Configuration choices (see `configure-hermes.sh`)

- **Model endpoint.** `model.provider: custom`, `base_url: http://127.0.0.1:8080/v1`, `context_length: 65536`
  (must equal the server's `--n-ctx`), `streaming: true`.
- **Auxiliary tasks.** Compression, approval and vision are all pinned to `provider: main`, so side tasks also
  stay local. Title generation is off, `fallback_providers: []` is set, and `web.keyless_fallback: false` stops
  the keyless web-search vendor ring.
- **Disabled toolsets.** `delegation, connections, browser-use, browser, vision, web, image_gen, tts,
  computer_use, video, video_gen`. These need cloud keys or a browser, or they bloat the prompt that the CPU
  must process each session: tool schemas dropped from 35 KB to 22 KB.
- **Approvals.** `approvals.mode: manual`, and one-shot runs keep the default `single_query_mode: deny`, so
  dangerous commands are refused rather than auto-approved. Don't use `--yolo` on the local backend; it has no
  sandbox.
- **Timeouts.** `HERMES_API_TIMEOUT`, `HERMES_STREAM_READ_TIMEOUT` and `HERMES_LOCAL_STREAM_STALE_TIMEOUT` are
  set to 3600 s, and the compression and approval timeouts are raised, because CPU prompt processing takes
  minutes.
- **Reasoning.** `agent.reasoning_effort: none`. Qwen thinking is off by default in the server, since thinking
  tokens cost minutes on CPU. Start the server with `--thinking`, or send
  `chat_template_kwargs: {enable_thinking: true}`, to turn it on.

## Known quirks

- **`hermes doctor` warning.** It reports `auxiliary.*.provider 'main' cannot be resolved`. This is cosmetic:
  `agent/auxiliary_client.py` resolves `main` to the main custom endpoint, and doctor itself says the task
  "silently runs on the main model".
- **Release-check warning.** `hermes --version` prints `Could not resolve the stable source release: HTTP 403`,
  because the GitHub API is blocked by the container's proxy. It is harmless.
- **Gateway as root.** The gateway runs as root here because the container is single-user and no messaging
  platform is configured. Before connecting Telegram, Discord or similar, follow the docs and run Hermes as a
  dedicated non-root user.
- **Prompt shape.** Hermes probes `/api/tags` (Ollama) and `/version` and gets 404s; that is expected. The first
  turn of each session processes about 3K tokens of system prompt after the cached tools block, because the
  system prompt carries a per-session timestamp.
- **No vision.** Images sent to the local model are replaced by a text placeholder.
