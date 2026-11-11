/**
 * The type-check, transform and emit step of a pattern compile, given as a
 * request that holds only data. The realm that asks for a compile and a
 * compile worker (`compile-worker.ts`) build the same compiler options from
 * one request, so a compile emits the same modules wherever it runs. What only
 * the asking realm holds, a pattern-coverage collector or a callback for the
 * transformed program, stays outside the request, and a compile that needs one
 * runs in that realm.
 *
 * Callers have awaited `ensureCompilerStack()`: the options built here reach
 * the transformer pipeline through `compilerStack()`.
 */

import type {
  AuthoredSourceLookup,
  CompiledTypeScriptModule,
  Program,
  Source,
  TypeScriptCompiler,
  TypeScriptCompilerOptions,
} from "@commonfabric/js-compiler";
import type {
  BuilderSourceSiteOptions,
  PatternCoverageOptions,
} from "@commonfabric/ts-transformers";
import { findFirstContentLineIndex } from "@commonfabric/ts-transformers/runtime-contract";

import type { PatternCoverageCollector } from "../pattern-coverage.ts";
import {
  FABRIC_MOUNT_ROOT,
  type FabricMount,
} from "../sandbox/module-record-compiler.ts";
import { RuntimeModuleIdentifiers } from "../sandbox/runtime-module-policy.ts";
import { compilerStack } from "./deferred-compiler-stack.ts";

/** One compile of a resolved program, as data that crosses a port. */
export interface ModuleCompileRequest {
  /** The resolved program the compiler reads, helper imports injected. */
  readonly program: Program;

  /**
   * The authored bytes behind the program's modules, under their resolved
   * names, which a diagnostic and a builder source site are mapped back to.
   */
  readonly authoredSources: readonly Source[];

  /**
   * The whole-program `/<id>` prefix of the program's module names, absent
   * where they carry none (a recompile from stored source).
   */
  readonly id?: string;

  /** The fabric mounts resolution placed in the program. */
  readonly mounts: readonly FabricMount[];

  /** Each module's content identity, by resolved name. */
  readonly moduleIdentities: ReadonlyMap<string, string>;

  /** Scheme-prefixed import specifiers, mapped to program file names. */
  readonly specifierAliases: ReadonlyMap<string, string>;

  /**
   * Whether the program is durable stored source being reloaded, which no one
   * can re-author: hygiene diagnostics and pattern shape gates then warn
   * rather than fail.
   */
  readonly storedSource: boolean;

  /** Whether to skip type-checking. */
  readonly noCheck: boolean;

  /**
   * How a type error's message reads: as TypeScript wrote it, or rewritten
   * for reactive code, briefly or at length.
   */
  readonly diagnosticMessages: "typescript" | "reactive" | "reactive-verbose";

  /** Whether the transformer names the instances a pattern creates. */
  readonly instanceNames: boolean;
}

/** What only the realm that asks for a compile can give it. */
export interface LocalCompileHooks {
  /** Collects the statement coverage of the compiled modules. */
  readonly patternCoverage?: PatternCoverageCollector;

  /** Receives the program as the transformer pipeline rewrote it. */
  readonly getTransformedProgram?: (program: Program) => void;
}

/**
 * Something that runs a {@link ModuleCompileRequest} somewhere other than the
 * realm that holds it. A rejection that is a function of the request carries
 * the error the compiler threw (`CompilerError`, `TransformerError`, or an
 * ordinary error with its name and message). One that is a failure of the
 * place the compile ran is marked with `markPlaceCompileFailure()`.
 */
export interface ModuleCompiler {
  /** Runs `request` and returns the modules it emitted, by resolved name. */
  compile(
    request: ModuleCompileRequest,
  ): Promise<Map<string, CompiledTypeScriptModule>>;
}

/**
 * Runs `request` on `compiler` in this realm, yielding between modules when
 * `interleave` says to, so that work sharing the event loop runs between the
 * steps of a compile.
 */
export async function compileModulesHere(
  compiler: TypeScriptCompiler,
  request: ModuleCompileRequest,
  options: LocalCompileHooks & { interleave: boolean },
): Promise<Map<string, CompiledTypeScriptModule>> {
  const compileOptions = moduleCompileOptions(request, options);
  return options.interleave
    ? await compiler.compileToModulesInterleaved(
      request.program,
      compileOptions,
    )
    : compiler.compileToModules(request.program, compileOptions);
}

/** The compiler options `request` stands for, with `hooks` installed. */
function moduleCompileOptions(
  request: ModuleCompileRequest,
  hooks: LocalCompileHooks = {},
): TypeScriptCompilerOptions {
  const { id, mounts } = request;
  const naming = { id, mounts, sourceFiles: request.authoredSources };
  const patternCoverage = patternCoverageOptionsForCompile(
    hooks.patternCoverage,
    naming,
  );
  const builderSourceSites = builderSourceSiteOptionsForCompile(naming);
  const stack = compilerStack();
  return {
    noCheck: request.noCheck,
    storedSource: request.storedSource,
    runtimeModules: [...RuntimeModuleIdentifiers],
    specifierAliases: request.specifierAliases,
    ...(request.diagnosticMessages === "typescript" ? {} : {
      diagnosticMessageTransformer: stack.createReactiveErrorTransformer(
        request.diagnosticMessages === "reactive-verbose",
      ),
    }),
    ...(hooks.getTransformedProgram === undefined
      ? {}
      : { getTransformedProgram: hooks.getTransformedProgram }),
    authoredSource: authoredSourceForCompile(naming),
    beforeTransformers: (program) => {
      const pipeline = new stack.CommonFabricTransformerPipeline({
        instanceNames: request.instanceNames,
        patternCoverage,
        builderSourceSites,
        storedSource: request.storedSource,
        moduleIdentities: request.moduleIdentities,
        // Writer identities record authored paths: unmap the per-load `/<id>`
        // prefix and mount paths before spelling one.
        canonicalWriterIdentityFile: (name) =>
          storedFilenameFor(name, id, mounts),
      });
      return {
        factories: pipeline.toFactories(program),
        getDiagnostics: () => pipeline.getDiagnostics(),
        getBuilderSourceSites: () => pipeline.getBuilderSourceSites(),
        getPolicyManifests: () => pipeline.getPolicyManifests(),
      };
    },
  };
}

/**
 * The authored bytes behind each helper-injected compiler input, so that a
 * compile diagnostic names the line the author wrote and quotes its text.
 */
export function authoredSourceForCompile(params: {
  id: string | undefined;
  mounts: readonly FabricMount[];
  sourceFiles: readonly Source[];
}): AuthoredSourceLookup {
  const authored = new Map(
    params.sourceFiles.map((file) => [
      coverageFilenameFor(file.name, params.id, params.mounts),
      {
        contents: file.contents,
        lineOffset: helperInjectionLineOffset(file),
      },
    ]),
  );
  return (fileName) =>
    authored.get(coverageFilenameFor(fileName, params.id, params.mounts));
}

/**
 * The name a module's file is stored under: its resolved name without a mount
 * prefix or the whole-program `/<id>` prefix.
 */
export function storedFilenameFor(
  name: string,
  id: string | undefined,
  mounts: readonly FabricMount[],
): string {
  for (const mount of mounts) {
    const prefix = `${FABRIC_MOUNT_ROOT}${mount.entryIdentity}`;
    if (name.startsWith(`${prefix}/`)) {
      return name.slice(prefix.length);
    }
  }
  return id === undefined ? name : stripModuleIdPrefix(name, id);
}

/**
 * The name coverage and diagnostics key a file by: a mount path as it is,
 * since it carries the imported module's identity, and anything else as
 * {@link storedFilenameFor} names it.
 */
export function coverageFilenameFor(
  name: string,
  id: string | undefined,
  mounts: readonly FabricMount[],
): string {
  // The coverage collector keys spans by file name and span id, and span ids
  // restart for each source file.
  if (name.startsWith(FABRIC_MOUNT_ROOT)) return name;
  return storedFilenameFor(name, id, mounts);
}

/**
 * Strip the whole-program `/<id>` prefix from a resolved module path to recover
 * the normalized authored path (e.g. `/<id>/main.tsx` → `/main.tsx`). Modules
 * resolved without the prefix (the injected `cfc.ts` helper) are returned as-is.
 */
export function stripModuleIdPrefix(name: string, id: string): string {
  const prefix = `/${id}`;
  return name.startsWith(`${prefix}/`) ? name.slice(prefix.length) : name;
}

/**
 * The line shift `transformInjectHelperModule` applies to a file's authored
 * content, mirroring its decision order. Injection puts the one-line helper
 * import ahead of the first content line and appends an `h` shim after the last
 * (base/ts-transformers/src/core/cf-helpers.ts); only the leading import
 * moves the authored lines, so an injected file shifts by exactly one line.
 * Three kinds of file reach the compiler unchanged and keep their authored
 * lines: a declaration file, which the injector skips; a stored legacy
 * envelope, whose authored bytes already carry the helper import (tolerated
 * only on the storage-fed paths — `checkCFHelperVar` rejects those bytes on
 * every authoring path); and a file with no content line to inject ahead of.
 */
export function helperInjectionLineOffset(file: Source): number {
  if (file.name.endsWith(".d.ts")) return 0;
  const { isLegacyInjectedEnvelope } = compilerStack();
  if (isLegacyInjectedEnvelope(file.contents)) return 0;
  if (findFirstContentLineIndex(file.contents.split("\n")) === null) return 0;
  return -1;
}

/**
 * Normalizes transformer source sites from helper-injected compiler inputs to
 * authored coordinates before the sidecar leaves the compile boundary.
 */
function builderSourceSiteOptionsForCompile(params: {
  id: string | undefined;
  mounts: readonly FabricMount[];
  sourceFiles: readonly Source[];
}): BuilderSourceSiteOptions {
  const sourceInfo = new Map(
    params.sourceFiles.map((file) => [
      coverageFilenameFor(file.name, params.id, params.mounts),
      {
        lineOffset: helperInjectionLineOffset(file),
        lineCount: lineCountOf(file.contents),
      },
    ]),
  );
  return {
    mapSite: (sourceFileName, site) => {
      const fileName = coverageFilenameFor(
        sourceFileName,
        params.id,
        params.mounts,
      );
      const info = sourceInfo.get(fileName);
      if (info === undefined) return undefined;
      const line = site.line + info.lineOffset;
      if (line < 1 || line > info.lineCount) return undefined;
      return { ...site, line };
    },
  };
}

// Pattern coverage runs after helper injection. This maps spans back to the
// authored file and skips spans from helper code added around the source.
function patternCoverageOptionsForCompile(
  collector: PatternCoverageCollector | undefined,
  params: {
    id: string | undefined;
    mounts: readonly FabricMount[];
    // The AUTHORED bytes per file — what the offsets are measured against.
    sourceFiles: readonly Source[];
  },
): PatternCoverageOptions | undefined {
  if (collector === undefined) return undefined;

  const sourceInfo = new Map(
    params.sourceFiles.map((file) => [
      coverageFilenameFor(file.name, params.id, params.mounts),
      {
        lineOffset: helperInjectionLineOffset(file),
        lineCount: lineCountOf(file.contents),
      },
    ]),
  );
  const unknownSourceInfo = {
    lineOffset: 0,
    lineCount: Number.POSITIVE_INFINITY,
  };

  return {
    fileName: (sourceFileName) =>
      coverageFilenameFor(sourceFileName, params.id, params.mounts),
    mapSpan: (span) => {
      const info = sourceInfo.get(span.fileName) ?? unknownSourceInfo;

      const startLine = span.startLine + info.lineOffset;
      if (startLine < 1 || startLine > info.lineCount) return undefined;

      return {
        ...span,
        startLine,
        endLine: Math.min(span.endLine + info.lineOffset, info.lineCount),
      };
    },
    registerSpan: (span) => collector.registerSpan(span),
  };
}

function lineCountOf(source: string): number {
  return source.split(/\r\n|\r|\n/).length;
}
