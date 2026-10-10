// Node module customization hooks that make the Deno workspace loadable:
//
// * `resolve` applies the workspace import maps (a member's own `imports`
//   over the root's), maps workspace members by package name through their
//   `exports`, and translates `npm:`, `jsr:`, and `esm.sh` specifiers to the
//   packages installed under `nodejs/node_modules`.
// * `load` compiles TypeScript and JSX with esbuild, using the root's JSX
//   settings.
//
// Registered (in-thread, synchronously) by `nodejs/register.mjs`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import {
  jsrToBare,
  loadWorkspace,
  NODEJS_DIR,
  npmToBare,
  ROOT,
} from "./workspace.mjs";

const NODEJS_PKG_URL = pathToFileURL(path.join(NODEJS_DIR, "package.json"))
  .href;

/**
 * Specifiers (after import-map translation) that resolve to a module of this
 * port rather than to an installed package.
 */
const REPLACEMENTS = {
  "jsr:@db/sqlite": pathToFileURL(path.join(NODEJS_DIR, "lib/sqlite.mjs"))
    .href,
};

const workspace = loadWorkspace();

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

/**
 * Query parameter marking a URL to be loaded as a Deno text or bytes import,
 * whose `type` attribute Node refuses.
 */
const AS_DATA_PARAM = "cf-node-import-as";

/** Deno's import attribute types beyond what Node supports. */
const DATA_IMPORT_TYPES = new Set(["text", "bytes"]);

export function resolve(specifier, context, nextResolve) {
  const asType = context.importAttributes?.type;
  if (DATA_IMPORT_TYPES.has(asType)) {
    const { importAttributes: _, ...rest } = context;
    const resolved = resolveCode(
      specifier,
      { ...rest, importAttributes: {} },
      nextResolve,
    );
    const url = new URL(resolved.url);
    url.searchParams.set(AS_DATA_PARAM, asType);
    return {
      url: url.href,
      format: "module",
      importAttributes: {},
      shortCircuit: true,
    };
  }
  return resolveCode(specifier, context, nextResolve);
}

function resolveCode(specifier, context, nextResolve) {
  const parentURL = context.parentURL;
  const parentFile = parentURL?.startsWith("file:")
    ? fileURLToPath(parentURL)
    : null;
  const inNodeModules = parentFile?.includes(
    `${path.sep}node_modules${path.sep}`,
  );

  if (
    inNodeModules || isRelativeOrAbsolute(specifier) ||
    /^(node|data|blob):/.test(specifier)
  ) {
    return nextResolve(specifier, context);
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

  if (spec.startsWith("file:")) return nextResolve(spec, context);

  const replacementKey = Object.keys(REPLACEMENTS).find((k) =>
    spec === k || spec.startsWith(k + "@")
  );
  if (replacementKey) {
    return { url: REPLACEMENTS[replacementKey], shortCircuit: true };
  }

  const memberUrl = resolveMemberName(spec);
  if (memberUrl) return { url: memberUrl, shortCircuit: true };

  let bare = spec;
  if (spec.startsWith("npm:")) bare = npmToBare(spec);
  else if (spec.startsWith("jsr:")) bare = jsrToBare(spec);
  else if (spec.startsWith("https://esm.sh/")) bare = esmShToBare(spec);
  else if (/^(node|data|blob|https?):/.test(spec)) {
    return nextResolve(spec, context);
  }

  return resolveBare(
    bare,
    { ...context, parentURL: NODEJS_PKG_URL },
    nextResolve,
  );
}

/**
 * Resolves a bare specifier from `nodejs/`. A subpath of a package with no
 * `exports` map needs its extension under Node's ESM rules, which `esm.sh`
 * (and Deno's npm resolution) supply, so a failed subpath is retried with
 * `.js`.
 */
function resolveBare(bare, context, nextResolve) {
  try {
    return nextResolve(bare, context);
  } catch (e) {
    const isSubpath = bare.split("/").length > (bare.startsWith("@") ? 2 : 1);
    if (
      e?.code !== "ERR_MODULE_NOT_FOUND" || !isSubpath || bare.endsWith(".js")
    ) {
      throw e;
    }
    return nextResolve(bare + ".js", context);
  }
}

const TS_LOADERS = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".jsx": "jsx",
};

const rootCompilerOptions = workspace.root.config.compilerOptions ?? {};

export function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.includes(AS_DATA_PARAM)) {
    return loadAsData(url);
  }
  if (!url.startsWith("file:") || url.includes("/node_modules/")) {
    return nextLoad(url, context);
  }
  const file = fileURLToPath(url);
  const loader = TS_LOADERS[path.extname(file)];
  if (!loader) return nextLoad(url, context);

  const source = fs.readFileSync(file, "utf8");
  const { code } = transformSync(source, {
    loader,
    format: "esm",
    sourcefile: file,
    sourcemap: "inline",
    // Node does not run decorators natively; naming a Node target makes
    // esbuild lower them, and leaves the rest of the syntax alone.
    target: "node24",
    jsx: rootCompilerOptions.jsx === "react-jsx" ? "automatic" : "transform",
    jsxImportSource: rootCompilerOptions.jsxImportSource,
    tsconfigRaw: {
      compilerOptions: {
        // Deno emits TypeScript with `useDefineForClassFields` on.
        useDefineForClassFields: true,
        verbatimModuleSyntax: false,
      },
    },
  });
  return { format: "module", source: code, shortCircuit: true };
}

/** Loads a file as a module whose default export is its text or bytes. */
function loadAsData(url) {
  const parsed = new URL(url);
  const asType = parsed.searchParams.get(AS_DATA_PARAM);
  parsed.search = "";
  const bytes = fs.readFileSync(fileURLToPath(parsed));
  const source = asType === "text"
    ? `export default ${JSON.stringify(bytes.toString("utf8"))};`
    : `export default Uint8Array.from(atob(${
      JSON.stringify(bytes.toString("base64"))
    }), (c) => c.charCodeAt(0));`;
  return { format: "module", source, shortCircuit: true };
}
