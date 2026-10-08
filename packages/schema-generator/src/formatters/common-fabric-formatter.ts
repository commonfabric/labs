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
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import ts from "typescript";

import { reportUnresolvedDefault } from "../default-diagnostics.ts";
import type {
  BoundTypeArgument,
  BoundTypeParameters,
  GenerationContext,
  TypeFormatter,
} from "../interface.ts";
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
  entityNameRight,
  holdsFreeTypeParameter,
  holdsTypeParameter,
  readMemberAnnotation,
  readThroughIdentityAliases,
  typeParameterOfReference,
  typeParameterOfType,
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
import { hasDefaultMarker } from "../typescript/default-brand.ts";
import { isDefaultLibrarySourceFile } from "../typescript/default-library.ts";
import { isDefaultAliasSymbol } from "../typescript/property-optionality.ts";
import {
  CFC_CARRIER_PROPERTY,
  cfcCarrierProperty,
} from "../typescript/cfc-carrier.ts";
import {
  getScopeBrand,
  hasNestedScopeBrands,
  isScopeBrandMember,
  SCOPE_WRAPPER_FOR_SCOPE,
  type ScopeBrand,
  scopeForWrapperName,
  scopePayloadType,
} from "../typescript/scope-brand.ts";
import { dedupeByValueEqual } from "../value-equality.ts";
import {
  scopeAroundCellUnionError,
  scopeInsideUnionError,
} from "../scope-placement.ts";
import { withIfcLabels } from "../ifc-labels.ts";
import {
  holdsUnreadLabel,
  holdsUnreadMetadataLabel,
  reportUnreadLabel,
} from "../unread-label-diagnostics.ts";
import { reportUnreadWriterBinding } from "../writer-binding-diagnostics.ts";
import {
  bindWrittenArgument,
  usesParameterUnreachably,
} from "../type-parameter-bindings.ts";

type WrapperKind = CellWrapperKind;
const CFC_ALIAS_NAMES: ReadonlySet<string> = new Set(CFC_CANONICAL_ALIAS_NAMES);

/** The aliases a `WritePolicyAnyOf` member may be, each a whole writer policy. */
const WRITER_POLICY_ALIAS_NAMES: ReadonlySet<string> = new Set([
  "WriteAuthorizedBy",
  "TrustedActionWrite",
  "TrustedActionWriteWithIntegrity",
]);
/** The property `AnyOf<X>` is as a type (`@commonfabric/api/cfc`). */
const CFC_ANY_OF_BRAND = "__ct_cfc_any_of__";

/** The property `PolicyOf<Rules>` is as a type (`@commonfabric/api/cfc`). */
const CFC_POLICY_OF_BRAND = "__ct_cfc_policy_of__";
/**
 * What the literal reader returns for syntax it does not evaluate, so that the
 * type paired with that syntax is read in its place. `undefined` is a value it
 * reads (`undefined` written as a type), so it cannot stand for this.
 */
const UNREAD: unique symbol = Symbol("unread syntax");

/**
 * Whether `name`, an alias this formatter lowers, is lowered from its syntax.
 * That is every one but `Projection`, a conditional type: what it is depends on
 * its argument (a `Ref<Root, Path>` projects to `ProjectionOf<Root, Path>`,
 * anything else to `never`, a union member by member), so the lowering reads
 * the type the checker resolves it to, as it does the direct spelling.
 */
const lowersFromSyntax = (name: string): boolean => name !== "Projection";

/**
 * The type of the value `member` holds, given `type`, its type: `type` less
 * the `undefined` that an optional member's `?` adds.
 */
function memberValueType(
  member: ts.Symbol,
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type {
  if ((member.flags & ts.SymbolFlags.Optional) === 0 || !type.isUnion()) {
    return type;
  }
  // `getNonNullableType` also removes a `null`, which `?` does not add.
  return type.types.some((part) => (part.flags & ts.TypeFlags.Null) !== 0)
    ? type
    : checker.getNonNullableType(type);
}

const SCOPE_WRAPPER_NAMES: ReadonlySet<string> = new Set(
  Object.values(SCOPE_WRAPPER_FOR_SCOPE),
);

/** The aliases this formatter lowers when a chain of aliases reaches one. */
const CHAIN_LOWERED_ALIAS_NAMES: ReadonlySet<string> = new Set([
  ...CFC_ALIAS_NAMES,
  ...SCOPE_WRAPPER_NAMES,
]);

/**
 * The alias at the end of a chain of aliases, each the whole body of the one
 * before, with the arguments it is instantiated with there.
 */
type ResolvedAliasChain = {
  readonly aliasName: string;
  readonly aliasArgs: readonly ts.Type[];
  /**
   * The node of each argument, `undefined` for one that has a type and no
   * node. Absent for a canonical alias reached by its own name, whose nodes
   * are the reference's own.
   */
  readonly aliasArgNodes?: readonly (ts.TypeNode | undefined)[];
  /** The parameters along the chain given a type and no node. */
  readonly parameterTypes?: ParameterTypes;
  /**
   * The payload, `aliasName`'s first argument, as the last alias along the
   * chain writes it, with the bindings of that alias's parameters it is read
   * under. Absent for a canonical alias reached by its own name, whose payload
   * is the reference's own argument.
   */
  readonly payload?: WrittenArgument;
  /**
   * The type the chain instantiates, where the reference being formatted has
   * one. It holds the innermost payload with every argument in
   * (`cfcPayloadOf()`).
   */
  readonly instantiated?: ts.Type;
  /**
   * Set where the chain is entered with its arguments as their author wrote
   * them, whose syntax can say what `instantiated` does not.
   */
  readonly argumentsWritten?: true;
};

/**
 * A type argument as written, with the bindings of the parameters of the
 * declaration it is written in, absent where it is written under none.
 */
type WrittenArgument = {
  readonly node: ts.TypeNode;
  readonly bound?: BoundTypeParameters;
};

/** A reference's type arguments as written, and the bindings they are under. */
type WrittenArguments = {
  readonly nodes: readonly ts.TypeNode[];
  readonly bound?: BoundTypeParameters;
};

/**
 * Types for type parameters whose argument has a type but no node, as a chain
 * of aliases entered from a type has none, keyed by declaration: a node read
 * inside one alias's declaration may still refer to another's parameter.
 */
type ParameterTypes = ReadonlyMap<ts.TypeParameterDeclaration, ts.Type>;

const NO_PARAMETER_TYPES: ParameterTypes = new Map();

type ResolvedScopeWrapper = {
  readonly scope: SchemaScope;
  readonly node: ts.TypeReferenceNode;
};

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

/**
 * The scope wrapper `typeNode` names by its spelling, bare or qualified, with
 * the reference that names it.
 */
export const resolveScopeWrapperNode = (
  typeNode: ts.TypeNode | undefined,
): ResolvedScopeWrapper | undefined => {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const scope = scopeForWrapperName(entityNameRight(typeNode.typeName).text);
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
    // A cell another scope's wrapper caps is a wrapper nested in another with
    // no cell between them, whose scope would replace the cap.
    if (entry.scope !== undefined && entry.scope !== scope) {
      throw nestedScopeError();
    }
    return { ...entry, scope };
  }
  return entry;
};

/** Whether `schema` declares a cell: an object with an `asCell` entry. */
const isHandleSchema = (schema: unknown): boolean =>
  isObjectNotArray(schema) &&
  Array.isArray((schema as MutableJSONSchemaObj).asCell) &&
  ((schema as MutableJSONSchemaObj).asCell as unknown[]).length > 0;

/** Whether `schema` is `{ type: "null" }` or `{ type: "undefined" }` alone. */
const isNullishSchema = (schema: unknown): boolean =>
  isObjectNotArray(schema) &&
  Object.keys(schema).length === 1 &&
  ((schema as { type?: unknown }).type === "null" ||
    (schema as { type?: unknown }).type === "undefined");

/** Whether `node`, through parentheses, is `null` or `undefined`. */
const isNullishTypeNode = (node: ts.TypeNode): boolean => {
  const unwrapped = unwrapTypeParentheses(node);
  return unwrapped.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(unwrapped) &&
      unwrapped.literal.kind === ts.SyntaxKind.NullKeyword);
};

/**
 * The scope of the wrappers `node`, a union, writes beside `null` or
 * `undefined`, as `PerUser<A> | null` does, which is the scope wrapper around
 * the union of their payloads, `PerUser<A | null>`: each member is `null`,
 * `undefined`, or a wrapper of that one scope naming its payload, and at
 * least one is a wrapper. `undefined` for any other union.
 */
export const scopeOfWrittenScopedUnion = (
  node: ts.UnionTypeNode,
): SchemaScope | undefined => {
  let scope: SchemaScope | undefined;
  for (const member of node.types) {
    if (isNullishTypeNode(member)) continue;
    const wrapper = resolveScopeWrapperNode(member);
    if (
      !wrapper?.node.typeArguments?.length ||
      (scope !== undefined && wrapper.scope !== scope)
    ) {
      return undefined;
    }
    scope = wrapper.scope;
  }
  return scope;
};

/** The error for a scope wrapper nested in another with no cell between. */
const nestedScopeError = (): Error =>
  new Error("Nested scope wrappers require a cell boundary between scopes.");

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
 * The one branch of the conditional type `body` that is not `never`, reached
 * through nested conditionals and parentheses, when it is a reference. The
 * checker resolves `body` to that branch or to `never`, so an alias it
 * resolves `body` to is that branch's. With it come the type parameters that
 * the checker may bind differently from what is written: each of `parameters`
 * a conditional checks, which it reads member by member over a union, and each
 * one a conditional infers.
 */
const soleConditionalBranch = (
  body: ts.TypeNode,
  checker: ts.TypeChecker,
  parameters: readonly ts.TypeParameterDeclaration[],
):
  | {
    branch: ts.TypeReferenceNode;
    unreadable: ts.TypeParameterDeclaration[];
  }
  | undefined => {
  if (!ts.isConditionalTypeNode(unwrapTypeParentheses(body))) return undefined;
  const leaves: ts.TypeNode[] = [];
  const unreadable: ts.TypeParameterDeclaration[] = [];
  const collectInferred = (node: ts.Node): void => {
    if (ts.isInferTypeNode(node)) unreadable.push(node.typeParameter);
    ts.forEachChild(node, collectInferred);
  };
  const visit = (node: ts.TypeNode): void => {
    const bare = unwrapTypeParentheses(node);
    if (!ts.isConditionalTypeNode(bare)) {
      if (bare.kind !== ts.SyntaxKind.NeverKeyword) leaves.push(bare);
      return;
    }
    for (const parameter of parameters) {
      if (holdsTypeParameter(bare.checkType, checker, new Set([parameter]))) {
        unreadable.push(parameter);
      }
    }
    collectInferred(bare.extendsType);
    visit(bare.trueType);
    visit(bare.falseType);
  };
  visit(body);
  const [branch] = leaves;
  return leaves.length === 1 && branch && ts.isTypeReferenceNode(branch)
    ? { branch, unreadable }
    : undefined;
};

/**
 * The default-library aliases that map an object's members, which fold a
 * labelled operand's carrier into the object they build as one more member.
 */
const MEMBER_MAPPING_LIBRARY_ALIASES: ReadonlySet<string> = new Set([
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
]);

/**
 * The member-mapping aliases that leave a primitive as it is, as TypeScript's
 * homomorphic mapped types do: `Readonly<string>` is `string`.
 */
const PRIMITIVE_KEEPING_LIBRARY_ALIASES: ReadonlySet<string> = new Set([
  "Readonly",
  "Partial",
  "Required",
]);

/**
 * The innermost payload of `type`, a CFC alias chain's instantiation, or
 * `undefined` where it cannot be told apart. Every CFC alias adds its metadata
 * to its payload as one more member of an intersection, a carrier holding only
 * `__ct_cfc__`, so the intersection's one other member is the payload, its
 * arguments in wherever the declaration wrote a parameter. A payload that is
 * itself an intersection, or a union, which the intersection distributes over,
 * has no one other member.
 */
const cfcPayloadOf = (type: ts.Type): ts.Type | undefined => {
  if (!type.isIntersection()) return undefined;
  // An intersection has two members at least, so one left means a carrier.
  const rest = type.types.filter((member) => !cfcCarrierProperty(member));
  return rest.length === 1 ? rest[0] : undefined;
};

/**
 * Whether `member`, a member of an intersection, is a CFC metadata carrier,
 * which holds no part of the value.
 */
export const isCfcCarrier = (member: ts.Type): boolean =>
  cfcCarrierProperty(member) !== undefined;

/**
 * One policy a CFC carrier records: its metadata, and the payload it was
 * written around, where the carrier records one (`CfcStamp` in
 * `packages/api/cfc.ts`). A carrier that holds its metadata alone records
 * none.
 */
type CarrierStamp = {
  readonly meta: ts.Type;
  readonly of: ts.Type | undefined;
};

/** The members a `CfcStamp` holds. */
const STAMP_MEMBER_NAMES: ReadonlySet<string> = new Set(["meta", "of"]);

/** Whether `type` is a `CfcStamp`: an object holding `meta`, and `of` at most besides. */
const isCarrierStamp = (type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const names = type.getProperties().map((property) => property.name);
  return names.includes("meta") &&
    names.every((name) => STAMP_MEMBER_NAMES.has(name));
};

/**
 * The policies `value`, the type a carrier's `__ct_cfc__` holds, records. An
 * intersection or a mapped type folds several carriers into one, whose value
 * is then the intersection of what each held, and two spreads that may each
 * supply it make it their union; each member is a policy of its own.
 */
const carrierStamps = (
  value: ts.Type,
  checker: ts.TypeChecker,
): CarrierStamp[] => {
  const parts = value.isIntersection() ||
      (value.isUnion() && value.types.every(isCarrierStamp))
    ? value.types
    : [value];
  return parts.map((part) => {
    if (!isCarrierStamp(part)) return { meta: part, of: undefined };
    const member = (name: string) => {
      const symbol = part.getProperty(name);
      return symbol &&
        memberValueType(symbol, checker.getTypeOfSymbol(symbol), checker);
    };
    // The payload is what the policy was written around, as written: only
    // the `undefined` its optional `?` adds is taken off, since the checker's
    // non-nullable form of a parameter `T` is `T & {}`, which no binding
    // names.
    const ofSymbol = part.getProperty("of");
    const of = ofSymbol && checker.getTypeOfSymbol(ofSymbol);
    const definedOf = of?.isUnion()
      ? of.types.filter((type) => (type.flags & ts.TypeFlags.Undefined) === 0)
      : undefined;
    return {
      meta: member("meta")!,
      of: definedOf?.length === 1 ? definedOf[0] : of,
    };
  });
};

/**
 * The payload `stamp`'s policy was written around, where `payload` holds the
 * members its carrier is intersected with: the payload the stamp records, or,
 * for a carrier that records none, the one member where there is only one,
 * which can then be nothing but the payload. Beside more than one, nothing
 * says which the policy was written around.
 */
const payloadOfStamp = (
  stamp: CarrierStamp,
  payload: readonly ts.Type[],
): ts.Type | undefined =>
  stamp.of ?? (payload.length === 1 ? payload[0] : undefined);

/** The flags of a primitive type, a literal of one included. */
const PRIMITIVE_TYPE_FLAGS = ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike | ts.TypeFlags.EnumLike |
  ts.TypeFlags.ESSymbolLike;

/**
 * Whether `type` is a primitive, alone or intersected with carriers and
 * brands, so that the primitive is all the data a value of it holds. An
 * object it is intersected with that holds data of its own, under a name or
 * an index signature, makes it no primitive value.
 */
const isPrimitiveValue = (
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean => {
  const parts = type.isIntersection() ? type.types : [type];
  return parts.some((part) => (part.flags & PRIMITIVE_TYPE_FLAGS) !== 0) &&
    parts.every((part) =>
      (part.flags & PRIMITIVE_TYPE_FLAGS) !== 0 ||
      (checker.getIndexInfosOfType(part).length === 0 &&
        part.getProperties().every((property) =>
          property.name === CFC_CARRIER_PROPERTY ||
          property.name.startsWith("__@")
        ))
    );
};

/** The alternatives of `type`: its members where it is a union. */
const alternativesOf = (type: ts.Type): readonly ts.Type[] =>
  type.isUnion() ? type.types : [type];

/**
 * The declarations of each member `type` holds as data, by name: none for a
 * primitive, and never a CFC carrier or a symbol-keyed brand. A union's are
 * those of every alternative, each name holding the declarations of each
 * alternative that has it.
 */
const dataMemberDeclarations = (
  type: ts.Type,
  checker: ts.TypeChecker,
): ReadonlyMap<string, readonly ts.Declaration[]> => {
  const members = new Map<string, ts.Declaration[]>();
  for (const alternative of alternativesOf(type)) {
    if (
      (alternative.flags &
          (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0 ||
      isPrimitiveValue(alternative, checker)
    ) continue;
    for (const property of checker.getPropertiesOfType(alternative)) {
      if (
        property.name === CFC_CARRIER_PROPERTY ||
        property.name.startsWith("__@")
      ) continue;
      const declarations = members.get(property.name) ?? [];
      for (const declaration of property.declarations ?? []) {
        declarations.push(declaration);
      }
      members.set(property.name, declarations);
    }
  }
  return members;
};

/**
 * The payload `metadata`'s carrier recorded, read under the bindings its
 * metadata is read under: a type parameter they bind is its argument, as
 * the checker would instantiate it.
 */
const boundPayloadOf = (metadata: CarriedMetadata): ts.Type | undefined => {
  let payload = metadata.of;
  let bound = metadata.bound;
  for (
    let argument = payload && boundArgumentOfType(payload, bound);
    argument;
    argument = boundArgumentOfType(argument.type, argument.bound)
  ) {
    payload = argument.type;
    bound = argument.bound;
  }
  return payload;
};

/**
 * The labels that are evidence a value carries, which a part of a value may
 * carry only where it provably came from the policy's payload. Every other
 * label restricts what may happen to the value or is a claim the runtime
 * verifies at the write, and is safe wherever the payload's data may be.
 */
const EVIDENCE_LABELS: ReadonlySet<string> = new Set([
  "integrity",
  "addIntegrity",
]);

/**
 * A mapped type as the checker holds it, with the type it maps over:
 * `modifiersType` is `T` in `{ readonly [K in keyof T]: T[K] }`, which the
 * checker sets once it resolves the mapped type's members.
 */
type MappedTypeWithInternals = ts.ObjectType & {
  readonly modifiersType?: ts.Type;
};

/**
 * Whether nothing between a value of `type` and the CFC carriers it holds
 * writes over the payload's members: each carrier sits in an intersection
 * beside them, or a mapped type copied it from such a type. A spread's result
 * holds the carrier the spread of a labeled value copied into it, and a later
 * spread of a value of the payload's own type writes over the payload's
 * members while keeping their declarations, so the type cannot tell which
 * value a member came from. Any other object type that holds a carrier beside
 * members or an index signature of its own, as an interface extending a CFC
 * alias does, counts as one; so does a mapped type whose carrier did not come
 * from the type it maps over, or that the checker holds no such type for.
 */
const holdsCarriersUnwritten = (
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
): boolean => {
  if (seen.has(type)) return true;
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    return type.types.every((part) =>
      holdsCarriersUnwritten(part, checker, seen)
    );
  }
  if (
    !type.getProperty(CFC_CARRIER_PROPERTY) ||
    (isCfcCarrier(type) && checker.getIndexInfosOfType(type).length === 0)
  ) {
    return true;
  }
  if (
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) === 0
  ) {
    return false;
  }
  const source = (type as MappedTypeWithInternals).modifiersType;
  return source !== undefined &&
    source.getProperty(CFC_CARRIER_PROPERTY) !== undefined &&
    holdsCarriersUnwritten(source, checker, seen);
};

/**
 * Which members of a value of `type` a policy whose payload is `of` reaches:
 * those that may hold the payload's data, where a restriction belongs, and
 * those that must, where evidence belongs. `all` stands for the whole value.
 */
const payloadReach = (
  type: ts.Type,
  of: ts.Type | undefined,
  checker: ts.TypeChecker,
): { may: readonly string[] | "all"; must: readonly string[] | "all" } => {
  // No payload recorded (`payloadOfStamp()`): the payload's data may be
  // anywhere in the value, and nothing says where it must be.
  if (!of) return { may: "all", must: [] };
  // A primitive value of a payload one of whose alternatives is a primitive:
  // the value is that alternative, all of it the payload's data.
  if (
    alternativesOf(type).every((alternative) =>
      isPrimitiveValue(alternative, checker)
    ) &&
    alternativesOf(of).some((alternative) =>
      isPrimitiveValue(alternative, checker)
    )
  ) {
    return { may: "all", must: "all" };
  }
  const payloadMembers = dataMemberDeclarations(of, checker);
  const indexed = alternativesOf(of).some((alternative) =>
    checker.getIndexInfosOfType(alternative).length > 0
  );
  const valueMembers = [...dataMemberDeclarations(type, checker)];
  const unwritten = holdsCarriersUnwritten(type, checker);
  // A payload whose type lists no members, such as `{}` or `unknown`: its
  // data may be under any key, and is the whole value only where nothing
  // writes over the value's members and the value holds nothing besides.
  if (payloadMembers.size === 0 && !indexed) {
    return {
      may: "all",
      must: unwritten && valueMembers.length === 0 ? "all" : [],
    };
  }
  if (valueMembers.length === 0) {
    const whole = payloadMembers.size === 0;
    return {
      may: whole ? "all" : [],
      must: whole && unwritten ? "all" : [],
    };
  }
  // A member with no declaration may hold the payload's data under a name the
  // payload does not have: a mapped type that renames its keys keeps no
  // member's declaration, and a spread of its result keeps none either.
  const may = indexed ? "all" as const : valueMembers
    .filter(([name, declarations]) =>
      payloadMembers.has(name) || declarations.length === 0
    )
    .map(([name]) => name);
  const must = !unwritten ? [] : valueMembers
    .filter(([name, declarations]) => {
      const payload = payloadMembers.get(name);
      if (!payload) return false;
      // A member a mapped type such as `Record` synthesizes has no
      // declaration on either side; a mapped type cannot write over it.
      return declarations.length === 0 && payload.length === 0
        ? true
        : declarations.some((declaration) => payload.includes(declaration));
    })
    .map(([name]) => name);
  const whole = (members: readonly string[] | "all") =>
    members === "all" ||
      (members.length > 0 && members.length === valueMembers.length)
      ? "all" as const
      : members;
  return { may: whole(may), must: whole(must) };
};

/**
 * `schema` with `labels` on `members` of the value: the whole value, or each
 * of those members alone, or nowhere where there are none. Read for its
 * labels alone (`labelsOnly`), a value whose label belongs to some of its
 * members carries none at its top.
 */
const placeLabelsOn = (
  schema: MutableJSONSchema,
  labels: Record<string, unknown>,
  members: readonly string[] | "all",
  context: GenerationContext,
): MutableJSONSchema => {
  if (members === "all") return withIfcLabels(schema, labels);
  if (members.length === 0 || context.labelsOnly) return schema;
  const properties = isObjectNotArray(schema) &&
      isObjectOrArray(schema.properties)
    ? schema.properties as Record<string, MutableJSONSchema>
    : undefined;
  if (!properties) return withIfcLabels(schema, labels);
  const labeled: Record<string, MutableJSONSchema> = { ...properties };
  for (const name of members) {
    const property = labeled[name];
    if (property !== undefined) {
      labeled[name] = withIfcLabels(property, labels);
    }
  }
  return { ...(schema as MutableJSONSchemaObj), properties: labeled };
};

/**
 * `schema`, the schema of a value of `type`, with each of `placed`'s labels
 * on the part of the value its policy was written around (`CarrierStamp.of`;
 * `payloadReach()`). A restriction goes wherever the payload's data may be:
 * the members of the payload's names, or the whole value for a payload that
 * an index signature leaves open. Evidence goes only where the payload's data
 * must be: members whose declarations are the payload's own, and only where
 * nothing writes over them (`holdsCarriersUnwritten()`). Either is on the
 * whole value where it reaches every member, and nowhere where it reaches
 * none.
 */
const placeCarriedLabels = (
  schema: MutableJSONSchema,
  type: ts.Type,
  placed: readonly {
    readonly labels: Record<string, unknown>;
    readonly of: ts.Type | undefined;
  }[],
  context: GenerationContext,
): MutableJSONSchema => {
  let result = schema;
  for (const { labels, of } of placed) {
    const reach = payloadReach(type, of, context.typeChecker);
    const evidence: Record<string, unknown> = {};
    const restrictions: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(labels)) {
      (EVIDENCE_LABELS.has(key) ? evidence : restrictions)[key] = value;
    }
    if (Object.keys(restrictions).length > 0) {
      result = placeLabelsOn(result, restrictions, reach.may, context);
    }
    if (Object.keys(evidence).length > 0) {
      result = placeLabelsOn(result, evidence, reach.must, context);
    }
  }
  return result;
};

/**
 * The labeled parts of `type`, an intersection holding CFC metadata
 * carriers, or `undefined` for any other type: its other members, whose
 * intersection is the payload, and each carrier's policies. The checker drops
 * a CFC alias's name where it reduces the alias's type, as
 * `Confidential<T | null, …>` at `T = string` reduces to `string & carrier`
 * once `null & carrier` is nothing. Then the carriers are all that say the
 * value is labeled. A payload that is itself an intersection is several
 * members; which of them a policy was written around, the intersection
 * itself does not say, and each carrier records it (`CarrierStamp.of`). A
 * payload the checker drops from an intersection, as it drops `unknown` and
 * `{}`, is none. A scope wrapper's brand, which a labeled value in a scope
 * carries too, is no part of the value, and is passed over.
 */
const cfcCarriedParts = (
  type: ts.Type,
  checker: ts.TypeChecker,
): { payload: readonly ts.Type[]; metadata: CarrierStamp[] } | undefined => {
  if (!type.isIntersection()) return undefined;
  const metadata: CarrierStamp[] = [];
  const rest: ts.Type[] = [];
  for (const member of type.types) {
    const carrier = cfcCarrierProperty(member);
    if (carrier) {
      for (
        const stamp of carrierStamps(
          memberValueType(carrier, checker.getTypeOfSymbol(carrier), checker),
          checker,
        )
      ) metadata.push(stamp);
    } else if (!isScopeBrandMember(member, checker)) rest.push(member);
  }
  return metadata.length > 0 ? { payload: rest, metadata } : undefined;
};

/**
 * Whether `symbol` is one of the default library's aliases that map an
 * object's members (`MEMBER_MAPPING_LIBRARY_ALIASES`), declared there and
 * nowhere else.
 */
const mapsMembers = (
  symbol: ts.Symbol,
  context: GenerationContext,
): boolean =>
  MEMBER_MAPPING_LIBRARY_ALIASES.has(symbol.name) &&
  !!symbol.declarations?.length &&
  symbol.declarations.every((declaration) =>
    isDefaultLibrarySourceFile(declaration.getSourceFile(), context)
  );

/** The argument `bound` binds `type` to, where `type` is a parameter it binds. */
const boundArgumentOfType = (
  type: ts.Type,
  bound: BoundTypeParameters | undefined,
): BoundTypeArgument | undefined => {
  const parameter = bound && typeParameterOfType(type);
  return parameter && bound?.arguments.get(parameter);
};

/**
 * Whether `type`, the payload of an intersection of CFC metadata carriers,
 * leaves the intersection no carrier: `never`, and `null` and `undefined`,
 * alone or in a union of them, make it `never`, and `any` makes it `any`.
 * Every other payload keeps the carriers, `void` and `unknown` among them.
 */
const leavesNoCarrier = (type: ts.Type): boolean =>
  (type.isUnion() ? type.types : [type]).every((member) =>
    (member.flags &
      (ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.Undefined |
        ts.TypeFlags.Any)) !== 0
  );

/**
 * The metadata type a CFC carrier holds, with the bindings it is read under,
 * `undefined` where it is read under none.
 */
type CarriedMetadata = {
  readonly type: ts.Type;
  readonly bound: BoundTypeParameters | undefined;

  /** The payload its policy was written around (`CarrierStamp.of`). */
  readonly of?: ts.Type | undefined;
};

/**
 * A default-library alias mapping a labeled type's members, read for the
 * value it holds and the labels it keeps (`CommonFabricFormatter`'s
 * `#libraryView()`).
 */
type LibraryView = {
  /**
   * The members of the payload of the alias's labeled operand, whose
   * intersection the payload is (`cfcCarriedParts()`).
   */
  readonly payload: readonly ts.Type[];

  /** The metadata of each carrier the operand holds. */
  readonly metadata: readonly CarriedMetadata[];

  /**
   * Whether the value is the payload: a primitive, which `Readonly`,
   * `Partial` and `Required` leave as it is. A payload of several members,
   * or none, is an intersection, which they map as they map an object.
   */
  readonly primitive: boolean;
};

/**
 * The operand of `element`, a tuple element node, where it spreads one:
 * `...X`, or `...name: X` in a named tuple.
 */
const spreadOperand = (element: ts.TypeNode): ts.TypeNode | undefined =>
  ts.isRestTypeNode(element)
    ? element.type
    : ts.isNamedTupleMember(element) && element.dotDotDotToken
    ? element.type
    : undefined;

/**
 * Whether `value`, metadata read from a type, holds no `undefined`: no value
 * the type could not spell.
 */
const readInFull = (value: unknown): boolean =>
  value !== undefined &&
  (!isObjectOrArray(value) ||
    (Array.isArray(value) ? value : Object.values(value)).every(readInFull));

/**
 * The payload of `type`, a scope wrapper's instantiation, or `undefined` where
 * it cannot be told apart. A scope wrapper intersects its payload with its
 * brand, so the payload is the one member besides the brand; a payload that
 * is itself an intersection, or a union, which the brand distributes over,
 * has no one member.
 */
const scopePayloadOf = (
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined => {
  const payload = getScopeBrand(type, checker)?.payload;
  return payload?.length === 1 && payload[0]!.length === 1
    ? payload[0]![0]
    : undefined;
};

/**
 * The type the payload of a chain named `aliasName` at its end is read at,
 * where `instantiated` is the type the chain instantiates, less the
 * `undefined` an optional member's `?` adds: its payload, a scope wrapper's
 * (`scopePayloadOf()`) or a CFC alias's (`cfcPayloadOf()`). A payload that is
 * itself a CFC alias, `payloadIsCfcAlias`, is read at a CFC alias's whole
 * instantiation, whose payload, every carrier taken off, is that alias's own,
 * while its labels are read from its own arguments. A scope wrapper's brand
 * cannot be taken off such an intersection, so inside one it is read at none.
 */
const instantiatedPayloadOf = (
  aliasName: string,
  instantiated: ts.Type,
  payloadIsCfcAlias: boolean,
  checker: ts.TypeChecker,
): ts.Type | undefined => {
  const defined = definedPart(instantiated);
  if (scopeForWrapperName(aliasName) !== undefined) {
    return payloadIsCfcAlias ? undefined : scopePayloadOf(defined, checker);
  }
  return payloadIsCfcAlias ? defined : cfcPayloadOf(defined);
};

/**
 * `type` less the `undefined` among its members, where one other member
 * remains, and `type` itself otherwise.
 */
const definedPart = (type: ts.Type): ts.Type => {
  if (!type.isUnion()) return type;
  const defined = type.types.filter((member) =>
    (member.flags & ts.TypeFlags.Undefined) === 0
  );
  return defined.length === 1 ? defined[0]! : type;
};

/**
 * The type `parameterTypes` gives `node` when `node` is a bare reference to one
 * of its parameters.
 */
const boundParameterType = (
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  parameterTypes: ParameterTypes,
): ts.Type | undefined => {
  if (parameterTypes.size === 0) return undefined;
  const parameter = typeParameterOfReference(node, checker);
  return parameter && parameterTypes.get(parameter);
};

/**
 * Whether this formatter's lowering, handed `args` for `declaration`'s
 * parameters, reaches a CFC alias or a scope wrapper down `declaration`'s chain
 * of aliases, each the whole body of the one before and followed at most once,
 * with every parameter along the way replaced by an argument or, for one left
 * out, its default.
 */
const lowersDownAliasChain = (
  declaration: ts.TypeAliasDeclaration,
  args: readonly ts.TypeNode[],
  checker: ts.TypeChecker,
  visited: ReadonlySet<ts.TypeAliasDeclaration>,
): boolean => {
  if (CFC_ALIAS_NAMES.has(declaration.name.text)) {
    return lowersFromSyntax(declaration.name.text);
  }
  // A scope wrapper reads its payload from its argument, so one reached with
  // none is not lowered.
  if (SCOPE_WRAPPER_NAMES.has(declaration.name.text)) return args.length > 0;
  const aliased = unwrapTypeParentheses(declaration.type);
  if (!ts.isTypeReferenceNode(aliased)) return false;
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
  return target !== undefined && !visited.has(target) &&
    lowersDownAliasChain(
      target,
      substituted,
      checker,
      new Set([...visited, target]),
    );
};

/**
 * Whether this formatter lowers `reference`, to the generic `symbol`, from the
 * reference's own type arguments: a scope wrapper naming its payload, which it
 * reads from that argument, or an alias that is not itself a CFC alias or a
 * scope wrapper and whose whole body references one, directly or through
 * further such aliases, where substituting the reference's arguments down that
 * chain leaves no parameter unbound.
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
    !CHAIN_LOWERED_ALIAS_NAMES.has(declaration.name.text) &&
    lowersDownAliasChain(
      declaration,
      reference.typeArguments ?? [],
      checker,
      new Set([declaration]),
    );
}

/**
 * The scope of the wrapper that `type`'s alias names, directly or as the whole
 * body of a chain of aliases, each followed at most once. The checker reports
 * the outermost alias, so `type Rec = PerUser<T>` has `Rec` for its alias
 * symbol and the wrapper is found only by following it.
 */
export function scopeOfAliasChain(
  type: ts.Type,
  checker: ts.TypeChecker,
): SchemaScope | undefined {
  const aliasSymbol = (type as TypeWithInternals).aliasSymbol;
  let declaration = aliasSymbol &&
    resolveAliasedSymbol(aliasSymbol, checker).declarations?.find(
      ts.isTypeAliasDeclaration,
    );
  const visited = new Set<ts.TypeAliasDeclaration>();
  while (declaration && !visited.has(declaration)) {
    const scope = scopeForWrapperName(declaration.name.text);
    if (scope !== undefined) return scope;
    visited.add(declaration);
    const aliased = unwrapTypeParentheses(declaration.type);
    if (!ts.isTypeReferenceNode(aliased)) return undefined;
    const symbol = checker.getSymbolAtLocation(aliased.typeName);
    declaration = symbol &&
      resolveAliasedSymbol(symbol, checker).declarations?.find(
        ts.isTypeAliasDeclaration,
      );
  }
  return undefined;
}

/**
 * The scope of the scope wrapper `type` is: the one its alias chain reaches
 * (`scopeOfAliasChain()`), and otherwise the one its brand declares
 * (`getScopeBrand()`), as for a type the checker narrowed or built with no
 * alias, or a union written beside a wrapper, as `PerUser<A> | null`.
 */
export function scopeOfScopeWrapper(
  type: ts.Type,
  checker: ts.TypeChecker,
): SchemaScope | undefined {
  return scopeOfAliasChain(type, checker) ??
    getScopeBrand(type, checker)?.scope;
}

/**
 * Whether `type` is a scope wrapper (`scopeOfScopeWrapper()`) around a cell.
 * It caps the cell's handle and is itself a wrapper, so a cycle through it is
 * found at the cell's value, not at the wrapper, and the capped handle is
 * written inline at each reference.
 */
export function scopesCellHandle(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  return scopeOfScopeWrapper(type, checker) !== undefined &&
    (getScopeBrand(type, checker)?.payload.some((members) =>
      members.some((member) =>
        getCellWrapperInfo(member, checker) !== undefined
      )
    ) ?? false);
}

/**
 * Formatter for Common Fabric-specific types (Cell<T>, Stream<T>, Reactive<T>,
 * Default<T,V>), scope wrappers, and CFC aliases.
 *
 * The checker reports a type's outermost alias, so a scope wrapper or a CFC
 * alias reached through further aliases is found by following the alias
 * declarations (`scopeOfAliasChain()`, `#resolveAliasChainInstantiation()`).
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

    if (scopeOfAliasChain(type, context.typeChecker) !== undefined) {
      return true;
    }

    // Two scopes' brands on one value are refused (`formatType()`), except
    // where the schema declares no scope, which reads the value as it would
    // any other brand-only member's.
    if (
      this.#scopeBrand(type, context) !== undefined ||
      (!context.declaresNoScope &&
        hasNestedScopeBrands(type, context.typeChecker))
    ) {
      return true;
    }

    if (
      aliasName && CFC_ALIAS_NAMES.has(aliasName) && lowersFromSyntax(aliasName)
    ) {
      return true;
    }

    if (
      this.#resolveAliasChainInstantiation(
        type as TypeWithInternals,
        context,
        CFC_ALIAS_NAMES,
      )
    ) {
      return true;
    }

    if (
      context.carriersRead !== type &&
      cfcCarriedParts(type, context.typeChecker)
    ) {
      return true;
    }

    if (this.#libraryView(type, context)) {
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
      return this.#applyScopeWrapperSemantics(innerSchema, aliasScope, context);
    }

    const resolvedScopeAlias = this.#resolveAliasChainInstantiation(
      aliasType,
      context,
      SCOPE_WRAPPER_NAMES,
    );
    if (resolvedScopeAlias) {
      return this.#readChain(
        type,
        context,
        resolvedScopeAlias,
        "scope",
        () =>
          this.#applyScopeWrapperSemantics(
            this.#formatResolvedAliasPayload(resolvedScopeAlias, context),
            scopeForWrapperName(resolvedScopeAlias.aliasName)!,
            context,
          ),
      );
    }

    const resolvedCfcAlias = this.#resolveAliasChainInstantiation(
      aliasType,
      context,
      CFC_ALIAS_NAMES,
    );
    if (resolvedCfcAlias) {
      return this.#readChain(
        type,
        context,
        resolvedCfcAlias,
        "cfc",
        () => this.#formatResolvedCfcAlias(resolvedCfcAlias, context),
      );
    }

    // A default-library alias mapping a labelled type's members builds its
    // type from the operand's, carrier and all, as TypeScript builds any
    // mapped type: over an object it folds the carrier into the object as one
    // more member, which `Pick` may leave out, and over a primitive it builds
    // an object of the primitive's methods. So the value is that type as the
    // formatters after this one read it, or, where `Readonly`, `Partial` and
    // `Required` leave a primitive as it is, the primitive; and its labels
    // are the operand's, read from its carriers in full or not at all.
    const view = this.#libraryView(type, context);
    if (view) {
      const shape = view.primitive
        ? this.#schemaGenerator.formatChildType(
          view.payload[0]!,
          context,
          undefined,
        )
        : this.#schemaGenerator.formatStructure(type, context);
      // The structure may carry the same labels, from the carrier folded into
      // it; labelling it again with them changes nothing.
      return this.#withPlacedLabels(shape, type, view.metadata, context);
    }

    // Two scopes' brands on one value are a wrapper nested in another with no
    // cell between them, as the node-driven reading refuses when a node
    // names both.
    if (
      !context.declaresNoScope &&
      hasNestedScopeBrands(type, context.typeChecker)
    ) {
      throw nestedScopeError();
    }

    // A scope wrapper that no alias names, as a type the checker narrowed or
    // `PerUser<A> | null`, is named by its brand. Its payload is read from a
    // union node written for it where there is one.
    const brand = this.#scopeBrand(type, context);
    if (brand) {
      return this.#applyScopeWrapperSemantics(
        this.#formatWrittenScopedUnion(type, brand, context) ??
          this.#formatScopePayload(type, brand, context),
        brand.scope,
        context,
      );
    }

    // With no alias name left to follow, and no reference naming the policy,
    // the metadata carriers say the value is labelled, and with what. Read in
    // part, a policy could claim what its author never wrote together, or
    // break an invariant between its parts: an `ownerPrincipal` needs the
    // `writeAuthorizedBy` whose binding, a `typeof`, no type spells. So the
    // carriers are read in full, or the value is its payload alone.
    const carried = context.carriersRead !== type &&
      cfcCarriedParts(type, context.typeChecker);
    if (carried) {
      if (
        carried.metadata.some((stamp) =>
          context.typeChecker.getNonNullableType(stamp.meta).getProperty(
            "writeAuthorizedBy",
          )
        )
      ) this.#reportUnreadOperatorWriter(context);
      const payload = carried.payload.length === 1
        ? this.#schemaGenerator.formatChildType(
          carried.payload[0]!,
          context,
          undefined,
        )
        : this.#formatPayloadInPlace(type, context);
      const metadata = carried.metadata.map((stamp) => ({
        type: stamp.meta,
        bound: context.boundTypeParameters,
        of: payloadOfStamp(stamp, carried.payload),
      }));
      return this.#withPlacedLabels(payload, type, metadata, context);
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
      // The printer leaves out an argument equal to the parameter's default,
      // writing `SqliteDb` for `SqliteDb<SqliteDatabase>`, so a printed node
      // can name no payload. The resolved wrapper supplies it where there is
      // one; otherwise it is left unread, for a wrapper around it to recover.
      if (!this.#isSyntheticWrapperNode(typeRefNode)) {
        throw new Error(`${wrapperKind}<T> requires type argument`);
      }
      if (fallbackInnerTypeRef) {
        return this.#formatWrapperType(
          fallbackInnerTypeRef,
          undefined,
          context,
          wrapperKind,
        );
      }
      context.uninterpretedTypeNodes?.push(typeRefNode);
      return true;
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
    const hintsNode = context.typeNode ?? context.hintsNode;
    if (context.schemaHints && hintsNode) {
      const hint = context.schemaHints.get(hintsNode);
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
        for (const node of uninterpreted) {
          context.uninterpretedTypeNodes?.push(node);
        }
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
    const brand = type && !resolvedInner
      ? this.#scopeBrand(type, context)
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
      } else if (type && brand) {
        innerSchema = this.#formatScopePayload(type, brand, context);
      } else {
        for (const node of uninterpreted) {
          context.uninterpretedTypeNodes?.push(node);
        }
      }
    }

    return this.#applyScopeWrapperSemantics(innerSchema, scope, context);
  }

  /**
   * The scope brand `type` carries (`getScopeBrand()`), or `undefined` where a
   * scope wrapper reading it has taken the brand off
   * (`GenerationContext.scopeBrandRead`).
   */
  #scopeBrand(
    type: ts.Type,
    context: GenerationContext,
  ): ScopeBrand | undefined {
    return context.scopeBrandRead?.has(type)
      ? undefined
      : getScopeBrand(type, context.typeChecker);
  }

  /**
   * The schema of the payload the scope wrapper `type` holds, with its `brand`
   * taken off. A payload the checker cannot intersect again without the brand,
   * as `A & B` in `PerUser<A & B>`, is `type` itself, whose own `#formatType()`
   * is in progress. It is read in place rather than as a type met again inside
   * itself: by this formatter where it claims `type` for anything besides the
   * brand, such as the labels of a CFC alias, and otherwise by the formatters
   * after it (`SchemaGenerator.formatStructure()`). Either reads it without the
   * wrapper's node, which would name the wrapper once more.
   */
  #formatScopePayload(
    type: ts.Type,
    brand: ScopeBrand,
    context: GenerationContext,
  ): MutableJSONSchema {
    const payload = scopePayloadType(type, brand, context.typeChecker);
    const { typeNode: _, ...rest } = context;
    const payloadContext: GenerationContext = {
      ...rest,
      scopeBrandRead: new Set([
        type,
        payload,
        ...(type.isUnion() ? type.types : []),
      ]),
    };
    if (payload !== type) {
      return this.#schemaGenerator.formatChildType(
        payload,
        payloadContext,
        undefined,
      );
    }
    return this.supportsType(type, payloadContext)
      ? this.formatType(type, payloadContext)
      : this.#schemaGenerator.formatStructure(type, payloadContext);
  }

  /**
   * The schema of the payload of `type`, a union of scope wrappers of
   * `brand`'s scope beside `null` or `undefined` written as one, as
   * `PerUser<A> | null`, or `undefined` where no such union is written for it
   * (`#writtenUnion()`). The payload is read as `#formatScopePayload()` reads
   * it, by its type, `A | null`, at the members written for it: the payload
   * written in each wrapper and each `null` or `undefined`
   * (`GenerationContext.scopePayloadNodes`), as `PerUser<A | null>` writes
   * them. What only the syntax says, such as the binding
   * `PolicyOf<typeof rules>` names, is read as written.
   */
  #formatWrittenScopedUnion(
    type: ts.Type,
    brand: ScopeBrand,
    context: GenerationContext,
  ): MutableJSONSchema | undefined {
    const checker = context.typeChecker;
    const written = type.isUnion()
      ? this.#writtenUnion(type, context)
      : undefined;
    if (!written || scopeOfWrittenScopedUnion(written.node) !== brand.scope) {
      return undefined;
    }
    // Each wrapper stands for the payload written in it, and a union written
    // there has its members written beside the `null` or `undefined` outside.
    const nodes = written.node.types.flatMap((member) => {
      const payload = resolveScopeWrapperNode(member)?.node.typeArguments?.[0];
      if (!payload) return [member];
      const unwrapped = unwrapTypeParentheses(payload);
      return ts.isUnionTypeNode(unwrapped) ? unwrapped.types : [payload];
    });
    // Read under bindings, the union is the declaration's own type, whose
    // brand gives the payload as the declaration writes it.
    const writtenBrand = written.type === type
      ? brand
      : getScopeBrand(written.type, checker);
    if (writtenBrand?.scope !== brand.scope) return undefined;
    const payload = scopePayloadType(written.type, writtenBrand, checker);
    // The union's instantiation, where it is read under bindings, gives its
    // payload's (`GenerationContext.instantiatedAs`).
    const instantiatedType = written.type === type
      ? context.instantiatedAs
      : type;
    const instantiatedBrand = instantiatedType &&
      getScopeBrand(instantiatedType, checker);
    const instantiated = instantiatedBrand?.scope === brand.scope
      ? scopePayloadType(instantiatedType!, instantiatedBrand, checker)
      : undefined;
    const { typeNode: _, instantiatedAs: __, ...outer } = written.context;
    return this.#schemaGenerator.formatChildType(
      payload,
      {
        ...outer,
        // An alternative of several members is the branded member itself
        // (`scopePayloadType()`), read as its payload.
        scopeBrandRead: new Set([
          payload,
          ...(payload.isUnion() ? payload.types : []),
        ]),
        scopePayloadNodes: { payload, nodes },
      },
      undefined,
      instantiated,
    );
  }

  /**
   * The union node written for `type`, a union, with the type and the context
   * to read it in: the node at this position, through parentheses and aliases
   * that bind nothing, read as `type`; and otherwise the body of the alias the
   * reference at this position names, or, with no node here, the one `type`
   * is reached by. A generic alias's body is the declaration's own type, read
   * with each parameter bound to the argument the reference writes for it, or
   * to the type's argument where none is written, at `type`
   * (`GenerationContext.instantiatedAs`).
   */
  #writtenUnion(
    type: ts.UnionType,
    context: GenerationContext,
  ):
    | {
      readonly node: ts.UnionTypeNode;
      readonly type: ts.Type;
      readonly context: GenerationContext;
    }
    | undefined {
    const checker = context.typeChecker;
    const reference = context.typeNode &&
      readThroughIdentityAliases(context.typeNode, checker);
    if (reference && ts.isUnionTypeNode(reference)) {
      return { node: reference, type, context };
    }
    if (reference && !ts.isTypeReferenceNode(reference)) return undefined;
    const declaration = this.#getTypeAliasDeclarationForSymbol(
      reference
        ? checker.getSymbolAtLocation(reference.typeName)
        : type.aliasSymbol,
      context,
    );
    const body = declaration && unwrapTypeParentheses(declaration.type);
    if (!declaration || !body || !ts.isUnionTypeNode(body)) return undefined;
    const typeArguments = type.aliasSymbol &&
        this.#getTypeAliasDeclarationForSymbol(type.aliasSymbol, context) ===
          declaration
      ? type.aliasTypeArguments
      : undefined;
    const written = reference?.typeArguments ?? [];
    const bound = new Map<ts.TypeParameterDeclaration, BoundTypeArgument>();
    for (
      const [index, parameter] of (declaration.typeParameters ?? []).entries()
    ) {
      // An argument the reference leaves out is its parameter's default, read
      // with the arguments before it.
      const node = written[index] ?? (reference && parameter.default);
      const argument = node &&
        this.#bindWrittenArgument(
          node,
          written[index]
            ? context.boundTypeParameters
            : { arguments: new Map(bound), declaredNode: node },
          context,
        );
      const argumentType = typeArguments?.[index];
      const binding = argument || (argumentType && { type: argumentType });
      if (!binding) return undefined;
      bound.set(parameter, binding);
    }
    const { boundTypeParameters: _, ...outer } = context;
    return {
      node: body,
      type: this.#writtenArgumentType(body, context),
      context: bound.size > 0
        ? {
          ...outer,
          boundTypeParameters: { arguments: bound, declaredNode: body },
          instantiatedAs: type,
        }
        : outer,
    };
  }

  /**
   * `schema`, a scope wrapper's payload, in `scope`: the cap on its cell's
   * handle where it is a cell, and otherwise the scope of its slot. A schema
   * that declares no scope (`GenerationContext.declaresNoScope`) is the
   * payload alone.
   */
  #applyScopeWrapperSemantics(
    schema: MutableJSONSchema,
    scope: SchemaScope,
    context: GenerationContext,
  ): MutableJSONSchema {
    if (context.declaresNoScope) return schema;
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

    // Beside `null` or `undefined`, a cell is an `anyOf` branch, and the scope
    // is declared twice: at the top, the slot's own scope, which the write
    // path reads, and in the cell's `asCell` entry, the cap on following its
    // handle, which a read applies however it reaches the handle. One cell
    // beside those is all a scope wrapper around a cell may hold.
    const branches = schema.anyOf;
    if (Array.isArray(branches) && branches.some(isHandleSchema)) {
      if (
        branches.filter(isHandleSchema).length !== 1 ||
        !branches.every((b) => isHandleSchema(b) || isNullishSchema(b))
      ) {
        throw scopeAroundCellUnionError(scope);
      }
      if (schema.scope !== undefined) throw nestedScopeError();
      return {
        ...schema,
        anyOf: branches.map((branch) =>
          isHandleSchema(branch)
            ? this.#applyScopeWrapperSemantics(branch, scope, context)
            : branch
        ),
        scope,
      };
    }

    if (schema.scope !== undefined) throw nestedScopeError();

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
    const hintsNode = context.typeNode ?? context.hintsNode;
    if (context.schemaHints && hintsNode) {
      const hint = context.schemaHints.get(hintsNode);
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

    // Under bindings, the value is read at the cell's value in the position's
    // instantiation (`GenerationContext.instantiatedAs`).
    const instantiatedCell = context.instantiatedAs &&
      getCellWrapperInfo(context.instantiatedAs, context.typeChecker);
    const innerSchema = this.#schemaGenerator.formatChildType(
      innerType,
      childContext,
      shouldPassTypeNode ? innerTypeNode : undefined,
      instantiatedCell &&
        (instantiatedCell.typeRef.typeArguments ??
          context.typeChecker.getTypeArguments(instantiatedCell.typeRef))[0],
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

    // Generate schema for the value type, under bindings at the member of the
    // position's instantiation that carries no default brand
    // (`GenerationContext.instantiatedAs`).
    const instantiatedAs = context.instantiatedAs;
    const unbranded = instantiatedAs?.isUnion()
      ? instantiatedAs.types.filter((member) =>
        !hasDefaultMarker(member, context.typeChecker)
      )
      : undefined;
    const valueSchema = this.#schemaGenerator.formatChildType(
      valueType,
      context,
      valueTypeNode,
      unbranded?.length === 1 ? unbranded[0] : undefined,
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

  /**
   * `schema`, the schema of an object of `type`, with the labels `carrier`, a
   * CFC metadata carrier the object holds as one of its members, attaches:
   * one per policy it records, folded into it by a mapped type or a spread
   * (`carrierStamps()`), each placed on the part of the object its policy
   * names.
   */
  withLabelsCarriedBy(
    schema: MutableJSONSchema,
    type: ts.Type,
    carrier: ts.Symbol,
    context: GenerationContext,
  ): MutableJSONSchema {
    const checker = context.typeChecker;
    const value = memberValueType(
      carrier,
      checker.getTypeOfSymbol(carrier),
      checker,
    );
    return this.#withPlacedLabels(
      schema,
      type,
      carrierStamps(value, checker).map((stamp) => ({
        type: stamp.meta,
        bound: context.boundTypeParameters,
        of: stamp.of,
      })),
      context,
    );
  }

  /**
   * `schema`, the schema of a value of `type`, with the labels each of
   * `metadata` spells placed on the part of the value its policy names
   * (`placeCarriedLabels()`), each read in full, or `schema` alone where any
   * is not (`#labelsOf()`).
   */
  #withPlacedLabels(
    schema: MutableJSONSchema,
    type: ts.Type,
    metadata: readonly CarriedMetadata[],
    context: GenerationContext,
  ): MutableJSONSchema {
    const labels = this.#labelsOf(metadata, context);
    return labels
      ? placeCarriedLabels(
        schema,
        type,
        labels.map((label, index) => ({
          labels: label,
          of: boundPayloadOf(metadata[index]!),
        })),
        context,
      )
      : schema;
  }

  /**
   * The labels each of `metadata`, a carrier's metadata type, spells, read
   * under its own bindings, or `undefined` where any is not read in full.
   * Read in part, a policy could claim what its author never wrote together,
   * so it is read in full or not at all, as the carriers of an intersection
   * are.
   */
  #labelsOf(
    metadata: readonly CarriedMetadata[],
    context: GenerationContext,
  ): Record<string, unknown>[] | undefined {
    const { boundTypeParameters: _, ...unbound } = context;
    const labels = metadata.map(({ type, bound }) =>
      this.#extractLiteralLikeValue(
        type,
        undefined,
        bound ? { ...unbound, boundTypeParameters: bound } : unbound,
      )
    );
    return labels.every((label) =>
        isObjectOrArray(label) && !Array.isArray(label) && readInFull(label)
      )
      ? labels as Record<string, unknown>[]
      : undefined;
  }

  /**
   * The value of `type`, an intersection of CFC metadata carriers and other
   * members, several or none, as those members' intersection reads. The
   * checker's public API builds no intersection, so the value is read in
   * place: by this formatter where it claims `type` for anything besides its
   * carriers, such as a cell, and otherwise by the formatters after it
   * (`SchemaGenerator.formatStructure()`), which read a carrier as no part of
   * the value. Either reads it with no node, as a payload of one member is
   * read: the node names the policy, not its payload.
   */
  #formatPayloadInPlace(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const {
      typeNode: _,
      hintsNode: __,
      instantiatedAs: ___,
      ...unplaced
    } = context;
    const payloadContext: GenerationContext = {
      ...unplaced,
      carriersRead: type,
    };
    return this.supportsType(type, payloadContext)
      ? this.formatType(type, payloadContext)
      : this.#schemaGenerator.formatStructure(type, payloadContext);
  }

  /**
   * Where `type` is a default-library alias mapping a labeled type's members
   * (`Readonly<Sec<X>>`), directly or down a chain of aliases
   * (`#followToLibraryAlias()`), its labeled operand (`#operandView()`), and
   * whether the value is the operand's payload: a primitive, which
   * `Readonly`, `Partial` and `Required` leave as it is; `undefined` for any
   * other type. `bound` binds the type parameters `type` may hold.
   */
  #libraryView(
    type: ts.Type,
    context: GenerationContext,
    bound = context.boundTypeParameters,
  ): LibraryView | undefined {
    const followed = this.#followToLibraryAlias(type, bound, context);
    if (!followed) return undefined;
    const inner = this.#operandView(followed.operand, followed.bound, context);
    return inner && {
      ...inner,
      primitive: inner.primitive &&
        PRIMITIVE_KEEPING_LIBRARY_ALIASES.has(followed.name),
    };
  }

  /**
   * Helper for {@link #libraryView}, which returns the default-library alias
   * mapping an object's members that `type` is, with the type of its operand
   * and the bindings that type is read under. Where `type`'s own alias is
   * one, its operand is the checker's argument, read under `bound`.
   * Otherwise the checker has reported a user's alias, as it does for a
   * `Pick` or an `Omit` over literal keys, and holds that alias's arguments.
   * An alias whose whole body is a reference to another alias is followed to
   * it, until one of these, and each alias along the way binds its parameters
   * to the arguments the one before writes for it
   * (`#bindReferenceArguments()`), the first to the checker's, read under
   * `bound`. The operand is then the type the last alias's reference writes,
   * read under that alias's bindings. A chain that reaches anything else, or
   * comes back to an alias on it, names none.
   */
  #followToLibraryAlias(
    type: ts.Type,
    bound: BoundTypeParameters | undefined,
    context: GenerationContext,
  ):
    | {
      readonly name: string;
      readonly operand: ts.Type;
      readonly bound: BoundTypeParameters | undefined;
    }
    | undefined {
    const checker = context.typeChecker;
    const { aliasSymbol, aliasTypeArguments } = type as TypeWithInternals;
    if (!aliasSymbol) return undefined;
    if (mapsMembers(aliasSymbol, context)) {
      const operand = aliasTypeArguments?.[0];
      return operand && { name: aliasSymbol.name, operand, bound };
    }
    const chain: {
      readonly declaration: ts.TypeAliasDeclaration;
      readonly reference: ts.TypeReferenceNode;
    }[] = [];
    let declaration = resolveAliasedSymbol(aliasSymbol, checker).declarations
      ?.find(ts.isTypeAliasDeclaration);
    let library: ts.Symbol | undefined;
    while (
      declaration && !chain.some((link) => link.declaration === declaration)
    ) {
      const reference = unwrapTypeParentheses(declaration.type);
      if (!ts.isTypeReferenceNode(reference)) return undefined;
      chain.push({ declaration, reference });
      const named = checker.getSymbolAtLocation(reference.typeName);
      const target = named && resolveAliasedSymbol(named, checker);
      if (target && mapsMembers(target, context)) {
        library = target;
        break;
      }
      declaration = target?.declarations?.find(ts.isTypeAliasDeclaration);
    }
    const last = chain.at(-1);
    const written = library && last?.reference.typeArguments?.[0];
    if (!library || !last || !written) return undefined;
    const checkerArguments = new Map<
      ts.TypeParameterDeclaration,
      BoundTypeArgument
    >();
    for (
      const [index, parameter] of (chain[0]!.declaration.typeParameters ?? [])
        .entries()
    ) {
      const argument = aliasTypeArguments?.[index];
      if (argument) {
        checkerArguments.set(
          parameter,
          bound ? { type: argument, bound } : { type: argument },
        );
      }
    }
    let bindings: BoundTypeParameters | undefined = checkerArguments.size > 0
      ? { arguments: checkerArguments, declaredNode: chain[0]!.reference }
      : undefined;
    for (let at = 1; at < chain.length; at++) {
      bindings = this.#bindReferenceArguments(
        chain[at]!.declaration,
        chain[at - 1]!.reference,
        bindings,
        context,
      );
    }
    return {
      name: library.name,
      operand: this.#writtenArgumentType(written, context),
      bound: bindings,
    };
  }

  /**
   * `declaration`'s type parameters bound to the arguments `reference`, a
   * reference to it written under `bound`, writes for them
   * (`#bindWrittenArgument()`), or `undefined` where it binds none. One the
   * reference leaves out is bound to its parameter's default, read with the
   * arguments before it, as the checker instantiates one.
   */
  #bindReferenceArguments(
    declaration: ts.TypeAliasDeclaration,
    reference: ts.TypeReferenceNode,
    bound: BoundTypeParameters | undefined,
    context: GenerationContext,
  ): BoundTypeParameters | undefined {
    const bindings = new Map<ts.TypeParameterDeclaration, BoundTypeArgument>();
    for (
      const [index, parameter] of (declaration.typeParameters ?? []).entries()
    ) {
      const written = reference.typeArguments?.[index];
      const argument = written
        ? this.#bindWrittenArgument(written, bound, context)
        : parameter.default &&
          this.#bindWrittenArgument(
            parameter.default,
            bindings.size > 0
              ? {
                arguments: new Map(bindings),
                declaredNode: parameter.default,
              }
              : undefined,
            context,
          );
      if (argument) bindings.set(parameter, argument);
    }
    return bindings.size > 0
      ? {
        arguments: bindings,
        declaredNode: unwrapTypeParentheses(declaration.type),
      }
      : undefined;
  }

  /**
   * Helper for {@link #libraryView}, which returns the labeled parts of
   * `operand`, the type a default-library alias mapping an object's members
   * is given, read under `bound`: for a type parameter `bound` binds, its
   * argument's; for an intersection of CFC metadata carriers and other
   * members, those members as its payload's are read (`#payloadParts()`),
   * with the carriers' metadata and any its payload adds; for such an alias
   * in turn, its operand's; and `undefined` for any other type.
   */
  #operandView(
    operand: ts.Type,
    bound: BoundTypeParameters | undefined,
    context: GenerationContext,
  ): LibraryView | undefined {
    const argument = boundArgumentOfType(operand, bound);
    if (argument) {
      return this.#operandView(argument.type, argument.bound, context);
    }
    const carried = cfcCarriedParts(operand, context.typeChecker);
    if (!carried) return this.#libraryView(operand, context, bound);
    const payload = this.#payloadParts(carried.payload, bound, context);
    return payload && {
      payload: payload.payload,
      metadata: [
        ...payload.metadata,
        ...carried.metadata.map((stamp) => ({
          type: stamp.meta,
          bound,
          of: payloadOfStamp(stamp, carried.payload),
        })),
      ],
      primitive: payload.payload.length === 1 &&
        (payload.payload[0]!.flags & ts.TypeFlags.Object) === 0,
    };
  }

  /**
   * Helper for {@link #operandView}, which returns what `payload`, the
   * members a labeled operand intersects its carriers with, is under `bound`,
   * and the metadata of the carriers it adds to the operand's. A type
   * parameter `bound` binds is its argument. The checker folds an argument
   * that is itself labeled into the operand's intersection, as it folds any
   * intersection into another, so the argument's payload members are the
   * operand's and its carriers add their metadata. An argument that leaves
   * the intersection no carrier (`leavesNoCarrier()`) leaves the operand
   * unlabeled, and so returns `undefined`. Any other member adds no carrier.
   */
  #payloadParts(
    payload: readonly ts.Type[],
    bound: BoundTypeParameters | undefined,
    context: GenerationContext,
  ):
    | {
      readonly payload: readonly ts.Type[];
      readonly metadata: CarriedMetadata[];
    }
    | undefined {
    const members: ts.Type[] = [];
    const metadata: CarriedMetadata[] = [];
    for (const member of payload) {
      const argument = boundArgumentOfType(member, bound);
      if (!argument) {
        members.push(member);
        continue;
      }
      if (leavesNoCarrier(argument.type)) return undefined;
      const carried = cfcCarriedParts(argument.type, context.typeChecker);
      const inner = this.#payloadParts(
        carried?.payload ?? [argument.type],
        argument.bound,
        context,
      );
      if (!inner) return undefined;
      for (const part of inner.payload) members.push(part);
      for (const part of inner.metadata) metadata.push(part);
      for (const stamp of carried?.metadata ?? []) {
        metadata.push({
          type: stamp.meta,
          bound: argument.bound,
          of: payloadOfStamp(stamp, carried?.payload ?? []),
        });
      }
    }
    return { payload: members, metadata };
  }

  /**
   * `read`, the reading of `resolved`, entered from the written reference the
   * context reads, where it has one, and tracked as a chain reading
   * (`SchemaGenerator.readAliasChain()`) so a recursion through that reference
   * is found. Its instantiation is passed on to settle one by where it is
   * known: at a position the reading carries one for
   * (`GenerationContext.instantiatedAs`), and for a reference read under no
   * bindings, whose type is concrete; a declaration read under bindings with
   * none carried has only its own unbound parameters. A scope around a cell
   * settles none: its cycle is found at the cell's value, which keeps the
   * handle it caps at each reference (`scopesCellHandle()`). A chain reached
   * with no written reference is tracked by the alias it is reached by, which
   * bounds its nesting and settles nothing.
   */
  #readChain(
    type: ts.Type,
    context: GenerationContext,
    resolved: ResolvedAliasChain,
    kind: "cfc" | "scope",
    read: () => MutableJSONSchema,
  ): MutableJSONSchema {
    const checker = context.typeChecker;
    const reference = context.typeNode &&
      readThroughIdentityAliases(context.typeNode, checker);
    if (!reference || !ts.isTypeReferenceNode(reference)) {
      const alias = (type as TypeWithInternals).aliasSymbol;
      return alias
        ? this.#schemaGenerator.readAliasChain(
          type,
          context,
          alias,
          undefined,
          kind,
          read,
        )
        : read();
    }
    const instantiated = scopesCellHandle(type, checker)
      ? undefined
      : context.instantiatedAs ??
        (context.boundTypeParameters ? undefined : resolved.instantiated);
    return this.#schemaGenerator.readAliasChain(
      type,
      context,
      reference,
      instantiated,
      kind,
      read,
    );
  }

  #formatResolvedCfcAlias(
    resolved: ResolvedAliasChain,
    context: GenerationContext,
  ): MutableJSONSchema {
    const baseSchema = this.#formatResolvedAliasPayload(resolved, context);
    // The labels read the reference's own arguments where the payload does
    // (`#formatResolvedAliasPayload()`).
    const ifc = this.#buildIfcMetadataForAlias(
      resolved.aliasName,
      resolved.aliasArgs,
      context,
      this.#withBoundArgumentsWritten(
        resolved.aliasArgNodes ??
          this.#referenceArgumentNodes(resolved.aliasName, context),
        context,
      ),
      resolved.parameterTypes ?? NO_PARAMETER_TYPES,
    );
    if (ifc === undefined) {
      return baseSchema;
    }

    return withIfcLabels(baseSchema, ifc);
  }

  /**
   * `nodes`, a reference's arguments read under `context`, with each bare
   * reference to a parameter the context binds replaced by the argument
   * written for it, where that argument names no parameter of its own, so
   * that what only its syntax says, such as the binding a `typeof` names, is
   * there for a label to read. One that does name one stays the parameter,
   * which the label reader follows under its bindings.
   */
  #withBoundArgumentsWritten(
    nodes: readonly (ts.TypeNode | undefined)[] | undefined,
    context: GenerationContext,
  ): readonly (ts.TypeNode | undefined)[] | undefined {
    if (!context.boundTypeParameters || !nodes) return nodes;
    return nodes.map((node) => {
      const argument = node && this.#boundArgumentAt(node, context)?.argument;
      return argument?.node && !argument.bound ? argument.node : node;
    });
  }

  /**
   * The argument `typeNode` reads as, where it is a bare reference to a
   * parameter the context binds, with the context to read it in: the
   * bindings of the place the argument is written in place of the
   * context's.
   */
  #boundArgumentAt(
    typeNode: ts.TypeNode,
    context: GenerationContext,
  ):
    | {
      readonly argument: BoundTypeArgument;
      readonly context: GenerationContext;
    }
    | undefined {
    return context.boundTypeParameters
      ? this.#boundArgumentFor(
        typeParameterOfReference(typeNode, context.typeChecker),
        context,
      )
      : undefined;
  }

  /**
   * Like {@link #boundArgumentAt}, except for `parameter`, a type parameter
   * however it is reached.
   */
  #boundArgumentFor(
    parameter: ts.TypeParameterDeclaration | undefined,
    context: GenerationContext,
  ):
    | {
      readonly argument: BoundTypeArgument;
      readonly context: GenerationContext;
    }
    | undefined {
    const argument = parameter &&
      context.boundTypeParameters?.arguments.get(parameter);
    if (!argument) return undefined;
    const { boundTypeParameters: _, ...outer } = context;
    return {
      argument,
      context: argument.bound
        ? { ...outer, boundTypeParameters: argument.bound }
        : outer,
    };
  }

  /** The schema of the payload, the first argument, of a resolved alias. */
  #formatResolvedAliasPayload(
    resolved: ResolvedAliasChain,
    context: GenerationContext,
  ): MutableJSONSchema {
    const baseType = resolved.aliasArgs[0];
    if (!baseType) {
      throw new Error(`${resolved.aliasName}<T> requires type argument`);
    }
    if (resolved.payload) {
      return this.#formatWrittenPayload(resolved, resolved.payload, context);
    }
    // A canonical alias reached by its own name resolves no argument nodes; the
    // reference's own arguments are its nodes, the payload's as much as the
    // labels'. Read from its type alone, a generic alias in the payload has no
    // argument to bind, and a `typeof` binding nested in it is lost unless a
    // member's annotation still names it. An authored node is formatted as the
    // type it is, so a named type in the payload stays a reference to its
    // definition.
    const argNodes = resolved.aliasArgNodes ??
      this.#referenceArgumentNodes(resolved.aliasName, context);
    const payloadNode = argNodes?.[0];
    // Read under bindings, the payload is read at the payload of the alias's
    // instantiation (`GenerationContext.instantiatedAs`).
    const instantiatedPayload = context.instantiatedAs &&
      instantiatedPayloadOf(
        resolved.aliasName,
        context.instantiatedAs,
        payloadNode !== undefined &&
          this.#refersToCfcAlias(payloadNode, context),
        context.typeChecker,
      );
    return this.#schemaGenerator.formatChildType(
      baseType,
      context,
      payloadNode,
      instantiatedPayload,
    );
  }

  /**
   * Helper for {@link #formatResolvedAliasPayload}: `payload`, the payload as
   * the last alias along `resolved`'s chain writes it. One holding a
   * parameter of that alias is read from that declaration with each
   * parameter bound to its argument (`GenerationContext.boundTypeParameters`),
   * so every reference in it stays one the checker resolves, and a parameter
   * reads its argument as written where it is. The type the chain
   * instantiates is read instead, where it holds the payload apart
   * (`cfcPayloadOf()`) and the payload is no CFC alias of its own, whose
   * labels that type holds merged with the chain's: for a chain entered from
   * its type, whose arguments have no syntax to read, and for a payload using
   * a parameter where no reading under bindings reaches it
   * (`usesParameterUnreachably()`).
   */
  #formatWrittenPayload(
    resolved: ResolvedAliasChain,
    payload: WrittenArgument,
    context: GenerationContext,
  ): MutableJSONSchema {
    const checker = context.typeChecker;
    const { boundTypeParameters: _, ...outer } = context;
    const type = this.#writtenArgumentType(payload.node, context);
    if (!holdsFreeTypeParameter(payload.node, checker)) {
      return this.#schemaGenerator.formatChildType(type, outer, payload.node);
    }
    const payloadIsCfcAlias = this.#refersToCfcAlias(payload.node, context);
    const instantiatedPayload = resolved.instantiated &&
      instantiatedPayloadOf(
        resolved.aliasName,
        resolved.instantiated,
        payloadIsCfcAlias,
        checker,
      );
    const readsInstantiation = !payloadIsCfcAlias &&
      (!resolved.argumentsWritten ||
        usesParameterUnreachably(payload.node, checker));
    if (readsInstantiation && instantiatedPayload) {
      return this.#schemaGenerator.formatChildType(
        instantiatedPayload,
        context,
        undefined,
      );
    }
    // A parameter left unbound, its argument not read, is reported as a
    // use no binding reaches. The payload the chain instantiates, where it
    // holds one apart, identifies the reading
    // (`GenerationContext.instantiatedAs`).
    return this.#schemaGenerator.formatChildType(
      type,
      {
        ...outer,
        boundTypeParameters: payload.bound ??
          { arguments: new Map(), declaredNode: payload.node },
      },
      payload.node,
      instantiatedPayload,
    );
  }

  /**
   * Whether `node`, through parentheses, refers to a CFC alias, by its own
   * name or down a chain of aliases.
   */
  #refersToCfcAlias(node: ts.TypeNode, context: GenerationContext): boolean {
    const reference = unwrapTypeParentheses(node);
    if (!ts.isTypeReferenceNode(reference)) return false;
    const declaration = this.#getTypeAliasDeclarationForSymbol(
      context.typeChecker.getSymbolAtLocation(reference.typeName),
      context,
    );
    return declaration !== undefined &&
      this.#resolveAliasChainFromDeclaration(
          CFC_ALIAS_NAMES,
          declaration,
          undefined,
          reference.typeArguments ?? [],
          context,
          new Set([declaration]),
          undefined,
        ) !== undefined;
  }

  /**
   * The type `node`, a type argument as written, denotes: the type it was
   * printed from, where the transformer printed it, and the checker's reading
   * of it otherwise, which is `any` for a node the checker cannot resolve.
   */
  #writtenArgumentType(
    node: ts.TypeNode,
    context: GenerationContext,
  ): ts.Type {
    const known = context.printedFrom?.(node) ??
      context.typeRegistry?.get(node);
    if (known) return known;
    try {
      return context.typeChecker.getTypeFromTypeNode(node);
    } catch {
      return context.typeChecker.getAnyType();
    }
  }

  /**
   * The alias among `terminals` that `typeWithAlias`'s alias names, directly or
   * down a chain of aliases, with its arguments there.
   */
  #resolveAliasChainInstantiation(
    typeWithAlias: TypeWithInternals,
    context: GenerationContext,
    terminals: ReadonlySet<string>,
  ): ResolvedAliasChain | undefined {
    // The checker can erase a local alias and report an inner alias's type.
    // Its parameters belong to that inner declaration, while `.typeNode`
    // still carries the outer reference's arguments. Start a user alias's
    // substitution from its authored declaration so those pairs agree.
    const reference = context.typeNode &&
      readThroughIdentityAliases(context.typeNode, context.typeChecker);
    if (reference && ts.isTypeReferenceNode(reference)) {
      const declaration = this.#getTypeAliasDeclarationForSymbol(
        context.typeChecker.getSymbolAtLocation(reference.typeName),
        context,
      );
      if (declaration && !terminals.has(declaration.name.text)) {
        const nodes = reference.typeArguments ?? [];
        const resolved = this.#resolveAliasChainFromDeclaration(
          terminals,
          declaration,
          undefined,
          nodes,
          context,
          new Set([declaration]),
          this.#writtenUnderContext(nodes, context),
        );
        if (resolved) {
          return this.#enteredWith(resolved, nodes, typeWithAlias, context);
        }
      }
      // Reduced, a policy's type can lose its name: `Confidential<string |
      // null, L>` is `string & carrier`, since `null & carrier` is nothing, and
      // `Confidential<null, L>` is `never`, as `Confidential<never, L>` is. The
      // reference still names the policy, and holds its arguments as written,
      // `null` and `never` among them.
      if (
        declaration && terminals.has(declaration.name.text) &&
        !typeWithAlias.aliasSymbol
      ) {
        // Reached by its own name, the policy reads its payload from the
        // reference's argument, as written.
        const resolved = this.#resolveAliasChainFromDeclaration(
          terminals,
          declaration,
          undefined,
          reference.typeArguments ?? [],
          context,
          new Set([declaration]),
          undefined,
        );
        if (resolved?.aliasArgs[0]) return resolved;
      }
    }

    const aliasName = typeWithAlias.aliasSymbol?.name;
    if (!aliasName) {
      return undefined;
    }
    const aliasArgs = typeWithAlias.aliasTypeArguments ?? [];
    if (terminals.has(aliasName)) {
      return lowersFromSyntax(aliasName) ? { aliasName, aliasArgs } : undefined;
    }

    const aliasSymbol = typeWithAlias.aliasSymbol;
    const aliasDeclaration = this.#getTypeAliasDeclarationForSymbol(
      aliasSymbol,
      context,
    );
    if (!aliasDeclaration) {
      return undefined;
    }

    const aliasArgNodes = this.#getAliasTypeArgumentNodes(context);
    const resolved = this.#resolveAliasChainFromDeclaration(
      terminals,
      aliasDeclaration,
      aliasArgs,
      aliasArgNodes,
      context,
      new Set([aliasDeclaration]),
      aliasArgNodes && this.#writtenUnderContext(aliasArgNodes, context),
    );
    return resolved &&
      this.#enteredWith(resolved, aliasArgNodes, typeWithAlias, context);
  }

  /**
   * `resolved`, a chain entered from a reference of type `typeWithAlias` with
   * `nodes` for its arguments, holding the type it instantiates, and whether
   * its arguments are read as written: they are unless there are none, or one
   * names a type parameter the context does not bind, as a member of a
   * generic declaration does once the checker has instantiated it, whose
   * argument the instantiated type holds instead.
   */
  #enteredWith(
    resolved: ResolvedAliasChain,
    nodes: readonly ts.TypeNode[] | undefined,
    typeWithAlias: ts.Type,
    context: GenerationContext,
  ): ResolvedAliasChain {
    const argumentsWritten = nodes !== undefined &&
      !nodes.some((node) =>
        holdsFreeTypeParameter(
          node,
          context.typeChecker,
          context.boundTypeParameters?.arguments,
        )
      );
    // Under bindings, the position's own instantiation is the chain's
    // (`GenerationContext.instantiatedAs`): `typeWithAlias` is the type the
    // declaration is written in, its parameters unbound.
    const instantiated = context.instantiatedAs ?? typeWithAlias;
    return argumentsWritten
      ? { ...resolved, instantiated, argumentsWritten }
      : { ...resolved, instantiated };
  }

  /**
   * The argument `node`, a type argument written under `bound`, binds its
   * parameter to, or `undefined` where it names a type parameter `bound` does
   * not bind: one of a generic declaration whose member the checker has
   * instantiated, whose argument is in the instantiated type and not here. A
   * bare reference to a parameter `bound` binds is that parameter's argument,
   * and a node holding none of its parameters is read under no bindings, so
   * that an alias reached again inside its own payload with the same
   * arguments is read under the same bindings, which is how its recursion is
   * found.
   */
  #bindWrittenArgument(
    node: ts.TypeNode,
    bound: BoundTypeParameters | undefined,
    context: GenerationContext,
  ): BoundTypeArgument | undefined {
    return bindWrittenArgument(
      node,
      bound,
      context.typeChecker,
      (written) => this.#writtenArgumentType(written, context),
    );
  }

  /**
   * `nodes`, type arguments written where `context` reads, under the bindings
   * it reads them with.
   */
  #writtenUnderContext(
    nodes: readonly ts.TypeNode[],
    context: GenerationContext,
  ): WrittenArguments {
    const bound = context.boundTypeParameters;
    return bound ? { nodes, bound } : { nodes };
  }

  /**
   * Follows the chain of aliases from `aliasDeclaration`, reached with
   * `aliasArgs` and `aliasArgNodes`, to the alias among `terminals` it ends at.
   * Each alias's arguments are substituted into its body, by node where they
   * have one and by type where they do not, for the labels to read. Along the
   * way, `written` holds the arguments of the reference being followed as
   * their author wrote them, so that the payload is read from the last
   * declaration with its parameters bound to those (`#formatWrittenPayload()`)
   * rather than from a substituted node.
   */
  #resolveAliasChainFromDeclaration(
    terminals: ReadonlySet<string>,
    aliasDeclaration: ts.TypeAliasDeclaration,
    aliasArgs: readonly (ts.Type | undefined)[] | undefined,
    aliasArgNodes: readonly (ts.TypeNode | undefined)[] | undefined,
    context: GenerationContext,
    visited: Set<ts.TypeAliasDeclaration>,
    written: WrittenArguments | undefined,
    parameterTypes: ParameterTypes = NO_PARAMETER_TYPES,
  ): ResolvedAliasChain | undefined {
    const aliasName = aliasDeclaration.name.text;
    if (terminals.has(aliasName)) {
      // A chain that reaches `Projection` stops: the type it is written in is
      // read as the checker resolves it.
      if (!lowersFromSyntax(aliasName)) return undefined;
      const payload = written?.nodes[0];
      return {
        aliasName,
        // Alias chains substitute syntax until they reach a terminal. Only its
        // arguments need checker types; unrelated aliases require no conversion.
        // An argument with a type and no node already has its type.
        aliasArgs: aliasArgNodes
          ? aliasArgNodes.map((node, index) =>
            aliasArgs?.[index] ??
              (node
                ? this.#resolveTypeNodeToType(node, context)
                : context.typeChecker.getUnknownType())
          )
          : (aliasArgs ?? []).filter((type): type is ts.Type =>
            type !== undefined
          ),
        ...(aliasArgNodes ? { aliasArgNodes } : {}),
        ...(parameterTypes.size > 0 ? { parameterTypes } : {}),
        ...(payload
          ? {
            payload: written?.bound
              ? { node: payload, bound: written.bound }
              : { node: payload },
          }
          : {}),
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
    const typedHere = new Map(parameterTypes);
    // Each parameter bound to its argument as written, under the bindings of
    // the place it is written, or to its type where it has no node.
    const boundHere = new Map<
      ts.TypeParameterDeclaration,
      BoundTypeArgument
    >();
    for (let i = 0; i < (aliasDeclaration.typeParameters?.length ?? 0); i++) {
      const parameter = aliasDeclaration.typeParameters?.[i];
      const paramName = parameter?.name.text;
      // An argument the reference leaves out is its parameter's default read
      // with the arguments before it, as the checker instantiates one. With no
      // argument nodes at all there is nothing to read that default with.
      const leftOut = aliasArgNodes !== undefined &&
        i >= aliasArgNodes.length;
      const actualArgNode = leftOut
        ? parameter?.default &&
          substituteTypeNode(parameter.default, paramNodeMap)
        : aliasArgNodes?.[i];
      const actualArg = aliasArgs?.[i];
      if (parameter && paramName && actualArgNode) {
        paramNodeMap.set(paramName, actualArgNode);
      } else if (parameter && actualArg) {
        // An argument with a type and no node: a reference to its parameter
        // in the nodes below reads as that type, never as the declaration's
        // own reference with the parameter unbound.
        typedHere.set(parameter, actualArg);
      }
      const writtenArg = written?.nodes[i];
      const argument = !parameter
        ? undefined
        : writtenArg
        ? this.#bindWrittenArgument(writtenArg, written?.bound, context)
        : parameter.default && written && leftOut
        ? this.#bindWrittenArgument(
          parameter.default,
          boundHere.size > 0
            ? { arguments: new Map(boundHere), declaredNode: parameter.default }
            : undefined,
          context,
        )
        : actualArg && { type: actualArg };
      if (parameter && argument) boundHere.set(parameter, argument);
    }

    const resolvedArgs: (ts.Type | undefined)[] = [];
    const resolvedArgNodes: (ts.TypeNode | undefined)[] = [];
    for (const argNode of aliased.typeArguments ?? []) {
      const resolvedArgNode = substituteTypeNode(argNode, paramNodeMap);
      const bound = boundParameterType(
        resolvedArgNode,
        context.typeChecker,
        typedHere,
      );
      resolvedArgs.push(bound);
      resolvedArgNodes.push(bound ? undefined : resolvedArgNode);
    }

    visited.add(targetDeclaration);
    const writtenHere = aliased.typeArguments ?? [];
    return this.#resolveAliasChainFromDeclaration(
      terminals,
      targetDeclaration,
      resolvedArgs,
      resolvedArgNodes,
      context,
      visited,
      boundHere.size > 0
        ? {
          nodes: writtenHere,
          bound: { arguments: boundHere, declaredNode: aliased },
        }
        : { nodes: writtenHere },
      typedHere,
    );
  }

  #resolveTypeNodeToType(
    typeNode: ts.TypeNode,
    context: GenerationContext,
  ): ts.Type {
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
    aliasArgNodes: readonly (ts.TypeNode | undefined)[] | undefined,
    parameterTypes: ParameterTypes,
  ): Record<string, unknown> | undefined {
    const readValue = (index: number): unknown => {
      return this.#extractLiteralLikeValue(
        aliasArgs[index],
        aliasArgNodes?.[index],
        context,
        parameterTypes,
      );
    };
    // A label list the lowering cannot read in full would lower as no label or
    // with a `null` atom without a word to the author.
    const reportUnread = (index: number) =>
      reportUnreadLabel(
        context,
        aliasName,
        aliasArgs[index],
        aliasArgNodes?.[index],
      );
    const readLabels = (index: number): unknown => {
      const labels = readValue(index);
      if (holdsUnreadLabel(labels)) reportUnread(index);
      return labels;
    };
    // The list a trusted pattern's name stands for when the policy writes no
    // `requiredEventIntegrity` of its own, checked as a written one is.
    const patternLabels = (pattern: unknown, index: number): unknown[] => {
      const labels = [pattern];
      if (holdsUnreadLabel(labels)) reportUnread(index);
      return labels;
    };

    switch (aliasName) {
      case "Cfc": {
        const payload = readValue(1);
        if (!isObjectOrArray(payload) || Array.isArray(payload)) {
          return undefined;
        }
        if (holdsUnreadMetadataLabel(payload)) reportUnread(1);
        return { ...payload };
      }
      case "Confidential":
        return { confidentiality: readLabels(1) };
      case "Integrity":
        return { integrity: readLabels(1) };
      case "AddIntegrity":
        return { addIntegrity: readLabels(1) };
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
        return { requiredIntegrity: readLabels(1) };
      case "MaxConfidentiality":
        return { maxConfidentiality: readLabels(1) };
      case "ExactCopy":
        return { exactCopyOf: readValue(1) };
      case "WriteAuthorizedBy":
        return this.#buildWriteAuthorizedByMetadataForArg(
          context,
          aliasArgNodes,
          aliasName,
        );
      case "WritePolicyAnyOf":
        return this.#buildWritePolicyAnyOfMetadata(context, aliasArgNodes);
      case "TrustedActionWriteWithIntegrity":
        return this.#buildTrustedActionWriteMetadata({
          context,
          aliasArgNodes,
          aliasName,
          action: readValue(2),
          trustedPattern: readValue(3),
          requiredEventIntegrity: readLabels(4),
        });
      case "TrustedActionWrite": {
        const trustedPattern = readValue(3);
        return this.#buildTrustedActionWriteMetadata({
          context,
          aliasArgNodes,
          aliasName,
          action: readValue(2),
          trustedPattern,
          requiredEventIntegrity: patternLabels(trustedPattern, 3),
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
              ? readLabels(3)
              : patternLabels(trustedPattern, 2),
          },
        };
      }
      case "ProjectionPath":
        return this.#buildProjectionMetadata(
          aliasArgs,
          aliasArgNodes,
          context,
          {
            fromIndex: 1,
            pathIndex: 2,
            defaultFrom: undefined,
          },
        );
      case "ProjectionOf":
        return this.#buildProjectionMetadata(
          aliasArgs,
          aliasArgNodes,
          context,
          {
            fromIndex: 1,
            pathIndex: 1,
            defaultFrom: "/",
          },
        );
      default:
        return undefined;
    }
  }

  #buildProjectionMetadata(
    aliasArgs: readonly ts.Type[],
    aliasArgNodes: readonly (ts.TypeNode | undefined)[] | undefined,
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
        aliasArgNodes?.[index],
        context,
      );
    };

    const from = options.defaultFrom ?? readValue(options.fromIndex);
    const directPath = this.#encodeJsonPointerPath(
      readValue(options.pathIndex),
    );
    if (directPath === undefined) {
      return undefined;
    }

    return {
      projection: {
        from,
        path: directPath,
      },
    };
  }

  /**
   * The lowered `WritePolicyAnyOf`: each member of the tuple written as its
   * second argument, lowered as the writer policy it names. A member that is
   * not a writer policy, or whose writer does not resolve, would leave that
   * alternative with no writer, and an empty tuple would leave no way to
   * write at all, so each is an error here. So is an optional or rest member:
   * the list is a fixed set of writers, which a member that may be absent, or
   * may repeat, is not.
   */
  #buildWritePolicyAnyOfMetadata(
    context: GenerationContext,
    aliasArgNodes: readonly (ts.TypeNode | undefined)[] | undefined,
  ): Record<string, unknown> {
    let tuple = aliasArgNodes?.[1];
    while (
      tuple &&
      (ts.isParenthesizedTypeNode(tuple) ||
        (ts.isTypeOperatorNode(tuple) &&
          tuple.operator === ts.SyntaxKind.ReadonlyKeyword))
    ) {
      tuple = tuple.type;
    }
    if (!tuple || !ts.isTupleTypeNode(tuple) || tuple.elements.length === 0) {
      throw new Error(
        "`WritePolicyAnyOf` requires a nonempty tuple of writer policies, " +
          "written in place.",
      );
    }
    const policies = tuple.elements.map((element) => {
      const node = ts.isNamedTupleMember(element) ? element.type : element;
      if (
        ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node) ||
        (ts.isNamedTupleMember(element) &&
          (element.questionToken !== undefined ||
            element.dotDotDotToken !== undefined))
      ) {
        throw new Error(
          "A `WritePolicyAnyOf` member cannot be optional or rest: the list " +
            "is a fixed set of writers.",
        );
      }
      const policyContext = { ...context, typeNode: node };
      const policy = this.#resolveAliasChainInstantiation(
        context.typeChecker.getTypeFromTypeNode(node) as TypeWithInternals,
        policyContext,
        WRITER_POLICY_ALIAS_NAMES,
      );
      if (!policy) {
        throw new Error(
          "Each `WritePolicyAnyOf` member must be a `WriteAuthorizedBy`, " +
            "`TrustedActionWrite`, or `TrustedActionWriteWithIntegrity`.",
        );
      }
      const metadata = this.#buildIfcMetadataForAlias(
        policy.aliasName,
        policy.aliasArgs,
        policyContext,
        // The arguments are read as `#formatResolvedCfcAlias()` reads them.
        this.#withBoundArgumentsWritten(
          policy.aliasArgNodes ??
            this.#referenceArgumentNodes(policy.aliasName, policyContext),
          policyContext,
        ),
        policy.parameterTypes ?? NO_PARAMETER_TYPES,
      );
      if (metadata?.writeAuthorizedBy === undefined) {
        throw new Error(
          "A `WritePolicyAnyOf` member's writer must be a direct `typeof` " +
            "of a binding.",
        );
      }
      return metadata;
    });
    return { writePolicyAnyOf: policies };
  }

  #buildTrustedActionWriteMetadata(
    options: {
      context: GenerationContext;
      aliasArgNodes: readonly (ts.TypeNode | undefined)[] | undefined;
      aliasName: string;
      action: unknown;
      trustedPattern: unknown;
      requiredEventIntegrity: unknown;
    },
  ): Record<string, unknown> | undefined {
    const writeMetadata = this.#buildWriteAuthorizedByMetadataForArg(
      options.context,
      options.aliasArgNodes,
      options.aliasName,
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

  /**
   * The write claim of `aliasName`, a policy whose second argument is its
   * writer binding. The binding must be a direct `typeof`
   * (cfc_authoring_contract.md), read from its node. An indirect binding is
   * an error here as well as in `WriteAuthorizedByValidationTransformer`,
   * which cannot see bindings passed through another alias's parameters. A
   * policy written through another alias whose binding has no node to read
   * is also an error: its schema would carry no write restriction. A generic
   * member whose operator syntax erases its bound writer reports an error
   * with a specific authoring remedy.
   */
  #buildWriteAuthorizedByMetadataForArg(
    context: GenerationContext,
    aliasArgNodes: readonly (ts.TypeNode | undefined)[] | undefined,
    aliasName: string,
  ): Record<string, unknown> | undefined {
    const bindingNode = aliasArgNodes?.[1];
    if (!bindingNode) {
      if (
        !this.#reportUnreadOperatorWriter(context) &&
        this.#writesPolicyThroughAlias(aliasName, context)
      ) {
        reportUnreadWriterBinding(context, aliasName);
      }
      return undefined;
    }
    if (
      !ts.isTypeQueryNode(bindingNode) || !ts.isIdentifier(bindingNode.exprName)
    ) {
      // A declaration read from an instantiated type can name a parameter
      // whose argument has no syntax. It is a type-only read, not an authored
      // indirect binding for this check to reject.
      const bound = this.#boundArgumentAt(bindingNode, context);
      if (bound && !bound.argument.node) return undefined;
      reportUnreadWriterBinding(context, aliasName);
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

  /** Reports a policy whose authored operator erased its writer syntax. */
  #reportUnreadOperatorWriter(context: GenerationContext): boolean {
    const node = context.typeNode;
    if (
      !node || !context.boundTypeParameters ||
      !holdsTypeParameter(
        node,
        context.typeChecker,
        context.boundTypeParameters.arguments,
      ) ||
      !usesParameterUnreachably(node, context.typeChecker)
    ) return false;
    reportUnreadWriterBinding(
      context,
      "WriteAuthorizedBy",
      "The generic member's operator syntax cannot preserve its authored " +
        "writer binding. Write the protected member directly or pass the " +
        "policy unchanged through a parameter.",
    );
    return true;
  }

  /**
   * Whether the context's written reference names an alias other than
   * `aliasName`, the policy being lowered, and denotes that policy, as
   * `Checked<typeof save>` denotes a `WriteAuthorizedBy`. Such a policy is
   * written through the alias, whose syntax is what passes its binding on. A
   * reference that denotes something else writes no policy: the payload node
   * the transformer's direct `WriteAuthorizedBy` path hands over, while it
   * mints the claim itself, is one. So does a schema read from a type alone,
   * such as a capture's, which has no reference at all.
   */
  #writesPolicyThroughAlias(
    aliasName: string,
    context: GenerationContext,
  ): boolean {
    const reference = context.typeNode &&
      readThroughIdentityAliases(context.typeNode, context.typeChecker);
    if (
      !reference || !ts.isTypeReferenceNode(reference) ||
      this.#resolveTypeReferenceName(reference.typeName, context) === aliasName
    ) {
      return false;
    }
    const denoted = this.#resolveTypeNodeToType(
      reference,
      context,
    ) as TypeWithInternals;
    return denoted.aliasSymbol?.name === aliasName;
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

  /**
   * Helper for {@link #formatResolvedCfcAlias}: the argument nodes of
   * `aliasName`, the canonical alias the checker resolved the context's
   * reference to. A reference that names it holds them. A reference to a
   * conditional alias whose one branch other than `never` names it holds them
   * as that branch writes them: an argument that is one of the alias's
   * parameters is the reference's argument for it, and one that holds no
   * parameter is itself. An argument holding a parameter the conditional
   * checks or infers is read from its type, as the checker may bind that
   * parameter to one member of a union, and so is any argument holding some
   * other parameter. Any other reference holds the arguments of another alias
   * (`Pick2<A, B>`'s are not `Confidential`'s), so it gives none.
   */
  #referenceArgumentNodes(
    aliasName: string,
    context: GenerationContext,
  ): readonly (ts.TypeNode | undefined)[] | undefined {
    const checker = context.typeChecker;
    const reference = context.typeNode &&
      readThroughIdentityAliases(context.typeNode, checker);
    if (!reference || !ts.isTypeReferenceNode(reference)) return undefined;
    if (
      this.#resolveTypeReferenceName(reference.typeName, context) === aliasName
    ) {
      return this.#getAliasTypeArgumentNodes(context);
    }

    const declaration = this.#getTypeAliasDeclarationForSymbol(
      checker.getSymbolAtLocation(reference.typeName),
      context,
    );
    const parameters: readonly ts.TypeParameterDeclaration[] =
      declaration?.typeParameters ?? [];
    const conditional = declaration &&
      soleConditionalBranch(declaration.type, checker, parameters);
    if (
      !conditional ||
      this.#resolveTypeReferenceName(conditional.branch.typeName, context) !==
        aliasName
    ) {
      return undefined;
    }
    const argumentNodes = reference.typeArguments ?? [];
    return (conditional.branch.typeArguments ?? []).map((argument) => {
      if (
        holdsTypeParameter(argument, checker, new Set(conditional.unreadable))
      ) {
        return undefined;
      }
      const bare = unwrapTypeParentheses(argument);
      const parameter = ts.isTypeReferenceNode(bare) &&
          ts.isIdentifier(bare.typeName) && !bare.typeArguments?.length
        ? checker.getSymbolAtLocation(bare.typeName)?.declarations?.find(
          ts.isTypeParameterDeclaration,
        )
        : undefined;
      const index = parameter ? parameters.indexOf(parameter) : -1;
      if (index >= 0) return argumentNodes[index];
      return holdsTypeParameter(argument, checker) ? undefined : argument;
    });
  }

  /**
   * The type arguments written on the reference being formatted. The
   * reference is read through parentheses, plain aliases, and aliases whose
   * whole body is one of their parameters (`readThroughIdentityAliases()`): `type Name = Owned<string, typeof setName>`
   * holds the arguments that `Name` stands for, and a policy read from the
   * bare `Name` would find none and drop the writer binding without a word.
   */
  #getAliasTypeArgumentNodes(
    context: GenerationContext,
  ): readonly ts.TypeNode[] | undefined {
    const typeNode = context.typeNode &&
      readThroughIdentityAliases(context.typeNode, context.typeChecker);
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
      return undefined;
    }
    return typeNode.typeArguments ? [...typeNode.typeArguments] : undefined;
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

  /**
   * The value a label's type spells, read from `typeNode` where it is given
   * and from `type` otherwise. Syntax says what a type cannot, such as which
   * binding a `typeof` names, so it is read first, paired with the type it
   * denotes. Where it is syntax this reader does not evaluate, such as a
   * conditional or mapped alias, the paired type decides the value.
   */
  #extractLiteralLikeValue(
    type: ts.Type | undefined,
    typeNode: ts.TypeNode | undefined,
    context: GenerationContext,
    parameterTypes: ParameterTypes = NO_PARAMETER_TYPES,
  ): unknown {
    if (typeNode) {
      // A parameter with a type and no node is read as that type.
      const bound = boundParameterType(
        typeNode,
        context.typeChecker,
        parameterTypes,
      );
      if (bound) {
        return this.#extractLiteralLikeValue(bound, undefined, context);
      }
      const at = this.#boundArgumentAt(typeNode, context);
      if (at) {
        return this.#extractLiteralLikeValue(
          at.argument.type,
          at.argument.node,
          at.context,
        );
      }
      const fromSyntax = this.#readLiteralSyntax(
        type,
        typeNode,
        context,
        parameterTypes,
      );
      if (fromSyntax !== UNREAD) return fromSyntax;
    }
    return type ? this.#readLiteralType(type, context) : undefined;
  }

  /**
   * Helper for {@link #extractLiteralLikeValue}: the value `typeNode` spells,
   * or `UNREAD` for syntax it does not evaluate. Each node it descends into is
   * read paired with the part of `type` that node denotes, where `type` is
   * given.
   */
  #readLiteralSyntax(
    type: ts.Type | undefined,
    typeNode: ts.TypeNode,
    context: GenerationContext,
    parameterTypes: ParameterTypes,
  ): unknown {
    const checker = context.typeChecker;
    if (ts.isParenthesizedTypeNode(typeNode)) {
      return this.#extractLiteralLikeValue(
        type,
        typeNode.type,
        context,
        parameterTypes,
      );
    }
    if (
      ts.isTypeOperatorNode(typeNode) &&
      typeNode.operator === ts.SyntaxKind.ReadonlyKeyword
    ) {
      return this.#extractLiteralLikeValue(
        type,
        typeNode.type,
        context,
        parameterTypes,
      );
    }
    if (ts.isTypeQueryNode(typeNode)) {
      const symbol = checker.getSymbolAtLocation(typeNode.exprName);
      const extracted = symbol && extractLiteralValueOfSymbol(symbol, checker);
      return extracted ? extracted.value : UNREAD;
    }
    if (ts.isLiteralTypeNode(typeNode)) {
      const literal = typeNode.literal;
      if (ts.isStringLiteral(literal)) return literal.text;
      if (ts.isNumericLiteral(literal)) return Number(literal.text);
      if (literal.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (literal.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (literal.kind === ts.SyntaxKind.NullKeyword) return null;
      return UNREAD;
    }
    if (ts.isTupleTypeNode(typeNode)) {
      // An optional element leaves no element-for-element reading of the
      // tuple, which its type then decides.
      if (
        typeNode.elements.some((element) =>
          ts.isOptionalTypeNode(element) ||
          (ts.isNamedTupleMember(element) && element.questionToken)
        )
      ) {
        return UNREAD;
      }
      if (typeNode.elements.some((element) => spreadOperand(element))) {
        // A spread element stands for the elements of the list its operand
        // reads as. The tuple's type holds those elements spread already, so
        // none pairs with an element node, and each node is read alone. A
        // tuple that leaves an element unread that way, or spreads what reads
        // as no list, is left to its type.
        const values: unknown[] = [];
        for (const element of typeNode.elements) {
          const operand = spreadOperand(element);
          const value = this.#extractLiteralLikeValue(
            undefined,
            operand ??
              (ts.isNamedTupleMember(element) ? element.type : element),
            context,
            parameterTypes,
          );
          if (!operand) {
            values.push(value);
          } else if (Array.isArray(value)) {
            for (const atom of value) values.push(atom);
          } else {
            return UNREAD;
          }
        }
        return readInFull(values) ? values : UNREAD;
      }
      const elementTypes = type && checker.isTupleType(type)
        ? checker.getTypeArguments(type as ts.TypeReference)
        : undefined;
      const paired = elementTypes?.length === typeNode.elements.length
        ? elementTypes
        : undefined;
      return typeNode.elements.map((element, index) =>
        this.#extractLiteralLikeValue(
          paired?.[index],
          ts.isNamedTupleMember(element) ? element.type : element,
          context,
          parameterTypes,
        )
      );
    }
    if (ts.isTypeReferenceNode(typeNode)) {
      const referencedName = this.#resolveTypeReferenceName(
        typeNode.typeName,
        context,
      );
      if (
        referencedName === "AnyOf" &&
        this.#namesBrand(typeNode.typeName, CFC_ANY_OF_BRAND, context)
      ) {
        const alternatives = this.#extractLiteralLikeValue(
          type && this.#anyOfBrandPayload(type, context),
          typeNode.typeArguments?.[0],
          context,
          parameterTypes,
        );
        return Array.isArray(alternatives) ? { anyOf: alternatives } : UNREAD;
      }
      if (
        referencedName === "PolicyOf" &&
        this.#namesBrand(typeNode.typeName, CFC_POLICY_OF_BRAND, context)
      ) {
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
        checker.getSymbolAtLocation(typeNode.typeName),
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
        // The alias's body, with the reference's arguments in place of its
        // parameters, denotes what the reference does.
        return this.#extractLiteralLikeValue(
          type,
          substituteTypeNode(aliasDeclaration.type, paramMap),
          context,
          parameterTypes,
        );
      }
      return UNREAD;
    }
    if (ts.isTypeLiteralNode(typeNode)) {
      const obj: Record<string, unknown> = {};
      for (const member of typeNode.members) {
        // An object read without one of its members would be read short, so
        // a member this reader cannot name from its syntax, such as a
        // computed key, or one that is not a property with a written type,
        // such as an accessor, leaves the whole object to its type. The type
        // path reads each member at its annotation, as this reader would.
        if (!ts.isPropertySignature(member) || !member.type) return UNREAD;
        const propName = getPropertyNameText(member.name);
        if (propName === undefined) return UNREAD;
        const property = type && checker.getPropertyOfType(type, propName);
        obj[propName] = this.#extractLiteralLikeValue(
          property &&
            memberValueType(
              property,
              checker.getTypeOfSymbol(property),
              checker,
            ),
          member.type,
          context,
          parameterTypes,
        );
      }
      return obj;
    }
    if (typeNode.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (typeNode.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (typeNode.kind === ts.SyntaxKind.NullKeyword) return null;
    if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
    return UNREAD;
  }

  /**
   * Helper for {@link #extractLiteralLikeValue}: the value `type` spells, for
   * a label with no syntax to read, or syntax this reader does not evaluate.
   */
  #readLiteralType(type: ts.Type, context: GenerationContext): unknown {
    const checker = context.typeChecker;
    // A type parameter the context binds is its argument, as a bare
    // reference to it is (`#boundArgumentAt()`).
    const at = this.#boundArgumentFor(typeParameterOfType(type), context);
    if (at) {
      return this.#extractLiteralLikeValue(
        at.argument.type,
        at.argument.node,
        at.context,
      );
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

    // `AnyOf<X>` is `{ readonly __ct_cfc_any_of__?: X }` as a type. That brand
    // is how the library writes the metadata into the type, so a type read
    // without a node is recognized by it, not by an alias name an author may
    // also use.
    const anyOfPayload = this.#anyOfBrandPayload(type, context);
    if (anyOfPayload) {
      const alternatives = this.#extractLiteralLikeValue(
        anyOfPayload,
        undefined,
        context,
      );
      return Array.isArray(alternatives) ? { anyOf: alternatives } : undefined;
    }

    if (checker.isTupleType(type)) {
      const { elementFlags } = (type as ts.TupleTypeReference).target;
      return checker.getTypeArguments(type as ts.TypeReference).flatMap(
        (element, index) => {
          const value = this.#extractLiteralLikeValue(
            element,
            undefined,
            context,
          );
          // A spread element stands for the elements of the list it is, and
          // one that is no list it reads is left unread.
          if ((elementFlags[index]! & ts.ElementFlags.Variadic) === 0) {
            return [value];
          }
          return Array.isArray(value) ? value : [undefined];
        },
      );
    }

    if ((type.flags & ts.TypeFlags.Object) !== 0) {
      const properties = checker.getPropertiesOfType(type);
      if (properties.length > 0) {
        const obj: Record<string, unknown> = {};
        for (const property of properties) {
          const propType = checker.getTypeOfSymbolAtLocation(
            property,
            property.valueDeclaration ?? property.declarations?.[0] ??
              context.typeNode ?? ({} as ts.Node),
          );
          // A member's annotation says what its type cannot, such as the
          // binding in `PolicyOf<typeof rules>`, and is read wherever it
          // denotes the member's type, paired with that type.
          const annotation = readMemberAnnotation(property, propType, checker);
          obj[property.getName()] = annotation
            ? this.#extractLiteralLikeValue(
              checker.getTypeFromTypeNode(annotation),
              annotation,
              context,
            )
            : this.#extractLiteralLikeValue(
              memberValueType(property, propType, checker),
              undefined,
              context,
            );
        }
        return obj;
      }
    }

    return undefined;
  }

  /**
   * Whether `typeName` refers to an alias whose type is the brand `brand`
   * names, an object holding that member alone, as `AnyOf` and `PolicyOf` are
   * (`@commonfabric/api/cfc`). An authored alias that shares their name and
   * not their brand is read as the type it is, as it is from its type.
   */
  #namesBrand(
    typeName: ts.EntityName,
    brand: string,
    context: GenerationContext,
  ): boolean {
    const checker = context.typeChecker;
    const symbol = checker.getSymbolAtLocation(typeName);
    const declared = symbol &&
      checker.getDeclaredTypeOfSymbol(resolveAliasedSymbol(symbol, checker));
    if (!declared || (declared.flags & ts.TypeFlags.Object) === 0) {
      return false;
    }
    const properties = checker.getPropertiesOfType(declared);
    return properties.length === 1 && properties[0]!.getName() === brand;
  }

  /**
   * `X`, for a type that is the brand `AnyOf<X>` is, `{ readonly
   * __ct_cfc_any_of__?: X }`, and `undefined` for any other type.
   */
  #anyOfBrandPayload(
    type: ts.Type,
    context: GenerationContext,
  ): ts.Type | undefined {
    if ((type.flags & ts.TypeFlags.Object) === 0) return undefined;
    const properties = context.typeChecker.getPropertiesOfType(type);
    const brand = properties.length === 1 ? properties[0]! : undefined;
    if (!brand || brand.getName() !== CFC_ANY_OF_BRAND) return undefined;
    return memberValueType(
      brand,
      context.typeChecker.getTypeOfSymbol(brand),
      context.typeChecker,
    );
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
    const at = this.#boundArgumentAt(typeNode, context);
    if (at) {
      return at.argument.node
        ? this.#extractDefaultValueFromNode(at.argument.node, at.context)
        : this.#extractDefaultValue(at.argument.type, at.context);
    }
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
        scopeOfAliasChain(memberType, context.typeChecker);
      if (memberScope !== undefined && !context.declaresNoScope) {
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
   * A wrapper that CFC labels hold is not one here (see the member loop).
   * Examples that return true: Reactive<T> | undefined, Cell<T> | null, Stream<T> | null | undefined
   * Examples that return false: string | Cell | null (mixed union, should use UnionFormatter),
   * Confidential<Cell<T>, …> | undefined (a labeled value)
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

      // A wrapper under CFC labels, as `Confidential<Cell<T>, …>` is, is a
      // labeled value rather than a wrapper: the labels ride on a carrier the
      // wrapper's own formatting reads past, so the union formatter reads it,
      // through the CFC alias.
      const wrapperInfo = getCellWrapperInfo(memberType, context.typeChecker);
      if (
        wrapperInfo !== undefined &&
        cfcCarriedParts(memberType, context.typeChecker) === undefined
      ) {
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
