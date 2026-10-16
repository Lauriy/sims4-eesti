# Precedence and fall-through probes

Two experiments that Phase 2 depends on, neither of which can be answered from
the files: **which package wins when two claim the same resource**, and **whether
a package may override part of a table while the game keeps its own text for the
rest**. Design context: `../../PHASE2_DESIGN.md`.

Both are cheap to run and completely reversible — they are two throwaway packages
in the Mods folder, deleted afterwards. Run them whenever you next start the game.

## Generate the packages

```powershell
npx tsx probes/precedence/make-probes.ts `
  --base "<The Sims 4>\Data\Client\Strings_ENG_US.package" `
  --pack "<The Sims 4>\SP06\Strings_ENG_US.package" `
  --out work/probes
```

Three packages land in `work/probes/` (git-ignored). `SP06` is Romantic Garden
Stuff; the pack probe uses its table so that a wrong answer cannot blank out the
main interface, only that pack's text.

## The session, in order

Do these in one sitting — the first step is a test you already owe, and each
launch answers one question.

### Step 1 — removal test (Phase 1's outstanding gate item)

1. Close the game.
2. Move `Sims4_Eesti.package` out of the Mods folder (to the Desktop, say).
3. Launch. **Expect:** the interface is back in English — `New Game`, `Options`,
   `Build Mode`.
4. Note the result below. Leave the mod out for step 2.

### Step 2 — experiment A: two packages, same resource, different text

1. Copy `aaa_probe.package` and `zzz_probe.package` into the Mods folder.
2. Launch and look at the main menu.
3. **Observe:** does the first button read `PROBE-AAA`, `PROBE-ZZZ`, or something
   else? Both packages claim the same resource identity, so exactly one set of
   text can win. The filenames are chosen so that "alphabetically first" and
   "alphabetically last" are distinguishable.
4. Remove both packages.

### Step 3 — experiment B: sparse override of a pack table

1. Copy `sparse_probe.package` into the Mods folder (alone; `Sims4_Eesti.package`
   still out).
2. Launch, open **Build Mode**, and find Romantic Garden content — search the
   catalogue for `Fountain`.
3. **Observe two things:**
   - The fountain is named **`SPARSE-PROBE-LOADED`** → the package loaded and its
     two entries apply. (If it is not renamed, the package did not load at all
     and the rest of this step proves nothing.)
   - The plant named **`Lupin`** still reads `Lupin`, and other Romantic Garden
     text (wishing-well notifications, moodlets) is still English → the game
     **falls through** to its own table for entries the package omits.
     If instead those strings are blank, missing, or show raw IDs, then it does
     **not** fall through — which would mean every override must carry the whole
     table, as Phase 1 does.
4. Remove `sparse_probe.package`, restore `Sims4_Eesti.package` if you want the
   Estonian text back.

If step 3 blanks Romantic Garden text, that is the experiment working as
designed, not damage: delete the probe package and relaunch.

## Results

Fill these in as observed; they are the deliverable, since none of it can be
re-derived without a game install. Game version and date, please.

| # | Question | Result | Date / version |
| --- | --- | --- | --- |
| 1 | Removing the package restores English | **Yes.** Same harness, same screen: with the package `LAADI MÄNG` / `Uus MÄNG`, with it parked `LOAD GAME` / `NEW GAME` (read by OCR, 2026-10-16) | 2026-10-16, 1.128.90.1030 |
| 2 | Mods vs Mods, same resource: which text wins? | **First-named wins, twice observed.** `aaa_probe.package` beat `zzz_probe.package` (identical size, identical timestamp — only the name differed), and `Sims4_Eesti.package` beat `zzz_probe.package`. The first pair is the discriminating one; the second is consistent with name order but would also fit "newest wins". | 2026-10-16, 1.128.90.1030 |
| 3 | Does a sparse override fall through to the game's own text? | *(not yet run — needs Build Mode navigation)* | |

Already answered, for reference: **Mods beats the game's own copy of this
resource** — the shipped `Strings_ENG_US.package` contains the base table, and the
mod's text is what appears (observed 2026-10-16, 1.128.90.1030).

## What each result changes

- **Result 2** decides whether Phase 2's catalogs must treat duplicate resource
  identities across Mods packages as a hard error (no safe answer) or as a
  documented ordering. Until it is known, the tool refuses nothing and assumes
  nothing.
- **Result 3** decides whether a future build can emit only translated entries
  (a few kilobytes instead of 1.7 MiB) or must keep shipping the complete table.
  If fall-through works, the staleness problem in `PHASE2_DESIGN.md` shrinks with
  it: a sparse override cannot go stale in the 58,322 entries it never mentions.
