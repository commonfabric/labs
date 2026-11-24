import ts from "typescript";
import {
  type CellBrand,
  getCellBrand,
  getCellKind as utilGetCellKind,
} from "@commonfabric/schema-generator/cell-brand";

/**
 * Check if a type is a cell type by looking for the CELL_BRAND property.
 * This includes OpaqueCell, Cell, Stream, and other cell variants.
 */
export function isBrandedCellType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if (type.getCallSignatures().length > 0) {
    return false;
  }
  if (type.flags & ts.TypeFlags.Union) {
    return (type as ts.UnionType).types.some((t) =>
      isBrandedCellType(t, checker)
    );
  }
  if (type.flags & ts.TypeFlags.Intersection) {
    return (type as ts.IntersectionType).types.some((t) =>
      isBrandedCellType(t, checker)
    );
  }

  // Look for the CELL_BRAND unique symbol on the type.
  const brand = getCellBrand(type, checker);
  if (brand !== undefined) {
    // Valid cell brands: "opaque", "cell", "stream", "comparable", "readonly",
    // "writeonly", "sqlite"
    return [
      "opaque",
      "cell",
      "stream",
      "comparable",
      "readonly",
      "writeonly",
      "sqlite",
    ]
      .includes(brand);
  }

  return false;
}

/**
 * Get the cell kind from a type ("opaque", "cell", or "stream").
 * Maps other cell types to their logical category.
 * Returns undefined if not a cell type.
 */
export function getCellKind(
  type: ts.Type,
  checker: ts.TypeChecker,
): CellBrand | undefined {
  return utilGetCellKind(type, checker);
}

export function isSimpleReactiveAccess(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (
    ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
  ) {
    const type = checker.getTypeAtLocation(expression);
    return isBrandedCellType(type, checker);
  }
  return false;
}
