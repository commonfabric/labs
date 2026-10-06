import ts from "typescript";
import {
  type CommonFabricKeyName,
  getCommonFabricComputedKeyName,
  getComputedPropertyKeyInfo,
} from "@commonfabric/schema-generator/property-name";

import {
  CF_HELPERS_IDENTIFIER,
  type TransformationContext,
} from "../core/mod.ts";

export function getCommonFabricKeyName(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): CommonFabricKeyName | undefined {
  return getCommonFabricComputedKeyName(expr, checker, {
    commonFabricHelperIdentifier: CF_HELPERS_IDENTIFIER,
  });
}

export function cloneKeyExpression(
  expr: ts.Expression,
  factory: ts.NodeFactory,
): ts.Expression {
  if (ts.isIdentifier(expr)) {
    return ts.setOriginalNode(factory.createIdentifier(expr.text), expr);
  }
  if (ts.isStringLiteral(expr)) {
    return factory.createStringLiteral(expr.text);
  }
  if (ts.isNumericLiteral(expr)) {
    return factory.createNumericLiteral(expr.text);
  }
  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    return factory.createStringLiteral(expr.text);
  }
  return expr;
}

export function isCommonFabricKeyIdentifier(
  expr: ts.Expression,
  context: TransformationContext,
  targetName: CommonFabricKeyName,
): expr is ts.Identifier {
  return ts.isIdentifier(expr) &&
    getCommonFabricKeyName(expr, context.checker) === targetName;
}

/**
 * Check if an expression is a `__cfHelpers.X` property access for a known key.
 * Prior transformers (e.g. ClosureTransformer) rewrite bare `NAME`/`UI`/`SELF`
 * identifiers into this form.
 */
export function isCtHelpersKeyAccess(
  expr: ts.Expression,
  targetName: CommonFabricKeyName,
): boolean {
  return ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === CF_HELPERS_IDENTIFIER &&
    expr.name.text === targetName;
}

/**
 * Check if an expression refers to a Common Fabric key (NAME/UI/SELF) in either
 * bare identifier or `__cfHelpers.X` property-access form.
 */
export function isCommonFabricKeyExpression(
  expr: ts.Expression,
  context: TransformationContext,
  targetName: CommonFabricKeyName,
): boolean {
  return getCommonFabricKeyName(expr, context.checker) === targetName;
}

export function getKnownComputedKeyPathSegment(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): string | undefined {
  return getComputedPropertyKeyInfo(expr, checker, {
    commonFabricHelperIdentifier: CF_HELPERS_IDENTIFIER,
  })?.text;
}

export function getKnownComputedKeyExpression(
  expr: ts.Expression,
  context: TransformationContext,
): ts.Expression | undefined {
  const keyInfo = getComputedPropertyKeyInfo(expr, context.checker, {
    commonFabricHelperIdentifier: CF_HELPERS_IDENTIFIER,
  });
  if (!keyInfo) {
    return undefined;
  }
  if (keyInfo.kind === "literal") {
    return cloneKeyExpression(expr, context.factory);
  }
  return context.cfHelpers.getHelperExpr(keyInfo.name);
}

export function isFallbackOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.BarBarToken;
}
