/**
 * Test fixtures.
 *
 * Packages are generated in code rather than committed as binaries, so the
 * repository never contains game data and the fixtures stay readable.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Package, RawResource, StringTableResource } from "@s4tk/models";
import { CompressionType } from "@s4tk/compression";
import { STBL_TYPE } from "../src/ids.js";

export interface FixtureEntry {
  key: number;
  text: string;
}

export interface FixtureTable {
  type?: number;
  group?: number;
  instance: bigint;
  entries: FixtureEntry[];
}

export interface FixtureResource {
  type: number;
  group: number;
  instance: bigint;
  bytes: Buffer;
}

/** Writes a synthetic package containing the given string tables. */
export function writeFixturePackage(
  path: string,
  tables: FixtureTable[],
  extraResources: FixtureResource[] = []
): void {
  const pairs = tables.map((table) => {
    const model = new StringTableResource(
      table.entries.map((entry) => ({ key: entry.key, value: entry.text }))
    );
    model.defaultCompressionType = CompressionType.ZLIB;
    return {
      key: { type: table.type ?? STBL_TYPE, group: table.group ?? 0, instance: table.instance },
      value: model as import("@s4tk/models").RawResource | StringTableResource,
    };
  });

  const extras = extraResources.map((resource) => ({
    key: { type: resource.type, group: resource.group, instance: resource.instance },
    value: new RawResource({
      buffer: resource.bytes,
      compressionType: CompressionType.Uncompressed,
      sizeDecompressed: resource.bytes.length,
    }),
  }));

  const pkg = new Package([...pairs, ...extras]);
  writeFileSync(path, pkg.getBuffer());
}

/** A temporary directory that the caller removes when finished. */
export function makeTempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `sims4-eesti-${name}-`));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/**
 * The English string table instance this project was first developed against.
 * It is above Number.MAX_SAFE_INTEGER, but happens to be exactly representable
 * as a double — which is why `UNSAFE_INSTANCE` below exists too.
 */
export const REAL_ENGLISH_INSTANCE = 0x0054935f2685ad48n;

/**
 * One greater than the real instance: an odd 55-bit value that a JavaScript
 * `number` cannot hold, so it fails a naive round trip. Used to prove instance
 * ids are kept lossless.
 */
export const UNSAFE_INSTANCE = 0x0054935f2685ad49n;

/** `key` values are FNV-1a hashes of English text, not sequential ids. */
export const SAMPLE_KEYS = {
  newGame: 0x4e5906a1,
  loadGame: 0x8a1f2c33,
  resume: 0x1b2c3d4e,
  greeting: 0x2c3d4e5f,
  counter: 0x3d4e5f60,
  empty: 0x4e5f6071,
  complex: 0x5f607182,
  duplicate: 0x60718293,
} as const;
