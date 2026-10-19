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


## Strings per locale: why mods look larger than the game

Measured 2026-10-16, prompted by a fair question ("how can mods have more strings
than the whole base game?"). They do not. A mod ships its text once **per locale**
in a single package:

| Package | Tables | Entries | Distinct texts | Locales |
| --- | --- | --- | --- | --- |
| `TURBODRIVER_WickedWhims_Tuning.package` | 110 | 139,788 | 6,187 | 22 (each locale: 6,354 entries in 5 tables) |
| `Data\Client\Strings_ENG_US.package` (base game) | 1 | 58,374 | 58,374 | 1 (English only, by definition of the file) |

So "383,473 strings in my mods" was an all-locales figure compared against the
base game's English-only file — apples to oranges. Counting only locale `00`
(English, which is what a game running in English reads):

| Source | English strings |
| --- | --- |
| Base game | 58,374 |
| Three stuff packs (SP06, SP08, SP14) | 688 |
| Installed mods (89 packages, 111 tables) | 16,278 — of which WickedWhims ~6,354, Basemental Drugs 4,831, MC Command Center 3,201, and ~86 item mods of 1–3 strings each |

Consequences:

1. The scan reads English tables only by default (`--include-non-english` to
   override). Reading all 22 locales would inflate a catalog ~22x with text the
   game never shows.
2. "Translate everything" is therefore a corpus of roughly **75,000 strings**, not
   440,000 — still a pipeline job rather than a session's, but a tractable one.
3. The size heuristic that skips large packages **is only valid for a game
   installation**. A Mods folder is the opposite case: the largest packages are
   exactly the ones with text (WickedWhims is 136 MiB). The scan now applies the
   rule only when the root looks like an installation, and `--large-file-mb 0`
   disables it anywhere. This was caught by rescanning after the fix and noticing
   the numbers had not moved — the CLI had been overriding the default.


## Reference translations in another language (measured, then captured)

The game installs **only the selected language's** string files; the language is a
Steam depot of about **12 MB** (`BytesToDownload` in `appmanifest_1222670.acf`),
and switching replaces the existing ones. Switching to Finnish produced
`Strings_FIN_FI.package` in place of `Strings_ENG_US.package`, including in the
pack folders - so the English *source* disappears until the language is switched
back, while `translations/et-EE.json` stays valid because occurrence IDs are
derived from labels, resource identity and string keys, not from file paths.

What Finnish gives us: `Data/Client/Strings_FIN_FI.package` has **58,374 entries
covering 100% of the English table's keys**, so every base-game string can be
shown to a translator alongside the official Finnish rendering:

| key | English | Finnish |
| --- | --- | --- |
| `0DFED87C` | New Game | Uusi peli |
| `D9F5EFCA` | Options | Asetukset |
| `07A4B7F0` | Resume Game | Jatka peliä |
| `1FDF180F` | Audio | Äänentoisto |

Finnish is the most useful reference available: Finno-Ugric, no grammatical gender
and a case system, so it shows how a professional team handled the same strings -
especially the gender-branch text this tool defers. The files are kept in
`work/reference-fi/` and are **never committed**: that text is EA's, not ours.

Other packages, measured the same way: MC Command Center ships real translations
in ~17 languages (2,400-3,150 of its 3,201 strings each), WickedWhims ships 68
translated strings per locale out of 6,353, and Basemental Drugs' 17 locales are
pure English stubs. So references help the base game and MCCC, and very little
else.

## A format trap that cost 11 strings

Object names such as `"Ivy League Fence
"` end with a **real newline character**,
not with the two characters backslash and n. The batch instructions said "keep
`
` exactly as written", which reads as an escape sequence in a JSON file, so the
translators wrote a literal backslash-n and dropped the newline. The importer
refused all 11 with `token-mismatch` and `edge-whitespace-mismatch` - the guard
worked, and the strings stayed English rather than shipping broken - and the
instructions now spell out the difference. Worth knowing for the bulk run: this
class of error is invisible in a diff and only shows up as odd spacing in game.

## Retiring the deferrals: what the Finnish translation proved

Phase 1 left 6,786 strings in English because they carried syntax the validator
could not check: gender and plural branches (`{M0.his}`, `{F0.she}`), pronoun
expressions (`{0.SimPronounSubjective}`), and HTML-like markup. The reasoning was
that preserving them verbatim would freeze English words inside Estonian
sentences, and that guessing was worse.

The Finnish copy of the game's own strings — captured while the Steam install was
switched to Finnish for this purpose — answers the question directly, because
EA's translators faced the same constructs. Measured over the base game:

| Construct | Count | What Finnish does |
| --- | --- | --- |
| Gender branches `{M0.}{F0.}` | 2,524 strings, 8,644 tokens | **Deletes them** and rephrases. `{M1.his}{F1.her} dreams?` → `…toteuttamaan unelmansa?` |
| Plural branches `{S0.}{P0.}` | 306 strings, 658 tokens | **Translates inside each branch**: `{S0.Pack}{P0.Packs}` → `{S0.paketti}{P0.paketit}` |
| Wording-style branches `{T1.}{DAE1.}` | 40 strings | `{T1.Mess Around}{DAE1.WooHoo}` → `{T1.vehtailu}{DAE1.pelehdintä}`, case included |
| Value reference in a branch | 9 strings: `{P0.ObjectName}`, `{S2.{S3.ObjectName}}` | **Kept verbatim** — the content names a value, not text |
| Pronoun expressions | 576 strings | **Replaced by the word**: `{0.SimPronounSubjective\|xxUpper} can also Mentor others` → `Hän voi myös opastaa muita` |
| Markup tags | 1,700 strings | Identical in 1,300 of 1,446 comparable strings; the exceptions are a localized legal URL and a dropped `<span class="money">` |

Three things came out of this beyond "translate them":

1. **The branch skeleton is the thing to check, not the branch text.** Estonian is
   genderless like Finnish, so the *content* of a gender pair may be identical
   (`{M0.tema}{F0.tema}`) or the pair may go as a whole. Both are structurally
   sound; half a pair is not, because one gender would render with no text at all.
   The validator now enforces exactly that, and refuses to drop a plural branch,
   which Estonian needs.

2. **Content that is a value name is a reference, not text.** `{P0.ObjectName}`
   stays as it is in Finnish while `{S0.Pack}` is translated. To separate the two
   without guessing, the value-name list is built from the corpus itself (44 names
   from `{0.SimFirstName}` down to `{0.GhostPowersPoints}`). Audited afterwards:
   of everything that appears in branch position, the only CamelCase-shaped
   content that is *not* a value name is `WooHoo`, which Finnish translates.

3. **The pronoun rule removes a documented limitation**, partially. Runtime values
   still render in the game's own language, but a pronoun is now the translator's
   word rather than an English "he" inside an Estonian sentence.

After the change, 58,370 of the base game's 58,374 entries are eligible; the four
that remain are a brace shape that parses as neither a value nor a branch, two
tag-shaped strings in a mod's OpenGL copyright notice that are actually an email
address, and their siblings.

**What is still unverified.** The *deletion* strategy for gender branches is
inferred from shipped Finnish, not observed in this game: we know EA shipped it,
we have not watched it render here. The same goes for a rephrased pronoun
sentence. Both are cheap to check and belong in the in-game gate next to the
precedence and fall-through probes: a package with one collapsed branch, one
deleted branch and one replaced pronoun, looked at in a moodlet.

## The locale byte, and where the clock's weekday names live

A string table's 64-bit instance is not opaque: its **high byte is the locale**.
Measured against the two files installed at different times:

| File | Instance | Entries |
| --- | --- | --- |
| `Strings_ENG_US.package` | `0054935F2685AD48` | 58,374 |
| `Strings_FIN_FI.package` | `0654935F2685AD48` | 58,374 |

The 56-bit base is identical; only the high byte differs (`00` = en_US,
`06` = fi_FI). The four Finnish reference packages captured earlier confirm
this for every table this build touches: `BASE_FIN_FI.package` has
`0654935F2685AD48`, SP06 `06BEA5E1D2845652`, SP08 `06A9BC4CEC99A5F8`, and SP14
`069DD507B385879F` — exactly the instances `build --locales en,fi` now writes,
each with the same 56-bit base as its English counterpart. The game loads the table matching the language it runs in, so a
mod that ships only the English-locale resource is **ignored when the game is set
to Finnish**. `build --locales en,fi` emits one copy per requested language —
identical entries, different high byte. This is exactly what the Ukrainian
translation project does by hand in Sims 4 Studio: their public instruction page
("Інструкція зі зміни системної мови перекладу", under
<https://sims4ukrainian.notion.site/bd67c0b217834cb0969a6e5dbcf4012c>) tells players to open every
language-flagged string table in their `Strings_UKR_UA_…` package and change its
Locale to the system language they use. Doing it at build time removes the manual
step, and the manifest records every copy it wrote.

The clock's weekday abbreviations and AM/PM are **not in any string table**, in
either language:

- exact-value scan of the English base table: 0 weekday values, 0 AM/PM values;
- the Finnish table: 0 as well (Finnish uses "sunnuntai", "tiistai", … only
  inside prose);
- the whole install-wide catalog (75,340 strings, 92 packages): the only exact
  weekday values are 7 entries in MC Command Center's own translation table
  (`220557DA:80000000:0024072D2A2C5142`), not the game's; 0 exact AM/PM values
  and 0 short time-format values. The base game's only short weekday text is a venue
  schedule, `"Mon 9am - Sun 6pm"` (`682F4294`), which is prose, not the clock;
- `Data/Client/UI.package` holds no STBL resources at all. Its Scaleform movies
  `calendar.gfx` and `timecontrols.gfx` contain the text fields
  `txtWeekday0`…`txtWeekday6` and `txtGameTime`, plus the localization-key
  constant `CALENDAR_WEEKDAY_NAME`, but no weekday text.

The source is the executable. `Game/Bin/TS4_x64.exe` holds a UTF-16 locale
registry with one caret-delimited record per language, including the weekday
and month names. Two records, read directly from the binary:

```
en^English^English^Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday^
   Mon.,Tue.,Wed.,Thur.,Fri.,Sat.,Sun.^January,February,...
fi^Finnish^Suomi^maanantai,tiistai,keskiviikko,torstai,perjantai,lauantai,sunnuntai^
   Ma,Ti,Ke,To,Pe,La,Su^tammikuu,helmikuu,...
```

`Mon.` is exactly the English short-day entry in that table, so the clock reads
its weekday text from the executable, not from any resource this pipeline can
write. The registry also chooses the time format (`%H:%M` versus `%I:%M %p`).
An exact UTF-16 search of the executable finds **no** `et-ee`, `Estonian`, or
`eesti` record: the game ships no Estonian locale data. The install is read-only
by this project's own rule and the tool does not patch executables, so an
Estonian clock is out of scope for a package mod. What `--locales` buys instead
is a choice of base language: with `--locales en,fi`, a player on an English
game gets Estonian text plus English "Mon."; on a Finnish game they get the same
Estonian text plus Finnish "Ma". Neither changes the time format, and the
manifest says which tables were shipped.

The 24-hour format is a separate, UI-level change. A public mod, **Clock – 24
hours** (Crinlorite, CurseForge), does exactly that as a `.package` interface
override of the speed/clock panel, with no script, and explicitly keeps the
weekday in the game's own language while converting only the main HUD clock —
career, university, calendar and notification times remain 12-hour. Its
existence is evidence that the clock's *formatting* can be overridden at the UI
layer, not evidence that a language switch changes it; the Finnish locale record
in the executable does not expose an obvious 12/24-hour flag (its fields match
the English record except for language-specific names). That mod is All Rights
Reserved, so its package or code cannot be reused here; a 24-hour Estonian clock
would be a separate UI override of `timecontrols.gfx` and, for other panels,
`calendar.gfx`, with its own licence and maintenance questions.

Where each display lives, and how far the evidence goes:

| Display | UI resource | Weekday text | Time format |
| --- | --- | --- | --- |
| Main HUD clock | `timecontrols.gfx` (`62ECC59A:00000000:C4B030271AE45C30`) | executable locale registry, via `DateUtils` | GFX formatting; a UI override can force 24-hour |
| Calendar | `calendar.gfx` (`62ECC59A:00000000:A5C032C0F84B521F`), fields `txtWeekday0`…`txtWeekday6`, `InitializeWeekdayNames` | no STBL values exist, so also the executable registry | not separately verified |
| Career / university / notifications | separate panels, not traced | **not verified** | **not verified**; the 24-hour mod explicitly leaves these at 12-hour |

A naive string search across all 258 GFX movies is not evidence of use: 142 of
them contain the same localization-key and class-library strings, because the
shared libraries are embedded in each movie. Only `calendar.gfx` contains the
`txtWeekday` fields and `InitializeWeekdayNames`; the main clock has no weekday
field of its own and formats through `DateUtils`. This is why a single STBL
override cannot be expected to change every time display, and why the coverage
table separates them.

The in-game check remains worth doing as confirmation, not discovery: run the
game in Finnish and look at the clock — the expectation is `Ma`, `Ti`, … from
the Finnish registry row, and the time format is whatever the Finnish game
shows (not assumed to be 24-hour). No claim is made that the Ukrainian project
localizes its clock; its Notion page documents the locale retag only.

## Pack strings live in Delta, and the root folders can be stale

The three owned stuff packs have both a standalone root folder and a
`Delta/<pack>` copy. For SP06 the root `Version.ini` records
`packversion 12.0.136.1020` (2016), while `Delta/SP06/Version.ini` records
`1.128.90.1030` (2026, the current game version); `Delta/SP06/ResourceClient.cfg`
gives `Strings_*.package` priority `-9` against `-30` for the full build. The
Delta table is therefore the live one.

The first pack translation was built from the root copies. Against the Delta
copies it was missing 22 keys and had 9 changed source texts (of which 5 had
translations that went stale). The catalog now draws the three packs from
`Delta/`, the 22 new keys are translated, the five stale entries were re-checked
and their hashes refreshed, and the 12 translations for keys that no longer
exist were removed. Whether a Mods package overrides a Delta table at load time
is still the open precedence question; the base-game override is verified, the
pack path is not.

## Translating the mods: the first pass

The 88 installed mod packages hold 16,278 English strings. They were exported
into 25 batches (14,999 distinct entries after text dedupe), translated in
parallel, pre-validated, and imported: 15,779 accepted, 0 rejected. Coverage:

| Mod group | Entries | Translated |
| --- | --- | --- |
| WickedWhims (Tuning) | 6,354 | 6,269 |
| Basemental Drugs | 4,831 | 4,745 |
| MC Command Center | 3,201 | 3,161 |
| All other mods (85 packages) | 1,892 | 1,604 |

The 499 left English are proper names, world names, brand/URL text, progressive
`Nintendo…` label fragments, and ambiguous duplicate keys.

**Duplicate table IDs are real in mods.** Three pairs ship the same TGI:
`KhyanTristanScreen`/`KhyanTristanRoomDividerScreen`, `WW_mike24_Animations`/
`WW_mike24_Classic`, and `WW_mike24_DF`/`WW_mike24_DarkFantasies`. The game loads
the first-named package, so only that copy is addressable. The build now builds
the first-named package's table, skips 469 translations belonging to the shadowed
copies, records `shadowedDuplicateTranslations` in the manifest, warns, and has a
two-package test for the rule. Without this, the build correctly refused with a
source-hash mismatch — the catalog had two different texts for one table ID.

**Consistency checks after import.** `glossary-check` found 144 violations across
the whole corpus: 135 in the base game (mostly idioms and inflections) and 9 in
mods, nearly all false positives ("final volume", "promotion campaign", "safe and
sound", "cheat on"). `lint` found 2 findings after fixes, both false positives:
`pisidetaile` (base game) and `skriptifaile` (valid Estonian partitive plural).
One real mod wording defect was fixed: a duplicated `kohmakaile ja kohmakale`
in a Basemental string.

**Not yet observed in game**: whether a package can override another mod's table
at load time. The first-named-wins rule was measured on game resources; the mod
path is the next manual check.

## Known limitations and open questions

1. **The base-game override was run in game on 2026-10-16** (README Status); the
   pack tables and the 101 mod-table overrides have not been observed. Nothing here
   claims the mods render Estonian text yet.
2. **First-named-package wins** was measured for game resources. Overriding another
   mod's table, and overriding a `Delta/` table, are unverified (see above).
3. **SDX files** are still not treated as a special case. Pack strings are read
   from `Delta/`, but the game's own SDX precedence rules remain the brief's [R3]
   open question.
4. **Runtime-substituted values stay in the game's base language** (names, money,
   dates, day names), because no new game language is registered. The clock's
   weekday text lives in a locale registry compiled into `TS4_x64.exe`, and the
   game ships no Estonian record, so `--locales` changes which table the game
   loads, not how it formats dates. Installing Estonian clock names would require
   patching the executable, which this project does not do.
5. **Memory is proportional to package size**, so the multi-gigabyte build
   packages are out of scope until the streaming plugin or an index-only reader is
   added.
6. **Some strings stay English by design.** The base game keeps 2,503 entries
   (names, identifiers, deferred syntax), the three owned packs 72, and the mods
   499 (proper names, brand text, ambiguous keys). The validator refuses a
   translation rather than guessing at a construct it cannot verify.
7. **Stale-source translations are excluded, not flagged in the UI.** They are
   reported in the build output and the manifest (`stale-source`), and the fix is
   to re-translate after re-extracting.
