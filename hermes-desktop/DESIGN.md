# Talaria — design notes (working title)

A customizable AI chat desktop app in the spirit of Hermes-style clients. Covers
**streaming chat + history**, **provider/model switching + settings**, and **tool use**
(files, shell, web) with approvals, **MCP servers** as an extension point for more tools, **theming**, **memory + skills**, and cross-platform **packaging**.

> Rename the app in one place: `APP_NAME` in `src/shared/types.ts` (+ `productName` in `package.json`).

## Decisions

| Question | Decision | Why |
|---|---|---|
| Desktop framework | **Electron** + React + TypeScript + Vite (`electron-vite`) | "Most reliable": bundled Chromium renders identically on every OS. Tauri uses the system webview (WebKitGTK on Linux is the weak spot). Cost: ~100 MB installer. |
| Providers | **Two kinds**: generic **OpenAI-compatible** (`/chat/completions` + `/models`; preset 9router at `http://localhost:20128/v1`) and the native **Anthropic Messages API** (official `@anthropic-ai/sdk`) | 9router, Ollama, OpenRouter, vLLM, LM Studio all speak the first. Claude gets its own adapter for features the OpenAI shape can't carry: thinking blocks, prompt caching, effort, refusal handling. A conversation can switch providers mid-way. |
| Persistence | JSON files in the OS user-data dir (`settings.json`, `conversations/<id>.json`), atomic writes | Zero native deps (no `better-sqlite3` rebuild pain). Hidden behind `src/main/store.ts` so SQLite can replace it when we need search/memory. |
| State (UI) | Zustand | Small; chat streaming is a stream of tiny updates. |
| Styling | Plain CSS with design tokens (`:root` variables) | Theming/customization = swapping variables. No CSS-framework lock-in. |

## Architecture

```
┌────────────── Renderer (React, sandboxed, no Node) ──────────────┐
│ Sidebar · ChatView · Composer · ModelPicker · SettingsModal      │
│ zustand store  ──────────────►  window.api  (typed, preload)     │
└──────────────────────────────────────┬───────────────────────────┘
                         contextBridge │ IPC (invoke + 'chat:event')
┌──────────────────────────────────────▼───────────────────────────┐
│ Main process                                                     │
│  index.ts   window, IPC registration, navigation lockdown        │
│  chat.ts    send / regenerate / stop, per-conversation abort     │
│  openai.ts  SSE streaming client + /models (pure, unit-tested)   │
│  store.ts   settings, providers, conversations, key encryption   │
└──────────────────────────────────────────────────────────────────┘
```

**Why the main process owns the network and the data.** The renderer never sees API
keys (it only gets `hasKey`), never makes cross-origin requests (CSP is
`connect-src 'none'` in production), and cannot touch the filesystem. This is also
where tools/agents will live later, with the same trust boundary.

### Streaming flow
1. Renderer `chat.send({conversationId, content, providerId, model})`.
2. Main appends the user message, creates an empty assistant message, persists, and
   emits `start`; it then streams from the provider and emits `delta` events.
3. Partial text is checkpointed to disk every ~1.5 s; `done`/`error` persist the final state.
4. **Stop** aborts the request; the partial text is kept, no error shown.
5. Errors (server down, 401, mid-stream provider error) are stored on the message and
   shown inline with **Retry**.

### Data model (`src/shared/types.ts`)
`Conversation { id, title, messages[], providerId?, model?, systemPrompt? }` ·
`Message { id, role, content, model?, error? }` · `Provider { id, name, baseUrl, defaultModel, hasKey }` ·
`Settings { providers[], activeProviderId, systemPrompt, temperature, theme }`.

### Security posture
`contextIsolation`, `sandbox`, no `nodeIntegration`; window cannot navigate (external
links open in the OS browser, http/https only); strict CSP in production builds; API
keys encrypted with Electron `safeStorage` (OS keychain) — if no keychain exists
(some Linux setups) they fall back to plaintext in an owner-only (`0600`) file and the
Settings UI says so.

## Tool use

The model can call tools via OpenAI-style function calling and chain several rounds
(capped at 20 steps per message; **Stop** cancels everything, including a running command).

| Tool | Risk | Default | Notes |
|---|---|---|---|
| `read_file`, `list_dir` | read | auto inside workspace | Anything outside the workspace (incl. symlink escapes) **always asks** |
| `write_file`, `edit_file` | write | ask | Workspace-only; outside paths are refused *before* any prompt. `edit_file` needs a unique match |
| `run_command` | exec | ask | Shell in the workspace, 60 s default / 300 s max timeout, kills the whole process tree, output truncated. **Not sandboxed** |
| `web_fetch` | network | ask | http(s) GET, HTML → text, 20 s timeout, ~2 MB cap |

**Approval UX.** A pending call renders as a card in the thread showing exactly what will
happen (the command, the file + content, an old/new diff, the URL) with **Allow once /
Allow for this chat / Deny**. "Allow for this chat" is in-memory only (resets on restart).
Per-tool policy (*ask / always allow / disabled*), the master switch and the workspace
folder live in **Settings → Tools**; the composer chip shows the active workspace.

**Data model.** An assistant `Message` carries `toolCalls[]` (`id, name, arguments, status,
result`); each model turn is its own assistant message, so a tool round is
`assistant(tool_calls) → results → assistant(final text)`. `toWire()` expands this to the
provider format and gives any interrupted call a synthetic result so history never becomes
invalid after a Stop or crash. Regenerate drops everything after the last user message.

**Safety notes.** Tool output is framed to the model as data, not instructions (system note),
but prompt injection from files/web pages is a real risk — that's why web fetches and
commands ask by default and the Settings page warns about "Always allow". Tool code lives in
`src/main/tools/` and has no Electron dependency (unit-tested in plain Node).

## MCP (Model Context Protocol)

Servers are configured in **Settings → MCP** and their tools join the built-ins in the same
agent loop, the same approval cards and the same policy system. Uses the official
`@modelcontextprotocol/sdk` client in the main process.

- **Transports:** local command (stdio), Streamable HTTP, and legacy SSE. Servers connect in the
  background at launch; the first chat message waits up to 4 s for ones still starting.
- **Add servers** by form, or **Import JSON** — paste the `{ "mcpServers": {…} }` block from any
  server README (Claude Desktop / Cursor format). Import shows a preview and per-entry errors first.
- **Naming:** the model sees `server__tool` (sanitized to `[a-zA-Z0-9_-]`, ≤64 chars, unique across
  servers). Schemas are passed through (repaired to a top-level object if missing).
- **Permissions:** default is *ask* for every MCP tool. Each server has a default policy and each tool can
  override it (*server default / ask / always allow / disabled*). The master switch in Tools gates MCP
  as well. Approval cards show the server, the exact arguments, and an "external MCP tool" notice —
  MCP tools run in the server's process with *its* permissions, outside the workspace sandbox rules.
- **Secrets:** env vars (stdio) and headers (HTTP/SSE) are stored via the same `safeStorage` path as API
  keys and are write-only in the UI — the renderer only ever receives key *names*.
- **Lifecycle:** `tools/list_changed` is honored live; per-server status (connecting / connected / error
  with the server's own stderr) streams to the UI; children are killed on disable, remove, restart and
  quit. Tool calls time out at 120 s and are cancelled by **Stop**.
- **Results:** text is passed through (≤30 k chars); `isError` results show as failed cards; images/audio
  are described, not displayed.

Code: `src/main/mcp/` (`manager.ts` connections + ToolImpl adapter, `util.ts` pure helpers),
`src/renderer/src/components/McpSettings.tsx`. Tests use a real SDK-based fixture server over stdio and HTTP.

## Claude (native Anthropic provider)

Settings → Providers → **＋ Add Claude** (or Type → *Claude*). Code: `src/main/anthropic.ts` (client, streaming, history conversion),
`src/shared/anthropic.ts` (options, gating). Everything else — tools, MCP, memory, skills, approvals — works unchanged.

- **Streaming + tools:** `messages.stream`; text and *reasoning-summary* deltas stream to the UI; tool calls use the same approval-gated loop
  (`tool_use` → `tool_result` blocks in **one** user message).
- **Faithful replay (preserved thinking):** the API checks that earlier turns weren't edited and thinking blocks carry signatures. Each assistant
  turn's **raw content blocks are stored in the conversation file and replayed verbatim** (`Message.raw`), never rebuilt from text. Failed, partial
  or refused turns are skipped. History from another provider is converted (and Claude-only blocks never leak out).
- **Request shape (per the current API):** `system` + top-level automatic **prompt caching**; **no `temperature`/`top_p`/`top_k`** (newer models
  reject them — the temperature slider only affects OpenAI-compatible providers); `max_tokens = min(64 000, model limit)` from the **Models API**
  (cached); optional **effort** (`output_config.effort`) and **reasoning summaries** (`thinking: adaptive, display: summarized`) — both skipped when
  the model's capabilities say it doesn't support them; model list in the API's own order (newest first).
- **Refusals:** `stop_reason: "refusal"` is shown as a clear message with its category and isn't replayed. **Server-side refusal fallback**
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) is on by default **only** for the official API URL and the models that support it
  (Fable/Mythos 5.x, Opus 5.x, Sonnet 5.5); a reply produced by the fallback shows "↪ answered by <model>". If an account rejects the beta
  with a 400 mentioning it, the request is retried once without it.
- **Errors & auth:** typed SDK errors → plain messages (401 key, 403, 404 model, 429, 529 overloaded, unreachable, output-limit during a tool
  call, context window exceeded). The key lives encrypted in the main process like every other provider key; leaving it blank falls back to the
  SDK's own resolution (`ANTHROPIC_API_KEY`, etc.).
- **Usage:** each answer shows input/output/cached token counts.
- **Not done:** `eager_input_streaming` for tools (we don't render tool input as it streams, so it adds nothing), batches, files/citations, server
  tools (web search/code execution), vision input, `thinking` budgets for pre-4.6 models (Haiku 4.5: reasoning summaries won't work there),
  Bedrock/Vertex/Foundry clients (use the OpenAI-compatible kind with a gateway, or a custom API URL).
- **Verified:** 33 unit tests against the real SDK talking to a local fake of the API (headers, bodies, SSE, errors, abort, fallback + retry) and
  an end-to-end run in the real app. **Not verified against the live Anthropic API** (no key in the build environment) — the first real call is the
  remaining check, especially the fallback beta and capability fields.

## Memory & skills

### Memory — durable notes across chats
- **What:** short one-line notes (≤500 chars, ≤200 total) in `memory.json` (owner-only file). Each has a source
  (*you* / *model*) and a scope (*all chats* or *this project* = bound to the workspace folder).
- **How the model sees them:** a `## Memory` section in the system prompt, newest first, ids included, within a
  6 000-char budget (the UI warns if older notes don't fit). Framed as *notes, not commands*; newlines are
  collapsed so a note can't forge prompt structure.
- **Writing:** you (Settings → Memory, or `/remember …` in the composer — instant, no model call) or the model via
  `remember` / `forget`. **Model writes ask for approval by default**, and the card shows the exact text — a web page
  or file the model read must not be able to plant persistent instructions silently. Secret-looking text
  (API keys, tokens, `password: …`) is refused *before* any prompt, for both you and the model, because the file is
  unencrypted. Exact duplicates (ignoring case/punctuation) aren't stored twice.
- **Robustness:** writes are serialized (UI and tools can't lose each other's updates), saves are atomic, and an
  unreadable `memory.json` is moved aside, never silently overwritten.

### Skills — reusable instructions (open `SKILL.md` format)
- **Format:** a folder with `SKILL.md` (YAML header `name` + `description`, markdown body) and optional bundled files.
  Existing skills from other tools work as-is; unknown header keys survive edits.
- **Progressive disclosure:** only a short catalog (name + description) is in the prompt. The model calls
  `use_skill` to load the full text when a task matches, and `read_skill_file` for bundled files (confined to the skill
  folder, symlink-aware). You can also invoke one directly: `/skill-name <input>` — the instructions are
  snapshotted into that message, so history stays reproducible and it works with tools off.
- **Sources:** *yours* (`<userData>/skills`), *created by AI* (`create_skill`, **asks for approval** and shows the full
  instructions; tagged in the header), and *from this project* (`.talaria/skills`, `.claude/skills` in the workspace).
- **Project skills are untrusted by default.** A cloned repo could ship instructions aimed at your model, so they stay
  **off** until you review and enable them, and approval is **bound to a content hash** (SKILL.md + file list): if the
  repo changes the skill, it drops out of the prompt immediately and the UI says "changed since you enabled it".
  Symlinks inside workspace skill folders are ignored.
- **UI:** Settings → Skills (create/edit/rename/delete, import a folder, open the folder, view instructions, per-skill
  toggle) and a `/` menu in the composer (↑↓ Tab/Enter, Esc). Composer chips show 🧠 notes and ⚡ skills in use.
- **Limits:** names `[a-z0-9-]`, description ≤1 024, body ≤50 000, SKILL.md ≤200 KB, imports ≤5 MB / 200 files.

Code: `src/shared/{memory,skills}.ts` (pure helpers/prompt formatting), `src/main/memory.ts`,
`src/main/skills/{parse,registry}.ts`, `src/main/tools/{memoryTools,skillTools}.ts`, UI in
`MemorySettings.tsx` / `SkillsSettings.tsx` / `Composer.tsx`. Tools appear in Settings → Tools so each can be set to
ask / always allow / disabled.

## Packaging

`electron-builder` (config: `electron-builder.config.cjs`, always passed with `--config` — the builder ignores that filename on its own).
Linux: AppImage + deb + tar.gz · Windows: NSIS installer + zip · macOS: dmg + zip (x64 + arm64). Details in [README.md](README.md).

- **What ships:** only `out/` (the Vite/electron-vite output) in an `app.asar` (~14 MB) + the Electron runtime. Renderer libraries
  (React, markdown, highlight.js…) are bundled by Vite and therefore live in `devDependencies`; the only runtime `dependencies` are the
  ones the main process loads from `node_modules` at run time (`@modelcontextprotocol/sdk`, `yaml`, `zod`). A test enforces this split and
  `scripts/verify-bundle.mjs` (run before every `dist`) fails the build if the compiled main/preload requires something that isn't shipped.
- **Hardening (Electron fuses):** `RunAsNode`, `NODE_OPTIONS` and `--inspect` are disabled in the shipped binary, cookies are encrypted,
  and only the asar is loaded — the app can't be repurposed as a generic Node runtime. (`TALARIA_UNFUSED=1` builds a test variant that
  Playwright can attach to.)
- **Identity:** `APP_ID`/`APP_NAME` in `src/shared/types.ts` ↔ `appId`/`productName` in the builder config (a test keeps them in sync);
  Windows AppUserModelID is set for taskbar grouping; `desktopName` links Linux windows to their launcher; icons are rendered from
  `build/icon.svg` (pure-JS resvg) and the builder derives `.ico`/`.icns`.
- **Data safety:** uninstall never deletes the data folder (`deleteAppDataOnUninstall: false`). About/diagnostics in Settings → General.
- **CI:** `.github/workflows/desktop.yml` — typecheck/test/build on every change; installers on Windows/macOS/Linux runners for tags
  `desktop-v*` (or manual runs) → draft release. Signing/notarization activate when the secrets exist (listed in the README).
- **Verified here (Linux):** production AppImage/deb/tar.gz build; fuse state inspected in the binary; hardened AppImage and unpacked build
  launch and render; all end-to-end suites pass against the packaged (unfused) build.
- **Not verified here:** Windows NSIS installer (needs wine off-Windows; the zip and exe layout were built), macOS dmg/signing/notarization
  (only an unsigned `.app` directory was built), and the CI workflow itself (can't run Actions from this environment).
- **Not done:** auto-update (needs signed builds on macOS and a publish channel — `publish` is `null` on purpose), Windows ARM / Linux ARM
  targets, a Linux `.rpm`, Flatpak/Snap/winget/Homebrew distribution.

## Theming

**Settings → Appearance.** Everything visual is a CSS variable set on `:root` by one pure function,
`resolveAppearance()` in `src/shared/theme.ts` (shared by the renderer, the main process and tests).

- **Mode:** System / Light / Dark. Each mode has its own theme slot, so *System* flips between your chosen
  light and dark themes live when the OS changes.
- **11 built-in themes** (6 dark, 5 light, incl. two High Contrast). A unit test enforces WCAG contrast on every
  preset (text 7:1, muted/accent/status 4.5:1, code, syntax colours).
- **Accent override** over any theme; the text-on-accent colour is recomputed for readability.
- **Typography & shape:** UI font (4 stacks + custom), code font, text size 85–135 % (every text size
  scales, not just the base), corner roundness, chat width.
- **Custom themes:** *Customize* any preset or *New theme* → editor with 18 colours, **live preview across the
  whole app**, a readability panel (advisory), Save/Cancel/Revert. **Export/Import** as JSON
  (`{"talariaTheme":1,"name","base","colors"}`) to share themes; imports are validated and open in the
  editor for review first.
- **No flash:** the window stays hidden until the renderer has applied the saved theme (2.5 s failsafe), and
  its native background colour is set from the theme in the main process (also updated on change).
- **Safety:** all appearance data is re-validated on every load and on every update (`sanitizeAppearance`):
  hex-only colours, font names stripped of CSS metacharacters, ids/sizes/counts clamped, deleted themes can't
  leave dangling selections. A hand-edited or hostile `settings.json` can't inject CSS or crash startup.

Adding a preset = one entry in `PRESETS`; adding a new themable token = one key in `ThemeColors` + `CSS_VAR`.

## UI

- **Layout:** left sidebar (new chat, search, history grouped Today/Yesterday/7 days/Older,
  inline rename on double-click, delete) · main thread (max-width 780px) · composer
  with inline model picker and Send/Stop.
- **Messages:** Markdown (GFM tables, lists), syntax-highlighted code blocks with Copy,
  per-message Copy / Regenerate, streaming caret, "thinking" dots before first token.
- **Model picker:** provider switch + searchable list from `/models`; you can also type
  any model id (9router uses ids like `cc/claude-opus-4-7`). The last pick becomes the
  default for new chats.
- **Settings:** Providers (name, base URL, key, default model, *Test connection*) and
  General (theme system/dark/light, global system prompt, temperature).
- **Shortcuts:** `Ctrl/Cmd+N` new chat · `Ctrl/Cmd+,` settings · `Enter` send · `Shift+Enter` newline.

## Customization roadmap (designed-for, not built)

The seams already exist so these are additive:

1. **Themes** — done (see Theming). Possible next: per-chat/per-provider accent, wallpapers, message-bubble styles, density.
2. **Providers** — add native adapters (Anthropic Messages, etc.) behind the same
   `streamChat` shape; provider `kind` field in `ProviderRecord`.
3. **Per-chat settings** — `Conversation.systemPrompt` is already honored by `chat.ts`; needs UI. Add presets ("personas").
4. **Storage → SQLite** — swap `store.ts`; unlocks full-text search over message bodies.
5. **More tools** — add a `ToolImpl` to `src/main/tools/` + a row in `shared/toolMeta.ts`, or just connect an MCP server (done).
   Also: MCP OAuth, resources/prompts, per-conversation workspace, command allow/deny patterns, background processes.
6. **Memory & skills** — done (see above). Possible next: semantic recall for large memories, automatic end-of-chat memory suggestions (with approval), skill sharing/export, per-conversation skill sets.
7. **Plugins/commands** — slash-command registry in the composer.

## Known limitations (v1)

- Text only: no attachments/images, no message editing/branching, no export.
- MCP: tools only (no resources, prompts, sampling or elicitation); no OAuth sign-in for remote servers
  (use servers that take a token header); server `instructions` aren't forwarded to the model; images
  aren't rendered; local servers keep the working directory they started with (restart after changing
  workspace). When the app is launched from the macOS Dock/Windows Start menu, `PATH` may lack tools like
  `npx`/`uvx` that a terminal has — use an absolute path to the command if a server fails to start.
- Memory & skills: all enabled notes are injected (no relevance ranking/embeddings), so keep notes short; the model only saves memories when it decides to (no background extraction); `allowed-tools`/`license` header keys are preserved but not enforced; skill scripts run only through `run_command` (with its approvals), never automatically; slash commands take free text, not structured arguments; no skill marketplace/sync.
- Theming: fonts must already be installed (none are bundled); sidebar width and spacing aren't themable yet; no scheduled (time-of-day) theme switching.
- Tools: one global workspace; shell commands are unsandboxed; no output streaming from long commands (result appears when it finishes); parallel tool calls run sequentially; models without tool-calling support need Tools switched off.
- No context-window management — the full history is sent each turn.
- Reasoning/"thinking" deltas from providers (e.g. `reasoning_content`) are ignored, not shown.
- Conversation titles are the first user message (truncated), not model-generated.
- Not yet packaged/code-signed (`npm run dist` uses electron-builder defaults, untested). Tested on Linux only (Xvfb); macOS/Windows untested.
- The renderer bundle is ~1.5 MB (all highlight.js languages) — fine for desktop, trimmable later.

## Dev

```bash
cd hermes-desktop
npm install          # downloads the Electron binary (~100 MB)
npm run dev          # hot-reload dev app
npm run typecheck && npm test
npm run build && npm start
```

On first launch, open Settings → Providers → set the base URL (defaults to 9router's
`http://localhost:20128/v1`), paste your key, **Test connection**, pick a default model.
