import ts from "typescript";
import type { Emitter } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";

export const emitPrefixUnaryExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  inSafeContext,
  preferInputBoundWrappers,
}) => {
  if (!ts.isPrefixUnaryExpression(expression)) return undefined;

  // Skip lift-applied wrapping in safe contexts - they don't need it
  if (inSafeContext) return undefined;

  if (expression.operator !== ts.SyntaxKind.ExclamationToken) {
    return undefined;
  }
  if (dataFlows.length === 0) return undefined;

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      preferInputBoundWrapper: preferInputBoundWrappers,
    },
  );
};
