/**
 * Deployment safety (brief §6): only our artifact is ever touched, a dry run
 * changes nothing, an unrelated file is refused, and replacing our own previous
 * release always leaves a backup outside the Mods folder.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ARTIFACT_NAME, deploy, DeployError, loadDeployState } from "../src/deploy.js";
import { sha256File } from "../src/hashing.js";
import { REAL_ENGLISH_INSTANCE, SAMPLE_KEYS, makeTempDir, removeDir, writeFixturePackage } from "./helpers.js";

let dir: string;
let modsDir: string;
let statePath: string;
let artifactA: string;
let artifactB: string;

function makeArtifact(path: string, text: string): void {
  writeFixturePackage(path, [
    { instance: REAL_ENGLISH_INSTANCE, entries: [{ key: SAMPLE_KEYS.newGame, text }] },
  ]);
}

before(() => {
  dir = makeTempDir("deploy");
  modsDir = join(dir, "Mods");
  mkdirSync(modsDir, { recursive: true });
  statePath = join(dir, "work", "deploy-state.json");
  artifactA = join(dir, "Sims4_Eesti-a.package");
  artifactB = join(dir, "Sims4_Eesti-b.package");
  makeArtifact(artifactA, "Uus mäng");
  makeArtifact(artifactB, "Uus mäng!");
});

after(() => {
  removeDir(dir);
});

function deployOptions(overrides: {
  file?: string;
  dryRun?: boolean;
  forceReplaceUnknown?: boolean;
}) {
  return {
    file: overrides.file ?? artifactA,
    modsDir,
    dryRun: overrides.dryRun ?? false,
    forceReplaceUnknown: overrides.forceReplaceUnknown ?? false,
    statePath,
  };
}

describe("deployment", () => {
  it("copies a fresh artifact and records it", () => {
    const result = deploy(deployOptions({}));
    assert.equal(result.action, "copy");
    assert.equal(result.destinationPath, join(modsDir, ARTIFACT_NAME));
    assert.equal(sha256File(result.destinationPath), sha256File(artifactA));

    const state = loadDeployState(statePath);
    assert.equal(state.deployments.length, 1);
    assert.equal(state.deployments[0]!.destination, join(modsDir, ARTIFACT_NAME));
  });

  it("treats a repeat deploy of the same bytes as a no-op", () => {
    const result = deploy(deployOptions({}));
    assert.equal(result.action, "already-current");
    assert.equal(loadDeployState(statePath).deployments.length, 1);
  });

  it("changes nothing at all on a dry run", () => {
    const listing = readdirSync(modsDir).sort();
    const stateBefore = readFileSync(statePath, "utf8");
    const result = deploy(deployOptions({ file: artifactB, dryRun: true }));

    assert.equal(result.dryRun, true);
    assert.equal(result.action, "replace-ours");
    assert.ok(result.backupPath);
    assert.equal(sha256File(join(modsDir, ARTIFACT_NAME)), sha256File(artifactA), "not replaced");
    assert.deepEqual(readdirSync(modsDir).sort(), listing);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore);
    assert.equal(existsSync(result.backupPath!), false, "no backup written by a dry run");
  });

  it("backs up our previous release outside the Mods folder when replacing it", () => {
    const bystander = join(modsDir, "SomeOtherMod.package");
    writeFileSync(bystander, "not our file");
    const bystanderSha = sha256File(bystander);

    const result = deploy(deployOptions({ file: artifactB }));
    assert.equal(result.action, "replace-ours");
    assert.ok(result.backupPath?.includes("backups"));
    assert.equal(existsSync(result.backupPath!), true);
    assert.equal(sha256File(result.backupPath!), sha256File(artifactA), "backup holds the old bytes");
    assert.equal(sha256File(join(modsDir, ARTIFACT_NAME)), sha256File(artifactB));

    // Only our own file changed; Resource.cfg and other mods are untouched.
    assert.deepEqual(readdirSync(modsDir).sort(), [ARTIFACT_NAME, "SomeOtherMod.package"]);
    assert.equal(sha256File(bystander), bystanderSha);
  });

  it("refuses to overwrite a same-named file that is not ours", () => {
    const foreignDir = join(dir, "ForeignMods");
      mkdirSync(foreignDir, { recursive: true });
    // A package that contains something besides string tables.
    const foreign = join(foreignDir, ARTIFACT_NAME);
    writeFixturePackage(
      foreign,
      [{ instance: REAL_ENGLISH_INSTANCE, entries: [{ key: SAMPLE_KEYS.newGame, text: "New Game" }] }],
      [{ type: 0x00b2d882, group: 0, instance: 0x1n, bytes: Buffer.from([9, 9, 9]) }]
    );
    const foreignSha = sha256File(foreign);

    const refused = deploy({
      file: artifactA,
      modsDir: foreignDir,
      dryRun: false,
      forceReplaceUnknown: false,
      statePath: join(dir, "work", "other-state.json"),
    });
    assert.equal(refused.action, "refuse");
    assert.match(refused.message, /Refusing to overwrite/);
    assert.equal(sha256File(foreign), foreignSha, "the foreign file is untouched");
  });

  it("replaces a foreign file only when explicitly forced, backing it up first", () => {
    const foreignDir = join(dir, "ForeignMods2");
      mkdirSync(foreignDir, { recursive: true });
    const foreign = join(foreignDir, ARTIFACT_NAME);
    writeFileSync(foreign, "definitely not a package");

    const result = deploy({
      file: artifactA,
      modsDir: foreignDir,
      dryRun: false,
      forceReplaceUnknown: true,
      statePath: join(dir, "work", "forced-state.json"),
    });
    assert.equal(result.action, "replace-ours");
    assert.equal(readFileSync(result.backupPath!, "utf8"), "definitely not a package");
    assert.equal(sha256File(foreign), sha256File(artifactA));
  });

  it("refuses to keep its backups inside the Mods folder", () => {
    // A backup in Mods would be a second package holding an older revision of the
    // same string tables, which the game could load instead.
    const modsWithState = join(dir, "ModsWithState");
    mkdirSync(modsWithState, { recursive: true });
    // An existing release of ours at the destination, so the replace path runs.
    makeArtifact(join(modsWithState, ARTIFACT_NAME), "Vana tõlge");
    makeArtifact(artifactA, "Uus mäng");

    assert.throws(
      () =>
        deploy({
          file: artifactA,
          modsDir: modsWithState,
          dryRun: false,
          forceReplaceUnknown: false,
          statePath: join(modsWithState, "deploy-state.json"),
        }),
      (error: Error) =>
        error instanceof DeployError && /Refusing to back up inside the Mods folder/.test(error.message)
    );
    assert.deepEqual(
      readdirSync(modsWithState).sort(),
      [ARTIFACT_NAME],
      "nothing else was created in the Mods folder"
    );
  });

  it("refuses a Mods directory that does not exist", () => {
    assert.throws(
      () =>
        deploy({
          file: artifactA,
          modsDir: join(dir, "NoSuchMods"),
          dryRun: false,
          forceReplaceUnknown: false,
          statePath,
        }),
      (error: Error) => error instanceof DeployError && /does not exist/.test(error.message)
    );
  });

  it("refuses to deploy a file that is not one of our string-table packages", () => {
    const bogus = join(dir, "bogus.package");
    writeFileSync(bogus, "just text");
    assert.throws(
      () => deploy(deployOptions({ file: bogus })),
      (error: Error) =>
        error instanceof DeployError && /too short to be a DBPF package/.test(error.message)
    );
  });

  it("refuses to deploy a file that does not exist", () => {
    assert.throws(
      () => deploy(deployOptions({ file: join(dir, "missing.package") })),
      (error: Error) => error instanceof DeployError && /No such package/.test(error.message)
    );
  });
});
