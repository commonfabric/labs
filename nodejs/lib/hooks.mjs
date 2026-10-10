// Node module customization hooks that make the Deno workspace loadable:
//
// * `resolve` maps specifiers as Deno would (see `resolver.mjs`), and handles
//   Deno's text and bytes imports.
// * `load` compiles TypeScript and JSX with esbuild, using the root's JSX
//   settings.
//
// Registered (in-thread, synchronously) by `nodejs/register.mjs`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import {
  isBareSubpath,
  mapSpecifier,
  rootCompilerOptions,
} from "./resolver.mjs";
import { NODEJS_DIR } from "./workspace.mjs";

const NODEJS_PKG_URL = pathToFileURL(path.join(NODEJS_DIR, "package.json"))
  .href;

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
  const mapped = mapSpecifier(specifier, parentFile);
  switch (mapped.kind) {
    case "default":
      return nextResolve(mapped.specifier, context);
    case "url":
      return nextResolve(mapped.url, context);
    case "bare":
      return resolveBare(
        mapped.bare,
        { ...context, parentURL: NODEJS_PKG_URL },
        nextResolve,
      );
  }
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
    if (
      e?.code !== "ERR_MODULE_NOT_FOUND" || !isBareSubpath(bare) ||
      bare.endsWith(".js")
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
