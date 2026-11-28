import { SEPARATOR } from "@std/path/constants";
import { dirname } from "@std/path/dirname";
import { isAbsolute } from "@std/path/is-absolute";
import { join } from "@std/path/join";
import { normalize } from "@std/path/normalize";
import { relative } from "@std/path/relative";

import { decodeDataFile } from "@commonfabric/text/data-file";

import type { ProgramResolver, Source } from "./interface.ts";

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${SEPARATOR}`) ||
    isAbsolute(relativePath);
}

function groundedSourceName(relativePath: string): string {
  const portablePath = SEPARATOR === "/"
    ? relativePath
    : relativePath.replaceAll(SEPARATOR, "/");
  return `/${portablePath}`;
}

export class InMemoryProgram implements ProgramResolver {
  #modules: Record<string, string>;
  #main: string;
  constructor(main: string, modules: Record<string, string>) {
    this.#modules = modules;
    this.#main = main;
  }

  main(): Promise<Source> {
    const main = this.#modules[this.#main];
    if (main === undefined) {
      throw new Error(`${this.#main} not in modules.`);
    }
    return Promise.resolve({ name: this.#main, contents: main });
  }

  resolveSource(identifier: string): Promise<Source | undefined> {
    const contents = this.#modules[identifier];
    if (contents === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ contents, name: identifier });
  }

  /**
   * Lists the modules named directly inside `directory`. A directory is
   * nothing here but a prefix of names, so one holding no module is absent.
   */
  listDataFiles(directory: string): Promise<readonly string[] | undefined> {
    const parent = directory.replace(/\/+$/, "");
    const names = Object.keys(this.#modules).filter((name) =>
      name.slice(0, name.lastIndexOf("/")) === parent
    );
    return Promise.resolve(names.length === 0 ? undefined : names);
  }
}

/**
 * Read a data file from the file system as a program source, grounded against
 * `rootPath` exactly as {@link FileSystemProgramResolver} grounds a module: the
 * returned `name` is the portable, root-relative path the deployed package
 * stores it under, and a path that escapes the root — through `..` or through a
 * symbolic link — is refused.
 *
 * A source package holds text, so the bytes are decoded by `decodeDataFile`:
 * a binary media file becomes its `data:` URL, and any other file is decoded
 * as UTF-8 strictly, a file that is not valid UTF-8 being reported by name
 * rather than stored with replacement characters in place of the bytes that
 * were read.
 *
 * Deno-only.
 */
export function readDataFileSource(
  dataPath: string,
  rootPath: string,
): Source {
  const fsRoot = normalize(rootPath);
  const normalizedDataPath = normalize(dataPath);
  const relativeDataPath = relative(fsRoot, normalizedDataPath);
  if (isOutsideRoot(relativeDataPath)) {
    throw new Error(
      `Data file "${dataPath}" must be within root directory "${fsRoot}".`,
    );
  }
  const realDataPath = Deno.realPathSync(normalizedDataPath);
  if (isOutsideRoot(relative(Deno.realPathSync(fsRoot), realDataPath))) {
    throw new Error(
      `Data file "${dataPath}" must be within root directory "${fsRoot}".`,
    );
  }
  return {
    name: groundedSourceName(relativeDataPath),
    contents: decodeDataFile(Deno.readFileSync(realDataPath), dataPath),
  };
}

// Resolve a program using the file system.
// Deno-only.
export class FileSystemProgramResolver implements ProgramResolver {
  #fsRoot: string;
  #realFsRoot: string;
  #main: Source;
  constructor(mainPath: string, rootPath?: string) {
    this.#fsRoot = normalize(rootPath ?? dirname(mainPath));
    const normalizedMainPath = normalize(mainPath);
    const relativeMainPath = relative(this.#fsRoot, normalizedMainPath);
    if (rootPath && isOutsideRoot(relativeMainPath)) {
      throw new Error(
        `Main file "${mainPath}" must be within root directory "${this.#fsRoot}".`,
      );
    }
    this.#realFsRoot = Deno.realPathSync(this.#fsRoot);
    const realMainPath = Deno.realPathSync(normalizedMainPath);
    if (isOutsideRoot(relative(this.#realFsRoot, realMainPath))) {
      throw new Error(
        `Main file "${mainPath}" must be within root directory "${this.#fsRoot}".`,
      );
    }
    this.#main = {
      name: groundedSourceName(relativeMainPath),
      contents: Deno.readTextFileSync(realMainPath),
    };
  }

  main(): Promise<Source> {
    return Promise.resolve(this.#main);
  }

  resolveSource(specifier: string): Promise<Source | undefined> {
    const realPath = this.#groundedRealPath(specifier, "Import");
    if (realPath === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      name: specifier,
      contents: Deno.readTextFileSync(realPath),
    });
  }

  /**
   * Reads the data file `name` from the file system, a binary media file as
   * its base64 `data:` URL and any other file as UTF-8 text. Async so that a
   * refusal — an escaping name, or a text file whose bytes are not valid UTF-8
   * — arrives as a rejection. A method that returns a promise and also throws
   * where it is called cannot be handled one way.
   */
  async resolveDataFile(name: string): Promise<Source | undefined> {
    let realPath: string | undefined;
    try {
      realPath = this.#groundedRealPath(name, "Data file");
    } catch (error) {
      // A name with nothing behind it is the caller's to report, against the
      // module that read it. An escape is refused here, as it is for a module.
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    if (realPath === undefined) return undefined;
    return {
      name,
      contents: decodeDataFile(await Deno.readFile(realPath), name),
    };
  }

  /**
   * Lists the files directly inside the directory `directory` names, grounded
   * as a data file is, or undefined where there is no directory there. Async
   * for the reason {@link resolveDataFile} is.
   */
  async listDataFiles(
    directory: string,
  ): Promise<readonly string[] | undefined> {
    let realPath: string | undefined;
    try {
      realPath = this.#groundedRealPath(directory, "Data directory");
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    if (realPath === undefined) return undefined;
    const parent = directory.replace(/\/+$/, "");
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(realPath)) {
        const isFile = entry.isFile ||
          (entry.isSymlink && await linksToFile(join(realPath, entry.name)));
        if (isFile) names.push(`${parent}/${entry.name}`);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotADirectory) return undefined;
      throw error;
    }
    return names.sort();
  }

  /**
   * The real path a grounded specifier names, or undefined when the specifier
   * is not grounded against the root at all.
   *
   * A path that leaves the root is refused twice over: once as written, and
   * again after symbolic links are followed, so a link inside the root cannot
   * name a file outside it. `kind` names the thing being resolved in that
   * refusal, since a module and a data file both arrive here.
   */
  #groundedRealPath(specifier: string, kind: string): string | undefined {
    if (!specifier || specifier[0] !== "/") return undefined;
    const absPath = normalize(
      join(
        this.#fsRoot,
        specifier.substring(1, specifier.length).replaceAll("/", SEPARATOR),
      ),
    );
    if (isOutsideRoot(relative(this.#fsRoot, absPath))) {
      throw new Error(
        `${kind} "${specifier}" resolves outside of root directory "${this.#fsRoot}".`,
      );
    }
    const realPath = Deno.realPathSync(absPath);
    if (isOutsideRoot(relative(this.#realFsRoot, realPath))) {
      throw new Error(
        `${kind} "${specifier}" resolves outside of root directory "${this.#fsRoot}".`,
      );
    }
    return realPath;
  }
}

/**
 * Helper for `FileSystemProgramResolver.listDataFiles()`, which returns
 * whether the symbolic link `path` resolves to a file. One that resolves to
 * nothing is not a file.
 */
async function linksToFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

// Resolve a program from HTTP.
export class HttpProgramResolver implements ProgramResolver {
  #mainUrl: URL;
  #main?: Promise<Source>;
  #fetchImpl: typeof globalThis.fetch;
  constructor(
    main: string | URL,
    fetchImpl?: typeof globalThis.fetch,
  ) {
    this.#mainUrl = !(main instanceof URL) ? new URL(main) : main;
    // Keep the host receiver for browser fetch. Capturing a fetch function and
    // later calling it as a resolver field makes WorkerGlobalScope reject the
    // call with `Illegal invocation`.
    this.#fetchImpl = fetchImpl
      ? (input, init) => fetchImpl.call(globalThis, input, init)
      : (input, init) => globalThis.fetch(input, init);
  }

  main(): Promise<Source> {
    if (!this.#main) {
      this.#main = this.#fetch(this.#mainUrl);
    }
    return this.#main;
  }

  resolveSource(specifier: string): Promise<Source | undefined> {
    if (!specifier || specifier[0] !== "/") {
      return Promise.resolve(undefined);
    }
    const url = new URL(this.#mainUrl);
    url.pathname = normalize(specifier);
    return this.#fetch(url);
  }

  async resolveDataFile(name: string): Promise<Source | undefined> {
    if (!name || name[0] !== "/") return undefined;
    const url = new URL(this.#mainUrl);
    url.pathname = normalize(name);
    const res = await this.#fetchImpl(url);
    // Absent is the caller's to report, against the module that read the name.
    // Anything else — unauthorized, forbidden, a server fault — is not absence,
    // and saying the file is missing would send the reader after the wrong
    // thing.
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(
        `Failed to fetch data file ${url}: ${res.status} ${res.statusText}`,
      );
    }
    return {
      name,
      contents: decodeDataFile(new Uint8Array(await res.arrayBuffer()), name),
    };
  }

  async #fetch(url: URL): Promise<Source> {
    const res = await this.#fetchImpl(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${res.status} ${res.statusText}`,
      );
    }
    const contents = await res.text();
    return {
      name: url.pathname,
      contents,
    };
  }
}
