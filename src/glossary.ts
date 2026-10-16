/**
 * Terminology consistency across a corpus translated in hundreds of independent
 * batches.
 *
 * The problem is not the 67,000 strings, it is the ~200 concept words inside them:
 * "household", "lot", "skill", "career". Each batch is translated in isolation, so
 * without a shared vocabulary the same English word drifts into several Estonian
 * ones - and unlike a wrong sentence, that drift is invisible until a player
 * notices two screens disagreeing.
 *
 * Three mechanisms, in the order they pay off:
 *
 * 1. **A curated glossary** injected into every batch, so translators start from
 *    the same words instead of inventing them.
 * 2. **Term reports**: each batch returns the terms it had to decide, which are
 *    merged back into the glossary, so wave two is more consistent than wave one.
 * 3. **A checker** that finds strings whose English contains a glossary term but
 *    whose Estonian does not contain the agreed stem. It reports, it never
 *    rewrites: Estonian inflects, and one term can legitimately have several
 *    renderings ("Home" is a navigation tab in one string and a house in another).
 *
 * The checker matches stems rather than whole words on purpose - Estonian is
 * agglutinative, so "leibkond" appears as "leibkonnad", "leibkonnal", "leibkonda".
 */
import { existsSync, readFileSync } from "node:fs";
import type { Catalog } from "./catalog.js";
import type { TranslationMap } from "./translations.js";

export interface GlossaryTerm {
  /** English term as it appears in the game text. */
  en: string;
  /** The agreed Estonian rendering, in its dictionary form. */
  et: string;
  /** Other forms or synonyms that are equally correct, so the checker stays quiet. */
  accept?: string[];
  /**
   * A pattern that, when it matches the English, means this is not the term.
   * Single words collide with ordinary English: "a lot of" is not a building lot,
   * and "money can't buy happiness" is not the Buy button.
   */
  exclude?: string;
  /**
   * The English word also has ordinary-language senses ("level of recognition",
   * "cast their lot", "mood lighting"). Such a term is only checked in short
   * strings - labels and buttons, where it is certainly the game term - and only
   * prevented, not policed, in prose. Measured: of the first 31 violations, 23
   * were this, and rewriting the checker's rules for prose senses costs more
   * than it catches.
   */
  ambiguous?: boolean;
  /** When the term means different things in different places, say so. */
  note?: string;
}

export interface Glossary {
  targetLocale: string;
  sourceLocale: string;
  terms: GlossaryTerm[];
  style: string[];
}

export function loadGlossary(path: string): Glossary {
  if (!existsSync(path)) {
    return { targetLocale: "et-EE", sourceLocale: "en_US", terms: [], style: [] };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Glossary>;
  if (!Array.isArray(parsed.terms)) {
    throw new Error(`"${path}" has no "terms" array.`);
  }
  const seen = new Set<string>();
  for (const term of parsed.terms) {
    if (typeof term.en !== "string" || typeof term.et !== "string") {
      throw new Error(`"${path}" has a term without "en" or "et".`);
    }
    // A duplicated term means two agreed renderings for one word, which is the
    // drift this file exists to prevent - and it happens easily when term
    // reports from different batches are merged in.
    const key = term.en.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`"${path}" lists "${term.en}" twice; merge the two entries into one.`);
    }
    seen.add(key);
  }
  return {
    targetLocale: parsed.targetLocale ?? "et-EE",
    sourceLocale: parsed.sourceLocale ?? "en_US",
    terms: parsed.terms,
    style: Array.isArray(parsed.style) ? parsed.style : [],
  };
}

/** The glossary as it is handed to a translator: compact, one line per term. */
export function glossaryForPrompt(glossary: Glossary): { en: string; et: string; note?: string }[] {
  return glossary.terms.map((term) => ({
    en: term.en,
    et: term.et,
    ...(term.note ? { note: term.note } : {}),
  }));
}

export interface GlossaryViolation {
  term: string;
  occurrenceId: string;
  english: string;
  estonian: string;
  expected: string[];
}

/** Leading characters of a word: long enough to survive inflection, short enough to match it. */
function stem(word: string, length = 6): string {
  const cleaned = word.toLocaleLowerCase("et");
  return cleaned.slice(0, Math.min(length, Math.max(4, cleaned.length - 2)));
}

/** Above this length a string is prose, where an ambiguous word may be another sense. */
const LABEL_LENGTH = 80;

function containsTerm(english: string, term: GlossaryTerm): boolean {
  const { en, exclude, ambiguous } = term;
  if (ambiguous && english.trim().length > LABEL_LENGTH) return false;
  // A single word can collide with ordinary English: "a lot of" is not a
  // building lot, and "money can't buy happiness" is not the Buy button.
  if (exclude && new RegExp(exclude, "i").test(english)) return false;
  // Word-boundary match, and never inside a placeholder or markup: "{0.SimName}"
  // must not count as the term "sim".
  const withoutSyntax = english.replace(/\{[^{}]*\}/g, " ").replace(/<[^>]*>/g, " ");
  const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(withoutSyntax);
}

export interface GlossaryCheckResult {
  violations: GlossaryViolation[];
  /** Occurrences that are in this catalog *and* translated, so actually compared. */
  checked: number;
  /**
   * Translation keys with no occurrence in this catalog. Checked against the
   * base-game catalog these are the stuff packs and mods, and checking against
   * the install-wide one they are stale - either way the caller must see them,
   * because "0 violations" over 57 of 672 strings looks like a clean bill of
   * health and is not one.
   */
  orphanTranslationIds: string[];
}

/**
 * Strings whose English uses a glossary term but whose Estonian does not use the
 * agreed rendering. A report for review, never an automatic correction.
 */
export function checkGlossary(
  glossary: Glossary,
  catalog: Catalog,
  translations: TranslationMap
): GlossaryCheckResult {
  const violations: GlossaryViolation[] = [];
  let checked = 0;
  const present = new Set<string>();
  for (const occurrence of catalog.occurrences) {
    present.add(occurrence.occurrenceId);
    const estonian = translations[occurrence.occurrenceId];
    if (estonian === undefined) continue;
    checked += 1;
    for (const term of glossary.terms) {
      if (!containsTerm(occurrence.sourceText, term)) continue;
      const acceptable = [term.et, ...(term.accept ?? [])];
      const stems = acceptable.map((word) => stem(word));
      const haystack = estonian.toLocaleLowerCase("et");
      if (stems.some((candidate) => haystack.includes(candidate))) continue;
      violations.push({
        term: term.en,
        occurrenceId: occurrence.occurrenceId,
        english: occurrence.sourceText,
        estonian,
        expected: acceptable,
      });
    }
  }
  const orphanTranslationIds = Object.keys(translations).filter((id) => !present.has(id));
  return { violations, checked, orphanTranslationIds };
}

/**
 * Merges the terms a batch's translator had to decide. Existing entries win: a
 * suggestion never overwrites an agreed term, it is only reported.
 */
export function mergeTermReports(
  glossary: Glossary,
  reports: Record<string, string>[]
): { added: GlossaryTerm[]; conflicts: { en: string; agreed: string; suggested: string }[] } {
  const known = new Map(glossary.terms.map((term) => [term.en.toLowerCase(), term]));
  const added: GlossaryTerm[] = [];
  const conflicts: { en: string; agreed: string; suggested: string }[] = [];

  for (const report of reports) {
    for (const [en, et] of Object.entries(report)) {
      if (typeof et !== "string" || et.trim() === "") continue;
      const existing = known.get(en.toLowerCase());
      if (!existing) {
        const term: GlossaryTerm = { en, et, note: "added from a translator's term report" };
        known.set(en.toLowerCase(), term);
        added.push(term);
        continue;
      }
      if (existing.et.toLowerCase() !== et.toLowerCase()) {
        conflicts.push({ en, agreed: existing.et, suggested: et });
      }
    }
  }
  return { added, conflicts };
}
