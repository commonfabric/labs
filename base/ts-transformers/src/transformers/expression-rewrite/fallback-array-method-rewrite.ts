import ts from "typescript";

import { classifyArrayMethodAccess } from "../../ast/mod.ts";
import { unwrapExpression } from "../../utils/expression.ts";
import { isFallbackOperator } from "../../utils/reactive-keys.ts";
import { isSimpleReactiveAccess } from "../cell-type.ts";

/**
 * True when `expression` is the receiver of an unlowered `map`, so a fallback
 * such as `(xs ?? []).map(...)` can be left for the array-method rewrite to
 * own rather than wrapped on its own.
 *
 * The receiver walk steps through parentheses and partially emitted nodes, and
 * deliberately not the rest of the transparent wrapper set: the shapes this
 * gate accepts are binary fallback expressions, and an `as`, `<T>`,
 * `satisfies`, or `!` between the fallback and the `.map` changes what the
 * array-method rewrite reads there.
 */
export function isFallbackMapReceiverExpression(
  expression: ts.BinaryExpression,
): boolean {
  let current: ts.Node = expression;

  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isPartiallyEmittedExpression(current.parent)
  ) {
    current = current.parent;
  }

  const parent = current.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== current) {
    return false;
  }

  const arrayMethodInfo = classifyArrayMethodAccess(parent);
  return !!arrayMethodInfo &&
    !arrayMethodInfo.lowered &&
    arrayMethodInfo.family === "map";
}

export function shouldDeferFallbackMapReceiverRewrite(
  expression: ts.BinaryExpression,
  checker: ts.TypeChecker,
): boolean {
  if (!isFallbackOperator(expression.operatorToken.kind)) {
    return false;
  }

  if (!isFallbackMapReceiverExpression(expression)) {
    return false;
  }

  return isSimpleReactiveAccess(unwrapExpression(expression.left), checker);
}
