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
  type CatalogResource,
  type SourceFacts,
} from "./catalog.js";
import { sha256Hex, sha256File } from "./hashing.js";
import {
  allLocaleCodes,
  formatTgi,
  hex8,
  localeByteFromCode,
  localeByteOf,
  parseHex8,
  toTgi,
} from "./ids.js";
import {
  readRawStblBuffers,
  readStblTables,
  writePackageFile,
  type RawEntry,
  type RawTable,
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
  /**
   * Base-game languages to carry the translated tables for, as locale codes
   * (`fi`) or bytes (`0x06`); `all` means every locale the game ships. Each
   * copy is identical except for the locale byte in its instance, so the game
   * loads the Estonian text whichever supported language it runs in. Defaults
   * to the source table's own locale (English).
   */
  targetLocales?: string[];
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
  /** Every package the artifact drew on, with the fingerprint it was verified against. */
  sourcePackages: { label: string; path: string; sha256: string }[];
  /** Set only for single-package catalogs. */
  sourceSha256: string | null;
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
    /** Translations skipped because a first-named package already owns that table ID. */
    shadowedDuplicateTranslations: number;
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

/** Expands `--locales` into the distinct locale bytes to emit, or null for "source only". */
function parseTargetLocales(requested: string[] | undefined): number[] | null {
  if (!requested || requested.length === 0) return null;
  const bytes = new Set<number>();
  for (const item of requested) {
    for (const part of item.split(",")) {
      const text = part.trim();
      if (!text) continue;
      if (text.toLowerCase() === "all") {
        for (const locale of allLocaleCodes()) bytes.add(locale.byte);
      } else {
        try {
          bytes.add(localeByteFromCode(text));
        } catch (error) {
          throw new BuildError((error as Error).message);
        }
      }
    }
  }
  if (bytes.size === 0) {
    throw new BuildError(`--locales was given no locale codes.`);
  }
  return [...bytes].sort((a, b) => a - b);
}

/** Replaces the locale byte (high byte) of a string-table instance. */
function withLocaleByte(instance: bigint, localeByte: number): bigint {
  return (instance & 0x00ffffffffffffffn) | (BigInt(localeByte) << 56n);
}

/**
 * The game loads the first-named package for a conflicting resource
 * (probes/precedence, observed twice on 2026-10-16). When two packages ship the
 * same table ID, only the first-named one is addressable; the other is shadowed.
 */
function packageOrderKey(packagePath: string): string {
  return basename(packagePath).toLowerCase();
}

export function buildPackage(options: BuildOptions): BuildReport {
  const catalog: Catalog = loadCatalog(options.catalogPath);
  const manifestPath = options.manifestPath ?? defaultManifestPath(options.outPath);
  const targetLocaleBytes = parseTargetLocales(options.targetLocales);

  // A resource ID is not guaranteed to be unique across mod packages. Group the
  // catalog's resources and keep the one the game would actually load.
  const resourcesByTgi = new Map<string, CatalogResource[]>();
  for (const resource of catalog.resources) {
    const list = resourcesByTgi.get(resource.tgi) ?? [];
    list.push(resource);
    resourcesByTgi.set(resource.tgi, list);
  }
  const winnerByTgi = new Map<string, CatalogResource>();
  for (const [tgi, list] of resourcesByTgi) {
    const winner = [...list].sort((a, b) =>
      packageOrderKey(a.packagePath).localeCompare(packageOrderKey(b.packagePath), "en")
    )[0]!;
    winnerByTgi.set(tgi, winner);
  }

  // A catalog may draw on many packages (Phase 2's install-wide scan). Sources are
  // therefore resolved per package, and the single-package `--package` override is
  // only meaningful when the catalog has exactly one.
  const resolveSourcePath = (facts: { path: string }): string => {
    if (!options.packagePath) return resolve(facts.path);
    if (catalog.packages.length > 1) {
      throw new BuildError(
        `--package cannot be used with a catalog covering ${catalog.packages.length} packages; ` +
          `it names one. Re-run "extract" or "scan" against the current files instead.`
      );
    }
    return resolve(options.packagePath);
  };
  const firstSourcePath = resolveSourcePath(catalog.packages[0]!);
  assertOutputIsSafe(options, firstSourcePath, manifestPath);

  // 1. Every source package must be byte-identical to what the catalog was built
  //    from. Stale text or stale offsets are never applied.
  const verified = new Map<string, SourceFacts>();
  for (const facts of catalog.packages) {
    const path = resolveSourcePath(facts);
    if (!existsSync(path)) {
      throw new BuildError(
        `Source package "${path}" no longer exists. Re-run "extract"/"scan" if it moved, or pass ` +
          `--package with its new location (single-package catalogs only).`
      );
    }
    const actual = sha256File(path);
    if (actual !== facts.sha256) {
      throw new BuildError(
        `Source package "${facts.label}" has changed since the catalog was written.\n` +
          `  catalog: ${facts.sha256}\n` +
          `  file:    ${actual}  (${path})\n` +
          `Refusing to build from a stale catalog. Re-run "extract"/"scan" against the current ` +
          `files, then re-check any translations it invalidates.`
      );
    }
    verified.set(facts.label, { ...facts, path });
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
  let shadowedDuplicates = 0;

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

    const winner = winnerByTgi.get(occurrence.resourceTgi);
    if (winner && occurrence.packageLabel !== winner.packageLabel) {
      // Another, first-named package owns this table ID; the game never loads
      // this copy, so applying its translation would target the wrong table.
      shadowedDuplicates += 1;
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

  // 2. Re-read the source tables - from whichever package each resource lives in -
  //    and replace only eligible entries.
  const resourceByTgi = new Map<string, CatalogResource>(
    [...winnerByTgi.entries()].map(([tgi, resource]) => [tgi, resource])
  );
  const tablesByTgi = new Map<string, { table: RawTable; label: string }>();
  const packagesRead = new Set<string>();
  for (const tgi of planned.keys()) {
    const resource = resourceByTgi.get(tgi);
    if (!resource) {
      throw new BuildError(`Catalog inconsistency: ${tgi} has translations but no resource entry.`);
    }
    const facts = verified.get(resource.packageLabel);
    if (!facts) {
      throw new BuildError(
        `Catalog inconsistency: ${tgi} names package "${resource.packageLabel}", which the catalog ` +
          `does not list.`
      );
    }
    if (packagesRead.has(facts.label)) continue;
    packagesRead.add(facts.label);
    for (const table of readStblTables(facts.path).tables) {
      const tgi = formatTgi(toTgi(table));
      const existing = tablesByTgi.get(tgi);
      if (!existing || winnerByTgi.get(tgi)?.packageLabel === facts.label) {
        tablesByTgi.set(tgi, { table, label: facts.label });
      }
    }
  }

  const affectedTgis = [...planned.keys()].sort();
  const writtenTables: WrittenTable[] = [];
  const expectedTables = new Map<string, RawEntry[]>();
  const resourceReports: EmittedResource[] = [];
  let resourcesSkipped = catalog.resources.length - affectedTgis.length;
  let appliedTranslations = 0;
  let reviewedApplied = 0;
  for (const list of planned.values()) {
    for (const replacement of list) {
      appliedTranslations += 1;
      if (replacement.state === "reviewed") reviewedApplied += 1;
    }
  }
  let uniqueEntryCount = 0;

  for (const tgi of affectedTgis) {
    const found = tablesByTgi.get(tgi);
    if (!found) {
      throw new BuildError(
        `Catalog says ${tgi} exists, but re-reading its source package did not find it. ` +
          `Re-run "extract"/"scan".`
      );
    }
    const { table, label: sourceLabel } = found;
    const replacements = planned.get(tgi)!;

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
    const entries: RawEntry[] = table.entries.map((entry: RawEntry, index: number) => {
      const replacement = replacementByIndex.get(index);
      if (!replacement) return { key: entry.key, text: entry.text };
      replaced++;
      if (replacement.reviewed) reviewedReplaced++;
      else unreviewedReplaced++;
      return { key: entry.key, text: replacement.text };
    });

    uniqueEntryCount += entries.length;
    // One copy per requested base-game locale. The entries are identical; only
    // the locale byte in the instance differs, which is what makes the game load
    // the copy that matches the language it is running in.
    const localeBytes = targetLocaleBytes ?? [localeByteOf(table.instance)];
    for (const localeByte of localeBytes) {
      const instance = withLocaleByte(table.instance, localeByte);
      const variantTgi = formatTgi(toTgi({ type: table.type, group: table.group, instance }));
      writtenTables.push({ type: table.type, group: table.group, instance, entries });
      expectedTables.set(variantTgi, entries);
      resourceReports.push({
        tgi: variantTgi,
        localeByte: hex8(localeByte).slice(-2),
        entryCount: entries.length,
        replaced,
        leftInEnglish: entries.length - replaced,
        reviewedReplaced,
        unreviewedReplaced,
      });
    }
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
    sourcePackages: [...verified.values()],
    manifestPath,
    outputSha,
    outputBytes,
    resources: resourceReports,
    excluded,
    excludedByCode,
    unknownIds,
    translationsCount: Object.keys(translations).length,
    appliedTranslations,
    reviewedApplied,
    uniqueEntryCount,
    shadowedDuplicates,
  });
  writeJsonAtomic(manifestPath, manifest);

  const warnings: string[] = [];
  if (targetLocaleBytes && options.targetLocales && targetLocaleBytes.length > 0) {
    const sourceLocales = new Set(resourceReports.map((resource) => resource.localeByte));
    const sourceLocaleBytes = new Set(
      [...tablesByTgi.values()].map(({ table }) => hex8(localeByteOf(table.instance)).slice(-2))
    );
    for (const sourceLocale of sourceLocaleBytes) {
      if (!sourceLocales.has(sourceLocale)) {
        warnings.push(
          `--locales does not include the source table's locale (${sourceLocale}); the package will ` +
            `not override that language.`
        );
      }
    }
  }
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
  if (shadowedDuplicates > 0) {
    warnings.push(
      `${shadowedDuplicates} translation(s) belong to a package that ships the same table ID as a ` +
        `first-named package. The game loads the first-named copy, so those translations were not ` +
        `applied; the winning package's copy is the one emitted.`
    );
  }
  if (catalog.warnings.length > 0) {
    warnings.push(...catalog.warnings.slice(0, 5));
  }

  return {
    outPath: resolve(options.outPath),
    manifestPath,
    sourcePackages: [...verified.values()].map((facts) => ({ label: facts.label, path: facts.path, sha256: facts.sha256 })),
    sourceSha256: catalog.packages.length === 1 ? catalog.packages[0]!.sha256 : null,
    outputSha256: outputSha,
    outputBytes,
    resources: resourceReports,
    counts: {
      catalogOccurrences: catalog.occurrences.length,
      translationsInFile: Object.keys(translations).length,
      applied: appliedTranslations,
      excluded: excluded.length,
      excludedByCode,
      unknownIds,
      reviewedApplied,
      unreviewedApplied: appliedTranslations - reviewedApplied,
      resourcesEmitted: resourceReports.length,
      resourcesSkipped,
      shadowedDuplicateTranslations: shadowedDuplicates,
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
  sourcePackages: SourceFacts[];
  manifestPath: string;
  outputSha: string;
  outputBytes: number;
  resources: EmittedResource[];
  excluded: ExcludedEntry[];
  excludedByCode: Partial<Record<IssueCode, number>>;
  unknownIds: number;
  translationsCount: number;
  /** Logical translations applied once, even when a table is emitted for several locales. */
  appliedTranslations: number;
  reviewedApplied: number;
  /** Entries across the distinct source tables, not across their locale copies. */
  uniqueEntryCount: number;
  /** Translations ignored because a first-named package owns the same table ID. */
  shadowedDuplicates: number;
}

function buildManifest(input: ManifestInput): Record<string, unknown> {
  const { options, catalog, resources } = input;
  const replaced = input.appliedTranslations;
  const entries = input.uniqueEntryCount;
  const reviewed = input.reviewedApplied;
  const unreviewed = replaced - reviewed;

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
      `Estonian text for the string tables of the supplied package(s) ` +
      `(${input.sourcePackages.map((facts) => facts.label).join(", ")}). This is not 100% of the ` +
      `base game and not a complete localisation of the game.`,
    sources: input.sourcePackages.map((facts) => ({
      label: facts.label,
      path: facts.path,
      fileName: facts.fileName,
      sizeBytes: facts.sizeBytes,
      sha256: facts.sha256,
      stblResourceCount: facts.stblResourceCount,
      stblEntryCount: facts.stblEntryCount,
      dbpfVersion: facts.dbpfVersion,
    })),
    source: {
      // Kept for readers of earlier manifests; the full list is `sources`.
      path: input.sourcePackages.length === 1 ? input.sourcePackages[0]!.path : null,
      fileName: input.sourcePackages.length === 1 ? input.sourcePackages[0]!.fileName : null,
      sha256: input.sourcePackages.length === 1 ? input.sourcePackages[0]!.sha256 : null,
      packLabel: catalog.packLabel,
      catalogPath: resolve(options.catalogPath),
      catalogGeneratedAt: catalog.generatedAt,
      packageCount: input.sourcePackages.length,
      stblResourceCount: catalog.packages.reduce((sum, facts) => sum + facts.stblResourceCount, 0),
      stblEntryCount: catalog.packages.reduce((sum, facts) => sum + facts.stblEntryCount, 0),
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
      overridden: [...new Set(resources.map((resource) => resource.localeByte))].sort().join(","),
      note:
        "Each translated string table is emitted once per requested base-game locale; the locale is the " +
        "high byte of the resource instance (00 = en_US, 06 = fi_FI). The instance base and every entry " +
        "are identical between copies. The game loads the copy whose locale byte matches the language " +
        "it is running in and is not otherwise modified. This package does not add a language to the " +
        "game's language menu; with --locales omitted, only the source table's own locale is emitted.",
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
      shadowedDuplicateTranslations: input.shadowedDuplicates,
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
