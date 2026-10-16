# Sims 4 Eesti

An unofficial, noncommercial **prototype** that builds an Estonian text mod for
The Sims 4 out of the English string files already on your own PC.

It is a local command-line tool, not a translation website and not an installer:
you point it at one English `.package`, pick strings, write Estonian text, and it
writes one `.package` you can drop into your Mods folder.

**Scope of this prototype:** one supplied package (by default the base game's
`Data\Client\Strings_ENG_US.package`), 57 translated entries out of its 58,374,
covering 44 distinct English strings across the menus, the options dialogs and the
mode switcher. Every
other entry in that table keeps its English text. This is not a complete Estonian
localisation of the game.

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

Every step refuses to guess: strings whose placeholders or markup the tool does
not fully understand are left in English and reported, never half-translated.

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
npm test          # 89 tests, all synthetic; no game files needed
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
Nothing else was changed.

### Options that matter

| Flag | Meaning |
| --- | --- |
| `--include-unreviewed` (build) | Also apply drafts/machine text. Stale or invalid entries are still rejected. Without it, only `reviewed` entries are applied. |
| `--force-overwrite-reviewed` (set) | Required to replace text already marked `reviewed`. |
| `--translatable-only` (search) | Hide strings whose syntax this phase cannot validate. |
| `--dry-run` (deploy) | Print exactly what would be copied, then stop. |
| `--force-replace-unknown` (deploy) | Replace a same-named file the tool does not recognise as its own — after backing it up. |
| `--game-version` (build) | Record the game version in the manifest. Without it the manifest says "not recorded" rather than inventing one. |

Copy `config.example.json` to `config.json` to set default paths; command-line
flags always win.

---

## Manual in-game test plan

> **Result of the first run (2026-10-16, game 1.128.90.1030):** the package loaded,
> translated labels appeared, and all twelve probe letters rendered as letters.
> Still open from this list: the removal test, and a per-label inspection of the
> items below rather than a general confirmation. See [Status](#status).

The automated tests prove the package is well formed and self-consistent. They
**cannot** prove the game loads it, renders Estonian letters, or shows the new
text where you expect. That is what this checklist is for. Run it once, and
record what you actually saw.

Before you start:

- [ ] **Back up your saves.** Copy `Documents\Electronic Arts\The Sims 4\saves`
      somewhere safe, and use a disposable test save. This mod is text only, but
      treat any mod install as a risk to saves.
- [ ] **Isolate the test.** Temporarily move your other mods out of the Mods
      folder (or use a second user folder), because other mods can also override
      strings. This tool never rearranges your Mods folder for you.
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
- [ ] **Text from another package is unchanged** — e.g. strings belonging to your
      stuff packs (Backyard Stuff, My First Pet Stuff, Romantic Garden Stuff)
      still read in English. Note that this build has no "untouched table" to
      compare against: the source file
      (`Data\Client\Strings_ENG_US.package`) contains exactly **one** string
      table (58,374 entries), and the mod overrides that one table. Strings in
      other packages come from tables with different resource IDs and are not
      touched.
- [ ] **Optional independent inspection.** Open `dist/!Sims4_Eesti.package` in
      Sims 4 Studio (a separate, independently written tool — *not* a dependency
      of this project, and not installed on this machine) and confirm it lists one
      string table, `220557DA:00000000:0054935F2685AD48`, with 58,374 entries.
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

57 entries covering 44 distinct English strings, all base game. Grouped by where
you will see them; the full list with keys is `translations/et-EE.json`.

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
the table (Maxis groups UI text in blocks) — see `IMPLEMENTATION_NOTES.md` for why
that is the only offline evidence available, and for the one label that was
chosen wrongly before the first trial. Two labels are deliberately **not**
translated: `Marketplace` and one of the two `Home` entries, both of which share
their text with a build/buy list, where a single translation would change a
category name too.

**All of this text is machine-drafted and unreviewed.** `npm run cli -- build`
without `--include-unreviewed` will refuse to apply it, and the manifest reports
`reviewedApplied: 0` — no human has reviewed these translations, and none of them
was produced by a human translator. See `glossary.json` for the vocabulary and
style rules they follow.

## Limitations you should know about

- **Untranslated entries keep their English text** inside the emitted table. That
  is deliberate: the tool does not rely on the game falling through to the
  original resource for missing entries, which is unverified behaviour.
- **Strings with complex syntax are skipped.** Gender/plural branches such as
  `{M0.his}` / `{F0.she}`, pronoun expressions such as
  `{0.SimPronounSubjective}`, and all HTML-like markup (`<span class="pink">`,
  `<b>`) are left in English. Preserving them verbatim would leave English words
  inside Estonian sentences — see `IMPLEMENTATION_NOTES.md` for the survey these
  rules come from. Measured against the base game's table:

  | Strings | Share | Status |
  | --- | --- | --- |
  | 53,551 | 91.7% | eligible for translation today |
  | 3,315 | 5.7% | deferred: gender/plural/pronoun expressions |
  | 1,501 | 2.6% | deferred: HTML-like markup |
  | 7 | 0.0% | unbalanced or nested braces, left alone |

- **Runtime values still render in the game's own language.** A translated
  sentence that inserts a Sim's name, a day of the week, an amount of money or a
  date will show that value as the game produces it (English), because this mod
  overrides text without registering a new locale.
- **Whole-table overrides can go stale after a game update.** The build checks
  the source file's fingerprint at build time, but nothing protects a player who
  updates the game after installing. Rebuild after each game update.
- **Estonian glyph coverage is confirmed in game** for the twelve letters in the
  probe (`Õ Ä Ö Ü õ ä ö ü Š Ž š ž`), including `Š` and `Ž`, which never appear in
  the game's own English text. Other alphabets' letters remain untested.
- **Package integrity is verified, game behaviour is not.** See
  [Status](#status-and-what-is-unverified).

## Status

Verified on this machine, with evidence in `IMPLEMENTATION_NOTES.md`:

- 89 automated tests pass (`npm test`), plus 4 integration tests against the real
  `Strings_ENG_US.package` (`npm run test:game`).
- The built package was reopened and compared entry by entry against the source:
  58,374 / 58,374 entries, exactly 57 changed, 0 unexpected differences, identical
  resource identity, all 64-bit instance IDs preserved.
- Output is byte-identical across separate builds (same sha256).
- The source package was not modified: its sha256 is unchanged.
- **The mod was loaded in the real game** — game 1.128.90.1030, Steam install,
  2026-10-16. The tester reported translated labels appearing, and confirmed that
  all twelve probe letters `Õ Ä Ö Ü õ ä ö ü Š Ž š ž` render as letters in the
  interface. `Š` and `Ž` never occur in the game's own English text, so their
  coverage could only be established this way.
- **The Mods folder wins for this resource**: the game ships its own copy of the
  table we override, and our text is what appears.

Not verified:

- **Removal has not been tested**: nobody has deleted the package, relaunched, and
  confirmed the interface returns to English.
- No systematic clipping check on the longer labels, and the individual labels of
  the main checklist were not each confirmed by eye — the tester's confirmation was
  general, plus the Audio tab probe specifically.
- **No human has reviewed the 57 translations.** All are machine-drafted and the
  manifest reports `reviewedApplied: 0`.

## Legal and distribution

- This tool reads the game files on your own PC and writes a mod. It does not
  distribute game content, and this repository contains no game data.
- The generated package contains the **English text of the overridden table**
  (58,317 entries plus the 57 translated ones), because that is how the English
  fallback works. **Keep the built package private** until you have checked what
  you are allowed to redistribute.
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
  cli.ts           command line: extract, search, set, build, deploy
  package-io.ts    the only module that touches @s4tk/models
  stbl-format.ts   minimal independent STBL reader, used for verification only
  catalog.ts       extraction, catalog files, search
  translations.ts  translation + metadata storage, the "set" command
  validation.ts    what may be applied, and why things are refused
  build.ts         whole-table override build + verification
  deploy.ts        one-file Mods folder install with backups
  ids.ts           TGI/occurrence identity, lossless 64-bit hex
  hashing.ts       SHA-256 helpers
tests/             synthetic fixtures, built in code (no game data committed)
translations/      et-EE.json (text) and metadata.json (state, source hash)
glossary.json      Estonian terms and style rules used by the prototype
config.example.json
work/              ignored: extracted catalogs, manifests, backups
dist/              ignored: built packages
```

Next phases (installation-wide catalogs, source diffing, controlled machine
translation, community review) are designed but not built. See
`Sims4_Eesti_Implementation_Brief.md` and `IMPLEMENTATION_NOTES.md`.
