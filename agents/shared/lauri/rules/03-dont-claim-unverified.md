# Don't claim what you didn't verify

**Applies when:** reporting results — to the user, in a commit message, in a
README, in a comment, or in your own summary of what you did.

## Separate the three states

Every claim belongs to exactly one bucket, and the user must be able to tell
which without guessing:

1. **Verified** — you ran it and observed the result. Say what you ran and what
   it printed, in numbers where numbers exist.
2. **Unverified** — plausible, untested, or tested only in a different
   environment. Label it. "Not run in game", "not tested on macOS", "assuming the
   API keeps this promise".
3. **Pending** — someone else must do it. Name the person, the exact steps, and
   what result would count as success.

Never let a batch of verified facts carry an unverified paragraph along with it;
readers grant the whole message the credibility of its strongest sentence.

## Never invent

- No fabricated test results, benchmark numbers, file sizes, hashes, version
  numbers, resource ids, error messages, or observations from a machine you
  cannot see.
- If a field is unknown, write "not recorded" and say why. An empty value with a
  reason is worth more than a plausible-looking guess.
- Don't describe a tool's behaviour from memory of its documentation when you
  have the tool installed — read it or run it.
- If you are asked to record metadata you did not observe (a game version, a
  build number, a reviewer's name), record it only when it was supplied, and
  record where it came from.

## Report faithfully, including the bad parts

- If tests fail, say so and include the output. If you skipped a step, say which.
  If you worked around a problem instead of fixing it, say that too.
- When something is done and verified, state it plainly — no hedging, no
  "should be working now". False modesty is also a reporting error.
- Correct yourself explicitly when you were wrong earlier, and say what changed.
  A quiet fix teaches the reader the wrong thing about your earlier statements.
- Never present machine-generated text as human-reviewed work. Record its origin
  and let the coverage numbers speak: "0 reviewed, 30 machine-drafted" is a
  usable status; "translations complete" is not.

## Also, in the artifacts themselves

The same rules apply to what you write into files that outlive the conversation:
a manifest that claims a verified rebuild must have been verified; a comment that
describes behaviour the code does not have is a bug report waiting to happen. If
a comment and the code disagree, fix one of them.
