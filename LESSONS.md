# Lessons this project earned

Written at the point where 4,043 strings are translated, built and playable. Every
line here cost something to learn, and most of them cost it more than once. They
are in the order they would have saved the most time had they come first.

## 1. Before deferring work as unverifiable, look for the artifact that already solved it

Four classes of string — 6,786 of them — sat in English for a whole phase because
the validator could not check gender branches, plural branches, pronouns and
markup. The reasoning was sound and the conclusion was wrong: EA's own Finnish
translation of the same 58,374 keys is a manual for all four, and Finnish is
genderless like Estonian. One language switch in Steam turned "we cannot verify
this" into a table of measured answers:

| English | Finnish | What it proves |
| --- | --- | --- |
| `{S0.Pack}{P0.Packs}` | `{S0.paketti}{P0.paketit}` | branch content is text, and is translated |
| `{M1.his}{F1.her} dreams?` | `…unelmansa?` | a whole gender pair may simply go |
| `{P0.ObjectName}` | `{P0.ObjectName}` | a value reference is not text, and stays |
| `{0.SimPronounSubjective\|xxUpper} can also Mentor others` | `Hän voi myös opastaa muita` | the pronoun is written out, not left to the game |

**Before writing "we cannot check this", look for a professional translation of the
same corpus, a reference implementation, or a shipped artifact.** The excuse was
never laziness; it was that the verification gap looked absolute.

## 2. A heuristic is a claim — validate it against ground truth you already have

"Order the untranslated strings by how often a player sees them" has no data
behind it, so it had to be checked against the only ground truth that existed: the
57 base-game strings already confirmed on screen in the first in-game trial.

The obvious score — rank by repetition — put `OK` (55 keys) first and covered
**0 of the 57**. The measured score (short label, reuse across keys, core
vocabulary, same table block as a confirmed string) covers **54 of 57**, median
position 102 out of 51,509. Same data, same intent, opposite outcome.

**Find the ground truth you already have and make the heuristic reproduce it.** If
nothing can check the heuristic, the heuristic is a guess wearing a number.

## 3. Rules will be wrong — the first small run is what finds out

Two rules died within minutes of the first three batches:

- "A gender group goes whole or not at all, and a plural group must stay" was
  wrong twice over. Estonian drops the possessive but keeps the noun; EA's Finnish
  drops one of two number groups in the same string. The one rule that survived is
  simpler: *a group is kept whole or dropped whole, on every axis*.
- "Every bracketed run is an inline code" made `[Recovered]` untranslatable. Of
  100 distinct bracketed runs in the corpus, **99 are label text the player reads**
  and only `[PH]` and `[DNT]` are markers.

**A rule that has never met real output is a hypothesis.** Run a small batch before
the big one, and expect to spend the first hour fixing rules rather than reading
translations.

## 4. Instructions are part of the contract, and must agree with the data

The batch instruction said a line break in the English "means an actual newline
character". Measured: **4,046 strings carry the two literal characters**, 311 a
real newline, 47 both. Two translators noticed, followed the data, and said so in
their reports; a third silently produced the right thing. The instruction now
tells them to give back the form the source uses, and the validator counts both.

**When prose and files disagree, translators trust files.** That is the correct
instinct, and it means an instruction that contradicts the corpus is worse than no
instruction: it is a trap for the ones who follow the rules.

## 5. A checker is a triage queue, not an oracle

The glossary check reported 31 violations on 672 shipped strings. Triage found
that most were the *glossary's* fault, not the translations': `Home` matched 18
strings where English meant a house, `lot` matched "a lot of", `Buy` matched
"money can't buy happiness".

The fix was never in the code — it was encoding what the triage taught:
`accept` (equally correct forms), `exclude` (idioms), `ambiguous` (a common word
with ordinary senses is checked in labels, not prose), `caseSensitive`, and a
hyphen-aware word boundary so `Sell-Out` is not the Sell button. On 3,643 real
strings that took the noise from **26 to 2**.

**Budget for triage, then move what you learn into the artifact so the next wave
is quieter.** A checker that keeps reporting the same false positives gets ignored,
and an ignored checker is worse than none.

## 6. Different translators drift on the same construct within one wave

The first 89 moodlet-source strings came back **58 as `(X tõttu)` and 31 as
`(põhjus: X)`** — two conventions for 1,588 strings, created by nine translators
working in parallel on the same day. Nothing was wrong with either; they had not
been told, because before the run nobody knew the construct existed in that shape.

**Conventions discovered mid-run are rules for the next run.** This is what the
`style` list in `glossary.json` is for, and it grows with every wave.

## 7. Make your own reporting unable to flatter you

Two examples, both caught by reading output rather than trusting it:

- `glossary-check` printed "Checked **672** translation(s): 0 violations" while
  comparing 57 occurrences, because it counted translations *loaded* rather than
  *compared*. "0 violations" over 57 of 672 looks like a clean bill of health.
- The reuse measurement everyone expected to be large — "answer the next batch
  from the work already done" — is **0.3%** (218 of 71,292 occurrences), because
  the first slice deliberately took the repeated strings. Template matching over
  digits and placeholders: **0**. The levers that do pay are context, not memory:
  **19.3%** of remaining entries have an already-translated string in the same
  table block, and **14%** of the remaining volume is internal repetition.

**Measure the thing you are about to build, and make the tool report the number it
actually computed.** The first number was a bug; the second would have been a
month of building translation memory for nothing.

## 8. Report what is not verified, in the artifact itself

The repository is AI-generated end to end, and nothing said so until a footnote
did. The manifest says `reviewedApplied: 0`. `README.md` lists what has been seen
in game and what has not — including the three behaviours the Finnish taught us
(dropping a gender pair, replacing a pronoun, fall-through) that have never been
watched on this machine. `CLAUDE.md` carried "the in-game gate has not been run"
for a day after it had been.

**A claim outlives the context that produced it.** Stale claims in a contributor
doc are read by every agent afterwards, and they either repeat the falsehood or
learn to distrust the true parts.

## 9. A guard has to be tested against the defect that motivated it

A playtest found `Flirttaile` for the Flirt interaction. It is the Finnish word:
EA's Finnish says `Flirttaile` for the same key, and a translator handed the
reference gave it back unchanged. `flirttailla` is a Finnish verb; Estonian has
`flirtima`, imperative `flirta`.

The lint written for it was wrong on the first pass. The ending list was
transcribed from a scratch script and `-aile` was dropped on the way, so the
module did not fire on the very string it was built for - and running it on the
cleaned data reported "0 findings", which looked like a pass and was nothing at
all. A self-test with the original defect in it caught the dead guard in one run.
On the real 4,043 strings it then found 3 instances, every one copied from the
reference, and no false positives.

The same detector built the other way round - "a word used once that also appears
in the Finnish" - found three strings and all three were innocent Estonian
loanwords (`teline`, `kitara`, `fantasia`), while missing the actual defect, which
appears three times. **The detector that looks principled can be worse than the
one that encodes the actual failure.**

## 10. A string in every UI movie proves nothing about any one of them

Looking for the clock's weekday names, I scanned all 258 Scaleform movies for
`CALENDAR_WEEKDAY_NAME`, `txtGameTime`, `DateUtils` and similar. 142 of 258
matched, including the credits screen and the options menu, because every movie
embeds the same shared class libraries. The discriminating fields were the ones
that did not appear everywhere: `txtWeekday0..6` and `InitializeWeekdayNames`
exist only in `calendar.gfx`.

The weekday text itself was in neither the movies nor any STBL. It is a UTF-16
locale registry inside `TS4_x64.exe` (`en` → `Mon.,Tue.,...`, `fi` →
`Ma,Ti,...`, no Estonian record). Seven exact weekday strings do exist in the
install-wide catalog, but all seven belong to MC Command Center's own table, not
the game's. A broad search tells you where a word appears, not who reads it;
negative evidence has to come from the data source the code is actually wired
to.

## 11. Working habits that cost real time here

- **Write code containing backslashes through files, not shell heredocs.** Git
  Bash halved `\\` to `\` repeatedly, corrupting regexes, string literals and one
  `REAL_NEWLINE` constant. The fix each time was to write the block with a file
  tool and splice it in.
- **Do not edit shared source while agents are reading it.** Two batch agents hit
  a transient syntax error in `src/validation.ts` mid-edit; one worked around it
  by testing against `HEAD`, which was good judgement, but the run was one
  interruption away from failing. Freeze the rules for the length of a wave.
- **A stale comment is a bug report.** One leftover comment line ending in a
  backtick opened a template literal and desynchronised the whole file's parse.
  It cost twenty minutes of bisecting to find.
- **Byte-identical rebuilds and file hashes are cheap determinism checks.** Same
  sha256 across two builds hours apart, one of them after code changes, is one
  line of evidence that nothing drifted.
- **The game is the only source of truth for game behaviour.** Everything else —
  library round-trips, independent byte readers, fixtures — verifies the artifact,
  not what the player sees.
