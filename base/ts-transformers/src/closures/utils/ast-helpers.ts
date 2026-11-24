import ts from "typescript";

import { unwrapExpression } from "../../utils/expression.ts";

/**
 * The arrow function an expression denotes, looking through every transparent
 * wrapper, or `undefined` when it denotes something else.
 *
 * The whole set has to come off. A spelling left on hides the callback from the
 * closure strategies, and `action(...)` then reaches the runtime unrewritten —
 * where it throws by construction, because it exists only to be lowered to
 * `handler()` at compile time.
 */
export function unwrapArrowFunction(
  expression: ts.Expression,
): ts.ArrowFunction | undefined {
  const current = unwrapExpression(expression);
  return ts.isArrowFunction(current) ? current : undefined;
}
