import ts from "typescript";

import { isCommonFabricSymbol } from "./common-fabric-symbols.ts";

/**
 * Check if a type is a union that includes undefined.
 * When a property type is `T | undefined`, it's considered optional for JSON/runtime semantics.
 */
export function isUnionWithUndefined(type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Union)) {
    return false;
  }
  const unionType = type as ts.UnionType;
  return unionType.types.some(
    (t) => (t.flags & ts.TypeFlags.Undefined) !== 0,
  );
}

/**
 * Check if a typeNode represents Default<T | undefined, V>.
 * When the inner type T includes undefined, the property is optional.
 */
export function isDefaultNodeWithUndefined(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return false;
  }

  const typeName = ts.isIdentifier(typeNode.typeName)
    ? typeNode.typeName.text
    : undefined;
  if (typeName !== "Default") {
    return false;
  }

  const typeArgs = typeNode.typeArguments;
  if (!typeArgs || typeArgs.length === 0) {
    return false;
  }

  const innerTypeNode = typeArgs[0];
  if (!innerTypeNode) {
    return false;
  }

  const innerType = checker.getTypeFromTypeNode(innerTypeNode);
  return isUnionWithUndefined(innerType);
}

export function isOptionalSymbol(symbol: ts.Symbol): boolean {
  return (symbol.flags & ts.SymbolFlags.Optional) !== 0;
}

/**
 * Returns true if `symbol` is the `Default` type alias from `@commonfabric/api`.
 *
 * Checks both the symbol name AND where it is declared
 * (`isCommonFabricSymbol()`), so that any user-defined type that happens to
 * be named "Default" is not treated as the framework's Default<T,V>.
 */
export function isDefaultAliasSymbol(symbol: ts.Symbol | undefined): boolean {
  return !!symbol && symbol.getName() === "Default" &&
    isCommonFabricSymbol(symbol);
}
