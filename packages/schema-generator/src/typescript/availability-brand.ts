/** Nominal recognition of Common Fabric availability types during schema generation. */

import ts from "typescript";
import { isCommonFabricSymbol } from "./common-fabric-symbols.ts";

const AVAILABILITY_TYPE_NAMES: ReadonlySet<string> = new Set([
  "FabricUnavailable",
  "IsPending",
  "IsSyncing",
  "HasError",
  "HasSchemaMismatch",
]);

/** Recognizes the canonical unavailable primitive and its narrowed aliases. */
export function isCommonFabricAvailabilityType(
  type: ts.Type,
  typeNode: ts.TypeNode | undefined,
): boolean {
  if (
    typeNode && ts.isTypeReferenceNode(typeNode) &&
    ts.isQualifiedName(typeNode.typeName) &&
    ts.isIdentifier(typeNode.typeName.left) &&
    typeNode.typeName.left.text === "__cfHelpers" &&
    AVAILABILITY_TYPE_NAMES.has(typeNode.typeName.right.text)
  ) return true;
  if (
    [type.aliasSymbol, type.getSymbol()].some((symbol) =>
      symbol !== undefined && AVAILABILITY_TYPE_NAMES.has(symbol.getName()) &&
      isCommonFabricSymbol(symbol)
    )
  ) return true;
  return type.isIntersection() &&
    type.types.some((part) => isCommonFabricAvailabilityType(part, undefined));
}
