/**
 * Building a local catalog of every translatable string in one English package.
 *
 * The catalog is the tool's memory of what the game's English text looks like:
 * every occurrence keeps its full resource identity, its string key, its exact
 * text, and a hash of that text. Translations are stored separately and point
 * back here by occurrence ID (see translations.ts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sha256File, sha256Hex } from "./hashing.js";
import {
  ENGLISH_LOCALE_BYTE,
  formatOccurrenceId,
  formatTgi,
  hex8,
  localeByteOf,
  toTgi,
  type Tgi,
} from "./ids.js";
import { readRawStblBuffers, readStblTables, type DbpfHeaderSummary } from "./package-io.js";
import { parseStblBuffer, type StblHeader } from "./stbl-format.js";

export const CATALOG_SCHEMA_VERSION = 1;
export const TOOL_NAME = "sims4-eesti";
export const TOOL_VERSION = "0.1.0";

export interface SourceFacts {
  /** Absolute path as resolved when the catalog was written. */
  path: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  dbpfVersion: string;
  resourceCount: number;
  stblResourceCount: number;
  stblEntryCount: number;
}

export interface CatalogOccurrence {
  occurrenceId: string;
  resourceTgi: string;
  stringKey: string;
  /** Position within its table, used as a cross-check when applying text. */
  entryIndex: number;
  sourceText: string;
  /** SHA-256 of `sourceText`'s UTF-8 bytes. */
  sourceHash: string;
  /** Set when this key appears more than once in its table and cannot be addressed. */
  ambiguous?: true;
}

export interface CatalogResource {
  tgi: string;
  type: string;
  group: string;
  instance: string;
  localeByte: string;
  entryCount: number;
  /** String keys that appear more than once in this table. */
  duplicateKeys: string[];
  stblHeader: StblHeader;
  /** Number of entries whose `mnFlags` byte was non-zero in the source bytes. */
  nonZeroFlagEntries: number;
}

export interface Catalog {
  schemaVersion: number;
  tool: { name: string; version: string };
  generatedAt: string;
  packLabel: string;
  source: SourceFacts;
  resources: CatalogResource[];
  occurrences: CatalogOccurrence[];
  warnings: string[];
}

export interface InputManifest {
  schemaVersion: number;
  tool: { name: string; version: string };
  generatedAt: string;
  packLabel: string;
  source: SourceFacts;
  locale: {
    /** Locale byte observed in the string-table instance (high byte). */
    instanceHighByte: string;
    /** False if any table in the file is not the English (`00`) locale. */
    allTablesEnglish: boolean;
  };
  resources: {
    tgi: string;
    entryCount: number;
    duplicateKeys: string[];
    stblHeader: StblHeader;
    nonZeroFlagEntries: number;
  }[];
  notes: string[];
}

export interface ExtractOptions {
  packagePath: string;
  packLabel: string;
  outDir: string;
}

export interface ExtractResult {
  catalog: Catalog;
  manifest: InputManifest;
  catalogPath: string;
  manifestPath: string;
  warnings: string[];
}

export interface SearchOptions {
  text: string;
  caseSensitive?: boolean;
  exact?: boolean;
  limit?: number;
}

export function loadCatalog(catalogPath: string): Catalog {
  const parsed = JSON.parse(readTextFile(catalogPath)) as Catalog;
  if (parsed.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `Catalog "${catalogPath}" has schema version ${parsed.schemaVersion}; this build of the tool ` +
        `writes version ${CATALOG_SCHEMA_VERSION}. Re-run "extract".`
    );
  }
  if (!Array.isArray(parsed.occurrences) || !Array.isArray(parsed.resources)) {
    throw new Error(`Catalog "${catalogPath}" is missing its resource or occurrence list.`);
  }
  return parsed;
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`No such file: "${path}"`);
    throw new Error(`Could not read "${path}": ${(error as Error).message}`);
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    // Never leave a half-written temp file next to the real one.
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function fileSize(path: string): number {
  return statSync(path).size;
}

/**
 * Reads one English package into a catalog plus an input manifest.
 *
 * Only string tables are extracted; textures, tuning, audio and every other
 * resource in the package are ignored.
 */
export function extractCatalog(options: ExtractOptions): ExtractResult {
  const packagePath = resolve(options.packagePath);
  if (!existsSync(packagePath)) {
    throw new Error(`No such package: "${packagePath}"`);
  }
  if (!statSync(packagePath).isFile()) {
    throw new Error(`"${packagePath}" is not a file.`);
  }
  if (!options.packLabel || /[|\s]/.test(options.packLabel)) {
    throw new Error(
      `Pack label "${options.packLabel}" is invalid: use a short label without spaces or "|".`
    );
  }

  const generatedAt = new Date().toISOString();
  const sha256 = sha256File(packagePath);
  const read = readStblTables(packagePath);

  // Independent byte-level pass: confirms the entry flags and headers the
  // library does not model, using our own minimal STBL reader. Buffers are kept
  // in order per TGI so that a package holding the same resource twice still
  // verifies each copy against its own bytes.
  const rawBuffers = readRawStblBuffers(packagePath);
  const rawByTgi = new Map<string, Buffer[]>();
  for (const raw of rawBuffers) {
    const tgiText = formatTgi(toTgi(raw.key));
    const list = rawByTgi.get(tgiText) ?? [];
    list.push(raw.buffer);
    rawByTgi.set(tgiText, list);
  }
  const rawConsumed = new Map<string, number>();

  const warnings: string[] = [];
  const resources: CatalogResource[] = [];
  const occurrences: CatalogOccurrence[] = [];
  let nonZeroFlagsTotal = 0;
  let allTablesEnglish = true;

  // Count tables per TGI up front: when a package holds the same resource twice,
  // *every* string in it is unaddressable, including the ones in the first copy
  // (which is the one a lookup would otherwise find).
  const tgiCounts = new Map<string, number>();
  for (const table of read.tables) {
    const tgiText = formatTgi(toTgi(table));
    tgiCounts.set(tgiText, (tgiCounts.get(tgiText) ?? 0) + 1);
  }
  const duplicatedTgis = new Set(
    [...tgiCounts].filter(([, count]) => count > 1).map(([tgiText]) => tgiText)
  );

  for (const table of read.tables) {
    const tgi = toTgi(table);
    const tgiText = formatTgi(tgi);
    const localeByte = localeByteOf(table.instance);
    if (localeByte !== ENGLISH_LOCALE_BYTE) {
      allTablesEnglish = false;
      warnings.push(
        `Table ${tgiText} has locale byte ${hex8(localeByte).slice(-2)}, not the English 00 — it is ` +
          `preserved as-is, not treated as English.`
      );
    }

    const rawIndex = rawConsumed.get(tgiText) ?? 0;
    rawConsumed.set(tgiText, rawIndex + 1);
    const rawBuffer = rawByTgi.get(tgiText)?.[rawIndex];
    if (!rawBuffer) {
      throw new Error(
        `Internal error: byte-level reader did not return a buffer for ${tgiText} ` +
          `(copy ${rawIndex + 1}). Refusing to continue with an unverified table.`
      );
    }
    const parsed = parseStblBuffer(rawBuffer);
    if (parsed.entries.length !== table.entries.length) {
      throw new Error(
        `Internal error: ${tgiText} has ${table.entries.length} entries in the package model but ` +
          `${parsed.entries.length} in the raw bytes. Refusing to continue.`
      );
    }

    let nonZeroFlags = 0;
    for (const entry of parsed.entries) {
      if (entry.flags !== 0) nonZeroFlags++;
    }
    nonZeroFlagsTotal += nonZeroFlags;

    const duplicateKeys: string[] = [];
    const keyCounts = new Map<number, number>();
    for (const entry of table.entries) {
      keyCounts.set(entry.key, (keyCounts.get(entry.key) ?? 0) + 1);
    }
    for (const [key, count] of keyCounts) {
      if (count > 1) duplicateKeys.push(hex8(key));
    }
    duplicateKeys.sort();

    const isDuplicateTgi = duplicatedTgis.has(tgiText);
    if (isDuplicateTgi) {
      warnings.push(
        `Table ${tgiText} appears ${tgiCounts.get(tgiText)} times in this package; every string in it ` +
          `is excluded because a translation cannot be addressed to one of the copies.`
      );
    }

    if (duplicateKeys.length > 0) {
      warnings.push(
        `Table ${tgiText} contains ${duplicateKeys.length} string key(s) used by more than one entry ` +
          `(${duplicateKeys.slice(0, 5).join(", ")}${duplicateKeys.length > 5 ? ", …" : ""}); ` +
          `those strings are excluded because a translation cannot be addressed to one entry.`
      );
    }
    if (nonZeroFlags > 0) {
      warnings.push(
        `Table ${tgiText} has ${nonZeroFlags} entry flag byte(s) set. The package library does not ` +
          `model that byte and writes zeros, so those flags are not preserved.`
      );
    }

    resources.push({
      tgi: tgiText,
      type: tgi.type,
      group: tgi.group,
      instance: tgi.instance,
      localeByte: hex8(localeByte).slice(-2),
      entryCount: table.entries.length,
      duplicateKeys,
      stblHeader: parsed.header,
      nonZeroFlagEntries: nonZeroFlags,
    });

    table.entries.forEach((entry, entryIndex) => {
      const stringKey = hex8(entry.key);
      const ambiguous = (keyCounts.get(entry.key) ?? 0) > 1 || isDuplicateTgi;
      occurrences.push({
        occurrenceId: formatOccurrenceId(options.packLabel, tgi, stringKey),
        resourceTgi: tgiText,
        stringKey,
        entryIndex,
        sourceText: entry.text,
        sourceHash: sha256Hex(entry.text),
        ...(ambiguous ? { ambiguous: true as const } : {}),
      });
    });
  }

  const source: SourceFacts = {
    path: packagePath,
    fileName: basename(packagePath),
    sizeBytes: statSync(packagePath).size,
    sha256,
    dbpfVersion: read.header.version,
    resourceCount: read.resourceCount,
    stblResourceCount: read.tables.length,
    stblEntryCount: occurrences.length,
  };

  const catalog: Catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    generatedAt,
    packLabel: options.packLabel,
    source,
    resources,
    occurrences,
    warnings,
  };

  const manifest: InputManifest = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    generatedAt,
    packLabel: options.packLabel,
    source,
    locale: {
      instanceHighByte: resources[0]?.localeByte ?? "00",
      allTablesEnglish,
    },
    resources: resources.map((resource) => ({
      tgi: resource.tgi,
      entryCount: resource.entryCount,
      duplicateKeys: resource.duplicateKeys,
      stblHeader: resource.stblHeader,
      nonZeroFlagEntries: resource.nonZeroFlagEntries,
    })),
    notes: [
      "Only string tables (type 220557DA) were read; no other resource in this package was touched.",
      `The source package was not modified. Fingerprint: sha256:${source.sha256}`,
      `Entry flag bytes: ${nonZeroFlagsTotal} non-zero out of ${occurrences.length} entries. This tool's ` +
        `package library reads and writes that byte as 0.`,
      "This catalog covers the one supplied package, not the whole game.",
    ],
  };

  mkdirSync(options.outDir, { recursive: true });
  const catalogPath = join(options.outDir, "catalog.json");
  const manifestPath = join(options.outDir, "input.manifest.json");
  writeJsonAtomic(catalogPath, catalog);
  writeJsonAtomic(manifestPath, manifest);

  return { catalog, manifest, catalogPath, manifestPath, warnings };
}

export interface SearchHit {
  occurrence: CatalogOccurrence;
  resource: CatalogResource | undefined;
}

export function searchCatalog(catalog: Catalog, options: SearchOptions): SearchHit[] {
  const limit = options.limit ?? 50;
  const needle = options.caseSensitive ? options.text : options.text.toLowerCase();
  const resourcesByTgi = new Map(catalog.resources.map((resource) => [resource.tgi, resource]));

  const hits: SearchHit[] = [];
  for (const occurrence of catalog.occurrences) {
    const haystack = options.caseSensitive ? occurrence.sourceText : occurrence.sourceText.toLowerCase();
    const matches = options.exact ? haystack === needle : haystack.includes(needle);
    if (!matches) continue;
    hits.push({ occurrence, resource: resourcesByTgi.get(occurrence.resourceTgi) });
    if (hits.length >= limit) break;
  }
  return hits;
}

export function findOccurrence(catalog: Catalog, occurrenceId: string): CatalogOccurrence | undefined {
  return catalog.occurrences.find((occurrence) => occurrence.occurrenceId === occurrenceId);
}

export function findResource(catalog: Catalog, tgi: string): CatalogResource | undefined {
  return catalog.resources.find((resource) => resource.tgi === tgi);
}

export type { Tgi };
