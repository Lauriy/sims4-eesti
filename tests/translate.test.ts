/**
 * The batch pipeline: one entry per distinct text, and the keys it stands for.
 *
 * Motivated by a real drift: "Stuff Packs" was exported at three keys, translated
 * independently in different batches, and came back as "Komplektid",
 * "Väikepakid" and "Asjapaketid". Deduplicating by text makes one decision cover
 * every key that carries the same English; an override file keeps the keys that
 * genuinely differ ("Kids" is a radio station and a build category) from being
 * overruled.
 */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { extractCatalog } from "../src/catalog.js";
import { exportBatches, importTranslations } from "../src/translate.js";
import { makeTempDir, removeDir, writeFixturePackage } from "./helpers.js";

const REAL_ENGLISH_INSTANCE = 0x0054935f2685ad48n;
const KEYS = {
  first: 0x10000001,
  second: 0x10000002,
  unique: 0x10000003,
} as const;

let dir: string;
let packagePath: string;
let catalogPath: string;
let translationsPath: string;
let metadataPath: string;

before(() => {
  dir = makeTempDir("translate");
  packagePath = join(dir, "Strings_ENG_US.package");
  // "Buy a Bed" appears at two keys, which is what dedupe groups.
  writeFixturePackage(packagePath, [
    {
      instance: REAL_ENGLISH_INSTANCE,
      entries: [
        { key: KEYS.first, text: "Buy a Bed" },
        { key: KEYS.second, text: "Buy a Bed" },
        { key: KEYS.unique, text: "Sell a Bed" },
      ],
    },
  ]);
  catalogPath = join(dir, "catalog.json");
  extractCatalog({ packagePath, packLabel: "BASE", outDir: dir });
  catalogPath = join(dir, "catalog.json");
  translationsPath = join(dir, "et-EE.json");
  metadataPath = join(dir, "metadata.json");
  writeFileSync(translationsPath, JSON.stringify({}), "utf8");
  writeFileSync(metadataPath, JSON.stringify({ schemaVersion: 1, targetLocale: "et-EE", entries: {} }), "utf8");
});

after(() => {
  removeDir(dir);
});


/** A fresh export of the fixture into its own directory. */
function exportForTest(): { out: string; result: ReturnType<typeof exportBatches> } {
  const out = join(dir, "batches");
  const result = exportBatches({ catalogPath, translationsPath, outDir: out, dedupeTexts: true, batchSize: 10 });
  return { out, result };
}

function entriesOf(out: string): {
  grouped: { occurrenceId: string; sourceText: string; alsoAt?: string[] };
  single: { occurrenceId: string; sourceText: string; alsoAt?: string[] };
} {
  const batch = JSON.parse(readFileSync(join(out, "batch-001.json"), "utf8")) as {
    entries: { occurrenceId: string; sourceText: string; alsoAt?: string[] }[];
  };
  return {
    grouped: batch.entries.find((entry) => entry.sourceText === "Buy a Bed")!,
    single: batch.entries.find((entry) => entry.sourceText === "Sell a Bed")!,
  };
}

describe("batch export and import", () => {
  it("exports one entry per distinct text, with the other keys attached", () => {
    const { out, result } = exportForTest();
    assert.equal(result.totalStrings, 2, "two distinct texts, from three occurrences");

    const batch = JSON.parse(readFileSync(join(out, "batch-001.json"), "utf8")) as {
      entries: { occurrenceId: string; sourceText: string; alsoAt?: string[] }[];
    };
    const grouped = batch.entries.find((entry) => entry.sourceText === "Buy a Bed")!;
    assert.equal(grouped.alsoAt?.length, 1, "the second key travels with the entry");
    assert.match(grouped.alsoAt![0]!, /\|10000002$/);
    const single = batch.entries.find((entry) => entry.sourceText === "Sell a Bed")!;
    assert.equal(single.alsoAt, undefined, "a text that appears once carries no list");
  });

  it("fills every key of a text from the one translation, and lets an override win", () => {
    const { out } = exportForTest();
    const { grouped, single } = entriesOf(out);

    writeFileSync(
      join(out, "batch-001.translated.json"),
      JSON.stringify({
        [grouped.occurrenceId]: "Osta voodi",
        [single.occurrenceId]: "Müü voodi",
      }),
      "utf8"
    );
    // The second key needs a different wording: the translator says so here.
    writeFileSync(
      join(out, "batch-001.overrides.json"),
      JSON.stringify({ [grouped.alsoAt![0]!]: "Osta voodi (teine)" }),
      "utf8"
    );

    const result = importTranslations({
      catalogPath,
      translationsPath,
      metadataPath,
      inputs: [out],
      state: "machine",
      origin: "machine",
    });
    assert.equal(result.applied, 2);
    assert.equal(result.propagated, 1, "the twin key was filled from the shared text");
    assert.equal(result.overridden, 1, "and then the override replaced it");
    assert.equal(result.rejected.length, 0);

    const translations = JSON.parse(readFileSync(translationsPath, "utf8")) as Record<string, string>;
    const byKey = (key: string) => translations[Object.keys(translations).find((id) => id.endsWith(key))!];
    assert.equal(byKey("|10000001"), "Osta voodi");
    assert.equal(byKey("|10000002"), "Osta voodi (teine)", "the override wins over the propagated default");
    assert.equal(byKey("|10000003"), "Müü voodi");

    // Provenance: the propagated key records where its text came from.
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      entries: Record<string, { origin?: string; note?: string }>;
    };
    const propagated = Object.entries(metadata.entries).find(([id]) => id.endsWith("|10000002"))![1];
    assert.equal(propagated.origin, "machine");
  });

  it("refuses to propagate onto a key that appears twice in its own table", () => {
    // Such a key cannot be addressed to a single entry, so the catalog marks it
    // ambiguous and it must stay English rather than inherit the twin's text.
    const { out } = exportForTest();
    const { grouped } = entriesOf(out);
    writeFileSync(
      join(out, "batch-001.translated.json"),
      JSON.stringify({ [grouped.occurrenceId]: "Osta voodi" }),
      "utf8"
    );

    const patchedCatalog = join(dir, "catalog-ambiguous.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      occurrences: { occurrenceId: string; ambiguous?: true }[];
    };
    for (const occurrence of catalog.occurrences) {
      if (occurrence.occurrenceId.endsWith("|10000002")) occurrence.ambiguous = true;
    }
    writeFileSync(patchedCatalog, JSON.stringify(catalog), "utf8");

    const freshTranslations = join(dir, "ambiguous-et.json");
    const freshMetadata = join(dir, "ambiguous-metadata.json");
    writeFileSync(freshTranslations, JSON.stringify({}), "utf8");
    writeFileSync(freshMetadata, JSON.stringify({ schemaVersion: 1, targetLocale: "et-EE", entries: {} }), "utf8");

    const result = importTranslations({
      catalogPath: patchedCatalog,
      translationsPath: freshTranslations,
      metadataPath: freshMetadata,
      inputs: [out],
      state: "machine",
      origin: "machine",
    });
    assert.equal(result.applied, 1);
    assert.equal(result.propagated, 0, "the ambiguous twin is left alone");
    const translations = JSON.parse(readFileSync(freshTranslations, "utf8")) as Record<string, string>;
    assert.equal(Object.values(translations).includes("Osta voodi") && Object.keys(translations).length, 1);
  });
});
