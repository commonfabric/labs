import type { Program } from "@commonfabric/js-compiler";
import type {
  BuilderSourceSitesV1,
  PatternCoverageSpan,
} from "@commonfabric/ts-transformers";
import type { MemorySpace } from "../runtime.ts";
import type { HoistRegistrationSink } from "../sandbox/module-record-compiler.ts";

export type HarnessedFunction = (input: any) => void;

export type RuntimeProgram = Program & {
  // The named export from the program's entry file to run.
  // Defaults to "default".
  mainExport?: string;

  /** Source entry points retained and compiled without being executed. */
  sourceRoots?: string[];
};

export interface TypeScriptHarnessProcessOptions {
  // Disables typechecking of the program.
  noCheck?: boolean;
  // An identifer to use to uniquely identify the compiled
  // code when applying source maps.
  identifier?: string;
  // Filename to use in the compiled JS code, for engines
  // that apply source maps.
  filename?: string;
  // Get the program post-AST-transformation for debugging.
  getTransformedProgram?: (program: Program) => void;
  // Show verbose TypeScript error messages instead of simplified hints.
  verboseErrors?: boolean;
  // Cached per-module compiled bodies keyed by content-addressed module
  // identity (the prefix-free `cf:module/<hash>` minus the scheme). Used only on
  // the ESM record-graph path: when every emitted module is present,
  // `compileToRecordGraph` skips the TypeScript compile and builds the record
  // graph from these bodies instead. A partial set is ignored (the engine
  // recompiles the whole program) because per-module identities are
  // transitively sensitive — a closure either hits in full or not at all.
  precompiledModules?: Map<string, CompiledModuleArtifact>;
  // Lazy variant of `precompiledModules`: invoked once, after the engine has
  // resolved the program and computed per-module identities (so the cache can
  // be queried by content identity without a separate resolve pass). Returns the
  // identity-keyed cached bodies, or undefined for a miss. `precompiledModules`
  // takes precedence when both are set.
  precompiledModulesFor?: (info: {
    entryIdentity: string;
    identities: string[];
  }) => Promise<Map<string, CompiledModuleArtifact> | undefined>;
  // Trust the precompiled bodies on a FULL hit: skip the per-module SES body
  // verifier (`verifyCompiledModuleBody`). Set ONLY when the bodies came from an
  // integrity-gated read (the `compileCache` set, loaded with `requiredIntegrity`
  // via `loadCompiledClosure`) — the CFC integrity label, not the SES verifier,
  // is the security boundary for cache hits (see the threat model in
  // `docs/specs/module-loading.md` §"the persistent compilation cache"). Ignored
  // on a miss/partial hit: freshly compiled bodies are always SES-verified.
  // Never set for direct `precompiledModules` injection (untrusted bytes).
  trustedBodies?: boolean;

  /**
   * Enables fabric (cf:) imports for this compile: the space whose cell-cache
   * source docs fabric refs are fetched from and verified against. Absent means
   * any fabric specifier in the authored program is a compile error.
   */
  fabricImports?: FabricImportOptions;
}

export interface FabricImportOptions {
  space: MemorySpace;

  /**
   * Dev-only: resolve unpinned mutable refs by chasing the live pointer.
   * The resulting compile is NOT cacheable — module identity folds the
   * (unpinned) specifier text, so the chase result varies under a fixed
   * identity, and persisting it would make `pattern:`/`compileCache:` docs
   * key-unstable. The cell-cache write path enforces this
   * (`assertNoUnpinnedFabricImports`); callers that write compiled artifacts
   * back must never set this flag.
   */
  allowUnpinned?: boolean;
}

export interface ResolvedFabricPin {
  specifier: string;
  resolvedIdentity: string;
  chain: string[];
}

/** A cached/compiled per-module artifact: emitted JS plus optional metadata. */
export interface CompiledModuleArtifact {
  js: string;
  sourceMap?: unknown;
  patternCoverageSpans?: PatternCoverageSpan[];

  /** Debug-only authored sites, keyed by runtime artifact symbol. */
  builderSourceSites?: BuilderSourceSitesV1;

  /** Compiler-issued policy manifests, transported separately from JS exports. */
  policyManifests?: readonly unknown[];

  /**
   * The modules `js` loads at run time: the specifiers its `require()` calls
   * name, as the record compiler's scan of `js` lists them, in that order.
   * Given, the record graph takes them from here and `js` is not parsed for
   * them; absent, the record compiler scans `js`.
   */
  importSpecs?: readonly string[];
}

/**
 * Everything the content-addressed compilation cache needs to persist (and
 * later reload) one module, surfaced by `compileToRecordGraph` in identity
 * space — callers never see the engine's internal `/<id>` path prefix.
 */
export interface CacheableModule extends CompiledModuleArtifact {
  /** Prefix-free content identity (the `cf:module/<hash>` hash, no scheme). */
  identity: string;

  /** Normalized authored module path (no `/<id>` prefix; e.g. `/main.tsx`). */
  filename: string;

  /** Resolved TypeScript source whose bytes are folded into `identity`. */
  source: string;

  /** Internal import edges: specifier → the dependency module's identity. */
  imports: { specifier: string; targetIdentity: string }[];

  /**
   * This entry carries data rather than code. A data entry's compiled form is
   * its own bytes, so `js` repeats `source` and the compiled set carries what a
   * warm load needs without reading the source set. It is never parsed,
   * verified as a module body, or built into a record.
   */
  isData?: boolean;
}

export type Exports = Record<string, any>;

export interface EvaluateResult {
  main?: Exports;
  exportMap?: Record<string, Exports>;

  /**
   * Per-module namespaces keyed by content identity (the prefix-free
   * `cf:module/<identity>` hash). Lets the runner register every module in a
   * just-evaluated bundle into an in-memory identity->Pattern cache, so a later
   * by-identity load of a sub-pattern reuses the already-live module instead of
   * re-reading the closure from storage and re-evaluating it (CT-1623).
   * Populated only on the ESM evaluate paths.
   */
  exportsByIdentity?: Map<string, Exports>;

  /**
   * Module content identity → the authored file it came from.
   *
   * A pattern reloaded by identity gets no program attached (that path is
   * source-free by design), so nothing downstream can say WHICH file a nested
   * pattern came from. The evaluate loop knows both, so it records the pairing
   * and `PatternManager` stamps it onto each indexed artifact.
   */
  sourcePathByIdentity?: Map<string, string>;

  /**
   * Hoist registrations collected during this evaluation (`__cfReg`): module
   * content identity → (symbol → live builder artifact). The PatternManager turns
   * each trusted entry into a content-addressed `{ identity, symbol }` reference
   * and indexes it for synchronous by-identity resolution.
   */
  registrationsByIdentity?: HoistRegistrationSink;
}
