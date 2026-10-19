/**
 * Identifiers used throughout the tool.
 *
 * All identifiers are stored and printed as fixed-width uppercase hex:
 * 8 digits for type/group/string key, 16 for the 64-bit instance. The instance
 * only ever travels as a `bigint` in memory, because real Sims 4 STBL instances
 * exceed `Number.MAX_SAFE_INTEGER`.
 */

/** Resource type of a Sims 4 string table (STBL). */
export const STBL_TYPE = 0x220557da;

/** High byte of the string-table instance that holds the locale. `00` is English. */
export const ENGLISH_LOCALE_BYTE = 0x00;

export interface Tgi {
  /** 8 hex digits. */
  type: string;
  /** 8 hex digits. */
  group: string;
  /** 16 hex digits, lossless. */
  instance: string;
}

export interface TgiBig {
  type: number;
  group: number;
  instance: bigint;
}

const HEX8 = /^[0-9a-fA-F]{8}$/;
const HEX16 = /^[0-9a-fA-F]{16}$/;

export function hex8(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Not a 32-bit unsigned integer: ${value}`);
  }
  return value.toString(16).toUpperCase().padStart(8, "0");
}

export function hex16(value: bigint): string {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`Not a 64-bit unsigned integer: ${value}`);
  }
  return value.toString(16).toUpperCase().padStart(16, "0");
}

export function parseHex8(text: string, what: string): number {
  if (!HEX8.test(text)) {
    throw new Error(`${what} must be exactly 8 hex digits, got "${text}"`);
  }
  return Number.parseInt(text, 16);
}

export function parseHex16(text: string, what: string): bigint {
  if (!HEX16.test(text)) {
    throw new Error(`${what} must be exactly 16 hex digits, got "${text}"`);
  }
  return BigInt(`0x${text}`);
}

export function toTgi(key: TgiBig): Tgi {
  return { type: hex8(key.type), group: hex8(key.group), instance: hex16(key.instance) };
}

export function fromTgi(tgi: Tgi): TgiBig {
  return {
    type: parseHex8(tgi.type, "type"),
    group: parseHex8(tgi.group, "group"),
    instance: parseHex16(tgi.instance, "instance"),
  };
}

/** `TYPE:GROUP:INSTANCE`, e.g. `220557DA:00000000:0054935F2685AD48`. */
export function formatTgi(tgi: Tgi): string {
  return `${tgi.type}:${tgi.group}:${tgi.instance}`;
}

export function parseTgiString(text: string): Tgi {
  const parts = text.split(":");
  if (parts.length !== 3) {
    throw new Error(`TGI must be "TYPE:GROUP:INSTANCE", got "${text}"`);
  }
  const [type, group, instance] = parts as [string, string, string];
  parseHex8(type, "TGI type");
  parseHex8(group, "TGI group");
  parseHex16(instance, "TGI instance");
  return { type: type.toUpperCase(), group: group.toUpperCase(), instance: instance.toUpperCase() };
}

/**
 * Stable identity of one translatable string occurrence: pack label, full
 * resource identity, and the string's own key. Never derived from the English
 * text or from the string hash alone, and never from position within a table.
 */
export function formatOccurrenceId(packLabel: string, tgi: Tgi, stringKey: string): string {
  return `${packLabel}|${formatTgi(tgi)}|${stringKey}`;
}

export interface OccurrenceIdParts {
  packLabel: string;
  tgi: Tgi;
  stringKey: string;
}

export function parseOccurrenceId(occurrenceId: string): OccurrenceIdParts {
  const parts = occurrenceId.split("|");
  if (parts.length !== 3) {
    throw new Error(
      `Occurrence ID must be "PACK|TYPE:GROUP:INSTANCE|STRINGKEY", got "${occurrenceId}"`
    );
  }
  const [packLabel, tgiText, stringKey] = parts as [string, string, string];
  if (!packLabel) throw new Error(`Occurrence ID has an empty pack label: "${occurrenceId}"`);
  parseHex8(stringKey, "occurrence string key");
  return {
    packLabel,
    tgi: parseTgiString(tgiText),
    stringKey: stringKey.toUpperCase(),
  };
}

/** Locale byte of a string table instance (high byte). */
export function localeByteOf(instance: bigint): number {
  return Number((instance >> 56n) & 0xffn);
}

/**
 * Two-letter code for a string-table locale byte, i.e. the high byte of a table's
 * instance. Values follow the game's own `StringTableLocale` enumeration.
 */
const LOCALE_CODES: Record<number, string> = {
  0x00: "en",
  0x01: "zh-CN",
  0x02: "zh-TW",
  0x03: "cs",
  0x04: "da",
  0x05: "nl",
  0x06: "fi",
  0x07: "fr",
  0x08: "de",
  0x0b: "it",
  0x0c: "ja",
  0x0d: "ko",
  0x0e: "no",
  0x0f: "pl",
  0x11: "pt",
  0x12: "ru",
  0x13: "es",
  0x15: "sv",
};

export function localeCodeOf(localeByte: number): string {
  return LOCALE_CODES[localeByte] ?? `0x${localeByte.toString(16).padStart(2, "0")}`;
}

/** Every locale code the game ships a string table for, as `[byte, code]` pairs. */
export function allLocaleCodes(): { byte: number; code: string }[] {
  return Object.entries(LOCALE_CODES).map(([byte, code]) => ({ byte: Number(byte), code }));
}

/**
 * Parses a locale given either by code (`fi`) or by byte (`0x06`, `06`). Named
 * codes win over hex when the text is both, so `de` is German, not byte 0xDE.
 */
export function localeByteFromCode(text: string): number {
  const trimmed = text.trim().toLowerCase();
  for (const [byte, code] of Object.entries(LOCALE_CODES)) {
    if (code.toLowerCase() === trimmed) return Number(byte);
  }
  if (/^0x[0-9a-f]{2}$/.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
  if (/^[0-9a-f]{2}$/.test(trimmed)) return Number.parseInt(trimmed, 16);
  throw new Error(
    `Unknown locale "${text}". Use a code such as ${Object.values(LOCALE_CODES).slice(0, 6).join(", ")}, ` +
      `or a two-digit byte such as 0x06.`
  );
}

/**
 * Languages to show a translator, best first. Finnish leads deliberately: it is
 * Finno-Ugric like Estonian, has no grammatical gender and uses cases, so it
 * shows how a professional team solved the same problems on the same strings.
 */
export const REFERENCE_LOCALE_PREFERENCE = ["fi", "de", "ru", "sv", "pl"];
