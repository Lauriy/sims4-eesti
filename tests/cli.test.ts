/**
 * End-to-end checks of the command line itself: the command shapes from the
 * brief, the exit codes, and that the workflow runs offline against a synthetic
 * package with nothing but local paths.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { ARTIFACT_NAME } from "../src/deploy.js";
import { REAL_ENGLISH_INSTANCE, SAMPLE_KEYS, makeTempDir, removeDir, writeFixturePackage } from "./helpers.js";

const CLI = join(process.cwd(), "src", "cli.ts");
// Absolute path to the tsx loader, so the CLI can be run from any working
// directory the way a user would.
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
let dir: string;
let packagePath: string;
let catalogPath: string;
let translationsPath: string;
let metadataPath: string;
let outPath: string;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, ["--import", TSX, CLI, ...args], {
      encoding: "utf8",
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

before(() => {
  dir = makeTempDir("cli");
  packagePath = join(dir, "Strings_ENG_US.package");
  catalogPath = join(dir, "base", "catalog.json");
  translationsPath = join(dir, "et-EE.json");
  metadataPath = join(dir, "metadata.json");
  outPath = join(dir, "dist", "Sims4_Eesti.package");
  mkdirSync(join(dir, "dist"), { recursive: true });

  writeFixturePackage(packagePath, [
    {
      instance: REAL_ENGLISH_INSTANCE,
      entries: [
        { key: SAMPLE_KEYS.newGame, text: "New Game" },
        { key: SAMPLE_KEYS.greeting, text: "Hello, {0.SimFirstName}!" },
        { key: SAMPLE_KEYS.complex, text: "{{0.String}} house" },
      ],
    },
  ]);
});

after(() => {
  removeDir(dir);
});

describe("cli", () => {
  it("prints usage and exits 0 for --help", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /sims4-eesti/);
    assert.match(result.stdout, /extract/);
  });

  it("exits 2 for an unknown command or option", () => {
    assert.equal(run(["frobnicate"]).status, 2);
    assert.equal(run(["extract", "--nope", "x"]).status, 2);
    assert.equal(run(["extract"]).status, 2, "missing required --package");
  });

  it("extracts a catalog from a package", () => {
    const result = run([
      "extract",
      "--package",
      packagePath,
      "--out",
      join(dir, "base"),
      "--pack-label",
      "BASE",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Wrote/);
    assert.ok(existsSync(catalogPath));
  });

  it("searches and prints a complete occurrence ID", () => {
    const result = run(["search", "--catalog", catalogPath, "--text", "New Game"]);
    assert.equal(result.status, 0, result.stderr);
    const idLine = result.stdout.split("\n").find((line) => line.startsWith("BASE|"));
    assert.ok(idLine, "prints the full occurrence ID on its own line");
    assert.match(idLine!, /^BASE\|220557DA:00000000:[0-9A-F]{16}\|[0-9A-F]{8}$/);
    assert.match(result.stdout, /en {2}"New Game"/);
  });

  it("hides deferred strings from --translatable-only", () => {
    const all = run(["search", "--catalog", catalogPath, "--text", "house"]);
    assert.match(all.stdout, /deferred|\{\{0\.String\}\}/);
    const filtered = run([
      "search",
      "--catalog",
      catalogPath,
      "--text",
      "house",
      "--translatable-only",
    ]);
    assert.equal(filtered.stdout.includes("{{0.String}}"), false);
  });

  it("records a translation from the ID printed by search", () => {
    const search = run(["search", "--catalog", catalogPath, "--text", "New Game"]);
    const id = search.stdout.split("\n").find((line) => line.startsWith("BASE|"))!.trim();
    const result = run([
      "set",
      "--catalog",
      catalogPath,
      "--id",
      id,
      "--text",
      "Uus mäng",
      "--translations",
      translationsPath,
      "--metadata",
      metadataPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /state \(none\) → draft/);

    const translations = JSON.parse(readFileSync(translationsPath, "utf8")) as Record<string, string>;
    assert.equal(translations[id], "Uus mäng");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      entries: Record<string, { state: string; sourceHash: string }>;
    };
    assert.equal(metadata.entries[id]!.state, "draft");
    assert.equal(metadata.entries[id]!.sourceHash.length, 64);
  });

  it("refuses to apply drafts without --include-unreviewed", () => {
    const result = run([
      "build",
      "--catalog",
      catalogPath,
      "--out",
      outPath,
      "--translations",
      translationsPath,
      "--metadata",
      metadataPath,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Nothing to build/);
    assert.match(result.stderr, /--include-unreviewed/);
    assert.equal(existsSync(outPath), false);
  });

  it("builds the package with --include-unreviewed and writes a manifest", () => {
    const result = run([
      "build",
      "--catalog",
      catalogPath,
      "--out",
      outPath,
      "--include-unreviewed",
      "--translations",
      translationsPath,
      "--metadata",
      metadataPath,
      "--game-version",
      "1.128.90.1030",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Built/);
    assert.ok(existsSync(outPath));
    const manifest = JSON.parse(
      readFileSync(join(dir, "dist", "Sims4_Eesti.manifest.json"), "utf8")
    ) as { counts: { applied: number }; gameVersion: { value: string } };
    assert.equal(manifest.counts.applied, 1);
    assert.equal(manifest.gameVersion.value, "1.128.90.1030");
  });

  it("deploys as a dry run without touching the Mods folder", () => {
    const modsDir = join(dir, "Mods");
    mkdirSync(modsDir, { recursive: true });
    const result = run([
      "deploy",
      "--file",
      outPath,
      "--mods-dir",
      modsDir,
      "--dry-run",
      "--state-path",
      join(dir, "work", "deploy-state.json"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run/);
    assert.match(result.stdout, new RegExp(modsDir.replace(/\\/g, "\\\\")));
    assert.equal(existsSync(join(modsDir, ARTIFACT_NAME)), false, "the dry run installed nothing");
  });

  it("exits 3 when the destination is an unrelated file", () => {
    const modsDir = join(dir, "ModsForeign");
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(join(modsDir, ARTIFACT_NAME), "someone else's file");

    const result = run([
      "deploy",
      "--file",
      outPath,
      "--mods-dir",
      modsDir,
      "--state-path",
      join(dir, "work", "deploy-state.json"),
    ]);
    assert.equal(result.status, 3);
    assert.match(result.stdout, /Refusing to overwrite/);
    assert.equal(readFileSync(join(modsDir, ARTIFACT_NAME), "utf8"), "someone else's file");
  });
});
