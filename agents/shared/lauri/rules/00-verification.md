# Verify before you claim

**Applies when:** you are about to say that something works, passes, or is done.

## Run it

- Run the thing. "This should work" is not a result, and "the code looks right"
  is not evidence.
- Prefer a test that fails for the *wrong* reason today and passes after your
  change. A green suite that never exercised your branch proves nothing.
- Exercise the failure path too, not only the happy path. If a guard is supposed
  to refuse, make it refuse and read the message.

## Don't verify with the thing you are verifying

- Reopening a file with the same library that wrote it is necessary, not
  sufficient. Add one independent check: a different tool, a second
  implementation, or a byte-level read of the format's own specification.
- When your check and your code share a helper, you have one check, not two.
- For generated artifacts, compare against the *input*, entry by entry, and
  assert the exact number of differences you intended — "no errors" is weaker
  than "58,344 unchanged, 30 changed, 0 unexpected".

## Make results comparable

- Same input twice should give the same output; verify it in two separate
  processes, not two calls in one process.
- Record hashes of inputs before and after. "We did not modify the source" is a
  claim you can prove in one line.
- If you cannot run something (no hardware, no game, no credentials), say which
  steps remain and hand them over explicitly. A skipped test is not a pass, and a
  pending manual check is not a completed one.

## When something surprises you

- If a result contradicts your model of the system, stop and investigate the
  model. A test that "unexpectedly passed" is usually a test that measured
  nothing — check the assertion was actually capable of failing.
- A guard that never fires is untested. If your check catches nothing on real
  data, prove the limitation is real by measuring it (count the affected rows),
  rather than assuming it is harmless.
