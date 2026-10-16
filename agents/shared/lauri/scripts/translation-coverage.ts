#!/usr/bin/env node
/**
 * Measure how much of a catalog the current validation rules can actually
 * translate, and why the rest is deferred. This is the number to quote when
 * describing coverage — not "everything except a few edge cases".
 *
 * Usage (from the project root):
 *   npx tsx agents/shared/lauri/scripts/translation-coverage.ts <catalog.json>
 */
import { readFileSync } from "node:fs";
import { analyzeSyntax } from "../../../../src/validation.js";

const [catalogPath] = process.argv.slice(2);
if (!catalogPath) {
  console.error("usage: translation-coverage.ts <catalog.json>");
  process.exit(2);
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
  occurrences: { sourceText: string; ambiguous?: true }[];
};

const reasons = new Map<string, number>();
let eligible = 0;

for (const occurrence of catalog.occurrences) {
  if (occurrence.ambiguous) {
    reasons.set("ambiguous (duplicate key or resource)", (reasons.get("ambiguous (duplicate key or resource)") ?? 0) + 1);
    continue;
  }
  const analysis = analyzeSyntax(occurrence.sourceText);
  if (!analysis.problem) {
    eligible++;
    continue;
  }
  const reason = /markup/.test(analysis.problem)
    ? "markup (reflow rules unhandled)"
    : /does not handle|value names/.test(analysis.problem)
      ? "branch/pronoun expression (payload is source-language grammar)"
      : /closing|opening|nested/.test(analysis.problem)
        ? "unbalanced or nested braces"
        : "other";
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

const total = catalog.occurrences.length;
const share = (count: number) => `${((count / total) * 100).toFixed(1)}%`;
console.log(`catalog: ${total} strings`);
console.log(`eligible for translation now: ${eligible} (${share(eligible)})`);
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  deferred — ${reason}: ${count} (${share(count)})`);
}
