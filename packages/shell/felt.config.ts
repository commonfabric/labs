import { type Config } from "@commonfabric/felt";

import ports from "@commonfabric/ports" with { type: "json" };

import { computeCurrentCompilerVersion } from "../runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import { optionalPresenceUrl } from "./src/lib/presence-url.ts";

const PRODUCTION = !!Deno.env.get("PRODUCTION");
const ENVIRONMENT = PRODUCTION ? "production" : "development";
const COMPILE_CACHE_RUNTIME_VERSION = await computeCurrentCompilerVersion();
const PRESENCE_URL = optionalPresenceUrl(Deno.env.get("PRESENCE_URL"));

const SHELL_PORT = parseInt(
  Deno.env.get("SHELL_PORT") || String(ports.shell),
  10,
);

const config: Config = {
  entries: [
    { in: "src/index.ts", out: "scripts/index" },
    {
      in: "../runtime-client/src/backends/web-worker/index.ts",
      // Changing this path requires a matching update in
      // packages/shell/src/lib/runtime.ts (fetchBuildHash).
      out: "scripts/worker-runtime",
      // The TypeScript compiler stack is reached only through the single
      // dynamic import in deferred-compiler-stack.ts. Splitting emits it as a
      // separate chunk loaded on first compile, so it stays out of the worker
      // boot bundle. `index` above is a plain, unsplit bundle.
      splitting: true,
    },
  ],
  outDir: "dist",
  hostname: "127.0.0.1",
  port: SHELL_PORT,
  publicDir: "public",
  watchDir: "src",
  redirectToIndex:
    /^\/(?!((assets|scripts|styles|static|fonts)\/.*|build-manifest\.json|manifest\.webmanifest|sw\.js))/,
  staticDirs: [
    { from: "../static/assets", to: "/static" },
  ],
  esbuild: {
    sourcemap: !PRODUCTION,
    minify: PRODUCTION,
    // Emit split chunks under scripts/ (next to worker-runtime.js) with a
    // content hash in the name. Co-location keeps a chunk reachable by the same
    // /scripts/* route as the worker. Production serves the complete graph from
    // an immutable /builds/<sha>/ namespace; hashes also make repeated local
    // watch outputs safe to cache and distinguish.
    chunkNames: "scripts/chunk-[hash]",
    external: [
      "source-map-support",
      "canvas",
      "inspector",
    ],
    define: {
      "$ENVIRONMENT": ENVIRONMENT,
      "$API_URL": Deno.env.get("API_URL"),
      "$PRESENCE_URL": PRESENCE_URL?.href,
      "$COMMIT_SHA": Deno.env.get("COMMIT_SHA"),
      "$EXPERIMENTAL_MODERN_CELL_REP": Deno.env.get(
        "EXPERIMENTAL_MODERN_CELL_REP",
      ),
      "$EXPERIMENTAL_AGENT_BUILTIN": Deno.env.get(
        "EXPERIMENTAL_AGENT_BUILTIN",
      ),
      "$EXPERIMENTAL_COMPUTED_CELL_IDS": Deno.env.get(
        "EXPERIMENTAL_COMPUTED_CELL_IDS",
      ),
      "$EXPERIMENTAL_VIEW_SCOPED_REPLICATION": Deno.env.get(
        "EXPERIMENTAL_VIEW_SCOPED_REPLICATION",
      ),
      "$EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION": Deno.env.get(
        "EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION",
      ),
      "$EXPERIMENTAL_SERVER_EXECUTION": Deno.env.get(
        "EXPERIMENTAL_SERVER_EXECUTION",
      ),
      "$EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS": Deno.env.get(
        "EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS",
      ),
      "$EXPERIMENTAL_READER_SCHEMA_PRECEDENCE": Deno.env.get(
        "EXPERIMENTAL_READER_SCHEMA_PRECEDENCE",
      ),
      "globalThis.__cfCompileCacheRuntimeVersion":
        COMPILE_CACHE_RUNTIME_VERSION,
    },
    supported: {
      // Provide polyfills for `using` resource management
      using: false,
    },
    tsconfigRaw: {
      compilerOptions: {
        // `useDefineForClassFields` is critical when using Lit
        // with esbuild, even when not using decorators.
        useDefineForClassFields: false,
      },
    },
    logOverride: {
      "direct-eval": "silent",
    },
  },
};
export default config;
