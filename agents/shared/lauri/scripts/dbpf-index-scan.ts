#!/usr/bin/env node
/**
 * Find which installed packages list a given resource identity, by reading only
 * the 96-byte DBPF header and the index region of each package — never the
 * resource data. Answers "does anything else ship the resource I override, and
 * would it compete with my mod?" in seconds instead of loading gigabytes.
 *
 * Self-contained: no project imports, no dependencies.
 *
 * Usage:
 *   npx tsx agents/shared/lauri/scripts/dbpf-index-scan.ts <game-root> [type-hex] [instance-hex]
 *   npx tsx agents/shared/lauri/scripts/dbpf-index-scan.ts "C:\...\The Sims 4" 220557DA 0054935F2685AD48
 *
 * Reports, per package: how many resources it lists, how many match the type,
 * and how many match the full identity. Packages whose index uses constant
 * fields (flags != 0) are skipped and named, because their records are laid out
 * differently — read those with the project's own reader instead.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const [root, typeHex = "220557DA", instanceHex = "0054935F2685AD48"] = process.argv.slice(2);
if (!root) {
  console.error("usage: dbpf-index-scan.ts <game-root> [type-hex] [instance-hex]");
  process.exit(2);
}
const TARGET_TYPE = Number.parseInt(typeHex, 16);
const TARGET_INSTANCE = BigInt(`0x${instanceHex}`);

interface ScanResult {
  file: string;
  error?: string;
  count?: number;
  typed?: number;
  matched?: number;
  others?: string[];
}

function scan(file: string): ScanResult {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(96);
    if (readSync(fd, header, 0, 96, 0) < 96) return { file, error: "shorter than a header" };
    if (header.toString("latin1", 0, 4) !== "DBPF") return { file, error: "not a DBPF" };
    const count = header.readUInt32LE(36);
    const indexSize = header.readUInt32LE(44);
    const indexPosition = Number(header.readBigUInt64LE(64)) || header.readUInt32LE(40);
    const size = statSync(file).size;
    if (indexPosition <= 0 || indexPosition >= size) {
      return { file, error: `index position ${indexPosition} is outside the file` };
    }
    const index = Buffer.alloc(Math.min(indexSize, 32 * count + 4));
    readSync(fd, index, 0, index.length, indexPosition);
    const flags = index.readUInt32LE(0);
    if (flags !== 0) {
      return { file, error: `index flags ${flags} (constant fields); read it with the project's reader` };
    }
    let typed = 0;
    let matched = 0;
    const others: string[] = [];
    for (let i = 0; i < count; i++) {
      const offset = 4 + i * 32;
      if (offset + 32 > index.length) break;
      if (index.readUInt32LE(offset) !== TARGET_TYPE) continue;
      typed++;
      const instance =
        (BigInt(index.readUInt32LE(offset + 8)) << 32n) + BigInt(index.readUInt32LE(offset + 12));
      if (instance === TARGET_INSTANCE) matched++;
      else others.push(instance.toString(16).toUpperCase().padStart(16, "0"));
    }
    return { file, count, typed, matched, others };
  } finally {
    closeSync(fd);
  }
}

function collectPackageFiles(root: string, maxDepth = 6): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than fail the whole scan
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.toLowerCase().endsWith(".package")) {
        files.push(full);
      }
    }
  };
  walk(root, 0);
  return files.sort();
}

const files = collectPackageFiles(root);
let matches = 0;
let skipped = 0;
for (const file of files) {
  const result = scan(file);
  if (result.error) {
    skipped++;
    console.log(`SKIP  ${file} — ${result.error}`);
    continue;
  }
  if (result.matched) {
    matches++;
    console.log(
      `MATCH ${file} — ${result.count} resources, ${result.typed} with type ${typeHex}, ` +
        `${result.matched} with instance ${instanceHex}`
    );
  } else if (result.typed) {
    console.log(
      `typed ${file} — ${result.typed} other ${typeHex} instance(s): ${result.others!.slice(0, 3).join(", ")}`
    );
  }
}
console.log(
  `\nscanned ${files.length} package(s): ${matches} list ${typeHex}:${instanceHex}, ` +
    `${skipped} could not be scanned`
);
