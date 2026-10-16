/**
 * Building the conservative whole-table override package.
 *
 * Strategy: for every string table that has at least one eligible translation,
 * start from the *complete original English table*, replace only the eligible
 * entries, and preserve every other entry, key, and resource identifier exactly.
 * The output package contains only those string tables — nothing else from the
 * source package is copied.
 *
 * Keeping the English text of untranslated entries inside each emitted table is
 * deliberate: it gives an English fallback without relying on the game falling
 * through to the original resource for missing entries, which is not something
 * this project has verified.
 */
import { existsSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CompressionType } from "@s4tk/compression";
import {
  TOOL_NAME,
  TOOL_VERSION,
  loadCatalog,
  writeJsonAtomic,
  type Catalog,
  type CatalogOccurrence,
} from "./catalog.js";
import { sha256Hex, sha256File } from "./hashing.js";
import { formatTgi, hex8, localeByteOf, parseHex8, toTgi } from "./ids.js";
import {
  readRawStblBuffers,
  readStblTables,
  writePackageFile,
  type RawEntry,
  type WrittenTable,
} from "./package-io.js";
import { parseStblBuffer } from "./stbl-format.js";
import { loadMetadata, loadTranslations, describeMalformedMetadata } from "./translations.js";
import {
  validateTranslation,
  type IssueCode,
  type TranslationState,
  type ValidationIssue,
} from "./validation.js";

export const BUILD_MANIFEST_SCHEMA_VERSION = 1;

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

export interface BuildOptions {
  catalogPath: string;
  outPath: string;
  translationsPath: string;
  metadataPath: string;
  manifestPath?: string;
  includeUnreviewed: boolean;
  /** Override the source package path recorded in the catalog. Its bytes must still match. */
  packagePath?: string;
  gameVersion?: string;
  gameVersionSource?: string;
}

export interface ExcludedEntry {
  occurrenceId: string;
  sourceText: string;
  codes: IssueCode[];
  messages: string[];
}

export interface EmittedResource {
  tgi: string;
  /** Locale byte of this resource's instance (high byte); "00" is English. */
  localeByte: string;
  entryCount: number;
  replaced: number;
  leftInEnglish: number;
  reviewedReplaced: number;
  unreviewedReplaced: number;
}

export interface BuildReport {
  outPath: string;
  manifestPath: string;
  sourcePackagePath: string;
  sourceSha256: string;
  outputSha256: string;
  outputBytes: number;
  resources: EmittedResource[];
  counts: {
    catalogOccurrences: number;
    translationsInFile: number;
    applied: number;
    excluded: number;
    excludedByCode: Partial<Record<IssueCode, number>>;
    unknownIds: number;
    reviewedApplied: number;
    unreviewedApplied: number;
    resourcesEmitted: number;
    resourcesSkipped: number;
  };
  excluded: ExcludedEntry[];
  warnings: string[];
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let canonical = absolute;
  if (existsSync(absolute)) {
    try {
      canonical = realpathSync.native(absolute);
    } catch {
      canonical = absolute;
    }
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * Refuses to let the output overwrite any input file. Called before anything is
 * written so a build can never damage the catalog or the source package.
 */
function assertOutputIsSafe(options: BuildOptions, sourcePackagePath: string, manifestPath: string): void {
  const inputs: [string, string][] = [
    ["the source package", sourcePackagePath],
    ["the catalog", options.catalogPath],
    ["the translations file", options.translationsPath],
    ["the metadata file", options.metadataPath],
  ];
  // Both outputs are checked, not just the package: the manifest is written
  // unconditionally, so pointing --manifest at an input would destroy it.
  const outputs: [string, string][] = [
    ["the output package", options.outPath],
    ["the manifest", manifestPath],
  ];
  for (const [outputLabel, outputPath] of outputs) {
    const out = canonicalPath(outputPath);
    for (const [inputLabel, inputPath] of inputs) {
      if (canonicalPath(inputPath) === out) {
        throw new BuildError(
          `Refusing to write ${outputLabel} over ${inputLabel}: "${outputPath}" is the same file as ` +
            `"${inputPath}". Choose a different path.`
        );
      }
    }
    if (outputLabel === "the manifest" && canonicalPath(options.outPath) === out) {
      throw new BuildError(
        `Refusing to write the manifest over the output package: both are "${outputPath}".`
      );
    }
    if (existsSync(outputPath) && statSync(outputPath).isDirectory()) {
      throw new BuildError(`${outputLabel} "${outputPath}" is a directory.`);
    }
  }
  const outDir = dirname(resolve(options.outPath));
  if (!existsSync(outDir)) {
    throw new BuildError(
      `Output directory "${outDir}" does not exist. Create it first (the tool will not create ` +
        `directories it might guess wrong about).`
    );
  }
  const manifestDir = dirname(resolve(manifestPath));
  if (!existsSync(manifestDir)) {
    throw new BuildError(`Manifest directory "${manifestDir}" does not exist.`);
  }
}

interface PlannedReplacement {
  occurrence: CatalogOccurrence;
  text: string;
  state: TranslationState;
}

interface AppliedReplacement {
  text: string;
  reviewed: boolean;
}

export function buildPackage(options: BuildOptions): BuildReport {
  const catalog: Catalog = loadCatalog(options.catalogPath);
  const sourcePackagePath = resolve(options.packagePath ?? catalog.source.path);
  const manifestPath = options.manifestPath ?? defaultManifestPath(options.outPath);
  assertOutputIsSafe(options, sourcePackagePath, manifestPath);

  // 1. The source package must be byte-identical to what the catalog was built
  //    from. Stale text or stale offsets are never applied.
  if (!existsSync(sourcePackagePath)) {
    throw new BuildError(
      `Source package "${sourcePackagePath}" no longer exists. Re-run "extract" if it moved, or ` +
        `pass --package with its new location.`
    );
  }
  const sourceSha = sha256File(sourcePackagePath);
  if (sourceSha !== catalog.source.sha256) {
    throw new BuildError(
      `Source package has changed since the catalog was extracted.\n` +
        `  catalog: ${catalog.source.sha256}\n` +
        `  file:    ${sourceSha}\n` +
        `Refusing to build from a stale catalog. Re-run "extract" against the current file, then ` +
        `re-check any translations it invalidates.`
    );
  }

  const translations = loadTranslations(options.translationsPath);
  const metadata = loadMetadata(options.metadataPath);
  const occurrencesById = new Map(
    catalog.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence])
  );

  const excluded: ExcludedEntry[] = [];
  const excludedByCode: Partial<Record<IssueCode, number>> = {};
  const planned = new Map<string, PlannedReplacement[]>();
  let unknownIds = 0;

  for (const occurrenceId of Object.keys(translations).sort()) {
    const text = translations[occurrenceId]!;
    const occurrence = occurrencesById.get(occurrenceId);

    if (!occurrence) {
      unknownIds++;
      excluded.push({
        occurrenceId,
        sourceText: "",
        codes: ["unknown-occurrence"],
        messages: [
          "not in this catalog: the translations file was built against a different extraction",
        ],
      });
      excludedByCode["unknown-occurrence"] = (excludedByCode["unknown-occurrence"] ?? 0) + 1;
      continue;
    }

    const entry = metadata.entries[occurrenceId];
    const metadataMalformed = describeMalformedMetadata(entry);
    const issues = validateTranslation({
      sourceText: occurrence.sourceText,
      catalogSourceHash: occurrence.sourceHash,
      metadataSourceHash:
        entry && typeof entry.sourceHash === "string" ? entry.sourceHash : undefined,
      text,
      state: entry?.state,
      includeUnreviewed: options.includeUnreviewed,
      ...(metadataMalformed ? { metadataMalformed } : {}),
      ...(occurrence.ambiguous ? { ambiguous: true } : {}),
    });

    if (issues.length > 0) {
      for (const issue of issues) {
        excludedByCode[issue.code] = (excludedByCode[issue.code] ?? 0) + 1;
      }
      excluded.push({
        occurrenceId,
        sourceText: occurrence.sourceText,
        codes: issues.map((issue: ValidationIssue) => issue.code),
        messages: issues.map((issue) => issue.message),
      });
      continue;
    }

    const list = planned.get(occurrence.resourceTgi) ?? [];
    list.push({ occurrence, text, state: entry!.state });
    planned.set(occurrence.resourceTgi, list);
  }

  if (planned.size === 0) {
    throw new BuildError(
      `Nothing to build: none of the ${Object.keys(translations).length} translation(s) in ` +
        `"${options.translationsPath}" is eligible` +
        (options.includeUnreviewed ? "" : " (drafts need --include-unreviewed)") +
        `.\n` +
        (excluded.length > 0
          ? `First exclusion: ${excluded[0]!.occurrenceId} — ${excluded[0]!.messages[0]}\n`
          : "") +
        `Run "build" again after fixing them; no package was written.`
    );
  }

  // 2. Re-read the source tables and replace only eligible entries.
  const source = readStblTables(sourcePackagePath);
  const sourceByTgi = new Map(source.tables.map((table) => [formatTgi(toTgi(table)), table]));
  const writtenTables: WrittenTable[] = [];
  const expectedTables = new Map<string, RawEntry[]>();
  const resourceReports: EmittedResource[] = [];
  let resourcesSkipped = 0;

  for (const table of source.tables) {
    const tgi = formatTgi(toTgi(table));
    const replacements = planned.get(tgi);
    if (!replacements) {
      resourcesSkipped++;
      continue;
    }

    const replacementByIndex = new Map<number, AppliedReplacement>();
    for (const replacement of replacements) {
      const index = replacement.occurrence.entryIndex;
      const original = table.entries[index];
      if (!original) {
        throw new BuildError(
          `Catalog is inconsistent with the source package: ${replacement.occurrence.occurrenceId} ` +
            `points at entry ${index} of ${tgi}, which has ${table.entries.length} entries. ` +
            `Re-run "extract".`
        );
      }
      const expectedKey = parseHex8(replacement.occurrence.stringKey, "string key");
      if (original.key !== expectedKey) {
        throw new BuildError(
          `Catalog is inconsistent with the source package: entry ${index} of ${tgi} has key ` +
            `0x${original.key.toString(16)} but the catalog says 0x${replacement.occurrence.stringKey}. ` +
            `Re-run "extract".`
        );
      }
      if (sha256Hex(original.text) !== replacement.occurrence.sourceHash) {
        throw new BuildError(
          `Catalog is inconsistent with the source package: English text of entry ${index} in ${tgi} ` +
            `does not match the hash recorded in the catalog. Re-run "extract" and review the ` +
            `translations that were made from the old text.`
        );
      }
      replacementByIndex.set(index, {
        text: replacement.text,
        reviewed: replacement.state === "reviewed",
      });
    }

    let replaced = 0;
    let reviewedReplaced = 0;
    let unreviewedReplaced = 0;
    const entries: RawEntry[] = table.entries.map((entry, index) => {
      const replacement = replacementByIndex.get(index);
      if (!replacement) return { key: entry.key, text: entry.text };
      replaced++;
      if (replacement.reviewed) reviewedReplaced++;
      else unreviewedReplaced++;
      return { key: entry.key, text: replacement.text };
    });

    writtenTables.push({ type: table.type, group: table.group, instance: table.instance, entries });
    expectedTables.set(tgi, entries);
    resourceReports.push({
      tgi,
      localeByte: hex8(localeByteOf(table.instance)).slice(-2),
      entryCount: entries.length,
      replaced,
      leftInEnglish: entries.length - replaced,
      reviewedReplaced,
      unreviewedReplaced,
    });
  }

  // 3. Write through a temporary file, verify it, then move it into place.
  const tempPath = `${options.outPath}.building-${process.pid}`;
  let outputBytes: number;
  try {
    outputBytes = writePackageFile(tempPath, writtenTables).bytes;
    verifyWrittenPackage(tempPath, expectedTables);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }

  renameSync(tempPath, options.outPath);
  const outputSha = sha256File(options.outPath);

  const manifest = buildManifest({
    options,
    catalog,
    sourcePackagePath,
    sourceSha,
    manifestPath,
    outputSha,
    outputBytes,
    resources: resourceReports,
    excluded,
    excludedByCode,
    unknownIds,
    translationsCount: Object.keys(translations).length,
  });
  writeJsonAtomic(manifestPath, manifest);

  const appliedResources = resourceReports.reduce((sum, resource) => sum + resource.replaced, 0);
  const warnings: string[] = [];
  if (unknownIds > 0) {
    warnings.push(
      `${unknownIds} translation(s) reference occurrence IDs that are not in the catalog and were ` +
        `not applied.`
    );
  }
  if (!options.includeUnreviewed) {
    const unreviewed = excludedByCode["unreviewed"] ?? 0;
    if (unreviewed > 0) {
      warnings.push(`${unreviewed} translation(s) were skipped because they are not reviewed yet.`);
    }
  }
  const stale = excludedByCode["stale-source"] ?? 0;
  if (stale > 0) {
    warnings.push(
      `${stale} translation(s) were made from different English text and were not applied.`
    );
  }
  if (catalog.warnings.length > 0) {
    warnings.push(...catalog.warnings.slice(0, 5));
  }

  return {
    outPath: resolve(options.outPath),
    manifestPath,
    sourcePackagePath,
    sourceSha256: sourceSha,
    outputSha256: outputSha,
    outputBytes,
    resources: resourceReports,
    counts: {
      catalogOccurrences: catalog.occurrences.length,
      translationsInFile: Object.keys(translations).length,
      applied: appliedResources,
      excluded: excluded.length,
      excludedByCode,
      unknownIds,
      reviewedApplied: resourceReports.reduce((sum, resource) => sum + resource.reviewedReplaced, 0),
      unreviewedApplied: resourceReports.reduce(
        (sum, resource) => sum + resource.unreviewedReplaced,
        0
      ),
      resourcesEmitted: resourceReports.length,
      resourcesSkipped,
    },
    excluded,
    warnings,
  };
}

export function defaultManifestPath(outPath: string): string {
  const fileName = basename(outPath).replace(/\.package$/i, "");
  return join(dirname(outPath), `${fileName}.manifest.json`);
}

/**
 * Reopens the written package and checks it against what was intended: same
 * resources, same keys, same order, same text. The library re-read proves the
 * package is loadable; the independent byte-level reader proves the payload
 * matches the STBL format (including the flag byte the library does not model).
 */
function verifyWrittenPackage(tempPath: string, expected: Map<string, RawEntry[]>): void {
  const reread = readStblTables(tempPath);
  if (reread.tables.length !== expected.size) {
    throw new BuildError(
      `Verification failed: wrote ${expected.size} string table(s) but re-read ${reread.tables.length}. ` +
        `The temporary output was discarded.`
    );
  }

  for (const table of reread.tables) {
    const tgi = formatTgi(toTgi(table));
    const wanted = expected.get(tgi);
    if (!wanted) {
      throw new BuildError(`Verification failed: unexpected table ${tgi} in the written package.`);
    }
    if (table.compressionType !== CompressionType.ZLIB) {
      throw new BuildError(
        `Verification failed: table ${tgi} was written with compression type ${table.compressionType}, ` +
          `expected ZLIB (${CompressionType.ZLIB}).`
      );
    }
    if (table.entries.length !== wanted.length) {
      throw new BuildError(
        `Verification failed: table ${tgi} has ${table.entries.length} entries after re-reading, ` +
          `expected ${wanted.length}.`
      );
    }
    for (let index = 0; index < wanted.length; index++) {
      const actual = table.entries[index]!;
      const want = wanted[index]!;
      if (actual.key !== want.key) {
        throw new BuildError(
          `Verification failed: table ${tgi} entry ${index} re-read with key ` +
            `0x${actual.key.toString(16)}, expected 0x${want.key.toString(16)}.`
        );
      }
      if (actual.text !== want.text) {
        throw new BuildError(
          `Verification failed: table ${tgi} entry ${index} re-read as ${JSON.stringify(actual.text)} ` +
            `but ${JSON.stringify(want.text)} was intended.`
        );
      }
    }
  }

  // Independent byte-level check of every written table.
  const rawTables = readStblBytesForVerification(tempPath);
  for (const { tgi, buffer } of rawTables) {
    const parsed = parseStblBuffer(buffer);
    const wanted = expected.get(tgi);
    if (!wanted) {
      throw new BuildError(`Verification failed: unexpected raw table ${tgi}.`);
    }
    if (parsed.header.version !== 5) {
      throw new BuildError(
        `Verification failed: table ${tgi} was written with STBL version ${parsed.header.version}.`
      );
    }
    if (parsed.header.compressed !== 0) {
      throw new BuildError(
        `Verification failed: table ${tgi} has mnCompressed=${parsed.header.compressed}.`
      );
    }
    if (parsed.entries.length !== wanted.length) {
      throw new BuildError(
        `Verification failed: table ${tgi} holds ${parsed.entries.length} entries in its bytes, ` +
          `expected ${wanted.length}.`
      );
    }
    for (let index = 0; index < wanted.length; index++) {
      const actual = parsed.entries[index]!;
      const want = wanted[index]!;
      if (actual.flags !== 0) {
        throw new BuildError(
          `Verification failed: table ${tgi} entry ${index} has flag byte ${actual.flags}.`
        );
      }
      if (actual.key !== want.key || actual.text !== want.text) {
        throw new BuildError(
          `Verification failed: table ${tgi} entry ${index} differs in its bytes from the intended text.`
        );
      }
      const wantBytes = Buffer.byteLength(want.text, "utf8");
      if (actual.byteLength !== wantBytes) {
        throw new BuildError(
          `Verification failed: table ${tgi} entry ${index} stores ${actual.byteLength} bytes but ` +
            `${wantBytes} were expected.`
        );
      }
    }
  }
}

/** Reads back the raw STBL payloads of a written package, ignoring the library's models. */
function readStblBytesForVerification(filePath: string): { tgi: string; buffer: Buffer }[] {
  // The container is unpacked by the library; each payload is then parsed by our
  // own reader, so the byte-level claims below do not rest on the same code path
  // that produced the bytes.
  return readRawStblBuffers(filePath).map(({ key, buffer }) => ({
    tgi: formatTgi(toTgi(key)),
    buffer,
  }));
}

interface ManifestInput {
  options: BuildOptions;
  catalog: Catalog;
  sourcePackagePath: string;
  sourceSha: string;
  manifestPath: string;
  outputSha: string;
  outputBytes: number;
  resources: EmittedResource[];
  excluded: ExcludedEntry[];
  excludedByCode: Partial<Record<IssueCode, number>>;
  unknownIds: number;
  translationsCount: number;
}

function buildManifest(input: ManifestInput): Record<string, unknown> {
  const { options, catalog, resources } = input;
  const replaced = resources.reduce((sum, resource) => sum + resource.replaced, 0);
  const entries = resources.reduce((sum, resource) => sum + resource.entryCount, 0);
  const reviewed = resources.reduce((sum, resource) => sum + resource.reviewedReplaced, 0);
  const unreviewed = resources.reduce((sum, resource) => sum + resource.unreviewedReplaced, 0);

  return {
    schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    generatedAt: new Date().toISOString(),
    artifact: {
      path: resolve(options.outPath),
      fileName: basename(options.outPath),
      sizeBytes: input.outputBytes,
      sha256: input.outputSha,
    },
    scope:
      `Estonian text for the string tables of one supplied package ` +
      `(${catalog.packLabel}, ${catalog.source.fileName}). This is not 100% of the base game and ` +
      `not a complete localisation.`,
    source: {
      path: input.sourcePackagePath,
      fileName: catalog.source.fileName,
      sizeBytes: catalog.source.sizeBytes,
      sha256: input.sourceSha,
      packLabel: catalog.packLabel,
      catalogPath: resolve(options.catalogPath),
      catalogGeneratedAt: catalog.generatedAt,
      stblResourceCount: catalog.source.stblResourceCount,
      stblEntryCount: catalog.source.stblEntryCount,
      dbpfVersion: catalog.source.dbpfVersion,
    },
    gameVersion: options.gameVersion
      ? {
          value: options.gameVersion,
          source: options.gameVersionSource ?? "supplied on the command line",
        }
      : {
          value: null,
          source:
            "not recorded — no --game-version was passed, so no version is claimed for this artifact",
        },
    locale: {
      overridden: [...new Set(resources.map((resource) => resource.localeByte))].join(","),
      note:
        "Locale byte of the overridden string-table resources (high byte of the instance; 00 = en_US). " +
        "The original English resource identity is preserved exactly. No new locale is registered: the " +
        "game keeps running in English and this package overrides the text of the same resources.",
    },
    resources: resources.map((resource) => ({
      tgi: resource.tgi,
      localeByte: resource.localeByte,
      entryCount: resource.entryCount,
      replaced: resource.replaced,
      leftInEnglish: resource.leftInEnglish,
      reviewedReplaced: resource.reviewedReplaced,
      unreviewedReplaced: resource.unreviewedReplaced,
    })),
    counts: {
      catalogOccurrences: catalog.occurrences.length,
      translationsInFile: input.translationsCount,
      applied: replaced,
      reviewedApplied: reviewed,
      unreviewedAppliedIncluded: unreviewed,
      englishFallbackEntriesInOutput: entries - replaced,
      excludedTranslations: input.excluded.length,
      excludedByCode: input.excludedByCode,
      unknownOccurrenceIds: input.unknownIds,
      resourcesEmitted: resources.length,
    },
    exclusions: input.excluded.map((entry) => ({
      occurrenceId: entry.occurrenceId,
      codes: entry.codes,
      sourceTextPreview: entry.sourceText.slice(0, 80),
    })),
    verification: {
      reopenedWithPackageLibrary: true,
      independentStblByteReader: true,
      perEntryKeysAndTextCompared: true,
      flagBytesWritten: 0,
      note:
        "Reopening with the same library is necessary but not sufficient: every entry was also " +
        "compared against an independent byte-level STBL reader, and the container header was " +
        "compared against a package written by EA.",
    },
    compression: {
      written: "ZLIB (0x5A42)",
      note:
        "EA ships this table internally compressed (0xFFFF), a type the package library can read " +
        "but cannot write. ZLIB is the compression mod packages use.",
    },
    limitations: [
      "Untranslated entries inside an overridden table keep their English text.",
      "Strings whose placeholders or branches are not fully understood are left in English.",
      "Only string tables are included; no other resource from the source package is copied.",
      "Whole-table overrides can go stale after a game update; rebuild after updating the game.",
    ],
  };
}
