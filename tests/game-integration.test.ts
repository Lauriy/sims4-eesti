/**
 * Integration test against a real English string package.
 *
 * Opt-in: set SIMS4_EESTI_SOURCE_PACKAGE to the .package you want to exercise
 * (for example the base game's Data\Client\Strings_ENG_US.package). Without it,
 * every test here is skipped — and a skipped test is not a pass.
 *
 * This test only reads the supplied file and writes to a temporary directory.
 */
import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractCatalog } from "../src/catalog.js";
import { sha256File } from "../src/hashing.js";
import { formatTgi, localeByteOf, toTgi } from "../src/ids.js";
import { readRawStblBuffers, readStblTables, writePackageFile } from "../src/package-io.js";
import { parseStblBuffer } from "../src/stbl-format.js";
import { makeTempDir, removeDir } from "./helpers.js";

const sourcePackage = process.env.SIMS4_EESTI_SOURCE_PACKAGE;
const skip = sourcePackage
  ? false
  : "SIMS4_EESTI_SOURCE_PACKAGE is not set: run with " +
    'SIMS4_EESTI_SOURCE_PACKAGE="C:\\path\\to\\Strings_ENG_US.package" npm run test:game';

describe("real English package", { skip }, () => {
  it("reads every string table, with locale and entry counts reported", () => {
    const read = readStblTables(sourcePackage!);
    assert.ok(read.tables.length >= 1, "at least one string table");
    assert.equal(read.header.version, "2.1");

    let entries = 0;
    for (const table of read.tables) {
      entries += table.entries.length;
      assert.equal(formatTgi(toTgi(table)).length, 8 + 1 + 8 + 1 + 16);
      assert.ok(table.entries.every((entry) => typeof entry.text === "string"));
    }
    console.log(
      `  ${sourcePackage}\n` +
        `  ${read.resourceCount} resources, ${read.tables.length} string table(s), ${entries} entries, ` +
        `locale byte(s) ${[...new Set(read.tables.map((table) => localeByteOf(table.instance)))].join(",")}`
    );
  });

  it("reports the entry flag bytes the package library does not model", () => {
    const raw = readRawStblBuffers(sourcePackage!);
    let nonZero = 0;
    let scanned = 0;
    for (const { buffer } of raw) {
      const parsed = parseStblBuffer(buffer);
      assert.equal(parsed.header.version, 5, "STBL version");
      for (const entry of parsed.entries) {
        if (entry.flags !== 0) nonZero++;
        scanned++;
      }
    }
    console.log(`  entry flags: ${nonZero} non-zero out of ${scanned} entries`);
    if (nonZero > 0) {
      console.log(
        `  LIMITATION: this file uses entry flags the package library drops when rewriting. ` +
          `Entries affected: ${nonZero}.`
      );
    }
    assert.ok(scanned > 0);
  });

  it("round-trips the whole file: read → write → read, semantically equal", () => {
    const dir = makeTempDir("game-integration");
    try {
      const before = sha256File(sourcePackage!);
      const original = readStblTables(sourcePackage!);
      const outPath = join(dir, "roundtrip.package");

      writePackageFile(
        outPath,
        original.tables.map((table) => ({
          type: table.type,
          group: table.group,
          instance: table.instance,
          entries: table.entries.map((entry) => ({ key: entry.key, text: entry.text })),
        }))
      );

      const reread = readStblTables(outPath);
      assert.equal(reread.tables.length, original.tables.length);
      for (let t = 0; t < original.tables.length; t++) {
        const a = original.tables[t]!;
        const b = reread.tables[t]!;
        assert.equal(b.type, a.type);
        assert.equal(b.group, a.group);
        assert.equal(b.instance, a.instance, "64-bit instance survives the round trip");
        assert.equal(b.entries.length, a.entries.length);
        let mismatches = 0;
        for (let e = 0; e < a.entries.length; e++) {
          if (b.entries[e]!.key !== a.entries[e]!.key || b.entries[e]!.text !== a.entries[e]!.text) {
            mismatches++;
          }
        }
        assert.equal(mismatches, 0, `all entries of ${formatTgi(toTgi(a))} survive unchanged`);
      }

      assert.equal(sha256File(sourcePackage!), before, "the source package is untouched");
      console.log(
        `  round trip: ${original.tables.length} table(s), ` +
          `${original.tables.reduce((sum, table) => sum + table.entries.length, 0)} entries, no mismatches`
      );
    } finally {
      removeDir(dir);
    }
  });

  it("extracts a catalog with a fingerprint of the supplied file", () => {
    const dir = makeTempDir("game-catalog");
    try {
      const result = extractCatalog({
        packagePath: sourcePackage!,
        packLabel: "BASE",
        outDir: dir,
      });
      assert.equal(result.catalog.source.sha256, sha256File(sourcePackage!));
      assert.equal(result.catalog.occurrences.length, result.catalog.source.stblEntryCount);
      assert.ok(
        result.catalog.warnings.length === 0 ||
          result.catalog.warnings.every((warning) => typeof warning === "string")
      );
      const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
        source: { sha256: string };
      };
      assert.equal(manifest.source.sha256, result.catalog.source.sha256);
      console.log(
        `  catalog: ${result.catalog.occurrences.length} occurrences, ` +
          `${result.catalog.warnings.length} warning(s), fingerprint ${result.catalog.source.sha256.slice(0, 16)}…`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
