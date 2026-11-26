import ts from "typescript";

import { isCommonFabricDeclaration } from "./common-fabric-symbols.ts";

const COMMON_FABRIC_HELPERS_IDENTIFIER = "__cfHelpers";
const COMMON_FABRIC_KEY_NAMES = [
  "NAME",
  "UI",
  "SELF",
  "FS",
  "VIEWS",
  "SUGGESTIONS",
] as const;
const COMMON_FABRIC_KEY_NAME_SET: ReadonlySet<string> = new Set(
  COMMON_FABRIC_KEY_NAMES,
);

export type CommonFabricKeyName = typeof COMMON_FABRIC_KEY_NAMES[number];

/** Whether `name` is one of the keys Common Fabric declares. */
function isCommonFabricKeyName(name: string): name is CommonFabricKeyName {
  return COMMON_FABRIC_KEY_NAME_SET.has(name);
}

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
    isCommonFabricKeyName(expr.name.text)
  ) {
    return expr.name.text;
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
  if (symbol === undefined) return undefined;
  const resolvedName = symbol.getName();
  if (!isCommonFabricKeyName(resolvedName)) return undefined;

  // The key Common Fabric declares, or a unique symbol of its name.
  const declaration = symbol.declarations?.[0];
  if (declaration !== undefined && isCommonFabricDeclaration(declaration)) {
    return resolvedName;
  }
  const type = checker.getTypeOfSymbol(symbol);
  return (type.flags & ts.TypeFlags.UniqueESSymbol) !== 0
    ? resolvedName
    : undefined;
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
 * Whether schema generation leaves the member whose escaped name is `name` out
 * of an object's schema whatever node the object is read through: a member
 * keyed by a symbol, whose escaped name the checker writes starting `__@`, a
 * cell's internal markers among them, or a class's private member, whose
 * escaped name starts `__#`. A string key starting `__` has one more leading
 * underscore in its escaped name, so neither `"__@x"` nor `"__#x"` is taken
 * for one.
 */
export function isInternalMemberName(name: string): boolean {
  return name.startsWith("__@") || name.startsWith("__#");
}
