/**
 * Catalog extraction and search (brief §2, §3): every occurrence keeps its full
 * resource identity, its own source hash, and provenance; ambiguous duplicates
 * are reported instead of resolved; the source package is never modified.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { extractCatalog, loadCatalog, searchCatalog } from "../src/catalog.js";
import { sha256File, sha256Hex } from "../src/hashing.js";
import { hex16 } from "../src/ids.js";
import { PackageReadError } from "../src/package-io.js";
import {
  REAL_ENGLISH_INSTANCE,
  SAMPLE_KEYS,
  makeTempDir,
  removeDir,
  writeFixturePackage,
} from "./helpers.js";

let dir: string;
let packagePath: string;
let outDir: string;

before(() => {
  dir = makeTempDir("catalog");
  packagePath = join(dir, "Strings_ENG_US.package");
  outDir = join(dir, "base");
  writeFixturePackage(packagePath, [
    {
      instance: REAL_ENGLISH_INSTANCE,
      entries: [
        { key: SAMPLE_KEYS.newGame, text: "New Game" },
        { key: SAMPLE_KEYS.loadGame, text: "Load Game" },
        { key: SAMPLE_KEYS.greeting, text: "Hello, {0.SimFirstName}!" },
        { key: SAMPLE_KEYS.empty, text: "" },
      ],
    },
    {
      group: 0x00000002,
      instance: 0x00000000deadbeefn,
      entries: [
        { key: SAMPLE_KEYS.duplicate, text: "Repeated key, first entry" },
        { key: SAMPLE_KEYS.duplicate, text: "Repeated key, second entry" },
      ],
    },
  ]);
});

after(() => {
  removeDir(dir);
});

describe("catalog extraction", () => {
  it("writes a catalog and an input manifest with the source fingerprint", () => {
    const result = extractCatalog({ packagePath, packLabel: "BASE", outDir });
    assert.ok(existsSync(result.catalogPath));
    assert.ok(existsSync(result.manifestPath));

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
      source: { sha256: string; stblEntryCount: number };
      locale: { instanceHighByte: string; allTablesEnglish: boolean };
      notes: string[];
    };
    assert.equal(manifest.source.sha256, sha256File(packagePath));
    assert.equal(manifest.locale.instanceHighByte, "00");
    assert.equal(manifest.locale.allTablesEnglish, true);
    assert.ok(manifest.notes.some((note) => note.includes("Fingerprint")));
  });

  it("keeps full resource identity and per-string hashes", () => {
    const catalog = loadCatalog(join(outDir, "catalog.json"));
    assert.equal(catalog.occurrences.length, 6);
    assert.equal(catalog.resources.length, 2);

    const newGame = catalog.occurrences.find((occurrence) => occurrence.sourceText === "New Game")!;
    assert.equal(
      newGame.occurrenceId,
      `BASE|220557DA:00000000:${hex16(REAL_ENGLISH_INSTANCE)}|${newGame.stringKey}`
    );
    assert.equal(newGame.resourceTgi, `220557DA:00000000:${hex16(REAL_ENGLISH_INSTANCE)}`);
    assert.equal(newGame.stringKey.length, 8);
    assert.equal(newGame.sourceHash, sha256Hex("New Game"));
    assert.equal(newGame.entryIndex, 0);

    const hello = catalog.occurrences.find((occurrence) => occurrence.sourceText.startsWith("Hello"))!;
    assert.equal(hello.entryIndex, 2);
  });

  it("marks duplicate string keys as ambiguous instead of picking one", () => {
    const catalog = loadCatalog(join(outDir, "catalog.json"));
    const duplicates = catalog.occurrences.filter((occurrence) => occurrence.ambiguous);
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0]!.sourceText, duplicates[1]!.sourceText);
    assert.equal(duplicates[0]!.occurrenceId, duplicates[1]!.occurrenceId);
    assert.ok(catalog.warnings.some((warning) => warning.includes("more than one entry")));
    assert.deepEqual(
      catalog.resources.find((resource) => resource.group === "00000002")!.duplicateKeys,
      [duplicates[0]!.stringKey]
    );
  });

  it("treats every string in a duplicated table as ambiguous, including the first copy", () => {
    // A lookup would otherwise find the first copy while the build resolves the
    // last one, so no string in either copy may be addressed.
    const path = join(dir, "duplicate-tgi.package");
    writeFixturePackage(path, [
      {
        instance: REAL_ENGLISH_INSTANCE,
        entries: [{ key: SAMPLE_KEYS.newGame, text: "New Game" }],
      },
      {
        instance: REAL_ENGLISH_INSTANCE,
        entries: [{ key: SAMPLE_KEYS.loadGame, text: "Load Game" }],
      },
    ]);
    const result = extractCatalog({
      packagePath: path,
      packLabel: "DUP",
      outDir: join(dir, "dup"),
    });

    assert.equal(result.catalog.occurrences.length, 2);
    assert.ok(
      result.catalog.occurrences.every((occurrence) => occurrence.ambiguous === true),
      "both copies are ambiguous"
    );
    assert.ok(result.warnings.some((warning) => warning.includes("appears 2 times")));
    assert.equal(result.catalog.occurrences[0]!.entryIndex, 0);
    assert.equal(result.catalog.occurrences[1]!.entryIndex, 0);
  });

  it("does not modify the source package", () => {
    const before = sha256File(packagePath);
    extractCatalog({ packagePath, packLabel: "AGAIN", outDir: join(dir, "again") });
    assert.equal(sha256File(packagePath), before);
  });

  it("labels occurrences with the supplied pack label", () => {
    const catalog = loadCatalog(join(dir, "again", "catalog.json"));
    assert.ok(catalog.occurrences.every((occurrence) => occurrence.occurrenceId.startsWith("AGAIN|")));
  });

  it("fails actionably on a file with no string tables", () => {
    const path = join(dir, "no-strings.package");
    writeFixturePackage(path, [], [
      { type: 0x00b2d882, group: 0, instance: 0x1n, bytes: Buffer.from([0, 1, 2]) },
    ]);
    assert.throws(
      () => extractCatalog({ packagePath: path, packLabel: "BASE", outDir: join(dir, "none") }),
      (error: Error) =>
        error instanceof PackageReadError && /no string tables/.test(error.message)
    );
  });

  it("fails actionably on a file that is not a package at all", () => {
    const path = join(dir, "not-a-package.package");
    writeFileSync(path, `PK\u0003\u0004${"x".repeat(200)}`);
    assert.throws(
      () => extractCatalog({ packagePath: path, packLabel: "BASE", outDir: join(dir, "bad") }),
      (error: Error) => error instanceof PackageReadError && /not a Sims 4 package/.test(error.message)
    );
  });

  it("fails actionably on a file too short to be a package", () => {
    const path = join(dir, "tiny.package");
    writeFileSync(path, "DBPF");
    assert.throws(
      () => extractCatalog({ packagePath: path, packLabel: "BASE", outDir: join(dir, "tiny") }),
      (error: Error) => error instanceof PackageReadError && /too short/.test(error.message)
    );
  });

  it("fails actionably on a missing file", () => {
    assert.throws(
      () =>
        extractCatalog({
          packagePath: join(dir, "nope.package"),
          packLabel: "BASE",
          outDir: join(dir, "nope"),
        }),
      /No such package/
    );
  });
});

describe("catalog search", () => {
  const catalog = () => loadCatalog(join(outDir, "catalog.json"));

  it("finds strings by substring, case-insensitively by default", () => {
    const hits = searchCatalog(catalog(), { text: "game" });
    const texts = hits.map((hit) => hit.occurrence.sourceText).sort();
    assert.deepEqual(texts, ["Load Game", "New Game"]);
  });

  it("respects case sensitivity and exact matching", () => {
    assert.equal(searchCatalog(catalog(), { text: "Load" }).length, 1);
    assert.equal(searchCatalog(catalog(), { text: "load" }).length, 1);
    assert.equal(searchCatalog(catalog(), { text: "load", caseSensitive: true }).length, 0);
    assert.equal(searchCatalog(catalog(), { text: "Load", exact: true }).length, 0);
    assert.equal(searchCatalog(catalog(), { text: "Load Game", exact: true }).length, 1);
  });

  it("stops at the requested limit", () => {
    assert.equal(searchCatalog(catalog(), { text: "", limit: 2 }).length, 2);
  });

  it("reports provenance for each hit", () => {
    const hit = searchCatalog(catalog(), { text: "New Game" })[0]!;
    assert.equal(hit.resource?.tgi, `220557DA:00000000:${hex16(REAL_ENGLISH_INSTANCE)}`);
    assert.equal(hit.occurrence.entryIndex, 0);
  });
});
