/**
 * The wave report is a reporting tool, and the lesson from this project is that a
 * reporting tool can quietly flatter itself. These tests pin the arithmetic on a
 * batch where the answer is known: one accepted, one rejected, one never answered.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { extractCatalog } from "../src/catalog.js";
import { inspectWave } from "../src/wave.js";
import { makeTempDir, removeDir, writeFixturePackage } from "./helpers.js";

const INSTANCE = 0x0054935f2685ad48n;

let dir: string;
let catalogPath: string;
let waveDir: string;
const ids: Record<string, string> = {};

before(() => {
  dir = makeTempDir("wave");
  const packagePath = join(dir, "Strings_ENG_US.package");
  writeFixturePackage(packagePath, [
    {
      instance: INSTANCE,
      entries: [
        { key: 0x20000001, text: "New Game" },
        { key: 0x20000002, text: "Zimbabwe" },
        { key: 0x20000003, text: "Load Game" },
      ],
    },
  ]);
  extractCatalog({ packagePath, packLabel: "BASE", outDir: dir });
  catalogPath = join(dir, "catalog.json");

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    occurrences: { occurrenceId: string; sourceText: string }[];
  };
  for (const occurrence of catalog.occurrences) ids[occurrence.sourceText] = occurrence.occurrenceId;

  // The batch asks for three entries; the answer covers two, and one of those two
  // is the English copied back, which the validator refuses as not a translation.
  waveDir = join(dir, "wave");
  mkdirSync(waveDir, { recursive: true });
  writeFileSync(
    join(waveDir, "batch-001.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: ["New Game", "Zimbabwe", "Load Game"].map((text) => ({
        occurrenceId: ids[text],
        sourceText: text,
        context: {},
      })),
    }),
    "utf8"
  );
  writeFileSync(
    join(waveDir, "batch-001.translated.json"),
    JSON.stringify({ [ids["New Game"]!]: "Uus mäng", [ids["Zimbabwe"]!]: "Zimbabwe" }),
    "utf8"
  );
});

after(() => {
  removeDir(dir);
});

describe("wave report", () => {
  it("counts accepted, rejected and unanswered separately", () => {
    const report = inspectWave({ directory: waveDir, catalogPath, translations: {} });
    assert.equal(report.totals.expected, 3);
    assert.equal(report.totals.answered, 2);
    assert.equal(report.totals.accepted, 1, "only the Estonian translation is accepted");
    assert.equal(report.totals.missing, 1, "the third entry has no answer at all");
    assert.equal(report.batches[0]!.rejected.length, 1);
    assert.deepEqual(report.batches[0]!.rejected[0]!.codes, ["identical-to-source"]);
    assert.equal(report.complete, false);
  });

  it("counts what is already imported", () => {
    const report = inspectWave({
      directory: waveDir,
      catalogPath,
      translations: { [ids["New Game"]!]: "Uus mäng" },
    });
    assert.equal(report.imported, 1);
  });
});
