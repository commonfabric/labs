/**
 * Gives the serving runtimes of this toolshed a compiler for compiled
 * patterns, behind the experimental option `compiledPatterns`
 * (`docs/development/EXPERIMENTAL_OPTIONS.md`).
 *
 * With the option on, each serving runtime the serving loop creates is
 * given the loader of compiled pieces (`serveCompiledPieces()` of
 * `runtime/runner/src/compiled/serving.ts`) with one `PatternCompiler` for
 * the thread the loop runs on, the main thread or each serving worker
 * (`lib/serving-worker.ts`), which runs the binary of
 * `base/pattern-compiler` that `PATTERN_COMPILER_BINARY` names, in a child
 * process. A toolshed that is started with the option on and no such file
 * does not start: the fault is one of its configuration, and a loader
 * without a compiler would refuse every piece one by one.
 *
 * With the option off this module is imported and does nothing: the
 * modules of the executor are imported when the first serving runtime is
 * given the loader, and not before.
 */
import type { EnvReader, Runtime } from "@commonfabric/runner";

/** The environment variable that names the binary of the pattern compiler. */
export const PATTERN_COMPILER_BINARY = "PATTERN_COMPILER_BINARY";

/**
 * The environment variable that names the directory the compiler keeps
 * what it emitted in. Unset, each compile runs the binary.
 */
export const PATTERN_COMPILER_CACHE_DIR = "PATTERN_COMPILER_CACHE_DIR";

/** Why a toolshed with the option on cannot give its runtimes a compiler. */
export class CompiledPatternsMisconfiguredError extends Error {
  override name = "CompiledPatternsMisconfiguredError";
}

/** Whether a file is at `path`. */
const isFile = (path: string): boolean => {
  try {
    return Deno.statSync(path).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

/**
 * What gives a serving runtime the loader of compiled pieces, or nothing
 * with the experimental option `compiledPatterns` off. Throws
 * `CompiledPatternsMisconfiguredError` with the option on where
 * `PATTERN_COMPILER_BINARY` is unset or names no file.
 */
export const compiledPatternsForServing = (
  experimental: { compiledPatterns?: boolean },
  envGet: EnvReader,
): ((runtime: Runtime) => Promise<void>) | undefined => {
  if (experimental.compiledPatterns !== true) return undefined;
  const binary = envGet(PATTERN_COMPILER_BINARY);
  if (binary === undefined || binary === "") {
    throw new CompiledPatternsMisconfiguredError(
      "EXPERIMENTAL_COMPILED_PATTERNS is on, and " +
        `${PATTERN_COMPILER_BINARY} names no binary of the pattern compiler. ` +
        "Build it with `cargo build --release` in `base/pattern-compiler` " +
        "and set the variable to the path of the binary, or turn the " +
        "option off.",
    );
  }
  if (!isFile(binary)) {
    throw new CompiledPatternsMisconfiguredError(
      "EXPERIMENTAL_COMPILED_PATTERNS is on, and " +
        `${PATTERN_COMPILER_BINARY} names ${binary}, where no file is.`,
    );
  }
  const cacheDir = envGet(PATTERN_COMPILER_CACHE_DIR);
  // One compiler for every serving runtime of the thread, made with the
  // first of them: a compile of a source that is under way is shared.
  let installing:
    | Promise<(runtime: Runtime) => void>
    | undefined;
  return async (runtime) => {
    installing ??= (async () => {
      const [{ PatternCompiler }, { serveCompiledPieces }] = await Promise.all([
        // deno-lint-ignore cf-imports/no-inline-module-import -- a toolshed with the option off imports no module of the executor
        import("@commonfabric/runner/compiled/compile.deno"),
        // deno-lint-ignore cf-imports/no-inline-module-import -- the same: the loader imports the executor
        import("@commonfabric/runner/compiled/serving"),
      ]);
      const compiler = new PatternCompiler({
        binary,
        ...(cacheDir === undefined || cacheDir === "" ? {} : { cacheDir }),
      });
      return (made: Runtime) =>
        serveCompiledPieces(made, {
          compile: (program) => compiler.compile(program),
        });
    })();
    (await installing)(runtime);
  };
};
