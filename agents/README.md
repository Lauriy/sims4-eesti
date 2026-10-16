# Lauri's personal agent setup

Personal instructions, rules, scripts and skills that load into AI coding agents
**without putting files into repositories** — so nothing I add ever collides with
another developer's `AGENTS.md`, `CLAUDE.md`, or Copilot instructions.

## Two locations

| Location | Role |
| --- | --- |
| `%USERPROFILE%\agents\shared\lauri\` | **Canonical copy**, outside every repo. User-level agent config points here, so the rules load even in projects that do not carry their own. Refresh with `-SyncGlobal` (below). |
| `<project>\agents\shared\lauri\` | A project's **own copy** — may extend or override the canonical one. First in the search order. |

```
agents/
  README.md              <- this file: how it loads, and what was verified
  shared/lauri/
    rules/               <- the rules (00 and 03 always-on, others conditional)
    scripts/             <- runnable helpers, including the installer/sync script
    skills/              <- reusable skill packages
```

## How the rules reach an agent

| Tool | Mechanism | Status |
| --- | --- | --- |
| **Claude Code** | `~/.claude/CLAUDE.md` **imports** `rules/00-verification.md` and `rules/03-dont-claim-unverified.md` from the canonical copy (`@C:/…` paths), and points at the project's copy for the three conditional rules (`01`, `02`, `04`). Imports in user-scope memory load at launch, from any path, without an approval prompt. | **Verified** on this machine: a fresh headless session in an unrelated directory (`claude -p`) listed both rule titles as already in context and correctly reported that the conditional three were *not* loaded. |
| **Codex** | `~/.codex/AGENTS.md` — read in every project and merged with the project's own `AGENTS.md`. | **Verified**: `codex debug prompt-input` shows the content in the model-visible prompt (16,374 → 18,563 bytes). With a project `AGENTS.md` present, both load and the global one comes first, so **project instructions come later and take precedence**. |
| **Copilot (VS Code)** | User-profile instruction files: `%APPDATA%\Code\User\prompts\*.instructions.md`, or `~/.copilot/instructions/`, configurable via `chat.instructionsFilesLocations`. Personal scope sits below repository scope. The older `github.copilot.chat.codeGeneration.instructions` setting could not reference files outside the workspace and is deprecated. | **Documented only** — VS Code and Copilot are not installed on this machine, so nothing here was tested against them. |
| **Anything that only reads repo files** | `scripts/install-project-instructions.ps1` writes `AGENTS.md`, `CLAUDE.md` and `.github/copilot-instructions.md` into a repo as small pointer files and registers them in `.git/info/exclude`. Git never shows or commits them, `.gitignore` is not touched, and the script refuses to touch a file that is tracked or that it did not create. | **Verified** against scratch repos: fresh install (`git status` clean, three pointer files, no `.gitignore`), re-run (idempotent, same hashes), a teammate's committed `AGENTS.md` (left byte-identical), an untracked foreign `AGENTS.md` (left alone), `-Undo` (files and created directories removed). |

### Why the two always-on rules are imported and the rest are not

`00` and `03` apply to every session by definition — verification discipline and
honest reporting. Importing them costs about 3.4 KB of context and removes the
agent's discretion to skip them.

`01`, `02` and `04` are conditional (Windows paths, binary formats, credentials).
Loading those everywhere would add roughly 7 KB to every session for rules that
rarely apply, so the global file names their triggers and the agent reads the
relevant one. **That part is a pointer, not a load** — it depends on the agent
following instructions.

Two stronger alternatives, deliberately not used:

- `~/.claude/rules/*.md` loads **every** file placed there in every session, with
  no pointer and no repo files. Clean, but it would load the conditional rules
  everywhere too, and it needs copies or a junction rather than reading the
  canonical files directly.
- A `SessionStart` hook in `~/.claude/settings.json` can inject `additionalContext`
  conditionally per project (checking for `agents/shared/lauri/rules/` first).
  More machinery, more that can fail silently, and `additionalContext` is capped
  at 10,000 characters.

### One correction to keep in mind

Claude Code **concatenates** instruction files rather than applying a strict
precedence order, and the documentation warns that conflicting instructions may be
resolved either way. "The project wins" is therefore a convention written into the
files, not something the loader enforces. If something must never happen, it
belongs in a permission rule or a hook, not in a memory file. (Codex is different:
its merge order is deterministic, and the project file genuinely comes last.)

## Verifying it is actually loaded

Presence in a config directory is not proof. What to run:

- **Claude Code**: `/context` lists the memory files that loaded at launch; run it
  in a scratch directory to confirm `~/.claude/CLAUDE.md` and both imports appear.
  The `InstructionsLoaded` hook logs every load with its reason and parent file.
- **Codex**: `codex debug prompt-input "hi"` prints the model-visible prompt as
  JSON; grep it for a line from your instructions.
- **The installer**: it prints the exact paths it created or skipped, then tells
  you to check `git status` — do that, since "excluded" is the whole point.

## Adopting this in a new project

1. Copy `agents/shared/lauri/` into the project (it becomes the project's copy).
2. If a tool only reads repo files, run:
   ```powershell
   pwsh -File agents/shared/lauri/scripts/install-project-instructions.ps1
   ```
3. After editing rules, refresh the canonical copy so other projects see them:
   ```powershell
   pwsh -File agents/shared/lauri/scripts/install-project-instructions.ps1 -SyncGlobal
   ```

## What is deliberately not here

- **No hooks, no daemon, no background syncing.** Every mechanism above is a file
  in a user-level config directory that the tool already reads.
- **No instruction files committed to repositories.** The only files written into
  a repo are the git-excluded pointer files, and only when asked for.
- **No credentials.** `.env` files stay where they are;
  `rules/04-secrets-on-disk.md` explains how agents should handle them.
