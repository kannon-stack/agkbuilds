# Pinning Hermes Agent to a Local Brain

Hermes Agent is Nous Research's MIT-licensed Python agent. The latest release is **v0.23.0 "The Hearth Release" (5 November 2026)**. Every front end it offers runs the same synchronous tool-calling loop: the CLI, the TUI, the desktop app, about 20 messaging platforms, an OpenAI-compatible API server, ACP editor integration and cron. **Since v0.23.0, one gateway daemon per machine owns every session**, so even a lone terminal user is a client of a local server. The whole design is built around a system prompt that stays byte-for-byte identical for the length of a session:

- memory is two small frozen files (2,200 and 1,375 characters);
- procedures live in skills that load only when needed;
- history sits in SQLite with full-text search;
- context compression is the only time the prompt cache is deliberately broken, and by default it fires at 50% of the window.

Hermes runs entirely against a self-hosted model when you set `provider: custom` and point it at any `/v1/chat/completions` server that returns structured `tool_calls`. It **refuses any model with less than 64,000 tokens of context**, and the code offers no supported way to lower that.

On a CPU-only container with 4 cores, 15 GB of RAM and no GPU, the setup I recommend has three parts:

- **Server:** llama-server built from source, serving **Qwen3.5-9B at Q4_K_M with `--jinja -c 65536 -np 1` and a q8_0 KV cache**, roughly 9–10 GB resident.
- **Hermes config:** `model.context_length: 65536` pinned to match the server, streaming timeouts raised to an hour, and every auxiliary slot pinned to the main model.
- **Hygiene:** no cloud API keys, no fallback providers, the keyless web vendor ring and Edge TTS turned off, and unused toolsets removed. The fixed prompt costs minutes of CPU prefill, so every toolset you remove helps.

The rest of the report explains each subsystem, then gives a copy-paste recipe, verification steps, a troubleshooting table and about two dozen places where the docs contradict each other. Those contradictions are the reason for the rule this report follows throughout: set values explicitly instead of trusting defaults.

## One synchronous loop powers every Hermes front end

Hermes calls itself "the self-improving AI agent built by Nous Research". It claims "a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, searches its own past conversations" ([README](https://github.com/NousResearch/hermes-agent/blob/main/README.md)).

The root AGENTS.md describes the shape of the system. The same agent core runs across "a CLI, a messaging gateway (Telegram, Discord, Slack, ~20 platforms), a TUI, and an Electron desktop app". It is "extended primarily through plugins and skills, not by growing the core" ([AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)). The code is Python, with TypeScript for the desktop app, TUI and website, and current installs run only on **Python 3.14** ([Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)).

The project moves fast. Ten releases shipped between 12 October and 5 November 2026, from v0.21.7 to v0.23.0 ([GitHub Releases](https://github.com/NousResearch/hermes-agent/releases)). Versioning switched from CalVer to SemVer at 0.21.5, and the last CalVer release was v2026.9.24. The committed project version is always `0.0.0`, so only the release tag or `hermes --version` tells you what you are running ([Stable releases](https://hermes-agent.nousresearch.com/docs/developer-guide/stable-releases)). The architecture page counts "70+ registered tools across ~28 toolsets", "25+ platform adapters" and about 25,000 tests ([Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)).

### The turn loop

`run_agent.py` is now "a thin facade". The loop itself lives in `agent/conversation_loop.py`, and each phase of a turn has its own `agent/turn_*.py` file: preflight, request assembly, API call, error handling, overflow, truncation, compaction and recovery ([Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop); [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)).

A turn proceeds in this order:

1. Generate a task id and append the user message.
2. Build the system prompt, or reuse the cached one.
3. Run a preflight compression check.
4. Convert messages into one of three wire formats: `chat_completions` (the OpenAI-compatible default), `codex_responses`, or `anthropic_messages`.
5. Inject ephemeral layers such as budget warnings.
6. Make an interruptible model call.
7. If the model returned tool calls, execute them and go back to step 4. If it returned plain text, the turn ends: the session is saved and memory is flushed ([Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)).

The HTTP call runs on a background thread, so a new message or `/stop` can abandon it. A partial response never enters history. Roles must strictly alternate (never two assistant or two user messages in a row), and `/steer` is the one sanctioned exception. The loop stops at **500 iterations** by default (`agent.max_turns`) and returns a summary of the work done. `fallback_providers` are tried in order on 429, 5xx, 401 or 403 responses ([Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)).

### How tools are registered and run

Each `tools/*.py` module calls `registry.register(...)` when it is imported. `discover_builtin_tools()` uses an AST scan so that it imports only modules that actually register something. A `check_fn` decides whether a tool is available when the schema list is built. A registration that would shadow a tool from a different toolset is rejected unless it passes `override=True` ([Tools Runtime](https://hermes-agent.nousresearch.com/docs/developer-guide/tools-runtime)).

When one model response contains several tool calls, they run concurrently in a `ThreadPoolExecutor`, and the results are put back in their original order. Interactive tools such as `clarify` force sequential execution. Each call goes through a `pre_tool_call` plugin hook, the dangerous-command check, the tool itself and a `post_tool_call` hook. Four "agent-level" tools touch agent state, so they are intercepted before the registry: `todo`, `memory`, `session_search` and `delegate_task` ([Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)).

Two design rules explain why the core stays small. One: "Every model tool is sent on every API call, so the bar for a new core tool is high." Two: "Per-conversation prompt caching is sacred… the ONE exception is context compression" ([AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)). An opt-in Tool Search mode replaces MCP and non-core plugin tools with three bridge tools that load schemas on demand ([Tool Search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search)). That is a real lever when a local model has a small window.

### One gateway owns every session

The biggest recent architectural change is about who owns a session. The v0.23.0 notes say: "One gateway owns every conversation … each machine runs one gateway that owns every session, and every surface attaches to it as a client" ([GitHub Releases](https://github.com/NousResearch/hermes-agent/releases)). The profile's gateway is "the only writer of canonical sessions". `hermes chat`, the TUI, Desktop, the API server, ACP and cron all submit input to it over `/api/ws` ([Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)).

In practice, `hermes chat` "no longer runs the agent inside your terminal process". It runs `hermes gateway ensure`, attaches over a local WebSocket, and freezes these settings into the session when it is created: working directory, model, provider, toolsets, max turns, YOLO and base URL. The classic CLI exposes only ten slash commands: `/stop`, `/approve`, `/answer`, `/discard`, `/branch`, `/model`, `/compress`, `/yolo`, `/help` and `/quit`. `hermes --tui` has the full slash-command registry ([CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli)). Once the new gateway has written `state.db`, rolling back to an older version is unsupported ([Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)).

## A frozen prompt keeps memory tiny and pushes knowledge into skills

### Three prompt tiers are frozen for the whole session

`agent/system_prompt.py` builds the system prompt once per session, in three tiers ([Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)):

- **Stable tier.** Identity comes from `~/.hermes/SOUL.md` if it exists. Otherwise Hermes uses a built-in identity that begins "You are Hermes Agent, built by Nous Research". This tier also holds tool and model guidance and a coding brief.
- **Context tier.** This holds any caller-supplied system message plus exactly one project context file. The first match wins, in this order: `.hermes.md`/`HERMES.md` (walking up to the git root), then `AGENTS.md`, `CLAUDE.md`, and `.cursorrules` or `.cursor/rules/*.mdc` in the working directory. The tier also includes a git workspace snapshot, operator instructions and platform hints.
- **Volatile tier.** This holds the skills index, the frozen `MEMORY.md` and `USER.md` snapshots, any external memory-provider block, a timestamp/session/model line, and runtime hints such as host, home and working directory.

Context files are scanned for prompt injection; a file that trips the scanner is replaced with a `[BLOCKED: …]` marker. They are also stripped of frontmatter and truncated with a 70/20 head/tail split, with a cap that ranges from a 20,000-character floor to a 500K ceiling.

Anything that changes during a session is delivered somewhere other than the system prompt:

- Subdirectory `AGENTS.md` hints are appended to tool results, capped at 32,000 characters.
- Skill invocations arrive as user messages.
- Ephemeral layers, such as `HERMES_EPHEMERAL_SYSTEM_PROMPT` or context from a `pre_llm_call` plugin, are appended to the current user message and never cached ([Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly); [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)).

SOUL.md is meant for tone and personality, not for repo conventions or paths ([Use SOUL.md with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-soul-with-hermes)).

Two consequences follow. First, edits to SOUL.md, to memory, or to config that affects the prompt take effect in the next session or after the next compaction, not immediately. Second, the prompt prefix stays identical from turn to turn, so a single-slot llama-server can reuse its KV cache and process only the new tokens. That second point is my inference from the design rather than a documented claim, but it is the property that decides whether Hermes is usable on a CPU.

### Memory is capped at 3,575 characters on purpose

Built-in memory is two files in `~/.hermes/memories/` that the agent curates itself:

- `MEMORY.md` holds the agent's own notes, up to **2,200 characters (about 800 tokens)**.
- `USER.md` holds the user profile, up to **1,375 characters (about 500 tokens)**.

Both are injected as a frozen snapshot at session start, with a usage header such as `[67% — 1,474/2,200 chars]` ([Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)).

The `memory` tool has only three actions, `add`, `patch` and `remove`, each aimed at a `target` of `memory` or `user`. A `replace` action used to exist and was removed because models used it to wipe entries holding several facts. There is no read action, because the content is already in the prompt. There is also no auto-compaction: a write that would exceed the limit fails, and the agent must remove and add entries in a single `operations` batch. All writes are scanned for injection and exfiltration patterns.

After a turn, a background "self-improvement review" can run as a fork on the main model and save memories or update skills:

- `auxiliary.background_review` reroutes it to another model or disables it.
- `memory.write_approval: true` stages its writes for approval.
- `memory.nudge_interval` and `skills.creation_nudge_interval` set how often it runs; both default to **10** in source ([Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory); [agent/agent_init.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/agent_init.py)).

The docs give three warnings. Local models under roughly 30B "often claim to save memory without calling the tool". A gateway chat is one continuous session until you send `/new`. Two agents must never share one Hermes home.

You can add exactly one external memory provider on top of the built-in files: Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory or Memori. It prefetches context before each turn, syncs turns afterward, and adds its own tools, while built-in memory keeps working "exactly as before". Honcho needs either an app.honcho.dev key or a self-hosted `baseUrl` ([Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)).

Recall of past conversations comes from `session_search`. It queries SQLite FTS5 in about 20 ms and returns the actual messages, with no LLM summarization and no truncation ([Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)).

### Skills are the real long-term store

A skill is a folder containing a `SKILL.md` (YAML frontmatter plus Markdown), stored under `~/.hermes/skills/<category>/<name>/`. Skills follow the agentskills.io standard and load in three levels ([Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)):

1. An index of names and descriptions, about 3k tokens, sits in the prompt.
2. `skill_view(name)` loads the full body.
3. `skill_view(name, path)` loads one reference file.

Frontmatter fields include `name`, `description`, `version`, `platforms` and `required_environment_variables`, plus Hermes-specific `metadata.hermes` keys such as `requires_toolsets` and `fallback_for_tools`. Every installed skill becomes a slash command, and up to five can be stacked in one message. Invoking a skill injects a user message; it never changes the system prompt.

The agent writes its own skills with `skill_manage`, which can create, patch and delete skills and write or remove their supporting files. The system prompt tells it to capture "lessons, not logs". `/learn` turns a directory, URL or book into a knowledge-base skill.

Skills load in this order of precedence:

1. Project skills in `<repo>/.hermes/skills/` and `<repo>/.agents/skills/`. These load only after `hermes skills trust`.
2. Local skills in `~/.hermes/skills/`.
3. `skills.create_dir`, then `skills.external_dirs`.

The Skills Hub installs from official optional skills, skills.sh, ClawHub, LobeHub, GitHub and `/.well-known/skills/` endpoints. Each install is quarantined, scanned and recorded in `skills/.hub/lock.json`. A background curator runs on inactivity, by default every 168 hours once the system has been idle for 2 hours. It marks unused agent-created skills stale after 14 days and archives them after 30; pinned skills and skills used by cron jobs are exempt ([Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)).

The skills index matters for local deployments for one reason: bundled skills are copied into `~/.hermes/skills/` at install time, so the index adds to the fixed prompt. Uninstalling skills you don't use is one of the documented ways to shorten CPU prefill ([Ollama guide](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup)).

## Sessions live in SQLite and compress at half the window, with a hard 64K floor

### Storage and resume

Sessions persist in `<HERMES_HOME>/state.db`. It is a WAL-mode SQLite database with FTS5 and trigram indexes, and it replaced the earlier per-session JSONL files. Its tables cover sessions, messages, per-model usage, gateway routing, compression locks, async delegations and delivery obligations. Lineage between sessions is tracked through `parent_session_id` ([Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)).

To resume, use `hermes --continue` (or `-c` with a title), `hermes --resume` with an id, title or `latest`, or `/resume` inside a session. Resuming restores the working directory and shows a recap. `hermes sessions` also offers list, export, prune (90 days by default), repair and recover ([Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions); [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)).

### Compression

Compression runs at two levels. The gateway runs a hygiene pass at a fixed **85%** of the window as a safety net. Inside the agent, the `ContextCompressor` fires at **50%** by default, based on token counts reported by the API ([Context Compression & Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)).

The compressor works in four steps:

1. Replace old tool outputs longer than 200 characters with a placeholder. This step makes no LLM call.
2. Keep a head (the system prompt plus the first exchange) and a tail sized by a token budget. With `tail_mode: lean` the tail is 2.5% of the window, clamped to 10K–25K tokens; `protect_last_n` defaults to 20.
3. Ask the auxiliary compression model for a structured summary with sections such as Goal, Constraints & Preferences, Progress Done and In Progress.
4. Reassemble head, summary and tail, and repair any tool-call pairs that lost one half.

Later compressions update the previous summary instead of starting over.

The summarizer "**must** have a context window at least as large as your main agent model's". If it does not, "the middle turns are **dropped without a summary**" ([Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#context-compression)). The source also requires it to meet the 64K floor ([agent/conversation_compression.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/conversation_compression.py)). A failed summary arms a cooldown of 60, then 300, then 900 seconds, and after repeated failures Hermes commits a deterministic fallback summary.

Current builds compact in place: old rows are archived with `active=0` and the session id stays the same ([Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)). The compression engine is pluggable through `context.engine`, which defaults to `compressor`; plugin engines such as `lcm` are never turned on automatically. Hermes also implements Anthropic-style prompt caching (the "system_and_3" strategy, with about 75% input savings claimed), but that does nothing for a local llama-server, whose own prefix cache plays the same role ([Context Compression & Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)).

### The 64K floor is enforced in code

The floor is in the code: `MINIMUM_CONTEXT_LENGTH = 64_000` in `agent/model_metadata.py`, with context probe tiers running from 256K down to 8K. The comment says: "Sessions, model switches and cron jobs reject models below this" ([model_metadata.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/model_metadata.py)). A local endpoint below the floor gets an explicit refusal: "Your local server is serving a N-token window. Start it with at least 64K context (llama.cpp: -c 64000; vLLM: --max-model-len; Ollama: OLLAMA_CONTEXT_LENGTH=64000 or a Modelfile num_ctx)…" ([agent_init.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/agent_init.py)).

Overstating the window does not get around it. A second check runs whenever tools are attached and compares the server's real `num_ctx` against the floor. Setting `context_length: 65536` in front of a 32K server passes startup and then fails at runtime ([#53347](https://github.com/NousResearch/hermes-agent/issues/53347)).

There is no supported override. The feature request to "warn instead of hard failure" is open and labelled `needs-decision`, and PR #116645 proposes an explicit opt-in ([#53347](https://github.com/NousResearch/hermes-agent/issues/53347)). The only exception in source is the `lmstudio` provider when it has an explicit positive `context_length` ([agent_init.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/agent_init.py)).

Hermes works out the context length through a nine-step chain ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#context-length-detection)):

1. The `model.context_length` pin. It is shown as `(pinned)` and is dropped automatically when you switch model, provider or base URL.
2. Per-provider model entries.
3. A persistent cache.
4. The endpoint's `/models`.
5. Anthropic's `/v1/models`.
6. OpenRouter.
7. Nous Portal.
8. models.dev.
9. A 128K fallback.

For llama.cpp, Hermes reads the `n_ctx` the server actually allocated from `/v1/props` or `/props`, which takes priority over `/v1/models` metadata ([model_metadata.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/model_metadata.py)).

### Delegation, code execution and trajectories

Two mechanisms keep intermediate tokens out of the parent's context:

- **`delegate_task`** spawns child `AIAgent`s, each with a fresh conversation, the parent's tools and its own terminal session. Only each child's final summary comes back. Up to **10** children run at once by default, nesting is off (`max_spawn_depth: 1`), and there is no wall-clock timeout, only a monitor that detects stalls ([Subagent Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)).
- **`execute_code`** lets the model write Python that imports a generated `hermes_tools` stub. The script can call `web_search`, `read_file`, `write_file`, `search_files`, `patch` and foreground `terminal` over a Unix-socket RPC. "Only the script's `print()` output is returned to the LLM." Each run is limited to 300 seconds, 50 KB of stdout and 50 tool calls ([Code Execution](https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution)).

On a single-slot CPU server, delegation gains no real parallelism: the children queue behind each other, and each one needs its own window of at least 64K. `execute_code`, by contrast, saves model turns outright.

Finally, `save_trajectories` and `batch_runner.py` write ShareGPT-format JSONL for training tool-calling models. This is a research feature and plays no part in everyday use ([Trajectory Format](https://hermes-agent.nousresearch.com/docs/developer-guide/trajectory-format); [Batch Processing](https://hermes-agent.nousresearch.com/docs/user-guide/features/batch-processing)).

## Tools, MCP, plugins and the gateway all live at the edges

### About 85 tools, most of which work without any cloud

The current registry holds about 85 tools ([Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)), grouped into toolsets ([Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)):

- **Core toolsets:** `file` (`read_file`, `write_file`, `patch`, `search_files`), `terminal` (`terminal`, `process_manage`), `web` (`web_search`, `web_extract`), `browser` (`browser_exec` plus three helpers), `memory`, `skills`, `todo`, `session_search`, `clarify`, `code_execution`, `delegation`, `cronjob`, `vision`, `image_gen` and `tts`.
- **Opt-in toolsets:** `video`, `kanban`, `x_search` and others.
- **Composites:** `coding`, `debugging`, and a `safe` set with no file writes or terminal.
- **Platform toolsets:** `hermes-cli` is the full default. `hermes-api-server` and `hermes-acp` drop the interactive tools, and `hermes-webhook` is a restricted subset.

There is deliberately no `send_message` tool that the agent can call. Outbound messages go through cron or `hermes send` ([toolsets.py](https://github.com/NousResearch/hermes-agent/blob/main/toolsets.py)). v0.23.0 removed the ten old `browser_*` tools in favor of `browser_exec`, which runs model-written Python against the browser over the Chrome DevTools Protocol ([Gradually AI changelog](https://www.gradually.ai/en/changelogs/hermes-agent/); [Browser Automation](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser)).

You can switch toolsets on and off in four places:

- `hermes tools`, per platform, saved to config.
- `--toolsets` for a single run.
- `/tools disable browser` inside a session.
- `agent.disabled_toolsets`, a global kill switch that "applies after per-platform tool config … so a toolset listed here is always removed" ([Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)).

| Capability | Fully local | Free, but calls a third party | Needs a paid key or subscription |
|---|---|---|---|
| Terminal, file, todo, clarify, code execution, cron | Yes, on the local, docker or ssh backends | — | — |
| Memory, skills, session search | Built-in memory, local skills, FTS5 search | Installing from the Skills Hub | Cloud memory such as Honcho or Supermemory |
| Web search and extract | Self-hosted SearXNG; the `web-local` extract plugin (httpx + trafilatura) | The default keyless ring (Exa, Parallel, Firecrawl, Keenable); DDGS | Perplexity, xAI, OpenAI native, paid vendor tiers |
| Browser | Bundled headless Chromium; Lightpanda | — | Browserbase, Browser Use, Firecrawl cloud, Nous |
| Vision | A multimodal main model, or a local VLM set in `auxiliary.vision` | — | A cloud VLM through an auxiliary slot |
| Text to speech | Piper, KittenTTS, NeuTTS | Edge TTS (the default) | ElevenLabs, OpenAI, MiniMax, Mistral, Gemini, xAI |
| Speech to text | faster-whisper (downloads its model from Hugging Face once) | — | Groq, OpenAI |
| Image and video generation | A local OpenAI-compatible endpoint via `image_gen.openai.base_url` | — | FAL, OpenAI, xAI, Krea, DeepInfra |

Sources for the table: [Web Search & Extract](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search), [web-local plugin](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/web-local.yaml), [Browser Automation](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser), [TTS/STT](https://hermes-agent.nousresearch.com/docs/user-guide/features/tts), [Vision](https://hermes-agent.nousresearch.com/docs/user-guide/features/vision), [Image Generation](https://hermes-agent.nousresearch.com/docs/user-guide/features/image-generation).

The paid Nous Tool Gateway routes "web search, image generation, text-to-speech, and cloud browser automation" through Nous infrastructure, and `hermes setup --portal` turns it on ([Tool Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-gateway)).

### MCP: a built-in client, and a server via plugin

MCP client support "ships with the standard install". Servers are declared under `mcp_servers:` in `config.yaml`:

- **stdio servers** use `command`, `args`, `env` and `cwd`.
- **HTTP servers** use `url` and `headers`. They default to Streamable HTTP; set `transport: sse` for SSE.
- **Common options:** OAuth 2.1 with PKCE (`auth: oauth`), mTLS, `timeout` (default 300 s), `connect_timeout` (60 s), `lazy: true` (spawn the server on first call), and include/exclude glob filters (if both are set, `include` wins).
- **Trust and cost:** `trust: untrusted` makes every write-capable call require approval, and `tool_costs`/`spend_limit` cap spending ([MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp); [MCP Config Reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)).

At runtime:

- Discovery connects at most four servers at a time.
- A `tools/list_changed` notification triggers a re-fetch, and `/reload-mcp` reloads servers.
- A running gateway picks up config edits within about a minute.
- Failed connections retry with backoff from 30 seconds up to 10 minutes.
- Each server becomes a toolset named `mcp-<server>`.

Hermes does not pass your full shell environment to stdio servers, only the configured `env` plus a safe baseline. It strips invisible Unicode tag characters from results and redacts tokens from error messages.

Management commands are `hermes mcp add`, `list`, `test`, `configure` and `login`, plus a curated catalog in `optional-mcps/` ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)). Hermes can also *be* an MCP server, but since v0.23.0 only through the official `mcp-serve` plugin. Install it with `hermes plugins install mcp-serve`; clients then use `{"command": "hermes", "args": ["mcp-serve"]}`. The old built-in `hermes mcp serve` no longer exists. The plugin exposes conversations, events, sending and approvals. With `--tools` it also exposes web, browser, vision, image, skills and TTS tools, but never terminal, file or kanban tools ([MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp); [mcp-serve.yaml](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/mcp-serve.yaml)).

Local stdio MCP servers work offline. Servers launched with `npx` or `uvx` need their packages fetched while the network is available. If you add many MCP tools, turn on Tool Search so their schemas stay out of the fixed prompt.

### The messaging gateway

The gateway is "a single background process that connects to all your configured platforms, handles sessions, runs cron jobs, and delivers voice messages" ([Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)). Supported platforms include Telegram, Discord, Slack, Google Chat, WhatsApp (Baileys bridge or Cloud API), Signal, SMS, Email, Home Assistant (now a plugin), Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Weixin, BlueBubbles, QQ, Microsoft Teams, LINE, ntfy, IRC, SimpleX and others.

The gateway **denies everyone by default**. A user gets in only through one of these routes:

- a per-platform allowlist such as `TELEGRAM_ALLOWED_USERS`, or the global `GATEWAY_ALLOWED_USERS`;
- DM pairing, approved with `hermes pairing approve <platform> <code>`. Codes expire after one hour and are rate-limited;
- `GATEWAY_ALLOW_ALL_USERS=true`, which the docs explicitly do not recommend.

To run the gateway, use `hermes gateway setup`, `hermes gateway install` (a systemd user service, or `--system` for a boot-time service), or `hermes gateway run` in the foreground. The docs recommend the foreground form for WSL, Docker and Termux ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)). Under a wrapper supervisor, add `--external-supervisor`; restarts then exit with code 75 so the supervisor can relaunch.

Webhooks listen on port 8644 and validate HMAC signatures. By default they get only `web_search`, `web_extract`, `vision_analyze` and `clarify`, "because webhook payloads can carry untrusted third-party content" ([Webhooks](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks)).

Platforms that can run without any vendor cloud are Matrix, Mattermost, IRC, self-hosted ntfy, LAN email, Home Assistant, webhooks and the API server. This is my inference from the transport each one uses.

### Cron

All scheduling goes through one tool, `cronjob_manage`. You can create jobs with `/cron add "every 2h" "Check server status"` in chat, with `hermes cron create` on the command line, or in plain language ("Every morning at 9am…"). There is also a no-agent mode that runs a script and delivers its stdout verbatim, with no LLM involved ([Scheduled Tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)).

Key facts:

- **Execution:** "Cron execution is handled by the gateway daemon", which ticks every 60 seconds and runs due jobs in isolated agent sessions. `hermes cron tick` still needs the gateway running.
- **Storage:** jobs live in `~/.hermes/cron/jobs.json`, and their output in `~/.hermes/cron/output/<job_id>/`.
- **Model choice:** a per-job pin wins, then `cron.model`, then the main model at the time the job fires. The agent itself cannot repoint a job's model.
- **Delivery:** to the chat that created the job, to local files (the CLI default), or to any platform target.
- **Safety:** dangerous commands are denied headlessly (`approvals.cron_mode: deny`), and agents launched by the scheduler cannot use `cronjob_manage` by default ([Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)).

### API server, ACP and other front ends

The gateway can expose an OpenAI-compatible API at `127.0.0.1:8642`. Turn it on with `API_SERVER_ENABLED=true` and an `API_SERVER_KEY`; the key is required "whenever the API server is enabled", even on loopback. Clients call `http://localhost:8642/v1` with `model: "hermes-agent"` ([API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server); [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables)). It serves:

- `/v1/chat/completions`, `/v1/responses`, `/v1/models` and health endpoints;
- a Runs API that streams events over SSE and accepts approval and clarify answers;
- Jobs and Sessions APIs.

That is enough for Open WebUI, LobeChat or LibreChat to sit in front of the full agent. API sessions get the `hermes-api-server` toolset, and dangerous commands fall under `approvals.unattended_mode: deny` ([Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)).

ACP lets editors talk to Hermes over stdio ([ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)):

- **Install the extra:** `cd ~/.hermes/hermes-agent && python -c "import pm; pm.sync_venv(['acp'], explicit=True)"`.
- **Launch and check:** `hermes acp`, and `hermes acp --check` to verify.
- **VS Code:** the ACP Client extension, with `{"command":"hermes","args":["acp"]}`.
- **Zed:** a custom `agent_servers` entry.
- **JetBrains:** any ACP-compatible plugin.

Other front ends:

- the TUI (`hermes --tui`);
- a native desktop app for macOS (Apple Silicon), Windows and Linux;
- a dashboard (`hermes dashboard`, port 9119; a public bind requires an auth provider);
- a browser "webapp", off by default (`webapp.enabled`) ([Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop); [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)).

For Python embedding, use `from run_agent import AIAgent` from a source checkout. There is no supported wheel ([Python Library](https://hermes-agent.nousresearch.com/docs/guides/python-library)).

### Plugins and hooks

A plugin is a directory in `~/.hermes/plugins/<name>/` containing a `plugin.yaml` and an `__init__.py` with a `register(ctx)` function. Through `ctx`, a plugin can register:

- tools, hooks, slash commands and CLI subcommands;
- skills and gateway platforms;
- image and video backends;
- delegation, terminal, computer-use and approval-transport providers.

It can also borrow the user's model with `ctx.llm.complete(...)` ([Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)).

General plugins load nothing until their name is added to `plugins.enabled`. Project-local `.hermes/plugins/` folders are "Not loaded by the gateway that runs sessions". The catalog (`hermes plugins install <name>`) has about 1,200 entries, each pinned to a reviewed commit SHA ([plugin-catalog](https://github.com/NousResearch/hermes-agent/tree/main/plugin-catalog)).

There are four hook systems ([Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)):

- **Gateway hooks** (`HOOK.yaml` plus `handler.py` in `~/.hermes/hooks/`). These are "trusted-by-placement": they run with no sandbox and no first-use prompt.
- **Plugin hooks**, covering 27 lifecycle events, including the blocking `pre_tool_call` and `pre_llm_call`.
- **Shell hooks**, defined in `config.yaml`.
- **Signed outbound webhooks.**

The contributing guide ranks the preferred ways to add a capability: a service-gated tool, then a plugin, then a catalog MCP server, and a new core tool only as a last resort ([Contributing](https://hermes-agent.nousresearch.com/docs/developer-guide/contributing)).

## Eight security layers wrap a local backend that has no sandbox

The docs list eight layers of defense ([Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)):

1. User authorization.
2. Dangerous-command approval.
3. File-write safety.
4. Container isolation.
5. MCP credential filtering.
6. Prompt-injection scanning of context files.
7. Cross-session isolation.
8. Input sanitization.

Where commands actually run depends on `terminal.backend`. The options are `local` (the default), `docker`, `ssh`, `modal`, `daytona`, `vercel_sandbox`, or plugin backends such as `singularity`, `sprites` and `bubblewrap`. On `local`, "The agent has the same filesystem access as your user account" ([Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)).

Container backends harden the sandbox: a read-only root, all capabilities dropped, no privilege escalation, and a 256-process limit. But "When running in `docker`, `modal`, `daytona`, or `vercel_sandbox` backends … dangerous command checks are **skipped**," because the container is treated as the boundary. The `bubblewrap` plugin runs each command in its own bwrap sandbox and *keeps* the approval prompts ([bubblewrap.yaml](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/bubblewrap.yaml)). It depends on Linux namespaces, which some container runtimes block when containers are nested.

Approvals are configured under `approvals:`. `mode: smart` is the default: an auxiliary LLM auto-approves low-risk commands, auto-denies dangerous ones and escalates the uncertain ones to you. `manual` always prompts. `off` is the same as `--yolo` and is meant "only in trusted environments". The other defaults are:

- `timeout: 300`;
- `cron_mode: deny`, `single_query_mode: deny` and `unattended_mode: deny`;
- a prompt that times out is denied, so the system fails closed.

At an interactive prompt you choose once, session, always or deny. "Always" writes the pattern into `command_allowlist:` in `config.yaml`.

YOLO mode (`--yolo`, `/yolo` or `HERMES_YOLO_MODE=1`) skips the prompts but **never the hardline blocklist**. That list covers `rm -rf /` and its variants, fork bombs, `mkfs` on the root device, `dd` onto `/dev/sd*`, and piping untrusted URLs to `sh`. It also does not override user-defined rules in `approvals.deny`.

File writes are always blocked to `~/.ssh/`, `~/.aws/`, `~/.kube/` and `/etc/sudoers`, and to Hermes' own secret stores (`.env`, OAuth files, `mcp-tokens/`, `pairing/`). `HERMES_WRITE_SAFE_ROOT` can further restrict `write_file` and `patch` to listed roots. Secret redaction is on by default (`security.redact_secrets: true`). The production checklist says "never run the gateway as root", "Use container backend", and "Set `terminal.cwd`" ([Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)).

For a root container, the practical reading is as follows. Hermes running *inside* a container is not the same as Hermes using a container *backend*. On `local`, dangerous-command prompts still fire, and the agent has full root inside the container. I found no technical block on running as root, only the advice above.

With a 9B local model, `smart` mode means a weak model judges command risk, and each judgment costs another call on the single server slot. On CPU I would use `manual`. Reserve `off` for a disposable container whose contents you can afford to lose.

## Closing every route from a local install to a paid cloud

Hermes does not call a paid API unless a credential or a setting sends it there. For example, `hermes chat --provider ollama` with no endpoint configured fails with "provider 'ollama' has no endpoint configured", because Hermes "refuses to send the request rather than fall back to OpenRouter with a cloud key" ([Ollama guide](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup#provider-ollama-has-no-endpoint-configured)). Several defaults still point outward, though. Some lead to paid services; others reach free third-party services that a privacy-minded or offline deployment should also close.

| Outbound path | What happens by default | Local-only setting |
|---|---|---|
| The shipped `config.yaml` | The installer copies an example whose `model` block says `default: "anthropic/claude-opus-4.6"`, `provider: "auto"` and `base_url: "https://openrouter.ai/api/v1"` ([cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example)) | Set `model.provider custom` first (this clears stale endpoints), then `base_url`, `default` and `context_length` |
| The setup wizard | Its first mode is Quick Setup via Nous Portal; `--portal` turns on the paid Tool Gateway ([Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)) | Install with `--non-interactive` and configure with `hermes config set` |
| Credentials | `provider: auto` picks a provider from whatever credentials it finds | Keep `~/.hermes/.env` and the process environment free of `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, Anthropic or Nous credentials |
| Fallback chain | `fallback_providers` are tried on 429, 5xx or auth errors ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#fallback-providers)) | Leave it empty |
| Auxiliary slots | `auto` now routes every slot to the main model, but one table still says vision "tries OpenRouter → Nous → Codex". `provider: openai` without a `base_url` goes to `api.openai.com` ([Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#auxiliary-models)) | Pin `vision`, `compression` and `approval` to `provider: main`; turn off title generation |
| Context-length lookup | Without a pin, the detection chain can query OpenRouter, Nous Portal and models.dev ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#context-length-detection)) | Pin `model.context_length` |
| Web tools | With no keys, requests "rotate round-robin across the ring vendors' public free tiers — Exa, Parallel, Firecrawl, and Keenable" ([Web Search & Extract](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search)) | Disable the `web` toolset, or set `web.keyless_fallback: false` and use SearXNG or DDGS plus `web-local` |
| Text to speech | Edge TTS is the default; it is keyless but calls Microsoft's online service ([TTS](https://hermes-agent.nousresearch.com/docs/user-guide/features/tts)) | Disable the `tts` toolset, or use Piper |
| External memory | Honcho, Supermemory and similar need API keys ([Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)) | Don't install a memory provider |
| Package and update traffic | Lazy installs of optional dependencies come from PyPI; the passive update check calls the GitHub API once every 24 hours; the Skills Hub and plugin catalog fetch on demand ([Security](https://hermes-agent.nousresearch.com/docs/user-guide/security); [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)) | `security.allow_lazy_installs: false`. Unpaid, but treat it as egress |

The shipped config also has a `telemetry:` section. This research did not document its defaults, so read it in `hermes config show` before you consider the box quiet. The last line of defense is verification, which a later section covers: the `--usage-file` auxiliary breakdown, the llama-server request log, and an optional test with egress denied all show what actually ran.

## A 9B Qwen at 64K is the realistic ceiling for 4 cores and 15 GB

### Which model

Hermes' own local guide recommends **Qwen3.5-9B** for getting started. The Q4_K_M GGUF is 5.3 GB on disk and needs about 10 GB of RAM at 128K context with a quantized KV cache. The guide calls the 9B "the sweet spot for 8-16 GB machines" ([Mac guide](https://hermes-agent.nousresearch.com/docs/guides/local-llm-on-mac#choosing-a-model)). A user story on the project site reads "Fairly good with qwen3.5-4b, very decent with qwen3.5-9b, VERY good with 27b", and adds that it is not suited to complex coding ([userStories.json](https://github.com/NousResearch/hermes-agent/blob/main/website/src/data/userStories.json)).

Other options rule themselves out:

- **gemma4:31b**, the Ollama guide's quality pick, needs 24 GB or more of RAM ([Ollama guide](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup#step-2-pull-a-model)).
- **Qwen3-8B** and the Ollama packaging of **qwen2.5** top out at 32,768 tokens, below the floor ([#53347](https://github.com/NousResearch/hermes-agent/issues/53347); [#25629](https://github.com/NousResearch/hermes-agent/issues/25629)). Stretching a 32K-native model to 64K "has a real quality cost past ~32K".
- **Nous's own Hermes 3 and 4 checkpoints** are explicitly flagged by the agent: "Nous Research Hermes 3 & 4 models are NOT agentic and are not designed for use with Hermes Agent" ([model_switch.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/model_switch.py)). A third-party guide that calls Hermes 4.3 36B "the best Ollama model" contradicts the project's own code ([localaimaster.com](https://localaimaster.com/blog/hermes-agent-ollama)).

**Qwen3.5-4B** is the fallback if the 9B's latency is unbearable.

### Memory budget

The KV cache numbers below are scaled from the Mac guide's 128K figures (f16 about 16 GB, q8_0 about 8 GB, q4_0 about 4 GB for a 9B model) ([Mac guide](https://hermes-agent.nousresearch.com/docs/guides/local-llm-on-mac#memory-optimization-for-constrained-systems)). I did not measure them on this container.

| Configuration | Weights | KV cache | Approx. total | Verdict on 15 GB |
|---|---|---|---|---|
| 64K, f16 KV | 5.3 GB | ~8 GB | ~13.5 GB | Too tight next to Hermes and Node |
| **64K, q8_0 KV** | 5.3 GB | ~4 GB | **~9.5 GB** | **Recommended** |
| 64K, q4_0 KV | 5.3 GB | ~2 GB | ~7.5 GB | Fallback if RAM is contested |
| 128K, q4_0 KV | 5.3 GB | ~4 GB | ~9.5 GB | Feasible, but slower generation on long contexts |

### Speed

The Ollama guide says "A 9B model on a modern 8-core CPU gives ~10 tokens/sec". It also notes that larger models take 30–120 seconds per response, and lists 4 cores as the minimum ([Ollama guide](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup#what-you-need)). Halving the cores suggests about 4–6 tokens per second of generation here; that is an extrapolation, not a measurement.

Prefill is the bigger problem. Hermes sends the system prompt and every enabled tool schema on each call. The docs warn that on CPU "the model can sit silent for minutes… This is expected behaviour, not a hang" ([Ollama guide](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup#slow-first-response-prefill)). The size of that fixed prompt is disputed. The docs put the system prompt plus tool schemas at "4k–8k tokens" ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#model-seems-to-forget-context-or-give-incoherent-responses)), but one user measured **23,855 input tokens** on a real request ([#53347](https://github.com/NousResearch/hermes-agent/issues/53347)). `hermes prompt-size` reports the real figure for your configuration.

That number decides everything else. On a 64K window with a 24K fixed prompt, a 50% compression threshold leaves only about 8K tokens of working conversation before every turn triggers an expensive summarization call. Trimming toolsets and skills is therefore a bigger lever than changing the model.

The upside is real too. Hermes keeps its prompt byte-stable, and llama-server with one slot caches the shared prefix, so after the first turn only new tokens are processed. Each compression breaks that cache and forces a fresh prefill, which makes rare compressions much cheaper than frequent ones on this hardware.

### Why llama-server rather than Ollama

On this box llama-server is the better server, for five reasons:

1. You set the window explicitly with `-c`.
2. `-np 1` gives the whole window to one slot. The docs warn that `-c 64000 -np 4` leaves each slot "below Hermes' minimum".
3. The KV cache can be quantized.
4. Hermes reads the real `n_ctx` from `/props`.
5. `--jinja` turns on structured tool calls. Without it, "llama-server ignores the `tools` parameter entirely" ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#llamacpp--llama-server--cpu--metal-inference)).

Hermes also excludes the time llama.cpp spends reading a prompt from its compression deadlines, using the server's own progress reports ([Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#context-compression)).

Ollama carries extra risk on this box:

- Its default context depends on VRAM tier (4K below 24 GB) ([Ollama context docs](https://github.com/ollama/ollama/blob/main/docs/context-length.mdx)).
- `/api/show` reports the model's maximum context, not the configured `num_ctx` ([FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq#can-i-use-it-offline--with-local-models)).
- Hermes sends `options.num_ctx` set to that detected maximum unless you cap it ([agent_init_ollama.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/agent_init_ollama.py)). On 15 GB of RAM, that could request an enormous KV cache.
- The streaming-plus-tools hang on CPU-only Ollama is still an open issue. It returns zero bytes or an HTTP 500 and can freeze the whole Ollama API ([#25629](https://github.com/NousResearch/hermes-agent/issues/25629)).

vLLM and SGLang are documented as GPU servers and do not fit this box.

One caution applies to llama.cpp as well. Its list of native tool-call formats covers Qwen 2.5, Hermes 2/3, Llama 3.x, Mistral Nemo and GPT-OSS; other templates fall back to a "Generic" handler that "may consume more tokens and be less efficient" ([llama.cpp function-calling.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)). I could not confirm whether Qwen3.5's template gets a native handler. Treat the tool-call curl test in Step 5 as mandatory.

## Step-by-step: building the local stack in the root container

The recipe below combines the documented steps above. The flag and timeout choices for this hardware are my own tuning, and I note them where they appear. All commands run as root.

### Step 1: OS packages, proxy trust and a loopback bypass

The installer needs only git, curl, tar and SHA-256 utilities. Minimal images lack `libatomic1`, which the managed Node.js links against; without it the installer "aborts with exit 127 and no error output at all" ([Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation); [#87460](https://github.com/NousResearch/hermes-agent/issues/87460)). The rest of the list is the llama.cpp build toolchain plus verification helpers.

Hermes trusts certificates through `truststore`, which uses the operating system's store. The docs say: "For a corporate TLS proxy, install its root through your organization's operating-system trust procedure" ([Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)). The package manager treats a TLS failure as permanent and does not retry it ([Package management](https://hermes-agent.nousresearch.com/docs/reference/package-management)). So install the proxy CA before anything else. In the research container behind these notes, the proxy's bundle lives at `/root/.ccr/ca-bundle.crt`.

Keep `HTTPS_PROXY` set as provided, but make sure loopback traffic never goes through the proxy. That last step is my inference from how standard HTTP clients behave.

```bash
apt-get update
apt-get install -y git curl tar coreutils ca-certificates libatomic1 \
  build-essential cmake jq tmux libcurl4-openssl-dev libssl-dev

cp /path/to/egress-proxy-ca.pem /usr/local/share/ca-certificates/egress-proxy.crt
update-ca-certificates

cat >> /root/.bashrc <<'EOF'
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export PATH="$HOME/.local/bin:$PATH"
EOF
source /root/.bashrc
mkdir -p /root/models /root/work
```

### Step 2: build llama-server for CPU

The Hermes docs give the standard CMake build ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#llamacpp--llama-server--cpu--metal-inference)). Building from source avoids guessing the name of the current prebuilt release asset; a guessed name returned 404 during research.

```bash
git clone --depth 1 https://github.com/ggml-org/llama.cpp /opt/llama.cpp
cmake -S /opt/llama.cpp -B /opt/llama.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build /opt/llama.cpp/build --config Release -j 4 --target llama-server
/opt/llama.cpp/build/bin/llama-server --version
```

If CMake complains about CURL, either the libcurl dev package above is missing, or you can pass `-DLLAMA_CURL=OFF`. That option only drops llama.cpp's built-in model downloader.

### Step 3: download the model

The docs use `huggingface-cli download unsloth/Qwen3.5-9B-GGUF Qwen3.5-9B-Q4_K_M.gguf --local-dir ~/models` ([Mac guide](https://hermes-agent.nousresearch.com/docs/guides/local-llm-on-mac#download-the-model)). A plain, resumable curl of the same file avoids installing the Hugging Face CLI.

```bash
curl -fL -C - -o /root/models/Qwen3.5-9B-Q4_K_M.gguf \
  "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"
ls -lh /root/models/    # expect roughly 5.3 GB
```

I probed these routes directly from the research container on 2026-11-08; this is not a published source:

- Hugging Face downloads redirect to the `us.aws.cdn.hf.co` Xet CDN, which worked through the proxy.
- `cdn-lfs.huggingface.co` was refused by proxy policy. That only matters for older LFS-only repos.
- GitHub `/releases/latest/download/<asset>` redirects worked, but the `/releases/latest` HTML page returned 403.
- PyPI and npm were reachable.

### Step 4: start the server with explicit flags

This builds on the documented Linux/Mac command (`--jinja -fa -c 64000 -ngl 99`, plus the Mac guide's `-np 1 -fa on --cache-type-k/-v` flags), adapted for no GPU and four cores ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#llamacpp--llama-server--cpu--metal-inference); [Mac guide](https://hermes-agent.nousresearch.com/docs/guides/local-llm-on-mac#start-the-server)).

```bash
tmux new-session -d -s llm \
  "/opt/llama.cpp/build/bin/llama-server \
     -m /root/models/Qwen3.5-9B-Q4_K_M.gguf \
     --jinja -c 65536 -np 1 -t 4 -ngl 0 \
     -fa on --cache-type-k q8_0 --cache-type-v q8_0 \
     --host 127.0.0.1 --port 8080 2>&1 | tee -a /root/llama-server.log"
```

| Flag | Why |
|---|---|
| `--jinja` | Without it, llama-server ignores `tools` and the model prints JSON as plain text |
| `-c 65536` | Meets the 64K floor. Recent builds default to `0` (the training context), which "can OOM" on 128K+ models |
| `-np 1` | One slot gets the whole window, and the prefix cache keeps working across turns |
| `-t 4 -ngl 0` | Four CPU threads; no GPU layers |
| `-fa on`, q8_0 K/V | A quantized KV cache roughly halves the cache memory of f16. Older builds spell the flag `-fa` with no value |
| `--host 127.0.0.1` | Nothing outside the container needs to reach the model |

### Step 5: prove the server can make structured tool calls

```bash
until curl -sf http://127.0.0.1:8080/v1/models >/dev/null; do sleep 5; done
curl -s http://127.0.0.1:8080/props | jq '.default_generation_settings.n_ctx, (.chat_template | length)'
# expect 65536 and a non-zero template length
MODEL_ID=$(curl -s http://127.0.0.1:8080/v1/models | jq -r '.data[0].id'); echo "$MODEL_ID"

curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "'"$MODEL_ID"'",
  "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
  "tools": [{"type": "function", "function": {"name": "get_weather",
    "description": "Get current weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
  "tool_choice": "auto"}' | jq '.choices[0].message.tool_calls'
# must print a JSON array with get_weather, not null
grep -i "chat format" /root/llama-server.log | tail -n 1
```

If `tool_calls` is null and the reply contains JSON-looking text, the server is at fault, not Hermes ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#tool-calls-appear-as-text-instead-of-executing)). If the log shows "Chat format: Generic", expect weaker tool calling.

### Step 6: install Hermes non-interactively

This is the documented one-liner. The flags go through `bash -s --`, which is standard bash usage even though the docs don't show it. `--non-interactive` skips the setup wizard, whose first option is the Nous Portal. `--skip-browser` and `--skip-computer-use` skip the Chromium and cua-driver downloads ([Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation); [install.sh](https://github.com/NousResearch/hermes-agent/blob/main/scripts/install.sh)).

Running as root puts the code in `/root/.hermes/hermes-agent`, the launcher at `/root/.local/bin/hermes`, and data in `/root/.hermes`. Do not use `sudo`, and do not use pip or PyPI, which are unsupported ([Platform Support](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support)). The installer logs to `~/.hermes/logs/install.log`.

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
  | bash -s -- --non-interactive --skip-browser --skip-computer-use
hash -r && hermes --version
```

### Step 7: point Hermes at the local server and pin every slot

`hermes config set` sends dotted keys to `config.yaml` and `UPPER_SNAKE` names to `.env`, and checks each value's type against the schema ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)). Set `model.provider` first, because it clears a stale `base_url`.

If a key is rejected as unknown, your build has renamed it; check `hermes config show`. The timeout values are my tuning for slow CPU prefill. The defaults they replace are listed in the timeout table below.

```bash
hermes config set model.provider custom
hermes config set model.base_url http://127.0.0.1:8080/v1
hermes config set model.default "$MODEL_ID"
hermes config set model.context_length 65536
hermes config set agent.reasoning_effort none
hermes config set agent.max_turns 100
hermes config set compression.threshold 0.75
hermes config set compression.context_total_ceiling_seconds 1800
hermes config set auxiliary.compression.provider main
hermes config set auxiliary.compression.timeout 900
hermes config set auxiliary.compression.no_progress_timeout 600
hermes config set auxiliary.approval.provider main
hermes config set auxiliary.approval.timeout 300
hermes config set auxiliary.vision.provider main
hermes config set auxiliary.title_generation.enabled false
hermes config set memory.nudge_interval 20
hermes config set skills.creation_nudge_interval 20
hermes config set delegation.max_concurrent_children 1
hermes config set approvals.mode manual
hermes config set terminal.backend local
hermes config set terminal.cwd /root/work
hermes config set terminal.timeout 600
hermes config set terminal.home_mode real
hermes config set web.keyless_fallback false
hermes config set security.allow_lazy_installs false
hermes config set HERMES_API_TIMEOUT 3600
hermes config set HERMES_STREAM_READ_TIMEOUT 3600
hermes config set HERMES_LOCAL_STREAM_STALE_TIMEOUT 3600
```

Each choice has a reason:

- **`compression.threshold: 0.75`.** The compression page gives a default of 0.50 but also says the threshold is "floored at 0.75 below 512K windows". Choosing 0.75 gives the same behavior under either reading. It sets the trigger near 48K, which leaves room for the summary call and means fewer cache-breaking compressions.
- **`agent.reasoning_effort: none`.** Custom endpoints otherwise get `reasoning_effort: medium` ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#named-custom-providers)), and thinking tokens cost minutes at CPU speed. Use `/reasoning` to turn it back up for hard tasks.
- **`approvals.mode: manual`.** This avoids a 9B model judging command risk inside a 30-second auxiliary timeout.
- **`terminal.home_mode: real`.** The default `auto` "uses `{HERMES_HOME}/home` in containers" ([Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)). Without this, the agent's shell would see a different HOME from yours.
- **Nudge intervals of 20.** This halves how often background memory and skill reviews compete for the single slot. `auxiliary.background_review.enabled: false` turns them off completely.

### Step 8: trim the toolsets and audit for cloud credentials

Lists are safer to edit by hand, because `hermes doctor` flags "any list stored as a quoted string" ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)). Run `hermes config edit` and set the following under the existing `agent:` block and at the top level, without duplicating keys:

```yaml
agent:
  disabled_toolsets: [browser, web, image_gen, tts, vision, computer_use, delegation]
fallback_providers: []
```

Then audit:

```bash
grep -vE '^\s*(#|$)' ~/.hermes/.env      # only the three HERMES_* timeouts should be listed
env | grep -E 'API_KEY|OPENAI_BASE_URL|HERMES_INFERENCE_MODEL' || echo "no cloud credentials in environment"
hermes config check
hermes prompt-size                        # the fixed prompt you will prefill on every new session
```

`HERMES_INFERENCE_MODEL` must be unset, because it "takes priority over `config.yaml` for the session" ([Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables)).

If you want web search without paid services, take `web` out of the disabled list. Then configure self-hosted SearXNG (`SEARXNG_URL`) or keyless DDGS for search, and install the `web-local` plugin for extraction ([Web Search & Extract](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search)).

For reference, the resulting state should read:

```yaml
model:
  provider: custom
  default: Qwen3.5-9B-Q4_K_M.gguf     # exactly what GET /v1/models returned
  base_url: http://127.0.0.1:8080/v1
  context_length: 65536               # equals llama-server -c
  streaming: true                     # set false only if streamed tool calls break
fallback_providers: []
agent:
  reasoning_effort: none
  max_turns: 100
  disabled_toolsets: [browser, web, image_gen, tts, vision, computer_use, delegation]
compression: {enabled: true, threshold: 0.75, context_total_ceiling_seconds: 1800}
auxiliary:
  compression:      {provider: main, timeout: 900, no_progress_timeout: 600}
  approval:         {provider: main, timeout: 300}
  vision:           {provider: main}
  title_generation: {enabled: false}
memory:     {nudge_interval: 20}
skills:     {creation_nudge_interval: 20}
delegation: {max_concurrent_children: 1}
approvals:  {mode: manual, timeout: 300, cron_mode: deny, single_query_mode: deny, unattended_mode: deny}
terminal:   {backend: local, cwd: /root/work, timeout: 600, home_mode: real}
web:        {keyless_fallback: false}
security:   {allow_lazy_installs: false, redact_secrets: true}
# ~/.hermes/.env: HERMES_API_TIMEOUT=3600, HERMES_STREAM_READ_TIMEOUT=3600, HERMES_LOCAL_STREAM_STALE_TIMEOUT=3600
```

| Timeout layer | Default | Automatic value for local endpoints | Recommended here | Knob |
|---|---|---|---|---|
| Streaming socket read | 120 s | 1,800 s | 3,600 s | `HERMES_STREAM_READ_TIMEOUT` |
| Stale stream | 180 s | 900 s ceiling | 3,600 s | `HERMES_LOCAL_STREAM_STALE_TIMEOUT` / `agent.local_stream_stale_timeout` |
| Stale non-stream | 90 s | Disabled when implicit | Leave | `HERMES_API_CALL_STALE_TIMEOUT` |
| Non-streaming API call | 1,800 s | — | 3,600 s | `HERMES_API_TIMEOUT` / `providers.<id>.request_timeout_seconds` |
| Compression summarizer | 120 s, 60 s no-progress | — | 900 s / 600 s; 1,800 s total ceiling | `auxiliary.compression.*`, `compression.context_total_ceiling_seconds` |
| Approval classifier, title generation | 30 s each | — | 300 s / disabled | `auxiliary.approval.timeout`, `auxiliary.title_generation.enabled` |
| Terminal command | 180 s | — | 600 s | `terminal.timeout` |

Sources for the timeout table: [Configuration: API Timeouts](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#api-timeouts), [Stream progress timeout](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#stream-progress-timeout), [Full auxiliary config reference](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#full-auxiliary-config-reference). The automatic raises apply to loopback, RFC-1918, `*.local`, link-local and Tailscale hosts ([model_metadata.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/model_metadata.py)).

### Step 9: run the gateway as a long-lived process

The first `hermes` command would start an unmanaged gateway, and that gateway "stops itself once it has been idle for a while" ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)). Containers usually have no systemd, so run the gateway in the foreground under tmux. Docker and WSL get the same advice. If a gateway is already running from before the config changes, restart it.

```bash
hermes gateway stop --yes 2>/dev/null
tmux new-session -d -s hermes "/root/.local/bin/hermes gateway run"
hermes gateway status
```

### Step 10: use it

```bash
cd /root/work
hermes                     # classic CLI client; the banner should show the custom provider
                           # and a context limit of 65,536 tokens
hermes --tui               # full slash-command set (/context, /compress, /memory, /tools ...)
hermes -z "List the files here and say what each one is."   # one-shot, final text only
hermes chat -Q -q "Summarize README.md" --format stream-json  # machine-readable events
```

### Variant: Ollama instead of llama-server

Install with `curl -fsSL https://ollama.com/install.sh | sh` ([Ollama Linux docs](https://github.com/ollama/ollama/blob/main/docs/linux.mdx)). Ollama's FAQ says to use `HTTPS_PROXY`, to install the proxy certificate as a system certificate, and to "Avoid setting `HTTP_PROXY`" ([Ollama FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.mdx)).

Start it with the window and slot count fixed: `OLLAMA_CONTEXT_LENGTH=65536 OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=24h OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 ollama serve` (inside tmux). Pull the Qwen3.5-9B tag from the Ollama library and confirm that the CONTEXT column in `ollama ps` reads 65536.

Then configure Hermes:

- `model.base_url http://127.0.0.1:11434/v1`
- `model.default` set to the tag you pulled
- `model.context_length 65536`
- `model.ollama_num_ctx 65536`, so Hermes does not request the model's full advertised window ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#ollama--local-models-zero-config))
- `model.streaming false`, if tool turns hang (issue #25629).

### Variants: API server, editors and a non-root user

**Local API server.** Run `hermes config set API_SERVER_ENABLED true` and `hermes config set API_SERVER_KEY "$(openssl rand -hex 32)"`, restart the gateway, and point clients at `http://127.0.0.1:8642/v1` with `model: "hermes-agent"` ([API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)).

**Editors.** Install the ACP extra as shown earlier and register `hermes acp` as the agent command.

**Non-root user.** For anything long-lived or reachable from messaging platforms, follow the production checklist. Create a service user, run the installer *as* that user, and call it through `~/.local/bin/hermes` ([Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)).

## Verification: proving every token stays on localhost

The documented success criteria for a first chat are: the banner shows your model and provider, the reply arrives without error, a tool runs when needed, and the conversation continues past one turn and resumes with `hermes --continue` ([Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)).

`hermes doctor` exits 0 when it finds no problems. It reports auxiliary blocks that are failing and IPv6 routes that are blackholed. `hermes dump` prints model, provider, terminal, and a table showing which API keys are set ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)). `hermes -z` writes a JSON usage report with an `auxiliary` breakdown, even when the run fails. Its exit codes are 0 for completed, 2 for failed or partial, 1 for no text, and 130 for interrupted.

```bash
hermes --version
hermes doctor; echo "doctor exit=$?"                 # want 0
hermes config get model --json                       # provider custom, base_url 127.0.0.1:8080, context 65536
hermes dump | head -n 60                             # every cloud API key reported as not set
hermes tools --summary                               # no browser, web, tts, image_gen, vision, delegation
hermes -z "Reply with exactly the word OK." --usage-file /root/usage.json; echo "exit=$?"
jq '.' /root/usage.json                              # auxiliary entries must name only the local model
hermes -z "Use the terminal tool to run nproc and report only the number."   # expect 4
tail -n 40 /root/llama-server.log                    # every Hermes request shows up here
hermes logs errors -n 50
```

For a stronger guarantee, run one session with the gateway denied any egress.

1. Stop the gateway: `hermes gateway stop --yes`.
2. Relaunch it in tmux with the proxy variables stripped: `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy /root/.local/bin/hermes gateway run`.
3. Run a multi-turn task that reads files and forces a `/compress`.

In a container whose only route out is the proxy, any hidden cloud dependency now fails loudly instead of silently succeeding, while loopback traffic to llama-server still works. Restart the gateway with its normal environment afterwards. This test is my suggestion, not a documented procedure.

## Troubleshooting the failures local users actually hit

| Symptom | Cause | Fix |
|---|---|---|
| Installer exits 127 with no output on a minimal image | The managed Node needs `libatomic.so.1` | `apt-get install -y libatomic1`; the installer now does this itself when run as root ([#87460](https://github.com/NousResearch/hermes-agent/issues/87460)) |
| TLS errors, or Python/Node downloads timing out during install | The proxy CA is missing from the OS trust store; TLS failures are not retried | Run `update-ca-certificates` with the proxy root, then re-run ([Package management](https://hermes-agent.nousresearch.com/docs/reference/package-management); [#10778](https://github.com/NousResearch/hermes-agent/issues/10778)) |
| `git clone` returns HTTP 429 during install | GitHub rate limiting | Retry later; no fix was documented ([#89624](https://github.com/NousResearch/hermes-agent/issues/89624)) |
| `hermes: command not found` | PATH changes only reach new shells | `source ~/.bashrc`, or call `~/.local/bin/hermes` ([Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)) |
| "The wheel is invalid" or "RECORD file is invalid" | Corrupted packages | `hermes pm doctor --repair`, then `hermes pm repair` ([Package management](https://hermes-agent.nousresearch.com/docs/reference/package-management)) |
| Startup refusal: "Your local server is serving a N-token window…" | Server `-c` or `num_ctx` is below 64K | Restart the server at 65536 or more and match `model.context_length` ([agent_init.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/agent_init.py)) |
| Banner reads "Context limit: 2048 tokens" | The server reported no context value, or a low one | Pin `model.context_length 65536` ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#context-limit-2048-tokens-at-startup)) |
| Passes startup, then fails once tools are attached | `context_length` claims more than the server really serves | Make the server serve 64K or more; don't overstate it ([#53347](https://github.com/NousResearch/hermes-agent/issues/53347)) |
| llama.cpp logs `truncated = 1`, then "compression could not reduce the rebuilt request" | Hermes' window is larger than the server's `-c` | Make them equal ([FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq#context-length-exceeded)) |
| Tool calls show up as raw JSON text | No `--jinja`, or a template that doesn't support tools | Add `--jinja`, check `chat_template` in `/props`, re-run the Step 5 curl test ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#tool-calls-appear-as-text-instead-of-executing)) |
| Flaky tool calls, with "Chat format: Generic" in the log | No native handler for this model's template | Use `--chat-template-file` or a model with a native handler ([llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)) |
| Long silence, then a stale-stream abort on the first turn | CPU prefill is longer than the 900-second local ceiling | Raise the three `HERMES_*` timeouts, trim toolsets, check `hermes prompt-size` ([Ollama guide](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup#slow-first-response-prefill)) |
| Compression times out, or middle turns vanish without a summary | Auxiliary timeouts are too short, or the summarizer's window is smaller than the main model's | Raise the `auxiliary.compression` timeouts; keep `provider: main` ([Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#context-compression)) |
| "The model server rejected this request as too large, but this conversation is only about N tokens" | A background memory review is holding the single slot | Wait and `/retry`; keep `-np 1`; lengthen or disable the reviews ([FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq#context-length-exceeded)) |
| Ollama tool turn hangs with zero bytes or HTTP 500, and the Ollama API freezes | Open bug with streaming plus tools on CPU | `model.streaming false`, restart Ollama, or switch to llama-server ([#25629](https://github.com/NousResearch/hermes-agent/issues/25629)) |
| Ollama model forgets context; `ollama ps` stuck at 32768 | Default context is 4K, or the GGUF caps at 32K (qwen2.5) | `OLLAMA_CONTEXT_LENGTH` or a Modelfile `num_ctx`; `model.ollama_num_ctx`; pick a model with a 64K+ native window ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#ollama--local-models-zero-config); [#25629](https://github.com/NousResearch/hermes-agent/issues/25629)) |
| "provider 'ollama' has no endpoint configured" | `--provider ollama` used with no URL set | Set `providers.ollama.base_url` ([Ollama guide](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup#provider-ollama-has-no-endpoint-configured)) |
| Empty `content` from a Qwen thinking model | The reasoning parser swallows the answer | `agent.reasoning_effort none`, or `extra_body.chat_template_kwargs.enable_thinking: false` on a named provider ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#vllm--high-performance-gpu-inference)) |
| `Unsupported gateway CLI options: …` (exit 2) | `--image`, `--worktree`, `-v`, `--compact` and `--run-budget` are refused in gateway-client mode | Drop those flags, or use `hermes --tui` ([CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli)) |
| CLI exits with code 3 mid-turn; cron jobs show OVERDUE | The gateway went away or idled out | Run `hermes gateway run` under tmux or a supervisor ([CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli); [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)) |
| One-shot run refuses a needed command | `approvals.single_query_mode: deny` | Let the agent find another way, or use `approve`/`--yolo` only in a disposable container ([Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)) |
| Agent's shell sees a different HOME, or `node` is missing | `home_mode: auto` in containers; the login-shell snapshot misses nvm or asdf | `terminal.home_mode real`; add those scripts to `terminal.shell_init_files` ([Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration); [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)) |
| Network calls stall on IPv6 | IPv6 is advertised but blackholed | `network.force_ipv4: true` ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)) |
| Warning that the model is "NOT agentic" | A Nous Hermes 3/4 checkpoint is selected | Switch to Qwen3.5 ([model_switch.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/model_switch.py)) |
| Agent says "memory saved" but nothing changed | Small models skip the tool call | Check with `/memory`; this is a known limitation under ~30B ([Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)) |
| Isolating config problems from server problems | — | `hermes chat --safe-mode --provider custom --base-url http://127.0.0.1:8080/v1 --model "$MODEL_ID" -q "ping"` ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)) |

## Two dozen documented contradictions to read around

| Topic | One source says | Another says | Working rule |
|---|---|---|---|
| Skills index tier | The tier list puts it in "volatile" | The same page says skills are "part of the stable tier" ([Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)) | Either way it is rebuilt only at compaction |
| Session search | "FTS5 session search with LLM summarization" ([README](https://github.com/NousResearch/hermes-agent/blob/main/README.md)) | "no LLM calls" ([Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)); agent/AGENTS.md lists it as an auxiliary slot ([agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)) | Trust the user docs |
| Subagent iteration cap | Default 50 ([Agent Loop](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)) | Default 250 ([Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)) | Set `delegation.max_iterations` explicitly |
| Compression lineage | Creates a child session ([Agent Loop](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)) | In place, stable session id ([agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md); [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)) | Current builds compact in place |
| Compression threshold | Default 0.50 | "Floored at 0.75 below 512K windows" ([Context Compression](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)) | Set 0.75 explicitly |
| Ollama default context | 2,048 tokens ([Ollama guide](https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup#increase-ollamas-context-window)) | 4K, 32K or 256K by VRAM tier ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#ollama--local-models-zero-config); [Ollama docs](https://github.com/ollama/ollama/blob/main/docs/context-length.mdx)) | Always set it explicitly |
| Ollama context via `/v1` | "You cannot set context length through the OpenAI-compatible API" ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#ollama--local-models-zero-config)) | Hermes sends `options.num_ctx` on every request ([agent_init_ollama.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/agent_init_ollama.py)) | Set it on the server and in `ollama_num_ctx` |
| Vision auxiliary `auto` | Routes to the main model ([Auxiliary Models](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#auxiliary-models)) | "Vision tries OpenRouter → Nous → Codex" ([Provider Options](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#provider-options)) | Pin `provider: main` |
| Local stale-stream detection | "Disabled entirely" ([Mac guide](https://hermes-agent.nousresearch.com/docs/guides/local-llm-on-mac#timeouts); [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)) | A 900-second ceiling "replaces the former infinite disable" ([Env vars](https://hermes-agent.nousresearch.com/docs/reference/environment-variables)) | Assume 900 s; raise it |
| `hermes chat` flags | `--image`, `--worktree` and `-v` listed; `hermes -w -z` shown ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)) | Refused with exit 2 in gateway mode ([CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli)) | Test before scripting |
| MCP tool names | `mcp_<server>_<tool>` ([MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)) | `mcp__<server>__<tool>` ([Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference); [mcp_tool_schema.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/mcp_tool_schema.py)) | The code uses double underscores |
| Webhook toolset | "Full tools including terminal" ([Messaging index](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)) | A restricted four-tool subset ([Webhooks](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks)) | Assume restricted |
| `hermes tools` subcommands | Only `--summary` ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)) | `enable`, `list`, `--platform` ([Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)) | Prefer `agent.disabled_toolsets` |
| `.env` vs `config.yaml` | "config.yaml wins for non-secret settings" ([Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)) | Documented secrets in `.env` "take precedence" ([cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example)) | Keep each value in only one place |
| Fixed prompt size | 4k–8k tokens ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#model-seems-to-forget-context-or-give-incoherent-responses)) | 23,855 measured ([#53347](https://github.com/NousResearch/hermes-agent/issues/53347)) | Measure with `hermes prompt-size` |
| Python version | `>=3.11,<3.15` ([pyproject.toml](https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml)) | 3.14 only ([Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)) | Use the installer's pinned 3.14 |
| uv | FAQ: install uv yourself ([FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)) | The installer always uses its own pinned uv ([Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)) | Ignore the FAQ line |
| Hermes 3/4 models | "NOT agentic" ([model_switch.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/model_switch.py)) | Hermes 4.3 36B is the "best Ollama model" ([localaimaster.com](https://localaimaster.com/blog/hermes-agent-ollama)) | Trust the code |
| Cron and memory | `skip_memory=True` by default ([agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)) | Since v0.21, cron agents "load and update persistent memory" ([changelog](https://www.gradually.ai/en/changelogs/hermes-agent/)) | Test it on your version |
| Project plugins | `.hermes/plugins/` is a plugin location ([Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)) | "Not loaded by the gateway that runs sessions" ([Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)) | Install into `~/.hermes/plugins/` |
| The 64K floor | "Rejected at startup", no exceptions ([Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)) | `lmstudio` with an explicit `context_length` is exempt ([agent_init.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/agent_init.py)) | Plan for 64K on every other provider |
| Tool and platform counts | 70+ tools, ~28 toolsets, 25+ adapters ([Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)) | ~85 tools ([Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)); "19 native plus IRC and Teams via plugins" ([llms.txt](https://hermes-agent.nousresearch.com/docs/assets/files/llms-2a7843a9a75658e6935fc6f34e77c823.txt)) | Counts drift with each release |
| Version metadata | Tag v0.23.0 ([tags](https://github.com/NousResearch/hermes-agent/tags)) | `__release_date__ = "2026.9.24"` ([hermes_cli/__init__.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/__init__.py)); PyPI stops at 0.19.0 ([PyPI](https://pypi.org/project/hermes-agent/)); `pyproject.toml` says 0.0.0 | Trust `hermes --version` |
| Root install layout | FHS paths under `/usr/local` ([#21457](https://github.com/NousResearch/hermes-agent/issues/21457)) | Root's home directory ([Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)) | Current builds use `/root/.hermes` |
| `-q` behavior | Answers once and exits (before 0.21) | Seeds an interactive session on a TTY ([CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)) | Use `-z` or `--oneshot` in scripts |
| llama.cpp flash-attention flag | `-fa` ([Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#llamacpp--llama-server--cpu--metal-inference)) | `-fa on` ([Mac guide](https://hermes-agent.nousresearch.com/docs/guides/local-llm-on-mac#start-the-server)) | Match the syntax your build accepts |

## Conclusion

On CPU, Hermes is constrained less by model size than by how often the prompt cache breaks. The project's own invariants (a byte-stable prompt, compression as the only deliberate cache break, every tool schema sent on every call) line up with llama-server's single-slot prefix cache, so a well-trimmed session pays the full prefill only once and then streams incremental turns. The 64K floor and the compression threshold work against that. Each summarization means a large prefill with no cache reuse, followed by a full re-prefill of the compacted history. The levers that matter are therefore:

- a smaller fixed prompt (fewer toolsets and skills);
- a later and explicit compression trigger;
- the long timeouts that let those rare compressions finish.

Choosing a smarter model matters less than any of these.

"No paid cloud" is now close to the default but not quite there. Auxiliary `auto` means the main model, and a missing local endpoint refuses rather than falling back to OpenRouter. But the shipped config still names OpenRouter, the web tools still rotate across third-party free tiers, Edge TTS still calls Microsoft, and one doc table still routes vision through OpenRouter. Because v0.23.0 put every surface behind one gateway, the gateway's own environment is what counts, so a "local CLI" user is in fact operating a daemon. With releases arriving every few days and the docs disagreeing in more than two dozen places, the reliable sources of truth are runtime ones: `hermes doctor`, `hermes dump`, the `--usage-file` auxiliary breakdown, the llama-server request log, and an egress-denied smoke test.
