import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import ts from "typescript";

import { reportUnresolvedDefault } from "../default-diagnostics.ts";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { unionFoldedFrom } from "../schema-origins.ts";
import { readBoundTypeNode } from "../type-parameter-bindings.ts";
import {
  cloneSchemaDefinition,
  detectWrapperViaNode,
  extractDefaultValueFromBrandedMembers,
  getNativeTypeSchema,
  getPropertyNameText,
  isEmptyObjectDefaultType,
  resolveWrapperNode,
  soleNonNullishMember,
  TypeWithInternals,
} from "../type-utils.ts";
import { hasDefaultMarker } from "../typescript/default-brand.ts";
import { extractLiteralValueOfSymbol } from "../typescript/literal-value.ts";
import {
  getTypeAliasDeclaration,
  readUnionMemberNodes,
  typeParameterOfReference,
  unwrapTypeParentheses,
} from "../typescript/type-node.ts";
import { dedupeByValueEqual } from "../value-equality.ts";

// Simple primitive schemas only have these keys (possibly just one)
const PRIMITIVE_SCHEMA_KEY_SET = new Set(["type", "enum"]);

/**
 * The base type `schema`'s literal values widen to: their shared `typeof`, read
 * from its `enum`, or from its `const`, when every value is a string, every
 * value a number, or every value a boolean. `undefined` when the schema holds
 * no literal values, or holds values of more than one type or of another.
 */
function widenedLiteralType(
  schema: MutableJSONSchemaObj,
): "string" | "number" | "boolean" | undefined {
  const values: readonly unknown[] | undefined = schema.enum ??
    ("const" in schema ? [schema.const] : undefined);
  const types = new Set(values?.map((value) => typeof value));
  if (types.size !== 1) return undefined;
  const [type] = types;
  return type === "string" || type === "number" || type === "boolean"
    ? type
    : undefined;
}

type DefaultUnionKind = "Default" | "DeepDefault";

interface DefaultUnionEntry {
  readonly kind: DefaultUnionKind;
  readonly valueTypeNode: ts.TypeNode;
  readonly defaultTypeNode: ts.TypeNode;
  readonly valueType: ts.Type;
  readonly defaultType: ts.Type;
  readonly defaultValue: unknown;
}

function getTypeNodeMemberType(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  try {
    return checker.getTypeFromTypeNode(node);
  } catch {
    return undefined;
  }
}

function unionMemberTypesMatch(
  left: ts.Type,
  right: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if (left === right) {
    return true;
  }

  return checker.typeToString(left) === checker.typeToString(right);
}

function orderMemberNodesBySemanticType(
  members: readonly ts.Type[],
  memberNodes: readonly ts.TypeNode[],
  checker: ts.TypeChecker,
): Array<ts.TypeNode | undefined> {
  const remaining = memberNodes.map((node) => ({
    node,
    type: getTypeNodeMemberType(node, checker),
  }));

  return members.map((member) => {
    const matchIndex = remaining.findIndex(({ type }) =>
      type !== undefined && unionMemberTypesMatch(type, member, checker)
    );
    if (matchIndex === -1) {
      return undefined;
    }

    const [match] = remaining.splice(matchIndex, 1);
    return match?.node;
  });
}

/**
 * Whether a written union member is read as one alternative, retaining the
 * information in `node` for every semantic member of `type`. `context` is
 * the enclosing union's.
 */
export type ReadsWhole = (
  type: ts.Type,
  node: ts.TypeNode,
  context: GenerationContext,
) => boolean;

/** A union member node read whole, and the type it stands for. */
export interface WholeMemberNode {
  readonly node: ts.TypeNode;
  readonly type: ts.Type;
}

/**
 * The nodes the members of a union are read at, `members` its members and
 * `unionNode` the union node spelling it:
 *
 * - `ordered` holds, for each member, the node whose type it is
 *   (`orderMemberNodesBySemanticType()`). A member node that writes a union,
 *   through parentheses and aliases without type parameters, is read for the
 *   members it writes (`readUnionMemberNodes()`), since the checker folds
 *   those into `members`.
 * - `wholeNodes` holds, by each member they stand for, the nodes `readsWhole`
 *   accepts, in the order they are written. A node can stand for several
 *   members, as `Confidential<A | B, …>` does, and several nodes for the same
 *   member: two whose labels differ only in the policy a `typeof` names have
 *   one type where the policies' bindings have one type.
 */
export function pairUnionMemberNodes(
  members: readonly ts.Type[],
  unionNode: ts.UnionTypeNode,
  checker: ts.TypeChecker,
  readsWhole: (type: ts.Type, node: ts.TypeNode) => boolean,
): {
  ordered: Array<ts.TypeNode | undefined>;
  wholeNodes: Map<ts.Type, WholeMemberNode[]>;
} {
  const read = new Set<ts.TypeNode>();
  const memberNodes = unionNode.types.flatMap((node) =>
    readUnionMemberNodes(node, checker, read)
  );
  const ordered = orderMemberNodesBySemanticType(members, memberNodes, checker);
  const wholeNodes = new Map<ts.Type, WholeMemberNode[]>();
  for (const node of memberNodes) {
    const type = getTypeNodeMemberType(node, checker);
    if (!type || !readsWhole(type, node)) continue;
    for (const member of type.isUnion() ? type.types : [type]) {
      wholeNodes.set(member, [...wholeNodes.get(member) ?? [], { node, type }]);
    }
  }
  return { ordered, wholeNodes };
}

export class UnionFormatter implements TypeFormatter {
  #schemaGenerator: SchemaGenerator;

  /**
   * Whether a written union member is read as one alternative for all the
   * semantic members it denotes (`pairUnionMemberNodes()`).
   */
  #readsWhole: ReadsWhole;

  constructor(schemaGenerator: SchemaGenerator, readsWhole: ReadsWhole) {
    this.#schemaGenerator = schemaGenerator;
    this.#readsWhole = readsWhole;
  }

  supportsType(type: ts.Type, _context: GenerationContext): boolean {
    return (type.flags & ts.TypeFlags.Union) !== 0;
  }

  /** Adds the checker's optional-property alternative to a declared reading. */
  withUndefined(
    schema: MutableJSONSchema,
    context: GenerationContext,
  ): MutableJSONSchema {
    const { default: value, ...payload } = typeof schema === "object"
      ? schema
      : { default: undefined };
    const union = this.#combineUnionSchemas(
      [typeof schema === "object" ? payload : schema, { type: "undefined" }],
      context,
    );
    return this.#applySchemaDefault(union, value);
  }

  /**
   * Formats a written union containing a default under its parameter bindings,
   * or returns `undefined` when the union declares no default. The instantiated
   * type supplies the semantic members used for default coverage checks.
   */
  formatDefaultUnion(
    node: ts.UnionTypeNode,
    context: GenerationContext,
  ): MutableJSONSchema | undefined {
    const type = context.instantiatedAs ??
      context.typeRegistry?.get(node) ??
      context.typeChecker.getTypeFromTypeNode(node);
    return this.#tryFormatDefaultUnion(
      node.types,
      type.isUnion() ? type.types : [type],
      context,
    );
  }

  /**
   * Formats a written union whose CFC alternatives share a semantic member.
   * Each alternative carries its own binding identities even when the checker
   * reduces the entire union to one type. Returns `undefined` for other types.
   */
  formatCollapsedUnion(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema | undefined {
    const node = this.#getUnionTypeNode(context.typeNode, context.typeChecker);
    if (!node) return undefined;
    const members = type.isUnion() ? type.types : [type];
    const paired = pairUnionMemberNodes(
      members,
      node,
      context.typeChecker,
      (member, at) => this.#readsWhole(member, at, context),
    );
    return members.some((member) =>
        (paired.wholeNodes.get(member)?.length ?? 0) > 1
      )
      ? this.formatType(type, context)
      : undefined;
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const members = type.isUnion() ? type.types : [type];
    const unionNode = this.#getUnionTypeNode(
      context.typeNode,
      context.typeChecker,
    );
    const memberNodes = unionNode ? unionNode.types : undefined;
    const paired = unionNode
      ? pairUnionMemberNodes(
        members,
        unionNode,
        context.typeChecker,
        (union, node) => this.#readsWhole(union, node, context),
      )
      : undefined;
    const orderedMemberNodes = paired?.ordered;

    if (members.length === 0) {
      throw new Error("UnionFormatter received empty union type");
    }

    const defaultUnionSchema = memberNodes
      ? this.#tryFormatDefaultUnion(
        memberNodes,
        context.instantiatedAs?.isUnion()
          ? context.instantiatedAs.types
          : context.instantiatedAs
          ? [context.instantiatedAs]
          : members,
        context,
      )
      : undefined;
    if (defaultUnionSchema !== undefined) {
      return defaultUnionSchema;
    }

    // General expanded-Default recovery: when Default<T, V> reaches us
    // already resolved away by the checker (no intact alias node anywhere),
    // the union is `T | (T & DefaultMarker<V>)` and the brand payload
    // carries V. Format the unbranded members and attach the extracted
    // default — no authored AST required.
    const expandedDefault = this.#tryFormatExpandedDefaultViaBrandPayload(
      members,
      orderedMemberNodes,
      context,
    );
    if (expandedDefault !== undefined) {
      return expandedDefault;
    }

    // Detect presence of null
    const hasNull = members.some((m) => (m.flags & ts.TypeFlags.Null) !== 0);
    // nonNull excludes only null; undefined members are kept because undefined is
    // now represented explicitly as { type: "undefined" } rather than being stripped.
    const nonNull = members.filter((m) => (m.flags & ts.TypeFlags.Null) === 0);
    // The one member that is neither `null` nor `undefined` is read at the
    // union's instantiation less those (`GenerationContext.instantiatedAs`);
    // any other member has none.
    const valued = nonNull.filter((m) =>
      (m.flags & ts.TypeFlags.Undefined) === 0
    );
    const soleInstantiated = valued.length === 1 && context.instantiatedAs
      ? soleNonNullishMember(context.instantiatedAs)
      : undefined;

    const generate = (
      t: ts.Type,
      memberIndex: number,
      typeNode?: ts.TypeNode,
    ): MutableJSONSchema => {
      const memberNode = typeNode ?? orderedMemberNodes?.[memberIndex];
      const wrapperKind = detectWrapperViaNode(
        memberNode,
        context.typeChecker,
      );
      const native = wrapperKind === undefined
        ? getNativeTypeSchema(t, context.typeChecker)
        : undefined;
      if (native !== undefined) {
        return cloneSchemaDefinition(native);
      }
      return this.#schemaGenerator.formatChildType(
        t,
        context,
        memberNode,
        t === valued[0] ? soleInstantiated : undefined,
      );
    };

    // Case: exactly one non-null member + null => anyOf (nullable type).
    // Note: We use anyOf instead of oneOf for better consumer compatibility.
    // For nullable types (T | null), both work identically since a value is either
    // null OR the other type, never both. anyOf is more easily supported.
    // Note: if undefined is also present (T | null | undefined), nonNull.length > 1,
    // so we fall through to the anyOf path which emits { type: "undefined" } explicitly.
    if (
      hasNull && nonNull.length === 1 &&
      (paired?.wholeNodes.get(nonNull[0]!)?.length ?? 0) < 2
    ) {
      const item = generate(nonNull[0]!, members.indexOf(nonNull[0]!));
      return { anyOf: [item, { type: "null" }] };
    }

    // Case: all non-null members are literals -> enum.
    // Note: undefined prevents this path since it doesn't match any literal flag,
    // intentionally falling through to the anyOf path which emits { type: "undefined" }.
    // Include null in the enum if present (null is a runtime value; undefined is
    // represented as a separate { type: "undefined" } schema member instead).
    const allLiteral = nonNull.length > 0 &&
      nonNull.every((m) =>
        (m.flags & ts.TypeFlags.StringLiteral) !== 0 ||
        (m.flags & ts.TypeFlags.NumberLiteral) !== 0 ||
        (m.flags & ts.TypeFlags.BooleanLiteral) !== 0
      );

    if (allLiteral) {
      const values: Array<string | number | boolean | null> = nonNull.map(
        (m) => {
          if (m.flags & ts.TypeFlags.StringLiteral) {
            return (m as ts.StringLiteralType).value;
          }
          if (m.flags & ts.TypeFlags.NumberLiteral) {
            return (m as ts.NumberLiteralType).value;
          }
          if (m.flags & ts.TypeFlags.BooleanLiteral) {
            return (m as TypeWithInternals).intrinsicName === "true";
          }
          return undefined;
        },
      ).filter((v) => v !== undefined) as Array<string | number | boolean>;

      // Special case: union of both boolean literals {true, false} becomes type: "boolean"
      const boolValues = values.filter((v) => typeof v === "boolean");
      const nonBoolValues = values.filter((v) => typeof v !== "boolean");

      if (boolValues.length === 2 && nonBoolValues.length === 0) {
        // TypeScript represents boolean as the union true | false. Preserve a
        // nullable member when collapsing those literals to boolean.
        return hasNull
          ? { anyOf: [{ type: "boolean" }, { type: "null" }] }
          : { type: "boolean" };
      }

      // Include null in enum values if present (null can be a runtime value, unlike undefined)
      if (hasNull) {
        values.push(null);
      }

      return { enum: values };
    }

    // Fallback: anyOf of member schemas (excluding null/undefined handled above).
    // Each accepted node is read once, as one alternative for all the members
    // it denotes. The node retains what their types cannot, such as a policy
    // binding in `Confidential<A | B, …>`. Nodes sharing even a single member
    // remain separate alternatives.
    const readWholeNodes = new Set<ts.TypeNode>();
    let unionOptions = members.flatMap((m, index) => {
      const wholeNodes = paired?.wholeNodes.get(m);
      if (!wholeNodes) return [generate(m, index)];
      return wholeNodes.filter(({ node }) => !readWholeNodes.has(node)).map(
        ({ node, type }) => {
          readWholeNodes.add(node);
          return this.#schemaGenerator.formatChildType(
            type,
            wholeNodes.length > 1
              ? { ...context, inlineUnionMember: node }
              : context,
            node,
            type === valued[0] ? soleInstantiated : undefined,
          );
        },
      );
    });
    // When widenLiterals is true, try to merge structurally identical schemas
    // that only differ in literal enum values
    if (context.widenLiterals && unionOptions.length > 1) {
      unionOptions = this.#mergeIdenticalSchemas(unionOptions);
    }
    const anyOf: MutableJSONSchemaObj[] = [];
    for (const option of unionOptions) {
      // mergePrimitiveSchemaIntoAnyOf mutates anyOf in place; returns true to short-circuit
      if (this.#mergePrimitiveSchemaIntoAnyOf(anyOf, option)) {
        return true;
      }
    }

    // If only one schema remains after filtering/merging, return it directly
    // without anyOf wrapper. Emitted schemas can coincide while the source
    // types still form a union, as `void | OpaqueCell<any>` does and as two
    // branded primitives do, so the fold above is recorded.
    return unionFoldedFrom(
      anyOf.length === 1 ? anyOf[0]! : { anyOf },
      unionOptions,
      anyOf.length,
      context,
    );
  }

  /**
   * Recover `"default"` from the DEFAULT_MARKER brand payload when the union
   * reaches us with the `Default<>` alias already resolved away — the general
   * case behind every "defaults dropped from injected schemas" regression:
   * capture shrinking, path lowering, projection, and generic instantiation
   * all rebuild types from the checker, where the authored alias node is
   * gone. The brand payload carries V (see Default<> in packages/api), so no
   * authored AST is required.
   *
   * Authored-node handling stays primary: tryFormatDefaultUnion runs first
   * and also covers non-literal V forms (e.g. `typeof CONST`) via
   * declaration reads. This fallback fires only when the alias node is
   * unavailable. An actual Default brand with an unextractable or conflicting
   * payload produces a warning before falling back to ordinary union formatting.
   */
  #tryFormatExpandedDefaultViaBrandPayload(
    members: readonly ts.Type[],
    orderedMemberNodes: ReadonlyArray<ts.TypeNode | undefined> | undefined,
    context: GenerationContext,
  ): MutableJSONSchema | undefined {
    const checker = context.typeChecker;
    // Only a member carrying DEFAULT_MARKER is a brand arm. A propertyless
    // member without one is a value: the plain arm of `Default<{}>` or of
    // `Default<Record<PropertyKey, never>>` has no properties either.
    const branded = members.filter((m) => hasDefaultMarker(m, checker));
    if (branded.length === 0) return undefined;

    // A union-valued default (`Default<boolean, true>`,
    // `Default<"a" | "b", "a">`) distributes the brand across SEVERAL members,
    // all carrying the same payload — extract the agreed value across all of
    // them, and exclude all of them from the formatted remainder.
    const extracted = extractDefaultValueFromBrandedMembers(branded, checker);
    if (!extracted) {
      reportUnresolvedDefault(context);
      return undefined;
    }

    let rest = members.filter((m) => !hasDefaultMarker(m, checker));
    // Degenerate empty-array members (the empty tuple `[]` / `never[]`) ride
    // along with expanded array Defaults (historically the unbranded arm of
    // `Default<[]>`, see CT-1639/CT-1640). When a real array member is
    // present they contribute nothing — but formatted as members they would
    // split the real array's schema into anyOf branches, dropping
    // per-element capabilities like asCell:["comparable"] from the
    // consumer's view. Collapse them into the real member.
    //
    // Safety: dropping the `[]`/`never[]` arm never narrows the accepted set
    // because ArrayFormatter emits array/tuple schemas with no length bound
    // (no minItems/prefixItems) — so `[]` is always a valid instance of the
    // surviving real member, and a recovered `default: []` validates against
    // it. If array length constraints are ever emitted, gate this pruning to
    // the expanded-empty-default shape before relying on it.
    const hasRealArray = rest.some((m) =>
      (checker.isArrayType(m) || checker.isTupleType(m)) &&
      !this.#isEmptyArrayType(m, checker)
    );
    if (hasRealArray) {
      rest = rest.filter((m) => !this.#isEmptyArrayType(m, checker));
    }
    if (rest.length === 0) return undefined;
    const schemas = rest.map((m) => {
      const memberNode = orderedMemberNodes?.[members.indexOf(m)];
      const native = detectWrapperViaNode(memberNode, context.typeChecker) ===
          undefined
        ? getNativeTypeSchema(m, context.typeChecker)
        : undefined;
      if (native !== undefined) {
        return cloneSchemaDefinition(native) as MutableJSONSchema;
      }
      return this.#schemaGenerator.formatChildType(m, context, memberNode);
    });
    return this.#applySchemaDefault(
      this.#combineUnionSchemas(schemas, context),
      extracted.value,
    );
  }

  #tryFormatDefaultUnion(
    memberNodes: readonly ts.TypeNode[],
    members: readonly ts.Type[],
    context: GenerationContext,
  ): MutableJSONSchema | undefined {
    const defaultEntries = memberNodes
      .map((node, index) => ({
        index,
        node,
        entry: this.#getDefaultUnionEntry(node, context),
      }))
      .filter((item): item is {
        index: number;
        node: ts.TypeNode;
        entry: DefaultUnionEntry;
      } => item.entry !== undefined);

    if (defaultEntries.length === 0) {
      return undefined;
    }
    if (defaultEntries.length > 1) {
      throw new Error(
        "Union types may contain at most one Default<> member.",
      );
    }

    const defaultEntry = defaultEntries[0]!;
    const nonDefaultNodes = memberNodes.filter((_, index) =>
      index !== defaultEntry.index
    );
    const nonDefaultTypes = nonDefaultNodes.map((node) =>
      readBoundTypeNode(node, context, members)
    );

    const schemas: MutableJSONSchema[] = [];
    for (const [index, node] of nonDefaultNodes.entries()) {
      schemas.push(
        this.#formatTypeNodeMember(
          node,
          context,
          context.typeRegistry?.get(node) ?? nonDefaultTypes[index],
        ),
      );
    }

    if (defaultEntry.entry.kind === "DeepDefault") {
      this.#assertDeepDefaultHasObjectTarget(
        defaultEntry.entry,
        nonDefaultTypes,
        context.typeChecker,
      );
      if (defaultEntry.entry.defaultValue === undefined) {
        reportUnresolvedDefault(
          context,
          defaultEntry.entry.defaultTypeNode,
          "DeepDefault",
        );
      }
      return this.#applyDeepDefaultToSchema(
        this.#combineUnionSchemas(schemas, context),
        defaultEntry.entry.defaultValue,
        context.definitions,
      );
    }

    const isCovered = this.#isDefaultCoveredByUnion(
      defaultEntry.entry,
      nonDefaultTypes,
      context.typeChecker,
    );
    this.#assertDefaultObjectDoesNotWidenExistingObject(
      defaultEntry.entry,
      nonDefaultTypes,
      isCovered,
      context.typeChecker,
    );

    if (!isCovered) {
      schemas.push(
        this.#formatTypeNodeMember(defaultEntry.entry.valueTypeNode, context),
      );
    }

    if (defaultEntry.entry.defaultValue === undefined) {
      reportUnresolvedDefault(context, defaultEntry.entry.defaultTypeNode);
    }

    return this.#applySchemaDefault(
      this.#combineUnionSchemas(schemas, context),
      defaultEntry.entry.defaultValue,
    );
  }

  /** Empty tuple `[]`, or `never[]`. */
  #isEmptyArrayType(type: ts.Type, checker: ts.TypeChecker): boolean {
    if (checker.isTupleType(type)) {
      return checker.getTypeArguments(type as ts.TypeReference).length === 0;
    }
    if (checker.isArrayType(type)) {
      const elementType = checker.getTypeArguments(
        type as ts.TypeReference,
      )[0];
      return !!elementType && (elementType.flags & ts.TypeFlags.Never) !== 0;
    }
    return false;
  }

  /**
   * The union node `typeNode` stands for, read through parentheses and through
   * aliases without type parameters, or `undefined` when it stands for none.
   * A circular alias throws.
   */
  #getUnionTypeNode(
    typeNode: ts.TypeNode | undefined,
    checker: ts.TypeChecker,
    followed = new Set<ts.TypeAliasDeclaration>(),
  ): ts.UnionTypeNode | undefined {
    if (!typeNode) {
      return undefined;
    }

    const unwrapped = unwrapTypeParentheses(typeNode);
    if (ts.isUnionTypeNode(unwrapped)) {
      return unwrapped;
    }
    if (
      !ts.isTypeReferenceNode(unwrapped) || unwrapped.typeArguments?.length
    ) {
      return undefined;
    }

    const aliasDeclaration = getTypeAliasDeclaration(unwrapped, checker);
    if (!aliasDeclaration || aliasDeclaration.typeParameters?.length) {
      return undefined;
    }
    if (followed.has(aliasDeclaration)) {
      throw new Error(
        `Circular type alias detected: ${aliasDeclaration.name.text}`,
      );
    }
    followed.add(aliasDeclaration);
    return this.#getUnionTypeNode(aliasDeclaration.type, checker, followed);
  }

  #getDefaultUnionEntry(
    memberNode: ts.TypeNode,
    context: GenerationContext,
  ): DefaultUnionEntry | undefined {
    if (!ts.isTypeReferenceNode(memberNode)) {
      return undefined;
    }

    const directName = this.#getTypeReferenceName(memberNode);
    if (directName === "DeepDefault") {
      const typeArgs = memberNode.typeArguments;
      if (!typeArgs || typeArgs.length !== 1 || !typeArgs[0]) {
        throw new Error("DeepDefault<V> requires exactly 1 type argument");
      }
      const valueTypeNode = typeArgs[0];
      return {
        kind: "DeepDefault",
        valueTypeNode,
        defaultTypeNode: valueTypeNode,
        valueType: readBoundTypeNode(valueTypeNode, context),
        defaultType: readBoundTypeNode(valueTypeNode, context),
        defaultValue: this.#extractDefaultValueFromNode(
          valueTypeNode,
          context,
        ),
      };
    }

    const resolved = resolveWrapperNode(memberNode, context.typeChecker);
    if (resolved?.kind !== "Default") {
      return undefined;
    }
    const typeArgs = resolved.node.typeArguments;
    if (!typeArgs || typeArgs.length < 1 || typeArgs.length > 2) {
      throw new Error("Default<T,V> requires 1 or 2 type arguments");
    }

    const valueTypeNode = typeArgs[0];
    const defaultTypeNode = typeArgs[1] ?? valueTypeNode;
    if (!valueTypeNode || !defaultTypeNode) {
      throw new Error("Default<T,V> type arguments cannot be undefined");
    }
    const valueType = readBoundTypeNode(valueTypeNode, context);
    const defaultType = readBoundTypeNode(defaultTypeNode, context);
    if (typeArgs.length === 1 && this.#isUndefinedType(valueType)) {
      throw new Error(
        "Default<undefined> is unsupported; use an optional field or a JSON value default.",
      );
    }

    return {
      kind: "Default",
      valueTypeNode,
      defaultTypeNode,
      valueType,
      defaultType,
      defaultValue: this.#extractDefaultValueFromNode(defaultTypeNode, context),
    };
  }

  #getTypeReferenceName(typeNode: ts.TypeReferenceNode): string {
    const typeName = typeNode.typeName;
    return ts.isIdentifier(typeName) ? typeName.text : typeName.right.text;
  }

  #isDefaultCoveredByUnion(
    defaultEntry: DefaultUnionEntry,
    nonDefaultTypes: readonly ts.Type[],
    checker: ts.TypeChecker,
  ): boolean {
    return nonDefaultTypes.some((memberType) =>
      checker.isTypeAssignableTo(defaultEntry.defaultType, memberType)
    );
  }

  #assertDefaultObjectDoesNotWidenExistingObject(
    defaultEntry: DefaultUnionEntry,
    nonDefaultTypes: readonly ts.Type[],
    isCovered: boolean,
    checker: ts.TypeChecker,
  ): void {
    if (
      isCovered || !this.#isPlainObjectType(defaultEntry.defaultType, checker)
    ) {
      return;
    }

    const hasObjectTarget = nonDefaultTypes.some((memberType) =>
      this.#isPlainObjectType(memberType, checker)
    );
    if (!hasObjectTarget) {
      return;
    }

    throw new Error(
      "Default object union member is not assignable to the existing object type. Use T | Default<V> for full defaults or T | DeepDefault<V> for partial object defaults.",
    );
  }

  #assertDeepDefaultHasObjectTarget(
    defaultEntry: DefaultUnionEntry,
    nonDefaultTypes: readonly ts.Type[],
    checker: ts.TypeChecker,
  ): void {
    const hasObjectTarget = nonDefaultTypes.some((memberType) =>
      this.#isPlainObjectType(memberType, checker)
    );
    if (
      hasObjectTarget &&
      this.#isPlainObjectType(defaultEntry.defaultType, checker)
    ) {
      return;
    }

    throw new Error(
      "DeepDefault must be unioned with an object type and must provide an object default.",
    );
  }

  #isPlainObjectType(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): boolean {
    if ((type.flags & ts.TypeFlags.Object) === 0) {
      return false;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      return false;
    }
    const symbolName = type.getSymbol()?.getName();
    return symbolName !== "Array" && symbolName !== "ReadonlyArray";
  }

  #formatTypeNodeMember(
    typeNode: ts.TypeNode,
    context: GenerationContext,
    instantiatedAs?: ts.Type,
  ): MutableJSONSchema {
    const type = context.typeChecker.getTypeFromTypeNode(typeNode);
    const native = detectWrapperViaNode(typeNode, context.typeChecker) ===
        undefined
      ? getNativeTypeSchema(type, context.typeChecker)
      : undefined;
    if (native !== undefined) {
      return cloneSchemaDefinition(native);
    }
    return this.#schemaGenerator.formatChildType(
      type,
      context,
      typeNode,
      instantiatedAs,
    );
  }

  #combineUnionSchemas(
    schemas: MutableJSONSchema[],
    context: GenerationContext,
  ): MutableJSONSchema {
    if (schemas.length === 0) {
      return true;
    }
    if (schemas.length === 1) {
      return schemas[0]!;
    }
    const nullSchema = schemas.find((schema) =>
      isObjectOrArray(schema) && schema.type === "null"
    );
    const nonNullSchemas = schemas.filter((schema) => schema !== nullSchema);
    if (nullSchema && nonNullSchemas.length === 1) {
      return { anyOf: [nonNullSchemas[0]!, nullSchema] };
    }

    let unionOptions = schemas;
    if (context.widenLiterals && unionOptions.length > 1) {
      unionOptions = this.#mergeIdenticalSchemas(unionOptions);
    }

    const anyOf: MutableJSONSchemaObj[] = [];
    for (const option of unionOptions) {
      if (this.#mergePrimitiveSchemaIntoAnyOf(anyOf, option)) {
        return true;
      }
    }

    if (anyOf.length === 0) {
      return false;
    }
    if (anyOf.length === 1) {
      return anyOf[0]!;
    }

    return { anyOf };
  }

  #applySchemaDefault(
    schema: MutableJSONSchema,
    defaultValue: unknown,
  ): MutableJSONSchema {
    if (defaultValue === undefined) {
      return schema;
    }
    const value = defaultValue as NonNullable<MutableJSONSchemaObj["default"]>;

    if (typeof schema === "boolean") {
      return schema === false
        ? { not: true, default: value }
        : { default: value };
    }

    return {
      ...schema,
      default: value,
    };
  }

  #applyDeepDefaultToSchema(
    schema: MutableJSONSchema,
    defaultValue: unknown,
    rootDefs?: Record<string, unknown>,
  ): MutableJSONSchema {
    const withDefault = this.#applySchemaDefault(schema, defaultValue);
    if (!this.#isDefaultObject(defaultValue) || !isObjectOrArray(withDefault)) {
      return withDefault;
    }

    return this.#applyObjectPropertyDefaults(
      withDefault,
      defaultValue,
      [],
      this.#getSchemaDefs(withDefault) ?? rootDefs,
    );
  }

  #applyObjectPropertyDefaults(
    schema: MutableJSONSchemaObj,
    defaults: Record<string, unknown>,
    path: string[] = [],
    rootDefs?: Record<string, unknown>,
    targetSchema?: MutableJSONSchema,
  ): MutableJSONSchemaObj {
    const properties = isObjectOrArray(schema.properties)
      ? { ...schema.properties }
      : {};
    const targetProperties = this.#getObjectTargetProperties(
      isObjectOrArray(targetSchema) ? targetSchema : schema,
      rootDefs,
    );

    for (const [name, value] of Object.entries(defaults)) {
      const fullPath = [...path, name];
      const targetExisting = (properties[name] ??
        targetProperties?.[name]) as MutableJSONSchema | undefined;
      if (targetExisting === undefined) {
        throw new Error(
          `DeepDefault key "${
            fullPath.join(".")
          }" does not exist on the target object type.`,
        );
      }
      properties[name] = this.#applyDeepDefaultToProperty(
        properties[name] as MutableJSONSchema | undefined,
        value,
        fullPath,
        rootDefs,
        targetExisting,
      );
    }

    return {
      ...schema,
      properties,
    };
  }

  #applyDeepDefaultToProperty(
    schema: MutableJSONSchema | undefined,
    defaultValue: unknown,
    path: string[] = [],
    rootDefs?: Record<string, unknown>,
    targetSchema?: MutableJSONSchema,
  ): MutableJSONSchema {
    const withDefault = this.#applySchemaDefault(schema ?? true, defaultValue);
    if (!this.#isDefaultObject(defaultValue) || !isObjectOrArray(withDefault)) {
      return withDefault;
    }

    return this.#applyObjectPropertyDefaults(
      withDefault,
      defaultValue,
      path,
      rootDefs,
      targetSchema,
    );
  }

  #getObjectTargetProperties(
    schema: MutableJSONSchemaObj,
    rootDefs?: Record<string, unknown>,
    seen = new Set<MutableJSONSchemaObj>(),
  ): Record<string, unknown> | undefined {
    if (seen.has(schema)) {
      return undefined;
    }
    seen.add(schema);

    if (isObjectOrArray(schema.properties)) {
      return schema.properties;
    }

    const refSchema = this.#resolveLocalRefSchema(schema, rootDefs);
    if (refSchema) {
      return this.#getObjectTargetProperties(refSchema, rootDefs, seen);
    }

    if (Array.isArray(schema.anyOf)) {
      const candidates = schema.anyOf
        .map((option) =>
          isObjectOrArray(option)
            ? this.#getObjectTargetProperties(
              option as MutableJSONSchemaObj,
              rootDefs,
              new Set(seen),
            )
            : undefined
        )
        .filter((properties): properties is Record<string, unknown> =>
          properties !== undefined
        );

      if (candidates.length === 1) {
        return candidates[0];
      }
    }

    return undefined;
  }

  #resolveLocalRefSchema(
    schema: MutableJSONSchemaObj,
    rootDefs?: Record<string, unknown>,
  ): MutableJSONSchemaObj | undefined {
    if (typeof schema.$ref !== "string") {
      return undefined;
    }
    const prefix = "#/$defs/";
    if (!schema.$ref.startsWith(prefix)) {
      return undefined;
    }

    const defs = this.#getSchemaDefs(schema) ?? rootDefs;
    const resolved = defs?.[schema.$ref.slice(prefix.length)];
    return isObjectOrArray(resolved)
      ? resolved as MutableJSONSchemaObj
      : undefined;
  }

  #getSchemaDefs(
    schema: MutableJSONSchemaObj,
  ): Record<string, unknown> | undefined {
    if (isObjectOrArray(schema.$defs)) {
      return schema.$defs;
    }
    return isObjectOrArray(schema.definitions) ? schema.definitions : undefined;
  }

  #isDefaultObject(value: unknown): value is Record<string, unknown> {
    return isObjectNotArray(value);
  }

  #extractDefaultValueFromNode(
    typeNode: ts.TypeNode,
    context: GenerationContext,
  ): unknown {
    const parameter = typeParameterOfReference(typeNode, context.typeChecker);
    const argument = parameter &&
      context.boundTypeParameters?.arguments.get(parameter);
    if (argument) {
      const { boundTypeParameters: _, ...outer } = context;
      const argumentContext = argument.bound
        ? { ...outer, boundTypeParameters: argument.bound }
        : outer;
      return argument.node
        ? this.#extractDefaultValueFromNode(argument.node, argumentContext)
        : this.#extractDefaultValue(argument.type, argumentContext);
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

    if (typeNode.kind === ts.SyntaxKind.NullKeyword) return null;
    if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;

    return this.#extractDefaultValue(
      context.typeChecker.getTypeFromTypeNode(typeNode),
      context,
    );
  }

  #extractDefaultValue(
    type: ts.Type,
    context: GenerationContext,
  ): unknown {
    if (type.flags & ts.TypeFlags.StringLiteral) {
      return (type as ts.StringLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      return (type as ts.NumberLiteralType).value;
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return (type as TypeWithInternals).intrinsicName === "true";
    }
    if (type.flags & ts.TypeFlags.Null) {
      return null;
    }
    if (type.flags & ts.TypeFlags.Undefined) {
      return undefined;
    }

    if (isEmptyObjectDefaultType(type, context.typeChecker)) {
      return {};
    }

    const symbol = type.getSymbol();
    if (symbol?.valueDeclaration) {
      return this.#extractValueFromSymbol(symbol, context);
    }

    return undefined;
  }

  #extractValueFromTypeQuery(
    typeQueryNode: ts.TypeQueryNode,
    context: GenerationContext,
  ): unknown {
    const symbol = context.typeChecker.getSymbolAtLocation(
      typeQueryNode.exprName,
    );
    return symbol ? this.#extractValueFromSymbol(symbol, context) : undefined;
  }

  #extractValueFromSymbol(
    symbol: ts.Symbol,
    context: GenerationContext,
  ): unknown {
    return extractLiteralValueOfSymbol(symbol, context.typeChecker)?.value;
  }

  #isUndefinedType(type: ts.Type): boolean {
    return (type.flags & ts.TypeFlags.Undefined) !== 0;
  }

  /**
   * Merge schemas that are structurally identical except for literal enum values.
   * Used when widenLiterals is true to collapse unions like
   * {x: {enum: [10]}} | {x: {enum: [20]}} into {x: {type: "number"}}.
   * Schemas that differ in any other keyword, at any depth, stay apart, and
   * a merged schema keeps every keyword its members share.
   */
  #mergeIdenticalSchemas(
    schemas: MutableJSONSchema[],
  ): MutableJSONSchema[] {
    if (schemas.length <= 1) return schemas;

    // Group schemas by their structure (ignoring enum values)
    const groups = new Map<string, MutableJSONSchema[]>();

    for (const schema of schemas) {
      const normalized = this.#normalizeSchemaForComparison(schema);
      const key = hashStringOf(normalized as FabricValue);
      const group = groups.get(key) ?? [];
      group.push(schema);
      groups.set(key, group);
    }

    // For each group with multiple schemas, try to merge them
    const result: MutableJSONSchema[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        result.push(group[0]!);
      } else {
        // Multiple schemas with same structure - merge them
        result.push(this.#mergeSchemaGroup(group));
      }
    }

    return result;
  }

  /**
   * Merge `cur` into the `anyOf` accumulator array in place.
   * Returns true if the result is the permissive schema (short-circuit the caller).
   */
  #mergePrimitiveSchemaIntoAnyOf(
    anyOf: MutableJSONSchemaObj[],
    cur: MutableJSONSchema,
  ): boolean {
    if (cur === true) {
      // One of our anyOf values was true, so return true to let our caller
      // know that they can skip the anyOf and just use `true` for the schema.
      return true;
    } else if (cur === false) {
      // One of our anyOf values was false. This has no effect on the anyOf,
      // so we don't need to add it to the list, and we can just return.
      return false;
    }
    const curHash = hashStringOf(cur);
    if (anyOf.some((option) => hashStringOf(option) === curHash)) {
      return false;
    }
    const isCurPrimitive = PRIMITIVE_SCHEMA_KEY_SET.isSupersetOf(
      new Set(Object.keys(cur)),
    );
    // Merge only schemas whose complete meaning is a primitive type and enum.
    const matchingTypeIdx = anyOf.findIndex((option) =>
      isCurPrimitive &&
      isObjectOrArray(option) &&
      PRIMITIVE_SCHEMA_KEY_SET.isSupersetOf(new Set(Object.keys(option))) &&
      "type" in option && option.type === cur.type
    );
    const matchingType = matchingTypeIdx !== -1
      ? anyOf[matchingTypeIdx]
      : undefined;
    if (
      isObjectOrArray(cur) && Array.isArray(cur.enum) &&
      isObjectOrArray(matchingType) &&
      Array.isArray(matchingType.enum)
    ) {
      // Add our enum values to their enum values, and keep the same type.
      // Dedupe by `valueEqual` rather than a `Set`: a `Set` uses SameValueZero,
      // which would collapse `-0` and `0` into one enum member, where the value
      // model keeps them distinct.
      const mergedEnum = dedupeByValueEqual([
        ...matchingType.enum,
        ...cur.enum,
      ]);
      // Special case for boolean with all options
      if (
        cur.type === "boolean" && mergedEnum.includes(true) &&
        mergedEnum.includes(false)
      ) {
        // this collapse may allow us to combine with other options that have only a type,
        // but I'm not doing that currently.
        const { enum: _dropped, ...rest } = matchingType;
        anyOf[matchingTypeIdx] = rest;
      } else {
        anyOf[matchingTypeIdx] = {
          ...matchingType,
          enum: mergedEnum.toSorted(),
        };
      }
    } else if (isObjectOrArray(matchingType)) {
      // If either entry is missing an enum, we can have any value of that type, so clear enum
      const { enum: _dropped, ...rest } = matchingType;
      anyOf[matchingTypeIdx] = rest;
    } else if (
      isCurPrimitive && cur.enum === undefined && cur.type !== undefined
    ) {
      // If cur is a primitive non-enum with a known type, we can merge with any existing non-enum primitive
      const matchingNonEnumIdx = anyOf.findIndex((option) =>
        isObjectOrArray(option) &&
        PRIMITIVE_SCHEMA_KEY_SET.isSupersetOf(new Set(Object.keys(option))) &&
        option.enum === undefined
      );
      const matchingNonEnum = matchingNonEnumIdx !== -1
        ? anyOf[matchingNonEnumIdx]
        : undefined;
      if (isObjectOrArray(matchingNonEnum) && matchingNonEnumIdx !== -1) {
        const curTypes = Array.isArray(cur.type) ? cur.type : [cur.type];
        const matchingNonEnumTypes = matchingNonEnum.type === undefined
          ? []
          : Array.isArray(matchingNonEnum.type)
          ? matchingNonEnum.type
          : [matchingNonEnum.type];
        anyOf[matchingNonEnumIdx] = {
          ...matchingNonEnum,
          type: [...new Set([...curTypes, ...matchingNonEnumTypes])].toSorted(),
        };
      } else {
        anyOf.push(cur);
      }
    } else {
      anyOf.push(cur);
    }
    return false;
  }

  /**
   * What two schemas must share to merge: every keyword of `schema`, with
   * literal values that `widenedLiteralType()` widens read as their base type,
   * and `properties` and `items` read the same way.
   */
  #normalizeSchemaForComparison(
    schema: MutableJSONSchema,
  ): Record<string, unknown> {
    if (typeof schema === "boolean") return { _bool: schema };

    const { properties, items, ...rest } = schema;
    const result: Record<string, unknown> = { ...rest };
    const widened = widenedLiteralType(schema);
    if (widened !== undefined) {
      delete result.enum;
      delete result.const;
      result.type = widened;
    }
    if (isObjectNotArray(properties)) {
      result.properties = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          this.#normalizeSchemaForComparison(value as MutableJSONSchema),
        ]),
      );
    } else if (properties !== undefined) {
      result.properties = properties;
    }
    if (items !== undefined) {
      result.items = this.#normalizeSchemaForComparison(
        items as MutableJSONSchema,
      );
    }
    return result;
  }

  /**
   * Merge a group of schemas that `#normalizeSchemaForComparison()` reads
   * alike, widening their literal values to the base type they share. Every
   * other keyword is the same across the group, so the first schema's stands
   * for all of them, in the order it writes them.
   */
  #mergeSchemaGroup(
    schemas: MutableJSONSchema[],
  ): MutableJSONSchema {
    if (schemas.length === 0) {
      throw new Error("Cannot merge empty schema group");
    }

    const first = schemas[0]!;
    if (typeof first === "boolean") return first;

    const widened = widenedLiteralType(first);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(first)) {
      if (
        widened !== undefined &&
        (key === "type" || key === "enum" || key === "const")
      ) {
        result.type = widened;
      } else if (key === "properties" && isObjectNotArray(value)) {
        result.properties = Object.fromEntries(
          Object.keys(value).map((property) => [
            property,
            this.#mergeSchemaGroup(
              schemas.flatMap((schema) =>
                isObjectOrArray(schema) && isObjectNotArray(schema.properties)
                  ? [schema.properties[property] as MutableJSONSchema]
                  : []
              ),
            ),
          ]),
        );
      } else if (key === "items" && value !== undefined) {
        result.items = this.#mergeSchemaGroup(
          schemas.flatMap((schema) =>
            isObjectOrArray(schema) && schema.items !== undefined
              ? [schema.items as MutableJSONSchema]
              : []
          ),
        );
      } else {
        result[key] = value;
      }
    }
    return result as MutableJSONSchemaObj;
  }
}
