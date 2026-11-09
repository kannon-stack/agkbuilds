# Hermes Agent (Nous Research): installing, configuring and running it from the Linux CLI

Source basis: I read the docs as Markdown from a shallow clone of `github.com/NousResearch/hermes-agent` at `main` commit `21ae0e1` (committed 2026-11-07). The docs site is built from `website/docs/` in that repo. I spot-checked the live page https://hermes-agent.nousresearch.com/docs/getting-started/installation (Docusaurus 3.10.2, fetched 2026-11-08) and it matches the repo text word for word. Every docs URL below follows the pattern `https://hermes-agent.nousresearch.com/docs/<path-without-.md>`.

Version context: the newest semver tag is `v0.23.0`, whose tagged commit is dated 2026-11-05. Older tags include `v0.22.0` (2026-10-13) through `v0.22.7`, `v0.23.0+canary.*` builds, and an earlier calendar-style series that ends at `v2026.9.24`. `hermes_cli/__init__.py` on main still says `__release_date__ = "2026.9.24"`. The bundled config schema is `_config_version: 53` — [tags](https://github.com/NousResearch/hermes-agent/tags), [hermes_cli/__init__.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/__init__.py), [cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example)

---

## 1. System requirements (Python, uv, git, Node.js, ripgrep, ffmpeg, supported OSes, WSL)

### Takeaway
Before you run the source installer you only need **git, curl, tar and SHA-256 utilities**. The installer downloads its own pinned uv, and its dependency manager ("PM") brings pinned **Python 3.14**, Node.js, npm, pnpm, ripgrep, FFmpeg and Chromium. On minimal Debian/Ubuntu images the managed Node needs **`libatomic1`**. Current builds run only on Python 3.14, even though `pyproject.toml` still says `>=3.11,<3.15`.

### Cited Findings
- **POSIX installer prerequisites:** "provide Git, curl, tar, and SHA-256 utilities". The script always downloads its own verified uv pin and never uses a uv already on PATH — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **What PM supplies:** pinned Python, Node.js, npm, pnpm, ripgrep and FFmpeg. By default PM also installs a pinned Chromium (Chrome for Testing) and, on glibc Linux, `cua-driver` (the computer-use driver). If one of those downloads fails, the install still completes and prints the retry command — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Python version:** "Current first-party installations run on **Python 3.14**." The `>=3.11,<3.15` range in `pyproject.toml` only exists so old installs can run the updater once; "it does not promise current runtime support on 3.11–3.13" — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation); [pyproject.toml](https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml) (`requires-python = ">=3.11,<3.15"`)
- **Why older Pythons break:** every runtime dependency carries a `python_version >= '3.14'` marker. `pip install .`, `uv pip install .` or `pip install -e .` on Python 3.11–3.13 installs `hermes-agent` "with **no dependencies** and the package does not import" — [Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)
- **Node version:** PM picks tool versions from `pm/lock.json` and "does not adopt arbitrary system Node versions as the installed runtime" — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **libatomic:** on glibc Linux the managed Node.js links `libatomic.so.1`, which minimal Debian, Ubuntu and RHEL-family images do not ship. The installer and `hermes update` install the package themselves (`libatomic1` on apt and zypper). They run the package manager directly when running as root, or through `sudo -n` otherwise. `--non-interactive` runs never prompt — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Compilers:** "Source builds can require a native compiler and platform development libraries." With no compiler present, a source build fails with a hint to run `sudo apt install build-essential`. PM falls back to `gcc`/`g++` when the pinned Python's recorded `clang` is not on PATH — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation); [Package management](https://hermes-agent.nousresearch.com/docs/reference/package-management)
- **Chromium system libraries:** "Linux Chromium also requires system libraries supplied by the distribution." The installer "does not run Playwright's `--with-deps` step" — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **musl hosts (e.g. Alpine):** the installer requires the system `libstdc++` (`apk add libstdc++`), and PM has no Chromium build there, so Hermes uses a system `chromium` on PATH — [install.sh](https://github.com/NousResearch/hermes-agent/blob/main/scripts/install.sh); [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Tier 1 platforms:** macOS (Apple Silicon); Windows 10/11; **Linux / WSL2 (x86_64, aarch64) via `install.sh`** ("We test on the latest Ubuntu and WSL2. If your distro has glibc, systemd, and follows the Filesystem Hierarchy Standard, it's likely to work pretty well."); and Docker (x86_64, aarch64) — [Platform Support](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support)
- **Tier 2 (best effort):** Nix, and Termux on aarch64. **Unsupported:** PyPI installs (`pip install hermes-agent`, `uv tool install hermes-agent`), `brew`, the AUR, and Intel macOS desktop bundles — [Platform Support](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support)
- **WSL:** use `hermes gateway run` rather than `hermes gateway start`, because "WSL's systemd support is unreliable". Wrap it in tmux to keep it running: `tmux new -s hermes 'hermes gateway run'` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Model context:** the model needs at least **64,000 tokens** of context. "Models with smaller windows … will be rejected at startup" — [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
- **Open bug:** issue #150951, "pm & install.sh misidentify Fedora (glibc) hosts as linux-x64-musl when musl-libc is installed as a secondary toolchain", is open as of 2026-11-08 — [Issues](https://github.com/NousResearch/hermes-agent/issues)

### Inferences
- For the target container (Ubuntu/Debian, root, no GPU), do `apt-get install -y git curl tar coreutils libatomic1 build-essential ca-certificates` before running the installer. That covers every documented prerequisite plus the two packages minimal images usually lack. The installer would install `libatomic1` itself as root, but installing it first removes one failure point.
- The docs give no CPU or RAM minimums. With no GPU, 4 CPUs and 15 GB RAM, a hosted or remote LLM endpoint is the realistic setup. The agent itself is light; Chromium and the TUI build are the heaviest local parts.

### Gaps
- The docs state no explicit CPU, RAM or disk minimums for the agent.
- I did not open `pm/lock.json`, so the exact pinned Node, ripgrep, FFmpeg and Chromium versions are not recorded here. (Issue #87460 refers to "Node 26.x" being the managed Node as of August 2026.)

---

## 2. Install methods, what the script does, and where everything lands

### Takeaway
The supported Linux path is `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`. It runs nine stages. The code goes to `~/.hermes/hermes-agent/`, the launcher to `~/.local/bin/hermes`, and user data to `~/.hermes/`. Run as root, that means `/root/...`. There is no supported pip/PyPI install. Docker uses the `nousresearch/hermes-agent` image, with code at `/opt/hermes` and data at `/opt/data`.

### Cited Findings
- **One-liner (Linux, macOS, WSL2):** `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`. Native Windows: `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Script usage:** `install.sh [--channel stable|main] [--branch NAME] [--commit SHA] [--dir PATH] [--hermes-home PATH] [--manifest] [--stage NAME] [--json] [--non-interactive] [--include-desktop] [--verbose] [--skip-browser] [--skip-computer-use]`. `--skip-setup` is an alias for non-interactive and `--no-playwright` is an alias for `--skip-browser`. Environment variables it reads: `HERMES_REPO_URL` (default `https://github.com/NousResearch/hermes-agent.git`), `HERMES_INSTALL_CHANNEL`, `HERMES_INSTALL_DIR`, `HERMES_HOME` (default `$HOME/.hermes`), and `HERMES_INSTALL_VERBOSE`. It also exports `UV_NO_CONFIG=1` so uv does not pick up the wrong user's config under `sudo -u` (see #21269) — [install.sh](https://github.com/NousResearch/hermes-agent/blob/main/scripts/install.sh)
- **The stages, in order:** `prerequisites repository venv python-deps config products setup gateway complete` — [install.sh](https://github.com/NousResearch/hermes-agent/blob/main/scripts/install.sh)
  1. **prerequisites:** checks that git and curl exist and that git runs. On musl it checks for `libstdc++`. On glibc, as non-root with a TTY and libatomic missing, it caches sudo credentials (`sudo -v`) ahead of time.
  2. **repository:** clones or updates the checkout at `INSTALL_DIR` (default `$HERMES_HOME/hermes-agent`). If that directory exists but is not a Hermes checkout, it fails with "Move it aside, or install elsewhere with --dir <path>". The **stable** channel (the default) checks out the latest published release; `main` follows every commit.
  3. **venv**, then **python-deps:** fetches the bootstrap Python and hands dependency preparation to PM ("PM alone creates dependency environments").
  4. **config:** creates `$HERMES_HOME/{cron,sessions,logs,pairing,hooks,image_cache,audio_cache,memories,skills}`, copies `.env.example` to `~/.hermes/.env` and sets it to mode `600`, and copies `cli-config.yaml.example` to `~/.hermes/config.yaml` if no config exists yet.
  5. **products:** runs `hermes_cli/source_completion.py`, which publishes the `hermes` command, builds the TUI and web products (and the desktop app with `--include-desktop`), syncs bundled skills and migrates config. It then appends the PATH line to `~/.bashrc` and `~/.profile`, and also to `~/.bash_profile` or `~/.bash_login` if either exists (`~/.zshrc`/`~/.zprofile` for zsh, `fish_add_path` for fish).
  6. **setup:** runs `hermes setup </dev/tty`, but only when the run is interactive *and* `/dev/tty` can be opened.
  7. **gateway:** runs `hermes gateway install --if-missing`, under the same conditions.
  8. **complete:** writes `.hermes-bootstrap-complete` (pinned commit and branch), saves an explicitly chosen channel with `hermes update --set-channel`, then prints "Hermes Agent install complete. Run: hermes".
- **Installer output:** on a terminal it shows one status line per step and writes the git, uv and build output to `logs/install.log` in the data dir. CI (`CI` or `GITHUB_ACTIONS` set), redirected output, `--verbose` or `HERMES_INSTALL_VERBOSE=1` stream everything instead — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Channel:** a new install lands on the latest stable release. Use `--channel main` or `HERMES_INSTALL_CHANNEL=main` for the tip of main. `--skip-browser` and `--skip-computer-use` are remembered; undo them with `hermes pm install chromium` or `hermes pm install cua-driver` — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Install layout:** POSIX source script: code in `~/.hermes/hermes-agent/`, CLI as the `~/.local/bin/hermes` wrapper, data in `~/.hermes/`. Docker: code in `/opt/hermes/`, entrypoint plus a `hermes` shim, data in the mounted `/opt/data/`. "Running the POSIX script as root does not select an automatic FHS layout: it uses root's home unless you provide an explicit source path." `HERMES_HOME` selects user data, and `--dir` selects the checkout independently — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **PM's writable state, under `~/.hermes`:** `tools/` (the shared tool store; the installer's default for `HERMES_RUNTIME_DIR` is `$HERMES_HOME/tools`), `cache/partials/` (resumable downloads), `installs/INSTALL_KEY/environments/` (Python generations, i.e. the venvs), and `logs/update_receipts/`. "Do not edit facts or generation paths manually" — [Package management](https://hermes-agent.nousresearch.com/docs/reference/package-management); [install.sh](https://github.com/NousResearch/hermes-agent/blob/main/scripts/install.sh)
- **Entry points:** the package name is `hermes-agent`, and it defines `hermes = "hermes_cli.main:main"`, `hermes-agent = "agent.legacy_cli:main"` and `hermes-acp = "acp_adapter.entry:main"`. Installing it from PyPI or pip is *unsupported* — [pyproject.toml](https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml); [Platform Support](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support)
- **Manual / developer install:** `git clone https://github.com/NousResearch/hermes-agent.git && cd hermes-agent`. Optionally `export HERMES_HOME="$HOME/hermes-dev-data"` and `export HERMES_RUNTIME_DIR="$HERMES_HOME/tools"`, then `source ./activate`; `deactivate` restores the shell. Activation provisions tools and syncs the `all` Python extra, but skips shell config, `.env` and bundled skills; "Run the setup script separately if you want that full installation workflow" (the repo root has `setup-hermes.sh`). "Do not mutate a Hermes environment with raw pip or uv commands." To repair the launcher from a checkout: `python -m pm.cli install` — [Package management](https://hermes-agent.nousresearch.com/docs/reference/package-management); [Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)
- **Service-user installs:** run the installer *as* the service user, add `export PATH="$HOME/.local/bin:$PATH"`, and run `hermes doctor` through the installed wrapper ("not a hardcoded `venv/bin/hermes` path"). For a user service, run `sudo loginctl enable-linger SERVICE_USER` — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Docker setup and gateway:** `docker run -it --rm -v ~/.hermes:/opt/data nousresearch/hermes-agent setup`. Gateway: `docker run -d --name hermes --restart unless-stopped -v ~/.hermes:/opt/data -p 8642:8642 nousresearch/hermes-agent gateway run`, where port 8642 is the OpenAI-compatible API server and health endpoint. Docker installs "do not support `hermes update`"; update by pulling `nousresearch/hermes-agent:latest` and recreating the container — [Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker); [Platform Support](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support); [Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)
- **Docker and root:** the image uses s6-overlay `/init`, which runs as root to fix volume ownership and then drops to the `hermes` user. `docker exec hermes hermes …` runs as root, but the `/opt/hermes/bin/hermes` shim re-execs through `s6-setuidgid hermes` — [Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker)
- **Uninstall:** `hermes uninstall [--full] [--gui] [--data] [--dry-run] [--yes]`. `--full` also removes data — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)

#### Version changes worth flagging (cross-cutting)
- **`-q` semantics:** before 0.21, `-q` answered once and exited. Now on a TTY it seeds an interactive session; use `--oneshot`, `-Q`, `-z` or non-TTY stdio to answer and exit — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Python:** older installers fetched Python 3.11 through uv (issue #10778). Current builds are 3.14-only and managed by PM — [Issue #10778](https://github.com/NousResearch/hermes-agent/issues/10778); [Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)
- **Root install layout:** it used to be an FHS layout (`/usr/local/lib/hermes-agent`); now it is root's home — [Issue #21457](https://github.com/NousResearch/hermes-agent/issues/21457); [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Gateway-owned session runtime:** the CLI, TUI, Desktop, ACP and cron are now all gateway clients. "Rolling back is unsupported once the new gateway has written `state.db`" — [Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)
- **Removed or deprecated:**
  - `LLM_MODEL` in `.env` was removed, and `OPENAI_BASE_URL` now applies only to `openai-api`.
  - `HERMES_CA_BUNDLE` and the SSL startup guard were removed.
  - `HERMES_TOOL_PROGRESS` and `HERMES_HUMAN_DELAY_*` are no longer read, and `TERMINAL_CWD` is deprecated.
  - `hermes login`/`logout` are deprecated in favor of `hermes auth`.
  - Nix is demoted to best-effort, and pip/PyPI installs are unsupported — [Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers); [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security); [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables); [Platform Support](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support)
- **Update channels:** the default is now `stable`, meaning published `vX.Y.Z` releases. Forks and mirrors default to `main` — [Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)

### Inferences
- As root in a container, the result is code in `/root/.hermes/hermes-agent`, the launcher at `/root/.local/bin/hermes` and data in `/root/.hermes`. Under `curl | bash` with no TTY, the setup and gateway stages skip themselves with "setup skipped (no terminal); run 'hermes setup' after install". Passing `--non-interactive` is still the explicit way to say so. With `curl | bash`, flags go through `bash -s --`: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive --skip-computer-use`. That is standard bash usage; the docs do not show this form.
- PATH changes only reach new shells, because the installer runs as a child process. Afterwards run `source ~/.bashrc` or `export PATH="$HOME/.local/bin:$PATH"`, or call `~/.local/bin/hermes` directly.

### Gaps
- I did not verify whether the tag `v0.23.0` is a published GitHub *Release*: the GitHub API is blocked from this session, so I only saw the git tag.
- I did not determine the exact URLs the stable-channel lookup hits behind the proxy (the GitHub REST API vs git).

---

## 3. CLI command reference: commands, flags, one-shot mode, slash commands

### Takeaway
`hermes` (or `hermes chat`) opens an interactive session. For scripts, use `hermes -z "prompt"` to get only the final answer, or `hermes chat --oneshot -q "…"` (`-Q`, `--format stream-json`) for more output. Pick the model and provider per run with `-m/--model`, `--provider`, `-t/--toolsets`, and `--base-url/--api-key` together with `--provider custom`. **Since the "gateway-owned session runtime" change, the classic CLI is a client of a local gateway daemon**, which it discovers or starts automatically.

### Cited Findings
- **Global options:** `hermes [global-options] <command>`. They are `--version/-V`, `--profile/-p <name>`, `--resume/-r <id|title|latest>`, `--continue/-c [name]`, `--in <dir>`, `--worktree/-w`, `--yolo`, `--pass-session-id`, `--ignore-user-config` (credentials in `.env` still load), `--ignore-rules`, `--tui` (same as `HERMES_TUI=1`), `--cli` and `--dev` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **`hermes chat` options:**
  - `-q/--query`: on a real TTY this seeds an interactive session and leaves it open. With `--oneshot`, `-Q`, **or non-TTY stdio** it answers and exits.
  - `--query-file PATH`: `-` reads stdin, with no shell interpretation.
  - `--oneshot`: "the pre-0.21 single-query behavior".
  - `-m/--model`; `-t/--toolsets <csv>`; `--provider <id>` (`auto`, `openrouter`, `nous`, `openai-codex`, `anthropic`, `gemini`, `openai-api`, `deepseek`, `lmstudio`, `bedrock` … and `custom`).
  - `-s/--skills`; `-v/--verbose`; `-Q/--quiet`; `--format stream-json`; `--image`; `--worktree`; `--checkpoints`; `--yolo`.
  - `--safe-mode` (needs an explicit `--model`); `--base-url <url>` / `--api-key <key>` for `--provider custom` (the key is held only in the gateway's memory and never written to disk); `--source <tag>`.
  - `--max-turns <N>`: default 500, or `agent.max_turns` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Examples from the docs:** `hermes chat --oneshot -q "Summarize the latest PRs"`; `hermes chat --provider openrouter --model anthropic/claude-sonnet-4.6`; `hermes chat --toolsets web,terminal,skills`; `hermes chat --safe-mode --provider custom --base-url http://127.0.0.1:8000/v1 --model local -q "Isolate against a local server"` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **`hermes -z <prompt>`:** "single prompt in, final response text out, nothing else on stdout or stderr". Per-run overrides are `-m/--model` (or `HERMES_INFERENCE_MODEL`), `--provider` and `--usage-file <path>`. The usage report is a JSON file with tokens, `estimated_cost_usd` and an `auxiliary` breakdown, and it is written even when the run fails. Exit codes: `0` completed; `2` failed or partial (also bad flags); `130` interrupted; `1` completed but produced no text — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Exit codes for `chat -Q`, `--oneshot` and non-TTY runs:** `0` completed; `1` failed, partial, hit the iteration budget, or never ran (credentials or init failed); `130` interrupted; `75` only for Kanban workers on a transient provider error. **`--format stream-json` events:** `system` (init: model, session_id), `text`, `tool_use`, `tool_result` (output capped at 5000 chars), and `result` (exit_code, text, tokens, duration_ms) — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Legacy runner:** `hermes-agent --query "…"` (options include `--model`, `--base-url`, `--max-turns`, `--enabled-toolsets`, `--disabled-toolsets`, `--list-tools`). The docs say: "For anything else use `hermes`" — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **The CLI as a gateway client:** "`hermes chat` … no longer runs the agent inside your terminal process. It discovers or starts the profile's gateway (`hermes gateway ensure`), creates or resumes the session there, and attaches over the gateway's local WebSocket." These flags are frozen into the session when it is created: cwd, `--model`, `--provider`, `--toolsets`, `--max-turns`, `--yolo`, `--base-url/--api-key`, `--safe-mode`. In this mode `--image`, `--worktree/-w`, `--verbose/-v`, `--compact` and `--run-budget` "are refused up front (`Unsupported gateway CLI options: …`, exit 2)". The slash commands available are limited to `/stop /approve /answer /discard /branch /model /compress /yolo /help /quit`; "Use the TUI (`hermes --tui`) for the full slash registry." If a running turn loses its owner, the CLI exits with code `3` — [CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli)
- **Docs contradiction:** the CLI reference still lists `--image`, `--worktree` and `-v` as `hermes chat` options, and the CLI guide shows `hermes -w -z "Fix issue #123"`. The gateway-client note says those same options are refused with exit 2 — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands) contradicted by [CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli)
- **`hermes setup [model|tts|terminal|gateway|tools|agent] [--non-interactive] [--reset] [--quick] [--reconfigure] [--portal]`:** `--non-interactive` means "Use defaults / environment values without prompts". On a fresh install the wizard offers three modes: Quick Setup (Nous Portal), Full Setup, and Blank Slate, which enables only provider and model plus the File and Terminal toolsets — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands); [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
- **`hermes model`:** "the command for adding new providers, setting up API keys, and running OAuth flows". Run it from the shell, not from inside a chat. `/model` inside a chat only switches between providers already configured. `/model <m> --global` persists the switch, including the provider and base URL, and a stale base URL is cleared when you leave a custom endpoint — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **`hermes tools [--summary]`:** the interactive per-platform tool UI; `--summary` prints the enabled tools and exits — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **`hermes config`:** subcommands `show`, `edit`, `get <key> [--json] [--raw]` (secrets are masked unless `--raw`), `set <key> <value> [--force]`, `unset`, `path`, `env-path`, `check` and `migrate`. On `set`, dotted keys go to `config.yaml` and **every `UPPER_SNAKE` name goes to `.env`**. Denylisted names such as `HERMES_YOLO_MODE` and `PATH` are refused. Values are type-checked against the schema, and literal dots in key names are escaped like `'providers.p.models.grok-4\.7.context_length'` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **`hermes doctor [--fix]`:** exit `0` when no problems remain, `1` otherwise, so it works as a CI gate. It runs an IPv6-route check (a blackholed IPv6 route gives a warning recommending `network.force_ipv4: true`), flags malformed `custom_providers` and any list stored as a quoted string, and reports install provenance — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands); [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **`hermes update [--check] [--plan] [--backup|--no-backup] [--yes] [--set-channel stable|main] [--channel …] [--branch …]`:** exit `0` ok, `1` pull or install error, `2` a dirty tree blocks the pull. It auto-restarts the running gateways of the same `HERMES_HOME` and logs to `~/.hermes/logs/update.log` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands); [Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)
- **`hermes gateway`** subcommands: `run` (foreground; "Recommended for WSL, Docker, and Termux"), `ensure`, `attach`, `start`, `stop`, `restart`, `status`, `list`, `install` (systemd/launchd), `uninstall`, `setup`, `migrate`, `migrate-legacy` and `enroll`. Flags: `--all`, `-y/--yes` (needed for `stop`/`restart` when there is no terminal), `--detach` and `--external-supervisor` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **`hermes sessions`** subcommands: `list`, `browse`, `export <out> [--session-id]`, `delete`, `prune` (default: older than 90 days), `archive`, `stats`, `rename`, `optimize`, `repair` and `recover`. Resume with `hermes -c`, `hermes -c "title"`, `hermes --resume <id|title|latest>` or `hermes --resume latest --in ./dir`. Sessions live in `~/.hermes/state.db` (SQLite) — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands); [CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli)
- **Other useful commands:** `hermes status`, `hermes dump` (a pasteable setup summary), `hermes logs [agent|errors|gateway|update|…] [-f] [-n N] [--level] [--since 1h]` (files in `~/.hermes/logs/`), `hermes pm doctor|status|repair|install`, `hermes auth` (`hermes login`/`logout` are deprecated), `hermes backup` / `hermes import`, `hermes profile`, `hermes mcp`, `hermes skills`, `hermes cron` and `hermes completion bash|zsh|fish` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Slash commands (full set in the TUI or classic CLI):**
  - Sessions and history: `/new` (`/reset`), `/clear`, `/history`, `/save`, `/retry`, `/undo`, `/title`, `/compress`, `/rollback`, `/resume`, `/sessions`, `/status`, `/context`.
  - Background work: `/stop`, `/queue`, `/steer`, `/bg`, `/btw`.
  - Model and behavior: `/model`, `/reasoning`, `/yolo`, `/approvals [manual|smart|off]`.
  - Tools and features: `/tools [list|disable|enable]`, `/toolsets`, `/skills`, `/memory`, `/plan`, `/init` (generates `AGENTS.md`), `/cron`, `/config`, `/help`, `/quit`.
  - Every installed skill also becomes its own `/<skill>` command — [Slash Commands](https://hermes-agent.nousresearch.com/docs/reference/slash-commands); [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
- **Toolset names for `-t`:**
  - Single toolsets: `file`, `terminal`, `web`, `search`, `browser`, `code_execution`, `delegation`, `memory`, `skills`, `todo`, `session_search`, `clarify`, `vision`, `image_gen`, `tts`, `cronjob`, `computer_use`, `safe`.
  - Composites: `coding` and `debugging`. The platform default for the CLI is `hermes-cli`.
  - The Actual Computer section of the providers page suggests restricting tools on small local models (`-t file,web`) — [Toolsets reference](https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference); [Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers)

### Inferences
- In a headless container, the first `hermes chat` or `hermes -z` starts an unmanaged local gateway. A related doc line says "An unmanaged gateway that `attach` starts (no service installed) stops itself once it has been idle for a while" — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands). If you want it long-lived, run `hermes gateway run` in a tmux session or as a supervised process; containers usually have no systemd.
- In scripts, judge a run by its exit code and treat `-z` and `chat -Q` codes as different: `-z` uses `2` for failure and `1` for "no text", while `chat -Q` uses `1` for failure.

### Gaps
- I did not find which release number introduced the gateway-owned session runtime. The Updating page only says "From this release".
- The docs contradict themselves on whether `--worktree`, `--image` and `-v` still work for `hermes chat` and `-z` (see above). This needs testing.

---

## 4. Configuration layout: config.yaml, .env and precedence

### Takeaway
Non-secret settings go in `~/.hermes/config.yaml`; secrets go in `~/.hermes/.env` (mode 600). Precedence from highest to lowest: **CLI arguments, then config.yaml, then .env, then built-in defaults**. A few process-level environment variables (for example `HERMES_INFERENCE_MODEL`) override `config.yaml` for that run. `hermes config set` writes each key to the right file automatically. The provider, model and base URL live in the `model:` block.

### Cited Findings
- **Directory layout:** `~/.hermes/` holds `config.yaml`, `.env`, `auth.json` (OAuth credentials), `SOUL.md`, `memories/`, `skills/`, `cron/`, `sessions/` and `logs/`. Session data is in `state.db` — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration); [CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli)
- **Precedence:** "1. CLI arguments … 2. `~/.hermes/config.yaml` … 3. `~/.hermes/.env` — fallback for env vars; **required** for secrets … 4. Built-in defaults." Also: "When both are set, `config.yaml` wins for non-secret settings." An administrator can pin values through [Managed Scope](https://hermes-agent.nousresearch.com/docs/user-guide/managed-scope) — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **Exception in the example config:** its header says "only documented secret environment variables in .env take precedence over their corresponding settings" — [cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example)
- **Process-level overrides:** `HERMES_INFERENCE_MODEL` "takes priority over `config.yaml` for the session". `HERMES_IGNORE_USER_CONFIG` skips `config.yaml` — [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables)
- **Env substitution inside config.yaml:** `${VAR}` and `${env:VAR}` are expanded; bare `$VAR` is not; an unset variable stays verbatim and a warning is logged — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **Top-level sections of the shipped example:**
  - `_config_version`, `database`, `runtime`, `attachments`, `plugins`, `model`.
  - `kanban`, `cron`, `terminal`, `browser`, `tool_loop_guardrails`, `compression`, `prompt_caching`, `memory`, `max_concurrent_sessions`, `group_sessions_per_user`, `hosted_rooms`.
  - `streaming`, `skills`, `agent`, `gateway`, `platform_toolsets`, `stt`, `code_execution`, `delegation`, `display`, `telemetry`, `auth`, `updates`.
  - Commented-out examples: `providers:`, `security:`, `auxiliary:` — [cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example)
- **`model:` block:**
  - `default: "anthropic/claude-opus-4.6"` ("Both "default" and "model" work as the key name").
  - `provider: "auto"` (auto-detect from credentials). Other values include `openrouter`, `nous`, `anthropic`, `openai-codex`, `gemini`, `lmstudio`, and `custom`, whose aliases are `ollama`, `vllm` and `llamacpp`.
  - `base_url: "https://openrouter.ai/api/v1"`; optional `api_key`; `streaming: true`; plus `context_length` and output-token settings — [cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example)
- **Custom endpoint YAML:** `model: {default: your-model-name, provider: custom, base_url: http://localhost:8000/v1, api_key: …}`. `key_env: MY_PROVIDER_API_KEY` is an alternative to `api_key`. `LLM_MODEL` in `.env` "is **removed**". `OPENAI_BASE_URL` is honored "**only** for the `openai-api` provider". "`config.yaml` is the single source of truth for model and endpoint configuration" — [Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers)
- **Named custom providers:** use the `providers:` map; the legacy `custom_providers` must be a YAML list. Switch with `/model custom:<name>:<model>` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands); [Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers)
- **Provider timeouts:** `providers.<id>.request_timeout_seconds` and `stale_timeout_seconds`. Legacy defaults: `HERMES_API_TIMEOUT=1800` s, `HERMES_API_CALL_STALE_TIMEOUT=90` s — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **`agent:` block:** `max_turns: 500` (also settable via `HERMES_MAX_ITERATIONS`), `reasoning_effort: "medium"`, `verbose: false`, `disabled_toolsets: [...]` (removes toolsets everywhere, after `platform_toolsets`), and an optional `gateway_timeout: 1800` — [cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example); [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **`compression:`:** `enabled: true`, `threshold: 0.50`, `target_ratio: 0.20`, `tail_mode: lean`, `protect_last_n: 20`, `protect_first_n: 3`, `in_place: true`. The summarizer is set under `auxiliary.compression.{model,provider,base_url}`; an empty `model` means the main model — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **`memory:`:** `memory_enabled: true`, `user_profile_enabled: true`, `memory_char_limit: 2200`, `user_char_limit: 1375`, `write_approval: false`. The example config also has `nudge_interval: 10` — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration); [cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example)
- **`updates:`:** `pre_update_backup: quick|full|off`, `backup_keep: 5`, `non_interactive_local_changes: stash|discard`. `runtime:` defaults to `nofile_soft_limit: 4096` and `malloc_arena_max: 4`. `database.journal_mode: wal` (use `delete` on NFS or SMB) — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **Config backups:** copies of `config.yaml` go to `backups/config/config.yaml.<reason>.<timestamp>`. If `config.yaml` is broken, Hermes serves the newest good copy and warns on every start — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **CLI examples:** `hermes config set model anthropic/claude-opus-4.6`, `hermes config set terminal.backend docker`, `hermes config set OPENROUTER_API_KEY sk-or-...` ("The right value goes to the right file automatically"). Run `hermes config check` and then `hermes config migrate` after updates — [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart); [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Changing provider:** `config set model.provider <provider>` removes a leftover `model.base_url` or `model.api_mode` that points at another provider's endpoint. A proxy or LAN URL is kept, with a warning — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)

### Inferences
- For a scripted custom endpoint, the minimum is three commands: `hermes config set model.provider custom`, `hermes config set model.base_url http://HOST:PORT/v1` and `hermes config set model.default <model-id>`. Add `hermes config set model.api_key …` or put the key in an env var named by `model.key_env`. `hermes config get model --json` verifies the result. Set `model.provider` first, because that command can remove a stale `base_url`.

### Gaps
- I did not record every key in the 2,443-line example config, such as all `display.*` or `gateway.*` keys. The full list is in [cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example).

---

## 5. Terminal backends; the local backend, its security, approvals, sudo and working directory

### Takeaway
`terminal.backend` (or the `TERMINAL_ENV` env var) picks where shell commands run. The options are **local** (the default, no isolation), docker, ssh, modal, daytona and vercel_sandbox; plugins add singularity and sprites. On the local backend, commands run with your user's full rights, so dangerous-command approval (`approvals.mode: smart` by default) and a non-overridable hardline blocklist are the only guards. Container backends skip the dangerous-command checks.

### Cited Findings
- **Terminal defaults:**
  ```yaml
  terminal:
    backend: local   # local | docker | ssh | modal | daytona | vercel_sandbox | <plugin backend>
    cwd: "."         # gateway/cron working directory; the CLI always uses the launch dir
    temp_dir: ""
    timeout: 180     # per-command timeout, seconds
    home_mode: auto
    env_passthrough: []
    client_env_passthrough: []
    sync_back_max_bytes: 2147483648
    modal_image: nousresearch/hermes-sandbox:desktop
    daytona_image: nousresearch/hermes-sandbox:desktop
  ```
  The example config also sets `lifetime_seconds: 300` and `docker_mount_cwd_to_workspace: false` ("SECURITY: off by default") — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration); [cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example)
- **Backend overview:**
  - local: "Your machine directly | None | Development, personal use".
  - docker: a single persistent container, with namespaces and cap-drop.
  - ssh: a network boundary.
  - modal, daytona, vercel_sandbox: cloud sandboxes.
  - singularity (plugin): for HPC.
  - sprites (plugin): Fly.io microVMs — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **Local backend:** "The default. Commands run directly on your machine with no isolation. No special setup required." Warning: "The agent has the same filesystem access as your user account. Use `hermes tools` to disable tools you don't want, or switch to Docker for sandboxing." — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **`terminal.home_mode`:** `auto` keeps the real `HOME` on host installs and uses `{HERMES_HOME}/home` in containers; `real` forces the real `HOME`; `profile` uses `{HERMES_HOME}/home`, and in that mode `HERMES_REAL_HOME` points at the real home — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **Shell behavior:**
  - Each command runs in a fresh `bash`, started from a login-shell environment snapshot.
  - With the persistent shell on (the default), `cd` and exported variables carry over between commands; plain shell variables, functions and aliases do not.
  - Local-backend switch: `TERMINAL_LOCAL_PERSISTENT` (default `true`). SSH backend: `terminal.persistent_shell`.
  - The snapshot comes from `bash -l`, and Hermes also auto-sources `~/.bashrc` (`terminal.auto_source_bashrc`). Add other files via `terminal.shell_init_files`.
  - Hermes appends standard system directories and `~/.local/bin` to PATH — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration); [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)
- **Working directory:**
  - The CLI uses the directory it was launched from; `--in <dir>` changes it.
  - `terminal.cwd` applies to gateway and cron sessions. `TERMINAL_CWD` is "Deprecated".
  - The production checklist says "Set `terminal.cwd` — don't let the agent operate from sensitive directories" — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration); [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables); [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **Temp directories:** every Hermes process and its children get `TMPDIR`, `TMP` and `TEMP` set to `~/.hermes/cache/scratch` unless those are already set. Entries are pruned after 24 hours idle — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **Approval config:**
  ```yaml
  approvals:
    mode: smart              # smart | manual | off
    timeout: 300
    cron_mode: deny          # deny | approve
    single_query_mode: deny  # deny | approve
    unattended_mode: deny    # deny | approve
    deny: []                 # fnmatch globs that block commands even under --yolo
  ```
  [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **What the modes do:** `smart` uses an auxiliary LLM to judge risk: low-risk commands are auto-approved, genuinely dangerous ones auto-denied, and unclear ones escalate to a prompt. `manual` always prompts. `off` is the same as `--yolo`: "Use only in trusted environments (CI/CD, containers, etc.)". A prompt that times out is denied (fail-closed) — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **YOLO:** turn it on with `--yolo`, `/yolo` (a toggle) or `HERMES_YOLO_MODE=1`. It still does **not** bypass the hardline blocklist, which covers `rm -rf /` and variants, fork bombs, `mkfs` on the root device, `dd` to `/dev/sd*`, and piping untrusted URLs to `sh` at rootfs level. It also does not bypass `approvals.deny` rules — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **Patterns that trigger approval:** `rm -r`, `chmod 777`, `chown -R root`, `mkfs`, `dd if=`, `DROP TABLE`, writes to `/etc/`, `systemctl stop/restart`, `kill -9 -1`, `bash -c`/`sh -c`, `python -e`, `curl … | sh`, writes to `~/.ssh/` or `~/.hermes/.env`, `docker stop/kill`, and others. "**Container bypass**: When running in `docker`, `modal`, `daytona`, or `vercel_sandbox` backends … dangerous command checks are **skipped**" — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **CLI approval prompt:** `[o]nce | [s]ession | [a]lways | [d]eny`, with deny as the default. "always" saves the pattern to `command_allowlist:` in `config.yaml`. Allowlisted rule keys are honored even under `single_query_mode: deny` — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **sudo:**
  - `terminal.sudo_password` (or the `SUDO_PASSWORD` env var) pipes the password through `sudo -S`. It is stored in plaintext.
  - Setting `sudo_password: ""` "try[s] an empty password … and will not open the interactive prompt (passwordless sudo)".
  - When unset, the CLI prompts with a 45 s timeout and caches the password for the session.
  - The config notes say "Containers: Run as root inside the container (no sudo needed)".
  - In the gateway, sudo cannot prompt; the advice is to use sudoers rules — [cli-config.yaml.example](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example); [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables); [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)
- **File-write safety:** `HERMES_WRITE_SAFE_ROOT` hard-blocks `write_file` and `patch` outside the listed roots, with no approval prompt. Some protected paths are always blocked — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security); [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables)
- **Docker backend:** default image `nousresearch/hermes-sandbox:desktop` (`TERMINAL_DOCKER_IMAGE`); `HERMES_DOCKER_BINARY` can select podman. Resources: `TERMINAL_CONTAINER_CPU` (default 1), `TERMINAL_CONTAINER_MEMORY` (5120 MB), `TERMINAL_CONTAINER_DISK` (51200 MB). It needs a working `docker version`; "If it fails, fix Docker or `hermes config set terminal.backend local`" — [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables); [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- **SSH backend:** needs `TERMINAL_SSH_HOST`, `TERMINAL_SSH_USER`, `TERMINAL_SSH_PORT` (default 22) and `TERMINAL_SSH_KEY`, set in `.env` — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **Running as root:** the production checklist says "**Run as non-root** — never run the gateway as root" and "**Use container backend**" — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)

### Inferences
- In the target container (root, probably no Docker daemon), `local` is the practical backend. The container itself is the isolation boundary, but Hermes does not know that, so dangerous-command prompts still fire. That is because the "container bypass" applies only to container *backends*, not to Hermes running inside a container.
- For unattended use, choose one of three options: `approvals.mode: off` or `--yolo`; `approvals.single_query_mode: approve` for one-shot runs only; or keep `smart`. `smart` costs an extra auxiliary-LLM call per flagged command.
- Running as root goes against the docs' advice for the gateway, but the docs give no technical block on it. The local backend's agent would have full root access to the container.

### Gaps
- I found no doc statement that root is refused or warned at startup. I also did not check the "File Write Safety → Protected paths" list in detail.

---

## 6. Running headless or non-interactively (scripts, CI, a container without a TTY)

### Takeaway
Install with `--non-interactive`; with no TTY the installer skips setup by itself. Configure with `hermes config set …`, or `hermes setup --non-interactive`, which uses defaults and env values. Run with `hermes -z "…"` or `hermes chat -Q -q "…"` / `--format stream-json`, which answer and exit automatically when stdio is not a TTY. Control behavior with env vars such as `HERMES_YOLO_MODE=1`, `HERMES_ACCEPT_HOOKS=1`, `HERMES_INFERENCE_MODEL` and `HERMES_HOME`.

### Cited Findings
- **Installer without a TTY:** "Interactive stages read the terminal, not stdin: under `curl | bash` stdin IS the script." The installer probes `/dev/tty`; "a Docker build has the device node … but opening it fails (ENXIO)". Without a terminal it logs "setup skipped (no terminal); run 'hermes setup' after install" and "gateway setup skipped (no terminal); run 'hermes gateway install' after install". `--non-interactive` skips both stages outright — [install.sh](https://github.com/NousResearch/hermes-agent/blob/main/scripts/install.sh)
- **`hermes setup --non-interactive`:** "Use defaults / environment values without prompts" — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **One-shot runs:** `-q` "With `--oneshot`, `-Q`, or non-TTY stdio … answers and exits". `--query-file -` reads a prompt from stdin without shell interpretation. `hermes -z` gives final text only. `--usage-file` writes a JSON spend report — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Isolated CI runs:** `--ignore-user-config` ("Useful for isolated CI runs, reproducible bug reports"), `--ignore-rules`, and `--safe-mode`, which needs `--model` and is best paired with `--provider custom --base-url … --api-key …` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Approvals in one-shot runs:** they default to `single_query_mode: deny`, meaning "the agent must find another path". Set it to `approve`, or use `--yolo` / `HERMES_YOLO_MODE=1`, to auto-approve. An MCP `spend_limit` is still refused when nobody can answer — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **Env vars that skip prompts or change behavior:**
  - `HERMES_YOLO_MODE=1`: same as `--yolo`. It cannot be written with `config set`; it is denylisted there.
  - `HERMES_ACCEPT_HOOKS`: auto-approves unseen shell hooks "without a TTY prompt" (same as `--accept-hooks` / `hooks_auto_accept: true`).
  - `HERMES_INFERENCE_MODEL`, `HERMES_IGNORE_USER_CONFIG`, `HERMES_IGNORE_RULES`, `HERMES_QUIET`, `HERMES_MAX_ITERATIONS`, `HERMES_TUI`, `HERMES_HOME`.
  - `SUDO_PASSWORD`; `HERMES_TUI_NO_CONFIRM=1` (skips the TUI's `/clear` confirmation) — [Environment Variables](https://hermes-agent.nousresearch.com/docs/reference/environment-variables); [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands); [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **Gateway lifecycle without a TTY:** `hermes gateway stop/restart` "With no terminal to ask on (scripts, cron) it refuses unless `--yes` is passed". `hermes update --yes` assumes yes and skips API-key entry. Non-interactive updates restore stashed local edits by default — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Containers and supervisors:** in Docker or under a wrapper supervisor, use `hermes gateway run`, with `--external-supervisor` when a wrapper owns the process. Restarts then exit 75 and expect the supervisor to relaunch — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Proxies and TLS:** Hermes uses `truststore`, which on Linux means the OpenSSL system trust paths. "For a corporate TLS proxy, install its root through your organization's operating-system trust procedure." `HERMES_CA_BUNDLE` is no longer used except for the Nous Portal login. `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE` are still read by `requests`/`urllib`, pip, uv, curl and Node. `HERMES_SKIP_SSL_GUARD` "has no effect". Custom providers can set `ssl_ca_cert`. "Provider HTTP clients keep proxy configuration separate from certificate selection" — [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- **PM and the proxy:** PM activates `truststore` before its HTTPS clients, so "No application dependencies or certificate-path override are required". It retries 408, 429 and 5xx responses up to 4 times. A package mirror can be set via `index-url` in `pip.conf` or `UV_INDEX_URL` — [Package management](https://hermes-agent.nousresearch.com/docs/reference/package-management)
- **IPv6:** when IPv6 is advertised but blackholed (common in containers), `hermes doctor` recommends `network.force_ipv4: true` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Update checks:** passive checks call the GitHub REST API at most once per 24 h, and internal git runs `ssh -o BatchMode=yes` so it never prompts — [Configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)

### Inferences
- For the target container (outbound HTTPS through a MITM proxy, with the CA in a bundle file), the safe move is to install that CA into the system store *before* running the installer: copy it to `/usr/local/share/ca-certificates/` and run `update-ca-certificates`. truststore, PM, uv and Node then all trust it. Keep `HTTPS_PROXY`/`HTTP_PROXY` exported. Standard proxy variables are honored by curl, git, uv and pip, and the docs mention them for the Desktop update check, but I found no single doc page listing proxy support for every Hermes component.
- A minimal headless smoke test after install: `hermes config set model.provider custom; hermes config set model.base_url …; hermes config set model.default …; hermes doctor; hermes -z "Reply with OK" ; echo $?`.

### Gaps
- I found no documented env var that answers `hermes setup` wizard questions beyond "environment values". Which values are read is not listed.
- The docs do not say how `hermes gateway ensure` behaves in a container with no systemd and no TTY beyond the "unmanaged gateway … stops itself once it has been idle" note, and they give no idle-timeout value.

---

## 7. Verifying an install, and common install-time errors with fixes

### Takeaway
Verify with `hermes --version`, `hermes doctor` (exit 0 means healthy), `hermes pm status` / `hermes pm doctor`, `hermes dump`, and then a real chat that uses a tool. The usual install failures are PATH not reloaded, missing `libatomic1` on minimal Ubuntu, download timeouts for the Python or Node runtimes, and old root-install layouts.

### Cited Findings
- **Post-install and post-update validation:** `git status --short`, `hermes doctor`, `hermes --version`, `hermes gateway status` and `hermes pm status` — [Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)
- **First chat success criteria:** "The banner shows your chosen model/provider; Hermes replies without error; It can use a tool if needed (terminal, file read, web search); The conversation continues normally for more than one turn". Then check that `hermes --continue` resumes. Suggested test prompts: "Summarize this repo in 5 bullets and tell me what the main entrypoint is." and "What's my disk usage? Show the top 5 largest directories." — [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
- **Scripted check:** `hermes -z "What's the capital of France?"` should print `Paris.` — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Recovery order:** `hermes doctor`, then `hermes model`, `hermes setup`, `hermes sessions list`, `hermes --continue`, and `hermes gateway status` — [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
- **`hermes dump` fields:** version (example `0.8.0 (2026.4.8) [af4abd2f]`), os, python, profile, hermes_home, model, provider, terminal, the api_keys set/not-set table, and features (toolsets, mcp_servers, gateway, skills) — [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- **Troubleshooting table:**
  - `hermes: command not found`: run `source ~/.bashrc`, or check `which hermes` / `ls ~/.local/bin/hermes`.
  - `API key not set`: run `hermes model` or `hermes config set OPENROUTER_API_KEY …`.
  - Missing config after update: run `hermes config check` and then `hermes config migrate` — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation); [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)
- **Permission denied during install:** "Don't use sudo with the installer — it installs to ~/.local/bin". If you previously installed with sudo, clean up with `sudo rm /usr/local/bin/hermes` and re-run the installer — [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)
- **`node: command not found` from the terminal tool (nvm, pyenv, asdf):** the snapshot uses `bash -l`. Add `terminal.shell_init_files: [~/.nvm/nvm.sh, …]` — [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)
- **Unsupported Python version:** current installs require Python 3.14. Use the installer's pinned interpreter, and "Do not replace the interpreter inside an installed app or container" — [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)
- **`uv: command not found`:** the FAQ suggests `curl -LsSf https://astral.sh/uv/install.sh | sh`. Note that the current installer always uses its own pinned uv — [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq); [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Issue #87460 (closed 2026-08-31, fixed by PR #99481):** on minimal Ubuntu, `install.sh` "aborts with exit 127 and no error output at all", because Node 26 links `libatomic.so.1`. Fix: `apt-get install -y libatomic1`. The installer now installs the package itself — [Issue #87460](https://github.com/NousResearch/hermes-agent/issues/87460); [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Issue #21457 (opened 2026-05-07, closed, fixed by PRs #27124 and #33467):** a root-mode install used the old FHS layout (`/usr/local/lib/hermes-agent/venv`, `/usr/local/bin/hermes`) with a venv Python under `/root/.local/share/uv/python`. Non-root users then got "bad interpreter: Permission denied". The workaround was `UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python UV_PYTHON_BIN_DIR=/usr/local/share/uv/bin`. The current docs say root installs now use root's home, not FHS — [Issue #21457](https://github.com/NousResearch/hermes-agent/issues/21457); [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Issue #10778 (opened 2026-04-16, closed 2026-09-12):** the installer timed out downloading `python-build-standalone` from GitHub releases ("Failed to download … operation timed out"). This was from the era when it installed Python 3.11. The fix referenced is reusing an installed Python (PR #10824 or #109122) — [Issue #10778](https://github.com/NousResearch/hermes-agent/issues/10778)
- **Issue #89624:** a fresh `install.sh` aborted because `git clone` failed with HTTP 429. I saw only the search snippet, not the resolution — [Issue #89624](https://github.com/NousResearch/hermes-agent/issues/89624)
- **Corrupt packages and interrupted installs:** for "The wheel is invalid" or "RECORD file is invalid", run `hermes pm doctor --repair`; for damaged dependencies, run `hermes pm repair` and restart. If an update was interrupted, check `tail -f ~/.hermes/logs/update.log` — [Package management](https://hermes-agent.nousresearch.com/docs/reference/package-management); [Updating](https://hermes-agent.nousresearch.com/docs/getting-started/updating)
- **Symlinked or unavailable storage:** if `HERMES_HOME` or a subdirectory is a link with a missing target, initialization stops with a storage error and Hermes does not recreate the target. `hermes setup` is not the fix — [Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- **Docker terminal backend not connecting:** run `docker info`, `sudo usermod -aG docker $USER` and `docker run hello-world`, or fall back to the local backend — [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq)

### Inferences
- Behind the target environment's proxy, downloads are the riskiest step. Those are the GitHub clone, the uv pin, python-build-standalone, Node and Chromium (Chrome for Testing). PM retries transient errors, but a TLS failure is "permanent" and is not retried. That is another reason to install the proxy CA into the system store first. `--skip-browser` removes the Chromium download if browsing is not needed.

### Gaps
- No doc page shows real `hermes doctor` output; I recorded only its checks and exit codes.
- I could not fetch the full GitHub issue list (the API is blocked). The issues above come from a web search, so other common errors may be missing.
