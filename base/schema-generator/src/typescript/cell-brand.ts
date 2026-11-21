import ts from "typescript";
import { TwoLevelWeakCache } from "@commonfabric/collections/two-level-weak-cache";
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

/**
 * Whether `name` is the name of a member keyed by one of the `unique symbol`s
 * `CELL_BRAND` and `CELL_INNER_TYPE` that `BrandedCell` declares.
 */
function isCellInternalMarkerName(name: string): boolean {
  return name.startsWith("__@CELL_BRAND") ||
    name.startsWith("__@CELL_INNER_TYPE");
}

function isCellBrandSymbol(symbol: ts.Symbol): boolean {
  if (isCellInternalMarkerName(symbol.getName())) {
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
  if (brandType?.isUnion()) {
    return kindOfBrandUnion(brandType);
  }

  return undefined;
}

/**
 * For a kind, the other kinds of cell assignable to a cell of that kind. A
 * cell type declares its brand as the union of its own kind and the kinds
 * listed here for it, which is what makes cells of those kinds assignable to
 * it: `ReadonlyCell` declares `"readonly" | "cell"`.
 */
const KINDS_ASSIGNABLE_TO: ReadonlyMap<CellBrand, readonly CellBrand[]> =
  new Map([["readonly", ["cell"]]]);

/**
 * Helper for `computeCellBrand()`, which returns the kind a brand that is a
 * union names: the kind whose entry in `KINDS_ASSIGNABLE_TO` lists exactly the
 * union's other members. Any other union, such as the brand of a union of a
 * cell and a stream, names no kind.
 */
function kindOfBrandUnion(brand: ts.UnionType): CellBrand | undefined {
  const members = new Set<string>();
  for (const member of brand.types) {
    if (!member.isStringLiteral()) return undefined;
    members.add(member.value);
  }
  for (const [kind, others] of KINDS_ASSIGNABLE_TO) {
    if (
      members.size === others.length + 1 &&
      members.has(kind) &&
      others.every((other) => members.has(other))
    ) {
      return kind;
    }
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

export function wrapperKindToBrand(wrapperKind: CellWrapperKind): CellBrand {
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
  }
}

/**
 * Whether `type` is a type parameter or is built from one: as a member of a
 * union or an intersection, as a type argument, or as the type of a property
 * of an object type written in place. `seen` holds the types already looked
 * at, so a type that refers to itself is looked at once.
 */
function mentionsTypeParameter(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): boolean {
  if (type.flags & ts.TypeFlags.TypeParameter) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  const within = (inner: ts.Type) =>
    mentionsTypeParameter(inner, checker, seen);
  if (type.isUnionOrIntersection()) return type.types.some(within);
  if (type.aliasTypeArguments?.some(within)) return true;
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  const objectType = type as ts.ObjectType;
  if (objectType.objectFlags & ts.ObjectFlags.Reference) {
    return checker.getTypeArguments(objectType as ts.TypeReference)
      .some(within);
  }
  if (objectType.objectFlags & ts.ObjectFlags.Anonymous) {
    return type.getProperties().some((property) =>
      within(checker.getTypeOfSymbol(property))
    );
  }
  return false;
}

/**
 * Returns the first reference with a type argument in the hierarchy of
 * `type`, which is the wrapper's own where the wrapper is what was written.
 * With `named`, only a reference to the type of that name counts.
 */
function extractWrapperTypeReference(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
  named?: string,
): ts.TypeReference | undefined {
  return traverseTypeHierarchy(type, {
    checker,
    // A named type is looked for among the types the given one extends.
    visitTypeReferenceTarget: named !== undefined,
    visitBaseTypes: named !== undefined,
    checkType: (t) => {
      if (t.flags & ts.TypeFlags.Object) {
        const objectType = t as ts.ObjectType;
        if (objectType.objectFlags & ts.ObjectFlags.Reference) {
          const typeRef = objectType as ts.TypeReference;
          const typeArgs = typeRef.typeArguments ??
            checker.getTypeArguments(typeRef);
          if (
            typeArgs && typeArgs.length > 0 &&
            (named === undefined ||
              // Reached through a declaration, a base can still carry the
              // declaration's own parameter, as `SqliteDb<T>` does under
              // `interface Board<T> extends SqliteDb<T>`. That names no
              // payload, and the search by name gives way to the plain one.
              (typeRef.target.symbol?.name === named &&
                !typeArgs.some((arg) => mentionsTypeParameter(arg, checker))))
          ) {
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

  // A database handle has subtypes with type parameters of their own, as
  // `IndexedCollections<Kinds>` has, and the first of those is not the value
  // the handle reads as. The reference to `SqliteDb` itself carries that.
  const typeRef =
    (kind === "SqliteDb"
      ? extractWrapperTypeReference(type, checker, new Set(), "SqliteDb")
      : undefined) ?? extractWrapperTypeReference(type, checker, new Set());
  if (!typeRef) return undefined;

  return { brand, kind, typeRef };
}
