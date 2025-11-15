# Agent Instructions

<shared>
# AGENTS.md

Shared guardrails distilled from the various `~/Projects/*/AGENTS.md` files (state as of **November 15, 2025**). This document highlights the rules that show up again and again; still read the repo-local instructions before making changes.

## Codex Global Instructions
- Keep the system-wide Codex guidance at `~/.codex/AGENTS.md` (the Codex home; override via `CODEX_HOME` if needed) so every task inherits these rules by default.

## General Guardrails

### Intake & Scoping
- Open the local agent instructions plus any `docs:list` summaries at the start of every session. Re-run those helpers whenever you suspect the docs may have changed.
- Review any referenced tmux panes, CI logs, or failing command transcripts so you understand the most recent context before writing code.

### Tooling & Command Wrappers
- Use the command wrappers provided by the workspace (`./runner …`, `scripts/committer`, `pnpm mcp:*`, etc.). Skip them only for trivial read-only shell commands if that’s explicitly allowed.
- Stick to the package manager and runtime mandated by the repo (pnpm-only, bun-only, swift-only, go-only, etc.). Never swap in alternatives without approval.
- When editing shared guardrail scripts (runners, committer helpers, browser tools, etc.), mirror the same change back into the `agent-scripts` folder so the canonical copy stays current.
- Ask the user before adding dependencies, changing build tooling, or altering project-wide configuration.

### tmux & Long Tasks
- Run any command that could hang (tests, servers, log streams, browser automation) inside tmux using the repository’s preferred entry point.
- Do not wrap tmux commands in infinite polling loops. Run the job, sleep briefly (≤30 s), capture output, and surface status at least once per minute.
- Document which sessions you create and clean them up when they are no longer needed unless the workflow explicitly calls for persistent watchers.

### Build, Test & Verification
- Before handing off work, run the full “green gate” for that repo (lint, type-check, tests, doc scripts, etc.). Follow the same command set humans run—no ad-hoc shortcuts.
- Leave existing watchers running unless the owner tells you to stop them; keep their tmux panes healthy if you started them.
- Treat every bug fix as a chance to add or extend automated tests that prove the behavior.

### Code Quality & Naming
- Refactor in place. Never create duplicate files with suffixes such as “V2”, “New”, or “Fixed”; update the canonical file and remove obsolete paths entirely.
- Favor strict typing: avoid `any`, untyped dictionaries, or generic type erasure unless absolutely required. Prefer concrete structs/enums and mark public concurrency surfaces appropriately.
- Keep files at a manageable size. When a file grows unwieldy, extract helpers or new modules instead of letting it bloat.
- Match the repo’s established style (commit conventions, formatting tools, component patterns, etc.) by studying existing code before introducing new patterns.

### Git, Commits & Releases
- Invoke git through the provided wrappers, especially for status, diffs, and commits. Only commit or push when the user asks you to do so.
- Follow the documented release or deployment checklists instead of inventing new steps.
- Do not delete or rename unfamiliar files without double-checking with the user or the repo instructions.

### Documentation & Knowledge Capture
- Update existing docs whenever your change affects them, including front-matter metadata if the repo’s `docs:list` tooling depends on it.
- Only create new documentation when the user or local instructions explicitly request it; otherwise, edit the canonical file in place.
- When you uncover a reproducible tooling or CI issue, record the repro steps and workaround in the designated troubleshooting doc for that repo.

### Troubleshooting & Observability
- Design workflows so they are observable without constant babysitting: use tmux panes, CI logs, log-tail scripts, MCP/browser helpers, and similar tooling to surface progress.
- If you get stuck, consult external references (web search, official docs, Stack Overflow, etc.) before escalating, and record any insights you find for the next agent.
- Keep any polling or progress loops bounded to protect hang detectors and make it obvious when something stalls.

### Stack-Specific Reminders
- Start background builders or watchers using the automation provided by the repo (daemon scripts, tmux-based dev servers, etc.) instead of running binaries directly.
- Use the official CLI wrappers for browser automation, screenshotting, or MCP interactions rather than crafting new ad-hoc scripts.
- Respect each workspace’s testing cadence (e.g., always running the main `check` script after edits, never launching forbidden dev servers, keeping replies concise when requested).

## Swift Projects
- Kick off the workspace’s build daemon or helper before running any Swift CLI or app; rely on the provided wrapper to rebuild targets automatically instead of launching stale binaries.
- Validate changes with `swift build` and the relevant filtered test suites, documenting any compiler crashes and rewriting problematic constructs immediately so the suite can keep running.
- Keep concurrency annotations (`Sendable`, actors, structured tasks) accurate and prefer static imports over dynamic runtime lookups that break ahead-of-time compilation.
- Avoid editing derived artifacts or generated bundles directly—adjust the sources and let the build pipeline regenerate outputs.
- When encountering toolchain instability, capture the repro steps in the designated troubleshooting doc and note any required cache cleans (DerivedData, SwiftPM caches) you perform.

## TypeScript Projects
- Use the package manager declared by the workspace (often `pnpm` or `bun`) and run every command through the same wrapper humans use; do not substitute `npm`/`yarn` or bypass the runner.
- Start each session by running the repo’s doc-index script (commonly a `docs:list` helper), then keep required watchers (`lint:watch`, `test:watch`, dev servers) running inside tmux unless told otherwise.
- Treat `lint`, `typecheck`, and `test` commands (e.g., `pnpm run check`, `bun run typecheck`) as mandatory gates before handing off work; surface any failures with their exact command output.
- Maintain strict typing—avoid `any`, prefer utility helpers already provided by the repo, and keep shared guardrail scripts (runner, committer, browser helpers) consistent by syncing back to `agent-scripts` when they change.
- When editing UI code, follow the established component patterns (Tailwind via helper utilities, TanStack Query for data flow, etc.) and keep files under the preferred size limit by extracting helpers proactively.

Keep this master file up to date as you notice new rules that recur across repositories, and reflect those updates back into every workspace’s local guardrail documents.
</shared>

This repository relies on autonomous agents to run the `oracle` CLI safely. When you update the runner or CLI behavior, add a short note here so future agents inherit the latest expectations. These guidelines supplement the existing system/developer instructions.

## Current Expectations

- **NPM publishes require explicit user approval per release.** Never publish to npm unless the user authorizes that specific release; one approval covers one publish only.
- When a user pastes a CLI command that is failing and you implement a fix, only execute that command yourself as the *final* verification step. (Skip the rerun entirely if the command would be destructive or dangerous—ask the user instead.)
- Browser runs now exist (`oracle --browser`). They spin up a Chrome helper process, log its PID in the session output, and shouldn't be combined with `--preview`. If you modify this flow, keep `docs/browser-mode.md` updated.
- Browser mode now uploads every `--file` path individually via the ChatGPT composer (system/user text stays inline). The automation waits for uploads to finish before hitting submit. Use `--browser-inline-files` as a debug escape hatch when you need to fall back to pasting file contents, and keep this note + `docs/browser-mode.md` updated if the behavior changes.
- **Commits go through `scripts/committer`** – whenever you need to stage/commit, run `./scripts/committer "your message" path/to/file1 path/to/file2`. Never call `git add`/`git commit` directly; the helper enforces the guardrails used across repos.
- Browser mode inherits the `--model` flag as its picker target—pass strings like `--model "ChatGPT 5.1 Instant"` to hit UI-only variants; canonical API names still map to their default labels automatically. Cookie sync now defaults to Chrome's `"Default"` profile so you stay signed in unless you override it, and the run aborts if cookie copying fails (use the hidden `--browser-allow-cookie-errors` override only when you truly want to proceed logged out).
- Headful debugging: if you need to inspect the live Chrome composer, run the browser command inside `tmux` with `--browser-keep-browser`, note the logged DevTools port, and hook up `chrome-devtools-mcp` (see `docs/manual-tests.md` for the full checklist).
- Need ad‑hoc browser control? Use `pnpm tsx scripts/browser-tools.ts --help` for Mario Zechner–style start/nav/eval/screenshot tools before reaching for MCP servers.
- Browser-mode token estimates now explicitly state when inline files are included or when attachments are excluded; leave that log line intact so users understand whether file uploads affected the count.
- Use `--dry-run` when you just need token/file summaries—Commander now enforces `--prompt` automatically, and the dry-run output should show inline vs attachment handling for browser mode.
- For local testing you can set `ORACLE_NO_DETACH=1` to keep the CLI runner inline instead of spawning a detached process (the integration suite relies on this).
- **Always ask before changing tooling** – package installs, `pnpm approve-builds`, or swaps like `sqlite3` → `@vscode/sqlite3` require explicit user confirmation. Suggest the change and wait for approval before touching dependencies or system-wide configs.
- **Interactive prompts** – when you must run an interactive command (e.g., `pnpm approve-builds`, `git rebase --interactive`), start a `tmux` session first (`tmux new -s oracle`) so the UI survives and the user can attach if needed.
- **tmux etiquette** – tmux is how we detect runs that hang. Never wrap it in polling loops like `while tmux has-session …`; that defeats the safety net. If you need to check progress, grab the pane output, `sleep`, and re-check manually instead of blocking the terminal with a loop.
- **Unattended-friendly debugging** – every workflow should be end-to-end debuggable without babysitting. If you can’t make a run observable unattended (e.g., need a debugger port or special tooling), pause and tell the operator exactly what’s missing so they can unblock you instead of guessing.
- **Release hygiene** – when prepping npm releases, follow `docs/release.md` rather than improvising. If anything in the checklist is unclear or blocked, surface it early.
- **Respect existing files** – do not delete or rename folders/files you don’t recognize. Other agents (or humans) are working here; ask before removing shared artifacts like `config/`.
- `oracle session --clear --hours <n>` (hidden alias: `--clean`) now mirrors `oracle status --clear` for pruning cached runs, and `oracle status` prints a tip pointing to it—use that flag instead of manipulating `~/.oracle` manually.
- CLI + tooling should read the version via `getCliVersion()` (`src/version.ts`) instead of hard-coding strings; the helper also powers the new `oracle --version` regression test.
- GPT-5 Pro API sessions now force `background: true` + `store: true`, poll for up to 30 minutes, and auto-log when the CLI reconnects after a transport drop. Non-Pro models still stream in the foreground.
- Whenever you are stuck, consider asking the oracle: `npx @steipete/oracle --prompt "Explain what this error means" --file path/to/log.txt`.
