/**
 * Combine catalogs into one.
 *
 * The beta covers the base game, the installed packs and the installed mods, but
 * those live under two roots, and a scan covers one root at a time. Merging their
 * catalogs lets one build emit one package holding all of it.
 *
 * Labels must stay unique across the merged catalog, because they are part of
 * every occurrence ID: a collision is refused rather than silently renamed, since
 * renaming would orphan the translations already written against that label.
 */
import { existsSync } from "node:fs";
import {
  CATALOG_SCHEMA_VERSION,
  TOOL_NAME,
  TOOL_VERSION,
  loadCatalog,
  writeJsonAtomic,
  type Catalog,
  type CatalogOccurrence,
  type CatalogResource,
  type SourceFacts,
} from "./catalog.js";

export interface MergeOptions {
  catalogPaths: string[];
  outPath: string;
}

export interface MergeResult {
  outPath: string;
  packages: number;
  tables: number;
  strings: number;
  duplicatePathsSkipped: string[];
}

export function mergeCatalogs(options: MergeOptions): MergeResult {
  if (options.catalogPaths.length === 0) {
    throw new Error("Nothing to merge: no catalogs given.");
  }

  const packages: SourceFacts[] = [];
  const resources: CatalogResource[] = [];
  const occurrences: CatalogOccurrence[] = [];
  const labelToPath = new Map<string, string>();
  const seenPaths = new Set<string>();
  const duplicatePathsSkipped: string[] = [];
  const warnings: string[] = [];

  for (const path of options.catalogPaths) {
    if (!existsSync(path)) throw new Error(`No such catalog: "${path}"`);
    const catalog: Catalog = loadCatalog(path);
    const acceptedLabels = new Set<string>();

    for (const facts of catalog.packages) {
      const existing = labelToPath.get(facts.label);
      if (existing !== undefined) {
        // The same package listed twice is fine; the same label for two different
        // files is not.
        if (existing === facts.path) continue;
        throw new Error(
          `Label collision: "${facts.label}" is used by two different packages:\n` +
            `  ${existing}\n  ${facts.path}\n` +
            `Merging would make their occurrence IDs collide, which would orphan translations. ` +
            `Re-scan one of them with a different --pack-label.`
        );
      }
      labelToPath.set(facts.label, facts.path);
      acceptedLabels.add(facts.label);
      if (seenPaths.has(facts.path)) {
        duplicatePathsSkipped.push(facts.path);
        continue;
      }
      seenPaths.add(facts.path);
      packages.push(facts);
    }

    for (const resource of catalog.resources) {
      if (!acceptedLabels.has(resource.packageLabel)) continue;
      resources.push(resource);
    }
    for (const occurrence of catalog.occurrences) {
      if (!acceptedLabels.has(occurrence.packageLabel)) continue;
      occurrences.push(occurrence);
    }
    warnings.push(...catalog.warnings);
  }

  const merged: Catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    generatedAt: new Date().toISOString(),
    packLabel: "MERGED",
    packages,
    resources,
    occurrences,
    warnings,
  };
  writeJsonAtomic(options.outPath, merged);

  return {
    outPath: options.outPath,
    packages: packages.length,
    tables: resources.length,
    strings: occurrences.length,
    duplicatePathsSkipped,
  };
}
