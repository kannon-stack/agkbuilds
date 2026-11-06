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
`Conversation { id, title, messages[], leafId?, rootChild?, providerId?, model?, systemPrompt? }` ·
`Message { id, parentId, activeChild?, role, content, attachments?, model?, error? }` (see *Chat polish*) · `Provider { id, name, baseUrl, defaultModel, hasKey }` ·
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

### MCP OAuth (remote servers)
Remote (HTTP/SSE) servers that need a sign-in show **Sign-in required** with a **Sign in** button — no token to paste. Uses the SDK's OAuth 2.1
client (protected-resource + authorization-server discovery, dynamic client registration, PKCE S256, `resource` indicator); our part is the
provider in `src/main/mcp/oauth.ts` and the lifecycle in `manager.ts`.

- **Nothing happens until you click.** A server only gets an OAuth provider when it already has stored tokens (silent refresh) or you pressed
  **Sign in**. A bare 401 at launch is just the "Sign-in required" state: no browser window, no client registration at the server. Once signed in,
  the provider is switched to background-only, so a failed refresh later can *never* pop a browser by itself — the card goes back to
  "Sign-in required" and a tool call says "sign in again".
- **Browser round-trip:** system browser → `http://127.0.0.1:33418/callback` (RFC 8252 loopback; another free port only if that one is busy, with
  automatic re-registration). The listener exists only while a sign-in is pending, binds 127.0.0.1 only, serves only `GET /callback`, accepts
  each random `state` **once** (forged/replayed/unknown states get 400 and don't disturb the real flow), times out after 5 min, and can be
  cancelled. Its pages escape all text and set a strict CSP.
- **Safety checks:** authorization pages must be `https` (or loopback `http`); `file:`, `javascript:`, non-loopback `http` are refused before
  anything opens. The UI shows the host you're approving. The PKCE verifier lives in memory only.
- **Token storage:** `mcp-oauth.json` (0600): client registration + tokens encrypted via the OS keychain (`safeStorage`, same path as API
  keys; plaintext fallback with a private file where no keychain exists). The renderer only ever sees `signedIn: true`. **Sign out** and
  **removing the server** delete the stored credentials.
- **Refresh:** access tokens are refreshed in the background by the SDK (rotating refresh tokens supported) while a connection is live and on the
  next launch.
- **Servers without automatic registration:** *Edit → OAuth settings (advanced)*: Client ID, optional secret (write-only), optional scope, with
  the redirect URI to register shown. Without them such a server gives a clear error that says exactly this.
- **Tested** against a fake OAuth-protected MCP server (discovery, registration, PKCE verification, single-use codes, rotating refresh,
  expiry, deny, revoked refresh) with the real SDK, plus an end-to-end run in the app. **Not tested** against a real hosted MCP provider.
  Not supported: client-credentials/enterprise-managed flows, URL-based client IDs (CIMD), step-up re-authorization for new scopes.

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

## Chat polish

### Branching (edit & regenerate)
A conversation is a **tree**: `Conversation.messages` holds every node of every branch; each `Message` has `parentId`
(`null` = first message) and `activeChild` (which child the view follows at a fork; `Conversation.rootChild` for the first
message). The chat on screen is the path root → `leafId` (`shared/tree.ts`: `pathOf`, `siblingInfo`, `switchTo`, `setLeaf` — all
pure and cycle-safe).
- **Edit** a user message → a *sibling* user message under the same parent, answered immediately; the original and its replies stay as
  another branch. **Regenerate** → a new sibling of the answer; a failed, empty answer is replaced rather than piled up.
- A `‹ n/m ›` switcher on any message with siblings flips branches (each fork remembers the branch you last viewed).
  Switching is disabled while a response streams. Tool rounds chain as assistant → assistant children, so they stay inside one branch.
- Pure edit rules live in `main/conversationOps.ts` (unit-tested); `chat.ts` only orchestrates I/O and streaming. The provider history
  for a turn is `pathTo(conv, assistant.parentId)`, so other branches never leak into requests.
- **Migration:** files without `parentId` are linear — `normalizeTree` links each message to the previous one on load (also repairs
  dangling parents/pointers from hand-edited files). Nothing is rewritten until the next save.

### Search
`shared/search.ts` is a pure scan over every message of every branch (plus titles, attachment names and tool-call summaries):
all terms must appear somewhere in the chat (quoted phrases supported), ranked title-match first then recency, ≤30 chats,
≤3 snippets each with `<mark>` highlights. `store.loadAllConversations` caches parsed chats by mtime+size so each keystroke
(120 ms debounce) only re-reads files that changed. Clicking a hit opens the chat, switches to the right branch if the hit is on an
inactive one (`conversations:reveal`, which doesn't count as activity), and flashes the message. No index/SQLite yet —
a linear scan is instant for thousands of chats; revisit if that stops being true.

### Export
Header **⋯** menu: *Copy as Markdown*, *Save as Markdown…* (visible branch; title/model/date, tool calls summarized with results
cut at 2 000 chars, reasoning omitted, `[image: name]` for attachments, fences that can't be broken out of) and *Save as JSON*
(all branches, minus provider-internal `raw` blocks). Files are written by the main process after a native save dialog.

### Image attachments
Paste, drag-drop or 📎 (≤6 per message, ≤5 MB each; PNG/JPEG/GIF/WebP). The renderer downscales big images (long edge > 2048 px or > 1.5 MB;
never GIFs). The main process (`main/attachments.ts`) **detects the type from magic bytes** (name/MIME are never trusted; SVG is
refused), stores `<sha256>.<ext>` in `userData/attachments/` (content-addressed → duplicates are free) and later re-verifies every
descriptor the renderer sends against the file on disk. Messages store only `{id,name,mime,size}`; the renderer receives pixels as
data URLs over IPC, never paths (so the strict `img-src 'self' data:` CSP is unchanged). On the wire: OpenAI-style `image_url` data-URL
parts / Claude base64 `image` blocks, before the text; a file that has gone missing becomes `[image unavailable: name]`. Unreferenced
files older than an hour are deleted at startup and after a chat is deleted — and never if any chat file couldn't be read.
Images are re-sent with every turn (no context management yet), so long image-heavy chats cost tokens; the model must support vision.

### Scroll-to-latest
A floating ↓ button appears whenever you've scrolled away from the bottom (e.g. while a long answer streams) and jumps back.

## Context management

Goal: long chats keep working instead of failing at the model's limit, without the user babysitting them. Everything below is
about what is *sent*; the full chat always stays visible and stored.

- **Window detection** (`shared/context.ts: windowFor`): Settings override → learned from a "maximum context length is N" error →
  the provider's Models API (Claude `max_input_tokens`) → a name table (claude/gpt-5/gemini/llama/…, router prefixes like `cc/` are fine) → 128k.
- **Estimation:** ~3.6 chars/token (CJK 1/char), flat 1 200 per image, plus tool-call args/results. The composer's **meter** anchors on the
  provider's own `usage` from the last answer (Claude always; OpenAI-compatible servers that send `usage` in the stream) and adds an
  estimate for anything newer, so it self-corrects.
- **Compaction = a summary stored on a message.** `Message.compaction` on message *M* means "everything up to and including *M* is
  replaced by this text" for requests. It lives in the tree, so it is branch-aware: editing/regenerating before *M* branches away from
  the summary automatically; switching back restores it. Cuts are always right before a user turn (kept tail starts with a user message,
  tool calls never lose their results). The summary is injected into the **system prompt**, not as a fake message, so role alternation
  rules never matter. A later compaction folds the earlier summary in (`<previous_summary>`), and very long histories are summarized in
  several passes that each fit the window (`main/summarize.ts`, same provider/model as the chat, no tools).
- **When:** automatically before a request once the estimate passes `min(window × threshold, send budget)` (default 80 %, keeping the last
  2 turns verbatim); on demand with `/compact [focus text]` or the meter's *Compact now* (keeps the last turn); and as **overflow
  recovery** — if a provider still rejects the prompt as too long (`parseOverflow`), the limit is learned from the message if it states one,
  the history is compacted, and the step is retried once before surfacing a friendly error.
- **Fitting without summaries** (`fitToWindow`, used when auto-summarizing is off, fails, or isn't enough): shorten tool results (>1 500 chars)
  and drop images from turns older than the last two, then drop the oldest whole turns, always keeping the newest. A one-time notice says so.
- **Settings → General → Context:** auto on/off, threshold (50–95 %), window override. Stored as `settings.context`, validated on load.
- Limits: summaries are model-written (lossy by nature — view them via the divider); token counts are estimates unless the provider reports
  usage; only the active branch is considered; the summarizer uses the chat's own model/provider (cost); no per-provider window setting yet.

## Customization roadmap (designed-for, not built)

The seams already exist so these are additive:

1. **Themes** — done (see Theming). Possible next: per-chat/per-provider accent, wallpapers, message-bubble styles, density.
2. **Providers** — add native adapters (Anthropic Messages, etc.) behind the same
   `streamChat` shape; provider `kind` field in `ProviderRecord`.
3. **Per-chat settings** — `Conversation.systemPrompt` is already honored by `chat.ts`; needs UI. Add presets ("personas").
4. **Storage → SQLite** — swap `store.ts`; would add ranked/indexed search (substring scan works today).
5. **More tools** — add a `ToolImpl` to `src/main/tools/` + a row in `shared/toolMeta.ts`, or just connect an MCP server (done).
   Also: MCP OAuth, resources/prompts, per-conversation workspace, command allow/deny patterns, background processes.
6. **Memory & skills** — done (see above). Possible next: semantic recall for large memories, automatic end-of-chat memory suggestions (with approval), skill sharing/export, per-conversation skill sets.
7. **Plugins/commands** — slash-command registry in the composer.

## Known limitations (v1)

- Attachments are images only (no PDFs/text files/audio); edited messages keep their original images (can't swap them); search is a substring scan (no stemming/fuzzy); exports don't embed image bytes; branches can't be deleted or merged individually (delete the chat); no message-level pin/bookmark.
- MCP: tools only (no resources, prompts, sampling or elicitation); OAuth covers the interactive browser flow only; server `instructions` aren't forwarded to the model; images
  aren't rendered; local servers keep the working directory they started with (restart after changing
  workspace). When the app is launched from the macOS Dock/Windows Start menu, `PATH` may lack tools like
  `npx`/`uvx` that a terminal has — use an absolute path to the command if a server fails to start.
- Memory & skills: all enabled notes are injected (no relevance ranking/embeddings), so keep notes short; the model only saves memories when it decides to (no background extraction); `allowed-tools`/`license` header keys are preserved but not enforced; skill scripts run only through `run_command` (with its approvals), never automatically; slash commands take free text, not structured arguments; no skill marketplace/sync.
- Theming: fonts must already be installed (none are bundled); sidebar width and spacing aren't themable yet; no scheduled (time-of-day) theme switching.
- Tools: one global workspace; shell commands are unsandboxed; no output streaming from long commands (result appears when it finishes); parallel tool calls run sequentially; models without tool-calling support need Tools switched off.
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
