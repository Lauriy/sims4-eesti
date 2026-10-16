/**
 * Installing the built package into a Mods folder.
 *
 * Deployment touches exactly one file: our own artifact at its destination path.
 * It never moves, renames, or deletes other mods, never edits Resource.cfg, and
 * never starts or stops the game. Replacing our own previous release always
 * makes a backup outside the active Mods folder first, and an unrelated file
 * that happens to share the name is refused unless explicitly forced.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sha256File } from "./hashing.js";
import { formatTgi, toTgi } from "./ids.js";
import { readStblTables } from "./package-io.js";
import { CompressionType } from "@s4tk/compression";

/**
 * The file name used inside the Mods folder.
 *
 * The leading "!" is deliberate and load-bearing: when two packages claim the
 * same resource, the game uses the one whose file name sorts first (measured in
 * game, 2026-10-16 - see probes/precedence/README.md). Once this mod translates
 * text that belongs to another mod, our copy of that table has to win, and those
 * mods' own file names sort before any ordinary name. "!" sorts before digits and
 * letters, which is why it is the convention mod authors already use.
 */
export const ARTIFACT_NAME = "!Sims4_Eesti.package";

export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployError";
  }
}

export interface DeployRecord {
  destination: string;
  sha256: string;
  sizeBytes: number;
  deployedAt: string;
  backupPath?: string;
  sourceArtifact: string;
}

export interface DeployState {
  schemaVersion: number;
  deployments: DeployRecord[];
}

export interface DeployOptions {
  file: string;
  modsDir: string;
  dryRun: boolean;
  /** Replace a destination file that is not recognisable as one of our releases. */
  forceReplaceUnknown: boolean;
  /** Where to record releases and keep backups. Defaults to work/deploy-state.json. */
  statePath: string;
  /** File name to use inside the Mods folder. */
  destinationName?: string;
}

export interface DeployResult {
  dryRun: boolean;
  sourcePath: string;
  sourceSha256: string;
  sourceBytes: number;
  destinationPath: string;
  action: "copy" | "replace-ours" | "already-current" | "refuse";
  backupPath?: string;
  message: string;
  notes: string[];
}

export function loadDeployState(statePath: string): DeployState {
  if (!existsSync(statePath)) return { schemaVersion: 1, deployments: [] };
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as DeployState;
    if (!Array.isArray(parsed.deployments)) return { schemaVersion: 1, deployments: [] };
    return parsed;
  } catch {
    // A damaged state file must not block deployment: it only affects whether we
    // can recognise our own previous release, which is checked independently.
    return { schemaVersion: 1, deployments: [] };
  }
}

function saveDeployState(statePath: string, state: DeployState): void {
  mkdirSync(dirname(resolve(statePath)), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** True when `candidate` is the same directory as, or below, `parent`. */
function isInside(candidate: string, parent: string): boolean {
  const child = canonicalDir(candidate);
  const container = canonicalDir(parent);
  if (child === container) return true;
  const withSep = container.endsWith("\\") || container.endsWith("/") ? container : `${container}\\`;
  return child.toLowerCase().startsWith(withSep.toLowerCase());
}

function canonicalDir(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    try {
      return realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  }
  // The directory may not exist yet (backups are created on demand): resolve its
  // closest existing ancestor instead of giving up on the check.
  const parent = dirname(absolute);
  if (parent !== absolute) return join(canonicalDir(parent), basename(absolute));
  return absolute;
}

/**
 * A destination is treated as our own previous release when this tool recorded a
 * deployment of that exact byte sequence, or when the existing file contains
 * nothing but string tables — which is all this project ever builds.
 */
function looksLikeOurRelease(destination: string, state: DeployState, sha256: string): boolean {
  const recorded = state.deployments.some(
    (deployment) => samePath(deployment.destination, destination) && deployment.sha256 === sha256
  );
  if (recorded) return true;
  try {
    const read = readStblTables(destination);
    return read.tables.length > 0 && read.resourceCount === read.tables.length;
  } catch {
    return false;
  }
}

export function deploy(options: DeployOptions): DeployResult {
  const notes: string[] = [];
  const sourcePath = resolve(options.file);
  if (!existsSync(sourcePath)) {
    throw new DeployError(`No such package: "${sourcePath}". Run "build" first.`);
  }
  if (!statSync(sourcePath).isFile()) {
    throw new DeployError(`"${sourcePath}" is not a file.`);
  }

  const modsDir = resolve(options.modsDir);
  if (!existsSync(modsDir)) {
    throw new DeployError(
      `Mods directory "${modsDir}" does not exist. Point --mods-dir at the Mods folder of the ` +
        `user folder the game actually uses (Documents\\Electronic Arts\\The Sims 4\\Mods by default).`
    );
  }
  if (!statSync(modsDir).isDirectory()) {
    throw new DeployError(`"${modsDir}" is not a directory.`);
  }

  const destinationName = options.destinationName ?? ARTIFACT_NAME;
  const destinationPath = join(modsDir, destinationName);
  if (samePath(sourcePath, destinationPath)) {
    throw new DeployError(
      `Source and destination are the same file ("${destinationPath}"); nothing to do.`
    );
  }

  const sourceSha256 = sha256File(sourcePath);
  const sourceBytes = statSync(sourcePath).size;
  const state = loadDeployState(options.statePath);

  // Validate that we are deploying string tables and nothing else.
  let read;
  try {
    read = readStblTables(sourcePath);
  } catch (error) {
    throw new DeployError(
      `"${sourcePath}" cannot be deployed: ${(error as Error).message}`
    );
  }
  const compressed = new Set(read.tables.map((table) => table.compressionType));
  if (![...compressed].every((type) => type === CompressionType.ZLIB)) {
    throw new DeployError(
      `"${sourcePath}" contains string tables with unexpected compression types ` +
        `(${[...compressed].join(", ")}); refusing to deploy a package this tool did not build.`
    );
  }
  notes.push(
    `Contains ${read.tables.length} string table(s), ` +
      `${read.tables.reduce((sum, table) => sum + table.entries.length, 0)} entries: ` +
      read.tables.map((table) => formatTgi(toTgi(table))).join(", ")
  );

  if (!existsSync(destinationPath)) {
    const result: DeployResult = {
      dryRun: options.dryRun,
      sourcePath,
      sourceSha256,
      sourceBytes,
      destinationPath,
      action: "copy",
      message: `Copy "${sourcePath}" to "${destinationPath}".`,
      notes,
    };
    if (options.dryRun) {
      notes.push("Dry run: nothing was copied and no state was written.");
      return result;
    }
    copyFileSync(sourcePath, destinationPath);
    recordDeployment(options, state, {
      destination: destinationPath,
      sha256: sourceSha256,
      sizeBytes: sourceBytes,
      deployedAt: new Date().toISOString(),
      sourceArtifact: sourcePath,
    });
    return result;
  }

  const existingSha256 = sha256File(destinationPath);
  if (existingSha256 === sourceSha256) {
    return {
      dryRun: options.dryRun,
      sourcePath,
      sourceSha256,
      sourceBytes,
      destinationPath,
      action: "already-current",
      message: `"${destinationPath}" is already this exact build; nothing to do.`,
      notes,
    };
  }

  const isOurs = looksLikeOurRelease(destinationPath, state, existingSha256);
  if (!isOurs && !options.forceReplaceUnknown) {
    return {
      dryRun: options.dryRun,
      sourcePath,
      sourceSha256,
      sourceBytes,
      destinationPath,
      action: "refuse",
      message:
        `Refusing to overwrite "${destinationPath}": it is not a release this tool recorded, and ` +
        `it does not look like a string-table package it built. Move or rename that file yourself ` +
        `if it really is yours to replace, or pass --force-replace-unknown to back it up and replace it.`,
      notes,
    };
  }

  const backupDir = join(dirname(resolve(options.statePath)), "backups");
  const backupName = `${basename(destinationPath).replace(/\.package$/i, "")}-${timestamp()}-${existingSha256.slice(0, 8)}.package`;
  const backupPath = join(backupDir, backupName);

  // A backup inside the Mods folder would be a second package holding an older
  // revision of the same string tables, which the game may load — the exact
  // stale-whole-table hazard this project documents. Refuse rather than create it.
  if (isInside(backupDir, modsDir)) {
    throw new DeployError(
      `Refusing to back up inside the Mods folder: the backup would be written to ` +
        `"${backupPath}". Point --state-path (currently "${options.statePath}") somewhere outside ` +
        `"${modsDir}", for example the default work/deploy-state.json.`
    );
  }

  const result: DeployResult = {
    dryRun: options.dryRun,
    sourcePath,
    sourceSha256,
    sourceBytes,
    destinationPath,
    action: "replace-ours",
    backupPath,
    message:
      `Replace "${destinationPath}" with "${sourcePath}".\n` +
      `  Backup of the existing file: "${backupPath}"`,
    notes,
  };

  if (options.dryRun) {
    notes.push("Dry run: nothing was copied, no backup was written, and no state was written.");
    return result;
  }

  mkdirSync(backupDir, { recursive: true });
  if (existsSync(backupPath)) {
    throw new DeployError(
      `Backup path "${backupPath}" already exists; refusing to overwrite an existing backup.`
    );
  }
  copyFileSync(destinationPath, backupPath);
  copyFileSync(sourcePath, destinationPath);
  notes.push(`Backed up the previous file to "${backupPath}" (outside the Mods folder).`);
  recordDeployment(options, state, {
    destination: destinationPath,
    sha256: sourceSha256,
    sizeBytes: sourceBytes,
    deployedAt: new Date().toISOString(),
    backupPath,
    sourceArtifact: sourcePath,
  });
  return result;
}

function recordDeployment(options: DeployOptions, state: DeployState, record: DeployRecord): void {
  state.deployments = state.deployments.filter(
    (deployment) => !samePath(deployment.destination, record.destination)
  );
  state.deployments.push(record);
  saveDeployState(options.statePath, state);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}
