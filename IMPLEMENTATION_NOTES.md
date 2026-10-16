# Implementation notes — Phase 1

Technical record of what was actually built, tested, and observed while
implementing the Phase 1 prototype described in `Sims4_Eesti_Implementation_Brief.md`.
Everything here was measured on this machine; nothing is assumed from upstream
documentation.

## Environment actually used

| Thing | Version |
| --- | --- |
| OS | Windows 11 Pro, build 26100 |
| Node.js | v22.18.0 |
| npm | 11.6.4 |
| TypeScript | 7.0.2 (`tsc --noEmit`, strict) |
| `@s4tk/models` | **0.6.14, pinned exactly** (was `^0.6.14` during development, pinned after the tests passed) |
| `@s4tk/compression` | **0.2.0, pinned exactly** |
| tsx | 4.23.15 |
| Test game | The Sims 4 **1.128.90.1030**, Steam install, `en_US` |
| Source file used | `...\The Sims 4\Data\Client\Strings_ENG_US.package`, sha256 `6388f33b95f4fc0c2ba22f67f0a4dbb085aedc6ad217e2a5420377e29bd8f9af`, 6,313,691 bytes |

`@s4tk/compression` is a direct dependency even though it arrives with
`@s4tk/models`, because the adapter uses its public `CompressionType` enum; the
resolved version is the same one in the tree.

## Library findings (read from the installed package, then verified by running it)

These came from reading `node_modules/@s4tk/models/lib/**/*.d.ts` and `*.js`, then
confirming each by execution. They drive the design of `src/package-io.ts`.

1. **64-bit instance IDs are lossless.** `ResourceKey.instance` is a `bigint`
   (`lib/packages/types.d.ts`), and the writer splits it into two `uint32`s
   (`write-dbpf.js`). Verified: the base game table's instance
   `0054935F2685AD48` survives read → write → read exactly. Note that this value
   is above `Number.MAX_SAFE_INTEGER` but *is* exactly representable as a double,
   so the test suite uses `0054935F2685AD49` (odd, 55 significant bits) to prove
   that a `number` would corrupt the id.

2. **Resource filtering happens at index level.** `resourceFilter` is applied
   while walking the DBPF index, so non-matching resources are never read or
   decompressed. This is what keeps extraction to string tables only: EA's
   `Strings_ENG_US.package` holds 43 resources and exactly one of them is a
   string table.

3. **The STBL entry `mnFlags` byte is dropped.** `read-stbl.js` does
   `decoder.skip(1) // mnFlags (uint8; has no use, will never be set)`, and
   `write-stbl.js` writes `encoder.skip(1)` — a zero. The library models neither.
   Measured on the real file with our own byte reader: **0 of 58,374 entries have
   a non-zero flag byte**, so nothing is actually lost for this input. The tool
   reports this per resource (`nonZeroFlagEntries`) and warns if a future file
   ever sets one. This is the "report the exact limitation" case from the brief.

4. **EA ships this table internally compressed (`0xFFFF`), which cannot be
   written back.** `CompressionType.InternalCompression` can be decompressed but
   `compressBuffer` throws `Compressing with "65535 (InternalCompression)" is not
   supported`. Reading a package sets each resource's `defaultCompressionType`
   from the index, so the first attempt to serialize the table failed outright.
   Fix: the adapter sets `defaultCompressionType = CompressionType.ZLIB` before
   serializing. ZLIB (`0x5A42`) is what mod packages use, and it is what EA's own
   *other* resources in the same file use. The manifest records this.

5. **Our container matches EA's conventions.** Header dump comparison of EA's
   file and our output: DBPF version 2.1, index record flags 0, `mnCommitted` 1,
   resources compressed with `0x5A42`, index position stored in the 64-bit field.
   The library always writes index flags as zero and `mnCommitted` as 1; EA's own
   file does the same. See `write-dbpf.js` lines 17, 29–32.

   The STBL header's `mnStringLength` field was checked separately, because the
   library recomputes it rather than preserving it. Both files follow the same
   convention — the sum of each entry's byte length **plus one per entry**:

   | | entries | `mnStringLength` | sum(text bytes) | sum(text bytes + 1) |
   | --- | --- | --- | --- | --- |
   | EA's original | 58,374 | 3,952,075 | 3,893,701 | **3,952,075** |
   | our output | 58,374 | 3,952,132 | 3,893,758 | **3,952,132** |

   So the recomputed field agrees with EA's own usage rather than merely being
   "close enough".

6. **`equals()` on large models is O(n²).** `MappedModel.equals` compares entries
   pairwise. Calling it on the 58,374-entry table took roughly five minutes.
   Verification code therefore compares entries index by index (linear) and never
   calls `equals()` on real tables.

7. **Whole-file reads.** `Package.streamResources` / `indexResources` require the
   optional `@s4tk/plugin-bufferfromfile`, which is not installed, so the adapter
   uses `Package.from(buffer, …)`. Memory use is therefore proportional to the
   package size: fine for a 6 MiB string package (169 ms), not suitable for the
   multi-gigabyte build packages. Installation-wide discovery in Phase 2 needs
   the streaming plugin or an index-only path.

## Syntax survey of the real English file

Rules in `src/validation.ts` are derived from this survey of the 58,374 entries,
not from assumption:

| Pattern | Occurrences | Decision |
| --- | --- | --- |
| Brace expressions | 20,802, in 698 distinct shapes | Only `{N.ValueName}` with a whitelisted value name is applied |
| — `{0.SimFirstName}` and friends | 7,588 (SimFirstName), 1,201 (String), 670 (Number), 327 (Money), 281 (SimName), 155 (ObjectName), 100 (TimeShort), 46 (Timespan), 42/31 (DayOfWeek) | Supported; preserved as a multiset, order may change |
| — gender/plural branches `{F0.her}`, `{M0.his}`, `{M0.he}`, `{S0.is}`, `{P0.packs}`, `{T0.Mess Around}`, `{DAE0.WooHoo}` | 1,840 / 1,548 / 1,457 / … | **Deferred.** The payload is English grammar; freezing it would leave English words inside Estonian text (the case the brief warns about in [R5]) |
| — pronoun expressions `{0.SimPronounSubjective}`, `{0.SimPronounSubjective|xxUpper}` | 207 / 73 | **Deferred.** The substituted value is language-dependent |
| Markup `<span class="pink">`, `</span>`, `<b>`, `<font color="#EC262E">` | 9,429 | **Deferred.** Tag reflow between languages is unhandled; a string containing any tag is left in English |
| Escapes `\n`, `\s` | 8,893 / 1 | Preserved, multiset must match |
| Inline codes `[PH]`, `[C]`, `[V]`, `[W]`, `[DNT]`, `[REDACTED]` | 33 | Preserved, multiset must match |
| Literal `%` | 89 | Ignored on purpose: not treated as a formatting token |
| Real newlines / tabs | 279 / 4 | Allowed in text; leading/trailing runs must match exactly |
| Empty strings | 19 | An empty English entry may be filled; a non-empty one may not be emptied |
| Duplicate string keys | **0** | The ambiguity machinery exists (and is tested) but the real file has none |

Applying these rules to the whole table gives the Phase 1 coverage:

| Strings | Share | Status |
| --- | --- | --- |
| 53,551 | 91.7% | eligible for translation today |
| 3,315 | 5.7% | deferred: gender/plural/pronoun expressions |
| 1,501 | 2.6% | deferred: HTML-like markup |
| 7 | 0.0% | unbalanced or nested braces (left alone) |

## Verification evidence

Automated (all run on this machine):

```
npm test        → 78 tests, 78 pass, 0 fail   (synthetic fixtures only)
npm run test:game (SIMS4_EESTI_SOURCE_PACKAGE set) → 4 tests, 4 pass, 0 fail
npx tsc --noEmit → clean, strict mode
```

The integration tests against the real file report:

- 43 resources, 1 string table, 58,374 entries, locale byte `0`
- 0 non-zero entry flag bytes out of 58,374
- read → write → read: 58,374 entries, **0 mismatches**, resource identity identical
- catalog extraction: 58,374 occurrences, 0 warnings

Build of the real artifact:

```
npm run cli -- build --catalog work/base/catalog.json --include-unreviewed \
  --out dist/Sims4_Eesti.package --game-version "1.128.90.1030"
→ dist/Sims4_Eesti.package, sha256 4e8c322793eb0a9ff98b53c92a2b6d562f7b3b553ab1769792a5cc388ee5914a
  57 replaced, 58,317 kept in English, 0 excluded
  (earlier builds: 30 translations 66ffac53…, 31 translations 488b2b2e…, 52 translations 16db9fbe…)
```

Independent re-check of that artifact against the source file (separate script,
comparing every entry): **58,374 entries both sides, unchanged except the intended
translations, 0 unexpected changes, 0 key mismatches**; the written payload parses as
STBL version 5, `mnCompressed = 0`, reserved `0,0`, all 58,374 flag bytes zero,
and every entry's declared byte length equals its UTF-8 byte length.

Reproducibility: two builds in **separate processes** produced the same sha256.
Byte-identity is therefore demonstrated for this input, and the only library-induced
difference from EA's original is the compression of the rewritten table
(`0xFFFF` internal → `0x5A42` ZLIB) plus the container's file size (6.02 MiB →
1.70 MiB). Semantic content is unchanged, as verified above.

Source safety: the game's `Strings_ENG_US.package` sha256 is identical before and
after every operation.

## Override-conflict investigation (read-only, not Phase 1 product code)

Because a same-TGI resource elsewhere could shadow the mod, the installed game
tree was inspected read-only:

- DBPF **index scan** of all 647 `.package` files in the installation (reading
  only the 96-byte header and the index region, never resource data): exactly
  **one** file lists resource `220557DA:00000000:0054935F2685AD48`, namely
  `Data\Client\Strings_ENG_US.package` itself.
- 346 of those files use constant index fields (`flags` ≠ 0) and were not covered
  by that scan. For the ones that could matter — every `Delta\<pack>\Strings_ENG_US.package` —
  the product's own reader was used instead: **116 string tables across the delta
  folders, all with distinct instances; none shares the base game's instance.**
- The three stuff pack string files (`SP06`, `SP08`, `SP14`) each hold their own
  table with their own instance, so pack text is untouched by this mod.
- `Delta\EP01\ClientDeltaBuild0.package` holds 30,571 resources and **no** string
  tables at all.

This is *detection*, not precedence: it shows nothing installed competes for the
same resource ID, but the Mods folder vs. base-file load order is exactly the
question Phase 2 must settle — and it remains unverified until the game is
launched with the mod installed.

## Deliberate deviations from the brief's suggested layout

- Added `ids.ts`, `hashing.ts`, `stbl-format.ts`, `deploy.ts` next to the
  suggested modules. `stbl-format.ts` is a ~120-line reader for the STBL payload
  only (no DBPF parsing, which the brief forbids). It exists because the only way
  to make a factual claim about the flag byte the library discards — and to
  cross-check the written payload without using the same code that produced it —
  is to parse those bytes independently.
- `set` records the text *and* its validation problems, rather than refusing
  invalid text outright, so a translator never loses work; the build excludes it
  and says why.
- An `--origin human|machine` flag was added so machine-drafted text can never be
  recorded as human work. All prototype translations are `machine` and the build
  manifest reports `reviewedApplied: 0`.

## Dependency advisories (npm audit)

`npm audit` reports 7 moderate advisories, all transitive inside `@s4tk/models`
(`@jimp/*`, `file-type`, `fast-xml-parser`); none of them has a fix available at
the pinned version. None is reachable from this tool's code paths:

- the `file-type` / `@jimp/*` advisories concern image parsing, and the adapter
  filters to string tables, so image resources are never loaded or decoded;
- the `fast-xml-parser` advisory concerns XML *building* from unescaped input,
  and this project neither parses nor writes XML resources.

These are recorded rather than silently ignored; if a future phase reads images
or XML resources, that judgement has to be revisited.

## Independent inspection

Reopening the package with the same library that wrote it proves the file is
loadable and self-consistent, but not that a different implementation agrees with
it. Two independent checks were built in:

- `src/stbl-format.ts`, a ~120-line STBL payload reader written from the format
  description rather than from the library, parses the written bytes and verifies
  version, entry count, keys, text, byte lengths and the flag byte the library
  drops.
- The container header of our output was dumped and compared field by field with
  EA's own package (version, index flags, committed flag, compression type,
  index position width).

Still outstanding, and part of the manual gate: opening
`dist/Sims4_Eesti.package` in **Sims 4 Studio**, an independently written tool
that is not a dependency of this project (it is not installed on this machine).
That is listed as an optional step in the README checklist.

## Independent review pass and the fixes it produced

After the tests were green, the eight source modules were reviewed by a separate
pass whose brief was to find correctness bugs and to verify them by running code.
It found six, all of which are fixed and now covered by regression tests
(78 → 89 tests). None of them changed the built artifact: the rebuild after the
fixes has the same sha256, and the same applied translations.

| # | Defect found | Fix |
| --- | --- | --- |
| 1 | `set` wrote the text file before the metadata file. If the metadata write then failed (locked file, disk full), new unreviewed text sat under an entry whose recorded state was still `reviewed`, so a *strict* build would apply it. | Metadata is written first, the text second, both files are read back and compared before success is reported, and `writeJsonAtomic` removes its temp file when the rename fails. The write order makes the only possible half-written state the safe one: old text, new metadata. |
| 2 | `assertOutputIsSafe` checked only the package path, not the manifest path — `--manifest <metadata.json>` silently replaced the metadata with a build manifest, destroying every entry's review state. | Both outputs are now compared against all four inputs (and against each other), and both parent directories are required to exist. |
| 3 | When a package held the same resource twice, only the second and later copies were marked ambiguous, so `set` accepted an ID whose first copy could never be built, producing a build error that blamed the catalog and told the user to re-extract (which reproduced it). | Duplicate TGIs are counted in a pre-pass and *every* string in *every* copy is marked ambiguous; the byte-level reader also keeps per-copy buffers so each copy is verified against its own bytes. |
| 4 | An empty English string "translated" to empty text passed validation, so a table could be emitted whose contents were byte-for-byte the English original. | An empty-to-empty pair is now `identical-to-source`: it is not a translation, does not count as applied, and cannot make a table count as affected. |
| 5 | `--state-path` pointing inside the Mods folder put backups *in* Mods — a second package containing an older revision of the same string tables, which the game could load. | Backups are refused when the backup directory resolves to the Mods folder or anything beneath it (junction-aware, works for directories that do not exist yet). |
| 6 | Two inert problems: the `ENGLISH_LOCALE_BYTE` comment said "low byte" while every use is the high byte, and the header summary read the index flags from the 64-bit index position only, where the library falls back to the 32-bit field. | Comment corrected; the fallback is mirrored so the field reports flags rather than unrelated bytes. |

The review also independently confirmed the main invariants under an 80-scenario
randomised differential test of the build path: hash gating, lossless 64-bit
instances, per-entry preservation, table selection and input immutability all held.

**Unrelated finding worth acting on outside this repository:** the git-ignored
`.env` in this project's root contains a `GH_PAT=` GitHub personal access token in
plaintext. It never entered git, but it is exposed to anything that reads the
directory. Rotate it and keep credentials out of project folders.

## What the first in-game trial revealed

The first run in the real game (2026-10-16, game 1.128.90.1030, Steam install)
confirmed that the package loads and that interface labels change. It also caught
a string-selection error — not a bug in the tool, but a property of the format
that the documentation did not previously state:

1. **Nothing in a string table says where a string is rendered.** `"Sound"`
   (key `91392857`) is a build/buy *tag*; the options dialog's audio tab is
   `"Audio"` (key `1FDF180F`). Both were chosen from the text alone, and the
   inference was wrong for one of them. Picking labels is an in-game observation
   task — the catalog can only prove that the text exists somewhere.
2. **The same text exists under several different keys.** Five entries carry the
   text exactly `"Audio"`: three in the credits list, one in a tag list, one the
   options tab. Searching by text returns all five, and translating the wrong key
   changes a string that may never appear where the translator is looking.
3. **One key can serve several UI locations.** A key is derived from one canonical
   string, so translating it changes every place that uses that string. The
   cheapest offline clue is *neighbourhood analysis*: Maxis groups UI text in
   blocks, so the strings immediately before and after a candidate tell you
   whether it belongs to an options screen (`"Lighting:"`, `"Fullscreen"`), a tag
   list (`"Spaceship"`, `"Social"`, `"Soap"`), or the credits.

Action taken: `1FDF180F` (`"Audio"`, the options tab) now carries the
`ÕÄÖÜ õäöü ŠŽ šž` rendering probe, and `91392857` (`"Sound"`, a tag) carries the
natural `"Heli"`. Rebuilt (31 translations) and redeployed over the previous
release, which was backed up to `work/backups/` outside the Mods folder.

The probe was then moved onto the options dialog's audio tab, and the tester
confirmed that all twelve letters — `Õ Ä Ö Ü õ ä ö ü Š Ž š ž` — render as letters
in the interface. That settles the font-coverage question the English source text
could not answer: the game's own strings contain no `õ`, `ü`, `Š` or `Ž` at all,
so those glyphs were previously unobservable.

Also learned from the trial: the Mods folder does take precedence for this
resource (the game ships its own copy of the table we override, and our text is
what appears).

## Known limitations and open questions

1. **Not run in game.** The manual gate in `README.md` is unexecuted. Nothing here
   claims the game loads the package or renders Estonian letters.
2. **Load-order precedence in the Mods folder is unverified** (see above).
3. **SDX files** were not treated as a special case; the brief's [R3] warning about
   unresolved SDX precedence still stands.
4. **Runtime-substituted values stay English** (names, money, dates, day names),
   because no new locale is registered.
5. **Memory is proportional to package size**, so the multi-gigabyte build
   packages are out of scope until the streaming plugin or an index-only reader is
   added.
6. **Complex syntax is skipped, not handled.** According to the survey that is
   ~20,802 brace expressions in gender/plural/pronoun shapes and 9,429 markup
   tags' worth of strings that stay English. Phase 3 is where they get a real
   token-aware treatment.
7. **Stale-source translations are excluded, not flagged in the UI.** They are
   reported in the build output and the manifest (`stale-source`), and the fix is
   to re-translate after re-extracting.
