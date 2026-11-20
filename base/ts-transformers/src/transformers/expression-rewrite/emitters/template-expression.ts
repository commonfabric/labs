import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";

export const emitTemplateExpression = ({
  expression,
  dataFlows,
  context,
  preferInputBoundWrappers,
}: EmitterContext) => {
  if (!ts.isTemplateExpression(expression)) return undefined;

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      preferInputBoundWrapper: preferInputBoundWrappers,
    },
  );
};
