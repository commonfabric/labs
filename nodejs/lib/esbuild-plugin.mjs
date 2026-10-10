// The Node replacement for `jsr:@deno/esbuild-plugin`: an esbuild plugin that
// resolves workspace modules' specifiers as Deno would (see `resolver.mjs`).
// The loader hooks map `@deno/esbuild-plugin` here, so `felt` bundles under
// Node unchanged.
//
// Only what this repository uses is implemented: `denoPlugin()` with
// `noTranspile`, under which esbuild does the transpiling.

import { fileURLToPath } from "node:url";
import { isBareSubpath, mapSpecifier } from "./resolver.mjs";
import { NODEJS_DIR } from "./workspace.mjs";

/** `pluginData` marking a resolution this plugin asked esbuild for. */
const OWN_RESOLVE = Symbol("cf-node-esbuild-resolve");

export function denoPlugin(_options = {}) {
  return {
    name: "cf-node-deno-resolver",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === OWN_RESOLVE) return undefined;
        if (args.namespace !== "file" && args.namespace !== "") {
          return undefined;
        }
        // As with Deno's plugin, a Node builtin stays an import; code reaches
        // one only behind a runtime check for a server platform.
        if (args.path.startsWith("node:")) {
          return { path: args.path, external: true };
        }

        const mapped = mapSpecifier(args.path, args.importer || null);
        switch (mapped.kind) {
          case "default":
            return undefined;
          case "url":
            return { path: fileURLToPath(mapped.url) };
          case "bare":
            return await resolveBare(build, mapped.bare, args.kind);
        }
      });
    },
  };
}

/**
 * Resolves a bare specifier from `nodejs/`, where the packages are installed,
 * retrying a failed subpath with `.js` as the loader hooks do.
 */
async function resolveBare(build, bare, kind) {
  const attempt = (spec) =>
    build.resolve(spec, {
      kind,
      resolveDir: NODEJS_DIR,
      pluginData: OWN_RESOLVE,
    });
  let result = await attempt(bare);
  if (
    result.errors.length > 0 && isBareSubpath(bare) && !bare.endsWith(".js")
  ) {
    const retry = await attempt(bare + ".js");
    if (retry.errors.length === 0) result = retry;
  }
  if (result.errors.length > 0) return { errors: result.errors };
  return {
    path: result.path,
    external: result.external,
    namespace: result.namespace,
    sideEffects: result.sideEffects,
  };
}
