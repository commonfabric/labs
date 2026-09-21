import ts from "typescript";

import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import type { MutableJSONSchema } from "@commonfabric/api";
import { NativeTypeFormatter } from "./formatters/native-type-formatter.ts";
import { getPropertyNameText } from "./typescript/property-name.ts";
import type { CellWrapperKind } from "./typescript/cell-brand.ts";
import {
  isWrapperSpelling,
  spellingsWhere,
  WRAPPER_SPELLING_TO_KIND,
  type WrapperSpelling,
} from "./typescript/wrapper-names.ts";

/**
 * Names that should be treated as Cell-like wrapper types.
 * "Writable" is an alias for "Cell" that better expresses semantic meaning.
 *
 * NB: this keys off raw type-node NAMES (hence `Writable` is listed and
 * `OpaqueCell` is split into `OPAQUE_WRAPPER_NAMES`). It is intentionally
 * distinct from `common-fabric-formatter.ts`'s `CELL_CAPABILITY_KIND_MAP`,
 * which keys off RESOLVED `CellWrapperKind` values (where `Writable` has already
 * normalized to `Cell` and `OpaqueCell` belongs with the rest).
 */
const CELL_LIKE_WRAPPER_NAMES = spellingsWhere({
  Cell: true,
  Writable: true,
  ReadonlyCell: true,
  WriteonlyCell: true,
  ComparableCell: true,
  OpaqueCell: false, // split into OPAQUE_WRAPPER_NAMES (see NB above)
  Stream: false, // handled separately at each call site
  SqliteDb: false, // handled separately at each call site
  Reactive: false,
  CellTypeConstructor: false,
  ScopedCellTypeConstructor: false,
});

const OPAQUE_WRAPPER_NAMES = spellingsWhere({
  OpaqueCell: true,
  Cell: false,
  Writable: false,
  ReadonlyCell: false,
  WriteonlyCell: false,
  ComparableCell: false,
  Stream: false,
  SqliteDb: false,
  Reactive: false,
  CellTypeConstructor: false,
  ScopedCellTypeConstructor: false,
});
type NodeWrapperKind = "Default" | CellWrapperKind;

function getEntityNameText(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

// Spellings that participate in node-level wrapper detection. Reactive is
// deliberately excluded: wrapperKindForName has never treated it as a node
// wrapper, and its callers (Default-literal and type-name resolution) must not
// start unwrapping it.
const NODE_WRAPPER_SPELLINGS: Readonly<Record<WrapperSpelling, boolean>> = {
  Cell: true,
  Writable: true,
  ReadonlyCell: true,
  WriteonlyCell: true,
  ComparableCell: true,
  OpaqueCell: true,
  Stream: true,
  SqliteDb: true,
  Reactive: false,
  CellTypeConstructor: false,
  ScopedCellTypeConstructor: false,
};

function wrapperKindForName(name: string): NodeWrapperKind | undefined {
  if (name === "Default") return "Default";
  if (!isWrapperSpelling(name) || !NODE_WRAPPER_SPELLINGS[name]) {
    return undefined;
  }
  return WRAPPER_SPELLING_TO_KIND[name];
}

export { getPropertyNameText };

/**
 * Safely get text from a Node, handling synthetic nodes (pos=-1) that lack
 * real source positions. Falls back to ts.createPrinter() to avoid triggering
 * TypeScript's assertHasRealPosition debug assertion.
 */
export function safeGetNodeText(node: ts.Node): string {
  try {
    const sourceFile = node.getSourceFile?.();
    if (sourceFile && node.pos >= 0 && node.end >= 0) {
      return node.getText(sourceFile);
    }
  } catch {
    // fall through to printer
  }
  try {
    const printer = ts.createPrinter();
    return printer.printNode(
      ts.EmitHint.Unspecified,
      node,
      ts.createSourceFile("", "", ts.ScriptTarget.Latest),
    );
  } catch {
    return "";
  }
}

/**
 * Safe wrapper for TypeScript checker APIs that may throw in reduced environments
 */
export function safeGetTypeFromTypeNode(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
  context?: string,
): ts.Type | undefined {
  try {
    return checker.getTypeFromTypeNode(node);
  } catch (error) {
    console.warn(
      `Failed to get type from node${context ? ` in ${context}` : ""}:`,
      error,
    );
    return undefined;
  }
}

/**
 * Safe wrapper for getting type of symbol at location
 */
export function safeGetTypeOfSymbolAtLocation(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  location: ts.Node,
  context?: string,
): ts.Type | undefined {
  try {
    return checker.getTypeOfSymbolAtLocation(symbol, location);
  } catch (error) {
    console.warn(
      `Failed to get type of symbol at location${
        context ? ` in ${context}` : ""
      }:`,
      error,
    );
    return undefined;
  }
}

/**
 * Safe wrapper for getting index type
 */
export function safeGetIndexTypeOfType(
  checker: ts.TypeChecker,
  type: ts.Type,
  kind: ts.IndexKind,
  context?: string,
): ts.Type | undefined {
  try {
    return checker.getIndexTypeOfType(type, kind);
  } catch (error) {
    console.warn(
      `Failed to get index type${context ? ` in ${context}` : ""}:`,
      error,
    );
    return undefined;
  }
}

/**
 * Safely resolve a property's type, preferring AST nodes to avoid deep checker recursion
 */
export function safeGetPropertyType(
  prop: ts.Symbol,
  parentType: ts.Type,
  checker: ts.TypeChecker,
  fallbackNode?: ts.TypeNode,
): ts.Type {
  const decl = prop.valueDeclaration;
  const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;

  // Get type from the resolved parent type (for generic instantiation and mapped types)
  // We'll use this to validate/override the declaration-based type if needed
  let typeFromParent: ts.Type | undefined;
  try {
    const propName = prop.getName();
    const propSymbol = checker.getPropertyOfType(parentType, propName);
    if (propSymbol) {
      typeFromParent = checker.getTypeOfSymbol(propSymbol);
      const typeStr = typeFromParent
        ? checker.typeToString(typeFromParent)
        : undefined;
      // If we got 'any', treat it as if we didn't get a type
      if (typeStr === "any") {
        typeFromParent = undefined;
      }
    }
  } catch (error) {
    // Type resolution can fail for some edge cases - fall back to declaration type
    console.warn(
      `Failed to resolve property type from parent for "${prop.getName()}":`,
      error,
    );
  }

  // Try to get type from declaration
  let typeFromDecl: ts.Type | undefined;
  if (decl && ts.isPropertySignature(decl) && decl.type) {
    typeFromDecl = safeGetTypeFromTypeNode(
      checker,
      decl.type,
      "property signature",
    );
  }

  // If we have both, and they differ, prefer parent (handles generic instantiation)
  // Example: Box<number> where property is declared as `value: T` but should resolve to `number`
  if (typeFromParent && typeFromDecl) {
    const parentStr = checker.typeToString(typeFromParent);
    const declStr = checker.typeToString(typeFromDecl);

    if (parentStr !== declStr) {
      // For optional properties, the parent type may include "| undefined" which we don't want
      // The optionality is tracked separately in the schema via the required array
      // Check if parent is a union that contains undefined, and if removing it gives us the decl type
      if (isOptional && typeFromParent.isUnion()) {
        const parentUnion = typeFromParent as ts.UnionType;
        const hasUndefined = parentUnion.types.some((t) =>
          !!(t.flags & ts.TypeFlags.Undefined)
        );

        if (hasUndefined) {
          const nonUndefinedTypes = parentUnion.types.filter(
            (t) => !(t.flags & ts.TypeFlags.Undefined),
          );

          // Compare the non-undefined part with the declaration type
          // Handle both single types and remaining unions
          if (nonUndefinedTypes.length === 1 && nonUndefinedTypes[0]) {
            const withoutUndefined = checker.typeToString(nonUndefinedTypes[0]);
            if (withoutUndefined === declStr) {
              // Parent only differs by the added | undefined, use decl
              return typeFromDecl;
            }
          } else if (nonUndefinedTypes.length > 1) {
            // Compare as sets (order-independent) since TypeScript's internal union ordering
            // (primitives before object types) may differ from the source declaration order.
            // e.g. `Date | null` declared in source becomes `null | Date` internally.
            const nonUndefinedStrs = new Set(
              nonUndefinedTypes.map((t) => checker.typeToString(t)),
            );
            const declMemberStrs: Set<string> = typeFromDecl.isUnion()
              ? new Set(
                (typeFromDecl as ts.UnionType).types.map((t) =>
                  checker.typeToString(t)
                ),
              )
              : new Set([declStr]);
            if (
              nonUndefinedStrs.size === declMemberStrs.size &&
              [...nonUndefinedStrs].every((s) => declMemberStrs.has(s))
            ) {
              return typeFromDecl;
            }
          }
        }
      }

      // Types differ - parent has the instantiated/resolved version (e.g., T -> number)
      return typeFromParent;
    }
  }

  // If only parent type available (e.g., mapped types with no declaration), use it
  if (typeFromParent && !typeFromDecl) {
    // For optional properties from mapped types (like Partial<T>), the parent type
    // includes "| undefined", but we want just the base type since optionality
    // is tracked separately in the required array
    if (isOptional && typeFromParent.isUnion()) {
      const unionType = typeFromParent as ts.UnionType;
      const nonUndefinedTypes = unionType.types.filter(
        (t) => !(t.flags & ts.TypeFlags.Undefined),
      );
      if (nonUndefinedTypes.length === 1 && nonUndefinedTypes[0]) {
        return nonUndefinedTypes[0];
      }
      // If multiple non-undefined types, just use parent as-is
      // The schema generator will handle the union properly
    }

    return typeFromParent;
  }

  // Otherwise use declaration type
  if (typeFromDecl) {
    return typeFromDecl;
  }

  // Fallback to provided node
  if (fallbackNode) {
    const typeFromFallback = safeGetTypeFromTypeNode(
      checker,
      fallbackNode,
      "property fallback node",
    );
    if (typeFromFallback) return typeFromFallback;
  }

  // Try symbol location as last resort before giving up
  if (decl) {
    const typeFromSymbol = safeGetTypeOfSymbolAtLocation(
      checker,
      prop,
      decl,
      "property symbol location",
    );
    if (typeFromSymbol) return typeFromSymbol;
  }

  // Absolute last resort - return 'any' type
  return checker.getAnyType();
}

/**
 * TypeScript internal API type extensions for safer casting
 */
export interface TypeWithInternals extends ts.Type {
  aliasSymbol?: ts.Symbol;
  aliasTypeArguments?: readonly ts.Type[];
  resolvedTypeArguments?: readonly ts.Type[];
  intrinsicName?: string;
}

/**
 * Resolve the most relevant symbol for a type, accounting for references,
 * aliases, and internal helper accessors exposed on some compiler objects.
 */
export function getPrimarySymbol(type: ts.Type): ts.Symbol | undefined {
  if (type.symbol) return type.symbol;
  const ref = type as ts.TypeReference;
  if (ref.target?.symbol) return ref.target.symbol;
  const alias = (type as TypeWithInternals).aliasSymbol;
  if (alias) return alias;
  return undefined;
}

export function cloneSchemaDefinition<T extends MutableJSONSchema>(
  schema: T,
): T {
  // TODO(danfuzz): `structuredClone()` mangles non-JSON `FabricValue`s —
  // harmless while generated schemas are plain JSON, but a problem once
  // schema-generator covers the full `FabricValue` spectrum. It then needs a
  // FabricValue-aware clone; also revisit whether a freely-mutable result is
  // required at all (callers just return it), since an immutable base plus
  // `cloneForMutation()` for scoped edits is a safer pattern.
  return (typeof schema === "boolean" ? schema : structuredClone(schema)) as T;
}

export function getNativeTypeSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
): MutableJSONSchema | undefined {
  const visited = new Set<ts.Type>();

  const resolve = (
    current: ts.Type,
  ): MutableJSONSchema | undefined => {
    if (visited.has(current)) return undefined;
    visited.add(current);

    if ((current.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const base = checker.getBaseConstraintOfType(current);
      if (base && base !== current) {
        const resolved = resolve(base);
        if (resolved !== undefined) return resolved;
      }
      const defaultConstraint = checker.getDefaultFromTypeParameter?.(current);
      if (defaultConstraint && defaultConstraint !== current) {
        const resolved = resolve(defaultConstraint);
        if (resolved !== undefined) return resolved;
      }
      return undefined;
    }

    if ((current.flags & ts.TypeFlags.Intersection) !== 0) {
      const intersection = current as ts.IntersectionType;
      for (const part of intersection.types) {
        const resolved = resolve(part);
        if (resolved !== undefined) return resolved;
      }
    }

    const symbol = getPrimarySymbol(current);
    const name = symbol?.getName();

    // Reject non-JSON-serializable collection types
    // These types cannot be properly serialized to JSON and should not be used
    // in pattern inputs/outputs
    if (name === "Map" || name === "WeakMap") {
      throw new Error(
        `${name} cannot be used in pattern inputs/outputs because it is not JSON-serializable. ` +
          `Use Record<string, V> for key-value data or Array<[K, V]> for ordered pairs instead.`,
      );
    }
    if (name === "Set" || name === "WeakSet") {
      throw new Error(
        `${name} cannot be used in pattern inputs/outputs because it is not JSON-serializable. ` +
          `Use Array<T> instead.`,
      );
    }
    return undefined;
  };

  return resolve(type);
}

/**
 * Return a public/stable named key for a type if and only if it has a useful
 * symbol name. Filters out anonymous ("__type") and wrapper/container names
 * that we do not want to promote into top-level definitions.
 */
export function getNamedTypeKey(
  type: ts.Type,
  typeNode?: ts.TypeNode,
): string | undefined {
  // Check if the TypeNode indicates this is a wrapper type (Default/Cell/Stream/Reactive)
  // Even if the type symbol says it's the inner type, if it's wrapped we shouldn't hoist it
  if (typeNode && ts.isTypeReferenceNode(typeNode)) {
    const nodeTypeName = getEntityNameText(typeNode.typeName);
    if (
      nodeTypeName === "Default" || CELL_LIKE_WRAPPER_NAMES.has(nodeTypeName) ||
      nodeTypeName === "Stream" || nodeTypeName === "SqliteDb" ||
      OPAQUE_WRAPPER_NAMES.has(nodeTypeName)
    ) {
      return undefined;
    }
  }

  // Check if this is a Default/Cell/Stream/Reactive wrapper type via alias
  const aliasName = (type as TypeWithInternals).aliasSymbol?.name;
  if (
    aliasName === "Default" || CELL_LIKE_WRAPPER_NAMES.has(aliasName ?? "") ||
    aliasName === "Stream" || aliasName === "SqliteDb" ||
    aliasName === "Reactive"
  ) {
    return undefined;
  }

  // Prefer direct symbol name; fall back to target symbol for TypeReference
  const symbol = type.symbol;
  let name = symbol?.name;
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
  if (!name && (objectFlags & ts.ObjectFlags.Reference)) {
    const ref = type as unknown as ts.TypeReference;
    name = ref.target?.symbol?.name ?? name;
  }
  // Known compiler-internal anonymous type names
  // Using a minimal whitelist - only block the most common cases we know are problematic.
  // Fail open: if uncertain, let it through rather than break user code (like GraphQL __Schema types).
  const compilerInternalNames = new Set([
    "__type", // Anonymous object literals
    "__object", // Anonymous object types
  ]);

  // Helper to check if a name is compiler-internal/anonymous
  // vs. user-defined types that happen to start with __ (e.g., GraphQL introspection types like __Schema)
  const isAnonymousName = (n: string | undefined) => {
    if (!n) return true; // No name = anonymous
    return compilerInternalNames.has(n); // Check against whitelist
  };

  // Fall back to alias symbol when present (type aliases) if we haven't used it yet
  // This includes the case where symbol.name is "__type" (anonymous object literal)
  // but the type has an explicit alias name
  if (isAnonymousName(name) && aliasName) {
    name = aliasName;
  }
  // Filter out compiler-internal anonymous type names
  if (isAnonymousName(name)) {
    return undefined;
  }
  // Exclude property/method-like symbols (member names), which are not real named types
  const symFlags = symbol?.flags ?? 0;
  if (
    (symFlags & ts.SymbolFlags.Property) !== 0 ||
    (symFlags & ts.SymbolFlags.Method) !== 0 ||
    (symFlags & ts.SymbolFlags.Signature) !== 0 ||
    (symFlags & ts.SymbolFlags.Function) !== 0 ||
    (symFlags & ts.SymbolFlags.TypeParameter) !== 0 ||
    (symFlags & ts.SymbolFlags.EnumMember) !== 0
  ) {
    return undefined;
  }
  const decls = symbol?.declarations ?? [];
  if (
    decls.some((d) =>
      ts.isPropertySignature(d) || ts.isMethodSignature(d) ||
      ts.isPropertyDeclaration(d) || ts.isMethodDeclaration(d) ||
      ts.isEnumMember(d)
    )
  ) {
    return undefined;
  }
  // Avoid promoting wrappers/containers into definitions
  if (name === "Array" || name === "ReadonlyArray") return undefined;
  if (
    CELL_LIKE_WRAPPER_NAMES.has(name ?? "") || name === "Stream" ||
    name === "SqliteDb" || name === "Default"
  ) {
    return undefined;
  }

  // If we are overriding the type, don't return a named type key.
  // This makes it so we include these inline instead of as $defs. The
  // `FabricPrimitive` names are only claimed by NativeTypeFormatter when the
  // type carries the `FabricPrimitive` brand; hoisting classifies the same
  // way, so an unbranded user type sharing a name hoists normally.
  if (NativeTypeFormatter.isNativeType(name)) {
    if (
      !NativeTypeFormatter.isFabricPrimitiveTypeName(name) ||
      NativeTypeFormatter.declaresFabricPrimitiveBrand(type)
    ) {
      return undefined;
    }
  }
  // Don't hoist generic type instantiations (Record<K,V>, Partial<T>, Box<T>, etc.)
  // These have aliasTypeArguments, meaning they're a generic type applied to specific type arguments
  // The name "Record" or "Box" is meaningless without the type parameters - what matters is the
  // resolved/instantiated type structure
  const typeWithAlias = type as TypeWithInternals;
  if (
    typeWithAlias.aliasTypeArguments &&
    typeWithAlias.aliasTypeArguments.length > 0
  ) {
    return undefined;
  }

  // Also check for generic interface/class instantiations (e.g., PatternToolResult<E>)
  // Type aliases use aliasTypeArguments (checked above), but interfaces and classes
  // store their type arguments in TypeReference.typeArguments instead.
  //
  // Important: Skip this check if the type has an alias name (like `type ItemTuple = [...]`).
  // The alias provides a unique, user-defined name that should be used for hoisting.
  // We only want to prevent hoisting for anonymous generic interface instantiations
  // where different instantiations (e.g., PatternToolResult<A> vs PatternToolResult<B>)
  // would incorrectly collide under the same base name.
  if (objectFlags & ts.ObjectFlags.Reference && !aliasName) {
    const typeRef = type as ts.TypeReference;
    const target = typeRef.target as ts.InterfaceType | undefined;
    // Only reject if target has type parameters (is a generic interface/class)
    // AND there are type arguments provided for this instantiation
    if (
      target?.typeParameters &&
      target.typeParameters.length > 0 &&
      typeRef.typeArguments &&
      typeRef.typeArguments.length > 0
    ) {
      return undefined;
    }
  }

  return name;
}

/**
 * Determine if a type represents a callable/constructable function value.
 */
export function isFunctionLike(type: ts.Type): boolean {
  if (type.getCallSignatures().length > 0) return true;
  if (type.getConstructSignatures().length > 0) return true;

  const symbol = type.symbol;
  if (!symbol) return false;

  const flags = symbol.flags;
  if (
    (flags & ts.SymbolFlags.Function) !== 0 ||
    (flags & ts.SymbolFlags.Method) !== 0 ||
    (flags & ts.SymbolFlags.Signature) !== 0
  ) {
    return true;
  }

  return false;
}

/**
 * Helper to extract array element type using multiple detection methods
 */
export type ArrayElementInfo = {
  elementType: ts.Type;
  elementNode?: ts.TypeNode;
};

/**
 * Helper to get array element type and, when available, the element node used in the AST.
 * Prefer node-first detection for stability in reduced lib environments and aliases.
 */
export function getArrayElementInfo(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
): ArrayElementInfo | undefined {
  if (typeNode) {
    // Direct syntax T[]
    if (ts.isArrayTypeNode(typeNode)) {
      // For array types, get the element type from the parent array Type
      // instead of from the element TypeNode (which would widen to any for synthetic nodes)
      const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (elementType) {
        return {
          elementType,
          elementNode: typeNode.elementType,
        };
      }
    }

    // Reference syntax Array<T> or alias to it
    if (ts.isTypeReferenceNode(typeNode)) {
      const tn = typeNode.typeName;
      if (ts.isIdentifier(tn)) {
        const id = tn.text;
        // If the node itself is Array/ReadonlyArray, use its type argument
        if (
          (id === "Array" || id === "ReadonlyArray") &&
          typeNode.typeArguments && typeNode.typeArguments.length > 0
        ) {
          const argNode = typeNode.typeArguments[0]!;
          const elementType = safeGetTypeFromTypeNode(
            checker,
            argNode,
            "Array<T> type argument",
          );
          if (elementType) {
            return {
              elementType,
              elementNode: argNode,
            };
          }
        }
        // Resolve alias: if this is a type alias referring to Array<T> or T[]
        const sym = checker.getSymbolAtLocation(tn);
        const decl = sym?.declarations?.[0];
        if (decl && ts.isTypeAliasDeclaration(decl)) {
          const aliased = decl.type;
          if (ts.isArrayTypeNode(aliased)) {
            const elementType = safeGetTypeFromTypeNode(
              checker,
              aliased.elementType,
              "aliased array element type",
            );
            // If the element type is a type parameter (e.g., T from the alias declaration),
            // don't use it - fall through to extract from the actual type instead
            if (
              elementType &&
              (elementType.flags & ts.TypeFlags.TypeParameter) === 0
            ) {
              return {
                elementType,
                elementNode: aliased.elementType,
              };
            }
          }
          if (ts.isTypeReferenceNode(aliased)) {
            const name = aliased.typeName;
            if (
              ts.isIdentifier(name) &&
              (name.text === "Array" || name.text === "ReadonlyArray") &&
              aliased.typeArguments && aliased.typeArguments.length > 0
            ) {
              const argNode = aliased.typeArguments[0]!;
              const elementType = safeGetTypeFromTypeNode(
                checker,
                argNode,
                "aliased Array<T> type argument",
              );
              // If the element type is a type parameter (e.g., T from the alias declaration),
              // don't use it - fall through to extract from the actual type instead
              if (
                elementType &&
                (elementType.flags & ts.TypeFlags.TypeParameter) === 0
              ) {
                return {
                  elementType,
                  elementNode: argNode,
                };
              }
            }
          }
        }
      }
    }
  }

  // Only object-like types can be arrays. Prevent primitives like string
  // from being treated as array-like due to numeric index access.
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return undefined;
  }

  const native = getNativeTypeSchema(type, checker);
  if (native !== undefined) {
    return undefined;
  }
  // Check ObjectFlags.Reference for Array/ReadonlyArray
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;

  if (objectFlags & ts.ObjectFlags.Reference) {
    const typeRef = type as ts.TypeReference;
    const symbol = typeRef.target?.symbol;
    if (
      symbol && (symbol.name === "Array" || symbol.name === "ReadonlyArray")
    ) {
      const elementType = typeRef.typeArguments?.[0];
      if (elementType) return { elementType };
    }
  }

  // Check symbol name for Array
  if (type.symbol?.name === "Array") {
    const typeRef = type as ts.TypeReference;
    const elementType = typeRef.typeArguments?.[0];
    if (elementType) return { elementType };
  }

  // If the type also has a string index signature, prefer treating it as an
  // object map (not an array). This avoids misclassifying dictionary types
  // like `{ [k: string]: T; [n: number]: T }` as arrays.
  const stringIndex = safeGetIndexTypeOfType(
    checker,
    type,
    ts.IndexKind.String,
    "array/map disambiguation string index",
  );
  const numberIndex = safeGetIndexTypeOfType(
    checker,
    type,
    ts.IndexKind.Number,
    "array/map disambiguation number index",
  );
  if (stringIndex && numberIndex) {
    return undefined;
  }

  // Use numeric index type as fallback (for tuples/array-like objects)
  const elementType = safeGetIndexTypeOfType(
    checker,
    type,
    ts.IndexKind.Number,
    "array numeric index",
  );
  if (elementType) {
    return { elementType };
  }

  return undefined;
}

/**
 * Check if a type reference node represents Default<T,V>
 */
export function isDefaultTypeRef(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol> = new Set(),
): boolean {
  if (!node.typeName || !ts.isIdentifier(node.typeName)) return false;
  // Fast path: identifier text says "Default" even if symbol is missing
  if (node.typeName.text === "Default") return true;

  const symbol = checker.getSymbolAtLocation(node.typeName);
  if (!symbol) return false;

  // Prevent infinite recursion from circular aliases
  if (visited.has(symbol)) return false;
  visited.add(symbol);

  const symbolName = symbol.getName();
  if (symbolName === "Default") return true;

  // If this is an alias, resolve the alias target recursively
  const decl = symbol.declarations?.[0];
  if (decl && ts.isTypeAliasDeclaration(decl)) {
    const aliased = decl.type;
    if (ts.isTypeReferenceNode(aliased)) {
      return isDefaultTypeRef(aliased, checker, visited); // Recursive call with visited set
    }
  }
  return false;
}

/**
 * Checks if a type reference node (via literal name or alias chain) refers to a wrapper type.
 * Returns the wrapper kind if detected.
 *
 * This handles:
 * - Direct wrapper types: Default<T, V>, Cell<T>, Stream<T>, OpaqueCell<T>
 * - Aliases to wrappers: type MyDefault<T> = Default<T, T>
 *
 * Note: This only checks via typeNode. For structural detection of Cell/Stream/opaque wrappers
 * based on type identity, see CommonFabricFormatter.getWrapperTypeInfo().
 */
export function detectWrapperViaNode(
  typeNode: ts.TypeNode | undefined,
  typeChecker: ts.TypeChecker,
): NodeWrapperKind | undefined {
  const result = resolveWrapperNode(typeNode, typeChecker);
  return result?.kind;
}

/**
 * Resolve a type node to a wrapper type, following alias chains.
 * Returns both the wrapper kind and the resolved type reference node with type arguments.
 */
export function resolveWrapperNode(
  typeNode: ts.TypeNode | undefined,
  typeChecker: ts.TypeChecker,
): {
  kind: NodeWrapperKind;
  node: ts.TypeReferenceNode;
} | undefined {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }

  const literalName = getEntityNameText(typeNode.typeName);

  // Fast path: direct wrapper reference
  const directKind = wrapperKindForName(literalName);
  if (directKind) {
    return {
      kind: directKind,
      node: typeNode,
    };
  }

  // Follow alias chain
  if (!ts.isIdentifier(typeNode.typeName)) {
    return undefined;
  }
  return followAliasToWrapperNode(typeNode, typeChecker, new Set());
}

/**
 * Follow alias chains to detect if a type alias resolves to a wrapper type.
 * Returns both the wrapper kind and the resolved node with type arguments.
 */
function followAliasToWrapperNode(
  typeNode: ts.TypeReferenceNode,
  typeChecker: ts.TypeChecker,
  visited: Set<string>,
): {
  kind: NodeWrapperKind;
  node: ts.TypeReferenceNode;
} | undefined {
  // Caller must ensure typeNode.typeName is an Identifier.
  if (!ts.isIdentifier(typeNode.typeName)) {
    throw new Error("followAliasToWrapperNode requires an Identifier typeName");
  }

  const typeName = typeNode.typeName.text;

  // Detect circular aliases and throw descriptive error
  if (visited.has(typeName)) {
    const aliasChain = Array.from(visited).join(" -> ");
    throw new Error(
      `Circular type alias detected: ${aliasChain} -> ${typeName}`,
    );
  }
  visited.add(typeName);

  // Check if we've reached a wrapper type
  const directKind = wrapperKindForName(typeName);
  if (directKind) {
    return {
      kind: directKind,
      node: typeNode,
    };
  }

  // Look up the symbol for this type name
  const symbol = typeChecker.getSymbolAtLocation(typeNode.typeName);
  if (!symbol || !(symbol.flags & ts.SymbolFlags.TypeAlias)) {
    return undefined;
  }

  const aliasDeclaration = symbol.valueDeclaration || symbol.declarations?.[0];
  if (!aliasDeclaration || !ts.isTypeAliasDeclaration(aliasDeclaration)) {
    return undefined;
  }

  const aliasedType = aliasDeclaration.type;
  if (
    ts.isTypeReferenceNode(aliasedType) && ts.isIdentifier(aliasedType.typeName)
  ) {
    // Recursively follow the alias chain, returning the final resolved node
    return followAliasToWrapperNode(aliasedType, typeChecker, visited);
  }

  return undefined;
}

/**
 * Recognizes `{}` literals and propertyless records with only `never`-valued
 * indexes as empty defaults, including when reached through type aliases.
 */
export function isEmptyObjectDefaultType(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
): boolean {
  if (
    (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0 ||
    type.isIntersection() &&
      type.types.some((member) => (member.flags & ts.TypeFlags.Object) === 0) ||
    typeChecker.getPropertiesOfType(type).length !== 0 ||
    type.getCallSignatures().length !== 0 ||
    type.getConstructSignatures().length !== 0
  ) return false;

  const indexes = typeChecker.getIndexInfosOfType(type);
  if (indexes.length > 0) {
    return indexes.every((index) =>
      (index.type.flags & ts.TypeFlags.Never) !== 0
    );
  }
  return type.getSymbol()?.declarations?.some((declaration) =>
    ts.isTypeLiteralNode(declaration) && declaration.members.length === 0
  ) ?? false;
}

/**
 * Convert a purely literal-shaped Type to its JSON value: string/number/
 * boolean literals, null, literal tuples, and object-literal types whose
 * members are themselves literal-shaped. Returns the value wrapped (so a
 * legitimate `null` is distinguishable from "not extractable") or undefined
 * when any part of the type is not a literal.
 *
 * Used to read `Default<T, V>`'s V back out of the DEFAULT_MARKER brand
 * payload once the checker has resolved the alias away — the payload is the
 * only place V survives at the type level (see Default<> in
 * packages/api/index.ts). Deliberately type-structural only: payloads that
 * resolve to non-literal types (e.g. a widened `typeof CONST`) bail to
 * undefined, and the caller falls back to existing behavior.
 */
export function extractValueFromLiteralType(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
): { value: FabricValue } | undefined {
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return { value: (type as ts.StringLiteralType).value };
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return { value: (type as ts.NumberLiteralType).value };
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return {
      value: (type as unknown as { intrinsicName?: string }).intrinsicName ===
        "true",
    };
  }
  if (type.flags & ts.TypeFlags.Null) {
    return { value: null };
  }

  if (typeChecker.isTupleType(type)) {
    const elements = typeChecker.getTypeArguments(type as ts.TypeReference);
    const values: FabricValue[] = [];
    for (const element of elements) {
      const extracted = extractValueFromLiteralType(element, typeChecker);
      if (!extracted) return undefined;
      values.push(extracted.value);
    }
    return { value: values };
  }

  if (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    !typeChecker.isArrayType(type) &&
    type.getCallSignatures().length === 0 &&
    type.getConstructSignatures().length === 0
  ) {
    if (typeChecker.getIndexInfosOfType(type).length > 0) {
      return isEmptyObjectDefaultType(type, typeChecker)
        ? { value: {} }
        : undefined;
    }
    const props = typeChecker.getPropertiesOfType(type);
    const result: Record<string, FabricValue> = {};
    for (const prop of props) {
      const name = String(prop.escapedName as string);
      // Symbol-keyed members (`__@...`) mean this is a brand, not data.
      if (name.startsWith("__@")) return undefined;
      const propType = typeChecker.getTypeOfSymbol(prop);
      const extracted = extractValueFromLiteralType(propType, typeChecker);
      if (!extracted) return undefined;
      result[name] = extracted.value;
    }
    return { value: result };
  }

  return undefined;
}

/**
 * True for a "brand-only" object type that carries only symbol-keyed markers
 * (e.g. `{ readonly [DEFAULT_MARKER]: V }`) — no string-keyed data
 * properties. TypeScript encodes unique-symbol property names as "__@..."
 * internally; a type with only such properties is a brand, not data.
 */
export function isBrandOnlyMarkerType(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const props = typeChecker.getPropertiesOfType(type);
  if (props.length === 0) return true;
  return props.every((prop) =>
    String(prop.escapedName as string).startsWith("__@")
  );
}

/**
 * Recognizes an actual DEFAULT_MARKER property on an expanded Default member.
 * Ordinary empty objects and unrelated symbol brands do not promise a default.
 */
export function hasDefaultMarker(
  member: ts.Type,
  typeChecker: ts.TypeChecker,
): boolean {
  return getDefaultMarkerProperty(member, typeChecker) !== undefined;
}

/** Finds the marker on a brand-only constituent of an expanded Default. */
function getDefaultMarkerProperty(
  member: ts.Type,
  typeChecker: ts.TypeChecker,
): ts.Symbol | undefined {
  const brandParts = (member.flags & ts.TypeFlags.Intersection) !== 0
    ? ((member as ts.IntersectionType).types ?? []).filter((part) =>
      isBrandOnlyMarkerType(part, typeChecker)
    )
    : isBrandOnlyMarkerType(member, typeChecker)
    ? [member]
    : [];
  return brandParts
    .flatMap((part) => typeChecker.getPropertiesOfType(part))
    .find((prop) =>
      String(prop.escapedName as string).startsWith("__@DEFAULT_MARKER")
    );
}

function extractPayloadFromBrandedMember(
  member: ts.Type,
  typeChecker: ts.TypeChecker,
): { value: FabricValue } | undefined {
  const markerProp = getDefaultMarkerProperty(member, typeChecker);
  if (!markerProp) return undefined;
  const payload = typeChecker.getTypeOfSymbol(markerProp);
  const extracted = extractValueFromLiteralType(payload, typeChecker);
  if (!extracted || extracted.value === undefined) return undefined;
  return extracted;
}

/**
 * Extract the agreed default value from one or more branded members.
 *
 * A union-valued default distributes the brand across several members that
 * all carry the SAME payload — `Default<boolean, true>` expands to
 * `true & DefaultMarker<true> | false & DefaultMarker<true> | boolean`, two
 * branded members both paying `true`; likewise `Default<"a" | "b", "a">`.
 * Require every branded member to yield the same literal value and return it;
 * bail (undefined) on genuine disagreement — two distinct defaults in one
 * union is ambiguous and must never resolve to a guess.
 */
export function extractDefaultValueFromBrandedMembers(
  branded: readonly ts.Type[],
  typeChecker: ts.TypeChecker,
): { value: FabricValue } | undefined {
  if (branded.length === 0) return undefined;
  let agreed: { value: FabricValue } | undefined;
  for (const member of branded) {
    const extracted = extractPayloadFromBrandedMember(member, typeChecker);
    if (!extracted) return undefined;
    if (agreed === undefined) {
      agreed = extracted;
    } else if (
      hashStringOf(agreed.value) !== hashStringOf(extracted.value)
    ) {
      // Genuine disagreement between two branded members is ambiguous; bail.
      // The canonical content hash is the honest comparison here: a
      // `JSON.stringify` round-trip would call `-0` and `0` equal, and both
      // `NaN` and `Infinity` equal (each renders `null`), and would spuriously
      // disagree on equal objects written in a different key order.
      return undefined;
    }
  }
  return agreed;
}

export function extractDefaultBrandPayloadValue(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
): { value: FabricValue } | undefined {
  const members = type.isUnion() ? type.types : [type];
  const branded = members.filter((member) =>
    hasDefaultMarker(member, typeChecker)
  );
  return extractDefaultValueFromBrandedMembers(branded, typeChecker);
}
