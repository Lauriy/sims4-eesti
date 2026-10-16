/**
 * Translation storage: the Estonian text and its review metadata.
 *
 * Text lives in a plain `occurrenceId → text` JSON mapping so it can be handed to
 * an ordinary localisation platform later without an adapter. Everything a
 * reviewer needs to know *about* a translation (which English text it was made
 * from, whether a human reviewed it) lives in a separate metadata file.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Catalog } from "./catalog.js";
import { findOccurrence, loadCatalog, writeJsonAtomic } from "./catalog.js";
import {
  TRANSLATION_STATES,
  isTranslationState,
  validateTranslation,
  type TranslationMetadata,
  type TranslationState,
  type ValidationIssue,
} from "./validation.js";

export const TRANSLATIONS_SCHEMA_VERSION = 1;

/** `occurrenceId → Estonian text`. */
export type TranslationMap = Record<string, string>;

export interface MetadataFile {
  schemaVersion: number;
  targetLocale: string;
  /** `occurrenceId → metadata` */
  entries: Record<string, TranslationMetadata>;
}

export function emptyMetadata(): MetadataFile {
  return { schemaVersion: TRANSLATIONS_SCHEMA_VERSION, targetLocale: "et-EE", entries: {} };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadTranslations(path: string): TranslationMap {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = readJson(path);
  } catch (error) {
    throw new Error(`Translations file "${path}" is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Translations file "${path}" must be a JSON object mapping occurrence IDs to text.`
    );
  }
  const map: TranslationMap = {};
  for (const [occurrenceId, text] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof text !== "string") {
      throw new Error(
        `Translations file "${path}" has a non-string value for "${occurrenceId}".`
      );
    }
    map[occurrenceId] = text;
  }
  return map;
}

export function loadMetadata(path: string): MetadataFile {
  if (!existsSync(path)) return emptyMetadata();
  let parsed: unknown;
  try {
    parsed = readJson(path);
  } catch (error) {
    throw new Error(`Metadata file "${path}" is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Metadata file "${path}" must be a JSON object.`);
  }
  const file = parsed as Partial<MetadataFile>;
  if (file.schemaVersion !== TRANSLATIONS_SCHEMA_VERSION) {
    throw new Error(
      `Metadata file "${path}" has schema version ${String(file.schemaVersion)}; this build of the ` +
        `tool writes version ${TRANSLATIONS_SCHEMA_VERSION}.`
    );
  }
  if (file.entries === null || typeof file.entries !== "object") {
    throw new Error(`Metadata file "${path}" is missing its "entries" object.`);
  }
  return {
    schemaVersion: TRANSLATIONS_SCHEMA_VERSION,
    targetLocale: typeof file.targetLocale === "string" ? file.targetLocale : "et-EE",
    entries: file.entries,
  };
}

export function saveTranslations(path: string, translations: TranslationMap): void {
  const sorted: TranslationMap = {};
  for (const occurrenceId of Object.keys(translations).sort()) {
    sorted[occurrenceId] = translations[occurrenceId]!;
  }
  writeJsonAtomic(path, sorted);
}

export function saveMetadata(path: string, metadata: MetadataFile): void {
  const entries: Record<string, TranslationMetadata> = {};
  for (const occurrenceId of Object.keys(metadata.entries).sort()) {
    entries[occurrenceId] = metadata.entries[occurrenceId]!;
  }
  writeJsonAtomic(path, { ...metadata, entries });
}

/**
 * Explains why a metadata entry cannot be trusted, or returns undefined when it
 * is well formed. Never repairs silently.
 */
export function describeMalformedMetadata(entry: TranslationMetadata | undefined): string | undefined {
  if (!entry) return "no metadata entry";
  if (!isTranslationState(entry.state)) {
    return `unknown state ${JSON.stringify(entry.state)} (expected one of ${TRANSLATION_STATES.join(", ")})`;
  }
  if (typeof entry.sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(entry.sourceHash)) {
    return "source hash is missing or is not a 64-character lowercase SHA-256";
  }
  if (typeof entry.updatedAt !== "string" || Number.isNaN(Date.parse(entry.updatedAt))) {
    return "updatedAt is missing or is not an ISO timestamp";
  }
  return undefined;
}

export interface SetTranslationOptions {
  catalogPath: string;
  translationsPath: string;
  metadataPath: string;
  occurrenceId: string;
  text: string;
  state: TranslationState;
  /** Who produced the text. Machine output must never be recorded as human work. */
  origin: "human" | "machine";
  /** Allow overwriting a translation whose state is "reviewed". */
  forceOverwriteReviewed: boolean;
  note?: string;
}

export interface SetTranslationResult {
  occurrenceId: string;
  sourceText: string;
  previousState: TranslationState | undefined;
  state: TranslationState;
  origin: "human" | "machine";
  /** Validation problems that will keep this out of a build until fixed. */
  issues: ValidationIssue[];
  warning?: string;
}

/**
 * Records one translation as a draft (or another explicit state) together with
 * the hash of the English text it was made from.
 */
export function setTranslation(options: SetTranslationOptions): SetTranslationResult {
  const catalog: Catalog = loadCatalog(options.catalogPath);
  const occurrence = findOccurrence(catalog, options.occurrenceId);
  if (!occurrence) {
    throw new Error(
      `Unknown occurrence ID "${options.occurrenceId}". ` +
        `Use "search" against "${options.catalogPath}" and copy an ID from its output.`
    );
  }
  if (occurrence.ambiguous) {
    throw new Error(
      `"${options.occurrenceId}" is ambiguous: its string key is used by more than one entry in ` +
        `its table, so text cannot be addressed to a single entry.`
    );
  }

  const translations = loadTranslations(options.translationsPath);
  const metadata = loadMetadata(options.metadataPath);
  const previous = metadata.entries[options.occurrenceId];

  if (previous?.state === "reviewed" && !options.forceOverwriteReviewed) {
    throw new Error(
      `"${options.occurrenceId}" is already reviewed and will not be overwritten automatically. ` +
        `Re-run with --force-overwrite-reviewed if that is really what you want.`
    );
  }

  const sourceHash = occurrence.sourceHash;
  const issues = validateTranslation({
    sourceText: occurrence.sourceText,
    catalogSourceHash: sourceHash,
    metadataSourceHash: sourceHash,
    text: options.text,
    state: options.state,
    includeUnreviewed: true,
  });

  // Metadata is written *first*, and the text second. The two files cannot be
  // updated in one atomic step, so the order decides which half-written state is
  // possible, and only one of them is safe: if the text landed first and the
  // metadata write then failed, the new, unreviewed text would sit under the old
  // entry's state — which, for an entry that used to be `reviewed`, means a
  // strict build would apply unreviewed text. With this order, a failure leaves
  // the old text in place, which is always safe.
  metadata.entries[options.occurrenceId] = {
    state: options.state,
    sourceHash,
    updatedAt: new Date().toISOString(),
    origin: options.origin,
    ...(options.note ? { note: options.note } : {}),
  };
  saveMetadata(options.metadataPath, metadata);
  translations[options.occurrenceId] = options.text;
  saveTranslations(options.translationsPath, translations);

  // Read both files back and confirm they agree before reporting success.
  const readBack = loadTranslations(options.translationsPath)[options.occurrenceId];
  const readBackState = loadMetadata(options.metadataPath).entries[options.occurrenceId]?.state;
  if (readBack !== options.text || readBackState !== options.state) {
    throw new Error(
      `"${options.occurrenceId}" could not be recorded consistently: the text or metadata file on ` +
        `disk does not match what was just written (text ${readBack === options.text ? "ok" : "MISMATCH"}, ` +
        `state ${readBackState === options.state ? "ok" : `MISMATCH (${String(readBackState)})`}). ` +
        `Re-run "search" and check both files before rebuilding; nothing was applied.`
    );
  }

  const warning =
    issues.length > 0
      ? `Recorded, but it will be left in English at build time until these are fixed: ` +
        issues.map((issue) => `${issue.code} (${issue.message})`).join("; ")
      : undefined;

  return {
    occurrenceId: options.occurrenceId,
    sourceText: occurrence.sourceText,
    previousState: previous?.state,
    state: options.state,
    origin: options.origin,
    issues,
    ...(warning ? { warning } : {}),
  };
}
