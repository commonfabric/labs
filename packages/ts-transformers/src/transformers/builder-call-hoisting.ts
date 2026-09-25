import ts from "typescript";
import {
  detectCallKind,
  getHandlerAppliedInnerCall,
  getLiftAppliedInnerCall,
  getPatternToolHoistablePatternCall,
  getWithPatternHoistablePatternCall,
  isCallbackReference,
  isHandlerAppliedCall,
  resolveCallbackFunctionExpression,
  SYNTHETIC_HANDLER_HOIST_PREFIX,
  SYNTHETIC_LIFT_HOIST_PREFIX,
  SYNTHETIC_PATTERN_HOIST_PREFIX,
} from "../ast/call-kind.ts";
import { recoverAuthoredPosition } from "../ast/utils.ts";
import {
  type BuilderSourceSite,
  HelpersOnlyTransformer,
  TransformationContext,
} from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";

/**
 * Hoist every reactive *builder call* to module scope: `lift` (CT-1644, Phase 2
 * of derive→lift→selfcontained), then `handler` and `pattern` (CT-1655). Each
 * becomes a named, addressable, eventually-selfcontainable module-scope const —
 * the substrate Phase 3 wraps with `selfcontained(...)`. (Formerly named
 * `LiftHoistingTransformer` / `lift-hoisting.ts`, when it only owned lift.)
 *
 * The hoist mechanic differs by builder shape; see {@link HOISTABLE_BUILDERS}.
 * For the original lift case: after Phase 1 (CT-1615) and SchemaInjection, every
 * reactive lift-style computation in lowered output is the schema-injected
 * *lift-applied* shape:
 *
 * ```ts
 *   __cfHelpers.lift(argSchema, resSchema, callback)(captures).for("result", true)
 * ```
 *
 * where the inner `__cfHelpers.lift(...)` call builds the module factory and
 * the outer application supplies the captures object. This stage hoists the
 * **entire inner call** (schemas + callback) to a module-scope const and
 * rewrites the original site to apply the captures to the hoisted name:
 *
 * ```ts
 *   // module scope:
 *   const __cfLift_1 = __cfHelpers.lift(argSchema, resSchema, callback);
 *   // original site:
 *   __cfLift_1(captures).for("result", true)
 * ```
 *
 * ## Why this runs AFTER SchemaInjection
 *
 * SchemaInjection derives the lift's ARGUMENT schema from the applied captures
 * object (`call.arguments[0]` of the outer application) — the closure
 * transformer assembled that object's full type upstream. If the lift were
 * hoisted to a bare `const __cfLift_N = lift(callback)` BEFORE injection, the
 * captures object would no longer be adjacent and injection would fall back to
 * the callback's parameter type alone — which silently drops capture
 * properties in nested / multi-capture callbacks (verified regression; see
 * `session_outputs/2026-06-02_lift-hoist-phase2/02-ordering-correction.md`).
 * Running after injection means the schema is already baked into the inner
 * `lift(...)` call before we relocate it, so the hoist is schema-transparent.
 *
 * Result: every reactive computation is a named, addressable module-scope
 * const — the substrate Phase 3 wraps with `selfcontained(...)`.
 *
 * ## The sole module-scope hoisting phase (CT-1585 subsumed)
 *
 * CT-1585 originally had a separate `BuilderCallbackHoistingTransformer` that
 * hoisted builder *callbacks* (the function argument) when the callback closed
 * solely over module-level symbols. That mechanic was redundant and actively
 * harmful once a builder's whole call is hoisted here: hoisting the call AND the
 * callback produced a double hoist whose two consts referenced each other out
 * of declaration order (TDZ `ReferenceError` at module load). As each builder
 * gained whole-call hoisting — `lift` (CT-1644), then `handler`, `pattern`, and
 * `patternTool` (CT-1655) — it was removed from CT-1585's set; with the set
 * emptied, `BuilderCallbackHoistingTransformer` was deleted. This stage is now
 * the single module-scope hoisting phase.
 *
 * ## Generality
 *
 * The hoist mechanic is builder-agnostic: only "which call expression is the
 * hoistable unit", "how the original site references the hoisted name", and
 * "what name prefix to bind it to" are builder-specific. Those live in
 * {@link HOISTABLE_BUILDERS}. Two shapes are registered:
 *   - applied builders (`lift`, `handler`): `builder(...)(captures)` — hoist the
 *     inner call, leave `name(captures)` (the default callee-swap rewrite);
 *   - argument-position builders (`pattern`): the bare `pattern(...)` sits in
 *     argument 0 of an enclosing `*WithPattern` or `patternTool` call — hoist it
 *     and rewrite that argument (via {@link HoistableBuilderSpec.rewriteSite}).
 */
export class BuilderCallHoistingTransformer extends HelpersOnlyTransformer {
  override transform(context: TransformationContext): ts.SourceFile {
    return hoistBuilderCalls(context.sourceFile, context);
  }
}

/**
 * A hoistable builder: given a visited call expression, decide whether it is
 * this builder's hoistable unit and, if so, return the inner call to relocate
 * to module scope plus the name prefix to bind it under.
 *
 * `innerCall` is the expression bound to `const <prefix>_N`. How the original
 * site is rewritten to reference that name depends on the builder shape:
 *
 *   - **Applied builders** (`lift`/`handler`): the visited call IS the inner
 *     call applied to captures — `inner(captures)`. The default rewrite swaps
 *     the callee for the hoisted name, leaving the captures arguments and any
 *     surrounding member chain (e.g. the `.for(...)` tail) anchored in place.
 *   - **Argument-position builders** (`pattern`/`patternTool`): the visited
 *     call is the *enclosing* `mapWithPattern` call and the inner pattern call
 *     sits in one of its arguments. The default callee-swap is wrong here — the
 *     callee (`.mapWithPattern`) and the other arguments must survive untouched.
 *     Such builders provide {@link rewriteSite} to replace just the argument
 *     that held the inner call with the hoisted name.
 */
interface HoistableBuilderSpec {
  readonly prefix: string;
  readonly resolveHoistable: (
    call: ts.CallExpression,
    context: TransformationContext,
  ) => ts.CallExpression | undefined;

  /**
   * Optional: produce the replacement for the visited site once the inner call
   * has been hoisted to `hoistedName`. Omit for applied builders, which take
   * the default callee-swap. Provide it when the inner call sits in an argument
   * position (the visited call is an enclosing call whose callee must survive).
   */
  readonly rewriteSite?: (
    visited: ts.CallExpression,
    hoistedName: ts.Identifier,
    innerCall: ts.CallExpression,
    factory: ts.NodeFactory,
  ) => ts.Expression;
}

const LIFT_BUILDER: HoistableBuilderSpec = {
  prefix: SYNTHETIC_LIFT_HOIST_PREFIX,
  resolveHoistable: (call, context) => {
    // The lift-applied shape is `__cfHelpers.lift(...)(captures)`: an applied
    // call whose callee is itself the inner `lift(...)` call. detectCallKind
    // is the single source of truth for recognizing it (it guards against
    // over-application chains like `lift(cb)(x)(y)`).
    if (detectCallKind(call, context.checker)?.kind !== "lift-applied") {
      return undefined;
    }
    return getLiftAppliedInnerCall(call);
  },
};

const HANDLER_BUILDER: HoistableBuilderSpec = {
  prefix: SYNTHETIC_HANDLER_HOIST_PREFIX,
  resolveHoistable: (call, context) => {
    // The handler-applied shape is
    // `__cfHelpers.handler(eventSchema, stateSchema, cb)(captures)` —
    // structurally the same single-application unit as lift, so the same hoist
    // mechanic applies: relocate the inner `handler(...)` call, leave
    // `__cfHandler_N(captures)` at the site (the `.for(...)` tail stays
    // anchored on the outer call). Unlike lift this is NOT a `lift-applied`
    // CallKind — `isHandlerAppliedCall` recognizes it while keeping the applied
    // call classifying as `{ kind: "builder", builderName: "handler" }`, so
    // handler-specific downstream dispatchers are untouched (CT-1655).
    if (!isHandlerAppliedCall(call, context.checker)) {
      return undefined;
    }
    return getHandlerAppliedInnerCall(call);
  },
};

const PATTERN_BUILDER: HoistableBuilderSpec = {
  prefix: SYNTHETIC_PATTERN_HOIST_PREFIX,
  resolveHoistable: (call, context) => {
    // Pattern is NOT applied: the bare `__cfHelpers.pattern(cb, inSchema,
    // outSchema)` call sits in the FIRST argument of an enclosing call, with
    // per-instance values flowing through that call's remaining argument(s).
    // Two enclosing shapes carry a hoistable pattern (identical mechanic —
    // relocate argument 0, keep the rest):
    //   - `receiver.mapWithPattern(pattern(...), { params })` (and the other
    //     lowered `*WithPattern` array methods); captures in the params object.
    //   - `patternTool(pattern(...), extraParams?)` (CT-1655); per-instance
    //     values in extraParams, module-scoped reads absorbed by the pattern.
    // In both, the bare pattern call is capture-free and safe to relocate. The
    // top-level `export default pattern(...)` is a direct call (not an argument
    // to either), so it is naturally excluded.
    return getWithPatternHoistablePatternCall(call, context.checker) ??
      getPatternToolHoistablePatternCall(call, context.checker);
  },
  rewriteSite: (visited, hoistedName, _innerCall, factory) => {
    // Replace ONLY the first argument (the pattern call) with the hoisted name,
    // keeping the enclosing call's callee (`.mapWithPattern` / `patternTool`)
    // and the trailing argument(s) intact. (Applied builders take the default
    // callee-swap instead.)
    return factory.updateCallExpression(
      visited,
      visited.expression,
      visited.typeArguments,
      [hoistedName, ...visited.arguments.slice(1)],
    );
  },
};

const HOISTABLE_BUILDERS: readonly HoistableBuilderSpec[] = [
  LIFT_BUILDER,
  HANDLER_BUILDER,
  PATTERN_BUILDER,
];

/**
 * Marker that keeps the content-addressed hoist namespace (`__cfPattern_h…`)
 * disjoint from the positional alias namespace (`__cfPattern_<n>`): a hash
 * suffix always starts with this letter, a positional alias never does, so a
 * recognizer can classify a symbol by shape alone and a hex digest that
 * happens to be all-numeric can never be mistaken for an alias.
 */
const HOIST_HASH_MARKER = "h";

/** Hex digits kept from the 64-bit digest: 48 bits, far past birthday range
 * for the handful of hoists a single file mints. */
const HOIST_HASH_LENGTH = 12;

/**
 * FNV-1a over the canonical print of a hoisted call, 64-bit.
 *
 * FROZEN. A hoist's content suffix is the durable half of the
 * `{ identity, symbol }` reference deployed pieces store for their mapped
 * sub-patterns (CT-1623), so this function and its input are part of the
 * stored-data contract: changing either re-keys every hoist in the tree.
 * The positional aliases keep OLD pointers loadable through such a change
 * (a frozen source reproduces its visit order under any toolchain), but new
 * correlation would churn fleet-wide — do not "improve" this hash.
 */
function fnv1a64(text: string): bigint {
  const prime = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

/** `h` + the first {@link HOIST_HASH_LENGTH} hex chars of the digest. */
function hoistContentSuffix(printedInnerCall: string): string {
  const digest = fnv1a64(printedInnerCall)
    .toString(16)
    .padStart(16, "0")
    .slice(0, HOIST_HASH_LENGTH);
  return `${HOIST_HASH_MARKER}${digest}`;
}

function hoistBuilderCalls(
  sourceFile: ts.SourceFile,
  context: TransformationContext,
): ts.SourceFile {
  const factory = context.factory;
  const inputSourceFile = context.program.getSourceFile(sourceFile.fileName);
  const builderSourceSites = Object.create(null) as Record<
    string,
    BuilderSourceSite
  >;

  const recordBuilderSourceSite = (
    symbol: string,
    artifact: BuilderArtifact | undefined,
  ): void => {
    const mapSite = context.options.builderSourceSites?.mapSite;
    if (
      mapSite === undefined || artifact === undefined ||
      Object.hasOwn(builderSourceSites, symbol)
    ) {
      return;
    }
    const site = resolveCompilerInputSite(artifact, inputSourceFile);
    if (site === undefined) return;
    // `mapSite` is what turns compiler-input coordinates into authored ones.
    const mapped = mapSite(sourceFile.fileName, site);
    if (mapped !== undefined) builderSourceSites[symbol] = mapped;
  };

  // Hoisted consts produced while visiting the CURRENT top-level statement.
  // They are flushed immediately before that statement (see below), not pooled
  // into a single after-imports block. This keeps each hoisted const *after*
  // every module-scoped binding declared in an earlier top-level statement —
  // which the original use site necessarily followed, since you cannot
  // reference a binding before its declaration in valid source. That ordering
  // matters because `pattern(...)` INVOKES its callback eagerly at construction
  // (unlike `lift`/`handler`, whose callbacks are stored and run lazily): a
  // hoisted `const __cfPattern_N = pattern(cb)` whose `cb` reads a later
  // module-scoped `const onRemoveFavorite = handler(...)` would otherwise throw
  // a module-load TDZ `ReferenceError`. (Verified against
  // patterns/system/favorites-manager.tsx; the after-imports placement that is
  // safe for lift/handler is NOT safe for pattern.)
  let pendingHoists: ts.Statement[] = [];

  // Each hoist gets TWO names, and the split is load-bearing:
  //
  //   - a CANONICAL name, `<prefix>_h<digest>` — the digest of the inner
  //     call's canonical (comment-stripped) print. Content-addressed, so
  //     inserting, removing, or reordering OTHER hoists cannot re-key an
  //     existing one; it re-keys only when its own callback or baked schemas
  //     change, which is when its contract genuinely changed. The hoisted
  //     const is bound under this name, call sites reference it, and it is
  //     the symbol NEW `{ identity, symbol }` references serialize under.
  //   - a POSITIONAL ALIAS, `<prefix>_<n>` in visit order — the historical
  //     numbering. Registered alongside the canonical name (never bound, never
  //     referenced by emitted code) so every `{ identity, symbol }` pointer a
  //     deployed piece stored under the old numeric scheme keeps resolving:
  //     by-identity cold loads recompile the OLD source with the CURRENT
  //     toolchain, and a frozen source reproduces its visit order exactly.
  //     Permanent, not transitional — the aliases are what make the stored
  //     archive immortal under toolchain change.
  //
  // Both are explicit literal names (NOT `factory.createUniqueName`, whose
  // `.text` carries only the bare prefix and defers numeric suffixing to emit —
  // so every hoisted identifier would share the same `.text`, breaking the
  // identity-by-text lookups later stages rely on to match a hoist call site
  // back to its hoisted const).
  const counters = new Map<string, number>();
  // Occurrences per canonical base name: identical twins (same builder, same
  // printed content) share a digest, so the second onward takes an occurrence
  // ordinal (`…_2`). Twins mint identical graphs, so even a cross-twin
  // correlation is content-correct; the ordinal only keeps registration keys
  // unique, deterministically.
  const hashOccurrences = new Map<string, number>();
  // Canonical print of a hoisted call for hashing: comments stripped (a
  // comment edit must not re-key) and line endings pinned (the digest must not
  // vary by platform). Runs after schema injection, so the print covers the
  // callback AND its baked schemas — a type-level change re-keys, which is
  // aligned: the sub-pattern's contract changed.
  const hoistPrinter = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  });

  // Every hoisted builder-artifact CANONICAL name plus every authored
  // non-exported builder const, in creation order. After the whole file is
  // visited we emit a SINGLE trailing
  // `__cfReg({ __cfPattern_h…, …, __cfPattern_1: __cfPattern_h…, … })` call so
  // the runtime can assign each a content-addressed `{ identity, symbol }`
  // reference (the property key is the symbol). Canonical entries come FIRST:
  // the runtime's forward value→ref map is first-write-wins, so ordering is
  // what makes new serializations canonical-hash while the positional aliases
  // (appended after) quietly serve pointers stored under the old numbering.
  // A single trailing call — rather than exporting each hoist or registering
  // it inline — keeps the verifier's job to "exactly one top-level `__cfReg`
  // call" and lets a run-once trap reject any injected duplicate. See
  // PatternManager.registerHoistedValues / the `__cfReg` factory parameter
  // wired up by the module-record compiler.
  const registeredNames: string[] = [];
  const hoistAliases: { alias: string; canonical: string }[] = [];
  const exportedSymbolsByLocalName = collectExportedLocalSymbols(sourceFile);

  const visit: ts.Visitor = (node: ts.Node): ts.Node => {
    const visited = ts.visitEachChild(node, visit, context.tsContext);
    if (!ts.isCallExpression(visited)) {
      return visited;
    }

    for (const builder of HOISTABLE_BUILDERS) {
      const innerCall = builder.resolveHoistable(visited, context);
      if (!innerCall) {
        continue;
      }

      // Positional alias: the historical visit-order numbering (see the
      // counter block above for why it is registered but never bound).
      const next = (counters.get(builder.prefix) ?? 0) + 1;
      counters.set(builder.prefix, next);
      const aliasText = `${builder.prefix}_${next}`;
      // Canonical name: content digest of the inner call's canonical print,
      // plus an occurrence ordinal when an identical twin already minted it.
      const printed = hoistPrinter
        .printNode(ts.EmitHint.Expression, innerCall, sourceFile)
        .replace(/\r\n/g, "\n");
      const baseName = `${builder.prefix}_${hoistContentSuffix(printed)}`;
      const occurrence = (hashOccurrences.get(baseName) ?? 0) + 1;
      hashOccurrences.set(baseName, occurrence);
      const nameText = occurrence === 1
        ? baseName
        : `${baseName}_${occurrence}`;
      const name = factory.createIdentifier(nameText);
      registeredNames.push(nameText);
      hoistAliases.push({ alias: aliasText, canonical: nameText });
      recordBuilderSourceSite(
        nameText,
        resolveBuilderArtifact(innerCall, context.checker),
      );
      // Carry the hoisted call's identity on the synthetic call-site identifier.
      // The checker can't resolve a synthetic identifier to its const
      // initializer, so detectCallKind would otherwise fail to recognize
      // `__cfLift_N(captures)` as the lift-applied reactive origin it lowers
      // from — dropping e.g. the `.for(...)` tag ReactiveVariableFor attaches.
      // Pointing the identifier's original node at the inner lift call lets the
      // builder-kind resolver (`resolveBuilderExpressionKind`) fall back through
      // it and still classify `__cfLift_N(captures)` as lift-applied.
      ts.setOriginalNode(name, innerCall);

      // const <prefix>_N = <inner lift(...) call>;
      pendingHoists.push(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                name,
                undefined,
                undefined,
                innerCall,
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
      );

      // Rewrite the site to reference the hoisted name. Applied builders take
      // the default callee-swap: reuse the visited outer call's own node
      // identity (updateCallExpression) so any surrounding member chain —
      // notably the `.for(...)` tail that ReactiveVariableForTransformer later
      // expects on the result — stays anchored to the same position.
      // Argument-position builders (pattern/patternTool) override via
      // `rewriteSite` to replace just the argument that held the inner call.
      if (builder.rewriteSite) {
        return builder.rewriteSite(visited, name, innerCall, factory);
      }
      return factory.updateCallExpression(
        visited,
        name,
        visited.typeArguments,
        visited.arguments,
      );
    }

    return visited;
  };

  // Visit each top-level statement, flushing the hoists it produced immediately
  // BEFORE it. A statement's hoisted consts are placed after every preceding
  // top-level statement — and therefore after every module-scoped binding the
  // hoisted (eagerly-run) pattern callbacks reference, since those bindings had
  // to precede the original use site. Among hoists from the same statement,
  // post-order traversal already pushed inner/earlier calls first, so a hoist
  // that references another hoist (e.g. `__cfPattern` whose callback calls
  // `__cfLift`) sees it declared above.
  // Local names that leave the module through ANY export form — `export const`,
  // `export { x }` / `export { x as y }`, `export default x`. Such artifacts are
  // addressable through the module namespace by their export name, so they are
  // NOT also routed through `__cfReg` (and `export const` has no local binding
  // after CommonJS emit anyway). `__cfReg` covers exactly the gap: hoists and
  // non-exported top-level builder consts.
  const resultStatements: ts.Statement[] = [];
  for (const statement of sourceFile.statements) {
    // Also register AUTHORED non-exported top-level builder artifacts
    // (`const foo = lift(...)`), so `__cfReg` covers every top-level builder
    // artifact that does not reach the namespace. Detect on the ORIGINAL
    // statement (the checker resolves real, not synthetic, nodes). Only a direct
    // builder CALL counts, so an import/alias (`const x = imported`) — whose value
    // belongs to another module — is never mis-attributed to this identity.
    collectTopLevelBuilderArtifacts(
      statement,
      context,
      exportedSymbolsByLocalName,
      registeredNames,
      recordBuilderSourceSite,
    );
    collectDefaultExportBuilderArtifact(
      statement,
      context.checker,
      recordBuilderSourceSite,
    );
    pendingHoists = [];
    const visitedStatement = ts.visitNode(statement, visit) as ts.Statement;
    resultStatements.push(...pendingHoists, visitedStatement);
  }

  // Register every hoisted builder artifact with one trailing call. `__cfReg` is
  // a free identifier supplied by the module wrapper (its 4th factory parameter,
  // which shadows a no-op compartment global). The object uses
  // shorthand so each value is the module-level `const` binding itself — the
  // registrar receives `{ symbol -> live value }` and the runtime pairs it with
  // this module's content identity. Emitted only when there is something to
  // register, so hoist-free modules are unchanged.
  if (registeredNames.length > 0) {
    resultStatements.push(
      factory.createExpressionStatement(
        factory.createCallExpression(
          factory.createIdentifier("__cfReg"),
          undefined,
          [
            factory.createObjectLiteralExpression(
              [
                // Canonical entries first — the runtime's forward value→ref
                // map is first-write-wins, so this ordering is what stamps
                // NEW serializations with the canonical hash symbol.
                ...registeredNames.map((n) =>
                  factory.createShorthandPropertyAssignment(
                    factory.createIdentifier(n),
                  )
                ),
                // Positional aliases after: same live values under the
                // visit-order numeric names, serving every `{identity,symbol}`
                // pointer stored under the historical numbering.
                ...hoistAliases.map(({ alias, canonical }) =>
                  factory.createPropertyAssignment(
                    factory.createIdentifier(alias),
                    factory.createIdentifier(canonical),
                  )
                ),
              ],
              true,
            ),
          ],
        ),
      ),
    );
  }

  if (Object.keys(builderSourceSites).length > 0) {
    context.state.recordBuilderSourceSites(sourceFile.fileName, {
      formatVersion: 1,
      sites: builderSourceSites,
    });
  }

  return factory.updateSourceFile(sourceFile, resultStatements);
}

/**
 * Collect the names of top-level `const`/`let`/`var` declarations whose
 * initializer is a direct builder CALL (`pattern(...)`, `lift(...)`,
 * `handler(...)`, `computed(...)`, …) — i.e. authored module-scope builder
 * artifacts. These are added to the module's `__cfReg({ … })` registration so
 * they receive a content-addressed `{ identity, symbol }` reference (symbol = the
 * binding name), exactly like the synthetic hoists.
 *
 * Requiring a builder call (via `detectCallKind`) means a re-export / alias
 * (`const x = imported`) — whose value belongs to ANOTHER module — is never
 * registered here, so identity is never mis-attributed. Non-artifact builders are
 * harmlessly trust-filtered at registration time. Destructuring is skipped.
 *
 * An exported name is omitted from `__cfReg`: it leaves through the namespace
 * under every symbol in `exportedSymbolsByLocalName`. `__cfReg` covers exactly
 * the remaining gap — hoists and non-exported top-level builder consts.
 */
function collectTopLevelBuilderArtifacts(
  statement: ts.Statement,
  context: TransformationContext,
  exportedSymbolsByLocalName: ReadonlyMap<string, readonly string[]>,
  out: string[],
  recordSourceSite: (
    symbol: string,
    artifact: BuilderArtifact | undefined,
  ) => void,
): void {
  if (!ts.isVariableStatement(statement)) return;
  for (const decl of statement.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name)) continue;
    // Unwrap `as` / `satisfies` / parenthesized / type-assertion wrappers before
    // the call check: a cast-typed builder const (`const x = handler(...) as
    // XFactory`) has an AsExpression initializer, not a CallExpression. Without
    // this it is silently excluded from `__cfReg`, so a non-exported handler/lift
    // gets no content-addressed provenance and falls to the SES-source fallback at
    // resolve time — `navigateTo`/SubPattern imports then read undefined (CT-1743).
    const init = decl.initializer
      ? unwrapTypeWrappers(decl.initializer)
      : undefined;
    if (!init || !ts.isCallExpression(init)) continue;
    if (detectCallKind(init, context.checker)?.kind !== "builder") continue;
    const exportSymbols = exportedSymbolsByLocalName.get(decl.name.text);
    const runtimeSymbols = exportSymbols ?? [decl.name.text];
    if (exportSymbols === undefined) out.push(decl.name.text);
    const artifact = resolveBuilderArtifact(init, context.checker);
    for (const symbol of runtimeSymbols) recordSourceSite(symbol, artifact);
  }
}

/** Strip the transparent wrapper set to reach the underlying
 * builder/identifier expression. Used both for `export default x` recognition
 * and for top-level `const foo = handler(...) as XFactory` registration —
 * without unwrapping, a wrapped builder const is excluded from `__cfReg`, loses
 * content-addressed provenance, and falls to the SES fallback at resolve time
 * (CT-1743). Reading the shared set is what keeps that true of every spelling
 * rather than of the casts alone. */
function unwrapTypeWrappers(expr: ts.Expression): ts.Expression {
  return unwrapExpression(expr);
}

/**
 * Runtime export symbols for each local binding. The values both keep exported
 * artifacts out of `__cfReg` and key their debug sidecar entries exactly as the
 * engine's namespace walk encounters them.
 */
function collectExportedLocalSymbols(
  sourceFile: ts.SourceFile,
): Map<string, readonly string[]> {
  const symbols = new Map<string, string[]>();
  const add = (localName: string, exportName: string): void => {
    const names = symbols.get(localName) ?? [];
    if (!names.includes(exportName)) names.push(exportName);
    symbols.set(localName, names);
  };
  for (const statement of sourceFile.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) add(decl.name.text, decl.name.text);
      }
    } else if (
      ts.isExportDeclaration(statement) && !statement.moduleSpecifier &&
      statement.exportClause && ts.isNamedExports(statement.exportClause)
    ) {
      for (const el of statement.exportClause.elements) {
        add((el.propertyName ?? el.name).text, el.name.text);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expr = unwrapTypeWrappers(statement.expression);
      if (ts.isIdentifier(expr)) add(expr.text, "default");
    }
  }
  return symbols;
}

/** Records a direct function-bearing `export default <builder>(...)`. */
function collectDefaultExportBuilderArtifact(
  statement: ts.Statement,
  checker: ts.TypeChecker,
  recordSourceSite: (
    symbol: string,
    artifact: BuilderArtifact | undefined,
  ) => void,
): void {
  if (!ts.isExportAssignment(statement) || statement.isExportEquals) return;
  const expression = unwrapExpression(statement.expression);
  if (ts.isIdentifier(expression)) return;
  recordSourceSite("default", resolveBuilderArtifact(expression, checker));
}

/** A function-bearing builder call and its best same-file function anchor. */
interface BuilderArtifact {
  readonly call: ts.CallExpression;
  readonly fn?:
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.FunctionDeclaration;
}

/** Returns the function-bearing builder artifact denoted by `expression`. */
function resolveBuilderArtifact(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): BuilderArtifact | undefined {
  const call = unwrapExpression(expression);
  if (!ts.isCallExpression(call)) return undefined;
  if (detectCallKind(call, checker)?.kind !== "builder") return undefined;
  for (const argument of call.arguments) {
    const fn = resolveCallbackFunctionExpression(argument, checker);
    if (fn) return { call, fn };
    const declaration = resolveSameFileFunctionDeclaration(argument, checker);
    if (declaration) return { call, fn: declaration };
  }
  return call.arguments.some((argument) =>
      isCallbackReference(argument, checker)
    )
    ? { call }
    : undefined;
}

/** Returns the same-file function declaration named by `argument`. */
function resolveSameFileFunctionDeclaration(
  argument: ts.Expression,
  checker: ts.TypeChecker,
): ts.FunctionDeclaration | undefined {
  const target = unwrapExpression(argument);
  if (!ts.isIdentifier(target)) return undefined;
  const symbol = checker.getSymbolAtLocation(target);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isFunctionDeclaration(declaration)) return undefined;
  return declaration.getSourceFile().fileName ===
      target.getSourceFile().fileName
    ? declaration
    : undefined;
}

/**
 * Resolves one artifact's position and declaration name in COMPILER-INPUT
 * coordinates. The input carries the helper prelude the compiler injects, so
 * these line numbers are authored only once `mapSite` has normalized them; the
 * transformer records nothing without a mapper for exactly that reason.
 */
function resolveCompilerInputSite(
  artifact: BuilderArtifact,
  inputSourceFile: ts.SourceFile | undefined,
): BuilderSourceSite | undefined {
  if (!inputSourceFile) return undefined;
  const candidates = artifact.fn
    ? [artifact.fn, artifact.call]
    : [artifact.call];
  for (const candidate of candidates) {
    const range = recoverAuthoredPosition(candidate);
    if (!range) continue;
    const enclosing = findAuthoredNodeAt(inputSourceFile, range.pos);
    const start = enclosing?.node.getStart(inputSourceFile) ?? range.pos;
    const position = inputSourceFile.getLineAndCharacterOfPosition(
      start >= range.pos && start < range.end ? start : range.pos,
    );
    return {
      line: position.line + 1,
      col: position.character,
      ...(enclosing?.bindingName === undefined
        ? {}
        : { bindingName: enclosing.bindingName }),
    };
  }
  return undefined;
}

/** Finds the innermost authored node covering `pos` and its declaration name. */
function findAuthoredNodeAt(
  sourceFile: ts.SourceFile,
  pos: number,
): { node: ts.Node; bindingName: string | undefined } | undefined {
  let node: ts.Node = sourceFile;
  let bindingName: string | undefined;
  let found = false;

  for (;;) {
    const child = ts.forEachChild(
      node,
      (candidate) =>
        candidate.pos <= pos && pos < candidate.end ? candidate : undefined,
    );
    if (!child) break;
    if (ts.isFunctionLike(node)) bindingName = undefined;
    bindingName = authoredDeclarationName(child) ?? bindingName;
    node = child;
    found = true;
  }

  return found ? { node, bindingName } : undefined;
}

/** Returns the authored name introduced by a supported declaration node. */
function authoredDeclarationName(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  return undefined;
}
