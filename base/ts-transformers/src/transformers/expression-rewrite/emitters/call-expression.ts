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
import { createLiftAppliedCall } from "../../builtins/lift-applied.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import {
  getCalleeReceiver,
  getGetCallReceiver,
} from "../../call-root-support.ts";
import { rewriteHelperOwnedExpression } from "./helper-owned-expression.ts";

function isZeroArgInlineIifeCall(expression: ts.CallExpression): boolean {
  if (expression.arguments.length !== 0) {
    return false;
  }

  // Parentheses only: a callee under a type assertion is not recognized as an
  // inline IIFE — the assertion re-types the call, and the general call
  // lowering handles it.
  const callee = unwrapParentheses(expression.expression);

  return ts.isArrowFunction(callee) || ts.isFunctionExpression(callee);
}

/**
 * Whether `expression` names a binding declared inside `container`. Bindings
 * are declared in the authored tree, so a rewritten `container` is compared
 * through the authored node it was rebuilt from.
 */
function isDeclaredInside(
  expression: ts.Expression,
  container: ts.Node,
  context: Parameters<Emitter>[0]["context"],
): boolean {
  if (!ts.isIdentifier(expression)) {
    return false;
  }

  const authored = ts.getOriginalNode(container);
  const symbol = context.checker.getSymbolAtLocation(expression);
  const declarations = symbol?.getDeclarations() ?? [];
  return declarations.some((declaration) => {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (current === authored) {
        return true;
      }
      current = current.parent;
    }
    return false;
  });
}

/**
 * Collects the receivers of `.get()` calls an IIFE makes on values declared
 * outside it. The scan enters the IIFE's own function and synthetic compute
 * callbacks, and skips every other nested function, whose reads do not run when
 * the IIFE does. Reads inside a synthetic compute callback already happen under
 * a reactive cause context and are not collected.
 */
function collectUnsafeIifeGetReceivers(
  iife: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
): ts.Expression[] {
  const receivers: ts.Expression[] = [];

  const visit = (
    node: ts.Node,
    syntheticComputeDepth: number,
    insideIife: boolean,
  ): void => {
    const isFunctionLike = ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node);
    if (isFunctionLike) {
      const isSyntheticCompute = context.isSyntheticComputeCallback(node);
      if (insideIife && !isSyntheticCompute) {
        return;
      }
      const nextDepth = syntheticComputeDepth + (isSyntheticCompute ? 1 : 0);
      ts.forEachChild(node, (child) => visit(child, nextDepth, true));
      return;
    }

    const receiver = syntheticComputeDepth === 0 &&
        ts.isCallExpression(node) && node.arguments.length === 0
      ? getGetCallReceiver(node)
      : undefined;
    if (receiver) {
      if (
        !isDeclaredInside(receiver, iife, context) &&
        !receivers.includes(receiver)
      ) {
        receivers.push(receiver);
      }
      return;
    }

    ts.forEachChild(
      node,
      (child) => visit(child, syntheticComputeDepth, insideIife),
    );
  };

  visit(iife, 0, false);
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

  const isJoinSink = classifyArrayMethodResultSinkCall(
        expression,
        context.checker,
      )?.sink === "join" ||
    classifyArrayMethodResultSinkReceiverChainCall(
        expression,
        context.checker,
      )?.sinkCall.sink === "join";
  if (!isJoinSink) {
    return false;
  }

  const receiver = getCalleeReceiver(expression);
  return receiver !== undefined && analyze(receiver).containsReactive;
}

function isCellGetTerminalCall(
  expression: ts.CallExpression,
  context: Parameters<Emitter>[0]["context"],
): boolean {
  const receiver = getGetCallReceiver(expression);
  if (!receiver) {
    return false;
  }

  return getCellKind(
    context.checker.getTypeAtLocation(receiver),
    context.checker,
  ) !== undefined;
}

export const emitCallExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  analysis,
  analyze,
  rewriteChildren,
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
      const updated = reactiveContextKind === "pattern"
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
      rewritten,
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
