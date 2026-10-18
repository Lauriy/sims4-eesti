#!/usr/bin/env node
/**
 * One entry point for the whole workflow: extract → search → set → build → deploy.
 *
 * Every command takes explicit paths; nothing is discovered by scanning the disk,
 * and no command touches the game installation or your saves.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildPackage, defaultManifestPath, BuildError } from "./build.js";
import { extractCatalog, loadCatalog, searchCatalog, writeJsonAtomic } from "./catalog.js";
import { coverageByPackage, scanInstallation } from "./scan.js";
import { exportBatches, importTranslations, translationStats } from "./translate.js";
import { mergeCatalogs } from "./merge.js";
import { checkGlossary, loadGlossary, mergeTermReports } from "./glossary.js";
import { occurrenceIdsOf, rankStrings } from "./rank.js";
import { describeWave, inspectWave } from "./wave.js";
import { findForeignForms } from "./lint.js";
import { loadReferenceFiles } from "./references.js";
import { deploy, DeployError, ARTIFACT_NAME } from "./deploy.js";
import { loadMetadata, loadTranslations, setTranslation } from "./translations.js";
import { analyzeSyntax, isTranslationState } from "./validation.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;

type Config = {
  catalogPath: string;
  translationsPath: string;
  metadataPath: string;
  outPackage: string;
  modsDir: string | null;
  deployStatePath: string;
};

const DEFAULT_CONFIG: Config = {
  catalogPath: "work/base/catalog.json",
  translationsPath: "translations/et-EE.json",
  metadataPath: "translations/metadata.json",
  outPackage: "dist/!Sims4_Eesti.package",
  modsDir: null,
  deployStatePath: "work/deploy-state.json",
};

const USAGE = `sims4-eesti — unofficial Estonian text mod builder for The Sims 4

Usage: npm run cli -- <command> [options]

Commands:
  extract   Read one English .package and write a catalog of its strings
  scan      Find every string table installed and catalog them all at once
  coverage  Report how many strings each package contributes
  merge     Combine catalogs into one (e.g. the game's and the Mods folder's)
  translate-export  Write batches of untranslated strings for any engine to fill in
  translate-import  Read filled-in batches back, validating every entry
  translate-stats   Report how much of each package is translated
  search    Find English strings in a catalog and print their occurrence IDs
  set       Record an Estonian translation for one occurrence ID
  build     Write a package containing the validated translations
  deploy    Copy the built package into a Mods folder

Run "npm run cli -- <command> --help" for the options of one command.

Typical session (paths are examples; use your own):
  npm run cli -- extract --package "C:\\Program Files (x86)\\Steam\\steamapps\\common\\The Sims 4\\Data\\Client\\Strings_ENG_US.package" --out work/base
  npm run cli -- search --catalog work/base/catalog.json --text "New Game"
  npm run cli -- set --catalog work/base/catalog.json --id "<ID printed by search>" --text "Uus mäng"
  npm run cli -- build --catalog work/base/catalog.json --include-unreviewed --out dist/!Sims4_Eesti.package
  npm run cli -- deploy --file dist/!Sims4_Eesti.package --mods-dir "C:\\Users\\you\\Documents\\Electronic Arts\\The Sims 4\\Mods" --dry-run

Options are read from config.json in the working directory when it exists
(see config.example.json). Command-line flags always win.`;

interface FlagSpec {
  /** true when the flag takes no value. */
  boolean?: boolean;
  help: string;
}

const COMMON_CONFIG_FLAG: Record<string, FlagSpec> = {
  config: { help: "Read defaults from this JSON file instead of ./config.json" },
};

const COMMANDS: Record<string, { summary: string; flags: Record<string, FlagSpec> }> = {
  extract: {
    summary: "Read one English .package and write a catalog of its strings",
    flags: {
      package: { help: "Path to the English .package to read (required)" },
      out: { help: "Directory for catalog.json and input.manifest.json (default work/base)" },
      "pack-label": { help: "Label used in occurrence IDs (default BASE)" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  search: {
    summary: "Find English strings in a catalog and print their occurrence IDs",
    flags: {
      catalog: { help: "Path to catalog.json" },
      text: { help: "Substring to look for in the English text (required)" },
      limit: { help: "Maximum number of matches to print (default 50)" },
      exact: { boolean: true, help: "Match the whole string instead of a substring" },
      "case-sensitive": { boolean: true, help: "Do not ignore case" },
      "translatable-only": {
        boolean: true,
        help: "Hide strings whose syntax this tool cannot validate yet",
      },
      translations: { help: "Also show the current Estonian text from this file" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  set: {
    summary: "Record an Estonian translation for one occurrence ID",
    flags: {
      catalog: { help: "Path to catalog.json" },
      id: { help: "Occurrence ID printed by search (required)" },
      text: { help: "Estonian text to record (required)" },
      state: { help: "draft | machine | reviewed | needs_review (default draft)" },
      origin: {
        help: "human | machine — who produced the text (default human); machine output is never " +
          "recorded as human work",
      },
      note: { help: "Optional note stored with the metadata" },
      "force-overwrite-reviewed": {
        boolean: true,
        help: "Allow replacing a translation that is already marked reviewed",
      },
      translations: { help: "Translations file to update" },
      metadata: { help: "Metadata file to update" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  scan: {
    summary: "Find every string table the game has installed and catalog them all",
    flags: {
      "game-root": { help: "The Sims 4 installation folder (required)" },
      out: { help: "Directory for install-index.json and catalog.json (required)" },
      "large-file-mb": {
        help:
          "Skip packages at least this large unless named like strings; 0 disables. " +
          "Default: 50 for a game installation, 0 elsewhere (a Mods folder needs 0)",
      },
      "include-delta": { boolean: true, help: "Read Delta (SDX) files too; precedence is unsettled" },
      "include-non-english": {
        boolean: true,
        help: "Read tables for languages other than English (a mod repeats its text per locale)",
      },
      ...COMMON_CONFIG_FLAG,
    },
  },
  merge: {
    summary: "Combine catalogs into one (e.g. the game's and the Mods folder's)",
    flags: {
      catalogs: { help: "Catalogs to merge, comma-separated (required)" },
      out: { help: "Where to write the merged catalog.json (required)" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  coverage: {
    summary: "Report how many strings each package contributes",
    flags: {
      catalog: { help: "Path to a catalog.json from extract or scan" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  rank: {
    summary: "Order untranslated strings by how likely a player is to see them",
    flags: {
      catalog: { help: "Path to catalog.json" },
      translations: { help: "Translations file, for what to skip and what to check against" },
      glossary: { help: "Glossary file for the core-vocabulary bonus (default glossary.json)" },
      packages: { help: "Only these package labels, comma-separated (e.g. BASE)" },
      top: { help: "How many texts to select (default 1000)" },
      sample: { help: "How many entries to print as a sample (default 20)" },
      out: { help: "Write the selection as JSON, for translate-export --ids" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  "translate-export": {
    summary: "Write JSON batches of untranslated strings for any engine to fill in",
    flags: {
      catalog: { help: "Path to catalog.json" },
      out: { help: "Directory for the batch files and INSTRUCTIONS.md (required)" },
      packages: { help: "Only these package labels, comma-separated (e.g. SP06,SP08)" },
      "exclude-packages": { help: "Skip these package labels, comma-separated (e.g. BASE)" },
      "batch-size": { help: "Strings per batch file (default 400)" },
      "dedupe-texts": {
        boolean: true,
        help: "One entry per distinct English text; the other keys are filled in from it at import",
      },
      "target-locale": { help: "Locale recorded in the batches (default et-EE); a fork for another language sets its own" },
      "language-name": { help: "Target language as the translator should read it (default Estonian)" },
      ids: { help: "Only the occurrence ids in this JSON file (a rank selection, or a plain array)" },
      limit: { help: "Stop after this many strings in total" },
      references: {
        help:
          "Files or directories holding reference translations, comma-separated " +
          "(e.g. work/reference-fi). Packages' own sibling languages are used automatically",
      },
      "max-reference-languages": { help: "Reference languages per entry (default 3)" },
      translations: { help: "Translations file, to skip what is already done" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  "translate-import": {
    summary: "Read filled-in batches back, validating every entry",
    flags: {
      catalog: { help: "Path to catalog.json" },
      in: { help: "Files or directories to read, comma-separated (required)" },
      state: { help: "State to record: draft | machine | reviewed | needs_review (default machine)" },
      origin: { help: "human | machine (default machine)" },
      "force-overwrite-reviewed": {
        boolean: true,
        help: "Also replace entries already marked reviewed",
      },
      translations: { help: "Translations file to update" },
      metadata: { help: "Metadata file to update" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  lint: {
    summary: "Find Estonian carrying forms Estonian does not build (e.g. copied Finnish)",
    flags: {
      catalog: { help: "Path to catalog.json" },
      translations: { help: "Translations file to check" },
      references: {
        help: "Reference packages, comma-separated (e.g. work/reference-fi): a hit that also appears there is marked as copied",
      },
      limit: { help: "Show at most this many findings (default 40)" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  wave: {
    summary: "Report the state of a translation wave: answered, accepted, rejected, imported",
    flags: {
      catalog: { help: "Path to catalog.json" },
      in: { help: "Directory of batch files (and their .translated.json answers)" },
      translations: { help: "Translations file, to report what is already imported" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  "glossary-check": {
    summary: "Find strings that ignore the agreed terminology",
    flags: {
      catalog: { help: "Path to catalog.json" },
      glossary: { help: "Glossary file to check against (default glossary.json)" },
      translations: { help: "Translations file to check" },
      limit: { help: "Show at most this many violations (default 40)" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  "glossary-merge": {
    summary: "Merge the terms translators reported into the glossary file",
    flags: {
      in: { help: "Term files (JSON: English term -> Estonian) to merge, comma-separated" },
      glossary: { help: "Glossary file to update (default glossary.json)" },
      write: { boolean: true, help: "Actually write the merged glossary (otherwise report only)" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  "translate-stats": {
    summary: "How much of each package is translated",
    flags: {
      catalog: { help: "Path to catalog.json" },
      translations: { help: "Translations file to count" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  build: {
    summary: "Write a package containing the validated translations",
    flags: {
      catalog: { help: "Path to catalog.json" },
      out: { help: "Package to write" },
      manifest: { help: "Manifest to write (default <out>.manifest.json)" },
      package: { help: "Override the source package path recorded in the catalog" },
      "include-unreviewed": {
        boolean: true,
        help: "Also apply drafts and machine output (still rejects stale or invalid entries)",
      },
      "game-version": {
        help: "Game version to record in the manifest (e.g. from GameVersion.txt); optional",
      },
      "game-version-source": {
        help: "Where that version string came from, recorded alongside it",
      },
      translations: { help: "Translations file to read" },
      metadata: { help: "Metadata file to read" },
      ...COMMON_CONFIG_FLAG,
    },
  },
  deploy: {
    summary: "Copy the built package into a Mods folder",
    flags: {
      file: { help: `Package to install (default ${ARTIFACT_NAME} from the build output)` },
      "mods-dir": { help: "Your Mods folder (required unless config.json sets modsDir)" },
      "dry-run": { boolean: true, help: "Show exactly what would happen, then stop" },
      "force-replace-unknown": {
        boolean: true,
        help: "Back up and replace a destination file this tool does not recognise as its own",
      },
      "state-path": { help: "Where deployments and backups are recorded (default work/deploy-state.json)" },
      "destination-name": { help: `File name to use inside Mods (default ${ARTIFACT_NAME})` },
      ...COMMON_CONFIG_FLAG,
    },
  },
};

interface ParsedArgs {
  command: string;
  values: Map<string, string>;
  booleans: Set<string>;
  positional: string[];
}

function parseArgs(argv: string[], command: string | undefined): ParsedArgs {
  const flags = command ? COMMANDS[command]?.flags : undefined;
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = (equals >= 0 ? arg.slice(2, equals) : arg.slice(2)).trim();
    if (name === "help" || name === "h") {
      booleans.add("help");
      continue;
    }
    if (flags && !(name in flags)) {
      throw new UsageError(`Unknown option --${name} for "${command}".`);
    }
    const spec = flags?.[name];
    const inlineValue = equals >= 0 ? arg.slice(equals + 1) : undefined;
    if (spec?.boolean) {
      if (inlineValue !== undefined) {
        throw new UsageError(`--${name} does not take a value.`);
      }
      booleans.add(name);
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined) {
      throw new UsageError(`--${name} needs a value.`);
    }
    values.set(name, value);
  }
  return { command: command ?? "", values, booleans, positional };
}

class UsageError extends Error {}

function loadConfig(parsed: ParsedArgs): Config {
  const explicit = parsed.values.get("config");
  const path = explicit ?? "config.json";
  if (!existsSync(path)) {
    if (explicit) throw new UsageError(`Config file "${explicit}" does not exist.`);
    return DEFAULT_CONFIG;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`Config file "${path}" is not valid JSON: ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== "object") {
    throw new UsageError(`Config file "${path}" must be a JSON object.`);
  }
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!known.has(key)) {
      throw new UsageError(
        `Config file "${path}" has unknown key "${key}". Known keys: ${[...known].join(", ")}.`
      );
    }
  }
  return { ...DEFAULT_CONFIG, ...(raw as Partial<Config>) };
}

function required(parsed: ParsedArgs, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || value === "") {
    throw new UsageError(`--${name} is required.`);
  }
  return value;
}

function resolvePath(parsed: ParsedArgs, flag: string, configValue: string): string {
  return resolve(parsed.values.get(flag) ?? configValue);
}

function printUsage(command?: string): void {
  if (!command || !COMMANDS[command]) {
    console.log(USAGE);
    return;
  }
  const spec = COMMANDS[command]!;
  console.log(`${command} — ${spec.summary}\n`);
  console.log(`Usage: npm run cli -- ${command} [options]\n`);
  console.log("Options:");
  for (const [name, flag] of Object.entries(spec.flags)) {
    console.log(`  --${name}${flag.boolean ? "" : " <value>"}`.padEnd(38) + flag.help);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function runExtract(parsed: ParsedArgs, config: Config): number {
  const packagePath = required(parsed, "package");
  const outDir = resolve(parsed.values.get("out") ?? dirname(config.catalogPath));
  const packLabel = parsed.values.get("pack-label") ?? "BASE";

  const result = extractCatalog({ packagePath, packLabel, outDir });
  const { catalog } = result;

  const source = catalog.packages[0]!;
  console.log(`Read ${source.fileName}`);
  console.log(`  path          ${source.path}`);
  console.log(`  size          ${formatBytes(source.sizeBytes)}`);
  console.log(`  sha256        ${source.sha256}`);
  console.log(`  dbpf version  ${source.dbpfVersion}`);
  console.log(
    `  resources     ${source.resourceCount} total, ` +
      `${source.stblResourceCount} string table(s), ${source.stblEntryCount} strings`
  );
  for (const resource of catalog.resources) {
    console.log(
      `  table         ${resource.tgi}  ${resource.entryCount} entries  ` +
        `locale ${resource.localeByte}  stbl v${resource.stblHeader.version}  ` +
        `duplicate keys ${resource.duplicateKeys.length}  non-zero flags ${resource.nonZeroFlagEntries}`
    );
  }
  console.log(`Wrote ${result.catalogPath}`);
  console.log(`Wrote ${result.manifestPath}`);
  for (const warning of result.warnings) {
    console.log(`\nWarning: ${warning}`);
  }
  console.log(
    `\nNext: npm run cli -- search --catalog "${result.catalogPath}" --text "<a word you expect to see in game>"`
  );
  return EXIT_OK;
}

function runScan(parsed: ParsedArgs, config: Config): number {
  const gameRoot = required(parsed, "game-root");
  const outDir = resolve(required(parsed, "out"));
  // Only pass a size rule when the user asked for one: scanInstallation picks the
  // right default for the root it is given (a game installation can skip large
  // files, a Mods folder must not - that is where the big text packages live).
  const largeFileMbRaw = parsed.values.get("large-file-mb");
  let largeFileBytes: number | undefined;
  if (largeFileMbRaw !== undefined) {
    const largeFileMb = Number(largeFileMbRaw);
    if (!Number.isFinite(largeFileMb) || largeFileMb < 0) {
      throw new UsageError("--large-file-mb must be zero or a positive number (0 disables the rule).");
    }
    largeFileBytes = largeFileMb * 1024 * 1024;
  }

  const result = scanInstallation({
    gameRoot,
    outDir,
    ...(largeFileBytes !== undefined ? { largeFileBytes } : {}),
    includeDelta: parsed.booleans.has("include-delta"),
    includeNonEnglish: parsed.booleans.has("include-non-english"),
    onProgress: (message) => console.log(message),
  });

  const { index } = result;
  console.log("");
  console.log(`Scanned ${index.gameRoot}`);
  console.log(`  packages found   ${index.totals.packagesFound}`);
  console.log(`  read             ${index.totals.packagesRead}`);
  console.log(`  string tables    ${index.totals.tables}`);
  console.log(`  strings          ${index.totals.entries}`);
  for (const [disposition, count] of Object.entries(index.totals.byDisposition).sort()) {
    if (disposition === "read") continue;
    console.log(`  ${disposition.padEnd(17)}${count}`);
  }
  if (index.totals.nonEnglishTablesSkipped > 0) {
    console.log(`  non-English tables skipped: ${index.totals.nonEnglishTablesSkipped}`);
  }
  console.log("");
  for (const row of coverageByPackage(result.catalog)) {
    console.log(
      `  ${row.label.padEnd(28)} ${String(row.entries).padStart(7)} strings in ` +
        `${String(row.tables).padStart(3)} table(s)${row.ambiguous > 0 ? `, ${row.ambiguous} ambiguous` : ""}`
    );
  }
  console.log(`
Wrote ${result.catalogPath}`);
  console.log(`Wrote ${result.indexPath}`);
  console.log(
    `
Next: npm run cli -- build --catalog "${result.catalogPath}" --out dist/!Sims4_Eesti.package --include-unreviewed`
  );
  return EXIT_OK;
}

function runCoverage(parsed: ParsedArgs, config: Config): number {
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const catalog = loadCatalog(catalogPath);
  const rows = coverageByPackage(catalog);
  console.log(`Catalog ${catalogPath}`);
  console.log(`  packages   ${catalog.packages.length}`);
  console.log(`  tables     ${catalog.resources.length}`);
  console.log(`  strings    ${catalog.occurrences.length}`);
  console.log("");
  let total = 0;
  for (const row of rows) {
    total += row.entries;
    console.log(
      `  ${row.label.padEnd(28)} ${String(row.entries).padStart(7)} strings  ${row.path}`
    );
  }
  console.log(`  ${"total".padEnd(28)} ${String(total).padStart(7)} strings`);
  return EXIT_OK;
}

function runMerge(parsed: ParsedArgs, config: Config): number {
  const catalogs = required(parsed, "catalogs")
    .split(",")
    .map((item) => resolve(item.trim()))
    .filter(Boolean);
  const outPath = resolve(required(parsed, "out"));
  const result = mergeCatalogs({ catalogPaths: catalogs, outPath });
  console.log(`Merged ${catalogs.length} catalog(s) into ${result.outPath}`);
  console.log(`  packages  ${result.packages}`);
  console.log(`  tables    ${result.tables}`);
  console.log(`  strings   ${result.strings}`);
  if (result.duplicatePathsSkipped.length > 0) {
    console.log(`  same file listed twice, counted once: ${result.duplicatePathsSkipped.length}`);
  }
  return EXIT_OK;
}

function runTranslateExport(parsed: ParsedArgs, config: Config): number {
  const idsPath = parsed.values.get("ids");
  const ids = idsPath ? readIdsFile(resolve(idsPath)) : undefined;
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const translationsPath = resolvePath(parsed, "translations", config.translationsPath);
  const outDir = resolve(required(parsed, "out"));
  const split = (value: string | undefined): string[] | undefined =>
    value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
  const packages = split(parsed.values.get("packages"));
  const excludePackages = split(parsed.values.get("exclude-packages"));

  const result = exportBatches({
    catalogPath,
    translationsPath,
    outDir,
    ...(parsed.values.get("batch-size") ? { batchSize: Number(parsed.values.get("batch-size")) } : {}),
    ...(parsed.values.get("limit") ? { limit: Number(parsed.values.get("limit")) } : {}),
    ...(ids ? { ids } : {}),
    ...(parsed.booleans.has("dedupe-texts") ? { dedupeTexts: true } : {}),
    ...(parsed.values.get("target-locale") ? { targetLocale: parsed.values.get("target-locale")! } : {}),
    ...(parsed.values.get("language-name") ? { languageName: parsed.values.get("language-name")! } : {}),
    ...(parsed.values.get("references")
      ? { referenceDirs: parsed.values.get("references")!.split(",").map((item) => resolve(item.trim())) }
      : {}),
    ...(parsed.values.get("max-reference-languages")
      ? { maxReferenceLanguages: Number(parsed.values.get("max-reference-languages")) }
      : {}),
    ...(packages ? { includePackages: packages } : {}),
    ...(excludePackages ? { excludePackages } : {}),
  });

  console.log(`Wrote ${result.batchPaths.length} batch file(s) to ${outDir}`);
  console.log(`  strings to translate: ${result.totalStrings}`);
  if (result.deferredCount > 0) {
    console.log(`  left English on purpose (gender branches, markup): ${result.deferredCount}`);
  }
  const locales = Object.keys(result.referenceSources);
  if (locales.length > 0) {
    console.log(`  reference languages: ${locales.join(", ")}`);
    for (const [locale, sources] of Object.entries(result.referenceSources)) {
      console.log(`    ${locale}: ${sources.length} file(s)`);
    }
  }
  if (result.stubLocalesDropped > 0) {
    console.log(`  locale tables dropped as English stubs: ${result.stubLocalesDropped}`);
  }
  for (const [label, count] of Object.entries(result.perPackage).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${label.padEnd(28)} ${String(count).padStart(7)}`);
  }
  console.log(`\nInstructions: ${join(outDir, "INSTRUCTIONS.md")}`);
  console.log(
    `Import results with:\n  npm run cli -- translate-import --catalog "${catalogPath}" --in "${outDir}"`
  );
  return EXIT_OK;
}

function runTranslateImport(parsed: ParsedArgs, config: Config): number {
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const translationsPath = resolvePath(parsed, "translations", config.translationsPath);
  const metadataPath = resolvePath(parsed, "metadata", config.metadataPath);
  const inputs = required(parsed, "in")
    .split(",")
    .map((item) => resolve(item.trim()))
    .filter(Boolean);
  const stateRaw = parsed.values.get("state") ?? "machine";
  if (!isTranslationState(stateRaw)) {
    throw new UsageError(
      `--state must be one of draft, machine, reviewed, needs_review (got "${stateRaw}").`
    );
  }
  const originRaw = parsed.values.get("origin") ?? "machine";
  if (originRaw !== "human" && originRaw !== "machine") {
    throw new UsageError(`--origin must be "human" or "machine" (got "${originRaw}").`);
  }

  const result = importTranslations({
    catalogPath,
    translationsPath,
    metadataPath,
    inputs,
    state: stateRaw,
    origin: originRaw,
    forceOverwriteReviewed: parsed.booleans.has("force-overwrite-reviewed"),
  });

  console.log(`Read ${result.filesRead} file(s), saw ${result.entriesSeen} translation(s)`);
  console.log(`  applied                  ${result.applied}`);
  if (result.propagated > 0) {
    console.log(
      `  propagated               ${result.propagated} (same English text, another key's translation)`
    );
  }
  if (result.overridden > 0) {
    console.log(`  overridden               ${result.overridden} (a wording chosen for one key)`);
  }
  console.log(`  rejected                 ${result.rejected.length}`);
  console.log(`  unknown ids              ${result.unknownIds.length}`);
  console.log(`  already reviewed, kept   ${result.skippedReviewed.length}`);
  for (const [label, count] of Object.entries(result.perPackage).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${label.padEnd(28)} ${String(count).padStart(7)} applied`);
  }
  const byCode = new Map<string, number>();
  for (const rejection of result.rejected) {
    for (const issue of rejection.reasons) {
      byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);
    }
  }
  if (byCode.size > 0) {
    console.log("\n  rejections by reason (these strings stay English):");
    for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${code}: ${count}`);
    }
    for (const rejection of result.rejected.slice(0, 5)) {
      console.log(`    e.g. ${rejection.occurrenceId} — ${rejection.reasons[0]!.message}`);
    }
  }
  return EXIT_OK;
}

function runLint(parsed: ParsedArgs, config: Config): number {
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const translationsPath = resolvePath(parsed, "translations", config.translationsPath);
  const limit = Number(parsed.values.get("limit") ?? 40);
  const catalog = loadCatalog(catalogPath);
  const translations = loadTranslations(translationsPath);

  const referencePaths = (parsed.values.get("references") ?? "")
    .split(",")
    .map((item) => resolve(item.trim()))
    .filter(Boolean);
  let reference: Map<string, string> | undefined;
  if (referencePaths.length > 0) {
    const englishByKey = new Map<string, string>();
    for (const occurrence of catalog.occurrences) {
      if (!englishByKey.has(occurrence.stringKey)) englishByKey.set(occurrence.stringKey, occurrence.sourceText);
    }
    reference = loadReferenceFiles(referencePaths, englishByKey).byLocale.get("fi");
  }

  const { checked, findings } = findForeignForms(catalog.occurrences, translations, reference);
  console.log(`Checked ${checked} translation(s): ${findings.length} carry a form Estonian does not build
`);
  for (const finding of findings.slice(0, limit)) {
    console.log(`${finding.inReference ? "COPIED FROM THE REFERENCE " : ""}${finding.form}  (${finding.note})`);
    console.log(`    en ${JSON.stringify(finding.english.slice(0, 60))}`);
    console.log(`    et ${JSON.stringify(finding.estonian.slice(0, 60))}`);
    console.log(`       ${finding.occurrenceId}`);
  }
  if (findings.length > limit) console.log(`(${findings.length - limit} more not shown; raise --limit)`);
  console.log(
    `
These are reports, not verdicts: Estonian has borrowed from Finnish for centuries, ` +
      `and a reader decides. Fix the offender with "set".`
  );
  return EXIT_OK;
}

function runWave(parsed: ParsedArgs, config: Config): number {
  const directory = parsed.values.get("in");
  if (!directory) throw new UsageError('"wave" needs --in <directory of batch files>.');
  const report = inspectWave({
    directory: resolve(directory),
    catalogPath: resolvePath(parsed, "catalog", config.catalogPath),
    translations: loadTranslations(resolvePath(parsed, "translations", config.translationsPath)),
  });
  for (const line of describeWave(report)) console.log(line);
  const rejected = report.batches.flatMap((batch) =>
    batch.rejected.map((entry) => ({ batch: batch.batch, ...entry }))
  );
  for (const entry of rejected.slice(0, 10)) {
    console.log(`  rejected ${entry.occurrenceId} (${entry.batch}): ${entry.codes.join(", ")}`);
  }
  if (rejected.length > 10) console.log(`  (${rejected.length - 10} more rejected entries not shown)`);
  return EXIT_OK;
}

function runGlossaryCheck(parsed: ParsedArgs, config: Config): number {
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const translationsPath = resolvePath(parsed, "translations", config.translationsPath);
  const glossaryPath = parsed.values.get("glossary") ?? "glossary.json";
  const limit = Number(parsed.values.get("limit") ?? 40);
  const glossary = loadGlossary(glossaryPath);
  const catalog = loadCatalog(catalogPath);
  const translations = loadTranslations(translationsPath);
  const { violations, checked, orphanTranslationIds } = checkGlossary(glossary, catalog, translations);

  console.log(`Glossary ${glossaryPath}: ${glossary.terms.length} term(s)`);
  console.log(`Checked ${checked} translated occurrence(s) from ${catalogPath}: ${violations.length} do not use the agreed term`);
  if (orphanTranslationIds.length > 0) {
    console.log(
      `\n${orphanTranslationIds.length} translation(s) have no occurrence in this catalog, so they were NOT checked ` +
        `(e.g. ${orphanTranslationIds[0]}).\nPass the install-wide catalog (work/beta-catalog.json) to check everything.`
    );
  }
  console.log();
  const byTerm = new Map<string, number>();
  for (const violation of violations) byTerm.set(violation.term, (byTerm.get(violation.term) ?? 0) + 1);
  let printed = 0;
  for (const [term, count] of [...byTerm].sort((a, b) => b[1] - a[1])) {
    const example = violations.find((violation) => violation.term === term)!;
    console.log(`${term} (${count}): expected ${example.expected.join(" / ")}`);
    for (const violation of violations.filter((v) => v.term === term).slice(0, Math.max(0, limit - printed))) {
      console.log(`    en ${JSON.stringify(violation.english).slice(0, 66)}`);
      console.log(`    et ${JSON.stringify(violation.estonian).slice(0, 66)}`);
      console.log(`       ${violation.occurrenceId}`);
      printed += 1;
    }
  }
  if (violations.length > printed) {
    console.log(`(${violations.length - printed} more not shown; raise --limit to see them)`);
  }
  if (violations.length > 0) {
    console.log(`
These are reports, not errors: Estonian inflects, and a term can legitimately`);
    console.log(`have another rendering. Fix the offender with "set", or add the form to the term's`);
    console.log(`"accept" list in ${glossaryPath} when the translation is right and the checker is wrong.`);
  }
  return EXIT_OK;
}

/** A rank selection (`{ ids: [...] }`) or a plain JSON array of occurrence ids. */
function readIdsFile(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const ids = Array.isArray(parsed) ? parsed : (parsed as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new UsageError(`"${path}" does not look like a list of occurrence ids.`);
  }
  return ids as string[];
}

function runRank(parsed: ParsedArgs, config: Config): number {
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const translationsPath = resolvePath(parsed, "translations", config.translationsPath);
  const glossaryPath = parsed.values.get("glossary") ?? "glossary.json";
  const top = Number(parsed.values.get("top") ?? 1000);
  const sample = Number(parsed.values.get("sample") ?? 20);
  const outPath = parsed.values.get("out");
  const packages = (parsed.values.get("packages") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const catalog = loadCatalog(catalogPath);
  const translations = loadTranslations(translationsPath);
  const glossary = loadGlossary(glossaryPath);
  const options = {
    glossary,
    translations,
    anchors: Object.keys(translations),
    ...(packages.length > 0 ? { includePackages: packages } : {}),
  };

  const ranked = rankStrings(catalog, { ...options, top });
  const occurrenceIds = occurrenceIdsOf(ranked);

  console.log(`Catalog ${catalogPath}: ${catalog.occurrences.length} occurrence(s)`);
  console.log(
    `Top ${ranked.length} untranslated text(s) = ${occurrenceIds.length} occurrence(s), ` +
      `scored ${ranked[0]?.score ?? 0} down to ${ranked[ranked.length - 1]?.score ?? 0}`
  );

  // The score is a heuristic, so it is checked against the only ground truth
  // available: strings already confirmed on screen. They are the anchors, so they
  // are excluded from the list - this re-ranks everything to see where they land.
  if (Object.keys(translations).length > 0) {
    const everything = rankStrings(catalog, { ...options, translations: {}, anchors: Object.keys(translations) });
    const positions = new Map<string, number>();
    everything.forEach((entry, index) => {
      for (const occurrence of entry.occurrences) positions.set(occurrence.occurrenceId, index + 1);
    });
    const placed = Object.keys(translations)
      .map((id) => positions.get(id))
      .filter((position): position is number => position !== undefined)
      .sort((a, b) => a - b);
    if (placed.length > 0) {
      const median = placed[Math.floor(placed.length / 2)]!;
      console.log(
        `\nSelf-check: of ${placed.length} string(s) already confirmed on screen, ` +
          `${placed.filter((position) => position <= top).length} rank inside the top ${top} ` +
          `(median position ${median} of ${everything.length}, worst ${placed[placed.length - 1]})`
      );
    }
  }

  if (ranked.length > 0) {
    console.log(`\nEvery ${Math.max(1, Math.floor(ranked.length / Math.max(1, sample)))}th entry:`);
    const step = Math.max(1, Math.floor(ranked.length / Math.max(1, sample)));
    for (let index = 0; index < ranked.length; index += step) {
      const entry = ranked[index]!;
      console.log(
        `  ${String(index + 1).padStart(4)}. ${JSON.stringify(entry.text.slice(0, 44))} ` +
          `[${entry.occurrences.length} keys; ${entry.why.join("; ")}]`
      );
    }
  }

  if (outPath) {
    const out = resolve(outPath);
    writeJsonAtomic(out, {
      generatedAt: new Date().toISOString(),
      catalog: catalogPath,
      packages: packages.length > 0 ? packages : "all",
      count: occurrenceIds.length,
      ids: occurrenceIds,
      texts: ranked.map((entry) => ({
        text: entry.text,
        score: entry.score,
        keys: entry.occurrences.length,
        why: entry.why,
      })),
    });
    console.log(`\nWrote ${out} (${occurrenceIds.length} occurrence ids) - pass it to translate-export --ids`);
  }
  return EXIT_OK;
}

function runGlossaryMerge(parsed: ParsedArgs, config: Config): number {
  const glossaryPath = parsed.values.get("glossary") ?? "glossary.json";
  const glossary = loadGlossary(glossaryPath);
  const inputs = (parsed.values.get("in") ?? "")
    .split(",")
    .map((item) => resolve(item.trim()))
    .filter(Boolean);
  const reports: Record<string, string>[] = [];
  for (const path of inputs) {
    if (!existsSync(path)) throw new UsageError(`No such term file: "${path}"`);
    reports.push(JSON.parse(readFileSync(path, "utf8")) as Record<string, string>);
  }
  const { added, conflicts } = mergeTermReports(glossary, reports);
  console.log(`Read ${reports.length} term file(s)`);
  console.log(`  new terms: ${added.length}`);
  for (const term of added.slice(0, 20)) console.log(`    ${term.en} -> ${term.et}`);
  console.log(`  conflicts with agreed terms: ${conflicts.length}`);
  for (const conflict of conflicts.slice(0, 20)) {
    console.log(`    ${conflict.en}: agreed "${conflict.agreed}", suggested "${conflict.suggested}"`);
  }
  if (!parsed.booleans.has("write")) {
    console.log("");
    console.log("Report only. Re-run with --write to add the new terms to the glossary.");
    return EXIT_OK;
  }
  if (added.length > 0) {
    writeJsonAtomic(glossaryPath, { ...glossary, terms: [...glossary.terms, ...added] });
    console.log(`
Wrote ${added.length} new term(s) to ${glossaryPath}`);
  }
  return EXIT_OK;
}

function runTranslateStats(parsed: ParsedArgs, config: Config): number {
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const translationsPath = resolvePath(parsed, "translations", config.translationsPath);
  const stats = translationStats(catalogPath, translationsPath);
  const share = (part: number, whole: number) =>
    whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`;
  console.log(`Catalog ${catalogPath}`);
  console.log(`  strings            ${stats.total}`);
  console.log(`  translated         ${stats.translated} (${share(stats.translated, stats.total)})`);
  console.log(`  ambiguous/skipped  ${stats.ambiguous}`);
  console.log("");
  for (const [label, row] of [...stats.byPackage].sort((a, b) => b[1].total - a[1].total)) {
    const eligible = row.total - row.ambiguous;
    console.log(
      `  ${label.padEnd(30)} ${String(row.translated).padStart(6)}/${String(eligible).padStart(6)} (${share(row.translated, eligible)})`
    );
  }
  return EXIT_OK;
}

function runSearch(parsed: ParsedArgs, config: Config): number {
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const text = required(parsed, "text");
  const limit = Number(parsed.values.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new UsageError("--limit must be a positive whole number.");
  }
  const catalog = loadCatalog(catalogPath);
  const translationsPath = parsed.values.get("translations")
    ? resolve(parsed.values.get("translations")!)
    : resolve(config.translationsPath);
  const translations = existsSync(translationsPath) ? loadTranslations(translationsPath) : {};
  const metadataPath = resolve(config.metadataPath);
  const metadata = existsSync(metadataPath) ? loadMetadata(metadataPath) : undefined;

  const hits = searchCatalog(catalog, {
    text,
    limit: parsed.booleans.has("translatable-only") ? limit * 20 : limit,
    ...(parsed.booleans.has("exact") ? { exact: true } : {}),
    ...(parsed.booleans.has("case-sensitive") ? { caseSensitive: true } : {}),
  });

  let printed = 0;
  for (const hit of hits) {
    const { occurrence } = hit;
    if (parsed.booleans.has("translatable-only")) {
      if (occurrence.ambiguous || analyzeSyntax(occurrence.sourceText).problem) continue;
    }
    const translation = translations[occurrence.occurrenceId];
    const state = metadata?.entries[occurrence.occurrenceId]?.state;
    console.log(occurrence.occurrenceId);
    console.log(`  en  ${quote(occurrence.sourceText)}`);
    if (translation !== undefined) {
      console.log(`  et  ${quote(translation)}${state ? `   [${state}]` : ""}`);
    } else if (state) {
      console.log(`  et  [${state}, no text recorded]`);
    }
    if (occurrence.ambiguous) console.log("  note  string key is used by more than one entry; cannot be addressed");
    printed++;
    if (printed >= limit) break;
  }

  console.log(
    `\n${printed} of ${catalog.occurrences.length} strings match ${quote(text)}` +
      (printed >= limit ? ` (stopped at --limit ${limit})` : "")
  );
  if (printed > 0) {
    console.log(
      `\nTo translate one of them:\n  npm run cli -- set --catalog "${catalogPath}" ` +
        `--id "<ID printed above>" --text "<Estonian text>"`
    );
  }
  return EXIT_OK;
}

function runSet(parsed: ParsedArgs, config: Config): number {
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const translationsPath = resolvePath(parsed, "translations", config.translationsPath);
  const metadataPath = resolvePath(parsed, "metadata", config.metadataPath);
  const occurrenceId = required(parsed, "id");
  const text = required(parsed, "text");
  const stateRaw = parsed.values.get("state") ?? "draft";
  if (!isTranslationState(stateRaw)) {
    throw new UsageError(
      `--state must be one of draft, machine, reviewed, needs_review (got "${stateRaw}").`
    );
  }
  const originRaw = parsed.values.get("origin") ?? "human";
  if (originRaw !== "human" && originRaw !== "machine") {
    throw new UsageError(`--origin must be "human" or "machine" (got "${originRaw}").`);
  }

  const result = setTranslation({
    catalogPath,
    translationsPath,
    metadataPath,
    occurrenceId,
    text,
    state: stateRaw,
    origin: originRaw,
    forceOverwriteReviewed: parsed.booleans.has("force-overwrite-reviewed"),
    ...(parsed.values.get("note") ? { note: parsed.values.get("note")! } : {}),
  });

  console.log(`Recorded "${occurrenceId}"`);
  console.log(`  en    ${quote(result.sourceText)}`);
  console.log(`  et    ${quote(text)}`);
  console.log(`  state ${result.previousState ?? "(none)"} → ${result.state} (${result.origin})`);
  console.log(`  wrote ${translationsPath}`);
  console.log(`  wrote ${metadataPath}`);
  if (result.issues.length > 0) {
    console.log(`\nWarning: this translation will be left in English at build time:`);
    for (const issue of result.issues) {
      console.log(`  - ${issue.code}: ${issue.message}`);
    }
  }
  return EXIT_OK;
}

function runBuild(parsed: ParsedArgs, config: Config): number {
  const catalogPath = resolvePath(parsed, "catalog", config.catalogPath);
  const outPath = resolvePath(parsed, "out", config.outPackage);
  const translationsPath = resolvePath(parsed, "translations", config.translationsPath);
  const metadataPath = resolvePath(parsed, "metadata", config.metadataPath);
  const manifestPath = parsed.values.get("manifest")
    ? resolve(parsed.values.get("manifest")!)
    : defaultManifestPath(outPath);

  const report = buildPackage({
    catalogPath,
    outPath,
    translationsPath,
    metadataPath,
    manifestPath,
    includeUnreviewed: parsed.booleans.has("include-unreviewed"),
    ...(parsed.values.get("package") ? { packagePath: parsed.values.get("package")! } : {}),
    ...(parsed.values.get("game-version") ? { gameVersion: parsed.values.get("game-version")! } : {}),
    ...(parsed.values.get("game-version-source")
      ? { gameVersionSource: parsed.values.get("game-version-source")! }
      : {}),
  });

  console.log(`Built ${report.outPath}`);
  console.log(`  size        ${formatBytes(report.outputBytes)}`);
  console.log(`  sha256      ${report.outputSha256}`);
  console.log(`  manifest    ${report.manifestPath}`);
  for (const facts of report.sourcePackages) {
    console.log(`  source      ${facts.label}: ${facts.path}`);
    console.log(`  source sha  ${facts.sha256}`);
  }
  console.log("");
  for (const resource of report.resources) {
    console.log(
      `  table ${resource.tgi}: ${resource.replaced} replaced ` +
        `(${resource.reviewedReplaced} reviewed, ${resource.unreviewedReplaced} unreviewed), ` +
        `${resource.leftInEnglish} kept in English, ${resource.entryCount} entries total`
    );
  }
  console.log("");
  console.log(`  applied     ${report.counts.applied} of ${report.counts.translationsInFile} translations`);
  console.log(`  excluded    ${report.counts.excluded}`);
  for (const [code, count] of Object.entries(report.counts.excludedByCode).sort()) {
    console.log(`      ${code}: ${count}`);
  }
  if (report.excluded.length > 0) {
    console.log("\n  first exclusions:");
    for (const entry of report.excluded.slice(0, 10)) {
      console.log(`    ${entry.occurrenceId}`);
      console.log(`      en  ${quote(entry.sourceText.slice(0, 70))}`);
      for (const message of entry.messages) console.log(`      - ${message}`);
    }
    if (report.excluded.length > 10) {
      console.log(`    … ${report.excluded.length - 10} more (see the manifest)`);
    }
  }
  for (const warning of report.warnings) {
    console.log(`\nWarning: ${warning}`);
  }
  console.log(
    `\nNext (dry run first): npm run cli -- deploy --file "${report.outPath}" --mods-dir "<your Mods folder>" --dry-run`
  );
  return EXIT_OK;
}

function runDeploy(parsed: ParsedArgs, config: Config): number {
  const file = resolve(parsed.values.get("file") ?? config.outPackage);
  const modsDirValue = parsed.values.get("mods-dir") ?? config.modsDir ?? undefined;
  if (!modsDirValue) {
    throw new UsageError(
      `--mods-dir is required (or set "modsDir" in config.json). It is the Mods folder of the user ` +
        `folder the game actually uses, e.g. "C:\\Users\\you\\Documents\\Electronic Arts\\The Sims 4\\Mods".`
    );
  }
  const dryRun = parsed.booleans.has("dry-run");
  const result = deploy({
    file,
    modsDir: modsDirValue,
    dryRun,
    forceReplaceUnknown: parsed.booleans.has("force-replace-unknown"),
    statePath: resolve(parsed.values.get("state-path") ?? config.deployStatePath),
    ...(parsed.values.get("destination-name")
      ? { destinationName: parsed.values.get("destination-name")! }
      : {}),
  });

  console.log(result.dryRun ? "Deploy (dry run)" : "Deploy");
  console.log(`  from        ${result.sourcePath}`);
  console.log(`  to          ${result.destinationPath}`);
  console.log(`  size        ${formatBytes(result.sourceBytes)}`);
  console.log(`  sha256      ${result.sourceSha256}`);
  console.log(`  action      ${result.action}`);
  for (const note of result.notes) console.log(`  note        ${note}`);
  console.log(`\n${result.message}`);

  if (result.action === "refuse") {
    return EXIT_REFUSED;
  }
  if (dryRun) {
    console.log(
      `\nDry run only: nothing was copied. To install for real (close the game first):\n` +
        `  npm run cli -- deploy --file "${result.sourcePath}" --mods-dir "${dirname(result.destinationPath)}"`
    );
  } else if (result.action !== "already-current") {
    console.log(
      `\nInstalled. Start the game and check the strings listed in the manual test plan ` +
        `(README.md). To remove it again, delete only "${result.destinationPath}".`
    );
  }
  return EXIT_OK;
}

function main(argv: string[]): number {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return EXIT_OK;
  }
  if (!(command in COMMANDS)) {
    console.error(`Unknown command "${command}".\n`);
    printUsage();
    return EXIT_USAGE;
  }

  const parsed = parseArgs(argv.slice(1), command);
  if (parsed.booleans.has("help")) {
    printUsage(command);
    return EXIT_OK;
  }
  if (parsed.positional.length > 0) {
    console.error(`Unexpected argument "${parsed.positional[0]}" for "${command}".\n`);
    printUsage(command);
    return EXIT_USAGE;
  }

  const config = loadConfig(parsed);
  switch (command) {
    case "extract":
      return runExtract(parsed, config);
    case "scan":
      return runScan(parsed, config);
    case "merge":
      return runMerge(parsed, config);
    case "translate-export":
      return runTranslateExport(parsed, config);
    case "translate-import":
      return runTranslateImport(parsed, config);
    case "rank":
      return runRank(parsed, config);
    case "lint":
      return runLint(parsed, config);
    case "wave":
      return runWave(parsed, config);
    case "glossary-check":
      return runGlossaryCheck(parsed, config);
    case "glossary-merge":
      return runGlossaryMerge(parsed, config);
    case "translate-stats":
      return runTranslateStats(parsed, config);
    case "coverage":
      return runCoverage(parsed, config);
    case "search":
      return runSearch(parsed, config);
    case "set":
      return runSet(parsed, config);
    case "build":
      return runBuild(parsed, config);
    case "deploy":
      return runDeploy(parsed, config);
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`Usage error: ${error.message}\n`);
    printUsage(process.argv[2]);
    process.exitCode = EXIT_USAGE;
  } else if (error instanceof BuildError || error instanceof DeployError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = EXIT_ERROR;
  } else {
    console.error(`Error: ${(error as Error).message}`);
    if (process.env.SIMS4_EESTI_DEBUG) console.error(error);
    process.exitCode = EXIT_ERROR;
  }
}
