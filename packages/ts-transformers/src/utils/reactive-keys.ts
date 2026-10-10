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
    return factory.createIdentifier(expr.text);
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

/**
 * Check if an expression is a `__cfHelpers.X` property access for a known key.
 * Prior transformers (e.g. ClosureTransformer) rewrite a bare well-known key
 * identifier, such as `NAME`, into this form.
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
 * Check if an expression refers to the Common Fabric key `targetName` in either
 * bare identifier or `__cfHelpers.X` property-access form.
 */
export function isCommonFabricKeyExpression(
  expr: ts.Expression,
  context: TransformationContext,
  targetName: CommonFabricKeyName,
): boolean {
  return getCommonFabricKeyName(expr, context.checker) === targetName;
}

/**
 * Whether the code fixes which member `key`, the key of an element access,
 * names. A literal fixes it, and so do a well-known Common Fabric key (`NAME`)
 * and an expression whose type is a single string or number literal, such as
 * a reference to `const KEY = "k"`. Any other key can name any member, which
 * makes the access dynamic, and so does a missing key, which only source
 * that does not parse has.
 *
 * The type is all this reads. A key of a literal type that is read from a
 * reactive value passes, and a caller that would emit the key has to rule
 * that out itself.
 */
export function isStaticElementKey(
  key: ts.Expression | undefined,
  checker?: ts.TypeChecker,
): boolean {
  return key !== undefined &&
    getComputedPropertyKeyInfo(key, checker, {
        commonFabricHelperIdentifier: CF_HELPERS_IDENTIFIER,
      }) !== undefined;
}

/**
 * The `.key(...)` argument a static element key lowers to, or `undefined` for
 * a key `isStaticElementKey()` refuses. A literal is the string it denotes, a
 * numeric one under its decimal name. A well-known key is its `__cfHelpers`
 * member. Any other key is the expression as written, so an expression of a
 * literal type is still evaluated where the read is.
 */
export function getStaticKeySegment(
  key: ts.Expression | undefined,
  context: TransformationContext,
): string | ts.Expression | undefined {
  if (key === undefined) {
    return undefined;
  }
  if (
    ts.isStringLiteral(key) || ts.isNumericLiteral(key) ||
    ts.isNoSubstitutionTemplateLiteral(key)
  ) {
    return key.text;
  }
  return getKnownComputedKeyExpression(key, context);
}

/**
 * Like `getStaticKeySegment()`, except a literal key is returned as a copy of
 * the literal rather than as its text.
 */
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
