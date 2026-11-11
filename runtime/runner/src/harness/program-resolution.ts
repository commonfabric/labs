/**
 * Program resolution: assembling a program from a `ProgramResolver` without
 * a runtime. The engine resolves through these functions, and a caller that
 * only needs the resolved program (a deploy staging a pattern's closure, say)
 * imports this module instead of constructing a `Runtime`, whose module graph
 * is far larger than resolution needs.
 */
import type { ProgramResolver, Source } from "@commonfabric/js-compiler";
import { getLogger } from "@commonfabric/logger";

import { RuntimeModuleIdentifiers } from "../sandbox/runtime-module-policy.ts";
import { attachDeclaredDataFiles } from "./declared-data-files.ts";
import { ensureCompilerStack } from "./deferred-compiler-stack.ts";
import type { RuntimeProgram } from "./types.ts";

const logger = getLogger("engine");

/**
 * Resolves a `ProgramResolver` into a program: the entry, each supplied
 * source root and their import closures, and the declared data files.
 *
 * This is how a program is assembled from a source of truth — a directory, a
 * web address, the fabric — so it is where a declaration in the source is
 * acted on. Re-resolving a program already held goes through
 * {@link resolveProgramModules}, which follows imports and nothing else.
 */
export async function resolveRuntimeProgram(
  program: ProgramResolver,
  options: { sourceRoots?: readonly string[] } = {},
): Promise<RuntimeProgram> {
  const roots = [...new Set(options.sourceRoots ?? [])];
  const resolved = roots.length === 0 ? await resolveProgramModules(program) : {
    ...await resolveWithSourceRoots(program, roots),
    sourceRoots: roots,
  };
  return await attachDeclaredDataFiles(resolved, program);
}

/**
 * Resolve the module closure an entry's imports reach. Resolution only
 * scans imports, so it takes the resolver from the compiler stack without
 * building a compiler, whose TypeScript environment types a runtime that
 * compiles elsewhere would otherwise hold for nothing. The options are the
 * ones `TypeScriptCompiler.resolveProgram()` passes.
 */
export async function resolveProgramModules(
  program: ProgramResolver,
): Promise<RuntimeProgram> {
  const { resolveProgram, TARGET } = await ensureCompilerStack();
  logger.timeStart("resolve");
  try {
    return await resolveProgram(program, {
      unresolvedModules: {
        type: "allow",
        identifiers: [...RuntimeModuleIdentifiers],
      },
      resolveUnresolvedModuleTypes: true,
      target: TARGET,
    });
  } finally {
    logger.timeEnd("resolve");
  }
}

/**
 * Resolve the entry's closure and each source root's, as one set of files.
 * A name two closures reach must hold the same bytes in both.
 */
export async function resolveWithSourceRoots(
  resolver: ProgramResolver,
  sourceRoots: readonly string[],
): Promise<RuntimeProgram> {
  const programs = [await resolveProgramModules(resolver)];
  for (const root of new Set(sourceRoots)) {
    if (root === programs[0].main) continue;
    programs.push(
      await resolveProgramModules(new RootedProgramResolver(resolver, root)),
    );
  }

  const files = new Map<string, Source>();
  for (const program of programs) {
    for (const file of program.files) {
      const existing = files.get(file.name);
      if (existing !== undefined && existing.contents !== file.contents) {
        throw new Error(
          `Resolved source roots produced conflicting files named ` +
            `"${file.name}".`,
        );
      }
      files.set(file.name, file);
    }
  }
  return { main: programs[0].main, files: [...files.values()] };
}

class RootedProgramResolver implements ProgramResolver {
  readonly #inner: ProgramResolver;
  readonly #root: string;

  constructor(
    inner: ProgramResolver,
    root: string,
  ) {
    this.#inner = inner;
    this.#root = root;
  }

  async main(): Promise<Source> {
    const source = await this.#inner.resolveSource(this.#root);
    if (source === undefined) {
      throw new Error(`Source root "${this.#root}" could not be resolved.`);
    }
    return source;
  }

  resolveDataFile(name: string): Promise<Source | undefined> {
    return this.#inner.resolveDataFile
      ? this.#inner.resolveDataFile(name)
      : this.#inner.resolveSource(name);
  }

  resolveSource(identifier: string): Promise<Source | undefined> {
    return this.#inner.resolveSource(identifier);
  }
}
