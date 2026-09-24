import ts from "typescript";

import {
  classifyArrayMethodCall,
  detectCallKind,
  isSyntheticNode,
  type NormalizedDataFlow,
  preserveSourceMapRange,
  setParentPointers,
  typeToTypeNodeWithRegistry,
} from "../../ast/mod.ts";
import { isModuleScopedDeclaration } from "../../ast/scope-analysis.ts";
import { unwrapTransparentWrapperOnce } from "../../utils/expression.ts";
import { TransformationContext } from "../../core/mod.ts";
import { createLiftAppliedCall } from "../builtins/lift-applied.ts";

/**
 * True when `node` is the receiver an array-method call is made on, looking
 * through any transparent wrappers between the two: `xs`, `(xs)`, and
 * `(xs as T[])!` are all the receiver of `.map(...)`.
 *
 * The walk runs outward through parents and checks at each step that it is on
 * the wrapper's `expression` spine, so a node sitting in a wrapper's *type*
 * position is not mistaken for the value being wrapped.
 */
export function isArrayMethodReceiverExpression(node: ts.Node): boolean {
  let current: ts.Node = node;
  let parent = current.parent;
  while (parent) {
    const wrapped = unwrapTransparentWrapperOnce(parent);
    if (!wrapped) break;
    if (wrapped !== current) return false;
    current = parent;
    parent = parent.parent;
  }

  if (
    !parent ||
    (
      !ts.isPropertyAccessExpression(parent) &&
      !ts.isElementAccessExpression(parent)
    ) ||
    parent.expression !== current
  ) {
    return false;
  }

  const call = parent.parent;
  return !!call && ts.isCallExpression(call) && call.expression === parent &&
    !!classifyArrayMethodCall(call);
}

function getCaptureRootExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isCallExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isNestedFunctionLocalCapture(
  expression: ts.Expression,
  wrappedExpression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const wrappedSourceNode = !isSyntheticNode(wrappedExpression)
    ? wrappedExpression
    : ts.getOriginalNode(wrappedExpression);
  const root = getCaptureRootExpression(expression);
  if (!ts.isIdentifier(root)) {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(root);
  if (!symbol) {
    return false;
  }

  const declarations = symbol.getDeclarations() ?? [];
  return declarations.some((declaration) => {
    if (
      declaration.pos < wrappedSourceNode.pos ||
      declaration.end > wrappedSourceNode.end
    ) {
      return false;
    }

    let current: ts.Node | undefined = declaration.parent;
    while (current && current !== wrappedSourceNode) {
      if (ts.isFunctionLike(current)) {
        return true;
      }
      current = current.parent;
    }

    return false;
  });
}

export function createReactiveWrapperForExpression(
  expression: ts.Expression,
  relevantDataFlows: readonly NormalizedDataFlow[],
  context: TransformationContext,
  options: {
    allowDirectExpressionWrap?: boolean;
    preferInputBoundWrapper?: boolean;
    filterNestedFunctionLocalCaptures?: boolean;
    /** Known output type of a synthetic expression. */
    resultTypeNode?: ts.TypeNode;
  } = {},
): ts.Expression | undefined {
  const shouldFilterNestedLocals = options.filterNestedFunctionLocalCaptures ??
    !ts.isCallExpression(expression);

  const wrapperDataFlows = shouldFilterNestedLocals
    ? relevantDataFlows.filter((dataFlow) =>
      !isNestedFunctionLocalCapture(
        dataFlow.expression,
        expression,
        context.checker,
      )
    )
    : [...relevantDataFlows];

  if (wrapperDataFlows.length === 0) return undefined;

  // Don't wrap expressions that are already lift-applied, computed, when, or unless calls
  // These are already reactive and wrapping them would create unnecessary nesting
  if (ts.isCallExpression(expression)) {
    const callKind = detectCallKind(expression, context.checker);
    if (
      callKind?.kind === "lift-applied" ||
      callKind?.kind === "when" ||
      callKind?.kind === "unless" ||
      (callKind?.kind === "builder" && callKind.builderName === "computed")
    ) {
      return undefined;
    }
  }

  if (
    !options.allowDirectExpressionWrap &&
    wrapperDataFlows.length === 1
  ) {
    const [dataFlow] = wrapperDataFlows;
    if (dataFlow && dataFlow.expression === expression) {
      return undefined;
    }
  }

  if (options.preferInputBoundWrapper) {
    const refs = unionWithEnclosingScopeFreeIdentifiers(
      wrapperDataFlows.map((dataFlow) => dataFlow.expression),
      expression,
      context.checker,
    );
    return createLiftAppliedCall(expression, refs, {
      factory: context.factory,
      tsContext: context.tsContext,
      cfHelpers: context.cfHelpers,
      context,
      resultTypeNode: options.resultTypeNode,
    });
  }

  const { factory, checker, sourceFile } = context;

  context.markSyntheticComputeOwnedSubtree(expression);

  // Get result type for the synthetic lift-applied call we're about to emit.
  let resultTypeNode: ts.TypeNode | undefined;
  let resultType: ts.Type | undefined;

  try {
    resultType = checker.getTypeAtLocation(expression);
    // Build via the canonical chokepoint so commonfabric refs normalize to
    // `__cfHelpers.X` and the node is registered for schema generation. (The
    // call-node registration below still keys the lift-applied CallExpression
    // to its result Type.)
    resultTypeNode = typeToTypeNodeWithRegistry(
      resultType,
      { checker, factory, sourceFile, state: context.state },
      context.state.typeRegistry,
    );
  } catch {
    resultTypeNode = undefined;
    resultType = undefined;
  }

  // Emit the canonical lift-applied form for a zero-input compute wrapper:
  //   __cfHelpers.lift(() => expression)({})
  //
  // This matches LiftLoweringTransformer's lowering of source-level
  // `computed(() => expr)`. Previously this site emitted bare
  // `__cfHelpers.computed(...)` — but LiftLoweringTransformer has already run
  // by this stage in the pipeline, so emitting computed here would leave it
  // in lowered output, defeating Phase 1's "no computed/derive in lowered
  // output" invariant.
  // Callback arrow: source-map-range only (emit-safe position carry). See
  // preserveSourceMapRange.
  const arrowFunction = preserveSourceMapRange(
    factory.createArrowFunction(
      undefined,
      undefined,
      [],
      options.resultTypeNode ?? resultTypeNode,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      expression,
    ),
    expression,
  );
  context.markAsSyntheticComputeCallback(arrowFunction);

  const innerLiftCall = context.cfHelpers.createHelperCall(
    "lift",
    expression,
    undefined,
    [arrowFunction],
  );
  const emptyInput = factory.createObjectLiteralExpression([], false);
  // Outer wrapper call: source-map-range ONLY. This call WRAPS the authored
  // expression rather than replacing it as the same semantic unit, so it must
  // not claim the expression's identity: `expression` was just marked
  // compute-owned (markSyntheticComputeOwnedSubtree above), and identity-
  // sensitive classifiers fall back through getOriginalNode — an original
  // pointing at the marked subtree makes the wrapper (e.g. as the receiver of
  // a chained array method) falsely read as compute-owned and trips the
  // array-method context invariant. smr carries the authored position without
  // identity (CT-1868).
  const liftAppliedCall = preserveSourceMapRange(
    factory.createCallExpression(
      innerLiftCall,
      undefined,
      [emptyInput],
    ),
    expression,
  );

  // Register types for both the TypeNode and the lift-applied CallExpression
  if (resultTypeNode && resultType) {
    context.state.typeRegistry.set(resultTypeNode, resultType);
    context.state.typeRegistry.set(liftAppliedCall, resultType);
  }

  // CRITICAL: Set parent pointers and connect to parent chain
  // This maintains the parent chain so walking up from nested callbacks works
  setParentPointers(liftAppliedCall, expression.parent);

  return liftAppliedCall;
}

/**
 * Union the reactive dataflow refs with any free identifiers in `expression`
 * whose declarations live in an enclosing (non-module, non-expression-local)
 * function scope. This is what makes plain-JS captures (e.g. `const suffix =
 * "!"` declared in the enclosing pattern/map callback) become explicit
 * lift-applied inputs instead of flowing through lexical closure.
 *
 * The dataflow analyzer only surfaces reactive captures (Cell/Reactive).
 * Plain-JS values declared in enclosing scope are invisible to it, so they
 * default to lexical closure when `createLiftAppliedCall` emits the callback.
 * That breaks the self-contained-callback contract that SES sandboxing and
 * module-scope hoisting rely on. Including them here gives them schema
 * coverage and explicit transport.
 *
 * Identifiers that resolve to module scope (imports, top-level consts) are
 * NOT added — module bindings are stable and hoistable. Identifiers
 * declared *inside* a nested function within `expression` itself (e.g. the
 * parameter of a `.filter((x) => ...)` callback nested in the expression)
 * are NOT added — they're local, not enclosing.
 */
function unionWithEnclosingScopeFreeIdentifiers(
  refs: readonly ts.Expression[],
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Expression[] {
  // Build a set of identifier names already represented by the dataflow refs
  // so we don't add them again. We key by name rather than by symbol because
  // dataflow refs are sometimes synthesized expressions whose root identifier
  // doesn't carry a resolvable symbol on the post-transform AST. Within a
  // single expression, TypeScript scoping makes name → binding unambiguous,
  // so name-based dedup is safe here.
  const alreadyCoveredNames = new Set<string>();
  for (const ref of refs) {
    const root = getRootIdentifier(ref);
    if (root) alreadyCoveredNames.add(root.text);
  }

  const added: ts.Expression[] = [];
  const addedNames = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReferenceSite(node)) {
      if (
        !alreadyCoveredNames.has(node.text) && !addedNames.has(node.text)
      ) {
        const symbol = checker.getSymbolAtLocation(node);
        // Only capture value-space symbols. Type-only identifiers (type
        // aliases, interfaces — type parameters are also filtered by
        // `isEnclosingScopeDeclaration` below) can appear at reference
        // sites in `as`/`satisfies` casts and generic type arguments;
        // emitting them as runtime inputs would be a type error.
        if (
          symbol &&
          (symbol.flags & ts.SymbolFlags.Value) !== 0 &&
          !isNestedFunctionLocalCapture(node, expression, checker) &&
          isEnclosingScopeDeclaration(symbol)
        ) {
          addedNames.add(node.text);
          added.push(node);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(expression);

  return [...refs, ...added];
}

/**
 * The identifier a reference is rooted at, looking through member access, calls,
 * and the transparent wrapper set.
 *
 * This decides which names an existing data flow already covers. A reference
 * whose root goes unrecognized is not merely skipped: the free-identifier pass
 * below then adds that root as its own capture, and a whole-object capture
 * subsumes the narrower paths beside it — so the lift subscribes to the whole
 * object where it could have subscribed to one field.
 */
function getRootIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  let current: ts.Expression = expr;
  while (true) {
    const unwrapped = unwrapTransparentWrapperOnce(current);
    if (unwrapped) {
      current = unwrapped;
      continue;
    }
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return ts.isIdentifier(current) ? current : undefined;
  }
}

function isReferenceSite(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  // Property name in a property access — not a free reference.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  // Property key in an object literal — not a free reference.
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  // Property name in a binding pattern (e.g. `{ propertyName: bindingName }`)
  // — not a free reference.
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  // JSX tag names look like identifiers but resolve to components/elements.
  if (
    ts.isJsxOpeningElement(parent) ||
    ts.isJsxClosingElement(parent) ||
    ts.isJsxSelfClosingElement(parent)
  ) return false;
  return true;
}

function isEnclosingScopeDeclaration(symbol: ts.Symbol): boolean {
  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return false;
  // Reject if ANY declaration is module-scoped or an import — those don't
  // need to be passed as lift-applied inputs. They're stable and hoistable.
  for (const decl of declarations) {
    if (
      ts.isImportSpecifier(decl) ||
      ts.isImportClause(decl) ||
      ts.isNamespaceImport(decl) ||
      isModuleScopedDeclaration(decl)
    ) {
      return false;
    }
    if (ts.isTypeParameterDeclaration(decl)) {
      return false;
    }
  }
  // Accept only if SOME declaration is inside a function-like ancestor
  // (i.e., truly enclosing-scope, not floating somewhere weird).
  return declarations.some((decl) => {
    let current: ts.Node | undefined = decl.parent;
    while (current) {
      if (ts.isFunctionLike(current)) return true;
      if (ts.isSourceFile(current)) return false;
      current = current.parent;
    }
    return false;
  });
}
