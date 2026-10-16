/**
 * Installation-wide discovery: find every string table the player has installed
 * and write one catalog covering all of them.
 *
 * How files are chosen (measured, not guessed — see IMPLEMENTATION_NOTES.md):
 * every string table in a Sims 4 installation lives in a file whose name contains
 * "Strings"; an index-only scan of all 647 packages found no others, and no
 * package over 50 MiB carries one. So the scan reads files that look like string
 * tables, skips large ones with a reason recorded, and leaves `Delta` (SDX) alone
 * until resource precedence is settled - reported, never silently dropped.
 *
 * The reading itself is done entirely by `@s4tk/models`; this module writes no
 * DBPF parsing of its own.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  CATALOG_SCHEMA_VERSION,
  TOOL_NAME,
  TOOL_VERSION,
  writeJsonAtomic,
  type Catalog,
  type CatalogOccurrence,
  type CatalogResource,
  type SourceFacts,
} from "./catalog.js";
import { sha256File, sha256Hex } from "./hashing.js";
import { ENGLISH_LOCALE_BYTE, formatOccurrenceId, formatTgi, hex8, localeByteOf, toTgi } from "./ids.js";
import { readRawStblBuffers, readStblTables, PackageReadError, type RawEntry } from "./package-io.js";
import { parseStblBuffer } from "./stbl-format.js";

export const INSTALL_INDEX_SCHEMA_VERSION = 1;
export const DEFAULT_LARGE_FILE_BYTES = 50 * 1024 * 1024;

export type Disposition =
  | "read"
  | "skipped-large"
  | "excluded-delta"
  | "no-string-tables"
  | "no-english-tables"
  | "unreadable";

export interface ScannedPackage {
  /** Path relative to the game root, with forward slashes. */
  path: string;
  label: string;
  sizeBytes: number;
  sha256: string | null;
  disposition: Disposition;
  note?: string;
  tableCount: number;
  entryCount: number;
}

export interface InstallIndex {
  schemaVersion: number;
  tool: { name: string; version: string };
  generatedAt: string;
  gameRoot: string;
  packages: ScannedPackage[];
  totals: {
    packagesFound: number;
    packagesRead: number;
    tables: number;
    entries: number;
    byDisposition: Partial<Record<Disposition, number>>;
    /** Tables holding a language other than English; not read, by design. */
    nonEnglishTablesSkipped: number;
  };
  notes: string[];
}

export interface ScanOptions {
  gameRoot: string;
  outDir: string;
  /** Files at least this large are skipped unless their name looks like strings. */
  largeFileBytes?: number;
  /** Read `Delta` (SDX) files too. Off by default: precedence is unsettled. */
  includeDelta?: boolean;
  /**
   * Read non-English tables too. Off by default, and deliberately: a mod ships
   * the same text once per locale (WickedWhims: 6,354 strings in each of 22
   * locales = 139,788 entries, of which only the English ones are relevant to a
   * game running in English).
   */
  includeNonEnglish?: boolean;
  /** Print progress lines (used by the CLI; silent in tests). */
  onProgress?: (message: string) => void;
}

export interface ScanResult {
  index: InstallIndex;
  catalog: Catalog;
  indexPath: string;
  catalogPath: string;
}

const STRINGS_NAME = /strings/i;
const MAX_DEPTH = 4;

/** Walks the game root, shallow and bounded, collecting packages. */
export function findPackages(gameRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.toLowerCase().endsWith(".package")) {
        found.push(full);
      }
    }
  };
  walk(gameRoot, 0);
  return found.sort();
}

/**
 * A stable, human-readable label for a package, used in occurrence IDs. Changing
 * a label changes every occurrence ID inside it, so these are kept simple and
 * derived only from the path: `BASE` for the base game's strings, the pack folder
 * name for a pack, otherwise the file stem.
 */
export function labelFor(gameRoot: string, filePath: string, allFiles: string[]): string {
  const rel = relative(gameRoot, filePath).split(sep).join("/");
  const parts = rel.split("/");
  const fileStem = sanitiseLabel(basename(filePath).replace(/\.package$/i, ""));

  // The base game's own strings file is always BASE, whatever else lives beside it.
  if (parts.length === 3 && parts[0] === "Data" && parts[1] === "Client" && STRINGS_NAME.test(basename(filePath))) {
    return "BASE";
  }
  if (parts.length === 2 && STRINGS_NAME.test(basename(filePath))) {
    return sanitiseLabel(parts[0]!);
  }
  // Anything else is labelled by its own name, qualified by its folder when
  // another file would otherwise claim the same label. Labels only ever get
  // assigned to packages that actually contribute strings, so collisions here
  // mean two contributing files in one folder, not a strings file losing its
  // name to a thumbnail archive.
  const candidates = allFiles.filter(
    (other) => sanitiseLabel(basename(other).replace(/\.package$/i, "")) === fileStem
  );
  if (candidates.length > 1 && parts.length > 1) {
    return sanitiseLabel(`${parts.slice(0, -1).join("_")}_${fileStem}`).slice(0, 40);
  }
  return fileStem.slice(0, 40);
}

function sanitiseLabel(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "PKG";
}

export function isDeltaPath(gameRoot: string, filePath: string): boolean {
  const rel = relative(gameRoot, filePath).split(sep).join("/");
  return rel.startsWith("Delta/");
}

export function scanInstallation(options: ScanOptions): ScanResult {
  const gameRoot = resolve(options.gameRoot);
  if (!existsSync(gameRoot)) {
    throw new Error(`No such game root: "${gameRoot}"`);
  }
  // The size heuristic is only true of a game installation, where every string
  // table sits in a file named *Strings* and nothing large carries one. A Mods
  // folder is the opposite: the big packages are exactly the ones with text
  // (WickedWhims is 136 MiB and holds 6,354 English strings). So the rule applies
  // only when the root looks like an installation, and `--large-file-mb 0`
  // disables it anywhere.
  const looksLikeGameInstall = existsSync(join(gameRoot, "Data", "Client"));
  const largeFileBytes =
    options.largeFileBytes ?? (looksLikeGameInstall ? DEFAULT_LARGE_FILE_BYTES : 0);
  const progress = options.onProgress ?? (() => {});
  const generatedAt = new Date().toISOString();

  const files = findPackages(gameRoot);
  progress(`found ${files.length} package(s) under ${gameRoot}`);

  // Two phases on purpose. Labels end up inside occurrence IDs ("BASE|TGI|KEY"),
  // so a label must never depend on which file happened to be visited first: a
  // thumbnail archive claiming "SP06" would rename every string in the pack's real
  // strings file and orphan every existing translation. Phase one therefore reads
  // and classifies, phase two assigns labels to the packages that actually
  // contributed, in path order.
  type ReadTables = ReturnType<typeof readStblTables>["tables"];
  interface Candidate {
    filePath: string;
    rel: string;
    sizeBytes: number;
    read: ReturnType<typeof readStblTables>;
    tables: ReadTables;
    rawByTgi: Map<string, Buffer[]>;
    skippedNonEnglish: number;
  }

  const packages: ScannedPackage[] = [];
  const resources: CatalogResource[] = [];
  const occurrences: CatalogOccurrence[] = [];
  const sourceFacts: SourceFacts[] = [];
  const candidates: Candidate[] = [];
  const seenLabels = new Set<string>();
  let nonEnglishSkipped = 0;
  let noEnglishOnly = 0;

  for (const filePath of files) {
    const rel = relative(gameRoot, filePath).split(sep).join("/");
    const sizeBytes = statSync(filePath).size;
    const record = (disposition: Disposition, note?: string): void => {
      packages.push({
        path: rel,
        label: labelFor(gameRoot, filePath, files),
        sizeBytes,
        sha256: null,
        disposition,
        ...(note ? { note } : {}),
        tableCount: 0,
        entryCount: 0,
      });
    };

    if (isDeltaPath(gameRoot, filePath) && !options.includeDelta) {
      record("excluded-delta", "Delta (SDX) content: precedence is not established, so it is not read");
      continue;
    }
    const looksLikeStrings = STRINGS_NAME.test(basename(filePath));
    if (largeFileBytes > 0 && sizeBytes >= largeFileBytes && !looksLikeStrings) {
      record(
        "skipped-large",
        `${(sizeBytes / 1024 / 1024).toFixed(0)} MiB and not named like a string file; ` +
          `measured: no package this size holds a string table in a game installation. ` +
          `Pass --large-file-mb 0 to read it anyway (mods folders need this).`
      );
      continue;
    }

    let read;
    try {
      read = readStblTables(filePath);
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof PackageReadError && /no string tables/.test(message)) {
        record("no-string-tables", "read successfully; contains no string tables");
      } else {
        record("unreadable", message);
      }
      continue;
    }

    const rawByTgi = new Map<string, Buffer[]>();
    for (const raw of readRawStblBuffers(filePath)) {
      const key = formatTgi(toTgi(raw.key));
      rawByTgi.set(key, [...(rawByTgi.get(key) ?? []), raw.buffer]);
    }

    const tables = options.includeNonEnglish
      ? read.tables
      : read.tables.filter((table) => localeByteOf(table.instance) === 0);
    const skippedNonEnglish = read.tables.length - tables.length;
    nonEnglishSkipped += skippedNonEnglish;

    if (tables.length === 0) {
      noEnglishOnly += 1;
      record("no-english-tables", `${read.tables.length} table(s), none in English; nothing to translate`);
      continue;
    }

    candidates.push({ filePath, rel, sizeBytes, read, tables, rawByTgi, skippedNonEnglish });
  }

  // Phase two: labels, then resources and occurrences.
  candidates.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const candidate of candidates) {
    const { filePath, rel, sizeBytes, read, tables, rawByTgi, skippedNonEnglish } = candidate;
    let label = labelFor(gameRoot, filePath, files);
    let uniqueLabel = label;
    let suffix = 2;
    while (seenLabels.has(uniqueLabel)) uniqueLabel = `${label}_${suffix++}`;
    if (uniqueLabel !== label) {
      progress(`  two contributing files would both be "${label}"; using "${uniqueLabel}" for ${rel}`);
    }
    seenLabels.add(uniqueLabel);

    const tgiCounts = new Map<string, number>();
    for (const table of tables) {
      const tgiText = formatTgi(toTgi(table));
      tgiCounts.set(tgiText, (tgiCounts.get(tgiText) ?? 0) + 1);
    }
    const duplicated = new Set(
      [...tgiCounts].filter(([, count]) => count > 1).map(([tgiText]) => tgiText)
    );

    let packageEntries = 0;
    const consumed = new Map<string, number>();
    for (const table of tables) {
      const tgi = toTgi(table);
      const tgiText = formatTgi(tgi);
      const index = consumed.get(tgiText) ?? 0;
      consumed.set(tgiText, index + 1);
      const buffer = rawByTgi.get(tgiText)?.[index];
      if (!buffer) throw new Error(`Internal error: no raw buffer for ${tgiText} in ${rel}`);
      const parsed = parseStblBuffer(buffer);
      let nonZeroFlags = 0;
      for (const entry of parsed.entries) if (entry.flags !== 0) nonZeroFlags++;

      const keyCounts = new Map<number, number>();
      for (const entry of table.entries) keyCounts.set(entry.key, (keyCounts.get(entry.key) ?? 0) + 1);
      const duplicateKeys = [...keyCounts]
        .filter(([, count]) => count > 1)
        .map(([key]) => hex8(key))
        .sort();

      resources.push({
        tgi: tgiText,
        type: tgi.type,
        group: tgi.group,
        instance: tgi.instance,
        localeByte: hex8(localeByteOf(table.instance)).slice(-2),
        packageLabel: uniqueLabel,
        packagePath: rel,
        entryCount: table.entries.length,
        duplicateKeys,
        stblHeader: parsed.header,
        nonZeroFlagEntries: nonZeroFlags,
      });

      const isDuplicateTgi = duplicated.has(tgiText);
      table.entries.forEach((entry: RawEntry, entryIndex: number) => {
        const stringKey = hex8(entry.key);
        const ambiguous = (keyCounts.get(entry.key) ?? 0) > 1 || isDuplicateTgi;
        occurrences.push({
          occurrenceId: formatOccurrenceId(uniqueLabel, tgi, stringKey),
          resourceTgi: tgiText,
          packageLabel: uniqueLabel,
          stringKey,
          entryIndex,
          sourceText: entry.text,
          sourceHash: sha256Hex(entry.text),
          ...(ambiguous ? { ambiguous: true as const } : {}),
        });
      });
      packageEntries += table.entries.length;
    }

    const sha256 = sha256File(filePath);
    sourceFacts.push({
      label: uniqueLabel,
      path: filePath,
      fileName: basename(filePath),
      sizeBytes,
      sha256,
      dbpfVersion: read.header.version,
      resourceCount: read.resourceCount,
      stblResourceCount: read.tables.length,
      stblEntryCount: packageEntries,
    });
    packages.push({
      path: rel,
      label: uniqueLabel,
      sizeBytes,
      sha256,
      disposition: "read",
      ...(skippedNonEnglish > 0 ? { note: `${skippedNonEnglish} non-English table(s) not read` } : {}),
      tableCount: tables.length,
      entryCount: packageEntries,
    });
    progress(`  read ${rel} — ${tables.length} table(s), ${packageEntries} strings as "${uniqueLabel}"`);
  }

  const byDisposition: Partial<Record<Disposition, number>> = {};
  for (const entry of packages) {
    byDisposition[entry.disposition] = (byDisposition[entry.disposition] ?? 0) + 1;
  }
  const entries = occurrences.length;

  const index: InstallIndex = {
    schemaVersion: INSTALL_INDEX_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    generatedAt,
    gameRoot,
    packages,
    totals: {
      packagesFound: packages.length,
      packagesRead: byDisposition.read ?? 0,
      tables: resources.length,
      entries,
      byDisposition,
      nonEnglishTablesSkipped: nonEnglishSkipped,
    },
    notes: [
      "Every string table found is listed here with the package it came from.",
      `Large packages that are not named like string files were skipped; none of them held a table in ` +
        `the measurement recorded in IMPLEMENTATION_NOTES.md (${byDisposition["skipped-large"] ?? 0} skipped).`,
      `Delta (SDX) files are reported but not read until resource precedence is established ` +
        `(${byDisposition["excluded-delta"] ?? 0} excluded).`,
      `Packages holding no English table are listed but contribute nothing (${noEnglishOnly}).`,
      `Tables in languages other than English are not read (${nonEnglishSkipped} skipped): a mod ` +
        `repeats the same text once per locale, and only the English ones matter to a game running ` +
        `in English. Pass --include-non-english to read them anyway.`,
    ],
  };

  const catalog: Catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    generatedAt,
    packLabel: "MULTI",
    packages: sourceFacts,
    resources,
    occurrences,
    warnings: [],
  };

  const indexPath = join(options.outDir, "install-index.json");
  const catalogPath = join(options.outDir, "catalog.json");
  writeJsonAtomic(indexPath, index);
  writeJsonAtomic(catalogPath, catalog);
  progress(`wrote ${indexPath}`);
  progress(`wrote ${catalogPath}`);

  return { index, catalog, indexPath, catalogPath };
}

/** Per-package coverage: how much of each package is translatable today. */
export interface CoverageRow {
  label: string;
  path: string;
  tables: number;
  entries: number;
  ambiguous: number;
}

export function coverageByPackage(catalog: Catalog): CoverageRow[] {
  const rows = new Map<string, CoverageRow>();
  for (const resource of catalog.resources) {
    const row = rows.get(resource.packageLabel) ?? {
      label: resource.packageLabel,
      path: resource.packagePath,
      tables: 0,
      entries: 0,
      ambiguous: 0,
    };
    row.tables += 1;
    row.entries += resource.entryCount;
    rows.set(resource.packageLabel, row);
  }
  for (const occurrence of catalog.occurrences) {
    if (!occurrence.ambiguous) continue;
    const row = rows.get(occurrence.packageLabel);
    if (row) row.ambiguous += 1;
  }
  return [...rows.values()].sort((a, b) => b.entries - a.entries);
}
