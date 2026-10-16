# Phase 2 design — installation-wide catalogs and patch updates

Design document, **not** an implementation. Phase 1 covered one supplied package;
Phase 2 covers everything the player has installed, and keeps translations alive
across game updates. Grounded in measurements taken on this machine (game
1.128.90.1030, Steam install) — those are labelled. Anything not measured is
marked as an assumption or an open question.

## What Phase 1 leaves us

- One English package → one catalog → one output package containing a **whole
  table** override, with untranslated entries kept in English.
- Translations keyed by `PACK|TYPE:GROUP:INSTANCE|KEY`, with a per-string source
  hash and a state (`draft` / `machine` / `reviewed` / `needs_review`).
- A build-time fingerprint check: if the source package changed, the build
  refuses rather than applying stale text.

Phase 2 has to scale that from one table to many, and survive the game changing
underneath the translations.

## Measured facts the design rests on

All measured read-only on this installation; evidence and commands in
`IMPLEMENTATION_NOTES.md`.

1. **One package, one table, 43 resources** — the base game's
   `Data\Client\Strings_ENG_US.package` holds exactly one STBL
   (`220557DA:00000000:0054935F2685AD48`, 58,374 entries) among 43 resources.
2. **Packs ship their own tables with their own instance IDs** — `SP06`, `SP08`
   and `SP14` each have a `Strings_ENG_US.package` with a distinct instance
   (`00BEA5E1D2845652`, `00A9BC4CEC99A5F8`, `009DD507B385879F`). No pack shares
   the base table's identity. So "translate the base game" and "translate a pack"
   are different resources, and partial coverage per pack is the normal case.
3. **116 string tables live in `Delta\<pack>\Strings_ENG_US.package`** — all with
   distinct instances, none equal to the base table's.
4. **Indexes are not uniform.** 647 packages were scanned by reading header +
   index only; **346 use constant index fields** (`flags != 0`), which my
   index-only reader cannot decode. The library can read them (it handles
   constant type/group/instance), but the fast path cannot. Any full-install scan
   needs both paths, or must accept reading those files whole.
5. **Whole-file reads do not scale.** `Package.from(buffer)` reads the file into
   memory; the build packages here are ~1 GB each and there are 18 of them.
   Phase 2 needs the optional `@s4tk/plugin-bufferfromfile` (mmap) or an
   index-only path.
6. **Nothing installed currently competes for the base table** — exactly one file
   lists that TGI, `Data\Client\Strings_ENG_US.package` itself. This is a
   *detection* result, not a precedence result.

## The open question Phase 2 must answer first: precedence

Which package wins when two files ship the same resource identity? The upstream
extraction example explicitly warns that this is unresolved, and it decides
whether a mod that overrides a pack's table even works.

**It must be settled by experiment, not by assumption.** The design therefore
starts with a precedence probe, not with a scanner:

- `probes/precedence/` generates the packages and documents the procedure. Two of
  the three experiments still need a game launch; the results table there is the
  deliverable.
- Build two tiny packages with the same TGI and *different text for the same key*.
  Install one in the Mods folder and one in a scratch location that the game
  loads, and read which text appears.
- Repeat for the pairs that matter: Mods vs base file, Mods vs `Delta` (SDX),
  two Mods files with the same TGI, and `<pack>` vs `Delta\<pack>`.
- Record the outcome per pair in a table in this repository. Until a row is
  filled in, nothing in the tool may rely on that ordering.
- **Already answered (in game, 2026-10-16):** Mods beats the game's own copy of
  the base table; and of two Mods packages claiming the same resource, the
  alphabetically first filename won. The second is a single data point — the rule
  could be creation or index order — so it is recorded as "first-named won", not
  as "alphabetical order decides".

SDX (`Delta`) stays **out of scope for catalogs** until this is answered: files
are detected, counted and reported as excluded, and the manifest says so. The
brief's warning about copying an upstream extraction order as authoritative
stands.

## Discovery

Goal: enumerate the player's installed string tables without guessing, without
scanning the whole disk, and without writing anywhere in the game folder.

1. **Inputs stay explicit.** The user names the game root once (`--game-root`).
   No directory walking outside it.
2. **Two-pass scan.** Pass one: read header + index only, and collect every
   package's type/instance list (fast; 647 files took seconds). Pass two: for the
   files whose index uses constant fields, read them with the library instead —
   the list of such files is known from pass one, so the expensive reads are
   bounded and predictable.
3. **Catalog per package, not per game.** Keep the Phase 1 rule: an occurrence
   belongs to a package and a table. The catalog grows a `packages[]` array with
   `{ path, packLabel, sha256, tableCount, entryCount, excluded?: reason }`, and
   occurrences gain the package's label. Coverage is then reportable per pack:
   "BASE 58,374 strings; SP06 262; …".
4. **Duplicates are reported, never resolved.** If two files in the install (or
   two Mods files) ship the same TGI, that is a finding with a severity, printed
   and recorded in the manifest — not silently picked by enumeration order. This
   already exists inside one package (duplicate keys, duplicate TGIs) and extends
   naturally across packages.
5. **Non-string resources are never read.** The type filter from Phase 1 stays.

## Source diffing (the part that keeps translations alive)

After a game update, the English text changes under existing translations. The
design:

- **Re-extract first.** A new catalog is written next to the old one; nothing is
  overwritten in place.
- **Classify every occurrence** by identity (`pack|TGI|key`) and source hash:
  - *unchanged* — same key, same text hash: the translation carries over as-is.
  - *modified* — same key, different text hash: the translation is **kept** but
    marked `needs_review`, and is **not shipped by default**. Phase 1's
    stale-source rejection already refuses to apply it; Phase 2 keeps it visible
    instead of just excluding it.
  - *added* — new key: untranslated, appears in the coverage report.
  - *removed* — key gone: the translation is **archived**, not deleted. Archive
    lives under `translations/archive/` keyed by the old occurrence ID and the
    catalog it came from, so a re-added string can be recovered.
- **Rebuild from fresh English, never from an old output.** The override is
  always constructed from the current English source plus eligible translations;
  an old built package is never a source of truth. (Phase 1 already does this by
  construction — this is a design invariant to preserve.)
- **Shrink the diff surface.** The manifest records which catalog and which
  source fingerprint produced each artifact, so "which translations does the new
  game version invalidate?" is a query, not an investigation.

## Staleness after a game update

Phase 1's fingerprint check protects the *builder*, not the *player*: someone who
installs a package and then updates the game is running a whole-table override
whose English half — 58,322 of 58,374 entries — is now a snapshot of an older
game. That is inherent to whole-table overrides.

What Phase 2 can honestly do:

- Record the game version the artifact was built against (already in the
  manifest) and print it at deploy time: "built for 1.128.90.1030; your
  GameVersion.txt says …".
- Document the rebuild requirement in the README and the deploy output.
- **Not** claim runtime protection. There is no runtime hook here, and a text mod
  cannot detect that it is stale.

A sparse-override strategy (emit only the changed entries rather than the whole
table) would reduce the staleness surface, but Phase 1 deliberately avoided it
because the game's fall-through behaviour for missing entries is unverified.
That verification — one experiment, same shape as the precedence probe — is the
prerequisite for revisiting it.

## Proposed command surface

Kept small and explicit; every path still supplied by the user.

```powershell
# Discover and catalog everything installed (writes one catalog per package plus an index)
npm run cli -- scan --game-root "<...>\The Sims 4" --out work/install

# Coverage report: strings per pack, translated / eligible / deferred
npm run cli -- coverage --catalog work/install/index.json

# Compare two catalogs: unchanged, modified, added, removed
npm run cli -- diff --from work/install/catalog.json --to work/install-next/catalog.json --report work/diff.json

# Mark carried-over-but-stale translations for review (writes metadata only)
npm run cli -- review --diff work/diff.json --translations translations/et-EE.json --metadata translations/metadata.json

# Build one package covering several catalogs, or one per pack
npm run cli -- build --catalog work/install/index.json --include-unreviewed --out dist/
```

`extract` from Phase 1 stays as it is: one package in, one catalog out, no
discovery. It is the debugging tool for the scanning machinery.

## Testing strategy

- Synthetic multi-package fixtures: the same TGI in two files, a pack table, a
  constant-field index, a file with no string tables, a truncated file.
- Diff classifier: a fixture catalog pair covering all four classes, asserting
  that nothing is deleted, that `modified` never ships by default, and that
  unchanged translations are bit-identical afterwards.
- Precedence: the probe packages and the recorded results table are committed as
  fixtures plus documentation — the results table is the deliverable, since it
  cannot be re-derived without a game install.
- Safety, unchanged from Phase 1: inputs hashed before and after; scan and build
  never write inside the game folder; the Mods folder is touched only by deploy.

## Acceptance criteria for Phase 2

1. A scan of this installation catalogs every string table, names how many files
   were read which way, and lists excluded content (SDX, unreadable) explicitly.
2. Coverage per pack is reported in numbers, not adjectives.
3. A game update is simulated by swapping one package: the diff classifies every
   occurrence, and no human translation is silently lost or silently shipped
   against changed source.
4. The precedence table has at least the Mods-vs-base and Mods-vs-SDX rows filled
   in by experiment, with the method written down.
5. Phase 1's guarantees still hold, verified by the existing suite plus the new
   fixtures.

## Non-goals (Phase 3 and later)

- Any machine translation, provider configuration or bulk translation run.
- Handling of gender/plural branches, pronoun expressions or markup; that stays
  deferred, and Phase 2's coverage report should keep quantifying it.
- Distribution, review workflows or a translation UI.

## Open questions

- Does the game read `Delta` only as a patch layer, or also as a full source for
  some resources? (Precedence probe.)
- Do pack tables load before or after the base table? Affects nothing today,
  because identities differ — but it decides the two-file experiment's design.
- Does the game cache string tables in the user folder (`cache/`) in a way that
  survives a Mods-folder change? Phase 1's trial showed a change taking effect
  after a restart; a cache-invalidation experiment belongs here.
