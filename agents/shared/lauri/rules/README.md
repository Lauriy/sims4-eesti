# Lauri's shared agent rules

Portable working rules for coding agents, kept out of any single project so the
same file can be pointed at from Codex, Claude Code, or anything else.

## How these are meant to be used

- **One concern per file.** A rule file is small enough to read in a minute and
  specific enough to act on.
- **The first line after the title says when it applies** (`Applies when: …`), so
  an agent — or a person skimming — can tell in one line whether it is relevant.
- **Reference them from your own configuration, never from a shared file.** Point
  at them from user-level agent config (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`)
  or, for tools that only read files inside a repository, from the git-excluded
  pointers that `../scripts/install-project-instructions.ps1` creates. Do **not**
  add pointers to a committed `CLAUDE.md`/`AGENTS.md`: that would load your
  personal rules in every collaborator's session.
- **They are written to be true regardless of language or stack.** Anything
  project-specific belongs in that project's own documentation instead — or in
  the project's own copy of this directory, which only your configuration reads.

## How these load

See `../../README.md` for the full picture and what has been verified per tool.
In short: `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` point at this directory
automatically in every session, and
`../scripts/install-project-instructions.ps1` handles tools that can only read
files inside a repository — without committing anything.

## The rules

| File | Applies when |
| --- | --- |
| [00-verification.md](00-verification.md) | You are about to claim something works |
| [01-windows-paths.md](01-windows-paths.md) | Writing file paths, comparisons or shell commands on Windows |
| [02-binary-formats.md](02-binary-formats.md) | Editing any binary format through a third-party library |
| [03-dont-claim-unverified.md](03-dont-claim-unverified.md) | Reporting results to the user |
| [04-secrets-on-disk.md](04-secrets-on-disk.md) | You meet a credential, `.env`, or a directory you were told is scratch space |

Sibling directories: `scripts/` holds runnable helpers, `skills/` holds
Claude Code skill packages (see their own READMEs).
