// Maps a specifier, as written in a workspace module, to what Node (or a
// bundler) should resolve instead, following Deno's rules for the workspace:
// a member's own import map over the root's, workspace members by package
// name through their `exports`, and `npm:`, `jsr:`, and `esm.sh` specifiers
// as packages installed under `nodejs/node_modules`.
//
// Shared by the Node loader hooks (`hooks.mjs`) and the esbuild plugin
// (`esbuild-plugin.mjs`), which each finish the resolution their own way.

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  jsrToBare,
  loadWorkspace,
  NODEJS_DIR,
  npmToBare,
  ROOT,
} from "./workspace.mjs";

/**
 * Specifiers (after import-map translation) that resolve to a module of this
 * port rather than to an installed package.
 */
const REPLACEMENTS = {
  "jsr:@db/sqlite": pathToFileURL(path.join(NODEJS_DIR, "lib/sqlite.mjs"))
    .href,
  "jsr:@deno/esbuild-plugin": pathToFileURL(
    path.join(NODEJS_DIR, "lib/esbuild-plugin.mjs"),
  ).href,
};

const workspace = loadWorkspace();

/** The root config's `compilerOptions`. */
export const rootCompilerOptions = workspace.root.config.compilerOptions ?? {};

/** One import-map scope: a config's directory and its `imports`. */
function scopeFor({ dir, config }) {
  return { dir, imports: config.imports ?? {} };
}

const rootScope = scopeFor(workspace.root);

const memberScopes = workspace.members
  .map((m) => ({
    ...scopeFor(m),
    name: m.config.name,
    exports: m.config.exports,
  }))
  .sort((a, b) => b.dir.length - a.dir.length);

const membersByName = new Map(
  memberScopes.filter((m) => m.name).map((m) => [m.name, m]),
);

/** The member whose directory contains `file`, or `null`. */
function memberFor(file) {
  for (const m of memberScopes) {
    if (file === m.dir || file.startsWith(m.dir + path.sep)) return m;
  }
  return null;
}

/**
 * Applies one import map to `spec`. Returns the mapped specifier (with a
 * relative target made absolute against `dir`), or `null` if no key matches.
 */
function applyImportMap(spec, imports, dir) {
  let target = null;
  if (Object.hasOwn(imports, spec)) {
    target = imports[spec];
  } else {
    // Longest matching prefix key. A key ending in `/` matches its prefix.
    // A key mapped to `npm:` or `jsr:` also covers its subpaths, as in Deno.
    let best = null;
    for (const key of Object.keys(imports)) {
      const value = imports[key];
      if (key.endsWith("/")) {
        if (spec.startsWith(key) && (!best || key.length > best.key.length)) {
          best = { key, value, rest: spec.slice(key.length) };
        }
      } else if (/^(npm|jsr):/.test(value) && spec.startsWith(key + "/")) {
        if (!best || key.length + 1 > best.key.length) {
          best = { key: key + "/", value, rest: spec.slice(key.length + 1) };
        }
      }
    }
    if (best) {
      target = best.value.endsWith("/")
        ? best.value + best.rest
        : `${best.value}/${best.rest}`;
    }
  }
  if (target === null) return null;
  if (target.startsWith("./") || target.startsWith("../")) {
    return pathToFileURL(path.resolve(dir, target)).href;
  }
  return target;
}

/** Resolves a workspace member's package name (with subpath) to a file. */
function resolveMemberName(spec) {
  for (const [name, m] of membersByName) {
    if (spec !== name && !spec.startsWith(name + "/")) continue;
    const sub = "." + spec.slice(name.length);
    const exports = typeof m.exports === "string"
      ? { ".": m.exports }
      : (m.exports ?? {});
    const target = exports[sub];
    if (target === undefined) {
      throw new Error(`Workspace member ${name} does not export "${sub}"`);
    }
    return pathToFileURL(path.resolve(m.dir, target)).href;
  }
  return null;
}

/** `https://esm.sh/pkg@ver/sub` to `pkg/sub`. */
function esmShToBare(spec) {
  return npmToBare("npm:" + spec.slice("https://esm.sh/".length));
}

function isRelativeOrAbsolute(spec) {
  return spec.startsWith("./") || spec.startsWith("../") ||
    spec.startsWith("/") || spec.startsWith("file:");
}

/** Whether `file` is inside a `node_modules` directory. */
export function isInNodeModules(file) {
  return file.includes(`${path.sep}node_modules${path.sep}`);
}

/**
 * Maps `specifier`, imported by the module at path `parentFile` (or `null`
 * for an entry point), to one of:
 *
 * * `{ kind: "default", specifier }`: resolve it the ordinary way, from the
 *   importer. Relative and absolute specifiers, `node:`/`data:`/`blob:` and
 *   other URLs, and anything imported from inside `node_modules`.
 * * `{ kind: "url", url }`: a `file:` URL, fully resolved.
 * * `{ kind: "bare", bare }`: a package specifier, to be resolved from
 *   `nodejs/`, where the packages are installed.
 */
export function mapSpecifier(specifier, parentFile) {
  if (
    (parentFile && isInNodeModules(parentFile)) ||
    isRelativeOrAbsolute(specifier) ||
    /^(node|data|blob):/.test(specifier)
  ) {
    return { kind: "default", specifier };
  }

  let spec = specifier;

  // Import maps: the parent's member first, then the root.
  if (parentFile && parentFile.startsWith(ROOT)) {
    const member = memberFor(parentFile);
    const mapped =
      (member && applyImportMap(spec, member.imports, member.dir)) ??
        applyImportMap(spec, rootScope.imports, rootScope.dir);
    if (mapped !== null) spec = mapped;
  }

  if (spec.startsWith("file:")) return { kind: "url", url: spec };

  const replacementKey = Object.keys(REPLACEMENTS).find((k) =>
    spec === k || spec.startsWith(k + "@")
  );
  if (replacementKey) return { kind: "url", url: REPLACEMENTS[replacementKey] };

  const memberUrl = resolveMemberName(spec);
  if (memberUrl) return { kind: "url", url: memberUrl };

  if (spec.startsWith("npm:")) return { kind: "bare", bare: npmToBare(spec) };
  if (spec.startsWith("jsr:")) return { kind: "bare", bare: jsrToBare(spec) };
  if (spec.startsWith("https://esm.sh/")) {
    return { kind: "bare", bare: esmShToBare(spec) };
  }
  if (/^(node|data|blob|https?):/.test(spec)) {
    return { kind: "default", specifier: spec };
  }
  return { kind: "bare", bare: spec };
}

/** Whether a bare specifier names a subpath of its package. */
export function isBareSubpath(bare) {
  return bare.split("/").length > (bare.startsWith("@") ? 2 : 1);
}
