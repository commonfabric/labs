import ts from "typescript";

import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import type { GenerationContext } from "./interface.ts";
import { NativeTypeFormatter } from "./formatters/native-type-formatter.ts";
import { declaresFabricPrimitiveBrand } from "./typescript/fabric-primitive-brand.ts";
import { getPropertyNameText } from "./typescript/property-name.ts";
import type { CellWrapperKind } from "./typescript/cell-brand.ts";
import { isCommonFabricSymbol } from "./typescript/common-fabric-symbols.ts";
import {
  getDefaultMarkerPayload,
  hasDefaultMarker,
} from "./typescript/default-brand.ts";
import {
  getTypeAliasDeclaration,
  holdsTypeParameter,
  sameBesidesUndefined,
  unwrapTypeParentheses,
} from "./typescript/type-node.ts";
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
 * NB: this keys off raw type NAMES (hence `Writable` is listed and
 * `OpaqueCell` is not). It is intentionally distinct from
 * `common-fabric-formatter.ts`'s `CELL_CAPABILITY_KIND_MAP`, which keys off
 * RESOLVED `CellWrapperKind` values (where `Writable` has already normalized
 * to `Cell` and `OpaqueCell` belongs with the rest).
 */
const CELL_LIKE_WRAPPER_NAMES = spellingsWhere({
  Cell: true,
  Writable: true,
  ReadonlyCell: true,
  WriteonlyCell: true,
  ComparableCell: true,
  OpaqueCell: false,
  Stream: false, // handled separately at each call site
  SqliteDb: false, // handled separately at each call site
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
 * Resolves the type of `prop` as a member of `parentType`, preferring its
 * declared type where `parentType` adds no more than `undefined` to it.
 */
export function resolvePropertyType(
  prop: ts.Symbol,
  parentType: ts.Type,
  checker: ts.TypeChecker,
  fallbackNode?: ts.TypeNode,
): ts.Type {
  // A property a homomorphic mapped type makes, as `Pick`, `Omit` and
  // `Partial` do, has no value declaration but keeps the declaration of the
  // property it maps, which says what its type is where the mapping leaves it.
  // One several members of an intersection or a union declare has none either,
  // and no one of its declarations says what its type is there.
  const decl = prop.valueDeclaration ??
    (prop.declarations?.length === 1
      ? prop.declarations.find(ts.isPropertySignature)
      : undefined);
  const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;

  // Get type from the resolved parent type (for generic instantiation and mapped types)
  // We'll use this to validate/override the declaration-based type if needed
  const propSymbol = checker.getPropertyOfType(parentType, prop.getName());
  const readFromParent = propSymbol && checker.getTypeOfSymbol(propSymbol);
  // A read of `any` says nothing about the property.
  const typeFromParent =
    readFromParent && checker.typeToString(readFromParent) !== "any"
      ? readFromParent
      : undefined;

  // Try to get type from declaration
  const declTypeNode = decl && ts.isPropertySignature(decl)
    ? decl.type
    : undefined;
  const typeFromDecl = declTypeNode &&
    checker.getTypeFromTypeNode(declTypeNode);

  // If we have both, and they differ, prefer parent (handles generic instantiation)
  // Example: Box<number> where property is declared as `value: T` but should resolve to `number`
  if (typeFromParent && typeFromDecl) {
    const parentStr = checker.typeToString(typeFromParent);
    const declStr = checker.typeToString(typeFromDecl);
    // A declaration written in type parameters that the parent instantiates
    // denotes another type even where the two print alike: `Box<U>` for
    // another declaration's `U` prints its property `value: U` the same as
    // `Box`'s own. An optional property's `?` adds `undefined` to it without
    // instantiating anything.
    const instantiated = declTypeNode !== undefined &&
      holdsTypeParameter(declTypeNode, checker) &&
      typeFromParent !== typeFromDecl &&
      !(isOptional && sameBesidesUndefined(typeFromParent, typeFromDecl));

    if (parentStr !== declStr || instantiated) {
      // For optional properties, the parent type may include "| undefined" which we don't want
      // The optionality is tracked separately in the schema via the required array
      // Check if parent is a union that contains undefined, and if removing it gives us the decl type
      if (isOptional && !instantiated && typeFromParent.isUnion()) {
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
  if (fallbackNode) return checker.getTypeFromTypeNode(fallbackNode);

  // Try symbol location as last resort before giving up
  if (decl) return checker.getTypeOfSymbolAtLocation(prop, decl);

  // Absolute last resort - return 'any' type
  return checker.getAnyType();
}

/**
 * The one member of `type` that is neither `undefined` nor `null`, or `type`
 * itself where it is no union; `undefined` where no one member remains.
 */
export function soleNonNullishMember(type: ts.Type): ts.Type | undefined {
  if (!type.isUnion()) return type;
  const rest = type.types.filter((member) =>
    (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0
  );
  return rest.length === 1 ? rest[0] : undefined;
}

/**
 * The type of property `name` of `instantiatedAs`, the type the checker
 * instantiates at a position read under bindings
 * (`GenerationContext.instantiatedAs`), less the `undefined` an optional
 * property's `?` adds; `undefined` where it has no such property.
 */
export function instantiatedPropertyType(
  instantiatedAs: ts.Type | undefined,
  name: string,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const property = instantiatedAs &&
    checker.getPropertyOfType(instantiatedAs, name);
  if (!property) return undefined;
  const type = checker.getTypeOfSymbol(property);
  return (property.flags & ts.SymbolFlags.Optional) !== 0
    ? soleNonNullishMember(type) ?? type
    : type;
}

/**
 * The element type of `instantiatedAs`, the type the checker instantiates at
 * an array, a readonly array, or a tuple read under bindings
 * (`GenerationContext.instantiatedAs`): its number index type, which for a
 * tuple is every element's.
 */
export function instantiatedElementType(
  instantiatedAs: ts.Type | undefined,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  return instantiatedAs &&
    checker.getIndexTypeOfType(instantiatedAs, ts.IndexKind.Number);
}

/**
 * The type of the values `instantiatedAs`, the type the checker instantiates
 * at a record or an object with an index signature read under bindings
 * (`GenerationContext.instantiatedAs`), holds: its string or number index
 * type, or, for a record over literal keys, which has none, the type its
 * properties share, where every one of them has the same type.
 */
export function instantiatedValueType(
  instantiatedAs: ts.Type | undefined,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (!instantiatedAs) return undefined;
  const indexed =
    checker.getIndexTypeOfType(instantiatedAs, ts.IndexKind.String) ??
      checker.getIndexTypeOfType(instantiatedAs, ts.IndexKind.Number);
  if (indexed) return indexed;
  const [first, ...rest] = checker.getPropertiesOfType(instantiatedAs).map(
    (property) => checker.getTypeOfSymbol(property),
  );
  return first &&
      rest.every((type) =>
        checker.isTypeAssignableTo(first, type) &&
        checker.isTypeAssignableTo(type, first)
      )
    ? first
    : undefined;
}

/**
 * Helper for `getArrayElementInfo()`, which throws where the symbol of the
 * object type `type` names a `Map`, `WeakMap`, `Set` or `WeakSet`, none of
 * which serializes to JSON, and returns normally otherwise.
 */
function rejectNonSerializableCollection(type: ts.Type): void {
  const name = type.symbol?.name;
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
}

/**
 * Return a public/stable named key for a type if and only if it has a useful
 * symbol name. Filters out anonymous ("__type") and wrapper/container names
 * that we do not want to promote into top-level definitions. A `typeNode`
 * that names a wrapper (`wrapperKindOfReference()`) leaves the type unnamed,
 * though the type is the wrapper's payload. A reference to a type of the
 * module's own that shares a wrapper's name names no wrapper there, but the
 * filters on the type's own name below still leave a type named `Default`,
 * `Stream`, `SqliteDb` or a cell wrapper's name unnamed, whatever declares it.
 */
export function getNamedTypeKey(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
): string | undefined {
  if (
    typeNode && ts.isTypeReferenceNode(typeNode) &&
    wrapperKindOfReference(typeNode, checker)
  ) {
    return undefined;
  }

  // Check if this is a Default/Cell/Stream/Reactive wrapper type via alias
  const aliasName = type.aliasSymbol?.name;
  if (
    aliasName === "Default" || CELL_LIKE_WRAPPER_NAMES.has(aliasName ?? "") ||
    aliasName === "Stream" || aliasName === "SqliteDb" ||
    aliasName === "Reactive"
  ) {
    return undefined;
  }

  // A type reference has its target's symbol, so the symbol names it.
  const symbol = type.symbol;
  let name = symbol?.name;
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
      declaresFabricPrimitiveBrand(type)
    ) {
      return undefined;
    }
  }
  // Don't hoist generic type instantiations (Record<K,V>, Partial<T>, Box<T>, etc.)
  // These have aliasTypeArguments, meaning they're a generic type applied to specific type arguments
  // The name "Record" or "Box" is meaningless without the type parameters - what matters is the
  // resolved/instantiated type structure
  if (type.aliasTypeArguments && type.aliasTypeArguments.length > 0) {
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
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
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
  return type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0;
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
          return {
            elementType: checker.getTypeFromTypeNode(argNode),
            elementNode: argNode,
          };
        }
        // Resolve alias: if this is a type alias referring to Array<T> or T[]
        const sym = checker.getSymbolAtLocation(tn);
        const decl = sym?.declarations?.[0];
        if (decl && ts.isTypeAliasDeclaration(decl)) {
          const aliased = decl.type;
          if (ts.isArrayTypeNode(aliased)) {
            const elementType = checker.getTypeFromTypeNode(
              aliased.elementType,
            );
            // If the element type is a type parameter (e.g., T from the alias declaration),
            // don't use it - fall through to extract from the actual type instead
            if ((elementType.flags & ts.TypeFlags.TypeParameter) === 0) {
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
              const elementType = checker.getTypeFromTypeNode(argNode);
              // If the element type is a type parameter (e.g., T from the alias declaration),
              // don't use it - fall through to extract from the actual type instead
              if ((elementType.flags & ts.TypeFlags.TypeParameter) === 0) {
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

  // Throws for a collection that does not serialize to JSON. The array
  // formatter reads every object type here before the object formatter is
  // offered it, so this check stands for the object formatter's too.
  rejectNonSerializableCollection(type);
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

  // An object that declares a `length` beside its numeric index is array-like,
  // as a tuple, a type built on an array, and `ArrayLike<T>` are, and is read
  // as an array of what that index holds, unless it also has a string index,
  // which makes it a dictionary such as `{ [k: string]: T; [n: number]: T }`.
  // Any other object with a numeric index is a map from number-named keys, as
  // a type literal writing it is read.
  const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (
    elementType && type.getProperty("length") &&
    !checker.getIndexTypeOfType(type, ts.IndexKind.String)
  ) {
    return { elementType };
  }

  return undefined;
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
 *
 * The node is read through parentheses and through type aliases, an imported
 * one included (`getTypeAliasDeclaration()`). The node returned is one whose
 * type arguments are the wrapper's own, at the reference: the wrapper
 * reference itself, the reference an alias declares where nothing in its type
 * arguments depends on the alias's type parameters, or, through a generic
 * alias that passes its parameters to the wrapper unchanged and in order, the
 * reference as written. A generic alias that does more with its parameters
 * (`Default<T[], []>`, `Default<string, V>`) leaves no such node, so its
 * reference names no wrapper here and is read from the type it instantiates.
 * A circular alias throws.
 */
export function resolveWrapperNode(
  typeNode: ts.TypeNode | undefined,
  typeChecker: ts.TypeChecker,
): {
  kind: NodeWrapperKind;
  node: ts.TypeReferenceNode;
} | undefined {
  const node = typeNode && unwrapTypeParentheses(typeNode);
  return node && ts.isTypeReferenceNode(node)
    ? followAliasToWrapperNode(node, node, typeChecker, [], [])
    : undefined;
}

/**
 * Helper for `followAliasToWrapperNode()`, which returns the kind of wrapper
 * `reference` names, or `undefined` for a reference to anything else.
 * `Default` is recognized by its spelling. A cell wrapper counts only where
 * its name resolves, through its import binding, to the wrapper `commonfabric`
 * declares, under whatever name it was imported as: a type of the author's own
 * that shares a wrapper's name is something else. A reference the checker
 * cannot resolve, as one the transformer builds, is read by its spelling.
 */
function wrapperKindOfReference(
  reference: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): NodeWrapperKind | undefined {
  const identifier = ts.isIdentifier(reference.typeName)
    ? reference.typeName
    : reference.typeName.right;
  const spelled = wrapperKindForName(identifier.text);
  if (spelled === "Default") return spelled;
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return spelled;
  const declared = symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
  if (!isCommonFabricSymbol(declared)) return undefined;
  const kind = wrapperKindForName(declared.getName());
  return kind === "Default" ? undefined : kind;
}

/**
 * Helper for `resolveWrapperNode()`, which follows `reference`, through
 * parentheses and type aliases, to a reference that names a wrapper, and
 * returns that wrapper's kind with `binding` as it stands there. `binding` is
 * the reference whose type arguments are those of `reference` at the use
 * site, or `undefined` once an alias has left none (`bindAliasTarget()`); the
 * walk goes on without one, so that a circular alias still throws. `followed`
 * holds the aliases already on this path and `names` their names, which spell
 * the chain in the error a circular alias throws.
 */
function followAliasToWrapperNode(
  reference: ts.TypeReferenceNode,
  binding: ts.TypeReferenceNode | undefined,
  typeChecker: ts.TypeChecker,
  followed: readonly ts.TypeAliasDeclaration[],
  names: readonly string[],
): {
  kind: NodeWrapperKind;
  node: ts.TypeReferenceNode;
} | undefined {
  const kind = wrapperKindOfReference(reference, typeChecker);
  if (kind) return binding && { kind, node: binding };

  const declaration = getTypeAliasDeclaration(reference, typeChecker);
  if (!declaration) return undefined;
  const name = getEntityNameText(reference.typeName);
  if (followed.includes(declaration)) {
    throw new Error(
      `Circular type alias detected: ${[...names, name].join(" -> ")}`,
    );
  }
  const target = unwrapTypeParentheses(declaration.type);
  if (!ts.isTypeReferenceNode(target)) return undefined;
  return followAliasToWrapperNode(
    target,
    bindAliasTarget(binding, declaration, target, typeChecker),
    typeChecker,
    [...followed, declaration],
    [...names, name],
  );
}

/**
 * Helper for `followAliasToWrapperNode()`, which returns the reference whose
 * type arguments are those of `target`, the reference `declaration` declares,
 * where the alias is reached through `binding`. Without type parameters, and
 * where none of its type arguments mentions one, `target` means the same
 * wherever it is reached, and is its own binding. Where the alias passes its
 * parameters to `target` unchanged and in order, and `binding` supplies an
 * argument for each, `target`'s arguments are `binding`'s. Otherwise
 * `target`'s arguments exist only once the alias's parameters are replaced,
 * which no authored node shows, and the result is `undefined`.
 */
function bindAliasTarget(
  binding: ts.TypeReferenceNode | undefined,
  declaration: ts.TypeAliasDeclaration,
  target: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.TypeReferenceNode | undefined {
  const parameters = (declaration.typeParameters ?? []).map((parameter) =>
    checker.getSymbolAtLocation(parameter.name)
  );
  const parameterSet = new Set(parameters);
  const targetArguments = target.typeArguments ?? [];
  if (
    !targetArguments.some((argument) =>
      mentionsSymbol(argument, parameterSet, checker)
    )
  ) {
    return target;
  }
  const passesThrough = binding?.typeArguments?.length === parameters.length &&
    targetArguments.length === parameters.length &&
    targetArguments.every((argument, index) => {
      const node = unwrapTypeParentheses(argument);
      return ts.isTypeReferenceNode(node) && !node.typeArguments &&
        ts.isIdentifier(node.typeName) &&
        checker.getSymbolAtLocation(node.typeName) === parameters[index];
    });
  return passesThrough ? binding : undefined;
}

/**
 * Helper for `bindAliasTarget()`, which returns `true` where `node` holds a
 * reference to one of `symbols`.
 */
function mentionsSymbol(
  node: ts.Node,
  symbols: ReadonlySet<ts.Symbol | undefined>,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    if (symbols.has(checker.getSymbolAtLocation(node.typeName))) return true;
  }
  return ts.forEachChild(
    node,
    (child) => mentionsSymbol(child, symbols, checker) || undefined,
  ) ?? false;
}

/**
 * Whether `type` is an empty object as a default's value: an object type, or
 * an intersection of them, with no properties and no call or construct
 * signatures, each index signature of which, if any, holds `never`, as `{}`,
 * an empty interface, `{ [K in never]: X }` and `Record<string, never>` are.
 */
function isEmptyObjectDefaultType(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
): boolean {
  return (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) !==
      0 &&
    !(type.isIntersection() &&
      type.types.some((member) =>
        (member.flags & ts.TypeFlags.Object) === 0
      )) &&
    typeChecker.getPropertiesOfType(type).length === 0 &&
    type.getCallSignatures().length === 0 &&
    type.getConstructSignatures().length === 0 &&
    typeChecker.getIndexInfosOfType(type).every((index) =>
      (index.type.flags & ts.TypeFlags.Never) !== 0
    );
}

/**
 * The value of `type` where it is a string, number or boolean literal type,
 * and `undefined` otherwise.
 */
export function primitiveLiteralValue(
  type: ts.Type,
  checker: ts.TypeChecker,
): string | number | boolean | undefined {
  if (type.isStringLiteral() || type.isNumberLiteral()) return type.value;
  return (type.flags & ts.TypeFlags.BooleanLiteral) !== 0
    ? checker.isTypeAssignableTo(type, checker.getTrueType())
    : undefined;
}

/**
 * The JSON value a literal-shaped type spells, read from the type alone: a
 * string, number or boolean literal, `null`, an empty object
 * (`isEmptyObjectDefaultType()`), a tuple of such types, or an object type
 * with no index signature, call or construct signature, whose members are
 * such types, which makes an object type with no members at all `{}`. The
 * value is returned wrapped, so a legitimate `null` is distinguishable from
 * a type with no value, and the whole type has none where any part of it has
 * none.
 *
 * It reads a default's value where no syntax spells it: `Default<T, V>`'s `V`
 * reached by type in either formatter, and `V` read back out of the
 * `DEFAULT_MARKER` brand payload once the checker has resolved the alias away
 * (see `Default<>` in `base/api/index.ts`).
 */
export function extractValueFromLiteralType(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
): { value: FabricValue } | undefined {
  if (isEmptyObjectDefaultType(type, typeChecker)) return { value: {} };
  const primitive = primitiveLiteralValue(type, typeChecker);
  if (primitive !== undefined) return { value: primitive };
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
    type.getConstructSignatures().length === 0 &&
    typeChecker.getIndexInfosOfType(type).length === 0
  ) {
    const props = typeChecker.getPropertiesOfType(type);
    const result: Record<string, FabricValue> = {};
    for (const prop of props) {
      // Symbol-keyed members (`__@...`) mean this is a brand, not data. Only
      // the escaped name tells the two apart: escaping gives a written name
      // that starts with `__` a third underscore, so the value is keyed by the
      // unescaped name instead.
      if (String(prop.escapedName).startsWith("__@")) {
        return undefined;
      }
      const propType = typeChecker.getTypeOfSymbol(prop);
      const extracted = extractValueFromLiteralType(propType, typeChecker);
      if (!extracted) return undefined;
      // Defined as an own property: `result[name] =` with the name
      // `__proto__` would set the prototype on an engine that keeps
      // `Object.prototype.__proto__`.
      Object.defineProperty(result, prop.getName(), {
        value: extracted.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { value: result };
  }

  return undefined;
}

function extractPayloadFromBrandedMember(
  member: ts.Type,
  typeChecker: ts.TypeChecker,
): { value: FabricValue } | undefined {
  const payload = getDefaultMarkerPayload(member, typeChecker);
  if (!payload) return undefined;
  return extractValueFromLiteralType(payload, typeChecker);
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

/**
 * `context` without its `typeNode`, for reading a type that has no node of
 * its own. The node dropped, or the one written around it, becomes
 * `writtenAround`, which a diagnostic names in its place.
 */
export function withoutTypeNode(
  { typeNode, ...rest }: GenerationContext,
): GenerationContext {
  const writtenAround = typeNode ?? rest.writtenAround;
  return writtenAround ? { ...rest, writtenAround } : rest;
}
