# Lauri's shared scripts

Runnable helpers that earned their place by answering a question I actually had.
They are kept here so they can be committed and reused instead of living in an
ignored scratch folder and being rewritten next time.

## Running them

From the **project root** (they import that project's `src/` four levels up):

```powershell
npx tsx agents/shared/lauri/scripts/verify-built-package.ts <source.package> <built.package> [translations.json]
npx tsx agents/shared/lauri/scripts/dbpf-index-scan.ts "<game root>" [type-hex] [instance-hex]
npx tsx agents/shared/lauri/scripts/stbl-syntax-survey.ts <package> [max-shapes]
npx tsx agents/shared/lauri/scripts/translation-coverage.ts <catalog.json>
```

## What each one is for

| Script | Question it answers |
| --- | --- |
| `verify-built-package.ts` | Does the artifact match the input exactly, with only the differences I intended? Reports counts and a byte-level read, and exits non-zero on surprise. |
| `dbpf-index-scan.ts` | Does any installed package ship the resource I am overriding? Reads only headers and indexes, so it scans a whole installation in seconds. Self-contained (no project imports). |
| `stbl-syntax-survey.ts` | What token syntax actually occurs in this file? Run this *before* writing validation rules rather than assuming which placeholders exist. |
| `translation-coverage.ts` | What share of the catalog can the current rules translate, and why is the rest deferred? |
| `install-project-instructions.ps1` | Load my rules into a tool that only reads repo files, without committing anything. See below. |

## install-project-instructions.ps1

Run it from the project root (PowerShell 5.1 or 7):

```powershell
pwsh -File agents/shared/lauri/scripts/install-project-instructions.ps1
pwsh -File agents/shared/lauri/scripts/install-project-instructions.ps1 -RepoPath C:\src\team-repo -WhatIf
pwsh -File agents/shared/lauri/scripts/install-project-instructions.ps1 -Undo
```

It writes `AGENTS.md`, `CLAUDE.md` and `.github/copilot-instructions.md` as small
pointer files that name where the rules live, then registers each path in
`.git/info/exclude`. Consequences worth knowing:

- the files never appear in `git status` and can never be committed by accident;
- `.gitignore` — which *is* tracked — is not modified, so nothing shows up in
  anyone's diff;
- a path that git already tracks, or that already exists without the script's
  sentinel comment, is skipped and reported, never overwritten;
- `-Undo` removes only files carrying the sentinel, and says so if one has since
  become tracked.

Tested against scratch repositories for: fresh install, re-run (idempotent),
a teammate's committed `AGENTS.md` (left byte-identical), an untracked foreign
`AGENTS.md` (left alone), and undo (files and created directories removed).


## Portability

These are written against this project's `src/` layout (`../../../../src/...`) and
import its reader modules on purpose — the point is to check the artifact with
the same code the tool uses, plus one independent byte-level reader. If you copy
one into another project, fix the import depth or move it into that project's
test tree.

The *rules* in `../rules/` are the portable part; the scripts are conveniences.
