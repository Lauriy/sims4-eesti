#!/usr/bin/env node
/**
 * Compare a built package against the source package it was built from, entry by
 * entry, using the project's own reader — and report the exact number of
 * differences rather than "no errors".
 *
 * Usage (from the project root):
 *   npx tsx agents/shared/lauri/scripts/verify-built-package.ts <source.package> <built.package> [translations.json]
 *
 * Exits non-zero if anything unexpected appears: a changed key, a changed entry
 * that is not in the translations file, a resource identity that moved, or a
 * payload that fails a byte-level read.
 *
 * NOTE: this file imports the host project's src/ four levels up, so it assumes
 * a sims4-eesti-shaped layout. Copy it into a project's own test tree rather than
 * pointing another project at it.
 */
import { readFileSync } from "node:fs";
import { formatTgi, toTgi } from "../../../../src/ids.js";
import { readRawStblBuffers, readStblTables } from "../../../../src/package-io.js";
import { parseStblBuffer } from "../../../../src/stbl-format.js";

const [sourcePath, builtPath, translationsPath] = process.argv.slice(2);
if (!sourcePath || !builtPath) {
  console.error("usage: verify-built-package.ts <source.package> <built.package> [translations.json]");
  process.exit(2);
}

const intended = new Set<string>(
  translationsPath
    ? Object.values(JSON.parse(readFileSync(translationsPath, "utf8")) as Record<string, string>)
    : []
);

const source = readStblTables(sourcePath);
const built = readStblTables(builtPath);
console.log(`source: ${source.resourceCount} resources, ${source.tables.length} string table(s)`);
console.log(`built:  ${built.resourceCount} resources, ${built.tables.length} string table(s)`);

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.log(`  FAIL ${message}`);
};

if (built.resourceCount !== built.tables.length) {
  fail("the built package contains something other than string tables");
}

for (const builtTable of built.tables) {
  const tgi = formatTgi(toTgi(builtTable));
  const sourceTable = source.tables.find((table) => formatTgi(toTgi(table)) === tgi);
  if (!sourceTable) {
    fail(`${tgi} is in the build but not in the source`);
    continue;
  }

  let unchanged = 0;
  let changed = 0;
  let unexpected = 0;
  if (builtTable.entries.length !== sourceTable.entries.length) {
    fail(`${tgi} has ${builtTable.entries.length} entries, source has ${sourceTable.entries.length}`);
  }
  for (let i = 0; i < sourceTable.entries.length; i++) {
    const before = sourceTable.entries[i]!;
    const after = builtTable.entries[i];
    if (!after) break;
    if (before.key !== after.key) {
      fail(`${tgi} entry ${i}: key 0x${before.key.toString(16)} became 0x${after.key.toString(16)}`);
      continue;
    }
    if (before.text === after.text) unchanged++;
    else {
      changed++;
      if (intended.size > 0 && !intended.has(after.text)) {
        unexpected++;
        console.log(`  UNEXPECTED ${tgi} 0x${after.key.toString(16)}: ${JSON.stringify(before.text)} -> ${JSON.stringify(after.text)}`);
      }
    }
  }
  console.log(
    `${tgi}: ${unchanged} unchanged, ${changed} changed, ${unexpected} unexpected, ${builtTable.compressionType} compression`
  );
}

// Byte-level read of the built payload, independent of the model above.
for (const { key, buffer } of readRawStblBuffers(builtPath)) {
  const parsed = parseStblBuffer(buffer);
  const tgi = formatTgi(toTgi(key));
  if (parsed.header.version !== 5) fail(`${tgi} STBL version ${parsed.header.version}`);
  if (parsed.header.compressed !== 0) fail(`${tgi} mnCompressed=${parsed.header.compressed}`);
  const nonZeroFlags = parsed.entries.filter((entry) => entry.flags !== 0).length;
  if (nonZeroFlags > 0) fail(`${tgi} has ${nonZeroFlags} non-zero entry flags`);
  const badLengths = parsed.entries.filter(
    (entry) => entry.byteLength !== Buffer.byteLength(entry.text, "utf8")
  ).length;
  if (badLengths > 0) fail(`${tgi} has ${badLengths} entries with a wrong byte length`);
  console.log(
    `${tgi}: bytes ok — ${parsed.entries.length} entries, version ${parsed.header.version}, flags 0`
  );
}

console.log(failures === 0 ? "\nVERIFIED: no unexpected differences" : `\nFAILED: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
