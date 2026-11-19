# Hermes Agent: Tools, Integrations and Extensibility (MCP, Gateway, Cron, API/ACP, Plugins/Hooks, Security)

Research basis and version context (applies to every section below):
- Primary source was the docs source tree (`website/docs/`, the Docusaurus source the docs site is built from) in a shallow clone of github.com/NousResearch/hermes-agent at commit `21ae0e1` dated 2026-11-07 ("fix(deps): pin av 18.1.0 alongside faster-whisper 1.2.1"). Rendered page URLs are cited below. `pyproject.toml` carries a placeholder `version = "0.0.0"`, so the version number comes from release notes.
- The latest published release is **Hermes Agent v0.23.0 ("The Hearth Release")**; earlier ones are v0.22.6, v0.21.0 ("The Pantheon Release", tagged v2026.8.31), v0.19.x and so on — [GitHub Releases](https://github.com/NousResearch/hermes-agent/releases); [Gradually AI changelog mirror (Nov 2026)](https://www.gradually.ai/en/changelogs/hermes-agent/)
- llms.txt describes Hermes as "a messaging gateway that lives on 21+ messaging platforms — 19 native to the gateway plus IRC and Microsoft Teams via plugins", running on "local, Docker, SSH, Daytona, Modal, Vercel Sandbox or plugin backends" — [docs llms.txt](https://hermes-agent.nousresearch.com/docs/assets/files/llms-2a7843a9a75658e6935fc6f34e77c823.txt)

---

## 1. Built-in tools and toolsets: what exists, how to enable/disable it, and which tools need third-party keys

### Takeaway
Hermes ships about 85 built-in tools, grouped into core, composite and platform toolsets. You toggle them with `hermes tools` (a curses UI per platform, saved to `config.yaml`), with `--toolsets` on the command line, with `toolsets:`/`custom_toolsets:` in config, with `agent.disabled_toolsets`, or with `/tools` inside a session. These tools work fully locally: terminal, file, memory, skills, todo, session_search, delegation, code execution, cron, clarify, the local Chromium browser, vision (if the local model or a local auxiliary model can see images), local STT (faster-whisper) and local TTS (Piper, KittenTTS, NeuTTS). These need cloud services: most web search/extract backends, image and video generation, cloud browsers, Edge TTS (keyless but cloud), and premium TTS/STT. SearXNG, DDGS and a community "web-local" extract plugin make web access possible without any API key.

### Cited Findings
**Tool inventory (current registry)**
- "~85 tools — 4 browser tools (`browser_exec`, `browser_cdp`, `browser_dialog`, `browser_vault`), 4 file tools, 2 terminal tools (`terminal`, `process_manage`), 11 desktop-GUI tools ..., 2 web tools, 5 Feishu tools, 14 kanban tools ..., 1 project tool, 2 Discord tools, 3 video tools ... and a handful of standalone tools (`memory`, `clarify`, `delegate_task`, `execute_code`, `cronjob_manage`, `session_search`, `skill_view`/`skill_manage`/`skills_list`, `text_to_speech`, `image_generate`, `vision_analyze` ...)" — [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)
- Core toolsets and their members:
  - `file` = `patch`, `read_file`, `search_files`, `write_file`
  - `terminal` = `terminal`, `process_manage`
  - `web` = `web_search`, `web_extract`; `search` = `web_search` only
  - `browser` = `browser_exec`, `browser_cdp`, `browser_dialog`, `browser_vault`
  - `memory`, `skills` (`skill_manage`, `skill_view`, `skills_list`), `todo` (`todo_list`), `session_search`, `clarify`
  - `code_execution` (`execute_code`), `delegation` (`delegate_task`), `cronjob` (`cronjob_manage`)
  - `vision` (`vision_analyze`), `image_gen` (`image_generate`), `tts` (`text_to_speech`), `video` (`video_analyze`, opt-in), `video_gen` (opt-in)
  - `computer_use`, `x_search` (opt-in, xAI), `kanban` (opt-in), `connections` (`manage_connections`, Nous Portal only), `desktop_ui`/`project`/`catalog` (desktop-app sessions only), `discord`/`discord_admin` (gateway only), `feishu_doc`/`feishu_drive`
  
  — [Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)
- Composite toolsets:
  - `coding` = file + terminal + search + web + skills + browser + todo + memory + session_search + clarify + code_execution + delegation + vision
  - `debugging` = file + terminal + web
  - `safe` = `image_generate`, `vision_analyze`, `web_extract`, `web_search`: "No file writes, no terminal, no code execution"
  
  — [Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)
- Platform toolsets:
  - `hermes-cli` is the full default.
  - `hermes-acp` drops `clarify`, `cronjob`, `image_generate`, `text_to_speech`, `computer_use` and kanban.
  - `hermes-api-server` drops `clarify`, `text_to_speech`, `computer_use` and kanban.
  - `hermes-cron` and most `hermes-<platform>` sets are the same as `hermes-cli`. `hermes-discord` adds the discord tools.
  - `hermes-webhook` is a "Restricted safe subset — only `web_search`, `web_extract`, `vision_analyze`, and `clarify`."
  
  — [Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)
- There is deliberately **no agent-callable `send_message` tool** in current builds. The `toolsets.py` comment reads: "there is deliberately no agent-callable send_message tool" — [toolsets.py](https://github.com/NousResearch/hermes-agent/blob/main/toolsets.py). The docs say the same: "the agent no longer has a `send_message` tool; outbound delivery is handled by cron/`hermes send`" — [research-paper-writing skill doc](https://hermes-agent.nousresearch.com/docs/user-guide/skills/optional/research/research-research-paper-writing). `hermes send --to <target> "text"` sends one-shot messages, and for bot-token platforms it needs no running gateway — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- Moved out of core into catalog plugins:
  - Honcho tools: `hermes plugins install honcho`
  - Home Assistant tools (`ha_*`): `hermes plugins install homeassistant`
  - Spotify tools: `hermes plugins install spotify`
  - Yuanbao tools
  
  — [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)

**Enabling/disabling**
- Per session: `hermes chat --toolsets web,file,terminal`, `--toolsets debugging`, `--toolsets all`. Per platform in `config.yaml`: a `toolsets:` list (for example `hermes-cli`). Interactive: `hermes tools`. In session: `/tools list`, `/tools disable browser`, `/tools enable discord`. Custom bundles go under `custom_toolsets:`. The `all`/`*` wildcard expands to every registered toolset — [Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)
- "`hermes tools` ... operates at the tool level (finer than toolsets) and persists to `config.yaml`. Disabled tools are filtered out even if their toolset is enabled." `hermes tools enable kanban --platform <p>` is cited for opt-in toolsets — [Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference). The CLI reference lists only `hermes tools [--summary]` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands). The configuration page mentions `hermes tools list` and `hermes tools enable` — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- Global kill switch: `agent.disabled_toolsets: [memory, web]`. It "applies after per-platform tool config (`platform_toolsets` written by `hermes tools`), so a toolset listed here is always removed" — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- Some tools are capability-gated: "browser, `computer_use`, `code_execution`, Feishu, cronjob appear only when their backend/credential prerequisite is configured". The `kanban` toolset is never enabled by `all` — [Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)
- From Python: `AIAgent(enabled_toolsets=[...], disabled_toolsets=[...], skip_memory=True)` — [Python Library guide](https://hermes-agent.nousresearch.com/docs/guides/python-library)

**Per-tool external requirements**
- **Web (`web_search`/`web_extract`).**
  - The Tools Reference lists the env requirement as "EXA_API_KEY or PARALLEL_API_KEY or FIRECRAWL_API_KEY or TAVILY_API_KEY or PERPLEXITY_API_KEY or KEENABLE_API_KEY" — [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)
  - The web-search page lists more backends and a keyless mode:
    - Firecrawl (default; keyless cloud when selected; `FIRECRAWL_API_URL` for self-hosting)
    - **SearXNG** (`SEARXNG_URL`, "Free (self-hosted)", search only)
    - Brave free tier (`BRAVE_SEARCH_API_KEY`)
    - **DDGS (DuckDuckGo)** (no key, search only, `ddgs` package)
    - Exa, Parallel, Tavily, Keenable (keyless free tiers)
    - Perplexity (paid)
    - xAI and OpenAI Native (subscription)
  - "A fresh install with no web credentials at all gets working `web_search` and `web_extract` out of the box: requests rotate round-robin across the ring vendors' public free tiers — Exa, Parallel, Firecrawl, and Keenable". You can turn this off with `web.keyless_fallback: false`.
  - Config keys: `web.backend`, or per capability `web.search_backend` / `web.extract_backend`.
  
  — [Web Search & Extract](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search)
- "SearXNG is **search-only** — `web_extract` requires a separate extract provider" — [Web Search & Extract](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search). The community `web-local` catalog plugin offers "Keyless local web extract: fetches pages from this machine with httpx and reduces them to readable text with trafilatura. No API key, no third-party service. Extract-only" (requires_hermes >=0.22) — [plugin-catalog/web-local.yaml](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/web-local.yaml)
- **Browser.**
  - "Local Chromium (default) — Hermes launches its own packaged Chromium, headless, one browser per session. No API key, no setup."
  - Cloud browsers: Nous subscription, Browserbase, Browser Use, Firecrawl, or a browser-provider plugin.
  - Other engines: Lightpanda (lightweight local engine); your own Chrome/Brave/Edge via `/browser connect` (CDP); a "real profile" mode.
  - `browser_exec` "runs model-written Python against the browser over the Chrome DevTools Protocol" and requires the `terminal` toolset.
  
  — [Browser Automation](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser); [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)
- **Version change (v0.23.0):** "The old built-in browser tools are gone. Browser automation runs on `browser_exec` only; agent-browser and the ten `browser_*` tools (`browser_navigate`, `browser_click`, ...) were removed. Homes that used Camofox get the `camofox` plugin installed automatically" — [Gradually AI changelog (v0.23.0 entry)](https://www.gradually.ai/en/changelogs/hermes-agent/). The v0.23.0 release notes also say "Camofox, `mcp-serve`, the agent importers and Singularity moved out of core into plugins" — [GitHub Releases](https://github.com/NousResearch/hermes-agent/releases)
- **Image generation (`image_generate`).** Requires "FAL_KEY / OPENAI_API_KEY / Codex OAuth / xAI OAuth / KREA_API_KEY" — [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference). Bundled image_gen plugins are deepinfra, fal, krea, meta-ai, openai, openai-codex, openrouter and xai — [plugins/image_gen](https://github.com/NousResearch/hermes-agent/tree/main/plugins/image_gen). The OpenAI provider "can point at any OpenAI-compatible `/v1/images/generations` endpoint (a local gateway ...)" via `image_gen.openai.base_url` and `key_env` — [Image Generation](https://hermes-agent.nousresearch.com/docs/user-guide/features/image-generation)
- **Video generation.** Needs xAI, FAL, OpenRouter or DeepInfra keys. The toolset is opt-in — [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)
- **TTS (`text_to_speech`).** Eleven providers:
  - **Edge TTS (default, "Free", "None needed")**
  - ElevenLabs, OpenAI (`VOICE_TOOLS_OPENAI_KEY`), MiniMax, Mistral, Gemini, xAI, DeepInfra
  - **NeuTTS, KittenTTS and Piper are "Free (local)"**. "Piper ... runs entirely on CPU, supports 44 languages ... needs no API key". Voices download on first use to `~/.hermes/cache/piper-voices/`.
  - Custom command providers and Python plugin providers are supported. `tts.openai.base_url` allows "OpenAI-compatible TTS endpoints".
  
  — [TTS](https://hermes-agent.nousresearch.com/docs/user-guide/features/tts)
- **STT.** "Local Whisper (default) ... Free ... None needed", via faster-whisper. Groq and OpenAI are cloud alternatives. The `HERMES_LOCAL_STT_COMMAND` hook is available. "The first use downloads the selected model from `huggingface.co`; later loads prefer the local cache" — [TTS/STT](https://hermes-agent.nousresearch.com/docs/user-guide/features/tts)
- **Voice mode.** CLI voice needs PortAudio, ffmpeg, opus and the `voice` extra (`sounddevice`, `numpy`, Faster-Whisper). It also covers Telegram and Discord (including voice channels) and a wake word ("hey hermes") — [Voice Mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode)
- **Vision.** For text-only main models, images are "Routed through the `vision_analyze` auxiliary tool — an auxiliary vision model describes the image". Vision-capable main models get native pixels — [Vision](https://hermes-agent.nousresearch.com/docs/user-guide/features/vision). "By default (`auxiliary.*.provider: "auto"`), Hermes routes every auxiliary task to your main chat model". The auxiliary tasks are vision, title_generation, compression, approval, voice_chat, delegation and more — [Configuration: Auxiliary Models](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **Code execution.** "The script runs in a child process on the agent host, communicating with Hermes over a Unix domain socket RPC"; "Only the script's `print()` output is returned to the LLM" — [Code Execution](https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution)
- **Delegation.** "Up to 10 concurrent subagents by default" (`delegation.max_concurrent_children`). `delegation.max_spawn_depth` defaults to 1 (flat) — [Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation). The Delegation auxiliary entry's "`auto` means inherit the parent agent's provider, model, and credentials" — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **session_search.** "FTS5-backed retrieval; returns actual messages from the DB (no LLM calls)" — [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)
- **computer_use.** "Background desktop control via cua-driver ... Works with any tool-capable model. macOS, Windows, and Linux". Requires `cua-driver` on PATH (`hermes computer-use install`) — [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference); [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **x_search.** Needs `XAI_API_KEY` or xAI Grok OAuth. **manage_connections** needs a Nous Portal sign-in with connectors enabled — [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)
- **Nous Tool Gateway** (paid Nous Portal subscription). It routes "web search, image generation, text-to-speech, and cloud browser automation — through infrastructure Nous already runs". Setup: `hermes setup --portal`, or per-tool `nous` provider selections — [Tool Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-gateway)
- **Terminal backends:**
  - `local` (default)
  - `docker`
  - `ssh`
  - `singularity` (plugin)
  - `sprites` (plugin, Fly.io)
  - `modal`, `daytona`, `vercel_sandbox` (cloud)
  
  Config: `terminal.backend`, `terminal.cwd`, `terminal.timeout` (default 180) — [Tools & Toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools)

### Inferences
**Local/offline compatibility matrix (LLM served locally, no cloud keys):**

Works fully offline:
- `terminal` with the local, docker, ssh-to-LAN or bubblewrap backends
- `file`, `memory` (built-in), `skills` (local skills only; the hub needs network), `todo`, `session_search`, `clarify`
- `execute_code`, `delegate_task` (inherits the local model), `cronjob_manage`
- `computer_use` (cua-driver)
- Local Chromium and Lightpanda browsing (only for intranet/localhost pages when truly offline)
- Piper, KittenTTS and NeuTTS TTS, after the one-time voice download
- faster-whisper STT, after the one-time model download from Hugging Face
- Smart approvals, compression and title generation (the auxiliary default is the main model, so they run on the local model)

Works without keys but needs internet:
- `web_search`/`web_extract` through the keyless vendor ring (Exa/Parallel/Firecrawl/Keenable), DDGS, Tavily keyless and public SearXNG instances
- Edge TTS (the keyless default; it calls Microsoft's online service, so it is not offline)

Works with self-hosting:
- SearXNG in Docker for search, plus the `web-local` plugin or a self-hosted Firecrawl (`FIRECRAWL_API_URL`) for extract
- An OpenAI-compatible local image endpoint via `image_gen.openai.base_url`
- An OpenAI-compatible local TTS endpoint via `tts.openai.base_url`
- A custom command TTS/STT provider

Needs cloud keys or subscriptions:
- FAL/OpenAI/xAI/Krea image generation
- Video generation
- Browserbase, Browser Use and Firecrawl cloud browsers
- ElevenLabs, OpenAI, MiniMax, Mistral, Gemini and xAI TTS
- Groq/OpenAI STT
- x_search, Nous Tool Gateway and managed connectors

Other inferences:
- **Vision on a local model:** it works if the local main model is vision-capable, or if `auxiliary.vision` points at a local VLM (the base_url option is described). With a text-only local model and no auxiliary VLM, image understanding degrades.
- The keyless web ring is on by default. Strictly offline or privacy-sensitive setups should set `web.keyless_fallback: false` (and `web.keyless_rescue: false`) so queries do not leak to third-party vendors, then configure SearXNG or DDGS explicitly.

### Gaps
- I did not verify NeuTTS/KittenTTS install specifics (extras, model downloads) or whether Edge TTS falls back to a local engine offline.
- The docs disagree on `hermes tools` subcommands (`enable`/`list`/`--platform`): the CLI reference shows only `--summary`, while other pages reference `hermes tools enable`. I did not check the exact syntax against code.
- I did not find the exact release in which `send_message` was removed, or in which the Honcho/Spotify/Home Assistant tools moved to plugins (Home Assistant plugin v2.0.1 declares `requires_hermes >=0.21.5`).

---

## 2. MCP: configuring MCP servers, and whether Hermes can itself be an MCP server

### Takeaway
MCP client support is built in. You configure servers under `mcp_servers:` in `~/.hermes/config.yaml`:
- stdio servers use `command`/`args`/`env`/`cwd`
- HTTP servers use `url`/`headers`, with Streamable HTTP by default and `transport: sse` for SSE
- options cover OAuth 2.1 PKCE, mTLS, timeouts, lazy start, recycling, include/exclude glob filtering, a `trust: untrusted` tier and spend limits

You can manage servers with `hermes mcp add/list/test/configure/login` and a Nous-approved catalog. Hermes can also act as an MCP server, but as of v0.23.0 only through the official `mcp-serve` plugin (`hermes mcp-serve`); this used to be the built-in `hermes mcp serve`. MCP itself works offline with local stdio servers.

### Cited Findings
- "MCP support ships with the standard install — no extra step needed". Minimal config: `mcp_servers: filesystem: command: "npx" args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]` — [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- Common keys are `command`, `args`, `env`, `cwd`, `url`, `headers`, `client_cert`/`client_key` (mTLS), `identity_header`, `timeout`, `connect_timeout`, `lazy`, `idle_timeout_seconds`, `max_lifetime_seconds`, `enabled`, `supports_parallel_tool_calls`, `events` (experimental) and `tools` — [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- Config reference extras:
  - `timeout` default **300 s**; `connect_timeout` default **60 s**
  - `transport: sse` ("Set to `sse` to use the SSE transport instead of Streamable HTTP")
  - `auth: oauth` ("OAuth 2.1 with PKCE")
  - `ssl_verify`, `protocol` (auto/handshake negotiation), `keepalive_interval`, `skip_preflight`
  - `sampling` (server-initiated LLM requests), `elicitation`
  - `trust: full|untrusted`: on untrusted servers "every write-capable tool call (any tool without a `readOnlyHint: true` annotation) requires user approval"
  - `tool_costs`, `spend_limit`, `cost_unit`
  - `${ENV_VAR}`, `${userHome}` and `${workspaceFolder}` substitution
  
  — [MCP Config Reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)
- Filtering: `tools.include` (whitelist) and `tools.exclude` (blacklist). Both accept fnmatch globs (for example `exclude: ["*_radar_*"]` for Cloudflare's ~3,300-tool MCP), and "`include` wins" if both are set. `tools.resources: false` / `tools.prompts: false` disable the utility wrappers (`list_resources`, `read_resource`, `list_prompts`, `get_prompt`), which are registered only if the server supports them. `enabled: false` skips the server entirely — [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- Runtime behavior:
  - Discovery connects at most 4 servers at a time (`mcp.discovery_concurrency`), with a 120 s budget per wave and 300 s per pass.
  - `lazy: true` registers tools from an on-disk schema cache and spawns the server on first call.
  - `notifications/tools/list_changed` triggers an automatic re-fetch.
  - `/reload-mcp` reloads servers.
  - A running gateway watches `config.yaml` and adds or removes servers within about a minute.
  - Failed connects retry from 30 s, doubling up to 10 min.
  
  — [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- Each server yields a runtime toolset `mcp-<server>`, usable in `--toolsets`. The bare server name works as an alias — [Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference)
- **Tool naming discrepancy:** the MCP feature page says tools register as `mcp_<server_name>_<tool_name>` (e.g. `mcp_github_create_issue`) — [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp). The Tools/Toolsets references say the prefix is `mcp__<server>__` (e.g. `mcp__github__create_issue`) — [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference). The code defines `MCP_TOOL_NAME_PREFIX = "mcp__"` — [tools/mcp_tool_schema.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/mcp_tool_schema.py). The double-underscore form appears current; the single-underscore table on the MCP page looks stale.
- Security:
  - "For stdio servers, Hermes does not blindly pass your full shell environment. Only explicitly configured `env` plus a safe baseline are passed through."
  - Invisible Unicode TAG characters (U+E0000–U+E007F) are stripped from MCP results and descriptions as a prompt-injection defense.
  - MCP error messages are redacted (`ghp_...`, `sk-...`, Bearer tokens, `token=`/`key=`/`password=` params).
  
  — [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp); [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- CLI: `hermes mcp` (picker), `catalog`, `install <name>` (e.g. `deepwiki`), `add <name> [--url URL] [--command CMD] [--auth oauth|header] [--args ...]`, `remove`, `list`, `test <name>`, `configure <name>` and `login <name>` (OAuth re-auth) — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands). The repo ships an `optional-mcps/` catalog (airtable, asana, atlassian, cloudflare, context7, deepwiki, figma, gitlab, grafana, hugging_face, linear and many more) — [optional-mcps/](https://github.com/NousResearch/hermes-agent/tree/main/optional-mcps)
- **Hermes as an MCP server:** "This ships as the official **mcp-serve** plugin: `hermes plugins install mcp-serve`". The client config is `{"command": "hermes", "args": ["mcp-serve"]}`. "It used to be built in as `hermes mcp serve`" — [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp). What the plugin exposes:
  - MCP clients (Claude Code, Claude Desktop, Cursor, Codex) can "list and read your messaging conversations, poll live events, send messages and answer approvals over stdio"
  - "`--tools` (off by default) also exposes Hermes' web, browser, vision, image generation, skills and TTS tools; terminal, file and kanban tools are never exposed"
  - requires_hermes >=0.22.0
  
  — [plugin-catalog/mcp-serve.yaml](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/mcp-serve.yaml)
- In ACP mode, editor-supplied `mcpServers` attach to the canonical gateway session. Their credentials are held only in memory and must be re-supplied after a gateway restart — [ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)
- The v0.21.0 notes describe an "MCP command center" in the desktop app (health checks, cost overlay, `hermes://` deep-link installs) — [Gradually AI changelog](https://www.gradually.ai/en/changelogs/hermes-agent/)

### Inferences
- With a local LLM, stdio MCP servers (filesystem, git, a local Playwright MCP, sqlite and similar) are fully offline-capable. `npx`/`uvx`-based servers need their packages pre-fetched before going offline.
- MCP "sampling" requests from servers would be answered by the configured (local) model.
- Users migrating from versions before v0.23 must change MCP client args from `["mcp","serve"]` to `["mcp-serve"]` and install the plugin.

### Gaps
- I did not read the mcp-serve plugin README for its exact tool list and safety limits (it lives in a separate repo, NousResearch/hermes-official-plugins).
- I did not check the exact sampling policy keys (`sampling:` sub-keys) or the defaults for OAuth token storage location (protected path `mcp-tokens/` under HERMES_HOME is mentioned in Security).

---

## 3. Messaging gateway: platforms, `hermes gateway` lifecycle, allowlists/pairing, per-platform config

### Takeaway
The gateway is one background process. It connects all configured chat platforms, handles sessions, runs the cron ticker, and hosts the API server and webhooks. As of v0.23.0 it also owns every session from every surface, including the CLI, TUI, Desktop and ACP.
- Setup is `hermes gateway setup`. It runs with `hermes gateway`, or as a systemd user/system service, launchd agent or Task Scheduler task via `hermes gateway install`.
- It is deny-by-default: users must be allowlisted (`<PLATFORM>_ALLOWED_USERS`, `GATEWAY_ALLOWED_USERS`) or approved through DM pairing (`hermes pairing approve <platform> <code>`).
- Most platforms need internet plus a vendor bot token. Self-hostable or LAN options exist (Matrix, Mattermost, IRC, ntfy, Email via your own IMAP/SMTP, Home Assistant, webhooks, the API server/Open WebUI).

### Cited Findings
- The description lists "Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Home Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Weixin, BlueBubbles (iMessage), QQ, Yuanbao, Microsoft Teams, LINE, ntfy, or your browser. The gateway is a single background process that connects to all your configured platforms, handles sessions, runs cron jobs, and delivers voice messages" — [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- The platform comparison table covers:
  - Telegram, Discord, Slack, Google Chat
  - WhatsApp (Baileys bridge) and WhatsApp Cloud API
  - Signal, SMS, Email, Home Assistant (plugin)
  - Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, WeCom Callback, Weixin
  - BlueBubbles, Photon (iMessage), QQ, Yuanbao (Labs plugin)
  - Microsoft Teams, LINE, ntfy, Raft, IRC, Buzz, SimpleX
  
  The table also lists voice, image, file, thread, reaction, typing and streaming support for each. Hermes Relay (experimental) fronts platforms through an external connector that holds the credentials — [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- Bundled platform adapter plugins in the repo: a2a, bluebubbles, buzz, dingtalk, discord, email, feishu, google_chat, irc, line, matrix, mattermost, ntfy, photon, qqbot, raft, signal, simplex, slack, sms, teams, telegram, wecom, weixin, whatsapp, whatsapp_cloud — [plugins/platforms](https://github.com/NousResearch/hermes-agent/tree/main/plugins/platforms)
- Per-platform transports:
  - Slack uses Socket Mode
  - Signal uses the signal-cli daemon in HTTP mode, which needs Java 17+
  - WhatsApp uses "the built-in Baileys bridge", or Meta's Business Cloud API
  - SMS uses Twilio
  - Email uses IMAP/SMTP
  - Google Chat uses Cloud Pub/Sub
  - Open WebUI connects through the OpenAI-compatible API server
  
  — [Signal](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/signal); [WhatsApp](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp); [Slack](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack); [SMS](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/sms); [Email](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/email); [Open WebUI](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/open-webui)
- Home Assistant moved to the `homeassistant` catalog plugin (`hermes plugins install homeassistant`). It uses `HASS_TOKEN` and `HASS_URL` (e.g. `http://192.168.1.100:8123`) and provides both the gateway platform and the `ha_*` tools. Existing users are auto-migrated — [Home Assistant](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/homeassistant)
- Commands:
  - `hermes gateway` (foreground)
  - `hermes gateway setup` (interactive wizard)
  - `hermes gateway install` (user service on Linux, launchd on macOS)
  - `sudo hermes gateway install --system` (Linux boot-time system service)
  - `hermes gateway start|stop|status`
  - Logs: `journalctl --user -u hermes-gateway -f`
  - `sudo loginctl enable-linger $USER` keeps the service running after logout
  - The installed unit uses `KillMode=mixed`, `Restart=always`. "Do not add a systemd drop-in such as `ExecStopPost=/bin/kill -9 $MAINPID`"
  
  Windows uses Task Scheduler — [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- Security: "By default, the gateway denies all users who are not in an allowlist or paired via DM."
  - Env allowlists: `TELEGRAM_ALLOWED_USERS`, `DISCORD_ALLOWED_USERS`, `SIGNAL_ALLOWED_USERS`, `EMAIL_ALLOWED_USERS`, `MATRIX_ALLOWED_USERS`, and so on; `GATEWAY_ALLOWED_USERS`; `GATEWAY_ALLOW_ALL_USERS=true` ("NOT recommended")
  - DM pairing: unknown users get a one-time code. You approve with `hermes pairing approve telegram XKGH5N7P`; other commands are `hermes pairing list` and `hermes pairing revoke`. "Pairing codes expire after 1 hour, are rate-limited, and use cryptographic randomness". Email senders are ignored unless email pairing is enabled.
  
  — [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- Admin/user tiers per platform and scope live under `gateway.platforms.<p>.extra` (`allow_from`, `allow_admin_from`, `user_allowed_commands`, `group_allow_admin_from` and so on). Today they gate slash commands only. Bot-to-bot handling uses `*_ALLOW_BOTS`, `bot_users` and `gateway.bot_loop_guard` (`max_hops` default 4) — [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- Other features:
  - Per-channel model and system prompt overrides
  - Busy-input modes (queue, interrupt, steer)
  - Tool progress notifications (including a `log` mode)
  - Background sessions, `/platform`, circuit breaker, session resume across restarts
  - Disabling a platform whose credentials remain in `.env` (`platforms.<name>.enabled: false`)
  - `gateway.trust_env` to ignore inherited proxies
  
  — [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- Webhooks platform:
  - An HTTP server validates HMAC signatures on `http://your-server:8644/webhooks/<route-name>` (`WEBHOOK_ENABLED=true`, `WEBHOOK_PORT=8644`, `hermes webhook subscribe`).
  - Webhook runs default to the constrained toolset (`web_search`, `web_extract`, `vision_analyze`, `clarify`), "because webhook payloads can carry untrusted third-party content". Per-route `toolsets:` can widen trusted routes.
  
  — [Webhooks](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks). **Conflict:** the Messaging index's toolset table lists Webhooks as "Full tools including terminal" — [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/). The webhooks page and the toolsets reference both state the restricted default.
- v0.23.0: "One gateway owns every conversation — ... each machine runs one gateway that owns every session, and every surface attaches to it as a client" — [GitHub Releases](https://github.com/NousResearch/hermes-agent/releases). Plugins doc: "Every Hermes session (`hermes`, `hermes --tui`, the Desktop app, messaging and cron) runs in the one gateway" — [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)
- Voice messages on Telegram, Discord, WhatsApp, Slack and Signal are auto-transcribed (local Whisper by default) — [TTS/STT](https://hermes-agent.nousresearch.com/docs/user-guide/features/tts)

### Inferences
- In a fully local setup, these work without third-party cloud: Matrix (self-hosted Synapse/Conduit), Mattermost, IRC, self-hosted ntfy, Email via a LAN mail server, Home Assistant on the LAN, webhooks, the API server plus Open WebUI, and SimpleX (self-hostable relays).
- Telegram, Discord, Slack, WhatsApp, Signal, SMS (Twilio), Teams, Google Chat, LINE, Feishu, DingTalk, WeCom, Weixin and QQ all require internet access to vendor services and bot credentials. They still work with a local LLM.
- Since every surface now attaches to one gateway (v0.23.0), a local-only CLI user still runs a gateway process. Messaging platforms are simply not enabled unless credentials exist.

### Gaps
- I did not extract per-platform env var names for each adapter beyond the allowlist list (for example `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN` are implied by tool docs; others not verified).
- I did not check whether IRC and Teams are bundled or catalog plugins in v0.23. The llms.txt says "IRC and Microsoft Teams via plugins", but `plugins/platforms/` in the repo contains both irc and teams.

---

## 4. Scheduled tasks (cron): natural-language jobs, execution, storage

### Takeaway
Cron runs on one agent tool, `cronjob_manage` (create/list/update/pause/resume/run/remove). You can also use `/cron add` in chat, `hermes cron create` on the CLI, plain-language requests ("Every morning at 9am..."), the dashboard and the API. The gateway daemon ticks every 60 s and runs due jobs in fresh, isolated agent sessions. Jobs are stored in `~/.hermes/cron/jobs.json`, with outputs under `~/.hermes/cron/output/<job_id>/`. Delivery goes to the origin chat, local files or any platform target. Cron works fully offline with a local model when delivery is `local` or a LAN platform.

### Cited Findings
- "Hermes exposes cron management through a single `cronjob_manage` tool with action-style operations". Jobs can be one-shot or recurring; you can pause, resume, edit, trigger, remove and stop in-flight runs; attach multiple skills; and use "no-agent mode — a script on a schedule, its stdout delivered verbatim, zero LLM involvement". Jobs can also be event-triggered from webhook routes — [Scheduled Tasks (Cron)](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- Creating jobs:
  - In chat: `/cron add "in 30m" "Remind me..."`, `/cron add "every 2h" "Check server status"`, `--skill blogwatcher`
  - On the CLI: `hermes cron create "every 2h" "Check server status" --skill ... --name ...`
  - In plain language: "Every morning at 9am, check Hacker News for AI news and send me a summary on Telegram." (Hermes uses `cronjob_manage` internally)
  
  — [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- "Cron execution is handled by the gateway daemon. The gateway ticks the scheduler every 60 seconds, running any due jobs in isolated agent sessions." `hermes cron tick` exists for external schedulers, but "The gateway must be running". Status commands are `hermes cron status`, `hermes cron doctor`, `hermes cron list`. `hermes pause`/`hermes resume` is a global emergency stop, and `hermes cron cancel` stops an in-flight run — [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- Storage: per-job model pins are editable "by editing `~/.hermes/cron/jobs.json`". The cron store is `~/.hermes/cron/` (or the profile's own `cron/`). Local delivery goes to `~/.hermes/cron/output/`. If the store is unwritable, the scheduler refuses to run jobs it cannot record — [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- Model resolution: per-job pin, then `cron.model`/`cron.model_provider`, then the main model at fire time. Per-job `reasoning_effort` is supported. "The agent cannot point a job at a different model — inference pins are user-owned" — [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- Delivery targets:
  - `origin` (the default on messaging) and `local` (the default on CLI)
  - `telegram`, `telegram:<chat_id>`, `telegram:<chat>:<thread>`, `discord:#channel`, `slack`, `whatsapp`, `signal`, `matrix`, `mattermost`, `email`, `sms`, `homeassistant` (plugin), `dingtalk`, `feishu`, `wecom`, `weixin`, `bluebubbles`, `qqbot`
  - `bot-chat`, `bot-chat:<profile>`, `all`, comma lists, and `origin,all`
  
  "The agent's final response is automatically delivered ... the agent does not send messages itself". Delivered output is secret-redacted even when `security.redact_secrets: false` — [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- Approvals in cron: `approvals.cron_mode: deny` (default) blocks dangerous commands headlessly; `approve` auto-approves them — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security). "By default, agents launched by the scheduler cannot use the `cronjob_manage` tool" (agent-managed scheduling is opt-in) — [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- Version changes:
  - v0.21.0: cron agents "load and update persistent memory", `continuity=true` carries output between runs, a per-job notepad, and monitor-mode jobs that skip the LLM when nothing changed
  - v0.23.0: stop a running cron job, plus a per-job missed-run policy
  
  — [Gradually AI changelog](https://www.gradually.ai/en/changelogs/hermes-agent/); [GitHub Releases](https://github.com/NousResearch/hermes-agent/releases)
- The API server exposes a Jobs API (`GET/POST /api/jobs`, `PATCH`/`DELETE /api/jobs/{id}`, `/pause`, `/resume`, `/run`) — [API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)

### Inferences
- For a local-only box, run `hermes gateway install` (or `--system` on a headless server) so cron fires. Otherwise jobs show as "OVERDUE".
- With a slow local model, consider `cron.model` to pin a smaller or faster local model for unattended jobs, and keep `approvals.cron_mode: deny`.

### Gaps
- I did not verify the exact on-disk job JSON schema, or whether jobs.json is per-profile under `~/.hermes/profiles/<name>/cron/` (the docs imply it with "the profile's own `cron/` directory").

---

## 5. API server (OpenAI-compatible), ACP editor integrations, desktop/web UIs, programmatic use

### Takeaway
- **API server.** The gateway can expose an OpenAI-compatible API on `127.0.0.1:8642` (`API_SERVER_ENABLED=true`, a mandatory `API_SERVER_KEY`). It serves `/v1/chat/completions`, `/v1/responses`, `/v1/models` and a Hermes-specific Runs/Jobs/Sessions API, so Open WebUI, LobeChat or LibreChat can sit in front of the full agent.
- **ACP.** `hermes acp` runs Hermes as an ACP server over stdio for VS Code (ACP Client extension), Zed (custom agent server) and JetBrains (ACP plugin). It needs the `acp` extra.
- **Other front ends:** a native Hermes Desktop app (macOS Apple Silicon, Windows, Linux); a web dashboard (`hermes dashboard`, port 9119); a v0.23.0 "Webapp" that serves the Desktop workspace in a browser (`hermes webapp`, off by default); and the TUI (`hermes --tui`).
- **Python embedding:** `from run_agent import AIAgent` from a source checkout. There is no supported wheel.

All of these run locally with a local model.

### Cited Findings
- "The API server exposes hermes-agent as an OpenAI-compatible HTTP endpoint. Any frontend that speaks the OpenAI format — Open WebUI, LobeChat, LibreChat, NextChat, ChatBox, and hundreds more — can connect". Enable it with `API_SERVER_ENABLED=true` and `API_SERVER_KEY=...` in `~/.hermes/.env`, then run `hermes gateway`. The log line is "API server listening on http://127.0.0.1:8642"; clients use `http://localhost:8642/v1` with `model: "hermes-agent"` — [API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- Env vars:
  - `API_SERVER_PORT` (default 8642) and `API_SERVER_HOST` (default 127.0.0.1)
  - `API_SERVER_KEY` ("Required whenever the API server is enabled", even on loopback)
  - `API_SERVER_CORS_ORIGINS` (default disabled)
  - `API_SERVER_MODEL_NAME` (defaults to the profile name or `hermes-agent`)
  - `GATEWAY_PROXY_KEY` (proxy mode)
  
  — [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables)
- Endpoints:
  - `POST /v1/chat/completions`, `POST /v1/responses` (with `previous_response_id` and named conversations), `GET/DELETE /v1/responses/{id}`, `GET /v1/models`, `GET /v1/capabilities`, `GET /api/model/options` (per-request model selection), `/health`, `/health/detailed`
  - Runs API: `POST /v1/runs`, `GET /v1/runs/{id}/events` (SSE), `/stop`, `/approval`, `/clarify`, `/resolve-unknown`
  - Jobs API: `/api/jobs*`
  - Sessions API: `/api/sessions/*` (fork, stream)
  - `GET /v1/skills` and `GET /v1/toolsets`
  - Idempotency keys
  
  Multi-profile routing uses `/p/<profile>/...` with each profile's own key — [API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- API sessions use the `hermes-api-server` toolset (no clarify, TTS, computer_use or kanban) — [Toolsets Reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference). Dangerous commands follow `approvals.unattended_mode: deny` by default for webhook, msgraph_webhook and api_server sessions — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- "Browser-extension control (removed)" appears as a section in the API server page (a past feature, now removed) — [API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- ACP:
  - "Hermes Agent can run as an ACP server, letting ACP-compatible hosts talk to Hermes over stdio". Editors render chat, tool activity, file diffs, terminal commands, approval prompts and streamed thinking.
  - Install the extra with `cd ~/.hermes/hermes-agent && python -c "import pm; pm.sync_venv(['acp'], explicit=True)"`. Launch with `hermes acp`, `hermes-acp` or `python -m acp_adapter`; `hermes acp --check` is available.
  - VS Code: the "ACP Client" extension (formulahendry.acp-client), with an `acp.agents` setting of `{"command":"hermes","args":["acp"]}`.
  - Zed: `agent_servers: {"hermes-agent": {"type":"custom","command":"hermes","args":["acp"]}}`.
  - JetBrains: "Use an ACP-compatible plugin and point it at `hermes acp`".
  - Buzz Desktop and Buzz channels are also supported.
  - Approvals map to allow once / allow always / deny and are denied on timeout (`approvals.timeout`, 300 s).
  
  — [ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)
- Desktop: "The Hermes desktop app is a native app built around the same agent you get from the CLI and the gateway". It runs on "macOS (Apple Silicon), Windows, and Linux". Front ends: Desktop, CLI (`hermes`), TUI (`hermes --tui`), Web Dashboard (`hermes dashboard`) — [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
- `hermes dashboard`:
  - Default `--port 9119` and `--host 127.0.0.1`.
  - "Since the June 2026 hardening a public bind always requires an auth provider (password or OAuth)"; `--insecure` is a deprecated no-op.
  - `hermes dashboard register` registers the dashboard with Nous Portal OAuth.
  - `hermes serve` is a headless backend.
  
  — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- `hermes webapp`: "Open the Hermes Desktop workspace in a normal browser. The gateway serves it on its own listener when `webapp.enabled` is `true`". It uses a one-use 60-second sign-in link; a public bind requires a sign-in gate — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands). v0.23.0 highlight: "Your Desktop workspace in a browser tab ... It is off by default; turn it on with `webapp.enabled`" — [GitHub Releases](https://github.com/NousResearch/hermes-agent/releases)
- Python library:
  - `from run_agent import AIAgent; agent = AIAgent(model=..., quiet_mode=True); agent.chat("...")`, or `run_conversation()` for full results.
  - "Hermes does not publish a supported wheel or source distribution for `requirements.txt` installs". Clone and `source ./activate` instead.
  - Parameters include `enabled_toolsets`, `disabled_toolsets` and `skip_memory`.
  
  — [Python Library](https://hermes-agent.nousresearch.com/docs/guides/python-library). See also [Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- `hermes -z`/one-shot and `hermes chat -q` single-query sessions exist. `approvals.single_query_mode: deny` governs dangerous commands in them — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security); [Tools Reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference)

### Inferences
- A fully local stack is possible: local LLM → Hermes gateway with the API server on 127.0.0.1:8642 → Open WebUI on the same host. No cloud key is needed beyond whatever tools are enabled.
- Exposing 8642, 9119 or the webapp beyond loopback requires auth. Keep the API key strong because API sessions get terminal and file tools.
- ACP and the Desktop app do not need cloud services. Desktop-only tools (`desktop_ui`, `catalog`, `connections`) partly assume Nous Portal (connectors/catalog), but the core chat works with any provider.

### Gaps
- I did not find a description of a JetBrains-specific ACP plugin name.
- I did not verify whether the Desktop app bundles its own gateway or requires the CLI install, or its download source (covered by the installation researcher).

---

## 6. Plugins, hooks and custom tools: how to extend Hermes

### Takeaway
Extensibility comes in layers:
1. **General plugins.** A directory in `~/.hermes/plugins/<name>/` with `plugin.yaml` and an `__init__.py` `register(ctx)` function, or a pip entry point. A plugin can register tools, hooks, slash commands, CLI commands, skills, gateway platforms, image/video-gen backends, terminal backends, approval transports, MCP calls and LLM calls. Plugins are opt-in via `plugins.enabled`.
2. **Provider plugins.** Memory, context-engine and model-provider plugins.
3. **Four hook systems:**
   - Gateway `HOOK.yaml` + `handler.py` in `~/.hermes/hooks/`
   - Plugin hooks (27 lifecycle events, including the blocking `pre_tool_call`/`pre_llm_call`)
   - Shell hooks configured in `config.yaml`
   - Signed outbound webhooks
4. **The plugin catalog** (`hermes plugins install <name>`, about 1,200 entries pinned to reviewed SHAs, with security scanning).
5. **MCP servers**, which the contributing guide prefers over new core tools.

### Cited Findings
- "Drop a directory into `~/.hermes/plugins/` with a `plugin.yaml` and Python code". The minimal example's `plugin.yaml` declares `provides_tools: [hello_world]` and `provides_hooks: [post_tool_call]`. `register(ctx)` calls `ctx.register_tool(name="hello_world", toolset="hello_world", schema=..., handler=handle_hello)` and `ctx.register_hook("post_tool_call", on_tool_call)`. Handlers return JSON strings — [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)
- The capabilities table covers:
  - `ctx.register_tool`, `register_hook`, `register_command` (slash command), `dispatch_tool`, `register_cli_command` (`hermes <plugin> <sub>`)
  - `inject_message`, `post_message`, `register_skill` (namespaced `plugin:skill`)
  - `requires_env` in plugin.yaml; pip entry point `hermes_agent.plugins`
  - `register_platform` (gateway adapters), `register_image_gen_provider`, `register_video_gen_provider`, `register_delegation_provider`, `register_context_engine`, `register_terminal_environment_provider`, `register_computer_use_provider`, `register_approval_transport`
  - `ctx.llm.complete(...)` (borrow the user's model) and `ctx.call_mcp(server, tool, args)` (capability-gated, default-off per-server allowlist)
  - Memory providers (subclass `MemoryProvider`) and model providers (`register_provider(ProviderProfile(...))`)
  
  — [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)
- Discovery order: bundled `<repo>/plugins/`, then user `~/.hermes/plugins/`, then pip entry points, then Nix. Project-local `.hermes/plugins/` is "Not loaded by the gateway that runs sessions" (since every session runs in the gateway, `HERMES_ENABLE_PROJECT_PLUGINS=true` has no effect on sessions) — [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)
- "General plugins and user-installed backends are disabled by default — discovery finds them ... but nothing with hooks or tools loads until you add the plugin's name to `plugins.enabled` in `~/.hermes/config.yaml`" — [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)
- Management commands:
  - `hermes plugins` (UI), `list`, `search <term>`
  - `install <name>` ("catalog entry (repo @ reviewed pinned SHA)")
  - `install user/repo [--enable|--no-enable]`
  - `update`, `enable`, `remove`
  
  Other mechanisms: install-time security scanning; `plugins.isolation` to run plugins out of process; plugin packs; and Desktop one-click install links — [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins). The repo's `plugin-catalog/` holds ~1,200 YAML entries (official and community tiers) — [plugin-catalog/](https://github.com/NousResearch/hermes-agent/tree/main/plugin-catalog)
- Hook systems: "Gateway hooks (`HOOK.yaml` + `handler.py` in `~/.hermes/hooks/`, Gateway only); Plugin hooks (`ctx.register_hook()`, CLI + Gateway); Shell hooks (`hooks:` block in profile `config.yaml` pointing at shell scripts) ... Drop-in scripts for blocking, auto-formatting, context injection; Outbound webhooks (`hooks.outbound:` list) — Push signed lifecycle events to external HTTP endpoints" — [Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- Gateway hook events: `gateway:startup`, `session:start`, `session:end`, `session:reset`, `session:compress`, `agent:start`, `agent:step`, `agent:end`, `reaction:added`, `reaction:removed`, `command:*`. Gateway hooks are "trusted-by-placement": "There is no sandbox, no first-use prompt, and `HERMES_SAFE_MODE` does not skip this loader". The BOOT.md tutorial runs a startup checklist on every gateway boot — [Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- Plugin hook catalog: "27 lifecycle events" in these categories:
  - Directive/control: `pre_tool_call`, `pre_llm_call`, `pre_verify`, `pre_gateway_dispatch`
  - Transform: `transform_tool_result`, `transform_terminal_output`, `transform_llm_output`, `pre_transcription`
  - Observer: `post_tool_call`, `post_llm_call`, `pre/post_api_request`, `on_session_*`, `subagent_start/stop`, `pre_approval_request`, and more
  
  — [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins); [Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks). The v0.22.6 notes mention "a `pre_llm_call` hook that can block a turn before inference" — [GitHub Releases](https://github.com/NousResearch/hermes-agent/releases)
- The contributing guide orders the preferred way to add capability: "service-gated tool (`check_fn`) → plugin → MCP server in the catalog → new core tool (last resort)" — [Contributing](https://hermes-agent.nousresearch.com/docs/developer-guide/contributing). Adding a core tool is covered in [Adding Tools](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-tools), and the registry is described in [Tools Runtime](https://hermes-agent.nousresearch.com/docs/developer-guide/tools-runtime)
- Notable official plugins (NousResearch/hermes-official-plugins):
  - `bubblewrap` (Linux sandbox terminal backend, requires_hermes >=0.22.6)
  - `mcp-serve`, `camofox` (self-hosted anti-detection Firefox)
  - `homeassistant`, `singularity`, `honcho`, `spotify`
  - v0.23.0 additions: Meshy, ElevenLabs Music/SFX, X Chat, REA
  
  — [plugin-catalog/bubblewrap.yaml](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/bubblewrap.yaml); [GitHub Releases](https://github.com/NousResearch/hermes-agent/releases)
- Lazy optional-dependency installs (from PyPI) can be disabled with `hermes config set security.allow_lazy_installs false` — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)

### Inferences
- Custom local tools (for example wrappers around local services) are simplest as a user plugin with `ctx.register_tool`, followed by `hermes plugins enable <name>`, or as a local stdio MCP server. Both work offline.
- Catalog installs (`hermes plugins install`) and lazy installs need network access (GitHub/PyPI). Offline machines need plugins pre-installed. Set `security.allow_lazy_installs: false` to avoid surprise network fetches.
- `ctx.llm.complete` uses the user's active model, so plugins that need LLM calls work with a local model.

### Gaps
- I did not verify shell-hook config syntax details (the `hooks:` block schema) or the outbound webhook signing scheme.
- I did not verify the exact plugin.yaml schema beyond `name`/`version`/`description`/`provides_tools`/`provides_hooks`/`requires_env`.

---

## 7. Security model around tool execution

### Takeaway
Hermes has eight layers of defense:
- user authorization (allowlists/pairing)
- dangerous-command approval (`approvals.mode: smart|manual|off`, where smart uses an auxiliary LLM, which by default is the main/local model)
- an always-on hardline blocklist below YOLO
- a file-write denylist plus optional `HERMES_WRITE_SAFE_ROOT`
- container isolation via the docker/modal/daytona/singularity/bubblewrap backends
- MCP env filtering
- prompt-injection scanning of context files
- cross-session isolation and input sanitization

On top of these: secret redaction (`security.redact_secrets: true` by default), SSRF and website access policies, and a restricted default toolset for webhooks. YOLO (`--yolo`, `/yolo`, `HERMES_YOLO_MODE=1`, or `approvals.mode: off`) bypasses prompts but never the hardline blocklist.

### Cited Findings
- "The security model has eight layers: 1. User authorization ... 2. Dangerous command approval ... 3. File write safety ... 4. Container isolation — Docker/Modal (and the Singularity plugin) ... 5. MCP credential filtering ... 6. Context file scanning — prompt injection detection in project files 7. Cross-session isolation ... 8. Input sanitization" — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- Approval config:
  - `approvals.mode: smart` (default) | `manual` | `off`
  - `timeout: 300`
  - `cron_mode: deny`, `single_query_mode: deny`, `unattended_mode: deny` (webhook, msgraph_webhook, api_server)
  - `mcp_reload_confirm`, `destructive_slash_confirm`, `discord_prompt_timeout`
  
  "smart (default) — Use an auxiliary LLM to assess risk. Low-risk commands ... are auto-approved ... Genuinely dangerous commands are auto-denied. Uncertain cases escalate to a manual prompt" — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security). The `approval` auxiliary task defaults to "auto / main model" — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- YOLO "bypasses all dangerous command approval prompts for the current session". Ways to turn it on: `hermes --yolo` / `hermes chat --yolo`, the `/yolo` toggle, or `HERMES_YOLO_MODE=1`. `/yolo` is saved with the session and survives restarts. A red banner and a `⚠ YOLO` status-bar marker show while it is on. It also skips the `trust: untrusted` MCP prompt, but MCP `spend_limit` still asks — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- The hardline blocklist (`tools/approval.py::UNRECOVERABLE_BLOCKLIST`) refuses these "regardless of --yolo / approvals.mode: off / cron approve / allow always":
  - `rm -rf /` variants and `--no-preserve-root`
  - fork bombs
  - `mkfs.*` on the root device
  - `dd if=/dev/zero of=/dev/sd*`
  - piping untrusted URLs to `sh` at rootfs top level
  
  It also fails closed on unparseable shell quoting ("malformed executable payload"). `approvals.deny` adds user-defined deny rules — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- Permanent allowlist: commands approved with "always" are saved to `config.yaml` under `command_allowlist:` (e.g. `- rm`, `- systemctl`) and silently approved afterwards. `hermes approvals suggest` mines approval history — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- `execute_code` scripts have their own approval section (#execute-code-scripts) — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- File write safety:
  - Writes are always blocked to `~/.ssh/`, `~/.aws/`, `~/.kube/`, `/etc/sudoers`, `~/.netrc`, and Hermes secret stores (`.env`, OAuth JSONs, `vault/`, `browser-profile/`, `mcp-tokens/`, `pairing/`).
  - Project `.env*`/`.envrc` files are read-denied but writable.
  - `~/.ssh/config` is approval-gated.
  - `HERMES_WRITE_SAFE_ROOT` (colon-separated) hard-restricts `write_file`/`patch`; it is set to `/opt/data` in the official Docker image.
  
  — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- Terminal backend comparison:
  - `local`: "None — runs on host", dangerous-command check ✅
  - `ssh`: ✅
  - `docker`: "❌ Skipped (container is boundary)"
  - singularity, sprites, modal, daytona, vercel_sandbox: ❌ Skipped
  
  Container hardening: "Read-only root filesystem (Docker); All Linux capabilities dropped; No privilege escalation; PID limits (256 processes); Full namespace isolation". The Docker backend uses "One persistent container, shared across the whole process" and `terminal.docker_forward_env` for an explicit env allowlist — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security); [Tools & Toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools)
- Bubblewrap plugin (Linux):
  - "every terminal and execute_code command runs in its own bwrap sandbox ... with a read-only root, a writable working directory (per profile: restricted, workspace or network), the dot entries of the home directory (credential stores always) and the Hermes home hidden ... per-command memory, CPU and process limits"
  - Configured with `hermes config set terminal.backend bubblewrap`
  - "Hermes keeps its dangerous-command prompts, as for the local backend"
  - Under the default `network` profile, commands share the host network
  
  — [plugin-catalog/bubblewrap.yaml](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/bubblewrap.yaml)
- Context file injection protection: "Context files (AGENTS.md, .cursorrules, SOUL.md) are scanned for prompt injection before being included in the system prompt". The scanner looks for ignore-instructions phrases, hidden HTML comments, secret-read attempts, curl exfiltration and invisible Unicode. Blocked files show `[BLOCKED: AGENTS.md contained potential prompt injection ...]`. The user's own `SOUL.md` in HERMES_HOME is warned about but still loaded. Profile-distribution SOUL.md files are still blocked. "These patterns are heuristics, not semantic intent detection" — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- Secret redaction: "`redact_secrets: true` # Redact API key patterns in tool output and logs (on by default)" — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration). MCP error messages redact `ghp_`, `sk-`, Bearer tokens and similar — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security). Cron deliveries are always redacted — [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron). TTS/STT command providers "run with Hermes secrets scrubbed from the child environment" — [TTS](https://hermes-agent.nousresearch.com/docs/user-guide/features/tts)
- Other sections on the security page: Environment Variable Passthrough, Credential File Passthrough, Website Access Policy, SSRF Protection, Content-Level Command Checks, Network Isolation, TLS trust, "Trusted-by-placement extension points", Supply-chain advisory checking, and Lazy install of optional dependencies. There is also an egress guide (iron-proxy, network isolation) — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security); [Egress / iron-proxy](https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy)
- `hermes curator lock` (v0.23.0) "stops the agent from rewriting a skill you curated by hand, through any tool, even in YOLO mode" — [GitHub Releases](https://github.com/NousResearch/hermes-agent/releases)

### Inferences
- With a local LLM, the default `smart` approval mode sends risk assessment to the local model. A weak local model may misjudge risk, so consider `approvals.mode: manual` on small models.
- Docker backends skip dangerous-command checks entirely because the container is treated as the boundary. Bubblewrap and local keep the checks. On a single-user local Linux box, bubblewrap gives sandboxing plus approval prompts with no cloud dependency.
- Messaging and API surfaces default to deny-by-default users and unattended `deny`. The main residual risks are prompt injection through web/MCP content and permissive `command_allowlist` entries.

### Gaps
- I did not read the SSRF/website access policy specifics (default blocked ranges, the `browser_url_policy` config keys) or the full `approvals.deny` rule syntax.
- I found no independent (third-party) security audit of these mechanisms. All claims come from Nous's own docs and code.
