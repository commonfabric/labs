import ts from "typescript";
import type { SchemaScope } from "@commonfabric/api";
import { getCellWrapperInfo } from "@commonfabric/schema-generator/cell-brand";
import {
  isCommonFabricSymbol,
  resolvesToCommonFabricSymbol,
} from "@commonfabric/schema-generator/common-fabric-symbols";
import { getDefaultMarkerPayload } from "@commonfabric/schema-generator/default-brand";
import { getPropertyNameText } from "@commonfabric/schema-generator/property-name";
import {
  getScopeBrand,
  SCOPE_WRAPPER_FOR_SCOPE,
  scopeForWrapperName,
} from "@commonfabric/schema-generator/scope-brand";
import {
  entityNameRight,
  readAuthoredTypeNode,
  unwrapTypeParentheses,
} from "@commonfabric/schema-generator/type-node";
import { spellingsWhere } from "@commonfabric/schema-generator/wrapper-names";
import {
  createRegisteredTypeLiteral,
  DEFAULT_TYPE_NODE_FLAGS,
  typeToTypeNodeWithRegistry,
} from "../ast/type-building.ts";
import { CF_HELPERS_IDENTIFIER } from "../core/cf-helpers.ts";
import { createPropertyName } from "../utils/identifiers.ts";
import { uniquePaths } from "../utils/path-serialization.ts";
import {
  type CapabilityParamDefault,
  type CapabilityParamSummary,
  type CrossStageState,
  type ReactiveCapability,
  TransformationContext,
} from "../core/mod.ts";
import {
  ensureTypeNodeRegistered,
  getTypeFromTypeNodeWithFallback,
  isAnyOrUnknownType,
  isCellLikeType,
  isSyntheticNode,
  typeToSchemaTypeNode,
  unwrapCellLikeType,
} from "../ast/mod.ts";
import { getCellKind } from "./cell-type.ts";

//
// Types
//

/**
 * How a capability summary is applied to a parameter's schema. `full` shrinks
 * to what the body uses; `defaults_only` keeps defaults and treats the rest
 * as opaque; `contract` serves the authored structure — every declared
 * top-level field is retained, with the summary's usage-derived capability
 * values where the body reads — per the ruling in
 * docs/history/plans/verb-input-contract.md. Only a verb's event parameter uses
 * `contract`: for reactive reads, shrinking is subscription semantics and
 * stays `full`.
 */
export type CapabilitySummaryApplicationMode =
  | "full"
  | "defaults_only"
  | "contract";

interface CapabilityShrinkPlan {
  readonly retainedPaths: readonly (readonly string[])[];
  readonly fullShapePaths: readonly (readonly string[])[];
  readonly identityPaths: readonly (readonly string[])[];
  readonly identityCellPaths: readonly (readonly string[])[];
  readonly comparableCellPaths: readonly (readonly string[])[];
  readonly identityOnlyRoot: boolean;
  readonly effectiveIdentityPaths: readonly (readonly string[])[];
}

/**
 * Properties on array-like types that don't require item-level data.
 * When all accessed paths are in this set, array items can be shrunk
 * to `unknown` to avoid fetching full item schemas.
 *
 * Includes Cell/reactive method names that leak through capability
 * analysis when parent pointers are absent on synthetic AST nodes.
 */
const NON_ITEM_PROPS = new Set([
  "length",
  "get",
  "set",
  "key",
  "update",
]);

//
// Utility helpers
//

function groupPathsByHead(
  paths: readonly (readonly string[])[],
): Map<string, readonly (readonly string[])[]> {
  const grouped = new Map<string, (readonly string[])[]>();
  for (const path of paths) {
    if (path.length === 0) continue;
    const [head, ...tail] = path;
    if (!head) continue;
    const existing = grouped.get(head);
    if (existing) {
      existing.push(tail);
    } else {
      grouped.set(head, [tail]);
    }
  }
  return grouped;
}

function getTopLevelRequestedHeads(
  paths: readonly (readonly string[])[],
): Set<string> {
  const heads = new Set<string>();
  for (const path of paths) {
    const head = path[0];
    if (head) heads.add(head);
  }
  return heads;
}

function getTopLevelRepresentedHeads(
  node: ts.TypeNode,
  checker?: ts.TypeChecker,
): Set<string> {
  const current = unwrapTypeParentheses(node);
  if (!ts.isTypeLiteralNode(current)) {
    return new Set<string>();
  }

  const heads = new Set<string>();
  for (const member of current.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = getRequestedPropertyNameText(member.name, checker);
    if (name) heads.add(name);
  }
  return heads;
}

function countRepresentedRequestedHeads(
  node: ts.TypeNode,
  requestedHeads: ReadonlySet<string>,
  checker?: ts.TypeChecker,
): number {
  if (typeNodeIsArrayShape(node, checker)) {
    let count = 0;
    for (const head of requestedHeads) {
      if (isNumericPathSegment(head) || isArrayRootOnlyPath([head])) {
        count++;
      }
    }
    return count;
  }

  const represented = getTopLevelRepresentedHeads(node, checker);
  let count = 0;
  for (const head of requestedHeads) {
    if (represented.has(head)) count++;
  }
  return count;
}

function isArrayCompatibleRequestedHead(head: string): boolean {
  return isNumericPathSegment(head) || isArrayRootOnlyPath([head]);
}

function shouldPreferArrayShapedShrink(
  nodeDriven: ts.TypeNode,
  typeDriven: ts.TypeNode,
  requestedHeads: ReadonlySet<string>,
  checker: ts.TypeChecker,
): boolean {
  if (requestedHeads.size === 0) return false;
  return typeNodeIsArrayShape(typeDriven, checker) &&
    !typeNodeIsArrayShape(nodeDriven, checker) &&
    [...requestedHeads].every(isArrayCompatibleRequestedHead);
}

function deriveCapabilityShrinkPlan(
  paramSummary: CapabilityParamSummary,
): CapabilityShrinkPlan {
  const paths = uniquePaths([
    ...paramSummary.readPaths,
    ...paramSummary.writePaths,
    ...(paramSummary.opaquePaths ?? []),
  ]);
  const fullShapePaths = uniquePaths(paramSummary.fullShapePaths ?? []);
  const identityPaths = uniquePaths(paramSummary.identityPaths ?? []);
  const identityCellPaths = uniquePaths(paramSummary.identityCellPaths ?? []);
  const comparableCellPaths = uniquePaths([
    ...(paramSummary.comparableCellPaths ?? []),
    ...(paramSummary.capability === "comparable" ? identityCellPaths : []),
  ]);
  const retainedPaths = uniquePaths([...paths, ...identityPaths]);
  const identityOnlyRoot = !!paramSummary.identityOnly &&
    !paramSummary.wildcard &&
    paths.length === 0;
  const effectiveIdentityPaths = identityOnlyRoot &&
      !identityPaths.some((path) => path.length === 0)
    ? uniquePaths([[], ...identityPaths])
    : identityPaths;

  return {
    retainedPaths,
    fullShapePaths,
    identityPaths,
    identityCellPaths,
    comparableCellPaths,
    identityOnlyRoot,
    effectiveIdentityPaths,
  };
}

function shouldPreferNodeDrivenShrink(
  nodeDriven: ts.TypeNode,
  typeDriven: ts.TypeNode,
  baseTypeNode: ts.TypeNode,
  retainedPaths: readonly (readonly string[])[],
  checker: ts.TypeChecker,
): boolean {
  if (
    containsDefaultTypeNode(nodeDriven) && !containsDefaultTypeNode(typeDriven)
  ) {
    return true;
  }

  const requestedHeads = getTopLevelRequestedHeads(retainedPaths);
  if (
    shouldPreferArrayShapedShrink(
      nodeDriven,
      typeDriven,
      requestedHeads,
      checker,
    )
  ) {
    return false;
  }

  const typeDrivenCoverage = countRepresentedRequestedHeads(
    typeDriven,
    requestedHeads,
    checker,
  );
  const nodeDrivenCoverage = countRepresentedRequestedHeads(
    nodeDriven,
    requestedHeads,
    checker,
  );

  return nodeDrivenCoverage > typeDrivenCoverage ||
    (
      nodeDriven !== baseTypeNode &&
      containsAnyOrUnknownTypeNode(nodeDriven) &&
      !containsAnyOrUnknownTypeNode(typeDriven)
    );
}

function shouldPreferTypeDrivenShrink(
  nodeDriven: ts.TypeNode,
  typeDriven: ts.TypeNode,
  baseTypeNode: ts.TypeNode,
  retainedPaths: readonly (readonly string[])[],
  checker: ts.TypeChecker,
  hasDirectAccess: boolean,
): boolean {
  if (
    containsDefaultTypeNode(nodeDriven) && !containsDefaultTypeNode(typeDriven)
  ) {
    return false;
  }

  const requestedHeads = getTopLevelRequestedHeads(retainedPaths);
  if (
    shouldPreferArrayShapedShrink(
      nodeDriven,
      typeDriven,
      requestedHeads,
      checker,
    )
  ) {
    return true;
  }

  const typeDrivenCoverage = countRepresentedRequestedHeads(
    typeDriven,
    requestedHeads,
    checker,
  );
  const nodeDrivenCoverage = countRepresentedRequestedHeads(
    nodeDriven,
    requestedHeads,
    checker,
  );

  return (
    nodeDriven === baseTypeNode &&
    typeDriven !== baseTypeNode &&
    !hasDirectAccess
  ) ||
    typeDrivenCoverage > nodeDrivenCoverage ||
    (
      containsAnyOrUnknownTypeNode(nodeDriven) &&
      !containsAnyOrUnknownTypeNode(typeDriven)
    );
}

/**
 * Returns `true` for a node that references `Default`. A `Default` that type
 * shrinking restored does not count: a candidate built from a type holds one
 * wherever the type had one, and the choice between candidates weighs a
 * default only where shrinking one of them lost it.
 */
function containsDefaultTypeNode(node: ts.TypeNode): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) return;
    if (ts.isTypeReferenceNode(current) && !RESTORED_DEFAULTS.has(current)) {
      const name = ts.isIdentifier(current.typeName)
        ? current.typeName.text
        : ts.isQualifiedName(current.typeName)
        ? current.typeName.right.text
        : undefined;
      if (name === "Default") {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function choosePreferredShrinkCandidate(
  primaryStrategy: "type" | "node",
  nodeDriven: ts.TypeNode | undefined,
  typeDriven: ts.TypeNode | undefined,
  baseTypeNode: ts.TypeNode,
  retainedPaths: readonly (readonly string[])[],
  checker: ts.TypeChecker,
  hasDirectAccess: boolean,
): ts.TypeNode | undefined {
  if (primaryStrategy === "type") {
    if (!typeDriven) return nodeDriven;
    if (!nodeDriven) return typeDriven;
    return shouldPreferNodeDrivenShrink(
        nodeDriven,
        typeDriven,
        baseTypeNode,
        retainedPaths,
        checker,
      )
      ? nodeDriven
      : typeDriven;
  }

  if (!nodeDriven) return typeDriven;
  if (!typeDriven) return nodeDriven;
  return shouldPreferTypeDrivenShrink(
      nodeDriven,
      typeDriven,
      baseTypeNode,
      retainedPaths,
      checker,
      hasDirectAccess,
    )
    ? typeDriven
    : nodeDriven;
}

function typeIncludesUndefined(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Undefined) !== 0) {
    return true;
  }
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const union = type as ts.UnionType;
    return union.types.some((member) => typeIncludesUndefined(member));
  }
  return false;
}

function isNullishType(type: ts.Type): boolean {
  return !!(type.flags & (
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.Void
  ));
}

function isPrimitiveScalarLikeType(type: ts.Type): boolean {
  return !!(type.flags & (
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike
  ));
}

function getSymbolTypeAtSource(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): ts.Type {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ??
    sourceFile;
  return checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

function isNullishTypeNode(node: ts.TypeNode): boolean {
  return node.kind === ts.SyntaxKind.UndefinedKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isLiteralTypeNode(node) &&
      node.literal.kind === ts.SyntaxKind.NullKeyword) ||
    node.kind === ts.SyntaxKind.VoidKeyword;
}

function typeNodeIncludesUndefined(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
    return true;
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.some((member) => typeNodeIncludesUndefined(member));
  }
  return false;
}

export function containsAnyOrUnknownTypeNode(node: ts.TypeNode): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) return;
    if (
      current.kind === ts.SyntaxKind.AnyKeyword ||
      current.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      found = true;
      return;
    }
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

function getRequestedPropertyNameText(
  name: ts.PropertyName,
  checker?: ts.TypeChecker,
): string | undefined {
  return getPropertyNameText(name, checker);
}

export function isArrayShapeType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const typeChecker = checker as ts.TypeChecker & {
    isArrayType?: (type: ts.Type) => boolean;
    isTupleType?: (type: ts.Type) => boolean;
  };
  const symbolName = type.getSymbol()?.getName();
  return !!(
    typeChecker.isArrayType?.(type) ||
    typeChecker.isTupleType?.(type) ||
    symbolName === "Array" ||
    symbolName === "ReadonlyArray" ||
    isArrayLikeIndexType(type, checker)
  );
}

function isHomogeneousArrayType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const typeChecker = checker as ts.TypeChecker & {
    isArrayType?: (type: ts.Type) => boolean;
    isTupleType?: (type: ts.Type) => boolean;
  };
  if (typeChecker.isTupleType?.(type)) {
    return false;
  }
  if (typeChecker.isArrayType?.(type)) {
    return true;
  }
  const symbolName = type.getSymbol()?.getName();
  return symbolName === "Array" || symbolName === "ReadonlyArray" ||
    isArrayLikeIndexType(type, checker);
}

function isArrayLikeIndexType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  // The transformer sometimes sees array values after narrowing as anonymous
  // array-like types rather than concrete Array<T> symbols. Requiring both a
  // numeric index and `length` keeps plain numeric maps object-shaped.
  return !!checker.getIndexTypeOfType(type, ts.IndexKind.Number) &&
    !!findPropertySymbol(type, "length", checker);
}

function typeNodeIsArrayShape(
  node: ts.TypeNode,
  checker?: ts.TypeChecker,
): boolean {
  const current = unwrapTypeParentheses(node);
  if (ts.isArrayTypeNode(current)) {
    return true;
  }
  if (
    ts.isTypeOperatorNode(current) &&
    current.operator === ts.SyntaxKind.ReadonlyKeyword &&
    ts.isArrayTypeNode(current.type)
  ) {
    return true;
  }
  if (
    ts.isTypeReferenceNode(current) &&
    ts.isIdentifier(current.typeName) &&
    (current.typeName.text === "Array" ||
      current.typeName.text === "ReadonlyArray")
  ) {
    return true;
  }
  if (ts.isTypeLiteralNode(current)) {
    return !!getArrayLikeTypeLiteralElementType(current, checker);
  }
  if (!checker) {
    return false;
  }
  const resolvedType = getTypeFromTypeNodeWithFallback(current, checker);
  return isArrayShapeType(resolvedType, checker);
}

function isNumericIndexableType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  return isArrayShapeType(type, checker) ||
    !!checker.getIndexTypeOfType(type, ts.IndexKind.Number);
}

function isNumericPathSegment(segment: string): boolean {
  return /^\d+$/.test(segment);
}

function isArrayRootOnlyPath(
  path: readonly string[],
): boolean {
  if (path.length !== 1) {
    return false;
  }

  const [head] = path;
  return !!head && NON_ITEM_PROPS.has(head);
}

function getArrayItemPaths(
  paths: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  const itemPaths: (readonly string[])[] = [];
  for (const path of paths) {
    if (path.length === 0) continue;
    const [head, ...tail] = path;
    if (!head) continue;
    if (isArrayRootOnlyPath(path)) {
      continue;
    }
    itemPaths.push(isNumericPathSegment(head) ? tail : path);
  }
  return uniquePaths(itemPaths);
}

function getArrayElementType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const numericIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (numericIndex) {
    return numericIndex;
  }

  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const objectType = type as ts.ObjectType;
    if ((objectType.objectFlags & ts.ObjectFlags.Reference) !== 0) {
      const ref = objectType as ts.TypeReference;
      const typeArgs = checker.getTypeArguments(ref);
      if (typeArgs[0]) {
        return typeArgs[0];
      }
    }
  }

  return undefined;
}

function getArrayLikeTypeLiteralElementType(
  node: ts.TypeLiteralNode,
  checker?: ts.TypeChecker,
): ts.TypeNode | undefined {
  let hasLength = false;
  let elementType: ts.TypeNode | undefined;

  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) {
      continue;
    }
    const name = getRequestedPropertyNameText(member.name, checker);
    if (name === "length") {
      hasLength = true;
    } else if (name && isNumericPathSegment(name) && !elementType) {
      elementType = member.type;
    }
  }

  return hasLength ? elementType : undefined;
}

function isAnyOrUnknownTypeNode(node: ts.TypeNode): boolean {
  return node.kind === ts.SyntaxKind.AnyKeyword ||
    node.kind === ts.SyntaxKind.UnknownKeyword;
}

function buildUnknownShapeTypeNodeFromPaths(
  paths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode | undefined {
  const grouped = groupPathsByHead(paths);
  const members: ts.TypeElement[] = [];

  for (const [head, childPaths] of grouped) {
    const hasDirectAccess = childPaths.some((path) => path.length === 0);
    const nestedPaths = childPaths.filter((path) => path.length > 0);
    const childType = !hasDirectAccess && nestedPaths.length > 0
      ? buildUnknownShapeTypeNodeFromPaths(
        nestedPaths,
        factory,
        checker,
        typeRegistry,
      ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
      : factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

    members.push(
      factory.createPropertySignature(
        undefined,
        createPropertyName(head, factory),
        undefined,
        childType,
      ),
    );
  }

  if (members.length === 0) {
    return undefined;
  }
  return checker
    ? createRegisteredTypeLiteral(members, { factory, checker, typeRegistry })
    : factory.createTypeLiteralNode(members);
}

function shrinkArrayElementTypeNode(
  elementType: ts.TypeNode,
  itemPaths: readonly (readonly string[])[],
  fullShapeItemPaths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  state?: CrossStageState,
  sourceFile?: ts.SourceFile,
): ts.TypeNode {
  let shrunkElement = buildShrunkTypeNodeFromTypeNode(
    elementType,
    itemPaths,
    factory,
    checker,
    typeRegistry,
    state,
    fullShapeItemPaths,
    sourceFile,
  ) ?? elementType;
  if (
    isAnyOrUnknownTypeNode(shrunkElement) &&
    itemPaths.some((path) => path.length > 0)
  ) {
    shrunkElement = buildUnknownShapeTypeNodeFromPaths(
      itemPaths,
      factory,
      checker,
      typeRegistry,
    ) ?? shrunkElement;
  }
  return shrunkElement;
}

function getSymbolPropertyHead(
  symbol: ts.Symbol,
  checker?: ts.TypeChecker,
): string | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration)) &&
      declaration.name
    ) {
      const head = getRequestedPropertyNameText(declaration.name, checker);
      if (head) return head;
    }
  }
  return undefined;
}

function findPropertySymbol(
  type: ts.Type,
  head: string,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const direct = type.getProperty(head);
  if (direct) return direct;

  for (const prop of checker.getPropertiesOfType(type)) {
    if (getSymbolPropertyHead(prop, checker) === head) {
      return prop;
    }
  }

  if (type.isUnion()) {
    for (const member of type.types) {
      const prop = findPropertySymbol(member, head, checker);
      if (prop) return prop;
    }
  }

  return undefined;
}

// Wrapper spellings the shrinking pass treats as cell-like type NODES (the
// reference may carry capability narrowing rather than a structural change).
const CELL_LIKE_TYPE_NODE_NAMES = spellingsWhere({
  Cell: true,
  Writable: true,
  OpaqueCell: true,
  Reactive: true,
  ComparableCell: true,
  ReadonlyCell: true,
  WriteonlyCell: true,
  Stream: true,
  // SqliteDb references are not rewritten by shrinking; the brand survives
  // capability shrinking via its own path (#3860).
  SqliteDb: false,
  CellTypeConstructor: false,
  ScopedCellTypeConstructor: false,
});

export function isCellLikeTypeNode(node: ts.TypeNode): boolean {
  if (!ts.isTypeReferenceNode(node)) return false;
  const name = getTypeReferenceNodeName(node);
  if (!name) return false;
  return CELL_LIKE_TYPE_NODE_NAMES.has(name);
}

/**
 * Returns `true` for a reference to one of `commonfabric`'s cell wrappers
 * (`CELL_LIKE_TYPE_NODE_NAMES`): one whose name resolves, through its import
 * binding, to the wrapper `commonfabric` declares, under whatever name it was
 * imported as. A type of the author's own that shares a wrapper's name is
 * something else, and so is an alias of a wrapper: its type arguments are its
 * own, not the wrapper's, and `readAuthoredTypeNode()` reads through the ones
 * that can be read through. A reference the transformer builds — one qualified
 * by its helper namespace, or one the checker cannot resolve — is judged by
 * its spelling alone.
 */
function namesCellWrapper(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): node is ts.TypeReferenceNode {
  return namesCommonFabricType(node, CELL_LIKE_TYPE_NODE_NAMES, checker);
}

/**
 * Returns `true` for a reference to one of `commonfabric`'s scope wrappers
 * (`SCOPE_WRAPPER_NAMES`), judged as `namesCellWrapper()` judges a cell
 * wrapper.
 */
function namesScopeWrapper(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): node is ts.TypeReferenceNode {
  return namesCommonFabricType(node, SCOPE_WRAPPER_NAMES, checker);
}

/**
 * Helper for `namesCellWrapper()` and `namesScopeWrapper()`, which returns
 * `true` for a reference whose name resolves, through its import binding, to
 * a type `commonfabric` declares under one of `names`, and for one the checker
 * cannot resolve whose spelling is one of `names`.
 */
function namesCommonFabricType(
  node: ts.TypeNode,
  names: ReadonlySet<string>,
  checker: ts.TypeChecker,
): node is ts.TypeReferenceNode {
  if (!ts.isTypeReferenceNode(node)) return false;
  const helper = ts.isQualifiedName(node.typeName) &&
    ts.isIdentifier(node.typeName.left) &&
    node.typeName.left.text === CF_HELPERS_IDENTIFIER;
  const name = ts.isIdentifier(node.typeName)
    ? node.typeName
    : node.typeName.right;
  const symbol = helper ? undefined : checker.getSymbolAtLocation(name);
  if (!symbol) return names.has(name.text);
  const declared = symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
  return names.has(declared.getName()) && isCommonFabricSymbol(declared);
}

function getTypeReferenceNodeName(
  node: ts.TypeReferenceNode,
): string | undefined {
  return ts.isIdentifier(node.typeName)
    ? node.typeName.text
    : ts.isQualifiedName(node.typeName)
    ? node.typeName.right.text
    : undefined;
}

export function isStreamTypeNode(node: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(node) &&
    getTypeReferenceNodeName(node) === "Stream";
}

function isStreamCellType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): boolean {
  return !!type && getCellKind(type, checker) === "stream";
}

export function isSqliteTypeNode(node: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(node) &&
    getTypeReferenceNodeName(node) === "SqliteDb";
}

/** A `SqliteDb` handle carries an explicit "sqlite" cell brand. Like `Stream`,
 *  that brand is authoritative and must survive capability shrinking — the
 *  reactive read/write inference would otherwise collapse its read-only method
 *  surface to an `asCell: ["readonly"]` wrapper, disagreeing with the schema
 *  generator's object-formatter path (which stamps `["sqlite"]`). */
function isSqliteCellType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): boolean {
  return !!type && getCellKind(type, checker) === "sqlite";
}

export function printTypeNode(
  node: ts.TypeNode,
  sourceFile: ts.SourceFile,
): string {
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

//
// Core type-shrinking
//

/**
 * Returns a type node for the part of `type` that `paths` reach, or
 * `undefined` when there is none to build. The node keeps the scope wrapper
 * that the alias of `type` names and the default its `Default` brand carries,
 * and so does each part of it the node retains.
 */
function buildShrunkTypeNodeFromType(
  type: ts.Type,
  paths: readonly (readonly string[])[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  state?: CrossStageState,
  fullShapePaths: readonly (readonly string[])[] = [],
  visiting: ReadonlySet<string> = new Set(),
): ts.TypeNode | undefined {
  const typeToNodeFlags = ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback;
  const normalized = uniquePaths(paths);
  const normalizedFullShapePaths = uniquePaths(fullShapePaths);
  if (normalized.length === 0) {
    return undefined;
  }
  // The scope lives in the wrapper's alias and brand, not in the scoped
  // type's structure, so a node built from that structure would drop it.
  const scopeWrapper = getScopeWrapper(type, checker);
  if (scopeWrapper) {
    const alternatives: ts.TypeNode[] = [];
    for (const payload of scopeWrapper.payload) {
      const shrunk = buildShrunkTypeNodeFromType(
        payload,
        paths,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        state,
        fullShapePaths,
        visiting,
      );
      if (!shrunk) return undefined;
      alternatives.push(shrunk);
    }
    const wrapped = createHelperWrapperTypeNode(
      alternatives.length === 1
        ? alternatives[0]!
        : factory.createUnionTypeNode(alternatives),
      scopeWrapper.name,
      factory,
    );
    // Schema generation reads a wrapper reference by its type, and the
    // synthesized one resolves to nothing where it is emitted.
    typeRegistry?.set(wrapped, type);
    return wrapped;
  }
  // A (type, requested-paths) pair already on the descent path cannot be
  // materialized as a literal — the recursion would never bottom out. The
  // paths are part of the key because revisiting the same type with narrower
  // paths terminates on its own. Fall back to the NAMED reference (no
  // structural fallback: expanding structure here is the very recursion
  // being cut), which schema generation resolves through `$defs` exactly as
  // it does for an authored node. Reachable since `contract` mode retains
  // declared fields whose types are self-referential.
  const visitKey = `${(type as ts.Type & { id?: number }).id ?? "?"}|${
    JSON.stringify(normalized)
  }`;
  if (visiting.has(visitKey)) {
    return typeToTypeNodeWithRegistry(
      type,
      { checker, factory, sourceFile, state },
      typeRegistry,
      ts.NodeBuilderFlags.NoTruncation,
    );
  }
  const guarded = new Set(visiting);
  guarded.add(visitKey);
  if (normalizedFullShapePaths.some((path) => path.length === 0)) {
    return typeToTypeNodeWithRegistry(
      type,
      { checker, factory, sourceFile, state },
      typeRegistry,
      typeToNodeFlags,
    );
  }

  // Normalized cell paths address the stored value. Preserve the wrapper so
  // a value field named after a cell method resolves against the inner type.
  if (isCellLikeType(type, checker)) {
    const node = typeToTypeNodeWithRegistry(
      type,
      { checker, factory, sourceFile, state },
      typeRegistry,
      typeToNodeFlags,
    );
    if (
      node && (ts.isUnionTypeNode(node) ||
        (ts.isTypeReferenceNode(node) && isCellLikeTypeNode(node) &&
          node.typeArguments?.length))
    ) {
      return buildShrunkTypeNodeFromTypeNode(
        node,
        normalized,
        factory,
        checker,
        typeRegistry,
        state,
        normalizedFullShapePaths,
        sourceFile,
      );
    }
    return node;
  }

  // Keep array-like roots as arrays. Narrowing `T[]` to `{ length: number }`
  // breaks runtime schema matching for downstream lift-applied calls.
  // However, when only array-intrinsic properties like `length` are accessed
  // (no item-level access), shrink the item type to `unknown` to avoid
  // fetching full item schemas unnecessarily.
  if (isArrayShapeType(type, checker)) {
    const itemPaths = getArrayItemPaths(normalized);
    const fullShapeItemPaths = getArrayItemPaths(normalizedFullShapePaths);
    const allNonItem = normalized.every((path) => isArrayRootOnlyPath(path));
    if (allNonItem && isHomogeneousArrayType(type, checker)) {
      // No item access — emit unknown[] to avoid fetching item schemas.
      return restoreDefault(
        factory.createArrayTypeNode(
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        type,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        state,
      );
    }
    if (itemPaths.length > 0 && isHomogeneousArrayType(type, checker)) {
      const elementType = getArrayElementType(type, checker);
      if (elementType) {
        const elementNode = buildShrunkTypeNodeFromType(
          elementType,
          itemPaths,
          checker,
          sourceFile,
          factory,
          typeRegistry,
          state,
          fullShapeItemPaths,
          guarded,
        ) ??
          typeToTypeNodeWithRegistry(
            elementType,
            { checker, factory, sourceFile, state },
            typeRegistry,
            typeToNodeFlags,
          );
        const arrayNode = factory.createArrayTypeNode(elementNode);
        ensureTypeNodeRegistered(arrayNode, checker, typeRegistry);
        return restoreDefault(
          arrayNode,
          type,
          checker,
          sourceFile,
          factory,
          typeRegistry,
          state,
        );
      }
    }
    return typeToTypeNodeWithRegistry(
      type,
      { checker, factory, sourceFile, state },
      typeRegistry,
      typeToNodeFlags,
    );
  }

  if (normalized.some((path) => path.length === 0)) {
    return typeToTypeNodeWithRegistry(
      type,
      { checker, factory, sourceFile, state },
      typeRegistry,
      typeToNodeFlags,
    );
  }

  // Strip nullish constituents from union types (e.g. `T | undefined`) so the
  // shrinking logic can resolve properties on the non-nullish part. This runs
  // after the direct-access check above so leaf types like `string | undefined`
  // are returned as-is when they have an empty-path access.
  // After shrinking, re-wrap with the nullish members to preserve the union
  // semantics (e.g. `foo?.bar` means `undefined` is still a valid value for foo).
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const nonNullable = checker.getNonNullableType(type);
    if (nonNullable !== type) {
      const shrunkInner = buildShrunkTypeNodeFromType(
        nonNullable,
        paths,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        state,
        normalizedFullShapePaths,
        guarded,
      );
      if (!shrunkInner) return undefined;
      // Collect the nullish members to re-append
      const nullishMembers: ts.TypeNode[] = [];
      if (type.isUnion()) {
        for (const constituent of type.types) {
          if (
            constituent.flags &
            (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)
          ) {
            nullishMembers.push(
              typeToTypeNodeWithRegistry(
                constituent,
                { checker, factory, sourceFile, state },
                typeRegistry,
                typeToNodeFlags,
              ),
            );
          }
        }
      }
      if (nullishMembers.length === 0) return shrunkInner;
      // A default restored on the value belongs to the whole union: the
      // runtime reads a missing property's default only from the top of its
      // schema.
      const [value, defaultValue] = RESTORED_DEFAULTS.has(shrunkInner) &&
          ts.isTypeReferenceNode(shrunkInner) && shrunkInner.typeArguments
        ? shrunkInner.typeArguments
        : [shrunkInner];
      const unionNode = factory.createUnionTypeNode([
        value!,
        ...nullishMembers,
      ]);
      ensureTypeNodeRegistered(unionNode, checker, typeRegistry);
      return defaultValue
        ? wrapTypeNodeWithRestoredDefault(unionNode, defaultValue, factory)
        : unionNode;
    }
  }

  const grouped = groupPathsByHead(normalized);
  const fullShapeGrouped = groupPathsByHead(normalizedFullShapePaths);
  const properties: ts.TypeElement[] = [];

  for (const [head, childPaths] of grouped) {
    let propType: ts.Type | undefined;
    let isOptional = false;

    const prop = findPropertySymbol(type, head, checker);
    if (prop) {
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0] ??
        sourceFile;
      propType = checker.getTypeOfSymbolAtLocation(prop, declaration);
      isOptional = !!(prop.flags & ts.SymbolFlags.Optional) ||
        (propType ? typeIncludesUndefined(propType) : false);
    } else {
      // Numeric/unknown-key accesses can be represented via index signatures
      // rather than named properties. Use the index type when available.
      const numericIndex = Number.isFinite(Number(head));
      const indexType = checker.getIndexTypeOfType(
        type,
        numericIndex ? ts.IndexKind.Number : ts.IndexKind.String,
      ) ?? checker.getIndexTypeOfType(type, ts.IndexKind.String);
      if (!indexType) continue;
      propType = indexType;
      // An index signature types whatever keys happen to exist — it never
      // guarantees this particular key is present. The shrunken property must
      // be optional, or the injected schema marks it `required` and values
      // lacking the key fail validation (the whole capture then reads
      // undefined at runtime).
      isOptional = true;
    }

    const hasDirectAccess = childPaths.some((path) => path.length === 0);
    const fullShapeChildPaths = fullShapeGrouped.get(head) ?? [];

    if (!propType) {
      continue;
    }

    // Nested primitive leaves still need their original runtime shape. For
    // object properties like `input.text.length`, shrinking `text` to
    // `{ length: number }` changes a string leaf into an object and breaks the
    // authored callback contract. Keep the primitive property type intact here;
    // root-level primitive projections (e.g. `summary.length`) are still
    // handled by the recursive shrink above.
    if (!hasDirectAccess && isPrimitiveScalarLikeType(propType)) {
      const propTypeNode = typeToTypeNodeWithRegistry(
        propType,
        { checker, factory, sourceFile, state },
        typeRegistry,
        typeToNodeFlags,
      );
      properties.push(
        factory.createPropertySignature(
          undefined,
          createPropertyName(head, factory),
          isOptional
            ? factory.createToken(ts.SyntaxKind.QuestionToken)
            : undefined,
          propTypeNode,
        ),
      );
      continue;
    }

    if (!hasDirectAccess && isAnyOrUnknownType(propType)) {
      // Preserve node-based precision for unresolved nested members.
      continue;
    }

    const shrunkChild = buildShrunkTypeNodeFromType(
      propType,
      childPaths,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      state,
      fullShapeChildPaths,
      guarded,
    );
    if (!shrunkChild && !hasDirectAccess) {
      // We failed to materialize a deeper path; let caller fall back to
      // node-based shrinking instead of widening to the full property shape.
      continue;
    }

    const propTypeNode = shrunkChild ??
      typeToTypeNodeWithRegistry(
        propType,
        { checker, factory, sourceFile, state },
        typeRegistry,
        typeToNodeFlags,
      );

    properties.push(
      factory.createPropertySignature(
        undefined,
        createPropertyName(head, factory),
        isOptional
          ? factory.createToken(ts.SyntaxKind.QuestionToken)
          : undefined,
        propTypeNode,
      ),
    );
  }

  if (properties.length === 0) {
    return undefined;
  }

  return restoreDefault(
    createRegisteredTypeLiteral(
      properties,
      { factory, checker, typeRegistry },
    ),
    type,
    checker,
    sourceFile,
    factory,
    typeRegistry,
    state,
  );
}

/**
 * The type the checker decomposed into `alternatives`, each one a literal, and
 * `undefined` where they are not every literal of one such type. `boolean` is
 * the case that matters: the checker holds it as `false | true`, and a brand
 * over it distributes into two alternatives that are the type written.
 */
function recomposedLiteralUnion(
  alternatives: readonly ts.Type[],
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const [first] = alternatives;
  if (!first) return undefined;
  const base = checker.getBaseTypeOfLiteralType(first);
  return base !== first && base.isUnion() &&
      base.types.length === alternatives.length &&
      base.types.every((member) => alternatives.includes(member))
    ? base
    : undefined;
}

/**
 * The wrappers that store a value in a scope, which `getScopeWrapper()` reads
 * by name when a type's alias is one of them: the alias then gives the
 * wrapper's argument as it was written, where the brand gives only the members
 * the checker resolved it to.
 */
const SCOPE_WRAPPER_NAMES: ReadonlySet<string> = new Set(
  Object.values(SCOPE_WRAPPER_FOR_SCOPE),
);

/**
 * Helper for `buildShrunkTypeNodeFromType()`, which returns the name of the
 * `commonfabric` scope wrapper `type` instantiates, with the types it scopes,
 * or `undefined` for any other type. The payload is given as the brand gives
 * it: one alternative per member of a union the brand was distributed over,
 * each listing the types that intersect to that alternative, which the caller
 * shrinks and joins back together. The checker reports only the outermost
 * alias, so a wrapper reached through an alias of the author's own, as in
 * `type Rec = PerUser<Inner>`, is recognized by that brand rather than by the
 * alias. A type of the author's own that shares a wrapper's name is not one,
 * and neither is a scope wrapper around a cell: the wrapper is read by the
 * scoped type it is registered with, which would undo the capability
 * narrowing applied to the cell node inside it.
 */
function getScopeWrapper(
  type: ts.Type,
  checker: ts.TypeChecker,
): { readonly name: string; readonly payload: readonly ts.Type[] } | undefined {
  const symbol = type.aliasSymbol;
  const argument = type.aliasTypeArguments?.[0];
  if (
    symbol && argument && SCOPE_WRAPPER_NAMES.has(symbol.name) &&
    resolvesToCommonFabricSymbol(symbol, checker, symbol.name)
  ) {
    return isCellLikeType(argument, checker)
      ? undefined
      : { name: symbol.name, payload: [argument] };
  }
  const brand = getScopeBrand(type, checker);
  if (!brand) return undefined;
  // An alternative the checker flattened into several members has no type of
  // its own to shrink. The branded type itself is no substitute: the node
  // built from it is registered with a type that still carries the brand, and
  // schema generation would then apply the scope inside the wrapper as well,
  // which it refuses as a nested scope.
  const payload = brand.payload.map((alternative) =>
    alternative.length === 1 ? alternative[0]! : undefined
  );
  if (payload.some((alternative) => alternative === undefined)) {
    return undefined;
  }
  const alternatives = payload as ts.Type[];
  if (
    alternatives.some((alternative) => isCellLikeType(alternative, checker))
  ) {
    return undefined;
  }
  const recomposed = recomposedLiteralUnion(alternatives, checker);
  return {
    name: SCOPE_WRAPPER_FOR_SCOPE[brand.scope],
    payload: recomposed ? [recomposed] : alternatives,
  };
}

/**
 * Returns `true` for a cell whose scope a `commonfabric` scope wrapper names,
 * as `Writable.perSession.of()` returns. Only the alias names the scope, so a
 * node built from the cell's structure would drop it.
 */
function isScopedCellType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const symbol = type.aliasSymbol;
  const scoped = type.aliasTypeArguments?.[0];
  return !!symbol && !!scoped && SCOPE_WRAPPER_NAMES.has(symbol.name) &&
    isCellLikeType(scoped, checker) &&
    resolvesToCommonFabricSymbol(symbol, checker, symbol.name);
}

/** A scope wrapper around a cell, taken apart: its name, cell, and type. */
interface ScopedCellParts {
  readonly name: string;
  readonly cell: ts.TypeNode;
  readonly type: ts.Type | undefined;
}

/**
 * Returns the parts of a `commonfabric` scope wrapper around a cell that
 * `node` writes out (`PerUser<Writable<T>>`, or the `__cfHelpers.PerUser<...>`
 * a pass builds), or `undefined` for any other node. The type is the one
 * `node` is registered with, or resolves to, and names the wrapper under
 * whatever name its reference was imported as.
 */
function scopedCellNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): ScopedCellParts | undefined {
  const cell = ts.isTypeReferenceNode(node)
    ? node.typeArguments?.[0]
    : undefined;
  if (
    !cell || !namesScopeWrapper(node, checker) ||
    !namesCellWrapper(cell, checker)
  ) {
    return undefined;
  }
  const type = getTypeFromTypeNodeWithFallback(node, checker, typeRegistry);
  const alias = type?.aliasSymbol?.name;
  return {
    name: alias && SCOPE_WRAPPER_NAMES.has(alias)
      ? alias
      : getTypeReferenceNodeName(node as ts.TypeReferenceNode)!,
    cell,
    type,
  };
}

/**
 * Helper for `applyCellCapabilityPathsToTypeNode()`, which returns the parts
 * of a scope wrapper around a cell that `node` holds, as `scopedCellNode()`
 * does, or, for a print of one, its cell printed afresh from its type.
 */
function scopedCellParts(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  state: CrossStageState | undefined,
): ScopedCellParts | undefined {
  const printedType = state?.printedFrom(node);
  if (!printedType) return scopedCellNode(node, checker, typeRegistry);
  if (!isScopedCellType(printedType, checker)) return undefined;
  return {
    name: printedType.aliasSymbol!.name,
    cell: typeToTypeNodeWithRegistry(
      printedType.aliasTypeArguments![0]!,
      { checker, factory, sourceFile, state },
      typeRegistry,
    ),
    type: printedType,
  };
}

/**
 * Wraps `node`, a cell a pass rebuilt, in the scope wrapper `name`, and
 * registers the wrapper with `type`, the scoped cell's own type: schema
 * generation dispatches on that type, reads the scope from the wrapper's name,
 * and reads the cell from `node`, keeping any narrowing it carries.
 */
function wrapScopedCell(
  node: ts.TypeNode,
  name: string,
  type: ts.Type | undefined,
  factory: ts.NodeFactory,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): ts.TypeNode {
  const wrapper = createHelperWrapperTypeNode(node, name, factory);
  if (type) typeRegistry?.set(wrapper, type);
  return wrapper;
}

/** The `Default` wrappers `wrapTypeNodeWithRestoredDefault()` built. */
const RESTORED_DEFAULTS = new WeakSet<ts.TypeNode>();

/**
 * Helper for `buildShrunkTypeNodeFromType()` and `restoreDefault()`, which
 * wraps `node` in a `Default` of `value` that type shrinking restored rather
 * than one its author wrote, and records it in `RESTORED_DEFAULTS`.
 */
function wrapTypeNodeWithRestoredDefault(
  node: ts.TypeNode,
  value: ts.TypeNode,
  factory: ts.NodeFactory,
): ts.TypeNode {
  const restored = wrapTypeNodeWithDefault(node, value, factory);
  RESTORED_DEFAULTS.add(restored);
  return restored;
}

/**
 * Helper for `buildShrunkTypeNodeFromType()`, which wraps `node`, a node built
 * from the structure of `type`, in the `Default` that `type` carries. Once the
 * checker resolves `Default` away, its value survives only in the brand on the
 * members of `type`, and a node built from their structure drops it. Returns
 * `node` itself when `type` carries no default, or members that disagree on
 * one.
 */
function restoreDefault(
  node: ts.TypeNode,
  type: ts.Type,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  state: CrossStageState | undefined,
): ts.TypeNode {
  const payloads = new Set<ts.Type>();
  for (const member of type.isUnion() ? type.types : [type]) {
    const payload = getDefaultMarkerPayload(member, checker);
    if (payload) payloads.add(payload);
  }
  const [payload, ...others] = payloads;
  if (!payload || others.length > 0) return node;
  const value = typeToTypeNodeWithRegistry(
    payload,
    { checker, factory, sourceFile, state },
    typeRegistry,
    DEFAULT_TYPE_NODE_FLAGS | ts.NodeBuilderFlags.AllowEmptyTuple,
  );
  return wrapTypeNodeWithRestoredDefault(node, value, factory);
}

function buildShrunkTypeNodeFromTypeNode(
  node: ts.TypeNode,
  paths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  state?: CrossStageState,
  fullShapePaths: readonly (readonly string[])[] = [],
  sourceFile?: ts.SourceFile,
): ts.TypeNode | undefined {
  const printedType = state?.printedFrom(node);
  // A scoped cell's print is kept whole: only its alias names its scope.
  // Narrowing rebuilds it around its cell, which is shrunk through the rebuilt
  // wrapper.
  if (printedType && checker && isScopedCellType(printedType, checker)) {
    return undefined;
  }
  // A printed node is not taken apart: it is shrunk as its unfolding, or not
  // at all.
  if (printedType && isUnfoldableKind(node)) {
    const unfolded = checker && sourceFile &&
      unfoldPrint(
        node,
        printedType,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        state,
      );
    if (!unfolded) return undefined;
    const shrunk = buildShrunkTypeNodeFromTypeNode(
      unfolded,
      paths,
      factory,
      checker,
      typeRegistry,
      state,
      fullShapePaths,
      sourceFile,
    );
    return shrunk === unfolded ? node : shrunk;
  }

  // A scope wrapper around a cell is shrunk as the cell it scopes.
  const scopedCell = checker && scopedCellNode(node, checker, typeRegistry);
  if (scopedCell) {
    const shrunk = buildShrunkTypeNodeFromTypeNode(
      scopedCell.cell,
      paths,
      factory,
      checker,
      typeRegistry,
      state,
      fullShapePaths,
      sourceFile,
    );
    if (!shrunk) return undefined;
    return shrunk === scopedCell.cell ? node : wrapScopedCell(
      shrunk,
      scopedCell.name,
      scopedCell.type,
      factory,
      typeRegistry,
    );
  }

  const normalized = uniquePaths(paths);
  const normalizedFullShapePaths = uniquePaths(fullShapePaths);
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalizedFullShapePaths.some((path) => path.length === 0)) {
    return node;
  }
  const hasDirectAccess = normalized.some((path) => path.length === 0);

  if (hasDirectAccess) {
    // For Cell-like types, an empty path typically comes from `.get()` being
    // tracked as a full read.  If there are also longer paths (e.g. from
    // `.get().length`), try shrinking the inner type using those paths.
    if (
      ts.isTypeReferenceNode(node) &&
      isCellLikeTypeNode(node) &&
      node.typeArguments &&
      node.typeArguments.length > 0
    ) {
      const nonEmptyPaths = normalized.filter((path) => path.length > 0);
      if (nonEmptyPaths.length > 0) {
        const [inner, ...rest] = node.typeArguments;
        if (inner) {
          const shrunkInner = buildShrunkTypeNodeFromTypeNode(
            inner,
            nonEmptyPaths,
            factory,
            checker,
            typeRegistry,
            state,
            normalizedFullShapePaths,
            sourceFile,
          );
          if (shrunkInner && shrunkInner !== inner) {
            return factory.updateTypeReferenceNode(
              node,
              node.typeName,
              factory.createNodeArray([shrunkInner, ...rest]),
            );
          }
        }
      }
    }
    if (!normalized.some((path) => path.length > 0)) {
      return node;
    }
  }

  // Shrink array types: when only array-intrinsic properties (e.g. `length`)
  // are accessed, replace the item type with `unknown` to avoid fetching full
  // item schemas.  The result stays array-shaped for runtime schema matching.
  // Handles `Item[]` (ArrayTypeNode), `Array<Item>` (TypeReferenceNode), and
  // type aliases that resolve to arrays (via the type checker).
  {
    let isArray = ts.isArrayTypeNode(node) ||
      // readonly T[]  →  TypeOperator(readonly, ArrayTypeNode)
      (ts.isTypeOperatorNode(node) &&
        node.operator === ts.SyntaxKind.ReadonlyKeyword &&
        ts.isArrayTypeNode(node.type)) ||
      (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) &&
        (node.typeName.text === "Array" ||
          node.typeName.text === "ReadonlyArray"));
    // Fall back to the checker for type aliases that resolve to arrays
    // (but not tuples or numeric-indexed objects, which have different
    // schema semantics).
    if (!isArray && checker && ts.isTypeReferenceNode(node)) {
      const resolvedType = getTypeFromTypeNodeWithFallback(
        node,
        checker,
        typeRegistry,
      );
      const tc = checker as ts.TypeChecker & {
        isArrayType?: (t: ts.Type) => boolean;
      };
      isArray = !!tc.isArrayType?.(resolvedType);
    }
    const arrayLikeElementType = ts.isTypeLiteralNode(node)
      ? getArrayLikeTypeLiteralElementType(node, checker)
      : undefined;
    isArray ||= !!arrayLikeElementType;
    if (isArray) {
      const itemPaths = getArrayItemPaths(normalized);
      const fullShapeItemPaths = getArrayItemPaths(normalizedFullShapePaths);
      const allNonItem = normalized.every((path) => isArrayRootOnlyPath(path));
      if (allNonItem) {
        const arrayNode = factory.createArrayTypeNode(
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        );
        if (checker) {
          ensureTypeNodeRegistered(arrayNode, checker, typeRegistry);
        }
        return arrayNode;
      }
      if (itemPaths.length > 0) {
        if (arrayLikeElementType) {
          const shrunkElement = shrinkArrayElementTypeNode(
            arrayLikeElementType,
            itemPaths,
            fullShapeItemPaths,
            factory,
            checker,
            typeRegistry,
            state,
            sourceFile,
          );
          const arrayNode = factory.createArrayTypeNode(shrunkElement);
          if (checker) {
            ensureTypeNodeRegistered(arrayNode, checker, typeRegistry);
          }
          return arrayNode;
        }

        if (ts.isArrayTypeNode(node)) {
          const shrunkElement = shrinkArrayElementTypeNode(
            node.elementType,
            itemPaths,
            fullShapeItemPaths,
            factory,
            checker,
            typeRegistry,
            state,
            sourceFile,
          );
          return factory.updateArrayTypeNode(node, shrunkElement);
        }

        if (
          ts.isTypeOperatorNode(node) &&
          node.operator === ts.SyntaxKind.ReadonlyKeyword &&
          ts.isArrayTypeNode(node.type)
        ) {
          const shrunkElement = shrinkArrayElementTypeNode(
            node.type.elementType,
            itemPaths,
            fullShapeItemPaths,
            factory,
            checker,
            typeRegistry,
            state,
            sourceFile,
          );
          return factory.updateTypeOperatorNode(
            node,
            factory.updateArrayTypeNode(node.type, shrunkElement),
          );
        }

        if (
          ts.isTypeReferenceNode(node) &&
          ts.isIdentifier(node.typeName) &&
          node.typeArguments?.[0] &&
          (node.typeName.text === "Array" ||
            node.typeName.text === "ReadonlyArray")
        ) {
          const [inner] = node.typeArguments;
          const shrunkInner = shrinkArrayElementTypeNode(
            inner,
            itemPaths,
            fullShapeItemPaths,
            factory,
            checker,
            typeRegistry,
            state,
            sourceFile,
          );
          return factory.updateTypeReferenceNode(
            node,
            node.typeName,
            factory.createNodeArray([shrunkInner]),
          );
        }

        if (checker && ts.isTypeReferenceNode(node)) {
          const resolvedType = getTypeFromTypeNodeWithFallback(
            node,
            checker,
            typeRegistry,
          );
          if (isArrayShapeType(resolvedType, checker)) {
            return buildShrunkTypeNodeFromType(
              resolvedType,
              normalized,
              checker,
              sourceFile ?? node.getSourceFile(),
              factory,
              typeRegistry,
              state,
              normalizedFullShapePaths,
            );
          }
        }
      }
      // Item access or other paths we could not materialize — keep full array type.
      return node;
    }
  }

  // Shrink object type literals by filtering to only the accessed members.
  if (ts.isTypeLiteralNode(node)) {
    return shrinkTypeLiteralMembers(
      node.members,
      normalized,
      factory,
      checker,
      typeRegistry,
      state,
      normalizedFullShapePaths,
      sourceFile,
    );
  }

  if (
    ts.isTypeReferenceNode(node) &&
    isCellLikeTypeNode(node) &&
    node.typeArguments &&
    node.typeArguments.length > 0
  ) {
    const [inner, ...rest] = node.typeArguments;
    if (!inner) return undefined;
    const shrunkInner = buildShrunkTypeNodeFromTypeNode(
      inner,
      normalized,
      factory,
      checker,
      typeRegistry,
      state,
      normalizedFullShapePaths,
      sourceFile,
    ) ?? inner;
    return factory.updateTypeReferenceNode(
      node,
      node.typeName,
      factory.createNodeArray([shrunkInner, ...rest]),
    );
  }

  // For non-Cell-like TypeReferences (type aliases, interfaces), resolve the
  // declaration and shrink its members directly.  This preserves source-level
  // TypeNodes (e.g. Date, string-literal unions) that would be lost by the
  // type-driven fallback.
  if (ts.isTypeReferenceNode(node) && checker) {
    const members = resolveTypeReferenceMembers(node, checker, typeRegistry);
    if (members) {
      const shrunk = shrinkTypeLiteralMembers(
        members,
        normalized,
        factory,
        checker,
        typeRegistry,
        state,
        normalizedFullShapePaths,
        sourceFile,
      );
      if (!shrunk) return undefined;
      // If the shrunk type is identical to the original declaration (same
      // member count and no nested changes), keep the original TypeReference
      // to preserve $ref/$defs in schema generation.
      if (isUnchangedShrink(members, shrunk)) {
        return node;
      }
      return shrunk;
    }
    // Could not resolve to concrete members — let the caller fall back.
    return undefined;
  }

  if (ts.isUnionTypeNode(node)) {
    const nullish: ts.TypeNode[] = [];
    const nonNullish: ts.TypeNode[] = [];
    for (const member of node.types) {
      (isNullishTypeNode(member) ? nullish : nonNullish).push(member);
    }
    if (nonNullish.length === 0) return node;

    let changed = false;
    const shrunkMembers = nonNullish.map((member) => {
      const s = buildShrunkTypeNodeFromTypeNode(
        member,
        normalized,
        factory,
        checker,
        typeRegistry,
        state,
        normalizedFullShapePaths,
        sourceFile,
      );
      if (s && s !== member) {
        changed = true;
        return s;
      }
      return member;
    });
    if (!changed) return node;

    const all = [...shrunkMembers, ...nullish];
    if (all.length === 1) {
      return all[0];
    }
    const unionNode = factory.createUnionTypeNode(all);
    if (checker) {
      ensureTypeNodeRegistered(unionNode, checker, typeRegistry);
    }
    return unionNode;
  }

  return node;
}

/**
 * Resolves a TypeReference to its declaration members (PropertySignatures).
 * Works for type aliases with TypeLiteral bodies and interface declarations.
 */
function resolveTypeReferenceMembers(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): readonly ts.TypeElement[] | undefined {
  const type = getTypeFromTypeNodeWithFallback(node, checker, typeRegistry);
  return resolveDeclaredObjectMembers(type, checker, typeRegistry);
}

function resolveDeclaredObjectMembers(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): readonly ts.TypeElement[] | undefined {
  return resolveDeclaredObjectMembersWithSeen(
    type,
    checker,
    typeRegistry,
    new Set<ts.Declaration>(),
  );
}

function resolveDeclaredObjectMembersWithSeen(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  seen: Set<ts.Declaration>,
): readonly ts.TypeElement[] | undefined {
  const symbol = type.aliasSymbol ?? type.symbol;
  if (!symbol?.declarations?.length) return undefined;

  const resolvedMembers: ts.TypeElement[][] = [];
  for (const decl of symbol.declarations) {
    const members = resolveMembersFromDeclaration(
      decl,
      checker,
      typeRegistry,
      seen,
    );
    if (members && members.length > 0) {
      resolvedMembers.push([...members]);
    }
  }

  if (resolvedMembers.length === 0) {
    return undefined;
  }

  return mergeResolvedMembers(resolvedMembers, checker);
}

function resolveMembersFromDeclaration(
  decl: ts.Declaration,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  seen: Set<ts.Declaration>,
): readonly ts.TypeElement[] | undefined {
  if (seen.has(decl)) {
    return undefined;
  }
  seen.add(decl);

  // A generic declaration's members are written in terms of its parameters,
  // which say nothing of the arguments an instantiation binds them to.
  if (
    (ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl)) &&
    decl.typeParameters?.length
  ) {
    return undefined;
  }

  if (ts.isTypeAliasDeclaration(decl) && ts.isTypeLiteralNode(decl.type)) {
    return decl.type.members;
  }

  if (!ts.isInterfaceDeclaration(decl)) {
    return undefined;
  }

  const inheritedMembers: ts.TypeElement[][] = [];
  for (const clause of decl.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }

    for (const heritageType of clause.types) {
      const inheritedType = getTypeFromTypeNodeWithFallback(
        heritageType,
        checker,
        typeRegistry,
      );
      const members = resolveDeclaredObjectMembersWithSeen(
        inheritedType,
        checker,
        typeRegistry,
        seen,
      );
      if (members && members.length > 0) {
        inheritedMembers.push([...members]);
      }
    }
  }

  return mergeResolvedMembers(
    [...inheritedMembers, [...decl.members]],
    checker,
  );
}

function mergeResolvedMembers(
  memberSets: readonly (readonly ts.TypeElement[])[],
  checker: ts.TypeChecker,
): readonly ts.TypeElement[] {
  const merged: ts.TypeElement[] = [];
  const propertyIndexes = new Map<string, number>();

  for (const members of memberSets) {
    for (const member of members) {
      if (ts.isPropertySignature(member) && member.name) {
        const name = getRequestedPropertyNameText(member.name, checker);
        if (name) {
          const existingIndex = propertyIndexes.get(name);
          if (existingIndex !== undefined) {
            merged[existingIndex] = member;
            continue;
          }
          propertyIndexes.set(name, merged.length);
        }
      }

      merged.push(member);
    }
  }

  return merged;
}

/**
 * Returns true when the shrunk TypeLiteral is structurally identical to the
 * original declaration members — same member count, same member names, and
 * each member's type node is the original (not a newly created node).
 */
function isUnchangedShrink(
  originalMembers: readonly ts.TypeElement[],
  shrunk: ts.TypeNode,
): boolean {
  if (!ts.isTypeLiteralNode(shrunk)) return false;
  const origProps = originalMembers.filter(
    (m): m is ts.PropertySignature =>
      ts.isPropertySignature(m) && !!m.name && !!m.type,
  );
  if (shrunk.members.length !== origProps.length) return false;
  // Check each shrunk member's type is the exact same node object as the
  // original — if any type was recreated by recursive shrinking, the node
  // identity will differ.
  for (const member of shrunk.members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) {
      return false;
    }
    const name = getPropertyNameText(member.name);
    if (!name) return false;
    const orig = origProps.find(
      (p) => getPropertyNameText(p.name) === name,
    );
    if (!orig) return false;
    if (member.type !== orig.type) return false;
  }
  return true;
}

/**
 * Shared logic: filters a list of type members to only the accessed property
 * heads and recursively shrinks child types.
 */
function shrinkTypeLiteralMembers(
  members: readonly ts.TypeElement[],
  normalizedPaths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  state?: CrossStageState,
  fullShapePaths: readonly (readonly string[])[] = [],
  sourceFile?: ts.SourceFile,
): ts.TypeNode | undefined {
  const grouped = groupPathsByHead(normalizedPaths);
  const fullShapeGrouped = groupPathsByHead(fullShapePaths);
  const result: ts.TypeElement[] = [];

  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) {
      continue;
    }

    const propertyName = getRequestedPropertyNameText(member.name, checker);
    if (!propertyName) continue;
    const childPaths = grouped.get(propertyName);
    if (!childPaths) continue;

    const shrunkChild = buildShrunkTypeNodeFromTypeNode(
      member.type,
      childPaths,
      factory,
      checker,
      typeRegistry,
      state,
      fullShapeGrouped.get(propertyName) ?? [],
      sourceFile,
    ) ?? member.type;

    result.push(
      factory.updatePropertySignature(
        member,
        member.modifiers,
        member.name,
        member.questionToken ??
          (typeNodeIncludesUndefined(shrunkChild)
            ? factory.createToken(ts.SyntaxKind.QuestionToken)
            : undefined),
        shrunkChild,
      ),
    );
  }

  if (result.length === 0) {
    return undefined;
  }
  return checker
    ? createRegisteredTypeLiteral(result, { factory, checker, typeRegistry })
    : factory.createTypeLiteralNode(result);
}

//
// Validation
//

/** Node-level check: does this TypeNode have a member named `head`? */
function typeNodeHasHead(
  node: ts.TypeNode,
  head: string,
  checker: ts.TypeChecker,
): boolean {
  if (typeNodeIsArrayShape(node, checker)) {
    return isNumericPathSegment(head) || isArrayRootOnlyPath([head]);
  }

  if (ts.isTypeLiteralNode(node)) {
    return node.members.some(
      (m) =>
        ts.isPropertySignature(m) && m.name &&
        getRequestedPropertyNameText(m.name, checker) === head,
    );
  }

  if (ts.isUnionTypeNode(node)) {
    // Valid if ANY non-nullish constituent has it
    return node.types.some(
      (m) => !isNullishTypeNode(m) && typeNodeHasHead(m, head, checker),
    );
  }

  if (ts.isTypeReferenceNode(node)) {
    const members = resolveTypeReferenceMembers(node, checker);
    if (members) {
      return members.some(
        (m) =>
          ts.isPropertySignature(m) && m.name &&
          getRequestedPropertyNameText(m.name, checker) === head,
      );
    }
  }

  return false;
}

/** Type-level check: does this ts.Type have a property named `head`? */
function typeHasHead(
  type: ts.Type,
  head: string,
  checker: ts.TypeChecker,
): boolean {
  // Direct property lookup (works for simple object types)
  if (findPropertySymbol(type, head, checker)) return true;

  // For unions, check each non-primitive constituent individually
  // (getProperty on a union uses intersection semantics)
  if (type.isUnion()) {
    for (const constituent of type.types) {
      if (constituent.getProperty(head)) return true;
    }
  }

  // Numeric heads are valid on array-like types (index access)
  if (Number.isFinite(Number(head))) {
    if (isNumericIndexableType(type, checker)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether `head` can resolve as a property on the given type.
 * Tries the shrunk TypeNode first, then baseTypeNode, then the resolved
 * ts.Type. Handles unions (any non-nullish constituent), TypeReferences
 * (resolved declarations), and arrays (numeric index heads).
 */
function typeHasProperty(
  head: string,
  shrunk: ts.TypeNode | undefined,
  baseTypeNode: ts.TypeNode,
  baseType: ts.Type | undefined,
  checker: ts.TypeChecker,
): boolean {
  // 1. Check the shrunk node (if available)
  if (shrunk && typeNodeHasHead(shrunk, head, checker)) return true;

  // 2. Check the base type node
  if (typeNodeHasHead(baseTypeNode, head, checker)) return true;

  // 3. Fall back to the resolved semantic type (handles aliases, generics,
  //    mapped types, and other forms that aren't visible at the node level).
  if (baseType) {
    const nonNullable = checker.getNonNullableType(baseType);
    if (typeHasHead(nonNullable, head, checker)) return true;
  }

  return false;
}

function getArrayElementTypeNode(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode | undefined {
  if (!node) return undefined;

  const current = unwrapTypeParentheses(node);

  if (ts.isUnionTypeNode(current)) {
    for (const member of current.types) {
      if (isNullishTypeNode(member)) continue;
      const elementNode = getArrayElementTypeNode(
        member,
        checker,
        sourceFile,
        typeRegistry,
      );
      if (elementNode) {
        return elementNode;
      }
    }
    return undefined;
  }

  if (ts.isArrayTypeNode(current)) {
    return current.elementType;
  }

  if (
    ts.isTypeOperatorNode(current) &&
    current.operator === ts.SyntaxKind.ReadonlyKeyword &&
    ts.isArrayTypeNode(current.type)
  ) {
    return current.type.elementType;
  }

  if (
    ts.isTypeReferenceNode(current) &&
    ts.isIdentifier(current.typeName) &&
    current.typeArguments?.[0] &&
    (current.typeName.text === "Array" ||
      current.typeName.text === "ReadonlyArray")
  ) {
    return current.typeArguments[0];
  }

  if (ts.isTypeLiteralNode(current)) {
    return getArrayLikeTypeLiteralElementType(current, checker);
  }

  const resolvedType = getTypeFromTypeNodeWithFallback(
    current,
    checker,
    typeRegistry,
  );
  if (!isArrayShapeType(resolvedType, checker)) {
    return undefined;
  }

  const elementType = getArrayElementType(resolvedType, checker);
  if (!elementType) {
    return undefined;
  }

  const typeToNodeFlags = ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback;
  const elementNode = checker.typeToTypeNode(
    elementType,
    sourceFile,
    typeToNodeFlags,
  );
  if (elementNode) {
    ensureTypeNodeRegistered(elementNode, checker, typeRegistry);
  }
  return elementNode;
}

/**
 * After shrinking, validates that the requested property paths were actually
 * materialized. Reports a diagnostic when the base type is too narrow or
 * `unknown`/`any` and property accesses cannot resolve.
 */
export function validateShrinkCoverage(
  paramSummary: CapabilityParamSummary,
  baseTypeNode: ts.TypeNode,
  baseType: ts.Type | undefined,
  paths: readonly (readonly string[])[],
  shrunk: ts.TypeNode | undefined,
  context: TransformationContext,
  fnNode: ts.Node,
  checker: ts.TypeChecker,
): void {
  if (paths.length === 0 && !paramSummary.wildcard) return;

  // For wildcard parameters with no explicit property paths, check if
  // the base type is `unknown` — passing an unknown-typed value to an
  // opaque function (like console.log) will not produce useful data at
  // runtime because the schema cannot express what to fetch.
  if (paramSummary.wildcard) {
    if (paramSummary.name.startsWith("__")) return;
    const isUnknownBase = baseTypeNode.kind === ts.SyntaxKind.UnknownKeyword ||
      (baseType !== undefined &&
        (baseType.flags & ts.TypeFlags.Unknown) !== 0);
    if (isUnknownBase) {
      context.reportDiagnostic({
        severity: "error",
        type: "schema:unknown-type-access",
        message:
          `Parameter '${paramSummary.name}' is typed as 'unknown' but is ` +
          `passed to a function the compiler cannot analyze. The generated ` +
          `schema cannot express what data to fetch. Replace 'unknown' with ` +
          `a concrete type that describes the expected shape.`,
        node: fnNode,
      });
    }
    return; // wildcard params still skip path-level validation
  }

  // Skip validation for synthetic parameters injected by the transformer
  // pipeline (e.g. ClosureTransformer's __cf_ parameters or __param indices).
  // These are internal implementation details, not user-authored types.
  if (paramSummary.name.startsWith("__")) return;

  const nonNullableBaseType = baseType
    ? checker.getNonNullableType(baseType)
    : undefined;

  const topLevelHeads = getTopLevelRequestedHeads(paths);
  if (
    shrunk &&
    typeNodeIsArrayShape(shrunk, checker) &&
    [...topLevelHeads].every(isArrayCompatibleRequestedHead)
  ) {
    const arrayItemPaths = getArrayItemPaths(paths);
    if (arrayItemPaths.length > 0) {
      const elementType =
        nonNullableBaseType && isArrayShapeType(nonNullableBaseType, checker)
          ? getArrayElementType(nonNullableBaseType, checker)
          : undefined;
      const elementTypeNode = getArrayElementTypeNode(
        shrunk,
        checker,
        context.sourceFile,
        context.state.typeRegistry,
      ) ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

      validateShrinkCoverage(
        paramSummary,
        elementTypeNode,
        elementType,
        arrayItemPaths,
        elementTypeNode,
        context,
        fnNode,
        checker,
      );
    }
    return;
  }

  if (nonNullableBaseType && isArrayShapeType(nonNullableBaseType, checker)) {
    const arrayRootPaths = uniquePaths(
      paths.filter((path) => isArrayRootOnlyPath(path)),
    );
    const arrayItemPaths = getArrayItemPaths(paths);

    if (arrayItemPaths.length > 0) {
      const elementType = getArrayElementType(nonNullableBaseType, checker);
      const elementTypeNode = getArrayElementTypeNode(
        baseTypeNode,
        checker,
        context.sourceFile,
        context.state.typeRegistry,
      ) ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      const shrunkElementNode = getArrayElementTypeNode(
        shrunk,
        checker,
        context.sourceFile,
        context.state.typeRegistry,
      );

      validateShrinkCoverage(
        paramSummary,
        elementTypeNode,
        elementType,
        arrayItemPaths,
        shrunkElementNode,
        context,
        fnNode,
        checker,
      );
    }

    if (arrayRootPaths.length === 0) {
      return;
    }

    paths = arrayRootPaths;
  }

  // Collect requested top-level property names. Synthetic callback lowering can
  // introduce helper reads like `.key("foo")`; ignore those when the base type
  // does not actually define a `key` property.
  const requestedHeads = new Set<string>();
  for (const p of paths) {
    const head = p[0];
    if (!head) {
      continue;
    }
    if (
      head === "key" &&
      !typeHasProperty(head, shrunk, baseTypeNode, baseType, checker)
    ) {
      continue;
    }
    requestedHeads.add(head);
  }
  if (requestedHeads.size === 0) return;

  // Skip validation for `never` — it is a bottom type where property access
  // is vacuously valid. This avoids false positives on synthetic parameters
  // injected by earlier transformers (e.g. ClosureTransformer).
  if (
    baseTypeNode.kind === ts.SyntaxKind.NeverKeyword ||
    (baseType !== undefined && (baseType.flags & ts.TypeFlags.Never) !== 0)
  ) {
    return;
  }

  // Skip validation for `any` — it is a top type where all property accesses
  // are valid. The runtime fetches all data for `any`-typed parameters, so
  // every key is reachable. This differs from `unknown` which cannot express
  // what to fetch.
  if (
    baseTypeNode.kind === ts.SyntaxKind.AnyKeyword ||
    (baseType !== undefined && (baseType.flags & ts.TypeFlags.Any) !== 0)
  ) {
    return;
  }

  // Case 1: unknown base type — every path is unresolvable
  const isUnknownBase = baseTypeNode.kind === ts.SyntaxKind.UnknownKeyword ||
    (baseType !== undefined &&
      (baseType.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !==
        0);

  if (isUnknownBase) {
    const pathList = [...requestedHeads].map((h) => `'.${h}'`).join(", ");
    context.reportDiagnostic({
      severity: "error",
      type: "schema:unknown-type-access",
      message:
        `Parameter '${paramSummary.name}' is typed as 'unknown' but the ` +
        `code accesses ${pathList}. The type must declare all properties ` +
        `the code may read. Replace 'unknown' with a concrete type that ` +
        `includes these properties.`,
      node: fnNode,
    });
    return;
  }

  // Case 2: concrete type but some accessed properties are typed `unknown`.
  // This catches interfaces like `{ amounts?: unknown }` where the property
  // exists but its type is `unknown`, meaning the runtime schema will contain
  // `{ type: "unknown" }` and the runtime will hand back an opaque reference
  // carrying none of the value's properties.
  if (nonNullableBaseType) {
    const unknownProps: string[] = [];
    for (const head of requestedHeads) {
      const prop = nonNullableBaseType.getProperty(head) ??
        (nonNullableBaseType.isUnion()
          ? nonNullableBaseType.types.find((t) => t.getProperty(head))
            ?.getProperty(
              head,
            )
          : undefined);
      if (!prop) continue;
      const propType = checker.getTypeOfSymbol(prop);
      // Check the raw property type for `unknown`. Note: we check propType
      // directly rather than after getNonNullableType because TS maps
      // getNonNullableType(unknown) to Object, losing the unknown flag.
      // For optional props (`foo?: unknown`), the type is still `unknown`
      // since `unknown | undefined` collapses to `unknown`.
      if ((propType.flags & ts.TypeFlags.Unknown) !== 0) {
        unknownProps.push(head);
      }
    }
    if (unknownProps.length > 0) {
      const propList = unknownProps.map((h) => `'.${h}'`).join(", ");
      context.reportDiagnostic({
        severity: "error",
        type: "schema:unknown-type-access",
        message: `Parameter '${paramSummary.name}' has ` +
          `${unknownProps.length === 1 ? "property" : "properties"} ` +
          `${propList} typed as 'unknown'. The generated schema cannot ` +
          `express what data to fetch for unknown-typed properties. ` +
          `Replace 'unknown' with a concrete type that describes the ` +
          `expected shape.`,
        node: fnNode,
      });
      return;
    }
  }

  // Case 3: concrete type but some paths didn't resolve.
  const missing = [...requestedHeads].filter(
    (h) => !typeHasProperty(h, shrunk, baseTypeNode, baseType, checker),
  );
  if (missing.length === 0) return;

  const missingList = missing.map((h) => `'.${h}'`).join(", ");
  const typeText = printTypeNode(baseTypeNode, context.sourceFile);
  context.reportDiagnostic({
    severity: "error",
    type: "schema:path-not-in-type",
    message: `Parameter '${paramSummary.name}' accesses ${missingList} but ` +
      `type '${typeText}' does not include ` +
      `${missing.length === 1 ? "it" : "them"}. Add the missing ` +
      `${missing.length === 1 ? "property" : "properties"} to the type.`,
    node: fnNode,
  });
}

//
// Wrapping and defaults
//

//
// Contract-mode capability overlay
//

/** A serialized path key with numeric segments normalized to `*`, so an
 * element access observed at one index matches the element position. */
function contractPathKey(segments: readonly string[]): string {
  return segments.map((segment) => /^\d+$/.test(segment) ? "*" : segment)
    .join("\x00");
}

function addPrefixKeys(
  target: Set<string>,
  paths: readonly (readonly string[])[] | undefined,
): void {
  for (const path of paths ?? []) {
    for (let i = 1; i <= path.length; i++) {
      target.add(contractPathKey(path.slice(0, i)));
    }
  }
}

/** Whether any data position in `type`'s subtree is cell-like — the test for
 * whether a named reference must be expanded to overlay capabilities inside
 * it. Cycles end the search: a cell beyond a self-reference is not found,
 * which the caller documents as the accepted residual. */
function typeSubtreeContainsCellLike(
  type: ts.Type,
  checker: ts.TypeChecker,
  visited: Set<ts.Type>,
): boolean {
  if (visited.has(type)) return false;
  visited.add(type);
  if (isCellLikeType(type, checker)) {
    // A stream or sqlite brand is authoritative and never rewritten, so it
    // is not a reason to expand the reference that holds it — every piece
    // output type carries its verb streams, and expanding those would trade
    // a named `$defs` identity for an anonymous literal.
    const kind = getCellKind(type, checker);
    return kind !== "stream" && kind !== "sqlite";
  }
  if ((type.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)) !== 0) {
    return (type as ts.UnionOrIntersectionType).types.some((member) =>
      typeSubtreeContainsCellLike(member, checker, visited)
    );
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (isArrayShapeType(type, checker)) {
    const element = getArrayElementType(type, checker);
    return !!element && typeSubtreeContainsCellLike(element, checker, visited);
  }
  for (const property of checker.getPropertiesOfType(type)) {
    if ((property.flags & ts.SymbolFlags.Method) !== 0) continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      declaration,
    );
    if (typeSubtreeContainsCellLike(propertyType, checker, visited)) {
      return true;
    }
  }
  return false;
}

/** The observation record the contract overlay consults, built once per
 * event from the capability summary's path channels. */
interface ContractObservation {
  readonly write: ReadonlySet<string>;
  readonly read: ReadonlySet<string>;
  readonly comparable: ReadonlySet<string>;

  /** Exact positions whose observed use needs an identity handle even when
   * the authored type is plain — `equals`-style comparison materializes
   * through a comparable cell, not through the value. */
  readonly exactComparableCell: ReadonlySet<string>;
}

function contractObservationFrom(
  summary: CapabilityParamSummary,
): ContractObservation {
  const write = new Set<string>();
  const read = new Set<string>();
  const comparable = new Set<string>();
  addPrefixKeys(write, summary.writePaths);
  addPrefixKeys(read, summary.readPaths);
  addPrefixKeys(read, summary.fullShapePaths);
  addPrefixKeys(read, summary.opaquePaths);
  addPrefixKeys(comparable, summary.comparablePaths);
  addPrefixKeys(comparable, summary.comparableCellPaths);
  addPrefixKeys(comparable, summary.identityPaths);
  addPrefixKeys(comparable, summary.identityCellPaths);
  const exactComparableCell = new Set<string>();
  for (const path of summary.comparableCellPaths ?? []) {
    exactComparableCell.add(contractPathKey(path));
  }
  for (const path of summary.identityCellPaths ?? []) {
    exactComparableCell.add(contractPathKey(path));
  }
  return { write, read, comparable, exactComparableCell };
}

function contractCapabilityAt(
  observation: ContractObservation,
  path: readonly string[],
): ReactiveCapability {
  const key = contractPathKey(path);
  if (observation.write.has(key)) return "writable";
  if (observation.read.has(key)) return "readonly";
  if (observation.comparable.has(key)) return "comparable";
  return "opaque";
}

/**
 * The contract half of docs/history/plans/verb-input-contract.md, applied to a verb's
 * event: the authored TypeNode is served VERBATIM in structure — objects,
 * unions, intersections, arrays, and primitives alike — and only cell-like
 * positions are rewritten, to the capability the body's usage earns:
 * writable where it writes, read-only where it reads, comparable where it
 * only compares, and OPAQUE where it never touches the position, so a
 * declared-but-unread reference confers no exercised authority while the
 * contract still names it.
 *
 * A reference to a type alias is walked as the node the alias names
 * (`readAuthoredTypeNode()`), so a cell declared through an alias is rewritten
 * as the wrapper the alias names. The reference stays as written where nothing
 * in that node changes, and where the alias recurs through its own type.
 * A cell-like position is one whose node names a `commonfabric` cell wrapper
 * (`namesCellWrapper()`), not merely one spelled like it.
 *
 * A named reference whose subtree holds no cell-like position passes through
 * untouched, keeping its `$defs` identity and its prose. One expands only
 * when a capability inside it must change, and a self-referential type ends
 * that expansion at the cycle with the node kept as authored — the accepted
 * residual, since a literal cannot spell its own recursion.
 */
export function overlayContractCapabilities(
  node: ts.TypeNode,
  type: ts.Type | undefined,
  summary: CapabilityParamSummary,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  state?: CrossStageState,
): ts.TypeNode {
  const observation = contractObservationFrom(summary);
  const visiting = new Set<ts.Type>();
  const expanding = new Set<ts.TypeNode>();

  const walk = (
    current: ts.TypeNode,
    currentType: ts.Type | undefined,
    path: readonly string[],
  ): ts.TypeNode => {
    if (ts.isParenthesizedTypeNode(current)) {
      const inner = walk(current.type, currentType, path);
      return inner === current.type
        ? current
        : factory.createParenthesizedType(inner);
    }

    const authored = readAuthoredTypeNode(current, checker);
    if (authored !== current) {
      if (expanding.has(authored)) return current;
      expanding.add(authored);
      try {
        const walked = walk(authored, currentType, path);
        return walked === authored ? current : walked;
      } finally {
        expanding.delete(authored);
      }
    }

    if (
      !namesCellWrapper(current, checker) &&
      observation.exactComparableCell.has(contractPathKey(path))
    ) {
      // Identity-only use of a plain-declared position: the authored
      // structure serves, and the observed comparison adds the identity
      // handle the runtime materializes it through.
      return wrapTypeNodeWithCapability(current, "comparable", factory);
    }

    if (namesCellWrapper(current, checker)) {
      if (preservedWrapperFor(current, currentType, checker)) return current;
      const innerNode = current.typeArguments?.[0];
      if (!innerNode) return current;
      // The wrapper's capability is this position's to overlay; the target's
      // own schema is not — a referenced value serves as authored, `$defs`
      // identity intact, and its interior is governed at its own reads.
      return wrapTypeNodeWithCapability(
        innerNode,
        contractCapabilityAt(observation, path),
        factory,
      );
    }

    if (ts.isTypeLiteralNode(current)) {
      let changed = false;
      const members = current.members.map((member) => {
        if (!ts.isPropertySignature(member) || !member.type) return member;
        const name = getPropertyNameText(member.name);
        if (name === undefined) return member;
        const memberSymbol = currentType
          ? checker.getPropertyOfType(currentType, name)
          : undefined;
        const memberType = memberSymbol
          ? checker.getTypeOfSymbolAtLocation(
            memberSymbol,
            memberSymbol.valueDeclaration ?? member,
          )
          : undefined;
        const walked = walk(member.type, memberType, [...path, name]);
        if (walked === member.type) return member;
        changed = true;
        return factory.updatePropertySignature(
          member,
          member.modifiers,
          member.name,
          member.questionToken,
          walked,
        );
      });
      return changed ? factory.createTypeLiteralNode(members) : current;
    }

    if (ts.isArrayTypeNode(current)) {
      const elementType = currentType
        ? getArrayElementType(currentType, checker)
        : undefined;
      const walked = walk(current.elementType, elementType, [...path, "*"]);
      return walked === current.elementType
        ? current
        : factory.createArrayTypeNode(walked);
    }

    if (ts.isUnionTypeNode(current) || ts.isIntersectionTypeNode(current)) {
      let changed = false;
      const constituents = current.types.map((member) => {
        const memberType = getTypeFromTypeNodeWithFallback(
          member,
          checker,
          typeRegistry,
        );
        const walked = walk(member, memberType, path);
        if (walked !== member) changed = true;
        return walked;
      });
      if (!changed) return current;
      return ts.isUnionTypeNode(current)
        ? factory.createUnionTypeNode(constituents)
        : factory.createIntersectionTypeNode(constituents);
    }

    if (ts.isTypeReferenceNode(current)) {
      const referenceName = ts.isIdentifier(current.typeName)
        ? current.typeName.text
        : undefined;
      if (
        (referenceName === "Array" || referenceName === "ReadonlyArray") &&
        current.typeArguments?.length === 1
      ) {
        const elementType = currentType
          ? getArrayElementType(currentType, checker)
          : undefined;
        const walked = walk(
          current.typeArguments[0]!,
          elementType,
          [...path, "*"],
        );
        return walked === current.typeArguments[0]
          ? current
          : factory.createTypeReferenceNode(current.typeName, [walked]);
      }
      const resolvedType = currentType ??
        getTypeFromTypeNodeWithFallback(current, checker, typeRegistry);
      if (!resolvedType) return current;
      if (visiting.has(resolvedType)) return current;
      if (
        !typeSubtreeContainsCellLike(resolvedType, checker, new Set())
      ) {
        return current;
      }
      visiting.add(resolvedType);
      try {
        const members: ts.TypeElement[] = [];
        for (const property of checker.getPropertiesOfType(resolvedType)) {
          if ((property.flags & ts.SymbolFlags.Method) !== 0) continue;
          const declaration = property.declarations?.find(
            ts.isPropertySignature,
          );
          const declaredNode = declaration?.type;
          const propertyType = checker.getTypeOfSymbolAtLocation(
            property,
            declaration ?? current,
          );
          const memberNode = declaredNode ??
            typeToTypeNodeWithRegistry(
              propertyType,
              { checker, factory, sourceFile, state },
              typeRegistry,
            );
          if (!memberNode) continue;
          members.push(factory.createPropertySignature(
            undefined,
            createPropertyName(property.getName(), factory),
            declaration?.questionToken !== undefined
              ? factory.createToken(ts.SyntaxKind.QuestionToken)
              : undefined,
            walk(memberNode, propertyType, [...path, property.getName()]),
          ));
        }
        return factory.createTypeLiteralNode(members);
      } finally {
        visiting.delete(resolvedType);
      }
    }

    return current;
  };

  return walk(node, type, []);
}

export function wrapTypeNodeWithCapability(
  node: ts.TypeNode,
  capability: ReactiveCapability,
  factory: ts.NodeFactory,
): ts.TypeNode {
  const wrapperName = capability === "readonly"
    ? "ReadonlyCell"
    : capability === "comparable"
    ? "ComparableCell"
    : capability === "writeonly"
    ? "WriteonlyCell"
    : capability === "writable"
    ? "Writable"
    : "OpaqueCell";

  return createHelperWrapperTypeNode(node, wrapperName, factory);
}

/** Cell wrappers whose explicit brand is authoritative and must survive
 *  capability shrinking instead of being replaced by an inferred read/write
 *  capability wrapper. `Stream` (a callable interface) and `SqliteDb` (a handle
 *  with a read-only method surface that would otherwise collapse to `readonly`)
 *  both fall here; the emitted `__cfHelpers.<name>` node is recognized by the
 *  schema generator and lowered to the matching `asCell` brand. */
export type PreservedWrapper = "Stream" | "SqliteDb";

export function preservedWrapperFor(
  node: ts.TypeNode,
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): PreservedWrapper | undefined {
  if (isStreamTypeNode(node) || isStreamCellType(type, checker)) {
    return "Stream";
  }
  if (isSqliteTypeNode(node) || isSqliteCellType(type, checker)) {
    return "SqliteDb";
  }
  return undefined;
}

function wrapTypeNodeWithCapabilityOrStream(
  node: ts.TypeNode,
  capability: ReactiveCapability,
  factory: ts.NodeFactory,
  preservedWrapper: PreservedWrapper | undefined,
): ts.TypeNode {
  return preservedWrapper
    ? createHelperWrapperTypeNode(node, preservedWrapper, factory)
    : wrapTypeNodeWithCapability(node, capability, factory);
}

function createHelperWrapperTypeNode(
  node: ts.TypeNode,
  wrapperName: string,
  factory: ts.NodeFactory,
  rest: readonly ts.TypeNode[] = [],
): ts.TypeNode {
  return factory.createTypeReferenceNode(
    factory.createQualifiedName(
      factory.createIdentifier("__cfHelpers"),
      factory.createIdentifier(wrapperName),
    ),
    [node, ...rest],
  );
}

/**
 * Returns the value type node of the cell wrapper that `node` names, as its
 * author wrote it, or `undefined` when `node` names none. The wrapper is read
 * through parentheses and type aliases (`readAuthoredTypeNode()`), and counts
 * only where it is `commonfabric`'s (`namesCellWrapper()`), so
 * `c: TheCell`, with `type TheCell = Writable<T | Default<V>>`, yields the
 * same `T | Default<V>` as `c: Writable<T | Default<V>>`.
 *
 * The node returned belongs to the declaration it is written in, which for a
 * cell declared through an alias may be in another module. Schema generation
 * reads it there through the checker; a caller that prints it into another
 * module clones it first (`cloneTypeNodeDeepForEmission()`).
 */
export function getAuthoredCellValueTypeNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const authored = readAuthoredTypeNode(node, checker);
  return namesCellWrapper(authored, checker)
    ? authored.typeArguments?.[0]
    : undefined;
}

interface CellCapabilityPath {
  readonly path: readonly string[];
  readonly capability: ReactiveCapability;
}

/**
 * Helper for `applyCellCapabilityPathsToTypeNode()`, which returns the value
 * type node of the cell a property's type node holds, or of each cell in a
 * nullable union of cells: as its author wrote it where the wrapper is written
 * out (`getAuthoredCellValueTypeNode()`), and printed from the cell's type
 * otherwise. Returns `undefined` for a node that holds no cell.
 */
function extractCellLikeInnerTypeNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  state: CrossStageState | undefined,
): ts.TypeNode | undefined {
  // A printed node is not taken apart: its value is printed from its type.
  const printedType = state?.printedFrom(node);
  if (printedType) {
    return printedCellValueTypeNode(
      printedType,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      state,
    );
  }

  // A nullable cell handle keeps its value alternatives inside the inferred
  // capability wrapper. Read the narrowed syntax before consulting cached types.
  if (ts.isUnionTypeNode(node)) {
    const members: ts.TypeNode[] = [];
    const nullish: ts.TypeNode[] = [];
    const values: { node: ts.TypeNode; type: ts.Type | undefined }[] = [];
    let hasCell = false;
    for (const member of node.types) {
      if (isNullishTypeNode(member)) {
        members.push(member);
        nullish.push(member);
        continue;
      }
      const memberType = getTypeFromTypeNodeWithFallback(
        member,
        checker,
        typeRegistry,
      );
      if (preservedWrapperFor(member, memberType, checker)) return undefined;
      const inner = extractCellLikeInnerTypeNode(
        member,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        state,
      );
      if (!inner) return undefined;
      hasCell = true;
      members.push(inner);
      values.push({
        node: inner,
        type: memberType && isCellLikeType(memberType, checker)
          ? unwrapCellLikeType(memberType, checker)
          : undefined,
      });
    }
    const scoped = values.length === 1 && nullish.length > 0
      ? moveNullishIntoScopeWrapper(
        values[0]!.node,
        values[0]!.type,
        nullish,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        state,
      )
      : undefined;
    return hasCell ? scoped ?? factory.createUnionTypeNode(members) : undefined;
  }

  const semanticType = getTypeFromTypeNodeWithFallback(
    node,
    checker,
    typeRegistry,
  );
  const semanticInner = semanticType && isCellLikeType(semanticType, checker)
    ? unwrapCellLikeType(semanticType, checker)
    : undefined;
  const inner = getAuthoredCellValueTypeNode(node, checker);
  if (inner) {
    const innerType = getTypeFromTypeNodeWithFallback(
      inner,
      checker,
      typeRegistry,
    );
    const typeToRegister = semanticInner && !isAnyOrUnknownType(semanticInner)
      ? semanticInner
      : innerType;
    if (typeToRegister) {
      typeRegistry?.set(inner, typeToRegister);
    }
    return inner;
  }
  const innerNode = typeToSchemaTypeNode(
    semanticInner,
    checker,
    sourceFile,
    state,
  );
  if (innerNode && semanticInner) {
    typeRegistry?.set(innerNode, semanticInner);
  }
  return innerNode;
}

/**
 * Helper for `extractCellLikeInnerTypeNode()`, which returns the value of a
 * nullable cell whose value is a scope wrapper as that wrapper around the
 * payload and the nullish alternatives, `PerUser<T | undefined>` for
 * `PerUser<T>` and `undefined`, or `undefined` for a value that is not a scope
 * wrapper. A scope wrapper may not be a union member: its scope would sit in a
 * branch the write path does not read.
 *
 * A wrapper written out is recognized by its name, as schema generation
 * recognizes it, and names its payload. Otherwise the value's type is read,
 * from the cell's type or, for a value node printed from a type, from the type
 * it was printed from, and the payload is printed from the types the scope
 * brand is intersected with, one alternative per member of a union the brand
 * was distributed over.
 */
function moveNullishIntoScopeWrapper(
  value: ts.TypeNode,
  cellValueType: ts.Type | undefined,
  nullish: readonly ts.TypeNode[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  state: CrossStageState | undefined,
): ts.TypeNode | undefined {
  const written = unwrapTypeParentheses(value);
  const name = ts.isTypeReferenceNode(written)
    ? entityNameRight(written.typeName)
    : undefined;

  // A printed node is not taken apart: its scope and payload are read from
  // the type it was printed from.
  const printedType = state?.printedFrom(written);
  const namedScope = !printedType && name && scopeForWrapperName(name.text);
  if (namedScope) {
    const payload = (written as ts.TypeReferenceNode).typeArguments?.[0];
    return payload && wrapInScope([payload], namedScope, nullish, factory);
  }

  const valueType = cellValueType ?? printedType;
  const brand = valueType && getScopeBrand(valueType, checker);
  if (!brand) return undefined;
  const alternatives: ts.TypeNode[] = [];
  for (const alternative of brand.payload) {
    const parts = alternative.map((part) =>
      typeToTypeNodeWithRegistry(
        part,
        { checker, factory, sourceFile, state },
        typeRegistry,
      )
    );
    alternatives.push(
      parts.length === 1
        ? parts[0]!
        : factory.createIntersectionTypeNode(parts),
    );
  }
  return wrapInScope(alternatives, brand.scope, nullish, factory);
}

/** `__cfHelpers.PerUser<A | B | ...nullish>` for the scope `user`. */
function wrapInScope(
  alternatives: readonly ts.TypeNode[],
  scope: SchemaScope,
  nullish: readonly ts.TypeNode[],
  factory: ts.NodeFactory,
): ts.TypeNode {
  return createHelperWrapperTypeNode(
    factory.createUnionTypeNode([...alternatives, ...nullish]),
    SCOPE_WRAPPER_FOR_SCOPE[scope],
    factory,
  );
}

/**
 * Helper for `extractCellLikeInnerTypeNode()`, which returns, for the type a
 * node was printed from, the value type node of the cell it holds, printed
 * from the type arguments its wrapper was given, or, for a nullable union of
 * cells, the union of each cell's value and the nullish alternatives, which a
 * scoped value holds inside its scope wrapper
 * (`moveNullishIntoScopeWrapper()`). Returns `undefined` for a type that holds
 * no cell, and for a nullable union holding a stream or a database.
 */
function printedCellValueTypeNode(
  type: ts.Type,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  state: CrossStageState | undefined,
): ts.TypeNode | undefined {
  const print = (printable: ts.Type) =>
    typeToTypeNodeWithRegistry(
      printable,
      { checker, factory, sourceFile, state },
      typeRegistry,
    );
  if (type.isUnion()) {
    const members: ts.TypeNode[] = [];
    const nullish: ts.TypeNode[] = [];
    const values: { node: ts.TypeNode; type: ts.Type | undefined }[] = [];
    for (const member of type.types) {
      if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) {
        const printed = print(member);
        members.push(printed);
        nullish.push(printed);
        continue;
      }
      if (
        isStreamCellType(member, checker) || isSqliteCellType(member, checker)
      ) {
        return undefined;
      }
      const inner = printedCellValueTypeNode(
        member,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        state,
      );
      if (!inner) return undefined;
      members.push(inner);
      values.push({ node: inner, type: unwrapCellLikeType(member, checker) });
    }
    if (values.length === 0) return undefined;
    // A scoped value holds the nullish alternatives inside its scope wrapper,
    // as for an authored node (`moveNullishIntoScopeWrapper()`).
    const scoped = values.length === 1 && nullish.length > 0
      ? moveNullishIntoScopeWrapper(
        values[0]!.node,
        values[0]!.type,
        nullish,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        state,
      )
      : undefined;
    return scoped ?? factory.createUnionTypeNode(members);
  }
  if (!isCellLikeType(type, checker)) return undefined;
  const [value] = cellTypeArguments(type, checker);
  return value && print(value);
}

/**
 * Helper for `printedCellValueTypeNode()` and `unfoldPrint()`, which
 * returns the type arguments of the cell wrapper `type` instantiates, as the
 * wrapper was given them, so that an alias among them keeps its name:
 * `Cell<EntriesValue>` yields `EntriesValue`, which the cell's value type
 * would expand. A cell-like type with no wrapper reference yields its value
 * type.
 */
function cellTypeArguments(
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly ts.Type[] {
  const typeRef = getCellWrapperInfo(type, checker)?.typeRef;
  const parameters = typeRef?.target.typeParameters?.length;
  if (typeRef && parameters) {
    return checker.getTypeArguments(typeRef).slice(0, parameters);
  }
  const value = unwrapCellLikeType(type, checker);
  return value ? [value] : [];
}

function selectCellPathCapability(
  entries: readonly CellCapabilityPath[],
): ReactiveCapability | undefined {
  let hasRead = false;
  let hasWrite = false;
  let hasOpaque = false;

  for (const entry of entries) {
    if (entry.capability === "writable") {
      hasRead = true;
      hasWrite = true;
    } else if (entry.capability === "readonly") {
      hasRead = true;
    } else if (entry.capability === "writeonly") {
      hasWrite = true;
    } else if (entry.capability === "opaque") {
      hasOpaque = true;
    }
  }

  if (hasRead && hasWrite) return "writable";
  if (hasRead) return "readonly";
  if (hasWrite) return "writeonly";
  if (hasOpaque) return "opaque";
  return undefined;
}

function buildCellCapabilityPaths(
  paramSummary: CapabilityParamSummary,
): readonly CellCapabilityPath[] {
  const byPath = new Map<
    string,
    {
      path: readonly string[];
      read: boolean;
      write: boolean;
      opaque: boolean;
    }
  >();
  const ensure = (path: readonly string[]) => {
    const key = JSON.stringify(path);
    let entry = byPath.get(key);
    if (!entry) {
      entry = {
        path,
        read: false,
        write: false,
        opaque: false,
      };
      byPath.set(key, entry);
    }
    return entry;
  };

  for (const path of paramSummary.opaquePaths ?? []) {
    if (path.length === 0) continue;
    ensure(path).opaque = true;
  }
  for (const path of paramSummary.readPaths) {
    if (path.length === 0) continue;
    ensure(path).read = true;
  }
  for (const path of paramSummary.writePaths) {
    if (path.length === 0) continue;
    ensure(path).write = true;
  }

  return Array.from(byPath.values()).map((entry) => {
    const capability = entry.read && entry.write
      ? "writable"
      : entry.read
      ? "readonly"
      : entry.write
      ? "writeonly"
      : "opaque";
    return { path: entry.path, capability };
  });
}

function groupCellCapabilityPathsByHead(
  entries: readonly CellCapabilityPath[],
): Map<string, CellCapabilityPath[]> {
  const grouped = new Map<string, CellCapabilityPath[]>();
  for (const entry of entries) {
    if (entry.path.length === 0) continue;
    const [head, ...tail] = entry.path;
    if (!head) continue;
    const existing = grouped.get(head);
    const childEntry = { path: tail, capability: entry.capability };
    if (existing) {
      existing.push(childEntry);
    } else {
      grouped.set(head, [childEntry]);
    }
  }
  return grouped;
}

function applyCellCapabilityPathsToTypeNode(
  node: ts.TypeNode,
  paths: readonly CellCapabilityPath[],
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  state?: CrossStageState,
): ts.TypeNode {
  if (paths.length === 0) {
    return node;
  }

  // A printed node is not taken apart: a cell inside a printed literal is
  // narrowed in its unfolding.
  const printedType = state?.printedFrom(node);
  if (printedType) {
    if (!ts.isTypeLiteralNode(node)) return node;
    const unfolded = unfoldPrint(
      node,
      printedType,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      state,
    );
    if (!unfolded) return node;
    const narrowed = applyCellCapabilityPathsToTypeNode(
      unfolded,
      paths,
      factory,
      checker,
      sourceFile,
      typeRegistry,
      state,
    );
    return narrowed === unfolded ? node : narrowed;
  }

  if (ts.isParenthesizedTypeNode(node)) {
    const updated = applyCellCapabilityPathsToTypeNode(
      node.type,
      paths,
      factory,
      checker,
      sourceFile,
      typeRegistry,
      state,
    );
    return updated === node.type
      ? node
      : factory.updateParenthesizedType(node, updated);
  }

  if (!ts.isTypeLiteralNode(node)) {
    return node;
  }

  const grouped = groupCellCapabilityPathsByHead(paths);
  let changed = false;
  const members = node.members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.type || !member.name) {
      return member;
    }
    const propertyName = getRequestedPropertyNameText(member.name, checker);
    if (!propertyName) {
      return member;
    }
    const childPaths = grouped.get(propertyName);
    if (!childPaths) {
      return member;
    }

    let updated = member.type;
    const scopedCell = scopedCellParts(
      updated,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      state,
    );
    const cellNode = scopedCell?.cell ?? updated;
    const memberSemanticType = getTypeFromTypeNodeWithFallback(
      cellNode,
      checker,
      typeRegistry,
    );
    const inner = extractCellLikeInnerTypeNode(
      cellNode,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      state,
    );
    if (inner) {
      const capability = selectCellPathCapability(childPaths);
      if (capability) {
        updated = wrapTypeNodeWithCapabilityOrStream(
          inner,
          capability,
          factory,
          preservedWrapperFor(cellNode, memberSemanticType, checker),
        );
        // A nullable cell's value alternatives are inside the wrapper, which
        // stands for a cell, so it is registered only with a cell's own type.
        if (
          typeRegistry && memberSemanticType &&
          !memberSemanticType.isUnion() &&
          isCellLikeType(memberSemanticType, checker)
        ) {
          typeRegistry.set(updated, memberSemanticType);
        }
        if (scopedCell) {
          updated = wrapScopedCell(
            updated,
            scopedCell.name,
            scopedCell.type,
            factory,
            typeRegistry,
          );
        }
      }
    } else {
      const nested = childPaths.filter((entry) => entry.path.length > 0);
      if (nested.length > 0) {
        updated = applyCellCapabilityPathsToTypeNode(
          updated,
          nested,
          factory,
          checker,
          sourceFile,
          typeRegistry,
          state,
        );
      }
    }

    if (updated === member.type) {
      return member;
    }
    changed = true;
    return factory.updatePropertySignature(
      member,
      member.modifiers,
      member.name,
      member.questionToken,
      updated,
    );
  });

  return changed ? factory.createTypeLiteralNode(members) : node;
}

/**
 * Returns `true` for a node of a kind a pass reading its structure looks
 * inside: a type literal, a union, an array, or a cell reference with a type
 * argument. A print of one of these is read through its unfolding
 * (`unfoldPrint()`), and as a whole where it has none.
 */
function isUnfoldableKind(node: ts.TypeNode): boolean {
  if (
    ts.isTypeLiteralNode(node) || ts.isUnionTypeNode(node) ||
    ts.isArrayTypeNode(node)
  ) {
    return true;
  }
  if (ts.isTypeOperatorNode(node)) {
    return node.operator === ts.SyntaxKind.ReadonlyKeyword &&
      ts.isArrayTypeNode(node.type);
  }
  return ts.isTypeReferenceNode(node) && !!node.typeArguments?.length &&
    isCellLikeTypeNode(node);
}

/**
 * Returns a node standing for `type`, which `node` was printed from, built one
 * level deep: a node of the print's own kind, each type node below it printed
 * from its own type. A pass reading the structure of a print reads its
 * unfolding in its place, so nothing the pass builds holds a piece of the
 * print, and each part it keeps is read by its type. Returns `undefined` for a
 * print whose kind no pass looks inside (`isUnfoldableKind()`), or whose type
 * says something only as a whole: a union with a `Default` brand, or an object
 * with a property keyed by a symbol.
 */
function unfoldPrint(
  node: ts.TypeNode,
  type: ts.Type,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  state: CrossStageState | undefined,
): ts.TypeNode | undefined {
  const print = (printable: ts.Type) =>
    typeToTypeNodeWithRegistry(
      printable,
      { checker, factory, sourceFile, state },
      typeRegistry,
    );
  if (ts.isTypeLiteralNode(node)) {
    return unfoldPrintedObjectType(
      type,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      state,
    );
  }
  if (ts.isUnionTypeNode(node) && type.isUnion()) {
    if (type.types.some((member) => getDefaultMarkerPayload(member, checker))) {
      return undefined;
    }
    return factory.createUnionTypeNode(type.types.map(print));
  }
  const readonlyArray = ts.isTypeOperatorNode(node) &&
    node.operator === ts.SyntaxKind.ReadonlyKeyword &&
    ts.isArrayTypeNode(node.type);
  if (ts.isArrayTypeNode(node) || readonlyArray) {
    const element = getArrayElementType(type, checker);
    if (!element) return undefined;
    const array = factory.createArrayTypeNode(print(element));
    return readonlyArray
      ? factory.createTypeOperatorNode(ts.SyntaxKind.ReadonlyKeyword, array)
      : array;
  }
  if (ts.isTypeReferenceNode(node) && isCellLikeTypeNode(node)) {
    const wrapper = getCellWrapperInfo(type, checker);
    const [argument, ...rest] = cellTypeArguments(type, checker);
    // The value is printed expanded, so a pass can read inside it, unless
    // the printer cannot write the expansion: then it is the argument the
    // wrapper was given, which keeps an alias's name.
    const value = unwrapCellLikeType(type, checker);
    const expanded = value && print(value);
    const printed = expanded &&
        (expanded.kind !== ts.SyntaxKind.UnknownKeyword ||
          isAnyOrUnknownType(value!))
      ? expanded
      : argument && print(argument);
    return wrapper && printed
      ? createHelperWrapperTypeNode(
        printed,
        wrapper.kind,
        factory,
        rest.map(print),
      )
      : undefined;
  }
  return undefined;
}

/**
 * Helper for `unfoldPrint()`, which returns a type literal holding the
 * properties and index signatures of `type`, the object type a literal was
 * printed from, each printed from its own type. Methods are left out, as
 * schema generation reads none. Returns `undefined` for a type with a property
 * keyed by a symbol, which has no name to write it under.
 */
function unfoldPrintedObjectType(
  type: ts.Type,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  state: CrossStageState | undefined,
): ts.TypeLiteralNode | undefined {
  const print = (printable: ts.Type) =>
    typeToTypeNodeWithRegistry(
      printable,
      { checker, factory, sourceFile, state },
      typeRegistry,
    );
  const members: ts.TypeElement[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    if ((property.flags & ts.SymbolFlags.Method) !== 0) continue;
    if (String(property.escapedName).startsWith("__@")) return undefined;
    const declaration = property.valueDeclaration ??
      property.declarations?.[0] ?? sourceFile;
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      declaration,
    );
    // An optional property is written without the `undefined` its
    // optionality adds to its type, as the printer writes it.
    const written = optional && propertyType.isUnion()
      ? propertyType.types.filter((member) =>
        (member.flags & ts.TypeFlags.Undefined) === 0
      )
      : [propertyType];
    members.push(factory.createPropertySignature(
      undefined,
      createPropertyName(property.getName(), factory),
      optional ? factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
      written.length === 1
        ? print(written[0]!)
        : factory.createUnionTypeNode(written.map(print)),
    ));
  }
  for (const index of checker.getIndexInfosOfType(type)) {
    members.push(factory.createIndexSignature(
      undefined,
      [factory.createParameterDeclaration(
        undefined,
        undefined,
        "key",
        undefined,
        print(index.keyType),
      )],
      print(index.type),
    ));
  }
  return factory.createTypeLiteralNode(members);
}

function createIdentityOnlyReplacementTypeNode(
  node: ts.TypeNode,
  semanticType: ts.Type | undefined,
  forceOpaque: boolean,
  forceComparable: boolean,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode {
  const unknownNode = factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );
  const resolvedType = semanticType ??
    getTypeFromTypeNodeWithFallback(
      node,
      checker,
      typeRegistry,
    );
  if (
    forceOpaque ||
    isCellLikeTypeNode(node) ||
    isCellLikeType(resolvedType, checker)
  ) {
    const wrappedNode = wrapTypeNodeWithCapabilityOrStream(
      unknownNode,
      forceComparable ? "comparable" : "opaque",
      factory,
      preservedWrapperFor(node, resolvedType, checker),
    );
    const wrappedType = resolveIdentitySemanticType(
      wrappedNode,
      checker,
      typeRegistry,
    );
    if (wrappedType && typeRegistry) {
      typeRegistry.set(wrappedNode, wrappedType);
    }
    return wrappedNode;
  }
  return unknownNode;
}

function createIdentityOnlyNullishTypeNode(
  type: ts.Type,
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode {
  const typeToNodeFlags = ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback;
  const nullishNode = checker.typeToTypeNode(
    type,
    node.getSourceFile(),
    typeToNodeFlags,
  ) ?? (
    (type.flags & ts.TypeFlags.Null) !== 0
      ? factory.createLiteralTypeNode(factory.createNull())
      : factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)
  );
  typeRegistry?.set(nullishNode, type);
  return nullishNode;
}

function createIdentityOnlyRootTypeNode(
  node: ts.TypeNode,
  semanticType: ts.Type | undefined,
  forceOpaque: boolean,
  forceComparable: boolean,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode {
  const resolvedType = semanticType ??
    resolveIdentitySemanticType(node, checker, typeRegistry);

  if (!resolvedType) {
    return createIdentityOnlyReplacementTypeNode(
      node,
      resolvedType,
      forceOpaque,
      forceComparable,
      checker,
      factory,
      typeRegistry,
    );
  }

  if (isNullishType(resolvedType)) {
    return createIdentityOnlyNullishTypeNode(
      resolvedType,
      node,
      checker,
      factory,
      typeRegistry,
    );
  }

  if (resolvedType.isUnion()) {
    const members = resolvedType.types.map((memberType) =>
      isNullishType(memberType)
        ? createIdentityOnlyNullishTypeNode(
          memberType,
          node,
          checker,
          factory,
          typeRegistry,
        )
        : createIdentityOnlyReplacementTypeNode(
          checker.typeToTypeNode(
            memberType,
            node.getSourceFile(),
            ts.NodeBuilderFlags.NoTruncation |
              ts.NodeBuilderFlags.UseStructuralFallback,
          ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          memberType,
          forceOpaque,
          forceComparable,
          checker,
          factory,
          typeRegistry,
        )
    );

    if (members.length === 1) {
      return members[0]!;
    }

    const unionNode = factory.createUnionTypeNode(members);
    ensureTypeNodeRegistered(unionNode, checker, typeRegistry);
    return unionNode;
  }

  return createIdentityOnlyReplacementTypeNode(
    node,
    resolvedType,
    forceOpaque,
    forceComparable,
    checker,
    factory,
    typeRegistry,
  );
}

function getIdentityChildSemanticType(
  type: ts.Type | undefined,
  head: string,
  location: ts.Node,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (!type) {
    return undefined;
  }

  const nonNullable = checker.getNonNullableType(type);
  const prop = findPropertySymbol(nonNullable, head, checker);
  if (prop) {
    const declaration = prop.valueDeclaration ?? prop.declarations?.[0] ??
      location;
    return checker.getTypeOfSymbolAtLocation(prop, declaration);
  }

  const numericIndex = Number.isFinite(Number(head));
  return checker.getIndexTypeOfType(
    nonNullable,
    numericIndex ? ts.IndexKind.Number : ts.IndexKind.String,
  ) ?? checker.getIndexTypeOfType(nonNullable, ts.IndexKind.String);
}

function resolveIdentitySemanticType(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type | undefined {
  try {
    return getTypeFromTypeNodeWithFallback(node, checker, typeRegistry);
  } catch (_error: unknown) {
    return undefined;
  }
}

function applyIdentityOnlyPathsToTypeNode(
  node: ts.TypeNode,
  paths: readonly (readonly string[])[],
  cellLikePaths: readonly (readonly string[])[],
  comparableCellLikePaths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
  semanticType?: ts.Type,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  sourceFile?: ts.SourceFile,
  state?: CrossStageState,
): ts.TypeNode {
  const normalized = uniquePaths(paths);
  const normalizedCellLikePaths = uniquePaths(cellLikePaths);
  const normalizedComparableCellLikePaths = uniquePaths(
    comparableCellLikePaths,
  );
  if (normalized.length === 0) {
    return node;
  }
  const resolvedSemanticType = semanticType ??
    resolveIdentitySemanticType(node, checker, typeRegistry);
  if (
    normalized.some((path) => path.length === 0) &&
    !normalized.some((path) => path.length > 0)
  ) {
    return createIdentityOnlyRootTypeNode(
      node,
      resolvedSemanticType,
      normalizedCellLikePaths.some((path) => path.length === 0),
      normalizedComparableCellLikePaths.some((path) => path.length === 0),
      checker,
      factory,
      typeRegistry,
    );
  }

  // A printed node is not taken apart: identity paths reaching inside it are
  // applied to its unfolding, or not at all.
  const printedType = state?.printedFrom(node);
  if (printedType && isUnfoldableKind(node)) {
    const unfolded = sourceFile &&
      unfoldPrint(
        node,
        printedType,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        state,
      );
    if (!unfolded) return node;
    const updated = applyIdentityOnlyPathsToTypeNode(
      unfolded,
      normalized,
      normalizedCellLikePaths,
      normalizedComparableCellLikePaths,
      factory,
      checker,
      resolvedSemanticType,
      typeRegistry,
      sourceFile,
      state,
    );
    return updated === unfolded ? node : updated;
  }

  // A scope wrapper around a cell has identity paths applied to the cell it
  // scopes.
  const scopedCell = scopedCellNode(node, checker, typeRegistry);
  if (scopedCell) {
    const updated = applyIdentityOnlyPathsToTypeNode(
      scopedCell.cell,
      normalized,
      normalizedCellLikePaths,
      normalizedComparableCellLikePaths,
      factory,
      checker,
      undefined,
      typeRegistry,
      sourceFile,
      state,
    );
    return updated === scopedCell.cell ? node : wrapScopedCell(
      updated,
      scopedCell.name,
      scopedCell.type,
      factory,
      typeRegistry,
    );
  }

  if (ts.isParenthesizedTypeNode(node)) {
    const updated = applyIdentityOnlyPathsToTypeNode(
      node.type,
      normalized,
      normalizedCellLikePaths,
      normalizedComparableCellLikePaths,
      factory,
      checker,
      resolvedSemanticType,
      typeRegistry,
      sourceFile,
      state,
    );
    return updated === node.type
      ? node
      : factory.updateParenthesizedType(node, updated);
  }

  const itemPaths = getArrayItemPaths(normalized);
  const itemCellLikePaths = getArrayItemPaths(normalizedCellLikePaths);
  const itemComparableCellLikePaths = getArrayItemPaths(
    normalizedComparableCellLikePaths,
  );
  if (itemPaths.length > 0) {
    const itemSemanticType = resolvedSemanticType
      ? getArrayElementType(
        checker.getNonNullableType(resolvedSemanticType),
        checker,
      )
      : undefined;
    if (ts.isArrayTypeNode(node)) {
      const updated = applyIdentityOnlyPathsToTypeNode(
        node.elementType,
        itemPaths,
        itemCellLikePaths,
        itemComparableCellLikePaths,
        factory,
        checker,
        itemSemanticType,
        typeRegistry,
        sourceFile,
        state,
      );
      if (updated === node.elementType) {
        return node;
      }
      const arrayNode = factory.updateArrayTypeNode(node, updated);
      return arrayNode;
    }

    if (
      ts.isTypeOperatorNode(node) &&
      node.operator === ts.SyntaxKind.ReadonlyKeyword &&
      ts.isArrayTypeNode(node.type)
    ) {
      const updated = applyIdentityOnlyPathsToTypeNode(
        node.type.elementType,
        itemPaths,
        itemCellLikePaths,
        itemComparableCellLikePaths,
        factory,
        checker,
        itemSemanticType,
        typeRegistry,
        sourceFile,
        state,
      );
      if (updated === node.type.elementType) {
        return node;
      }
      const readonlyArray = factory.updateArrayTypeNode(node.type, updated);
      const readonlyNode = factory.updateTypeOperatorNode(
        node,
        readonlyArray,
      );
      return readonlyNode;
    }

    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeArguments?.[0] &&
      (node.typeName.text === "Array" || node.typeName.text === "ReadonlyArray")
    ) {
      const [inner] = node.typeArguments;
      const updated = applyIdentityOnlyPathsToTypeNode(
        inner,
        itemPaths,
        itemCellLikePaths,
        itemComparableCellLikePaths,
        factory,
        checker,
        itemSemanticType,
        typeRegistry,
        sourceFile,
        state,
      );
      if (updated === inner) {
        return node;
      }
      const arrayRef = factory.updateTypeReferenceNode(
        node,
        node.typeName,
        factory.createNodeArray([updated]),
      );
      return arrayRef;
    }
  }

  if (ts.isTypeLiteralNode(node)) {
    const grouped = groupPathsByHead(normalized);
    const cellLikeGrouped = groupPathsByHead(normalizedCellLikePaths);
    const comparableCellLikeGrouped = groupPathsByHead(
      normalizedComparableCellLikePaths,
    );
    let changed = false;
    const members = node.members.map((member) => {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) {
        return member;
      }
      const propertyName = getRequestedPropertyNameText(member.name, checker);
      if (!propertyName) {
        return member;
      }
      const childPaths = grouped.get(propertyName);
      if (!childPaths) {
        return member;
      }
      const updated = applyIdentityOnlyPathsToTypeNode(
        member.type,
        childPaths,
        cellLikeGrouped.get(propertyName) ?? [],
        comparableCellLikeGrouped.get(propertyName) ?? [],
        factory,
        checker,
        getIdentityChildSemanticType(
          resolvedSemanticType,
          propertyName,
          member,
          checker,
        ),
        typeRegistry,
        sourceFile,
        state,
      );
      if (updated === member.type) {
        return member;
      }
      changed = true;
      return factory.updatePropertySignature(
        member,
        member.modifiers,
        member.name,
        member.questionToken ??
          (typeNodeIncludesUndefined(updated)
            ? factory.createToken(ts.SyntaxKind.QuestionToken)
            : undefined),
        updated,
      );
    });

    if (!changed) {
      return node;
    }
    return factory.createTypeLiteralNode(members);
  }

  if (
    ts.isTypeReferenceNode(node) &&
    isCellLikeTypeNode(node) &&
    node.typeArguments?.[0]
  ) {
    const [inner, ...rest] = node.typeArguments;
    const updated = applyIdentityOnlyPathsToTypeNode(
      inner,
      normalized,
      normalizedCellLikePaths,
      normalizedComparableCellLikePaths,
      factory,
      checker,
      unwrapCellLikeType(resolvedSemanticType, checker) ?? resolvedSemanticType,
      typeRegistry,
      sourceFile,
      state,
    );
    if (updated === inner) {
      return node;
    }
    const cellNode = factory.updateTypeReferenceNode(
      node,
      node.typeName,
      factory.createNodeArray([updated, ...rest]),
    );
    return cellNode;
  }

  if (ts.isTypeReferenceNode(node) && checker) {
    const members = resolveTypeReferenceMembers(node, checker, typeRegistry);
    if (members) {
      const grouped = groupPathsByHead(normalized);
      const cellLikeGrouped = groupPathsByHead(normalizedCellLikePaths);
      const comparableCellLikeGrouped = groupPathsByHead(
        normalizedComparableCellLikePaths,
      );
      let changed = false;
      const updatedMembers = members.map((member) => {
        if (!ts.isPropertySignature(member) || !member.type || !member.name) {
          return member;
        }
        const propertyName = getRequestedPropertyNameText(member.name, checker);
        if (!propertyName) {
          return member;
        }
        const childPaths = grouped.get(propertyName);
        if (!childPaths) {
          return member;
        }
        const updated = applyIdentityOnlyPathsToTypeNode(
          member.type,
          childPaths,
          cellLikeGrouped.get(propertyName) ?? [],
          comparableCellLikeGrouped.get(propertyName) ?? [],
          factory,
          checker,
          getIdentityChildSemanticType(
            resolvedSemanticType,
            propertyName,
            member,
            checker,
          ),
          typeRegistry,
          sourceFile,
          state,
        );
        if (updated === member.type) {
          return member;
        }
        changed = true;
        return factory.updatePropertySignature(
          member,
          member.modifiers,
          member.name,
          member.questionToken ??
            (typeNodeIncludesUndefined(updated)
              ? factory.createToken(ts.SyntaxKind.QuestionToken)
              : undefined),
          updated,
        );
      });

      if (!changed) {
        return node;
      }
      return factory.createTypeLiteralNode(updatedMembers);
    }
  }

  if (ts.isUnionTypeNode(node)) {
    let changed = false;
    const members = node.types.map((member) => {
      const updated = applyIdentityOnlyPathsToTypeNode(
        member,
        normalized,
        normalizedCellLikePaths,
        normalizedComparableCellLikePaths,
        factory,
        checker,
        resolvedSemanticType,
        typeRegistry,
        sourceFile,
        state,
      );
      if (updated !== member) {
        changed = true;
      }
      return updated;
    });

    if (!changed) {
      return node;
    }
    const unionNode = factory.createUnionTypeNode(members);
    return unionNode;
  }

  return node;
}

function wrapTypeNodeWithDefault(
  node: ts.TypeNode,
  defaultType: ts.TypeNode,
  factory: ts.NodeFactory,
): ts.TypeNode {
  return factory.createTypeReferenceNode(
    factory.createQualifiedName(
      factory.createIdentifier("__cfHelpers"),
      factory.createIdentifier("Default"),
    ),
    [node, defaultType],
  );
}

function applySingleDefaultToTypeNode(
  node: ts.TypeNode,
  path: readonly string[],
  defaultType: ts.TypeNode,
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
): { node: ts.TypeNode; applied: boolean } {
  if (path.length === 0) {
    return {
      node: wrapTypeNodeWithDefault(node, defaultType, factory),
      applied: true,
    };
  }

  const [head, ...tail] = path;
  if (!head) {
    return { node, applied: false };
  }

  if (ts.isTypeLiteralNode(node)) {
    let applied = false;
    const members = node.members.map((member) => {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) {
        return member;
      }
      const memberName = getPropertyNameText(member.name, checker);
      if (memberName !== head) {
        return member;
      }
      const updatedChild = applySingleDefaultToTypeNode(
        member.type,
        tail,
        defaultType,
        factory,
        checker,
      );
      if (!updatedChild.applied) {
        return member;
      }
      applied = true;
      return factory.updatePropertySignature(
        member,
        member.modifiers,
        member.name,
        member.questionToken,
        updatedChild.node,
      );
    });

    return applied
      ? { node: factory.createTypeLiteralNode(members), applied: true }
      : { node, applied: false };
  }

  if (ts.isTupleTypeNode(node)) {
    const index = Number(head);
    if (
      !Number.isInteger(index) || index < 0 || index >= node.elements.length
    ) {
      return { node, applied: false };
    }
    const element = node.elements[index];
    if (!element) return { node, applied: false };
    const updatedChild = applySingleDefaultToTypeNode(
      element,
      tail,
      defaultType,
      factory,
      checker,
    );
    if (!updatedChild.applied) {
      return { node, applied: false };
    }
    const nextElements = [...node.elements];
    nextElements[index] = updatedChild.node;
    return {
      node: factory.updateTupleTypeNode(node, nextElements),
      applied: true,
    };
  }

  if (ts.isUnionTypeNode(node)) {
    let applied = false;
    const members = node.types.map((member) => {
      const updatedChild = applySingleDefaultToTypeNode(
        member,
        path,
        defaultType,
        factory,
        checker,
      );
      if (updatedChild.applied) {
        applied = true;
      }
      return updatedChild.node;
    });

    return applied
      ? { node: factory.createUnionTypeNode(members), applied: true }
      : { node, applied: false };
  }

  return { node, applied: false };
}

function applyDefaultsToTypeNode(
  node: ts.TypeNode,
  defaults: readonly CapabilityParamDefault[] | undefined,
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
): { node: ts.TypeNode; appliedCount: number } {
  if (!defaults || defaults.length === 0) {
    return { node, appliedCount: 0 };
  }

  const ordered = [...defaults].sort((a, b) => b.path.length - a.path.length);
  let next = node;
  let appliedCount = 0;
  for (const entry of ordered) {
    const updated = applySingleDefaultToTypeNode(
      next,
      entry.path,
      entry.defaultType,
      factory,
      checker,
    );
    if (updated.applied) {
      next = updated.node;
      appliedCount++;
    }
  }
  return { node: next, appliedCount };
}

export function applyCapabilityDefaultsToTypeNode(
  node: ts.TypeNode,
  defaults: readonly CapabilityParamDefault[] | undefined,
  baseType: ts.Type | undefined,
  paths: readonly (readonly string[])[],
  wildcard: boolean,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  state?: CrossStageState,
): ts.TypeNode {
  const initial = applyDefaultsToTypeNode(node, defaults, factory, checker);
  if (initial.appliedCount > 0 || !defaults || defaults.length === 0) {
    return initial.node;
  }
  if (!baseType) {
    return initial.node;
  }

  let fallbackNode: ts.TypeNode | undefined;
  if (!wildcard && paths.length > 0) {
    fallbackNode = buildShrunkTypeNodeFromType(
      baseType,
      paths,
      checker,
      sourceFile,
      factory,
      undefined,
      state,
    );
  }
  fallbackNode ??= typeToSchemaTypeNode(baseType, checker, sourceFile, state);
  if (!fallbackNode) {
    return initial.node;
  }

  const fallback = applyDefaultsToTypeNode(
    fallbackNode,
    defaults,
    factory,
    checker,
  );
  return fallback.appliedCount > 0 ? fallback.node : initial.node;
}

function collectAllPropertyLeafPaths(
  type: ts.Type,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  prefix: readonly string[],
  seen: Set<ts.Type>,
): readonly (readonly string[])[] {
  if (seen.has(type) || isNumericIndexableType(type, checker)) {
    return [prefix];
  }
  const nextSeen = new Set(seen);
  nextSeen.add(type);

  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) {
    return [prefix];
  }

  const paths: string[][] = [];
  for (const property of properties) {
    const childType = getSymbolTypeAtSource(property, checker, sourceFile);
    const childPrefix = [...prefix, property.getName()];
    const childPaths = collectAllPropertyLeafPaths(
      childType,
      checker,
      sourceFile,
      childPrefix,
      nextSeen,
    );
    for (const path of childPaths) {
      paths.push([...path]);
    }
  }
  return paths;
}

function buildDefaultsOnlyFallbackPaths(
  baseType: ts.Type | undefined,
  defaults: readonly CapabilityParamDefault[] | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): readonly (readonly string[])[] {
  if (!baseType || !defaults || defaults.length === 0) {
    return [];
  }

  const nestedHeads = new Set<string>();
  for (const entry of defaults) {
    if (entry.path.length > 1) {
      const [head] = entry.path;
      if (head) nestedHeads.add(head);
    }
  }

  const fallbackPaths: string[][] = [];
  for (const property of checker.getPropertiesOfType(baseType)) {
    const head = property.getName();
    if (!nestedHeads.has(head)) {
      fallbackPaths.push([head]);
      continue;
    }

    const childType = getSymbolTypeAtSource(property, checker, sourceFile);
    const leafPaths = collectAllPropertyLeafPaths(
      childType,
      checker,
      sourceFile,
      [head],
      new Set<ts.Type>(),
    );
    for (const path of leafPaths) {
      fallbackPaths.push([...path]);
    }
  }

  for (const entry of defaults) {
    fallbackPaths.push([...entry.path]);
  }

  return uniquePaths(fallbackPaths);
}

//
// Main entry point
//

/**
 * Shared implementation for applying capability summary shrinking and wrapping
 * to a type node. Both `applyCapabilitySummaryToArgument` and
 * `applyCapabilitySummaryToParameter` delegate here after resolving their
 * respective param summary and base types.
 */
export function applyShrinkAndWrap(
  paramSummary: CapabilityParamSummary,
  baseTypeNode: ts.TypeNode,
  baseType: ts.Type | undefined,
  shouldWrap: boolean,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  mode: CapabilitySummaryApplicationMode = "full",
  wrapCapability: ReactiveCapability = paramSummary.capability,
  context?: TransformationContext,
  fnNode?: ts.Node,
  preservedWrapper: PreservedWrapper | undefined = undefined,
): ts.TypeNode {
  const shrinkPlan = deriveCapabilityShrinkPlan(paramSummary);
  const {
    retainedPaths,
    fullShapePaths,
    identityPaths,
    identityCellPaths,
    comparableCellPaths,
    identityOnlyRoot,
    effectiveIdentityPaths,
  } = shrinkPlan;
  const cellCapabilityPaths = buildCellCapabilityPaths(paramSummary);
  const appliedIdentityCellPaths = shouldWrap
    ? identityCellPaths.filter((path) => path.length > 0)
    : identityCellPaths;
  const appliedComparableCellPaths = shouldWrap
    ? comparableCellPaths.filter((path) => path.length > 0)
    : comparableCellPaths;

  if (mode === "defaults_only") {
    if (context && fnNode) {
      validateShrinkCoverage(
        paramSummary,
        baseTypeNode,
        baseType,
        retainedPaths,
        undefined,
        context,
        fnNode,
        checker,
      );
    }

    const next = identityOnlyRoot
      ? applyIdentityOnlyPathsToTypeNode(
        baseTypeNode,
        effectiveIdentityPaths,
        appliedIdentityCellPaths,
        appliedComparableCellPaths,
        factory,
        checker,
        baseType,
        context?.state.typeRegistry,
        sourceFile,
        context?.state,
      )
      : applyCapabilityDefaultsToTypeNode(
        baseTypeNode,
        paramSummary.defaults,
        baseType,
        buildDefaultsOnlyFallbackPaths(
          baseType,
          paramSummary.defaults,
          checker,
          sourceFile,
        ),
        false,
        checker,
        sourceFile,
        factory,
        context?.state,
      );

    if (!shouldWrap) {
      return next;
    }
    return wrapTypeNodeWithCapabilityOrStream(
      next,
      wrapCapability,
      factory,
      preservedWrapper,
    );
  }

  let next = identityOnlyRoot
    ? applyIdentityOnlyPathsToTypeNode(
      baseTypeNode,
      effectiveIdentityPaths,
      appliedIdentityCellPaths,
      appliedComparableCellPaths,
      factory,
      checker,
      baseType,
      context?.state.typeRegistry,
      sourceFile,
      context?.state,
    )
    : identityPaths.length > 0
    ? applyIdentityOnlyPathsToTypeNode(
      baseTypeNode,
      identityPaths,
      appliedIdentityCellPaths,
      appliedComparableCellPaths,
      factory,
      checker,
      baseType,
      context?.state.typeRegistry,
      sourceFile,
      context?.state,
    )
    : baseTypeNode;
  let shrunk: ts.TypeNode | undefined;
  const retainedPathsCoveredByIdentityContainers = identityPaths.length > 0 &&
    retainedPaths.every((path) =>
      identityPaths.some((identityPath) =>
        identityPath.length <= path.length &&
        identityPath.every((segment, index) => segment === path[index])
      )
    );
  if (
    !identityOnlyRoot &&
    !paramSummary.wildcard &&
    retainedPaths.length > 0 &&
    !retainedPathsCoveredByIdentityContainers
  ) {
    const shrinkBaseTypeNode = next;
    const hasDirectAccess = retainedPaths.some((path) => path.length === 0);
    const preferTypeDriven = !!baseType && isSyntheticNode(
      shrinkBaseTypeNode,
    );
    if (preferTypeDriven) {
      // Synthetic inferred nodes can lose property precision in node-only mode.
      const typeDriven = buildShrunkTypeNodeFromType(
        baseType!,
        retainedPaths,
        checker,
        sourceFile,
        factory,
        context?.state.typeRegistry,
        context?.state,
        fullShapePaths,
      );
      const nodeDriven = buildShrunkTypeNodeFromTypeNode(
        shrinkBaseTypeNode,
        retainedPaths,
        factory,
        checker,
        context?.state.typeRegistry,
        context?.state,
        fullShapePaths,
        sourceFile,
      );
      shrunk = choosePreferredShrinkCandidate(
        "type",
        nodeDriven,
        typeDriven,
        shrinkBaseTypeNode,
        retainedPaths,
        checker,
        hasDirectAccess,
      );
    } else {
      // Source-authored nodes preserve exact unions/aliases, but type-driven
      // shrinking can still produce a better result for arrays and inferred
      // wrappers. Compute both and choose the more informative shrink.
      const nodeDriven = buildShrunkTypeNodeFromTypeNode(
        shrinkBaseTypeNode,
        retainedPaths,
        factory,
        checker,
        context?.state.typeRegistry,
        context?.state,
        fullShapePaths,
        sourceFile,
      );
      const typeDriven = baseType && identityPaths.length === 0
        ? buildShrunkTypeNodeFromType(
          baseType,
          retainedPaths,
          checker,
          sourceFile,
          factory,
          context?.state.typeRegistry,
          context?.state,
          fullShapePaths,
        )
        : undefined;
      shrunk = choosePreferredShrinkCandidate(
        "node",
        nodeDriven,
        typeDriven,
        shrinkBaseTypeNode,
        retainedPaths,
        checker,
        hasDirectAccess,
      );
    }
    if (shrunk) {
      next = shrunk;
    }
  }
  if (!identityOnlyRoot && identityPaths.length > 0) {
    next = applyIdentityOnlyPathsToTypeNode(
      next,
      identityPaths,
      appliedIdentityCellPaths,
      appliedComparableCellPaths,
      factory,
      checker,
      baseType,
      context?.state.typeRegistry,
      sourceFile,
      context?.state,
    );
    shrunk = next;
  }
  if (context && fnNode) {
    validateShrinkCoverage(
      paramSummary,
      baseTypeNode,
      baseType,
      retainedPaths,
      shrunk,
      context,
      fnNode,
      checker,
    );
  }

  next = applyCapabilityDefaultsToTypeNode(
    next,
    paramSummary.defaults,
    baseType,
    retainedPaths,
    paramSummary.wildcard,
    checker,
    sourceFile,
    factory,
    context?.state,
  );
  next = applyCellCapabilityPathsToTypeNode(
    next,
    cellCapabilityPaths,
    factory,
    checker,
    sourceFile,
    context?.state.typeRegistry,
    context?.state,
  );

  if (!shouldWrap) {
    return next;
  }
  const wrapped = wrapTypeNodeWithCapabilityOrStream(
    next,
    wrapCapability,
    factory,
    preservedWrapper,
  );
  return wrapped;
}
