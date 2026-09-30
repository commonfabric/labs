import * as path from "@std/path";

import type { BuilderSourceSitesV1 } from "@commonfabric/ts-transformers/runtime-contract";
import { getLogger } from "@commonfabric/utils/logger";
import { yieldToEventLoop } from "@commonfabric/utils/sleep";
import type {
  CompilerHost,
  CompilerOptions,
  FileReference,
  ModuleResolutionHost,
  ResolvedModuleWithFailedLookupLocations,
  ResolvedProjectReference,
  ResolvedTypeReferenceDirectiveWithFailedLookupLocations,
  ScriptTarget,
  SourceFile,
  StringLiteralLike,
} from "typescript";
import ts from "typescript";

import { Program, ProgramResolver, Source } from "../interface.ts";
import type { SourceMap } from "../interface.ts";
import { parseSourceMap } from "../source-map.ts";
import {
  Checker,
  type DiagnosticMessageTransformer,
  formatTransformerDiagnostic,
  TransformerDiagnosticInfo,
  TransformerError,
} from "./diagnostics/mod.ts";
import { getCompilerOptions, TARGET } from "./options.ts";
import { resolveProgram } from "./resolver.ts";

const DEBUG_VIRTUAL_FS = false;
const VFS_TYPES_DIR = "$types/";

// Create a separate debug logger for VirtualFs operations
const vfsLogger = getLogger("virtualfs", {
  enabled: DEBUG_VIRTUAL_FS,
  level: "debug",
});

// Surfaces transformer-pipeline warnings. Errors are thrown via
// TransformerError; warnings have no other channel, so without this they are
// collected and silently dropped. Emitting them through the logger gates
// visibility on the host's log level: `cf` defaults the floor to `warn` so
// authors see them, while server/library compile paths that keep the `error`
// floor stay quiet.
const transformerLogger = getLogger("transformer");

// Compile-phase spans (`js-compiler/phase/<step>`): timing stats record even
// while the logger is disabled, so a cold compile's cost decomposes into
// program build vs type-check vs emit wherever timing stats are read (e.g.
// the integration-test load summaries). Per-file steps record one span per
// file — `n` is the file count, `max` the most expensive file.
const compileTimingLogger = getLogger("js-compiler", { enabled: false });

function surfaceTransformerWarnings(
  diagnostics: readonly TransformerDiagnosticInfo[],
  program: Program,
): void {
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  if (warnings.length === 0) return;
  const sources = new Map<string, string>();
  for (const file of program.files) sources.set(file.name, file.contents);
  for (const warning of warnings) {
    transformerLogger.warn(
      "transform-diagnostic",
      formatTransformerDiagnostic(warning, sources.get(warning.fileName) ?? ""),
    );
  }
}

// Mapping from virtual type path (e.g. `$types/es2023.d.ts`)
type TypeLibs = Record<string, string>;

class VirtualFs implements ModuleResolutionHost {
  readonly #types: Record<string, string>;
  readonly #fsRead: Record<string, string>;
  readonly #fsWrite: Record<string, string> = Object.create(null);
  readonly #debug: boolean;
  constructor(
    input: Program,
    typeLib: TypeLibs,
    debug?: boolean,
  ) {
    this.#fsRead = input.files.reduce((acc, file) => {
      acc[file.name] = file.contents;
      return acc;
    }, Object.create(null));
    this.#types = typeLib;
    this.#debug = !!debug;
  }

  writeFile(fileName: unknown, content: unknown) {
    if (typeof fileName !== "string") {
      throw new Error("file name not string:" + typeof fileName);
    }
    if (typeof content !== "string") {
      throw new Error("content not string:" + typeof content);
    }
    vfsLogger.debug(
      "vfs",
      () => `writeFile - ${fileName} (${content.length} chars)`,
    );
    this.#fsWrite[fileName] = content;
  }

  getCurrentDirectory(): string {
    vfsLogger.debug("vfs", () => "getCurrentDirectory - returning /");
    return "/";
  }

  getDirectories(_path: string): string[] {
    throw new Error("getDirectories() not implemented.");
  }

  fileExists(fileName: string): boolean {
    const exists = !!this.#innerRead(fileName);
    vfsLogger.debug("vfs", () => `fileExists - ${fileName}: ${exists}`);
    return exists;
  }

  readFile(fileName: string): string | undefined {
    const content = this.#innerRead(fileName);
    vfsLogger.debug(
      "vfs",
      () =>
        `readFile - ${fileName}: ${
          content ? content.length + " chars" : "not found"
        }`,
    );
    return content;
  }

  useCaseSensitiveFileNames() {
    return true;
  }

  getWrites(): Record<string, string> {
    return this.#fsWrite;
  }

  #innerRead(fileName: string): string | undefined {
    let innerRecord;
    if (fileName.startsWith(VFS_TYPES_DIR)) {
      innerRecord = this.#types;
    } else {
      innerRecord = this.#fsRead;
    }
    const content = innerRecord[fileName];
    vfsLogger.debug(
      "vfs",
      () => `innerRead - ${fileName}: ${content ? "found" : "not found"}`,
    );
    return content;
  }
}

class TypeScriptHost extends VirtualFs implements CompilerHost {
  #allowedRuntimeModules: string[];
  #specifierAliases?: ReadonlyMap<string, string>;
  constructor(
    source: Program,
    typeLibs: TypeLibs,
    allowedRuntimeModules: string[],
    specifierAliases?: ReadonlyMap<string, string>,
  ) {
    super(source, typeLibs, DEBUG_VIRTUAL_FS);
    this.#allowedRuntimeModules = allowedRuntimeModules;
    this.#specifierAliases = specifierAliases;
  }

  getDefaultLibFileName(_options: CompilerOptions): string {
    return "lib.d.ts";
  }

  getDefaultLibLocation(): string {
    return VFS_TYPES_DIR;
  }

  getEnvironmentVariable(_name: string): string | undefined {
    return undefined;
  }

  resolveTypeReferenceDirectiveReferences?<T extends FileReference | string>(
    _typeDirectiveReferences: readonly T[],
    _containingFile: string,
    _redirectedReference: ResolvedProjectReference | undefined,
    _options: CompilerOptions,
    _containingSourceFile: SourceFile | undefined,
    _reusedNames: readonly T[] | undefined,
  ): readonly ResolvedTypeReferenceDirectiveWithFailedLookupLocations[] {
    throw new Error("ResolveTypeReferenceDirectiveReferences");
  }

  getCanonicalFileName(fileName: string): string {
    return fileName;
  }

  getNewLine() {
    return "\n";
  }

  getSourceFile(
    fileName: string,
    languageVersion: ScriptTarget,
    _onError?: (message: string) => void,
  ): SourceFile | undefined {
    const sourceText = this.readFile(fileName);
    return sourceText !== undefined
      ? ts.createSourceFile(fileName, sourceText, languageVersion)
      : undefined;
  }

  resolveModuleNameLiterals(
    moduleLiterals: readonly StringLiteralLike[],
    containingFile: string,
  ): readonly ResolvedModuleWithFailedLookupLocations[] {
    return moduleLiterals.map((literal) => {
      const name = literal.text;
      const aliased = this.#specifierAliases?.get(name);
      if (aliased !== undefined) {
        return {
          resolvedModule: {
            resolvedFileName: aliased,
            extension: aliased.endsWith(".tsx")
              ? ts.Extension.Tsx
              : ts.Extension.Ts,
          },
        };
      }
      if (name[0] === "." || name[0] === "/") {
        const resolved = path.join(path.dirname(containingFile), name);
        return {
          resolvedModule: {
            resolvedFileName: resolved,
            extension: ts.Extension.Ts,
          },
        };
      }
      // This module could not be found in the input
      // e.g. `@commonfabric/foo`. If a type definition was provided
      // with the same identifier with a `.d.ts` extension, that will be used
      // for types, leaving the module implementation resolution to runtime.
      if (this.#allowedRuntimeModules.includes(name)) {
        return {
          resolvedModule: {
            resolvedFileName: `${name}.d.ts`,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: true,
            packageId: undefined,
          },
        };
      }
      return { resolvedModule: undefined };
    });
  }
}

/**
 * Result from a transformer pipeline that can include diagnostics.
 */
export interface TransformerPipelineResult {
  factories: ts.TransformerFactory<ts.SourceFile>[];
  getDiagnostics?: () => readonly TransformerDiagnosticInfo[];
  getBuilderSourceSites?: () => ReadonlyMap<string, BuilderSourceSitesV1>;
  getPolicyManifests?: () => ReadonlyMap<string, readonly unknown[]>;
}

export interface CompiledTypeScriptModule {
  js: string;
  sourceMap?: SourceMap;
  builderSourceSites?: BuilderSourceSitesV1;
  policyManifests?: readonly unknown[];
}

/**
 * Type for beforeTransformers - can return either:
 * - An array of transformer factories (legacy/simple case)
 * - A TransformerPipelineResult with factories and optional getDiagnostics
 */
export type BeforeTransformersResult =
  | ts.TransformerFactory<ts.SourceFile>[]
  | TransformerPipelineResult;

export interface TypeScriptCompilerOptions {
  // Skip type checking.
  noCheck?: boolean;

  /**
   * The program is DURABLE STORED pattern source being reloaded — bytes
   * nobody can re-author, recompiled by a toolchain newer than the one that
   * accepted them. Diagnostics that only signal authoring hygiene (currently
   * TS2578, "Unused '@ts-expect-error' directive" — a suppression obsoleted
   * by a platform type improvement) are non-fatal in this mode, so a types
   * bump cannot retroactively brick a stored pattern (CT-1916, 2026-07-28
   * estuary). Authoring paths (cf check, deploy, the corpus check) leave
   * this off and stay strict: there the author is present and can fix the
   * directive.
   */
  storedSource?: boolean;

  // Optional mapping of runtime module name e.g. `"@commonfabric/framework"`,
  // and its corresponding type definitions.
  runtimeModules?: string[];

  /**
   * Maps an import specifier (verbatim text) to a program file name. Used for
   * scheme-prefixed specifiers that the path-join and runtime-module rules
   * cannot resolve. The target must be a file in the program.
   */
  specifierAliases?: ReadonlyMap<string, string>;

  // Transformations to run before JS transforms.
  // Can return either an array of transformer factories (simple case)
  // or a TransformerPipelineResult with factories and getDiagnostics.
  beforeTransformers?: (
    program: ts.Program,
  ) => BeforeTransformersResult;
  // Return the transformed program.
  getTransformedProgram?: (program: Program) => void;
  // Optional transformer for diagnostic error messages.
  // Allows converting confusing TypeScript errors into clearer messages.
  diagnosticMessageTransformer?: DiagnosticMessageTransformer;
}

export class TypeScriptCompiler {
  #typeLibs: TypeLibs;
  constructor(typeLibs: TypeLibs) {
    this.#typeLibs = Object.keys(typeLibs).reduce((libs, libName) => {
      libs[`${VFS_TYPES_DIR}${libName}.d.ts`] = typeLibs[libName];
      return libs;
    }, {} as TypeLibs);
  }

  resolveProgram(
    resolver: ProgramResolver,
    options: Pick<TypeScriptCompilerOptions, "runtimeModules"> = {},
  ): Promise<Program> {
    return resolveProgram(resolver, {
      unresolvedModules: {
        type: "allow",
        identifiers: options.runtimeModules ?? [],
      },
      resolveUnresolvedModuleTypes: true,
      target: TARGET,
    });
  }

  /**
   * Compile a program to per-module CommonJS, running the type-check and
   * Common Fabric transformer pipeline and emitting one CommonJS file per
   * source. Returns the compiled body + source map per original source name —
   * the inputs the ESM module-record loader and verifier consume.
   *
   * Synchronous: runs {@link compileToModulesSteps} to completion in one
   * stretch. In an event-loop-sharing host (the browser runtime worker), use
   * {@link compileToModulesInterleaved} instead so queued tasks interleave.
   */
  compileToModules(
    program: Program,
    inputOptions: TypeScriptCompilerOptions = {},
  ): Map<string, CompiledTypeScriptModule> {
    const steps = this.#compileToModulesSteps(program, inputOptions);
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
    }
  }

  /**
   * {@link compileToModules}, yielding one macrotask turn between pipeline
   * steps (program build, then each module's type-check / declaration-check /
   * transform+emit). A cold compile is a multi-hundred-ms-to-seconds CPU-bound
   * pipeline; run synchronously it wedges the host's event loop for its whole
   * duration — in the browser runtime worker that stalls every queued IPC
   * delivery (cell traffic) until the compile finishes. Yielding at module
   * boundaries bounds the stall to the longest single step instead.
   *
   * Same inputs, outputs, errors, and step order as the synchronous driver —
   * both drain {@link compileToModulesSteps}.
   */
  async compileToModulesInterleaved(
    program: Program,
    inputOptions: TypeScriptCompilerOptions = {},
  ): Promise<Map<string, CompiledTypeScriptModule>> {
    const steps = this.#compileToModulesSteps(program, inputOptions);
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
      await yieldToEventLoop();
    }
  }

  /**
   * The compile pipeline as a generator, yielding at module boundaries: after
   * the TypeScript program build, and after each source file's type-check,
   * declaration-check, and transform+emit. Drivers choose what a `yield`
   * means: nothing ({@link compileToModules}) or one macrotask turn
   * ({@link compileToModulesInterleaved}).
   *
   * Per-file emit is equivalent to the whole-program `emit(undefined)`: the
   * files are emitted in the same program order, through the same transformer
   * factories (one pipeline instance, so cross-file transformer state and
   * collected diagnostics behave identically), and the emit diagnostics are
   * aggregated across files before being checked — matching the single-call
   * shape. Only the event-loop yield points differ.
   */
  *#compileToModulesSteps(
    program: Program,
    inputOptions: TypeScriptCompilerOptions,
  ): Generator<void, Map<string, CompiledTypeScriptModule>, void> {
    const noCheck = inputOptions.noCheck ?? false;
    const storedSource = inputOptions.storedSource ?? false;
    const runtimeModules = inputOptions.runtimeModules ?? [];

    validateSource(program);
    const sourceNames = program.files.map(({ name }) => name);
    const tsOptions = getCompilerOptions();
    // The multi-file path type-checks the trimmed virtual lib .d.ts files and
    // surfaces lib-internal errors (e.g. FormData in dom.d.ts). We only need
    // to type-check authored code, so skip checking the declaration libs
    // themselves.
    tsOptions.skipLibCheck = true;
    // Stored-source reloads drop authoring-hygiene codes (TS2578) at the
    // checker; TypeScript's own emit veto would re-block exactly what was
    // filtered, so the explicit gates below are the only gates in this mode.
    if (storedSource) tsOptions.noEmitOnError = false;

    const host = new TypeScriptHost(
      program,
      this.#typeLibs,
      runtimeModules,
      inputOptions.specifierAliases,
    );
    const createStart = performance.now();
    const tsProgram = ts.createProgram(sourceNames, tsOptions, host);
    compileTimingLogger.time(createStart, "phase", "createProgram");
    yield;

    const checker = new Checker(tsProgram, {
      messageTransformer: inputOptions.diagnosticMessageTransformer,
      storedSource,
    });
    // Parse and program-level errors are fatal unconditionally — `noCheck`
    // skips type-checking, never parsing, and stored-source mode filters
    // only semantic hygiene codes. On stored-source compiles this gate
    // replaces TypeScript's own `noEmitOnError` veto: without it, malformed
    // source would EMIT malformed JavaScript.
    {
      const errors = checker.collectProgramErrors();
      for (const sourceFile of checker.checkableSources()) {
        errors.push(...checker.collectSyntacticErrors(sourceFile));
      }
      checker.throwIfErrors(errors);
      yield;
    }
    if (!noCheck) {
      const errors = [];
      for (const sourceFile of checker.checkableSources()) {
        const typeCheckStart = performance.now();
        errors.push(...checker.collectSemanticErrors(sourceFile));
        compileTimingLogger.time(typeCheckStart, "phase", "typeCheckFile");
        yield;
      }
      checker.throwIfErrors(errors);
    }
    {
      const errors = [];
      for (const sourceFile of checker.checkableSources()) {
        const declCheckStart = performance.now();
        errors.push(...checker.collectDeclarationErrors(sourceFile));
        compileTimingLogger.time(declCheckStart, "phase", "declCheckFile");
        yield;
      }
      checker.throwIfErrors(errors);
    }

    const {
      beforeTransformers,
      sourceCollector,
      getDiagnostics,
      getBuilderSourceSites,
      getPolicyManifests,
    } = createTransformers(
      tsProgram,
      inputOptions,
    );

    // Emit ALL source files (not just main), so every module gets a body —
    // one emit call per file (in program order) so the driver can interleave
    // between modules; diagnostics aggregate across the calls exactly as the
    // single whole-program emit call reported them.
    const emitDiagnostics = [];
    let emitSkipped = false;
    for (const sourceFile of tsProgram.getSourceFiles()) {
      if (sourceFile.fileName.endsWith(".d.ts")) continue;
      const emitStart = performance.now();
      const emitResult = tsProgram.emit(
        sourceFile,
        undefined,
        undefined,
        undefined,
        { before: beforeTransformers },
      );
      compileTimingLogger.time(emitStart, "phase", "emitFile");
      emitDiagnostics.push(...emitResult.diagnostics);
      emitSkipped ||= emitResult.emitSkipped;
      yield;
    }
    checker.check(emitDiagnostics);

    if (getDiagnostics) {
      const transformerDiagnostics = getDiagnostics();
      surfaceTransformerWarnings(transformerDiagnostics, program);
      const errors = transformerDiagnostics.filter((d) =>
        d.severity === "error"
      );
      if (errors.length > 0) {
        const sources = new Map<string, string>();
        for (const file of program.files) sources.set(file.name, file.contents);
        throw new TransformerError(errors, sources);
      }
    }
    if (emitSkipped) {
      throw new Error("Emit skipped. Check diagnostics.");
    }

    if (sourceCollector && inputOptions.getTransformedProgram) {
      inputOptions.getTransformedProgram({
        main: program.main,
        files: sourceCollector.sources(),
      });
    }

    // Map emitted `<name>.js` outputs back to their original source names.
    const sourceByStem = new Map<string, string>();
    for (const name of sourceNames) {
      if (name.endsWith(".d.ts")) continue;
      const stem = name.replace(/\.[^./]+$/, "");
      const existing = sourceByStem.get(stem);
      if (existing !== undefined) {
        // Two sources emit to the same `<stem>.js` (e.g. `/a.ts` and `/a.tsx`).
        // The output→source mapping would be ambiguous; fail loudly.
        throw new Error(
          `Ambiguous emit target: '${existing}' and '${name}' both compile to '${stem}.js'`,
        );
      }
      sourceByStem.set(stem, name);
    }
    const writes = host.getWrites();
    const builderSourceSites = getBuilderSourceSites?.();
    const policyManifests = getPolicyManifests?.();
    const result = new Map<string, CompiledTypeScriptModule>();
    for (const [outName, contents] of Object.entries(writes)) {
      if (!outName.endsWith(".js")) continue;
      const stem = outName.replace(/\.js$/, "");
      const sourceName = sourceByStem.get(stem);
      if (sourceName === undefined) continue;
      const sourceSites = builderSourceSites?.get(sourceName);
      result.set(sourceName, {
        js: contents,
        sourceMap: parseSourceMap(writes[`${outName}.map`]),
        ...(sourceSites === undefined
          ? {}
          : { builderSourceSites: sourceSites }),
        ...(policyManifests?.get(sourceName)?.length
          ? { policyManifests: policyManifests.get(sourceName) }
          : {}),
      });
    }
    return result;
  }

  /**
   * Like {@link compileToModules}, but COLLECTS type/declaration/transformer
   * diagnostics per file instead of throwing on the first one. Returns the
   * emitted bodies plus every error-severity diagnostic, each attributed to its
   * source file. For batch callers (cfcheck over the whole pattern corpus) that
   * must report all failing patterns by name, not abort on the first.
   *
   * `durations` says how long each authored file took, in milliseconds, which
   * is what lets a caller that unioned several programs into one charge the
   * run's cost back to the program each file came from. The per-file
   * diagnostics and the emit below are where nearly all of that time goes;
   * what is left is the program-wide parse and bind, which belongs to no one
   * file and appears in no entry.
   */
  compileToModulesCollecting(
    program: Program,
    inputOptions: TypeScriptCompilerOptions = {},
  ): {
    modules: Map<string, CompiledTypeScriptModule>;
    diagnostics: { file: string; message: string }[];
    durations: Map<string, number>;
  } {
    const runtimeModules = inputOptions.runtimeModules ?? [];
    validateSource(program);
    const sourceNames = program.files.map(({ name }) => name);
    const tsOptions = getCompilerOptions();
    tsOptions.skipLibCheck = true;

    const host = new TypeScriptHost(
      program,
      this.#typeLibs,
      runtimeModules,
      inputOptions.specifierAliases,
    );
    const tsProgram = ts.createProgram(sourceNames, tsOptions, host);

    const authored = new Set(
      program.files.filter((f) => !f.name.endsWith(".d.ts")).map((f) => f.name),
    );
    const diagnostics: { file: string; message: string }[] = [];
    const pushTs = (d: ts.Diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (d.file) {
        const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
        diagnostics.push({
          file: d.file.fileName,
          message: `${line + 1}: ${message}`,
        });
      } else {
        diagnostics.push({ file: "", message });
      }
    };

    // Program-level (options + global) diagnostics first — with noEmitOnError
    // off these no longer surface through emit, so omitting them here would
    // return `diagnostics: []` for a program the throwing path refuses.
    for (const d of tsProgram.getOptionsDiagnostics()) pushTs(d);
    for (const d of tsProgram.getGlobalDiagnostics()) pushTs(d);

    const durations = new Map<string, number>();
    const charge = (name: string, since: number): void => {
      durations.set(
        name,
        (durations.get(name) ?? 0) + performance.now() - since,
      );
    };

    // Type + declaration diagnostics for authored files only (skipLibCheck
    // already excludes the declaration libs). The corpus check is an
    // AUTHORING surface, so no stored-source tolerance applies here: a
    // stale ts-expect-error directive in the repo corpus is reported for
    // the author to remove.
    for (const sourceFile of tsProgram.getSourceFiles()) {
      if (!authored.has(sourceFile.fileName)) continue;
      const at = performance.now();
      for (const d of tsProgram.getSemanticDiagnostics(sourceFile)) pushTs(d);
      for (const d of tsProgram.getSyntacticDiagnostics(sourceFile)) pushTs(d);
      charge(sourceFile.fileName, at);
    }

    // Transform + emit, collecting (not throwing) transformer diagnostics.
    const {
      beforeTransformers,
      getDiagnostics,
      getBuilderSourceSites,
      getPolicyManifests,
    } = createTransformers(
      tsProgram,
      inputOptions,
    );
    // One emit call per file, as `compileToModules()` makes them, so that
    // the time each file takes is the file's own. Diagnostics aggregate
    // across the calls the same way they do there. The authored set is
    // the emittable one: everything else the program holds is a
    // declaration lib, which emits nothing.
    for (const sourceFile of tsProgram.getSourceFiles()) {
      if (!authored.has(sourceFile.fileName)) continue;
      const at = performance.now();
      const { diagnostics: emitDiagnostics } = tsProgram.emit(
        sourceFile,
        undefined,
        undefined,
        undefined,
        { before: beforeTransformers },
      );
      for (const d of emitDiagnostics) pushTs(d);
      charge(sourceFile.fileName, at);
    }
    if (getDiagnostics) {
      for (const d of getDiagnostics()) {
        if (d.severity !== "error") continue;
        diagnostics.push({
          file: d.fileName,
          message: `${d.line}: ${d.message}`,
        });
      }
    }

    const sourceByStem = new Map<string, string>();
    for (const name of sourceNames) {
      if (name.endsWith(".d.ts")) continue;
      const stem = name.replace(/\.[^./]+$/, "");
      const existing = sourceByStem.get(stem);
      if (existing !== undefined) {
        // Two sources emit to the same `<stem>.js` (e.g. `/a.ts` and `/a.tsx`).
        // The output→source mapping would be ambiguous; fail loudly rather than
        // silently drop one (parity with compileToModules).
        throw new Error(
          `Ambiguous emit target: '${existing}' and '${name}' both compile to '${stem}.js'`,
        );
      }
      sourceByStem.set(stem, name);
    }
    const writes = host.getWrites();
    const builderSourceSites = getBuilderSourceSites?.();
    const policyManifests = getPolicyManifests?.();
    const modules = new Map<string, CompiledTypeScriptModule>();
    for (const [outName, contents] of Object.entries(writes)) {
      if (!outName.endsWith(".js")) continue;
      const sourceName = sourceByStem.get(outName.replace(/\.js$/, ""));
      if (sourceName === undefined) continue;
      const sourceSites = builderSourceSites?.get(sourceName);
      modules.set(sourceName, {
        js: contents,
        sourceMap: parseSourceMap(writes[`${outName}.map`]),
        ...(sourceSites === undefined
          ? {}
          : { builderSourceSites: sourceSites }),
        ...(policyManifests?.get(sourceName)?.length
          ? { policyManifests: policyManifests.get(sourceName) }
          : {}),
      });
    }
    return { modules, diagnostics, durations };
  }
}

function validateSource(artifact: Program) {
  let entryFound = false;
  for (const { name } of artifact.files) {
    if (name === artifact.main) {
      entryFound = true;
    }
    // Sources must be root paths, unless they are type files,
    // which could be included for runtime dependencies,
    // e.g. `@commonfabric/builder.d.ts`
    if (name[0] !== "/" && !name.endsWith(".d.ts")) {
      //throw new Error(`File "${name}" must have a "/" root.`);
    }
  }
  if (!entryFound) {
    throw new Error(`No main module "${artifact.main}" in source.`);
  }
}

function createTransformers(
  program: ts.Program,
  options: TypeScriptCompilerOptions,
): {
  beforeTransformers: ts.TransformerFactory<ts.SourceFile>[];
  sourceCollector?: SourceCollector;
  getDiagnostics?: () => readonly TransformerDiagnosticInfo[];
  getBuilderSourceSites?: () => ReadonlyMap<string, BuilderSourceSitesV1>;
  getPolicyManifests?: () => ReadonlyMap<string, readonly unknown[]>;
} {
  let factories: ts.TransformerFactory<ts.SourceFile>[] = [];
  let getDiagnostics: (() => readonly TransformerDiagnosticInfo[]) | undefined;
  let getBuilderSourceSites:
    | (() => ReadonlyMap<string, BuilderSourceSitesV1>)
    | undefined;
  let getPolicyManifests:
    | (() => ReadonlyMap<string, readonly unknown[]>)
    | undefined;

  if (options.beforeTransformers) {
    const result = options.beforeTransformers(program);
    if (Array.isArray(result)) {
      // Legacy: array of transformer factories
      factories = result;
    } else {
      // New: TransformerPipelineResult with factories and getDiagnostics
      factories = result.factories;
      getDiagnostics = result.getDiagnostics;
      getBuilderSourceSites = result.getBuilderSourceSites;
      getPolicyManifests = result.getPolicyManifests;
    }
  }

  const out: ReturnType<typeof createTransformers> = {
    beforeTransformers: factories,
    getDiagnostics,
    getBuilderSourceSites,
    getPolicyManifests,
  };

  if (factories.length && options.getTransformedProgram) {
    out.sourceCollector = new SourceCollector();
    out.beforeTransformers.push(out.sourceCollector.transformer());
  }

  return out;
}

class SourceCollector {
  #sources: Source[] = [];
  #printer: ts.Printer;
  constructor() {
    this.#printer = ts.createPrinter({
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
    });
  }

  sources(): Source[] {
    return this.#sources;
  }

  transformer(): ts.TransformerFactory<ts.SourceFile> {
    return () => (sourceFile) => {
      this.#sources.push({
        contents: this.#printer.printFile(sourceFile),
        name: path.normalize(sourceFile.fileName),
      });
      return sourceFile;
    };
  }
}
