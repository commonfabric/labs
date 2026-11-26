import ts from "typescript";

import {
  createReactiveWrapperForExpression,
  hasSyntheticComputeCallbackAncestor,
  isAlreadySyntheticComputeOwned,
} from "../rewrite-helpers.ts";
import { isCellReadTerminalCall } from "../../call-root-support.ts";
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
  return ts.isCallExpression(expression) &&
    isCellReadTerminalCall(expression, context);
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
