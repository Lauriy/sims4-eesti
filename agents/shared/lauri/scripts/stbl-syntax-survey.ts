#!/usr/bin/env node
/**
 * Survey the token syntax that actually occurs in a package's string tables —
 * the evidence you need before writing validation rules, instead of guessing
 * which placeholders and markup exist.
 *
 * Usage (from the project root):
 *   npx tsx agents/shared/lauri/scripts/stbl-syntax-survey.ts <package> [max-shapes]
 *
 * Prints: entry/empty/non-ASCII/duplicate-key counts, occurrence counts for each
 * pattern class, samples, and the most common brace-expression shapes with digits
 * normalised to `#`. Read the shapes before deciding what is safe to translate.
 */
import { formatTgi, toTgi } from "../../../../src/ids.js";
import { readStblTables } from "../../../../src/package-io.js";

const [packagePath, maxShapes = "40"] = process.argv.slice(2);
if (!packagePath) {
  console.error("usage: stbl-syntax-survey.ts <package> [max-shapes]");
  process.exit(2);
}

const PATTERNS: Record<string, RegExp> = {
  braceAny: /\{[^{}]*\}/g,
  angleTag: /<\/?[A-Za-z][^<>]{0,40}>/g,
  doubleBracket: /\[\[[^\]]{0,40}\]\]/g,
  percent: /%/g,
  backslashEscape: /\\[A-Za-z]/g,
  realNewline: /\n/g,
  tab: /\t/g,
  bracketCode: /\[[^[\]]{0,40}\]/g,
};

const read = readStblTables(packagePath);
for (const table of read.tables) {
  const counts: Record<string, number> = {};
  const samples: Record<string, Set<string>> = {};
  for (const name of Object.keys(PATTERNS)) {
    counts[name] = 0;
    samples[name] = new Set();
  }
  const braceShapes = new Map<string, number>();
  const keyCounts = new Map<number, number>();
  let empty = 0;
  let nonAscii = 0;

  for (const entry of table.entries) {
    const text = entry.text;
    if (text === "") empty++;
    if (/[^\x20-\x7e]/.test(text)) nonAscii++;
    keyCounts.set(entry.key, (keyCounts.get(entry.key) ?? 0) + 1);
    for (const [name, pattern] of Object.entries(PATTERNS)) {
      pattern.lastIndex = 0;
      const found = text.match(pattern);
      if (found) {
        counts[name] = (counts[name] ?? 0) + found.length;
        if (samples[name]!.size < 10) for (const match of found) samples[name]!.add(match);
      }
    }
    for (const match of text.matchAll(/\{[^{}]*\}/g)) {
      const shape = match[0].replace(/\d+/g, "#");
      braceShapes.set(shape, (braceShapes.get(shape) ?? 0) + 1);
    }
  }

  const duplicateKeys = [...keyCounts.values()].filter((count) => count > 1).length;
  console.log(`\n=== ${formatTgi(toTgi(table))}`);
  console.log(
    `entries ${table.entries.length} | empty ${empty} | non-ASCII ${nonAscii} | duplicate keys ${duplicateKeys}`
  );
  console.log("occurrences by pattern:", counts);
  for (const [name, set] of Object.entries(samples)) {
    if (set.size > 0) {
      console.log(`  ${name}: ${[...set].map((s) => JSON.stringify(s)).join(" ")}`);
    }
  }
  const shapes = [...braceShapes.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`distinct brace shapes: ${shapes.length}; most common:`);
  for (const [shape, count] of shapes.slice(0, Number(maxShapes))) {
    console.log(`  ${String(count).padStart(7)}  ${JSON.stringify(shape)}`);
  }
}

// Non-ASCII coverage is what tells you whether a target language's letters even
// appear in the source text — a font-coverage question you cannot answer from here.
const catalogLike = read.tables.flatMap((table) => table.entries.map((entry) => entry.text));
const chars = new Map<string, number>();
for (const text of catalogLike) {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code > 126) chars.set(char, (chars.get(char) ?? 0) + 1);
  }
}
const top = [...chars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log(`\ndistinct non-ASCII characters: ${chars.size}`);
console.log(top.map(([char, count]) => `${JSON.stringify(char)}:${count}`).join(" "));
if (process.env.SURVEY_CHARS) {
  for (const char of process.env.SURVEY_CHARS) {
    console.log(`  ${JSON.stringify(char)} appears ${chars.get(char) ?? 0} time(s)`);
  }
}