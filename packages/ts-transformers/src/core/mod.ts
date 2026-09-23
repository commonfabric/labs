/**
 * Cross-transformer communication state.
 *
 * `CrossStageState` (cross-stage-state.ts) owns the pipeline's cross-transformer
 * channels. Each is keyed by AST node or symbol identity, which is preserved
 * when transformers are applied in sequence via ts.transform(). The channels are
 * organized into three families:
 *
 *   1. Bare cross-package maps — `typeRegistry`, `schemaHints`. The published
 *      boundary contract: the separate schema-generator package reads these
 *      directly as plain WeakMaps and must not depend on `CrossStageState` or
 *      `NodeTypeLinks`. They deliberately stay their own maps; see the
 *      "schema-generator boundary" note below.
 *   2. `nodeLinks` (WeakMap<ts.Node, NodeTypeLinks>) — a NodeLinks-shaped side
 *      table (mirroring the TS compiler's internal NodeLinks: one struct of
 *      optional derived facts per node, lazily populated) holding the
 *      transformer-internal, non-cache-invalidating per-node channels:
 *      `capabilitySummary` and `schemaInjected`. Reached only through the
 *      record/lookup/mark/is methods on CrossStageState.
 *   3. The marker family — node/symbol-keyed WeakSets whose context-level
 *      mutators are coupled to reactive-analysis cache invalidation
 *      (mapCallbackRegistry, syntheticComputeCallbackRegistry,
 *      syntheticComputeOwnedNodeRegistry, syntheticReactiveCollectionRegistry).
 *
 * (Former members no longer exist: `syntheticLiftAppliedCallRegistry`, removed
 * after being verified functionally inert (see
 * docs/scratch/12-registry-unification-design.md); and `narrowedWrapperTypeRegistry`,
 * removed in PR #3788 by detecting and short-circuiting the synthetic
 * capability-wrapper re-entry in schema-injection that was its sole consumer —
 * see the `nodeLinks.schemaInjected` entry below for the current idempotency
 * model.)
 *
 * TypeRegistry (WeakMap<ts.Node, ts.Type>)
 *   Preserves and recovers synthetic typing across the pipeline. Serves three
 *   distinct uses sharing one map:
 *   - (a) replacement expression nodes keep their original authored types
 *   - (b) synthetic TypeNodes keep faithful schema/codegen types
 *   - (c) synthetic call expressions keep their result types
 *
 *   WHY ONE MAP IS SAFE (and why we did NOT split it — registry-unification
 *   investigation, 2026-05, docs/scratch/12-registry-unification-design.md):
 *   the three uses are isolated by KEY NODE-KIND, not by separate maps. A
 *   use-(a) key is always a replacement Expression/Identifier, a use-(b) key
 *   is always a ts.TypeNode, a use-(c) key is always a ts.CallExpression.
 *   These node-kinds never coincide for the same ts.Node, so a reader that
 *   looks up one kind of key can never retrieve another use's value. In
 *   particular the schema-generator package reads ONLY TypeNode keys (verified
 *   exhaustively: every .get/.has there keys on member.type, elementType,
 *   innerTypeNode, etc.), so it can only ever see use-(b) entries. Splitting
 *   into three physical maps would make this isolation explicit but fixes no
 *   reachable bug, while adding churn the reads can't even exploit (the shared
 *   read helpers — getTypeAtLocationWithFallback, ensureTypeNodeRegistered —
 *   are node-kind-agnostic and would have to consult all three anyway).
 *   Writers: closure strategies, builtins/lift-applied, expression rewrites,
 *            type-building/schema-factory/type-shrinking, schema-injection
 *   Readers: lift-lowering transformer, schema-generator, type-inference,
 *            ast/utils, schema-injection, capability/type-shrinking logic
 *
 * mapCallbackRegistry (WeakSet<ts.Node>)
 *   Marks arrow functions created by ClosureTransformer as array method callbacks.
 *   Writers: context.markAsArrayMethodCallback() (called by array-method-strategy)
 *   Readers: context.isArrayMethodCallback() (called by pattern-callback lowering,
 *            reactive-context classifier)
 *
 * syntheticComputeCallbackRegistry (WeakSet<ts.Node>)
 *   Marks callbacks introduced by synthetic compute wrappers (e.g. JSX branch
 *   wrapping) so later phases can treat reused authored nodes as compute-owned.
 *   Writers: context.markAsSyntheticComputeCallback() (called by expression-rewrite/rewrite-helpers)
 *   Readers: context.isSyntheticComputeCallback() (called by reactive-context classifier)
 *
 * syntheticComputeOwnedNodeRegistry (WeakSet<ts.Node>)
 *   Marks authored subtrees that have been moved under a synthetic compute
 *   wrapper so later phases can override stale source-context classification.
 *   Writers: context.markSyntheticComputeOwnedSubtree() (called by expression-rewrite/rewrite-helpers)
 *   Readers: context.isSyntheticComputeOwnedNode() (called by reactive-context classifier)
 *
 * syntheticReactiveCollectionRegistry (WeakSet<ts.Symbol>)
 *   Records symbols of variable declarations that hold collections synthesized
 *   by the transformer (e.g., the result of __cfHelpers.lift(...)(captures)
 *   bound to a const). Used by call-kind detection to distinguish synthetic
 *   collections from user-authored ones. Note: keys by ts.Symbol, not ts.Node.
 *   Writers: context.markSyntheticReactiveCollectionDeclaration()
 *            (called by reactive-variable-for transformer)
 *   Readers: ast/call-kind.ts, closures/strategies/array-method-policy.ts
 *
 * SchemaHints (WeakMap<ts.Node, SchemaHint>)
 *   Overrides default schema generation behavior (e.g., array items: false).
 *   Writers: capture analysis in schema-injection
 *   Readers: schema-generator
 *
 * nodeLinks.capabilitySummary (NodeTypeLinks field; was CapabilitySummaryRegistry)
 *   Caches per-function capability summaries (read/write paths, capability
 *   classification) computed by PatternCallbackLoweringTransformer. Internal
 *   only — never crosses the schema-generator boundary; reached through the
 *   record/lookup methods, never as a raw map (the bare-map channel was retired
 *   in step 5 — schema-injection no longer threads a `capabilityRegistry`
 *   parameter, it reads via context.lookupCapabilitySummary()).
 *   Writers: context.recordCapabilitySummary() (pattern-callback lowering)
 *   Readers: context.lookupCapabilitySummary() (schema-injection
 *            findCapabilitySummaryForParameter)
 *
 * nodeLinks.schemaInjected (NodeTypeLinks field; was schemaInjectedRegistry)
 *   Marks builder call/new nodes that SchemaInjection has already finalized.
 *   The single top-of-visit guard in SchemaInjectionTransformer skips
 *   re-processing a marked node (descending only into its children to reach
 *   callback bodies). Replaces the scattered per-builder arg-count idempotency
 *   guards (`args.length >= 5`, the implicit "drop the type args so
 *   re-detection fails" trick, etc.) with one explicit signal, and plugs the
 *   lift `isToSchemaCall` branch's missing idempotency guard — eliminating the
 *   redundant self-re-entry re-narrowing that CT-1621 targeted. NOTE: this
 *   marks SYNTHETIC nodes we produce; unlike the marker family it uses a plain
 *   presence check (no getOriginalNode fallback) because a marked node's
 *   original is the *pre-injection* user call, which must NOT read as injected.
 *   That no-fallback semantics is WHY it is a nodeLinks field and not a member
 *   of the getOriginalNode-fallback marker family.
 *   Some arg-count guards remain DELIBERATELY: the cell-factory/wish `>= 2`
 *   checks also protect USER-supplied schemas (which this marker can't cover),
 *   and the `!== 2`/`!== 3` checks are dispatch (input-shape) guards, not
 *   idempotency.
 *   Writers: context.markSchemaInjected() (SchemaInjection producer sites)
 *   Readers: context.isSchemaInjected() (SchemaInjection top-of-visit guard)
 *
 * --- schema-generator boundary ---
 *
 * `typeRegistry` and `schemaHints` are the ONLY channels read by the separate
 * schema-generator package (not a transformer stage). It receives them as bare
 * `WeakMap<ts.Node, …>` instances and calls only `.get`/`.has` on them; it must
 * NOT learn about `CrossStageState` or `NodeTypeLinks`. They therefore stay as
 * their own maps rather than folding into `nodeLinks` — adapter "views" cast
 * across the package line would re-introduce the very maps they claim to remove,
 * for zero structural win, and would lie to the typechecker at the boundary.
 * This mirrors the TS compiler, which keeps its NodeLinks table private and
 * exposes narrow typed accessors (getTypeAtLocation) instead of the table. The
 * bare boundary maps are our analog of that narrow published contract.
 *
 * --- Cache invalidation contract ---
 *
 * The four context.mark* methods on TransformationContext (for
 * mapCallbackRegistry, syntheticComputeCallbackRegistry,
 * syntheticComputeOwnedNodeRegistry, syntheticReactiveCollectionRegistry)
 * each mutate their registry and then call invalidateReactiveAnalysisCaches().
 * That helper drops three things: the wrapper-level caches
 * (#reactiveContextCache, #relevantDataFlowCache) and the dataflow analyzer
 * instance itself (#dataFlowAnalyzer). Dropping the analyzer instance is
 * critical: the analyzer's internal per-expression cache
 * (createDataFlowAnalyzer's `analysisCache`) lives inside its closure and
 * would otherwise return stale pre-mutation verdicts after a registry write.
 *
 * schemaHints and the nodeLinks fields (capabilitySummary, schemaInjected) are
 * accessed through record/lookup/mark/is methods (recordSchemaHint/
 * lookupSchemaHint, recordCapabilitySummary/lookupCapabilitySummary,
 * markSchemaInjected/isSchemaInjected) but do not invalidate caches (no analysis
 * cache depends on them). typeRegistry is still mutated via direct .set() at call
 * sites; same caveat applies. If you add a cache that depends on any of these,
 * route the mutation through a method that invalidates it (or extend
 * invalidateReactiveAnalysisCaches).
 *
 * If you add a new context-level cache or registry, mutate it through a
 * mark* method that calls invalidateReactiveAnalysisCaches() (or extend the
 * helper to also drop your new cache). If you add a new analyzer-side cache
 * inside createDataFlowAnalyzer, no extra wiring is needed — the whole
 * analyzer instance is dropped together, so any state captured in its
 * closure is GC'd.
 *
 * --- Registry unification (complete, 2026-06) ---
 *
 * This registry layer was consolidated into the CrossStageState abstraction.
 * The plan and rationale live in
 * `docs/scratch/12-registry-unification-design.md` (supersedes the earlier
 * audit in `07-registry-audit.md`). Sequence:
 *   1. (done) doc refresh: count fix + mark the inert registry.
 *   2. (done — NO-OP, by investigation) Splitting typeRegistry into three
 *      maps was on the plan, but the split fixes no reachable bug: the three
 *      uses are already isolated by key node-kind (see the TypeRegistry note
 *      above). The one real CT-1615 cross-consumer hazard (schema generator vs.
 *      schema injection needing different types for a synthetic wrapper node)
 *      was retired in CT-1621: PR #3716 added the `schemaInjectedRegistry`
 *      marker that catches re-entries on nodes whose mark survived. PR #3788
 *      then closed the residual case — synthetic capability-wrapper re-entries
 *      whose mark did not survive — by detecting them structurally
 *      (`argumentType.pos < 0 && isCellLikeTypeNode(argumentType)`) and
 *      short-circuiting the re-shrink, which left the channel without a
 *      consumer and let `narrowedWrapperTypeRegistry` be deleted entirely.
 *   3. (done) Lifted schemaHints + capabilitySummary to context record/lookup
 *      methods. typeRegistry stays on direct .set (its split was dropped in
 *      step 2, so there's no per-use method to route through).
 *   4. (done) Removed syntheticLiftAppliedCallRegistry (verified inert).
 *   5. (done) Folded the transformer-internal, non-cache-invalidating per-node
 *      channels (capabilitySummary, schemaInjected) into a single NodeLinks-
 *      shaped `nodeLinks` WeakMap, reached only through methods. As part of this
 *      the `capabilityRegistry` bare-map parameter that schema-injection threaded
 *      through ~14 functions was removed — reads now go through
 *      context.lookupCapabilitySummary(), and the `CapabilitySummaryRegistry`
 *      type was retired. typeRegistry + schemaHints intentionally stay as bare
 *      maps at the schema-generator boundary (see the "schema-generator boundary"
 *      note above), so no CrossStageState/NodeTypeLinks type crosses into
 *      schema-generator. Research (CT-1621 arc) confirmed this matches how the TS
 *      compiler itself structures NodeLinks: one private per-node struct, narrow
 *      public accessors, the table never handed out.
 */

export { TransformationContext } from "./context.ts";
export { CrossStageState } from "./cross-stage-state.ts";
export type {
  BuilderSourceSiteOptions,
  CapabilityParamDefault,
  CapabilityParamSummary,
  DiagnosticInput,
  DiagnosticSeverity,
  FunctionCapabilitySummary,
  PatternCoverageKind,
  PatternCoverageOptions,
  PatternCoverageSpan,
  ReactiveCapability,
  SchemaHint,
  SchemaHints,
  TransformationDiagnostic,
  TransformationOptions,
  TypeRegistry,
  UnreadableCellArgument,
} from "./transformers.ts";
export type {
  BuilderSourceSite,
  BuilderSourceSitesV1,
} from "./runtime-contract.ts";
export { isBuilderSourceSitesV1 } from "./runtime-contract.ts";
export {
  HelpersOnlyTransformer,
  PATTERN_COVERAGE_GLOBAL,
  Transformer,
} from "./transformers.ts";
export {
  CF_HELPERS_IDENTIFIER,
  CFHelpers,
  injectCfHelpers,
  isLegacyInjectedEnvelope,
  transformCfDirective,
} from "./cf-helpers.ts";
