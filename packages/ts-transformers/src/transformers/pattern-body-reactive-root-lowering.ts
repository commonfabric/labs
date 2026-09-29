import ts from "typescript";
import { MERGEABLE_OP_METHODS } from "@commonfabric/api";
import {
  getLiftAppliedInnerCall,
  getLiftAppliedInputAndCallback,
  getTypeAtLocationWithFallback,
  isSyntheticNode,
  isWildcardTraversalCall,
  type NormalizedDataFlow,
  preserveSourceMapRange,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import { TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import {
  cloneKeyExpression,
  getCommonFabricKeyName,
  isCommonFabricKeyExpression,
} from "../utils/reactive-keys.ts";
import {
  collectDestructureBindings,
  createKeyCall,
  type DefaultDestructureBinding,
  type DestructureBinding,
  type PathSegment,
} from "./destructuring-lowering.ts";
import {
  createReactiveWrapperForExpression,
} from "./expression-rewrite/rewrite-helpers.ts";
import {
  addBindingTargetSymbols,
  classifyOpaquePathTerminalCall,
  collectLocalOpaqueRootSymbols,
  getOpaqueAccessInfo,
  isOpaqueOriginCall,
  isOpaqueRootInfo,
  isOpaqueSourceExpression,
  isTopmostMemberAccess,
} from "./opaque-roots.ts";
import {
  findPendingComputeWrapCandidate,
  resolveComputeWrapCandidate,
} from "./expression-rewrite/emitters/compute-wrap-invariants.ts";
import {
  classifyUnsupportedExpressionSiteCallRoot,
} from "./expression-site-policy.ts";
import { getCellKind } from "./cell-type.ts";
import { createPropertyName } from "../utils/identifiers.ts";

const KNOWN_PATH_TERMINAL_METHODS = new Set([
  "set",
  "update",
  "get",
  "key",
  "elementById",
  "map",
  "mapWithPattern",
  "count",
  "countWithPattern",
  "sum",
  "min",
  "max",
  "minBy",
  "minByWithPattern",
  "maxBy",
  "maxByWithPattern",
  "groupBy",
  "groupByWithPattern",
  "keyBy",
  "keyByWithPattern",

  "filterWithPattern",
  "flatMapWithPattern",
  // SqliteDb.query(sql, ...) — a reactive read method on a SqliteDb handle,
  // lowered like .map (the node factory builds the sqliteQuery node).
  "query",
]);

// Mutating methods on cells / reactive arrays. A write of any of these in the
// pattern body is not lowerable, and the remedy is a module-scope handler<> —
// NOT computed(), which is read-only (CT-1641). The mergeable-op methods (push,
// addUnique, increment, removeByValue) come from the canonical catalog in
// @commonfabric/api, so a new mergeable op is covered by registering it there.
const WRITE_METHODS = new Set([
  // Cell write API
  "set",
  "update",
  ...MERGEABLE_OP_METHODS.map((op) => op.method),
  "remove",
  "removeAll",
  // Array mutators (in case the author reaches for them on a reactive array)
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

// The remedy half of the "method calls are not lowerable" diagnostics. The
// pattern body runs once at construction, so an event-driven write there has no
// triggering event and isn't lowerable; route it through a module-scope
// handler<>. (Wrapping the write in computed() is not the fix either: a write in
// a computed() re-triggers the computation and must be idempotent — see
// docs/common/concepts/computed/computed.md.) Non-write unsupported calls
// still belong in computed()/lift().
function notLowerableMethodRemedy(methodName: string | undefined): string {
  if (methodName && WRITE_METHODS.has(methodName)) {
    return "Writes to pattern inputs must go through a module-scope handler<> " +
      "(typed Writable<T>), not the pattern body, which runs once at " +
      "construction.";
  }
  return "Move this call into computed().";
}

// Best-effort extraction of the invoked method name from a call expression
// whose callee is a property access (e.g. `items.push(...)` -> "push").
function calleeMethodName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression)
  ) {
    return callee.argumentExpression.text;
  }
  return undefined;
}

function isSelfPathSegment(
  segment: PathSegment,
  context: TransformationContext,
): boolean {
  return typeof segment !== "string" &&
    isCommonFabricKeyExpression(segment, context, "SELF");
}

/** Carries the source-map range and inferred type to a semantic replacement. */
function registerReplacement(
  replacement: ts.Node,
  original: ts.Node,
  context: TransformationContext,
): void {
  preserveSourceMapRange(replacement, original);
  const typeRegistry = context.state.typeRegistry;
  const originalType = getTypeAtLocationWithFallback(
    original,
    context.checker,
    typeRegistry,
  );
  if (originalType) {
    typeRegistry.set(replacement, originalType);
  }
}

export function reportComputationError(
  context: TransformationContext,
  node: ts.Node,
  message: string,
): void {
  context.reportDiagnostic({
    severity: "error",
    type: "pattern-context:computation",
    message,
    node,
  });
}

function reportReceiverMethodError(
  context: TransformationContext,
  node: ts.Node,
  message: string,
): void {
  context.reportDiagnostic({
    severity: "error",
    type: "pattern-context:receiver-method-call",
    message,
    node,
  });
}

// Wraps a destructured leaf's initializer with `.for("<causeName>", true)`
// so the shared causeContainer (root + all `.key()` siblings) gets identity
// from the user-facing binding name rather than falling back to a
// counter-based `__#N` internal path. `allowIfSet: true` makes this a no-op
// once any sibling has set the cause — so in a multi-binding destructure
// (`const { a, b } = wish(...)`), the first leaf in source order wins.
function attachForCauseToOpaqueInitializer(
  initializer: ts.Expression,
  causeName: string,
  context: TransformationContext,
): ts.Expression {
  const { factory } = context;
  const call = factory.createCallExpression(
    factory.createPropertyAccessExpression(initializer, "for"),
    undefined,
    [factory.createStringLiteral(causeName), factory.createTrue()],
  );
  return context.cfHelpers.preserveNodeSourceMap(
    call,
    initializer,
    initializer,
  );
}

export function rewritePatternCallbackBody(
  body: ts.ConciseBody,
  opaqueRoots: Set<string>,
  opaqueRootSymbols: Set<ts.Symbol>,
  context: TransformationContext,
): ts.ConciseBody {
  const preRewrittenBody = rewriteInlineReactiveOriginChains(body, context);
  reportInlineReactiveRootAccesses(preRewrittenBody, context);
  const rewrittenBody = rewriteTrackedOpaquePatternBody(
    preRewrittenBody,
    opaqueRoots,
    opaqueRootSymbols,
    context,
  );
  return rewriteNestedLiftAppliedCallbackBodies(rewrittenBody, context);
}

function rewriteTrackedOpaquePatternBody(
  body: ts.ConciseBody,
  opaqueRoots: Set<string>,
  opaqueRootSymbols: Set<ts.Symbol>,
  context: TransformationContext,
): ts.ConciseBody {
  if (
    opaqueRoots.size === 0 &&
    opaqueRootSymbols.size === 0 &&
    !hasLocalOpaqueOriginBinding(body, context)
  ) {
    return body;
  }

  const activeOpaqueRoots = new Set(opaqueRoots);
  const scopeStack: Map<string, boolean>[] = [];

  const enterScope = (): void => {
    scopeStack.push(new Map<string, boolean>());
  };

  const exitScope = (): void => {
    const scope = scopeStack.pop();
    if (!scope) return;
    for (const [name, wasOpaque] of scope) {
      if (wasOpaque) {
        activeOpaqueRoots.add(name);
      } else {
        activeOpaqueRoots.delete(name);
      }
    }
  };

  const setBindingOpaqueState = (
    binding: ts.BindingName,
    isOpaque: boolean,
  ): void => {
    const currentScope = scopeStack[scopeStack.length - 1];

    if (ts.isIdentifier(binding)) {
      if (currentScope && !currentScope.has(binding.text)) {
        currentScope.set(binding.text, activeOpaqueRoots.has(binding.text));
      }
      if (isOpaque) {
        activeOpaqueRoots.add(binding.text);
      } else {
        activeOpaqueRoots.delete(binding.text);
      }
      return;
    }

    for (const element of binding.elements) {
      if (ts.isOmittedExpression(element)) continue;
      setBindingOpaqueState(element.name, isOpaque);
    }
  };

  const diagnosticsSeen = new Set<number>();
  const syntheticDiagnosticsSeen = new WeakSet<ts.Node>();
  const analyze = context.getDataFlowAnalyzer();
  const resolveDiagnosticNode = (node: ts.Node): ts.Node => {
    const original = ts.getOriginalNode(node);
    if (original.pos >= 0) {
      return original;
    }
    return node;
  };
  const reportOnce = (
    node: ts.Node,
    type: "computation" | "receiver-method",
    message: string,
  ): void => {
    const diagnosticNode = resolveDiagnosticNode(node);
    if (diagnosticNode.pos >= 0) {
      const key = diagnosticNode.getStart(context.sourceFile);
      if (diagnosticsSeen.has(key)) return;
      diagnosticsSeen.add(key);
    } else {
      if (syntheticDiagnosticsSeen.has(diagnosticNode)) return;
      syntheticDiagnosticsSeen.add(diagnosticNode);
    }
    if (type === "computation") {
      reportComputationError(context, diagnosticNode, message);
    } else {
      reportReceiverMethodError(context, diagnosticNode, message);
    }
  };

  const callTargetParents = new WeakMap<ts.Node, ts.CallExpression>();

  const getTrackedOpaqueAccessInfo = (
    expression: ts.Expression,
  ): ReturnType<typeof getOpaqueAccessInfo> | undefined => {
    const info = getOpaqueAccessInfo(expression, context);
    return isOpaqueRootInfo(
        info,
        activeOpaqueRoots,
        opaqueRootSymbols,
        context,
      )
      ? info
      : undefined;
  };

  const hasDynamicOpaqueAccess = (
    expression: ts.Expression,
  ): boolean => {
    let found = false;

    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        isTopmostMemberAccess(node)
      ) {
        const info = getTrackedOpaqueAccessInfo(node);
        if (info?.dynamic) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(expression);
    return found;
  };

  const getRelevantDataFlowsForExpression = (
    expression: ts.Expression,
  ) => {
    const relevantDataFlows = context.getRelevantDataFlows(expression).map(
      (dataFlow) => canonicalizeDataFlowForDerive(dataFlow),
    );
    return relevantDataFlows.length > 0 ? relevantDataFlows : undefined;
  };

  const canonicalizeDataFlowForDerive = (
    dataFlow: NormalizedDataFlow,
  ): NormalizedDataFlow => {
    const info = getTrackedOpaqueAccessInfo(dataFlow.expression);
    if (
      !info?.root ||
      info.dynamic ||
      info.path.length === 0 ||
      !info.path.every((segment) => typeof segment === "string")
    ) {
      return dataFlow;
    }

    const expression = createKeyCall(
      context.factory.createIdentifier(info.root),
      info.path,
      context.factory,
    );
    registerReplacement(expression, dataFlow.expression, context);
    return { ...dataFlow, expression };
  };

  const isDynamicElementAccess = (
    expression: ts.Expression,
  ): expression is ts.ElementAccessExpression => {
    if (!ts.isElementAccessExpression(expression)) return false;
    const arg = expression.argumentExpression;
    if (
      ts.isLiteralExpression(arg) ||
      ts.isNoSubstitutionTemplateLiteral(arg)
    ) return false;
    // Well-known CF computed keys (UI, NAME, SELF, FS) are statically known
    // even though they appear as identifier references rather than literals.
    // The late lowering substitutes the canonical `__cfHelpers.<NAME>`
    // expression for them, so treating them as dynamic would force an
    // unnecessary reactive wrapper around `obj[UI]` etc.
    if (getCommonFabricKeyName(arg, context.checker) !== undefined) {
      return false;
    }
    return true;
  };

  const hasJsxExpressionAncestor = (node: ts.Node): boolean => {
    const scan = (start: ts.Node | undefined): boolean => {
      let current = start;
      while (current) {
        if (ts.isJsxExpression(current)) {
          return true;
        }
        current = current.parent;
      }
      return false;
    };

    if (scan(node.parent)) {
      return true;
    }

    const original = ts.getOriginalNode(node);
    return original !== node && scan(original.parent);
  };

  const shouldWrapDirectJsxExpression = (node: ts.Node): boolean => {
    if (!hasJsxExpressionAncestor(node)) {
      return false;
    }

    let current = node.parent;
    while (current) {
      if (
        (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
        context.isSyntheticComputeCallback(current)
      ) {
        return false;
      }
      current = current.parent;
    }

    return true;
  };

  const reportTrackedOpaqueComputation = (
    expression: ts.Expression | undefined,
    diagnosticNode: ts.Node,
    message: string,
  ): void => {
    if (!expression || !getTrackedOpaqueAccessInfo(expression)) {
      return;
    }

    reportOnce(diagnosticNode, "computation", message);
  };

  const registerOpaqueBindingState = (
    name: ts.BindingName,
    initializer: ts.Expression | undefined,
  ): void => {
    const initializerIsOpaque = !!initializer &&
      isOpaqueSourceExpression(
        initializer,
        activeOpaqueRoots,
        opaqueRootSymbols,
        context,
      );
    setBindingOpaqueState(name, initializerIsOpaque);
    if (initializerIsOpaque) {
      addBindingTargetSymbols(name, opaqueRootSymbols, context.checker);
    }
  };

  const maybeWrapDynamicInitializer = (
    initializer: ts.Expression,
  ): ts.Expression | undefined => {
    if (!ts.isBinaryExpression(initializer)) {
      return undefined;
    }

    if (!hasDynamicOpaqueAccess(initializer)) {
      return undefined;
    }

    const relevantDataFlows = getRelevantDataFlowsForExpression(initializer);
    if (!relevantDataFlows) {
      return undefined;
    }

    const pendingWrap = findPendingComputeWrapCandidate(
      initializer,
      analyze,
      context,
    );
    if (!pendingWrap) {
      return undefined;
    }

    if (context.getReactiveContext(pendingWrap).kind !== "compute") {
      const decision = resolveComputeWrapCandidate(
        pendingWrap,
        initializer,
        "pattern callback initializer",
        context,
      );
      if (decision.kind === "skip-reported") {
        return undefined;
      }
    }

    return createReactiveWrapperForExpression(
      initializer,
      relevantDataFlows,
      context,
    );
  };

  const maybeWrapDynamicJsxAccess = (
    expression: ts.Expression,
  ): ts.Expression | undefined => {
    if (!shouldWrapDirectJsxExpression(expression)) {
      return undefined;
    }

    const relevantDataFlows = getRelevantDataFlowsForExpression(expression);
    if (!relevantDataFlows) {
      return undefined;
    }

    return createReactiveWrapperForExpression(
      expression,
      relevantDataFlows,
      context,
      {
        allowDirectExpressionWrap: true,
        preferInputBoundWrapper: true,
      },
    );
  };

  const maybeWrapCellGetJsxCall = (
    expression: ts.CallExpression,
  ): ts.Expression | undefined => {
    if (classifyOpaquePathTerminalCall(expression) !== "get") {
      return undefined;
    }

    if (!shouldWrapDirectJsxExpression(expression)) {
      return undefined;
    }

    const callee = expression.expression;
    if (
      !ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)
    ) {
      return undefined;
    }

    let receiverIsCellLike = !!getTrackedOpaqueAccessInfo(callee.expression);
    if (!receiverIsCellLike) {
      try {
        const receiverType = context.checker.getTypeAtLocation(
          callee.expression,
        );
        receiverIsCellLike = getCellKind(receiverType, context.checker) !==
          undefined;
      } catch {
        receiverIsCellLike = false;
      }
    }

    if (!receiverIsCellLike) {
      return undefined;
    }

    const relevantDataFlows = getRelevantDataFlowsForExpression(expression);
    if (!relevantDataFlows) {
      return undefined;
    }

    return createReactiveWrapperForExpression(
      expression,
      relevantDataFlows,
      context,
      {
        allowDirectExpressionWrap: true,
        preferInputBoundWrapper: true,
      },
    );
  };

  const lowerOpaqueDestructuredVariableStatement = (
    statement: ts.VariableStatement,
  ): ts.VariableStatement | undefined => {
    const rewrittenDeclarations: ts.VariableDeclaration[] = [];
    let changed = false;

    for (const declaration of statement.declarationList.declarations) {
      if (
        !declaration.initializer ||
        ts.isIdentifier(declaration.name) ||
        declaration.type
      ) {
        rewrittenDeclarations.push(declaration);
        continue;
      }

      if (
        !isOpaqueSourceExpression(
          declaration.initializer,
          activeOpaqueRoots,
          opaqueRootSymbols,
          context,
        )
      ) {
        rewrittenDeclarations.push(declaration);
        continue;
      }

      const bindings: DestructureBinding[] = [];
      const defaults: DefaultDestructureBinding[] = [];
      const unsupported: string[] = [];
      collectDestructureBindings(
        declaration.name,
        [],
        bindings,
        defaults,
        unsupported,
        context,
      );

      if (unsupported.length > 0 || defaults.length > 0) {
        if (defaults.length > 0) {
          reportComputationError(
            context,
            declaration.name,
            "Destructuring defaults on opaque local bindings are not lowerable in pattern context; move defaulting into computed().",
          );
        }
        for (const message of unsupported) {
          reportComputationError(context, declaration.name, message);
        }
        rewrittenDeclarations.push(declaration);
        continue;
      }

      changed = true;

      const initializer = unwrapExpression(declaration.initializer);
      let rootIdentifier: ts.Identifier;
      // True only when the destructure root is a fresh reactive-origin call
      // (`wish(...)`, `fetchJson(...)`, etc.). In that case the synthesized
      // root cell starts without a cause, so we attach a stable `.for(...)`
      // to each named leaf below to pin its shared causeContainer to a
      // user-facing identifier — otherwise the cell falls back to a
      // counter-based `__#N` internal path that drifts across edits.
      let rootIsFreshOpaqueOrigin = false;
      if (ts.isIdentifier(initializer)) {
        rootIdentifier = context.factory.createIdentifier(initializer.text);
      } else {
        rootIdentifier = context.factory.createUniqueName("__cf_destructure");
        rootIsFreshOpaqueOrigin = ts.isCallExpression(initializer) &&
          isOpaqueOriginCall(initializer, context);
        rewrittenDeclarations.push(
          preserveSourceMapRange(
            context.factory.createVariableDeclaration(
              rootIdentifier,
              undefined,
              undefined,
              declaration.initializer,
            ),
            declaration.initializer,
          ),
        );
      }

      for (const binding of bindings) {
        let loweredInitializer: ts.Expression;
        if (binding.directKeyExpression) {
          loweredInitializer = context.factory.createElementAccessExpression(
            rootIdentifier,
            cloneKeyExpression(binding.directKeyExpression, context.factory),
          );
        } else if (binding.path.length === 0) {
          loweredInitializer = rootIdentifier;
        } else {
          loweredInitializer = createKeyCall(
            rootIdentifier,
            binding.path,
            context.factory,
          );
        }

        if (rootIsFreshOpaqueOrigin && binding.path.length > 0) {
          loweredInitializer = attachForCauseToOpaqueInitializer(
            loweredInitializer,
            binding.localName,
            context,
          );
        }

        rewrittenDeclarations.push(
          preserveSourceMapRange(
            context.factory.createVariableDeclaration(
              context.factory.createIdentifier(binding.localName),
              undefined,
              undefined,
              loweredInitializer,
            ),
            binding.bindingNode,
          ),
        );
      }
    }

    if (!changed) return undefined;

    return context.factory.updateVariableStatement(
      statement,
      statement.modifiers,
      context.factory.updateVariableDeclarationList(
        statement.declarationList,
        rewrittenDeclarations,
      ),
    );
  };

  const visit = (node: ts.Node): ts.Node => {
    if (ts.isFunctionLike(node)) {
      if (node !== body) {
        return node;
      }
    }

    if (ts.isBlock(node) && node !== body) {
      enterScope();
      const rewritten = visitEachChildWithJsx(node, visit, context.tsContext);
      exitScope();
      return rewritten;
    }

    if (ts.isVariableStatement(node)) {
      const loweredStatement = lowerOpaqueDestructuredVariableStatement(node);
      if (loweredStatement) {
        return visit(loweredStatement);
      }
    }

    if (ts.isCallExpression(node)) {
      const wrappedCellGet = maybeWrapCellGetJsxCall(node);
      if (wrappedCellGet) {
        registerReplacement(wrappedCellGet, node, context);
        return wrappedCellGet;
      }

      callTargetParents.set(node.expression, node);
    }

    // Pre-visit dynamic-wrap: wraps `obj[dynamicKey]` accesses where the
    // root isn't tracked as opaque (so the post-visit branch's tracked-
    // opaque path doesn't apply) but the access still appears in JSX and
    // needs a reactive wrapper. CT-1586 audit confirmed this branch is
    // still load-bearing — disabling it breaks "element access
    // complex/simple", "jsx property access", and "reactive array element
    // access schema" tests. The pre-visit timing matters because the
    // visitor recurses into children after this point, and once the
    // sub-tree has been rewritten the original access-shape detection
    // may not match anymore.
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      isTopmostMemberAccess(node)
    ) {
      if (isDynamicElementAccess(node)) {
        const wrappedDynamicAccess = maybeWrapDynamicJsxAccess(node);
        if (wrappedDynamicAccess) {
          registerReplacement(wrappedDynamicAccess, node, context);
          return wrappedDynamicAccess;
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isExpression(node.initializer)
    ) {
      const rewrittenInitializer = maybeWrapDynamicInitializer(
        node.initializer,
      );
      if (rewrittenInitializer) {
        const rewrittenDeclaration = context.factory.updateVariableDeclaration(
          node,
          node.name,
          node.exclamationToken,
          node.type,
          rewrittenInitializer,
        );
        registerOpaqueBindingState(
          rewrittenDeclaration.name,
          rewrittenInitializer,
        );
        return rewrittenDeclaration;
      }
    }

    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (ts.isVariableDeclaration(visited)) {
      registerOpaqueBindingState(visited.name, visited.initializer);
    }

    if (
      (ts.isPropertyAccessExpression(visited) ||
        ts.isElementAccessExpression(visited)) &&
      isTopmostMemberAccess(visited)
    ) {
      const info = getTrackedOpaqueAccessInfo(visited);
      // Tracked-opaque static-key access takes precedence over the JSX
      // dynamic-wrap heuristic: when the root is a known opaque binding and
      // the access argument resolves to a static path segment (including
      // well-known CF computed keys like UI/NAME/SELF/FS), the canonical
      // form is `root.key(...)` in-place, regardless of whether the
      // expression lives inside a JSX slot. Falling into
      // `maybeWrapDynamicJsxAccess` here would produce an unnecessary
      // lift-applied wrapper around what is already a reactive expression.
      const hasTrackedStaticAccess = !!info?.root && !info.dynamic;
      if (!hasTrackedStaticAccess && isDynamicElementAccess(visited)) {
        const wrappedDynamicAccess = maybeWrapDynamicJsxAccess(visited);
        if (wrappedDynamicAccess) {
          registerReplacement(wrappedDynamicAccess, visited, context);
          return wrappedDynamicAccess;
        }
      }

      if (!info?.root) {
        return visited;
      }

      if (info.dynamic) {
        const wrappedDynamicAccess = maybeWrapDynamicJsxAccess(visited);
        if (wrappedDynamicAccess) {
          registerReplacement(wrappedDynamicAccess, visited, context);
          return wrappedDynamicAccess;
        }

        reportOnce(
          visited,
          "computation",
          "Dynamic key access is not lowerable in pattern context. Use a compute wrapper for dynamic traversal.",
        );
        return visited;
      }

      if (ts.isPropertyAccessExpression(visited)) {
        const parentCall = callTargetParents.get(node);
        const unsupportedCallRoot = parentCall
          ? classifyUnsupportedExpressionSiteCallRoot(
            parentCall,
            context,
            analyze,
          )
          : undefined;

        if (
          KNOWN_PATH_TERMINAL_METHODS.has(visited.name.text) && parentCall
        ) {
          if (info.path.length <= 1) {
            return visited;
          }

          const receiverPath = info.path.slice(0, -1);
          const rewrittenReceiver = createKeyCall(
            context.factory.createIdentifier(info.root),
            receiverPath,
            context.factory,
          );
          const rewrittenMethod = context.factory
            .createPropertyAccessExpression(
              rewrittenReceiver,
              visited.name.text,
            );
          registerReplacement(rewrittenMethod, visited, context);
          return rewrittenMethod;
        }

        if (parentCall) {
          if (
            unsupportedCallRoot === "unsupported-receiver-method"
          ) {
            return visited;
          }

          reportOnce(
            visited,
            "computation",
            "Method calls on opaque pattern values are not lowerable. " +
              notLowerableMethodRemedy(visited.name.text),
          );
          return visited;
        }
      }

      const firstPathSegment = info.path[0];
      if (
        info.path.length === 1 &&
        firstPathSegment &&
        isSelfPathSegment(firstPathSegment, context)
      ) {
        return visited;
      }

      if (info.path.length > 0) {
        const rewritten = createKeyCall(
          context.factory.createIdentifier(info.root),
          info.path,
          context.factory,
        );
        registerReplacement(rewritten, visited, context);
        return rewritten;
      }
    }

    if (ts.isCallExpression(visited)) {
      const unsupportedCallRoot = classifyUnsupportedExpressionSiteCallRoot(
        visited,
        context,
        analyze,
      );
      if (unsupportedCallRoot === "unsupported-receiver-method") {
        const reactiveContext = context.getReactiveContext(visited);
        const methodName = calleeMethodName(visited);
        const isWrite = methodName !== undefined &&
          WRITE_METHODS.has(methodName);
        if (
          reactiveContext.kind === "pattern" &&
          (reactiveContext.owner === "pattern" ||
            reactiveContext.owner === "render") &&
          !reactiveContext.inJsxExpression
        ) {
          reportOnce(
            visited,
            "receiver-method",
            isWrite
              ? "Writes to pattern inputs are not supported directly in pattern bodies. " +
                notLowerableMethodRemedy(methodName)
              : "Method calls on reactive values are not yet supported directly in non-JSX pattern bodies. Move this call into computed(() => ...), module-scope lift(), or another safe wrapper.",
          );
        } else {
          reportOnce(
            visited,
            "receiver-method",
            "Method calls on opaque pattern values are not lowerable. " +
              notLowerableMethodRemedy(methodName),
          );
        }
      }

      if (isWildcardTraversalCall(visited, context.checker)) {
        reportTrackedOpaqueComputation(
          visited.arguments[0],
          visited.arguments[0] ?? visited,
          "Wildcard object traversal is not lowerable in pattern context. Move this expression into computed().",
        );
      }
    }

    if (ts.isSpreadElement(visited) || ts.isSpreadAssignment(visited)) {
      reportTrackedOpaqueComputation(
        visited.expression,
        visited,
        "Spread traversal of opaque pattern values is not lowerable. Move this expression into computed().",
      );
    }

    if (ts.isForInStatement(visited)) {
      reportTrackedOpaqueComputation(
        visited.expression,
        visited.expression,
        "for..in traversal of opaque pattern values is not lowerable. Move this expression into computed().",
      );
    }

    if (ts.isForOfStatement(visited)) {
      reportTrackedOpaqueComputation(
        visited.expression,
        visited.expression,
        "for..of traversal of opaque pattern values is not lowerable. Move this expression into computed().",
      );
    }

    return visited;
  };

  enterScope();
  if (ts.isBlock(body)) {
    const rewrittenBody = visitEachChildWithJsx(
      body,
      visit,
      context.tsContext,
    ) as ts.Block;
    exitScope();
    return rewrittenBody;
  }

  const rewrittenExpr = visit(body) as ts.Expression;
  exitScope();
  return rewrittenExpr;
}

/**
 * Recursively process lift-applied callback bodies (the lowered form of
 * computed() callbacks) to rewrite property accesses on
 * locally-declared Reactive variables (e.g., const foo = computed(...);
 * foo.bar → foo.key("bar")).
 *
 * rewriteTrackedOpaquePatternBody stops at function boundaries, so
 * lift-applied callback bodies are not processed by it. This pass finds
 * lift-applied calls in the given body, extracts their callbacks, and
 * applies the tracked-opaque rewrite to each callback body
 * with empty opaque roots (since lift-applied callbacks receive unwrapped
 * captures).
 * Local variables initialized from computed/lift calls within the callback
 * will be detected as opaque roots by the tracked-opaque body's variable
 * tracking.
 */
function rewriteNestedLiftAppliedCallbackBodies(
  body: ts.ConciseBody,
  context: TransformationContext,
): ts.ConciseBody {
  const visit = (node: ts.Node): ts.Node => {
    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (!ts.isCallExpression(visited)) return visited;

    const liftAppliedArgs = getLiftAppliedInputAndCallback(
      visited,
      context.checker,
    );
    if (!liftAppliedArgs) return visited;
    const { callback: callbackArg } = liftAppliedArgs;

    // The callback lives on the inner lift call (lift(cb)(input)). When
    // getLiftAppliedInputAndCallback succeeds the inner call is always present
    // — both gate on the outer call's callee being a CallExpression — so
    // getLiftAppliedInnerCall is non-undefined here.
    const innerCall = getLiftAppliedInnerCall(visited);
    const callbackHostArgs = innerCall
      ? innerCall.arguments
      : visited.arguments;
    const callbackIndex = callbackHostArgs.indexOf(callbackArg);

    let processedBody = rewriteNestedLiftAppliedCallbackBodies(
      callbackArg.body,
      context,
    );

    const localOpaqueRootSymbols = collectLocalOpaqueRootSymbols(
      processedBody,
      context,
    );
    const localOpaqueRoots = new Set<string>();
    for (const parameter of callbackArg.parameters) {
      collectBindingNames(parameter.name, localOpaqueRoots);
    }

    processedBody = rewriteTrackedOpaquePatternBody(
      processedBody,
      new Set(),
      localOpaqueRootSymbols,
      context,
    );
    processedBody = rewriteLiftAppliedCallbackComputedKeyAccesses(
      processedBody,
      localOpaqueRoots,
      context,
    );

    if (processedBody === callbackArg.body) return visited;

    const newCallback = ts.isArrowFunction(callbackArg)
      ? context.factory.updateArrowFunction(
        callbackArg,
        callbackArg.modifiers,
        callbackArg.typeParameters,
        callbackArg.parameters,
        callbackArg.type,
        callbackArg.equalsGreaterThanToken,
        processedBody,
      )
      : context.factory.updateFunctionExpression(
        callbackArg as ts.FunctionExpression,
        callbackArg.modifiers,
        (callbackArg as ts.FunctionExpression).asteriskToken,
        (callbackArg as ts.FunctionExpression).name,
        callbackArg.typeParameters,
        callbackArg.parameters,
        callbackArg.type,
        processedBody as ts.Block,
      );

    if (innerCall) {
      const newInnerArgs = [...innerCall.arguments];
      newInnerArgs[callbackIndex] = newCallback;
      const newInnerCall = context.factory.updateCallExpression(
        innerCall,
        innerCall.expression,
        innerCall.typeArguments,
        newInnerArgs,
      );
      return context.factory.updateCallExpression(
        visited,
        newInnerCall,
        visited.typeArguments,
        visited.arguments,
      );
    }

    const args = [...visited.arguments];
    args[callbackIndex] = newCallback;
    return context.factory.updateCallExpression(
      visited,
      visited.expression,
      visited.typeArguments,
      args,
    );
  };

  if (ts.isBlock(body)) {
    return visitEachChildWithJsx(
      body,
      visit,
      context.tsContext,
    ) as ts.Block;
  }
  return visit(body) as ts.Expression;
}

function rewriteLiftAppliedCallbackComputedKeyAccesses(
  body: ts.ConciseBody,
  opaqueRoots: ReadonlySet<string>,
  context: TransformationContext,
): ts.ConciseBody {
  if (opaqueRoots.size === 0) {
    return body;
  }

  const visit = (node: ts.Node): ts.Node => {
    if (ts.isFunctionLike(node)) {
      return node;
    }

    const visited = visitEachChildWithJsx(node, visit, context.tsContext);
    if (
      !ts.isElementAccessExpression(visited) ||
      !isTopmostMemberAccess(visited) ||
      !ts.isIdentifier(visited.expression) ||
      !opaqueRoots.has(visited.expression.text) ||
      !visited.argumentExpression
    ) {
      return visited;
    }

    const keyName = getCommonFabricKeyName(
      visited.argumentExpression,
      context.checker,
    );
    if (!keyName) {
      return visited;
    }

    const rewritten = context.factory.createElementAccessExpression(
      context.factory.createIdentifier(visited.expression.text),
      context.cfHelpers.getHelperExpr(keyName),
    );
    registerReplacement(rewritten, visited, context);
    return rewritten;
  };

  if (ts.isBlock(body)) {
    return visitEachChildWithJsx(
      body,
      visit,
      context.tsContext,
    ) as ts.Block;
  }
  return visit(body) as ts.Expression;
}

function hasLocalOpaqueOriginBinding(
  body: ts.ConciseBody,
  context: TransformationContext,
): boolean {
  let found = false;

  const scan = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(node) && node !== body) return;

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (
        ts.isCallExpression(initializer) &&
        isOpaqueOriginCall(initializer, context)
      ) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, scan);
  };

  scan(body);
  return found;
}

/**
 * Pre-pass that rewrites one-line reactive-origin chains in variable
 * declarations into equivalent destructure forms, so the existing destructure
 * lowering machinery (in `lowerOpaqueDestructuredVariableStatement`) handles
 * them without further work.
 *
 * Source shapes handled:
 *   const x = wish(...).result
 *     => const { result: x } = wish(...)
 *   const x = wish(...).result.pieceRegistry
 *     => const { result: { pieceRegistry: x } } = wish(...)
 *   const { x } = wish(...).result
 *     => const { result: { x } } = wish(...)
 *   const { x } = wish(...).result.pieceRegistry
 *     => const { result: { pieceRegistry: { x } } } = wish(...)
 *
 * Non-null assertions inside the chain are dropped (they have no runtime
 * effect). Casts and parens at the root of the chain are preserved.
 *
 * The rewrite only fires when the chain bottoms out on an opaque-origin
 * call (per `isOpaqueOriginCall`) with NO intermediate named binding —
 * exactly the source shape that the existing walker can't lower in place.
 */
function rewriteInlineReactiveOriginChains(
  body: ts.ConciseBody,
  context: TransformationContext,
): ts.ConciseBody {
  const { factory } = context;

  const tryRewriteDeclaration = (
    declaration: ts.VariableDeclaration,
  ): ts.VariableDeclaration | undefined => {
    if (!declaration.initializer) return undefined;
    // Already-fine forms: declaration.initializer is a plain Identifier
    // (two-step form, already-handled) or a CallExpression directly (no
    // intermediate chain to rewrite).
    const unwrappedInitializer = unwrapExpression(declaration.initializer);
    if (ts.isIdentifier(unwrappedInitializer)) return undefined;
    if (ts.isCallExpression(unwrappedInitializer)) return undefined;
    // The initializer must be a property-access chain bottoming on an
    // opaque-origin call. Element-access (computed key) terminals don't
    // fit cleanly into a destructure pattern; skip them.
    if (
      !ts.isPropertyAccessExpression(unwrappedInitializer) &&
      !ts.isElementAccessExpression(unwrappedInitializer)
    ) {
      return undefined;
    }
    const chain = collectInlineOpaqueChain(unwrappedInitializer, context);
    if (!chain) return undefined;
    const wrappedBinding = wrapBindingPatternInDestructureChain(
      declaration.name,
      chain.segments,
      factory,
    );
    if (!wrappedBinding) return undefined;
    // Preserve cast/paren wrappers at the root of the chain so type
    // information that downstream passes rely on (schema injection)
    // stays intact. Non-null assertions on the call itself or inside the
    // chain are dropped — they're type-only and have no runtime effect.
    return factory.updateVariableDeclaration(
      declaration,
      wrappedBinding,
      declaration.exclamationToken,
      undefined, // strip the explicit type annotation — destructure pattern shape no longer matches
      chain.rootInitializer,
    );
  };

  const visit: ts.Visitor = (node) => {
    // Don't descend into nested function-like nodes; their own pattern
    // bodies get their own pass via the surrounding pipeline.
    if (ts.isFunctionLike(node) && node !== body) return node;
    if (ts.isVariableStatement(node)) {
      let changed = false;
      const newDeclarations = node.declarationList.declarations.map((decl) => {
        const rewritten = tryRewriteDeclaration(decl);
        if (rewritten) {
          changed = true;
          return rewritten;
        }
        return decl;
      });
      if (changed) {
        const newList = factory.updateVariableDeclarationList(
          node.declarationList,
          newDeclarations,
        );
        return factory.updateVariableStatement(
          node,
          node.modifiers,
          newList,
        );
      }
    }
    return ts.visitEachChild(node, visit, context.tsContext);
  };

  return ts.visitNode(body, visit) as ts.ConciseBody;
}

/**
 * Walk a property-access chain inward to its call receiver. If the receiver
 * is an opaque-origin call, return the static chain segments (innermost
 * first — i.e. the access nearest the call comes first) and the root
 * initializer with any cast/paren wrappers AROUND the call preserved (so
 * load-bearing type information like `(wish(...) as T).result` survives the
 * rewrite). Non-semantic wrappers BETWEEN accesses (e.g. `wish().result!.x`)
 * are stripped — they're type-only and have no runtime effect once the chain
 * is restructured into a destructure pattern. Returns undefined if the
 * receiver isn't an opaque-origin call or the chain contains a computed/
 * non-static access key.
 */
function collectInlineOpaqueChain(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  context: TransformationContext,
): { segments: string[]; rootInitializer: ts.Expression } | undefined {
  const segments: string[] = [];
  let current: ts.Expression = access;
  // First phase: peel access segments. Between accesses we strip parens and
  // non-null assertions (purely syntactic — no type info, no runtime effect)
  // but NOT casts/satisfies — those carry load-bearing type information that
  // downstream passes (schema injection, type-aware lowering) rely on.
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    const segment = getStaticAccessKey(current);
    if (segment === undefined) return undefined;
    segments.unshift(segment);
    current = stripSyntacticWrappers(current.expression);
  }
  if (segments.length === 0) return undefined;
  // `current` is now the call (possibly still wrapped in casts/satisfies).
  // Inspect the unwrapped form to verify it's an opaque-origin call, but
  // return `current` unchanged so any preserved wrappers stay attached.
  const unwrappedRoot = unwrapExpression(current);
  if (!ts.isCallExpression(unwrappedRoot)) return undefined;
  if (!isOpaqueOriginCall(unwrappedRoot, context)) return undefined;
  return { segments, rootInitializer: current };
}

/**
 * Strip purely syntactic wrappers (parens, non-null assertions) but preserve
 * casts and satisfies expressions, which carry type information that
 * downstream transformer passes rely on.
 */
function stripSyntacticWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isPartiallyEmittedExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function getStaticAccessKey(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(access)) {
    return access.name.text;
  }
  const arg = access.argumentExpression;
  if (ts.isStringLiteralLike(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.text;
  }
  if (ts.isNumericLiteral(arg)) {
    return arg.text;
  }
  return undefined;
}

/**
 * Given a binding pattern (or identifier) `inner` and a chain of property
 * keys [seg0, seg1, ..., segN] running from outer to inner (segment closest
 * to the call is seg0), produce the wrapped destructure pattern:
 *   { seg0: { seg1: { ... { segN: <inner> } } } }
 *
 * Returns undefined if the inner binding is incompatible (e.g. has a default
 * initializer that we can't safely preserve in this transformation).
 */
function wrapBindingPatternInDestructureChain(
  inner: ts.BindingName,
  segments: readonly string[],
  factory: ts.NodeFactory,
): ts.BindingName | undefined {
  let current: ts.BindingName = inner;
  for (let i = segments.length - 1; i >= 0; i--) {
    const key = segments[i];
    // When the inner binding is an Identifier and key matches the
    // identifier text, we could use the `{ key }` shorthand. But we
    // always emit an explicit property name to keep the rewrite legible
    // and to be safe when the binding is a nested pattern (where the
    // shorthand form is syntactically invalid).
    const propertyName = createPropertyName(key, factory);
    const element = factory.createBindingElement(
      undefined,
      propertyName,
      current,
      undefined,
    );
    current = factory.createObjectBindingPattern([element]);
  }
  return current;
}

/**
 * Emit a diagnostic for the one-line `const x = wish(...).result` shape, which
 * the body-walker cannot lower because the call result has no name binding to
 * register as a local opaque root. The two-step form (`const w = wish(...);
 * const x = w.result;`) is supported; the one-line form silently produces
 * code where `.result` is plain JS access, and downstream consumers crash
 * with `TypeError: <x>.get is not a function` (or similar) at runtime.
 *
 * This is a build-time guard so the constraint is discoverable at the
 * authoring site rather than from a runtime stack trace in a different file.
 */
function reportInlineReactiveRootAccesses(
  body: ts.ConciseBody,
  context: TransformationContext,
): void {
  const reported = new Set<ts.Node>();

  const scan = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== body) return;

    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      // Only flag source-level access sites — synthesized nodes (pos < 0)
      // come from earlier transformer passes that may have lowered
      // `(items ?? []).map(...)` or similar into a synthesized
      // `.method-on-call` shape that LOOKS like the bug but isn't
      // user-authored. This is a build-time guard for user-authored shapes.
      !isSyntheticNode(node) &&
      // Skip when this access is the callee of a method call AND its
      // immediate receiver is a reactive-origin call itself
      // (`Writable.of(...).for(...)`, `wish(...).key(...)`, etc.). Those
      // are legitimate identity-preserving / navigating method invocations
      // on the cell — not value-property reads that defeat reactivity. We
      // intentionally don't skip when the receiver is a *chain* like
      // `wish(...).result.get()`: there the `.result` defeats reactivity
      // and the trailing `.get()` is reading a value off plain JS, exactly
      // the broken shape this diagnostic exists to catch.
      !(node.parent && ts.isCallExpression(node.parent) &&
        node.parent.expression === node &&
        isDirectReactiveOriginCallReceiver(node, context))
    ) {
      // Only flag the topmost access in a chain (e.g. `wish(...).result` —
      // not `.result` deep inside a longer chain). The topmost site is
      // where the user wrote the access; reporting on inner sites would
      // duplicate the error.
      if (isTopmostMemberAccess(node)) {
        const receiver = findInlineOpaqueOriginCallReceiver(node, context);
        if (receiver && !reported.has(node)) {
          reported.add(node);
          context.reportDiagnostic({
            severity: "error",
            type: "pattern-context:inline-reactive-root-access",
            message: "Cannot read a property directly off the result of a " +
              "reactive-origin call (e.g. wish/computed) in a pattern body. " +
              "Bind the call result to a `const` first, then read the " +
              "property from the binding. For example, instead of " +
              "`const x = wish(...).result;` write " +
              "`const w = wish(...); const x = w.result;`.",
            node,
          });
        }
      }
    }

    ts.forEachChild(node, scan);
  };

  scan(body);
}

/**
 * If `access` is a property/element access chain that bottoms out on a
 * directly-invoked opaque-origin call (without an intermediate Identifier),
 * return that call expression. Otherwise return undefined.
 */
function findInlineOpaqueOriginCallReceiver(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  context: TransformationContext,
): ts.CallExpression | ts.NewExpression | undefined {
  let current: ts.Expression = access.expression;
  // Walk through any non-semantic wrappers (parens, casts) and chained
  // property/element accesses to find the receiver of the chain.
  while (true) {
    const unwrapped = unwrapExpression(current);
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      current = unwrapped.expression;
      continue;
    }
    current = unwrapped;
    break;
  }
  if (
    (ts.isCallExpression(current) || ts.isNewExpression(current)) &&
    isOpaqueOriginCall(current, context)
  ) {
    return current;
  }
  return undefined;
}

/**
 * True when `access`'s immediate receiver (after stripping non-semantic
 * wrappers) is itself a reactive-origin call. Used to distinguish
 * `Writable.of(...).for(...)` / `wish(...).key(...)` (legitimate cell methods
 * on the call result) from chains like `wish(...).result.get()` where the
 * receiver of `.get` is a *property access* on the call, not the call itself.
 */
function isDirectReactiveOriginCallReceiver(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  context: TransformationContext,
): boolean {
  const receiver = unwrapExpression(access.expression);
  return (ts.isCallExpression(receiver) || ts.isNewExpression(receiver)) &&
    isOpaqueOriginCall(receiver, context);
}

function collectBindingNames(
  name: ts.BindingName,
  names: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    collectBindingNames(element.name, names);
  }
}
