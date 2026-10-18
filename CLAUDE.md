# Sims 4 Eesti — contributor notes for coding agents

Builds an unofficial Estonian text mod for The Sims 4 from the English string
files on the machine it runs on. Phase 1 (extract → set → validate → build →
deploy) is complete and verified in game. Beyond it, and directed by the owner
rather than by the brief's original phase limit: an install-wide catalog, batch
translation with reference languages and a self-checking glossary, and the
sequencing of the bulk run in `RUN_PLAN.md`. See `README.md` for the user-facing
how-to, `IMPLEMENTATION_NOTES.md` for the measured findings, and
`Sims4_Eesti_Implementation_Brief.md` for the original specification.

This file is part of the repository and loads in every contributor's session. If
you want to layer your own instructions on top, use `CLAUDE.local.md` (gitignored)
or your user-level config — both load alongside this file.

## Commands

```powershell
npm ci                                  # no build step: tsx runs the TypeScript directly
npm test                                # synthetic fixtures, no game files needed
npx tsc --noEmit                        # strict typecheck; do this before claiming done

# Opt-in integration tests against a real package (skipped, not passed, without it)
$env:SIMS4_EESTI_SOURCE_PACKAGE="<path to Strings_ENG_US.package>"
npm run test:game

npm run cli -- <extract|scan|merge|search|set|build|deploy|translate-export|translate-import|glossary-check|lint|rank> --help
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

- Runtime values are preserved as a **multiset** — reordering is allowed, losing
  or adding a repetition is not. The name list is closed and measured (44 names
  over 75,340 strings: `{0.SimFirstName}`, `{1.String}`, `{0.Number}`,
  `{0.Money}`, `{0.ObjectName}`, `{0.Points}`, `{0.DateShort}`, …).
- **Variant branches are translated, not deferred.** `{M0.his}{F0.her}` (gender),
  `{S0.is}{P0.are}` (number), `{T1.Mess Around}{DAE1.WooHoo}` (wording style).
  The text after the dot is translated; the `{X0.}` marker is kept. The validator
  requires every group — consecutive branches sharing an index — to be kept whole
  or **dropped whole**, on any axis. Dropping is what EA's Finnish does: it deletes
  gender pairs (`{M1.his}{F1.her} dreams?` → `…unelmansa?`) and drops one of two
  number groups in the same string. Half a group is refused — the missing variant
  would render with no text. The order *inside* a group does not matter:
  `{M0.his}{F0.her}` and `{F0.her}{M0.his}` render the same two texts for the same
  two genders, so either order is accepted.
- **Branch content that is a value name is a reference, not text:**
  `{P0.ObjectName}`, `{S2.{S3.ObjectName}}` stay exactly as written (Finnish keeps
  them too). Everything else in a branch is literal text (`{S0.Pack}` →
  `{S0.paketti}`). Measured: the only CamelCase content in the whole catalog that
  is *not* a value name is `WooHoo`, which Finnish translates.
- **Markup tags are preserved character for character** (`<b>`, `<span
  class="…">`, `<font color="…">`, `<i>`, `<ul>`, `<li>`, `<a href="…">`), as a
  multiset; only the text between them is translated. Finnish keeps them identical
  in 1,300 of 1,446 comparable strings, and the 146 exceptions (a localized legal
  URL, a dropped `<span class="money">`) are refused rather than guessed at.
- **Pronouns the game would render in English may be replaced by a word.**
  `{0.SimPronounSubjective|xxUpper} can also Mentor others` → `Ta võib ka teisi
  õpetada`. Dropping is allowed for the pronoun family and `SimNameAndPronouns`
  only, never for a value that carries data (a number, a name, a date). Keeping
  the placeholder stays legal — the player then sees the English pronoun.
- Still deferred (4 of 58,374 base-game strings): brace shapes that parse as
  neither a value nor a branch, tags outside the list, unbalanced or nested
  braces, and an email address in angle brackets in a mod's legal notice.
- Also rejected: stale source hashes, unknown IDs, malformed metadata, empty
  replacements of non-empty text, English copied verbatim (not counted as a
  translation), unpaired surrogates, control characters, changed surrounding
  whitespace, and entries over 65,535 UTF-8 **bytes**.
- Never treat `%` as a formatting token. Never reject a whole table because one
  untranslated entry has complex syntax.

## Lessons already paid for

`LESSONS.md` holds the hard-won ones — read it before designing a rule, a
heuristic or a batch run. It is short and every item has a number or a story
behind it.

## Claims this project may and may not make

- **Never claim more of the in-game gate than `README.md`'s Status records.** The
  gate is manual and lives in `README.md`; parts of it have been run (the package
  loads, Estonian letters render, removal restores English, first-named package
  wins) and parts have not (fall-through, branch deletion and pronoun
  substitution, per-label inspection). Package integrity is verified; game
  behaviour is only verified where Status says so.
- **Never invent** resource IDs, game versions, test results, or observations.
  `build --game-version` records a version only when supplied; otherwise the
  manifest says "not recorded".
- **Machine-drafted text is never recorded as human work.** Use
  `set --state machine --origin machine`; the manifest reports `reviewedApplied: 0`
  until a human reviews something.
- Report exclusions and limitations in the build output and manifest rather than
  quietly dropping data. A skipped test is not a pass.
- **Provenance is stated, not implied.** The repository itself is AI-generated;
  the closing footnote of `README.md` records by what, in which sessions, and
  with what human involvement. Update it when that changes rather than letting it
  drift.
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
