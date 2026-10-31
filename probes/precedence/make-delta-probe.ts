#!/usr/bin/env node
/**
 * Generates the Delta (SDX) precedence probe: one whole pack table with two
 * entries renamed, so a Mods package and the game's Delta copy compete for the
 * same resource identity. Procedure and results: `README.md` here.
 *
 * Usage (from the project root):
 *   npx tsx probes/precedence/make-delta-probe.ts \
 *     --pack "<The Sims 4>/Delta/SP06/Strings_ENG_US.package" \
 *     --out work/probes
 *
 * Full table on purpose: if the game falls through for omitted keys, a sparse
 * probe would confuse "Mods wins" with "the game used its own text". Only the
 * two probe entries differ from the game's copy.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readStblTables, writePackageFile } from "../../src/package-io.js";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

const packPath = arg("pack");
const outDir = arg("out");
mkdirSync(outDir, { recursive: true });

const read = readStblTables(packPath);
if (read.tables.length !== 1) {
  throw new Error(`${packPath} has ${read.tables.length} string tables; the probe assumes exactly one.`);
}
const table = read.tables[0]!;

// SP06 = Romantic Garden Stuff. Both are visible in Build Mode by searching the
// probe text; the plant is the second observation, not a separate experiment.
const probes = new Map<number, string>([
  [0xe675c3c8, "DELTA-PROBE-LOADED"], // "Fountain of Gluteus Maximus"
  [0x40b79938, "DELTA-PROBE-PLANT\n"], // "Lupin\n"
]);
const entries = table.entries.map((entry) => ({
  key: entry.key,
  text: probes.get(entry.key) ?? entry.text,
}));
const changed = entries.filter((entry) => probes.has(entry.key)).length;
if (changed !== probes.size) {
  throw new Error(`expected ${probes.size} probe keys, found ${changed}; is this the SP06 table?`);
}

const outPath = join(outDir, "delta_probe.package");
const written = writePackageFile(outPath, [
  { type: table.type, group: table.group, instance: table.instance, entries },
]);
console.log(`wrote ${outPath} — ${entries.length} entries, ${written.bytes} bytes, ${written.compressors.join(", ")}`);
