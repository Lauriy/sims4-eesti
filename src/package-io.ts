/**
 * The only module that talks to `@s4tk/models`.
 *
 * Everything else in the project works with the plain data structures declared
 * here, so the dependency is pinned in one place (see IMPLEMENTATION_NOTES.md for
 * the version actually tested and the library limitations this adapter works
 * around).
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Package, RawResource, StringTableResource } from "@s4tk/models";
import { CompressionType } from "@s4tk/compression";
import { STBL_TYPE, localeByteOf, type TgiBig } from "./ids.js";

export class PackageReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageReadError";
  }
}

export interface RawEntry {
  /** 32-bit string key as stored in the table. */
  key: number;
  text: string;
}

export interface RawTable {
  type: number;
  group: number;
  instance: bigint;
  entries: RawEntry[];
  /** Compression type stored in the package index for this resource. */
  compressionType: number;
}

export interface DbpfHeaderSummary {
  /** e.g. `2.1`. */
  version: string;
  /** Number of index records the header claims. */
  indexRecordCount: number;
  /** DBPF index flags as stored (the library always writes 0). */
  indexFlags: number;
}

export interface ReadStblResult {
  /** Only string tables, in DBPF index order. */
  tables: RawTable[];
  /** Total resources in the package, including ones we do not read. */
  resourceCount: number;
  header: DbpfHeaderSummary;
}

export interface WrittenTable {
  type: number;
  group: number;
  instance: bigint;
  entries: RawEntry[];
}

const STBL_FILTER = (type: number): boolean => type === STBL_TYPE;

/**
 * Reads the DBPF header far enough to fail actionably on non-packages and to
 * report how many resources exist. This is not a package parser: the library
 * does all real reading.
 */
function summarizeDbpfHeader(buffer: Buffer, filePath: string): DbpfHeaderSummary {
  if (buffer.length < 96) {
    throw new PackageReadError(
      `"${filePath}" is only ${buffer.length} bytes; too short to be a DBPF package.`
    );
  }
  const magic = buffer.toString("latin1", 0, 4);
  if (magic !== "DBPF") {
    throw new PackageReadError(
      `"${filePath}" is not a Sims 4 package: expected the file to start with "DBPF", found ` +
        `${JSON.stringify(magic)}. Point --package at a .package file, not a .ts4script, .zip, or save.`
    );
  }
  const major = buffer.readUInt32LE(4);
  const minor = buffer.readUInt32LE(8);
  if (major !== 2) {
    throw new PackageReadError(
      `"${filePath}" is a DBPF version ${major}.${minor} package; this tool only supports ` +
        `Sims 4 packages (version 2.x).`
    );
  }
  // The index position lives in the 64-bit field, but the library falls back to
  // the 32-bit "low" field when that one is zero, so mirror that when reading the
  // index flags rather than reporting bytes that are not flags at all.
  const indexPosition =
    Number(buffer.readBigUInt64LE(64)) || buffer.readUInt32LE(40);
  return {
    version: `${major}.${minor}`,
    indexRecordCount: buffer.readUInt32LE(36),
    indexFlags: indexPosition === 0 ? 0 : buffer.readUInt32LE(indexPosition),
  };
}

function readFileOrThrow(filePath: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new PackageReadError(`No such file: "${filePath}"`);
    if (code === "EISDIR") throw new PackageReadError(`"${filePath}" is a directory, not a file.`);
    if (code === "EACCES" || code === "EPERM") {
      throw new PackageReadError(`Access denied reading "${filePath}".`);
    }
    throw new PackageReadError(`Could not read "${filePath}": ${(error as Error).message}`);
  }
}

/**
 * Lists the resource types a package holds, with counts - "what is in this file"
 * without loading a single resource body. Discovery aid: the game's strings are
 * in STBL resources, but its UI, tuning and locale assets are other types, and
 * knowing which type holds what is the difference between "findable" and "not".
 */
export function listResourceTypes(filePath: string): { type: string; count: number }[] {
  const buffer = readFileOrThrow(filePath);
  const header = summarizeDbpfHeader(buffer, filePath);
  let pkg: Package<RawResource>;
  try {
    const parsed = Package.from(buffer);
    if (!(parsed instanceof Package)) throw new Error("not a package");
    pkg = parsed as Package<RawResource>;
  } catch (error) {
    throw new PackageReadError(`Could not parse "${filePath}": ${(error as Error).message}`);
  }
  const counts = new Map<string, number>();
  for (const entry of pkg.entries) {
    const type = entry.key.type.toString(16).toUpperCase().padStart(8, "0");
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  void header;
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

export interface RawResourceBuffer {
  type: number;
  group: number;
  instance: bigint;
  /** Decompressed resource bytes, whatever the resource type is. */
  buffer: Buffer;
}

/**
 * Extracts resources of any type as decompressed buffers. A discovery aid for
 * looking past the string tables (UI assets, tuning, locale data); nothing in
 * the translation pipeline consumes these bytes.
 */
export function extractRawBuffers(
  filePath: string,
  options: { type?: number; limit?: number } = {}
): RawResourceBuffer[] {
  const buffer = readFileOrThrow(filePath);
  summarizeDbpfHeader(buffer, filePath);
  let resources: { key: TgiBig; value: RawResource }[];
  try {
    resources = Package.extractResources<RawResource>(buffer, {
      loadRaw: true,
      decompressBuffers: true,
      keepDeletedRecords: false,
      ...(options.type === undefined
        ? {}
        : { resourceFilter: (type: number): boolean => type === options.type }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    }) as { key: TgiBig; value: RawResource }[];
  } catch (error) {
    throw new PackageReadError(`Failed to extract resources from "${filePath}": ${(error as Error).message}`);
  }
  return resources.map(({ key, value }) => ({
    type: key.type,
    group: key.group,
    instance: key.instance,
    buffer: value.buffer,
  }));
}

/**
 * Reads every string table (and nothing else) from a package.
 *
 * @throws PackageReadError on unreadable input, non-DBPF files, decompression
 * failures, or a package with no string tables.
 */
export function readStblTables(filePath: string): ReadStblResult {
  const buffer = readFileOrThrow(filePath);
  const header = summarizeDbpfHeader(buffer, filePath);

  let pkg: Package<StringTableResource>;
  try {
    pkg = Package.from<StringTableResource>(buffer, {
      resourceFilter: STBL_FILTER,
      keepDeletedRecords: false,
    });
  } catch (error) {
    throw new PackageReadError(
      `Failed to read "${filePath}" as a package: ${(error as Error).message}. ` +
        `The file may be corrupt, truncated, or use a compression this tool cannot decompress.`
    );
  }

  const tables: RawTable[] = [];
  for (const entry of pkg.entries) {
    // Runtime guard: the generic type above is a claim about the library, not a
    // guarantee, so verify rather than assume.
    const table: unknown = entry.value;
    if (!(table instanceof StringTableResource)) {
      const loadedAs =
        (table as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof table;
      throw new PackageReadError(
        `Resource ${entry.key.type.toString(16)} in "${filePath}" was expected to be a string ` +
          `table but loaded as ${loadedAs}.`
      );
    }
    tables.push({
      type: entry.key.type,
      group: entry.key.group,
      instance: entry.key.instance,
      entries: table.entries.map((e) => ({ key: e.key, text: e.value })),
      compressionType: table.defaultCompressionType,
    });
  }

  if (tables.length === 0) {
    throw new PackageReadError(
      `"${filePath}" contains no string tables (type 220557DA): ${header.indexRecordCount} ` +
        `resource(s) were listed but none of them is text for this locale file. ` +
        `English base-game text lives in Data\\Client\\Strings_ENG_US.package.`
    );
  }

  return { tables, resourceCount: header.indexRecordCount, header };
}

/**
 * Reads string tables as *raw decompressed buffers* plus their resource keys.
 * Used only for byte-level verification (see stbl-format.ts).
 */
export function readRawStblBuffers(
  filePath: string
): { key: TgiBig; buffer: Buffer }[] {
  const buffer = readFileOrThrow(filePath);
  summarizeDbpfHeader(buffer, filePath);

  let resources: { key: TgiBig; value: RawResource }[];
  try {
    resources = Package.extractResources<RawResource>(buffer, {
      resourceFilter: STBL_FILTER,
      loadRaw: true,
      decompressBuffers: true,
      keepDeletedRecords: false,
    }) as { key: TgiBig; value: RawResource }[];
  } catch (error) {
    throw new PackageReadError(
      `Failed to read raw string tables from "${filePath}": ${(error as Error).message}`
    );
  }

  return resources.map(({ key, value }) => ({ key, buffer: value.buffer }));
}

/**
 * Writes a new package containing exactly the given tables.
 *
 * Written atomically: the buffer is completed and validated by the caller in a
 * temporary file first, and only then moved into place.
 */
export function writePackageFile(
  outPath: string,
  tables: WrittenTable[]
): { bytes: number; compressors: string[] } {
  const pairs = tables.map((table) => {
    const model = new StringTableResource(
      table.entries.map((entry) => ({ key: entry.key, value: entry.text }))
    );
    // EA ships this file internally-compressed (0xFFFF), which @s4tk/compression
    // can read but cannot write. Mods use ZLIB, which is what we emit.
    model.defaultCompressionType = CompressionType.ZLIB;
    return {
      key: { type: table.type, group: table.group, instance: table.instance },
      value: model,
    };
  });

  const pkg = new Package(pairs);
  let buffer: Buffer;
  try {
    buffer = pkg.getBuffer();
  } catch (error) {
    throw new PackageReadError(`Failed to serialize the output package: ${(error as Error).message}`);
  }

  const tempPath = `${outPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, buffer);
    renameSync(tempPath, outPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw new PackageReadError(
      `Failed to write "${outPath}": ${(error as Error).message}. ` +
        `Check that the directory exists and is writable, and that the file is not open in another program.`
    );
  }

  return { bytes: buffer.length, compressors: ["ZLIB"] };
}

/** Locale byte of the instance, for reporting which locale a table belongs to. */
export { localeByteOf };
