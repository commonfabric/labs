import { join } from "@std/path/join";
import { type TsconfigRaw } from "esbuild";

export interface EntryPoint {
  // JS entry from root
  in: string;
  // JS output from `outDir`
  out: string;
  // When set, build this entry with esbuild code splitting on, so its
  // dynamically-imported subtree is emitted as a separate on-demand chunk
  // instead of inlined into the entry bundle. `splitting` is a whole-build
  // esbuild flag, so entries that opt in build in a pass isolated from those
  // that don't — a non-splitting entry stays byte-for-byte unchanged.
  splitting?: boolean;
}

export interface Config {
  // Entry points to build
  entries: EntryPoint[];
  // Output directory from root to place build artifacts.
  // Defaults to "dist".
  outDir: string;
  // Hostname to use during `serve` and `dev` commands.
  // Defaults to "127.0.0.1".
  hostname?: string;
  // Port to use during `serve` and `dev` commands.
  // Defaults to "5173".
  port?: number;
  // The public directory from root to copy to `outDir`
  // during `serve` and `dev` commands.
  // Defaults to "public".
  publicDir?: string;
  // The directory from root to watch for changes
  // to cause a JS rebuild during `dev`.
  // Defaults to "src".
  watchDir?: string;
  // While running a dev server, a regex to match
  // against a path, and if successful, will return
  // the root index.html.
  redirectToIndex?: RegExp;
  // Additional static directories to serve during development.
  // Maps source directories to URL paths.
  staticDirs?: Array<{ from: string; to: string }>;
  esbuild?: ESBuildConfig;
}

export interface ESBuildConfig {
  sourcemap?: boolean;
  minify?: boolean;
  // esbuild `chunkNames` template applied to split output, e.g.
  // "scripts/chunk-[hash]". Only meaningful for entries built with `splitting`.
  // Point it at a served subdirectory so emitted chunks are reachable by the
  // same route as the entry that imports them (and, in the dev server, are not
  // caught by an index.html fallback for unknown top-level paths).
  // https://esbuild.github.io/api/#chunk-names
  chunkNames?: string;
  // https://esbuild.github.io/api/#external
  external?: string[];
  // Maps environment variables at build time to
  // global variables in the bundled code.
  define?: Record<string, string | undefined>;
  metafile?: string;
  supported?: Record<string, boolean>;
  tsconfigRaw: TsconfigRaw;
  // https://esbuild.github.io/api/#log-override
  logOverride?: Record<
    string,
    "silent" | "verbose" | "debug" | "info" | "warning" | "error"
  >;
}

export interface ResolvedEntryPoint {
  in: string;
  out: string;
  splitting?: boolean;
}

export class ResolvedConfig {
  entries: ResolvedEntryPoint[];
  outDir: string;
  hostname: string;
  port: number;
  publicDir: string;
  watchDir: string;
  redirectToIndex?: RegExp;
  staticDirs: Array<{ from: string; to: string }>;
  esbuild: {
    sourcemap: boolean;
    external: string[];
    minify: boolean;
    chunkNames?: string;
    metafile?: string;
    define: Record<string, string | undefined>;
    supported?: Record<string, boolean>;
    tsconfigRaw?: TsconfigRaw;
    logOverride?: Record<
      string,
      "silent" | "verbose" | "debug" | "info" | "warning" | "error"
    >;
  };
  cwd: string;
  constructor(partial: Config, cwd = Deno.cwd()) {
    this.cwd = cwd;
    this.outDir = join(cwd, partial.outDir ?? "dist");
    this.entries = partial.entries.map(({ in: entry, out, splitting }) => ({
      in: join(cwd, entry),
      out: join(this.outDir, out),
      splitting,
    }));
    this.publicDir = join(cwd, partial?.publicDir ?? "public");
    this.watchDir = join(cwd, partial?.watchDir ?? "src");
    this.hostname = partial?.hostname ?? "127.0.0.1";
    this.port = partial?.port ?? 5173;
    this.redirectToIndex = partial?.redirectToIndex;
    this.staticDirs = (partial?.staticDirs ?? []).map(({ from, to }) => ({
      from: join(cwd, from),
      to,
    }));
    this.esbuild = {
      sourcemap: !!(partial?.esbuild?.sourcemap),
      minify: !!(partial?.esbuild?.minify),
      chunkNames: partial?.esbuild?.chunkNames,
      external: partial?.esbuild?.external ?? [],
      define: partial?.esbuild?.define ?? {},
      metafile: partial?.esbuild?.metafile
        ? join(cwd, partial.esbuild?.metafile)
        : undefined,
      supported: partial?.esbuild?.supported,
      tsconfigRaw: partial?.esbuild?.tsconfigRaw,
      logOverride: partial?.esbuild?.logOverride,
    };
  }
}

export type FeltCommand = "build" | "serve" | "dev";
