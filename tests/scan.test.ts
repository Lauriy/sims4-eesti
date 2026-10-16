/**
 * Installation-wide scanning and multi-package builds (Phase 2's foundation).
 *
 * The fixtures build a fake game root: a base strings file, a pack strings file,
 * a large package that is not named like strings, a Delta file, and a table in a
 * non-English locale. The scan must classify each one for the right reason, and a
 * build from the resulting catalog must emit tables from more than one package.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildPackage, BuildError } from "../src/build.js";
import { loadCatalog } from "../src/catalog.js";
import { readStblTables } from "../src/package-io.js";
import { coverageByPackage, findPackages, isDeltaPath, labelFor, scanInstallation } from "../src/scan.js";
import { SAMPLE_KEYS, makeTempDir, removeDir, writeFixturePackage } from "./helpers.js";

let root: string;
let outDir: string;
let catalogPath: string;

before(() => {
  root = makeTempDir("scan");
  outDir = join(root, "out");
  const client = join(root, "Data", "Client");
  const pack = join(root, "SP06");
  const delta = join(root, "Delta", "SP99");
  for (const dir of [client, pack, delta]) mkdirSync(dir, { recursive: true });

  writeFixturePackage(join(client, "Strings_ENG_US.package"), [
    {
      instance: 0x0054935f2685ad48n,
      entries: [
        { key: SAMPLE_KEYS.newGame, text: "New Game" },
        { key: SAMPLE_KEYS.loadGame, text: "Load Game" },
      ],
    },
  ]);
  writeFixturePackage(join(pack, "Strings_ENG_US.package"), [
    {
      instance: 0x00bea5e1d2845652n,
      entries: [{ key: SAMPLE_KEYS.resume, text: "Wishing Well" }],
    },
  ]);
  // A non-English table inside the pack file's sibling: locale byte 0x02.
  writeFixturePackage(join(client, "Strings_GER_DE.package"), [
    {
      instance: 0x0254935f2685ad48n,
      entries: [{ key: SAMPLE_KEYS.newGame, text: "Neues Spiel" }],
    },
  ]);
  // Not named like strings and bigger than the threshold used below.
  writeFixturePackage(join(client, "ClientFullBuild0.package"), [
    {
      instance: 0x0011111111111111n,
      entries: [{ key: SAMPLE_KEYS.greeting, text: "Should never be read" }],
    },
  ]);
  writeFixturePackage(join(delta, "Strings_ENG_US.package"), [
    {
      instance: 0x00deadbeefdeadben,
      entries: [{ key: SAMPLE_KEYS.greeting, text: "Delta text" }],
    },
  ]);

  const result = scanInstallation({
    gameRoot: root,
    outDir,
    largeFileBytes: 1, // everything not named like strings counts as "large"
  });
  catalogPath = result.catalogPath;
});

after(() => {
  removeDir(root);
});

describe("discovery", () => {
  it("finds packages and labels them by location", () => {
    const files = findPackages(root);
    assert.equal(files.length, 5);
    const base = files.find((file) => file.endsWith("Strings_ENG_US.package") && file.includes("Data"))!;
    assert.equal(labelFor(root, base, files), "BASE");
    // A file that is not the pack's strings file does not get to claim the pack's name.
    assert.equal(
      labelFor(root, files.find((file) => file.includes("ClientFullBuild0"))!, files),
      "ClientFullBuild0"
    );
    assert.equal(
      labelFor(root, files.find((file) => file.includes("SP06"))!, files),
      "SP06",
      "the pack's strings file keeps the pack label"
    );
    assert.ok(isDeltaPath(root, files.find((file) => file.includes("Delta"))!));
  });
});

describe("scan classification", () => {
  it("reads string files, skips large non-string files, excludes Delta and non-English", () => {
    const result = scanInstallation({ gameRoot: root, outDir: join(root, "out2"), largeFileBytes: 1 });
    const byPath = new Map(result.index.packages.map((entry) => [entry.path, entry]));

    assert.equal(byPath.get("Data/Client/Strings_ENG_US.package")!.disposition, "read");
    assert.equal(byPath.get("SP06/Strings_ENG_US.package")!.disposition, "read");
    assert.equal(byPath.get("Data/Client/ClientFullBuild0.package")!.disposition, "skipped-large");
    assert.equal(byPath.get("Delta/SP99/Strings_ENG_US.package")!.disposition, "excluded-delta");
    assert.equal(byPath.get("Data/Client/Strings_GER_DE.package")!.disposition, "no-english-tables");
    assert.match(byPath.get("Data/Client/Strings_GER_DE.package")!.note!, /none in English/);
    assert.equal(result.index.totals.nonEnglishTablesSkipped, 1);
    assert.equal(result.index.totals.entries, 3, "two English base strings plus the pack's one");
  });

  it("records every package's fingerprint and coverage", () => {
    const catalog = loadCatalog(catalogPath);
    assert.equal(catalog.packages.length, 2, "base and pack were read");
    assert.ok(catalog.packages.every((facts) => facts.sha256.length === 64));
    const rows = coverageByPackage(catalog);
    assert.deepEqual(
      rows.map((row) => row.label).sort(),
      ["BASE", "SP06"]
    );
    assert.equal(rows.find((row) => row.label === "BASE")!.entries, 2);
    assert.equal(rows.find((row) => row.label === "SP06")!.entries, 1);
  });

  it("keeps occurrence IDs distinct across packages", () => {
    const catalog = loadCatalog(catalogPath);
    assert.equal(new Set(catalog.occurrences.map((occurrence) => occurrence.occurrenceId)).size, 3);
    assert.ok(catalog.occurrences.some((occurrence) => occurrence.packageLabel === "SP06"));
  });
});

describe("multi-package build", () => {
  it("emits one package holding tables from more than one source package", () => {
    const catalog = loadCatalog(catalogPath);
    const translationsPath = join(root, "et.json");
    const metadataPath = join(root, "meta.json");
    const translations: Record<string, string> = {};
    const entries: Record<string, unknown> = {};
    for (const occurrence of catalog.occurrences) {
      translations[occurrence.occurrenceId] = `Tõlge ${occurrence.stringKey}`;
      entries[occurrence.occurrenceId] = {
        state: "machine",
        sourceHash: occurrence.sourceHash,
        updatedAt: new Date().toISOString(),
        origin: "machine",
      };
    }
    writeFileSync(translationsPath, JSON.stringify(translations));
    writeFileSync(metadataPath, JSON.stringify({ schemaVersion: 1, targetLocale: "et-EE", entries }));

    const outPath = join(root, "dist", "multi.package");
    mkdirSync(join(root, "dist"), { recursive: true });
    const report = buildPackage({
      catalogPath,
      outPath,
      translationsPath,
      metadataPath,
      includeUnreviewed: true,
    });

    assert.equal(report.counts.applied, 3);
    assert.equal(report.counts.resourcesEmitted, 2, "both packages' tables are in the output");
    assert.equal(report.sourcePackages.length, 2);

    const read = readStblTables(outPath);
    assert.equal(read.tables.length, 2);
    const instances = read.tables.map((table) => table.instance).sort();
    assert.deepEqual(instances, [0x0054935f2685ad48n, 0x00bea5e1d2845652n].sort());
    assert.ok(read.tables.every((table) => table.entries.every((entry) => entry.text.startsWith("Tõlge"))));

    const manifest = JSON.parse(
      readFileSync(join(root, "dist", "multi.manifest.json"), "utf8")
    ) as { sources: { label: string }[]; scope: string };
    assert.deepEqual(manifest.sources.map((source: { label: string }) => source.label).sort(), ["BASE", "SP06"]);
    assert.match(manifest.scope, /not 100% of the base game/);
  });

  it("refuses the build when any one source package changed", () => {
    const catalog = loadCatalog(catalogPath);
    const translationsPath = join(root, "et2.json");
    const metadataPath = join(root, "meta2.json");
    const occurrence = catalog.occurrences.find((item) => item.packageLabel === "SP06")!;
    writeFileSync(translationsPath, JSON.stringify({ [occurrence.occurrenceId]: "Uus tekst" }));
    writeFileSync(
      metadataPath,
      JSON.stringify({
        schemaVersion: 1,
        targetLocale: "et-EE",
        entries: {
          [occurrence.occurrenceId]: {
            state: "machine",
            sourceHash: occurrence.sourceHash,
            updatedAt: new Date().toISOString(),
            origin: "machine",
          },
        },
      })
    );

    // Change the pack file behind the catalog's back.
    writeFixturePackage(join(root, "SP06", "Strings_ENG_US.package"), [
      {
        instance: 0x00bea5e1d2845652n,
        entries: [{ key: SAMPLE_KEYS.resume, text: "Wishing Well (patched)" }],
      },
    ]);

    assert.throws(
      () =>
        buildPackage({
          catalogPath,
          outPath: join(root, "dist", "stale.package"),
          translationsPath,
          metadataPath,
          includeUnreviewed: true,
        }),
      (error: Error) => error instanceof BuildError && /"SP06" has changed/.test(error.message)
    );
  });
});
