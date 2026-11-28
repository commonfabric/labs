import ts from "typescript";
import type { Emitter } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";

export const emitPrefixUnaryExpression: Emitter = ({
  expression,
  dataFlows,
  context,
  preferInputBoundWrappers,
}) => {
  if (
    !ts.isPrefixUnaryExpression(expression) ||
    expression.operator === ts.SyntaxKind.PlusPlusToken ||
    expression.operator === ts.SyntaxKind.MinusMinusToken
  ) {
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
