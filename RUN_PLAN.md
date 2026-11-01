# How the bulk run is sequenced, and why

**Updated 2026-10-31:** a second machine (game 1.129.39.1030) carries 116 DLC pack
tables. Measured backlog: **106,806 game strings and 16,010 mod strings**. A
cross-pack export produced 238 batches / 94,853 entries covering 103,864 keys,
with EA's Finnish as a reference on 93.2% of them. Waves 1–3 below remain the
record of the first machine; **Wave 5** is the DLC run.

**Updated 2026-10-19:** waves 1–3 are complete. 72,275 of 75,349 strings are
translated and deployed; 71,806 were applied to the built package (469 belong to
mod packages shadowed by a first-named copy of the same table ID). The remaining
3,074 are deferred syntax, proper names, brand fragments and ambiguous keys.

State at the time of writing (original plan): 4,043 of 75,340 strings translated
and deployed (the base game's most-seen 1,000 plus a syntax slice, and the three
stuff packs in full). 71,292 occurrences remain, 55,015 of them the game's own
text and 16,277 a mod's.

## Wave 1 — the game's own text (55,015)

```powershell
npm run cli -- translate-export --catalog work/beta-catalog.json `
  --translations translations/et-EE.json --packages BASE `
  --dedupe-texts --batch-size 400 --references work/reference-fi --out work/batches-wave1
```

**In table order, not in popularity order.** The popularity ranking earned its
place in the first slice — 54 of the 57 strings confirmed on screen land in its
top 1000 — but for the bulk it is the wrong instrument twice over: the most-seen
strings are already translated, and the lever that compounds from here is the
neighbour, which needs batches to be *contiguous blocks of the table* so that one
screen's strings travel together. Measured on a table-order export: 19.3% of
entries have an already-translated string within twelve entries.

Per batch: the agreed glossary (55 terms), the style rules that the first wave
produced, the neighbours, the Finnish translation of the same key (100% of the
base game), and precedents for the same English text translated elsewhere.

## Wave 2 — the three stuff packs (done)

Translated as whole tables in the first beta, before the glossary existed. Re-run
`glossary-check` over them at the end rather than re-translating: their tables are
small, and the check tells us whether anything needs a second look.

## Wave 3 — the mods (16,277), largest first (done 2026-10-19)

| Mod | Strings |
| --- | --- |
| WickedWhims (Tuning) | 6,354 |
| Basemental Drugs | 4,830 |
| MC Command Center | 3,201 |
| everything else (85 packages) | 1,892 |

Last, for three measured reasons and one honest non-reason:

1. **They have no Finnish.** The captured Finnish files cover the base game and
   the three stuff packs, so a mod string never gets the professional translation
   of the same key that a game string does. What they do have is their own sibling
   locales, where the mod ships them: MC Command Center has real translations in
   ~17 languages, WickedWhims 68 strings per locale, Basemental's locales are
   English stubs and are detected and dropped.
2. **They are full of the game's own vocabulary** — skill, career, mood, lot,
   household, relationship. Doing them after 55,000 game strings means the
   glossary has been through every construct the game has, and the style rules
   have absorbed what the first ~140 batches taught.
3. **Same-text precedents**: 2.9% of mod occurrences carry an English text that
   already exists in the game's own files ("Relationships" → *Suhted*, "Personality"
   → *Isiksus*). Each of those is shown to the translator as a precedent. It is
   offered, never applied: "Black" in a drug mod may be a strain, not a colour.
4. **Not** a reason: neighbours. A mod's strings live in their own table, so the
   cross-package neighbour lever does not exist between a mod and the game. Within
   one mod it works — 6,354 WickedWhims strings in table order is a large enough
   block for its own screens to reinforce each other, which is the second reason
   to go largest-first.

## Wave 4 — consistency, then review

```powershell
npm run cli -- glossary-check --catalog work/beta-catalog.json --translations translations/et-EE.json
npm run cli -- lint --catalog work/beta-catalog.json --translations translations/et-EE.json --references work/reference-fi
```

`lint` exists because a playtest found "Flirttaile" for the Flirt interaction,
which is the Finnish word copied whole from the reference. It looks for word
endings Estonian does not build (-ailla, -aile, -inen, -ssa, -minen, -matta) and
marks any hit that also appears in the Finnish of the same key. On the 4,043
translated strings: 3 hits, all the same real defect, no false positives.

Its limit, learned the same day: "Vehtle" (for WooHoo) is a Finnish stem with
Estonian grammar, which no ending rule can catch - a player found it. Expect the
lint to catch copies of Finnish *word forms* and to miss hybrids; the review pass
at the end of the run is what covers the rest.

Then the two reports used on the trial's output: same English text with more than
one Estonian rendering, and new translations that contradict something already
deployed. Both were run from scripts in `work/` and should become commands, since
the bulk run needs them after every wave rather than once.

Finally, the review loop: every string is `machine` today, and `reviewedApplied`
is 0. A human reading the game and marking what is wrong with `set --state
reviewed` is the only path to a reviewed translation, and it is the only claim
this project has never made.

## Wave 5 — the DLC machine (2026-10-31)

The catalog is 163,302 game strings in 117 tables plus 31,578 mod strings. Of the
72,275 stored translations, **71,845 still match** their source (56,491 game,
15,354 mods); five base-game texts changed; 425 IDs no longer resolve (8 changed
mod keys, 417 old mod package labels). The wave is ordered by what can be checked
soonest, not by string count:

1. **Precondition, one game launch.** Install `work/probes/delta_probe.package`
   alone and confirm the Romantic Garden fountain reads `DELTA-PROBE-LOADED`.
   That answers whether a Mods package overrides a `Delta` table. If it does not,
   stop: the build strategy must change before bulk translation.
2. **EP01 pilot, 11 batches.** Translate, import, build, and check in game. This
   is the first pack whose text was never in the first machine's beta.
3. **The other expansion packs, largest first**, then game packs, then the many
   tiny stuff packs and kits. Every pack has its own Finnish table except EP21 and
   13 recent kits; those are translated from English with base-game precedents.
4. **The new mods last** (16,010 strings), as before: they inherit the game's
   vocabulary, and the three updated big mods have 211 new strings among them.
5. **Consistency, then review.** `glossary-check`, `lint`, the same-English /
   different-Estonian report, and the bulk spell check against Filosoft
   (`work/spellcheck.py`, see LESSONS.md §12); fix the five stale base strings;
   then the human review loop, which remains the only path to `reviewed`.

Cost control: one 400-string batch per translator, deduped across packs, Finnish
reference capped at one language (it is the only one most packs have), and no
re-translation of the 56,491 strings that already match.

## Release 0.5.0 — game through EP10, no mods (owner decision, 2026-10-31)

Scope: **everything translated through EP10** — base game, EP01–EP10, plus whatever
other packs already have entries — released on GitHub and Nexus. Mods were deferred
from 0.5.0. **Owner decision 2026-11-01: the version-locked, separate-package rule
is withdrawn; mod translations may ship in the main package.** 0.6.0 includes the
surviving child-safe mod tables (MCCC, Lot51 Fashion Authority, ordinary CC).

Release steps once EP10 is done (batch-011 and any residual EP10 strings):

1. Import every finished batch; check EP10 coverage and translate any residual
   EP10 strings.
2. **Quality passes after the last import**: spell check, same-text drift report,
   `work/fix-weird*.ts` passes (imports overwrite earlier fixes, observed with
   `kyltt` → `silt`).
3. Build the whole-table game package with `--game-version 1.129.39.1030`; the
   build's own verification must pass.
4. Update `README.md`, release notes, manifest; run tests and typecheck.
5. GitHub release `v0.5.0-beta` with the package or zip; Nexus page 7387 version
   0.5.0 with the new file. No mod file in either release.
6. Commit and push the repository.

Done 2026-10-31: GitHub `v0.5.0-beta` published with the zip, and Nexus file
11850 uploaded manually (API upload returns HTTP 404 with a personal key). Nexus
reports 0.5.0, category MAIN, primary; its archive hash and the inner
`!Sims4_Eesti.package` hash match the local build. The Nexus page description
still carries the earlier short copy; the 0.5.0 text is ready in
`work/nexus-page-0.5.0.bbcode.txt`.

## Release 0.6.0 — installed packs + child-safe mods (owner decision, 2026-11-01)

Scope: the 0.5.0 tables (base + EP01–EP10 + SP06/08/14) plus the installed packs
translated afterwards (EP14 Horse Ranch, EP17 Life & Death, EP21 Royalty & Legacy;
GP02/03/04/10; SP01–SP18, SP48, SP51, SP60) and the 20 surviving child-safe mod
packages. Owner playtested the preceding child-safe local build and reports it
works in game (2026-11-01).

Build `dist/Sims4_Eesti_0.6.0.package` (2026-11-01): 119,430 occurrences, 115,714
applied, 3,716 English fallback, 74 tables, 0 excluded, verification passed;
sha256 `7adb8269dfc4852edb28090fcf1be5e96d3da722fe817943202fc752161a0a8a`.
The test build (71 tables, child-safe scope) is `dist/Sims4_Eesti_ChildSafe.package`,
sha256 `4d9fec2c…022dc8`, deployed and playtested. Publication and version naming
are pending the owner's go-ahead.
