/**
 * Ordering the untranslated corpus by how likely a player is to see a string.
 *
 * The game reports no telemetry, so this is inferred from the files, and the
 * inference is checked against the only ground truth that exists: the 57
 * base-game strings that were confirmed on screen in the first in-game trial.
 * Measured against them (see `work/rank-explore*.ts`):
 *
 * - 54 of 57 are short labels, not sentences;
 * - 41 of 57 exist at more than one key in the same table - the game reuses its
 *   own UI text, so a repeated string is a string met in several places;
 * - the strings at the very top of the repetition distribution are *not* the
 *   visible ones: "OK" appears at 55 keys and covers none of the 57. Repetition
 *   is a signal with a ceiling, not a ranking on its own.
 *
 * So the score prefers labels, credits reuse up to a cap, credits the project's
 * core vocabulary, and gives a small bonus to strings that sit in the same region
 * of the table as a string already seen on screen (Maxis groups UI text in
 * blocks). It is a heuristic and says so: the point is to work through the corpus
 * from the strings a player meets first, not to compute a number that is true.
 *
 * Text is ranked, not occurrences. One decision about "OK" applies to all 55 of
 * its keys, so a report that counted occurrences would call that 55 strings of
 * progress; the export then applies the decision to every key of a chosen text,
 * because 54 of them staying English while one changes is worse than either.
 */
import type { Catalog, CatalogOccurrence } from "./catalog.js";
import { loadGlossary, type Glossary } from "./glossary.js";
import type { TranslationMap } from "./translations.js";
import { analyzeSyntax } from "./validation.js";

/** Weights. Each one is traceable to a measurement above or is marked as taste. */
const W = {
  /** A label is what a player reads without opening anything. 54/57 ground truth. */
  label: 6,
  /** Reuse across keys, capped: past ~8 the text is chrome ("OK"), not content. */
  repeatCap: 8,
  /** A core-vocabulary word makes a string part of a system the player uses. */
  concept: 3,
  conceptCap: 6,
  /** Same block of the table as a string already seen on screen. */
  anchor: 4,
  /** Within this many entries counts as the same UI block. */
  anchorRadius: 25,
} as const;

export interface RankedText {
  /** The English text, as the most common of its variants is spelled. */
  text: string;
  /** Every occurrence of this text (case-insensitively) in the catalog. */
  occurrences: CatalogOccurrence[];
  /** How many keys in the ranked packages carry this text. */
  repeats: number;
  /** Agreed-vocabulary words found in it. */
  concepts: string[];
  /** Distance in the table to the nearest string confirmed on screen, if close. */
  anchorDistance?: number;
  score: number;
  /** Why it scored what it did, for the sample report. */
  why: string[];
}

export interface RankOptions {
  /** Package labels to rank within (default: all). */
  includePackages?: string[];
  /** Occurrence IDs already translated; those texts are not ranked again. */
  translations?: TranslationMap;
  glossary?: Glossary;
  /** Occurrence IDs confirmed on screen, used as anchors. */
  anchors?: string[];
  /** Cap the report size. */
  top?: number;
}

function isLabel(text: string): boolean {
  const trimmed = text.trim();
  if (/^[^a-z]*[A-Z][^a-z]*$/.test(trimmed) && trimmed.length > 1) return true;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return words <= 3 && trimmed.length <= 24 && !/[.!?]$/.test(trimmed);
}

export function rankStrings(catalog: Catalog, options: RankOptions = {}): RankedText[] {
  const glossary = options.glossary ?? loadGlossary("glossary.json");
  const labels = options.includePackages ? new Set(options.includePackages) : undefined;
  const translated = options.translations ?? {};
  const anchors = new Set(options.anchors ?? []);

  const considered = catalog.occurrences.filter(
    (occurrence) =>
      (!labels || labels.has(occurrence.packageLabel)) &&
      occurrence.sourceText.trim() !== "" &&
      // Rank only what could actually be translated. Markup and gender branches
      // are refused by the validator, so ranking them would spend the report on
      // strings the export then drops - measured: they were in the top 1000.
      analyzeSyntax(occurrence.sourceText).problem === undefined
  );

  // Anchor positions, per table: the blocks of the table a player has been shown.
  const anchorIndexes = new Map<string, number[]>();
  for (const occurrence of considered) {
    if (!anchors.has(occurrence.occurrenceId)) continue;
    const list = anchorIndexes.get(occurrence.resourceTgi) ?? [];
    list.push(occurrence.entryIndex);
    anchorIndexes.set(occurrence.resourceTgi, list);
  }

  const byText = new Map<string, CatalogOccurrence[]>();
  for (const occurrence of considered) {
    const key = occurrence.sourceText.trim().toLowerCase();
    byText.set(key, [...(byText.get(key) ?? []), occurrence]);
  }

  const ranked: RankedText[] = [];
  for (const occurrences of byText.values()) {
    // Skip texts that are already translated: the work is done.
    if (occurrences.some((occurrence) => translated[occurrence.occurrenceId] !== undefined)) continue;
    // The spelling that appears most often becomes the representative.
    const spellings = new Map<string, number>();
    for (const occurrence of occurrences) {
      spellings.set(occurrence.sourceText, (spellings.get(occurrence.sourceText) ?? 0) + 1);
    }
    const text = [...spellings].sort((a, b) => b[1] - a[1])[0]![0];
    // A string that is nothing but a placeholder has nothing to translate.
    if (!/\p{L}/u.test(text.replace(/\{[^{}]*\}/g, ""))) continue;
    const why: string[] = [];
    let score = 0;
    const label = isLabel(text);

    if (label) {
      score += W.label;
      why.push("short label");
    }
    const repeats = occurrences.length;
    if (repeats > 1) {
      const credit = Math.min(repeats - 1, W.repeatCap);
      score += credit;
      why.push(`used at ${repeats} keys (+${credit})`);
    }
    const concepts = glossary.terms
      .filter((term) => new RegExp(`\\b${term.en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text))
      .map((term) => term.en);
    if (concepts.length > 0) {
      // Prose earns less: core words in a paragraph say the paragraph is about a
      // system, not that the player reads it as often as a button. Measured: the
      // paragraphs at the tail of the first top-1000 were all this.
      const cap = label ? W.conceptCap : W.conceptCap / 2;
      const credit = Math.min(concepts.length * W.concept, cap);
      score += credit;
      why.push(`core vocabulary: ${concepts.join(", ")} (+${credit})`);
    }

    let anchorDistance: number | undefined;
    for (const occurrence of occurrences) {
      for (const position of anchorIndexes.get(occurrence.resourceTgi) ?? []) {
        const distance = Math.abs(position - occurrence.entryIndex);
        if (distance <= W.anchorRadius && (anchorDistance === undefined || distance < anchorDistance)) {
          anchorDistance = distance;
        }
      }
    }
    if (anchorDistance !== undefined) {
      score += W.anchor;
      why.push(`same table block as a confirmed string (${anchorDistance} entries away)`);
    }

    ranked.push({ text, occurrences, repeats, concepts, ...(anchorDistance !== undefined ? { anchorDistance } : {}), score, why });
  }

  ranked.sort((a, b) => b.score - a.score || b.repeats - a.repeats || a.text.length - b.text.length || a.text.localeCompare(b.text));
  return options.top === undefined ? ranked : ranked.slice(0, options.top);
}

/** Every occurrence ID of the chosen texts, in catalog order. */
export function occurrenceIdsOf(ranked: RankedText[]): string[] {
  return ranked.flatMap((entry) => entry.occurrences.map((occurrence) => occurrence.occurrenceId));
}
