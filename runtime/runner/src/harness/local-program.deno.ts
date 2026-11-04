import { common, dirname, join } from "@std/path";
import {
  FileSystemProgramResolver,
  type ProgramResolver,
  readDataFileSource,
} from "@commonfabric/js-compiler";
import type { RuntimeProgram } from "./types.ts";

/**
 * A program assembled from files on disk.
 *
 * `main` is the entry module. `testPaths` name additional entry points whose
 * source closures are retained and compiled without being executed.
 * `dataFilePaths` name files stored with the program and never read as code.
 * A file the source names in a `dataFile()` call is attached without being
 * listed here; the option is for a path the source cannot state, and for one
 * a caller wants attached to a program that does not read it.
 *
 * `root` grounds every authored name, so it decides which file on disk a
 * grounded `dataFile()` path such as `/data/cities.json` reaches, and the
 * stored name each `dataFilePaths` entry is given. A `dataFile()` path written
 * relative to the module that reads it reaches the same file under any root.
 * Omitted, `root` is the common directory containing the entry, every test
 * entry, and every data file — the smallest root that can hold them all.
 */
export interface LocalProgramOptions {
  main: string;
  root?: string;
  testPaths?: readonly string[];
  dataFilePaths?: readonly string[];
  mainExport?: string;
}

/**
 * Assemble a program from local files: resolve the entry and any attached test
 * entries, merge their closures, and attach any data files.
 *
 * This is the one operation for building a program from disk, and every caller
 * that compiles local source goes through it. That is deliberate. Attaching
 * data files is a step a hand-rolled `resolve(new FileSystemProgramResolver())`
 * has no reason to remember, and a program assembled without them compiles and
 * type-checks perfectly — the omission only surfaces when a pattern reads one.
 * Composing the whole operation here removes the opportunity rather than
 * relying on each caller to take it.
 *
 * `deno task check-local-program` holds that line: it fails on a
 * `FileSystemProgramResolver` constructed outside this module.
 *
 * `resolve` is the harness's own `resolve`, passed in rather than imported so
 * this module carries no dependency on which engine compiles the result.
 */
export async function resolveLocalProgram(
  resolve: (resolver: ProgramResolver) => Promise<RuntimeProgram>,
  options: LocalProgramOptions,
): Promise<RuntimeProgram> {
  const entryPaths = [options.main, ...(options.testPaths ?? [])];
  const dataPaths = options.dataFilePaths ?? [];
  const root = options.root ??
    join(common([...entryPaths, ...dataPaths].map((p) => dirname(p))), ".");

  const [mainProgram, ...testPrograms] = await Promise.all(
    entryPaths.map((path) =>
      resolve(new FileSystemProgramResolver(path, root))
    ),
  );

  // One file may be reached from several entries. Identical bytes under one
  // name are the same file; differing bytes are not, and no single program can
  // hold both.
  const files = new Map<string, RuntimeProgram["files"][number]>();
  for (const program of [mainProgram, ...testPrograms]) {
    for (const file of program.files) {
      const existing = files.get(file.name);
      if (existing !== undefined && existing.contents !== file.contents) {
        throw new Error(
          `Source package contains conflicting files named "${file.name}".`,
        );
      }
      files.set(file.name, file);
    }
  }

  const declared = new Set(
    [mainProgram, ...testPrograms].flatMap((p) => p.dataFiles ?? []),
  );
  const program: RuntimeProgram = {
    main: mainProgram.main,
    files: [...files.values()],
    ...(testPrograms.length === 0
      ? {}
      : { sourceRoots: testPrograms.map((test) => test.main) }),
    ...(declared.size === 0 ? {} : { dataFiles: [...declared] }),
  };
  const withData = attachDataFiles(program, dataPaths, root);
  if (options.mainExport) withData.mainExport = options.mainExport;
  return withData;
}

/**
 * Attach data files to an already-resolved program.
 *
 * Reserved for a caller that holds a program it did not assemble from disk —
 * the source-closure recompile paths. Anything reading local files should use
 * {@link resolveLocalProgram}, which does this as part of one operation.
 *
 * A data file is read directly rather than resolved: nothing imports one, so
 * there is no closure to follow, and its bytes are never parsed.
 */
export function attachDataFiles(
  program: RuntimeProgram,
  dataFilePaths: readonly string[] | undefined,
  rootPath: string,
): RuntimeProgram {
  if (!dataFilePaths?.length) return program;
  const files = [...program.files];
  const dataFiles: string[] = [...(program.dataFiles ?? [])];
  for (const path of dataFilePaths) {
    const source = readDataFileSource(path, rootPath);
    if (dataFiles.includes(source.name)) continue;
    // The program already reaches this name through an import, so it would have
    // to both compile the file and store it uninterpreted.
    if (files.some((file) => file.name === source.name)) {
      throw new Error(
        `Data file "${source.name}" is also a source module of this program.`,
      );
    }
    files.push(source);
    dataFiles.push(source.name);
  }
  return { ...program, files, dataFiles };
}
