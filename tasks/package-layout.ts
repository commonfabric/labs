/**
 * Where the repository keeps its packages.
 *
 * A package is a directory directly under one of {@link PACKAGE_PARENTS}, or
 * one of {@link TOP_LEVEL_PACKAGES}. A package is usually one workspace
 * member, but it can hold several: `connectors` holds one member for each part
 * of each connector.
 */

import { existsSync } from "@std/fs/exists";

/** The directories whose subdirectories are packages. */
export const PACKAGE_PARENTS = ["base", "runtime"] as const;

/** The packages that sit at the top level of the repository. */
export const TOP_LEVEL_PACKAGES = [
  "connectors",
  "dashboard",
  "patterns",
] as const;

/** Every directory holding package source, repository-relative. */
export const PACKAGE_ROOTS: readonly string[] = [
  ...PACKAGE_PARENTS,
  ...TOP_LEVEL_PACKAGES,
];

/**
 * The directory of the package holding a repository-relative path, or
 * undefined for a path in no package. A path below a top-level package is in
 * that package. A path below a parent directory is in the package named by the
 * parent and the path's next segment. A package directory is in its own
 * package.
 */
export function packageDirOf(path: string): string | undefined {
  for (const top of TOP_LEVEL_PACKAGES) {
    if (path === top || path.startsWith(`${top}/`)) return top;
  }
  for (const parent of PACKAGE_PARENTS) {
    if (!path.startsWith(`${parent}/`)) continue;
    const name = path.slice(parent.length + 1).split("/")[0];
    return name === "" ? undefined : `${parent}/${name}`;
  }
  return undefined;
}

/**
 * A path with its package's parent directory removed. Test records name a
 * workspace member this way: `runtime/runner` is `runner`. A path below no
 * parent directory, such as `connectors/agents/host`, is returned unchanged.
 */
export function withoutPackageParent(path: string): string {
  const parent = PACKAGE_PARENTS.find((dir) => path.startsWith(`${dir}/`));
  return parent === undefined ? path : path.slice(parent.length + 1);
}

/**
 * The repository-relative directory of the package that
 * {@link withoutPackageParent} calls `name`, found by looking in each place a
 * package can be under `root`.
 *
 * @throws Error when no package, or more than one, goes by that name.
 */
export function packageDirNamed(root: string, name: string): string {
  const candidates = [
    ...TOP_LEVEL_PACKAGES.filter((top) => top === name),
    ...PACKAGE_PARENTS.map((parent) => `${parent}/${name}`),
  ];
  const found = candidates.filter((dir) =>
    existsSync(`${root}/${dir}`, { isDirectory: true })
  );
  if (found.length !== 1) {
    throw new Error(
      `${found.length === 0 ? "no" : "more than one"} package is named ${name}`,
    );
  }
  return found[0];
}

/**
 * The order dependencies run in between the places packages live. A package
 * imports from packages in its own place or an earlier one; `connectors`,
 * `dashboard`, and `patterns` share the last place.
 */
const DEPENDENCY_ORDER: readonly (readonly string[])[] = [
  ["base"],
  ["runtime"],
  ["connectors", "dashboard", "patterns"],
];

/**
 * The position in {@link DEPENDENCY_ORDER} of the place holding a package
 * directory.
 *
 * @throws Error for a directory that is no package's.
 */
export function dependencyLayerOf(packageDir: string): number {
  const place = TOP_LEVEL_PACKAGES.find((top) => top === packageDir) ??
    PACKAGE_PARENTS.find((parent) => packageDir.startsWith(`${parent}/`));
  const layer = DEPENDENCY_ORDER.findIndex((places) =>
    place !== undefined && places.includes(place)
  );
  if (layer === -1) throw new Error(`${packageDir} is no package directory`);
  return layer;
}

/**
 * The categories patterns are sorted into, in the order dependencies run
 * between them: a pattern imports from its own category or an earlier one.
 */
export const PATTERN_CATEGORIES = [
  "system",
  "product",
  "apps",
  "examples",
  "showcase",
  "dev",
] as const;
