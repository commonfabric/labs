import type { ProgramResolver, Source } from "@commonfabric/js-compiler";
import type { RuntimeProgram } from "./types.ts";
import { compilerStack } from "./deferred-compiler-stack.ts";

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
 * Parsing is the compiler stack's work, so the caller must have awaited
 * `ensureCompilerStack()`.
 *
 * A declared name the resolver cannot produce is an error. The program cannot
 * be assembled as its source describes it, and saying so here names both the
 * module that asked and the name it asked for, while the pattern that would
 * otherwise fail at the read is still being built.
 */
export async function attachDeclaredDataFiles(
  program: RuntimeProgram,
  resolver: Pick<ProgramResolver, "resolveSource" | "resolveDataFile">,
): Promise<RuntimeProgram> {
  const { collectDataFileNames, TARGET } = compilerStack();
  // A data file is not code and is never parsed as code. One already attached
  // is in `files` like any other entry, and its bytes may happen to read as a
  // `dataFile()` call.
  const alreadyAttached = new Set(program.dataFiles ?? []);
  const declaredBy = new Map<string, string>();
  for (const file of program.files) {
    if (alreadyAttached.has(file.name)) continue;
    for (const name of collectDataFileNames(file, TARGET)) {
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
