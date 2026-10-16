/**
 * Reference translations in other languages.
 *
 * Two sources, both measured before being trusted:
 *
 * 1. **Files the user supplied** - for example the Finnish copies of the game's
 *    own string files, which cover 100% of the base game's keys. We keep them in
 *    `work/`, never in the repository: that text is EA's, not ours.
 * 2. **Sibling locales inside a package** - several mods ship their own text in
 *    many languages. MC Command Center has real translations in ~17 languages;
 *    WickedWhims ships 68 translated strings per locale; Basemental Drugs' locales
 *    are English stubs. Stubs are detected (text identical to English) and dropped,
 *    so a translator is never shown English dressed up as German.
 *
 * Matching is by string key, which is stable across locales in the same table set
 * (verified: 58,374 of 58,374 keys match between the English and Finnish base
 * tables).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { localeByteOf, localeCodeOf, REFERENCE_LOCALE_PREFERENCE } from "./ids.js";
import { readStblTables } from "./package-io.js";

export type LocaleReferences = Map<string, string>;

export interface ReferenceIndex {
  /** locale code -> string key -> text, for every locale found. */
  byLocale: Map<string, LocaleReferences>;
  /** Where each locale came from, for the report. */
  sources: Map<string, string[]>;
  /** Locale tables read but discarded because they only repeat the English. */
  stubLocalesDropped: number;
}

function addTable(
  index: ReferenceIndex,
  locale: string,
  entries: { key: number; text: string }[],
  englishText: Map<number, string>,
  origin: string
): number {
  const target = index.byLocale.get(locale) ?? new Map<string, string>();
  let differing = 0;
  for (const entry of entries) {
    const english = englishText.get(entry.key);
    // A locale that merely repeats the English is a stub, not a translation.
    if (english !== undefined && entry.text === english) continue;
    target.set(entry.key.toString(16).toUpperCase().padStart(8, "0"), entry.text);
    differing += 1;
  }
  if (target.size > 0) {
    index.byLocale.set(locale, target);
    const list = index.sources.get(locale) ?? [];
    list.push(origin);
    index.sources.set(locale, list);
  }
  return differing;
}

function readPackage(path: string, englishFrom?: Map<number, string>, origin?: string):
  { index: ReferenceIndex; english: Map<number, string> } {
  const index: ReferenceIndex = { byLocale: new Map(), sources: new Map(), stubLocalesDropped: 0 };
  const read = readStblTables(path);
  const english = englishFrom ?? new Map<number, string>();
  let englishSeen = englishFrom !== undefined;

  for (const table of read.tables) {
    const byte = localeByteOf(table.instance);
    if (byte === 0) {
      if (!englishSeen) {
        for (const entry of table.entries) english.set(entry.key, entry.text);
        englishSeen = true;
      }
      continue;
    }
    const locale = localeCodeOf(byte);
    const differing = addTable(index, locale, table.entries, english, origin ?? path);
    if (differing === 0) index.stubLocalesDropped += 1;
  }
  return { index, english };
}

/**
 * Loads reference files: each is a package holding one non-English table. The
 * English text to compare against comes from the catalog being translated, so a
 * stub is recognised even when the reference file has no English table of its own.
 */
export function loadReferenceFiles(
  paths: string[],
  englishByKey: Map<string, string>
): ReferenceIndex {
  const combined: ReferenceIndex = { byLocale: new Map(), sources: new Map(), stubLocalesDropped: 0 };
  for (const path of expandPaths(paths)) {
    const read = readStblTables(path);
    for (const table of read.tables) {
      const byte = localeByteOf(table.instance);
      if (byte === 0) continue;
      const locale = localeCodeOf(byte);
      const target = combined.byLocale.get(locale) ?? new Map<string, string>();
      for (const entry of table.entries) {
        const key = entry.key.toString(16).toUpperCase().padStart(8, "0");
        const english = englishByKey.get(key);
        if (english !== undefined && english === entry.text) continue;
        target.set(key, entry.text);
      }
      if (target.size > 0) {
        combined.byLocale.set(locale, target);
        const list = combined.sources.get(locale) ?? [];
        list.push(path);
        combined.sources.set(locale, list);
      }
    }
  }
  return combined;
}

/** Expands directories to the `*.package` files inside them. */
function expandPaths(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) {
        if (name.toLowerCase().endsWith(".package")) files.push(join(path, name));
      }
    } else {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Reads the sibling locales a package ships itself. Returns per-key references,
 * best language first, capped at `maxLanguages`.
 */
export function referencesFromPackage(packagePath: string, maxLanguages: number): {
  byKey: Map<string, Record<string, string>>;
  stubLocalesDropped: number;
} {
  const { index } = readPackage(packagePath);
  return {
    byKey: flatten(index.byLocale, maxLanguages),
    stubLocalesDropped: index.stubLocalesDropped,
  };
}

/** Turns `locale -> key -> text` into `key -> {locale: text}`, in preference order. */
export function flatten(
  byLocale: Map<string, LocaleReferences>,
  maxLanguages: number
): Map<string, Record<string, string>> {
  const ordered = [...byLocale.keys()].sort((a, b) => {
    const left = REFERENCE_LOCALE_PREFERENCE.indexOf(a);
    const right = REFERENCE_LOCALE_PREFERENCE.indexOf(b);
    return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
  });
  const chosen = ordered.slice(0, maxLanguages);
  const out = new Map<string, Record<string, string>>();
  for (const locale of chosen) {
    for (const [key, text] of byLocale.get(locale)!) {
      const row = out.get(key) ?? {};
      row[locale] = text;
      out.set(key, row);
    }
  }
  return out;
}

export { readPackage };
