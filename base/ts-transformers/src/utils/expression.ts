import ts from "typescript";

import { CF_HELPERS_IDENTIFIER } from "../core/cf-helpers.ts";

/**
 * The expression forms that wrap an inner expression without changing the
 * value it denotes: `(x)`, `x as T`, `<T>x`, `x satisfies T`, `x!`, and the
 * partially emitted node that carries an already-rewritten subtree.
 *
 * This is the one set the pipeline looks through, and it is read in four forms
 * so that every shape of consumer has a definition to reach for:
 * {@link isTransparentWrapper} tests a node, {@link unwrapTransparentWrapperOnce}
 * steps through a single wrapper, {@link unwrapExpression} reaches the innermost
 * expression, and {@link outermostTransparentWrapper} walks the other way, out
 * to the expression's usage site. A spelling added here reaches all four at
 * once, so a wrapper cannot be handled by one resolver and missed by another.
 *
 * A stripper that reads a narrower set does so deliberately, and says why at
 * its own definition.
 *
 * Every member is an expression. A type node is read through the forms that
 * stand for another type node by `@commonfabric/schema-generator/type-node`.
 */
export type TransparentWrapper =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.PartiallyEmittedExpression;

/**
 * True for a node that wraps an inner expression without changing the value it
 * denotes.
 */
export function isTransparentWrapper(
  node: ts.Node,
): node is TransparentWrapper {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isPartiallyEmittedExpression(node);
}

/**
 * The expression a single transparent wrapper wraps, or `undefined` when the
 * node is not one.
 *
 * This is the form for a caller that walks a wrapper chain a node at a time:
 * one following parent links outward, or one that must know which side of a
 * wrapper it arrived from. A caller that only wants the innermost expression
 * uses {@link unwrapExpression}.
 */
export function unwrapTransparentWrapperOnce(
  node: ts.Node,
): ts.Expression | undefined {
  return isTransparentWrapper(node) ? node.expression : undefined;
}

/**
 * The innermost expression, reached by removing every transparent wrapper.
 */
export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (isTransparentWrapper(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * The expression with directly nested parentheses removed and every other
 * transparent wrapper kept.
 *
 * The deliberately narrow companion to {@link unwrapExpression} for a caller
 * that rebuilds emitted code around the expression rather than classifying
 * it. Parentheses never change the type the checker reports, so removing them
 * removes only noise in the printed output. Every other wrapper can change it
 * — `as` and `<T>x` assert a type, `satisfies` shapes what a literal infers
 * as, `!` drops the nullable arms — and the schema stages read operand types
 * at the argument positions such a caller builds, so a wrapper stripped there
 * is a schema changed: a ternary branch reading `state.note!` keeps a
 * non-nullable operand schema only while the assertion stays in the tree.
 */
export function unwrapParentheses(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * The outermost expression that still denotes the same value as `expr`: `expr`
 * itself when nothing wraps it, otherwise the last transparent wrapper stacked
 * around it.
 *
 * The mirror of {@link unwrapExpression}, which walks in to the innermost
 * expression. A caller asking what an expression is *used as* wants this one,
 * because the use sits at the outside of the stack — `f(x as T)` hands `f` the
 * whole `x as T`, not `x`.
 *
 * Only a wrapper reached along the `expression` spine counts. A node standing
 * in a wrapper's type position is not the value that wrapper wraps, so the walk
 * stops rather than climbing past it.
 */
export function outermostTransparentWrapper(
  expr: ts.Expression,
): ts.Expression {
  let current = expr;
  while (true) {
    const parent = current.parent;
    if (
      !parent || !isTransparentWrapper(parent) ||
      parent.expression !== current
    ) {
      return current;
    }
    current = parent;
  }
}

/**
 * True for the syntactic shapes that compute a *value* from their operands —
 * binary (`a === b`, `a + b`, `a ?? b`), prefix/postfix unary (`!x`, `-x`,
 * `x++`), and conditional (`a ? b : c`). These are the expressions a reactive
 * boundary (a helper body, or a map/filter/flatMap callback) lifts to value
 * level so they operate on resolved values rather than Reactive proxies.
 *
 * It is a purely syntactic kind check — it does NOT decide lowerability
 * (reactivity, control-flow routing, and collection-vs-value distinctions are
 * the caller's concern). Conditionals and logical `&&`/`||` are included here
 * but are typically peeled off earlier by control-flow lowering.
 */
export function isValueComputationExpressionKind(
  expression: ts.Expression,
): boolean {
  return ts.isBinaryExpression(expression) ||
    ts.isPrefixUnaryExpression(expression) ||
    ts.isPostfixUnaryExpression(expression) ||
    ts.isConditionalExpression(expression);
}

/**
 * The runtime helper an `assert` body records an operand with. It takes the
 * operand and hands the same value back.
 */
export const ASSERT_CAPTURE_HELPER_NAME = "assertCapture";

/** The `assertCapture` argument holding the operand. */
const ASSERT_CAPTURE_VALUE_ARGUMENT = 2;

/** True for a `__cfHelpers.assertCapture(parts, src, value)` call. */
function isAssertCaptureCall(
  expression: ts.Expression,
): expression is ts.CallExpression {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  return ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === CF_HELPERS_IDENTIFIER &&
    callee.name.text === ASSERT_CAPTURE_HELPER_NAME &&
    expression.arguments.length === ASSERT_CAPTURE_VALUE_ARGUMENT + 1;
}

/**
 * The expression a value comes from, with the operand recordings an `assert`
 * body puts in the way removed. It also removes everything
 * {@link unwrapExpression} removes.
 *
 * `AssertDiagnosticsTransformer` rewrites `event.details.includes(text)` into
 * `__cfHelpers.assertCapture(parts, "event.details", event.details)
 * .includes(text)`. The method is now called on a call rather than on the
 * member access the author wrote. An analysis asking which reactive value an
 * expression reads has to read through that call to reach `event.details`.
 * Without it the read goes unrecorded, and the field is projected out of the
 * schema the body is served.
 */
export function unwrapAssertCapture(expression: ts.Expression): ts.Expression {
  let current = unwrapExpression(expression);
  while (isAssertCaptureCall(current)) {
    current = unwrapExpression(
      current.arguments[ASSERT_CAPTURE_VALUE_ARGUMENT]!,
    );
  }
  return current;
}
