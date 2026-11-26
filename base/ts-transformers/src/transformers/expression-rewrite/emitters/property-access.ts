import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import { isSafeEventHandlerCall } from "../../../ast/mod.ts";

export function emitPropertyAccess(
  params: EmitterContext,
): ts.Expression | undefined {
  const {
    expression,
    dataFlows,
    context,
    preferInputBoundWrappers,
  } = params;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;

  if (
    expression.parent &&
    ts.isCallExpression(expression.parent) &&
    expression.parent.expression === expression
  ) {
    if (!isSafeEventHandlerCall(expression.parent)) return undefined;
  }

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      preferInputBoundWrapper: preferInputBoundWrappers,
    },
  );
}
