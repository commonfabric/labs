import ts from "typescript";
import { TransformationContext } from "./mod.ts";
import { CrossStageState } from "./cross-stage-state.ts";
import type { BuilderSourceSite } from "./runtime-contract.ts";

/**
 * Hints for schema generation that override default behavior.
 * Used to communicate access patterns (like array-property-only access)
 * from capture analysis to schema generation.
 */
export type SchemaHint = {
  /** Override for array items schema (e.g., false for items: false) */
  readonly items?: unknown;

  readonly cfcUiContract?: {
    readonly helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
    readonly action?: string;
    readonly surface?: string;
    readonly role?: string;
    readonly kind?: string;
    readonly trustedPattern?: string;
    readonly requiredEventIntegrity?: readonly string[];
  };

  /**
   * The value a node built from part of it narrows: its type, and the node
   * that declares it where one is at hand. Schema generation keeps the
   * value's CFC labels on the narrowed node's schema.
   */
  readonly narrowedFrom?: {
    readonly type: ts.Type;
    readonly typeNode?: ts.TypeNode;
  };
};

export type ReactiveCapability =
  | "opaque"
  | "comparable"
  | "readonly"
  | "writeonly"
  | "writable";

export type CapabilityParamDefault = {
  readonly path: readonly string[];
  readonly defaultType: ts.TypeNode;
};

export type CapabilityParamSummary = {
  readonly name: string;
  readonly capability: ReactiveCapability;
  readonly readPaths: readonly (readonly string[])[];
  readonly fullShapePaths?: readonly (readonly string[])[];
  readonly writePaths: readonly (readonly string[])[];
  readonly opaquePaths?: readonly (readonly string[])[];
  readonly passthrough: boolean;
  readonly wildcard: boolean;

  /**
   * Write-exhaustiveness is unverifiable for this parameter — `writePaths`
   * may be incomplete. Set by unrecognized or dynamic method calls on
   * cell-like receivers, and by `set`/`send` calls carrying an onCommit
   * callback. Consumers asserting write exhaustiveness
   * (`completeSchedulerScopeSummary`) must treat this like `wildcard` and
   * fail closed. Detection is per
   * method-call dispatch: extracted method references
   * (`const f = cell.send; f(x)`) are outside the contract.
   */
  readonly hasUnverifiedCellUse?: boolean;

  readonly identityOnly?: boolean;
  readonly identityPaths?: readonly (readonly string[])[];
  readonly identityCellPaths?: readonly (readonly string[])[];
  readonly comparablePaths?: readonly (readonly string[])[];
  readonly comparableCellPaths?: readonly (readonly string[])[];
  readonly defaults?: readonly CapabilityParamDefault[];
};

/**
 * A cell argument that flows to an out-of-file parameter whose declared type the
 * capability contract cannot read (bare `Cell<T>`, a mixed union, an unbounded
 * generic, or a non-branded cell-like interface). The capability silently
 * degrades, so the caller surfaces this as a diagnostic.
 */
export type UnreadableCellArgument = {
  readonly node: ts.Node;
  readonly message: string;
};

export type FunctionCapabilitySummary = {
  readonly params: readonly CapabilityParamSummary[];

  /** True when analysis was short-circuited due to recursion. */
  readonly recursive?: boolean;

  /** Cell arguments passed to parameters the contract could not classify. */
  readonly unreadableCellArguments?: readonly UnreadableCellArgument[];
};

export type PatternCoverageKind = "runtime";

// Moved to runtime-contract.ts (typescript-free) so the runtime can import it
// without the compiler stack; re-exported here for the compile-side callers.
export { PATTERN_COVERAGE_GLOBAL } from "./runtime-contract.ts";

export type PatternCoverageSpan = {
  readonly fileName: string;
  readonly id: number;
  readonly kind: PatternCoverageKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
};

export type PatternCoverageOptions = {
  readonly fileName?: (sourceFileName: string) => string;
  readonly mapSpan?: (
    span: PatternCoverageSpan,
  ) => PatternCoverageSpan | undefined;
  readonly registerSpan: (span: PatternCoverageSpan) => void;
};

/** Coordinate normalization for builder source-site compiler output. */
export interface BuilderSourceSiteOptions {
  /**
   * Maps a compiler-input coordinate into authored source space. Callers whose
   * compiler input is already authored must supply the identity mapping
   * explicitly; without a mapper the transformer emits no sidecar.
   */
  readonly mapSite: (
    sourceFileName: string,
    site: BuilderSourceSite,
  ) => BuilderSourceSite | undefined;
}

/**
 * Registry for passing schema hints between transformer stages.
 * Keyed by TypeNode (unique per usage) to avoid conflicts when the same
 * Type is used in multiple places with different access patterns.
 */
export type SchemaHints = WeakMap<ts.Node, SchemaHint>;

export type SyntheticReactiveCollectionRegistry = WeakSet<ts.Symbol>;

export type TransformationOptions = {
  /**
   * Single owner of the pipeline's cross-transformer communication registries
   * (typeRegistry, schemaHints, the marker sets, etc.). Replaces the formerly
   * separate registry fields. See `CrossStageState`.
   *
   * This is the injection point for a caller that wants several runs to share
   * one set of registries. A `TransformationContext` built without one creates
   * its own and stores it back here, so `context.state` is always present.
   */
  readonly state?: CrossStageState;

  /**
   * Shared diagnostics collector that accumulates diagnostics across all transformers.
   * If provided, diagnostics are pushed to this array in addition to the local context.
   */
  readonly diagnosticsCollector?: TransformationDiagnostic[];

  readonly patternCoverage?: PatternCoverageOptions;
  readonly builderSourceSites?: BuilderSourceSiteOptions;

  /**
   * Whether an `assert(...)` body records its operands, so that a failing
   * pattern-test assertion can report them. Defaults to true.
   *
   * This does not control the shape of the value an assertion carries — that
   * is always an `AssertRecord`, because `assert` declares it returns one.
   * Setting it false drops only the recording, for a build that wants no
   * debug rendering in its assertion bodies.
   */
  readonly assertDiagnostics?: boolean;

  /** Content identity assigned by the compiler for every authored source. */
  readonly moduleIdentities?: ReadonlyMap<string, string>;

  /**
   * Compile-name → authored-name mapping for CFC writer-identity file
   * spellings (claim minting, provenance stamping, `PolicyOf` source
   * matching). Callers whose program file names are not already authored
   * paths — the runner's engine prefixes every module with a per-load
   * `/<id>` segment — must supply their own unmapping here (the engine
   * passes its `storedFilenameFor`). When absent, file names are recorded
   * verbatim (modulo path-separator normalization).
   */
  readonly canonicalWriterIdentityFile?: (fileName: string) => string;

  /**
   * The program is DURABLE STORED pattern source being reloaded — bytes
   * nobody can re-author, recompiled by a toolchain newer than the one that
   * accepted them, under an identity pin that guarantees this compile admits
   * nothing new. Authoring-shape gates report as warnings in this mode
   * instead of errors, so a new rule cannot retroactively brick every
   * stored pattern of an older shape (the 2026-08-25 estuary deploy: the
   * opaque-reserved-key rule refused every piece pinned to a pre-`VNode`
   * pattern, profiles fleet-wide among them). The transformer-level twin of
   * the compiler option of the same name (CT-1916). Authoring paths — cf
   * check, deploy, candidate admission — leave this off and stay strict:
   * there the author is present and can fix the shape.
   */
  readonly storedSource?: boolean;
};

export type DiagnosticSeverity = "error" | "warning";

export type TransformationDiagnostic = {
  readonly severity: DiagnosticSeverity;
  readonly type: string;
  readonly message: string;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly length: number;
};

export type DiagnosticInput = {
  readonly severity?: DiagnosticSeverity;
  readonly type: string;
  readonly message: string;
  readonly node: ts.Node;
};

/**
 * Registry for passing Type information between transformer stages.
 *
 * The registry carries three related kinds of synthetic typing:
 * - replacement expression nodes that should keep the original authored type
 * - synthetic TypeNodes that later schema/codegen phases must resolve faithfully
 * - synthetic call expressions (`lift-applied`, `ifElse`, etc.) whose
 *   result types would otherwise be lost after rewriting
 *
 * Most TypeNodes are registered directly at creation time. For composite
 * synthetic TypeNodes that still collapse to unresolved `any` / `unknown`
 * through the public checker APIs, `ensureTypeNodeRegistered(...)` in
 * `ast/type-inference.ts` reconstructs and caches a Type on demand.
 *
 * Uses WeakMap with node identity as key. Node identity is preserved when
 * transformers are applied in sequence via ts.transform().
 */
export type TypeRegistry = WeakMap<ts.Node, ts.Type>;

export abstract class Transformer {
  #options: TransformationOptions;
  constructor(options: TransformationOptions) {
    this.#options = options;
  }

  abstract transform(context: TransformationContext): ts.SourceFile;

  /**
   * Returns whether the transformation should run for `context`'s source
   * file. This base implementation always returns `true`.
   */
  filter(_context: TransformationContext): boolean {
    return true;
  }

  toFactory(
    program: ts.Program,
  ): ts.TransformerFactory<ts.SourceFile> {
    return (transformation: ts.TransformationContext) =>
    (sourceFile: ts.SourceFile) => {
      const context = new TransformationContext({
        program,
        sourceFile,
        tsContext: transformation,
        options: this.#options,
      });

      if (!this.filter(context)) {
        return sourceFile;
      }

      const transformed = this.transform(context);

      return transformed;
    };
  }
}

export abstract class HelpersOnlyTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.cfHelpers.sourceHasHelpers();
  }
}
