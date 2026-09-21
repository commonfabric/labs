import ts from "typescript";

import { isCommonFabricDeclaration } from "./common-fabric-symbols.ts";

const COMMON_FABRIC_HELPERS_IDENTIFIER = "__cfHelpers";
const COMMON_FABRIC_KEY_NAMES = ["NAME", "UI", "SELF", "FS"] as const;
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

function isUniqueSymbolKeySymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  const declaration = symbol.declarations?.[0];
  if (!declaration) {
    return false;
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  return (type.flags & ts.TypeFlags.UniqueESSymbol) !== 0;
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
    return expr.name.text as CommonFabricKeyName;
  }

  if (!ts.isIdentifier(expr)) {
    return undefined;
  }

  if (!checker) {
    return undefined;
  }

  const symbol = resolveAliasedSymbol(
    checker.getSymbolAtLocation(expr),
    checker,
  );
  const resolvedName = symbol?.getName() as CommonFabricKeyName | undefined;
  if (!resolvedName || !COMMON_FABRIC_KEY_NAME_SET.has(resolvedName)) {
    return undefined;
  }

  const declaration = symbol?.declarations?.[0];
  if (!declaration) {
    return undefined;
  }

  if (isCommonFabricDeclaration(declaration)) {
    return resolvedName;
  }

  return isUniqueSymbolKeySymbol(symbol, checker) ? resolvedName : undefined;
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
