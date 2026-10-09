// Reads the Deno workspace configuration (`deno.jsonc` files) so that the
// Node loader can resolve specifiers the way Deno does: per-member import
// maps layered over the root import map, workspace members by package name,
// and `npm:` / `jsr:` / `https:` specifiers translated to installed packages.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Absolute path of the repository root. */
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Absolute path of the directory holding the Node `package.json`. */
export const NODEJS_DIR = path.join(ROOT, "nodejs");

/**
 * Parses JSONC text: JSON plus `//` and `/* *\/` comments and trailing
 * commas.
 */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      out += text.slice(start, i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: a comma followed only by whitespace and a closer.
  out = out.replace(/,(\s*[\]}])/g, "$1");
  return JSON.parse(out);
}

/** Reads and parses a `deno.jsonc` or `deno.json`, or returns `null`. */
export function readDenoConfig(dir) {
  for (const name of ["deno.jsonc", "deno.json"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      return { file, dir, config: parseJsonc(fs.readFileSync(file, "utf8")) };
    }
  }
  return null;
}

/**
 * Loads the workspace: the root config, and every member config listed in
 * its `workspace` array.
 */
export function loadWorkspace() {
  const root = readDenoConfig(ROOT);
  const members = [];
  for (const rel of root.config.workspace ?? []) {
    const dir = path.resolve(ROOT, rel);
    const member = readDenoConfig(dir);
    if (member) members.push(member);
  }
  return { root, members };
}

/**
 * Translates a `npm:` specifier to the bare specifier of the installed
 * package: `npm:@scope/name@^1.2/sub` becomes `@scope/name/sub`.
 */
export function npmToBare(spec) {
  const body = spec.slice("npm:".length).replace(/^\//, "");
  const { name, subpath } = splitNameVersionSubpath(body);
  return subpath ? `${name}/${subpath}` : name;
}

/**
 * Translates a `jsr:` specifier to the bare specifier of the package as
 * installed from the JSR npm-compatibility registry: `jsr:@std/path@^1/posix`
 * becomes `@jsr/std__path/posix`.
 */
export function jsrToBare(spec) {
  const body = spec.slice("jsr:".length).replace(/^\//, "");
  const { name, subpath } = splitNameVersionSubpath(body);
  const npmName = jsrNameToNpm(name);
  return subpath ? `${npmName}/${subpath}` : npmName;
}

/** `@scope/name` to `@jsr/scope__name`. */
export function jsrNameToNpm(name) {
  const [scope, pkg] = name.slice(1).split("/");
  return `@jsr/${scope}__${pkg}`;
}

/**
 * Splits `@scope/name@version/sub/path` (or without scope, version, or
 * subpath) into its parts.
 */
export function splitNameVersionSubpath(body) {
  const parts = body.split("/");
  const nameParts = body.startsWith("@")
    ? parts.splice(0, 2)
    : parts.splice(0, 1);
  let name = nameParts.join("/");
  let version = null;
  const at = name.indexOf("@", 1);
  if (at !== -1) {
    version = name.slice(at + 1);
    name = name.slice(0, at);
  }
  return { name, version, subpath: parts.join("/") };
}

/** File URL of the root directory, with a trailing slash. */
export const ROOT_URL = pathToFileURL(ROOT + "/").href;
