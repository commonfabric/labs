import ts from "typescript";
import {
  detectCallKind,
  isCollectionType,
  isFunctionLikeExpression,
  isSyntheticNode,
  preserveSourceMapRange,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import { shouldTransformArrayMethod } from "../closures/strategies/array-method-policy.ts";
import { transformArrayMethodCallback } from "../closures/strategies/array-method-transform.ts";
import {
  classifyExpressionSiteHandling,
  containsLogicalBinaryOperator,
  findLowerableExpressionSite,
  findPreferredNestedLowerableExpressionSite,
  getExpressionContainerKind,
  isArrayMethodValueLiftOwner,
  isControlFlowRewriteExpression,
  isDirectArrayMethodRootExpression,
  shouldPreferArrayMethodSharedCallRootSite,
} from "./expression-site-policy.ts";
import { rewriteExpression } from "./expression-rewrite/mod.ts";
import {
  createReactiveWrapperForExpression,
} from "./expression-rewrite/rewrite-helpers.ts";
import type { AnalyzeFn } from "./expression-rewrite/types.ts";
import type { ExpressionContainerKind } from "./expression-site-types.ts";
import { createLiftAppliedCall } from "./builtins/lift-applied.ts";
import {
  classifyOpaquePathTerminalCall,
  isLocalOpaqueOriginBindingReference,
} from "./opaque-roots.ts";

interface RewriteExpressionSiteParams {
  readonly expression: ts.Expression;
  readonly containerKind: ExpressionContainerKind;
  readonly context: TransformationContext;
  readonly analyze: AnalyzeFn;
  readonly visit: ts.Visitor;
  readonly preferInputBoundWrappers?: boolean;
}

function getReactiveHelperWrapperKind(
  expression: ts.Expression,
  context: TransformationContext,
): "lift-applied" | "ifElse" | "when" | "unless" | undefined {
  if (!ts.isCallExpression(expression)) {
    return undefined;
  }

  const callKind = detectCallKind(expression, context.checker)?.kind;
  if (
    callKind === "lift-applied" ||
    callKind === "ifElse" ||
    callKind === "when" ||
    callKind === "unless"
  ) {
    return callKind;
  }

  return undefined;
}

function isDirectLiftAppliedCall(
  expression: ts.Expression,
  context: TransformationContext,
): expression is ts.CallExpression {
  return getReactiveHelperWrapperKind(expression, context) === "lift-applied";
}

function isReactiveHelperWrapperCall(
  expression: ts.Expression,
  context: TransformationContext,
): expression is ts.CallExpression {
  return getReactiveHelperWrapperKind(expression, context) !== undefined;
}

export function isSyntheticHelperWrapperInArrayMethodCallback(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  if (
    !isSyntheticNode(expression) ||
    !isReactiveHelperWrapperCall(expression, context)
  ) {
    return false;
  }

  let current: ts.Node | undefined = expression.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return context.isArrayMethodCallback(current);
    }
    current = current.parent;
  }

  return false;
}

function isArrayLikeReceiverType(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return isCollectionType(checker.getTypeAtLocation(expression), checker);
}

function markSyntheticReactiveCollectionDeclarationIfNeeded(
  original: ts.VariableDeclaration,
  rewritten: ts.VariableDeclaration,
  context: TransformationContext,
): void {
  const rewrittenOriginal = rewritten.initializer
    ? ts.getOriginalNode(rewritten.initializer)
    : undefined;
  if (
    !rewritten.initializer ||
    (
      rewrittenOriginal === rewritten.initializer &&
      !isSyntheticNode(rewritten.initializer)
    ) ||
    !isReactiveHelperWrapperCall(
      rewritten.initializer,
      context,
    ) ||
    !ts.isIdentifier(original.name) ||
    !isArrayLikeReceiverType(original.name, context.checker)
  ) {
    return;
  }
  context.markSyntheticReactiveCollectionDeclaration(original);
  context.markSyntheticReactiveCollectionDeclaration(rewritten);
}

function getTerminalGetReceiver(
  expression: ts.Expression,
): ts.Expression | undefined {
  if (
    !ts.isCallExpression(expression) ||
    classifyOpaquePathTerminalCall(expression) !== "get"
  ) {
    return undefined;
  }

  const callee = expression.expression;
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return undefined;
  }

  return callee.expression;
}

function getEnclosingZeroArgInlineIifeCall(
  node: ts.Node,
): ts.CallExpression | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      let callee: ts.Node = current;
      let parent = callee.parent;
      while (
        parent &&
        ts.isParenthesizedExpression(parent) &&
        parent.expression === callee
      ) {
        callee = parent;
        parent = callee.parent;
      }

      if (
        parent &&
        ts.isCallExpression(parent) &&
        parent.expression === callee &&
        parent.arguments.length === 0
      ) {
        return parent;
      }

      return undefined;
    }

    current = current.parent;
  }

  return undefined;
}

function rewriteDirectCellGetInitializer(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: AnalyzeFn,
): ts.Expression | undefined {
  const iifeCall = getEnclosingZeroArgInlineIifeCall(expression);
  if (
    !iifeCall ||
    context.getReactiveContext(iifeCall).kind !== "pattern" ||
    context.getReactiveContext(expression).kind !== "pattern"
  ) {
    return undefined;
  }

  const receiver = getTerminalGetReceiver(expression);
  if (!receiver) {
    return undefined;
  }

  const analysis = analyze(expression);
  const relevantDataFlows = context.getRelevantDataFlowsFromAnalysis(analysis);
  const wrapped = createReactiveWrapperForExpression(
    expression,
    relevantDataFlows,
    context,
    {
      allowDirectExpressionWrap: true,
      preferInputBoundWrapper: true,
    },
  );
  if (wrapped) {
    return wrapped;
  }

  return createLiftAppliedCall(expression, [receiver], {
    factory: context.factory,
    tsContext: context.tsContext,
    cfHelpers: context.cfHelpers,
    context,
  });
}

function rewriteLateArrayMethodCallbackCall(
  node: ts.CallExpression,
  context: TransformationContext,
  visit: ts.Visitor,
): ts.CallExpression | undefined {
  // Read the callback through paren spelling — a blind read here skips the
  // lowering and a raw reactive method call reaches the runtime.
  const callback = node.arguments[0] && unwrapExpression(node.arguments[0]);
  if (!callback || !isFunctionLikeExpression(callback)) {
    return undefined;
  }

  if (!shouldTransformArrayMethod(node, context)) {
    return undefined;
  }

  return transformArrayMethodCallback(
    node,
    callback,
    context,
    visit,
    {
      rewriteTransformedBody: rewriteArrayMethodCallbackExpressionSites,
    },
  );
}

export function rewriteExpressionSite(
  params: RewriteExpressionSiteParams,
): ts.Expression | undefined {
  const {
    expression,
    containerKind,
    context,
    analyze,
    visit,
    preferInputBoundWrappers = false,
  } = params;

  const handling = classifyExpressionSiteHandling(
    expression,
    containerKind,
    context,
    analyze,
  );
  if (handling.kind !== "shared") {
    return undefined;
  }

  if (!handling.lowerable) {
    return undefined;
  }

  const contextInfo = context.getReactiveContext(expression);
  const analysis = analyze(expression);
  const hasLogicalOps = containsLogicalBinaryOperator(expression);
  const controlFlowNeedsRewrite = containerKind === "jsx-expression" &&
    isControlFlowRewriteExpression(expression) &&
    analysis.containsReactive;

  if (!analysis.requiresRewrite && !hasLogicalOps && !controlFlowNeedsRewrite) {
    return undefined;
  }

  if (!hasLogicalOps) {
    const relevantDataFlows = context.getRelevantDataFlowsFromAnalysis(
      analysis,
    );
    if (
      shouldDeferToLateInPlaceLowering(
        context,
        expression,
        relevantDataFlows,
      )
    ) {
      return undefined;
    }
  }

  const result = rewriteExpression({
    expression,
    analysis,
    context,
    analyze,
    reactiveContextKind: contextInfo.kind,
    inSafeContext: contextInfo.kind === "compute",
    containerKind,
    preferInputBoundWrappers,
  });

  if (!result) {
    return undefined;
  }

  if (preferInputBoundWrappers && isDirectLiftAppliedCall(result, context)) {
    return result;
  }

  // A rewritten receiver can establish collection ownership. Register its
  // callback before visiting the body so local predicates read reactive values.
  if (ts.isCallExpression(result) && ts.isCallExpression(expression)) {
    const callback = expression.arguments[0];
    if (callback && isFunctionLikeExpression(unwrapExpression(callback))) {
      const withCallback = context.factory.updateCallExpression(
        result,
        result.expression,
        result.typeArguments,
        [callback, ...result.arguments.slice(1)],
      );
      const rewrittenArrayMethod = rewriteLateArrayMethodCallbackCall(
        withCallback,
        context,
        visit,
      );
      if (rewrittenArrayMethod) return rewrittenArrayMethod;
    }
  }

  return visitEachChildWithJsx(
    result,
    visit,
    context.tsContext,
  ) as ts.Expression;
}

// Shared rewrite entrypoint for explicit owned pre-closure JSX roots.
export function rewriteOwnedPreClosureJsxExpressionSite(
  params: Omit<RewriteExpressionSiteParams, "containerKind">,
): ts.Expression | undefined {
  const {
    expression,
    context,
    analyze,
    visit,
    preferInputBoundWrappers = false,
  } = params;

  const contextInfo = context.getReactiveContext(expression);
  const inSafeContext = contextInfo.kind === "compute";
  const analysis = analyze(expression);
  const hasLogicalOps = containsLogicalBinaryOperator(expression);

  if (inSafeContext) {
    return undefined;
  }

  if (!analysis.requiresRewrite && !hasLogicalOps) {
    return undefined;
  }

  // Defer to late in-place lowering when this JSX expression is just an
  // element-member read (or passthrough container thereof). The late
  // `pattern-body-reactive-root-lowering` pass will rewrite `elem.foo` to
  // `elem.key("foo")` in place, producing `{elem.key("foo")}` directly in
  // the JSX rather than a lift-applied wrapper like
  // `{__cfHelpers.lift(({elem}) => elem.foo)({elem})}`. The in-place form
  // encodes the same reactive dependency more cheaply and doesn't pull the
  // whole element binding into a lift-applied call's inputs.
  const relevantDataFlows = context.getRelevantDataFlowsFromAnalysis(analysis);
  if (
    !hasLogicalOps &&
    shouldDeferToLateInPlaceLowering(context, expression, relevantDataFlows)
  ) {
    return undefined;
  }

  const result = rewriteExpression({
    expression,
    analysis,
    context,
    analyze,
    reactiveContextKind: contextInfo.kind,
    inSafeContext,
    containerKind: "jsx-expression",
    preferInputBoundWrappers,
  });

  if (!result) {
    return undefined;
  }

  if (preferInputBoundWrappers && isDirectLiftAppliedCall(result, context)) {
    return result;
  }

  return visitEachChildWithJsx(
    result,
    visit,
    context.tsContext,
  ) as ts.Expression;
}

export function rewriteHelperOwnedExpressionSites<T extends ts.Node>(
  root: T,
  context: TransformationContext,
): T {
  const analyze = context.getDataFlowAnalyzer();

  const visit: ts.Visitor = (node) => {
    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (ts.isVariableDeclaration(node) && ts.isVariableDeclaration(visited)) {
      let rewrittenDeclaration = visited;
      if (visited.initializer) {
        const rewrittenInitializer = rewriteDirectCellGetInitializer(
          visited.initializer,
          context,
          analyze,
        );
        if (rewrittenInitializer) {
          rewrittenDeclaration = context.factory.updateVariableDeclaration(
            visited,
            visited.name,
            visited.exclamationToken,
            visited.type,
            rewrittenInitializer,
          );
        }
      }
      markSyntheticReactiveCollectionDeclarationIfNeeded(
        node,
        rewrittenDeclaration,
        context,
      );
      return rewrittenDeclaration;
    }

    if (ts.isExpression(visited)) {
      if (ts.isCallExpression(visited)) {
        const rewrittenArrayMethod = rewriteLateArrayMethodCallbackCall(
          visited,
          context,
          visit,
        );
        if (rewrittenArrayMethod) {
          return rewrittenArrayMethod;
        }
      }

      const containerKind = getExpressionContainerKind(visited);
      if (containerKind) {
        const handling = classifyExpressionSiteHandling(
          visited,
          containerKind,
          context,
          analyze,
        );
        if (
          handling.kind !== "owned" ||
          handling.owner !== "helper"
        ) {
          return visited;
        }
        if (!handling.lowerable) {
          return visited;
        }
        const analysis = analyze(visited);
        const result = rewriteExpression({
          expression: visited,
          analysis,
          context,
          analyze,
          reactiveContextKind: "pattern",
          inSafeContext: false,
          containerKind,
          preferInputBoundWrappers: true,
        });
        if (result) {
          return result;
        }
      }
    }

    return visited;
  };

  const rewritten = ts.visitNode(root, visit) as T;

  const lateArrayMethodVisit: ts.Visitor = (node) => {
    const visited = visitEachChildWithJsx(
      node,
      lateArrayMethodVisit,
      context.tsContext,
    );

    if (ts.isCallExpression(visited)) {
      return rewriteLateArrayMethodCallbackCall(
        visited,
        context,
        lateArrayMethodVisit,
      ) ?? visited;
    }

    return visited;
  };

  return ts.visitNode(rewritten, lateArrayMethodVisit) as T;
}

export function rewritePatternOwnedExpressionSites<T extends ts.Node>(
  root: T,
  context: TransformationContext,
): T {
  const analyze = context.getDataFlowAnalyzer();

  const visit: ts.Visitor = (node) => {
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      context.isSyntheticComputeCallback(node)
    ) {
      return node;
    }

    if (ts.isVariableDeclaration(node)) {
      if (
        node.initializer && isFunctionLikeExpression(node.initializer)
      ) {
        return node;
      }

      const visited = visitEachChildWithJsx(node, visit, context.tsContext);
      if (ts.isVariableDeclaration(visited)) {
        markSyntheticReactiveCollectionDeclarationIfNeeded(
          node,
          visited,
          context,
        );
      }
      return visited;
    }

    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      context.isArrayMethodCallback(node) &&
      !ts.isBlock(node.body)
    ) {
      return node;
    }

    if (ts.isJsxExpression(node)) {
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const handling = classifyExpressionSiteHandling(
        node.expression,
        "jsx-expression",
        context,
        analyze,
      );
      if (
        handling.kind !== "shared" ||
        (handling.jsxRoute ?? "shared-post-closure") !==
          "shared-post-closure"
      ) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const rewritten = rewriteExpressionSite({
        expression: node.expression,
        containerKind: "jsx-expression",
        context,
        analyze,
        visit,
        preferInputBoundWrappers: true,
      });
      if (rewritten) {
        return preserveSourceMapRange(
          context.factory.createJsxExpression(
            node.dotDotDotToken,
            rewritten,
          ),
          node,
        );
      }

      return visitEachChildWithJsx(node, visit, context.tsContext);
    }

    if (ts.isExpression(node)) {
      if (ts.isCallExpression(node)) {
        const rewrittenArrayMethod = rewriteLateArrayMethodCallbackCall(
          node,
          context,
          visit,
        );
        if (rewrittenArrayMethod) {
          return rewrittenArrayMethod;
        }
      }

      const containerKind = getExpressionContainerKind(node);
      if (containerKind) {
        if (containerKind === "jsx-expression") {
          return visitEachChildWithJsx(node, visit, context.tsContext);
        }

        // Array-method callback lowering may already have produced a synthetic
        // helper wrapper (lift-applied/ifElse/when/unless) for this subtree.
        // When that happens, the later pattern-owned pass should not re-enter
        // the wrapper root and compete for ownership again.
        if (isSyntheticHelperWrapperInArrayMethodCallback(node, context)) {
          return node;
        }

        const rewritten = rewriteExpressionSite({
          expression: node,
          containerKind,
          context,
          analyze,
          visit,
          preferInputBoundWrappers: true,
        });
        if (rewritten) {
          return rewritten;
        }
      }
    }

    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return ts.visitNode(root, visit) as T;
}

/**
 * Find the leftmost identifier in a dataflow expression — the "root" of a
 * `foo`, `foo.bar`, `foo.bar.baz`, or `foo.key("bar")` chain.
 */
function getDataFlowRootIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  let current: ts.Expression = expression;
  while (true) {
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "key"
    ) {
      current = current.expression.expression;
      continue;
    }
    break;
  }
  return ts.isIdentifier(current) ? current : undefined;
}

/**
 * True when every relevant dataflow can remain as a key-specific reactive
 * value until the late pattern-body lowering pass.
 */
function allDataFlowsSupportLateInPlaceLowering(
  context: TransformationContext,
  dataFlows: readonly { readonly expression: ts.Expression }[],
): boolean {
  if (dataFlows.length === 0) return false;
  for (const dataFlow of dataFlows) {
    const root = getDataFlowRootIdentifier(dataFlow.expression);
    if (!root) return false;
    if (
      !context.isArrayMethodElementBindingReference(root) &&
      !isLocalOpaqueOriginBindingReference(root, context)
    ) return false;
  }
  return true;
}

/**
 * True when the expression is a "pass-through container" — it holds other
 * expressions without computing a value of its own. Late
 * `pattern-body-reactive-root-lowering` will descend into it and rewrite
 * `elem.foo` reads to `elem.key("foo")` in-place. For these shapes the
 * early lift-applied wrap is unnecessary and produces broader output.
 *
 * In contrast, computations (BinaryExpression, ConditionalExpression,
 * CallExpression, etc.) produce a new value and *must* be wrapped in a
 * lift-applied call at the early stage; otherwise the resulting value
 * would be a one-shot snapshot rather than a reactive cell.
 */
function isPassthroughContainerExpression(
  expression: ts.Expression,
): boolean {
  const current = unwrapExpression(expression);
  return ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isObjectLiteralExpression(current) ||
    ts.isArrayLiteralExpression(current);
}

/**
 * Combined gate: the early lift-applied wrap should defer to late in-place
 * lowering for an expression whose only reactive content is member access on
 * an array element or local opaque-origin binding AND whose shape doesn't
 * produce a new value of its own. Both conditions are required:
 *
 *   - A supported reactive root alone isn't enough: a computation like
 *     `elem.type === "folder"` still needs an early wrap to be reactive,
 *     even though its only reactive read is `elem.type`.
 *
 *   - Passthrough-shape alone isn't enough: an array literal `[outerCell]`
 *     needs an early wrap if it captures a non-element reactive value.
 */
function shouldDeferToLateInPlaceLowering(
  context: TransformationContext,
  expression: ts.Expression,
  dataFlows: readonly { readonly expression: ts.Expression }[],
): boolean {
  return allDataFlowsSupportLateInPlaceLowering(context, dataFlows) &&
    isPassthroughContainerExpression(expression);
}

export function rewriteArrayMethodCallbackExpressionSites(
  body: ts.ConciseBody,
  context: TransformationContext,
): ts.ConciseBody {
  const analyze = context.getDataFlowAnalyzer();

  const rewriteArrayMethodOwnedReceiverMethodExpressionSite = (
    expression: ts.Expression,
  ): ts.Expression | undefined => {
    const lowerableSite = findLowerableExpressionSite(
      expression,
      context,
      analyze,
    );
    if (lowerableSite && lowerableSite.expression !== expression) {
      return undefined;
    }

    const containerKind = expression === body
      ? "return-expression"
      : getExpressionContainerKind(expression);
    if (!containerKind || containerKind === "jsx-expression") {
      return undefined;
    }

    const handling = classifyExpressionSiteHandling(
      expression,
      containerKind,
      context,
      analyze,
    );
    if (
      handling.kind !== "owned" ||
      !isArrayMethodValueLiftOwner(handling.owner) ||
      !handling.lowerable
    ) {
      return undefined;
    }

    const analysis = analyze(expression);
    const relevantDataFlows = context.getRelevantDataFlowsFromAnalysis(
      analysis,
    );
    if (relevantDataFlows.length === 0) {
      return undefined;
    }
    if (
      shouldDeferToLateInPlaceLowering(context, expression, relevantDataFlows)
    ) {
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

  const wrapArrayMethodCallbackLocalExpression = (
    expression: ts.Expression,
    options: {
      allowDirectExpressionWrap?: boolean;
    } = {},
  ): ts.Expression | undefined => {
    const analysis = analyze(expression);
    if (analysis.containsReactive && analysis.requiresRewrite) {
      const relevantDataFlows = context.getRelevantDataFlowsFromAnalysis(
        analysis,
      );
      if (relevantDataFlows.length === 0) {
        return undefined;
      }
      if (
        shouldDeferToLateInPlaceLowering(context, expression, relevantDataFlows)
      ) {
        return undefined;
      }

      return createReactiveWrapperForExpression(
        expression,
        relevantDataFlows,
        context,
        {
          allowDirectExpressionWrap: options.allowDirectExpressionWrap,
          preferInputBoundWrapper: true,
        },
      );
    }

    return undefined;
  };

  const rewriteArrayMethodCallbackExpressionStatement = (
    expression: ts.Expression,
  ): ts.Expression | undefined => {
    if (isDirectArrayMethodRootExpression(expression)) {
      return undefined;
    }

    return wrapArrayMethodCallbackLocalExpression(expression);
  };

  const rewriteSkippedArrayMethodCallbackInitializer = (
    expression: ts.Expression,
  ): ts.Expression | undefined => {
    if (isFunctionLikeExpression(expression)) {
      return undefined;
    }

    if (isControlFlowRewriteExpression(expression)) {
      return undefined;
    }

    const handling = classifyExpressionSiteHandling(
      expression,
      "variable-initializer",
      context,
      analyze,
    );
    if (handling.kind !== "skip" || handling.reason !== "not-lowerable") {
      return undefined;
    }

    if (
      !shouldPreferArrayMethodSharedCallRootSite(
        expression,
        context,
        analyze,
      ) &&
      findPreferredNestedLowerableExpressionSite(expression, context, analyze)
    ) {
      return undefined;
    }

    return wrapArrayMethodCallbackLocalExpression(expression, {
      allowDirectExpressionWrap: true,
    });
  };

  const visit: ts.Visitor = (node) => {
    if (
      node !== body &&
      ts.isFunctionLike(node)
    ) {
      return node;
    }

    if (ts.isJsxExpression(node)) {
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (isDirectArrayMethodRootExpression(node.expression)) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const handling = classifyExpressionSiteHandling(
        node.expression,
        "jsx-expression",
        context,
        analyze,
      );
      if (
        handling.kind === "owned" &&
        handling.owner === "array-method-callback-jsx" &&
        handling.lowerable
      ) {
        const rewritten = rewriteOwnedPreClosureJsxExpressionSite({
          expression: node.expression,
          context,
          analyze,
          visit,
          preferInputBoundWrappers: true,
        });
        if (rewritten) {
          return preserveSourceMapRange(
            context.factory.createJsxExpression(
              node.dotDotDotToken,
              rewritten,
            ),
            node,
          );
        }
      }

      return visitEachChildWithJsx(node, visit, context.tsContext);
    }

    if (ts.isExpressionStatement(node)) {
      const rewritten = rewriteArrayMethodCallbackExpressionStatement(
        node.expression,
      );
      if (rewritten) {
        return context.factory.updateExpressionStatement(node, rewritten);
      }

      return visitEachChildWithJsx(node, visit, context.tsContext);
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const rewritten = rewriteSkippedArrayMethodCallbackInitializer(
        node.initializer,
      );
      if (rewritten) {
        return context.factory.updateVariableDeclaration(
          node,
          node.name,
          node.exclamationToken,
          node.type,
          rewritten,
        );
      }
    }

    if (ts.isExpression(node)) {
      const containerKind = node === body
        ? "return-expression"
        : getExpressionContainerKind(node);
      if (containerKind && containerKind !== "jsx-expression") {
        const callbackOwnedReceiverRewrite =
          rewriteArrayMethodOwnedReceiverMethodExpressionSite(node);
        if (callbackOwnedReceiverRewrite) {
          return callbackOwnedReceiverRewrite;
        }

        const rewritten = rewriteExpressionSite({
          expression: node,
          containerKind,
          context,
          analyze,
          visit,
          preferInputBoundWrappers: true,
        });
        if (rewritten) {
          return rewritten;
        }
      }
    }

    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return ts.visitNode(body, visit) as ts.ConciseBody;
}
