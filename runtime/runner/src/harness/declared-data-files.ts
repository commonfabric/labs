import type {
  ModuleDeclarations,
  ProgramResolver,
  Source,
} from "@commonfabric/js-compiler";
import { resolveDeclaredDataFile } from "@commonfabric/js-compiler/specifier";

import type { SourcePackageIdentity } from "../sandbox/module-record-compiler.ts";
import { compilerStack } from "./deferred-compiler-stack.ts";
import type { RuntimeProgram } from "./types.ts";

/**
 * Attach the data files a program's own source declares.
 *
 * A pattern declares the code it depends on by importing it, and the resolver
 * follows that declaration. A pattern declares the data it depends on by
 * reading it, with `dataFile("./cities.json")`, and this follows that one.
 * Both are read out of the source, so a program carries the same files however
 * it was built and whoever built it, and no caller has to state a second time
 * what the source already says.
 *
 * A read resolves against the module that wrote it, as an import specifier
 * does, so the name a file is attached under here is the name the runtime will
 * look it up by.
 *
 * The names come from the resolved closure, and each is read back through the
 * resolver that produced it, so a program assembled from the file system, from
 * a web address, or from anywhere else reaches its data the way it reaches its
 * source. Reading is all this asks of the resolver.
 *
 * A module with an entry in `declarations`, keyed by file name, is read from
 * that scan; any other is parsed here, which is the compiler stack's work, so
 * the caller must have awaited `ensureCompilerStack()`.
 *
 * A declared name the resolver cannot produce is an error. The program cannot
 * be assembled as its source describes it, and saying so here names both the
 * module that asked and the name it asked for, while the pattern that would
 * otherwise fail at the read is still being built.
 */
export async function attachDeclaredDataFiles(
  program: RuntimeProgram,
  resolver: Pick<ProgramResolver, "resolveSource" | "resolveDataFile">,
  declarations: ReadonlyMap<string, ModuleDeclarations> = new Map(),
): Promise<RuntimeProgram> {
  // A data file is not code and is never parsed as code. One already attached
  // is in `files` like any other entry, and its bytes may happen to read as a
  // `dataFile()` call.
  const alreadyAttached = new Set(program.dataFiles ?? []);
  const declaredBy = new Map<string, string>();
  for (const file of program.files) {
    if (alreadyAttached.has(file.name)) continue;
    for (const name of declaredDataFiles(file, declarations.get(file.name))) {
      if (!declaredBy.has(name)) declaredBy.set(name, file.name);
    }
  }
  if (declaredBy.size === 0) return program;

  const attached: Source[] = [];
  const names: string[] = [];
  for (const [name, source] of declaredBy) {
    // A name the closure already holds is a module the program compiles, and
    // reading it as data as well would store it twice under one name.
    if (program.files.some((file) => file.name === name)) continue;
    const file = resolver.resolveDataFile
      ? await resolver.resolveDataFile(name)
      : await resolver.resolveSource(name);
    if (file === undefined) {
      throw new Error(
        `"${source}" reads the data file "${name}", which this program does ` +
          `not contain. Store it under the program root at that path.`,
      );
    }
    attached.push({ ...file, name });
    names.push(name);
  }
  if (names.length === 0) return program;
  return {
    ...program,
    files: [...program.files, ...attached],
    dataFiles: [...new Set([...(program.dataFiles ?? []), ...names])],
  };
}

/**
 * Assigns each edge of a program's source package to the module that owns it.
 *
 * A module whose `dataFile()` call names a data file owns the edge to that
 * file, so the module's identity covers the bytes it reads and its stored
 * documents link to them. A load entered at that module by its own identity,
 * as a sub-pattern referenced by `{ identity, symbol }` is loaded, then
 * reaches the file. The entry owns every attached source root, and every data
 * file no module's source names: one read by a computed path, or one nothing
 * reads. Those are the only edges whose owner depends on which module is the
 * entry, so a module compiled as the entry and as a child gets one identity
 * when the program carries neither.
 *
 * `modules` are the code modules whose identities are being computed, and only
 * those can own an edge, so a reader the program's roots never reach leaves
 * its file to the entry. Each one's reads resolve against
 * `storedNameFor(name)`, the name the runtime resolves them against; the
 * result names modules and files the way `program` does. A module that owns
 * nothing has no entry in the result.
 *
 * A module with an entry in `program.declarations`, keyed by module name, is
 * read from that scan; any other is parsed here, which is the compiler stack's
 * work, so the caller must have awaited `ensureCompilerStack()`.
 */
export function sourcePackageOwners(
  program: {
    main: string;
    sourceRoots: readonly string[];
    dataPaths: readonly string[];
    modules: readonly Source[];
    declarations?: ReadonlyMap<string, ModuleDeclarations>;
  },
  storedNameFor: (name: string) => string = (name) => name,
): SourcePackageIdentity[] {
  const dataByStoredName = new Map(
    program.dataPaths.map((path) => [storedNameFor(path), path]),
  );
  const dataByOwner = new Map<string, Set<string>>();
  const claimed = new Set<string>();
  if (dataByStoredName.size > 0) {
    for (const module of program.modules) {
      // A scan holds under the stored name, which keeps the base name.
      const read = {
        name: storedNameFor(module.name),
        contents: module.contents,
      };
      const declared = program.declarations?.get(module.name);
      for (const name of declaredDataFiles(read, declared)) {
        const path = dataByStoredName.get(name);
        if (path === undefined) continue;
        claimed.add(path);
        const owned = dataByOwner.get(module.name) ?? new Set<string>();
        owned.add(path);
        dataByOwner.set(module.name, owned);
      }
    }
  }
  const entryData = dataByOwner.get(program.main) ?? new Set<string>();
  for (const path of program.dataPaths) {
    if (!claimed.has(path)) entryData.add(path);
  }
  dataByOwner.delete(program.main);

  const owners: SourcePackageIdentity[] = [];
  if (program.sourceRoots.length > 0 || entryData.size > 0) {
    owners.push({
      ownerPath: program.main,
      rootPaths: [...program.sourceRoots],
      dataPaths: [...entryData].sort(),
    });
  }
  for (const [ownerPath, owned] of dataByOwner) {
    owners.push({ ownerPath, rootPaths: [], dataPaths: [...owned].sort() });
  }
  return owners;
}

/**
 * Helper for the two functions above, which returns the data-file names
 * `module` declares, resolved against its name. `declared` is the module's
 * scan, when the caller holds one; without it the module is parsed here.
 */
function declaredDataFiles(
  module: Source,
  declared: ModuleDeclarations | undefined,
): string[] {
  if (declared === undefined) {
    const { collectDataFileNames, TARGET } = compilerStack();
    return collectDataFileNames(module, TARGET);
  }
  return declared.dataFiles.map((path) =>
    resolveDeclaredDataFile(path, module)
  );
}
