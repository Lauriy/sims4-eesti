/**
 * A minimal, dependency-free reader for the STBL binary layout.
 *
 * This exists only for *verification*, never for building: it lets the tool make
 * claims about bytes that `@s4tk/models` deliberately does not model (notably the
 * per-entry `mnFlags` byte, which that library skips when reading and writes as
 * zero). It is not a DBPF parser — DBPF packages are always handled by the
 * library; the buffers passed in here are already-unpacked resource payloads.
 *
 * Layout (little-endian):
 *   header: "STBL" (4) | mnVersion u16 | mnCompressed u8 | mnNumEntries u64
 *           | mReserved (2) | mnStringLength u32            = 21 bytes
 *   entry:  mnKey u32 | mnFlags u8 | mnLength u16 | UTF-8 text (mnLength bytes)
 */
import { STBL_TYPE } from "./ids.js";

export interface StblHeader {
  signature: string;
  version: number;
  compressed: number;
  numEntries: number;
  reserved: [number, number];
  stringLength: number;
}

export interface StblRawEntry {
  index: number;
  key: number;
  flags: number;
  byteLength: number;
  text: string;
}

export interface ParsedStbl {
  header: StblHeader;
  entries: StblRawEntry[];
}

export class StblFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StblFormatError";
  }
}

const HEADER_BYTES = 21;

export function parseStblBuffer(buffer: Buffer): ParsedStbl {
  if (buffer.length < HEADER_BYTES) {
    throw new StblFormatError(
      `String table is ${buffer.length} bytes, shorter than the ${HEADER_BYTES}-byte header.`
    );
  }

  const signature = buffer.toString("latin1", 0, 4);
  if (signature !== "STBL") {
    throw new StblFormatError(
      `String table does not start with "STBL" (found ${JSON.stringify(signature)}).`
    );
  }

  const version = buffer.readUInt16LE(4);
  const numEntriesBig = buffer.readBigUInt64LE(7);
  if (numEntriesBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StblFormatError(`String table claims ${numEntriesBig} entries; refusing to parse.`);
  }
  const numEntries = Number(numEntriesBig);

  const header: StblHeader = {
    signature,
    version,
    compressed: buffer.readUInt8(6),
    numEntries,
    reserved: [buffer.readUInt8(15), buffer.readUInt8(16)],
    stringLength: buffer.readUInt32LE(17),
  };

  const entries: StblRawEntry[] = [];
  let offset = HEADER_BYTES;
  for (let index = 0; index < numEntries; index++) {
    if (offset + 7 > buffer.length) {
      throw new StblFormatError(
        `String table is truncated: entry ${index} of ${numEntries} starts past the end of the buffer.`
      );
    }
    const key = buffer.readUInt32LE(offset);
    const flags = buffer.readUInt8(offset + 4);
    const byteLength = buffer.readUInt16LE(offset + 5);
    offset += 7;
    if (offset + byteLength > buffer.length) {
      throw new StblFormatError(
        `String table is truncated: entry ${index} declares ${byteLength} bytes of text but only ` +
          `${buffer.length - offset} bytes remain.`
      );
    }
    const raw = buffer.subarray(offset, offset + byteLength);
    offset += byteLength;
    entries.push({ index, key, flags, byteLength, text: raw.toString("utf8") });
  }

  if (offset !== buffer.length) {
    throw new StblFormatError(
      `String table has ${buffer.length - offset} trailing byte(s) after ${numEntries} entries.`
    );
  }

  return { header, entries };
}

/** True if this resource type is a string table. */
export function isStblType(type: number): boolean {
  return type === STBL_TYPE;
}
