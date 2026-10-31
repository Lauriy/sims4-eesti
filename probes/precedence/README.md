# Precedence and fall-through probes

Three experiments, none of which can be answered from the files: **which package
wins when two claim the same resource**, **whether a package may override part of
a table while the game keeps its own text for the rest**, and **whether a Mods
package overrides a `Delta` (SDX) pack table**. Design context:
`../../docs/PHASE2_DESIGN.md`.

All are cheap to run and completely reversible — throwaway packages in the Mods
folder, deleted afterwards. Run them whenever you next start the game.

## Generate the packages

```powershell
# A, B and the Mods-vs-Mods pair; use the pack's live copy.
npx tsx probes/precedence/make-probes.ts `
  --base "<The Sims 4>\Data\Client\Strings_ENG_US.package" `
  --pack "<The Sims 4>\Delta\SP06\Strings_ENG_US.package" `
  --out work/probes

# C: Mods vs Delta, a whole table with two entries renamed.
npx tsx probes/precedence/make-delta-probe.ts `
  --pack "<The Sims 4>\Delta\SP06\Strings_ENG_US.package" `
  --out work/probes
```

On a single-pack install the live copy may be `<The Sims 4>\SP06\Strings_ENG_US.package`;
on a machine with many packs it is `Delta\SP06\...`. Both are Romantic Garden
Stuff, chosen so that a wrong answer cannot blank out the main interface, only
that pack's text.

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

### Step 3b — base-table fall-through (the gate for a sparse release)

A package that ships only our translations and no English fallback relies on the
same behaviour, on the table a base-game-only release uses.

1. Copy `base_sparse_probe.package` into the Mods folder (alone).
2. Launch and look at the main menu. **Expect:** `New Game` reads
   `BASE-SPARSE-NEWGAME` and `Options` reads `BASE-SPARSE-OPTIONS`, while every
   other label (`Load Game`, `Gallery`, `Manage Worlds`, …) still reads English.
3. If the other labels are blank, missing, or show raw IDs, the game does **not**
   fall through: a sparse release is impossible and the package must carry the
   whole table.
4. Remove `base_sparse_probe.package`.

This probe overrides only two entries, so a failure costs two labels, not the
whole interface.

### Step 4 — experiment C: does a Mods package override a Delta table?

1. Copy `delta_probe.package` into the Mods folder (alone).
2. Launch, open **Build Mode**, and search the catalogue for `DELTA-PROBE`.
3. **Observe:** the fountain and the plant read **`DELTA-PROBE-LOADED`** and
   **`DELTA-PROBE-PLANT`** → the Mods package beat the game's `Delta/SP06` copy.
   If they keep their normal names, the Delta table won and every DLC override in
   the 2026-10-31 wave is ineffective.
4. Remove `delta_probe.package`.

The package carries the whole table, so this tests precedence only; fall-through
is step 3's question.

## Results

Fill these in as observed; they are the deliverable, since none of it can be
re-derived without a game install. Game version and date, please.

| # | Question | Result | Date / version |
| --- | --- | --- | --- |
| 1 | Removing the package restores English | **Yes.** Same harness, same screen: with the package `LAADI MÄNG` / `Uus MÄNG`, with it parked `LOAD GAME` / `NEW GAME` (read by OCR, 2026-10-16) | 2026-10-16, 1.128.90.1030 |
| 2 | Mods vs Mods, same resource: which text wins? | **First-named wins, twice observed.** `aaa_probe.package` beat `zzz_probe.package` (identical size, identical timestamp — only the name differed), and `Sims4_Eesti.package` beat `zzz_probe.package`. The first pair is the discriminating one; the second is consistent with name order but would also fit "newest wins". | 2026-10-16, 1.128.90.1030 |
| 3 | Does a sparse override fall through to the game's own text? | **No** — not separately run on the pack table, but the base-table probe (row 5) shows the game does not fall through, so a sparse pack override fails the same way. | 2026-10-31, 1.129.39.1030 |
| 4 | Mods vs `Delta` (SDX) pack table: which text wins? | **Mods wins.** An EP01-only whole-table package installed in Mods rendered Estonian in game, replacing the live `Delta/EP01` table. | 2026-10-31, 1.129.39.1030 |
| 5 | Does a sparse **base-game** override fall through to the game's English? | **No.** A two-entry package (`New Game`, `Options`) left the other main-menu labels missing, with stray numbers and `wwww` where the game's own text should have appeared. Sparse builds are not viable; every emitted table must be complete. | 2026-10-31, 1.129.39.1030 |

Already answered, for reference: **Mods beats the game's own copy of this
resource** — the shipped `Strings_ENG_US.package` contains the base table, and the
mod's text is what appears (observed 2026-10-16, 1.128.90.1030).

## What each result changes

- **Result 2** decides whether Phase 2's catalogs must treat duplicate resource
  identities across Mods packages as a hard error (no safe answer) or as a
  documented ordering. Until it is known, the tool refuses nothing and assumes
  nothing.
- **Result 3/5** is settled: the game does **not** fall through. A build must
  carry the complete English table; `build --sparse` is a dead end on this game
  version, and a sparse package produces missing text rather than English.
- **Result 4** decides whether the DLC wave can ship at all. Its pack strings are
  read from `Delta/<pack>`; if a Mods package does not override a Delta resource,
  the build must target the table the game actually loads and the catalog strategy
  is wrong.
