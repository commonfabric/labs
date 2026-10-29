import ts from "typescript";
import { TwoLevelWeakCache } from "@commonfabric/utils/two-level-weak-cache";
import { traverseTypeHierarchy } from "./type-traversal.ts";

export type CellBrand =
  | "opaque"
  | "cell"
  | "stream"
  | "comparable"
  | "readonly"
  | "writeonly"
  | "sqlite";

export type CellWrapperKind =
  | "OpaqueCell"
  | "Cell"
  | "Stream"
  | "ComparableCell"
  | "ReadonlyCell"
  | "WriteonlyCell"
  | "SqliteDb"
  | "Reactive";

export interface CellWrapperInfo {
  brand: CellBrand;
  kind: CellWrapperKind;
  typeRef: ts.TypeReference;
}

export function isCellInternalMarkerName(name: string): boolean {
  return name === "CELL_BRAND" ||
    name === "CELL_INNER_TYPE" ||
    name.startsWith("__@CELL_BRAND") ||
    name.startsWith("__@CELL_INNER_TYPE");
}

function isCellBrandSymbol(symbol: ts.Symbol): boolean {
  const name = symbol.getName();
  if (isCellInternalMarkerName(name)) {
    return true;
  }

  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration)) &&
      ts.isComputedPropertyName(declaration.name)
    ) {
      const expr = declaration.name.expression;
      if (ts.isIdentifier(expr) && expr.text === "CELL_BRAND") {
        return true;
      }
    }
  }

  return false;
}

function getBrandSymbolFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  for (const prop of checker.getPropertiesOfType(type)) {
    if (isCellBrandSymbol(prop)) {
      return prop;
    }
  }
  return undefined;
}

function findCellBrandSymbol(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
): ts.Symbol | undefined {
  return traverseTypeHierarchy(type, {
    checker,
    checkType: (t) => getBrandSymbolFromType(t, checker),
    visitApparentType: true,
    visitTypeReferenceTarget: true,
    visitBaseTypes: true,
  }, seen);
}

// A type's cell brand is invariant: it depends only on the type's own shape,
// which is fixed within the checker that owns the type. The transformer and
// schema-generation pipelines query the same types tens of thousands of times,
// so the hierarchy walk and `getPropertiesOfType` lookups below are memoized per
// (checker, type).
const cellBrandCache = new TwoLevelWeakCache<
  ts.TypeChecker,
  ts.Type,
  CellBrand | undefined
>();

function computeCellBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): CellBrand | undefined {
  const brandSymbol = findCellBrandSymbol(type, checker, new Set());
  if (!brandSymbol) return undefined;

  const declaration = brandSymbol.valueDeclaration ??
    brandSymbol.declarations?.[0];
  if (!declaration) return undefined;

  const brandType = checker.getTypeOfSymbolAtLocation(brandSymbol, declaration);
  if (brandType && (brandType.flags & ts.TypeFlags.StringLiteral)) {
    return (brandType as ts.StringLiteralType).value as CellBrand;
  }

  return undefined;
}

export function getCellBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): CellBrand | undefined {
  return cellBrandCache.memoize(
    checker,
    type,
    () => computeCellBrand(type, checker),
  );
}

export function isCellType(type: ts.Type, checker: ts.TypeChecker): boolean {
  return getCellBrand(type, checker) !== undefined;
}

export function isCellBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
  brand: CellBrand,
): boolean {
  return getCellBrand(type, checker) === brand;
}

/**
 * It's possible we'll support different brands and cellkind values,
 * but for now, these are the same.
 */
export function getCellKind(
  type: ts.Type,
  checker: ts.TypeChecker,
): CellBrand | undefined {
  return getCellBrand(type, checker);
}

function brandToWrapperKind(brand: CellBrand): CellWrapperKind | undefined {
  switch (brand) {
    case "opaque":
      return "OpaqueCell";
    case "stream":
      return "Stream";
    case "cell":
      return "Cell";
    case "comparable":
      return "ComparableCell";
    case "readonly":
      return "ReadonlyCell";
    case "writeonly":
      return "WriteonlyCell";
    case "sqlite":
      return "SqliteDb";
    default:
      return undefined;
  }
}

export function wrapperKindToBrand(
  wrapperKind: CellWrapperKind,
): CellBrand | undefined {
  switch (wrapperKind) {
    case "OpaqueCell":
    case "Reactive":
      return "opaque";
    case "Stream":
      return "stream";
    case "Cell":
      return "cell";
    case "ComparableCell":
      return "comparable";
    case "ReadonlyCell":
      return "readonly";
    case "WriteonlyCell":
      return "writeonly";
    case "SqliteDb":
      return "sqlite";
    default:
      return undefined;
  }
}

function extractWrapperTypeReference(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
): ts.TypeReference | undefined {
  return traverseTypeHierarchy(type, {
    checker,
    checkType: (t) => {
      if (t.flags & ts.TypeFlags.Object) {
        const objectType = t as ts.ObjectType;
        if (objectType.objectFlags & ts.ObjectFlags.Reference) {
          const typeRef = objectType as ts.TypeReference;
          const typeArgs = typeRef.typeArguments ??
            checker.getTypeArguments(typeRef);
          if (typeArgs && typeArgs.length > 0) {
            return typeRef;
          }
        }
      }
      return undefined;
    },
  }, seen);
}

export function getCellWrapperInfo(
  type: ts.Type,
  checker: ts.TypeChecker,
): CellWrapperInfo | undefined {
  const brand = getCellBrand(type, checker);
  if (!brand) return undefined;

  const kind = brandToWrapperKind(brand);
  if (!kind) return undefined;

  const typeRef = extractWrapperTypeReference(type, checker, new Set());
  if (!typeRef) return undefined;

  return { brand, kind, typeRef };
}
