import ts from "typescript";
import {
  createDataFlowAnalyzer,
  type DataFlowAnalysis,
} from "../ast/dataflow.ts";
import type { NormalizedDataFlow } from "../ast/normalize.ts";
import {
  type CallbackContext,
  classifyReactiveContext,
  findEnclosingCallbackContext,
  type ReactiveContextInfo,
} from "../ast/reactive-context.ts";
import { getRelevantDataFlows } from "../ast/normalize.ts";
import {
  DiagnosticInput,
  type FunctionCapabilitySummary,
  type SchemaHint,
  TransformationDiagnostic,
  TransformationOptions,
} from "./transformers.ts";
import { CrossStageState } from "./cross-stage-state.ts";
import { CFHelpers } from "./cf-helpers.ts";

export interface TransformationContextConfig {
  program: ts.Program;
  sourceFile: ts.SourceFile;
  tsContext: ts.TransformationContext;
  options?: TransformationOptions;
}

export class TransformationContext {
  #dataFlowAnalyzer?: ReturnType<typeof createDataFlowAnalyzer>;
  #reactiveContextCache = new WeakMap<ts.Node, ReactiveContextInfo>();
  #callbackContextCache = new WeakMap<ts.Node, CallbackContext | null>();
  #relevantDataFlowCache = new WeakMap<
    DataFlowAnalysis,
    readonly NormalizedDataFlow[]
  >();
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly factory: ts.NodeFactory;
  readonly sourceFile: ts.SourceFile;
  readonly options: TransformationOptions;

  /**
   * The cross-transformer communication registries every stage in this run
   * shares. Either injected through `options.state` or created here; the same
   * instance is stored back into `this.options.state` so a nested
   * `TransformationContext` built from these options joins the same run.
   */
  readonly state: CrossStageState;

  readonly cfHelpers: CFHelpers;
  readonly diagnostics: TransformationDiagnostic[] = [];
  readonly tsContext: ts.TransformationContext;

  constructor(config: TransformationContextConfig) {
    this.program = config.program;
    this.checker = config.program.getTypeChecker();
    this.tsContext = config.tsContext;
    this.factory = config.tsContext.factory;
    this.sourceFile = config.sourceFile;
    this.cfHelpers = new CFHelpers({
      factory: this.factory,
      sourceFile: this.sourceFile,
    });
    this.state = config.options?.state ?? new CrossStageState();
    this.options = {
      ...config.options,
      state: this.state,
    };
  }

  reportDiagnostic(input: DiagnosticInput): void {
    const { start, length } = this.#resolveDiagnosticRange(input.node);
    const location = this.sourceFile.getLineAndCharacterOfPosition(start);
    const diagnostic: TransformationDiagnostic = {
      severity: input.severity ?? "error",
      type: input.type,
      message: input.message,
      fileName: this.sourceFile.fileName,
      line: location.line + 1,
      column: location.character + 1,
      start,
      length,
    };
    this.diagnostics.push(diagnostic);

    // Also push to shared collector if provided
    if (this.options.diagnosticsCollector) {
      this.options.diagnosticsCollector.push(diagnostic);
    }
  }

  /**
   * Like {@link reportDiagnostic}, but emits at most one diagnostic per
   * (file, type, source range). The capture schemas are built in one shared
   * place that several stages re-walk, so the same capture can reach a
   * diagnostic call more than once; this keys on the resolved range via the
   * shared CrossStageState so the duplicates collapse to one. The file name is
   * part of the key because that state is shared across every file in a
   * compilation, and the range is a file-relative offset that would otherwise
   * collide between files.
   */
  reportDiagnosticOnce(input: DiagnosticInput): void {
    const { start, length } = this.#resolveDiagnosticRange(input.node);
    const key = `${this.sourceFile.fileName}:${input.type}:${start}:${length}`;
    if (!this.state.markDiagnosticReported(key)) {
      return;
    }
    this.reportDiagnostic(input);
  }

  #resolveDiagnosticRange(
    node: ts.Node,
  ): { start: number; length: number } {
    let current: ts.Node | undefined = node;
    while (current) {
      // Try the original node first — synthetic nodes created by transformers
      // often have originals with real source positions.
      const original: ts.Node = ts.getOriginalNode(current);
      if (original && original !== current) {
        const origPos = original.pos;
        const origEnd = original.end;
        if (origPos >= 0 && origEnd >= origPos) {
          try {
            const start = original.getStart(this.sourceFile);
            return { start, length: Math.max(0, origEnd - start) };
          } catch (_e: unknown) {
            // Original may still lack parent links; fall through.
          }
        }
      }

      const pos = current.pos;
      const end = current.end;
      if (pos >= 0 && end >= pos) {
        try {
          const start = current.getStart(this.sourceFile);
          return {
            start,
            length: Math.max(0, end - start),
          };
        } catch (_e: unknown) {
          // Some synthetic nodes still throw here; continue walking to a real parent.
        }
      }
      current = current.parent;
    }

    // Final fallback for fully synthetic trees with no real source positions.
    return { start: 0, length: 0 };
  }

  /**
   * Mark an arrow function as an array method callback created by
   * ClosureTransformer. This allows later transformers to identify synthetic
   * array method callback scopes.
   */
  markAsArrayMethodCallback(node: ts.Node): void {
    this.state.markArrayMethodCallback(node);
    this.#invalidateReactiveAnalysisCaches();
  }

  /**
   * Check if a node is an array method callback created by ClosureTransformer.
   */
  isArrayMethodCallback(node: ts.Node): boolean {
    return this.state.isArrayMethodCallback(node);
  }

  /** Whether `sourceFile` belongs to TypeScript's loaded default library. */
  isSourceFileDefaultLibrary(sourceFile: ts.SourceFile): boolean {
    return this.program.isSourceFileDefaultLibrary(sourceFile);
  }

  /**
   * Mark a synthetic callback introduced by a compute wrapper so later phases
   * can classify its contents as compute-owned even when they originate from
   * authored nodes with original parent chains in pattern context.
   */
  markAsSyntheticComputeCallback(node: ts.Node): void {
    this.state.markSyntheticComputeCallback(node);
    this.#invalidateReactiveAnalysisCaches();
  }

  /**
   * Check if a node is a synthetic compute wrapper callback.
   */
  isSyntheticComputeCallback(node: ts.Node): boolean {
    return this.state.isSyntheticComputeCallback(node);
  }

  markSyntheticComputeOwnedSubtree(node: ts.Node): void {
    this.state.markSyntheticComputeOwnedSubtree(node);
    this.#invalidateReactiveAnalysisCaches();
  }

  isSyntheticComputeOwnedNode(node: ts.Node): boolean {
    return this.state.isSyntheticComputeOwnedNode(node);
  }

  /**
   * Mark a builder call/new node that SchemaInjection has finalized, so a
   * later re-traversal of the transformer's own output skips re-injection.
   * Replaces the arg-count idempotency guards in schema-injection.ts. See
   * the `nodeLinks.schemaInjected` docs in core/mod.ts (CT-1621).
   */
  markSchemaInjected(node: ts.Node): void {
    this.state.markSchemaInjected(node);
  }

  /**
   * Whether SchemaInjection has already finalized this node.
   */
  isSchemaInjected(node: ts.Node): boolean {
    return this.state.isSchemaInjected(node);
  }

  /**
   * Record a schema-generation hint for a node (and its original node, so the
   * hint survives visitor node-replacement). Each kind of hint `hint` gives
   * replaces the node's hint of that kind, and its other kinds stay. See
   * `SchemaHints` docs in core/mod.ts: producers are schema-injection +
   * jsx-site-router, consumers are schema-injection + the schema generator.
   */
  recordSchemaHint(node: ts.Node, hint: SchemaHint): void {
    this.state.recordSchemaHint(node, hint);
  }

  /**
   * Look up a schema-generation hint for a node, falling back to its original
   * node (handles visitor-replaced nodes). Returns undefined when absent.
   */
  lookupSchemaHint(node: ts.Node): SchemaHint | undefined {
    return this.state.lookupSchemaHint(node);
  }

  /**
   * Record a per-function capability summary computed by
   * PatternCallbackLoweringTransformer (expensive interprocedural analysis;
   * cached here for SchemaInjection to reuse). See the
   * `nodeLinks.capabilitySummary` docs in core/mod.ts.
   */
  recordCapabilitySummary(
    fn: ts.Node,
    summary: FunctionCapabilitySummary,
  ): void {
    this.state.recordCapabilitySummary(fn, summary);
  }

  /**
   * Look up a previously-recorded capability summary. Returns undefined when
   * absent; callers fall through to computing the summary on demand.
   */
  lookupCapabilitySummary(
    fn: ts.Node,
  ): FunctionCapabilitySummary | undefined {
    return this.state.lookupCapabilitySummary(fn);
  }

  markSyntheticReactiveCollectionDeclaration(node: ts.Node): void {
    const symbol = ts.isVariableDeclaration(node)
      ? (ts.isIdentifier(node.name)
        ? this.checker.getSymbolAtLocation(node.name)
        : undefined)
      : ts.isIdentifier(node)
      ? this.checker.getSymbolAtLocation(node)
      : undefined;
    if (!symbol) {
      return;
    }
    this.state.markSyntheticReactiveCollection(symbol);
    this.#invalidateReactiveAnalysisCaches();
  }

  /**
   * Returns true if the given identifier resolves to the per-element binding
   * of an array-method pattern callback (one whose declaring function-like is
   * registered in `mapCallbackRegistry`).
   *
   * Uses node-walking rather than symbol identity because symbols can be
   * re-instantiated across pipeline stages while node parent links remain
   * stable.
   */
  isArrayMethodElementBindingReference(identifier: ts.Identifier): boolean {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    const declaration = symbol?.valueDeclaration ??
      symbol?.declarations?.[0];
    if (!declaration) return false;
    if (
      !ts.isParameter(declaration) &&
      !ts.isBindingElement(declaration)
    ) {
      return false;
    }

    // Walk up to the enclosing function-like.
    let cursor: ts.Node | undefined = declaration.parent;
    while (cursor && !ts.isFunctionLike(cursor)) {
      cursor = cursor.parent;
    }
    if (!cursor) return false;

    // Only the FIRST parameter of an array-method callback counts as the
    // element binding. Index/array params and non-first decls are not.
    const fn = cursor as ts.SignatureDeclarationBase;
    const firstParam = fn.parameters?.[0];
    if (!firstParam) return false;
    if (!declarationBelongsToFirstParam(declaration, firstParam)) {
      return false;
    }

    return this.isArrayMethodCallback(cursor);
  }

  getDataFlowAnalyzer(): ReturnType<typeof createDataFlowAnalyzer> {
    this.#dataFlowAnalyzer ??= createDataFlowAnalyzer(this.checker, {
      isArrayMethodElementBindingReference: (id) =>
        this.isArrayMethodElementBindingReference(id),
    });
    return this.#dataFlowAnalyzer;
  }

  analyzeExpression(node: ts.Expression): DataFlowAnalysis {
    return this.getDataFlowAnalyzer()(node);
  }

  getRelevantDataFlows(node: ts.Expression): readonly NormalizedDataFlow[] {
    return this.getRelevantDataFlowsFromAnalysis(this.analyzeExpression(node));
  }

  getRelevantDataFlowsFromAnalysis(
    analysis: DataFlowAnalysis,
  ): readonly NormalizedDataFlow[] {
    const cached = this.#relevantDataFlowCache.get(analysis);
    if (cached) {
      return cached;
    }

    const relevant = getRelevantDataFlows(analysis, this.checker, this);
    this.#relevantDataFlowCache.set(analysis, relevant);
    return relevant;
  }

  getReactiveContext(node: ts.Node): ReactiveContextInfo {
    const cached = this.#reactiveContextCache.get(node);
    if (cached) {
      return cached;
    }

    const info = classifyReactiveContext(node, this.checker, this);
    this.#reactiveContextCache.set(node, info);
    return info;
  }

  getEnclosingCallbackContext(node: ts.Node): CallbackContext | undefined {
    if (this.#callbackContextCache.has(node)) {
      return this.#callbackContextCache.get(node) ?? undefined;
    }

    const info = findEnclosingCallbackContext(node);
    this.#callbackContextCache.set(node, info ?? null);
    return info;
  }

  #invalidateReactiveAnalysisCaches(): void {
    this.#reactiveContextCache = new WeakMap<ts.Node, ReactiveContextInfo>();
    this.#relevantDataFlowCache = new WeakMap<
      DataFlowAnalysis,
      readonly NormalizedDataFlow[]
    >();
    // The dataflow analyzer holds its own per-expression cache. Drop the
    // analyzer instance so the next consumer recreates it with a fresh cache.
    // Critical when downstream registries (array-method element bindings,
    // synthetic reactive collections, etc.) gain new entries between queries
    // — a cached "not opaque" result from before registration would otherwise
    // win.
    this.#dataFlowAnalyzer = undefined;
  }
}

function declarationBelongsToFirstParam(
  decl: ts.Declaration,
  firstParam: ts.ParameterDeclaration,
): boolean {
  // Identifier-form: the declaration itself is the parameter.
  if (decl === firstParam) return true;
  // Destructured: the declaration is a binding element nested under the
  // parameter's binding pattern. Walk parents until we hit firstParam (or
  // exit the function-like).
  let cursor: ts.Node | undefined = decl.parent;
  while (cursor) {
    if (cursor === firstParam) return true;
    if (ts.isFunctionLike(cursor)) return false;
    cursor = cursor.parent;
  }
  return false;
}
