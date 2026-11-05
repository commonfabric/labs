import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import { isTransparentWrapper } from "../../../utils/expression.ts";

/**
 * True for an expression the container emitter owns: a literal that holds other
 * expressions, or a transparent wrapper around one. A wrapper spelling missing
 * here is not inert — the emitter declines the expression, and it falls to
 * whichever emitter claims it next.
 */
const isContainerExpression = (expression: ts.Expression): boolean =>
  ts.isObjectLiteralExpression(expression) ||
  ts.isArrayLiteralExpression(expression) ||
  isTransparentWrapper(expression);

export const emitContainerExpression = ({
  expression,
  rewriteChildren,
}: EmitterContext) => {
  if (!isContainerExpression(expression)) return undefined;

  // In safe contexts, still rewrite children to handle nested when/unless
  // but the container itself doesn't need wrapping
  return rewriteChildren(expression);
};
