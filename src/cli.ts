#!/usr/bin/env node
/**
 * One entry point for the whole workflow: extract → search → set → build → deploy.
 *
 * Every command takes explicit paths; nothing is discovered by scanning the disk,
 * and no command touches the game installation or your saves.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildPackage, defaultManifestPath, BuildError } from "./build.js";
import { extractCatalog, loadCatalog, searchCatalog } from "./catalog.js";
import { coverageByPackage, scanInstallation } from "./scan.js";
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
  outPackage: "dist/Sims4_Eesti.package",
  modsDir: null,
  deployStatePath: "work/deploy-state.json",
};

const USAGE = `sims4-eesti — unofficial Estonian text mod builder for The Sims 4

Usage: npm run cli -- <command> [options]

Commands:
  extract   Read one English .package and write a catalog of its strings
  scan      Find every string table installed and catalog them all at once
  coverage  Report how many strings each package contributes
  search    Find English strings in a catalog and print their occurrence IDs
  set       Record an Estonian translation for one occurrence ID
  build     Write a package containing the validated translations
  deploy    Copy the built package into a Mods folder

Run "npm run cli -- <command> --help" for the options of one command.

Typical session (paths are examples; use your own):
  npm run cli -- extract --package "C:\\Program Files (x86)\\Steam\\steamapps\\common\\The Sims 4\\Data\\Client\\Strings_ENG_US.package" --out work/base
  npm run cli -- search --catalog work/base/catalog.json --text "New Game"
  npm run cli -- set --catalog work/base/catalog.json --id "<ID printed by search>" --text "Uus mäng"
  npm run cli -- build --catalog work/base/catalog.json --include-unreviewed --out dist/Sims4_Eesti.package
  npm run cli -- deploy --file dist/Sims4_Eesti.package --mods-dir "C:\\Users\\you\\Documents\\Electronic Arts\\The Sims 4\\Mods" --dry-run

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
  coverage: {
    summary: "Report how many strings each package contributes",
    flags: {
      catalog: { help: "Path to a catalog.json from extract or scan" },
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
Next: npm run cli -- build --catalog "${result.catalogPath}" --out dist/Sims4_Eesti.package --include-unreviewed`
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
