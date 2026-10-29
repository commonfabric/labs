import ts from "typescript";
import { getCellKind } from "@commonfabric/schema-generator/cell-brand";

import { classifyOpaquePathTerminalCall } from "../../opaque-roots.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import {
  findPendingComputeWrapCandidate,
  isJsxLocalRewriteContainer,
  resolveComputeWrapCandidate,
} from "./compute-wrap-invariants.ts";
import { isValueComputationExpressionKind } from "../../../utils/expression.ts";
import type { Emitter } from "../types.ts";

function isHelperOwnedCellGetExpression(
  expression: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
): expression is ts.CallExpression {
  if (
    !ts.isCallExpression(expression) ||
    classifyOpaquePathTerminalCall(expression) !== "get"
  ) {
    return false;
  }

  const callee = expression.expression;
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return false;
  }

  try {
    const receiverType = context.checker.getTypeAtLocation(callee.expression);
    const cellKind = getCellKind(receiverType, context.checker);
    return cellKind === "cell" || cellKind === "stream";
  } catch {
    return false;
  }
}

function hasSyntheticComputeCallbackAncestor(
  node: ts.Node,
  context: Parameters<Emitter>[0]["context"],
): boolean {
  let current = node.parent;
  while (current) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      context.isSyntheticComputeCallback(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isAlreadySyntheticComputeOwned(
  node: ts.Node,
  context: Parameters<Emitter>[0]["context"],
): boolean {
  return context.getReactiveContext(node).kind === "compute" &&
    context.isSyntheticComputeOwnedNode(node);
}

interface RewriteHelperOwnedExpressionParams {
  readonly expression: ts.Expression;
  readonly containerLabel: string;
  readonly assertContainer?: ts.Expression;
  readonly context: Parameters<Emitter>[0]["context"];
  readonly analyze: Parameters<Emitter>[0]["analyze"];
  readonly rewriteChildren: Parameters<Emitter>[0]["rewriteChildren"];
}

export function rewriteHelperOwnedExpression(
  params: RewriteHelperOwnedExpressionParams,
): ts.Expression {
  const {
    expression,
    containerLabel,
    assertContainer,
    context,
    analyze,
    rewriteChildren,
  } = params;

  // JSX containers can rewrite their dynamic slots locally via ReactiveJSX.
  // Wrapping the whole helper-owned branch here would force later passes to
  // disagree about nested collection lowering.
  if (isJsxLocalRewriteContainer(expression)) {
    return rewriteChildren(expression) || expression;
  }

  const analysis = analyze(expression);
  const relevantDataFlows = context.getRelevantDataFlowsFromAnalysis(analysis);

  const pendingRewrite = relevantDataFlows.length > 0
    ? findPendingComputeWrapCandidate(expression, analyze, context)
    : undefined;

  if (
    pendingRewrite &&
    !hasSyntheticComputeCallbackAncestor(pendingRewrite, context) &&
    !isAlreadySyntheticComputeOwned(pendingRewrite, context)
  ) {
    const decision = resolveComputeWrapCandidate(
      pendingRewrite,
      assertContainer ?? expression,
      containerLabel,
      context,
    );
    if (decision.kind === "skip-reported") {
      // Skip the forced value-lift below too — it would wrap the very
      // computation the guard refused.
      return expression;
    }

    const derived = createReactiveWrapperForExpression(
      expression,
      relevantDataFlows,
      context,
      { filterNestedFunctionLocalCaptures: true },
    );
    if (derived) {
      return derived;
    }
  }

  if (
    relevantDataFlows.length > 0 &&
    (
      isValueComputationExpressionKind(expression) ||
      isHelperOwnedCellGetExpression(expression, context)
    )
  ) {
    const forced = createReactiveWrapperForExpression(
      expression,
      relevantDataFlows,
      context,
      {
        allowDirectExpressionWrap: true,
        filterNestedFunctionLocalCaptures: true,
      },
    );
    if (forced) {
      return forced;
    }
  }

  return rewriteChildren(expression) || expression;
}
