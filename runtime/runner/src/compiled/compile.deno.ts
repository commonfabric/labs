/**
 * Compiles the source of a pattern to its artifacts, the plan and the value
 * code of each pattern, with the crate of `base/pattern-compiler` run as a
 * child process (milestone 5 of
 * `docs/plans/compiled-pattern-language-integration.md`). Deno-only: it
 * starts a process and reads and writes files.
 *
 * The crate reads its modules from files, so the files of the program are
 * written to a directory of their own, the binary runs there with
 * `emit --accepted`, and the directory is removed. The binary prints the
 * artifacts where every module is in the subset, and otherwise its
 * diagnostics and no artifact.
 *
 * With a cache directory, what the binary printed is kept in a file named
 * by the identity of the source: the hash of the files of the program,
 * their names and the name of the main file, under a directory named by
 * the hash of the bytes of the binary. A file is written whole under
 * another name and renamed into place. The first compile of a compiler
 * removes the directories of other binaries from the cache directory.
 *
 * The child runs beside the event loop: its output is read as it arrives,
 * and it is stopped where it prints more than a bound. One compiler runs
 * the binary once for one source at a time: a second compile of a source
 * whose compile is under way waits for that one. Two compilers, in one
 * process or in two, may both run the binary for one source, and then
 * write the same text.
 *
 * The child is the crate's own binary and no Deno process, so it reads and
 * writes nothing of the module cache of Deno.
 */
import { dirname, fromFileUrl, join, normalize } from "@std/path";
import { hashStringOf } from "@commonfabric/data-model";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { RuntimeProgram } from "../harness/types.ts";

/** The modules the crate emitted for a program, and the pattern to run. */
export type CompiledPatternSource = {
  /** The pattern the program names: `mainExport` of its main file. */
  main: Artifact;
  /** Every module the crate emitted, each with its patterns. */
  modules: { module: string; patterns: Artifact[] }[];
  /**
   * The artifact of a pattern of the program by the identity its plan
   * begins with (`CompiledPieceOptions.artifacts`).
   */
  artifacts: (id: string) => Artifact | undefined;
  /** Whether the artifacts were read from the cache directory. */
  cached: boolean;
};

/** What `compilePatternSource()` takes beside the program. */
export type PatternCompilerOptions = {
  /**
   * The path of the crate's binary. The default is the release build in
   * the checkout this module is in.
   */
  binary?: string;
  /** The directory the artifacts are kept in. Without it none is kept. */
  cacheDir?: string;
  /**
   * The most bytes the binary may print, to its standard output and to
   * its standard error each, before it is stopped and the compile is
   * rejected. The default is `DEFAULT_MAX_OUTPUT_BYTES`.
   */
  maxOutputBytes?: number;
  /** Stops the binary of a compile under way when it aborts. */
  signal?: AbortSignal;
};

/**
 * The default bound on what the binary prints: 256 MB. The largest
 * artifact of the corpus of this repository is 1.4 MB, and the corpus
 * whole is 23 MB.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** The crate's binary is not at the path it was looked for at. */
export class PatternCompilerMissingError extends Error {
  override name = "PatternCompilerMissingError";

  constructor(readonly binary: string) {
    super(
      `The pattern compiler is not at ${binary}. Build it with ` +
        "`cargo build --release` in `base/pattern-compiler`, or give the " +
        "path of its binary.",
    );
  }
}

/** The crate refused the program: `diagnostics` is what it printed. */
export class PatternCompileError extends Error {
  override name = "PatternCompileError";

  constructor(readonly diagnostics: string) {
    super(`The pattern compiler refused the program:\n${diagnostics}`);
  }
}

/** The crate's binary printed more than the bound on its output. */
export class PatternCompilerOutputError extends Error {
  override name = "PatternCompilerOutputError";

  constructor(readonly limit: number) {
    super(
      `The pattern compiler printed more than ${limit} bytes and was stopped.`,
    );
  }
}

/** The release build of the crate in the checkout this module is in. */
export const defaultPatternCompilerBinary = (): string =>
  fromFileUrl(
    new URL(
      "../../../../base/pattern-compiler/target/release/pattern-compiler",
      import.meta.url,
    ),
  );

const hex = (bytes: ArrayBuffer): string =>
  Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * The identity of the binary at `binary`: the hash of its bytes. Rejects
 * with `PatternCompilerMissingError` where no file is there.
 */
const binaryIdentity = async (binary: string): Promise<string> => {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await Deno.readFile(binary);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new PatternCompilerMissingError(binary);
    }
    throw error;
  }
  return hex(await crypto.subtle.digest("SHA-256", bytes));
};

/**
 * The path of a file of the program below the directory the binary runs
 * in. Throws for a name that leaves the directory.
 */
const relativePath = (name: string): string => {
  const path = normalize(name.replace(/^\/+/, ""));
  if (path === "" || path === "." || path.startsWith("..")) {
    throw new Error(`Not a file name of a program: ${name}`);
  }
  return path;
};

/**
 * Reads a stream of the child to its end and returns its bytes, or rejects
 * with `PatternCompilerOutputError` once it holds more than `limit` bytes.
 */
const readBounded = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new PatternCompilerOutputError(limit);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
};

/**
 * Writes `files` to a directory of their own, runs the binary on them
 * there, and returns what it printed. The child is stopped where it prints
 * more than `limit` bytes to one of its streams, and where `signal`
 * aborts.
 */
const emit = async (
  binary: string,
  files: readonly { name: string; contents: string }[],
  limit: number,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const directory = await Deno.makeTempDir({ prefix: "cf-pattern-compile-" });
  try {
    for (const { name, contents } of files) {
      await Deno.mkdir(dirname(join(directory, name)), { recursive: true });
      await Deno.writeTextFile(join(directory, name), contents);
    }
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(binary, {
        args: ["emit", "--accepted", ...files.map(({ name }) => name)],
        cwd: directory,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        ...(signal === undefined ? {} : { signal }),
      }).spawn();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new PatternCompilerMissingError(binary);
      }
      throw error;
    }
    const streams = Promise.all([
      readBounded(child.stdout, limit),
      readBounded(child.stderr, limit),
    ]);
    let stdout: Uint8Array;
    let stderr: Uint8Array;
    try {
      [stdout, stderr] = await streams;
    } catch (error) {
      // One stream went over the bound, or failed. The child is stopped,
      // the other stream is left unread, and the exit is awaited so that
      // no process outlives the compile.
      try {
        child.kill();
      } catch {
        // The child has exited already.
      }
      await Promise.allSettled([
        child.stdout.cancel(),
        child.stderr.cancel(),
      ]);
      await child.status;
      throw error;
    }
    const { success } = await child.status;
    const decoder = new TextDecoder();
    if (!success) {
      throw new PatternCompileError(
        decoder.decode(stderr) + decoder.decode(stdout),
      );
    }
    return decoder.decode(stdout);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
};

/** The name of the cache tree of a binary: the hash of its bytes, in hex. */
const TREE = /^[0-9a-f]{64}$/;

/**
 * Removes from `cacheDir` the tree of each binary other than the one whose
 * identity is `identity`. A directory entry that is not named as a tree is
 * left, so the directory may hold what another cache keeps beside it.
 */
const removeOtherTrees = async (
  cacheDir: string,
  identity: string,
): Promise<void> => {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(cacheDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const { name, isDirectory } of entries) {
    if (!isDirectory || name === identity || !TREE.test(name)) continue;
    try {
      await Deno.remove(join(cacheDir, name), { recursive: true });
    } catch (error) {
      // Another process removed the same tree.
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
};

/** Reads the text of the file at `path`, or nothing where none is there. */
const readIfPresent = async (path: string): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
};

/**
 * Compiles programs with the crate's binary at one path, and keeps what it
 * emitted in one cache directory where one is given.
 */
export class PatternCompiler {
  readonly #binary: string;
  readonly #cacheDir: string | undefined;
  readonly #maxOutputBytes: number;
  readonly #signal: AbortSignal | undefined;
  /**
   * The identity of the binary, read at the first compile that needs it,
   * once the trees of other binaries are removed from the cache directory.
   */
  #identity: Promise<string> | undefined;
  /** The compiles under way, by the identity of their source. */
  readonly #underWay = new Map<string, Promise<string>>();

  constructor(options: PatternCompilerOptions = {}) {
    this.#binary = options.binary ?? defaultPatternCompilerBinary();
    this.#cacheDir = options.cacheDir;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#signal = options.signal;
  }

  /**
   * What the binary prints for a source, from the cache directory where it
   * holds it, with whether it was read from there.
   */
  async #emitted(
    source: string,
    files: readonly { name: string; contents: string }[],
  ): Promise<{ text: string; cached: boolean }> {
    let file: string | undefined;
    if (this.#cacheDir !== undefined) {
      const cacheDir = this.#cacheDir;
      this.#identity ??= binaryIdentity(this.#binary).then(
        async (identity) => {
          await removeOtherTrees(cacheDir, identity);
          return identity;
        },
      );
      file = join(cacheDir, await this.#identity, `${source}.json`);
      const kept = await readIfPresent(file);
      if (kept !== undefined) return { text: kept, cached: true };
    }
    // One run of the binary for a source at a time: a compile of a source
    // whose compile is under way takes what that one gives.
    let running = this.#underWay.get(source);
    if (running === undefined) {
      const kept = file;
      running = (async () => {
        const text = await emit(
          this.#binary,
          files,
          this.#maxOutputBytes,
          this.#signal,
        );
        if (kept !== undefined) {
          await Deno.mkdir(dirname(kept), { recursive: true });
          const partial = `${kept}.${crypto.randomUUID()}.partial`;
          await Deno.writeTextFile(partial, text);
          await Deno.rename(partial, kept);
        }
        return text;
      })();
      this.#underWay.set(source, running);
      const settled = () => {
        if (this.#underWay.get(source) === running) {
          this.#underWay.delete(source);
        }
      };
      running.then(settled, settled);
    }
    return { text: await running, cached: false };
  }

  /**
   * Compiles `program` and returns its artifacts. Rejects with
   * `PatternCompilerMissingError` where the binary is absent, with
   * `PatternCompilerOutputError` where it prints more than the bound, with
   * `PatternCompileError` where the crate refuses the program or wrote no
   * value code for a construct of the pattern the program names, and with
   * an `Error` where the main file exports no pattern under `mainExport`.
   */
  async compile(program: RuntimeProgram): Promise<CompiledPatternSource> {
    const main = relativePath(program.main);
    const files = program.files.map(({ name, contents }) => ({
      name: relativePath(name),
      contents,
    }));
    const { text, cached } = await this.#emitted(
      hashStringOf({ main, files }),
      files,
    );
    const modules = JSON.parse(text) as CompiledPatternSource["modules"];
    const byIdentity = new Map<string, Artifact>();
    for (const { patterns } of modules) {
      for (const pattern of patterns) {
        const id = (pattern.plan as { patterns?: string[] }).patterns?.[0];
        if (id !== undefined) byIdentity.set(id, pattern);
      }
    }
    const name = program.mainExport ?? "default";
    const ofMain = modules.find(({ module }) => module === main)?.patterns;
    // The crate names a pattern held in a constant by the constant, also
    // where the module exports that constant as its default.
    const defaultName = name === "default"
      ? files.find((file) => file.name === main)?.contents.match(
        /export\s+default\s+([A-Za-z_$][\w$]*)\s*;/,
      )?.[1]
      : undefined;
    const chosen = ofMain?.find((pattern) => pattern.name === name) ??
      (defaultName === undefined
        ? undefined
        : ofMain?.find((pattern) => pattern.name === defaultName));
    if (chosen === undefined) {
      throw new Error(`${program.main} exports no pattern as \`${name}\`.`);
    }
    const unsupported = chosen.code.unsupported ?? [];
    if (unsupported.length > 0) {
      throw new PatternCompileError(
        unsupported.map(({ kind, file, start }) =>
          `${file}:${start}: no value code: ${kind}`
        ).join("\n"),
      );
    }
    return {
      main: chosen,
      modules,
      artifacts: (id) => byIdentity.get(id),
      cached,
    };
  }
}

/** Compiles `program` once, as `PatternCompiler.compile` does. */
export const compilePatternSource = (
  program: RuntimeProgram,
  options: PatternCompilerOptions = {},
): Promise<CompiledPatternSource> =>
  new PatternCompiler(options).compile(program);
