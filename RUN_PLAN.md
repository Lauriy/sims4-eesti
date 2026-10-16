# How the bulk run is sequenced, and why

State at the time of writing: 4,043 of 75,340 strings translated and deployed
(the base game's most-seen 1,000 plus a syntax slice, and the three stuff packs in
full). 71,292 occurrences remain, 55,015 of them the game's own text and 16,277 a
mod's.

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

## Wave 3 — the mods (16,277), largest first

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
