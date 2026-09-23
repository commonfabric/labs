import { getCellWrapperInfo } from "@commonfabric/schema-generator/cell-brand";
import ts from "typescript";
import { getCellKind, isBrandedCellType } from "../transformers/cell-type.ts";
import {
  getTypeAtLocationWithFallback,
  isDefaultAliasSymbol,
} from "./utils.ts";

/**
 * Type inference utilities for function signatures
 * Used primarily by schema-injection to infer types for lift/handler
 */

const TYPE_NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseStructuralFallback;

/**
 * Check if a type is 'any', 'unknown', or an uninstantiated type parameter.
 *
 * This is a conservative predicate used at fallback seams where we do not want
 * to trust the type for structural recovery. It is intentionally broader than
 * "cannot emit a schema": `any` and `unknown` are both schemaable, but they
 * are not structurally precise.
 */
export function isAnyOrUnknownType(type: ts.Type | undefined): boolean {
  if (!type) return false;
  return (type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !==
    0;
}

export function isAnyType(type: ts.Type | undefined): boolean {
  if (!type) return false;
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

export function isUnknownType(type: ts.Type | undefined): boolean {
  if (!type) return false;
  return (type.flags & ts.TypeFlags.Unknown) !== 0;
}

/**
 * Type parameters without a concrete constraint/default are the main
 * "truly unresolved" schema case that should stay conservative.
 */
export function isUnresolvedSchemaType(type: ts.Type | undefined): boolean {
  if (!type) return false;
  return (type.flags & ts.TypeFlags.TypeParameter) !== 0;
}

/**
 * Widen literal types to their base types for more flexible schemas.
 * - NumberLiteral (e.g., 10) → number
 * - StringLiteral (e.g., "hello") → string
 * - BooleanLiteral (e.g., true) → boolean
 * - BigIntLiteral (e.g., 10n) → bigint
 * - Other types are returned unchanged
 */
export function widenLiteralType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type {
  // Handle union types by widening each member and deduplicating
  if (type.isUnion()) {
    // Special case: pure boolean union (true | false) should remain as-is
    // The schema generator has special handling to convert this to {type: "boolean"}
    const isPureBooleanUnion = type.types.length === 2 &&
      type.types.every((m) => (m.flags & ts.TypeFlags.BooleanLiteral) !== 0);
    if (isPureBooleanUnion) {
      return type;
    }

    const widenedMembers = type.types.map((member) =>
      widenLiteralType(member, checker)
    );

    // Deduplicate by comparing type IDs (handles cases like string literals → string)
    const seen = new Set<number>();
    const unique: ts.Type[] = [];
    for (const t of widenedMembers) {
      // Use type identity to deduplicate
      const id = (t as { id?: number }).id ?? -1;
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(t);
      }
    }

    // If we reduced to a single type, return it directly
    if (unique.length === 1) {
      return unique[0]!;
    }

    // Otherwise create a new union from unique types
    const getUnionType = (checker as ts.TypeChecker & {
      getUnionType?: (types: readonly ts.Type[]) => ts.Type;
    }).getUnionType;
    if (getUnionType) {
      return getUnionType(unique);
    }
    return type;
  }

  // Number literal → number
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return checker.getNumberType();
  }

  // String literal → string
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return checker.getStringType();
  }

  // Boolean literal (true/false) → boolean
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    // TypeChecker doesn't have getBooleanType(), so we need to create it
    // by getting the union of true | false
    const trueType = checker.getTrueType?.() ?? type;
    const falseType = checker.getFalseType?.() ?? type;
    if (trueType && falseType) {
      return (checker as ts.TypeChecker & {
        getUnionType?: (types: readonly ts.Type[]) => ts.Type;
      }).getUnionType?.([trueType, falseType]) ?? type;
    }
    return type;
  }

  // BigInt literal → bigint
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    return checker.getBigIntType();
  }

  // All other types (including already-widened types) return unchanged
  return type;
}

/**
 * Infer type from an expression with automatic literal widening.
 * Use this for value-based type inference where literal types should
 * be widened to their base types (e.g., `const x = 5` should produce `number`, not `5`).
 *
 * This is the preferred method for inferring types for:
 * - Closure-captured variables
 * - Derive input arguments
 * - Handler/lift captured state
 *
 * @param expr - The expression to infer type from
 * @param checker - TypeChecker instance
 * @returns The widened type (literals expanded to base types)
 */
export function inferWidenedTypeFromExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type {
  const type = getTypeAtLocationWithFallback(expr, checker, typeRegistry) ??
    checker.getTypeAtLocation(expr);
  return widenLiteralType(type, checker);
}

/**
 * Infer the type of a function parameter, with optional fallback
 * Returns undefined if the type cannot be inferred
 */
export function inferParameterType(
  parameter: ts.ParameterDeclaration | undefined,
  signature: ts.Signature,
  checker: ts.TypeChecker,
  fallbackType?: ts.Type,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type | undefined {
  // If no parameter but signature has parameters, try to get from signature
  if (!parameter) {
    if (signature.parameters.length > 0) {
      const paramSymbol = signature.parameters[0];
      if (paramSymbol) {
        const valueDecl = paramSymbol.valueDeclaration;
        const location = valueDecl && ts.isParameter(valueDecl)
          ? valueDecl
          : signature.getDeclaration();
        if (location) {
          return checker.getTypeOfSymbolAtLocation(paramSymbol, location);
        }
      }
    }
    return undefined;
  }

  // If explicit type annotation exists, use it
  // Use fallback to handle synthetic TypeNodes that may be in the registry
  if (parameter.type) {
    const explicitType = getTypeFromTypeNodeWithFallback(
      parameter.type,
      checker,
      typeRegistry,
    );
    return explicitType;
  }

  // Try to infer from parameter location. Check typeRegistry first so that
  // transformer-stage overrides (e.g. lift-applied lowering registering the
  // input expression's type against the callback parameter) take precedence
  // over the checker's contextual inference, which may unwrap or otherwise
  // lose information when the parameter is reached from a curried call form.
  const registered = typeRegistry?.get(parameter);
  let paramType = registered ?? checker.getTypeAtLocation(parameter);

  // If it's 'any' and we have a fallback, use that
  if (isAnyOrUnknownType(paramType) && fallbackType) {
    paramType = fallbackType;
  }

  return paramType;
}

/**
 * Infer return type from function signature
 * Returns undefined if the type cannot be inferred
 */
export function inferReturnType(
  _fn: ts.ArrowFunction | ts.FunctionExpression,
  signature: ts.Signature,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  return checker.getReturnTypeOfSignature(signature);
}

/**
 * Convert a TypeScript type to a TypeNode for schema generation
 */
export function typeToTypeNode(
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
): ts.TypeNode | undefined {
  try {
    const result = checker.typeToTypeNode(type, location, TYPE_NODE_FLAGS);
    return result;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Extract the first type argument from a TypeReference or type alias
 * Used to unwrap generic types like Reactive<T> to get T
 */
export function getTypeReferenceArgument(type: ts.Type): ts.Type | undefined {
  if ("aliasTypeArguments" in type && type.aliasTypeArguments) {
    const [arg] = type.aliasTypeArguments;
    if (arg) return arg;
  }
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const ref = objectType as ts.TypeReference;
      if (ref.typeArguments && ref.typeArguments.length > 0) {
        return ref.typeArguments[0];
      }
    }
  }
  return undefined;
}

export function isCellLikeType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!type) return false;
  return getCellKind(type, checker) !== undefined ||
    isBrandedCellType(type, checker);
}

/**
 * Does this type denote a collection — an array, a tuple, or a union whose
 * every member is one of those?
 *
 * The union arm is the reason this is shared rather than a bare
 * `checker.isArrayType(t) || checker.isTupleType(t)`: a value built from
 * differently-typed arrays — e.g. `a ?? b` over `string[] | undefined` and
 * `number[]` resolves to `string[] | number[]` — is a union that
 * `checker.isArrayType` returns false for. Every caller that must keep
 * collection-valued expressions structurally lowered (array-method callback
 * returns in expression-site-policy, fallback receivers in
 * expression-site-lowering, derived reactive-collection calls in call-kind)
 * needs to catch that union, so the logic lives in one place.
 */
export function isCollectionType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!type) return false;
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return true;
  }
  return type.isUnion() &&
    type.types.length > 0 &&
    type.types.every((member) =>
      checker.isArrayType(member) || checker.isTupleType(member)
    );
}

function getCellPayloadType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const ref = getCellWrapperInfo(type, checker)?.typeRef;
  return ref && (ref.typeArguments ?? checker.getTypeArguments(ref))[0];
}

/**
 * Unwrap Reactive-like types to get the underlying type
 * Handles unions, intersections, and nested Reactive types
 * @param seen - Set to track visited types and prevent infinite recursion
 */
export function unwrapOpaqueLikeType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): ts.Type | undefined {
  if (!type) return undefined;
  if (seen.has(type)) return type;
  seen.add(type);

  if (type.isUnion()) {
    const unwrapped = type.types.map((candidate) =>
      unwrapOpaqueLikeType(candidate, checker, seen) ?? candidate
    );
    const merged = (checker as ts.TypeChecker & {
      getUnionType?: (types: readonly ts.Type[], node?: ts.Node) => ts.Type;
    }).getUnionType?.(unwrapped) ?? type;
    return merged;
  }

  if (type.isIntersection()) {
    // For Reactive<T> = OpaqueCell<T> & ReactiveInner<T>, we want to extract T
    // Look for an OpaqueCell<T> part and extract its type argument
    for (const part of type.types) {
      if (isBrandedCellType(part, checker)) {
        const inner = getCellPayloadType(part, checker);
        if (inner) {
          // Recursively unwrap in case T itself contains Reactive types
          return unwrapOpaqueLikeType(inner, checker, seen) ?? inner;
        }
      }
    }
    // No OpaqueCell found, try recursively unwrapping each part
    const intersection = (checker as ts.TypeChecker & {
      getIntersectionType?: (types: readonly ts.Type[]) => ts.Type;
    }).getIntersectionType;
    if (intersection) {
      const parts = type.types.map((candidate) =>
        unwrapOpaqueLikeType(candidate, checker, seen) ?? candidate
      );
      return intersection(parts);
    }
    return type;
  }

  if (isBrandedCellType(type, checker)) {
    const inner = unwrapOpaqueLikeType(
      getCellPayloadType(type, checker),
      checker,
      seen,
    );
    if (inner) return inner;
  }

  return type;
}

export function unwrapCellLikeType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (!type) return undefined;
  if (!isCellLikeType(type, checker)) {
    return type;
  }

  const opaqueUnwrapped = unwrapOpaqueLikeType(type, checker);
  if (opaqueUnwrapped && opaqueUnwrapped !== type) {
    return opaqueUnwrapped;
  }

  return getCellPayloadType(type, checker) ?? type;
}

/**
 * Convert a TypeScript type to a TypeNode for schema generation
 * Note: Does NOT unwrap Cell/Reactive types - the schema generator handles those
 */
export function typeToSchemaTypeNode(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  location: ts.Node,
): ts.TypeNode | undefined {
  if (!type) {
    return undefined;
  }
  // Don't unwrap Cell/Reactive types - let the schema generator handle them
  const result = typeToTypeNode(type, checker, location);
  return result;
}

/**
 * If a parameter has an explicit type annotation that's not Any,
 * return it and register in TypeRegistry.
 * This is useful for transformers that need to preserve explicit types.
 */
export function tryExplicitParameterType(
  param: ts.ParameterDeclaration | undefined,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): { typeNode: ts.TypeNode; type: ts.Type } | null {
  if (!param?.type) return null;

  // Use fallback to handle synthetic TypeNodes that may be in the registry
  const annotationType = getTypeFromTypeNodeWithFallback(
    param.type,
    checker,
    typeRegistry,
  );

  if (annotationType.flags & ts.TypeFlags.Any) return null;

  if (typeRegistry) {
    typeRegistry.set(param.type, annotationType);
  }

  return { typeNode: param.type, type: annotationType };
}

/**
 * Create a TypeNode and register it with a Type in TypeRegistry.
 * Handles the common pattern of synthetic TypeNode creation.
 * This ensures that later transformer stages can retrieve the Type from synthetic nodes.
 */
export function registerTypeForNode(
  typeNode: ts.TypeNode,
  type: ts.Type,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode {
  if (typeRegistry) {
    typeRegistry.set(typeNode, type);
  }
  return typeNode;
}

type InternalSymbolWithLinks = ts.Symbol & {
  links?: {
    type?: ts.Type;
  };
};

// Intentionally quarantined TypeScript-internal entry points.
// We use these only to materialize composite synthetic TypeNodes that the
// public checker APIs resolve as unresolved any/unknown. Do not spread this
// pattern elsewhere in the pipeline.
type InternalTypeChecker = ts.TypeChecker & {
  createAnonymousType?: (
    symbol: ts.Symbol | undefined,
    members: ts.SymbolTable,
    callSignatures: readonly ts.Signature[],
    constructSignatures: readonly ts.Signature[],
    indexInfos: readonly ts.IndexInfo[],
  ) => ts.Type;
  createArrayType?: (elementType: ts.Type, readonly?: boolean) => ts.Type;
  createSymbol?: (
    flags: ts.SymbolFlags,
    name: string,
    checkFlags?: number,
  ) => InternalSymbolWithLinks;
  getUnionType?: (types: readonly ts.Type[]) => ts.Type;
};

function createInternalSymbolName(name: string): string {
  const escapeLeadingUnderscores = (ts as typeof ts & {
    escapeLeadingUnderscores?: (text: string) => string;
  }).escapeLeadingUnderscores;
  return escapeLeadingUnderscores?.(name) ?? name;
}

function createInternalSymbolTable(
  symbols: readonly ts.Symbol[],
): ts.SymbolTable {
  const createSymbolTable = (ts as typeof ts & {
    createSymbolTable?: (symbols: readonly ts.Symbol[]) => ts.SymbolTable;
  }).createSymbolTable;
  if (createSymbolTable) {
    return createSymbolTable(symbols);
  }

  // Fallback for environments where the helper is not exposed at runtime.
  const table = new Map<ts.__String, ts.Symbol>();
  for (const symbol of symbols) {
    table.set(symbol.escapedName as ts.__String, symbol);
  }
  return table as ts.SymbolTable;
}

function tryGetSyntheticPropertyName(
  name: ts.PropertyName,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (
    ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteralLike(name.expression) ||
      ts.isNumericLiteral(name.expression) ||
      ts.isNoSubstitutionTemplateLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return undefined;
}

function tryGetTypeFromTypeNodeDirect(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  try {
    return checker.getTypeFromTypeNode(typeNode);
  } catch {
    return undefined;
  }
}

function ensureCompositeChildTypesRegistered(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): void {
  if (!typeRegistry) return;

  if (ts.isParenthesizedTypeNode(typeNode)) {
    ensureTypeNodeRegistered(typeNode.type, checker, typeRegistry);
    return;
  }

  if (ts.isArrayTypeNode(typeNode)) {
    ensureTypeNodeRegistered(typeNode.elementType, checker, typeRegistry);
    return;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    for (const arg of typeNode.typeArguments ?? []) {
      ensureTypeNodeRegistered(arg, checker, typeRegistry);
    }
    return;
  }

  if (ts.isUnionTypeNode(typeNode)) {
    for (const member of typeNode.types) {
      ensureTypeNodeRegistered(member, checker, typeRegistry);
    }
    return;
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    for (const member of typeNode.members) {
      if (ts.isPropertySignature(member) && member.type) {
        ensureTypeNodeRegistered(member.type, checker, typeRegistry);
      }
    }
  }
}

function tryRegisterCompositeSyntheticType(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type | undefined {
  if (!typeRegistry) return undefined;

  const existing = typeRegistry.get(typeNode);
  if (existing) return existing;

  ensureCompositeChildTypesRegistered(typeNode, checker, typeRegistry);

  const retried = tryGetTypeFromTypeNodeDirect(typeNode, checker);
  if (retried && !isAnyOrUnknownType(retried)) {
    typeRegistry.set(typeNode, retried);
    return retried;
  }

  const internalChecker = checker as InternalTypeChecker;

  if (ts.isParenthesizedTypeNode(typeNode)) {
    const inner = ensureTypeNodeRegistered(
      typeNode.type,
      checker,
      typeRegistry,
    );
    if (inner) {
      typeRegistry.set(typeNode, inner);
      return inner;
    }
    return retried;
  }

  if (ts.isArrayTypeNode(typeNode) && internalChecker.createArrayType) {
    const elementType = ensureTypeNodeRegistered(
      typeNode.elementType,
      checker,
      typeRegistry,
    );
    if (elementType && !isAnyOrUnknownType(elementType)) {
      const arrayType = internalChecker.createArrayType(elementType);
      typeRegistry.set(typeNode, arrayType);
      return arrayType;
    }
    return retried;
  }

  if (ts.isUnionTypeNode(typeNode) && internalChecker.getUnionType) {
    const memberTypes = typeNode.types.map((member) =>
      ensureTypeNodeRegistered(member, checker, typeRegistry)
    ).filter((member): member is ts.Type => !!member);
    if (
      memberTypes.length === typeNode.types.length &&
      memberTypes.every((member) => !isAnyOrUnknownType(member))
    ) {
      const unionType = internalChecker.getUnionType(memberTypes);
      typeRegistry.set(typeNode, unionType);
      return unionType;
    }
    return retried;
  }

  if (
    ts.isTypeLiteralNode(typeNode) &&
    typeNode.members.length > 0 &&
    internalChecker.createAnonymousType &&
    internalChecker.createSymbol
  ) {
    const membersList: ts.Symbol[] = [];
    for (const member of typeNode.members) {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) {
        return retried;
      }

      const propertyName = tryGetSyntheticPropertyName(member.name);
      if (!propertyName) {
        return retried;
      }

      const propertyType = ensureTypeNodeRegistered(
        member.type,
        checker,
        typeRegistry,
      ) ?? tryGetTypeFromTypeNodeDirect(member.type, checker);
      if (!propertyType || isAnyOrUnknownType(propertyType)) {
        return retried;
      }

      const symbol = internalChecker.createSymbol(
        ts.SymbolFlags.Property |
          (member.questionToken ? ts.SymbolFlags.Optional : 0),
        createInternalSymbolName(propertyName),
      );
      symbol.links ??= {};
      symbol.links.type = propertyType;
      membersList.push(symbol);
    }

    const symbol = internalChecker.createSymbol(
      ts.SymbolFlags.TypeLiteral,
      createInternalSymbolName("__type"),
    );
    const members = createInternalSymbolTable(membersList);
    const anonymousType = internalChecker.createAnonymousType(
      symbol,
      members,
      [],
      [],
      [],
    );
    typeRegistry.set(typeNode, anonymousType);
    return anonymousType;
  }

  return retried;
}

export function ensureTypeNodeRegistered(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type | undefined {
  if (typeRegistry?.has(typeNode)) {
    return typeRegistry.get(typeNode);
  }

  const direct = tryGetTypeFromTypeNodeDirect(typeNode, checker);
  if (!typeRegistry || !direct) {
    return direct;
  }

  if (!isAnyOrUnknownType(direct)) {
    typeRegistry.set(typeNode, direct);
    return direct;
  }

  return tryRegisterCompositeSyntheticType(typeNode, checker, typeRegistry) ??
    direct;
}

/**
 * Get the Type from a TypeNode, checking typeRegistry first.
 *
 * Similar to getTypeAtLocationWithFallback but for TypeNodes specifically.
 * This is useful when working with TypeNodes that may have been created by
 * prior transformers and already have types registered.
 *
 * @param typeNode The TypeNode to get the Type for
 * @param checker TypeChecker instance
 * @param typeRegistry Optional registry of types for synthetic nodes
 * @returns The Type corresponding to the TypeNode
 */
export function getTypeFromTypeNodeWithFallback(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type {
  // Check typeRegistry first (for synthetic TypeNodes)
  if (typeRegistry) {
    const registeredType = typeRegistry.get(typeNode);
    if (registeredType) {
      return registeredType;
    }
  }

  return ensureTypeNodeRegistered(typeNode, checker, typeRegistry) ??
    checker.getTypeFromTypeNode(typeNode);
}

/**
 * Register the result type for a synthetic lift-applied CallExpression.
 *
 * This is needed because synthetic nodes created by transformers don't have
 * type information from the TypeChecker. We need to explicitly register the
 * type so that later transformations can infer types correctly.
 *
 * @param liftAppliedCall The synthetic lift-applied CallExpression to register type for
 * @param resultTypeNode The TypeNode representing the call's result type
 * @param resultType Optional pre-computed Type object for the result
 * @param checker TypeChecker instance
 * @param typeRegistry The type registry to update
 */
export function registerLiftAppliedCallType(
  liftAppliedCall: ts.CallExpression,
  resultTypeNode: ts.TypeNode | undefined,
  resultType: ts.Type | undefined,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type>,
): void {
  // Try to get the type - either from provided resultType or from resultTypeNode
  let typeToRegister = resultType;

  if (!typeToRegister && resultTypeNode) {
    typeToRegister = getTypeFromTypeNodeWithFallback(
      resultTypeNode,
      checker,
      typeRegistry,
    );
  }

  if (typeToRegister) {
    registerSyntheticCallType(liftAppliedCall, typeToRegister, typeRegistry);
  }
}

/**
 * Register the result type for a synthetic call (lift-applied, ifElse, when, unless, etc.) in the TypeRegistry.
 * This enables schema injection to find the correct result type for the call.
 *
 * @param call The synthetic call node
 * @param resultType The result type to register
 * @param typeRegistry The type registry to update
 */
export function registerSyntheticCallType(
  call: ts.CallExpression,
  resultType: ts.Type,
  typeRegistry: WeakMap<ts.Node, ts.Type>,
): void {
  typeRegistry.set(call, resultType);
}

/**
 * Helper to find Reference type within an intersection type
 */
function findReferenceTypeInIntersection(
  intersectionType: ts.IntersectionType,
): ts.Type | undefined {
  for (const type of intersectionType.types) {
    if (type.flags & ts.TypeFlags.Object) {
      const objType = type as ts.ObjectType;
      if (objType.objectFlags & ts.ObjectFlags.Reference) {
        return type;
      }
    }
  }
  return undefined;
}

/**
 * Helper to find Reactive type within a union type
 */
function findReactiveInUnion(
  unionType: ts.UnionType,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  for (const member of unionType.types) {
    if (
      member.flags & ts.TypeFlags.Intersection ||
      isBrandedCellType(member, checker)
    ) {
      return member;
    }
  }
  return undefined;
}

function combineExtractedElementTypes(
  extracted: ts.Type[],
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (extracted.length === 0) return undefined;
  if (extracted.length === 1) return extracted[0];

  const seen = new Set<number>();
  const unique: ts.Type[] = [];
  for (const candidate of extracted) {
    const id = (candidate as { id?: number }).id ?? -1;
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(candidate);
    }
  }

  if (unique.length === 1) {
    return unique[0];
  }

  const getUnionType = (checker as ts.TypeChecker & {
    getUnionType?: (types: readonly ts.Type[]) => ts.Type;
  }).getUnionType;
  if (getUnionType) {
    return getUnionType(unique);
  }
  // Cannot construct union without internal API; signal failure so callers
  // can fall back to alternative type extraction strategies.
  return undefined;
}

/**
 * Extract element type from array-like types (T[] -> T), including unions,
 * intersections, and wrapped/reference forms used by reactive cell types.
 */
function extractElementFromArrayType(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): ts.Type | undefined {
  if (seen.has(type)) return undefined;
  seen.add(type);

  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  }

  if (type.flags & ts.TypeFlags.Union) {
    const extracted = (type as ts.UnionType).types
      .filter((member) => !(member.flags & ts.TypeFlags.Undefined))
      .map((member) => extractElementFromArrayType(member, checker, seen))
      .filter((member): member is ts.Type => !!member);
    return combineExtractedElementTypes(extracted, checker);
  }

  if (type.flags & ts.TypeFlags.Intersection) {
    const extracted = (type as ts.IntersectionType).types
      .map((member) => extractElementFromArrayType(member, checker, seen))
      .filter((member): member is ts.Type => !!member);
    return combineExtractedElementTypes(extracted, checker);
  }

  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const ref = objectType as ts.TypeReference;
      const typeArgs = checker.getTypeArguments(ref);
      const innerType = typeArgs[0];
      if (innerType) {
        const extractedInner = extractElementFromArrayType(
          innerType,
          checker,
          seen,
        );
        if (extractedInner) {
          return extractedInner;
        }

        const innerAlias = innerType as {
          aliasSymbol?: ts.Symbol;
          aliasTypeArguments?: readonly ts.Type[];
        };
        if (
          isDefaultAliasSymbol(innerAlias.aliasSymbol) &&
          innerAlias.aliasTypeArguments?.[0]
        ) {
          return extractElementFromArrayType(
            innerAlias.aliasTypeArguments[0],
            checker,
            seen,
          );
        }
      }
    }
  }

  return undefined;
}

/**
 * Infer the element type from an array-like expression (e.g., Reactive<T[]> or Array<T>).
 * Unwraps one level of array wrapping to get the element type.
 *
 * Handles:
 * - Reactive<T[]> → T[] → T (intersection type case)
 * - FactoryInput<T[]> → Reactive<T[]> → T[] → T (union type case)
 * - Plain Array<T> → T
 *
 * @param arrayExpr - Expression representing an array or array-like type
 * @param context - Context with checker, factory, and sourceFile
 * @returns Element type and its TypeNode representation, or unknown if inference fails
 */
export function inferArrayElementType(
  arrayExpr: ts.Expression,
  context: {
    checker: ts.TypeChecker;
    factory: ts.NodeFactory;
    sourceFile: ts.SourceFile;
    typeRegistry?: WeakMap<ts.Node, ts.Type>;
  },
): { typeNode: ts.TypeNode; type?: ts.Type } {
  const { checker, factory, typeRegistry } = context;
  // Use getTypeAtLocationWithFallback to check typeRegistry first (for synthetic nodes)
  // getTypeAtLocationWithFallback handles undefined typeRegistry gracefully
  const arrayType =
    getTypeAtLocationWithFallback(arrayExpr, checker, typeRegistry) ??
      checker.getTypeAtLocation(arrayExpr);

  // Try to unwrap Reactive<T[]> → T[] → T
  let actualType = arrayType;

  // Handle intersections (Reactive case)
  if (arrayType.flags & ts.TypeFlags.Intersection) {
    const refType = findReferenceTypeInIntersection(
      arrayType as ts.IntersectionType,
    );
    if (refType) {
      actualType = refType;
    }
  }

  // Handle unions (FactoryInput<T[]> case)
  if (arrayType.flags & ts.TypeFlags.Union) {
    const opaqueType = findReactiveInUnion(
      arrayType as ts.UnionType,
      checker,
    );
    if (opaqueType) {
      actualType = opaqueType;
    }
  }

  // Extract type arguments from the reference type
  let typeArgs: readonly ts.Type[] | undefined;

  // First check if actualType is an intersection (Reactive case)
  if (actualType.flags & ts.TypeFlags.Intersection) {
    const intersectionType = actualType as ts.IntersectionType;
    // Look for the Reference type member within the intersection
    for (const member of intersectionType.types) {
      if (member.flags & ts.TypeFlags.Object) {
        const objType = member as ts.ObjectType;
        if (objType.objectFlags & ts.ObjectFlags.Reference) {
          typeArgs = checker.getTypeArguments(objType as ts.TypeReference);
          break;
        }
      }
    }
  } else if (actualType.flags & ts.TypeFlags.Object) {
    // Plain object/reference type case
    const objectType = actualType as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      typeArgs = checker.getTypeArguments(objectType as ts.TypeReference);
    }
  }

  if (typeArgs && typeArgs.length > 0) {
    const innerType = typeArgs[0];
    if (innerType) {
      // innerType is either T[] or T depending on the structure
      let elementType: ts.Type;
      if (checker.isArrayType(innerType)) {
        // It's T[], extract T
        const extracted = extractElementFromArrayType(innerType, checker);
        if (extracted) {
          elementType = extracted;
        } else {
          return {
            typeNode: factory.createKeywordTypeNode(
              ts.SyntaxKind.UnknownKeyword,
            ),
          };
        }
      } else {
        // Check for Default<T[]> brand union: aliasSymbol = Default from @commonfabric/api,
        // aliasTypeArguments[0] = T[]. Default<T,V> expands to a branded union at the type
        // level; the type object retains aliasSymbol so we can detect and unwrap it here.
        const innerAlias = innerType as {
          aliasSymbol?: ts.Symbol;
          aliasTypeArguments?: readonly ts.Type[];
        };
        if (
          isDefaultAliasSymbol(innerAlias.aliasSymbol) &&
          innerAlias.aliasTypeArguments?.[0] &&
          checker.isArrayType(innerAlias.aliasTypeArguments[0])
        ) {
          const baseArrayType = innerAlias.aliasTypeArguments[0];
          const extracted = extractElementFromArrayType(baseArrayType, checker);
          if (extracted) {
            elementType = extracted;
          } else {
            return {
              typeNode: factory.createKeywordTypeNode(
                ts.SyntaxKind.UnknownKeyword,
              ),
            };
          }
        } else {
          // It's already T
          elementType = innerType;
        }
      }

      // Convert Type to TypeNode
      const typeNode =
        typeToTypeNode(elementType, checker, context.sourceFile) ??
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

      return { typeNode, type: elementType };
    }
  }

  // Fallback for plain Array<T>
  const elementType = extractElementFromArrayType(arrayType, checker);
  if (elementType) {
    const typeNode = typeToTypeNode(elementType, checker, context.sourceFile) ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

    return { typeNode, type: elementType };
  }

  return {
    typeNode: factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
  };
}

/**
 * Infers the expected type of an expression from its context (e.g., variable assignment).
 */
export function inferContextualType(
  node: ts.Expression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const contextualType = checker.getContextualType(node);
  if (contextualType && !isAnyOrUnknownType(contextualType)) {
    return contextualType;
  }
  return undefined;
}

/**
 * Check if a single union/intersection member represents an array-like type.
 *
 * Handles:
 * - Direct array/tuple types: T[]
 * - Intersection-with-brand: T[] & { [DEFAULT_MARKER]: T[] } (from Default<T[], V> expansion)
 * - Default<T[], V> alias (non-flattened form, retained aliasSymbol)
 */
function isEffectiveArrayMember(
  t: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if (checker.isArrayType(t) || checker.isTupleType(t)) return true;
  // Intersection like (T[] & brand): check if any member is an array
  if (t.flags & ts.TypeFlags.Intersection) {
    return (t as ts.IntersectionType).types.some(
      (m) => checker.isArrayType(m) || checker.isTupleType(m),
    );
  }
  // Non-flattened Default<T[], V> alias (aliasSymbol retained on the union type)
  const alias = t as {
    aliasSymbol?: ts.Symbol;
    aliasTypeArguments?: readonly ts.Type[];
  };
  if (
    isDefaultAliasSymbol(alias.aliasSymbol) && alias.aliasTypeArguments?.[0]
  ) {
    const baseT = alias.aliasTypeArguments[0];
    return checker.isArrayType(baseT) || checker.isTupleType(baseT);
  }
  return false;
}

/**
 * Helper to check if a type's type argument is an array.
 * Handles unions and intersections recursively, similar to isBrandedCellType.
 */
export function hasArrayTypeArgument(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  // Handle unions - check if any member has an array type argument
  if (type.flags & ts.TypeFlags.Union) {
    return (type as ts.UnionType).types.some((t: ts.Type) =>
      hasArrayTypeArgument(t, checker)
    );
  }

  // Handle intersections - check if any member has an array type argument
  if (type.flags & ts.TypeFlags.Intersection) {
    return (type as ts.IntersectionType).types.some((t: ts.Type) =>
      hasArrayTypeArgument(t, checker)
    );
  }

  // Handle object types with type references (e.g., Reactive<T[]>)
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = objectType as ts.TypeReference;
      if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
        const innerType = typeRef.typeArguments[0];
        if (!innerType) return false;
        // Check if inner type is an array or tuple
        if (checker.isArrayType(innerType) || checker.isTupleType(innerType)) {
          return true;
        }
        // Handle Default<T[]> brand union: aliasSymbol is Default from @commonfabric/api and
        // first aliasTypeArgument is T[]. typeToTypeNode expands Default<T[],V> to a
        // branded union, but the type object retains aliasSymbol so we can detect it here.
        const innerAlias = innerType as {
          aliasSymbol?: ts.Symbol;
          aliasTypeArguments?: readonly ts.Type[];
        };
        if (
          isDefaultAliasSymbol(innerAlias.aliasSymbol) &&
          innerAlias.aliasTypeArguments?.[0]
        ) {
          const baseT = innerAlias.aliasTypeArguments[0];
          if (checker.isArrayType(baseT) || checker.isTupleType(baseT)) {
            return true;
          }
        }
        // Handle T[] | undefined and Default<T[]> | undefined.
        //
        // Default<T[], V> expands to a union (T[] & brand) | T[] at the TypeScript
        // type level. Combined with WishState's `result: T | undefined`, TypeScript
        // flattens the whole thing into a 3-member union:
        //   (T[] & brand) | T[] | undefined
        // After stripping undefined we get 2 members, so we cannot require
        // nonUndefined.length === 1.  Instead, check if ANY non-undefined member
        // is array-like (direct array, or intersection/alias wrapping an array).
        if (innerType.flags & ts.TypeFlags.Union) {
          const nonUndefined = (innerType as ts.UnionType).types.filter(
            (t) => !(t.flags & ts.TypeFlags.Undefined),
          );
          if (nonUndefined.every((t) => isEffectiveArrayMember(t, checker))) {
            return true;
          }
        }
        return false;
      }
    }
  }

  return false;
}
