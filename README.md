# Sims 4 Eesti

A fan-made **prototype** that builds an Estonian text mod for The Sims 4 out of
the English string files already on your own PC.

It is a local command-line tool, not a translation website and not an installer:
you point it at one English `.package`, pick strings, write Estonian text, and it
writes one `.package` you can drop into your Mods folder.

**Scope:** an install-wide catalog (on the 2026-10-31 machine **194,880 English
strings across 230 tables**: 163,302 game strings in 117 tables read from the
live `Delta/<pack>` copies, and 31,578 strings in 87 mod packages) and
**107,778 stored translations** — 92,424 game strings (56.6% of the game) and
15,354 mod strings.

The **0.5.0 release ships 91,565 translations across 14 tables**: the base game,
EP01–EP10 and three stuff packs, with 3,355 entries deliberately left in English.
EP11 and later, the game packs and most stuff packs have barely been started;
mod translations exist but are **not part of 0.5.0** — they are deferred until the
later DLC text is translated, so they inherit its terminology. Untranslated
entries keep their English text. This is not a complete Estonian localisation of
the game, and no translation here has been reviewed by a human.

---

## What it does, in one picture

```
English .package ──extract──► catalog.json        (every string, with its full
                                  │                resource identity + hash)
                                  │
                    search ───────┤ you pick strings that are visible in game
                                  │
                    set ──────────┤ translations/et-EE.json  + metadata.json
                                  │                (state, source hash, origin)
                    build ────────▼
                              dist/!Sims4_Eesti.package
                              dist/Sims4_Eesti.manifest.json
                                  │
                    deploy ───────► your Mods folder  (one file, nothing else)
```

Every step refuses to guess: a string whose syntax the tool cannot check is left
in English and reported, never half-translated.

---

## Requirements

| Thing | Tested with |
| --- | --- |
| Windows | Windows 11 Pro (26300) |
| Node.js | v22.22.0 (LTS) |
| npm | 10.9.4 |
| TypeScript | 7.0.2 (`tsc --noEmit`, strict) |
| `@s4tk/models` | 0.6.14 (pinned) |
| `@s4tk/compression` | 0.2.0 (pinned) |
| tsx | 4.23.15 (runs the TypeScript CLI directly) |
| Game | The Sims 4 **1.129.39.1030**, Steam install, English (`en_US`). The in-game results in [Status](#status) were observed on 1.128.90.1030; the newer version has been measured read-only, not played with the mod. |

There is no build step: `npm run cli` runs the TypeScript directly through tsx.

## Install

```powershell
npm ci
npm test          # 110 tests, all synthetic; no game files needed
```

## Use

Find your English string package first. For the Steam install it is
`...\The Sims 4\Data\Client\Strings_ENG_US.package`; for EA App installs it is
under the game's `Data\Client` folder in the same way. The tool never guesses
paths — you supply them.

```powershell
# 1. Read the English package into a local catalog (writes work/base/*.json)
npm run cli -- extract --package "C:\Program Files (x86)\Steam\steamapps\common\The Sims 4\Data\Client\Strings_ENG_US.package" --out work/base

# 2. Find strings you can actually see in game. Prints a full occurrence ID per hit.
npm run cli -- search --catalog work/base/catalog.json --text "New Game"
npm run cli -- search --catalog work/base/catalog.json --text "Mode" --translatable-only

# 3. Record Estonian text against an ID copied from step 2
npm run cli -- set --catalog work/base/catalog.json --id "BASE|220557DA:00000000:0054935F2685AD48|0DFED87C" --text "Uus mäng"

# 4. Build the mod (--include-unreviewed applies drafts/machine text; reviewed text needs no flag)
npm run cli -- build --catalog work/base/catalog.json --include-unreviewed --out dist/!Sims4_Eesti.package --game-version "1.129.39.1030"

# 5. Install: always dry-run first (see the manual test plan below)
npm run cli -- deploy --file dist/!Sims4_Eesti.package --mods-dir "C:\Users\<you>\Documents\Electronic Arts\The Sims 4\Mods" --dry-run
```

The real install (only after the dry run shows the paths you expect, and with
**the game closed**):

```powershell
npm run cli -- deploy --file dist/!Sims4_Eesti.package --mods-dir "C:\Users\<you>\Documents\Electronic Arts\The Sims 4\Mods"
```

That copies exactly one file, `!Sims4_Eesti.package`, into the Mods folder. It does
not touch other mods, `Resource.cfg`, caches, or your options, and it does not
start or stop the game. Replacing an earlier build of this mod first copies the
old file to `work/backups/` (outside Mods).

To remove the mod again: delete `!Sims4_Eesti.package` from the Mods folder.
Nothing else was changed. (This removal was tested in game — see [Status](#status).)

**If you play the game in another language.** A string table's instance starts
with a locale byte (`00` English, `06` Finnish, and so on), and the game loads
the table for the language it is running in; a mod tagged only English is
therefore ignored under a Finnish game. `build --locales en,fi` writes one
identical copy per language, each tagged for that language. It is verified at the
package level (tests re-read every copy) but not yet observed in game under a
non-English language. The clock's weekday names are compiled into `TS4_x64.exe`
and the game ships no Estonian entry, so they follow the base language (English
"Mon." or Finnish "Ma"); changing the time format is a UI override this project
does not ship.

### Translating the whole game, not one table

The five commands above work on a single package, one string at a time. The beta
goes wider: it catalogs the whole installation, translates in batches through
whatever engine you point at them, and checks the result against an agreed
vocabulary.

```powershell
# 1. Catalog the game installation from each pack's live Delta copy.
#    --prefer-delta labels those tables by pack code (EP01, SP06, ...) and
#    records the stale root-folder copy as shadowed-delta instead of reading it.
npm run cli -- scan --game-root "C:\Program Files (x86)\Steam\steamapps\common\The Sims 4" --prefer-delta --out work/game

# 1b. The Mods folder is a separate root; scan it on its own, then merge.
npm run cli -- scan --game-root "C:\Users\<you>\Documents\Electronic Arts\The Sims 4\Mods" --out work/mods
npm run cli -- merge --catalogs work/game/catalog.json,work/mods/catalog.json --out work/beta-catalog.json

# 2. Export translation batches (JSON), with per-string context: what kind of
#    string it is, its neighbours in the game's own file, its placeholders, and
#    reference translations from the same package's other locales where they exist.
npm run cli -- translate-export --catalog work/beta-catalog.json --out work/batches --batch-size 400 --references work/reference-fi

# 3. Translate the batches (any engine, any translator - the file format is the interface),
#    then import. Import validates every entry and rejects with a reason.
npm run cli -- translate-import --catalog work/beta-catalog.json --in work/batches --translations translations/et-EE.json --metadata translations/metadata.json

# 4. Terminology: hand the agreed vocabulary to every batch, then check the result.
npm run cli -- glossary-check --catalog work/beta-catalog.json --translations translations/et-EE.json --glossary glossary.json
npm run cli -- glossary-merge --in work/terms --write    # fold in the terms translators proposed
```

Two things this design refuses to do: it never treats its own output as a source
(the scan skips `!Sims4_Eesti.package`, so Estonian text can never come back as
"untranslated English"), and it never rewrites a translation to satisfy the
glossary. `glossary-check` reports; a human decides. Terminology consistency is
handled where it actually lives — the concept words in `glossary.json`, not the
190,000 strings — and `glossary.json` records the senses, alternatives and
ambiguities learned by triaging what the checker reports.

### Options that matter

| Flag | Meaning |
| --- | --- |
| `--include-unreviewed` (build) | Also apply drafts/machine text. Stale or invalid entries are still rejected. Without it, only `reviewed` entries are applied. |
| `--force-overwrite-reviewed` (set) | Required to replace text already marked `reviewed`. |
| `--translatable-only` (search) | Hide strings whose syntax this phase cannot validate. |
| `--dry-run` (deploy) | Print exactly what would be copied, then stop. |
| `--force-replace-unknown` (deploy) | Replace a same-named file the tool does not recognise as its own — after backing it up. |
| `--game-version` (build) | Record the game version in the manifest. Without it the manifest says "not recorded" rather than inventing one. |
| `--locales` (build) | Base-game languages to carry the translated table for, e.g. `--locales en,fi` or `all`. Each language gets an identical copy with that locale byte, so the mod applies whichever language the game runs in. Default: only the source language (English). |
| `--sparse` (build) | Emit only translated entries, with no English fallback. **Measured 2026-10-31: the game does not fall through for omitted keys** — a sparse build showed missing text, stray numbers and `wwww`. Do not ship one; whole-table is mandatory. |
| `--prefer-delta` (scan) | Read each pack's strings from `Delta/<pack>` (the current SDX copy), label them by the pack code, and record the root-folder copy as `shadowed-delta`. Measured on the DLC machine: the root copies are years out of date and share the pack's table ID. |
| `--include-delta` (scan) | Read every Delta package, not only the string files. Off by default because the non-string Delta packages are large and hold no text; Mods-over-Delta precedence is verified for string tables (EP01, 2026-10-31). |
| `--include-non-english` (scan) | Read tables for languages other than English. Off by default: a mod repeats its text per locale. |

Copy `config.example.json` to `config.json` to set default paths; command-line
flags always win.

---

## Manual in-game test plan

> **Result of the first run (2026-10-16, game 1.128.90.1030):** the package loaded,
> translated labels appeared, and all twelve probe letters rendered as letters.
> The removal test has since been run too — with the package parked, the interface
> reads `LOAD GAME` / `NEW GAME` again (read by OCR, same screen, same session).
> Still open from this list: a per-label inspection of the items below rather than
> a general confirmation. See [Status](#status).
>
> The checklist below describes that first 105-table build. The 2026-10-31 DLC
> wave has not produced a package yet; after it is built, run the same checks
> against the new one — the table count and content will differ.

The automated tests prove the package is well formed and self-consistent. They
**cannot** prove the game loads it, renders Estonian letters, or shows the new
text where you expect. That is what this checklist is for. Run it once, and
record what you actually saw.

Before you start:

- [ ] **Back up your saves.** Copy `Documents\Electronic Arts\The Sims 4\saves`
      somewhere safe, and use a disposable test save. This mod is text only, but
      treat any mod install as a risk to saves.
- [ ] **Choose your test scope.** To test the game tables alone, move the other
      mods out of the Mods folder; to test the mod translations, keep them in —
      our package overrides the first-named copy of each conflicting table. This
      tool never rearranges your Mods folder for you.
- [ ] Confirm the game is running in **English** and that
      *Options → Game Options → Other → Enable Custom Content and Mods* is on.
- [ ] **Close the game**, then install:
      `npm run cli -- deploy --file dist/!Sims4_Eesti.package --mods-dir "<your Mods folder>"`

Then launch the game and check:

- [ ] The **main menu** labels are Estonian: `Uus mäng` (New Game), `Laadi mäng`
      (Load Game), `Jätka` (Resume/Continue), `Valikud` (Options),
      `Halda maailmu` (Manage Worlds), `Välju mängust` (Exit Game).
- [ ] **Build/Live mode** buttons read `Ehitusrežiim` / `Elurežiim`, and the
      household screen shows `Leibkonnad`.
- [ ] **Options** screen: the tabs read `Mängimine`, `Graafika`, `Heli`,
      `Juurdepääsetavus`, `Autorid` and so on, and inside `Heli` the labels are
      `Helitugevus`, `Hääled:`, `Kasutajaliidese heli:`, `Muusika`.
      (The `Heli` tab carried the `ÕÄÖÜ õäöü ŠŽ šž` rendering probe while glyph
      coverage was being established; that is confirmed, so the probe is retired.
      Its result is recorded in [Status](#status).)
- [ ] `Loo sim` appears for Create a Sim.
- [ ] At least one string in the Simology panel or a Sim tooltip shows
      `Päevi vananemiseni: <number>`, i.e. the `{0.Number}` substitution still
      works and the number appears where the English had it.
- [ ] **An English string that lives in the overridden table is unchanged** —
      e.g. almost any long description or tooltip still reads in English. (The
      whole table is overridden, so anything not in the list above should be
      English.)
- [ ] **Text from a package the mod does not cover is unchanged** — strings
      belonging to DLC this account does not own still read in English. This build
      overrides **105** tables: the four game tables (base game, SP06, SP08, SP14)
      plus the English string table of each installed mod. The other pack data in
      the installation is not owned, not playable, and not touched.
- [ ] **The three stuff packs are Estonian** — e.g. in Build Mode, Romantic
      Garden's wishing well, Backyard Stuff's lawn water slide and My First Pet's
      rodent cages have Estonian names and tooltips.
- [ ] **The mods are Estonian** — open WickedWhims settings, Basemental Drugs and
      MC Command Center; tabs, settings, moodlets and notifications should be
      Estonian, with proper names such as WickedWhims and MC Command Center kept.
- [ ] **Optional independent inspection.** Open `dist/!Sims4_Eesti.package` in
      Sims 4 Studio (a separate, independently written tool — *not* a dependency
      of this project, and not installed on this machine) and confirm the first
      build lists 105 string tables: the four game tables (`220557DA:00000000:0054935F2685AD48`
      with 58,374 entries, `...009DD507B385879F` with 230, `...00A9BC4CEC99A5F8`
      with 198 and `...00BEA5E1D2845652` with 269) plus one table for each
      translated mod.
      Reopening the file with the same library that wrote it is necessary but not
      sufficient as evidence; this is the outside check.
- [ ] **Nothing is broken:** no blank buttons, no raw IDs like
      `220557DA:...` or `{0.Number}` showing literally, no obviously clipped or
      overlapping text.
- [ ] Record the game version shown in the main menu's bottom corner, plus any
      oddity you saw (this prototype was never run in game by its author — see
      [Status](#status)).

Finally, verify removal:

- [ ] Close the game, delete only `!Sims4_Eesti.package` from the Mods folder,
      restart, and confirm the interface is back in English.

If the text does **not** change at all, the likely causes are, in order: the mod
is not enabled in Game Options; another package with the same resource ID loads
later; or the game updated and the package needs a rebuild.

---

## What is translated today

107,778 entries across the install-wide catalog. `translations/et-EE.json` holds
the text and `translations/metadata.json` the state and source hash of each
entry. The 0.5.0 package ships the 14 tables below; the later packs and the game
packs are queued, and the mod tables are not shipped in this version.

| Table group | Entries | Translated | What it covers |
| --- | --- | --- | --- |
| Base game | 58,419 | 56,328 | every string except names, identifiers and deferred syntax |
| Get to Work (EP01) | 4,476 | 4,345 | careers, retail, aliens |
| Get Together (EP02) | 2,431 | 2,302 | Windenburg, clubs |
| City Living (EP03) | 5,245 | 4,903 | San Myshuno, apartments, festivals |
| Cats & Dogs (EP04) | 3,248 | 3,087 | pets, vet clinics, Brindleton Bay |
| Seasons (EP05) | 3,169 | 3,096 | weather, holidays, calendars |
| Get Famous (EP06) | 4,145 | 4,071 | acting, fame, Del Sol Valley |
| Island Living (EP07) | 2,311 | 2,225 | Sulani, mermaids, conservation |
| Discover University (EP08) | 4,744 | 4,679 | Britechester, Foxbury, degrees |
| Eco Lifestyle (EP09) | 2,898 | 2,855 | Evergreen Harbor, fabrication, N.A.P. |
| Snowy Escape (EP10) | 3,137 | 3,049 | Mt. Komorebi, snow sports, lifestyles |
| Romantic Garden Stuff (SP06) | 269 | 226 | item names, tooltips, moodlet text |
| My First Pet Stuff (SP14) | 230 | 209 | same, for that pack |
| Backyard Stuff (SP08) | 198 | 190 | same, for that pack |
| **Shipped total** | **94,920** | **91,565 (96.5%)** | 3,355 entries stay English |
| Mods (not shipped) | 31,578 | 15,354 | deferred to a later release |

In the stored mod translations, three packages duplicate another package's table
ID (`KhyanTristanScreen`, `WW_mike24_Classic`, `WW_mike24_DarkFantasies`); the
game loads the first-named copy, so 469 translations from the shadowed copies are
not applied and the winning copies are the ones emitted.

On the 2026-10-31 machine the Mods folder holds **31,578 strings in 87 packages**.
15,354 stored translations still match their source; 8 are orphaned by a
Basemental Real Drink Names table that changed its keys; 417 sit on old mod
package labels that are no longer installed under those names (renamed or
replaced packages, chiefly `WW_mike24_DF`/`WW_mike24_DarkFantasies`);
and 16,010 strings are untranslated, mostly in mods that are new here (NisaK's
Wicked Perversions 2,535, Devious Desires 2,468, Deviant Core 1,461, CinErotique
958).

The three packs' tables are translated in full apart from 72 entries the tool
deliberately leaves in English: gender/plural branches such as
`{M0.he'd}{F0.she'd}`, HTML-like markup, and empty strings (see
[Limitations](#limitations-you-should-know-about)).

**DLC coverage is new and in progress.** The first machine owned three stuff
packs; the 2026-10-31 machine carries 116 pack tables (163,302 game strings in
all). The 2026-10-31 wave translated the base game and EP01–EP10; 0.5.0 ships
those 14 tables, and every later pack still stays English. The pack tables are
read from `Delta/<pack>`. A Mods package overriding a `Delta` table was confirmed
in game on 2026-10-31 with an EP01-only package (it rendered Estonian).

On the current base table (58,419 entries), 56,328 translations match their English
source and 2,091 remain in English: proper names, identifiers, deferred syntax, and
the 45 entries added by 1.129.
The labels confirmed on screen in the first trial are listed in the
[manual test plan](#manual-in-game-test-plan).

**All 107,778 stored translations (91,565 of them shipped in 0.5.0) are machine-drafted and unreviewed.** `npm run cli --
build` without `--include-unreviewed` will refuse to apply them, and the manifest
reports `reviewedApplied: 0` — no human has reviewed these translations, and none
of them was produced by a human translator. See `glossary.json` for the vocabulary
and style rules they follow, and the `note` on each entry in
`translations/metadata.json` for how it came to exist.

## Limitations you should know about

- **Untranslated entries keep their English text** inside the emitted table. That
  is deliberate: the tool does not rely on the game falling through to the
  original resource for missing entries, which is unverified behaviour.
- **Complex syntax is translated, not skipped.** Gender and plural branches,
  pronoun expressions and HTML-like markup are all carried through, because the
  game's own Finnish translation shows how: `{S0.Pack}{P0.Packs}` becomes
  `{S0.paketti}{P0.paketit}`, `{M1.his}{F1.her} dreams?` becomes a sentence with
  the branch gone (Estonian has no grammatical gender either), and
  `{0.SimPronounSubjective|xxUpper} can also Mentor others` becomes
  `Hän voi myös opastaa muita`. The validator enforces the mechanics: variant
  branches must survive as whole groups, markup tags character for character,
  value references inside branches untouched. Measured against the first
  machine's 58,374-entry base table:

  | Strings | Share | Status |
  | --- | --- | --- |
  | 53,655 | 91.9% | no syntax at all |
  | 2,524 | 4.3% | carries a gender branch (write both alike, or drop the pair) |
  | 346 | 0.6% | carries a number or wording-style branch (all variants kept) |
  | 1,700 | 2.9% | carries markup (tags kept exactly) |
  | 576 | 1.0% | carries a pronoun the game would render in English (replaced by a word) |
  | 4 | 0.0% | still deferred: brace shapes and tags that parse as neither |

- **Runtime values still render in the game's own language.** A translated
  sentence that inserts a Sim's name, a day of the week, an amount of money or a
  date will show that value as the game produces it (English), because this mod
  overrides text without registering a new locale. Pronouns are the exception: a
  translator may replace `{0.SimPronounSubjective}` with the Estonian word rather
  than leave an English "he" inside the sentence.
- **Whole-table overrides can go stale after a game update.** The build checks
  the source file's fingerprint at build time, but nothing protects a player who
  updates the game after installing. Rebuild after each game update.
- **Estonian glyph coverage is confirmed in game** for the twelve letters in the
  probe (`Õ Ä Ö Ü õ ä ö ü Š Ž š ž`), including `Š` and `Ž`, which never appear in
  the game's own English text. Other alphabets' letters remain untested.
- **Package integrity is verified, game behaviour is not.** See
  [Status](#status).

## Status

### First machine (game 1.128.90.1030) — the deployed artifact

Verified on the first machine, with evidence in `docs/IMPLEMENTATION_NOTES.md`:

- 110 automated tests pass (`npm test`; 109 at the time of the first run, plus the
  `--prefer-delta` scan test added on 2026-10-31). The 4 integration tests against the real
  `Strings_ENG_US.package` also pass, but only when pointed at it — without
  `SIMS4_EESTI_SOURCE_PACKAGE` they are skipped, and a skipped test is not a pass:
  ```powershell
  $env:SIMS4_EESTI_SOURCE_PACKAGE = "C:\Program Files (x86)\Steam\steamapps\common\The Sims 4\Data\Client\Strings_ENG_US.package"
  npm run test:game
  ```
- The built package was reopened and compared entry by entry against the source:
  74,721 / 74,721 entries across 105 tables, exactly 71,806 changed, 0 unexpected
  differences, identical resource identity, all 64-bit instance IDs preserved.
- Output is byte-identical across separate builds: the package rebuilt hours later,
  after code changes, has the same sha256 as the deployed one.
- All 92 source packages were fingerprinted again at build time and had not
  changed since extraction; none was written to.
- **The mod was loaded in the real game** — game 1.128.90.1030, Steam install,
  2026-10-16. The tester reported translated labels appearing, and confirmed that
  all twelve probe letters `Õ Ä Ö Ü õ ä ö ü Š Ž š ž` render as letters in the
  interface. `Š` and `Ž` never occur in the game's own English text, so their
  coverage could only be established this way.
- **The Mods folder wins for this resource**: the game ships its own copy of the
  table we override, and our text is what appears.

Also verified: **removal**. With the package parked outside Mods and the game
relaunched on the same screen, the buttons read `LOAD GAME` / `NEW GAME` again
(read by OCR, 2026-10-16, game 1.128.90.1030).

### Second machine (game 1.129.39.1030) — measured 2026-10-31, not yet played

- The 4 integration tests against this machine's `Strings_ENG_US.package` pass
  (`SIMS4_EESTI_SOURCE_PACKAGE=...` + `npm run test:game`); the full synthetic
  suite is 110/110.
- The installation was scanned read-only from the live `Delta/<pack>` copies:
  **117 game tables and 163,302 strings**; 606 stale root-folder copies recorded
  as `shadowed-delta`, 1,768 non-English tables skipped. Nothing in the game
  folder was written to.
- The stored translations survive the move: 56,491 game entries still match their
  source by hash, 5 are stale, and **0 game occurrence IDs are orphaned**. The
  Mods folder, now 31,578 strings in 87 packages, keeps 15,354 matching
  translations; 8 have changed keys and 417 sit on retired mod package labels
  (renamed/replaced packages) and are not applied.
- **Fall-through does not happen.** A two-entry probe overriding only `New Game`
  and `Options` in the base table (2026-10-31) left the other labels missing,
  with stray numbers and `wwww` where the omitted text should have been. The game
  does not fall through to its own table for omitted entries, so **whole-table
  overrides are mandatory**; a sparse build is not shippable.
- **Mods overrides a `Delta` pack table.** An EP01-only whole-table package
  installed in Mods rendered Estonian in game on 2026-10-31, confirming that the
  live `Delta/EP01` table is replaced by the Mods copy.
- The **0.5.0 build** (14 tables: base, EP01–EP10, SP06, SP08, SP14) passes the
  build's own verification: the package is reopened with the library and compared
  entry by entry against an independent byte-level reader. It has **not yet been
  launched in game**.
- The **child-safe local build** (71 tables: the 36 installed add-ons plus the
  surviving QoL/CC mods; 107,585 translations, 3,499 English fallback) was launched
  by the owner on 2026-11-01 and reported working. The prepared **0.6.0 release
  build** adds the three 0.5.0 packs not installed on this PC (EP07/EP09/EP10) and
  the same mod tables: 74 tables, 115,714 translations, 3,716 English fallback; it
  passes the build verification but is not separately playtested.
- The **0.4.0 build** (seven tables: base, SP06, SP08, SP14, EP01, EP02 partial,
  EP06) was installed and launched on this machine: the main menu rendered in
  Estonian (2026-10-31). It was also downloaded from the Nexus page and deployed
  with **Vortex** on a second PC, and rendered there after custom content and mods
  were enabled. Nexus mod page: <https://www.nexusmods.com/thesims4/mods/7387>.

Not verified:

- **The mod-table overrides have not been observed in game.** The package
  overrides the English table of each installed mod by resource ID, and the
  load-order probes established that the first-named package wins for a
  conflicting game resource; whether the same is true when the competing table
  belongs to another mod has not been watched. The 469 translations from the
  three duplicate table IDs were deliberately not applied because their copies
  are shadowed by the first-named package.
- No systematic clipping check on the longer labels, and the individual labels of
  the main checklist were not each confirmed by eye — the tester's confirmation was
  general, plus the Audio tab probe specifically.
- **No human has reviewed the 107,778 stored translations.** All are machine-drafted and the
  manifest reports `reviewedApplied: 0`.
- **The branch rules rest on shipped evidence, not on this machine.** That
  Estonian may drop a whole gender pair (`{M0.his}{F0.her}`), keep both branches
  alike, or write a word where the game would insert an English pronoun is
  inferred from EA's own Finnish translation. None of those three has yet been
  watched rendering in this game; they belong in the next in-game session.
- The first 672 entries were translated before the glossary and the Finnish
  reference material existed, so their terminology has been checked
  (`glossary-check`) but not regenerated against those inputs.
- **The shipped artifact is English-only.** `--locales` can add copies for other
  base languages, but those copies have not been observed in game. The
  package-level test proves they differ only in the locale byte, and all four
  Finnish `06` instances match the game's own Finnish reference tables exactly
  (measured); whether a Finnish game loads such a copy and shows the Estonian
  text is an in-game check, not a verified result. The clock's weekday text was
  traced statically to the executable's locale registry; the Finnish row (`Ma`,
  `Ti`, …) has not been seen on screen.

## Secrets, and the pre-commit guard

Two files on this machine hold credentials and must never be published: `.env`
(a GitHub token) and `claude-deepseek-windows.sh` (an API auth token). Both are
git-ignored, and `githooks/pre-commit` makes an accident harder rather than merely
unlikely:

- it refuses to commit a fixed list of local-only paths — including those two,
  and `*.pem` / `*.key` / `id_rsa*` / `.npmrc` — **even when force-added** with
  `git add -f`;
- it refuses to commit *content* that looks like a credential, in any file:
  GitHub and OpenAI token shapes, private-key headers, `ANTHROPIC_AUTH_TOKEN=`.

Enable it in a fresh clone:

```powershell
git config core.hooksPath githooks
```

`.gitattributes` pins LF endings for `githooks/*` and `*.sh` — a CRLF shebang
breaks shell scripts in Git for Windows — and marks `*.package` as binary so
artifacts are never line-ending-normalised.

## Repository layout

```
src/
  cli.ts           command line: extract, scan, coverage, merge, search, set,
                   build, deploy, translate-export/import/stats, glossary-check/merge
  package-io.ts    the only module that touches @s4tk/models
  stbl-format.ts   minimal independent STBL reader, used for verification only
  catalog.ts       extraction, catalog files, search
  scan.ts          install-wide discovery: base game, packs, Mods; with
                   --prefer-delta reads the live Delta/<pack> strings and skips
                   the stale root copy; always skips our own output
  merge.ts         merges catalogs, refusing label collisions (a rename would
                   orphan translations)
  translate.ts     batch export/import with per-string context, and validation
                   on the way back in
  references.ts    reference translations: supplied files and packages' own
                   sibling locales, with English stubs detected and dropped
  glossary.ts      agreed terminology: injected into batches, checked against
                   finished translations, never enforced
  translations.ts  translation + metadata storage, the "set" command
  validation.ts    what may be applied, and why things are refused
  build.ts         whole-table override build + verification
  deploy.ts        one-file Mods folder install with backups
  ids.ts           TGI/occurrence identity, lossless 64-bit hex, locale bytes
  hashing.ts       SHA-256 helpers
tests/             synthetic fixtures, built in code (no game data committed)
translations/      et-EE.json (text) and metadata.json (state, source hash, origin)
glossary.json      agreed Estonian terms, with alternatives and the senses learned
                   by triaging what the checker reported
probes/            in-game experiments (precedence, fall-through, Mods-vs-Delta)
                   and their results
config.example.json
work/              ignored: catalogs, batches, reference files, backups
dist/              ignored: built packages
```

Phase 1 (one package, one table, safe build, in-game proof) is complete. Phase 2's
installation-wide catalog, source diffing and bulk translation pipeline are built;
what remains of it is the DLC wave, the review loop and the community side. See
`docs/Sims4_Eesti_Implementation_Brief.md`, `docs/PHASE2_DESIGN.md` and
`docs/IMPLEMENTATION_NOTES.md`. What the project learned the hard way is in
`LESSONS.md`, and how the remaining
work is sequenced is in `RUN_PLAN.md`.

---

## Translating into your own language

This repository was built for Estonian, but the pipeline is not: it reads the
English string tables, gives a translator per-string context, and validates what
comes back. A fork for another language changes four things:

1. **The target locale and language name** — passed to the batch exporter, and
   nothing else needs to know:
   ```powershell
   npm run cli -- translate-export --catalog work/beta-catalog.json `
     --translations translations/fi-FI.json --packages BASE --dedupe-texts `
     --target-locale fi-FI --language-name Finnish --out work/batches-fi
   ```
   `translations/et-EE.json` becomes your `<locale>.json`, set in `config.json`.
2. **The style notes** in `src/translate.ts` (`STYLE_NOTES`). They contain facts
   about Estonian — no grammatical gender, case endings, the Finnish reference —
   that a translator for another language must rewrite. The first line is filled
   in from `--language-name`; the rest is prose you should edit.
3. **The glossary** (`glossary.json`) — write your own terms. The `en`/`et` field
   names are historical: `et` is simply "the target language".
4. **The lint** (`src/lint.ts`) looks for Finnish morphology leaking into
   Estonian. Point it at your own reference language, or disable it; it is a
   triage aid, not a correctness check.

The rest — extraction, the catalogs, batch export and import, validation, the
build's two-reader verification, deployment, the glossary and drift checks — is
language-agnostic. `LESSONS.md` is worth reading before you design anything here;
most of its items cost a day each to learn once.

---

## Footnote: who wrote this

Everything here — the tool in `src/`, the tests, the Estonian text, the probe
kits, and these documents — was produced by an AI agent in sessions on
2026-10-16 through 2026-10-20 and again on 2026-10-31: **DeepSeek 4.1 Flash**
(the model this session's environment reports as `deepseek-flash[1m]`), driving
the Claude Code harness. A model cannot verify its own identity from the inside,
so that is recorded as the person who ran the sessions states it and as the
environment reports it — not as something the agent observed. The batch
translations come from subagents of the same sessions.

The person in the loop is Lauri. He commissioned the implementation brief — which
Codex wrote — set the constraints the work runs under (game installation and
saves read-only, no invented results, no secrets in git), chose what to build at
each step, and was the hands for everything that needed a human present: running
the game and its probes, reading the screens, supplying the paths and
credentials, and — on the first machine — switching Steam to Finnish so the agent
could read EA's own translation of all 58,374 strings. On the 2026-10-31 machine
the Finnish tables were already on disk; the agent read them there. The commits
carry his git identity because they were made from his machine; the text inside
them was not written by him.

Two things sit outside that authorship: `docs/Sims4_Eesti_Implementation_Brief.md`
is Codex's, and the conventions the work was held to came from Lauri's own
machine-wide rules, which live outside this repository.

Nothing in this repository has been reviewed by a human translator. The
`reviewed` state exists for that review to be recorded in — today every entry is
`machine`, and the manifest says so.
