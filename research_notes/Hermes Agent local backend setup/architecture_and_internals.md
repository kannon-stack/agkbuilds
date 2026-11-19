# Hermes Agent: Architecture and Internals (How Hermes Agent Works)

Sourcing note: these notes come from the official docs (Docusaurus source under `website/docs/` in the GitHub repo, published at hermes-agent.nousresearch.com/docs), the root and area `AGENTS.md` files, `README.md`, and selected source files (`agent/model_metadata.py`) on the `main` branch, all read on 2026-11-08. Docs URLs below point at the published pages for the same source files. The project changes very fast (multiple releases a week), so treat line-level details as a snapshot of early November 2026 (around v0.23.0).

## 1. What Hermes Agent is: maker, license, language/runtime, version and release cadence

### Takeaway
Hermes Agent is Nous Research's open-source (MIT) personal AI agent, written in Python, with TypeScript for the desktop app, TUI and website. One agent core (`AIAgent`) runs behind a CLI, a TUI, an Electron desktop app, a messaging gateway, ACP (IDE integration), an API server and a batch runner. As of 2026-11-08 the latest release is **v0.23.0 "The Hearth Release" (5 Nov 2026)**. Patch releases ship every few days and minor releases roughly monthly. Versioning switched from CalVer to SemVer after v2026.9.24.

### Cited Findings
- README describes it as "The self-improving AI agent built by Nous Research… the only agent with a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, searches its own past conversations." The license badge reads MIT and the README's License section says "MIT — see LICENSE." — [README](https://github.com/NousResearch/hermes-agent/blob/main/README.md)
- The README advertises model-agnosticism: "Use any model you want — Nous Portal, OpenRouter, OpenAI, your own endpoint… Switch with `hermes model`." — [README](https://github.com/NousResearch/hermes-agent/blob/main/README.md)
- The root AGENTS.md says: "Hermes is a personal AI agent that runs the same agent core across a CLI, a messaging gateway (Telegram, Discord, Slack, ~20 platforms), a TUI, and an Electron desktop app. It learns across sessions (memory + skills), delegates to subagents, runs scheduled jobs, and drives a real terminal and browser. It is extended primarily through plugins and skills, not by growing the core." — [AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)
- Runtime: the source installer provisions **Python 3.14**, Node.js, npm, pnpm, ripgrep and FFmpeg through its package manager ("PM"), which uses Astral's `uv`. Native Windows is supported without WSL. A Termux/Android APT repo has `stable` and `canary` channels. — [README](https://github.com/NousResearch/hermes-agent/blob/main/README.md)
- Code style rules in AGENTS.md cover Python plus TypeScript for "desktop, TUI, website". — [AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)
- Releases on GitHub: v0.23.0 "The Hearth Release" (05 Nov, marked Latest), v0.22.7 (03 Nov), v0.22.6 (02 Nov), v0.22.5 (23 Oct), v0.22.4 (21 Oct), v0.22.3 (21 Oct), v0.22.2 (15 Oct), v0.22.1 (14 Oct), v0.22.0 "The Threshold Release" (14 Oct), v0.21.7 (12 Oct). — [GitHub Releases](https://github.com/NousResearch/hermes-agent/releases)
- Version scheme: "The committed project version is always `0.0.0`. Release jobs derive the payload version from the admitted ref." The SemVer line is "seeded at `0.21.5` (the last legacy CalVer release, v2026.9.24)". Stable releases go through an `rc.<N>-vX.Y.Z` attempt-ref gate, and canary builds have their own scheduled workflow. — [Stable releases (dev guide)](https://hermes-agent.nousresearch.com/docs/developer-guide/stable-releases)
- Scale: the architecture page lists "70+ registered tools across ~28 toolsets", "25+ platform adapters" and a test suite of "~25,000 tests across ~1,250 files". — [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)

### Inferences
- Do not rely on `pyproject.toml` (always `0.0.0`) to tell which version is installed. Use the release tag or the `hermes` CLI's version output.
- The cadence (about 10 releases between 12 Oct and 5 Nov 2026) means internals such as file names and defaults can drift within weeks. Re-check details against `main` before relying on them.

### Gaps
- I did not find an official Nous Research blog post or announcement for v0.23.0 with feature highlights. The release body was not read, only the titles and dates.
- The initial public launch date of Hermes Agent was not confirmed in this pass.

---

## 2. The agent loop and core modules (run_agent.py / AIAgent, model_tools, toolsets)

### Takeaway
`AIAgent` (facade in `run_agent.py`) runs a **synchronous** loop. Each iteration does the following:
1. Builds or reuses the cached system prompt.
2. Checks compression.
3. Converts messages to one of three API modes.
4. Makes an interruptible model call.
5. Executes any tool calls (in parallel via a thread pool when there are several), appends the results, and loops again.
6. Ends when the model returns plain text.

Tools self-register into `tools/registry.py` at import time. `model_tools.py` discovers them and dispatches calls, and `toolsets.py` groups them. A handful of "agent-level" tools (`todo`, `memory`, `session_search`, `delegate_task`) are intercepted before the registry.

### Cited Findings
- `run_agent.py` is "now a thin facade: the loop itself lives in `agent/conversation_loop.py`, each turn phase in `agent/turn_*.py` (iteration prep, API call, API error, overflow, truncation, recovery), constructor wiring in `agent/agent_init.py`." — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- `AIAgent` is assembled from mixins (`agent/turn_facade.py`, `client_lifecycle.py`, `stream_delivery.py`, `session_persistence.py`, `compression_facade.py`, …). `AIAgent.__init__` takes about 60 parameters, including `base_url`, `api_key`, `provider`, `api_mode`, `model`, `max_iterations` (default 500), `enabled_toolsets`/`disabled_toolsets`, `quiet_mode`, `save_trajectories`, `platform`, `session_id`, `skip_context_files`, `skip_memory` and `credential_pool`. — [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- There are two entry points. `agent.chat(msg) -> str` is a thin wrapper. `agent.run_conversation(user_message, system_message=None, conversation_history=None, task_id=None) -> dict` returns `final_response` and `messages`. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- Loop skeleton: `while (api_call_count < self.max_iterations and self.iteration_budget.remaining > 0) or self._budget_grace_call:` → check interrupt → `client.chat.completions.create(model, messages, tools)` → if `tool_calls`, run `handle_function_call()` for each and append the tool results; else return the content. The turn phase files include `turn_preflight*`, `turn_iteration_prep`, `turn_request_assembly`, `turn_api_call`, `turn_api_error`, `turn_response_intake`, `turn_empty_response`, `turn_tool_round`, `turn_overflow`, `turn_truncation`, `turn_context_compaction`, `turn_recovery`, `turn_recovery_autorecover`, `turn_stop_gates`, `turn_final_response` and `turn_finalizer`. — [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- Turn lifecycle as documented:
  1. Generate `task_id`.
  2. Append the user message.
  3. Build or reuse the cached system prompt.
  4. Preflight compression check (>50% of context).
  5. Build API messages for the mode.
  6. Inject ephemeral layers (budget warnings, context pressure).
  7. Apply Anthropic cache markers.
  8. Call `_interruptible_api_call`.
  9. If there are tool calls, execute them and loop to step 5. If the response is text, persist the session, flush memory and return.

  — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- There are three API modes: `chat_completions` (OpenAI-compatible, the default), `codex_responses` (OpenAI Responses API) and `anthropic_messages` (native Anthropic via `anthropic_adapter.py`). Resolution order: explicit `api_mode` arg → provider detection → base-URL heuristics → default. All modes convert to and from one internal OpenAI-style message format. Reasoning is stored in `assistant_msg["reasoning"]`. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- The loop enforces strict role alternation: never two assistant or two user messages in a row, and only `tool` messages may be consecutive. The one sanctioned exception is `/steer`, which arrives as a standalone user row after a tool result. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop); [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- Interruptibility: the HTTP call runs in a background thread while the main thread waits on response, interrupt event or timeout. On interrupt (a new message, `/stop`, a signal) the response is discarded and no partial response enters history. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- Tool execution: a single tool call runs in the main thread. Multiple calls run concurrently in a `ThreadPoolExecutor`, except interactive tools like `clarify`, which force sequential execution. Results are reinserted in the original order. Per call the sequence is: resolve the handler from the registry → `pre_tool_call` plugin hook → dangerous-command check (`tools/approval.py`, approval callback) → execute → `post_tool_call` hook → append the `{"role":"tool"}` message. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- Agent-level tools (`todo`, `memory`, `session_search`, `delegate_task`) are intercepted by `agent/tool_executor.py` through the `INLINE_TOOL_EXECUTORS` table in `agent/inline_tool_executors.py`, before `handle_function_call()`. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop); [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- Callbacks for UIs: `tool_progress_callback`, `thinking_callback`, `reasoning_callback`, `clarify_callback`, `step_callback`, `stream_delta_callback`, `tool_gen_callback` and `status_callback`. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- Budget and fallback: `IterationBudget` defaults to 500 iterations (`agent.max_turns`). At 100% the agent stops and returns a summary of the work done. `fallback_providers` are tried in order on 429, 5xx or 401/403 (401/403 attempt a credential refresh first). Auxiliary tasks (vision, compression, title generation) have their own fallback chains under `auxiliary.*`. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- Tool registry: each `tools/*.py` calls `registry.register(name=, toolset=, schema=, check_fn=, …)` at import. `discover_builtin_tools()` uses an **AST scan** to import only modules with a top-level `registry.register()` call. `check_fn` gates availability when `get_definitions()` builds the schema list. A registration that would shadow a tool from a different toolset is rejected unless `override=True`. — [Tools Runtime](https://hermes-agent.nousresearch.com/docs/developer-guide/tools-runtime)
- Dependency chain: `tools/registry.py` (no deps) ← `tools/*.py` ← `model_tools.py` ← `run_agent.py`, `cli.py`, `batch_runner.py`, `environments/`. — [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- Key files: `model_tools.py` (tool orchestration, `discover_builtin_tools()`, `handle_function_call()`), `toolsets.py` (`TOOLSETS` dict, `_HERMES_CORE_TOOLS`), `cli.py` (`HermesCLI`), `hermes_state.py` (`SessionDB` facade) and `hermes_constants.py` (`get_hermes_home()`). — [AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)
- Data flows:
  - CLI: `HermesCLI.process_input()` → `AIAgent.run_conversation()` → `prompt_builder.build_system_prompt()` → `runtime_provider.resolve_runtime_provider()` → API call → `model_tools.handle_function_call()` loop → display → save to SessionDB.
  - Gateway: `Adapter.on_message()` → `GatewayRunner._handle_message()` → authorize → resolve session key → create `AIAgent` with history → run → deliver.
  - Cron: a fresh `AIAgent` with no history, attached skills injected, response delivered to the target platform.

  — [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- Design invariants: "Per-conversation prompt caching is sacred… the ONE exception is context compression", and "The core is a narrow waist; capability lives at the edges. Every model tool is sent on every API call, so the bar for a new core tool is high." — [AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)
- Opt-in "Tool Search" replaces MCP and non-core plugin tools in the model-visible tools array with three bridge tools, and loads schemas on demand. — [Tool Search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search)

### Inferences
- The loop is a classic ReAct-style tool loop. What sets Hermes apart is the surrounding machinery (cache-stable prompts, compression, a background learning review, profiles), not the loop shape.
- "Facade + siblings" means older references (e.g., "logic in run_agent.py") in blogs or tutorials are probably stale. The code now lives in `agent/turn_*.py`.

### Gaps
- I did not read `run_agent.py` source directly, so the exact constructor defaults beyond those listed in agent/AGENTS.md are unverified.

---

## 3. How the system prompt is built (SOUL.md, context files, memory, skills index) and where files live

### Takeaway
The system prompt is assembled once per session in three ordered tiers: **stable** (identity from `~/.hermes/SOUL.md` or a built-in default, tool/model guidance, platform hint) → **context** (system_message override, one project context file, git workspace snapshot) → **volatile** (skills index, frozen `MEMORY.md`/`USER.md` snapshots, external memory-provider block, timestamp/session/model line, runtime environment and cwd). The prompt is byte-stable for the whole conversation. Anything mid-session, such as skill invocations, subdirectory AGENTS.md hints or plugin context, rides on user messages or tool results instead.

### Cited Findings
- Tier definitions (in `agent/system_prompt.py`):
  - **stable:** "identity (`SOUL.md` or fallback), tool/model guidance, coding operating brief".
  - **context:** "caller-supplied `system_message`, project context files (`.hermes.md` / `AGENTS.md` / `CLAUDE.md` / `.cursorrules`), then the worktree-dependent git workspace snapshot, operator instructions and platform hints".
  - **volatile:** "skills index, built-in memory snapshot (`MEMORY.md`), user profile snapshot (`USER.md`), external memory-provider block, timestamp/session/model/provider line, then runtime environment hints (host / home / current working directory)".

  — [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- Internal inconsistency: the same page later says "skills are part of the **stable** tier", which contradicts the tier list placing the skills index in **volatile**. — [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- SOUL.md: `load_soul_md()` reads `get_hermes_home() / "SOUL.md"`, security-scans it (warns but loads, because the file is user-authored) and truncates it (the cap scales with the context window, 20k floor). The result replaces the hardcoded `DEFAULT_AGENT_IDENTITY`. The fallback identity begins "You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask…". Subagents (`skip_context_files`) don't load SOUL.md and use the default identity. — [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- SOUL.md is "the primary identity… the first thing in the system prompt". It is for tone, personality and communication style, not for repo conventions or file paths. — [Use SOUL.md with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-soul-with-hermes)
- Project context priority (first match wins, only one type is loaded):
  1. `.hermes.md`/`HERMES.md`, walking from cwd up to the git root.
  2. `AGENTS.md` (cwd).
  3. `CLAUDE.md` (cwd).
  4. `.cursorrules` / `.cursor/rules/*.mdc` (cwd).

  Context files are security-scanned (a hit replaces the file with a `[BLOCKED: …]` marker), truncated at `context_file_max_chars` with a 70/20 head/tail split (dynamic cap: 20,000-char floor, 500K ceiling) and stripped of YAML frontmatter. — [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- Subdirectory `AGENTS.md` files discovered during a session (`agent/subdirectory_hints.py`) are appended to the **tool result**, not the system prompt, and truncated past `_MAX_HINT_CHARS = 32_000`. Paths outside the working dir are rejected, so `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md` never mix in. — [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- Layers that are API-call-time only and never cached: `ephemeral_system_prompt` (e.g., `HERMES_EPHEMERAL_SYSTEM_PROMPT`), prefill messages, gateway session overlays, later-turn Honcho/external recall, and `pre_llm_call` plugin context. All of these are appended to the current user message. — [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- Skills index changes mid-session (install, remove) are detected by `agent/skills_index_delta.py` and delivered as a one-shot note on the next user message. The index itself converges at the next rebuild boundary, which is compaction. — [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- The prompt carries per-platform hints (`PLATFORM_HINTS` in `agent/system_prompt.py`), overridable via the top-level `platform_hints:` config key with `append`/`replace`. — [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- The rendered "prompt surface" (system prompt + `tools[]`) is snapshotted in `tests/fixtures/prompt_surface/` via `scripts/ci/prompt_surface.py render` for nine surfaces. Changes need hermes-agent-core approval. — [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- Example assembled prompt includes a "Skills (mandatory)" block: "Before replying, scan the skills below. If one clearly matches your task, load it with skill_view(name)…" followed by an `<available_skills>` list grouped by category. — [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- User state layout: `~/.hermes/config.yaml` (settings), `.env` (secrets only), `logs/`. All paths are profile-aware via `get_hermes_home()`. The platform default is `~/.hermes` on macOS/Linux and `%LOCALAPPDATA%/hermes` on Windows. Named profiles live at `<root>/profiles/<name>/`. — [AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md); [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)
- Other paths under the Hermes home: `memories/MEMORY.md`, `memories/USER.md`, `SOUL.md`, `skills/`, `skill-bundles/`, `state.db`, `cache/exec/` and `plugins/`. Project-level plugins live in `.hermes/plugins/`. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory); [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills); [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)

### Inferences
- Because the prompt is frozen per session, changes to SOUL.md, MEMORY.md or config-driven prompt state take effect in the **next** session (or after compaction), not immediately.
- On local models with small windows, the system prompt plus around 70 tool schemas is a large fixed cost. This is one reason for the 64K minimum (see section 6).

### Gaps
- Exact token sizes of a stock system prompt and tool array were not found (they are in the committed prompt-surface fixtures, which I did not read).

---

## 4. Memory: MEMORY.md / USER.md, the memory tool, background review, Honcho and other providers, session search

### Takeaway
Built-in memory is two small, bounded, agent-curated files: `~/.hermes/memories/MEMORY.md` (2,200 chars) and `USER.md` (1,375 chars). They are injected as a frozen snapshot at session start and edited only through the `memory` tool (`add`/`patch`/`remove`, no read action). A background "self-improvement review" fork after turns can write memory and skills, optionally gated by `write_approval`. Exactly one external memory-provider plugin can be added on top: Honcho, Mem0, Hindsight, OpenViking, Holographic, RetainDB, ByteRover, Supermemory or Memori. Cross-session recall of raw history comes from `session_search` over SQLite FTS5.

### Cited Findings
- File limits: MEMORY.md holds the agent's notes, 2,200 chars (about 800 tokens). USER.md holds the user profile, 1,375 chars (about 500 tokens). Both are stored in `~/.hermes/memories/` and injected "as a frozen snapshot at session start". — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- Rendered format: a header such as `MEMORY (your personal notes) [67% — 1,474/2,200 chars]`, with entries separated by `§`. Writes during a session persist to disk immediately but don't change the prompt until the next session. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- Memory tool actions are `add`, `patch` (replace a span via `old_text` and `content`) and `remove` (substring match). There is no `read`. A `replace` action was removed because models used it as find-and-swap and wiped multi-fact entries. Every call needs a top-level `target` (`"memory"` or `"user"`). Batches go in `operations`. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- There is no auto-compaction. An over-limit write returns an error with `current_entries` and usage. The agent must then issue one `operations` batch that frees the needed chars and adds the entry (the limit is checked on the batch result). Exact duplicates are rejected. Entries are scanned for injection/exfiltration patterns and invisible Unicode. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- Config defaults (`memory:` in config.yaml): `memory_enabled: true`, `user_profile_enabled: true`, `memory_char_limit: 2200`, `user_char_limit: 1375`, `write_approval: false`, `prefetch_spill_enabled: false`. Disabling both stores drops the tool and its prompt guidance. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- Background review: after a turn, "the background self-improvement review may quietly save a memory or update a skill… repeated corrections and durable workflow lessons become compact memory entries or procedural skills." By default it runs on the main model, replaying the warm-cache conversation. It can be routed elsewhere with `auxiliary.background_review` (provider/model, `enabled`, `max_input_tokens` defaulting to 75% of the review model's window capped at 600K, and `extra_tools`). Its frequency is tuned via `memory.nudge_interval` and `skills.creation_nudge_interval`. Notifications show as "💾 Memory updated" and are controlled by `display.memory_notifications`. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- `write_approval: true` stages writes. Approval is inline in the interactive CLI; elsewhere, including background review, writes wait for `/memory pending` and `/memory approve|reject <id|all>`. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- Memory is per profile (`~/.hermes/profiles/<name>/memories/`), and the docs warn not to point two agents at one Hermes home. Small local models (roughly <30B) often claim to save memory without calling the tool. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- Memory "needs session boundaries". Gateway chats are one continuous session that can run for weeks, so users should `/new` at natural boundaries for memory to pay off. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- `/journey` (also `hermes journey`) shows a timeline of learned skills and memory entries, with list, edit and delete. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- External providers: when one is active, Hermes injects provider context into the system prompt, prefetches relevant memories before each turn (background, non-blocking), syncs turns after each response, extracts memories on session end, mirrors built-in memory writes, and adds provider-specific tools. "The built-in memory (MEMORY.md / USER.md) continues to work exactly as before. The external provider is additive." Listed providers: Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory, Memori. — [Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
- Memory providers and context engines are "single-select — only one of each can be active at a time" (`plugins/memory/`, configured via `memory.provider` / `hermes plugins`). The ABC is `agent/memory_provider.py` and the orchestrator is `agent/memory_manager.py`. Cron passes `skip_memory=True` by default. — [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture); [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- Honcho (Plastic Labs) is installed with `hermes plugins install honcho`. It needs an API key from app.honcho.dev or a self-hosted `baseUrl`. Its model is a workspace with a user peer (`peerName`) and an AI peer per profile. Key defaults: `recallMode: hybrid` (auto-inject + tools), `contextCadence: 1`, `dialecticCadence: 2`, `dialecticDepth: 1` (1–3 passes), `dialecticReasoningLevel: low`, `dialecticMaxChars: 600`, `writeFrequency: async`, `sessionStrategy: per-directory`, `observationMode: directional`. — [Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
- Session search: all sessions are stored in SQLite `~/.hermes/state.db` with FTS5. `session_search` returns actual messages, "no LLM summarization, no truncation". It runs in about 20ms per FTS query, with shapes for discovery (`query`), scroll (`session_id` + `around_message_id`) and browse. Discovery dedupes by session lineage and returns snippets, bookends and ±5 messages for the top hit. — [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory); [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)
- Conflict: the README says "FTS5 session search with LLM summarization for cross-session recall", the user docs say session search makes "no LLM calls", and agent/AGENTS.md lists `session_search` among auxiliary (side-LLM) task slots. — [README](https://github.com/NousResearch/hermes-agent/blob/main/README.md); contradicted by [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions); see also [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)

### Inferences
- The memory design trades capacity (about 1,300 tokens in total) for prompt-cache stability and focus. Long-term detail is expected to live in skills (procedural) and session history (episodic, via FTS5), not in MEMORY.md.
- The README's "LLM summarization" for session search is probably a holdover from an earlier design. The current tool returns raw message windows, possibly with an optional aux-LLM path. Treat the user docs as authoritative.

### Gaps
- I could not confirm the default values of `memory.nudge_interval` and `skills.creation_nudge_interval`. The keys are documented, but their defaults were not found in the files read.

---

## 5. The skills system: format, storage, progressive loading, agent-created skills, hub, standards compatibility

### Takeaway
Skills are folders with a `SKILL.md` (YAML frontmatter + Markdown) under `~/.hermes/skills/<category>/<name>/`. They are compatible with the agentskills.io open standard and are loaded by **progressive disclosure**:
- a compact index lives in the system prompt;
- `skill_view(name)` loads the full skill;
- `skill_view(name, path)` loads reference files.

The agent writes its own skills via `skill_manage` (its "procedural memory"). A curator prunes stale agent-created skills. A Skills Hub installs from official optional skills, skills.sh, ClawHub, LobeHub, GitHub and well-known endpoints, with security scanning.

### Cited Findings
- "Skills are on-demand knowledge documents… They follow a progressive disclosure pattern… and are compatible with the agentskills.io open standard. All skills live in `~/.hermes/skills/` — the primary directory and source of truth." Bundled skills are copied there on install. — [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- Progressive disclosure levels: Level 0 is `skills_list()` returning `[{name, description, category}]` (about 3k tokens). Level 1 is `skill_view(name)`, the full content. Level 2 is `skill_view(name, path)`, a specific reference file. — [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- SKILL.md frontmatter fields: `name`, `description`, `version`, `platforms` (macos/linux/windows), `metadata.hermes.{tags, category, fallback_for_toolsets, requires_toolsets, fallback_for_tools, requires_tools, config}`, and `required_environment_variables`. The recommended body sections are When to Use, Procedure, Pitfalls and Verification. Supporting files go in `references/`, `templates/`, `scripts/`, `assets/` and `examples/`. — [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- Every installed skill is a slash command (`/skill-name [instructions]`), and up to 5 can be stacked in one message. Skill invocations inject a **user message** and never mutate the system prompt. Skill bundles (`~/.hermes/skill-bundles/<slug>.yaml`) group skills under one command. — [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills); [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- Agent-managed skills: `skill_manage` supports `create`, `patch` (old_string/new_string, preferred), `patch` with full `content`, `delete`, `write_file` and `remove_file`. The system prompt asks the agent to save non-trivial workflows: multi-step workflows worth repeating, paths found after dead ends, and corrections from the user. Skills should capture "lessons, not logs". An advisory linter warns on `incident-log-shape`, `references-sprawl` (>60 files) and `oversized-body` (SKILL.md body >~24k chars). — [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- `/learn <dir|url|description|book>` turns sources into a skill. Large sources become "knowledge-base skills": a lean SKILL.md plus one distilled file per chapter or topic under `references/`. — [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- Directory precedence: `project (<repo>/.hermes/skills/, <repo>/.agents/skills/) → local (~/.hermes/skills/) → skills.create_dir → skills.external_dirs`. Project skills load only after `hermes skills trust` and are security-scanned on every load. `skills.external_dirs` (e.g., a shared `~/.agents/skills`) is scanned but is not write-protected. — [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- Skills Hub commands: `hermes skills browse|search|inspect|install|check|update|audit|uninstall|publish|tap add`. Sources include official optional skills (`official/...`), `skills.sh`, ClawHub, LobeHub, well-known endpoints (`/.well-known/skills/`), GitHub repos and direct `SKILL.md` URLs. Installs are quarantined, scanned and recorded in `skills/.hub/lock.json` (source URL, content hash, scanner version, findings). Optional advisory NVIDIA SkillEvaluator/SkillSpector scans are available. — [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- Curator: a background `AIAgent` fork, triggered by inactivity (`interval_hours: 168`, `min_idle_hours: 2`), not by cron. It moves agent-created skills `active → stale` (14 days unused) → `archived` (30 days, into `~/.hermes/skills/.archive/`). LLM consolidation is opt-in (`curator.consolidate: false`). Pinned skills and skills referenced by cron jobs are exempt. — [Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)
- Skills installed mid-conversation are announced via a one-shot note on the next message, and the system prompt index updates at the next compaction. — [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)

### Inferences
- Because Hermes reads `<repo>/.agents/skills/`, supports external dirs, and follows the agentskills.io SKILL.md format (the same name/description frontmatter convention as Claude-style skills), Claude-style skill folders should generally work with little or no change. Hermes-specific behaviour lives under `metadata.hermes`.
- Skills are the main "self-improvement" store. Memory holds always-on facts, while skills hold procedures loaded on demand.

### Gaps
- I did not verify byte-for-byte compatibility with Anthropic's Claude SKILL.md (e.g., `allowed-tools` frontmatter handling). The docs claim only agentskills.io compatibility.

---

## 6. Sessions, history, context compression, and context-length minimums

### Takeaway
Sessions live in a SQLite database (`<HERMES_HOME>/state.db`, WAL mode, FTS5 and trigram FTS), which replaced the earlier per-session JSONL files. The profile's gateway is the single canonical writer, and CLI/TUI/desktop are clients. History is OpenAI-format messages. Compression is the only sanctioned cache break. It runs at **50%** of the context window by default (inside the agent), with an **85%** gateway safety net. It prunes old tool outputs, then summarizes the middle turns into a structured summary with an auxiliary model, keeping the head and a protected tail. Hermes enforces a **64,000-token minimum context window**.

### Cited Findings
- "Hermes Agent uses a SQLite database (`~/.hermes/state.db`) to persist session metadata, full message history, and model configuration… This replaces the earlier per-session JSONL file approach." — [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)
- "The profile's gateway is the **only writer of canonical sessions**: `hermes chat`, the TUI, Desktop (local), the API server, ACP, cron, Bot Chat and Kanban workers are clients that admit input to its session authority over `/api/ws`." — [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)
- Tables: `sessions`, `messages`, `session_model_usage`, `messages_fts` (FTS5 over content + tool_name + tool_calls), `messages_fts_trigram` (CJK/substring), `state_meta`, `gateway_routing`, `compression_locks`, `async_delegations`, `delivery_obligations`, `runtime_epoch`, `session_admissions`, `worker_executions`, `worker_receipts` and `schema_version`. Lineage is tracked via `parent_session_id`, and rows carry a source tag (cli/telegram/…). Batch and RL trajectories are not stored here. Source files are `hermes_state.py` plus `hermes_state_*.py`. — [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)
- In-place compaction archives old rows with `active=0` and inserts the retained context as `active=1`. — [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)
- Resume commands: `hermes --continue` / `-c [title]`, `hermes --resume <id|title|latest>` and `/resume`. Session IDs look like `20250305_091523_a1b2c3d4`. Sessions get auto-generated unique titles, with lineage variants such as "my project #2". `hermes sessions list` and export to JSONL are available. Resume restores the working directory and shows a recap. — [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)
- Dual compression: gateway session hygiene (`gateway/run_turn_hygiene.py`) fires at a fixed **85%** before the agent runs, as a safety net. The agent `ContextCompressor` (`agent/context_compressor.py`) fires at **50%** by default using API-reported token counts (a "usage anchor"). — [Context Compression & Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Config (`compression:`):

  | Key | Default |
  |---|---|
  | `enabled` | `true` |
  | `threshold` | `0.50` (floored at 0.75 below 512K windows per the parameter table) |
  | `threshold_tokens` | `null` |
  | `model_thresholds` | `{}` |
  | `target_ratio` | `0.20` |
  | `tail_mode` | `lean` (2.5% of window, clamped 10K–25K) |
  | `protect_last_n` | `20` |
  | `min_tail_user_messages` | `1` |
  | `protect_first_n` | `3` (hardcoded) |
  | `idle_compact_after_seconds` | `0` |
  | `prepare_ahead` | opt-in |

  — [Context Compression & Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Algorithm (`ContextCompressor.compress()`):
  1. Prune old tool results (>200 chars, outside the tail) to "[Old tool output cleared to save context space]", with no LLM call.
  2. Determine boundaries: head (system + first exchange), middle, and a token-budgeted tail.
  3. Generate a structured summary (Goal / Constraints & Preferences / Progress Done / In Progress / …) via `call_llm(task="compression")` on the auxiliary model.
  4. Assemble head + summary + tail, then fix orphaned tool pairs with `_sanitize_tool_pairs()`.

  Re-compression updates the previous summary iteratively. — [Context Compression & Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- "The summary model must have a context window **at least as large** as the main agent model's." Failed summaries arm an escalating cooldown (60s → 300s → 900s), and repeated stalls commit a deterministic fallback summary. — [Context Compression & Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Memory is flushed to disk before compression, and compression creates a child session lineage (older docs). agent/AGENTS.md now says "In-place compaction keeps a single stable session id". — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop); contrast [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- Pluggable context engine: the `ContextEngine` ABC is in `agent/context_engine.py` and is selected by `context.engine` (`"compressor"` by default; plugins such as `"lcm"` add lossless context and tools like `lcm_grep`). Plugin engines are never auto-activated. — [Context Compression & Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Prompt caching (Anthropic, `agent/prompt_caching.py`): the "system_and_3" strategy places 4 `cache_control` breakpoints (system prompt plus the last 3 non-system messages). It claims about 75% input-cost reduction. `prompt_caching.cache_ttl` is `5m`, `1h` or `auto` (`1h` for human-paced sources, `5m` for subagent/cron/batch/etc.). — [Context Compression & Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- **Minimum context:** `MINIMUM_CONTEXT_LENGTH = 64_000` and `CONTEXT_PROBE_TIERS = [256_000, 128_000, 64_000, 32_000, 16_000, 8_000]` in `agent/model_metadata.py`. A live local probe below the minimum logs "agent init should reject". — [agent/model_metadata.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/model_metadata.py)
- Local-model docs: "# Context length: 64000 ← Hermes minimum; set this to match your server's actual context window". They warn that Ollama's `/api/show` reports the model's max context, not the configured `num_ctx`, and that "Every recommended model gets at least a 64K context window." — [Local models](https://hermes-agent.nousresearch.com/docs/user-guide/local-models); [Configuring models](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models)

### Inferences
- For local backends, set the server's context (e.g., Ollama `num_ctx`, llama.cpp `-c`) to at least 64K **and** tell Hermes the same value. Otherwise, agent init can reject the model, or compression will mis-trigger.
- Since the compression summary uses the auxiliary model and needs a window at least as large as the main model's, pointing `auxiliary.compression` at a small local model can break compaction.
- Conflict on lineage: older docs say compression spawns a child session (new lineage ID, `parent_session_id`). Newer internals say in-place compaction keeps the same session ID and archives rows with `active=0`. Both may coexist (CLI vs. gateway, or native compaction). Flag this as a version-dependent detail.

### Gaps
- The exact behaviour when a model is below 64K (a hard error vs. a warning, and any override flag) was not verified beyond the code comment.

---

## 7. Subagents/delegation, parallel tool calls, and code execution (programmatic tool calling)

### Takeaway
`delegate_task` spawns child `AIAgent`s with fresh, isolated conversations and their own terminal sessions; only the child's final summary returns to the parent. Batches of up to 10 run in parallel by default, and top-level delegation runs in the background with results posted back. Nesting is off by default (`max_spawn_depth: 1`). `execute_code` lets the model write Python that calls Hermes tools over a Unix-socket RPC. Only `print()` output re-enters context.

### Cited Findings
- "The `delegate_task` tool spawns child AIAgent instances with isolated context, inherited tool access, and their own terminal sessions. Each child gets a fresh conversation and works independently — only its final summary enters the parent's context." Top-level calls return a handle immediately and post results back as a new message. — [Subagent Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- Usage is `delegate_task(goal=, context=)` or `delegate_task(tasks=[…])`, with an optional per-task `output_schema` (JSON Schema validated on return, one retry, then `schema_valid: false`). "Subagents Know Nothing": they get only `goal` + `context`, plus the parent workspace's project context files. — [Subagent Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- Limits:
  - `delegation.max_concurrent_children` defaults to 10 (no hard ceiling, also settable via the `DELEGATION_MAX_CONCURRENT_CHILDREN` env var).
  - Child iteration limit: "default: 250" (`delegation.max_iterations`).
  - No wall-clock timeout by default (`child_timeout_seconds: 0`); a progress-based stall monitor is used instead.
  - `role="leaf"` is the default. `role="orchestrator"` requires `delegation.max_spawn_depth` > 1 (default 1 = flat). `delegation.orchestrator_enabled: false` is a kill switch.
  - One-shot runs are capped at `delegation.oneshot_max_children: 2`.
  - `delegate_task` is blocked for leaf children.

  — [Subagent Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- Conflict: the Agent Loop page says subagent budgets are "capped at `delegation.max_iterations` (default 50)", while the Delegation page says the default is 250. Each agent has its own budget, so total iterations can exceed the parent's cap. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop); contradicted by [Subagent Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- Children can be pinned to a different model or provider via `delegation.model`/`delegation.provider`. `delegation.backend` selects a strategy plugin. — [Subagent Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- `tools/delegate_tool.py::_run_single_child()` saves and restores the process-global `_last_resolved_tool_names` around child runs. — [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md)
- Parallel tool calls: multiple tool calls in one model response run concurrently in a `ThreadPoolExecutor`. Interactive tools force sequential execution, and results keep their original order. — [Agent Loop Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)
- `execute_code` mechanics:
  1. The agent writes Python with `from hermes_tools import …`.
  2. Hermes generates a `hermes_tools.py` stub.
  3. Hermes opens a Unix domain socket and RPC listener.
  4. The script runs in a child process, and tool calls go over the socket.
  5. "Only the script's `print()` output is returned to the LLM."

  Tools available inside scripts: `web_search`, `web_extract`, `read_file`, `write_file`, `search_files`, `patch` and `terminal` (foreground only). The agent should use it for 3+ chained tool calls, loops, or bulk filtering. — [Code Execution](https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution)
- `execute_code` limits: timeout 300s (SIGTERM, then SIGKILL after 5s), stdout 50KB (head and tail inline, full output saved under `~/.hermes/cache/exec/`), 50 tool calls per execution. All are configurable. Kernel state can persist (`reset: true` discards it). — [Code Execution](https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution)

### Inferences
- Both delegation and `execute_code` are context-economy mechanisms. They keep intermediate tokens out of the parent's context, which matters most on smaller-window local models.
- With local backends, parallel subagents multiply concurrent requests to one inference server. Lowering `delegation.max_concurrent_children` is likely prudent.

### Gaps
- The exact list of tools blocked for subagents beyond `delegate_task` was truncated in my reading. The docs list "certain tools", which may include memory and clarify.

---

## 8. Trajectories, batch runner, RL/training-data angle: relevance to normal users

### Takeaway
Hermes can save agent sessions as ShareGPT-format JSONL trajectories (`trajectory_samples.jsonl` / `failed_trajectories.jsonl`), and `batch_runner.py` runs a JSONL prompt dataset through full agent sessions in parallel to generate tool-use training data. This is the "research-ready" angle for training future tool-calling models such as Nous's Hermes models. It is opt-in (`save_trajectories`) and irrelevant to everyday use.

### Cited Findings
- "Hermes Agent saves conversation trajectories in ShareGPT-compatible JSONL format for use as training data, debugging artifacts, and reinforcement learning datasets." Source files are `agent/trajectory.py`, `agent/session_persistence.py` (`_save_trajectory`) and `batch_runner.py`. Files are written to cwd: `trajectory_samples.jsonl` (completed) and `failed_trajectories.jsonl`. Entries contain `conversations`, `timestamp`, `model` and `completed`. Batch entries add `prompt_index`, `metadata`, `partial` and `api_calls`. — [Trajectory Format](https://hermes-agent.nousresearch.com/docs/developer-guide/trajectory-format)
- Batch processing: "run the Hermes agent across hundreds or thousands of prompts in parallel, generating structured trajectory data. This is primarily used for training data generation." Example: `python batch_runner.py --dataset_file=data/prompts.jsonl --batch_size=10 --run_name=… --model=… --num_workers=4`. Each prompt gets an isolated environment, and interrupted runs can resume. — [Batch Processing](https://hermes-agent.nousresearch.com/docs/user-guide/features/batch-processing)
- README: "Research-ready — Batch trajectory generation, trajectory compression for training the next generation of tool-calling models." — [README](https://github.com/NousResearch/hermes-agent/blob/main/README.md)
- `AIAgent` takes a `save_trajectories` constructor flag. Trajectories are not stored in `state.db` ("Batch runner and RL trajectories are NOT stored here (separate systems)"). — [agent/AGENTS.md](https://github.com/NousResearch/hermes-agent/blob/main/agent/AGENTS.md); [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)
- The architecture page names "RL environments" as an optional subsystem and lists `environments/` as a consumer of `model_tools.py`. — [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)

### Inferences
- For a normal user, this only matters if you want to export your own sessions as fine-tuning data. Day-to-day agent use never touches it.
- The top-level `environments/` directory (distinct from `tools/environments/` terminal backends) is presumably where RL environment integrations, historically Atropos, live. I did not confirm this in this pass.

### Gaps
- None of the docs pages I read mention Nous's Atropos RL framework, so its current integration status in Hermes Agent is unverified.
- I found no source describing how the Hermes LLM family (Hermes 3/4) relates to the agent at runtime, e.g., special tool-call parsing or recommended defaults. The agent is documented as model-agnostic.
