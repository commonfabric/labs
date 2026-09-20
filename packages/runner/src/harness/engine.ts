import { hashOf } from "@commonfabric/data-model";
import type {
  Program,
  ProgramResolver,
  Source,
  SourceMap,
  TypeScriptCompiler,
  TypeScriptCompilerOptions,
} from "@commonfabric/js-compiler";
import { InMemoryProgram } from "@commonfabric/js-compiler/program";
import {
  composeBundleSourceMap,
  identitySourceMap,
} from "@commonfabric/js-compiler/source-map";
import type { StaticCache } from "@commonfabric/static";
import type {
  BuilderSourceSiteOptions,
  BuilderSourceSitesV1,
  PatternCoverageOptions,
} from "@commonfabric/ts-transformers";
import {
  findFirstContentLineIndex,
  PATTERN_COVERAGE_GLOBAL,
} from "@commonfabric/ts-transformers/runtime-contract";
import { getLogger } from "@commonfabric/utils/logger";

import { isTrustedBuilderArtifact } from "../builder/pattern-metadata.ts";
import { popFrame, pushFrame } from "../builder/pattern.ts";
import { validateCfcPolicyArtifactManifest } from "../cfc/policy.ts";
import type { PatternCoverageCollector } from "../pattern-coverage.ts";
import { type MemorySpace, Runtime } from "../runtime.ts";
import {
  createModuleCompartmentGlobals,
  createSafeConsoleGlobal,
} from "../sandbox/compartment-globals.ts";
import {
  loadModuleGraph,
  runtimeModuleRecords,
  type VirtualModuleRecord,
} from "../sandbox/esm-module-loader.ts";
import { isFabricImportSpecifier } from "../sandbox/fabric-import-specifier.ts";
import {
  ensureSESLockdown,
  getRuntimeModuleExports,
  getRuntimeModuleTypes,
  isRuntimeModuleIdentifier,
  RuntimeModuleIdentifiers,
  SESRuntime,
} from "../sandbox/mod.ts";
import {
  buildRecordsFromCompiled,
  type CachedCompiledModule,
  type CompiledModuleGraph,
  compileSourcesToRecords,
  computeFabricModuleIdentities,
  dataFileSpecifier,
  FABRIC_MOUNT_ROOT,
  type FabricMount,
  sourceRootSpecifier,
} from "../sandbox/module-record-compiler.ts";
import {
  verifyCompiledModuleBody,
  verifyModuleGraph,
} from "../sandbox/module-record-verifier.ts";
import type { UnsafeHostTrustOptions } from "../unsafe-host-trust.ts";
import {
  deterministicCompileError,
  markDeterministicCompileFailure,
} from "./compile-failure.ts";
import {
  COMPILE_INTERLEAVES_EVENT_LOOP,
  interleaveCompileYield,
} from "./compile-interleave.ts";
import { recordAuthoredDebugSource } from "./authored-debug-source.ts";
import { Console } from "./console.ts";
import {
  compilerStack,
  ensureCompilerStack,
} from "./deferred-compiler-stack.ts";
import { ExecutableRegistry } from "./executable-registry.ts";
import { FabricAwareResolver } from "./fabric-resolver.ts";
import {
  type ModuleImportEdges,
  resolveModuleImports,
} from "./module-identity.ts";
import {
  pretransformProgramForModules,
  transformInjectHelperModule,
} from "./pretransform.ts";
import {
  type CacheableModule,
  type CompiledModuleArtifact,
  type EvaluateResult,
  type Exports,
  type HarnessedFunction,
  type ResolvedFabricPin,
  type RuntimeProgram,
  type TypeScriptHarnessProcessOptions,
} from "./types.ts";
import { attachDeclaredDataFiles } from "./declared-data-files.ts";
import {
  getDefiningModule,
  readBindingIdentity,
  recordVerifiedProvenance,
} from "./verified-provenance.ts";

const logger = getLogger("engine");

/**
 * Run one pure compile step, classifying only its synchronous failures.
 *
 * Every call site sits after an `await`, so caller stack depth is drained.
 * Within a runtime session the engine stack limit is fixed, so an overflow
 * will recur for the same compile inputs and is safe to classify as
 * deterministic. Keep new call sites behind an `await`.
 */
function deterministicCompileStep<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    throw markDeterministicCompileFailure(error);
  }
}

// Extends a TypeScript program with 3P module types, if referenced.
export class EngineProgramResolver extends InMemoryProgram {
  #runtimeModuleTypes: Record<string, string> | undefined;
  #cache: StaticCache;
  constructor(program: Program, cache: StaticCache) {
    const modules = program.files.reduce((mod, file) => {
      mod[file.name] = file.contents;
      return mod;
    }, {} as Record<string, string>);
    super(program.main, modules);
    this.#cache = cache;
  }

  /**
   * Resolves a source, adding `.d.ts` files for known supported third-party
   * modules.
   */
  override async resolveSource(
    identifier: string,
  ): Promise<Source | undefined> {
    if (!this.#runtimeModuleTypes) {
      this.#runtimeModuleTypes = await Engine.getRuntimeModuleTypes(
        this.#cache,
      );
    }
    if (
      !isRuntimeModuleIdentifier(identifier) &&
      identifier in this.#runtimeModuleTypes &&
      this.#runtimeModuleTypes[identifier]
    ) {
      return {
        name: identifier,
        contents: this.#runtimeModuleTypes[identifier],
      };
    }
    if (identifier.endsWith(".d.ts")) {
      const origSource = identifier.substring(0, identifier.length - 5);
      if (
        isRuntimeModuleIdentifier(origSource)
      ) {
        if (
          origSource in this.#runtimeModuleTypes &&
          this.#runtimeModuleTypes[origSource]
        ) {
          return {
            name: identifier,
            contents: this.#runtimeModuleTypes[origSource],
          };
        }
      }
    }
    return super.resolveSource(identifier);
  }
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

function reachableModuleSpecifiers(
  records: ReadonlyMap<string, VirtualModuleRecord>,
  mainSpecifier: string,
): Set<string> {
  const reachable = new Set<string>();
  const pending = [mainSpecifier];
  while (pending.length > 0) {
    const specifier = pending.pop()!;
    if (reachable.has(specifier)) continue;
    reachable.add(specifier);
    const record = records.get(specifier);
    if (record === undefined) continue;
    for (const importSpecifier of record.imports) {
      const resolutions = record.resolutions;
      pending.push(
        resolutions !== undefined &&
          Object.hasOwn(resolutions, importSpecifier)
          ? resolutions[importSpecifier]
          : importSpecifier,
      );
    }
  }
  return reachable;
}

function canonicalSourceRoots(
  main: string,
  roots: readonly string[] | undefined,
): string[] {
  return [...new Set(roots ?? [])]
    .filter((root) => root !== main)
    .sort();
}

function canonicalDataFiles(
  main: string,
  dataFiles: readonly string[] | undefined,
): string[] {
  const paths = [...new Set(dataFiles ?? [])].sort();
  // Unlike a source root, which the entry trivially is, an entry named as data
  // is a contradiction: it is the module the program executes. Dropping it
  // would silently compile a file the caller asked to store uninterpreted.
  if (paths.includes(main)) {
    throw new Error(`The program entry '${main}' cannot be a data file.`);
  }
  return paths;
}

/**
 * Split a program's files into the code the compiler sees and the data files it
 * must not. A data file named by the program but absent from its files is a
 * caller error, and stops the compile rather than deploying a package whose
 * identity claims data that is not there. `idPrefix` names the per-load path
 * prefix to drop when reporting such a file, so the report spells the path the
 * caller wrote.
 */
function partitionDataFiles(
  program: RuntimeProgram,
  idPrefix?: string,
): { dataPaths: string[]; codeFiles: Source[]; dataSources: Source[] } {
  const dataPaths = canonicalDataFiles(program.main, program.dataFiles);
  if (dataPaths.length === 0) {
    return { dataPaths, codeFiles: [...program.files], dataSources: [] };
  }
  const wanted = new Set(dataPaths);
  const codeFiles: Source[] = [];
  const dataSources: Source[] = [];
  for (const file of program.files) {
    (wanted.has(file.name) ? dataSources : codeFiles).push(file);
  }
  if (dataSources.length !== wanted.size) {
    const present = new Set(dataSources.map((file) => file.name));
    const absent = dataPaths
      .filter((path) => !present.has(path))
      .map((path) =>
        idPrefix !== undefined && path.startsWith(`${idPrefix}/`)
          ? path.slice(idPrefix.length)
          : path
      )
      .join(", ");
    throw new Error(`Program names data files it does not carry: ${absent}`);
  }
  return { dataPaths, codeFiles, dataSources };
}

function persistableSourceFiles(files: readonly Source[]): Source[] {
  return files.filter((file) =>
    !file.name.endsWith(".d.ts") || file.name.startsWith("/")
  );
}

interface RuntimeInternals {
  runtime: SESRuntime;
  runtimeExports: Record<string, any> | undefined;
  // Callback will be called with a map of exported values to `RuntimeProgram`
  // after compilation and initial eval and before compilation returns, so
  // before any e.g. pattern would be instantiated.
  exportsCallback: (exports: Map<any, RuntimeProgram>) => void;
}

interface CompilerInternals {
  compiler: TypeScriptCompiler;
}

export interface EngineOptions {
  hideInternalStackFrames?: boolean;
}

export class Engine extends EventTarget {
  #runtimeInternals: RuntimeInternals | undefined;
  #compilerInternals: CompilerInternals | undefined;
  #ctRuntime: Runtime;

  #sesRuntime: SESRuntime | undefined;

  #nextEvalId = 0;

  readonly #executableRegistry = new ExecutableRegistry();

  readonly #consoleShim = createSafeConsoleGlobal(new Console(this));
  readonly #patternCoverageByGraph = new WeakMap<
    CompiledModuleGraph,
    PatternCoverageCollector
  >();

  readonly #options: EngineOptions;

  constructor(
    ctRuntime: Runtime,
    options: EngineOptions = {},
  ) {
    super();
    this.#options = options;
    this.#ctRuntime = ctRuntime;
  }

  /**
   * The SES runtime, once one has been made, and the implementation index,
   * which a test reads directly.
   */
  get accessForTestingOnly(): {
    readonly executableRegistry: ExecutableRegistry;
    readonly sesRuntime: SESRuntime | undefined;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      executableRegistry: this.#executableRegistry,
      get sesRuntime() {
        return outerThis.#sesRuntime;
      },
    };
  }

  async initializeRuntime(): Promise<RuntimeInternals> {
    const runtime = this.#getSESRuntime();
    const { runtimeExports, exportsCallback } = await getRuntimeModuleExports();
    return { runtime, runtimeExports, exportsCallback };
  }

  async initializeCompiler(): Promise<CompilerInternals> {
    // First compiler use on this engine: load the deferred compiler stack
    // (typescript + transformers), kept off the worker-boot path.
    const { TypeScriptCompiler } = await ensureCompilerStack();
    const environmentTypes = await Engine.getEnvironmentTypes(
      this.#ctRuntime.staticCache,
    );
    const compiler = new TypeScriptCompiler(environmentTypes);
    return { compiler };
  }

  async initialize(): Promise<RuntimeInternals & CompilerInternals> {
    const [runtimeInternals, compilerInternals] = await Promise.all([
      this.#getRuntimeInternals(),
      this.#getCompilerInternals(),
    ]);
    return { ...runtimeInternals, ...compilerInternals };
  }

  /**
   * Resolve a `ProgramResolver` into a program: the entry, the closure its
   * imports reach, and the data files its source declares by reading them.
   *
   * This is how a program is assembled from a source of truth — a directory, a
   * web address, the fabric — so it is where a declaration in the source is
   * acted on. Re-resolving a program the engine already holds goes through
   * `#resolveModules()`, which follows imports and nothing else.
   */
  async resolve(
    program: ProgramResolver,
    options: { sourceRoots?: readonly string[] } = {},
  ): Promise<RuntimeProgram> {
    const roots = [...new Set(options.sourceRoots ?? [])];
    const resolved = roots.length === 0
      ? await this.#resolveModules(program)
      : {
        ...await this.#resolveWithSourceRoots(program, roots),
        sourceRoots: roots,
      };
    return await attachDeclaredDataFiles(resolved, program);
  }

  /** Resolve the module closure an entry's imports reach. */
  async #resolveModules(
    program: ProgramResolver,
  ): Promise<RuntimeProgram> {
    const { compiler } = await this.#getCompilerInternals();
    logger.timeStart("resolve");
    try {
      return await compiler.resolveProgram(program, {
        runtimeModules: Engine.runtimeModuleNames(),
      });
    } finally {
      logger.timeEnd("resolve");
    }
  }

  async #resolveWithSourceRoots(
    resolver: ProgramResolver,
    sourceRoots: readonly string[],
  ): Promise<RuntimeProgram> {
    const programs = [await this.#resolveModules(resolver)];
    for (const root of new Set(sourceRoots)) {
      if (root === programs[0].main) continue;
      programs.push(
        await this.#resolveModules(new RootedProgramResolver(resolver, root)),
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

  /**
   * Compile a program to a verified ESM module-record graph. Runs the program
   * resolution + CF transformer pipeline, emits per-module CommonJS via
   * `compileToModules`, assembles content-addressed records (plus runtime-
   * module records), and security-verifies every authored module body with
   * the ESM verifier. Returns the graph and the entry specifier for evaluation.
   */
  async compileToRecordGraph(
    program: RuntimeProgram,
    options: TypeScriptHarnessProcessOptions = {},
  ): Promise<
    {
      id: string;
      graph: CompiledModuleGraph;
      mainSpecifier: string;
      entryIdentity: string;
      modules: CacheableModule[];
      resolvedPins: ResolvedFabricPin[];
    }
  > {
    logger.timeStart("compileToRecordGraph");
    try {
      // Pretransform/import-scan below parse before the compiler internals
      // are awaited — load the deferred compiler stack up front.
      await ensureCompilerStack();
      const id = options.identifier ?? computeId(program);
      assertNoReservedFabricPaths(program.files);
      const mappedProgram = pretransformProgramForModules(program, id);
      const sourceRoots = canonicalSourceRoots(
        mappedProgram.main,
        mappedProgram.sourceRoots,
      );
      // Data files leave the program before anything that reads TypeScript
      // touches it: they are neither scanned for imports nor offered to the
      // resolver, so an import can never land on one. They rejoin the pristine
      // set below, which is what identity and the source store are built from.
      const { dataPaths, codeFiles, dataSources } = partitionDataFiles(
        mappedProgram,
        `/${id}`,
      );
      assertFabricImportsHaveSpace(codeFiles, options);
      const engineResolver = new EngineProgramResolver(
        { ...mappedProgram, files: codeFiles },
        this.#ctRuntime.staticCache,
      );
      const fabricResolver = options.fabricImports
        ? new FabricAwareResolver(engineResolver, {
          runtime: this.#ctRuntime,
          space: options.fabricImports.space,
          allowUnpinned: options.fabricImports.allowUnpinned,
        })
        : undefined;
      const resolver = fabricResolver ?? engineResolver;
      const resolvedProgram = await this.#resolveWithSourceRoots(
        resolver,
        sourceRoots,
      );
      const mounts = fabricResolver?.mounts() ?? [];
      const specifierAliases = fabricResolver?.specifierAliases() ?? new Map();
      const resolvedPins = fabricResolver?.resolvedPins() ?? [];
      const resolvedFiles = uniqueSourcesByName(resolvedProgram.files);
      // For compilation, fabric mounts need the helper import too (they are
      // fetched as authored source — see the identity fix below). Authored
      // modules are already injected by `pretransformProgramForModules`.
      const resolvedForCompile = {
        ...resolvedProgram,
        files: injectMountSources(resolvedFiles),
      };

      // Authored (non-.d.ts) sources are the modules that must have a body.
      const moduleFiles = resolvedFiles.filter((f) =>
        !f.name.endsWith(".d.ts")
      );

      // Module identity hashes the AUTHORED source, before the helper-injection
      // decoration `pretransformProgramForModules` baked into `moduleFiles`
      // (module-loading.md: identity is over authored TS, so it is TCB-version
      // independent — CT-1740). Recover each authored module's original bytes by
      // its stored (prefix-free) filename; mounts keep their resolved bytes.
      const authoredByStoredName = new Map(
        program.files.map((f) => [f.name, f.contents]),
      );
      const authoredDataFiles = new Set(program.dataFiles ?? []);
      const authoredCompileSources = [
        ...program.files.filter((file) => !authoredDataFiles.has(file.name)),
        ...resolvedFiles.filter((file) =>
          file.name.startsWith(FABRIC_MOUNT_ROOT)
        ),
      ];
      const patternCoverage = patternCoverageOptionsForCompile(
        options.patternCoverage,
        {
          id,
          mounts,
          sourceFiles: authoredCompileSources,
        },
      );
      const builderSourceSites = builderSourceSiteOptionsForCompile({
        id,
        mounts,
        sourceFiles: authoredCompileSources,
      });
      const pristineSourceFiles = [
        ...pristineModuleSources(
          persistableSourceFiles(resolvedFiles),
          authoredByStoredName,
          (name) => storedFilenameFor(name, id, mounts),
        ),
        ...dataSources,
      ];

      // Prefix-free content identity per resolved module path. Computed here
      // (cheap, no TS compile) so the cache-hit check and the write-back
      // descriptors agree with the graph's `cf:module/<hash>` specifiers.
      const identityByPath = computeFabricModuleIdentities(
        pristineSourceFiles,
        mounts,
        {
          idPrefix: `/${id}`,
          ...(sourceRoots.length || dataPaths.length
            ? {
              sourcePackage: {
                entryPath: mappedProgram.main,
                rootPaths: sourceRoots,
                dataPaths,
              },
            }
            : {}),
        },
      );
      const entryIdentity = identityByPath.get(mappedProgram.main)!;

      // Cache hit: every emitted module already has a cached compiled body
      // (keyed by identity), so skip the TypeScript compile entirely and build
      // the record graph from the cached bodies. Per-module identities are
      // transitively sensitive, so a partial set cannot be trusted — fall back
      // to a full recompile. The cache is queried by identity (directly, or
      // lazily once identities are known) without leaking the engine's prefix.
      const cachedCandidate = options.precompiledModules ??
        (options.precompiledModulesFor
          ? await options.precompiledModulesFor({
            entryIdentity,
            identities: [
              ...new Set(
                moduleFiles.map((file) => identityByPath.get(file.name)!),
              ),
            ],
          })
          : undefined);
      const cached = patternCoverage !== undefined &&
          cachedCandidate !== undefined &&
          !cachedArtifactsIncludePatternCoverage(cachedCandidate)
        ? undefined
        : cachedCandidate;
      const fullHit = cached !== undefined &&
        moduleFiles.every((f) => cached.has(identityByPath.get(f.name)!));

      const precompiledBodies = new Map<string, string>();
      // Carry per-module source maps so the ESM loader can compose a per-load
      // bundle map for authored error-stack coordinates.
      const precompiledSourceMaps = new Map<string, SourceMap>();
      const precompiledBuilderSourceSites = new Map<
        string,
        BuilderSourceSitesV1
      >();
      const precompiledPolicyManifests = new Map<string, readonly unknown[]>();

      if (fullHit) {
        logger.info("compile-cache-hit", () => ["compileToRecordGraph", id]);
        for (const file of moduleFiles) {
          const artifact = cached!.get(identityByPath.get(file.name)!)!;
          precompiledBodies.set(file.name, artifact.js);
          if (artifact.sourceMap !== undefined) {
            precompiledSourceMaps.set(
              file.name,
              artifact.sourceMap as SourceMap,
            );
          }
          if (artifact.builderSourceSites !== undefined) {
            precompiledBuilderSourceSites.set(
              file.name,
              artifact.builderSourceSites,
            );
          }
          if (artifact.policyManifests !== undefined) {
            precompiledPolicyManifests.set(
              file.name,
              artifact.policyManifests,
            );
          }
          if (options.patternCoverage !== undefined) {
            options.patternCoverage.registerSpans(
              artifact.patternCoverageSpans ?? [],
            );
          }
        }
      } else {
        const { compiler } = await this.#getCompilerInternals();
        // A cold compile is a seconds-long CPU-bound pipeline. In the browser
        // runtime worker a synchronous run wedges the event loop and stalls
        // every queued IPC delivery until it finishes (measured as
        // runner.loop/workerLag ≈ the whole compile), so there we drive the
        // per-module interleaved variant to bound the stall to the longest
        // single module step. In Deno batch compiles (cf test, server, CLI)
        // nothing latency-sensitive shares the loop, so the yields would be
        // pure overhead (~2x wall) — run the synchronous driver instead.
        // Both drain the same generator, so the emitted output is identical.
        const compileOptions: TypeScriptCompilerOptions = {
          noCheck: options.noCheck,
          runtimeModules: Engine.runtimeModuleNames(),
          specifierAliases,
          getTransformedProgram: options.getTransformedProgram
            ? (nextProgram) => options.getTransformedProgram?.(nextProgram)
            : undefined,
          diagnosticMessageTransformer: compilerStack()
            .createReactiveErrorTransformer(options.verboseErrors),
          beforeTransformers: (program) => {
            const pipeline = new (compilerStack()
              .CommonFabricTransformerPipeline)({
              patternCoverage,
              builderSourceSites,
              moduleIdentities: identityByPath,
              // Writer identities record authored paths: unmap the engine's
              // per-load `/<id>` prefix (and mount paths) before spelling.
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
        const modules = COMPILE_INTERLEAVES_EVENT_LOOP
          ? await compiler.compileToModulesInterleaved(
            resolvedForCompile,
            compileOptions,
          )
          : compiler.compileToModules(resolvedForCompile, compileOptions);

        // Every authored source must have an emitted body; a missing one would
        // otherwise be silently dropped and only fail later at import.
        for (const file of moduleFiles) {
          if (!modules.has(file.name)) {
            throw new Error(
              `ESM compile produced no module body for '${file.name}'`,
            );
          }
        }
        for (const [name, out] of modules) {
          precompiledBodies.set(name, out.js);
          if (out.sourceMap) precompiledSourceMaps.set(name, out.sourceMap);
          if (out.builderSourceSites) {
            precompiledBuilderSourceSites.set(name, out.builderSourceSites);
          }
          if (out.policyManifests) {
            precompiledPolicyManifests.set(name, out.policyManifests);
          }
        }
      }
      const { runtimeExports } = await this.#getRuntimeInternals();
      const runtimeNames = Engine.runtimeModuleNames().filter((name) =>
        runtimeExports?.[name]
      );
      const runtimeModulesOption = Object.fromEntries(
        runtimeNames.map((name) => [
          name,
          Object.keys(runtimeExports?.[name] ?? {}),
        ]),
      );
      const graph = compileSourcesToRecords(moduleFiles, {
        precompiledBodies,
        precompiledSourceMaps,
        precompiledBuilderSourceSites,
        runtimeModules: runtimeModulesOption,
        specifierAliases,
        // Carried onto the graph under their stored (prefix-free) names, the
        // same spelling the warm path recovers from the compiled set.
        dataFiles: dataSources.map((file) =>
          [storedFilenameFor(file.name, id, mounts), file.contents] as const
        ),
        // Strip the whole-program `/<id>` prefix from per-module identities so
        // `cf:module/<hash>` is entry-point independent and dedupes across
        // programs (the content-addressed cache keys off these identities).
        idPrefix: `/${id}`,
        // Reuse the identities already computed above (cache-hit check); avoids
        // a second hashing/import-resolution pass over the module set.
        identityByPath,
        // A `dataFile()` path resolves against the reading module's stored
        // name, so a read lands in the same space `dataFiles` is keyed by.
        storedNameFor: (name) => storedFilenameFor(name, id, mounts),
      });
      if (options.patternCoverage) {
        this.#patternCoverageByGraph.set(graph, options.patternCoverage);
      }

      // Register runtime-module records so cf:runtime/* imports resolve.
      const runtimeRecordExports: Record<string, Record<string, unknown>> = {};
      for (const name of runtimeNames) {
        runtimeRecordExports[name] = runtimeExports?.[name] as Record<
          string,
          unknown
        >;
      }
      for (const [spec, record] of runtimeModuleRecords(runtimeRecordExports)) {
        graph.records.set(spec, record as VirtualModuleRecord);
      }

      // Security-verify every authored module body before it can execute —
      // EXCEPT a trusted, integrity-gated full hit. The CFC integrity label is
      // the security boundary for cache hits, so re-running the SES body verifier
      // on integrity-gated bytes is redundant per-load work (threat model:
      // `docs/specs/module-loading.md`, "the persistent compilation cache").
      // Trust is gated on PROVENANCE, not just the opt-in flag: the bodies must
      // have arrived via the lazy `precompiledModulesFor` channel (the cache
      // callback, which reads the compiled set with `requiredIntegrity`,
      // fail-closed) — NOT a direct, caller-supplied `precompiledModules` map,
      // which is untrusted injection. Freshly compiled bodies (miss / partial)
      // are likewise always verified.
      const trustBodies = fullHit &&
        options.trustedBodies === true &&
        options.precompiledModules === undefined &&
        options.precompiledModulesFor !== undefined;
      if (!trustBodies) {
        // Verify, and record which modules the verifier approved for hoist
        // registration — only those get the real `__cfReg` registrar (the rest
        // get a throwing one, so a smuggled call fails closed). In the browser
        // worker, yield between modules: per-body SES verification is CPU-bound
        // and shares the event loop with IPC traffic there (no-op in Deno).
        for (const [specifier, body] of graph.compiledBodies) {
          const { hasHoistRegistration } = verifyCompiledModuleBody(
            body,
            specifier,
          );
          if (hasHoistRegistration) graph.registrationApproved.add(specifier);
          await interleaveCompileYield();
        }
      } else {
        // Trusted integrity-gated bytes: SES verification — and its registration
        // approval — already ran when the cache entry was sealed, so grant the
        // real registrar to every module (one without a `__cfReg` call never
        // invokes it).
        for (const specifier of graph.compiledBodies.keys()) {
          graph.registrationApproved.add(specifier);
        }
      }

      const mainSpecifier = graph.specifierByPath.get(mappedProgram.main);
      if (mainSpecifier === undefined) {
        throw new Error(
          "ESM compile produced no record for the program entry",
        );
      }

      // Structurally verify the whole record graph (content-addressed
      // specifiers, well-formed records, and that every import edge resolves to
      // a content-addressed target). This must run here because the loader is
      // invoked with `verify: false` in evaluateRecordGraph — graph
      // verification happens once, at compile time, before any module executes.
      verifyModuleGraph(graph.records, mainSpecifier);

      // Serializable per-module descriptors for write-back to the cache, in
      // identity space (the engine's `/<id>` path prefix never leaks out). Each
      // carries the AUTHORED TS source (for the source set — pre-helper-injection,
      // matching what identity hashed), the compiled JS (for the compiled set),
      // and the internal import edges as specifier → dependency-identity links.
      // On a cache hit these mirror the artifacts just loaded. Built over the
      // pristine module set so `source` and the edges are over authored bytes.
      const dataFileSet = new Set(dataPaths);
      const importEdges = resolveModuleImports({
        main: "",
        files: pristineSourceFiles,
      }, { dataFiles: dataFileSet });
      const modules: CacheableModule[] = pristineSourceFiles.map((file) => {
        const identity = identityByPath.get(file.name)!;
        const sourceMap = precompiledSourceMaps.get(file.name);
        const emittedBody = precompiledBodies.get(file.name);
        const patternCoverageSpans = patternCoverage === undefined ||
            emittedBody === undefined
          ? undefined
          : options.patternCoverage?.spansForFile(
            coverageFilenameFor(file.name, id, mounts),
          );
        const imports = cacheableImportsFor(
          file.name,
          importEdges,
          identityByPath,
          specifierAliases,
        );
        if (file.name === mappedProgram.main) {
          for (const rootPath of sourceRoots) {
            const rootIdentity = identityByPath.get(rootPath);
            if (rootIdentity === undefined) {
              throw new Error(
                `Source root '${rootPath}' has no module identity.`,
              );
            }
            imports.push({
              specifier: sourceRootSpecifier(
                storedFilenameFor(rootPath, id, mounts),
              ),
              targetIdentity: rootIdentity,
            });
          }
          for (const dataPath of dataPaths) {
            // Every data path is in the pristine set the identities were
            // computed over, the same guarantee the module lookup above relies
            // on.
            imports.push({
              specifier: dataFileSpecifier(
                storedFilenameFor(dataPath, id, mounts),
              ),
              targetIdentity: identityByPath.get(dataPath)!,
            });
          }
        }
        const policyManifests = emittedBody === undefined
          ? undefined
          : validatePolicyManifestsForModule(
            identity,
            precompiledPolicyManifests.get(file.name),
          );
        // A data entry's compiled form is its own bytes: the compiled set is
        // what a warm load reads, and it must carry everything the runtime
        // needs to run the pattern.
        const isData = dataFileSet.has(file.name);
        return {
          identity,
          filename: storedFilenameFor(file.name, id, mounts),
          source: file.contents,
          js: isData ? file.contents : (emittedBody ?? ""),
          ...(isData ? { isData: true } : {}),
          ...(sourceMap === undefined ? {} : { sourceMap }),
          ...(emittedBody === undefined ||
              precompiledBuilderSourceSites.get(file.name) === undefined
            ? {}
            : {
              builderSourceSites: precompiledBuilderSourceSites.get(file.name),
            }),
          ...(patternCoverageSpans === undefined
            ? {}
            : { patternCoverageSpans }),
          ...(policyManifests === undefined ? {} : { policyManifests }),
          imports,
        };
      });
      for (const module of modules) {
        this.#ctRuntime.registerCfcPolicyManifests(
          undefined,
          module.policyManifests ?? [],
        );
      }

      return {
        id,
        graph,
        mainSpecifier,
        entryIdentity,
        modules,
        resolvedPins,
      };
    } finally {
      logger.timeEnd("compileToRecordGraph");
    }
  }

  /**
   * Type-check and SES-verify many authored programs as a SINGLE TypeScript
   * program.
   *
   * Each program is resolved with the runtime `.d.ts` type environment injected
   * exactly as {@link compileToRecordGraph} does (pretransform → resolve), then
   * every resolved file is unioned and compiled as roots of one `ts.Program`,
   * so the lib/API parse and bind is paid once for the whole batch rather than
   * once per program.
   *
   * Returns the batch's transformer/type diagnostics rather than throwing, so a
   * caller can attribute failures, along with `durations`: the milliseconds the
   * run spent on each program's own files, against the `main` that program was
   * given under. Every file carries the `/<id>` prefix of the one program it
   * came from, so the cost divides among them with nothing shared between two;
   * what the sum leaves out is the program-wide parse and bind.
   */
  async typeCheckBatch(
    programs: RuntimeProgram[],
    options: { transform?: boolean } = {},
  ): Promise<{
    patternCount: number;
    fileCount: number;
    diagnostics: readonly { file?: string; message: string }[];
    durations: ReadonlyMap<string, number>;
  }> {
    // Nothing to check (e.g. an empty CI shard, or every program failed to
    // resolve upstream) — there is no entry to compile, so return cleanly.
    if (programs.length === 0) {
      return {
        patternCount: 0,
        fileCount: 0,
        diagnostics: [],
        durations: new Map(),
      };
    }

    // Pretransform parses before the compiler internals are awaited.
    await ensureCompilerStack();
    const runTransform = options.transform ?? true;
    const unioned = new Map<string, Source>();
    const mains: string[] = [];
    const batchIds: string[] = [];
    for (const program of programs) {
      const id = computeId(program);
      batchIds.push(id);
      const mapped = pretransformProgramForModules(program, id);
      const resolver = new EngineProgramResolver(
        { ...mapped, files: partitionDataFiles(mapped).codeFiles },
        this.#ctRuntime.staticCache,
      );
      const resolved = await this.#resolveWithSourceRoots(
        resolver,
        mapped.sourceRoots ?? [],
      );
      for (const file of uniqueSourcesByName(resolved.files)) {
        if (!unioned.has(file.name)) unioned.set(file.name, file);
      }
      mains.push(mapped.main);
    }

    const merged: RuntimeProgram = {
      main: mains[0]!,
      files: [...unioned.values()],
    };

    const { compiler } = await this.#getCompilerInternals();
    const {
      modules,
      diagnostics: compileDiagnostics,
      durations: fileDurations,
    } = compiler
      .compileToModulesCollecting(merged, {
        runtimeModules: Engine.runtimeModuleNames(),
        beforeTransformers: runTransform
          ? (program) => {
            const moduleIdentities = new Map(
              [...unioned.keys()].map((name) => [name, `check:${name}`]),
            );
            const pipeline = new (compilerStack()
              .CommonFabricTransformerPipeline)({
              moduleIdentities,
              // The union carries a different `/<id>` prefix per batched
              // program; strip whichever one matches.
              canonicalWriterIdentityFile: (name) => {
                for (const batchId of batchIds) {
                  const stripped = stripModuleIdPrefix(name, batchId);
                  if (stripped !== name) return stripped;
                }
                return name;
              },
            });
            return {
              factories: pipeline.toFactories(program),
              getDiagnostics: () => pipeline.getDiagnostics(),
            };
          }
          : undefined,
      });
    const diagnostics: { file?: string; message: string }[] = [
      ...compileDiagnostics,
    ];

    // SES-verify each emitted body. compileToRecordGraph runs this per module
    // (verifyCompiledModuleBody); compileToModules does not, so the batch must
    // run it explicitly or it would silently lose cfcheck's SES coverage. Body
    // verification is per-body AST work (no type-checking), so it stays cheap.
    const verified = new Map<string, number>();
    if (runTransform) {
      for (const [name, body] of modules) {
        if (name.endsWith(".d.ts")) continue;
        const at = performance.now();
        try {
          verifyCompiledModuleBody(body.js, name);
        } catch (error) {
          diagnostics.push({
            file: name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        verified.set(name, (verified.get(name) ?? 0) + performance.now() - at);
      }
    }

    // A file's `/<id>` prefix is the first path segment of its name, so the
    // program it belongs to is one lookup rather than a scan of the batch.
    // The injected `cfc.ts` helper carries no prefix and belongs to none of
    // them, which is why an unmatched name is passed over. Verifying a body
    // is per-file work like checking and emitting one, so it is charged
    // alongside them rather than left in what the sum does not reach.
    const mainById = new Map(
      batchIds.map((id, index) => [`/${id}`, programs[index]!.main]),
    );
    const durations = new Map<string, number>();
    for (const spent of [fileDurations, verified]) {
      for (const [name, ms] of spent) {
        const cut = name.indexOf("/", 1);
        const main = cut === -1 ? undefined : mainById.get(name.slice(0, cut));
        if (main === undefined) continue;
        durations.set(main, (durations.get(main) ?? 0) + ms);
      }
    }

    return {
      patternCount: programs.length,
      fileCount: unioned.size,
      diagnostics,
      durations,
    };
  }

  /**
   * Cold-recovery path: recompile cacheable modules from the AUTHORED source
   * already stored in the content-addressed **source set** (`pattern:<identity>`
   * cells), loaded by identity — i.e. recreate the pattern from its stored
   * TypeScript alone. The stored source is prefix-free authored TS (the helper
   * import is NOT baked in — identity is over authored source, module-loading.md),
   * so we skip **re-prefixing** but DO re-inject the helper import for
   * compilation (`transformInjectHelperModule`, before resolve so the resolver
   * pulls the `commonfabric` types). We **resolve** to supply the runtime
   * `.d.ts` type environment the CF transformer needs for schema generation
   * (those types are TCB, from the static cache, not stored per pattern). Used
   * when the compiled set misses (e.g. a runtimeVersion bump invalidates
   * `compileCache:<rtver>/...`).
   *
   * Per-module identities recompute to the same content-addressed values (the
   * authored source + names are unchanged), so the rebuilt compiled set is
   * addressable — and writable-back — under the new runtimeVersion. Returns the
   * `CacheableModule[]` (feed to {@link evaluateCachedModules}) + entry identity.
   * `entryFilename` is the entry module's normalized path.
   */
  async compileResolvedToRecordGraph(
    resolvedFiles: Source[],
    entryFilename: string,
    options: {
      fabricImports?: TypeScriptHarnessProcessOptions["fabricImports"];
      patternCoverage?: PatternCoverageCollector;
      sourceRoots?: readonly string[];
      dataFiles?: readonly string[];
    } = {},
  ): Promise<{ modules: CacheableModule[]; entryIdentity: string }> {
    const { compiler } = await this.#getCompilerInternals();
    assertNoReservedFabricPaths(resolvedFiles);
    // Data files carry arbitrary bytes; keep them away from every scan, parse
    // and compile step, and rejoin them at the pristine set below.
    const { dataPaths, codeFiles, dataSources } = partitionDataFiles({
      main: entryFilename,
      files: resolvedFiles,
      ...(options.dataFiles === undefined
        ? {}
        : { dataFiles: [...options.dataFiles] }),
    });
    assertFabricImportsHaveSpace(codeFiles, options);
    // The stored source set holds prefix-free AUTHORED TS (the helper import is
    // NOT baked in — identity is over authored source, module-loading.md).
    // Inject the helper BEFORE resolve so the resolver pulls the `commonfabric`
    // runtime `.d.ts` the transformer needs; identity is recomputed over the
    // authored bytes below and matches the stored keys.
    //
    // `tolerateStoredLegacyEnvelope` (CT-1838): this input is storage-fetched
    // and Merkle-verified (loadVerifiedSourceClosure), and PRE-#4158 spaces
    // stored the helper-injected form — re-injecting those docs would trip
    // the reserved-symbol guard and permanently brick every pre-#4158
    // pattern. Exact-envelope legacy docs pass through unchanged; their
    // stored bytes are exactly what their identities were computed over, so
    // the identity check below still holds, and the successful compile
    // writes back under the current runtimeVersion (self-heal on load).
    // This pretransform is pure compute over the verified stored bytes.
    const injectedInput = deterministicCompileStep(() =>
      transformInjectHelperModule({
        main: entryFilename,
        files: codeFiles,
        ...(options.sourceRoots === undefined
          ? {}
          : { sourceRoots: [...options.sourceRoots] }),
      }, { tolerateStoredLegacyEnvelope: true })
    );
    const sourceRoots = canonicalSourceRoots(
      entryFilename,
      injectedInput.sourceRoots,
    );
    const engineResolver = new EngineProgramResolver(
      { main: entryFilename, files: injectedInput.files },
      this.#ctRuntime.staticCache,
    );
    const fabricResolver = options.fabricImports
      ? new FabricAwareResolver(engineResolver, {
        runtime: this.#ctRuntime,
        space: options.fabricImports.space,
        allowUnpinned: options.fabricImports.allowUnpinned,
      })
      : undefined;
    const resolver = fabricResolver ?? engineResolver;
    // Resolution may perform storage/network I/O for fabric mounts. Its
    // failures are intentionally left unmarked and therefore retryable.
    const resolvedProgram = await this.#resolveWithSourceRoots(
      resolver,
      sourceRoots,
    );
    const mounts = fabricResolver?.mounts() ?? [];
    const specifierAliases = fabricResolver?.specifierAliases() ?? new Map();
    const resolvedProgramFiles = uniqueSourcesByName(resolvedProgram.files);
    // Fabric mounts are fetched as authored source; inject the helper for
    // compilation (authored entry modules were injected before resolve above).
    const resolvedForCompile = {
      ...resolvedProgram,
      files: deterministicCompileStep(() =>
        injectMountSources(resolvedProgramFiles)
      ),
    };
    const moduleFiles = resolvedProgramFiles.filter((f) =>
      !f.name.endsWith(".d.ts")
    );
    // Identity + stored source hash the AUTHORED bytes (recovered from the
    // stored input, by stored filename); the resolved set above carries the
    // injected form the compiler needs. Identities recompute prefix-free over
    // the authored closure — they match the stored identities the source docs
    // were keyed by.
    const authoredByStoredName = new Map(
      codeFiles.map((f) => [f.name, f.contents]),
    );
    const pristineSourceFiles = [
      ...pristineModuleSources(
        persistableSourceFiles(resolvedProgramFiles),
        authoredByStoredName,
        (name) => storedFilenameFor(name, undefined, mounts),
      ),
      ...dataSources,
    ];
    const identityByPath = computeFabricModuleIdentities(
      pristineSourceFiles,
      mounts,
      sourceRoots.length || dataPaths.length
        ? {
          sourcePackage: {
            entryPath: entryFilename,
            rootPaths: sourceRoots,
            dataPaths,
          },
        }
        : {},
    );

    // Instrumenting does not disturb the identity check below: identity hashes
    // the authored source, not the emitted JS. The paths here are prefix-free,
    // so coverage names them without an `/<id>` prefix to strip.
    const patternCoverage = patternCoverageOptionsForCompile(
      options.patternCoverage,
      {
        id: undefined,
        mounts,
        sourceFiles: pristineSourceFiles,
      },
    );
    const builderSourceSites = builderSourceSiteOptionsForCompile({
      id: undefined,
      mounts,
      sourceFiles: pristineSourceFiles,
    });

    const emitted = deterministicCompileStep(() =>
      compiler.compileToModules(resolvedForCompile, {
        runtimeModules: Engine.runtimeModuleNames(),
        specifierAliases,
        // These bytes are durable stored source nobody can re-author;
        // authoring-hygiene diagnostics (a now-unused @ts-expect-error) must
        // not brick the reload (CT-1916).
        storedSource: true,
        beforeTransformers: (program) => {
          const pipeline = new (compilerStack()
            .CommonFabricTransformerPipeline)({
            patternCoverage,
            builderSourceSites,
            // The transformer-level twin of `storedSource` above: pattern
            // shape gates (opaque reserved result keys) demote to warnings
            // here, so a rule added after these bytes were admitted cannot
            // brick their reload. The identity check below already
            // guarantees this compile reconstructs rather than admits.
            storedSource: true,
            moduleIdentities: identityByPath,
            // Names on this path are already stored-shaped (no `/<id>`
            // prefix); only mount paths need unmapping to authored spellings.
            canonicalWriterIdentityFile: (name) =>
              storedFilenameFor(name, undefined, mounts),
          });
          return {
            factories: pipeline.toFactories(program),
            getDiagnostics: () => pipeline.getDiagnostics(),
            getBuilderSourceSites: () => pipeline.getBuilderSourceSites(),
            getPolicyManifests: () => pipeline.getPolicyManifests(),
          };
        },
      })
    );
    for (const file of moduleFiles) {
      if (!emitted.has(file.name)) {
        throw deterministicCompileError(
          `Recompile from source produced no body for '${file.name}'`,
        );
      }
    }

    const dataFileSet = new Set(dataPaths);
    const importEdges = resolveModuleImports({
      main: "",
      files: pristineSourceFiles,
    }, { dataFiles: dataFileSet });
    const modules: CacheableModule[] = pristineSourceFiles.map((file) => {
      const out = emitted.get(file.name);
      const identity = identityByPath.get(file.name)!;
      const patternCoverageSpans = patternCoverage === undefined ||
          out === undefined
        ? undefined
        : options.patternCoverage?.spansForFile(
          coverageFilenameFor(file.name, undefined, mounts),
        );
      const imports = cacheableImportsFor(
        file.name,
        importEdges,
        identityByPath,
        specifierAliases,
      );
      if (file.name === entryFilename) {
        for (const rootPath of sourceRoots) {
          const rootIdentity = identityByPath.get(rootPath);
          if (rootIdentity === undefined) {
            throw new Error(
              `Source root '${rootPath}' has no module identity.`,
            );
          }
          imports.push({
            specifier: sourceRootSpecifier(
              storedFilenameFor(rootPath, undefined, mounts),
            ),
            targetIdentity: rootIdentity,
          });
        }
        for (const dataPath of dataPaths) {
          imports.push({
            specifier: dataFileSpecifier(
              storedFilenameFor(dataPath, undefined, mounts),
            ),
            targetIdentity: identityByPath.get(dataPath)!,
          });
        }
      }
      const policyManifests = out === undefined
        ? undefined
        : validatePolicyManifestsForModule(identity, out.policyManifests);
      const isData = dataFileSet.has(file.name);
      return {
        identity,
        filename: storedFilenameFor(file.name, undefined, mounts),
        source: file.contents,
        js: isData ? file.contents : (out?.js ?? ""),
        ...(isData ? { isData: true } : {}),
        ...(out?.sourceMap === undefined ? {} : { sourceMap: out.sourceMap }),
        ...(out?.builderSourceSites === undefined
          ? {}
          : { builderSourceSites: out.builderSourceSites }),
        ...(patternCoverageSpans === undefined ? {} : { patternCoverageSpans }),
        ...(policyManifests === undefined ? {} : { policyManifests }),
        imports,
      };
    });
    for (const module of modules) {
      this.#ctRuntime.registerCfcPolicyManifests(
        undefined,
        module.policyManifests ?? [],
      );
    }
    const entryIdentity = identityByPath.get(entryFilename)!;
    return { modules, entryIdentity };
  }

  /**
   * Compile + evaluate a program through the ESM module-record path,
   * returning `{ main, exportMap }` plus the per-identity namespaces.
   *
   * Low-level: this does NOT register the evaluated artifacts in the pattern
   * index, so anonymous map/filter/flatMap ops from the returned namespace have
   * no content-addressed entry ref and would resolve via their embedded graph.
   * To RUN a pattern from the returned namespace, use
   * `PatternManager.compileAndRegisterModules`, which fuses registration in (see
   * CT-1811). Reach for this bare form only to inspect serialized/verified output
   * without running.
   */
  async compileAndEvaluateModules(
    program: RuntimeProgram,
    options: TypeScriptHarnessProcessOptions = {},
  ): Promise<EvaluateResult> {
    // Ensure runtime exports + exportsCallback are initialized.
    await this.#getRuntimeInternals();
    const { id, graph, mainSpecifier } = await this.compileToRecordGraph(
      program,
      options,
    );
    return this.evaluateRecordGraph(id, graph, mainSpecifier, program);
  }

  /**
   * Evaluate a verified ESM record graph (public so the PatternManager can run
   * compile → cache write-back → evaluate as discrete steps). Thin wrapper over
   * `#evaluateGraph()` with the source-compile registration strategy: module
   * identities are recomputed from `files`, paths carry the `/<id>` prefix, and
   * `files` flow into the export map for sub-pattern re-instantiation.
   * `dataFiles` names the members of `files` that are data, so a sub-pattern
   * re-instantiated from the export map keeps the same source package.
   */
  evaluateRecordGraph(
    id: string,
    graph: CompiledModuleGraph,
    mainSpecifier: string,
    program: Pick<RuntimeProgram, "files" | "dataFiles">,
  ): EvaluateResult {
    const prefix = `/${id}`;
    return this.#evaluateGraph(graph, mainSpecifier, {
      evalIdPrefix: id,
      fileNameForPath: (path) =>
        path.startsWith(prefix) ? path.slice(prefix.length) : path,
      filesForExports: program.files,
      ...(program.dataFiles === undefined
        ? {}
        : { dataFilesForExports: [...program.dataFiles] }),
    });
  }

  /**
   * Evaluate a record graph. Shared core for both the source-compile path
   * ({@link evaluateRecordGraph}) and the resolve-free cached-load path
   * ({@link evaluateCachedModules}); `ctx` supplies the path/identity handling
   * that differs between them (prefixed authored paths vs prefix-free cached
   * identities). The graph is assumed already security-verified.
   *
   * The graph loads synchronously via `importNow` in a locked-down compartment
   * whose globals are the hardened runtime globals (runtime-module records,
   * already in the graph, supply the trusted host APIs). The entry namespace
   * comes back as `main`, alongside the per-module export map.
   */
  #evaluateGraph(
    graph: CompiledModuleGraph,
    mainSpecifier: string,
    ctx: {
      evalIdPrefix: string;
      fileNameForPath(path: string): string;
      filesForExports: Source[];
      dataFilesForExports?: string[];
    },
  ): EvaluateResult {
    logger.timeStart("evaluateRecordGraph");
    try {
      // Per-evaluation id, used ONLY to key this evaluation's synthetic
      // source-map names (`${evalId}.js`). The former "verified load id" —
      // which scoped CFC identity and registry partitions to a load — is gone
      // (PR E2): identity flows through the content-addressed provenance
      // recorded below.
      const evalId = `${ctx.evalIdPrefix}:esm:${this.#nextEvalId++}`;

      const patternCoverage = this.#patternCoverageByGraph.get(graph);
      const globals = createModuleCompartmentGlobals({
        console: this.#consoleShim,
        ...(patternCoverage
          ? { [PATTERN_COVERAGE_GLOBAL]: patternCoverage.sandboxGlobal() }
          : {}),
      });
      // Register a composed bundle source map for `${evalId}.js` so that a
      // stack coordinate from this evaluation maps back to authored source.
      // Its consumers are error mapping for throws escaping module evaluation
      // or invocation, plus scheduler action diagnostics.
      // Full module path per specifier.
      const sourceNameBySpecifier = new Map<string, string>();
      for (const [name, specifier] of graph.specifierByPath) {
        sourceNameBySpecifier.set(specifier, name);
      }
      // Composition + registration are DEFERRED (CT-1819): composing these
      // maps is a per-segment VLQ transcode over every module (~16-22ms per
      // cold boot post-#4455/#4460), while error mapping only asks for one
      // after a throw. Providers capture per-module line counts and raw maps,
      // never compiled bodies, so the closures retain KBs, not bundle text;
      // each is one-shot and dropped after first use.
      const lineCountBySpecifier = new Map<string, number>();
      for (const [specifier, body] of graph.compiledBodies) {
        lineCountBySpecifier.set(
          specifier,
          (body.match(/\n/g)?.length ?? 0) + 1,
        );
      }
      const moduleSourceMaps = graph.moduleSourceMaps;
      const bundleEntries = [...graph.compiledBodies.keys()].map(
        (specifier) => {
          const source = sourceNameBySpecifier.get(specifier);
          const bodyLineCount = lineCountBySpecifier.get(specifier)!;
          return { specifier, source, bodyLineCount };
        },
      );
      this.#getSESRuntime().loadSourceMapLazy(
        `${evalId}.js`,
        () =>
          composeBundleSourceMap(
            bundleEntries.map(({ specifier, source, bodyLineCount }) => ({
              bodyLineCount,
              map: moduleSourceMaps.get(specifier) ??
                (source !== undefined
                  ? identitySourceMap(bodyLineCount, source)
                  : undefined),
              source,
            })),
            `${evalId}.js`,
          ),
      );
      // ALSO register each module's map under its eval `//# sourceURL` (its
      // sanitized source name). Browsers surface the per-module eval frame in
      // `new Error().stack` rather than the bundle frame, so it needs a map of
      // its own. Those coordinates are eval-relative, hence the factory-wrapper
      // line shift (`(function (...) {\n` = +1).
      //
      // When no authored map exists for a module (the warm/cached record load \u2014
      // `buildRecordsFromCompiled` populates `moduleSourceMaps` only for cached
      // bodies that retained one), fall back to an IDENTITY map keyed on the
      // module's per-module source `name`, so the frame is still re-labeled with
      // the module source name instead of a raw bundle coordinate.
      for (const [name, specifier] of graph.specifierByPath) {
        const sourceUrl = name.replace(/[\r\n\u2028\u2029]/g, "_");
        const bodyLineCount = lineCountBySpecifier.get(specifier) ?? 1;
        this.#getSESRuntime().loadSourceMapLazy(sourceUrl, () => {
          const map = moduleSourceMaps.get(specifier) ??
            identitySourceMap(bodyLineCount, name);
          return composeBundleSourceMap(
            [{ bodyLineCount: 1, map, source: name }],
            sourceUrl,
            1, // the `(function (exports, require, module) {` wrapper line
          );
        });
      }

      const frame = pushFrame({
        runtime: this.#ctRuntime,
        moduleEvaluation: true,
      });

      let loaded: ReturnType<typeof loadModuleGraph>;
      try {
        loaded = loadModuleGraph(mainSpecifier, {
          records: graph.records,
          globals,
          verify: false, // already verified at compile time
        });
      } catch (error) {
        // Module evaluation runs outside an `exec` call, so errors thrown
        // at module scope would otherwise surface with a censored (empty) or
        // raw-coordinate stack. Materialize + source-map it here (once),
        // matching how invoked-function errors are mapped.
        throw this.#getSESRuntime().mapThrownError(error);
      } finally {
        popFrame(frame);
      }

      const main = loaded.namespace as Exports;

      // Build the per-module export map (keyed by normalized source path) from
      // the SAME load, and map each exported value back to its RuntimeProgram
      // for sub-pattern resolution.
      const exportMap: Record<string, Exports> = {};
      const exportsByValue = new Map<unknown, RuntimeProgram>();
      // Per-module namespaces keyed by content identity (stripped from the
      // `cf:module/<identity>` specifier) for the in-memory identity cache.
      const exportsByIdentity = new Map<string, Exports>();
      // Where each module came from, keyed the same way. A pattern loaded BY
      // IDENTITY carries no program (see `patternFromMain`), so without this
      // its source location is unrecoverable at the point of use — the
      // information exists right here and was simply not written down.
      const sourcePathByIdentity = new Map<string, string>();
      const MODULE_SPECIFIER_PREFIX = "cf:module/";
      const reachableSpecifiers = reachableModuleSpecifiers(
        graph.records,
        mainSpecifier,
      );
      for (const [path, specifier] of graph.specifierByPath) {
        if (!reachableSpecifiers.has(specifier)) continue;
        const namespace = loaded.importNow(specifier) as Exports;
        const fileName = ctx.fileNameForPath(path);
        exportMap[fileName] = namespace;
        if (specifier.startsWith(MODULE_SPECIFIER_PREFIX)) {
          const identity = specifier.slice(MODULE_SPECIFIER_PREFIX.length);
          exportsByIdentity.set(identity, namespace);
          sourcePathByIdentity.set(identity, fileName);
        }
        for (const [exportName, value] of Object.entries(namespace)) {
          // Only object/function exports are sub-pattern candidates. Skip the
          // `__esModule` flag and primitives, which would otherwise collide in
          // this value-keyed map (e.g. every module's `true`).
          if (exportName === "__esModule") continue;
          if (typeof value !== "object" && typeof value !== "function") {
            continue;
          }
          if (value === null) continue;
          exportsByValue.set(value, {
            main: fileName,
            mainExport: exportName,
            files: ctx.filesForExports,
            ...(ctx.dataFilesForExports === undefined
              ? {}
              : { dataFiles: ctx.dataFilesForExports }),
          });
        }
      }
      this.#runtimeInternals?.exportsCallback(exportsByValue);

      // Content-addressed CFC provenance: record it HERE, where functions
      // become verified (this evaluation), rather than in the PatternManager's
      // later indexing - so provenance covers every load path, including a
      // pattern compiled by a standalone Engine and registered without going
      // through `PatternManager.compilePattern`. Keyed by the implementation
      // function object; gated on the same `isTrustedBuilderArtifact` brand the
      // index uses, so forged values get nothing. This walk also carries the
      // CT-1665 verified-binding identity for non-exported handlers: each
      // `__cfReg`-registered factory already wears its
      // `__cfVerifiedBindingIdentity` annotation, which recordModuleProvenance
      // folds into the provenance entry.
      this.#recordModuleProvenance(
        exportsByIdentity,
        graph.registrationSink,
        graph.builderSourceSitesByIdentity,
        sourcePathByIdentity,
      );

      // `graph.registrationSink` was populated by each module's `__cfReg` during
      // the `importNow` loop above (committed only for modules that evaluated
      // cleanly).
      return {
        main,
        exportMap,
        exportsByIdentity,
        sourcePathByIdentity,
        registrationsByIdentity: graph.registrationSink,
      };
    } finally {
      logger.timeEnd("evaluateRecordGraph");
    }
  }

  /**
   * Record content-addressed CFC provenance for every trusted builder artifact
   * surfaced by a verified evaluation — its exports (keyed by export name) and
   * its `__cfReg` hoist/non-export registrations (keyed by the hoist symbol).
   * Keyed by the artifact's implementation function object; the same gate the
   * artifact index uses (`isTrustedBuilderArtifact`) keeps forged values out.
   * First-write-wins (see `recordVerifiedProvenance`), so an export and a
   * `__cfReg` entry for one artifact agree on a single canonical symbol.
   */
  #recordModuleProvenance(
    exportsByIdentity: Map<string, Exports>,
    registrationSink: Map<string, Map<string, unknown>>,
    builderSourceSitesByIdentity: ReadonlyMap<
      string,
      BuilderSourceSitesV1
    >,
    sourcePathByIdentity: ReadonlyMap<string, string>,
  ): void {
    const record = (identity: string, symbol: string, value: unknown) => {
      if (!isTrustedBuilderArtifact(value)) return;
      const implementation =
        (value as { implementation?: unknown }).implementation ?? value;
      if (typeof implementation !== "function") return;
      // Reject a CONFIRMED cross-module mismatch: a re-exporting module
      // (`export { setName } from "./defn"`) surfaces the same function under
      // its own identity. Provenance is first-write-wins, so letting a
      // re-exporter (possibly visited first here) stamp its identity would give a
      // genuinely-verified artifact the WRONG (re-exporter's) module identity —
      // and its `writeAuthorizedBy` claims (which name the defining module) would
      // then be denied. The defining module stamps `getDefiningModule` at its
      // own (dependency-ordered) evaluation, so drop any record whose recording
      // identity disagrees; the defining module's (matching) record sticks. An
      // UNSTAMPED function (undefined — e.g. a runtime/host module, or a
      // standalone-engine load) is left ALONE: recording it is harmless.
      // (This replaces the former canonical-`fn.src` guard; `.src` is now
      // lazy/debug-only and no longer names the defining module.)
      const definingIdentity = getDefiningModule(implementation);
      if (definingIdentity !== undefined && definingIdentity !== identity) {
        return;
      }
      const bindingIdentity = readBindingIdentity(value);
      recordVerifiedProvenance(implementation, {
        identity,
        symbol,
        ...(bindingIdentity ? { bindingIdentity } : {}),
      });
      const sites = builderSourceSitesByIdentity.get(identity)?.sites;
      const site = sites !== undefined && Object.hasOwn(sites, symbol)
        ? sites[symbol]
        : undefined;
      const sourcePath = sourcePathByIdentity.get(identity);
      if (site !== undefined && sourcePath !== undefined) {
        const normalizedPath = authoredDebugSourcePath(sourcePath);
        const path = normalizedPath.startsWith("/")
          ? normalizedPath
          : `/${normalizedPath}`;
        recordAuthoredDebugSource(implementation, {
          src: `cf:module/${identity}${path}:${site.line}:${site.col}`,
          ...(site.bindingName === undefined
            ? {}
            : { bindingName: site.bindingName }),
        });
      }
      // The strong content-addressed implementation index — the resolution
      // (and eviction-insurance) backing for serialized `$implRef`s; see
      // `ExecutableRegistry.registerVerifiedImplementation`.
      this.#executableRegistry.registerVerifiedImplementation(
        identity,
        symbol,
        implementation as HarnessedFunction,
      );
      this.#ctRuntime.telemetry.submit({
        type: "harness.implementation.register",
        identity,
        symbol,
        ...(bindingIdentity
          ? { bindingPath: bindingIdentity.bindingPath }
          : {}),
      });
    };
    for (const [identity, namespace] of exportsByIdentity) {
      for (const [exportName, value] of Object.entries(namespace)) {
        if (exportName === "__esModule") continue;
        record(identity, exportName, value);
      }
    }
    for (const [identity, entries] of registrationSink) {
      for (const [symbol, value] of entries) {
        record(identity, symbol, value);
      }
    }
  }

  /**
   * Warm load path: build a record graph **directly from cached compiled
   * modules** (no TS source, no `resolve`, no recompile — see
   * {@link buildRecordsFromCompiled}), register runtime records, security-verify
   * (still re-verified while the integrity label is client-asserted), and
   * evaluate. `entryIdentity` is the content identity of the entry module
   * (`cf:module/<entryIdentity>`). Optional `sourceFiles` (the cached source
   * closure) flow into the export map so sub-pattern re-instantiation keeps a
   * program to recompile from; omit them and sub-patterns fall back to identity.
   * `dataFiles` names the members of `sourceFiles` that are data.
   */
  async evaluateCachedModules(
    modules: readonly CachedCompiledModule[],
    entryIdentity: string,
    options: {
      sourceFiles?: Source[];
      dataFiles?: readonly string[];
      trustedBodies?: boolean;
      patternCoverage?: PatternCoverageCollector;
    } = {},
  ): Promise<EvaluateResult> {
    await this.#getRuntimeInternals();
    const { runtimeExports } = await this.#getRuntimeInternals();
    const runtimeNames = Engine.runtimeModuleNames().filter((name) =>
      runtimeExports?.[name]
    );
    const runtimeModulesOption = Object.fromEntries(
      runtimeNames.map((name) => [
        name,
        Object.keys(runtimeExports?.[name] ?? {}),
      ]),
    );

    // A module without the persisted record surface (legacy doc, or a test
    // building modules by hand) makes buildRecordsFromCompiled parse its body
    // — load the deferred compiler stack first. The warm-cache boot path
    // always carries the surface (runtimeVersion fingerprints the extractor),
    // so the steady boot stays compiler-free.
    // A data entry has no record surface and is never parsed, so it must not
    // drag the compiler onto the warm boot path.
    if (
      modules.some((m) =>
        !m.isData &&
        (m.exportNames === undefined || m.starTargetSpecs === undefined ||
          m.importSpecs === undefined)
      )
    ) {
      await ensureCompilerStack();
    }
    const graph = buildRecordsFromCompiled(modules, {
      runtimeModules: runtimeModulesOption,
    });

    // The cached bodies carry the coverage probes from the compile that emitted
    // them, and the spans that name the lines those probes stand for. Register
    // both against this graph so `#evaluateGraph` installs the collector as the
    // sandbox global. The spans are what map a probe's `(fileName, id)` back to
    // source lines; a graph registered without them reports nothing for its
    // hits.
    if (options.patternCoverage !== undefined) {
      for (const module of modules) {
        options.patternCoverage.registerSpans(
          module.patternCoverageSpans ?? [],
        );
      }
      this.#patternCoverageByGraph.set(graph, options.patternCoverage);
    }

    // Register runtime-module records so cf:runtime/* imports resolve.
    const runtimeRecordExports: Record<string, Record<string, unknown>> = {};
    for (const name of runtimeNames) {
      runtimeRecordExports[name] = runtimeExports?.[name] as Record<
        string,
        unknown
      >;
    }
    for (const [spec, record] of runtimeModuleRecords(runtimeRecordExports)) {
      graph.records.set(spec, record as VirtualModuleRecord);
    }

    // Security-verify every cached body before executing — EXCEPT a trusted
    // warm hit. These bodies always come from the integrity-gated compiled set
    // (`loadCompiledClosure` reads with `requiredIntegrity`, fail-closed), so
    // with `trustedBodies` the CFC integrity label is the security boundary and
    // re-running the SES body verifier is redundant per-load work (threat model:
    // `docs/specs/module-loading.md`, "the persistent compilation cache"). The
    // structural graph verify below always runs.
    if (options.trustedBodies !== true) {
      // Verify, and record which modules the verifier approved for hoist
      // registration — only those get the real `__cfReg` registrar. Yield
      // between modules so queued event-loop work (worker IPC) interleaves
      // with the CPU-bound per-body verification (browser worker only; a no-op
      // in Deno, where the yield would be pure batch overhead).
      for (const [specifier, body] of graph.compiledBodies) {
        const { hasHoistRegistration } = verifyCompiledModuleBody(
          body,
          specifier,
        );
        if (hasHoistRegistration) graph.registrationApproved.add(specifier);
        await interleaveCompileYield();
      }
    } else {
      // Trusted integrity-gated bytes: registration approval was sealed at
      // first compile; grant the real registrar to every module.
      for (const specifier of graph.compiledBodies.keys()) {
        graph.registrationApproved.add(specifier);
      }
    }
    const mainSpecifier = `cf:module/${entryIdentity}`;
    if (!graph.records.has(mainSpecifier)) {
      throw new Error(
        `Cached closure is missing the entry module ${mainSpecifier}`,
      );
    }
    verifyModuleGraph(graph.records, mainSpecifier);

    // The SES evaluation below is a single synchronous stretch (~100ms+ for a
    // system pattern); in the browser worker, yield first so IPC queued behind
    // the load runs before it rather than after (no-op in Deno).
    await interleaveCompileYield();

    return this.#evaluateGraph(graph, mainSpecifier, {
      evalIdPrefix: entryIdentity,
      fileNameForPath: (path) => path, // already normalized
      filesForExports: options.sourceFiles ?? [],
      ...(options.dataFiles === undefined
        ? {}
        : { dataFilesForExports: [...options.dataFiles] }),
    });
  }

  /**
   * Invokes a function that should have come from this SES runtime
   * (unverifiable). We use this to hook into its source mapping functionality.
   */
  invoke(fn: () => any): any {
    // Scheduler dictates this is a synchronous function,
    // and if we have functions from this source, this should already
    // be set up.
    // Some tests invoke values outside of this SES runtime, so just
    // execute and return if runtime internals have not been initialized.
    if (!this.#runtimeInternals && !this.#sesRuntime) {
      return fn();
    }
    return this.#getSESRuntime().exec(fn);
  }

  getInvocation(source: string): HarnessedFunction {
    return this.#getSESRuntime().evaluateCallback(source) as HarnessedFunction;
  }

  getVerifiedImplementation(
    identity: string,
    symbol: string,
  ): HarnessedFunction | undefined {
    return this.#executableRegistry.getVerifiedImplementation(identity, symbol);
  }

  unsafeTrustHostValue(
    value: unknown,
    options: UnsafeHostTrustOptions,
  ): void {
    this.#executableRegistry.trustHostValue(value, options);
  }

  /**
   * Parses an error stack trace, mapping all positions back to original
   * sources. Returns the original stack if runtime internals haven't been
   * initialized.
   */
  parseStack(stack: string): string {
    if (!this.#runtimeInternals) {
      return stack;
    }
    return this.#runtimeInternals.runtime.parseStack(stack);
  }

  /** Returns a map of runtime module types. */
  static getRuntimeModuleTypes(cache: StaticCache) {
    return getRuntimeModuleTypes(cache);
  }

  static async getEnvironmentTypes(cache: StaticCache) {
    const { getTypeScriptEnvironmentTypes } = await ensureCompilerStack();
    return getTypeScriptEnvironmentTypes(cache);
  }

  static runtimeModuleNames() {
    return [...RuntimeModuleIdentifiers];
  }

  async #getRuntimeInternals(): Promise<RuntimeInternals> {
    if (!this.#runtimeInternals) {
      this.#runtimeInternals = await this.initializeRuntime();
    }
    return this.#runtimeInternals;
  }

  async #getCompilerInternals(): Promise<CompilerInternals> {
    if (!this.#compilerInternals) {
      this.#compilerInternals = await this.initializeCompiler();
    }
    return this.#compilerInternals;
  }

  /**
   * Clean up resources held by the engine.
   * Clears accumulated source maps and other state to prevent memory leaks.
   */
  dispose(): void {
    if (this.#sesRuntime) {
      this.#sesRuntime.clear();
    }
    this.#sesRuntime = undefined;
    this.#runtimeInternals = undefined;
    this.#compilerInternals = undefined;
    this.#nextEvalId = 0;
    this.#executableRegistry.clear();
  }

  #getSESRuntime(): SESRuntime {
    if (!this.#sesRuntime) {
      ensureSESLockdown();
      this.#sesRuntime = new SESRuntime({
        globals: createModuleCompartmentGlobals({
          console: this.#consoleShim,
        }),
        hideInternalStackFrames: this.#options.hideInternalStackFrames,
        lockdown: false,
      });
    }
    return this.#sesRuntime;
  }
}

function validatePolicyManifestsForModule(
  moduleIdentity: string,
  inputs: readonly unknown[] | undefined,
): readonly unknown[] | undefined {
  return inputs?.map((input) => {
    const artifact = validateCfcPolicyArtifactManifest(input);
    if (artifact.manifest.moduleIdentity !== moduleIdentity) {
      throw new Error(
        `policy manifest module identity mismatch for '${moduleIdentity}'`,
      );
    }
    return artifact;
  });
}

function computeId(program: RuntimeProgram): string {
  const sourceRoots = canonicalSourceRoots(program.main, program.sourceRoots);
  const dataFiles = canonicalDataFiles(program.main, program.dataFiles);
  const source = [
    program.main,
    ...(sourceRoots.length === 0 ? [] : [{ sourceRoots }]),
    ...(dataFiles.length === 0 ? [] : [{ dataFiles }]),
    ...persistableSourceFiles(program.files),
  ];
  return hashOf(source).toString();
}

function assertNoReservedFabricPaths(files: readonly Source[]): void {
  for (const file of files) {
    if (file.name.startsWith(FABRIC_MOUNT_ROOT)) {
      throw new Error("/~cf/ is a reserved namespace");
    }
  }
}

function assertFabricImportsHaveSpace(
  files: readonly Source[],
  options: { fabricImports?: { space: MemorySpace } },
): void {
  if (options.fabricImports !== undefined) return;
  // Deferred compiler stack (parses): only called from compileToRecordGraph,
  // which awaits ensureCompilerStack() first.
  const { collectImportSpecifiers, ts } = compilerStack();
  for (const file of files) {
    for (
      const specifier of collectImportSpecifiers(
        file,
        ts.ScriptTarget.ES2023,
      )
    ) {
      if (isFabricImportSpecifier(specifier)) {
        throw new Error(
          "fabric imports require a space context (options.fabricImports)",
        );
      }
    }
  }
}

// Recover each resolved AUTHORED module's pre-helper-injection source for module
// identity and the stored source set. `resolved` carries the helper-injected,
// prefixed bytes the compiler/transformer pipeline needs; identity must hash the
// authored bytes instead (module-loading.md). Authored modules map back to
// `authoredByStoredName` via their stored (prefix-free) filename. Fabric-MOUNT
// modules (`/~cf/<identity>/...`) are left untouched: their fetched `doc.code`
// is already the authored source their own space governs, and their stored
// filename can collide with an authored module's (both `/main.tsx`), so they
// must NOT be looked up in `authoredByStoredName`. `.d.ts` files are excluded by
// callers before this runs.
function pristineModuleSources(
  resolved: readonly Source[],
  authoredByStoredName: ReadonlyMap<string, string>,
  storedNameOf: (name: string) => string,
): Source[] {
  return resolved.map((file) => {
    if (file.name.startsWith(FABRIC_MOUNT_ROOT)) return file;
    const authored = authoredByStoredName.get(storedNameOf(file.name));
    return authored === undefined
      ? file
      : { name: file.name, contents: authored };
  });
}

// Inject the `__cfHelpers` import into resolved fabric-MOUNT sources, for
// compilation only. Authored modules are already helper-injected by
// `pretransformProgramForModules` (hot) / the cold path's pre-resolve inject;
// mounts are fetched as authored source (post the identity fix) and would
// otherwise reach the compiler without the helper they need. `commonfabric` is
// already resolved into the program by the authored entry's injected import, so
// injecting here (after resolve) resolves cleanly. Non-mount and `.d.ts` files
// pass through unchanged.
//
// Mount sources are ALWAYS storage-fetched (never author-typed), so the
// legacy-envelope tolerance (CT-1838) applies unconditionally here: a mount
// whose stored bytes are exactly the pre-#4158 injected envelope passes
// through unchanged instead of tripping the reserved-symbol guard. This is
// what lets a NEW pattern fabric-import a legacy pattern (warm/authoring
// path, `compileToRecordGraph`) as well as the cold path recompile one. The
// authoring guard for the pattern's OWN typed source is unaffected — it runs
// in `pretransformProgramForModules` before resolution.
function injectMountSources(files: readonly Source[]): Source[] {
  const mounts = files.filter((f) => f.name.startsWith(FABRIC_MOUNT_ROOT));
  if (mounts.length === 0) return [...files];
  const injected = new Map(
    transformInjectHelperModule({ main: mounts[0].name, files: mounts }, {
      tolerateStoredLegacyEnvelope: true,
    }).files
      .map((f) => [f.name, f.contents] as const),
  );
  return files.map((f) => {
    const next = injected.get(f.name);
    return next === undefined ? f : { ...f, contents: next };
  });
}

// The line shift `transformInjectHelperModule` applies to a file's authored
// content, mirroring its decision order. Injection puts the one-line helper
// import ahead of the first content line and appends an `h` shim after the last
// (packages/ts-transformers/src/core/cf-helpers.ts); only the leading import
// moves the authored lines, so an injected file shifts by exactly one line.
// Two kinds of file reach the compiler unchanged and keep their authored
// lines: a stored legacy envelope, whose authored bytes already carry the
// helper import (tolerated only on the storage-fed paths — `checkCFHelperVar`
// rejects those bytes on every authoring path), and a file with no content
// line to inject ahead of.
export function helperInjectionLineOffset(contents: string): number {
  const { isLegacyInjectedEnvelope } = compilerStack();
  if (isLegacyInjectedEnvelope(contents)) return 0;
  if (findFirstContentLineIndex(contents.split("\n")) === null) return 0;
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
        lineOffset: helperInjectionLineOffset(file.contents),
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

/**
 * Removes the loader's collision-disambiguation/mount prefix from a debug
 * source path. Both hot fabric paths (`/~cf/<entry-id>/main.tsx`) and cached
 * collision paths (`/~cf/<module-id>/main.tsx`) then report the persisted
 * authored filename (`/main.tsx`).
 */
function authoredDebugSourcePath(path: string): string {
  if (!path.startsWith(FABRIC_MOUNT_ROOT)) return path;
  const identityAndPath = path.slice(FABRIC_MOUNT_ROOT.length);
  const pathStart = identityAndPath.indexOf("/");
  return pathStart < 0 ? path : identityAndPath.slice(pathStart);
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
        lineOffset: helperInjectionLineOffset(file.contents),
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

function cachedArtifactsIncludePatternCoverage(
  artifacts: ReadonlyMap<string, CompiledModuleArtifact>,
): boolean {
  for (const artifact of artifacts.values()) {
    if (!Array.isArray(artifact.patternCoverageSpans)) return false;
  }
  return true;
}

function lineCountOf(source: string): number {
  return source.split(/\r\n|\r|\n/).length;
}

function coverageFilenameFor(
  name: string,
  id: string | undefined,
  mounts: readonly FabricMount[],
): string {
  // Mount paths carry the imported module identity. The coverage collector keys
  // spans by file name and span id, and span ids restart for each source file.
  if (name.startsWith(FABRIC_MOUNT_ROOT)) return name;
  return storedFilenameFor(name, id, mounts);
}

function uniqueSourcesByName(files: readonly Source[]): Source[] {
  const byName = new Map<string, Source>();
  for (const file of files) {
    const previous = byName.get(file.name);
    if (previous !== undefined) {
      if (previous.contents !== file.contents) {
        throw new Error(
          `Conflicting resolved source contents for '${file.name}'`,
        );
      }
      continue;
    }
    byName.set(file.name, file);
  }
  return [...byName.values()];
}

function cacheableImportsFor(
  fileName: string,
  importEdges: ReadonlyMap<string, ModuleImportEdges>,
  identityByPath: ReadonlyMap<string, string>,
  specifierAliases: ReadonlyMap<string, string>,
): CacheableModule["imports"] {
  const edges = importEdges.get(fileName);
  const internal = (edges?.internalDeps ?? []).map((dep) => ({
    specifier: dep.specifier,
    targetIdentity: requiredIdentity(identityByPath, dep.target),
  }));
  const fabric = (edges?.externalDeps ?? [])
    .filter(isFabricImportSpecifier)
    .map((specifier) => {
      const target = specifierAliases.get(specifier);
      if (target === undefined) {
        throw new Error(
          `unresolved fabric specifier '${specifier}' survived compile`,
        );
      }
      return {
        specifier,
        targetIdentity: requiredIdentity(identityByPath, target),
      };
    });
  return [...internal, ...fabric];
}

function requiredIdentity(
  identityByPath: ReadonlyMap<string, string>,
  path: string,
): string {
  const identity = identityByPath.get(path);
  if (identity === undefined) {
    throw new Error(`No module identity computed for '${path}'`);
  }
  return identity;
}

function storedFilenameFor(
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
 * Strip the whole-program `/<id>` prefix from a resolved module path to recover
 * the normalized authored path (e.g. `/<id>/main.tsx` → `/main.tsx`). Modules
 * resolved without the prefix (the injected `cfc.ts` helper) are returned as-is.
 */
function stripModuleIdPrefix(name: string, id: string): string {
  const prefix = `/${id}`;
  return name.startsWith(`${prefix}/`) ? name.slice(prefix.length) : name;
}
