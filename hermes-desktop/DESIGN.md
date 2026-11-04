# Talaria — design notes (working title)

A customizable AI chat desktop app in the spirit of Hermes-style clients. v1 covers
**streaming chat + history** and **provider/model switching + settings**. Everything
else is designed-for but not built.

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

1. **Themes** — all colors, radii, fonts, sidebar/thread widths are CSS variables in
   `styles.css`. A theme = a JSON map of variables applied to `:root`; ship presets +
   user-editable custom theme + accent picker.
2. **Providers** — add native adapters (Anthropic Messages, etc.) behind the same
   `streamChat` shape; provider `kind` field in `ProviderRecord`.
3. **Per-chat settings** — `Conversation.systemPrompt` is already honored by `chat.ts`; needs UI. Add presets ("personas").
4. **Storage → SQLite** — swap `store.ts`; unlocks full-text search over message bodies.
5. **Tools / agent loop** — new `src/main/tools/` with an approval-prompt IPC channel;
   tool calls become a new `Message` part type. MCP servers fit the same interface.
6. **Memory & skills** — stored beside conversations; injected by `chat.ts` when building the wire messages.
7. **Plugins/commands** — slash-command registry in the composer.

## Known limitations (v1)

- Text only: no attachments/images, no message editing/branching, no export.
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
