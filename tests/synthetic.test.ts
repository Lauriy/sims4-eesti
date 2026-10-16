/**
 * Binary-library proof (brief §1): a synthetic package is created, written,
 * reopened, and checked for exact resource identifiers, string keys, text,
 * Estonian letters, placeholders, an empty string, and a 64-bit instance that is
 * not safe to hold as a JavaScript number.
 *
 * These tests exercise the adapter and the library together. A passing round trip
 * is *not* evidence of in-game compatibility; that gate is manual (README.md).
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { writePackageFile } from "../src/package-io.js";
import { parseStblBuffer } from "../src/stbl-format.js";
import { readStblTables, readRawStblBuffers } from "../src/package-io.js";
import { formatTgi, hex16, toTgi } from "../src/ids.js";
import {
  REAL_ENGLISH_INSTANCE,
  SAMPLE_KEYS,
  UNSAFE_INSTANCE,
  makeTempDir,
  removeDir,
  writeFixturePackage,
  type FixtureTable,
} from "./helpers.js";

const ESTONIAN = "Jätka mängu — ÕÄÖÜ õäöü ŠŽ šž";
const REPEATED_PLACEHOLDER = "{0.SimFirstName} ja {1.SimFirstName} läksid koju";
const EMPTY_TEXT = "";

let dir: string;

before(() => {
  dir = makeTempDir("synthetic");
});

after(() => {
  removeDir(dir);
});

function buildFixture(path: string): FixtureTable[] {
  const tables: FixtureTable[] = [
    {
      instance: REAL_ENGLISH_INSTANCE,
      entries: [
        { key: SAMPLE_KEYS.newGame, text: "New Game" },
        { key: SAMPLE_KEYS.greeting, text: ESTONIAN },
        { key: SAMPLE_KEYS.counter, text: REPEATED_PLACEHOLDER },
        { key: SAMPLE_KEYS.empty, text: EMPTY_TEXT },
        { key: SAMPLE_KEYS.complex, text: "{F0.hero|M0.hero} arrives" },
      ],
    },
    {
      group: 0x00000001,
      instance: 0x00000000deadbeefn,
      entries: [{ key: SAMPLE_KEYS.loadGame, text: "Load Game" }],
    },
    {
      group: 0x00000002,
      instance: UNSAFE_INSTANCE,
      entries: [{ key: SAMPLE_KEYS.resume, text: "Resume" }],
    },
  ];
  writeFixturePackage(path, tables);
  return tables;
}

describe("synthetic package round trip", () => {
  it("preserves resource identifiers, keys, text, and metadata", () => {
    const sourcePath = join(dir, "fixture.package");
    const tables = buildFixture(sourcePath);

    const read = readStblTables(sourcePath);
    assert.equal(read.tables.length, 3);
    assert.equal(read.header.version, "2.1");

    const first = read.tables[0]!;
    assert.equal(first.instance, REAL_ENGLISH_INSTANCE);
    assert.equal(hex16(first.instance), "0054935F2685AD48");
    assert.equal(first.entries.length, 5);
    assert.deepEqual(
      first.entries.map((entry) => entry.key),
      tables[0]!.entries.map((entry) => entry.key)
    );
    assert.deepEqual(
      first.entries.map((entry) => entry.text),
      tables[0]!.entries.map((entry) => entry.text)
    );
    assert.equal(first.entries[1]!.text, ESTONIAN);
    assert.equal(first.entries[3]!.text, EMPTY_TEXT);

    const second = read.tables[1]!;
    assert.equal(second.group, 0x00000001);
    assert.equal(second.instance, 0x00000000deadbeefn);
    assert.equal(second.entries[0]!.text, "Load Game");
  });

  it("keeps 64-bit instance ids lossless, unlike a JavaScript number", () => {
    const sourcePath = join(dir, "lossless.package");
    buildFixture(sourcePath);
    const read = readStblTables(sourcePath);

    const real = read.tables[0]!.instance;
    assert.equal(real, REAL_ENGLISH_INSTANCE);
    assert.ok(Number(real) > Number.MAX_SAFE_INTEGER);

    const unsafe = read.tables[2]!.instance;
    assert.equal(unsafe, UNSAFE_INSTANCE);
    assert.equal(hex16(unsafe), "0054935F2685AD49");
    // Proof that a `number` would have silently corrupted this id.
    assert.notEqual(BigInt(Number(unsafe)), unsafe);
  });

  it("round-trips through the writer and reopens byte-verified", () => {
    const sourcePath = join(dir, "roundtrip-source.package");
    buildFixture(sourcePath);
    const original = readStblTables(sourcePath);

    const outPath = join(dir, "roundtrip-out.package");
    const { bytes } = writePackageFile(
      outPath,
      original.tables.map((table) => ({
        type: table.type,
        group: table.group,
        instance: table.instance,
        entries: table.entries.map((entry) => ({ key: entry.key, text: entry.text })),
      }))
    );
    assert.ok(bytes > 0);

    const reread = readStblTables(outPath);
    assert.equal(reread.tables.length, original.tables.length);
    for (let i = 0; i < original.tables.length; i++) {
      const before = original.tables[i]!;
      const after = reread.tables[i]!;
      assert.equal(formatTgi(toTgi(after)), formatTgi(toTgi(before)));
      assert.equal(after.entries.length, before.entries.length);
      for (let e = 0; e < before.entries.length; e++) {
        assert.equal(after.entries[e]!.key, before.entries[e]!.key);
        assert.equal(after.entries[e]!.text, before.entries[e]!.text);
      }
    }

    // Independent byte-level check of the payload we wrote.
    const raw = readRawStblBuffers(outPath);
    assert.equal(raw.length, original.tables.length);
    for (const { key, buffer } of raw) {
      const parsed = parseStblBuffer(buffer);
      assert.equal(parsed.header.version, 5);
      assert.equal(parsed.header.compressed, 0);
      for (const entry of parsed.entries) {
        assert.equal(entry.flags, 0);
        assert.equal(entry.byteLength, Buffer.byteLength(entry.text, "utf8"));
      }
    }
    const firstRaw = parseStblBuffer(raw[0]!.buffer);
    const estonianEntry = firstRaw.entries.find((entry) => entry.text === ESTONIAN);
    assert.ok(estonianEntry, "Estonian text survives the byte-level reader");
    assert.equal(estonianEntry!.byteLength, Buffer.byteLength(ESTONIAN, "utf8"));
  });

  it("produces identical bytes for identical input", () => {
    const sourcePath = join(dir, "repro-source.package");
    buildFixture(sourcePath);
    const tables = readStblTables(sourcePath).tables.map((table) => ({
      type: table.type,
      group: table.group,
      instance: table.instance,
      entries: table.entries.map((entry) => ({ key: entry.key, text: entry.text })),
    }));

    const firstPath = join(dir, "repro-a.package");
    const secondPath = join(dir, "repro-b.package");
    writePackageFile(firstPath, tables);
    writePackageFile(secondPath, tables);
    assert.ok(readFileSync(firstPath).equals(readFileSync(secondPath)));
  });

  it("preserves the non-string-table resources of the source when they are not copied", () => {
    // Our own writer only ever receives string tables; the source file's other
    // resources are simply never read, which this asserts from the reading side.
    const path = join(dir, "mixed.package");
    writeFixturePackage(
      path,
      [
        {
          instance: REAL_ENGLISH_INSTANCE,
          entries: [{ key: SAMPLE_KEYS.newGame, text: "New Game" }],
        },
      ],
      [{ type: 0x00b2d882, group: 0, instance: 0x1234n, bytes: Buffer.from([1, 2, 3, 4, 5]) }]
    );

    const read = readStblTables(path);
    assert.equal(read.resourceCount, 2, "the header still lists both resources");
    assert.equal(read.tables.length, 1, "but only the string table is read");
  });
});
