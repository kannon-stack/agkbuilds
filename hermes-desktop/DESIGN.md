# Talaria — design notes (working title)

A customizable AI chat desktop app in the spirit of Hermes-style clients. Covers
**streaming chat + history**, **provider/model switching + settings**, and **tool use**
(files, shell, web) with approvals, **MCP servers** as an extension point for more tools, and **theming**. Memory/skills are designed-for but not built.

> Rename the app in one place: `APP_NAME` in `src/shared/types.ts` (+ `productName` in `package.json`).

## Decisions

| Question | Decision | Why |
|---|---|---|
| Desktop framework | **Electron** + React + TypeScript + Vite (`electron-vite`) | "Most reliable": bundled Chromium renders identically on every OS. Tauri uses the system webview (WebKitGTK on Linux is the weak spot). Cost: ~100 MB installer. |
| v1 backend | **One generic OpenAI-compatible provider** (`/chat/completions` + `/models`), preset to 9router at `http://localhost:20128/v1` | 9router, Ollama, OpenRouter, vLLM, LM Studio all speak this. A "permanent" backend later = another provider entry, not a rewrite. |
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
6. **Memory & skills** — stored beside conversations; injected by `chat.ts` when building the wire messages.
7. **Plugins/commands** — slash-command registry in the composer.

## Known limitations (v1)

- Text only: no attachments/images, no message editing/branching, no export.
- MCP: tools only (no resources, prompts, sampling or elicitation); no OAuth sign-in for remote servers
  (use servers that take a token header); server `instructions` aren't forwarded to the model; images
  aren't rendered; local servers keep the working directory they started with (restart after changing
  workspace). When the app is launched from the macOS Dock/Windows Start menu, `PATH` may lack tools like
  `npx`/`uvx` that a terminal has — use an absolute path to the command if a server fails to start.
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
