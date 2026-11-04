import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createIfElseCall } from "../../builtins/ifelse.ts";
import {
  isSimpleReactiveAccessExpression,
  registerSyntheticCallType,
  selectDataFlowsReferencedIn,
} from "../../../ast/mod.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import {
  findPendingComputeWrapCandidate,
  isJsxLocalRewriteContainer,
  resolveComputeWrapCandidate,
} from "./compute-wrap-invariants.ts";
import { unwrapExpression } from "../../../utils/expression.ts";

function isControlFlowBranchExpression(expr: ts.Expression): boolean {
  const current = unwrapExpression(expr);
  return ts.isConditionalExpression(current) ||
    (
      ts.isBinaryExpression(current) &&
      (
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken
      )
    );
}

function isLogicalControlFlowExpression(expr: ts.Expression): boolean {
  const current = unwrapExpression(expr);
  return ts.isBinaryExpression(current) &&
    (
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken
    );
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

function processBranch(
  expr: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
  analyze: Parameters<Emitter>[0]["analyze"],
  rewriteChildren: Parameters<Emitter>[0]["rewriteChildren"],
  rewriteSubexpression: Parameters<Emitter>[0]["rewriteSubexpression"],
  preferInputBoundWrappers: boolean,
): ts.Expression {
  if (isJsxLocalRewriteContainer(expr)) {
    return rewriteChildren(expr) || expr;
  }

  if (isControlFlowBranchExpression(expr)) {
    return rewriteSubexpression(expr) || expr;
  }

  const branchAnalysis = analyze(expr);
  const branchDataFlows = context.getRelevantDataFlowsFromAnalysis(
    branchAnalysis,
  );

  const pendingRewrite = branchDataFlows.length > 0
    ? findPendingComputeWrapCandidate(expr, analyze, context)
    : undefined;

  if (pendingRewrite) {
    if (
      hasSyntheticComputeCallbackAncestor(pendingRewrite, context) ||
      isAlreadySyntheticComputeOwned(pendingRewrite, context)
    ) {
      return rewriteChildren(expr) || expr;
    }

    const decision = resolveComputeWrapCandidate(
      pendingRewrite,
      expr,
      "ternary branch",
      context,
    );
    if (decision.kind === "skip-reported") {
      return rewriteChildren(expr) || expr;
    }

    const derived = createReactiveWrapperForExpression(
      expr,
      branchDataFlows,
      context,
      {
        preferInputBoundWrapper: preferInputBoundWrappers,
        filterNestedFunctionLocalCaptures: true,
      },
    );
    if (derived) {
      return derived;
    }
  }

  return rewriteChildren(expr) || expr;
}

export const emitConditionalExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analyze,
  rewriteChildren,
  rewriteSubexpression,
  inSafeContext,
  preferInputBoundWrappers,
}) => {
  if (!ts.isConditionalExpression(expression)) return undefined;

  if (inSafeContext) return undefined;
  if (dataFlows.length === 0) return undefined;

  const predicateDataFlows = selectDataFlowsReferencedIn(
    dataFlows,
    expression.condition,
  );
  const shouldDerivePredicate = predicateDataFlows.length > 0 &&
    !isSimpleReactiveAccessExpression(expression.condition, context.checker);

  let predicate: ts.Expression = expression.condition;
  if (isLogicalControlFlowExpression(expression.condition)) {
    predicate = rewriteSubexpression(expression.condition);
  } else if (shouldDerivePredicate) {
    const derivedPredicate = createReactiveWrapperForExpression(
      expression.condition,
      predicateDataFlows,
      context,
      { preferInputBoundWrapper: preferInputBoundWrappers },
    );
    if (derivedPredicate) {
      predicate = derivedPredicate;
    }
  }

  const whenTrue = processBranch(
    expression.whenTrue,
    context,
    analyze,
    rewriteChildren,
    rewriteSubexpression,
    preferInputBoundWrappers,
  );

  const whenFalse = processBranch(
    expression.whenFalse,
    context,
    analyze,
    rewriteChildren,
    rewriteSubexpression,
    preferInputBoundWrappers,
  );

  const ifElseCall = createIfElseCall({
    expression,
    factory: context.factory,
    cfHelpers: context.cfHelpers,
    sourceFile: context.sourceFile,
    overrides: {
      predicate,
      whenTrue,
      whenFalse,
    },
  });

  const resultType = context.checker.getTypeAtLocation(expression);
  registerSyntheticCallType(
    ifElseCall,
    resultType,
    context.state.typeRegistry,
  );

  return ifElseCall;
};
