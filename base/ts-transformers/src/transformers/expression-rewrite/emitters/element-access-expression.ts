import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";

export const emitElementAccessExpression = ({
  expression,
  dataFlows,
  analysis,
  context,
  preferInputBoundWrappers,
}: EmitterContext) => {
  if (!ts.isElementAccessExpression(expression)) return undefined;

  // Check if this is a static index access
  const argumentExpression = expression.argumentExpression;
  const isStaticIndex = argumentExpression &&
    ts.isExpression(argumentExpression) &&
    (ts.isLiteralExpression(argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(argumentExpression));

  // If it's a static index and doesn't require rewrite, don't wrap it
  if (isStaticIndex && !analysis.requiresRewrite) {
    return undefined;
  }

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      allowDirectExpressionWrap: !isStaticIndex,
      preferInputBoundWrapper: preferInputBoundWrappers,
    },
  );
};
