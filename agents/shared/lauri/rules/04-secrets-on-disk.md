# Credentials on disk

**Applies when:** you open a `.env`, a config or state file that may hold
credentials, or you treat a directory as safe scratch space for tooling.

## Reading

- Key names are fine to read and mention (`GH_PAT`, `OPENAI_API_KEY`). **Values
  are not.** Do not print, echo, log, copy, or paste them — not into a summary,
  not into a commit, not into an example, not into a test fixture. If you need to
  show that a value exists, show `GH_PAT=<set>`.
- Do not use a credential you found, even for a "quick" call. Ask first.
- When scanning files, redact as you go: `sed 's/=.*/=<redacted>/'` before
  anything reaches your context or the user's screen.

## Reporting

- If a live credential sits in a project directory, say so plainly and promptly:
  which file, which key name, whether it is tracked by git, and that it should be
  **rotated** — a secret that was ever on disk in a working tree should be treated
  as exposed, whether or not it was committed.
- Check whether it is actually ignored before saying "it's not in git":
  `git check-ignore -v <file>` and `git log --all -- <file>`.
- Never make a secret's exposure worse while investigating it: no `git add -f`,
  no copying it to a scratch file, no pasting it into a URL.

## Handling

- Keep credentials out of the repository entirely: `.env` (ignored) plus
  `.env.example` (committed, placeholders only) is the pattern.
- A git-ignored `.env` is *not* safe from other software: agents, editors,
  backup tools, indexers and anything else that reads the directory can see it.
  Scratch space is not a vault.
- Don't add a credential to make a test pass. If a test needs one, it should skip
  when unset, and say so.
- If you must create a file that will hold a secret, create it in the user's
  designated secret store, not in the repo — and tell the user where it went.
