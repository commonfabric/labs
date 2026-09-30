/// <reference lib="deno.unstable" />

/**
 * A lint rule that stops a file from naming its own package in an import.
 *
 * A workspace package is meant to be named from outside it. From inside, the
 * name resolves through the package's `exports` map and lands back on a file
 * that a relative specifier would have reached directly. Two things follow, and
 * the rule reports both:
 *
 *   - The bare package name is the entry point, and the entry point reaches
 *     every module the package exports. Naming it from inside adds the edge
 *     back, so the module graph gains a cycle. When the import brings in a
 *     value rather than a type that cycle is there at run time, and the order
 *     in which the modules of the package initialize starts to depend on the
 *     order in which the entry point lists its exports. An alias from the
 *     package's own `imports` map that resolves to the entry point's file, such
 *     as `@` or `@/index.ts` where `@/` maps to `./src/`, is the same import
 *     and is reported the same way.
 *   - A subpath such as `@scope/pkg/thing` names one module rather than the
 *     whole package, so it adds no cycle. It still leaves the package and comes
 *     back, so the same file arrives under two spellings, and the shorter one
 *     stops being a reliable way to find who depends on what.
 *
 * The rule reads every form that names a module: the `import` and `export ...
 * from` declarations, a dynamic `import()`, and a type written
 * `import("...").Name`. That last one is reported for completeness rather than
 * because it is expected — `cf-imports/no-inline-type-import` rejects the form
 * outright, so one reaches here only in a file that has suppressed that rule.
 *
 * A file under a package's `test/`, `integration/`, or `bench/` directory is
 * exempt, as is one named `*.test.ts` or `*.bench.ts` anywhere in the package;
 * `test-files.ts` is what draws that line. A test that names its own package
 * is reaching for the surface a consumer sees, which is the thing it is there
 * to check.
 *
 * See docs/development/DEVELOPMENT.md.
 */

import { parse as parseJsonc } from "@std/jsonc";
import { dirname, relative, resolve } from "@std/path";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { isTestFile } from "./test-files.ts";

/** The file names a Deno configuration is allowed to take. */
const CONFIG_FILE_NAMES = ["deno.json", "deno.jsonc"] as const;

/**
 * A type written `import("...").Name`, which holds its specifier inside a
 * literal type rather than directly as the declaration forms do.
 */
interface InlineTypeImport {
  readonly argument?: { readonly literal?: { readonly value?: unknown } };
}

/** The package a file belongs to, as much of it as this rule reads. */
interface OwningPackage {
  /** The directory holding the package's Deno configuration. */
  readonly root: string;
  /** The name that configuration declares. */
  readonly name: string;
  /** The `exports` map, from specifier suffix to a path under `root`. */
  readonly exports: ReadonlyMap<string, string>;
  /** The `imports` map, from key to the address it stands for. */
  readonly imports: ReadonlyMap<string, string>;
}

/**
 * Resolved owners, keyed by directory. A lint run reads many files of the same
 * package, and this is what keeps that to one pass up the tree per directory.
 */
const ownerByDirectory = new Map<string, OwningPackage | null>();

/**
 * The Deno configuration written in `directory`, or null when there is none.
 * A file that is there but does not parse reads as an empty configuration:
 * Deno reports that itself, and a lint rule that threw over it would take the
 * whole run down over a file it only wanted a name from.
 */
function readConfig(directory: string): Record<string, unknown> | null {
  for (const name of CONFIG_FILE_NAMES) {
    let text: string;
    try {
      text = Deno.readTextFileSync(resolve(directory, name));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch {
      return {};
    }
    return isObjectOrArray(parsed) ? parsed as Record<string, unknown> : {};
  }
  return null;
}

/** The `exports` map of a configuration, keeping the entries that are paths. */
function exportMap(exports: unknown): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (typeof exports === "string") {
    map.set(".", exports);
  } else if (isObjectOrArray(exports)) {
    for (const [key, value] of Object.entries(exports)) {
      if (typeof value === "string") map.set(key, value);
    }
  }
  return map;
}

/** The `imports` map of a configuration, keeping the entries that are strings. */
function importMap(imports: unknown): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (isObjectOrArray(imports)) {
    for (const [key, value] of Object.entries(imports)) {
      if (typeof value === "string") map.set(key, value);
    }
  }
  return map;
}

/**
 * The package that owns files in `directory`. The nearest enclosing directory
 * with a Deno configuration is the package, and a configuration that declares
 * no name gives a package that cannot be named, so the walk stops there rather
 * than crediting the files to an enclosing package that does have a name.
 */
function ownerOf(directory: string): OwningPackage | null {
  if (ownerByDirectory.has(directory)) {
    return ownerByDirectory.get(directory) ?? null;
  }
  const owner = computeOwner(directory);
  ownerByDirectory.set(directory, owner);
  return owner;
}

function computeOwner(directory: string): OwningPackage | null {
  const config = readConfig(directory);
  if (config === null) {
    const parent = dirname(directory);
    return parent === directory ? null : ownerOf(parent);
  }
  const name = config.name;
  if (typeof name !== "string" || name === "") return null;
  return {
    root: directory,
    name,
    exports: exportMap(config.exports),
    imports: importMap(config.imports),
  };
}

/**
 * The file `specifier` names through the package's `imports` map, or null when
 * it names none. The match is the one an import map makes: a key equal to the
 * specifier, and failing that the longest key ending in `/` that the specifier
 * starts with. The winning entry is chosen from the whole map, and only then
 * asked whether it is a path relative to the configuration, so an entry naming
 * another package shadows a shorter one naming a directory here.
 */
function aliasTarget(owner: OwningPackage, specifier: string): string | null {
  let key = owner.imports.has(specifier) ? specifier : null;
  if (key === null) {
    for (const candidate of owner.imports.keys()) {
      if (!candidate.endsWith("/") || !specifier.startsWith(candidate)) {
        continue;
      }
      if (key === null || candidate.length > key.length) key = candidate;
    }
  }
  if (key === null) return null;
  const address = owner.imports.get(key);
  if (address === undefined || !address.startsWith("./")) return null;
  return resolve(owner.root, address, specifier.slice(key.length));
}

/** True when `specifier` is an alias for the package's entry point. */
function isEntryPointAlias(owner: OwningPackage, specifier: string): boolean {
  const entryPoint = owner.exports.get(".");
  if (entryPoint === undefined) return false;
  return aliasTarget(owner, specifier) === resolve(owner.root, entryPoint);
}

/** The specifier that reaches `to` from the file at `from`. */
function relativeSpecifier(from: string, to: string): string {
  const path = relative(dirname(from), to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

/** The advice given when the rule cannot name the file to import. */
const GENERAL_ADVICE =
  "Import the module that defines it by relative path instead.";

/**
 * The advice given for an alias of the entry point. A package that has aliases
 * addresses its own modules through them as readily as by relative path, so
 * this names no form.
 */
const ALIAS_ADVICE = "Import the module that defines it instead.";

/**
 * What to import instead: the module the offending subpath resolves to, named
 * relative to the offending file. A subpath the `exports` map does not carry
 * resolves to nothing, and the advice stays general.
 */
function suggestion(
  owner: OwningPackage,
  filename: string,
  specifier: string,
): string {
  const target = owner.exports.get(`.${specifier.slice(owner.name.length)}`);
  if (target === undefined) return GENERAL_ADVICE;
  const path = relativeSpecifier(filename, resolve(owner.root, target));
  return `Import \`${path}\` instead.`;
}

function message(
  owner: OwningPackage,
  filename: string,
  specifier: string,
): string {
  // The entry point gets no file named for it: the relative path to it reaches
  // the same barrel, so the fix is a path to whichever module defines the
  // imported name, which the rule does not know.
  const isAlias = isEntryPointAlias(owner, specifier);
  if (specifier === owner.name || isAlias) {
    const advice = isAlias ? ALIAS_ADVICE : GENERAL_ADVICE;
    return `\`${specifier}\` is the entry point of the package this file ` +
      "belongs to. Importing it from inside the package puts a cycle in the " +
      "module graph, and makes the order in which this module initializes " +
      `depend on the order the entry point lists its exports. ${advice}`;
  }
  return `\`${specifier}\` is an export of the package this file belongs to, ` +
    "and it resolves back to a file inside that package. Naming it this way " +
    `gives one module two spellings. ${suggestion(owner, filename, specifier)}`;
}

export default {
  name: "cf-package",
  rules: {
    "no-self-import": {
      create(context) {
        const owner = ownerOf(dirname(context.filename));
        if (owner === null) return {};
        if (isTestFile(owner.root, context.filename)) return {};

        // Every node that carries a module specifier carries it as `source`,
        // which is a string literal except in the dynamic-import form, where it
        // is an arbitrary expression that only sometimes is one.
        const check = (node: Deno.lint.Node, source: unknown) => {
          const value = (source as { value?: unknown } | null)?.value;
          if (typeof value !== "string") return;
          if (
            value !== owner.name && !value.startsWith(`${owner.name}/`) &&
            !isEntryPointAlias(owner, value)
          ) {
            return;
          }
          context.report({
            node,
            message: message(owner, context.filename, value),
          });
        };

        return {
          ImportDeclaration: (node) => check(node, node.source),
          ExportAllDeclaration: (node) => check(node, node.source),
          ExportNamedDeclaration: (node) => check(node, node.source),
          ImportExpression: (node) => check(node, node.source),
          TSImportType: (node) =>
            check(
              node,
              (node as unknown as InlineTypeImport).argument?.literal,
            ),
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
