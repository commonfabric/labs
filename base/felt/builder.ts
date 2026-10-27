import { debounce } from "@std/async/debounce";
import { blue, dim, green, red, yellow } from "@std/fmt/colors";
import {
  isAbsolute as isAbsolutePath,
  join as joinPath,
  relative as relativePath,
  resolve as resolvePath,
} from "@std/path";

import { denoPlugin } from "@deno/esbuild-plugin";
import * as esbuild from "esbuild";

import { ResolvedConfig, ResolvedEntryPoint } from "./interface.ts";

function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export class Builder extends EventTarget {
  #splitPassAuxiliaryOutputGenerations: Set<string>[] = [];

  constructor(public manifest: ResolvedConfig) {
    super();
  }

  async watch(watchRoot: string, debounceTimeout: number = 200) {
    const fn = debounce(async () => {
      try {
        await this.build();
      } catch (e: unknown) {
        const message = e && typeof e === "object" && "message" in e
          ? e.message
          : e;
        console.error(`   ${red("✗")} ${red("Error:")} ${message}`);
      }
    }, debounceTimeout);
    const watcher = Deno.watchFs(watchRoot);
    for await (const _ of watcher) {
      await fn();
    }
  }

  async build() {
    const startTime = performance.now();
    console.log(
      `${yellow("🔨")} ${dim("Building")} ${
        this.manifest.entries.map((e) => blue(e.in)).join(", ")
      }...`,
    );

    // esbuild's `splitting` is a whole-build flag, so entries that opt in build
    // in a pass of their own, separate from those that don't. Isolating the
    // passes keeps a non-splitting entry's output independent of any sibling
    // entry's `splitting`: it is bundled exactly as it would be with no
    // splitting entry present.
    const splitEntries = this.manifest.entries.filter((e) => e.splitting);
    const plainEntries = this.manifest.entries.filter((e) => !e.splitting);

    try {
      const passMetafiles: esbuild.Metafile[] = [];

      // One esbuild service serves both passes; stop it once, after the last.
      try {
        if (plainEntries.length > 0) {
          const metafile = await this.#runPass(plainEntries, false);
          if (metafile) passMetafiles.push(metafile);
        }
        if (splitEntries.length > 0) {
          const metafile = await this.#runPass(splitEntries, true);
          if (metafile) {
            await this.#pruneStaleSplitOutputs(metafile, splitEntries);
            passMetafiles.push(metafile);
          }
        }
      } finally {
        esbuild.stop();
      }

      if (this.manifest.esbuild.metafile) {
        const metafile = mergeMetafiles(passMetafiles);
        await Deno.writeTextFile(
          this.manifest.esbuild.metafile,
          JSON.stringify(metafile),
        );
        console.log(await esbuild.analyzeMetafile(metafile));
      }

      // Generate build manifest with content hashes of output files.
      // Used by the shell to cache-bust the worker bundle URL (?v=<hash>).
      await this.#writeBuildManifest();

      const buildTime = Math.round(performance.now() - startTime);
      console.log(`   ${dim(`Total build time: ${buildTime}ms`)}`);
      this.dispatchEvent(new CustomEvent("build"));
    } catch (error) {
      const buildTime = Math.round(performance.now() - startTime);
      console.error(
        `   ${red("✗")} ${red("Build failed")} ${dim(`after ${buildTime}ms`)}`,
      );
      throw error;
    }
  }

  /**
   * Build one esbuild pass over `entries`. When `splitting` is true, esbuild
   * code splitting is enabled for the pass: each entry's dynamically-imported
   * subtree is emitted as a separate content-hashed chunk (named via
   * `esbuild.chunkNames`) loaded on demand, rather than inlined into the entry.
   *
   * The shared esbuild service is kept alive (`stop: false`); {@link build}
   * stops it once after the final pass.
   */
  async #runPass(
    entries: ResolvedEntryPoint[],
    splitting: boolean,
  ): Promise<esbuild.Metafile | undefined> {
    const config: Parameters<typeof build>[0] = {
      define: resolveDefines(this.manifest),
      sourcemap: this.manifest.esbuild.sourcemap,
      minify: this.manifest.esbuild.minify,
      // esbuild's `{ in, out }` entry points reject unknown keys, so map to
      // just those two — `splitting` is a felt-only field consumed above.
      entryPoints: entries.map(({ in: input, out }) => ({ in: input, out })),
      outdir: this.manifest.outDir,
      external: this.manifest.esbuild.external,
      supported: this.manifest.esbuild.supported,
      tsconfigRaw: this.manifest.esbuild.tsconfigRaw,
      logOverride: this.manifest.esbuild.logOverride,
    };

    if (splitting) {
      config.splitting = true;
      if (this.manifest.esbuild.chunkNames) {
        config.chunkNames = this.manifest.esbuild.chunkNames;
      }
    }

    // Split passes always capture metadata so repeated builds can remove
    // superseded content-hashed chunks. Plain passes need it only when the
    // caller requested a combined metafile.
    if (splitting || this.manifest.esbuild.metafile) {
      config.metafile = true;
    }

    const result = await build(config, { stop: false });

    for (const output of result.outputFiles ?? []) {
      const fileInfo = await Deno.stat(output.path);
      const fileSize = formatFileSize(fileInfo.size);

      console.log(
        `   ${green("✓")} ${dim("Built")} ${blue(output.path)} ${
          dim(`(${fileSize})`)
        }`,
      );
    }
    return result.metafile;
  }

  /** Retain the current and previous split outputs, pruning anything older. */
  async #pruneStaleSplitOutputs(
    metafile: esbuild.Metafile,
    entries: ResolvedEntryPoint[],
  ): Promise<void> {
    const configuredEntryInputs = new Set(
      entries.map((entry) => resolvePath(entry.in)),
    );
    const nextOutputs = new Set(
      Object.entries(metafile.outputs)
        // Configured entry filenames are stable and overwritten in place.
        // Dynamic-import chunks may also carry an `entryPoint`, so distinguish
        // them by comparing against felt's actual configured entry inputs.
        .filter(([, output]) =>
          output.entryPoint === undefined ||
          !configuredEntryInputs.has(resolvePath(output.entryPoint))
        )
        .map(([outputPath]) => resolvePath(outputPath)),
    );

    this.#splitPassAuxiliaryOutputGenerations.push(nextOutputs);
    if (
      this.#splitPassAuxiliaryOutputGenerations.length <=
        RETAINED_SPLIT_OUTPUT_GENERATIONS
    ) {
      return;
    }

    const staleOutputs = this.#splitPassAuxiliaryOutputGenerations.shift()!;
    const retainedOutputs = new Set(
      this.#splitPassAuxiliaryOutputGenerations.flatMap((
        generation,
      ) => [...generation]),
    );
    for (const stalePath of staleOutputs) {
      if (retainedOutputs.has(stalePath)) continue;

      // Metafile paths originate from esbuild, but keep deletion explicitly
      // confined to felt's output directory.
      const relative = relativePath(this.manifest.outDir, stalePath);
      if (
        relative === ".." || relative.startsWith(`..${pathSeparator}`) ||
        isAbsolutePath(relative)
      ) {
        throw new Error(
          `Refusing to remove output outside outDir: ${stalePath}`,
        );
      }

      try {
        await Deno.remove(stalePath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }

  /**
   * Write a build manifest containing SHA-256 hashes of each output file.
   * The manifest is used by the shell to cache-bust the worker bundle URL
   * (`?v=<hash>`), so a deploy always loads the fresh worker.
   */
  async #writeBuildManifest(): Promise<void> {
    const manifest: Record<string, string> = {};
    for (const entry of this.manifest.entries) {
      // esbuild appends .js to entry.out; only .js outputs are hashed.
      const outPath = `${entry.out}.js`;
      try {
        const content = await Deno.readFile(outPath);
        const hash = await crypto.subtle.digest("SHA-256", content);
        const hex = Array.from(new Uint8Array(hash))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        // Store with path relative to outDir
        const relPath = outPath.slice(this.manifest.outDir.length + 1);
        manifest[relPath] = hex;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    const manifestPath = `${this.manifest.outDir}/build-manifest.json`;
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }
}

const pathSeparator = Deno.build.os === "windows" ? "\\" : "/";
const RETAINED_SPLIT_OUTPUT_GENERATIONS = 2;

function mergeMetafiles(metafiles: esbuild.Metafile[]): esbuild.Metafile {
  const inputs: esbuild.Metafile["inputs"] = {};
  const outputs: esbuild.Metafile["outputs"] = {};

  for (const metafile of metafiles) {
    Object.assign(inputs, metafile.inputs);
    Object.assign(outputs, metafile.outputs);
  }

  return { inputs, outputs };
}

function resolveDefines(
  manifest: ResolvedConfig,
): Record<string, string> {
  return Object.keys(manifest.esbuild.define).reduce((defines, envName) => {
    const value = manifest.esbuild.define[envName];
    defines[envName] = typeof value === "string" ? `"${value}"` : `undefined`;
    return defines;
  }, {} as Record<string, string>);
}

// Plugin to support Deno 2.4+ style text imports within esbuild:
// `import file from "./module.ts" with { type: "text" }`
function textLoaderPlugin(): esbuild.Plugin {
  return {
    name: "text-loader-plugin",
    setup(build) {
      build.onLoad({ filter: /.*/ }, async (args) => {
        if (args.with.type !== "text") return undefined;
        const contents = await Deno.readTextFile(args.path);
        if (!contents) return undefined;
        return { contents, loader: "text" };
      });
    },
  };
}

// The Deno resolver ignores npm packages' "browser" field. @opentelemetry
// packages gate their node/browser split behind it: modules import
// `./platform` (whose index re-exports `./node`), and the browser field remaps
// that index file to `platform/browser/index.js`. Without the remap the node
// platform build — `import "perf_hooks"`, `import "stream"` — lands in browser
// bundles and breaks both the browser (unresolvable specifiers) and
// `deno compile` of binaries that embed them. Reproduce exactly that file
// mapping here, scoped to @opentelemetry packages.
function otelBrowserPlatformPlugin(): esbuild.Plugin {
  const OTEL_PKG = /[/\\]@opentelemetry[/\\][^/\\]+[/\\]/;
  return {
    name: "otel-browser-platform",
    setup(build) {
      build.onResolve({ filter: /^\.\.?[/\\]platform$/ }, (args) => {
        if (!OTEL_PKG.test(args.importer)) return undefined;
        const platformDir = resolvePath(args.resolveDir, args.path);
        const browserIndex = joinPath(platformDir, "browser", "index.js");
        try {
          Deno.statSync(browserIndex);
        } catch (error) {
          // Only "file doesn't exist" means "no browser split in this
          // package"; a real I/O error must fail the build, not silently
          // fall back to bundling the node platform path.
          if (error instanceof Deno.errors.NotFound) return undefined;
          throw error;
        }
        return { path: browserIndex };
      });
    },
  };
}

// Exposes `esbuild`'s build functionality, applying
// default deno resolution plugins, browser platform,
// and ESM bundling format.
//
// `stop` (default true) tears down the shared esbuild service after the build.
// A caller running several builds back-to-back — e.g. felt's own multi-pass
// Builder — passes `{ stop: false }` on all but the last and stops the service
// itself once at the end, so it is not torn down and re-spawned per pass.
export async function build(
  config: Parameters<typeof esbuild.build>[0],
  { stop = true }: { stop?: boolean } = {},
): Promise<ReturnType<typeof esbuild.build>> {
  const fullConfig = Object.assign({}, config, {
    plugins: [
      textLoaderPlugin(),
      otelBrowserPlatformPlugin(),
      denoPlugin({ noTranspile: true }),
    ],
    platform: "browser",
    bundle: true,
    format: "esm",
  });

  const result = await esbuild.build(fullConfig);
  if (stop) esbuild.stop();
  return result;
}
