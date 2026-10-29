import ts from "typescript";
import { type TransformationContext } from "../../core/mod.ts";
import {
  classifyArrayMethodCall,
  isFunctionLikeExpression,
  type ReactiveContextInfo,
} from "../../ast/mod.ts";
import { unwrapExpression } from "../../utils/expression.ts";
import { shouldTransformArrayMethod } from "./array-method-policy.ts";
import { transformArrayMethodCallback } from "./array-method-transform.ts";
import { rewriteArrayMethodCallbackExpressionSites } from "../../transformers/expression-site-lowering.ts";

/**
 * Rewrite the callback of a not-yet-lowered reactive array method call.
 * Returns undefined for any other node.
 */
export function transformArrayMethodCall(
  node: ts.Node,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.Node | undefined {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression)
  ) {
    return undefined;
  }

  const arrayMethodInfo = classifyArrayMethodCall(node);
  if (!arrayMethodInfo || arrayMethodInfo.lowered) {
    return undefined;
  }

  // Read the callback through paren spelling — a blind read here skips the
  // lowering and a raw reactive method call reaches the runtime.
  const callback = node.arguments[0] && unwrapExpression(node.arguments[0]);
  if (callback && isFunctionLikeExpression(callback)) {
    assertValidSyntheticComputeOwnedArrayMethodContext(
      node,
      context.getReactiveContext(node),
      context,
    );
    if (shouldTransformArrayMethod(node, context)) {
      return transformArrayMethodCallback(node, callback, context, visitor, {
        rewriteTransformedBody: rewriteArrayMethodCallbackExpressionSites,
      });
    }
  }
  return undefined;
}

function getNodeSnippet(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  maxLength = 160,
): string {
  try {
    const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
  } catch {
    return ts.SyntaxKind[node.kind];
  }
}

type SyntheticComputeOwnedLookup = Pick<
  TransformationContext,
  "sourceFile" | "isSyntheticComputeOwnedNode"
>;

export function assertValidSyntheticComputeOwnedArrayMethodContext(
  methodCall: ts.CallExpression,
  contextInfo: ReactiveContextInfo,
  context: SyntheticComputeOwnedLookup,
): void {
  const receiver = ts.isPropertyAccessExpression(methodCall.expression)
    ? methodCall.expression.expression
    : undefined;
  const isSyntheticComputeOwned = context.isSyntheticComputeOwnedNode(
    methodCall,
  ) ||
    (receiver ? context.isSyntheticComputeOwnedNode(receiver) : false);

  if (!isSyntheticComputeOwned) {
    return;
  }

  if (contextInfo.kind === "compute") {
    return;
  }

  if (
    contextInfo.kind === "pattern" &&
    contextInfo.owner === "array-method"
  ) {
    return;
  }

  throw new Error(
    [
      "Internal Common Fabric compiler error: synthetic compute-owned array method retained a non-compute context.",
      "This is a bug in the compiler, not in your code. Please report it to the maintainers.",
      `Method call: \`${getNodeSnippet(methodCall, context.sourceFile)}\``,
      `Reactive context: ${contextInfo.kind} (${contextInfo.owner})`,
    ].join("\n"),
  );
}
