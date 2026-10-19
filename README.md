# Sims 4 Eesti

An unofficial, noncommercial **prototype** that builds an Estonian text mod for
The Sims 4 out of the English string files already on your own PC.

It is a local command-line tool, not a translation website and not an installer:
you point it at one English `.package`, pick strings, write Estonian text, and it
writes one `.package` you can drop into your Mods folder.

**Scope of this prototype:** an install-wide catalog (75,349 English strings: the
base game's 58,374, the three owned stuff packs, and 88 mod packages) and **72,275
translated entries across 105 string tables** — the base game, Romantic Garden
Stuff (SP06), Backyard Stuff (SP08), My First Pet Stuff (SP14), and the English
string tables of the installed mods (WickedWhims, Basemental Drugs, MC Command
Center, and the rest). Untranslated entries keep their English text. This is not
a complete Estonian localisation of the game, and no translation here has been
reviewed by a human.

**Nothing here is approved, endorsed, or supported by EA or Maxis.** See
[Legal and distribution](#legal-and-distribution) before sharing anything.

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
| Windows | Windows 11 Pro (26100) |
| Node.js | v22.18.0 (LTS) |
| npm | 11.6.4 |
| TypeScript | 7.0.2 (`tsc --noEmit`, strict) |
| `@s4tk/models` | 0.6.14 (pinned) |
| `@s4tk/compression` | 0.2.0 (pinned) |
| tsx | 4.23.15 (runs the TypeScript CLI directly) |
| Game | The Sims 4 **1.128.90.1030**, Steam install, English (`en_US`) |

There is no build step: `npm run cli` runs the TypeScript directly through tsx.

## Install

```powershell
npm ci
npm test          # 109 tests, all synthetic; no game files needed
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
npm run cli -- build --catalog work/base/catalog.json --include-unreviewed --out dist/!Sims4_Eesti.package --game-version "1.128.90.1030"

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
Nothing else was changed. (This removal was tested in game — see
[Status](#status-and-what-is-unverified).)

**If you play the game in another language.** A string table's instance starts
with a locale byte (`00` English, `06` Finnish, and so on), and the game loads
the table for the language it is running in. A mod tagged only English is
therefore ignored under a Finnish game. `build --locales en,fi` writes one
identical copy per language, each tagged for that language, so the Estonian text
appears whichever of them the game runs in. This is the same mechanism the
Ukrainian translation project retags by hand in Sims 4 Studio. It is verified at
the package level (tests re-read every copy) but not yet observed in game under a
non-English language. One thing no package can change: the clock's weekday names
are compiled into `TS4_x64.exe`, and the game ships no Estonian entry for them,
so they follow the base language (English "Mon." or Finnish "Ma") either way.
Changing the time format itself (12-hour to 24-hour) is a UI override, not a
string-table change; this project does not ship one. A known third-party option
is Crinlorite's *Clock – 24 hours* on CurseForge: it forces the main HUD clock to
24-hour and keeps the weekday in the game's language. It is All Rights Reserved,
is not bundled here, has not been tested against this installation, and by its
own description does not convert calendar, career, university or notification
times.

### Translating the whole game, not one table

The five commands above work on a single package, one string at a time. The beta
goes wider: it catalogs the whole installation, translates in batches through
whatever engine you point at them, and checks the result against an agreed
vocabulary.

```powershell
# 1. Catalog the whole installation: base game, packs, and your mods.
#    Skips the game's own Delta patches and this tool's previous output.
npm run cli -- scan --root "C:\Program Files (x86)\Steam\steamapps\common\The Sims 4" --mods "C:\Users\<you>\Documents\Electronic Arts\The Sims 4\Mods" --out work/beta-catalog.json

# 2. Export translation batches (JSON), with per-string context: what kind of
#    string it is, its neighbours in the game's own file, its placeholders, and
#    reference translations from the same package's other locales where they exist.
npm run cli -- translate-export --catalog work/beta-catalog.json --out work/batches --batch-size 400 --references work/finnish

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
handled where it actually lives — the ~50 concept words in `glossary.json`, not
the 67,000 strings — and `glossary.json` records the senses, alternatives and
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
| `--sparse` (build) | Emit only translated entries, with no English fallback. The game must fall through for omitted keys, which is not verified yet; use the sparse probe before distributing such a build. |

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
      of this project, and not installed on this machine) and confirm it lists
      105 string tables: the four game tables (`220557DA:00000000:0054935F2685AD48`
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
      [Status](#status-and-what-is-unverified)).

Finally, verify removal:

- [ ] Close the game, delete only `!Sims4_Eesti.package` from the Mods folder,
      restart, and confirm the interface is back in English.

If the text does **not** change at all, the likely causes are, in order: the mod
is not enabled in Game Options; another package with the same resource ID loads
later; or the game updated and the package needs a rebuild.

---

## What is translated today

72,275 entries across 105 string tables. `translations/et-EE.json` holds the
text and `translations/metadata.json` the state and source hash of each entry.

| Table group | Entries | Translated | What it covers |
| --- | --- | --- | --- |
| Base game | 58,374 | 55,871 | the base game, wave 1 complete: every string except names, identifiers and deferred syntax |
| Romantic Garden Stuff (SP06) | 269 | 226 | the pack's item names, tooltips and moodlet text |
| My First Pet Stuff (SP14) | 230 | 209 | same, for that pack |
| Backyard Stuff (SP08) | 198 | 190 | same, for that pack |
| WickedWhims (Tuning) | 6,354 | 6,269 | the mod's interactions, settings, moodlets and notifications |
| Basemental Drugs | 4,831 | 4,745 | drugs, effects, settings and notifications |
| MC Command Center | 3,201 | 3,161 | settings, commands and dialogs |
| All other mods (85 packages) | 1,892 | 1,604 | animation packs, object/CC names and descriptions |

The mods account for 15,779 of the 16,278 strings in the 88 mod packages
(96.9%). The remaining 499 are proper names, world names, brand/URL text,
progressive `Nintendo…` label fragments and ambiguous duplicate keys that are
deliberately left English. Three mod packages duplicate another package's table
ID (`KhyanTristanScreen`, `WW_mike24_Classic`, `WW_mike24_DarkFantasies`); the
game loads the first-named copy, so 469 translations from the shadowed copies
were not applied and the winning copies are the ones emitted.

The three packs' tables are translated in full apart from 72 entries the tool
deliberately leaves in English: gender/plural branches such as
`{M0.he'd}{F0.she'd}`, HTML-like markup, and empty strings (see
[Limitations](#limitations-you-should-know-about)).

**Only owned DLC is in scope.** This account owns the three stuff packs above;
the other pack data present in the installation belongs to packs that are not
installed or playable, so it is not translated and not part of the backlog. The
three owned packs are now catalogued from their current `Delta/` copies (game
version 1.128.90.1030), not the older standalone folders: the Delta tables add
22 keys and change 9 source texts, and those additions are translated here. What
is still unverified is whether a Mods package overrides a `Delta/` table at
load time; the base-game override is verified, the pack path is not.

The base game is 95.7%
translated: the most-seen slice, the syntax slice, and the first ~4,000 strings of
wave 1 in table order.
The base game is translated **only** where listed below — 55,871 of its 58,374
entries are translated, the other 2,503 keep their English text.

The 57 base-game entries, grouped by where you will see them:

| Group | Estonian | Where to look |
| --- | --- | --- |
| Main menu | `Jätka mängu`, `Uus mäng`, `Laadi mäng`, `Valikud`, `Halda maailmu`, `Välju mängust`, `Galerii`, `Mängi stsenaariumi`, `Kogu`, `Avaleht` | Main menu |
| Options dialog tabs | `Mängimine`, `Graafika`, `Heli`, `Juurdepääsetavus`, `Autorid`, `EA konto`, `Õppetunnid`, `Keskkond`, `Mängukaamera` | Options, across the top |
| Audio screen | `Helitugevus`, `Hääled:`, `Kasutajaliidese heli:`, `Muusika` | Options → Heli |
| In-game menu | `Menüü`, `Salvesta mäng?`, `Välju peaekraanile`, `Mängu valikud`, `Salvesta mäng` | ESC menu |
| Pack selection | `Pakettide valik`, `Mängupaketid`, `Laienduspaketid`, `Komplektid`, `Väljalaskemärkmed` | Pack Selection screen |
| Mode switcher | `Ehitusrežiim`, `Elurežiim` | bottom-left in game |
| Households and CAS | `Leibkonnad`, `Loo sim` | Manage Worlds, Create a Sim |
| Build / CAS controls | `Võta tagasi`, `Võta tagasi/Tee uuesti` | build mode |
| Sim info | `Päevi vananemiseni: {0.Number}` | Sim tooltip / Simology |
| Build/buy tag | `Heli` | category filter |

Every group was chosen by inspecting the strings that sit next to each label in
the table (Maxis groups UI text in blocks) — see `docs/IMPLEMENTATION_NOTES.md` for why
that is the only offline evidence available, and for the one label that was
chosen wrongly before the first trial. Two labels are deliberately **not**
translated: `Marketplace` and one of the two `Home` entries, both of which share
their text with a build/buy list, where a single translation would change a
category name too.

**All 72,275 of these entries are machine-drafted and unreviewed.** `npm run cli --
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
  value references inside branches untouched. Measured against the base game's
  table:

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
  [Status](#status-and-what-is-unverified).

## Status

Verified on this machine, with evidence in `docs/IMPLEMENTATION_NOTES.md`:

- 109 automated tests pass (`npm test`). The 4 integration tests against the real
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

Not verified:

- **Whether a package may override only *some* entries of a table** and have the
  game fall through for the rest. This build sidesteps the question by shipping
  each overridden table whole (hence 2.1 MiB rather than a few kilobytes); the
  probe that would answer it is generated and waiting in `probes/precedence/`.
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
- **No human has reviewed the 72,275 translations.** All are machine-drafted and the
  manifest reports `reviewedApplied: 0`.
- **The branch rules rest on shipped evidence, not on this machine.** That
  Estonian may drop a whole gender pair (`{M0.his}{F0.her}`), keep both branches
  alike, or write a word where the game would insert an English pronoun is
  inferred from EA's own Finnish translation. None of those three has yet been
  watched rendering in this game; they belong in the next in-game session, next
  to the fall-through probe.
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

## Legal and distribution

- This tool reads the game files on your own PC and writes a mod. It does not
  distribute game content, and this repository contains no game data.
- The **full build** (105 tables) contains the English text of every overridden
  mod table (2,915 fallback entries plus the 71,806 translated ones). That
  includes third-party mod content, so the full package stays private; do not
  publish it as a release asset.
- The **game-and-packs build** (4 tables, 56,496 translations) is the package
  attached to the beta release. It contains 2,575 English fallback entries from
  EA's own game tables, because whole-table override is the only strategy verified
  so far. It is published as a noncommercial mod under EA's mod policy; the
  project is not affiliated with or endorsed by EA or Maxis.
- `--sparse` can remove that fallback, but only once the game is shown to fall
  through for omitted keys. Until then, a sparse package is experimental.
- EA's mod policy requires noncommercial distribution and prohibits suggesting
  EA or Maxis endorsement. It does not pre-approve this project. Review it before
  publishing anything: <https://help.ea.com/en/articles/the-sims/the-sims-4/mods-policy/>
- The translations in `translations/` are machine-drafted and unreviewed. Do not
  present them as human-reviewed work.

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
  scan.ts          install-wide discovery: base game, packs, Mods; skips Delta
                   and our own output
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
probes/            in-game experiments (precedence, fall-through) and their results
config.example.json
work/              ignored: catalogs, batches, reference files, backups
dist/              ignored: built packages
```

Phase 1 (one package, one table, safe build, in-game proof) is complete. Phase 2's
installation-wide catalog, source diffing and bulk translation pipeline are built;
what remains of it is the review loop and the community side. See
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
2026-10-16 through 2026-10-20: **DeepSeek 4.1 Flash** (the model this session's
environment reports as `deepseek-flash[1m]`), driving the Claude Code harness.
A model cannot verify its own identity from the inside, so that is recorded as
the person who ran the sessions states it and as the environment reports it —
not as something the agent observed. The batch translations come from subagents
of the same sessions.

The person in the loop is Lauri. He commissioned the implementation brief — which
Codex wrote — set the constraints the work runs under (game installation and
saves read-only, no invented results, no secrets in git), chose what to build at
each step, and was the hands for everything that needed a human present: running
the game and its probes, reading the screens, switching Steam to Finnish so the
agent could read EA's own translation of all 58,374 strings, and supplying the
paths and credentials. The commits carry his git identity because they were made
from his machine; the text inside them was not written by him.

Two things sit outside that authorship: `docs/Sims4_Eesti_Implementation_Brief.md`
is Codex's, and the conventions the work was held to came from Lauri's own
machine-wide rules, which live outside this repository.

Nothing in this repository has been reviewed by a human translator. The
`reviewed` state exists for that review to be recorded in — today every entry is
`machine`, and the manifest says so.
