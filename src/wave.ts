/**
 * The state of a translation wave, in one report.
 *
 * A wave is a directory of batch files produced by `translate-export`, plus the
 * `batch-NNN.translated.json` answers written next to them. Questions this answers
 * without three scratch scripts: how much of the wave is answered, how much of the
 * answers the validator would accept, what was rejected and why, and whether
 * anything has already been imported.
 *
 * It reads; it never writes. The import remains the only thing that changes the
 * translations file.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadCatalog } from "./catalog.js";
import type { TranslationMap } from "./translations.js";
import { validateTranslation, type IssueCode } from "./validation.js";

export interface WaveBatchReport {
  /** The batch file's name, e.g. "batch-003.json". */
  batch: string;
  /** Entries the batch asked for. */
  expected: number;
  /** Ids the answer file covers. */
  answered: number;
  /** Answers the validator accepts. */
  accepted: number;
  /** Answers the validator refuses, with the codes. */
  rejected: { occurrenceId: string; codes: IssueCode[] }[];
  /** Entries with no answer at all: skipped by the translator, or not yet done. */
  missing: number;
}

export interface WaveReport {
  directory: string;
  batches: WaveBatchReport[];
  totals: { expected: number; answered: number; accepted: number; missing: number };
  /** How many answers each rejection code accounted for. */
  rejectionReasons: Record<string, number>;
  /** Ids in this wave that already have a translation stored. */
  imported: number;
  /** True when every batch is fully answered and nothing is rejected. */
  complete: boolean;
}

export interface WaveOptions {
  directory: string;
  catalogPath: string;
  translations: TranslationMap;
}

/** Reads one wave directory and reports what it holds. */
export function inspectWave(options: WaveOptions): WaveReport {
  const catalog = loadCatalog(options.catalogPath);
  const byId = new Map(catalog.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const names = existsSync(options.directory) ? readdirSync(options.directory) : [];
  const batchNames = names.filter((name) => /^batch-\d+\.json$/.test(name)).sort();

  const batches: WaveBatchReport[] = [];
  let imported = 0;

  for (const name of batchNames) {
    const batch = JSON.parse(readFileSync(join(options.directory, name), "utf8")) as {
      entries?: { occurrenceId?: unknown }[];
    };
    const ids = (batch.entries ?? [])
      .map((entry) => entry.occurrenceId)
      .filter((id): id is string => typeof id === "string");
    for (const id of ids) {
      if (options.translations[id] !== undefined) imported += 1;
    }

    const answerPath = join(options.directory, name.replace(/\.json$/, ".translated.json"));
    const answers = existsSync(answerPath)
      ? (JSON.parse(readFileSync(answerPath, "utf8")) as Record<string, unknown>)
      : {};

    const rejected: WaveBatchReport["rejected"] = [];
    let accepted = 0;
    let answered = 0;
    for (const id of ids) {
      const text = answers[id];
      if (typeof text !== "string") continue;
      answered += 1;
      const occurrence = byId.get(id);
      if (!occurrence) {
        rejected.push({ occurrenceId: id, codes: ["unknown-occurrence"] });
        continue;
      }
      const issues = validateTranslation({
        sourceText: occurrence.sourceText,
        catalogSourceHash: occurrence.sourceHash,
        metadataSourceHash: occurrence.sourceHash,
        text,
        state: "machine",
        includeUnreviewed: true,
        ...(occurrence.ambiguous ? { ambiguous: true } : {}),
      });
      if (issues.length > 0) {
        rejected.push({ occurrenceId: id, codes: issues.map((issue) => issue.code) });
      } else {
        accepted += 1;
      }
    }

    batches.push({
      batch: name,
      expected: ids.length,
      answered,
      accepted,
      rejected,
      missing: ids.length - answered,
    });
  }

  const totals = batches.reduce(
    (sum, batch) => ({
      expected: sum.expected + batch.expected,
      answered: sum.answered + batch.answered,
      accepted: sum.accepted + batch.accepted,
      missing: sum.missing + batch.missing,
    }),
    { expected: 0, answered: 0, accepted: 0, missing: 0 }
  );

  const rejectionReasons: Record<string, number> = {};
  for (const batch of batches) {
    for (const rejection of batch.rejected) {
      for (const code of rejection.codes) {
        rejectionReasons[code] = (rejectionReasons[code] ?? 0) + 1;
      }
    }
  }

  return {
    directory: options.directory,
    batches,
    totals,
    rejectionReasons,
    imported,
    complete:
      batches.length > 0 && totals.missing === 0 && batches.every((batch) => batch.rejected.length === 0),
  };
}

/** The one-line-per-batch summary the CLI prints. */
export function describeWave(report: WaveReport): string[] {
  const lines: string[] = [];
  const pct = (part: number, whole: number) => (whole === 0 ? "0.0" : ((100 * part) / whole).toFixed(1));
  lines.push(
    `Wave ${basename(report.directory)}: ${report.batches.length} batch file(s), ` +
      `${report.totals.expected} entries`
  );
  lines.push(
    `  answered ${report.totals.answered} (${pct(report.totals.answered, report.totals.expected)}%), ` +
      `accepted ${report.totals.accepted}, rejected ${report.totals.answered - report.totals.accepted}, ` +
      `unanswered ${report.totals.missing}`
  );
  lines.push(`  already imported: ${report.imported}`);
  for (const batch of report.batches) {
    const state =
      batch.missing > 0 ? "incomplete" : batch.rejected.length > 0 ? "rejected entries" : "clean";
    lines.push(
      `  ${batch.batch}  ${batch.answered}/${batch.expected} answered, ` +
        `${batch.rejected.length} rejected  (${state})`
    );
  }
  const reasons = Object.entries(report.rejectionReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    lines.push(`  rejection reasons: ${reasons.map(([code, count]) => `${code} ${count}`).join(", ")}`);
  }
  lines.push(report.complete ? "  wave complete" : "  wave not complete");
  return lines;
}
