import ts from "typescript";
import type { Emitter } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";

export const emitPrefixUnaryExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  preferInputBoundWrappers,
}) => {
  if (!ts.isPrefixUnaryExpression(expression)) return undefined;

  if (expression.operator !== ts.SyntaxKind.ExclamationToken) {
    return undefined;
  }
  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      preferInputBoundWrapper: preferInputBoundWrappers,
    },
  );
};
