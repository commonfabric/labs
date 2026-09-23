import type {
  AsCellEntry,
  MutableJSONSchema,
  MutableJSONSchemaObj,
  SchemaScope,
} from "@commonfabric/api";
import {
  CFC_ATOM_TYPE,
  CFC_CANONICAL_ALIAS_NAMES,
} from "@commonfabric/api/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";
import ts from "typescript";

import { reportUnresolvedDefault } from "../default-diagnostics.ts";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import {
  detectWrapperViaNode,
  extractDefaultBrandPayloadValue,
  getArrayElementInfo,
  getPropertyNameText,
  isEmptyObjectDefaultType,
  resolveWrapperNode,
  type TypeWithInternals,
} from "../type-utils.ts";
import {
  isCommonFabricSymbol,
  isImportedFromCommonFabric,
} from "../typescript/common-fabric-symbols.ts";
import {
  extractLiteralValueOfSymbol,
  resolveAliasedSymbol,
} from "../typescript/literal-value.ts";
import {
  readAuthoredTypeNode,
  unwrapTypeParentheses,
} from "../typescript/type-node.ts";
import { resolveWriterBinding } from "../typescript/writer-binding.ts";
import {
  type CellWrapperKind,
  getCellBrand,
  getCellWrapperInfo,
  isCellBrand,
  wrapperKindToBrand,
} from "../typescript/cell-brand.ts";
import { isDefaultAliasSymbol } from "../typescript/property-optionality.ts";
import { dedupeByValueEqual } from "../value-equality.ts";
import { scopeInsideUnionError } from "../scope-placement.ts";
import { combineIfcLabels } from "../ifc-labels.ts";

type WrapperKind = CellWrapperKind;
const CFC_ALIAS_NAMES: ReadonlySet<string> = new Set(CFC_CANONICAL_ALIAS_NAMES);
const SCOPE_WRAPPER_SCOPES: Readonly<Record<string, SchemaScope>> = {
  PerSpace: "space",
  PerUser: "user",
  PerSession: "session",
  PerAny: "any",
};
type ResolvedCfcAlias = {
  readonly aliasName: string;
  readonly aliasArgs: readonly ts.Type[];
  readonly aliasArgNodes?: readonly ts.TypeNode[];
  /**
   * The parameters, along the chain to `aliasName`, that an argument node was
   * substituted for.
   */
  readonly substituted?: readonly ts.TypeParameterDeclaration[];
};

type ResolvedScopeWrapper = {
  readonly scope: SchemaScope;
  readonly node: ts.TypeReferenceNode;
};

const scopeForWrapperName = (
  name: string | undefined,
): SchemaScope | undefined =>
  name === undefined ? undefined : SCOPE_WRAPPER_SCOPES[name];

// The capability subset of `CellWrapperKind`: brands that all wrap the SAME
// structural inner `T` and differ only in read/write capability. The transformer
// narrows one to another (e.g. `Cell<T>` → `ReadonlyCell<T>`) to reflect usage,
// so a node-vs-type brand mismatch among these is a capability narrowing, not a
// structural change. `Stream`/`SqliteDb`/`Reactive` are excluded: they carry a
// distinct structural contract, not a read/write variant of a plain cell.
//
// Derived as an exhaustive map over `CellWrapperKind` so that adding a new kind
// to that union is a compile error here until it's deliberately classified.
//
// NB: distinct from `type-utils.ts`'s `CELL_LIKE_WRAPPER_NAMES`, which keys off
// raw type-node NAMES (where `Writable` is a separate spelling and `OpaqueCell`
// is split out). This set keys off RESOLVED `CellWrapperKind` values, where
// `Writable` has already normalized to `Cell` and `OpaqueCell` belongs with the
// rest.
const CELL_CAPABILITY_KIND_MAP: Readonly<Record<CellWrapperKind, boolean>> = {
  Cell: true,
  ReadonlyCell: true,
  WriteonlyCell: true,
  ComparableCell: true,
  OpaqueCell: true,
  Stream: false,
  SqliteDb: false,
  Reactive: false,
};
const isCellCapabilityKind = (kind: WrapperKind): boolean =>
  CELL_CAPABILITY_KIND_MAP[kind];

/** Resolves the scope explicitly named by a type reference. */
export const resolveScopeWrapperNode = (
  typeNode: ts.TypeNode | undefined,
): ResolvedScopeWrapper | undefined => {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const name = ts.isIdentifier(typeNode.typeName)
    ? typeNode.typeName.text
    : typeNode.typeName.right.text;
  const scope = scopeForWrapperName(name);
  return scope === undefined ? undefined : { scope, node: typeNode };
};

const applyScopeToAsCellEntry = (
  entry: AsCellEntry,
  scope: SchemaScope,
): AsCellEntry => {
  if (typeof entry === "string") {
    return { kind: entry, scope };
  }
  if (isObjectOrArray(entry)) {
    return { ...entry, scope };
  }
  return entry;
};

/**
 * `typeNode` with each reference to a parameter in `paramMap` replaced by its
 * argument. A subtree holding a replaced reference is built afresh, with no
 * original node, so the checker cannot read it back as the declaration's
 * subtree with the parameter unbound. Any other subtree is returned as it is,
 * and so is a kind this does not open, which may still hold a parameter.
 */
const substituteTypeNode = (
  typeNode: ts.TypeNode,
  paramMap: ReadonlyMap<string, ts.TypeNode>,
): ts.TypeNode => {
  if (paramMap.size === 0) {
    return typeNode;
  }
  const f = ts.factory;
  const substitute = (node: ts.TypeNode) => substituteTypeNode(node, paramMap);
  const substituteEach = (nodes: readonly ts.TypeNode[]) => {
    const substituted = nodes.map(substitute);
    return substituted.some((node, index) => node !== nodes[index])
      ? substituted
      : undefined;
  };
  const substituteOne = (node: ts.TypeNode) => {
    const substituted = substitute(node);
    return substituted === node ? undefined : substituted;
  };

  if (ts.isTypeReferenceNode(typeNode)) {
    const mapped = ts.isIdentifier(typeNode.typeName)
      ? paramMap.get(typeNode.typeName.text)
      : undefined;
    if (mapped && !typeNode.typeArguments?.length) {
      return mapped;
    }
    const args = typeNode.typeArguments &&
      substituteEach(typeNode.typeArguments);
    return args ? f.createTypeReferenceNode(typeNode.typeName, args) : typeNode;
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    const members = typeNode.members.map((member) => {
      if (!ts.isPropertySignature(member) || !member.type) return member;
      const type = substituteOne(member.type);
      return type
        ? f.createPropertySignature(
          member.modifiers,
          member.name,
          member.questionToken,
          type,
        )
        : member;
    });
    return members.some((member, index) => member !== typeNode.members[index])
      ? f.createTypeLiteralNode(members)
      : typeNode;
  }

  if (ts.isUnionTypeNode(typeNode)) {
    const types = substituteEach(typeNode.types);
    return types ? f.createUnionTypeNode(types) : typeNode;
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    const types = substituteEach(typeNode.types);
    return types ? f.createIntersectionTypeNode(types) : typeNode;
  }
  if (ts.isTupleTypeNode(typeNode)) {
    const elements = substituteEach(typeNode.elements);
    return elements ? f.createTupleTypeNode(elements) : typeNode;
  }
  if (ts.isNamedTupleMember(typeNode)) {
    const type = substituteOne(typeNode.type);
    return type
      ? f.createNamedTupleMember(
        typeNode.dotDotDotToken,
        typeNode.name,
        typeNode.questionToken,
        type,
      )
      : typeNode;
  }
  if (ts.isOptionalTypeNode(typeNode)) {
    const type = substituteOne(typeNode.type);
    return type ? f.createOptionalTypeNode(type) : typeNode;
  }
  if (ts.isRestTypeNode(typeNode)) {
    const type = substituteOne(typeNode.type);
    return type ? f.createRestTypeNode(type) : typeNode;
  }
  if (ts.isArrayTypeNode(typeNode)) {
    const element = substituteOne(typeNode.elementType);
    return element ? f.createArrayTypeNode(element) : typeNode;
  }
  if (ts.isTypeOperatorNode(typeNode)) {
    const operand = substituteOne(typeNode.type);
    return operand
      ? f.createTypeOperatorNode(typeNode.operator, operand)
      : typeNode;
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    const inner = substituteOne(typeNode.type);
    return inner ? f.createParenthesizedType(inner) : typeNode;
  }

  return typeNode;
};

/**
 * Whether `node` holds a reference the checker binds to a type parameter, or,
 * given `parameters`, to one of those.
 */
const holdsTypeParameter = (
  node: ts.Node,
  checker: ts.TypeChecker,
  parameters?: readonly ts.TypeParameterDeclaration[],
): boolean =>
  (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) &&
    (checker.getSymbolAtLocation(node.typeName)?.declarations?.some(
      (declaration) =>
        ts.isTypeParameterDeclaration(declaration) &&
        (parameters === undefined || parameters.includes(declaration)),
    ) ?? false)) ||
  (ts.forEachChild(node, (child) =>
    holdsTypeParameter(child, checker, parameters) || undefined) ?? false);

/**
 * Whether the CFC lowering, handed `args` for `declaration`'s parameters,
 * reaches a CFC alias down `declaration`'s chain of aliases, each the whole
 * body of the one before and followed at most once, with every parameter along
 * the way replaced by an argument or, for one left out, its default.
 */
const lowersDownAliasChain = (
  declaration: ts.TypeAliasDeclaration,
  args: readonly ts.TypeNode[],
  checker: ts.TypeChecker,
  visited: ReadonlySet<string>,
): boolean => {
  if (CFC_ALIAS_NAMES.has(declaration.name.text)) return true;
  const aliased = declaration.type;
  if (
    !ts.isTypeReferenceNode(aliased) || !ts.isIdentifier(aliased.typeName) ||
    visited.has(aliased.typeName.text)
  ) {
    return false;
  }
  // An argument left out is its parameter's default, read with the arguments
  // before it; a parameter with neither leaves the chain unlowered.
  const paramMap = new Map<string, ts.TypeNode>();
  for (
    const [index, parameter] of (declaration.typeParameters ?? []).entries()
  ) {
    const arg = args[index] ??
      (parameter.default && substituteTypeNode(parameter.default, paramMap));
    if (!arg) return false;
    paramMap.set(parameter.name.text, arg);
  }
  const substituted = (aliased.typeArguments ?? []).map((arg) =>
    substituteTypeNode(arg, paramMap)
  );
  if (substituted.some((arg) => holdsTypeParameter(arg, checker))) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(aliased.typeName);
  const target = symbol &&
    resolveAliasedSymbol(symbol, checker).declarations?.find(
      ts.isTypeAliasDeclaration,
    );
  return target !== undefined &&
    lowersDownAliasChain(
      target,
      substituted,
      checker,
      new Set([...visited, declaration.name.text]),
    );
};

/**
 * Whether this formatter lowers `reference`, to the generic `symbol`, from the
 * reference's own type arguments: a scope wrapper naming its payload, which it
 * reads from that argument, or an alias that is not itself a CFC alias and
 * whose whole body references one, directly or through further such aliases,
 * where substituting the reference's arguments down that chain leaves no
 * parameter unbound.
 */
export function lowersFromReferenceArguments(
  reference: ts.TypeReferenceNode,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  if (resolveScopeWrapperNode(reference)) {
    return (reference.typeArguments?.length ?? 0) > 0;
  }
  const declaration = symbol.declarations?.find(ts.isTypeAliasDeclaration);
  return declaration !== undefined &&
    !CFC_ALIAS_NAMES.has(declaration.name.text) &&
    lowersDownAliasChain(
      declaration,
      reference.typeArguments ?? [],
      checker,
      new Set([declaration.name.text]),
    );
}

/**
 * Formatter for Common Fabric-specific types (Cell<T>, Stream<T>, Reactive<T>, Default<T,V>)
 *
 * TypeScript handles alias resolution automatically and we don't need to
 * manually traverse alias chains.
 */
export class CommonFabricFormatter implements TypeFormatter {
  #schemaGenerator: SchemaGenerator;

  constructor(schemaGenerator: SchemaGenerator) {
    this.#schemaGenerator = schemaGenerator;
    if (!schemaGenerator) {
      throw new Error(
        "CommonFabricFormatter requires a SchemaGenerator instance",
      );
    }
  }

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    const aliasName = (type as TypeWithInternals).aliasSymbol?.name;
    if (scopeForWrapperName(aliasName) !== undefined) {
      return true;
    }

    if (resolveScopeWrapperNode(context.typeNode)) {
      return true;
    }

    if (aliasName && CFC_ALIAS_NAMES.has(aliasName)) {
      return true;
    }

    if (
      this.#resolveCfcAliasInstantiation(type as TypeWithInternals, context)
    ) {
      return true;
    }

    // Check via typeNode for Default (erased at type-level)
    const wrapperViaNode = detectWrapperViaNode(
      context.typeNode,
      context.typeChecker,
    );
    if (wrapperViaNode) {
      return true;
    }

    // Fallback: check via aliasSymbol for Default<T> when typeToTypeNode expanded the alias.
    // typeToTypeNode expands Default<T,V> to its branded union representation, losing the
    // "Default" type node. The type object itself still carries aliasSymbol = Default.
    if (isDefaultAliasSymbol((type as TypeWithInternals).aliasSymbol)) {
      return true;
    }

    // Check if this is FactoryInput<T>.
    if (this.#getFactoryInputBase(type)) {
      return true;
    }

    // Check if union contains wrapper types via node inspection
    // This must come before the blanket union rejection to handle
    // cases like Reactive<T> | undefined without expanding conditionals
    if (this.#isWrapperUnion(type, context)) {
      return true; // Take ownership of wrapper unions
    }

    if ((type.flags & ts.TypeFlags.Union) !== 0) {
      return false;
    }

    // Check if this is a wrapper type (Cell/Stream/Reactive) via type structure
    const wrapperInfo = getCellWrapperInfo(type, context.typeChecker);
    return wrapperInfo !== undefined;
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const n = context.typeNode;
    const resolvedScopeWrapper = resolveScopeWrapperNode(n);
    if (resolvedScopeWrapper) {
      return this.#formatScopeWrapperTypeFromNode(
        resolvedScopeWrapper.node,
        context,
        resolvedScopeWrapper.scope,
        type,
      );
    }

    const aliasType = type as TypeWithInternals;
    const aliasScope = scopeForWrapperName(aliasType.aliasSymbol?.name);
    if (aliasScope !== undefined) {
      const innerType = aliasType.aliasTypeArguments?.[0];
      if (!innerType) {
        throw new Error(
          `${aliasType.aliasSymbol?.name}<T> requires type argument`,
        );
      }
      const innerSchema = this.#schemaGenerator.formatChildType(
        innerType,
        context,
        undefined,
      );
      return this.#applyScopeWrapperSemantics(innerSchema, aliasScope);
    }

    const resolvedCfcAlias = this.#resolveCfcAliasInstantiation(
      aliasType,
      context,
    );
    if (resolvedCfcAlias) {
      return this.#formatResolvedCfcAlias(resolvedCfcAlias, context);
    }

    // Handle wrapper unions first (before FactoryInput<T> union check)
    // This catches cases like Reactive<T> | undefined and processes them
    // via node inspection to avoid conditional type expansion
    if (
      (type.flags & ts.TypeFlags.Union) !== 0 &&
      this.#isWrapperUnion(type, context)
    ) {
      return this.#formatWrapperUnion(type as ts.UnionType, context);
    }

    // Check if this is FactoryInput<T> and handle it first
    // This prevents the UnionFormatter from creating an anyOf
    const factoryInputBase = this.#getFactoryInputBase(type);
    if (factoryInputBase) {
      const innerSchema = this.#schemaGenerator.formatChildType(
        factoryInputBase,
        context,
        undefined, // Don't pass typeNode since we're working with the unwrapped type
      );

      return this.#applyWrapperSemantics(innerSchema, "OpaqueCell");
    }

    // Check via typeNode for all wrapper types (handles both direct usage and aliases)
    const resolvedWrapper = n
      ? resolveWrapperNode(n, context.typeChecker)
      : undefined;

    // Handle Default via node, written in place or reached through
    // parentheses or an alias without type parameters: the resolved reference
    // is the `Default<T, V>` its author wrote, arguments and all.
    if (resolvedWrapper?.kind === "Default") {
      return this.#formatDefaultType(resolvedWrapper.node, context, type);
    }

    // Fallback: handle Default<T> detected via aliasSymbol when no type node is available.
    // When typeToTypeNode expands Default<T,V), the node no longer says "Default" but
    // the type object still carries aliasSymbol. Extract T from aliasTypeArguments[0]
    // and V from aliasTypeArguments[1] so the default value is preserved in the schema.
    const typeWithAlias = type as TypeWithInternals;
    if (
      isDefaultAliasSymbol(typeWithAlias.aliasSymbol) &&
      typeWithAlias.aliasTypeArguments &&
      typeWithAlias.aliasTypeArguments.length >= 1
    ) {
      const innerType = typeWithAlias.aliasTypeArguments[0]!;
      const valueSchema = this.#schemaGenerator.formatChildType(
        innerType,
        context,
        undefined,
      );

      if (typeWithAlias.aliasTypeArguments.length >= 2) {
        const defaultType = typeWithAlias.aliasTypeArguments[1]!;
        const defaultValue = this.#extractDefaultValue(defaultType, context);
        // TODO(danfuzz): A default for a fabric-backed native disagrees with
        // the value its type actually stores. `Date`, `RegExp`, and
        // `Uint8Array` map to `{ type: "object" }` because they are stored as
        // `FabricEpochNsec` / `FabricRegExp` / `FabricBytes`, but the default
        // captured here is the authored TS literal. So
        // `Default<Date, "2020-01-01T00:00:00.000Z">` emits
        // `{ type: "object", default: "2020-01-01T00:00:00.000Z" }` -- a string
        // standing in for an object, and not the form a read of that slot would
        // ever produce. Decide how a default for these types is expressed
        // (converted to the fabric form here, converted where the default is
        // applied, or refused outright) instead of leaving the two disagreeing.
        // The node-based path below attaches defaults the same way and needs
        // the same answer.
        if (defaultValue !== undefined) {
          if (typeof valueSchema === "boolean") {
            return (valueSchema === false
              ? { not: true, default: defaultValue }
              : { default: defaultValue }) as MutableJSONSchemaObj;
          }
          (valueSchema as Record<string, unknown>).default = defaultValue;
        } else {
          reportUnresolvedDefault(context);
        }
      } else {
        reportUnresolvedDefault(context);
      }

      return valueSchema;
    }

    const wrapperInfo = getCellWrapperInfo(type, context.typeChecker);
    if (
      resolvedWrapper &&
      wrapperInfo &&
      wrapperInfo.kind !== resolvedWrapper.kind &&
      this.#isSyntheticWrapperNode(resolvedWrapper.node)
    ) {
      return this.#formatWrapperTypeFromNode(
        resolvedWrapper.node,
        context,
        resolvedWrapper.kind,
        // The synthetic node narrows the resolved type's capability brand (e.g.
        // the transformer re-wrapped `Cell<T>` as `ReadonlyCell<T>` for read-only
        // usage). Both brands wrap the SAME structural inner. When the node's own
        // inner has no source position and degrades to `any`, fall back to the
        // resolved type's inner so the inner `$ref`/`$defs` survives the re-wrap.
        isCellCapabilityKind(wrapperInfo.kind)
          ? wrapperInfo.typeRef
          : undefined,
      );
    }

    if (wrapperInfo && !(type.flags & ts.TypeFlags.Union)) {
      const nodeToPass = this.#selectWrapperTypeNode(
        n,
        resolvedWrapper,
        wrapperInfo.kind,
      );
      return this.#formatWrapperType(
        wrapperInfo.typeRef,
        nodeToPass,
        context,
        wrapperInfo.kind,
      );
    }

    // Synthetic wrapper nodes (for example __cfHelpers.ReadonlyCell<...>) may
    // resolve to `any` in checker contexts created before helper injection.
    // In that case, fall back to node-driven wrapper formatting.
    if (resolvedWrapper && !wrapperInfo) {
      return this.#formatWrapperTypeFromNode(
        resolvedWrapper.node,
        context,
        resolvedWrapper.kind,
      );
    }

    // If we detected a wrapper syntactically but the current type is wrapped in
    // additional layers (e.g., FactoryInput<Reactive<...>>), recursively unwrap using
    // brand information until we reach the underlying wrapper.
    const wrapperKinds: WrapperKind[] = [
      "OpaqueCell",
      "Cell",
      "Stream",
      "SqliteDb",
      "ReadonlyCell",
      "WriteonlyCell",
      "ComparableCell",
    ];
    for (const kind of wrapperKinds) {
      const unwrappedType = this.#recursivelyUnwrapOpaqueCell(
        type,
        kind,
        context.typeChecker,
      );
      if (unwrappedType) {
        const nodeToPass = this.#selectWrapperTypeNode(
          n,
          resolvedWrapper,
          unwrappedType.kind,
        );
        return this.#formatWrapperType(
          unwrappedType.typeRef,
          nodeToPass,
          context,
          unwrappedType.kind,
        );
      }
    }

    const nodeName = this.#getTypeRefIdentifierName(n);
    throw new Error(
      `Unexpected Common Fabric type: ${nodeName}`,
    );
  }

  #formatWrapperTypeFromNode(
    typeRefNode: ts.TypeReferenceNode,
    context: GenerationContext,
    wrapperKind: WrapperKind,
    // When the synthetic node's own inner type degrades to `any`/`unknown` (no
    // source position to resolve against), the inner type argument of this
    // type — the capability re-wrap's source wrapper, e.g. `Cell<T>` for a node
    // narrowed to `ReadonlyCell<T>` — supplies the precise inner so the inner
    // `$ref`/`$defs` survives. Only consulted as a fallback, so node-driven
    // results that already resolve (including node-level unions like
    // `string | undefined`) are left untouched.
    fallbackInnerTypeRef?: ts.TypeReference,
  ): MutableJSONSchema {
    const innerTypeNode = typeRefNode.typeArguments?.[0];
    if (!innerTypeNode) {
      throw new Error(`${wrapperKind}<T> requires type argument`);
    }

    const registeredWrapperType = context.typeRegistry?.get(typeRefNode);
    const registeredWrapperInfo = registeredWrapperType
      ? getCellWrapperInfo(registeredWrapperType, context.typeChecker)
      : undefined;

    let innerType: ts.Type;
    try {
      innerType = context.typeRegistry?.get(innerTypeNode) ??
        (registeredWrapperInfo &&
          this.#firstTypeArgument(registeredWrapperInfo.typeRef, context)) ??
        context.typeChecker.getTypeFromTypeNode(innerTypeNode);
    } catch {
      innerType = context.typeChecker.getAnyType();
    }

    // Ahead of formatting, adopt the resolved type's inner only when the node's
    // inner is a bare named reference (a `TypeReferenceNode`) that degrades to
    // `any` — the case where node-driven formatting can recover NOTHING and
    // would emit `{}`, dropping the inner `$ref`/`$defs`. Structured inner nodes
    // (unions, literals, arrays) carry recoverable shape even when the checker
    // resolves them to `any` from a synthetic position, so the node-driven
    // result is tried first there (e.g. a `string | undefined` inner whose
    // `| undefined` lives only on the node).
    if (
      this.#isUnusableInnerType(innerType) && fallbackInnerTypeRef &&
      ts.isTypeReferenceNode(innerTypeNode)
    ) {
      const fallbackInner = this.#firstTypeArgument(
        fallbackInnerTypeRef,
        context,
      );
      if (fallbackInner && !this.#isUnusableInnerType(fallbackInner)) {
        innerType = fallbackInner;
      }
    }

    // Keep schema-hint propagation behavior aligned with type-based wrapper formatting.
    let childContext = context;
    if (context.schemaHints && context.typeNode) {
      const hint = context.schemaHints.get(context.typeNode);
      if (hint?.items === false) {
        const itemsOverride = this.#createArrayItemsOverride(
          innerType,
          innerTypeNode,
          context,
        );
        childContext = { ...context, arrayItemsOverride: itemsOverride };
      }
    }

    const uninterpreted: ts.TypeNode[] = [];
    let innerSchema = this.#schemaGenerator.formatChildType(
      innerType,
      { ...childContext, uninterpretedTypeNodes: uninterpreted },
      innerTypeNode,
    );

    // A structured inner node wins over the resolved type only while it can be
    // read. The printer emits forms that node-based analysis cannot interpret
    // from a synthetic position — `import("./mod.ts").T` for a name the
    // emitting module does not import, and the `T & { [DEFAULT_MARKER]: V }`
    // arm of an expanded `Default`. An unreadable member can turn a union into
    // accept-anything; skipping a computed brand can lose its default metadata.
    // The resolved wrapper's inner supplies the complete value schema instead,
    // at the cost of any narrowing the node carried: the schema is then that
    // of the whole stored value.
    if (uninterpreted.length > 0) {
      const resolvedInner = fallbackInnerTypeRef &&
        this.#firstTypeArgument(fallbackInnerTypeRef, context);
      if (resolvedInner && !this.#isUnusableInnerType(resolvedInner)) {
        innerType = resolvedInner;
        innerSchema = this.#schemaGenerator.formatChildType(
          resolvedInner,
          childContext,
          undefined,
        );
      } else {
        context.uninterpretedTypeNodes?.push(...uninterpreted);
      }
    }

    if (wrapperKind === "Stream") {
      if (typeof innerSchema === "boolean") {
        return this.#applyWrapperSemantics(innerSchema, "Stream");
      }
      return this.#applyWrapperSemantics(
        innerSchema as MutableJSONSchemaObj,
        "Stream",
      );
    }

    if (wrapperKind === "Cell") {
      const innerWrapper = resolveWrapperNode(
        innerTypeNode,
        context.typeChecker,
      );
      if (
        this.#isStreamType(innerType, context.typeChecker) ||
        innerWrapper?.kind === "Stream"
      ) {
        throw new Error(
          "Cell<Stream<T>> is unsupported. Wrap the stream: Cell<{ stream: Stream<T> }>.",
        );
      }
    }

    return this.#applyWrapperSemantics(innerSchema, wrapperKind);
  }

  /**
   * Helper for `#formatWrapperTypeFromNode()`, which reads a wrapper's payload
   * type. A reference whose arguments are still deferred carries none on the
   * object and yields them through the checker.
   */
  #firstTypeArgument(
    typeRef: ts.TypeReference,
    context: GenerationContext,
  ): ts.Type | undefined {
    const typeArgs = typeRef.typeArguments ??
      context.typeChecker.getTypeArguments(typeRef);
    return typeArgs[0];
  }

  #formatScopeWrapperTypeFromNode(
    typeRefNode: ts.TypeReferenceNode,
    context: GenerationContext,
    scope: SchemaScope,
    type: ts.Type | undefined,
  ): MutableJSONSchema {
    const innerTypeNode = typeRefNode.typeArguments?.[0];
    if (!innerTypeNode) {
      throw new Error(`Scoped wrapper requires type argument`);
    }

    // The payload carried by the wrapper's own type. A node the printer wrote
    // from a type has no scope to resolve against, so the checker reads it as
    // `any`, and a node-driven schema would then admit anything.
    const typeWithAlias = type as TypeWithInternals | undefined;
    const resolvedInner =
      scopeForWrapperName(typeWithAlias?.aliasSymbol?.name) !== undefined
        ? typeWithAlias?.aliasTypeArguments?.[0]
        : undefined;
    const usableResolvedInner = resolvedInner &&
        !this.#isUnusableInnerType(resolvedInner)
      ? resolvedInner
      : undefined;

    let innerType: ts.Type;
    try {
      innerType = context.typeRegistry?.get(innerTypeNode) ??
        context.typeChecker.getTypeFromTypeNode(innerTypeNode);
    } catch {
      innerType = context.typeChecker.getAnyType();
    }

    const uninterpreted: ts.TypeNode[] = [];
    let innerSchema = this.#schemaGenerator.formatChildType(
      innerType,
      { ...context, uninterpretedTypeNodes: uninterpreted },
      innerTypeNode,
    );

    // A payload node that node analysis had to guess at loses what it could
    // not read. A node printed from a type is guessed at whole, since the
    // names it spells resolve to nothing here; one read in part loses only
    // what that part carried, and the `T & { [DEFAULT_MARKER]: V }` arm of an
    // expanded `Default` carries the default. The wrapper's own payload
    // supplies the value schema instead, at the cost of any narrowing the
    // node carried.
    if (uninterpreted.length > 0) {
      if (usableResolvedInner) {
        innerSchema = this.#schemaGenerator.formatChildType(
          usableResolvedInner,
          context,
          undefined,
        );
      } else {
        context.uninterpretedTypeNodes?.push(...uninterpreted);
      }
    }

    return this.#applyScopeWrapperSemantics(innerSchema, scope);
  }

  #applyScopeWrapperSemantics(
    schema: MutableJSONSchema,
    scope: SchemaScope,
  ): MutableJSONSchema {
    if (typeof schema === "boolean") {
      return schema === false ? { not: true, scope } : { scope };
    }

    if (Array.isArray(schema.asCell) && schema.asCell.length > 0) {
      const [first, ...rest] = schema.asCell;
      return {
        ...schema,
        asCell: [applyScopeToAsCellEntry(first!, scope), ...rest],
      };
    }

    if (schema.scope !== undefined) {
      throw new Error(
        "Nested scope wrappers require a cell boundary between scopes.",
      );
    }

    return { ...schema, scope };
  }

  #formatWrapperType(
    typeRef: ts.TypeReference,
    typeRefNode: ts.TypeNode | undefined,
    context: GenerationContext,
    wrapperKind: WrapperKind,
  ): MutableJSONSchema {
    const innerTypeFromType = typeRef.typeArguments?.[0];

    // Only extract innerTypeNode if the typeRefNode has type arguments AND
    // those arguments are not generic type parameters.
    // If typeRefNode has no type arguments, or if the arguments are generic parameters
    // (e.g., T from an alias declaration), we should NOT extract inner types from it.
    let innerTypeNode: ts.TypeNode | undefined = undefined;
    if (
      typeRefNode && ts.isTypeReferenceNode(typeRefNode) &&
      typeRefNode.typeArguments
    ) {
      const firstArg = typeRefNode.typeArguments[0];
      if (firstArg) {
        // Check if this node represents a type parameter
        const argType = context.typeChecker.getTypeFromTypeNode(firstArg);
        const isTypeParameter =
          (argType.flags & ts.TypeFlags.TypeParameter) !== 0;
        if (!isTypeParameter) {
          // Not a type parameter, safe to use
          innerTypeNode = firstArg;
        }
        // Otherwise leave innerTypeNode as undefined (don't use type parameter nodes)
      }
    }

    // Resolve inner type, preferring type information but falling back to node
    // when wrapper references degrade to unknown/any/type-parameter.
    let innerType: ts.Type | undefined = innerTypeFromType;
    if (
      (!innerType || this.#isUnusableInnerType(innerType)) &&
      innerTypeNode
    ) {
      try {
        const fromNode = context.typeRegistry?.get(innerTypeNode) ??
          context.typeChecker.getTypeFromTypeNode(innerTypeNode);
        if (fromNode && !this.#isUnusableInnerType(fromNode)) {
          innerType = fromNode;
        }
      } catch {
        // Leave innerType as-is and continue with conservative fallback.
      }
    }
    if (!innerType) {
      throw new Error(
        `${wrapperKind}<T> requires type argument`,
      );
    }

    // When we resolve aliases (e.g., StringCell -> Cell<string>), the resolved node's
    // type arguments may contain unbound generics (e.g., T) from the alias declaration.
    // In that case, we must NOT pass the node, since the type information has the
    // concrete types (e.g., string) from the usage site.
    // We detect this by checking if the inner type is a type parameter.
    const innerTypeIsGeneric =
      (innerType.flags & ts.TypeFlags.TypeParameter) !== 0;

    // Synthetic nodes have pos === -1 and end === -1.
    const isSyntheticNode = innerTypeNode && innerTypeNode.pos === -1 &&
      innerTypeNode.end === -1;

    const syntheticNodeNeedsHelp = !!innerTypeNode && !!isSyntheticNode &&
      this.#innerTypeNeedsNodeAssistance(innerType, context.typeChecker);

    // Prefer real source nodes, but allow synthetic nodes when the resolved type
    // is widened/unusable and the node still carries useful structure.
    const shouldPassTypeNode = innerTypeNode && !innerTypeIsGeneric &&
      (!isSyntheticNode || syntheticNodeNeedsHelp);

    // Check for schema hints on the current typeNode and propagate to child context.
    // This allows identity-only/property-only array access patterns to avoid
    // materializing full item schemas while preserving the wrapper on the array.
    let childContext = context;
    if (context.schemaHints && context.typeNode) {
      const hint = context.schemaHints.get(context.typeNode);
      if (hint?.items === false) {
        // Pass the inner node even when it isn't used to build the inner schema
        // (shouldPassTypeNode=false): the override only reads the element's
        // capability from it. For an expanded `Default<[]> | Item[]` union the
        // element's `comparable` capability lives ONLY on the synthetic node
        // (the resolved union type can't express it), so the node is required to
        // recover it. (CT-1639 Gap B)
        const itemsOverride = this.#createArrayItemsOverride(
          innerType,
          innerTypeNode,
          context,
        );
        childContext = { ...context, arrayItemsOverride: itemsOverride };
      }
    }

    const innerSchema = this.#schemaGenerator.formatChildType(
      innerType,
      childContext,
      shouldPassTypeNode ? innerTypeNode : undefined,
    );

    // Stream<T>: can also reflect inner Cell-ness
    if (wrapperKind === "Stream") {
      if (typeof innerSchema === "boolean") {
        return this.#applyWrapperSemantics(innerSchema, "Stream");
      }
      return this.#applyWrapperSemantics(
        innerSchema as MutableJSONSchemaObj,
        "Stream",
      );
    }

    // Cell<T>: disallow Cell<Stream<T>> to avoid ambiguous semantics
    if (
      wrapperKind === "Cell" &&
      this.#isStreamType(innerType, context.typeChecker)
    ) {
      throw new Error(
        "Cell<Stream<T>> is unsupported. Wrap the stream: Cell<{ stream: Stream<T> }>.",
      );
    }

    // Apply wrapper semantics (asCell/asOpaque) to the inner schema
    return this.#applyWrapperSemantics(innerSchema, wrapperKind);
  }

  #createArrayItemsOverride(
    arrayType: ts.Type,
    arrayTypeNode: ts.TypeNode | undefined,
    context: GenerationContext,
  ): MutableJSONSchema {
    const base: MutableJSONSchema = { type: "unknown" };
    const elementInfo = getArrayElementInfo(
      arrayType,
      context.typeChecker,
      arrayTypeNode,
    );

    let resolvedElementWrapperKind: "Default" | WrapperKind | undefined;
    if (elementInfo) {
      resolvedElementWrapperKind = elementInfo.elementNode
        ? resolveWrapperNode(elementInfo.elementNode, context.typeChecker)?.kind
        : getCellWrapperInfo(elementInfo.elementType, context.typeChecker)
          ?.kind;
    } else {
      // No element info — e.g. an expanded `Default<[]> | Item[]` union, whose
      // type is not array-like so getArrayElementInfo can't reach the element.
      // The real array member's element capability (e.g. `comparable`) lives on
      // the synthetic NODE, not the resolved union type, so recover it from the
      // node by descending to the real array member's element. (CT-1639 Gap B)
      resolvedElementWrapperKind = this.#elementWrapperFromUnionNode(
        arrayTypeNode,
        context.typeChecker,
      );
    }

    const elementWrapperKind = resolvedElementWrapperKind === "Default"
      ? undefined
      : resolvedElementWrapperKind;
    return elementWrapperKind
      ? this.#applyWrapperSemantics(base, elementWrapperKind)
      : base;
  }

  /**
   * For a synthetic union type node like `ComparableCell<unknown>[] | Default<[]>`
   * (the expanded form of `Writable<Item[] | Default<[]>>`'s inner), find the
   * single real-array member and return the wrapper kind of its element node.
   * Empty-array / `Default<...>` members are skipped. Returns undefined when the
   * node is not a union, has no real array member, or the element is unwrapped.
   */
  #elementWrapperFromUnionNode(
    node: ts.TypeNode | undefined,
    checker: ts.TypeChecker,
  ): "Default" | WrapperKind | undefined {
    if (!node || !ts.isUnionTypeNode(node)) return undefined;
    let elementNode: ts.TypeNode | undefined;
    for (const member of node.types) {
      const arrayElement = this.#arrayElementNode(member);
      if (!arrayElement) continue; // non-array member (e.g. Default<[]>) — skip
      // Skip degenerate empty-array members (`never[]`) — they're the unbranded
      // arm of an expanded `Default<[]>` and carry no real element. (The branded
      // `[] & DefaultMarker` arm and the empty tuple `[]` are not ArrayTypeNodes,
      // so arrayElementNode already returned undefined for them.)
      if (arrayElement.kind === ts.SyntaxKind.NeverKeyword) continue;
      if (elementNode) return undefined; // more than one real array member
      elementNode = arrayElement;
    }
    if (!elementNode) return undefined;
    return resolveWrapperNode(elementNode, checker)?.kind;
  }

  /** The element TypeNode of `T[]` or `Array<T>`/`ReadonlyArray<T>`, else undefined. */
  #arrayElementNode(node: ts.TypeNode): ts.TypeNode | undefined {
    if (ts.isArrayTypeNode(node)) return node.elementType;
    if (
      ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) &&
      (node.typeName.text === "Array" ||
        node.typeName.text === "ReadonlyArray") &&
      node.typeArguments && node.typeArguments.length > 0
    ) {
      return node.typeArguments[0];
    }
    return undefined;
  }

  #isUnusableInnerType(type: ts.Type): boolean {
    return (type.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown |
        ts.TypeFlags.TypeParameter)) !==
      0;
  }

  #innerTypeNeedsNodeAssistance(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): boolean {
    if (this.#isUnusableInnerType(type)) {
      return true;
    }
    const numericIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (!numericIndex) {
      return false;
    }
    return this.#isUnusableInnerType(numericIndex);
  }

  /**
   * Recursively unwrap opaque-branded (OpaqueCell) layers to find a wrapper
   * type (Cell/Stream/etc.). This handles cases like
   * FactoryInput<OpaqueCell<Stream<T>>> where the target is wrapped in multiple
   * opaque-branded layers due to the recursive definition of the FactoryInput
   * type.
   */
  #recursivelyUnwrapOpaqueCell(
    type: ts.Type,
    targetWrapperKind: WrapperKind,
    checker: ts.TypeChecker,
    depth: number = 0,
  ):
    | { type: ts.Type; typeRef: ts.TypeReference; kind: WrapperKind }
    | undefined {
    // Prevent infinite recursion
    if (depth > 10) {
      return undefined;
    }

    // Check if this type itself is the target wrapper
    if ((type.flags & ts.TypeFlags.Union) === 0) {
      const wrapperInfo = getCellWrapperInfo(type, checker);
      if (wrapperInfo && wrapperInfo.kind === targetWrapperKind) {
        return { type, typeRef: wrapperInfo.typeRef, kind: wrapperInfo.kind };
      }
    }

    // If this is a union (e.g., from FactoryInput<T>), check each member
    if (type.flags & ts.TypeFlags.Union) {
      const unionType = type as ts.UnionType;
      for (const member of unionType.types) {
        // Try to unwrap this member
        const result = this.#recursivelyUnwrapOpaqueCell(
          member,
          targetWrapperKind,
          checker,
          depth + 1,
        );
        if (result) return result;
      }
    }

    // If this is an opaque-branded cell, extract its type argument and recurse
    if (this.#isOpaqueCellType(type, checker)) {
      const innerType = this.#extractOpaqueCellTypeArgument(type, checker);
      if (innerType) {
        return this.#recursivelyUnwrapOpaqueCell(
          innerType,
          targetWrapperKind,
          checker,
          depth + 1,
        );
      }
    }

    return undefined;
  }

  /**
   * Extract the base type from FactoryInput<T>.
   */
  #getFactoryInputBase(type: ts.Type): ts.Type | undefined {
    const aliasType = type as TypeWithInternals;
    return aliasType.aliasSymbol?.name === "FactoryInput"
      ? aliasType.aliasTypeArguments?.[0]
      : undefined;
  }

  /**
   * Detects the opaque cell brand, carried by `OpaqueCell<T>`. Named for the
   * brand it matches, not the `Reactive` annotation spelling: that is an
   * identity alias for `T` (no runtime wrapper, no brand), so it cannot be
   * detected structurally here — only `OpaqueCell` can.
   */
  #isOpaqueCellType(type: ts.Type, checker: ts.TypeChecker): boolean {
    return isCellBrand(type, checker, "opaque");
  }

  /**
   * Extract the type argument T from an opaque-branded cell (OpaqueCell<T>).
   */
  #extractOpaqueCellTypeArgument(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): ts.Type | undefined {
    const wrapperInfo = getCellWrapperInfo(type, checker);
    if (
      !wrapperInfo ||
      (wrapperInfo.kind !== "Reactive" && wrapperInfo.kind !== "OpaqueCell")
    ) {
      return undefined;
    }

    const typeArgs = wrapperInfo.typeRef.typeArguments ??
      checker.getTypeArguments(wrapperInfo.typeRef);
    return typeArgs && typeArgs.length > 0 ? typeArgs[0] : undefined;
  }

  #selectWrapperTypeNode(
    originalNode: ts.TypeNode | undefined,
    resolvedWrapper:
      | {
        kind: "Default" | WrapperKind;
        node: ts.TypeReferenceNode;
      }
      | undefined,
    targetKind: WrapperKind,
  ): ts.TypeReferenceNode | undefined {
    if (
      originalNode && ts.isTypeReferenceNode(originalNode) &&
      originalNode.typeArguments
    ) {
      // A generic Cell alias can map its parameters into a larger payload.
      // Only direct Cell syntax names that payload in its first argument.
      if (
        isCellCapabilityKind(targetKind) &&
        resolvedWrapper?.node !== originalNode
      ) {
        return undefined;
      }
      return originalNode;
    }
    if (resolvedWrapper?.kind === targetKind) {
      return resolvedWrapper.node;
    }
    return undefined;
  }

  #isSyntheticWrapperNode(node: ts.Node): boolean {
    return node.pos < 0 || node.end < 0;
  }

  #getTypeRefIdentifierName(
    node?: ts.TypeNode,
  ): string | undefined {
    if (!node || !ts.isTypeReferenceNode(node)) return undefined;
    const tn = node.typeName;
    return ts.isIdentifier(tn) ? tn.text : undefined;
  }

  #isStreamType(type: ts.Type, checker: ts.TypeChecker): boolean {
    return getCellBrand(type, checker) === "stream";
  }

  #formatDefaultType(
    typeRefNode: ts.TypeReferenceNode,
    context: GenerationContext,
    pairedType?: ts.Type,
  ): MutableJSONSchema {
    const typeArgs = typeRefNode.typeArguments;
    if (!typeArgs || typeArgs.length < 1 || typeArgs.length > 2) {
      throw new Error("Default<T,V> requires 1 or 2 type arguments");
    }

    const valueTypeNode = typeArgs[0];
    const defaultTypeNode = typeArgs[1] ?? valueTypeNode;

    if (!valueTypeNode || !defaultTypeNode) {
      throw new Error("Default<T,V> type arguments cannot be undefined");
    }
    // Get the value type from the type nodes
    const valueType = context.typeRegistry?.get(valueTypeNode) ??
      context.typeChecker.getTypeFromTypeNode(valueTypeNode);
    if (typeArgs.length === 1 && this.#isUndefinedType(valueType)) {
      throw new Error(
        "Default<undefined> is unsupported; use an optional field or a JSON value default.",
      );
    }

    // Generate schema for the value type
    const valueSchema = this.#schemaGenerator.formatChildType(
      valueType,
      context,
      valueTypeNode,
    );

    // Extract default value from the default type node (this can handle complex literals)
    let defaultValue = this.#extractDefaultValueFromNode(
      defaultTypeNode,
      context,
    );

    // Node-based extraction fails when V is not spelled literally at this
    // declaration — e.g. a generic-substituted V (`Default<string, P>` inside
    // an instantiated `Tagged<"x">`). The instantiated TYPE's brand payload
    // carries the substituted V (see Default<> in packages/api), so read it
    // back from there.
    if (defaultValue === undefined && pairedType) {
      defaultValue = extractDefaultBrandPayloadValue(
        pairedType,
        context.typeChecker,
      )?.value;
    }

    if (defaultValue !== undefined) {
      // TODO(danfuzz): This attaches a default without checking it against the
      // shape its type stores -- see the marker on the type-based path above,
      // which describes the fabric-backed-native mismatch and needs one answer
      // covering both paths.
      //
      // JSON Schema Draft 2020-12 allows default as a sibling of $ref
      // Simply add the default property directly to the schema
      if (typeof valueSchema === "boolean") {
        // Boolean schemas (true/false) cannot have properties directly
        // For true: { default: value } (any value is valid)
        // For false: { not: true, default: value } (no value is valid)
        return (valueSchema === false
          ? { not: true, default: defaultValue }
          : { default: defaultValue }) as MutableJSONSchemaObj;
      }
      (valueSchema as any).default = defaultValue;
    } else {
      reportUnresolvedDefault(context, defaultTypeNode);
    }

    return valueSchema;
  }

  #formatResolvedCfcAlias(
    resolved: ResolvedCfcAlias,
    context: GenerationContext,
  ): MutableJSONSchema {
    const baseType = resolved.aliasArgs[0];
    if (!baseType) {
      throw new Error(`${resolved.aliasName}<T> requires type argument`);
    }

    const baseTypeNode = resolved.aliasArgNodes?.[0];
    // A payload still referring to a parameter that substitution had an
    // argument for but did not reach would be read with that parameter
    // unbound, so it is a guess.
    const unsubstituted = baseTypeNode !== undefined &&
      resolved.substituted !== undefined &&
      holdsTypeParameter(
        baseTypeNode,
        context.typeChecker,
        resolved.substituted,
      );
    if (unsubstituted) context.uninterpretedTypeNodes?.push(baseTypeNode);
    // A canonical alias reached by its own name resolves no argument nodes; the
    // reference's own arguments are its nodes, the payload's as much as the
    // labels' (`#buildIfcMetadataForAlias` reads them the same way). Read from
    // its type alone, a generic alias in the payload has no argument to bind,
    // and a label nested in it no `typeof` binding or `AnyOf` to recognize.
    const baseSchema = unsubstituted
      ? true
      : baseTypeNode
      ? this.#formatCfcAliasTypeNode(baseTypeNode, context) ??
        this.#schemaGenerator.formatChildType(baseType, context, baseTypeNode)
      : this.#schemaGenerator.formatChildType(
        baseType,
        context,
        this.#getAliasTypeArgumentNode(context, 0),
      );

    const ifc = this.#buildIfcMetadataForAlias(
      resolved.aliasName,
      resolved.aliasArgs,
      context,
      resolved.aliasArgNodes,
    );
    if (ifc === undefined) {
      return baseSchema;
    }

    return this.#mergeIfcMetadata(baseSchema, ifc);
  }

  #formatCfcAliasTypeNode(
    typeNode: ts.TypeNode,
    context: GenerationContext,
  ): MutableJSONSchema | undefined {
    if (
      ts.isParenthesizedTypeNode(typeNode) || ts.isTypeOperatorNode(typeNode)
    ) {
      return this.#formatCfcAliasTypeNode(typeNode.type, context);
    }
    if (!ts.isTypeReferenceNode(typeNode)) {
      return undefined;
    }

    const aliasDeclaration = this.#getTypeAliasDeclarationForSymbol(
      context.typeChecker.getSymbolAtLocation(typeNode.typeName),
      context,
    );
    if (!aliasDeclaration) {
      return undefined;
    }

    const aliasArgNodes = typeNode.typeArguments
      ? [...typeNode.typeArguments]
      : undefined;
    const resolved = this.#resolveCfcAliasFromDeclaration(
      aliasDeclaration,
      undefined,
      aliasArgNodes,
      { ...context, typeNode },
      new Set([aliasDeclaration]),
    );
    return resolved
      ? this.#formatResolvedCfcAlias(resolved, context)
      : undefined;
  }

  #resolveCfcAliasInstantiation(
    typeWithAlias: TypeWithInternals,
    context: GenerationContext,
  ): ResolvedCfcAlias | undefined {
    // The checker can erase a local alias and report an inner alias's type.
    // Its parameters belong to that inner declaration, while `.typeNode`
    // still carries the outer reference's arguments. Start a user alias's
    // substitution from its authored declaration so those pairs agree.
    const reference = context.typeNode &&
      readAuthoredTypeNode(context.typeNode, context.typeChecker);
    if (reference && ts.isTypeReferenceNode(reference)) {
      const declaration = this.#getTypeAliasDeclarationForSymbol(
        context.typeChecker.getSymbolAtLocation(reference.typeName),
        context,
      );
      if (declaration && !CFC_ALIAS_NAMES.has(declaration.name.text)) {
        const nodes = reference.typeArguments ?? [];
        const resolved = this.#resolveCfcAliasFromDeclaration(
          declaration,
          undefined,
          nodes,
          context,
          new Set([declaration]),
        );
        if (resolved) return resolved;
      }
    }

    const aliasName = typeWithAlias.aliasSymbol?.name;
    if (!aliasName) {
      return undefined;
    }
    const aliasArgs = typeWithAlias.aliasTypeArguments ?? [];
    if (CFC_ALIAS_NAMES.has(aliasName)) {
      return { aliasName, aliasArgs };
    }

    const aliasSymbol = typeWithAlias.aliasSymbol;
    const aliasDeclaration = this.#getTypeAliasDeclarationForSymbol(
      aliasSymbol,
      context,
    );
    if (!aliasDeclaration) {
      return undefined;
    }

    return this.#resolveCfcAliasFromDeclaration(
      aliasDeclaration,
      aliasArgs,
      this.#getAliasTypeArgumentNodes(context),
      context,
      new Set([aliasDeclaration]),
    );
  }

  #resolveCfcAliasFromDeclaration(
    aliasDeclaration: ts.TypeAliasDeclaration,
    aliasArgs: readonly ts.Type[] | undefined,
    aliasArgNodes: readonly ts.TypeNode[] | undefined,
    context: GenerationContext,
    visited: Set<ts.TypeAliasDeclaration>,
    substituted: readonly ts.TypeParameterDeclaration[] = [],
  ): ResolvedCfcAlias | undefined {
    const aliasName = aliasDeclaration.name.text;
    if (CFC_ALIAS_NAMES.has(aliasName)) {
      return {
        aliasName,
        // Alias chains substitute syntax until they reach a policy. Only its
        // arguments need checker types; unrelated aliases require no conversion.
        aliasArgs: aliasArgs ??
          (aliasArgNodes ?? []).map((node) =>
            this.#resolveTypeNodeToType(node, context, new Map())
          ),
        ...(aliasArgNodes ? { aliasArgNodes } : {}),
        ...(substituted.length > 0 ? { substituted } : {}),
      };
    }

    // Parentheses around the body denote the same type; a body read raw
    // would not be seen as the policy it holds, and the field would lose its
    // policy and its type together.
    const aliased = unwrapTypeParentheses(aliasDeclaration.type);
    if (!ts.isTypeReferenceNode(aliased)) {
      return undefined;
    }

    const targetDeclaration = this.#getTypeAliasDeclarationForSymbol(
      context.typeChecker.getSymbolAtLocation(aliased.typeName),
      context,
    );
    // Different modules can export the same alias name. A cycle revisits a
    // declaration, not a spelling.
    if (!targetDeclaration || visited.has(targetDeclaration)) {
      return undefined;
    }

    const paramNodeMap = new Map<string, ts.TypeNode>();
    const substitutedHere: ts.TypeParameterDeclaration[] = [];
    for (let i = 0; i < (aliasDeclaration.typeParameters?.length ?? 0); i++) {
      const parameter = aliasDeclaration.typeParameters?.[i];
      const paramName = parameter?.name.text;
      // An argument the reference leaves out is its parameter's default read
      // with the arguments before it, as the checker instantiates one. With no
      // argument nodes at all there is nothing to read that default with.
      const actualArgNode = aliasArgNodes?.[i] ??
        (aliasArgNodes && parameter?.default
          ? substituteTypeNode(parameter.default, paramNodeMap)
          : undefined);
      if (parameter && paramName && actualArgNode) {
        paramNodeMap.set(paramName, actualArgNode);
        substitutedHere.push(parameter);
      }
    }

    const resolvedArgNodes: ts.TypeNode[] = [];
    for (const argNode of aliased.typeArguments ?? []) {
      const resolvedArgNode = substituteTypeNode(argNode, paramNodeMap);
      resolvedArgNodes.push(resolvedArgNode);
    }

    visited.add(targetDeclaration);
    return this.#resolveCfcAliasFromDeclaration(
      targetDeclaration,
      undefined,
      resolvedArgNodes,
      context,
      visited,
      [...substituted, ...substitutedHere],
    );
  }

  #resolveTypeNodeToType(
    typeNode: ts.TypeNode,
    context: GenerationContext,
    paramMap: ReadonlyMap<string, ts.Type>,
  ): ts.Type {
    if (
      ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)
    ) {
      const mapped = paramMap.get(typeNode.typeName.text);
      if (mapped) {
        return mapped;
      }
    }

    const fromRegistry = context.typeRegistry?.get(typeNode);
    if (fromRegistry) {
      return fromRegistry;
    }

    try {
      return context.typeChecker.getTypeFromTypeNode(typeNode);
    } catch {
      return context.typeChecker.getAnyType();
    }
  }

  #getTypeAliasDeclarationForSymbol(
    symbol: ts.Symbol | undefined,
    context: GenerationContext,
  ): ts.TypeAliasDeclaration | undefined {
    const resolved = symbol &&
      resolveAliasedSymbol(symbol, context.typeChecker);
    return resolved?.declarations?.find(
      (decl): decl is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(decl),
    );
  }

  #buildIfcMetadataForAlias(
    aliasName: string,
    aliasArgs: readonly ts.Type[],
    context: GenerationContext,
    aliasArgNodes?: readonly ts.TypeNode[],
  ): Record<string, unknown> | undefined {
    const readValue = (index: number): unknown => {
      return this.#extractLiteralLikeValue(
        aliasArgs[index],
        aliasArgNodes?.[index] ??
          this.#getAliasTypeArgumentNode(context, index),
        context,
      );
    };

    switch (aliasName) {
      case "Cfc": {
        const payload = readValue(1);
        return isObjectOrArray(payload) ? { ...payload } : undefined;
      }
      case "Confidential":
        return { confidentiality: readValue(1) };
      case "Integrity":
        return { integrity: readValue(1) };
      case "AddIntegrity":
        return { addIntegrity: readValue(1) };
      case "RepresentsCurrentUser":
        return {
          addIntegrity: [{
            kind: "represents-principal",
            subject: { __ctCurrentPrincipal: true },
          }],
        };
      case "AuthoredByCurrentUser":
        return {
          addIntegrity: [{
            kind: "authored-by",
            subject: { __ctCurrentPrincipal: true },
          }],
        };
      case "RequiresIntegrity":
        return { requiredIntegrity: readValue(1) };
      case "MaxConfidentiality":
        return { maxConfidentiality: readValue(1) };
      case "ExactCopy":
        return { exactCopyOf: readValue(1) };
      case "WriteAuthorizedBy":
        return this.#buildWriteAuthorizedByMetadata(context, aliasArgNodes);
      case "TrustedActionWriteWithIntegrity":
        return this.#buildTrustedActionWriteMetadata({
          context,
          aliasArgNodes,
          action: readValue(2),
          trustedPattern: readValue(3),
          requiredEventIntegrity: readValue(4),
        });
      case "TrustedActionWrite": {
        const trustedPattern = readValue(3);
        return this.#buildTrustedActionWriteMetadata({
          context,
          aliasArgNodes,
          action: readValue(2),
          trustedPattern,
          requiredEventIntegrity: [trustedPattern],
        });
      }
      case "TrustedActionUiContract": {
        const trustedPattern = readValue(2);
        return {
          uiContract: {
            helper: "UiAction",
            action: readValue(1),
            trustedPattern,
            requiredEventIntegrity: aliasArgs.length > 3
              ? readValue(3)
              : [trustedPattern],
          },
        };
      }
      case "ProjectionPath":
        return this.#buildProjectionMetadata(aliasArgs, context, {
          fromIndex: 1,
          pathIndex: 2,
          defaultFrom: undefined,
        });
      case "ProjectionOf":
        return this.#buildProjectionMetadata(aliasArgs, context, {
          fromIndex: 1,
          pathIndex: 1,
          defaultFrom: "/",
        });
      case "Projection":
        return this.#buildProjectionMetadata(aliasArgs, context, {
          fromIndex: 1,
          pathIndex: 1,
          defaultFrom: "/",
        });
      default:
        return undefined;
    }
  }

  #buildProjectionMetadata(
    aliasArgs: readonly ts.Type[],
    context: GenerationContext,
    options: {
      readonly fromIndex: number;
      readonly pathIndex: number;
      readonly defaultFrom: string | undefined;
    },
  ): Record<string, unknown> | undefined {
    const readValue = (index: number): unknown => {
      return this.#extractLiteralLikeValue(
        aliasArgs[index],
        this.#getAliasTypeArgumentNode(context, index),
        context,
      );
    };

    const from = options.defaultFrom ?? readValue(options.fromIndex);
    const directPath = this.#encodeJsonPointerPath(
      readValue(options.pathIndex),
    );
    if (directPath !== undefined) {
      return {
        projection: {
          from,
          path: directPath,
        },
      };
    }

    const sourceRefType = aliasArgs[0] as TypeWithInternals | undefined;
    const sourceRefNode = this.#getAliasTypeArgumentNode(context, 0);
    const nestedPathType = sourceRefType?.aliasTypeArguments?.[1];
    const nestedPathNode =
      sourceRefNode && ts.isTypeReferenceNode(sourceRefNode)
        ? sourceRefNode.typeArguments?.[1]
        : undefined;
    const nestedPath = this.#encodeJsonPointerPath(
      this.#extractLiteralLikeValue(nestedPathType, nestedPathNode, context),
    );
    if (nestedPath === undefined) {
      return undefined;
    }

    return {
      projection: {
        from,
        path: nestedPath,
      },
    };
  }

  #buildWriteAuthorizedByMetadata(
    context: GenerationContext,
    aliasArgNodes?: readonly ts.TypeNode[],
  ): Record<string, unknown> | undefined {
    return this.#buildWriteAuthorizedByMetadataForArg(
      context,
      aliasArgNodes,
      1,
    );
  }

  #buildTrustedActionWriteMetadata(
    options: {
      context: GenerationContext;
      aliasArgNodes: readonly ts.TypeNode[] | undefined;
      action: unknown;
      trustedPattern: unknown;
      requiredEventIntegrity: unknown;
    },
  ): Record<string, unknown> | undefined {
    const writeMetadata = this.#buildWriteAuthorizedByMetadataForArg(
      options.context,
      options.aliasArgNodes,
      1,
    );
    return {
      ...(writeMetadata ?? {}),
      uiContract: {
        helper: "UiAction",
        action: options.action,
        trustedPattern: options.trustedPattern,
        requiredEventIntegrity: options.requiredEventIntegrity,
      },
    };
  }

  #buildWriteAuthorizedByMetadataForArg(
    context: GenerationContext,
    aliasArgNodes: readonly ts.TypeNode[] | undefined,
    bindingIndex: number,
  ): Record<string, unknown> | undefined {
    // The binding itself must be a direct `typeof` (cfc_authoring_contract.md);
    // `WriteAuthorizedByValidationTransformer` reports any other spelling.
    const bindingNode = aliasArgNodes?.[bindingIndex] ??
      this.#getAliasTypeArgumentNode(context, bindingIndex);
    if (!bindingNode || !ts.isTypeQueryNode(bindingNode)) {
      return undefined;
    }
    if (!ts.isIdentifier(bindingNode.exprName)) {
      return undefined;
    }

    return {
      writeAuthorizedBy: {
        __ctWriterIdentityOf: this.#writeAuthorizedByIdentityForBinding(
          context,
          bindingNode.exprName,
        ),
      },
    };
  }

  #writeAuthorizedByIdentityForBinding(
    context: GenerationContext,
    bindingName: ts.Identifier,
    normalizeFile = true,
  ): { file: string; path: string[]; moduleIdentity?: string } {
    // The file this lands on becomes the writer's module identity, so the
    // binding is resolved to its DECLARATION: a claim that fell back to the
    // importing file would attribute authority to the wrong module. The
    // fallback below is for a binding the checker cannot resolve at all.
    const binding = resolveWriterBinding(bindingName, context.typeChecker);
    const declaredName = binding?.name ?? bindingName.text;
    const sourceFileName = binding?.fileName ??
      bindingName.getSourceFile().fileName ??
      context.sourceFileName ??
      "unknown";

    if (normalizeFile && context.writerIdentityForSourceFile) {
      return {
        ...context.writerIdentityForSourceFile(sourceFileName),
        path: [declaredName],
      };
    }

    return {
      file: normalizeFile
        ? normalizeWriterIdentityFile(sourceFileName)
        : sourceFileName.replace(/\\/g, "/"),
      path: [declaredName],
    };
  }

  #getAliasTypeArgumentNode(
    context: GenerationContext,
    index: number,
  ): ts.TypeNode | undefined {
    return this.#getAliasTypeArgumentNodes(context)?.[index];
  }

  /**
   * The type arguments written on the reference being formatted. The
   * reference is read through parentheses and plain aliases
   * (`readAuthoredTypeNode()`): `type Name = Owned<string, typeof setName>`
   * holds the arguments that `Name` stands for, and a policy read from the
   * bare `Name` would find none and drop the writer binding without a word.
   */
  #getAliasTypeArgumentNodes(
    context: GenerationContext,
  ): readonly ts.TypeNode[] | undefined {
    const typeNode = context.typeNode &&
      readAuthoredTypeNode(context.typeNode, context.typeChecker);
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
      return undefined;
    }
    return typeNode.typeArguments ? [...typeNode.typeArguments] : undefined;
  }

  #mergeIfcMetadata(
    schema: MutableJSONSchema,
    ifc: Record<string, unknown>,
  ): MutableJSONSchema {
    if (typeof schema === "boolean") {
      return schema === false ? { not: true, ifc } : { ifc };
    }

    const existingIfc = isObjectOrArray(schema.ifc) ? schema.ifc : {};
    return { ...schema, ifc: combineIfcLabels(existingIfc, ifc) };
  }

  #encodeJsonPointerPath(value: unknown): string | undefined {
    if (typeof value === "string") {
      return value;
    }
    if (
      Array.isArray(value) &&
      value.every((segment) => typeof segment === "string")
    ) {
      if (value.length === 0) {
        return "/";
      }
      return `/${
        value.map((segment) =>
          segment.replaceAll("~", "~0").replaceAll("/", "~1")
        ).join("/")
      }`;
    }
    return undefined;
  }

  #extractLiteralLikeValue(
    type: ts.Type | undefined,
    typeNode: ts.TypeNode | undefined,
    context: GenerationContext,
  ): unknown {
    if (!typeNode && !type) {
      return undefined;
    }

    if (typeNode) {
      if (ts.isParenthesizedTypeNode(typeNode)) {
        return this.#extractLiteralLikeValue(type, typeNode.type, context);
      }
      if (ts.isTypeOperatorNode(typeNode)) {
        return this.#extractLiteralLikeValue(type, typeNode.type, context);
      }
      if (ts.isTypeQueryNode(typeNode)) {
        return this.#extractValueFromTypeQuery(typeNode, context);
      }
      if (ts.isLiteralTypeNode(typeNode)) {
        const literal = typeNode.literal;
        if (ts.isStringLiteral(literal)) return literal.text;
        if (ts.isNumericLiteral(literal)) return Number(literal.text);
        if (literal.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (literal.kind === ts.SyntaxKind.FalseKeyword) return false;
        if (literal.kind === ts.SyntaxKind.NullKeyword) return null;
      }
      if (ts.isTupleTypeNode(typeNode)) {
        return typeNode.elements.map((element) =>
          this.#extractLiteralLikeValue(undefined, element, context)
        );
      }
      if (ts.isTypeReferenceNode(typeNode)) {
        const referencedName = this.#resolveTypeReferenceName(
          typeNode.typeName,
          context,
        );
        if (referencedName === "AnyOf") {
          const alternativesNode = typeNode.typeArguments?.[0];
          const alternatives = this.#extractLiteralLikeValue(
            undefined,
            alternativesNode,
            context,
          );
          return Array.isArray(alternatives)
            ? { anyOf: alternatives }
            : undefined;
        }
        if (referencedName === "PolicyOf") {
          const bindingNode = typeNode.typeArguments?.[0];
          if (
            bindingNode && ts.isTypeQueryNode(bindingNode) &&
            ts.isIdentifier(bindingNode.exprName)
          ) {
            return {
              type: CFC_ATOM_TYPE.Policy,
              policyRefKind: "module",
              __ctPolicyIdentityOf: this.#writeAuthorizedByIdentityForBinding(
                context,
                bindingNode.exprName,
                false,
              ),
              subject: { __ctOwningSpace: true },
            };
          }
          return undefined;
        }
        const aliasDeclaration = this.#getTypeAliasDeclarationForSymbol(
          context.typeChecker.getSymbolAtLocation(typeNode.typeName),
          context,
        );
        if (aliasDeclaration) {
          const paramMap = new Map<string, ts.TypeNode>();
          for (
            let i = 0;
            i < (aliasDeclaration.typeParameters?.length ?? 0);
            i++
          ) {
            const paramName = aliasDeclaration.typeParameters?.[i]?.name.text;
            const actualArgNode = typeNode.typeArguments?.[i];
            if (paramName && actualArgNode) {
              paramMap.set(paramName, actualArgNode);
            }
          }
          return this.#extractLiteralLikeValue(
            undefined,
            substituteTypeNode(aliasDeclaration.type, paramMap),
            context,
          );
        }
      }
      if (ts.isTypeLiteralNode(typeNode)) {
        const obj: Record<string, unknown> = {};
        for (const member of typeNode.members) {
          if (ts.isPropertySignature(member) && member.name && member.type) {
            const propName = getPropertyNameText(member.name);
            if (!propName) continue;
            obj[propName] = this.#extractLiteralLikeValue(
              undefined,
              member.type,
              context,
            );
          }
        }
        return obj;
      }
      if (typeNode.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (typeNode.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (typeNode.kind === ts.SyntaxKind.NullKeyword) return null;
      if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
    }

    if (!type) {
      return undefined;
    }

    if (type.flags & ts.TypeFlags.StringLiteral) {
      return (type as ts.StringLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      return (type as ts.NumberLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return (type as { intrinsicName?: string }).intrinsicName === "true";
    }
    if (type.flags & ts.TypeFlags.Null) {
      return null;
    }
    if (type.flags & ts.TypeFlags.Undefined) {
      return undefined;
    }

    const typeText = context.typeChecker.typeToString(type);
    if (
      typeText.length >= 2 &&
      ((typeText.startsWith('"') && typeText.endsWith('"')) ||
        (typeText.startsWith("'") && typeText.endsWith("'")))
    ) {
      return typeText.slice(1, -1);
    }

    if (context.typeChecker.isTupleType(type)) {
      const tupleType = type as ts.TypeReference;
      const elements = context.typeChecker.getTypeArguments(tupleType);
      if (elements.length > 0) {
        return elements.map((element) =>
          this.#extractLiteralLikeValue(element, undefined, context)
        );
      }
    }

    const objectFlags =
      (type as { objectFlags?: ts.ObjectFlags }).objectFlags ??
        0;
    if ((objectFlags & ts.ObjectFlags.Tuple) !== 0) {
      const tupleType = type as ts.TypeReference;
      const elements = context.typeChecker.getTypeArguments(tupleType);
      if (elements.length > 0) {
        return elements.map((element) =>
          this.#extractLiteralLikeValue(element, undefined, context)
        );
      }
    }

    if ((type.flags & ts.TypeFlags.Object) !== 0) {
      const properties = context.typeChecker.getPropertiesOfType(type);
      if (properties.length > 0) {
        const obj: Record<string, unknown> = {};
        for (const property of properties) {
          const propType = context.typeChecker.getTypeOfSymbolAtLocation(
            property,
            property.valueDeclaration ?? property.declarations?.[0] ??
              context.typeNode ?? ({} as ts.Node),
          );
          obj[property.getName()] = this.#extractLiteralLikeValue(
            propType,
            undefined,
            context,
          );
        }
        return obj;
      }
    }

    return undefined;
  }

  #resolveTypeReferenceName(
    typeName: ts.EntityName,
    context: GenerationContext,
  ): string | undefined {
    const symbol = context.typeChecker.getSymbolAtLocation(typeName);
    const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias)
      ? context.typeChecker.getAliasedSymbol(symbol)
      : symbol;
    const name = resolved?.name ??
      (ts.isIdentifier(typeName) ? typeName.text : typeName.right.text);
    // Qualified metadata receives canonical lowering only for library symbols;
    // an authored namespace member is read from its own declaration instead.
    if (ts.isQualifiedName(typeName)) {
      // In `outer.cf.AnyOf`, `outer.cf` may re-export the library namespace.
      const qualifier = context.typeChecker.getSymbolAtLocation(typeName.left);
      if (
        !resolved ||
        (!isCommonFabricSymbol(resolved) &&
          !isImportedFromCommonFabric(symbol, context.typeChecker) &&
          !isImportedFromCommonFabric(qualifier, context.typeChecker))
      ) {
        return undefined;
      }
    }
    return name;
  }

  #extractDefaultValueFromNode(
    typeNode: ts.TypeNode,
    context: GenerationContext,
  ): unknown {
    // Handle typeof expressions (TypeQuery nodes)
    // These reference a variable's value, like: typeof defaultRoutes
    if (ts.isTypeQueryNode(typeNode)) {
      return this.#extractValueFromTypeQuery(typeNode, context);
    }

    // Handle literal types
    if (ts.isLiteralTypeNode(typeNode)) {
      const literal = typeNode.literal;
      if (ts.isStringLiteral(literal)) return literal.text;
      if (ts.isNumericLiteral(literal)) return Number(literal.text);
      if (literal.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (literal.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (literal.kind === ts.SyntaxKind.NullKeyword) return null;
    }

    // Handle array literals (tuples) like [1, 2] or ["item1", "item2"]
    if (ts.isTupleTypeNode(typeNode)) {
      const values: unknown[] = [];
      for (const element of typeNode.elements) {
        const value = this.#extractDefaultValueFromNode(element, context);
        if (value === undefined) return undefined;
        values.push(value);
      }
      return values;
    }

    if (ts.isTypeLiteralNode(typeNode)) {
      const obj: Record<string, unknown> = {};
      for (const member of typeNode.members) {
        if (!ts.isPropertySignature(member) || !member.name || !member.type) {
          const type = context.typeRegistry?.get(typeNode) ??
            context.typeChecker.getTypeFromTypeNode(typeNode);
          return isEmptyObjectDefaultType(type, context.typeChecker)
            ? {}
            : undefined;
        }
        const propName = getPropertyNameText(member.name, context.typeChecker);
        if (propName === undefined) return undefined;
        const value = this.#extractDefaultValueFromNode(member.type, context);
        if (value === undefined) return undefined;
        Object.defineProperty(obj, propName, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return obj;
    }

    // Handle keywords
    if (typeNode.kind === ts.SyntaxKind.NullKeyword) return null;
    if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;

    // Fallback: try to get the type and extract from it
    const type = context.typeRegistry?.get(typeNode) ??
      context.typeChecker.getTypeFromTypeNode(typeNode);
    return this.#extractDefaultValue(type, context);
  }

  #extractDefaultValue(
    type: ts.Type,
    context: GenerationContext,
  ): unknown {
    // First try simple literal extraction
    if (type.flags & ts.TypeFlags.StringLiteral) {
      return (type as ts.StringLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      return (type as ts.NumberLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return (type as any).intrinsicName === "true";
    }
    if (type.flags & ts.TypeFlags.Null) {
      return null;
    }
    if (type.flags & ts.TypeFlags.Undefined) {
      return undefined;
    }

    // Empty type literals and mapped records need no value declaration.
    if (isEmptyObjectDefaultType(type, context.typeChecker)) {
      return {};
    }

    // For complex values (arrays/objects), try to extract from the type's symbol
    // This is a simplified approach that works for many cases
    const symbol = type.getSymbol();
    if (symbol && symbol.valueDeclaration) {
      return this.#extractComplexDefaultFromTypeSymbol(type, symbol, context);
    }

    return undefined;
  }

  #extractValueFromTypeQuery(
    typeQueryNode: ts.TypeQueryNode,
    context: GenerationContext,
  ): unknown {
    // Get the entity name being queried (e.g., "defaultRoutes" in "typeof defaultRoutes")
    const exprName = typeQueryNode.exprName;

    // Get the symbol for the referenced entity
    const symbol = context.typeChecker.getSymbolAtLocation(exprName);
    if (!symbol) {
      return undefined;
    }

    return this.#extractValueFromSymbol(symbol, context);
  }

  /**
   * Extract a runtime value from a symbol's value declaration.
   * Works for variables with initializers like: const foo = [1, 2, 3]
   */
  #extractValueFromSymbol(
    symbol: ts.Symbol,
    context: GenerationContext,
  ): unknown {
    return extractLiteralValueOfSymbol(symbol, context.typeChecker)?.value;
  }

  #extractComplexDefaultFromTypeSymbol(
    type: ts.Type,
    symbol: ts.Symbol,
    context: GenerationContext,
  ): unknown {
    // Try to extract from the symbol's value declaration initializer (AST-based)
    const extracted = this.#extractValueFromSymbol(symbol, context);
    if (extracted !== undefined) {
      return extracted;
    }

    // Check if this is an empty object type (no properties, object type)
    if (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      context.typeChecker.getPropertiesOfType(type).length === 0
    ) {
      return {};
    }

    return undefined;
  }

  /**
   * Check if a type is the undefined type.
   * Extracted for clarity and consistency with UnionFormatter.
   */
  #isUndefinedType(type: ts.Type): boolean {
    return (type.flags & ts.TypeFlags.Undefined) !== 0;
  }

  /**
   * Apply wrapper semantics to a schema, handling boolean schemas correctly.
   * Boolean schemas (true/false) can't have properties spread into them.
   */
  #applyWrapperSemantics(
    schema: MutableJSONSchema,
    wrapperKind: WrapperKind,
  ): MutableJSONSchema {
    const propertyValue = wrapperKindToBrand(wrapperKind);
    // If we couldn't determine a valid wrapper brand, return the schema as-is
    if (propertyValue === undefined) {
      return schema;
    }

    if (typeof schema === "boolean") {
      return schema === false
        ? { asCell: [propertyValue], not: true }
        : { asCell: [propertyValue] };
    }
    if (schema.asCell !== undefined) {
      return { ...schema, asCell: [propertyValue, ...schema.asCell] };
    }
    return { ...schema, asCell: [propertyValue] };
  }

  /**
   * Return a single schema or wrap multiple schemas in anyOf.
   * Handles empty array by returning true (any value is valid).
   * Deduplicates identical schemas before wrapping.
   */
  #maybeWrapInAnyOf(
    schemas: MutableJSONSchema[],
  ): MutableJSONSchema {
    if (schemas.length === 0) {
      return true;
    } else if (schemas.length === 1) {
      return schemas[0]!;
    } else {
      // Deduplicate identical schemas. `valueEqual` (Object.is at leaves) is
      // the honest comparison: a `JSON.stringify` dedup key collides distinct
      // values (`-0`/`0`, `NaN`/`Infinity`) and is key-order sensitive.
      const unique = dedupeByValueEqual(schemas);

      if (unique.length === 1) {
        return unique[0]!;
      }
      return { anyOf: unique };
    }
  }

  /**
   * Format a union type that contains wrapper types (Cell/Reactive/Stream).
   * Handles cases like: Reactive<T> | undefined, Cell<T> | null, etc.
   * Uses nodes when available to preserve named type hoisting.
   */
  #formatWrapperUnion(
    unionType: ts.UnionType,
    context: GenerationContext,
  ): MutableJSONSchema {
    const members = unionType.types;
    const schemas: MutableJSONSchema[] = [];

    // Check if we have a UnionTypeNode with member nodes
    const hasUnionNode = context.typeNode &&
      ts.isUnionTypeNode(context.typeNode);
    const unionNode = hasUnionNode
      ? context.typeNode as ts.UnionTypeNode
      : undefined;

    // Process each union member
    for (let i = 0; i < members.length; i++) {
      const memberType = members[i]!;
      const memberNode = unionNode?.types[i];

      // A scope wrapper around a cell formats as the cell alone, dropping the
      // scope before it reaches the schema — so the structural check on the
      // finished schema would have nothing left to reject. Catch it here,
      // where the wrapper is still visible.
      const memberScope = resolveScopeWrapperNode(memberNode)?.scope ??
        scopeForWrapperName(
          (memberType as TypeWithInternals).aliasSymbol?.name,
        );
      if (memberScope !== undefined) {
        throw scopeInsideUnionError(memberScope);
      }

      // Include undefined as an explicit type in the schema
      if (this.#isUndefinedType(memberType)) {
        schemas.push({ type: "undefined" });
        continue;
      }

      // Skip conditional types - they come from type expansion internals and shouldn't be formatted
      // Example: T extends (infer U)[] ? FactoryInput<U>[] : T extends object ? { [K in keyof T]: FactoryInput<T[K]>; } : T
      if ((memberType.flags & ts.TypeFlags.Conditional) !== 0) {
        continue;
      }

      // Skip type parameters - they're generic placeholders, not concrete types
      if ((memberType.flags & ts.TypeFlags.TypeParameter) !== 0) {
        continue;
      }

      // Handle null - it should be included in the schema as { type: "null" }
      if ((memberType.flags & ts.TypeFlags.Null) !== 0) {
        schemas.push({ type: "null" });
        continue;
      }

      // Check if this member is a wrapper type via type structure
      const wrapperInfo = getCellWrapperInfo(memberType, context.typeChecker);

      if (wrapperInfo) {
        // Format as a wrapper type
        // Try to get the wrapper node for better processing
        const wrapperNodeInfo = memberNode
          ? resolveWrapperNode(memberNode, context.typeChecker)
          : undefined;

        const schema = this.#formatWrapperType(
          wrapperInfo.typeRef,
          wrapperNodeInfo?.node, // Pass node if available for proper name hoisting
          context,
          wrapperInfo.kind,
        );
        schemas.push(schema);
      } else {
        // Not a wrapper - use standard formatting
        // Pass the member node if available to preserve named type hoisting
        const schema = this.#schemaGenerator.formatChildType(
          memberType,
          context,
          memberNode, // Pass node to preserve named type information
        );
        schemas.push(schema);
      }
    }

    return this.#maybeWrapInAnyOf(schemas);
  }

  /**
   * Check if this is a wrapper union (WrapperType | null/undefined).
   * Uses type-based detection which handles complex cases like intersection types
   * and conditional type expansions.
   * Returns true ONLY for unions where ALL non-null/undefined members are wrapper types.
   * Examples that return true: Reactive<T> | undefined, Cell<T> | null, Stream<T> | null | undefined
   * Examples that return false: string | Cell | null (mixed union, should use UnionFormatter)
   */
  #isWrapperUnion(type: ts.Type, context: GenerationContext): boolean {
    // Must be a union type
    if ((type.flags & ts.TypeFlags.Union) === 0) {
      return false;
    }

    const unionType = type as ts.UnionType;

    // Check if ALL non-null/undefined members are wrapper types
    // This ensures we only handle patterns like `Cell<T> | null`, not mixed unions like `string | Cell | null`
    let hasWrapperMember = false;
    let hasNonWrapperMember = false;

    for (const memberType of unionType.types) {
      // Skip undefined and null - they're modifiers, not members
      if (
        this.#isUndefinedType(memberType) ||
        (memberType.flags & ts.TypeFlags.Null) !== 0
      ) {
        continue;
      }

      // Skip conditional types and type parameters (from type expansion internals)
      if (
        (memberType.flags & ts.TypeFlags.Conditional) !== 0 ||
        (memberType.flags & ts.TypeFlags.TypeParameter) !== 0
      ) {
        continue;
      }

      // Check if this member is a wrapper type
      const wrapperInfo = getCellWrapperInfo(memberType, context.typeChecker);
      if (wrapperInfo !== undefined) {
        hasWrapperMember = true;
      } else {
        hasNonWrapperMember = true;
      }
    }

    // Only handle as wrapper union if we have wrapper members and NO non-wrapper members
    // This excludes mixed unions like `string | number | Cell | Stream | null`
    return hasWrapperMember && !hasNonWrapperMember;
  }
}

function normalizeWriterIdentityFile(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/");
  const strippedPrefixed = normalized.match(/^\/[^/]+(\/.+)$/)?.[1];
  return strippedPrefixed ?? normalized;
}
