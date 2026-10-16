/**
 * The `set` command's storage behaviour: what it refuses, and what state it
 * leaves behind when a write fails part-way. The text file and the metadata file
 * cannot be updated in one atomic step, so the failure mode matters.
 */
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { extractCatalog, loadCatalog, type Catalog } from "../src/catalog.js";
import { setTranslation } from "../src/translations.js";
import { REAL_ENGLISH_INSTANCE, SAMPLE_KEYS, makeTempDir, removeDir, writeFixturePackage } from "./helpers.js";

let dir: string;
let catalogPath: string;
let translationsPath: string;
let metadataPath: string;
let catalog: Catalog;

function idOf(text: string): string {
  return catalog.occurrences.find((occurrence) => occurrence.sourceText === text)!.occurrenceId;
}

function set(text: string, overrides: Record<string, unknown> = {}) {
  return setTranslation({
    catalogPath,
    translationsPath,
    metadataPath,
    occurrenceId: idOf("New Game"),
    text,
    state: "draft",
    origin: "human",
    forceOverwriteReviewed: false,
    ...overrides,
  });
}

before(() => {
  dir = makeTempDir("set");
  const packagePath = join(dir, "fixture.package");
  writeFixturePackage(packagePath, [
    {
      instance: REAL_ENGLISH_INSTANCE,
      entries: [
        { key: SAMPLE_KEYS.newGame, text: "New Game" },
        { key: SAMPLE_KEYS.loadGame, text: "Load Game" },
      ],
    },
  ]);
  extractCatalog({ packagePath, packLabel: "BASE", outDir: dir });
  catalogPath = join(dir, "catalog.json");
  translationsPath = join(dir, "et-EE.json");
  metadataPath = join(dir, "metadata.json");
  catalog = loadCatalog(catalogPath);
});

after(() => {
  // Restore write permission so the temp directory can be removed.
  try {
    chmodSync(metadataPath, 0o666);
  } catch {
    /* already writable or gone */
  }
  removeDir(dir);
});

describe("set command storage", () => {
  it("records text, state, origin and the source hash together", () => {
    const result = set("Uus mäng");
    assert.equal(result.state, "draft");
    assert.equal(result.origin, "human");

    const translations = JSON.parse(readFileSync(translationsPath, "utf8")) as Record<string, string>;
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      entries: Record<string, { state: string; sourceHash: string; origin: string }>;
    };
    assert.equal(translations[idOf("New Game")], "Uus mäng");
    assert.equal(metadata.entries[idOf("New Game")]!.state, "draft");
    assert.equal(metadata.entries[idOf("New Game")]!.origin, "human");
    assert.equal(
      metadata.entries[idOf("New Game")]!.sourceHash,
      catalog.occurrences.find((occurrence) => occurrence.sourceText === "New Game")!.sourceHash
    );
  });

  it("leaves the stored text untouched when the metadata write fails", () => {
    // The dangerous half-written state is "new text under the old entry's
    // state": if the entry used to be reviewed, a strict build would then apply
    // unreviewed text. Metadata is therefore written first, so a failure here
    // must leave the previous text exactly as it was.
    set("Uus mäng");
    const before = readFileSync(translationsPath, "utf8");

    chmodSync(metadataPath, 0o444);
    try {
      assert.throws(() => set("Midagi muud"), /EPERM|EACCES|permission/i);
      assert.equal(
        readFileSync(translationsPath, "utf8"),
        before,
        "the translations file must not change when metadata cannot be written"
      );
      const translations = JSON.parse(before) as Record<string, string>;
      assert.equal(translations[idOf("New Game")], "Uus mäng");
    } finally {
      chmodSync(metadataPath, 0o666);
    }
  });

  it("leaves no temporary files behind when a write fails", () => {
    chmodSync(metadataPath, 0o444);
    try {
      assert.throws(() => set("Jälle midagi"));
    } finally {
      chmodSync(metadataPath, 0o666);
    }
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".tmp-")),
      []
    );
  });

  it("refuses to overwrite a reviewed translation without the explicit flag", () => {
    set("Uus mäng", { state: "reviewed" });
    assert.throws(
      () => set("Vaikselt üle kirjutatud"),
      /already reviewed and will not be overwritten/
    );

    const result = set("Üle kirjutatud", { state: "draft", forceOverwriteReviewed: true });
    assert.equal(result.previousState, "reviewed");
    assert.equal(result.state, "draft");
  });

  it("refuses an unknown or ambiguous occurrence ID", () => {
    assert.throws(
      () => set("Tundmatu", { occurrenceId: "BASE|220557DA:00000000:0000000000000000|DEADBEEF" }),
      /Unknown occurrence ID/
    );

    // A duplicate string key makes the occurrence ambiguous.
    const ambiguousCatalogPath = join(dir, "ambiguous-catalog.json");
    const ambiguousPackage = join(dir, "ambiguous.package");
    writeFixturePackage(ambiguousPackage, [
      {
        instance: REAL_ENGLISH_INSTANCE,
        entries: [
          { key: SAMPLE_KEYS.duplicate, text: "Same key, first" },
          { key: SAMPLE_KEYS.duplicate, text: "Same key, second" },
        ],
      },
    ]);
    const ambiguousResult = extractCatalog({
      packagePath: ambiguousPackage,
      packLabel: "BASE",
      outDir: join(dir, "ambiguous"),
    });
    assert.ok(existsSync(ambiguousCatalogPath) === false, "the extraction writes its own catalog");
    const ambiguousId = ambiguousResult.catalog.occurrences[0]!.occurrenceId;
    assert.throws(
      () =>
        setTranslation({
          catalogPath: ambiguousResult.catalogPath,
          translationsPath,
          metadataPath,
          occurrenceId: ambiguousId,
          text: "Ei saa aadressida",
          state: "draft",
          origin: "human",
          forceOverwriteReviewed: false,
        }),
      /ambiguous/
    );
  });
});
