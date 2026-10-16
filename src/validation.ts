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
  | "markup-mismatch"
  | "branch-mismatch"
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
 * Every runtime value name the shipped text uses - 44 names over 75,340 strings,
 * measured, not guessed: `{0.SimFirstName}` 9,844 times, `{0.String}` 2,263,
 * `{0.Number}` 860, down to `{0.GhostPowersPoints}` once.
 *
 * A runtime value is a substitution the game fills at play time. Preserving it
 * verbatim is the only verifiable choice: we cannot know what it renders, and text
 * invented for it would be discarded. (A lowercase `{0.string}` appears 3 times
 * and is not in this list on purpose - it stays preserved as an unknown value.)
 */
const VALUE_NAMES = new Set([
  "SimFirstName",
  "SimLastName",
  "SimName",
  "SimFirstNameList",
  "SimNameWithPrefix",
  "SimFirstNameWithPrefix",
  "SimNameAndPronouns",
  "String",
  "Number",
  "Money",
  "Currency",
  "Points",
  "PerkPoints",
  "ClubPoints",
  "DynastyPoints",
  "OccultPoints",
  "NobilityPoints",
  "GhostPowersPoints",
  "SmallBusinessPoints",
  "FamePoints",
  "Influence",
  "GalacticCredits",
  "RecyclingBits",
  "RecyclingPieces",
  "UnitName",
  "ObjectName",
  "ObjectCatalogName",
  "ObjectDescription",
  "ObjectCatalogDescription",
  "TimeShort",
  "TimeLong",
  "Timespan",
  "TimespanShort",
  "TimespanShortCondensed",
  "DateShort",
  "DateLong",
  "DayOfWeekShort",
  "DayOfWeekLong",
  "SimPronounSubjective",
  "SimPronounObjective",
  "SimPronounPossessiveDependent",
  "SimPronounPossessiveIndependent",
  "SimPronounReflexive",
  "SimPronouns",
]);

/**
 * Values whose rendered form is a word in the game's own language rather than a
 * name or a number: the pronouns, and a name with its honorific. The game would
 * insert the English word, so a translation may - and for pronouns normally
 * should - replace the expression with the Estonian one. EA's own Finnish does
 * exactly that: `{0.SimPronounSubjective|xxUpper} can also Mentor others` becomes
 * `Hän voi myös opastaa muita`.
 *
 * Dropping is optional, never required, and never applies to a value that carries
 * data (a number, a name, a date): those are preserved as a multiset.
 */
const LANGUAGE_DEPENDENT_VALUE = /^SimPronoun|^SimNameAndPronouns$/;

/** `{0.SimFirstName}`, optionally with a modifier such as `|xxUpper`. */
const VALUE_EXPRESSION = /^\{\d+\.([A-Za-z][A-Za-z0-9_]*)(\|[A-Za-z][A-Za-z0-9_]*)?\}$/;

/**
 * A variant selector: `{M0.his}`, `{F.her}`, `{S2.…}`, `{P0.…}`, `{T1.Mess
 * Around}`, `{DAE1.WooHoo}`. The letters choose the variant - gender (M/F/N),
 * number (S/P), or a naming style (T/DAE) - and the content is either literal text
 * to translate or the name of a value to leave alone. Measured shapes, and what
 * EA's Finnish did with each:
 *
 *   {M0.his}{F0.her}   -> deleted, the sentence restructured (Finnish has no gender)
 *   {S0.Pack}{P0.Packs}-> {S0.paketti}{P0.paketit}, translated inside each branch
 *   {T1.Mess Around}   -> {T1.vehtailu}, literal text, translated and even re-cased
 *   {P0.ObjectName}    -> kept verbatim: the content is a value name, not text
 *   {S2.{S3.ObjectName}} -> kept verbatim: branches nest
 */
const BRANCH_EXPRESSION = /^\{([A-Z]{1,5})(\d*)\./;

/** Letters selecting a grammatical gender. Estonian has none, so these may go. */
const GENDER_LETTERS = new Set(["M", "F", "N"]);

/**
 * The markup tags the shipped text uses: b, i, u, br, p, ul, ol, li, span, font,
 * a. Anything else stays deferred. EA's Finnish keeps these identical in 1,300 of
 * 1,446 comparable strings, so preserving them exactly is the verifiable rule;
 * the 146 exceptions (a localized legal URL, a dropped `<span class="money">`)
 * are refused rather than guessed at.
 */
const ALLOWED_TAGS = new Set(["b", "i", "u", "br", "p", "ul", "ol", "li", "span", "font", "a"]);

/** `<b>`, `</b>`, `<span class="pink">`, `<font color="#EC262E">`. */
const MARKUP_TAG = /<\/?([A-Za-z][A-Za-z0-9]*)(?:\s+[^<>]*)?>/g;

/** Escapes such as `\n` and `\s`, stored as two characters in the string table. */
const ESCAPE = /\\[A-Za-z]/g;

/** Inline codes such as `[PH]`, `[V]`, `[DNT]`. */
const BRACKET_TOKEN = /\[[^[\]]*\]/g;

/** Characters allowed inside a string besides printable text. */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

/** STBL stores each entry's length in a 16-bit field. */
export const MAX_ENTRY_BYTES = 0xffff;

export interface VariantBranch {
  /** As written: "M0", "F", "S2", "DAE1". */
  selector: string;
  /** The variant letters, e.g. "M", "DAE". */
  letters: string;
  /** The group index, e.g. "0"; empty when the source writes none. */
  index: string;
}

export interface SyntaxAnalysis {
  /** Values that must appear as often in the translation (`{0.SimFirstName}`). */
  placeholders: string[];
  /** Values the game renders, and whether the translation may drop them. */
  runtimeValues: { expression: string; droppable: boolean }[];
  /** Variant branches, in the order they appear. */
  branches: VariantBranch[];
  /** Value names and nested expressions inside branch content: leave verbatim. */
  branchValues: string[];
  /** Markup tags, preserved as a multiset. */
  tags: string[];
  /** Structural tokens we preserve: escapes and bracketed codes, in order. */
  tokens: string[];
  /** Why this string cannot be validated, when it cannot. */
  problem?: string;
}

/** The index of the "}" closing the "{" at `open`, respecting nesting; -1 if none. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function isGenderBranch(branch: VariantBranch): boolean {
  return [...branch.letters].every((letter) => GENDER_LETTERS.has(letter));
}

/** Classifies one `{...}` expression, recursing into branch content. */
function classifyExpression(expression: string, out: SyntaxAnalysis): string | undefined {
  const branch = BRANCH_EXPRESSION.exec(expression);
  if (branch) {
    const letters = branch[1]!;
    const index = branch[2]!;
    const content = expression.slice(branch[0].length, -1);
    out.branches.push({ selector: letters + index, letters, index });

    // Content may hold nested expressions - `{S2.{S3.ObjectName}}` - which the
    // game resolves; the translator must leave them exactly as they are.
    let cursor = 0;
    for (;;) {
      const at = content.indexOf("{", cursor);
      if (at < 0) break;
      const end = matchBrace(content, at);
      if (end < 0) return `nested braces in ${JSON.stringify(expression)}`;
      const nested = content.slice(at, end + 1);
      out.branchValues.push(nested);
      const problem = classifyExpression(nested, out);
      if (problem) return problem;
      cursor = end + 1;
    }
    if (content.replace(/\{[^{}]*\}/g, "").includes("}")) {
      return `a closing "}" with no opening "{" in ${JSON.stringify(expression)}`;
    }
    // Content that is the name of a value is a reference, not text. Measured:
    // `{P0.ObjectName}` stays `{P0.ObjectName}` in Finnish, while `{S0.Pack}`
    // becomes `{S0.paketti}`.
    if (VALUE_NAMES.has(content)) out.branchValues.push(content);
    return undefined;
  }

  const value = VALUE_EXPRESSION.exec(expression);
  if (!value) {
    return `the expression ${JSON.stringify(expression)}, which this phase does not handle`;
  }
  const name = value[1]!;
  if (VALUE_NAMES.has(name)) {
    if (LANGUAGE_DEPENDENT_VALUE.test(name)) {
      out.runtimeValues.push({ expression, droppable: true });
    } else {
      out.placeholders.push(expression);
    }
    return undefined;
  }
  // A value we have not catalogued: preserved, never dropped, unless its name
  // marks it as language-dependent (a pronoun we have not seen before).
  out.runtimeValues.push({ expression, droppable: LANGUAGE_DEPENDENT_VALUE.test(name) });
  return undefined;
}

/**
 * Finds the syntax in a string, and reports the first thing about it that this
 * phase does not handle.
 */
export function analyzeSyntax(text: string): SyntaxAnalysis {
  const out: SyntaxAnalysis = {
    placeholders: [],
    runtimeValues: [],
    branches: [],
    branchValues: [],
    tags: [],
    tokens: [],
  };

  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{", index);
    const stray = text.indexOf("}", index);
    // A "}" with no "{" before it was not consumed by any expression.
    if (stray >= 0 && (open < 0 || stray < open)) {
      return { ...out, problem: `a closing "}" with no opening "{"` };
    }
    if (open < 0) break;
    const close = matchBrace(text, open);
    if (close < 0) return { ...out, problem: `an opening "{" with no closing "}"` };
    const problem = classifyExpression(text.slice(open, close + 1), out);
    if (problem) return { ...out, problem };
    index = close + 1;
  }

  for (const match of text.matchAll(MARKUP_TAG)) {
    const name = match[1]!.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) {
      return { ...out, problem: `the markup tag ${JSON.stringify(match[0])}, which this phase does not handle` };
    }
    out.tags.push(match[0]);
  }

  for (const match of text.matchAll(ESCAPE)) out.tokens.push(match[0]);
  for (const match of text.matchAll(BRACKET_TOKEN)) out.tokens.push(match[0]);

  return out;
}

/**
 * Whether the translation's variant skeleton can be accepted, and why not when it
 * cannot. The selectors must appear in the same order; a *complete* gender group
 * may be dropped, because Estonian has no grammatical gender and EA's Finnish
 * deletes them too - but half a group would leave one gender with no text at all.
 */
export function branchProblem(source: VariantBranch[], translation: VariantBranch[]): string | undefined {
  const runs = (list: VariantBranch[]): VariantBranch[][] => {
    const out: VariantBranch[][] = [];
    for (const branch of list) {
      const last = out[out.length - 1];
      const joins =
        last !== undefined &&
        isGenderBranch(branch) &&
        last.every(isGenderBranch) &&
        last[0]!.index === branch.index;
      if (joins) last!.push(branch);
      else out.push([branch]);
    }
    return out;
  };
  const sourceRuns = runs(source);
  const translationRuns = runs(translation);
  const labels = (list: VariantBranch[]) => list.map((branch) => `{${branch.selector}.…}`).join("");

  let i = 0;
  let j = 0;
  while (i < sourceRuns.length && j < translationRuns.length) {
    const expected = sourceRuns[i]!;
    const found = translationRuns[j]!;
    if (
      expected.length === found.length &&
      expected.every((branch, k) => branch.selector === found[k]!.selector)
    ) {
      i += 1;
      j += 1;
      continue;
    }
    if (isGenderBranch(found[0]!) && expected.every(isGenderBranch)) {
      return (
        `a gender variant was dropped only partly: the English has ${labels(expected)} where the ` +
        `translation has ${labels(found)}; the whole group must go, or none of it`
      );
    }
    if (expected.every(isGenderBranch)) {
      i += 1;
      continue;
    }
    return `variant branches differ: the English has ${labels(expected)} where the translation has ${found.length ? labels(found) : "nothing"}`;
  }
  for (; i < sourceRuns.length; i += 1) {
    const expected = sourceRuns[i]!;
    if (!expected.every(isGenderBranch)) {
      return `the translation drops ${labels(expected)}, which is not a gender variant and must be kept`;
    }
  }
  if (j < translationRuns.length) {
    return `the translation has extra variant branches (${labels(translationRuns.slice(j).flat())}) that the English does not have`;
  }
  return undefined;
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
    // What the translator must reproduce exactly: every value that carries data,
    // every value reference inside a branch, and every markup tag.
    const required = (syntax: SyntaxAnalysis) =>
      countItems([
        ...syntax.placeholders,
        ...syntax.runtimeValues.filter((value) => !value.droppable).map((value) => value.expression),
        ...syntax.branchValues,
      ]);
    const sourceRequired = required(sourceSyntax);
    const translationRequired = required(translationSyntax);
    if (!sameMultiset(sourceRequired, translationRequired)) {
      issues.push({
        code: "placeholder-mismatch",
        message:
          `substitutions differ: English has [${describeCounts(sourceRequired)}], ` +
          `translation has [${describeCounts(translationRequired)}] (each must appear as often, ` +
          `in any order; a runtime value may be dropped only when it is a pronoun)`,
      });
    }

    // A pronoun may be replaced by a word, but never added or repeated.
    const droppable = (syntax: SyntaxAnalysis) => {
      const counts = new Map<string, number>();
      for (const value of syntax.runtimeValues) {
        if (!value.droppable) continue;
        counts.set(value.expression, (counts.get(value.expression) ?? 0) + 1);
      }
      return counts;
    };
    const sourceDroppable = droppable(sourceSyntax);
    for (const [expression, count] of droppable(translationSyntax)) {
      if (count > (sourceDroppable.get(expression) ?? 0)) {
        issues.push({
          code: "placeholder-mismatch",
          message: `the translation adds ${expression}, which the English text does not have`,
        });
        break;
      }
    }

    const sourceTags = countItems(sourceSyntax.tags);
    const translationTags = countItems(translationSyntax.tags);
    if (!sameMultiset(sourceTags, translationTags)) {
      issues.push({
        code: "markup-mismatch",
        message:
          `markup differs: English has [${describeCounts(sourceTags)}], ` +
          `translation has [${describeCounts(translationTags)}] (every tag must be kept exactly as written)`,
      });
    }

    const branchIssue = branchProblem(sourceSyntax.branches, translationSyntax.branches);
    if (branchIssue) {
      issues.push({ code: "branch-mismatch", message: branchIssue });
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
