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
 * the hash of the bytes of the binary. A file is written whole under another name and
 * renamed into place. Two compiles of one source at once both run the
 * binary and write the same text.
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
};

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
 * Writes `files` to a directory of their own, runs the binary on them
 * there, and returns what it printed.
 */
const emit = async (
  binary: string,
  files: readonly { name: string; contents: string }[],
): Promise<string> => {
  const directory = await Deno.makeTempDir({ prefix: "cf-pattern-compile-" });
  try {
    for (const { name, contents } of files) {
      await Deno.mkdir(dirname(join(directory, name)), { recursive: true });
      await Deno.writeTextFile(join(directory, name), contents);
    }
    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command(binary, {
        args: ["emit", "--accepted", ...files.map(({ name }) => name)],
        cwd: directory,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new PatternCompilerMissingError(binary);
      }
      throw error;
    }
    const decoder = new TextDecoder();
    if (!output.success) {
      throw new PatternCompileError(
        decoder.decode(output.stderr) + decoder.decode(output.stdout),
      );
    }
    return decoder.decode(output.stdout);
  } finally {
    await Deno.remove(directory, { recursive: true });
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
  /** The identity of the binary, read at the first compile that needs it. */
  #identity: Promise<string> | undefined;

  constructor(options: PatternCompilerOptions = {}) {
    this.#binary = options.binary ?? defaultPatternCompilerBinary();
    this.#cacheDir = options.cacheDir;
  }

  /**
   * Compiles `program` and returns its artifacts. Rejects with
   * `PatternCompilerMissingError` where the binary is absent, with
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
    let text: string | undefined;
    let file: string | undefined;
    if (this.#cacheDir !== undefined) {
      this.#identity ??= binaryIdentity(this.#binary);
      file = join(
        this.#cacheDir,
        await this.#identity,
        `${hashStringOf({ main, files })}.json`,
      );
      text = await readIfPresent(file);
    }
    const cached = text !== undefined;
    if (text === undefined) {
      text = await emit(this.#binary, files);
      if (file !== undefined) {
        await Deno.mkdir(dirname(file), { recursive: true });
        const partial = `${file}.${crypto.randomUUID()}.partial`;
        await Deno.writeTextFile(partial, text);
        await Deno.rename(partial, file);
      }
    }
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
