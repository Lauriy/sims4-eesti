/**
 * Whole-table override building (brief §5, §8).
 *
 * The properties that matter: only affected tables are emitted, untouched entries
 * keep their English text, a rebuild after changing one translation moves exactly
 * one logical entry, stale input is refused, output paths cannot collide with
 * inputs, and identical inputs produce identical bytes.
 */
import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildPackage, BuildError } from "../src/build.js";
import { extractCatalog, loadCatalog, type Catalog } from "../src/catalog.js";
import { sha256File, sha256Hex } from "../src/hashing.js";
import { hex16 } from "../src/ids.js";
import { readStblTables } from "../src/package-io.js";
import type { TranslationMap } from "../src/translations.js";
import { REAL_ENGLISH_INSTANCE, SAMPLE_KEYS, makeTempDir, removeDir, writeFixturePackage } from "./helpers.js";

const ENGLISH_TGI = `220557DA:00000000:${hex16(REAL_ENGLISH_INSTANCE)}`;
const SECOND_TGI = "220557DA:00000002:00000000DEADBEEF";

let dir: string;
let packagePath: string;
let catalogPath: string;
let translationsPath: string;
let metadataPath: string;
let catalog: Catalog;

/** Writes translations + metadata directly, as a reviewer would end up with. */
function writeTranslations(
  entries: { id: string; text: string; state?: string; sourceHash?: string }[]
): void {
  const translations: TranslationMap = {};
  const metadata: Record<string, unknown> = {};
  for (const entry of entries) {
    translations[entry.id] = entry.text;
    const occurrence = catalog.occurrences.find((item) => item.occurrenceId === entry.id);
    metadata[entry.id] = {
      state: entry.state ?? "draft",
      sourceHash: entry.sourceHash ?? occurrence?.sourceHash ?? sha256Hex(entry.id),
      updatedAt: new Date().toISOString(),
      origin: "human",
    };
  }
  writeFileSync(translationsPath, JSON.stringify(translations, null, 2));
  writeFileSync(
    metadataPath,
    JSON.stringify({ schemaVersion: 1, targetLocale: "et-EE", entries: metadata }, null, 2)
  );
}

function occurrenceIdOf(text: string): string {
  return catalog.occurrences.find((occurrence) => occurrence.sourceText === text)!.occurrenceId;
}

function buildTo(outName: string, extra: Partial<Parameters<typeof buildPackage>[0]> = {}) {
  return buildPackage({
    catalogPath,
    outPath: join(dir, outName),
    translationsPath,
    metadataPath,
    includeUnreviewed: true,
    ...extra,
  });
}

before(() => {
  dir = makeTempDir("build");
  packagePath = join(dir, "Strings_ENG_US.package");
  writeFixturePackage(packagePath, [
    {
      instance: REAL_ENGLISH_INSTANCE,
      entries: [
        { key: SAMPLE_KEYS.newGame, text: "New Game" },
        { key: SAMPLE_KEYS.loadGame, text: "Load Game" },
        { key: SAMPLE_KEYS.greeting, text: "Hello, {0.SimFirstName}!" },
        { key: SAMPLE_KEYS.counter, text: "Level {0.Number} of 10" },
        { key: SAMPLE_KEYS.complex, text: "{M0.his} house" },
        { key: SAMPLE_KEYS.empty, text: "" },
      ],
    },
    {
      group: 0x00000002,
      instance: 0x00000000deadbeefn,
      entries: [{ key: SAMPLE_KEYS.resume, text: "Resume" }],
    },
    {
      // A table with no eligible translations must not be emitted at all.
      group: 0x00000003,
      instance: 0x00000000feedfacen,
      entries: [{ key: SAMPLE_KEYS.duplicate, text: "Untouched table" }],
    },
  ]);
  extractCatalog({ packagePath, packLabel: "BASE", outDir: dir });
  catalogPath = join(dir, "catalog.json");
  translationsPath = join(dir, "et-EE.json");
  metadataPath = join(dir, "metadata.json");
  catalog = loadCatalog(catalogPath);
});

after(() => {
  removeDir(dir);
});

describe("whole-table override build", () => {
  it("emits only affected tables and keeps every other entry in English", () => {
    writeTranslations([
      { id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" },
      { id: occurrenceIdOf("Hello, {0.SimFirstName}!"), text: "Tere, {0.SimFirstName}!", state: "reviewed" },
      { id: occurrenceIdOf("Resume"), text: "Jätka", state: "reviewed" },
    ]);

    const report = buildTo("first.package");
    assert.equal(report.counts.applied, 3);
    assert.equal(report.counts.excluded, 0);
    assert.equal(report.counts.reviewedApplied, 3);
    assert.equal(report.resources.length, 2, "only the two affected tables are written");

    const read = readStblTables(report.outPath);
    assert.equal(read.tables.length, 2);
    const tgis = read.tables.map((table) => table.group);
    assert.deepEqual(tgis, [0x00000000, 0x00000002], "untouched table 3 is not emitted");

    const english = read.tables[0]!;
    assert.equal(english.entries.length, 6, "the whole original table is present");
    assert.equal(english.entries[0]!.text, "Uus mäng");
    assert.equal(english.entries[1]!.text, "Load Game", "untouched entry keeps English");
    assert.equal(english.entries[2]!.text, "Tere, {0.SimFirstName}!", "placeholder survives");
    assert.equal(english.entries[4]!.text, "{M0.his} house", "deferred string keeps English");
    assert.equal(english.entries[5]!.text, "", "empty entry stays empty");
    assert.equal(read.tables[1]!.entries[0]!.text, "Jätka");
  });

  it("records the source fingerprint, counts and output hash in the manifest", () => {
    const report = buildTo("manifest-check.package");
    const manifest = JSON.parse(readFileSync(report.manifestPath, "utf8")) as {
      artifact: { sha256: string; sizeBytes: number };
      source: { sha256: string; catalogPath: string };
      counts: { applied: number; catalogOccurrences: number };
      scope: string;
      gameVersion: { value: string | null };
      locale: { overridden: string };
      verification: { independentStblByteReader: boolean };
    };
    assert.equal(manifest.artifact.sha256, sha256File(report.outPath));
    assert.equal(manifest.artifact.sizeBytes, report.outputBytes);
    assert.equal(manifest.source.sha256, sha256File(packagePath));
    assert.equal(manifest.counts.catalogOccurrences, catalog.occurrences.length);
    assert.match(manifest.scope, /not 100% of the base game/i);
    assert.equal(manifest.gameVersion.value, null, "no version is invented");
    assert.equal(manifest.locale.overridden, "00", "the overridden tables are still en_US");
    assert.equal(manifest.verification.independentStblByteReader, true);
  });

  it("records the game version only when it is supplied", () => {
    const report = buildTo("versioned.package", {
      gameVersion: "1.128.90.1030",
      gameVersionSource: "GameVersion.txt observed on this machine",
    });
    const manifest = JSON.parse(readFileSync(report.manifestPath, "utf8")) as {
      gameVersion: { value: string; source: string };
    };
    assert.equal(manifest.gameVersion.value, "1.128.90.1030");
    assert.equal(manifest.gameVersion.source, "GameVersion.txt observed on this machine");
  });

  it("changes exactly one logical entry when one translation changes", () => {
    writeTranslations([
      { id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" },
      { id: occurrenceIdOf("Load Game"), text: "Laadi mäng", state: "reviewed" },
      { id: occurrenceIdOf("Resume"), text: "Jätka", state: "reviewed" },
    ]);
    const before = buildTo("diff-before.package");
    const beforeTables = readStblTables(before.outPath).tables;

    writeTranslations([
      { id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" },
      { id: occurrenceIdOf("Load Game"), text: "Ava mäng", state: "reviewed" },
      { id: occurrenceIdOf("Resume"), text: "Jätka", state: "reviewed" },
    ]);
    const after = buildTo("diff-after.package");
    const afterTables = readStblTables(after.outPath).tables;

    assert.equal(afterTables.length, beforeTables.length);
    const differences: string[] = [];
    for (let t = 0; t < beforeTables.length; t++) {
      const a = beforeTables[t]!;
      const b = afterTables[t]!;
      assert.equal(a.entries.length, b.entries.length);
      for (let e = 0; e < a.entries.length; e++) {
        if (a.entries[e]!.text !== b.entries[e]!.text) {
          differences.push(`${hex16(b.instance)}|${b.entries[e]!.key.toString(16)}`);
        }
      }
    }
    assert.deepEqual(differences, [
      `${hex16(REAL_ENGLISH_INSTANCE)}|${SAMPLE_KEYS.loadGame.toString(16)}`,
    ]);
  });

  it("produces byte-identical output for identical input", () => {
    const first = buildTo("repro-1.package");
    const second = buildTo("repro-2.package");
    assert.equal(first.outputSha256, second.outputSha256);
    assert.ok(readFileSync(first.outPath).equals(readFileSync(second.outPath)));
  });

  it("does not modify the source package or the catalog", () => {
    const packageBefore = sha256File(packagePath);
    const catalogBefore = sha256File(catalogPath);
    buildTo("harmless.package");
    assert.equal(sha256File(packagePath), packageBefore);
    assert.equal(sha256File(catalogPath), catalogBefore);
  });
});

describe("eligibility", () => {
  it("applies only reviewed translations unless unreviewed ones are included", () => {
    writeTranslations([
      { id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" },
      { id: occurrenceIdOf("Load Game"), text: "Laadi mäng", state: "draft" },
    ]);

    const strict = buildTo("reviewed-only.package", { includeUnreviewed: false });
    assert.equal(strict.counts.applied, 1);
    assert.equal(strict.counts.excludedByCode["unreviewed"], 1);
    assert.equal(readStblTables(strict.outPath).tables[0]!.entries[1]!.text, "Load Game");

    const loose = buildTo("with-drafts.package", { includeUnreviewed: true });
    assert.equal(loose.counts.applied, 2);
    assert.equal(loose.counts.unreviewedApplied, 1);
    assert.equal(readStblTables(loose.outPath).tables[0]!.entries[1]!.text, "Laadi mäng");
  });

  it("refuses a stale source hash rather than applying text made from other English", () => {
    writeTranslations([
      { id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" },
      { id: occurrenceIdOf("Resume"), text: "Jätka", state: "reviewed", sourceHash: "c".repeat(64) },
    ]);
    const report = buildTo("stale.package");
    assert.equal(report.counts.applied, 1);
    assert.equal(report.counts.excludedByCode["stale-source"], 1);
    // The only string in the second table was excluded, so that table has no
    // changes at all and must not be emitted.
    assert.equal(report.resources.length, 1);
    const read = readStblTables(report.outPath);
    assert.equal(read.tables.length, 1);
    assert.equal(
      read.tables[0]!.entries.some((entry) => entry.text === "Jätka"),
      false,
      "stale text is not applied"
    );
    assert.ok(report.warnings.some((warning) => warning.includes("different English text")));
  });

  it("excludes unknown occurrence IDs and says so", () => {
    writeTranslations([
      { id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" },
      { id: "BASE|220557DA:00000000:0000000000000000|DEADBEEF", text: "Tundmatu", state: "reviewed" },
    ]);
    const report = buildTo("unknown.package");
    assert.equal(report.counts.unknownIds, 1);
    assert.equal(report.counts.applied, 1);
    assert.equal(report.excluded[0]!.codes[0], "unknown-occurrence");
  });

  it("excludes deferred syntax, English copies and empty replacements", () => {
    writeTranslations([
      { id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" },
      { id: occurrenceIdOf("{M0.his} house"), text: "{M0.his} maja", state: "reviewed" },
      { id: occurrenceIdOf("Load Game"), text: "Load Game", state: "reviewed" },
      { id: occurrenceIdOf("Resume"), text: "", state: "reviewed" },
    ]);
    const report = buildTo("rules.package");
    assert.equal(report.counts.applied, 1);
    assert.equal(report.counts.excludedByCode["unsupported-syntax"], 1);
    assert.equal(report.counts.excludedByCode["identical-to-source"], 1);
    assert.equal(report.counts.excludedByCode["empty-replacement"], 1);
  });

  it("fails rather than writing an empty package when nothing is eligible", () => {
    // The English text copied verbatim is not a translation, so this leaves
    // nothing to apply.
    writeTranslations([{ id: occurrenceIdOf("New Game"), text: "New Game", state: "reviewed" }]);
    assert.throws(
      () => buildTo("nothing.package"),
      (error: Error) => error instanceof BuildError && /Nothing to build/.test(error.message)
    );
    assert.equal(existsSync(join(dir, "nothing.package")), false);
  });

  it("does not treat an empty-to-empty entry as a change worth emitting a table for", () => {
    // The fixture's empty entry translated to "" changes nothing at all.
    writeTranslations([{ id: occurrenceIdOf(""), text: "", state: "reviewed" }]);
    assert.throws(
      () => buildTo("empty-noop.package"),
      (error: Error) =>
        error instanceof BuildError &&
        /Nothing to build/.test(error.message) &&
        /changes nothing/.test(error.message)
    );
    assert.equal(existsSync(join(dir, "empty-noop.package")), false);
  });
});

describe("stale and unsafe inputs", () => {
  it("refuses to build when the source package changed after extraction", () => {
    writeTranslations([{ id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" }]);
    const changed = join(dir, "changed.package");
    copyFileSync(packagePath, changed);
    writeFixturePackage(changed, [
      {
        instance: REAL_ENGLISH_INSTANCE,
        entries: [{ key: SAMPLE_KEYS.newGame, text: "New Game (patched)" }],
      },
    ]);

    assert.throws(
      () => buildTo("from-changed.package", { packagePath: changed }),
      (error: Error) =>
        error instanceof BuildError && /changed since the catalog was extracted/.test(error.message)
    );
  });

  it("refuses to write over the source package, the catalog, or the translations", () => {
    writeTranslations([{ id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" }]);
    for (const unsafe of [packagePath, catalogPath, translationsPath, metadataPath]) {
      assert.throws(
        () => buildTo("whatever.package", { outPath: unsafe }),
        (error: Error) => error instanceof BuildError && /Refusing to write/.test(error.message),
        unsafe
      );
    }
  });

  it("refuses to write into a directory that does not exist", () => {
    assert.throws(
      () => buildTo("whatever.package", { outPath: join(dir, "missing-dir", "out.package") }),
      (error: Error) => error instanceof BuildError && /does not exist/.test(error.message)
    );
  });

  it("refuses to write the manifest over any input, or over the package", () => {
    writeTranslations([{ id: occurrenceIdOf("New Game"), text: "Uus mäng", state: "reviewed" }]);
    for (const target of [metadataPath, translationsPath, catalogPath, packagePath]) {
      assert.throws(
        () => buildTo("manifest-guard.package", { manifestPath: target }),
        (error: Error) =>
          error instanceof BuildError && /Refusing to write the manifest/.test(error.message),
        `--manifest ${target}`
      );
      assert.equal(
        readFileSync(target).length > 0,
        true,
        "the input file must be intact after the refusal"
      );
    }
    assert.throws(
      () =>
        buildTo("same-both.package", {
          manifestPath: join(dir, "same-both.package"),
        }),
      (error: Error) =>
        error instanceof BuildError && /manifest over the output package/.test(error.message)
    );
    assert.equal(existsSync(join(dir, "same-both.manifest.json")), false);
  });

  it("refuses a manifest path in a directory that does not exist", () => {
    assert.throws(
      () =>
        buildTo("manifest-dir.package", {
          manifestPath: join(dir, "no-such-dir", "x.manifest.json"),
        }),
      (error: Error) => error instanceof BuildError && /Manifest directory/.test(error.message)
    );
  });

  it("leaves no temporary file behind when verification or writing fails", () => {
    const leftovers = readdirSync(dir).filter((name) => name.includes(".building-"));
    assert.deepEqual(leftovers, []);
  });
});

describe("catalog/package consistency", () => {
  it("refuses to apply text when the catalog's recorded hash does not match the package", () => {
    // Simulates a catalog that was tampered with (or built against different
    // bytes): validation would otherwise pass, because metadata and catalog agree
    // with each other, so the build must catch it against the real package.
    const tamperedHash = sha256Hex("Something else entirely");
    const tamperedCatalogPath = join(dir, "tampered-catalog.json");
    const tampered = JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;
    const occurrence = tampered.occurrences.find((item) => item.sourceText === "New Game")!;
    occurrence.sourceHash = tamperedHash;
    writeFileSync(tamperedCatalogPath, JSON.stringify(tampered));

    const ids = { id: occurrence.occurrenceId };
    const tamperedTranslations = join(dir, "tampered-et.json");
    const tamperedMetadata = join(dir, "tampered-metadata.json");
    writeFileSync(tamperedTranslations, JSON.stringify({ [ids.id]: "Uus mäng" }));
    writeFileSync(
      tamperedMetadata,
      JSON.stringify({
        schemaVersion: 1,
        targetLocale: "et-EE",
        entries: {
          [ids.id]: { state: "reviewed", sourceHash: tamperedHash, updatedAt: new Date().toISOString() },
        },
      })
    );

    assert.throws(
      () =>
        buildPackage({
          catalogPath: tamperedCatalogPath,
          outPath: join(dir, "tampered.package"),
          translationsPath: tamperedTranslations,
          metadataPath: tamperedMetadata,
          includeUnreviewed: true,
        }),
      (error: Error) =>
        error instanceof BuildError && /Catalog is inconsistent with the source package/.test(error.message)
    );
    assert.equal(existsSync(join(dir, "tampered.package")), false);
  });
});
