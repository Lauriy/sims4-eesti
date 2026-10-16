/**
 * Batch translation in and out.
 *
 * Deliberately engine-agnostic: `export` writes plain JSON batches of English
 * strings, `import` reads the same files back with Estonian filled in. Whatever
 * produced the text - a subagent, a script, a translation service, a person - the
 * import path is identical, which is what keeps the metadata honest and the
 * validation in one place.
 *
 * `import` is the only way machine text enters `translations/`: it validates each
 * entry against the catalog before writing (placeholders preserved, no unhandled
 * syntax, not the English text verbatim), records `machine` origin, and reports
 * every rejection with its reason. Text that would break a string is refused; text
 * that is merely imperfect Estonian is not - that is what review during play is
 * for.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TOOL_NAME, TOOL_VERSION, loadCatalog, writeJsonAtomic, type Catalog } from "./catalog.js";
import {
  loadMetadata,
  loadTranslations,
  saveMetadata,
  saveTranslations,
  type MetadataFile,
  type TranslationMap,
} from "./translations.js";
import {
  analyzeSyntax,
  validateTranslation,
  type TranslationState,
  type ValidationIssue,
} from "./validation.js";

export const BATCH_SCHEMA_VERSION = 1;

export interface BatchEntry {
  occurrenceId: string;
  sourceText: string;
  /** Where this string sits, for a translator who cannot see the game. */
  context: {
    package: string;
    /** What kind of thing it reads as, from its shape. */
    kind: string;
    /** Strings immediately before and after it in the same table: Maxis groups UI text in blocks, so neighbours identify the screen. */
    before?: string[];
    after?: string[];
    /** Placeholders that must survive, verbatim and in this multiset. */
    placeholders: string[];
    /** UTF-8 bytes of the English, as a rough budget for how much room there is. */
    englishBytes: number;
    notes?: string[];
  };
}

export interface BatchFile {
  schemaVersion: number;
  createdAt: string;
  targetLocale: string;
  notes: string[];
  /** Strings still to translate, in catalog order. */
  entries: BatchEntry[];
}

export interface ExportOptions {
  catalogPath: string;
  translationsPath: string;
  outDir: string;
  /** Strings per batch file. */
  batchSize?: number;
  /** Stop after this many strings, across all batches. */
  limit?: number;
  /** Only these package labels (e.g. SP06); default: every package. */
  includePackages?: string[];
  /** Skip these package labels (e.g. BASE, when doing the packs first). */
  excludePackages?: string[];
}

export interface ExportResult {
  batchPaths: string[];
  totalStrings: number;
  perPackage: Record<string, number>;
}

const STYLE_NOTES = [
  "Translate the English game text into Estonian (et-EE).",
  "Return ONLY a JSON object mapping each occurrenceId to the Estonian text: {\"<id>\": \"<text>\", ...}",
  "Do not translate the ids. Do not add or drop entries. Do not explain.",
  "Keep every placeholder exactly as it appears, including its number and spelling: {0.SimFirstName}, {1.String}, {0.Number}, {0.Money}, {0.SimName}, {0.ObjectName}, {0.TimeShort}, {0.Timespan}, {0.DayOfWeekShort}, {0.DayOfWeekLong}. Reordering them inside a sentence is fine; changing or dropping one is not.",
  "Keep escape sequences and bracketed codes exactly: \\n, \\s, [PH], [V], [DNT].",
  "Preserve leading and trailing spaces exactly as in the English.",
  "Do not translate: Sim, Sims, The Sims 4, EA, Maxis, and pack or kit names (e.g. Backyard Stuff).",
  "Uppercase English labels are usually buttons or tabs: translate them as short noun phrases or imperatives in normal Estonian capitalisation, not in capitals.",
  "Estonian buttons and menu entries are imperative verb phrases (Salvesta, Laadi, Välju), not nouns.",
  "Do not attach Estonian case endings to names or values that the game inserts at runtime; rephrase instead.",
  "If a string cannot be translated without breaking the rules above, leave it out of the answer rather than guessing - it will stay English and be reported.",
];

/**
 * What a string reads as, judged only from its own shape. A translator who cannot
 * see the game needs at least this much: a one-word English label like "Sound"
 * gives no clue whether it is a tab, a tag or a category heading.
 */
function classify(sourceText: string): { kind: string; notes: string[] } {
  const notes: string[] = [];
  const trimmed = sourceText.trim();
  const words = trimmed.split(/\s+/).filter(Boolean).length;

  if (/^\(From /.test(trimmed)) {
    return { kind: "moodlet source, shown in brackets after the mood text", notes };
  }
  if (/^[^a-z]*[A-Z][^a-z]*$/.test(trimmed) && trimmed.length > 1) {
    notes.push("rendered in capitals in the interface; translate as a normal-cased label");
    return { kind: "label, shown in capitals", notes };
  }
  if (words <= 3 && trimmed.length <= 24 && !/[.!?]$/.test(trimmed)) {
    return { kind: "short label: button, tab, menu entry or item name", notes };
  }
  if (/[.!?]$/.test(trimmed) || words > 12) {
    return { kind: "sentence or paragraph: notification, tooltip or description", notes };
  }
  return { kind: "phrase", notes };
}

/**
 * The two strings either side in the same table, which is where UI blocks live.
 *
 * Built once for the whole catalog: doing this per entry would be quadratic, and
 * the base game alone is 58,374 entries.
 */
function tableIndex(catalog: Catalog): Map<string, { text: string; position: number }[]> {
  const byTable = new Map<string, { text: string; position: number }[]>();
  for (const occurrence of catalog.occurrences) {
    const list = byTable.get(occurrence.resourceTgi) ?? [];
    list.push({ text: occurrence.sourceText, position: occurrence.entryIndex });
    byTable.set(occurrence.resourceTgi, list);
  }
  for (const list of byTable.values()) list.sort((a, b) => a.position - b.position);
  return byTable;
}

function neighbours(
  byTable: Map<string, { text: string; position: number }[]>,
  resourceTgi: string,
  entryIndex: number
): { before?: string[]; after?: string[] } {
  const list = byTable.get(resourceTgi) ?? [];
  const position = list.findIndex((item) => item.position === entryIndex);
  if (position < 0) return {};
  const before = list.slice(Math.max(0, position - 2), position).map((item) => item.text);
  const after = list.slice(position + 1, position + 3).map((item) => item.text);
  return {
    ...(before.length > 0 ? { before } : {}),
    ...(after.length > 0 ? { after } : {}),
  };
}

export function exportBatches(options: ExportOptions): ExportResult {
  const catalog: Catalog = loadCatalog(options.catalogPath);
  const translations = loadTranslations(options.translationsPath);
  const batchSize = options.batchSize ?? 400;

  const candidates = catalog.occurrences.filter((occurrence) => {
    if (occurrence.ambiguous) return false;
    if (translations[occurrence.occurrenceId] !== undefined) return false;
    if (catalog.resources.find((r) => r.tgi === occurrence.resourceTgi)?.localeByte !== "00") return false;
    if (options.includePackages && !options.includePackages.includes(occurrence.packageLabel)) return false;
    if (options.excludePackages?.includes(occurrence.packageLabel)) return false;
    return true;
  });

  const byTable = tableIndex(catalog);
  const limited = options.limit ? candidates.slice(0, options.limit) : candidates;
  mkdirSync(options.outDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const batchPaths: string[] = [];
  const perPackage: Record<string, number> = {};

  for (let start = 0; start < limited.length; start += batchSize) {
    const slice = limited.slice(start, start + batchSize);
    for (const occurrence of slice) {
      perPackage[occurrence.packageLabel] = (perPackage[occurrence.packageLabel] ?? 0) + 1;
    }
    const index = Math.floor(start / batchSize) + 1;
    const batch: BatchFile = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      createdAt,
      targetLocale: "et-EE",
      notes: [
        ...STYLE_NOTES,
        "See glossary.json in the repository root for agreed vocabulary and style rules.",
      ],
      entries: slice.map((occurrence) => {
        const where = classify(occurrence.sourceText);
        const analysis = analyzeSyntax(occurrence.sourceText);
        const { before, after } = neighbours(byTable, occurrence.resourceTgi, occurrence.entryIndex);
        return {
          occurrenceId: occurrence.occurrenceId,
          sourceText: occurrence.sourceText,
          context: {
            package: occurrence.packageLabel,
            kind: where.kind,
            ...(before ? { before } : {}),
            ...(after ? { after } : {}),
            placeholders: analysis.placeholders,
            englishBytes: Buffer.byteLength(occurrence.sourceText, "utf8"),
            ...(where.notes.length > 0 ? { notes: where.notes } : {}),
          },
        };
      }),
    };
    const path = join(options.outDir, `batch-${String(index).padStart(3, "0")}.json`);
    writeJsonAtomic(path, batch);
    batchPaths.push(path);
  }

  const instructions = `# Translation batches

${batchPaths.length} batch file(s), ${limited.length} strings, target locale et-EE.

For each batch file, produce a file next to it named \`batch-NNN.translated.json\`
containing a single JSON object that maps every \`occurrenceId\` in the batch to its
Estonian text. Nothing else: no wrapper object, no comments, no markdown fences.

Rules that the import step enforces (a violating entry is rejected, not repaired):

${STYLE_NOTES.map((note) => `- ${note}`).join("\n")}

Import with:

\`\`\`powershell
npm run cli -- translate import --catalog ${options.catalogPath} --in ${options.outDir} --state machine --origin machine
\`\`\`
`;
  writeFileSync(join(options.outDir, "INSTRUCTIONS.md"), instructions, "utf8");

  return { batchPaths, totalStrings: limited.length, perPackage };
}

export interface ImportOptions {
  catalogPath: string;
  translationsPath: string;
  metadataPath: string;
  /** Files or directories holding `{id: text}` objects. */
  inputs: string[];
  state: TranslationState;
  origin: "human" | "machine";
  /** Replace an entry whose current state is "reviewed". */
  forceOverwriteReviewed?: boolean;
}

export interface ImportResult {
  filesRead: number;
  entriesSeen: number;
  applied: number;
  rejected: { occurrenceId: string; reasons: ValidationIssue[] }[];
  unknownIds: string[];
  skippedReviewed: string[];
  perPackage: Record<string, number>;
}

function collectJsonFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    if (!existsSync(input)) throw new Error(`No such file or directory: "${input}"`);
    if (statSync(input).isDirectory()) {
      for (const entry of readdirSync(input, { withFileTypes: true })) {
        const full = join(input, entry.name);
        if (entry.isDirectory()) files.push(...collectJsonFiles([full]));
        // Skip the untranslated batches themselves; they are English on purpose.
        else if (entry.name.endsWith(".json") && !/^batch-\d+\.json$/.test(entry.name)) files.push(full);
      }
    } else {
      files.push(input);
    }
  }
  return files.sort();
}

export function importTranslations(options: ImportOptions): ImportResult {
  const catalog = loadCatalog(options.catalogPath);
  const translations: TranslationMap = loadTranslations(options.translationsPath);
  const metadata: MetadataFile = loadMetadata(options.metadataPath);
  const byId = new Map(catalog.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const resources = new Map(catalog.resources.map((resource) => [resource.tgi, resource]));

  const files = collectJsonFiles(options.inputs);
  const result: ImportResult = {
    filesRead: files.length,
    entriesSeen: 0,
    applied: 0,
    rejected: [],
    unknownIds: [],
    skippedReviewed: [],
    perPackage: {},
  };

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`"${basename(file)}" is not valid JSON: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `"${basename(file)}" must be a JSON object mapping occurrence IDs to text, not an array.`
      );
    }

    for (const [occurrenceId, text] of Object.entries(parsed as Record<string, unknown>)) {
      result.entriesSeen += 1;
      if (typeof text !== "string") {
        result.rejected.push({
          occurrenceId,
          reasons: [{ code: "invalid-text", message: `not a string: ${typeof text}` }],
        });
        continue;
      }
      const occurrence = byId.get(occurrenceId);
      if (!occurrence) {
        result.unknownIds.push(occurrenceId);
        continue;
      }
      if (metadata.entries[occurrenceId]?.state === "reviewed" && !options.forceOverwriteReviewed) {
        result.skippedReviewed.push(occurrenceId);
        continue;
      }

      const issues = validateTranslation({
        sourceText: occurrence.sourceText,
        catalogSourceHash: occurrence.sourceHash,
        metadataSourceHash: occurrence.sourceHash,
        text,
        state: options.state,
        includeUnreviewed: true,
        ...(occurrence.ambiguous ? { ambiguous: true } : {}),
      });
      // An English copy is a missing translation, not a broken one: keep it out of
      // the translation file so it shows up as still-untranslated.
      if (issues.some((issue) => issue.code === "identical-to-source")) {
        result.rejected.push({ occurrenceId, reasons: issues });
        continue;
      }
      if (issues.length > 0) {
        result.rejected.push({ occurrenceId, reasons: issues });
        continue;
      }

      translations[occurrenceId] = text;
      metadata.entries[occurrenceId] = {
        state: options.state,
        sourceHash: occurrence.sourceHash,
        updatedAt: new Date().toISOString(),
        origin: options.origin,
      };
      result.applied += 1;
      const label = resources.get(occurrence.resourceTgi)?.packageLabel ?? "?";
      result.perPackage[label] = (result.perPackage[label] ?? 0) + 1;
    }
  }

  if (result.applied > 0) {
    saveTranslations(options.translationsPath, translations);
    saveMetadata(options.metadataPath, metadata);
  }
  return result;
}

export function translationStats(catalogPath: string, translationsPath: string) {
  const catalog = loadCatalog(catalogPath);
  const translations = loadTranslations(translationsPath);
  const byPackage = new Map<string, { total: number; translated: number; ambiguous: number }>();
  let total = 0;
  let translated = 0;
  let ambiguous = 0;

  for (const occurrence of catalog.occurrences) {
    const label = occurrence.packageLabel;
    const row = byPackage.get(label) ?? { total: 0, translated: 0, ambiguous: 0 };
    row.total += 1;
    if (occurrence.ambiguous) {
      row.ambiguous += 1;
      ambiguous += 1;
    } else if (translations[occurrence.occurrenceId] !== undefined) {
      row.translated += 1;
      translated += 1;
    }
    total += 1;
    byPackage.set(label, row);
  }
  return { total, translated, ambiguous, byPackage };
}
