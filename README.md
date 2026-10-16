# Sims 4 Eesti

An unofficial, noncommercial **prototype** that builds an Estonian text mod for
The Sims 4 out of the English string files already on your own PC.

It is a local command-line tool, not a translation website and not an installer:
you point it at one English `.package`, pick strings, write Estonian text, and it
writes one `.package` you can drop into your Mods folder.

**Scope of this prototype:** an install-wide catalog (75,340 English strings: the
base game's 58,374, three stuff packs, and every mod in the Mods folder) and **672
translated entries across four string tables** — the base game's menus, options
dialogs and mode switcher, plus the complete string tables of Romantic Garden
Stuff (SP06), Backyard Stuff (SP08) and My First Pet Stuff (SP14). Every other
entry in those four tables keeps its English text, and no other package is
touched. This is not a complete Estonian localisation of the game, and no
translation here has been reviewed by a human.

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
npm test          # 95 tests, all synthetic; no game files needed
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
- [ ] **Text from a package the mod does not cover is unchanged** — strings
      belonging to any other pack, world or mod still read in English. This build
      overrides exactly **four** tables (base game, SP06, SP08, SP14); everything
      else in the installation comes from packages with different resource IDs.
- [ ] **The three stuff packs are Estonian** — e.g. in Build Mode, Romantic
      Garden's wishing well, Backyard Stuff's lawn water slide and My First Pet's
      rodent cages have Estonian names and tooltips.
- [ ] **Optional independent inspection.** Open `dist/!Sims4_Eesti.package` in
      Sims 4 Studio (a separate, independently written tool — *not* a dependency
      of this project, and not installed on this machine) and confirm it lists
      four string tables - `220557DA:00000000:0054935F2685AD48` with 58,374
      entries, `...009DD507B385879F` with 225, `...00A9BC4CEC99A5F8` with 201 and
      `...00BEA5E1D2845652` with 262.
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

672 entries across four string tables. `translations/et-EE.json` holds the text
and `translations/metadata.json` the state and source hash of each entry.

| Table in the built package | Entries | Translated | What it covers |
| --- | --- | --- | --- |
| Base game | 58,374 | 57 | the menus, options dialogs and mode switcher listed below |
| Romantic Garden Stuff (SP06) | 262 | 219 | the pack's item names, tooltips and moodlet text |
| My First Pet Stuff (SP14) | 225 | 203 | same, for that pack |
| Backyard Stuff (SP08) | 201 | 193 | same, for that pack |

The three packs' tables are translated in full apart from 73 entries the tool
deliberately leaves in English: gender/plural branches such as
`{M0.he'd}{F0.she'd}`, HTML-like markup, and empty strings (see
[Limitations](#limitations-you-should-know-about)).
The base game is translated **only** where listed below — the other 58,317 of its
entries keep their English text.

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
the table (Maxis groups UI text in blocks) — see `IMPLEMENTATION_NOTES.md` for why
that is the only offline evidence available, and for the one label that was
chosen wrongly before the first trial. Two labels are deliberately **not**
translated: `Marketplace` and one of the two `Home` entries, both of which share
their text with a build/buy list, where a single translation would change a
category name too.

**All 672 of these entries are machine-drafted and unreviewed.** `npm run cli --
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

Verified on this machine, with evidence in `IMPLEMENTATION_NOTES.md`:

- 95 automated tests pass (`npm test`). The 4 integration tests against the real
  `Strings_ENG_US.package` also pass, but only when pointed at it — without
  `SIMS4_EESTI_SOURCE_PACKAGE` they are skipped, and a skipped test is not a pass:
  ```powershell
  $env:SIMS4_EESTI_SOURCE_PACKAGE = "C:\Program Files (x86)\Steam\steamapps\common\The Sims 4\Data\Client\Strings_ENG_US.package"
  npm run test:game
  ```
- The built package was reopened and compared entry by entry against the source:
  59,062 / 59,062 entries across four tables, exactly 672 changed, 0 unexpected
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
  each overridden table whole (hence 1.7 MiB rather than a few kilobytes); the
  probe that would answer it is generated and waiting in `probes/precedence/`.
- No systematic clipping check on the longer labels, and the individual labels of
  the main checklist were not each confirmed by eye — the tester's confirmation was
  general, plus the Audio tab probe specifically.
- **No human has reviewed the 672 translations.** All are machine-drafted and the
  manifest reports `reviewedApplied: 0`.
- **The branch rules rest on shipped evidence, not on this machine.** That
  Estonian may drop a whole gender pair (`{M0.his}{F0.her}`), keep both branches
  alike, or write a word where the game would insert an English pronoun is
  inferred from EA's own Finnish translation. None of those three has yet been
  watched rendering in this game; they belong in the next in-game session, next
  to the fall-through probe.
- The 672 entries were translated before the glossary and the Finnish reference
  material existed, so their terminology has been checked (`glossary-check`) but
  not regenerated against those inputs.

## Legal and distribution

- This tool reads the game files on your own PC and writes a mod. It does not
  distribute game content, and this repository contains no game data.
- The generated package contains the **English text of the four overridden
  tables** (58,390 entries that keep their English text, plus the 672 translated
  ones), because that is how the English fallback works. **Keep the built package
  private** until you have checked what you are allowed to redistribute.
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
`Sims4_Eesti_Implementation_Brief.md`, `PHASE2_DESIGN.md` and
`IMPLEMENTATION_NOTES.md`. What the project learned the hard way is in
`LESSONS.md`.

---

## Footnote: who wrote this

Everything here — the tool in `src/`, the tests, the Estonian text, the probe
kits, and these documents — was produced by an AI agent in sessions on
2026-10-16 and 2026-10-17: **DeepSeek 4.1 Flash** (the model this session's
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

Two files predate or sit outside that authorship: `Sims4_Eesti_Implementation_Brief.md`
is Codex's, and `agents/shared/lauri/` holds Lauri's own machine-wide rules,
copied in so every contributor's tooling loads them.

Nothing in this repository has been reviewed by a human translator. The
`reviewed` state exists for that review to be recorded in — today every entry is
`machine`, and the manifest says so.
