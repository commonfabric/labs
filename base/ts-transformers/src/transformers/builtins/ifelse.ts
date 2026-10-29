import ts from "typescript";
import { CFHelpers } from "../../core/mod.ts";
import { unwrapParentheses } from "../../utils/expression.ts";

export interface IfElseParams {
  expression: ts.ConditionalExpression;
  factory: ts.NodeFactory;
  cfHelpers: CFHelpers;
  sourceFile: ts.SourceFile;
  overrides?: IfElseOverrides;
}

export interface IfElseOverrides {
  readonly predicate?: ts.Expression;
  readonly whenTrue?: ts.Expression;
  readonly whenFalse?: ts.Expression;
}

export function createIfElseCall(params: IfElseParams): ts.CallExpression {
  const { cfHelpers, overrides, expression } = params;

  const predicate = unwrapParentheses(
    overrides?.predicate ?? expression.condition,
  );
  const whenTrue = unwrapParentheses(
    overrides?.whenTrue ?? expression.whenTrue,
  );
  const whenFalse = unwrapParentheses(
    overrides?.whenFalse ?? expression.whenFalse,
  );

  return cfHelpers.createHelperCall(
    "ifElse",
    expression,
    undefined,
    [predicate, whenTrue, whenFalse],
  );
}

export interface WhenParams {
  condition: ts.Expression;
  value: ts.Expression;
  factory: ts.NodeFactory;
  cfHelpers: CFHelpers;
}

/**
 * Creates when(condition, value) call for && operator optimization.
 * Equivalent to: ifElse(condition, value, condition)
 */
export function createWhenCall(params: WhenParams): ts.CallExpression {
  const { cfHelpers, condition, value } = params;

  const cond = unwrapParentheses(condition);
  const val = unwrapParentheses(value);

  return cfHelpers.createHelperCall(
    "when",
    condition,
    undefined,
    [cond, val],
  );
}

/**
 * Creates unless(condition, value) call for || operator optimization.
 * Equivalent to: ifElse(condition, condition, value)
 */
export function createUnlessCall(params: WhenParams): ts.CallExpression {
  const { cfHelpers, condition, value } = params;

  const cond = unwrapParentheses(condition);
  const val = unwrapParentheses(value);

  return cfHelpers.createHelperCall(
    "unless",
    condition,
    undefined,
    [cond, val],
  );
}
