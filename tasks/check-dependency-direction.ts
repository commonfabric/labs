#!/usr/bin/env -S deno run --allow-read --allow-run=git

/**
 * Fails when production source imports from a place the layout puts after
 * its own.
 *
 * Packages live in places that dependencies run between in one order: `base`,
 * then `runtime`, then `connectors`, `dashboard`, and `patterns` together
 * (`dependencyLayerOf` in `tasks/package-layout.ts`). A package imports from
 * packages in its own place or an earlier one. Patterns are sorted into categories that
 * dependencies run between in the same way (`PATTERN_CATEGORIES`): a pattern
 * imports from its own category or an earlier one.
 *
 * Test code is excluded, as `check-package-cycles` excludes it: a test
 * reaches whatever it needs to exercise its subject. The edges are the ones
 * `check-package-cycles` reads, an import by package name or by a relative
 * path that climbs into another package. Between pattern categories they are
 * relative imports, which is the only way one pattern names another's module.
 */

import { dirname, fromFileUrl } from "@std/path";
import {
  buildEdges,
  extractSpecifiers,
  productionPaths,
  readWorkspace,
  resolveRelative,
} from "./check-package-cycles.ts";
import {
  dependencyLayerOf,
  PATTERN_CATEGORIES,
  withoutPackageParent,
} from "./package-layout.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** One import that runs against the order, with the file that makes it. */
export interface Violation {
  /** The package or pattern category the importing file belongs to. */
  readonly from: string;

  /** The package or pattern category the import reaches. */
  readonly to: string;

  readonly file: string;
  readonly specifier: string;
}

/** The category of a pattern file, or undefined for a path in none. */
function categoryOf(path: string): number | undefined {
  const [top, category] = path.split("/");
  if (top !== "patterns") return undefined;
  const index = PATTERN_CATEGORIES.findIndex((name) => name === category);
  return index === -1 ? undefined : index;
}

/** Every production import under `root` that runs against the order. */
export async function findViolations(root: string): Promise<Violation[]> {
  const workspace = await readWorkspace(root);
  // `check-package-cycles` names a package without its parent directory,
  // and those names are unique (`tasks/package-layout.test.ts`).
  const dirOf = new Map(
    workspace.members.map((member) => [withoutPackageParent(member), member]),
  );
  const layerOf = (name: string) => {
    const member = dirOf.get(name);
    if (member === undefined) throw new Error(`no package is named ${name}`);
    const top = member.split("/")[0];
    return dependencyLayerOf(
      top === "connectors" || top === "patterns" ? top : member,
    );
  };

  const violations: Violation[] = [];
  for (const edge of await buildEdges(root)) {
    if (layerOf(edge.from) < layerOf(edge.to)) violations.push(edge);
  }
  for (const path of await productionPaths(root, workspace)) {
    const from = categoryOf(path);
    if (from === undefined) continue;
    const source = await Deno.readTextFile(`${root}/${path}`);
    for (const specifier of extractSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const to = categoryOf(resolveRelative(path, specifier));
      if (to === undefined || to <= from) continue;
      violations.push({
        from: `patterns/${PATTERN_CATEGORIES[from]}`,
        to: `patterns/${PATTERN_CATEGORIES[to]}`,
        file: path,
        specifier,
      });
    }
  }
  return violations;
}

export async function main(root: string = REPO_ROOT): Promise<number> {
  const violations = await findViolations(root);
  if (violations.length === 0) {
    console.log("Production imports run in the layout's order.");
    return 0;
  }
  console.error(
    `\n${violations.length} production ` +
      `${violations.length === 1 ? "import runs" : "imports run"} ` +
      "against the layout's order:\n",
  );
  for (const violation of violations) {
    console.error(
      `  ${violation.from} -> ${violation.to}: ` +
        `${violation.file}  <-  ${violation.specifier}`,
    );
  }
  console.error(
    "\nMove the module to the earlier place, or the importer to the later" +
      "\none. LAYOUT.md says what each place holds.\n",
  );
  return 1;
}

if (import.meta.main) Deno.exit(await main());
