# Editing binary formats through someone else's library

**Applies when:** you read, modify or write a binary file format using a
third-party library (packages, archives, save files, media containers, protobuf
blobs) — and especially when the result has to be loaded by a closed-source
consumer you cannot test directly.

## Read the actual installed code, not the documentation

- Read the `.d.ts`/source **of the version you installed**. Upstream `main`, a
  tutorial and the published version routinely disagree. Check the file that
  actually runs.
- Confirm the types you rely on: integer width, signedness, endianness, and
  whether large identifiers are `number`, `bigint`, or strings. A 64-bit id above
  2^53 stored as a JS `number` is silently corrupted; prove the losslessness with
  a value that *cannot* round-trip (`BigInt(Number(x)) !== x`), since many large
  values happen to be exactly representable and will hide the bug.
- Pin the exact version once your tests pass. `^0.6.14` is not a decision, it is
  a future incident.

## Prove the write path before building on it

- Round-trip one synthetic file first: read → write → read, comparing **every**
  entry, key and identifier semantically. Then do the same on a real input.
- Don't trust `equals()` style helpers on large models — check their complexity.
  A pairwise comparison is O(n²) and will appear to hang on 50k entries.
- Distinguish "the bytes differ" from "the meaning differs". Compression, layout
  and header padding may legitimately change; identifiers, keys and text may not.
  Document the differences you accept rather than claiming determinism.
- Test reproducibility in two separate processes. In-process caching can make a
  non-deterministic writer look deterministic.

## Watch for fields the library silently drops

- A field the library does not model is a field you lose on write. Check what is
  skipped on read (`skip(n)`) and what is hardcoded on write (`uint8(0)`), then
  **measure the real input**: if the field is always the format's default in
  practice, the limitation is harmless but must still be reported; if it is ever
  set, you must refuse rather than silently discard it.
- Recompute-on-write header fields (lengths, counts, offsets) are a common source
  of "close enough" output. Verify the writer's convention against a file the
  original producer wrote, not against your own assumption.

## Format rules that bite

- Length fields may be counted in bytes while you think in characters — check
  UTF-8 byte length against the field width, not `String.length`.
- Preserve structural tokens exactly (placeholders, escapes, inline codes,
  markup). Compare them as **multisets** so a reordering passes and a lost
  repetition fails. Never "freeze everything between delimiters": if the payload
  is human language, freezing it silently keeps source-language words in the
  output. Defer what you cannot handle, and say which strings you deferred.
- Keep a minimal, independent reader for the parts you make factual claims about
  (a flag byte, a header field). It is the only way to check the bytes without
  using the same code that produced them — and it is not a licence to write a
  full second parser.

## Treat the input as read-only

- Hash inputs before and after every operation and assert they are unchanged.
- Never write into an installation, cache or data directory you did not create.
  Emit to a path the user named, write through a temp file, verify, then rename.
- Refuse output paths that resolve to an input path — including the secondary
  outputs like manifests and logs, which are the ones people forget.
