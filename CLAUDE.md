# Sims 4 Eesti — contributor notes for coding agents

Builds an unofficial Estonian text mod for The Sims 4 from the English string
files on the machine it runs on. Phase 1 (extract → set → validate → build →
deploy) is implemented; see `README.md` for the user-facing how-to,
`IMPLEMENTATION_NOTES.md` for the measured findings, and
`Sims4_Eesti_Implementation_Brief.md` for the specification. **Phase 2+ is
designed but must not be built yet.**

This file is part of the repository and loads in every contributor's session. If
you want to layer your own instructions on top, use `CLAUDE.local.md` (gitignored)
or your user-level config — both load alongside this file.

## Commands

```powershell
npm ci                                  # no build step: tsx runs the TypeScript directly
npm test                                # 89 tests, synthetic fixtures, no game files
npx tsc --noEmit                        # strict typecheck; do this before claiming done

# Opt-in integration tests against a real package (skipped, not passed, without it)
$env:SIMS4_EESTI_SOURCE_PACKAGE="<path to Strings_ENG_US.package>"
npm run test:game

npm run cli -- <extract|search|set|build|deploy> --help
```

`npm run cli --` needs the `--` — everything after it is passed to the tool.
Paths contain spaces: quote them.

## Invariants — do not break these

1. **The game installation and saves are read-only.** No patching executables, no
   writing into the game folder or the Documents user folder except a single
   explicit `deploy` into a user-specified Mods folder. Never launch or kill the
   game, never delete caches, never touch `Resource.cfg` or other mods.
2. **No game data in git.** `work/` (extracted catalogs) and `dist/` (built
   packages) are ignored. Test fixtures are *generated in code* under
   `tests/helpers.ts` — never commit a `.package` or extracted game text.
3. **Only `src/package-io.ts` imports `@s4tk/models`** (pinned to `0.6.14`;
   `@s4tk/compression` `0.2.0`). Everything else uses the plain structures it
   returns. Don't write a DBPF parser or a compression implementation;
   `src/stbl-format.ts` is a payload-only reader that exists solely for
   independent verification.
4. **Instance IDs travel as `bigint`**, printed as fixed-width uppercase hex (8
   digits for type/group/string key, 16 for instance). Real values exceed
   `Number.MAX_SAFE_INTEGER`; converting through `number` corrupts them.
5. **Translations are addressed by occurrence ID**
   (`PACK|TYPE:GROUP:INSTANCE|KEY`), never by English text, text hash, or table
   position.
6. **Secrets stay local.** `.env` and `claude-deepseek-windows.sh` hold credentials:
   git-ignored, and blocked by `githooks/pre-commit` along with any
   credential-shaped content. Never commit them, never `git add -f` them, and
   never bypass the hook with `--no-verify`.

## Library traps already diagnosed (don't rediscover these)

- EA ships the string table **internally compressed (`0xFFFF`)**, which
  `@s4tk/compression` can decompress but *cannot* write. Reading a package copies
  that compression type onto the model, so serializing throws until
  `defaultCompressionType` is set to `CompressionType.ZLIB` (`0x5A42`). We emit
  ZLIB, and the manifest says so.
- The STBL **per-entry flag byte is dropped** by the library (skipped on read,
  written as 0). Measured: 0 of 58,374 entries use it in the base game file. The
  tool reports `nonZeroFlagEntries` rather than silently losing it.
- `MappedModel.equals()` is **O(n²)** — it took ~5 minutes on a 58k-entry table.
  Compare entries index by index instead.
- The header's `mnStringLength` is recomputed; it follows EA's own convention
  (sum of entry byte lengths + 1 per entry), verified against the original file.
- Verification must not reuse the writer's code path: the build re-reads the
  output with the library *and* with `src/stbl-format.ts`, compares every entry
  against intent, and refuses to publish the artifact if anything differs.

## Translation policy (conservative by design)

`src/validation.ts` decides what may be applied. The rules come from a survey of
the real 58,374-entry table (see `IMPLEMENTATION_NOTES.md`), not from assumption:

- Supported placeholders are a **closed whitelist** (`{0.SimFirstName}`,
  `{1.String}`, `{0.Number}`, `{0.Money}`, `{0.SimName}`, `{0.ObjectName}`,
  `{0.TimeShort}`, `{0.Timespan}`, `{0.DayOfWeekShort}`, `{0.DayOfWeekLong}`).
  Preserve them as a **multiset** — reordering is allowed, losing or adding a
  repetition is not.
- **Deferred, left in English:** gender/plural branches (`{M0.his}`, `{F0.she}`),
  pronoun expressions (`{0.SimPronounSubjective}`), HTML-like markup (`<span>`,
  `<b>`, `<font>`), unbalanced or nested braces. They carry source-language
  grammar or unmodelled reflow rules; freezing them would leave English words in
  Estonian sentences.
- Also rejected: stale source hashes, unknown IDs, malformed metadata, empty
  replacements of non-empty text, English copied verbatim (not counted as a
  translation), unpaired surrogates, control characters, changed surrounding
  whitespace, and entries over 65,535 UTF-8 **bytes**.
- Never treat `%` as a formatting token. Never reject a whole table because one
  untranslated entry has complex syntax.

## Claims this project may and may not make

- **Never claim the in-game gate passed.** It is manual, listed in `README.md`,
  and has not been run. Package integrity is verified; game behaviour is not.
- **Never invent** resource IDs, game versions, test results, or observations.
  `build --game-version` records a version only when supplied; otherwise the
  manifest says "not recorded".
- **Machine-drafted text is never recorded as human work.** Use
  `set --state machine --origin machine`; the manifest reports `reviewedApplied: 0`
  until a human reviews something.
- Report exclusions and limitations in the build output and manifest rather than
  quietly dropping data. A skipped test is not a pass.
- Keep the built package private pending a distribution review; it contains the
  English fallback text of the overridden table.

Shell scripts (`githooks/*`, `*.sh`) must keep LF endings. `.gitattributes`
pins that inside git, but editors on Windows write CRLF into the worktree — check
with `git ls-files --eol <path>` after editing one, and normalise if it shows
`w/crlf`.

## Layout and build strategy

`src/cli.ts` (commands) · `package-io.ts` (library adapter) · `catalog.ts`
(extract/search) · `translations.ts` (text + metadata storage) · `validation.ts`
(policy) · `build.ts` (whole-table override + verification) · `deploy.ts` (one-file
install) · `ids.ts`, `hashing.ts`, `stbl-format.ts`. Tests mirror these modules.

For each affected table, start from the **complete original English table**,
replace only eligible entries, and emit only affected tables. The English text of
untranslated entries is the fallback — do not assume the game falls through to the
original resource for missing entries.
