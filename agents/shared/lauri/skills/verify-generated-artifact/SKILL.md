---
name: verify-generated-artifact
description: Independently verify a generated artifact (package, archive, exported file, generated document) against the inputs it was built from before claiming it works. Use after any build step whose output a third-party consumer will load, and whenever you are about to say "it works".
---

# Verify a generated artifact

Use this when a build produced a file that something else will consume, and the
honest answer to "does it work?" is currently "it should".

Work through the four checks below **in order**, and report each one's result
separately. Do not merge them into a single "verified" claim.

## 1. Re-read it

Reopen the artifact with the tool/library that produced it. Confirm it loads at
all and that the top-level structure is what you intended (count of resources,
entries, sections).

This is the weakest check and it is not sufficient on its own — it shares code
with the writer, so a shared misconception passes it.

## 2. Compare against the input, entry by entry

Compare the artifact to the source you built it from and count the differences
explicitly:

- unchanged entries: N
- changed entries: N — and each change must be one you intended
- unexpected changes: must be **0**
- keys/identifiers: identical, in the same order
- identities (resource ids, file names, anchors): unchanged

"That's the expected number of changes" is the claim to make, with the numbers.
A report of "no errors" is not a verification.

## 3. Read the bytes with something independent

For the fields you are making factual claims about — a header flag, a length
field, an encoding — parse those bytes with a small reader that did **not** come
from the writer. Assert the specific values you expect, and check anything the
write path might silently drop (fields the library skips, values it recomputes).

`agents/shared/lauri/scripts/verify-built-package.ts` implements checks 1–3 for
the Sims 4 package case; adapt or copy it.

## 4. Prove reproducibility and input safety

- Build twice in two separate processes with identical input, and compare hashes.
  Same-process caching can hide non-determinism.
- Hash every input before and after, and assert nothing changed. Prove the claim
  "we did not modify the source" instead of asserting it.
- Note any difference you accept (compression, layout, timestamps) and say why it
  is harmless.

## Then hand over what you could not check

List the steps only a human can do — launching the real application, judging
rendering, checking a device — as explicit steps with the observation that would
count as success. A pending manual check is not a pass, and a skipped check is
not a pass either.

## Rules this borrows from

`../rules/00-verification.md` (how to get evidence) and
`../rules/03-dont-claim-unverified.md` (how to report it).
