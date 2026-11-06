# Talaria

A customizable AI chat desktop app (working title). Streaming chat with history, any OpenAI-compatible
provider (preset: [9router](https://github.com/decolua/9router)), file/shell/web tools **with approvals**, MCP servers,
memory, skills and themes — plus message editing with branches, full-text search, export, image attachments, model-written chat titles, and automatic context management (long chats are summarized as they approach the model's limit; `/compact` does it on demand). See [DESIGN.md](DESIGN.md) for architecture and decisions.

## Install

Download the installer for your OS from the project's GitHub **Releases** (or build it yourself, below).

| OS | File | Notes |
|---|---|---|
| **Windows** 10/11 x64 | `Talaria-<v>-win-x64.exe` (installer) or `.zip` (portable) | Unsigned builds show a SmartScreen warning: **More info → Run anyway**. |
| **macOS** 12+ (Intel & Apple silicon) | `Talaria-<v>-mac-<arch>.dmg` or `.zip` | Unsigned builds are blocked by Gatekeeper: right-click the app → **Open**, or run `xattr -dr com.apple.quarantine /Applications/Talaria.app`. |
| **Linux** x64 | `.AppImage`, `.deb`, or `.tar.gz` | AppImage: `chmod +x Talaria-*.AppImage && ./Talaria-*.AppImage`. Debian/Ubuntu: `sudo apt install ./Talaria-*.deb`. |

First launch: **Settings → Providers**.
- **Claude:** **＋ Add Claude**, paste your Anthropic API key, **Test connection**, pick a model (default `claude-opus-5-5`).
- **Anything OpenAI-compatible** (9router, Ollama, OpenRouter…): set the base URL (default `http://localhost:20128/v1`), key, **Test connection**, pick a model.

### Where your data lives
Chats, settings, memory, skills and attached images are plain files in the app's data folder (also reachable from **Settings → General →
Open data folder**). **Uninstalling never deletes them.**

| OS | Folder |
|---|---|
| Linux | `~/.config/Talaria` |
| macOS | `~/Library/Application Support/Talaria` |
| Windows | `%APPDATA%\Talaria` |

### Troubleshooting
- **Linux: AppImage won't start / "setuid sandbox" error** (common on Ubuntu 24.04+, where unprivileged user namespaces are
  restricted). Either install the `.deb` (its post-install step sets up the sandbox), or run
  `./Talaria-*.AppImage --no-sandbox` (weaker isolation of the browser engine), or allow user namespaces for the AppImage via AppArmor.
- **An MCP server fails with "command not found" (`npx`, `uvx`…)** when the app is started from the Dock/Start menu: GUI apps
  don't inherit your terminal's `PATH`. Use the command's absolute path (e.g. `/opt/homebrew/bin/npx`), or start Talaria from a terminal.
- **Remote MCP server says “Sign-in required”:** press **Sign in** (Settings → MCP). If a browser can't reach `127.0.0.1:33418`, check for a local firewall; if the server has no automatic app registration, add its Client ID under *OAuth settings (advanced)*.
- **Report a problem:** **Settings → General → Copy diagnostics** gives version/OS info to paste into an issue.

## Build from source

```bash
cd hermes-desktop
npm ci
npm run dev            # hot-reload development app
npm run typecheck && npm test
npm run pack           # unpacked app in release/<os>-unpacked (fast; good for a smoke test)
npm run dist           # installers for THIS OS in release/
npm run dist:linux     # AppImage + deb + tar.gz
npm run dist:win       # NSIS installer + zip  (build on Windows — the installer needs wine elsewhere)
npm run dist:mac       # dmg + zip, x64 + arm64 (build on macOS)
npm run icons          # re-render build/icon.png from build/icon.svg
```

`dist*` scripts run the build and **`verify:bundle`** first (fails if the compiled app requires a module that isn't shipped).
Output names: `Talaria-<version>-<os>-<arch>.<ext>`. Build switches (env vars) are documented at the top of
`electron-builder.config.cjs`.

## Releasing

1. Bump `version` in `package.json`, commit.
2. Tag and push: `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`.
3. The **Talaria desktop** workflow tests, builds installers on Linux/Windows/macOS runners and creates a **draft** GitHub
   release with all of them attached. Review it, then publish.

**Signing (optional, recommended before sharing widely).** Without certificates the installers are unsigned (see warnings
above). Add repository secrets and the workflow picks them up automatically:
macOS `CSC_LINK` (base64 Developer ID `.p12`), `CSC_KEY_PASSWORD`, and notarization `APPLE_API_KEY` / `APPLE_API_KEY_ID` /
`APPLE_API_ISSUER` (or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`); Windows `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.
