# Windows paths and shells

**Applies when:** you write paths, compare paths, quote arguments, or run shell
commands on Windows (this machine: Windows 11, PowerShell primary, Git Bash also
available).

## Quoting and arguments

- Paths contain spaces (`C:\Program Files (x86)\…`, `…\Electronic Arts\…`). Quote
  every path you pass, in every language and every shell.
- `npm run <script> -- <args>`: everything after `--` goes to the script. Without
  it, npm eats your flags. With `--silent`, npm's own chatter goes away but the
  exit code still propagates.
- PowerShell and Bash do not share syntax. `$env:VAR` vs `VAR=x cmd`,
  `` ` `` vs `\`, `;` vs `&&`. Pick one and stay in it for a whole command.
- When a command must run from a specific directory, prefer passing a working
  directory or absolute paths over `cd` chaining — `cd` in a compound command can
  surprise permission prompts and leaves state behind.

## Comparing paths

- Windows paths are case-insensitive: compare `path.resolve(a).toLowerCase()`
  against the same for `b`, never raw strings.
- `path.resolve` does not resolve junctions, symlinks or 8.3 short names.
  For files that exist, use `fs.realpathSync.native` before comparing — this
  matters for OneDrive-redirected folders (`Documents` is often one) and for
  `C:\Users\alice\…` vs `C:\Users\Alice\…`.
- For a path that does not exist yet (an output file), canonicalise its closest
  existing ancestor and re-join the rest, rather than skipping the check.
- To test "is A inside B", resolve both, then compare with a trailing separator —
  `C:\Mods2` starts with `C:\Mods` as a string but is not inside it.

## File semantics that differ from Unix

- A file opened by another process (editor, antivirus scanner, indexer) can fail
  to rename with `EPERM`, even when you have write permission.
- Read-only files: `chmod 0o444` sets the read-only attribute, and renaming over
  such a file fails with `EPERM` while the original content survives. Useful for
  testing failure paths.
- `fs.rmSync(dir, { recursive: true, force: true })` fails on read-only contents
  unless the permissions are restored first — clean up in a `finally`.
- Use `pathToFileURL()` when a tool expects a URL: `node --import "C:\…\x.mjs"`
  fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME` (drive letters parse as a scheme).
  Standalone tools cannot be spawned if they live in a project the process was
  not started in — pass absolute paths or URLs, never rely on the child's `cwd`
  to resolve your tooling.

## Line endings and encoding

- Write text files explicitly as UTF-8 (`writeFileSync(path, text, "utf8")`);
  some cmdlets default to the system codepage and will mangle Estonian or other
  non-ASCII text.
- Node writes UTF-8 to a Windows console TTY correctly (it converts through the
  console API), so non-ASCII output is fine in Windows Terminal; it is legacy
  consoles and piped-then-reinterpreted output that mangle it.
- Don't mix `\r\n` and `\n` in files you generate and then diff; pick one.
