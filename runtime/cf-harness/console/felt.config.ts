import { type Config } from "@commonfabric/felt";

/**
 * The console's build: the operator's page, and the live pane one session is
 * watched through. Both are served by the console server itself rather than by
 * felt, so only `build` is used here: `port` and `hostname` belong to felt's
 * own dev server, which this surface does not run.
 */
const config: Config = {
  entries: [
    { in: "src/index.ts", out: "scripts/index" },
    { in: "src/live.ts", out: "scripts/live" },
  ],
  outDir: "dist",
  publicDir: "public",
  watchDir: "src",
  esbuild: {
    sourcemap: true,
    minify: false,
    tsconfigRaw: {
      compilerOptions: {
        // `useDefineForClassFields` is critical when using Lit with esbuild,
        // even when not using decorators.
        useDefineForClassFields: false,
      },
    },
  },
};

export default config;
