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
 * Whether the type of `key`, the key of an element access, fixes which member
 * it names. A literal fixes it, and so do a well-known Common Fabric key
 * (`NAME`) and an expression whose type is a single string or number literal,
 * such as a reference to `const KEY = "k"`. Any other key can name any
 * member, and so does a missing key, which only source that does not parse
 * has.
 *
 * The type is all this reads, so a key of a literal type that is read from a
 * reactive value passes. That suits a caller deciding whether an access may
 * become a computation, which such a key's access may, and a caller that
 * rules the key out from an analysis of its own. A caller deciding whether to
 * write the key out asks `isStaticElementKey()`.
 */
export function hasStaticKeyType(
  key: ts.Expression | undefined,
  checker?: ts.TypeChecker,
): boolean {
  return key !== undefined &&
    getComputedPropertyKeyInfo(key, checker, {
        commonFabricHelperIdentifier: CF_HELPERS_IDENTIFIER,
      }) !== undefined;
}

/**
 * Whether `key`, the key of an element access, is static: its type fixes the
 * member it names (`hasStaticKeyType()`), and it is not read from a reactive
 * value. A static key makes the access a path read, lowered in place as a
 * `.key(...)` argument; any other key makes it dynamic.
 *
 * A key of a literal type read from a reactive value, such as a pattern input
 * typed `"k"`, is the case the second condition is for. Its type names one
 * member, but the key is a cell, and written out it would hand `.key()` the
 * cell in place of the key.
 */
export function isStaticElementKey(
  key: ts.Expression | undefined,
  context: TransformationContext,
): boolean {
  if (key === undefined || !hasStaticKeyType(key, context.checker)) {
    return false;
  }
  // A literal and a well-known key are constants, so only a key that is
  // static by its type alone can be reactive.
  if (
    ts.isStringLiteral(key) || ts.isNumericLiteral(key) ||
    ts.isNoSubstitutionTemplateLiteral(key) ||
    getCommonFabricKeyName(key, context.checker) !== undefined
  ) {
    return true;
  }
  return !context.analyzeExpression(key).containsReactive;
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
  if (key === undefined || !isStaticElementKey(key, context)) {
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
