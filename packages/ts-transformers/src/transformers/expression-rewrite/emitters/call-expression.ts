import ts from "typescript";

import type { Emitter } from "../types.ts";
import {
  classifyArrayMethodResultSinkCall,
  classifyArrayMethodResultSinkReceiverChainCall,
  detectCallKind,
  isSyntheticNode,
} from "../../../ast/mod.ts";
import { getCellKind } from "../../cell-type.ts";
import { unwrapParentheses } from "../../../utils/expression.ts";
import { classifyOpaquePathTerminalCall } from "../../opaque-roots.ts";
import { createLiftAppliedCall } from "../../builtins/lift-applied.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import { rewriteHelperOwnedExpression } from "./helper-owned-expression.ts";

function isZeroArgInlineIifeCall(
  expression: ts.CallExpression,
): expression is ts.CallExpression & {
  expression:
    | ts.ParenthesizedExpression
    | ts.ArrowFunction
    | ts.FunctionExpression;
} {
  return getZeroArgInlineIifeCallee(expression) !== undefined;
}

function getZeroArgInlineIifeCallee(
  expression: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (expression.arguments.length !== 0) {
    return undefined;
  }

  // Parentheses only: a callee under a type assertion is not recognized as an
  // inline IIFE — the assertion re-types the call, and the general call
  // lowering handles it.
  const callee = unwrapParentheses(expression.expression);

  return ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)
    ? callee
    : undefined;
}

function isZeroArgGetCall(expression: ts.CallExpression): boolean {
  if (expression.arguments.length !== 0) {
    return false;
  }

  if (classifyOpaquePathTerminalCall(expression) === "get") {
    return true;
  }

  const callee = expression.expression;
  return (
    ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee)
  ) &&
    (
      ts.isPropertyAccessExpression(callee)
        ? callee.name.text === "get"
        : ts.isStringLiteralLike(callee.argumentExpression) &&
          callee.argumentExpression.text === "get"
    );
}

function getZeroArgGetReceiver(
  expression: ts.CallExpression,
): ts.Expression | undefined {
  if (!isZeroArgGetCall(expression)) {
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

function isDeclaredInside(
  expression: ts.Expression,
  container: ts.Node,
  context: Parameters<Emitter>[0]["context"],
): boolean {
  if (!ts.isIdentifier(expression)) {
    return false;
  }

  const symbol = context.checker.getSymbolAtLocation(expression);
  const declarations = symbol?.getDeclarations() ?? [];
  return declarations.some((declaration) => {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (current === container) {
        return true;
      }
      current = current.parent;
    }
    return false;
  });
}

function collectUnsafeIifeGetReceivers(
  expression: ts.CallExpression,
  context: Parameters<Emitter>[0]["context"],
): ts.Expression[] {
  const iifeCallee = getZeroArgInlineIifeCallee(expression);
  if (!iifeCallee) {
    return [];
  }

  const receivers: ts.Expression[] = [];

  const visit = (node: ts.Node, syntheticComputeDepth: number): void => {
    const isFunctionLike = ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node);
    if (isFunctionLike) {
      const isRootIife = node === iifeCallee;
      const isSyntheticCompute = context.isSyntheticComputeCallback(node);
      if (!isRootIife && !isSyntheticCompute) {
        return;
      }
      const nextDepth = syntheticComputeDepth + (isSyntheticCompute ? 1 : 0);
      ts.forEachChild(node, (child) => visit(child, nextDepth));
      return;
    }

    if (
      syntheticComputeDepth === 0 &&
      ts.isCallExpression(node) &&
      isZeroArgGetCall(node)
    ) {
      const receiver = getZeroArgGetReceiver(node);
      if (
        receiver &&
        !isDeclaredInside(receiver, iifeCallee, context) &&
        !receivers.includes(receiver)
      ) {
        receivers.push(receiver);
      }
      return;
    }

    ts.forEachChild(node, (child) => visit(child, syntheticComputeDepth));
  };

  visit(iifeCallee.body, 0);
  return receivers;
}

function getConditionalHelperArgLabel(
  helperName: "ifElse" | "when" | "unless",
  index: number,
): string {
  if (helperName === "ifElse") {
    if (index === 0) return "ifElse condition";
    if (index === 1) return "ifElse true branch";
    return "ifElse false branch";
  }

  if (helperName === "when") {
    return index === 0 ? "when condition" : "when value";
  }

  return index === 0 ? "unless condition" : "unless value";
}

function shouldFilterNestedLocalsForCallWrapper(
  expression: ts.CallExpression,
  context: Parameters<Emitter>[0]["context"],
  analyze: Parameters<Emitter>[0]["analyze"],
): boolean {
  const reactiveContext = context.getReactiveContext(expression);
  if (
    reactiveContext.kind !== "pattern" ||
    (reactiveContext.owner !== "pattern" &&
      reactiveContext.owner !== "render" &&
      reactiveContext.owner !== "array-method")
  ) {
    return false;
  }

  const callbackContext = context.getEnclosingCallbackContext(expression);
  if (
    callbackContext &&
    (context.isArrayMethodCallback(callbackContext.callback) ||
      detectCallKind(callbackContext.call, context.checker)?.kind ===
        "array-method")
  ) {
    return true;
  }

  const sinkCall = classifyArrayMethodResultSinkCall(
    expression,
    context.checker,
  );
  if (sinkCall?.sink === "join") {
    const callee = expression.expression;
    if (
      !ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)
    ) {
      return false;
    }

    const receiverAnalysis = analyze(callee.expression);
    return receiverAnalysis.containsReactive;
  }

  const sinkReceiverChain = classifyArrayMethodResultSinkReceiverChainCall(
    expression,
    context.checker,
  );
  if (!sinkReceiverChain || sinkReceiverChain.sinkCall.sink !== "join") {
    return false;
  }

  const callee = expression.expression;
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return false;
  }

  const receiverAnalysis = analyze(callee.expression);
  return receiverAnalysis.containsReactive;
}

function isCellGetTerminalCall(
  expression: ts.CallExpression,
  context: Parameters<Emitter>[0]["context"],
): boolean {
  if (classifyOpaquePathTerminalCall(expression) !== "get") {
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
    return cellKind !== undefined;
  } catch {
    return false;
  }
}

export const emitCallExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analysis,
  analyze,
  rewriteChildren,
  inSafeContext,
  reactiveContextKind,
  preferInputBoundWrappers,
}) => {
  if (!ts.isCallExpression(expression)) return undefined;
  if (dataFlows.length === 0) return undefined;

  const hint = analysis.rewriteHint;
  const callKind = detectCallKind(expression, context.checker);
  // Synthetic when/unless/ifElse calls created by earlier lowering passes
  // already own their argument rewriting decisions and must not be reprocessed.
  const isAuthoredCall = !isSyntheticNode(expression);
  const conditionalHelperName: "ifElse" | "when" | "unless" | undefined =
    hint?.kind === "call-if-else" ? "ifElse" : (
        callKind?.kind === "ifElse" ||
        callKind?.kind === "when" ||
        callKind?.kind === "unless"
      )
      ? callKind.kind
      : undefined;

  if (hint?.kind === "skip-call-rewrite") {
    if (hint.reason === "array-method") {
      // For array method calls (e.g., state.items.filter(...).map(...)),
      // we don't wrap the method call itself, but we DO need to rewrite
      // the call chain before the method to wrap reactive expressions

      // If the callee is a property access (e.g., ...filter(...).map),
      // recursively rewrite the entire callee to handle wrapped expressions
      const rewrittenCallee = rewriteChildren(expression.expression);

      if (rewrittenCallee !== expression.expression) {
        // The callee was rewritten, update the map call
        return context.factory.updateCallExpression(
          expression,
          rewrittenCallee as ts.LeftHandSideExpression,
          expression.typeArguments,
          expression.arguments,
        );
      }

      // No changes needed
      return undefined;
    }
    return undefined;
  }

  if (conditionalHelperName) {
    if (!isAuthoredCall) {
      return undefined;
    }

    const rewrittenCallee = rewriteChildren(expression.expression);
    const rewrittenArgs: ts.Expression[] = [];
    let changed = rewrittenCallee !== expression.expression;

    expression.arguments.forEach((argument, index) => {
      const updated = !inSafeContext &&
          reactiveContextKind === "pattern"
        ? rewriteHelperOwnedExpression({
          expression: argument,
          containerLabel: getConditionalHelperArgLabel(
            conditionalHelperName,
            index,
          ),
          assertContainer: expression,
          context,
          analyze,
          rewriteChildren,
        })
        : rewriteChildren(argument) || argument;
      if (updated !== argument) changed = true;
      rewrittenArgs.push(updated);
    });

    if (!changed) return undefined;

    return context.factory.updateCallExpression(
      expression,
      rewrittenCallee,
      expression.typeArguments,
      rewrittenArgs,
    );
  }

  // Skip lift-applied wrapping in safe contexts - they don't need it
  if (inSafeContext) {
    return undefined;
  }

  // Preserve authored zero-arg IIFEs so the existing inner expression-site
  // machinery can decompose their local aliases instead of forcing a blanket
  // wrapper around the whole call. If they still contain direct cell reads,
  // wrap the IIFE so those reads happen under a reactive cause context.
  if (
    isAuthoredCall &&
    isZeroArgInlineIifeCall(expression)
  ) {
    const rewritten = rewriteChildren(expression);
    const unsafeGetReceivers = collectUnsafeIifeGetReceivers(
      rewritten as ts.CallExpression,
      context,
    );
    if (
      unsafeGetReceivers.length > 0
    ) {
      return createReactiveWrapperForExpression(
        rewritten,
        dataFlows,
        context,
        {
          filterNestedFunctionLocalCaptures: true,
          preferInputBoundWrapper: preferInputBoundWrappers,
        },
      ) ?? createLiftAppliedCall(rewritten, unsafeGetReceivers, {
        factory: context.factory,
        tsContext: context.tsContext,
        cfHelpers: context.cfHelpers,
        context,
      });
    }
    return rewritten !== expression ? rewritten : undefined;
  }

  if (dataFlows.length === 0) return undefined;

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      filterNestedFunctionLocalCaptures: shouldFilterNestedLocalsForCallWrapper(
        expression,
        context,
        analyze,
      ),
      allowDirectExpressionWrap: isCellGetTerminalCall(expression, context),
      preferInputBoundWrapper: preferInputBoundWrappers,
    },
  );
};
