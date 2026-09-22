import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import { hashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import ts from "typescript";

import { reportUnresolvedDefault } from "../default-diagnostics.ts";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { unionFoldedFrom } from "../schema-origins.ts";
import {
  cloneSchemaDefinition,
  detectWrapperViaNode,
  extractDefaultValueFromBrandedMembers,
  getNativeTypeSchema,
  getPropertyNameText,
  isEmptyObjectDefaultType,
  resolveWrapperNode,
  TypeWithInternals,
} from "../type-utils.ts";
import { hasDefaultMarker } from "../typescript/default-brand.ts";
import { extractLiteralValueOfSymbol } from "../typescript/literal-value.ts";
import {
  getTypeAliasDeclaration,
  unwrapTypeParentheses,
} from "../typescript/type-node.ts";
import { dedupeByValueEqual } from "../value-equality.ts";

// Simple primitive schemas only have these keys (possibly just one)
const PRIMITIVE_SCHEMA_KEY_SET = new Set(["type", "enum"]);

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

export class UnionFormatter implements TypeFormatter {
  #schemaGenerator: SchemaGenerator;

  constructor(schemaGenerator: SchemaGenerator) {
    this.#schemaGenerator = schemaGenerator;
  }

  supportsType(type: ts.Type, _context: GenerationContext): boolean {
    return (type.flags & ts.TypeFlags.Union) !== 0;
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const union = type as ts.UnionType;
    const members = union.types ?? [];
    const unionNode = this.#getUnionTypeNode(
      context.typeNode,
      context.typeChecker,
    );
    const memberNodes = unionNode ? unionNode.types : undefined;
    const orderedMemberNodes = memberNodes
      ? orderMemberNodesBySemanticType(
        members,
        memberNodes,
        context.typeChecker,
      )
      : undefined;

    if (members.length === 0) {
      throw new Error("UnionFormatter received empty union type");
    }

    const defaultUnionSchema = memberNodes
      ? this.#tryFormatDefaultUnion(memberNodes, context)
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
      );
    };

    // Case: exactly one non-null member + null => anyOf (nullable type).
    // Note: We use anyOf instead of oneOf for better consumer compatibility.
    // For nullable types (T | null), both work identically since a value is either
    // null OR the other type, never both. anyOf is more easily supported.
    // Note: if undefined is also present (T | null | undefined), nonNull.length > 1,
    // so we fall through to the anyOf path which emits { type: "undefined" } explicitly.
    if (hasNull && nonNull.length === 1) {
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

    // Fallback: anyOf of member schemas (excluding null/undefined handled above)
    let unionOptions = members.map((m, index) => generate(m, index));
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

    const schemas: MutableJSONSchema[] = [];
    for (const node of nonDefaultNodes) {
      schemas.push(this.#formatTypeNodeMember(node, context));
    }

    if (defaultEntry.entry.kind === "DeepDefault") {
      this.#assertDeepDefaultHasObjectTarget(
        defaultEntry.entry,
        nonDefaultNodes,
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
      nonDefaultNodes,
      context.typeChecker,
    );
    this.#assertDefaultObjectDoesNotWidenExistingObject(
      defaultEntry.entry,
      nonDefaultNodes,
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
        valueType: context.typeChecker.getTypeFromTypeNode(valueTypeNode),
        defaultType: context.typeChecker.getTypeFromTypeNode(valueTypeNode),
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
    const valueType = context.typeChecker.getTypeFromTypeNode(valueTypeNode);
    const defaultType = context.typeChecker.getTypeFromTypeNode(
      defaultTypeNode,
    );
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
    nonDefaultNodes: readonly ts.TypeNode[],
    checker: ts.TypeChecker,
  ): boolean {
    return nonDefaultNodes.some((node) => {
      const memberType = checker.getTypeFromTypeNode(node);
      return checker.isTypeAssignableTo(
        defaultEntry.defaultType,
        memberType,
      );
    });
  }

  #assertDefaultObjectDoesNotWidenExistingObject(
    defaultEntry: DefaultUnionEntry,
    nonDefaultNodes: readonly ts.TypeNode[],
    isCovered: boolean,
    checker: ts.TypeChecker,
  ): void {
    if (
      isCovered || !this.#isPlainObjectType(defaultEntry.defaultType, checker)
    ) {
      return;
    }

    const hasObjectTarget = nonDefaultNodes.some((node) =>
      this.#isPlainObjectType(checker.getTypeFromTypeNode(node), checker)
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
    nonDefaultNodes: readonly ts.TypeNode[],
    checker: ts.TypeChecker,
  ): void {
    const hasObjectTarget = nonDefaultNodes.some((node) =>
      this.#isPlainObjectType(checker.getTypeFromTypeNode(node), checker)
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
  ): MutableJSONSchema {
    const type = context.typeChecker.getTypeFromTypeNode(typeNode);
    const native = detectWrapperViaNode(typeNode, context.typeChecker) ===
        undefined
      ? getNativeTypeSchema(type, context.typeChecker)
      : undefined;
    if (native !== undefined) {
      return cloneSchemaDefinition(native);
    }
    return this.#schemaGenerator.formatChildType(type, context, typeNode);
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
   * {x: {enum: [10]}} | {x: {enum: [20]}} into {x: {type: "number"}}
   */
  #mergeIdenticalSchemas(
    schemas: MutableJSONSchema[],
  ): MutableJSONSchema[] {
    if (schemas.length <= 1) return schemas;

    // Group schemas by their structure (ignoring enum values)
    const groups = new Map<string, MutableJSONSchema[]>();

    for (const schema of schemas) {
      const normalized = this.#normalizeSchemaForComparison(schema);
      const key = JSON.stringify(normalized);
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
   * Normalize a schema for structural comparison by removing enum values
   * and converting them to base types
   */
  #normalizeSchemaForComparison(
    schema: MutableJSONSchema,
  ): Record<string, unknown> {
    if (typeof schema === "boolean") return { _bool: schema };

    const result: Record<string, unknown> = {};

    // Convert enum to base type for comparison
    if ("enum" in schema && schema.enum) {
      const firstValue = schema.enum[0];
      if (typeof firstValue === "string") {
        result.type = "string";
      } else if (typeof firstValue === "number") {
        result.type = "number";
      } else if (typeof firstValue === "boolean") {
        result.type = "boolean";
      }
    } else if ("type" in schema) {
      result.type = schema.type;
    }

    // Recursively normalize properties
    if ("properties" in schema && isObjectOrArray(schema.properties)) {
      const props: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        props[key] = this.#normalizeSchemaForComparison(
          value as MutableJSONSchema,
        );
      }
      result.properties = props;
    }

    // Recursively normalize items
    if ("items" in schema && schema.items) {
      result.items = this.#normalizeSchemaForComparison(
        schema.items as MutableJSONSchema,
      );
    }

    // Copy other structural fields
    if ("required" in schema) result.required = schema.required;
    if ("additionalProperties" in schema) {
      result.additionalProperties = schema.additionalProperties;
    }

    return result;
  }

  /**
   * Merge a group of structurally identical schemas by widening their enums
   */
  #mergeSchemaGroup(
    schemas: MutableJSONSchema[],
  ): MutableJSONSchema {
    if (schemas.length === 0) {
      throw new Error("Cannot merge empty schema group");
    }

    const first = schemas[0]!;
    if (typeof first === "boolean") return first;

    const result: MutableJSONSchemaObj = {};

    // Handle enum -> base type conversion
    if ("enum" in first && first.enum) {
      const firstValue = first.enum[0];
      if (typeof firstValue === "string") {
        result.type = "string";
      } else if (typeof firstValue === "number") {
        result.type = "number";
      } else if (typeof firstValue === "boolean") {
        result.type = "boolean";
      }
    } else if ("type" in first) {
      result.type = first.type;
    }

    // Recursively merge properties
    if ("properties" in first && isObjectOrArray(first.properties)) {
      const props: Record<string, MutableJSONSchema> = {};
      for (const key of Object.keys(first.properties)) {
        const propSchemas = schemas
          .map((s) =>
            isObjectOrArray(s) && isObjectOrArray(s.properties)
              ? s.properties[key]
              : undefined
          )
          .filter((p): p is MutableJSONSchema => p !== undefined);

        if (propSchemas.length > 0) {
          props[key] = this.#mergeSchemaGroup(propSchemas);
        }
      }
      result.properties = props;
    }

    // Recursively merge items
    if ("items" in first && first.items !== undefined) {
      const itemSchemas = schemas
        .map((s) =>
          isObjectOrArray(s) && "items" in s && s.items !== undefined
            ? s.items
            : undefined
        )
        .filter((i): i is MutableJSONSchema => i !== undefined);

      if (itemSchemas.length > 0) {
        result.items = this.#mergeSchemaGroup(itemSchemas);
      }
    }

    // Copy other structural fields from first schema
    if ("required" in first) result.required = first.required;
    if ("additionalProperties" in first) {
      result.additionalProperties = first.additionalProperties;
    }

    return result;
  }
}
