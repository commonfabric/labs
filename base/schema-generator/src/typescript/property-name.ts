import ts from "typescript";

import { isCellInternalMarkerName } from "./cell-brand.ts";
import { isCommonFabricSymbol } from "./common-fabric-symbols.ts";

const COMMON_FABRIC_HELPERS_IDENTIFIER = "__cfHelpers";
const COMMON_FABRIC_KEY_NAMES = ["NAME", "UI", "SELF", "FS", "VIEWS"] as const;
const COMMON_FABRIC_KEY_NAME_SET = new Set<CommonFabricKeyName>(
  COMMON_FABRIC_KEY_NAMES,
);

export type CommonFabricKeyName = typeof COMMON_FABRIC_KEY_NAMES[number];

export type ComputedPropertyKeyInfo =
  | {
    kind: "literal";
    text: string;
    value: string | number;
  }
  | {
    kind: "common-fabric";
    text: `$${CommonFabricKeyName}`;
    name: CommonFabricKeyName;
  };

export interface ComputedPropertyKeyResolutionOptions {
  readonly commonFabricHelperIdentifier?: string;
  /**
   * Trust a matching helper access that has no checker-resolved canonical
   * symbol. Callers may set this only for compiler-owned synthetic nodes.
   */
  readonly allowCompilerOwnedCommonFabricHelperAccess?: boolean;
}

function getLiteralComputedKeyValue(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): string | number | undefined {
  if (
    ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)
  ) {
    return expr.text;
  }
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (!checker) {
    return undefined;
  }

  const type = checker.getTypeAtLocation(expr);
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return (type as ts.StringLiteralType).value;
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return (type as ts.NumberLiteralType).value;
  }
  return undefined;
}

function resolveAliasedSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (!symbol) {
    return undefined;
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function getTrustedCommonFabricKeyName(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): CommonFabricKeyName | undefined {
  const resolved = resolveAliasedSymbol(symbol, checker);
  if (!resolved) return undefined;
  const resolvedName = resolved.getName() as CommonFabricKeyName;
  return COMMON_FABRIC_KEY_NAME_SET.has(resolvedName) &&
      isCommonFabricSymbol(resolved, checker)
    ? resolvedName
    : undefined;
}

function resolveCommonFabricComputedKeyName(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
  options: ComputedPropertyKeyResolutionOptions = {},
): CommonFabricKeyName | undefined {
  const helperIdentifier = options.commonFabricHelperIdentifier ??
    COMMON_FABRIC_HELPERS_IDENTIFIER;

  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === helperIdentifier &&
    COMMON_FABRIC_KEY_NAME_SET.has(expr.name.text as CommonFabricKeyName)
  ) {
    if (checker) {
      const trustedName = getTrustedCommonFabricKeyName(
        checker.getSymbolAtLocation(expr.name),
        checker,
      );
      if (trustedName) return trustedName;
    }
    return options.allowCompilerOwnedCommonFabricHelperAccess
      ? expr.name.text as CommonFabricKeyName
      : undefined;
  }

  if (!ts.isIdentifier(expr)) {
    return undefined;
  }

  if (!checker) {
    return undefined;
  }

  return getTrustedCommonFabricKeyName(
    checker.getSymbolAtLocation(expr),
    checker,
  );
}

export function getComputedPropertyKeyInfo(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
  options: ComputedPropertyKeyResolutionOptions = {},
): ComputedPropertyKeyInfo | undefined {
  const commonFabricKeyName = resolveCommonFabricComputedKeyName(
    expr,
    checker,
    options,
  );
  if (commonFabricKeyName) {
    return {
      kind: "common-fabric",
      name: commonFabricKeyName,
      text: `$${commonFabricKeyName}`,
    };
  }

  const literalValue = getLiteralComputedKeyValue(expr, checker);
  if (literalValue !== undefined) {
    return {
      kind: "literal",
      text: String(literalValue),
      value: literalValue,
    };
  }

  return undefined;
}

export function getCommonFabricComputedKeyName(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
  options: ComputedPropertyKeyResolutionOptions = {},
): CommonFabricKeyName | undefined {
  const info = getComputedPropertyKeyInfo(expr, checker, options);
  return info?.kind === "common-fabric" ? info.name : undefined;
}

/**
 * Extract static text for a property name when available.
 * Supports identifier keys plus string/numeric/template literal keys.
 */
export function getPropertyNameText(
  name: ts.PropertyName,
  checker?: ts.TypeChecker,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  if (ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    return getComputedPropertyKeyInfo(name.expression, checker)?.text;
  }

  return undefined;
}

/**
 * Whether schema generation leaves the member named `name` out of an object's
 * schema whatever node the object is read through: a member keyed by a
 * symbol, whose name the checker writes starting `__@`, or a cell's internal
 * marker.
 */
export function isInternalMemberName(name: string): boolean {
  return name.startsWith("__@") || isCellInternalMarkerName(name);
}
