# Sims 4 Eesti — implementation brief for a coding agent

## Assignment and first stopping point

Implement a small Windows-first command-line project that builds an unofficial Estonian text-translation mod for The Sims 4 from a user's local English game files.

**Implement Phase 1 now. Do not implement the later roadmap yet.** The first deliverable is a working extraction → translation → validation → package-build loop, with roughly 10–20 visible strings changed and a documented in-game test. It is not a translation website, installer, or full-game machine translation.

Work in the current repository and inspect existing files before changing them. Make sensible implementation decisions without asking for approval of every detail. Do not delete unrelated work. If game files are unavailable, complete synthetic tests and clearly mark the local game test as pending. Do not fabricate resource IDs, API methods, test results, or successful game launches.

## Operating constraints

Development and initial game testing are on Windows, using PowerShell. Keep the CLI portable where straightforward; do not introduce WSL, Docker, or Linux-specific commands. The test installation runs in English (`en_US`); Estonian is the text we insert, not a newly registered game locale.

Treat the game installation and saves as read-only. Do not patch executables, replace installed language files, write script mods, or change the EA app. Deployment is a separate, explicitly invoked operation that copies only this project's package into a user-specified Mods directory. Do not automatically publish anything or call paid translation APIs.

Accept explicit paths instead of guessing the user's installation or Documents folder. Paths must work with spaces, Unicode, and redirected/OneDrive Documents. Never scan the entire disk to find the game.

## Technology choice

Use TypeScript with strict checking, a supported Node.js LTS release, npm, and a committed lockfile. Record the runtime and dependency versions actually tested.

Start with **`@s4tk/models`** for package and string-table reading/writing. Its upstream purpose is handling Sims 4 packages/resources, and STBL Studio uses it. Read its actual installed type declarations, examples, and tests before implementing the adapter. Do not assume that upstream `main`, a tutorial, and the published npm version have identical APIs. The project describes its software as pre-release, so pin the version that passes our tests. [R1, R2]

Do not write a new DBPF parser or compression implementation. Keep dependency-specific code in one small module. Sims 4 Studio is an optional independent inspection tool, not a build dependency.

`@s4tk/extraction` and its example are references for later installation-wide discovery. They are not required for the initial one-package input. In particular, the extraction example warns that SDX/base-file precedence is unresolved in that example. Do not copy its extraction order as an authoritative game load order. [R3]

## Phase 1 — one working translation mod

### 1. Prove the binary library before building the rest

Make a small automated test that creates a synthetic package with an English STBL resource, writes it, reopens it, and verifies all resource identifiers, string keys, text, and supported metadata. Include Estonian letters, a repeated placeholder, an empty source string, and a 64-bit instance ID that would be unsafe to store as a JavaScript `number`.

Then perform a read → write → read test on an explicitly supplied local English string package. Verify semantic equality; compression or storage layout need not be byte-identical to EA's original. Check that relevant entry flags and metadata survive. If the selected library cannot preserve required data, report the exact limitation rather than quietly discarding it.

Fail with an actionable error on unsupported formats, decompression failures, invalid input, or zero English STBLs. A successful synthetic round trip is not proof of in-game compatibility.

### 2. Extract a local catalog

Take one user-specified English `.package` file. Read its STBL resources, retaining their original identity and every entry. Save a local catalog plus an input manifest containing a SHA-256 fingerprint of the original file. Do not extract unrelated textures, tuning, audio, or other resources.

For every string occurrence retain:

- Source-package relative path and a pack label, initially `BASE` or user-supplied.
- Full resource **type, group, and instance**; entry key and flags.
- Exact English source text and SHA-256 of its UTF-8 bytes.

Use fixed-width hexadecimal strings for identifiers in JSON: 8 digits for type/group/string key and 16 for the instance. Use `bigint` or the library's lossless type internally for the instance.

Create a stable occurrence ID from the pack label, full TGI, and string key. Keep package path as provenance. Do not use English text or the string hash alone as the catalog identity. Do not silently collapse equal keys from different tables. Ambiguous duplicate resources or conflicting occurrences must be reported, not resolved using filesystem enumeration order.

Sims STBL resource type is `220557DA`; the locale occupies the high byte of the instance, and `00` is English. This first implementation preserves the original English TGI exactly. Do not invent an Estonian locale, change the group to a generic mod group, or generate new string keys. [R4]

### 3. Store translations separately

Use a plain UTF-8 JSON mapping of `occurrenceId → Estonian text`, with a separate metadata file for each translation's accepted source hash and review state. This keeps the text files suitable for a future localization platform without making one necessary today.

Example structure; the identifier below is illustrative, not an actual game string:

```json
{
  "BASE|220557DA:00000000:00123456789ABCDE|89ABCDEF": "Jätka mängu"
}
```

Metadata should distinguish `draft`, `machine`, `reviewed`, and `needs_review`. A local `set` command records the current source hash and creates a draft. A reviewed translation must not be silently overwritten. Do not count a copied English fallback as an Estonian translation or call machine output human-reviewed.

Provide text search over the catalog that prints matching source strings, complete IDs, and provenance. The user can then select actual visible labels; do not assume that a particular example such as “Resume Game” exists in the supplied package.

### 4. Validate only the translations we intend to apply

Start with plain text and a deliberately limited set of verified simple dynamic placeholders, such as `{0.SimFirstName}`, `{1.String}`, `{0.Number}`, and `{0.Money}`. Preserve each supported placeholder exactly. Compare **multisets**, not sets, so lost repetitions are detected while valid word-order changes remain possible.

Reject a changed string containing token syntax or markup we do not yet understand. Leave its original English entry untouched. Do not reject an entire original table merely because an untranslated entry contains complex syntax.

**Do not implement “freeze everything between braces.”** Sims also uses expressions with translatable literal payloads, including gender/plural branches, and English pronoun placeholders. Preserving all those expressions verbatim can preserve English words inside otherwise Estonian text. Full handling belongs in Phase 3; Phase 1 should identify and defer these strings. [R5]

Also reject unknown translation IDs, stale source hashes, malformed metadata, invalid text, and accidental empty replacements of nonempty text. Preserve source whitespace/control sequences where structurally required. Do not treat every literal percent sign as a formatting token.

Check actual UTF-8 byte lengths against the supported format's limits. The documented STBL format stores an entry length in a 16-bit field and encodes text as UTF-8; character count alone is insufficient. [R6]

### 5. Build conservative whole-table overrides

Implement this explicit strategy for the prototype:

1. Verify the supplied source package still matches the extraction manifest. If it changed, refuse to build and require re-extraction; never apply stale catalog offsets or text.
2. Group eligible translations by original STBL resource. Default eligibility is fresh, validated, reviewed translations. Allow an explicit `--include-unreviewed` option for the local draft prototype, while still rejecting stale or invalid entries.
3. For each affected resource, begin with the **complete original English table**, replace only eligible entries, and preserve all other entries and relevant metadata.
4. Preserve its original type/group/instance and string keys. Skip tables with no actual changes.
5. Write a **new package containing only these affected STBL resources**. Do not copy the entire original game package or its non-STBL resources.
6. Reopen the result and verify the exact table/key set, metadata, changed values, and unchanged English values against the expected result.

This deliberately provides English fallback by retaining English values inside each emitted table. **Do not assume that a same-TGI table containing only 20 entries will fall through to the original resource for its missing entries.** A smaller sparse-override strategy can be investigated later; it is not a prerequisite for this prototype.

The new package should be `dist/Sims4_Eesti.package`. Write through a temporary file and replace the final artifact only after validation. Prevent output paths from overwriting inputs. Aim for reproducible output from identical inputs; at minimum test semantic reproducibility and document any library-induced byte differences rather than claiming determinism without evidence.

Write an adjacent manifest recording source fingerprints, actual tested/observed game version when available, overridden locale, included resources, translated/reviewed/fallback counts, and output hash. Do not invent a game version. Label the scope as the supplied package, not “100% of the base game.”

### 6. Offer a safe local workflow

Use one CLI entry point. These are the intended command shapes, not pre-existing tool APIs:

```powershell
npm ci
npm test
npm run cli -- extract --package "C:\path\to\Strings_ENG_US.package" --out work/base
npm run cli -- search --catalog work/base/catalog.json --text "Resume"
npm run cli -- set --catalog work/base/catalog.json --id "<ID printed by search>" --text "Jätka mängu"
npm run cli -- build --catalog work/base/catalog.json --include-unreviewed --out dist/Sims4_Eesti.package
npm run cli -- deploy --file dist/Sims4_Eesti.package --mods-dir "C:\actual\game-user-folder\Mods" --dry-run
```

Document the explicit non-dry-run deploy invocation. `set` and `build` may use documented default paths for the translation and metadata files; allow overrides.

Deployment should display its exact source and destination, copy only our artifact, and never delete/move other mods or alter `Resource.cfg`. Refuse to overwrite an unrelated destination; provide explicit handling for replacing our previous release, with a backup outside the active Mods folder. Do not silently reset user options, delete caches, or launch/kill the game. Document closing the game before replacement.

A package-only mod does not need our own Python script payload. Do not add one simply to automate installation or translation lookup.

### 7. Keep the repository small

A reasonable layout is:

```text
src/
  cli.ts
  package-io.ts
  catalog.ts
  validation.ts
  build.ts
tests/
translations/
  et-EE.json
  metadata.json
glossary.json
config.example.json
README.md
IMPLEMENTATION_NOTES.md
work/                         # ignored: extracted EA text and local manifests
dist/                         # ignored: generated packages
```

Use ordinary functions and data structures. Do not introduce plugin frameworks, a database, a web server, or an elaborate dependency-injection architecture. Adjust this layout when it makes the implementation simpler; it is not a reason to create empty files.

Commit only synthetic fixtures, not extracted EA packages or the complete game script. Keep `.env`, absolute local paths, and secrets out of Git. Keep the local prototype artifact private pending a distribution review.

### 8. Automated acceptance tests

Cover package/STBL round trips, unchanged entry preservation, resource/key/flag preservation, lossless 64-bit IDs, Unicode and byte limits, repeated/reordered/missing placeholders, unsupported syntax, stale-source rejection, ambiguous duplicate detection, output-path safety, and dry-run deployment.

Use synthetic fixtures for normal tests. Make local-game integration tests opt-in and explicitly skip them when no input path is configured. A skipped test is not a pass. Test that no operation changes source-package bytes.

A rebuild after changing one translation should affect exactly the intended logical entry. Reopening with the same library is necessary but not sufficient: document independent Studio inspection and the real-game test below.

### 9. Manual in-game acceptance gate

Write an explicit checklist for the user:

- Back up saves and use a disposable test session. Test with our package isolated from other mods; do not make the program rearrange the user's normal Mods folder.
- Run an English installation, enable package mods/custom content, close the game, and install the test artifact.
- Verify roughly 10–20 selected visible labels, plus `ÕÄÖÜ õäöü ŠŽ šž` in at least one visible label.
- Verify an unchanged English entry from an overridden table, another from an untouched table, and at least one supported dynamic substitution when available.
- Check for missing text, raw IDs, broken formatting, and obvious clipping. Record the actual game version and observations.
- Close the game, remove only our mod, restart, and verify the original text returns.

Do not claim this gate passed unless someone actually ran it. If this coding environment cannot launch the user's game, finish the CLI/tests and state exactly which manual steps remain.

**End Phase 1 here.** Deliver runnable code, a lockfile, tests, the exact commands, and a short results/limitations report. No placeholder binary methods or TODOs in the critical path. Do not proceed to infrastructure merely because the game test is pending.

## Later roadmap — design for it, do not build it now

### Phase 2: installation-wide catalogs and patch updates

Discover only installed, user-authorized content and report coverage by base game/pack. Keep package provenance and STBL boundaries. Detect duplicate TGIs and keys; investigate actual precedence instead of assuming sorted filenames match game loading.

Treat SDX separately until its precedence is established. The upstream extraction example explicitly warns about this. Record excluded content honestly. [R3]

Implement source diffing: unchanged, added, modified, and removed entries. Preserve unchanged translations. Retain changed-source translations as suggestions marked `needs_review`, but do not ship them by default. Archive removed entries instead of deleting translation history. Rebuild affected tables from fresh English sources, never from an old translated package.

Whole-table overrides may become stale after game updates. A build-time fingerprint check does not protect a player who updates the game after installing the mod. Document compatibility/rebuild requirements; do not claim automatic runtime protection.

### Phase 3: controlled AI translation

Agree a small Estonian glossary/style guide first. Names, relationships, moodlets, item descriptions, and UI labels need appropriate context. Avoid blindly attaching Estonian case endings to arbitrary runtime names; rephrase where possible.

Implement provider/model configuration rather than baking in a particular model ID. API keys stay in environment variables. Require an explicit translation command, a small initial batch, bounded concurrency/retries, and a spending/request limit. Treat game strings as data, not instructions to the agent.

Use structured output keyed by occurrence ID; reject missing, duplicate, or unexpected IDs. Cache by source hash plus model, prompt, and glossary versions. Never overwrite reviewed human text. Mark all accepted generated output as machine-origin and report human-review coverage separately.

Before bulk work, implement and test a real token-aware treatment of translatable branch payloads and locale-dependent pronoun expressions. Distinguish runtime values from grammar-bearing text. Allow carefully reviewed structural rewrites rather than a blanket token-set rule. Unknown syntax remains English and appears in a review queue. [R5]

### Phase 4: community review and distribution

Use an existing Weblate deployment, not a homegrown translator UI. Weblate supports ordinary JSON and a monolingual base/source file; split catalogs into manageable pack components and retain stable occurrence IDs. Do not assume Weblate will understand our metadata file without an adapter. Review decisions must be mapped into our metadata deliberately, not inferred from any Git commit. [R7]

Add suggestions, trusted reviewers, glossary ownership, source-change invalidation, and validation before release. Keep glossary checks sensitive to legitimate Estonian inflection; do not require every word to appear in dictionary form.

Human translators need source text/context. Keeping the Git repository free of EA source text does **not** automatically solve the question of exposing that text in a public translation platform. Similarly, Phase 1's full-table prototype includes retained English text. Review source-text access, distribution permissions, and host requirements before public release; “translation patch” is not a blanket legal exemption.

EA's policy requires noncommercial/free mod distribution subject to its stated exceptions and prohibits suggesting EA/Maxis endorsement. It does not pre-approve this project or guarantee a host will accept it. Do not use EA logos or assume a mod policy grants unrestricted rights to publish the extracted game script. [R8]

Only after compatibility and publication requirements are settled, produce a user-facing package release with scope, game version, review coverage, installation/removal instructions, and checksums. No automatic uploading or accounts are part of the first implementation.

## Reference material

These are upstream/primary references to inspect, not permission to invent APIs or treat the entire plan as proven game behavior.

```text
[R1] Sims 4 Toolkit package/resource library:
https://github.com/sims4toolkit/models
https://raw.githubusercontent.com/sims4toolkit/models/main/package.json

[R2] STBL Studio and its dependencies:
https://github.com/sims4toolkit/stbl-studio-web
https://raw.githubusercontent.com/sims4toolkit/stbl-studio-web/main/package.json

[R3] Extraction library and template; read the SDX warning:
https://github.com/sims4toolkit/extraction
https://github.com/sims4toolkit/extraction-template
https://raw.githubusercontent.com/sims4toolkit/extraction-template/main/index.cjs

[R4] Resource identifiers and locale encoding:
https://github.com/Llama-Logic/Binary-Templates

[R5] Mod creator's explanation of Sims tokens, branches, and pronouns:
https://www.patreon.com/ilkavelle/posts/mod-it-yourself-144706784

[R6] STBL binary format reference:
https://raw.githubusercontent.com/Llama-Logic/Binary-Templates/main/StringTable_0x220557da.bt

[R7] Weblate JSON-format documentation:
https://docs.weblate.org/en/latest/formats/json.html

[R8] EA's Sims 4 mod policy:
https://help.ea.com/en/articles/the-sims/the-sims-4/mods-policy/
```
