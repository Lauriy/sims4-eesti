/**
 * Decides which translations may be applied to the game's text.
 *
 * The rule everywhere is conservative: if anything about a string is not fully
 * understood, its English text is left untouched rather than guessed at. Every
 * rejection carries a reason code so the build report can explain itself.
 *
 * What counts as "understood" comes from surveying the real English file the
 * project targets (58,374 entries) rather than from assumption:
 *   20,802 brace expressions in 698 shapes, 9,429 markup tags, 8,893 `\n`
 *   escapes, 33 `[PH]`-style codes.
 * Only the subset below is handled; the rest is deliberately deferred.
 */

export type TranslationState = "draft" | "machine" | "reviewed" | "needs_review";

export const TRANSLATION_STATES: readonly TranslationState[] = [
  "draft",
  "machine",
  "reviewed",
  "needs_review",
];

export function isTranslationState(value: string): value is TranslationState {
  return (TRANSLATION_STATES as readonly string[]).includes(value);
}

export type IssueCode =
  | "unknown-occurrence"
  | "missing-metadata"
  | "missing-text"
  | "malformed-metadata"
  | "stale-source"
  | "unreviewed"
  | "empty-replacement"
  | "identical-to-source"
  | "placeholder-mismatch"
  | "token-mismatch"
  | "unsupported-syntax"
  | "too-long-utf8"
  | "invalid-text"
  | "edge-whitespace-mismatch"
  | "ambiguous-occurrence";

export interface ValidationIssue {
  code: IssueCode;
  message: string;
}

/**
 * Value names that stand for a runtime value and carry no translatable English.
 *
 * Everything else between braces is deferred: gender and plural branches such as
 * `{M0.his}` / `{F0.she}`, pronoun expressions such as `{0.SimPronounSubjective}`,
 * modifier forms such as `{0.SimPronounSubjective|xxUpper}`, and any shape we have
 * not surveyed. Preserving those verbatim can leave English words inside
 * otherwise Estonian text, so guessing is worse than leaving the string alone.
 */
const SUPPORTED_VALUE_NAMES = new Set([
  "SimFirstName",
  "SimLastName",
  "SimName",
  "String",
  "Number",
  "Money",
  "ObjectName",
  "TimeShort",
  "Timespan",
  "DayOfWeekShort",
  "DayOfWeekLong",
]);

/** `{0.SimFirstName}` with a whitelisted value name. */
const SIMPLE_PLACEHOLDER = /^\{\d+\.([A-Za-z][A-Za-z0-9_]*)\}$/;

/** HTML-like markup the game renders: `<b>`, `</b>`, `<span class="pink">`, `<font color="#EC262E">`. */
const MARKUP = /<\/?[A-Za-z][^<>]*>/;

/** Escapes such as `\n` and `\s`, stored as two characters in the string table. */
const ESCAPE = /\\[A-Za-z]/g;

/** Inline codes such as `[PH]`, `[V]`, `[DNT]`. */
const BRACKET_TOKEN = /\[[^[\]]*\]/g;

/** Characters allowed inside a string besides printable text. */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

/** STBL stores each entry's length in a 16-bit field. */
export const MAX_ENTRY_BYTES = 0xffff;

export interface SyntaxAnalysis {
  /** Simple substitutions we preserve, in order of appearance (may repeat). */
  placeholders: string[];
  /** Structural tokens we preserve: escapes and bracketed codes, in order. */
  tokens: string[];
  /** Why this string cannot be validated, when it cannot be. */
  problem?: string;
}

/**
 * Finds the syntax in a string, and reports the first thing about it that this
 * phase does not handle.
 */
export function analyzeSyntax(text: string): SyntaxAnalysis {
  const placeholders: string[] = [];
  const tokens: string[] = [];
  let index = 0;

  while (index < text.length) {
    const open = text.indexOf("{", index);
    if (open < 0) break;
    const close = text.indexOf("}", open + 1);
    if (close < 0) {
      return { placeholders, tokens, problem: `an opening "{" with no closing "}"` };
    }
    const expression = text.slice(open, close + 1);
    if (expression.slice(1, -1).includes("{")) {
      return { placeholders, tokens, problem: `nested braces in ${JSON.stringify(expression)}` };
    }
    const match = SIMPLE_PLACEHOLDER.exec(expression);
    if (!match) {
      return {
        placeholders,
        tokens,
        problem: `the expression ${JSON.stringify(expression)}, which this phase does not handle`,
      };
    }
    if (!SUPPORTED_VALUE_NAMES.has(match[1]!)) {
      return {
        placeholders,
        tokens,
        problem:
          `the expression ${JSON.stringify(expression)}: "${match[1]}" is not one of the value names ` +
          `this phase can preserve safely`,
      };
    }
    placeholders.push(expression);
    index = close + 1;
  }

  // Every "}" in the string must have been consumed as part of a matched
  // expression; a leftover one is a stray closing brace.
  const closingBraces = text.split("}").length - 1;
  if (closingBraces !== placeholders.length) {
    return { placeholders, tokens, problem: `a closing "}" with no opening "{"` };
  }

  if (MARKUP.test(text)) {
    const found = MARKUP.exec(text)![0];
    return {
      placeholders,
      tokens,
      problem: `markup such as ${JSON.stringify(found)}, whose reflow rules are not handled yet`,
    };
  }

  for (const match of text.matchAll(ESCAPE)) tokens.push(match[0]);
  for (const match of text.matchAll(BRACKET_TOKEN)) tokens.push(match[0]);

  return { placeholders, tokens };
}

export function countItems(items: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

export function sameMultiset(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, count] of a) {
    if (b.get(key) !== count) return false;
  }
  return true;
}

function describeCounts(counts: Map<string, number>): string {
  return (
    [...counts.entries()]
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([item, count]) => (count > 1 ? `${item}×${count}` : item))
      .join(", ") || "none"
  );
}

export function findInvalidCharacters(text: string): string | undefined {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return `unpaired high surrogate at index ${i}`;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return `unpaired low surrogate at index ${i}`;
    }
    if (code === 0x7f) return `DEL (U+007F) at index ${i}`;
    if (code < 0x20 && !ALLOWED_CONTROL.has(code)) {
      return `control character U+${code.toString(16).toUpperCase().padStart(4, "0")} at index ${i}`;
    }
  }
  return undefined;
}

/** Leading and trailing whitespace runs, which must survive translation intact. */
export function edgeWhitespace(text: string): { leading: string; trailing: string } {
  return {
    leading: /^\s*/.exec(text)?.[0] ?? "",
    trailing: /\s*$/.exec(text)?.[0] ?? "",
  };
}

export interface TranslationMetadata {
  state: TranslationState;
  /** SHA-256 of the English source text this translation was made from. */
  sourceHash: string;
  updatedAt: string;
  origin?: "human" | "machine";
  note?: string;
}

export interface ValidateInput {
  sourceText: string;
  /** SHA-256 recorded when the catalog was extracted. */
  catalogSourceHash: string;
  /** SHA-256 recorded when the translation was written. */
  metadataSourceHash: string | undefined;
  text: string | undefined;
  state: TranslationState | undefined;
  includeUnreviewed: boolean;
  metadataMalformed?: string;
  ambiguous?: boolean;
}

/**
 * Returns every reason this translation must not be applied. An empty array
 * means it may be applied.
 */
export function validateTranslation(input: ValidateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { sourceText, text } = input;

  if (input.ambiguous) {
    issues.push({
      code: "ambiguous-occurrence",
      message:
        "this string key appears more than once in its table, so a translation cannot be " +
        "addressed to a single entry",
    });
  }

  if (input.metadataMalformed) {
    issues.push({ code: "malformed-metadata", message: input.metadataMalformed });
  } else if (!input.metadataSourceHash) {
    issues.push({
      code: "missing-metadata",
      message: "no translation metadata (source hash, state) was recorded for this string",
    });
  } else if (input.metadataSourceHash !== input.catalogSourceHash) {
    issues.push({
      code: "stale-source",
      message:
        `translated from a different source: metadata records ${input.metadataSourceHash.slice(0, 12)}… ` +
        `but the catalog's English text hashes to ${input.catalogSourceHash.slice(0, 12)}…`,
    });
  }

  if (input.state !== undefined && input.state !== "reviewed" && !input.includeUnreviewed) {
    issues.push({
      code: "unreviewed",
      message:
        `state is "${input.state}"; only reviewed translations are applied without ` +
        `--include-unreviewed`,
    });
  }

  if (text === undefined) {
    issues.push({
      code: "missing-text",
      message: "this occurrence ID has metadata but no text in the translations file",
    });
    return issues;
  }

  const invalidTranslation = findInvalidCharacters(text);
  if (invalidTranslation) {
    issues.push({ code: "invalid-text", message: `translation contains ${invalidTranslation}` });
  }

  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_ENTRY_BYTES) {
    issues.push({
      code: "too-long-utf8",
      message:
        `translation is ${byteLength} UTF-8 bytes; a string table entry holds at most ${MAX_ENTRY_BYTES}`,
    });
  }

  if (text.trim() === "" && sourceText.trim() !== "") {
    issues.push({
      code: "empty-replacement",
      message: "translation is empty (or whitespace only) but the English text is not",
    });
  }

  if (text === sourceText) {
    // Covers the English copied verbatim, and also the empty-to-empty case:
    // neither changes a single byte of the emitted table, so neither counts as a
    // translation (and a table whose only "change" is this must not be emitted).
    issues.push({
      code: "identical-to-source",
      message:
        sourceText === ""
          ? "the English text is empty and so is the translation, so this changes nothing"
          : "translation is the English text verbatim, so it is not counted as an Estonian " +
            "translation (the emitted table already falls back to English)",
    });
  }

  const sourceSyntax = analyzeSyntax(sourceText);
  const translationSyntax = analyzeSyntax(text);
  if (sourceSyntax.problem) {
    issues.push({
      code: "unsupported-syntax",
      message: `English text contains ${sourceSyntax.problem}; left in English for now`,
    });
  } else if (translationSyntax.problem) {
    issues.push({
      code: "unsupported-syntax",
      message: `translation contains ${translationSyntax.problem}; left in English for now`,
    });
  } else {
    const sourcePlaceholders = countItems(sourceSyntax.placeholders);
    const translationPlaceholders = countItems(translationSyntax.placeholders);
    if (!sameMultiset(sourcePlaceholders, translationPlaceholders)) {
      issues.push({
        code: "placeholder-mismatch",
        message:
          `substitutions differ: English has [${describeCounts(sourcePlaceholders)}], ` +
          `translation has [${describeCounts(translationPlaceholders)}] (each must appear as often, ` +
          `in any order)`,
      });
    }

    const sourceTokens = countItems(sourceSyntax.tokens);
    const translationTokens = countItems(translationSyntax.tokens);
    if (!sameMultiset(sourceTokens, translationTokens)) {
      issues.push({
        code: "token-mismatch",
        message:
          `line breaks and inline codes differ: English has [${describeCounts(sourceTokens)}], ` +
          `translation has [${describeCounts(translationTokens)}]`,
      });
    }
  }

  const sourceEdges = edgeWhitespace(sourceText);
  const translationEdges = edgeWhitespace(text);
  if (
    translationEdges.leading !== sourceEdges.leading ||
    translationEdges.trailing !== sourceEdges.trailing
  ) {
    issues.push({
      code: "edge-whitespace-mismatch",
      message:
        `surrounding whitespace must match exactly: English is ${JSON.stringify(sourceEdges)}, ` +
        `translation is ${JSON.stringify(translationEdges)}`,
    });
  }

  return issues;
}
