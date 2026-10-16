#!/usr/bin/env node
/**
 * Generates the packages for the Phase 2 precedence and fall-through
 * experiments. Design: `../../PHASE2_DESIGN.md`; procedure: `README.md` here.
 *
 * Usage (from the project root):
 *   npx tsx probes/precedence/make-probes.ts \
 *     --base "<The Sims 4>/Data/Client/Strings_ENG_US.package" \
 *     --pack "<The Sims 4>/SP06/Strings_ENG_US.package" \
 *     --out work/probes
 *
 * Everything is generated from the player's own files; no game content is
 * committed. The generated packages are throwaway probes, not releases.
 */
import { mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readStblTables, writePackageFile, type WrittenTable } from "../../src/package-io.js";
import { formatTgi, toTgi } from "../../src/ids.js";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

const basePath = arg("base");
const packPath = arg("pack");
const outDir = arg("out");
mkdirSync(outDir, { recursive: true });

/** The base game's "New Game" entry — visible on the main menu the moment the game starts. */
const NEW_GAME_KEY = 0x0dfed87c;

// SP06 = Romantic Garden Stuff. Two of these are renamed by the probe (so the
// tester can see the package loaded at all); the flower is deliberately left out
// of the package, so its continuing to render in English proves that the game
// falls through to its own table for entries a package does not contain.
const PROBE_OBJECT_KEY = 0xe675c3c8; // "Fountain of Gluteus Maximus" — buy mode
const PROBE_INTERACTION_KEY = 0x03e33593; // "Make a Wish" — the wishing well pie menu
const FALLTHROUGH_TARGET = { key: 0x40b79938, text: "Lupin\n" }; // plant name — buy mode

function copyTable(path: string): WrittenTable {
  const read = readStblTables(path);
  if (read.tables.length !== 1) {
    throw new Error(`${path} has ${read.tables.length} string tables; the probes assume exactly one.`);
  }
  const table = read.tables[0]!;
  return {
    type: table.type,
    group: table.group,
    instance: table.instance,
    entries: table.entries.map((entry) => ({ key: entry.key, text: entry.text })),
  };
}

function withReplacement(table: WrittenTable, key: number, text: string): WrittenTable {
  const index = table.entries.findIndex((entry) => entry.key === key);
  if (index < 0) {
    throw new Error(`key 0x${key.toString(16)} is not in the table being probed`);
  }
  const entries = table.entries.slice();
  entries[index] = { key, text };
  return { ...table, entries };
}

// --- experiment A: two packages, same resource identity, different text -----
const base = copyTable(basePath);
const baseTgi = formatTgi(toTgi({ type: base.type, group: base.group, instance: base.instance }));

const aaa = withReplacement(base, NEW_GAME_KEY, "PROBE-AAA");
const zzz = withReplacement(base, NEW_GAME_KEY, "PROBE-ZZZ");
writePackageFile(join(outDir, "aaa_probe.package"), [aaa]);
writePackageFile(join(outDir, "zzz_probe.package"), [zzz]);

// --- experiment B: a sparse package for a pack table ------------------------
const pack = copyTable(packPath);
const packTgi = formatTgi(toTgi({ type: pack.type, group: pack.group, instance: pack.instance }));
const sparseEntries = [
  { key: PROBE_OBJECT_KEY, text: "SPARSE-PROBE-LOADED" },
  { key: PROBE_INTERACTION_KEY, text: "SPARSE-PROBE-INTERACTION" },
];
for (const entry of sparseEntries) {
  if (!pack.entries.some((original) => original.key === entry.key)) {
    throw new Error(`key 0x${entry.key.toString(16)} is not in ${basename(packPath)}`);
  }
}
if (pack.entries.some((entry) => entry.key === FALLTHROUGH_TARGET.key) === false) {
  throw new Error(`the fall-through target 0x${FALLTHROUGH_TARGET.key.toString(16)} is not in the pack`);
}
writePackageFile(join(outDir, "sparse_probe.package"), [{ ...pack, entries: sparseEntries }]);

const size = (name: string) => `${(statSync(join(outDir, name)).size / 1024).toFixed(0)} KiB`;
console.log(`Wrote three probe packages to ${outDir}\n`);
console.log(`A. precedence (Mods vs Mods):`);
console.log(`   aaa_probe.package   ${size("aaa_probe.package")}  ${baseTgi}, "New Game" -> "PROBE-AAA"`);
console.log(`   zzz_probe.package   ${size("zzz_probe.package")}  same resource identity, -> "PROBE-ZZZ"`);
console.log(`B. fall-through (sparse override of a pack table):`);
console.log(`   sparse_probe.package ${size("sparse_probe.package")}  ${packTgi}`);
console.log(`      contains 2 of that table's ${pack.entries.length} entries:`);
console.log(`        "Fountain of Gluteus Maximus" -> "SPARSE-PROBE-LOADED"   (positive control)`);
console.log(`        "Make a Wish"                 -> "SPARSE-PROBE-INTERACTION"`);
console.log(`      deliberately omits 0x${FALLTHROUGH_TARGET.key.toString(16)} = ${JSON.stringify(FALLTHROUGH_TARGET.text)}`);
console.log(`\nRead probes/precedence/README.md before installing these.`);
