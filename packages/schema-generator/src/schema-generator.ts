import ts from "typescript";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import type {
  BoundTypeArgument,
  BoundTypeParameters,
  GenerationContext,
  SchemaGenerationOptions,
  SchemaHints,
  TypeFormatter,
} from "./interface.ts";
import { attachUiContract, getUiContractHint } from "./ui-contract.ts";
import { PrimitiveFormatter } from "./formatters/primitive-formatter.ts";
import {
  classifyCallableProperty,
  ObjectFormatter,
} from "./formatters/object-formatter.ts";
import { ArrayFormatter } from "./formatters/array-formatter.ts";
import {
  CommonFabricFormatter,
  lowersFromReferenceArguments,
  resolveScopeWrapperNode,
  scopeOfAliasChain,
  scopesCellHandle,
} from "./formatters/common-fabric-formatter.ts";
import { NativeTypeFormatter } from "./formatters/native-type-formatter.ts";
import {
  pairUnionMemberNodes,
  UnionFormatter,
} from "./formatters/union-formatter.ts";
import { IntersectionFormatter } from "./formatters/intersection-formatter.ts";
import { isDefaultLibrarySourceFile } from "./typescript/default-library.ts";
import {
  denotesSameType,
  getTypeAliasDeclaration,
  holdsFreeTypeParameter,
  holdsTypeParameter,
  readAuthoredTypeNode,
  readUnionMemberNodes,
  sameBesidesUndefined,
  typeParameterOfReference,
  typeParameterOfType,
  unwrapTypeParentheses,
} from "./typescript/type-node.ts";
import { resolveWriterBinding } from "./typescript/writer-binding.ts";
import { getCellWrapperInfo } from "./typescript/cell-brand.ts";
import { bindWrittenArgument } from "./type-parameter-bindings.ts";
import {
  detectWrapperViaNode,
  getNamedTypeKey,
  getPropertyNameText,
  instantiatedElementType,
  instantiatedPropertyType,
  instantiatedValueType,
  resolveWrapperNode,
  safeGetIndexTypeOfType,
  safeGetTypeOfSymbolAtLocation,
  soleNonNullishMember,
  type TypeWithInternals,
} from "./type-utils.ts";
import { attachDocTags, extractDocFromType } from "./doc-utils.ts";
import { unionFoldedFrom } from "./schema-origins.ts";
import {
  reportUnreadCfcRecursion,
  reportUnreadTypes,
} from "./unread-type-diagnostics.ts";
import { holdsUnreadMetadataLabel } from "./unread-label-diagnostics.ts";
import { dedupeByValueEqual } from "./value-equality.ts";
import { assertScopeDeclarationsAreReachable } from "./scope-placement.ts";
import {
  declaredIfcLabels,
  holdsIfcLabels,
  joinMemberIfcLabels,
  labeledValueMember,
  stateReferencedIfcLabels,
  withIfcLabels,
} from "./ifc-labels.ts";

/**
 * The default library's generic aliases the node-based analyzer applies
 * structurally (see `#analyzeLibraryAliasReference`). A cell read prints its
 * type through `Readonly<…>`; the others are what authored types reach for.
 */
const LIBRARY_ALIAS_NAMES = new Set([
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "NonNullable",
  "Array",
  "ReadonlyArray",
  "Record",
]);

/**
 * How many readings of one type under bindings that write the same arguments
 * for it may nest before the innermost is taken for a recursion without end
 * (`SchemaGenerator.#formatType`).
 */
const MAX_BOUND_NESTING = 3;

/**
 * A CFC alias chain's reading in progress: the written reference it was
 * entered from, the type the checker instantiates there where that is known,
 * and the type and context its schema is being formatted with.
 */
type ChainReading = {
  readonly entry: ts.TypeNode | ts.Symbol;
  readonly instantiated: ts.Type | undefined;
  readonly type: ts.Type;
  readonly context: GenerationContext;
};

/**
 * Whether `node`, read under `bound`, holds a `typeof` query: in its own
 * syntax, or in the argument of a parameter `bound` binds, in turn.
 */
function holdsTypeQuery(
  node: ts.Node,
  bound: BoundTypeParameters | undefined,
  checker: ts.TypeChecker,
  seen: Set<ts.Node> = new Set(),
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isTypeQueryNode(node)) return true;
  const parameter = ts.isTypeNode(node)
    ? typeParameterOfReference(node, checker)
    : undefined;
  const argument = parameter && bound?.arguments.get(parameter);
  if (argument?.node) {
    return holdsTypeQuery(argument.node, argument.bound, checker, seen);
  }
  return ts.forEachChild(
    node,
    (child) => holdsTypeQuery(child, bound, checker, seen) || undefined,
  ) ?? false;
}

/**
 * A node's written form (`SchemaGenerator.#writtenForm()`): a text, or a union
 * or intersection of forms, which `writtenFormText()` flattens.
 */
type WrittenForm =
  | string
  | { readonly op: "|" | "&"; readonly members: readonly WrittenForm[] };

/**
 * `form` as text: a union or an intersection as its members, those of a
 * member of the same kind among them, each once, in order, since `A | B` and
 * `B | (A | A)` are one type.
 */
function writtenFormText(form: WrittenForm): string {
  if (typeof form === "string") return form;
  const flat = (of: WrittenForm): WrittenForm[] =>
    typeof of !== "string" && of.op === form.op
      ? of.members.flatMap(flat)
      : [of];
  const members = [...new Set(form.members.flatMap(flat).map(writtenFormText))]
    .sort();
  return `${form.op}(${members.join(",")})`;
}

/**
 * `name`, a type literal member's name, as a key two members share only where
 * they name one property: an identifier and a string literal by their text,
 * alike, and a number by its text apart from them, since the checker spells
 * a numeric name as its value; `undefined` for a computed name.
 */
function propertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return JSON.stringify(["name", name.text]);
  }
  return ts.isNumericLiteral(name)
    ? JSON.stringify(["number", name.text])
    : undefined;
}

/** Whether a schema is an object schema the alias rules can rewrite. */
function isObjectSchema(
  schema: MutableJSONSchema,
): schema is MutableJSONSchemaObj & { type: "object" } {
  return isObjectOrArray(schema) && schema.type === "object";
}

/**
 * The definition a local `$ref` names, or `schema` itself when it is not one.
 * A named authored type analyzes to a reference into the context's
 * definitions, so a rule that needs the shape behind it reads it here. The
 * definition is returned as the shared object it is: a caller that derives a
 * new shape copies before it changes anything.
 */
function resolveLocalRef(
  schema: MutableJSONSchema,
  context: GenerationContext,
): MutableJSONSchema {
  const prefix = "#/$defs/";
  if (
    !isObjectOrArray(schema) || typeof schema.$ref !== "string" ||
    !schema.$ref.startsWith(prefix)
  ) {
    return schema;
  }
  const definition = context.definitions[schema.$ref.slice(prefix.length)];
  return definition === undefined ? schema : definition as MutableJSONSchema;
}

/** Whether a schema is an array schema the alias rules can rewrite. */
function isArraySchema(
  schema: MutableJSONSchema,
): schema is MutableJSONSchemaObj & { type: "array" } {
  return isObjectOrArray(schema) && schema.type === "array";
}

/**
 * `transform` applied to every object or array schema `schema` denotes: the
 * schema itself, the definition a local reference names, or each arm of a
 * union of them — the homomorphic aliases (`Partial`, `Required`) distribute
 * over a union, `Partial<A | B>` being `Partial<A> | Partial<B>`, and map an
 * array's elements as they map a tuple's. The schema handed to `transform`
 * is a copy with its own `properties` map, so a mapped view (`Partial<Foo>`)
 * never alters the `Foo` every other consumer reads. A schema that denotes
 * neither is returned as it came.
 */
function mapArms(
  schema: MutableJSONSchema,
  context: GenerationContext,
  transform: (
    arm: MutableJSONSchemaObj & { type: "object" | "array" },
  ) => MutableJSONSchema,
): MutableJSONSchema {
  const resolved = resolveLocalRef(schema, context);
  if (isObjectOrArray(resolved) && Array.isArray(resolved.anyOf)) {
    const arms = (resolved.anyOf as MutableJSONSchema[]).map((arm) =>
      mapArms(arm, context, transform)
    );
    return { ...resolved, anyOf: arms as MutableJSONSchemaObj[] };
  }
  if (!isObjectSchema(resolved) && !isArraySchema(resolved)) return schema;
  return transform({
    ...resolved,
    ...(isObjectOrArray(resolved.properties)
      ? { properties: { ...resolved.properties } }
      : {}),
  });
}

/**
 * The index signature an object schema carries, as the schema every key it
 * covers has: `additionalProperties` when present — a schema, `true`, or
 * `false` for a `never`-valued signature, which still covers every key —
 * and `undefined` for an object closed to unnamed keys, for which this
 * generator writes no `additionalProperties` at all.
 */
function indexSignatureOf(
  object: MutableJSONSchemaObj,
): MutableJSONSchema | undefined {
  return object.additionalProperties as MutableJSONSchema | undefined;
}

/** An object or array arm as `Partial<T>` maps it. */
function partialArm(
  arm: MutableJSONSchemaObj & { type: "object" | "array" },
): MutableJSONSchema {
  if (arm.type === "array") {
    return {
      ...arm,
      items: unionOfSchemas([
        (arm.items as MutableJSONSchema | undefined) ?? true,
        { type: "undefined" },
      ]),
    };
  }
  const { required: _required, ...rest } = arm;
  return rest;
}

/** An object or array arm as `Required<T>` maps it. */
function requiredArm(
  arm: MutableJSONSchemaObj & { type: "object" | "array" },
  context: GenerationContext,
): MutableJSONSchema {
  if (arm.type === "array") {
    return arm.items === undefined ? arm : {
      ...arm,
      items: withoutUndefined(arm.items as MutableJSONSchema, context),
    };
  }
  return isObjectOrArray(arm.properties)
    ? { ...arm, required: Object.keys(arm.properties) }
    : arm;
}

/**
 * The schemas a union denotes, one per arm, read through local references
 * and flattened through nested unions; a schema that is no union is its own
 * single arm. The arms are the shared objects they are — see
 * `resolveLocalRef`.
 */
function unionArms(
  schema: MutableJSONSchema,
  context: GenerationContext,
): MutableJSONSchema[] {
  const resolved = resolveLocalRef(schema, context);
  if (isObjectOrArray(resolved) && Array.isArray(resolved.anyOf)) {
    return (resolved.anyOf as MutableJSONSchema[]).flatMap((arm) =>
      unionArms(arm, context)
    );
  }
  return [resolved];
}

/**
 * The labels of the value `schema` denotes, which may be any arm of it
 * (`unionArms()`): those declared along each reference chain on the way to an
 * arm (`declaredIfcLabels()`), a union's joined with those of its arms
 * (`joinMemberIfcLabels()`). A union is labeled by every label it and its
 * arms declare read in full (`holdsUnreadArmLabel()`), or not at all, as a
 * union read by type is: a label read in part could claim what its author
 * never wrote together, and a join leaves out what an unread one held.
 */
function armLabels(
  schema: MutableJSONSchema,
  context: GenerationContext,
): Record<string, unknown> | undefined {
  const labels = declaredIfcLabels(schema, context.definitions);
  const resolved = resolveLocalRef(schema, context);
  if (!isObjectOrArray(resolved) || !Array.isArray(resolved.anyOf)) {
    return labels;
  }
  if (holdsUnreadArmLabel(schema, context)) return undefined;
  return joinMemberIfcLabels(
    labels ?? {},
    (resolved.anyOf as MutableJSONSchema[]).map((arm) =>
      armLabels(arm, context) ?? {}
    ),
  );
}

/**
 * Whether a label declared along `schema`'s reference chain, or along any
 * arm's of a union `schema` is, holds an atom the lowering could not read in
 * full (`holdsUnreadMetadataLabel()`).
 */
function holdsUnreadArmLabel(
  schema: MutableJSONSchema,
  context: GenerationContext,
): boolean {
  const labels = declaredIfcLabels(schema, context.definitions);
  if (labels && holdsUnreadMetadataLabel(labels)) return true;
  const resolved = resolveLocalRef(schema, context);
  return isObjectOrArray(resolved) && Array.isArray(resolved.anyOf) &&
    (resolved.anyOf as MutableJSONSchema[]).some((arm) =>
      holdsUnreadArmLabel(arm, context)
    );
}

/**
 * `Pick`/`Omit` applied to `schema`: the object it denotes with only the
 * selected properties. These aliases map over `keyof T`, and the keys of a
 * union are the keys every arm has, so a union does not distribute the way
 * `Partial` does: its view is one object over the surface the arms share,
 * each property accepting what any arm's does and required only where every
 * arm that names it requires it. `Omit<A | B, "kind">` therefore keeps
 * neither arm's own members, and a `Pick` of two correlated arms no longer
 * pairs their values. An index signature covers every key: a key an arm
 * has only through one takes the signature's schema and casts no vote on
 * being required, and an `Omit` from a surface every arm covers that way
 * keeps just the signature, the named members dissolving into it as they do
 * in `keyof T`. A lone arm that is no object is returned as it came; a union
 * with such an arm, or a `Pick` naming a key some arm lacks (a program the
 * type checker rejects), has no view here and is `undefined`.
 */
function pickedView(
  schema: MutableJSONSchema,
  context: GenerationContext,
  selection: { pick: Set<string> } | { omit: Set<string> },
): MutableJSONSchema | undefined {
  const arms = unionArms(schema, context);
  if (arms.length === 1 && !isObjectSchema(arms[0]!)) return schema;
  const objects = arms.filter(isObjectSchema);
  if (objects.length !== arms.length) return undefined;
  const propertiesOf = (
    object: MutableJSONSchemaObj,
  ): Record<string, MutableJSONSchema> =>
    isObjectOrArray(object.properties)
      ? object.properties as Record<string, MutableJSONSchema>
      : {};
  const closed = objects.filter((object) =>
    indexSignatureOf(object) === undefined
  );
  if ("omit" in selection && closed.length === 0) {
    return {
      type: "object",
      properties: {},
      additionalProperties: unionOfSchemas(
        objects.map((object) => indexSignatureOf(object)!),
      ),
    };
  }
  const covers = (object: MutableJSONSchemaObj, key: string) =>
    key in propertiesOf(object) || indexSignatureOf(object) !== undefined;
  const keys = "pick" in selection
    ? [...selection.pick]
    : Object.keys(propertiesOf(closed[0]!)).filter((key) =>
      !selection.omit.has(key) && closed.every((object) => covers(object, key))
    );
  if (!keys.every((key) => objects.every((object) => covers(object, key)))) {
    return undefined;
  }
  const properties = Object.fromEntries(
    keys.map((key) => [
      key,
      unionOfSchemas(
        objects.map((object) =>
          propertiesOf(object)[key] ?? indexSignatureOf(object)!
        ),
      ),
    ]),
  );
  const required = keys.filter((key) =>
    objects.every((object) =>
      !(key in propertiesOf(object)) ||
      (Array.isArray(object.required) && object.required.includes(key))
    )
  );
  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

/** The alias declarations already opened on one path — see `#openTypeNode`. */
type OpenedAliases = ReadonlySet<ts.TypeAliasDeclaration>;

/**
 * How `#tupleSlots` reads a node. Under `nonNullable` a union's `null` and
 * `undefined` members are dropped, as `NonNullable` drops them. Under
 * `spread` the node is what a rest element spreads, so a member that is no
 * tuple is an array and is held in a rest slot rather than ending the read.
 */
type TupleReading = { nonNullable: boolean; spread: boolean };

/** One slot of a tuple as the checker sees it once spreads are expanded. */
type TupleSlot = {
  kind: "required" | "optional" | "rest";
  schema: MutableJSONSchema;
};

/**
 * A tuple's slots as the checker normalizes them: an optional slot that a
 * required slot follows is required, `undefined` added to what it holds,
 * since a value filling the later slot has to spell the earlier one out.
 */
function normalizeTuple(slots: TupleSlot[]): TupleSlot[] {
  const lastRequired = slots.findLastIndex((slot) => slot.kind === "required");
  return slots.map((slot, index) =>
    slot.kind === "optional" && index < lastRequired
      ? {
        kind: "required",
        schema: unionOfSchemas([slot.schema, { type: "undefined" }]),
      }
      : slot
  );
}

/**
 * A tuple's slots as `Required<T>` leaves them: no slot optional, and
 * `undefined` gone from what an optional or a rest slot held — those count
 * as optional — while a required slot keeps an authored `undefined`.
 */
function requiredSlots(
  slots: TupleSlot[],
  context: GenerationContext,
): TupleSlot[] {
  return slots.map((slot) =>
    slot.kind === "required" ? slot : {
      kind: slot.kind === "rest" ? "rest" : "required",
      schema: withoutUndefined(slot.schema, context),
    }
  );
}

/**
 * A tuple's slots as `Partial<T>` leaves them: every slot optional, a rest
 * slot's elements admitting `undefined`.
 */
function partialSlots(slots: TupleSlot[]): TupleSlot[] {
  return slots.map((slot) =>
    slot.kind === "rest"
      ? {
        kind: "rest",
        schema: unionOfSchemas([slot.schema, { type: "undefined" }]),
      }
      : { kind: "optional", schema: slot.schema }
  );
}

/**
 * The default library's aliases that map a type without changing whether it
 * is a tuple, and distribute over a union: what `#requiredView` peels to
 * reach the tuple or union they wrap.
 */
const LIBRARY_WRAPPER_NAMES = new Set([
  "Readonly",
  "NonNullable",
  "Required",
  "Partial",
]);

/** Whether a type node is `null` or `undefined`, what `NonNullable` removes. */
function isNullishTypeNode(node: ts.TypeNode): boolean {
  return node.kind === ts.SyntaxKind.UndefinedKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isLiteralTypeNode(node) &&
      node.literal.kind === ts.SyntaxKind.NullKeyword);
}

/**
 * What a schema spread into a tuple contributes: an array's items, held in
 * a rest slot — or, for a schema that is no array (a program the checker
 * rejects), the schema itself.
 */
function restSlot(schema: MutableJSONSchema): TupleSlot {
  if (isArraySchema(schema) && schema.items !== undefined) {
    return { kind: "rest", schema: schema.items as MutableJSONSchema };
  }
  return { kind: "rest", schema };
}

/**
 * The positionless items schema of tuples with these slots, one list per
 * alternative: every slot's schema, an optional slot admitting `undefined`
 * as well, since an omitted one reads as `undefined` and the type-based
 * path admits it into the items union.
 */
function tupleItems(alternatives: TupleSlot[][]): MutableJSONSchema {
  return unionOfSchemas(
    alternatives.flat().map((slot) =>
      slot.kind === "optional"
        ? unionOfSchemas([slot.schema, { type: "undefined" }])
        : slot.schema
    ),
  );
}

type NullishName = "null" | "undefined";
const NULLISH: ReadonlySet<NullishName> = new Set(["null", "undefined"]);
const UNDEFINED_ONLY: ReadonlySet<NullishName> = new Set(["undefined"]);

/**
 * `schema` with `null` and `undefined` removed from what it accepts, the way
 * `NonNullable<T>` removes them from `T`.
 */
function withoutNullish(
  schema: MutableJSONSchema,
  context: GenerationContext,
): MutableJSONSchema {
  return withoutTypes(schema, context, NULLISH);
}

/**
 * `schema` with `undefined` alone removed from what it accepts, the way
 * `Required<T>` removes it from an element it makes non-optional.
 */
function withoutUndefined(
  schema: MutableJSONSchema,
  context: GenerationContext,
): MutableJSONSchema {
  return withoutTypes(schema, context, UNDEFINED_ONLY);
}

/**
 * `schema` with the nullish types in `drop` removed from what it accepts: a
 * schema of nothing else becomes `false`; an array-valued `type` loses those
 * entries, an `enum` those values; a union loses those arms; a local
 * reference is followed to its definition. A schema that accepted none of
 * them is returned as it came, reference and all.
 */
function withoutTypes(
  schema: MutableJSONSchema,
  context: GenerationContext,
  drop: ReadonlySet<NullishName>,
): MutableJSONSchema {
  const resolved = resolveLocalRef(schema, context);
  if (!isObjectOrArray(resolved)) return schema;
  if (Array.isArray(resolved.anyOf)) {
    const before = resolved.anyOf as MutableJSONSchema[];
    const arms = before.map((arm) => withoutTypes(arm, context, drop)).filter(
      (arm) => arm !== false,
    );
    if (
      arms.length === before.length && arms.every((arm, i) => arm === before[i])
    ) {
      return schema;
    }
    if (arms.length === 0) return false;
    if (arms.length === 1) return arms[0]!;
    return { ...resolved, anyOf: arms as MutableJSONSchemaObj[] };
  }
  type SchemaType = NonNullable<MutableJSONSchemaObj["type"]>;
  const types: SchemaType[] | undefined = Array.isArray(resolved.type)
    ? resolved.type
    : typeof resolved.type === "string"
    ? [resolved.type]
    : undefined;
  const values = Array.isArray(resolved.enum) ? resolved.enum : undefined;
  const keptTypes = types?.filter((type) => !drop.has(type as NullishName));
  const keptValues = values?.filter((value) =>
    !(value === null && drop.has("null")) &&
    !(value === undefined && drop.has("undefined"))
  );
  if (
    keptTypes?.length === types?.length &&
    keptValues?.length === values?.length
  ) {
    return schema;
  }
  if (keptTypes?.length === 0 || keptValues?.length === 0) return false;
  return {
    ...resolved,
    ...(keptTypes === undefined ? {} : {
      type: (keptTypes.length === 1 ? keptTypes[0]! : keptTypes) as SchemaType,
    }),
    ...(keptValues === undefined ? {} : { enum: keptValues }),
  };
}

/**
 * `node` with parentheses and `readonly` operators stripped from the outside.
 * Parentheses never change the type a node denotes; `readonly` does, but not
 * to these rules, which have no counterpart for it in a schema.
 */
function unwrapTypeNode(node: ts.TypeNode): ts.TypeNode {
  let current = unwrapTypeParentheses(node);
  while (
    ts.isTypeOperatorNode(current) &&
    current.operator === ts.SyntaxKind.ReadonlyKeyword
  ) {
    current = unwrapTypeParentheses(current.type);
  }
  return current;
}

/**
 * The string keys a `Pick`/`Omit`/`Record` key argument names: a string
 * literal or a union of them. Anything else (a `keyof`, a `string`) is not a
 * key list, and the caller falls back to the general path.
 */
function literalKeys(node: ts.TypeNode): Set<string> | undefined {
  const members = ts.isUnionTypeNode(node) ? node.types : [node];
  const keys = new Set<string>();
  for (const member of members) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      return undefined;
    }
    keys.add(member.literal.text);
  }
  return keys;
}

/** The primitive `type` names an intersection can narrow or find disjoint. */
const PRIMITIVE_TYPE_NAMES = new Set([
  "string",
  "number",
  "boolean",
  "null",
  "undefined",
]);

/**
 * What a primitive schema accepts: the primitive types, and the values when
 * a `const` or an `enum` makes them finite. `void` has the domain of
 * `undefined` — beside another primitive the checker reduces it as one — and
 * is marked, because beside an object it is not the nullish part that
 * `undefined` is, and because `undefined & void` is `undefined`.
 */
type PrimitiveDomain = {
  types: string[];
  values: unknown[] | undefined;
  isVoid: boolean;
};

/** The primitive type name of a literal value. */
function primitiveTypeOf(value: unknown): string {
  return value === null ? "null" : typeof value;
}

/**
 * The domain of a schema that says nothing but which primitives it accepts —
 * `type`, `const`, `enum` and no other keyword — or `undefined` for any
 * other schema. An `enum` with no `type`, the spelling of a named literal
 * union, takes its types from its values.
 */
function primitiveDomain(
  schema: MutableJSONSchemaObj,
  context: GenerationContext,
): PrimitiveDomain | undefined {
  if (context.schemaOrigins?.get(schema)?.kind === "void") {
    return { types: ["undefined"], values: undefined, isVoid: true };
  }
  const values = "const" in schema
    ? [schema.const]
    : Array.isArray(schema.enum)
    ? [...schema.enum]
    : undefined;
  const declared = Array.isArray(schema.type)
    ? schema.type as string[]
    : typeof schema.type === "string"
    ? [schema.type]
    : undefined;
  const types = declared ?? [...new Set((values ?? []).map(primitiveTypeOf))];
  const primitivesOnly = types.length > 0 &&
    types.every((type) => PRIMITIVE_TYPE_NAMES.has(type)) &&
    Object.keys(schema).every((key) =>
      key === "type" || key === "const" || key === "enum"
    );
  return primitivesOnly ? { types, values, isVoid: false } : undefined;
}

/**
 * The intersection of primitive schemas, as the checker reduces one: the
 * types every part admits, and, where a part is finite, the values every
 * part admits — `"a" & string` is `"a"`, `string & number` is nothing. A
 * part that already says exactly that is returned as it is, so a literal
 * keeps its spelling; otherwise the result is an `enum` or a `type`.
 */
function intersectPrimitives(
  parts: MutableJSONSchema[],
  domains: PrimitiveDomain[],
): MutableJSONSchema {
  let types = domains[0]!.types;
  let values: unknown[] | undefined;
  for (const domain of domains) {
    types = types.filter((type) => domain.types.includes(type));
    if (domain.values === undefined) continue;
    const admitted = domain.values;
    values = values === undefined
      ? admitted
      : values.filter((value) =>
        admitted.some((other) => Object.is(value, other))
      );
  }
  values = values?.filter((value) => types.includes(primitiveTypeOf(value)));
  if (values !== undefined) {
    const held = new Set(values.map(primitiveTypeOf));
    types = types.filter((type) => held.has(type));
  }
  if (types.length === 0) return false;
  const same = (left: unknown[] | undefined, right: unknown[] | undefined) =>
    left === undefined || right === undefined
      ? left === right
      : left.length === right.length &&
        left.every((value) => right.some((other) => Object.is(value, other)));
  const says = (index: number) =>
    same(domains[index]!.types, types) && same(domains[index]!.values, values);
  const indexes = parts.map((_part, index) => index);
  const exact =
    indexes.find((index) => !domains[index]!.isVoid && says(index)) ??
      indexes.find(says);
  if (exact !== undefined) return parts[exact]!;
  if (values !== undefined) return { enum: values } as MutableJSONSchema;
  type SchemaType = NonNullable<MutableJSONSchemaObj["type"]>;
  return { type: (types.length === 1 ? types[0]! : types) as SchemaType };
}

/**
 * `parts` with its primitive schemas intersected into one, or `false` when
 * they are disjoint. The one that survives stands where it stood — the
 * checker drops the wider part and keeps the narrower in place, and the
 * order decides which refused part the merge meets first — and a result
 * none of them spelled stands where the first of them stood. Parts that are
 * no primitive stay as they are, in order.
 */
function reducePrimitiveParts(
  parts: MutableJSONSchemaObj[],
  context: GenerationContext,
): MutableJSONSchemaObj[] | false {
  const domains = parts.map((part) => primitiveDomain(part, context));
  const primitive = parts.filter((_part, index) =>
    domains[index] !== undefined
  );
  if (primitive.length < 2) return parts;
  const met = intersectPrimitives(
    primitive,
    domains.filter((domain) => domain !== undefined),
  );
  if (met === false) return false;
  const survivor = parts.indexOf(met as MutableJSONSchemaObj);
  const stands = survivor >= 0 ? survivor : parts.indexOf(primitive[0]!);
  return parts.flatMap((part, index) =>
    index === stands
      ? [met as MutableJSONSchemaObj]
      : domains[index] === undefined
      ? [part]
      : []
  );
}

/** Whether a schema is an object with no members to speak of: `{}`. */
function isEmptyObjectSchema(schema: MutableJSONSchema): boolean {
  return isObjectSchema(schema) &&
    Object.keys(schema).every((key) =>
      key === "type" || key === "properties"
    ) &&
    Object.keys(schema.properties ?? {}).length === 0;
}

/**
 * `parts` with equal schemas folded, preserving source kind and the identity
 * of schemas with recorded union or intersection constituents. Equal fallback
 * schemas can stand for different constituents; `void` and an opaque cell
 * also remain distinct despite their equal schemas.
 */
function dedupeIntersectionParts<T extends MutableJSONSchema>(
  parts: T[],
  context: GenerationContext,
): T[] {
  const sourceIds = new Map<MutableJSONSchemaObj, number>();
  return dedupeByValueEqual(parts.map((schema) => {
    const origin = isObjectOrArray(schema)
      ? context.schemaOrigins?.get(schema)
      : undefined;
    let sourceId = 0;
    if (
      isObjectOrArray(schema) &&
      (origin?.kind === "union" || origin?.kind === "intersection")
    ) {
      sourceId = sourceIds.get(schema) ?? sourceIds.size + 1;
      sourceIds.set(schema, sourceId);
    }
    return { schema, sourceKind: origin?.kind ?? "schema", sourceId };
  })).map((part) => part.schema);
}

/**
 * The schema of an intersection whose constituents have these schemas, as
 * the checker settles one. Nested fallbacks expose their source constituents
 * before reduction, and identical constituents fold. A constituent
 * accepting nothing (`never`) leaves nothing. One accepting anything (`any`)
 * makes the whole accept anything — unless the constituents beside it that
 * are no union already contradict each other, which is as far as the checker
 * looks before `any` wins: it never distributes a union beside `any`, so
 * `any & null & (string | number)` is `any` where `any & null & string` is
 * nothing. Otherwise a union constituent distributes, and every combination
 * of arms is merged on its own (`mergeParts`).
 */
function intersectionOf(
  constituents: MutableJSONSchema[],
  context: GenerationContext,
): MutableJSONSchema {
  const expand = (schema: MutableJSONSchema): MutableJSONSchema[] => {
    const resolved = resolveLocalRef(schema, context);
    const origin = isObjectOrArray(resolved)
      ? context.schemaOrigins?.get(resolved)
      : undefined;
    return origin?.kind === "intersection"
      ? origin.parts().flatMap(expand)
      : [schema];
  };
  const distinct = dedupeIntersectionParts(
    constituents.flatMap(expand),
    context,
  );
  if (distinct.some((constituent) => constituent === false)) return false;
  const arms = distinct
    .filter((constituent) => constituent !== true)
    .map((constituent) => {
      const resolved = resolveLocalRef(constituent, context);
      const origin = isObjectOrArray(resolved)
        ? context.schemaOrigins?.get(resolved)
        : undefined;
      return origin?.kind === "union"
        ? origin.parts().flatMap((part) => unionArms(part, context))
        : unionArms(constituent, context);
    });
  if (arms.length < distinct.length) {
    const direct = arms
      .filter((alternatives) => alternatives.length === 1)
      .map((alternatives) => alternatives[0] as MutableJSONSchemaObj)
      .filter((part) => {
        const domain = primitiveDomain(part, context);
        return domain === undefined ||
          (domain.types.length === 1 && (domain.values?.length ?? 1) === 1);
      });
    return contradictory(direct, context) ? false : true;
  }
  const combinations = arms.reduce<MutableJSONSchema[][]>(
    (prefixes, alternatives) =>
      prefixes.flatMap((prefix) => alternatives.map((arm) => [...prefix, arm])),
    [[]],
  );
  return unionOfSchemas(
    combinations.map((parts) => {
      const expanded = parts.flatMap(expand);
      if (
        expanded.length !== parts.length ||
        expanded.some((part, index) => part !== parts[index])
      ) {
        return intersectionOf(expanded, context);
      }
      return parts.some((part) => part === false) ? false : mergeParts(
        parts as MutableJSONSchemaObj[],
        context,
      );
    }),
    context,
  );
}

/**
 * Whether these constituents, none of them a union, contradict each other
 * the way the checker finds before it lets `any` win: a nullish part beside
 * an object, or two disjoint primitives. It finds the latter from a
 * string-like, number-like, or void-like part, or between two unit types, so
 * `null` beside the bare `boolean`, which is none of those, is no
 * contradiction to it at that point, though `null` beside `true` is.
 */
function contradictory(
  direct: MutableJSONSchemaObj[],
  context: GenerationContext,
): boolean {
  const parts = direct.filter((part) => part.type !== "unknown");
  if (parts.length < 2 || mergeParts(parts, context) !== false) return false;
  const domains = parts.map((part) => primitiveDomain(part, context));
  const bareBoolean = (domain: PrimitiveDomain | undefined) =>
    domain?.types[0] === "boolean" && domain.values === undefined;
  const nullOnly = (domain: PrimitiveDomain | undefined) =>
    domain?.types[0] === "null";
  return !domains.every((domain) => bareBoolean(domain) || nullOnly(domain));
}

/**
 * The schema of an intersection of these parts, none of them a union,
 * `never`, or `any`, reduced the way the checker reduces the types before
 * `IntersectionFormatter` merges them, in this order: `unknown` is the
 * identity and drops out; an empty object drops out beside anything else and
 * takes `null` and `undefined` with it, `T & {}` being `NonNullable<T>`;
 * primitives are narrowed or found disjoint wherever they sit
 * (`reducePrimitiveParts`); and `null` or `undefined` beside an object
 * leaves nothing. What remains is one schema, returned as it is, or object
 * schemas whose properties are unioned (the first definition kept on a
 * clash) and whose `required` lists are unioned. A part that merge refuses —
 * a non-object, or one with an index signature, which an array is — yields
 * the same unsupported-pattern fallback the type-based path emits.
 */
function mergeParts(
  parts: MutableJSONSchemaObj[],
  context: GenerationContext,
): MutableJSONSchema {
  const substantive = dedupeIntersectionParts(
    parts.filter((part) => part.type !== "unknown"),
    context,
  );
  if (substantive.length === 0) return { type: "unknown" };
  const nonEmpty = substantive.filter((part) => !isEmptyObjectSchema(part));
  const remaining: MutableJSONSchema[] =
    nonEmpty.length > 0 && nonEmpty.length < substantive.length
      ? dedupeIntersectionParts(
        nonEmpty.map((part) => withoutNullish(part, context)),
        context,
      )
      : substantive;
  if (remaining.some((part) => part === false)) return false;
  // The primitive parts are reduced among themselves wherever they sit, so
  // a contradiction between two of them is found with an object beside them
  // too; what they reduce to stands where the first of them stood.
  const reduced = reducePrimitiveParts(
    remaining as MutableJSONSchemaObj[],
    context,
  );
  if (reduced === false) return false;
  if (reduced.length === 1) return reduced[0]!;
  const nullish = (part: MutableJSONSchemaObj) => {
    const domain = primitiveDomain(part, context);
    return domain !== undefined && !domain.isVoid &&
      domain.types.every((type) => type === "null" || type === "undefined");
  };
  if (reduced.some(nullish)) return false;
  const unsupported = (reason: string): MutableJSONSchema => {
    const schema: MutableJSONSchemaObj = {
      type: "object",
      additionalProperties: true,
      $comment: `Unsupported intersection pattern: ${reason}`,
    };
    context.schemaOrigins?.set(schema, {
      kind: "intersection",
      parts: () => reduced,
    });
    return schema;
  };
  const properties: Record<string, MutableJSONSchema> = {};
  const required = new Set<string>();
  for (const part of reduced) {
    if (isArraySchema(part)) {
      return unsupported("index signature on constituent");
    }
    if (!isObjectSchema(part)) return unsupported("non-object constituent");
    if (part.additionalProperties !== undefined) {
      return unsupported("index signature on constituent");
    }
    for (
      const [key, value] of Object.entries(
        (part.properties ?? {}) as Record<string, MutableJSONSchema>,
      )
    ) {
      if (!(key in properties)) properties[key] = value;
    }
    if (Array.isArray(part.required)) {
      for (const key of part.required) {
        if (typeof key === "string") required.add(key);
      }
    }
  }
  const merged: MutableJSONSchemaObj = { type: "object", properties };
  if (required.size > 0) merged.required = [...required];
  return merged;
}

/**
 * The schema of a union whose arms have these schemas: an arm that is itself
 * a bare union contributes its arms, an arm accepting anything makes the
 * whole accept anything, arms accepting nothing drop out, equal arms fold
 * (by value-model equality, as every other union in this package folds),
 * and a lone survivor stands alone. Given the context, a fold that drops an
 * arm with an origin of its own is recorded (`unionFoldedFrom`), so an
 * intersection that meets the survivor still reads every arm.
 */
function unionOfSchemas(
  schemas: MutableJSONSchema[],
  context?: GenerationContext,
): MutableJSONSchema {
  const flat = schemas.flatMap((schema) =>
    isObjectOrArray(schema) && Array.isArray(schema.anyOf) &&
      Object.keys(schema).length === 1
      ? schema.anyOf as MutableJSONSchema[]
      : [schema]
  );
  if (flat.some((schema) => schema === true)) return true;
  const kept = flat.filter((schema) => schema !== false);
  const unique = dedupeByValueEqual(kept);
  if (unique.length === 0) return false;
  const folded = unique.length === 1
    ? unique[0]!
    : { anyOf: unique as MutableJSONSchemaObj[] };
  return context === undefined
    ? folded
    : unionFoldedFrom(folded, kept, unique.length, context);
}

/** Whether `symbol`'s declaration introduces type parameters. */
function declaresTypeParameters(symbol: ts.Symbol): boolean {
  return symbol.declarations?.some((declaration) =>
    (ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isClassDeclaration(declaration)) &&
    declaration.typeParameters !== undefined
  ) ?? false;
}

/**
 * Returns the type to read in place of `typeNode` when that node was printed
 * from a type, or `undefined` when it was not. A printed node is never read as
 * a node. The type read is the caller's own `type` when it carries something,
 * and the type the node was printed from when the caller's is `any`, `unknown`,
 * or an unbound type parameter.
 */
function typeReadForPrintedNode(
  type: ts.Type,
  typeNode: ts.TypeNode | undefined,
  printedFrom: ((node: ts.TypeNode) => ts.Type | undefined) | undefined,
): ts.Type | undefined {
  const printed = typeNode && printedFrom?.(typeNode);
  if (!printed) return undefined;
  const carriesNothing = (type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !==
    0;
  return carriesNothing ? printed : type;
}

/**
 * The argument of `type` where it is a type parameter the context binds
 * (`GenerationContext.boundTypeParameters`), and `undefined` for any other
 * type.
 */
function boundArgumentOf(
  type: ts.Type,
  context: GenerationContext,
): BoundTypeArgument | undefined {
  const bound = context.boundTypeParameters;
  const declaration = bound && typeParameterOfType(type);
  return declaration && bound?.arguments.get(declaration);
}

/**
 * Whether `typeNode` is a `Default` holding a type parameter the context
 * binds. Its type is the parameter, or a conditional type the checker defers
 * over it, neither of which carries the default, so it is read as the
 * wrapper, whose value and default read the parameter's argument in turn.
 */
function wrapsBoundParameter(
  typeNode: ts.TypeNode | undefined,
  context: GenerationContext,
): boolean {
  const bound = context.boundTypeParameters;
  return bound !== undefined && typeNode !== undefined &&
    detectWrapperViaNode(typeNode, context.typeChecker) === "Default" &&
    holdsTypeParameter(typeNode, context.typeChecker, bound.arguments);
}

/**
 * Whether `type`, read under type parameter bindings at `typeNode`, is a
 * mapped type whose keys come from a bound parameter. The checker has not
 * instantiated it, so it has no members to read until it is, and no
 * binding reaches the argument its keys come from. A generic declaration's
 * mapped member instantiated over one, reached by its type, has no alias
 * arguments that show it: over an unconstrained parameter it has no member or
 * index signature the checker can list, which a mapped type written
 * generically has only then, and over a constrained one its members' types
 * are indexed accesses, which are reported where they are read.
 */
function mapsBoundParameter(
  type: ts.Type,
  typeNode: ts.TypeNode | undefined,
  context: GenerationContext,
): boolean {
  const bound = context.boundTypeParameters;
  if (!bound) return false;
  const checker = context.typeChecker;
  const written = typeNode && unwrapTypeParentheses(typeNode);
  if (
    written && ts.isMappedTypeNode(written) &&
    holdsTypeParameter(written, checker, bound.arguments)
  ) {
    return true;
  }
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
  if ((objectFlags & ts.ObjectFlags.Mapped) === 0) return false;
  const aliasArguments = (type as TypeWithInternals).aliasTypeArguments;
  if (
    aliasArguments?.some((argument) =>
      mentionsBoundParameter(argument, bound, checker, new Set())
    )
  ) {
    return true;
  }
  return checker.getPropertiesOfType(type).length === 0 &&
    checker.getIndexInfosOfType(type).length === 0 &&
    !checker.isTypeAssignableTo(checker.getStringType(), type) &&
    (written === undefined || holdsFreeTypeParameter(written, checker));
}

/**
 * Whether `type` is, or is built from, a type parameter `bound` binds: as a
 * union or intersection member, or as a type argument of a reference or an
 * alias.
 */
function mentionsBoundParameter(
  type: ts.Type,
  bound: BoundTypeParameters,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const declaration = type.symbol?.declarations?.find(
      ts.isTypeParameterDeclaration,
    );
    return declaration !== undefined && bound.arguments.has(declaration);
  }
  const mentions = (types: readonly ts.Type[] | undefined) =>
    types?.some((part) => mentionsBoundParameter(part, bound, checker, seen)) ??
      false;
  if (type.isUnionOrIntersection()) return mentions(type.types);
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
  return mentions((type as TypeWithInternals).aliasTypeArguments) ||
    ((objectFlags & ts.ObjectFlags.Reference) !== 0 &&
      mentions(checker.getTypeArguments(type as ts.TypeReference)));
}

/**
 * Main schema generator that uses a chain of formatters
 */
export class SchemaGenerator {
  #commonFabricFormatter = new CommonFabricFormatter(this);

  #unionFormatter = new UnionFormatter(
    this,
    (type, node, context) => this.#readsWhole(type, node, context),
  );

  #formatters: TypeFormatter[] = [
    this.#commonFabricFormatter,
    new NativeTypeFormatter(),
    this.#unionFormatter,
    new IntersectionFormatter(this),
    // Prefer array detection before primitives to avoid Any-flag misrouting
    new ArrayFormatter(this),
    new PrimitiveFormatter(),
    new ObjectFormatter(this),
  ];

  /** Synthetic names for anonymous recursive types */
  #anonymousNames: WeakMap<ts.Type, string> = new WeakMap();

  /**
   * Synthetic names for anonymous recursive types read under type parameter
   * bindings, by type and bindings (`#bindingKey()`): the same declared type
   * read under two bindings is two types.
   */
  #boundAnonymousNames: Map<string, string> = new Map();

  /**
   * The readings of CFC alias chains in progress, per generation, keyed by the
   * generation's `definitionStack` (`readAliasChain()`).
   */
  #chainReadings: WeakMap<object, ChainReading[]> = new WeakMap();

  /** Each chain reading's arguments form (`#argumentsFormOf()`). */
  #argumentForms: WeakMap<ChainReading, string | undefined> = new WeakMap();

  /** Identities of the types and declarations a binding key names. */
  #bindingIds: WeakMap<object, number> = new WeakMap();

  /** Each immutable binding environment's query-origin key and presence. */
  #bindingQueriesCache: WeakMap<
    BoundTypeParameters,
    { key: string; hasQuery: boolean }
  > = new WeakMap();

  /** Counter for `#bindingIds`. */
  #bindingIdCounter: number = 0;

  /** Counter to generate stable synthetic identifiers */
  #anonymousNameCounter: number = 0;

  /**
   * The node `#spelling()` builds for each annotation, by whether the type it
   * spells holds `undefined`.
   */
  #optionalSpellings: WeakMap<
    ts.TypeNode,
    Map<boolean, ts.TypeNode | undefined>
  > = new WeakMap();

  /**
   * Generate JSON Schema for a TypeScript type.
   * AUTO-DETECTS whether to use type-based or node-based analysis.
   */
  generateSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
    typeNode?: ts.TypeNode,
    options?: SchemaGenerationOptions,
    schemaHints?: SchemaHints,
    sourceFile?: ts.SourceFile,
  ): MutableJSONSchema {
    return this.#generateSchemaInternal(
      type,
      checker,
      typeNode,
      undefined,
      options,
      schemaHints,
      sourceFile,
    );
  }

  /**
   * Generate schema from a synthetic TypeNode that doesn't resolve to a proper Type.
   * Used by transformers that create synthetic type structures programmatically.
   *
   * This is now a simple wrapper around generateSchema that passes an 'any' type,
   * which triggers the auto-detection logic to use node-based analysis.
   */
  public generateSchemaFromSyntheticTypeNode(
    typeNode: ts.TypeNode,
    checker: ts.TypeChecker,
    typeRegistry?: WeakMap<ts.Node, ts.Type>,
    schemaHints?: SchemaHints,
    sourceFile?: ts.SourceFile,
    options?: SchemaGenerationOptions,
  ): MutableJSONSchema {
    // Pass 'any' type with the typeNode - auto-detection will choose node-based analysis
    const anyType = checker.getAnyType();
    return this.#generateSchemaInternal(
      anyType,
      checker,
      typeNode,
      typeRegistry,
      options,
      schemaHints,
      sourceFile,
    );
  }

  /**
   * Internal unified implementation for schema generation.
   * Handles both normal and synthetic type node cases, with optional typeRegistry.
   */
  #generateSchemaInternal(
    type: ts.Type,
    checker: ts.TypeChecker,
    typeNode?: ts.TypeNode,
    typeRegistry?: WeakMap<ts.Node, ts.Type>,
    options?: SchemaGenerationOptions,
    schemaHints?: SchemaHints,
    sourceFile?: ts.SourceFile,
    hintsNode?: ts.TypeNode,
  ): MutableJSONSchema {
    const readInPlace = typeReadForPrintedNode(
      type,
      typeNode,
      options?.printedFrom,
    );
    if (readInPlace) {
      return this.#generateSchemaInternal(
        readInPlace,
        checker,
        undefined,
        typeRegistry,
        options,
        schemaHints,
        sourceFile,
        typeNode,
      );
    }

    // Create unified context with all state
    const cycles = this.#getCycles(type, checker);

    // A guess a wrapper recovers never reaches this list, so what arrives here
    // is what the finished schema accepts without having read it.
    const unread: ts.TypeNode[] = [];

    const context: GenerationContext = {
      // Immutable context
      typeChecker: checker,
      cyclicTypes: cycles.types,
      cyclicNames: cycles.names,

      // Accumulating state
      definitions: {},
      emittedRefs: new Set(),
      schemaOrigins: new WeakMap(),
      uninterpretedTypeNodes: unread,

      // Stack state
      definitionStack: new Set(),
      inProgressNames: new Set(),

      // Optional context
      ...(typeNode && { typeNode }),
      ...(hintsNode && { hintsNode }),
      ...(typeNode?.getSourceFile()?.fileName && {
        sourceFileName: typeNode.getSourceFile().fileName,
      }),
      ...(sourceFile && {
        sourceFile,
        sourceFileName: sourceFile.fileName,
      }),
      ...(typeRegistry && { typeRegistry }),
      ...(options?.widenLiterals && { widenLiterals: true }),
      ...(options?.writerIdentityForSourceFile && {
        writerIdentityForSourceFile: options.writerIdentityForSourceFile,
      }),
      ...(options?.onDiagnostic && { onDiagnostic: options.onDiagnostic }),
      ...(options?.isDefaultLibrarySourceFile && {
        isDefaultLibrarySourceFile: options.isDefaultLibrarySourceFile,
      }),
      ...(options?.printedFrom && { printedFrom: options.printedFrom }),
      ...(schemaHints && { schemaHints }),
    };

    // Auto-detect: Should we use node-based or type-based analysis?
    let schema: MutableJSONSchema;
    let result: MutableJSONSchema;
    if (this.#shouldUseNodeBasedAnalysis(type, typeNode, checker)) {
      // Use node-based analysis (for synthetic nodes or when type is unreliable)
      schema = this.#analyzeTypeNodeStructure(
        typeNode!,
        checker,
        context,
      );
      schema = this.#applyNodeSchemaHints(schema, context);
      // Build final schema with $schema and $defs
      result = this.#buildFinalSchemaForSynthetic(schema, context);
    } else {
      // Use type-based analysis (normal path)
      schema = this.#formatType(type, context, true);
      schema = this.#applyNodeSchemaHints(schema, context);

      // Attach root-level description from JSDoc if available
      schema = this.#attachRootDescription(schema, type, context);

      // Build final schema with definitions if needed
      result = this.#buildFinalSchema(schema, type, context, typeNode);
    }

    if (unread.length > 0) reportUnreadTypes(context, unread);

    stateReferencedIfcLabels(result);
    assertScopeDeclarationsAreReachable(result);
    return result;
  }

  /**
   * Determine if we should use node-based analysis instead of type-based.
   * This happens when the Type is unreliable (any/unknown) but we have a concrete TypeNode.
   *
   * When TypeScript widens a type to 'any' (e.g., for array element types or synthetic nodes),
   * the TypeNode structure is more reliable than the Type.
   *
   * EXCEPTION: Wrapper types (Default/Cell/Stream/OpaqueCell) erase to their inner type,
   * which may appear as 'any', but they should use type-based analysis because
   * CommonFabricFormatter handles them specially via typeNode context.
   */
  #shouldUseNodeBasedAnalysis(
    type: ts.Type,
    typeNode: ts.TypeNode | undefined,
    checker: ts.TypeChecker,
  ): boolean {
    if (!typeNode || !(type.flags & ts.TypeFlags.Any)) {
      return false;
    }

    // Check if this is a wrapper type - if so, use type-based analysis
    const wrapperKind = detectWrapperViaNode(typeNode, checker);
    if (wrapperKind) {
      return false;
    }

    return true;
  }

  /**
   * Format a nested/child type within the current active context. This preserves
   * definition/$ref behavior (including cycles) and ensures non-root usages can
   * return $ref where appropriate.
   *
   * AUTO-DETECTS whether to use type-based or node-based analysis. A node the
   * caller printed from a type is never analyzed; the type at that position is
   * read instead (`typeReadForPrintedNode()`). `instantiatedAs` is the type
   * the checker instantiates at the position, where a reading under bindings
   * has it (`GenerationContext.instantiatedAs`); the child reads with it, and
   * with none where it is not given.
   */
  public formatChildType(
    type: ts.Type,
    context: GenerationContext,
    typeNode?: ts.TypeNode,
    instantiatedAs?: ts.Type,
  ): MutableJSONSchema {
    // A bound type parameter reads as its argument: its node where it has one,
    // under the bindings of the place it is written, and its type where it
    // does not. A `Default` around one is read as the wrapper, whose value
    // reads the parameter in turn.
    const wrapsBound = wrapsBoundParameter(typeNode, context);
    const argument = !wrapsBound && boundArgumentOf(type, context);
    if (argument) {
      const { boundTypeParameters: _, ...outer } = context;
      return this.formatChildType(
        argument.type,
        argument.bound
          ? { ...outer, boundTypeParameters: argument.bound }
          : outer,
        argument.node,
        instantiatedAs,
      );
    }
    // A type still depending on a parameter, where no binding reaches it, is
    // not fully read. One the checker defers, such as `T["name"]`, has no
    // schema to read, so it accepts any value, as a conditional type does,
    // and so does a mapped type over one, unless a library alias is written
    // for it, which the node-based analyzer applies to the argument.
    const bound = context.boundTypeParameters;
    const mapsBound = !this.#readsBySyntax(typeNode, context) &&
      mapsBoundParameter(type, typeNode, context);
    if (
      bound && !wrapsBound &&
      ((type.flags & ts.TypeFlags.Instantiable) !== 0 || mapsBound)
    ) {
      const unread = context.uninterpretedTypeNodes;
      const node = typeNode ?? bound.declaredNode;
      if (unread && !unread.includes(node)) unread.push(node);
      if ((type.flags & ts.TypeFlags.TypeParameter) === 0) return {};
    }

    // A print whose member annotation names a value binding is read as that
    // annotation spells the type at hand, and keeps the print's hints.
    const spelledBy = typeNode && context.schemaHints?.get(typeNode)?.spelledBy;
    const spelling = spelledBy &&
      this.#spelling(type, spelledBy, context.typeChecker);
    if (spelling) {
      return this.#applyNodeSchemaHints(
        this.formatChildType(type, context, spelling),
        { ...context, typeNode },
      );
    }

    const readInPlace = typeReadForPrintedNode(
      type,
      typeNode,
      context.printedFrom,
    );

    // IMPORTANT: Always create a new context, replacing typeNode (even if undefined).
    // If we pass the parent context as-is when typeNode is undefined, the child will
    // inherit the parent's typeNode which leads to mismatched type/node pairs.
    // A printed node is not read as a node, and the hints attached to it apply.
    const {
      typeNode: _,
      hintsNode: __,
      instantiatedAs: ___,
      ...unplaced
    } = context;
    const baseContext: GenerationContext = instantiatedAs
      ? { ...unplaced, instantiatedAs }
      : unplaced;
    const childContext: GenerationContext = readInPlace && typeNode
      ? { ...baseContext, hintsNode: typeNode }
      : typeNode
      ? { ...baseContext, typeNode }
      : baseContext;
    const readType = readInPlace ?? type;

    // Read for its labels alone, a type no CFC wrapper holds is a payload, and
    // is not formatted. A union or an intersection is formatted from its
    // members, which can attach their labels to it: an expanded `Default`
    // holds its value as a member.
    if (
      context.labelsOnly && !readType.isUnionOrIntersection() &&
      !this.#commonFabricFormatter.supportsType(readType, childContext)
    ) {
      return {};
    }

    // Auto-detect: Should we use node-based or type-based analysis?
    const useNodeBased = !readInPlace &&
      (this.#shouldUseNodeBasedAnalysis(
        readType,
        typeNode,
        context.typeChecker,
      ) ||
        this.#readsBySyntax(typeNode, context));
    if (useNodeBased) {
      // Use node-based analysis (for synthetic nodes or when type is unreliable)
      return this.#applyNodeSchemaHints(
        this.#analyzeTypeNodeStructure(
          typeNode!,
          context.typeChecker,
          childContext,
        ),
        childContext,
      );
    }

    // Use type-based analysis (normal path)
    return this.#applyNodeSchemaHints(
      this.#formatType(readType, childContext, false),
      childContext,
    );
  }

  /**
   * `type` as the formatters after `CommonFabricFormatter` read it: for a type
   * that formatter claims for the labels it adds, whose value is the type as
   * the checker builds it (`Readonly<Sec<X>>`). Called within the type's own
   * `#formatType()`, which names and stores what it returns.
   */
  public formatStructure(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    return this.#formatters.find((formatter) =>
      formatter !== this.#commonFabricFormatter &&
      formatter.supportsType(type, context)
    )?.formatType(type, context) ?? {};
  }

  /**
   * The labels `carrier`, a CFC metadata carrier an object holds as one of its
   * members, attaches, each read in full, or `undefined` where any is not
   * (`CommonFabricFormatter.labelsCarriedBy()`).
   */
  public labelsCarriedBy(
    carrier: ts.Symbol,
    context: GenerationContext,
  ): Record<string, unknown>[] | undefined {
    return this.#commonFabricFormatter.labelsCarriedBy(carrier, context);
  }

  /**
   * Formats `type` with `read`, the reading of an alias chain of `kind` entered
   * from `entry`, where the checker instantiates `instantiated`: a written reference
   * to the chain, or, for a chain reached with none, as through an index
   * signature or a tuple element read by type, the alias it is reached by. A
   * reading entered again from the same reference inside itself is a recursion
   * through it. One whose instantiation is identical to a reading's in progress
   * there is a cycle of that type, which `#formatType` finds as it finds any
   * other. Otherwise it refers to the definition of the reading it settles to
   * (`#settledReading()`), where that reading stores one. A chain reached by
   * its alias settles none: two readings of one alias through no written
   * reference may be a nesting its author wrote out, whose instantiations the
   * checker can find assignable both ways though they read differently. Nor
   * does a scope around a cell, whose cycle is found at the cell's value, which
   * keeps the handle it caps at each reference (`scopesCellHandle()`), nor a
   * reading for labels alone, which names no definition
   * (`GenerationContext.labelsOnly`). An entry nested in itself
   * `MAX_BOUND_NESTING` deep without settling instantiates the chain without
   * end, as `Nest<T[]>` inside `Nest<T>` does. Reaching that bound in a CFC
   * chain is an error: the unread remainder could hold confidentiality or
   * write policies. A scope chain reports an unread-type warning.
   */
  public readAliasChain(
    type: ts.Type,
    context: GenerationContext,
    entry: ts.TypeNode | ts.Symbol,
    instantiated: ts.Type | undefined,
    kind: "cfc" | "scope",
    read: () => MutableJSONSchema,
  ): MutableJSONSchema {
    const readings = this.#chainReadings.get(context.definitionStack) ?? [];
    this.#chainReadings.set(context.definitionStack, readings);
    const checker = context.typeChecker;
    const written = "kind" in entry;
    const again = readings.filter((reading) => reading.entry === entry);
    const settled = written && again.length > 0 && !context.labelsOnly &&
        !scopesCellHandle(type, checker)
      ? this.#settledReading(entry, context, instantiated, again)
      : undefined;
    if (settled) return this.#referToReading(settled.type, settled.context);
    if (again.length >= MAX_BOUND_NESTING) {
      if (kind === "cfc") {
        // At the written reference, or at the node the context reads. A chain
        // reached by its type alone has neither, and the error goes without
        // one.
        reportUnreadCfcRecursion(context, written ? entry : context.typeNode);
      } else {
        // The warning names the type the chain stops at, which a chain
        // reached by its type alone has only as a print. `IgnoreErrors`
        // prints any type, where with no flags the checker prints nothing for
        // one holding `[]`.
        const named = written ? entry : context.typeNode ??
          checker.typeToTypeNode(
            type,
            undefined,
            ts.NodeBuilderFlags.IgnoreErrors,
          );
        const unread = context.uninterpretedTypeNodes;
        if (unread && named && !unread.includes(named)) unread.push(named);
      }
      return {};
    }
    readings.push({ entry, instantiated, type, context });
    try {
      return read();
    } finally {
      readings.pop();
    }
  }

  /**
   * Helper for {@link readAliasChain}: the reading among `again`, readings in
   * progress entered from `reference`, that the reading entered from it again
   * with `context` settles to, where the checker instantiates `instantiated`.
   * One whose instantiation is a different type assignable both ways with
   * this one (`Sec<Readonly<Readonly<X>>>` and `Sec<Readonly<X>>`) is the same
   * reading up to assignability. So is one whose type arguments denote the
   * same types as this one's (`#argumentsForm()`), which settles a recursion
   * wherever the reading has lost the instantiation at its position: the
   * same reference over the same types is the same reading. `Nest<T[]>`
   * inside `Nest<T>` denotes a deeper array at each step, and settles to
   * none. Where the arguments of any of these readings hold a `typeof` query,
   * none settles: a writer binding is an identity that no type shows, and
   * two readings with different writers can have one type. That recursion
   * ends where it meets the same reading again, which `#formatType` finds.
   */
  #settledReading(
    reference: ts.TypeNode,
    context: GenerationContext,
    instantiated: ts.Type | undefined,
    again: readonly ChainReading[],
  ): ChainReading | undefined {
    const checker = context.typeChecker;
    const holdsQuery = (
      entry: ts.TypeNode | ts.Symbol,
      at: GenerationContext,
    ) =>
      "kind" in entry && ts.isTypeReferenceNode(entry) &&
      (entry.typeArguments ?? []).some((node) =>
        holdsTypeQuery(node, at.boundTypeParameters, checker)
      );
    if (
      holdsQuery(reference, context) ||
      again.some((reading) => holdsQuery(reading.entry, reading.context))
    ) {
      return undefined;
    }
    const byInstantiation = instantiated &&
      again.find((reading) =>
        reading.instantiated !== undefined &&
        reading.instantiated !== instantiated &&
        checker.isTypeAssignableTo(reading.instantiated, instantiated) &&
        checker.isTypeAssignableTo(instantiated, reading.instantiated)
      );
    if (byInstantiation) return byInstantiation;
    const form = this.#argumentsForm(reference, context);
    return form === undefined
      ? undefined
      : again.find((reading) => this.#argumentsFormOf(reading) === form);
  }

  /**
   * Helper for {@link #settledReading}: the arguments form of `reading`, taken
   * once for the reading's lifetime.
   */
  #argumentsFormOf(reading: ChainReading): string | undefined {
    if (!this.#argumentForms.has(reading)) {
      this.#argumentForms.set(
        reading,
        this.#argumentsForm(reading.entry as ts.TypeNode, reading.context),
      );
    }
    return this.#argumentForms.get(reading);
  }

  /**
   * Helper for {@link #settledReading}: the type arguments `reference` writes,
   * each in its written form under `context`'s bindings (`#writtenForm()`),
   * as one text two references share only where their arguments denote the
   * same types; `undefined` where an argument has no such form.
   */
  #argumentsForm(
    reference: ts.TypeNode,
    context: GenerationContext,
  ): string | undefined {
    const typeArguments = ts.isTypeReferenceNode(reference)
      ? reference.typeArguments
      : undefined;
    return typeArguments?.length
      ? this.#formsOf(typeArguments, context.boundTypeParameters, context)
        ?.map(writtenFormText).join(",")
      : undefined;
  }

  /**
   * Helper for {@link #writtenForm}: each of `nodes`, written under `bound`,
   * in its written form, or `undefined` where any has none, or is missing,
   * as the type of a member written without one is.
   */
  #formsOf(
    nodes: readonly (ts.TypeNode | undefined)[],
    bound: BoundTypeParameters | undefined,
    context: GenerationContext,
  ): WrittenForm[] | undefined {
    const forms: WrittenForm[] = [];
    for (const node of nodes) {
      const form = node && this.#writtenForm(node, bound, context);
      if (form === undefined) return undefined;
      forms.push(form);
    }
    return forms;
  }

  /**
   * Helper for {@link #argumentsForm}: `node`, written under `bound`, in a form
   * that two nodes share only where they denote the same type, or `undefined`
   * where it has none. A bound parameter is its argument's form, under the
   * bindings the argument is written under, which are the bindings of a place
   * outside it, so the form of every node ends. A node holding no type
   * parameter is the type the checker gives it, compared by identity. A union
   * or an intersection is its members, flattened into it
   * (`writtenFormText()`), so `(string | undefined) | undefined` is
   * `string | undefined`. A reference is the declaration it names and its
   * arguments' forms, and any other construct as `#constructForm()` gives
   * it. A type parameter `bound` does not bind, as a payload read from its
   * instantiation leaves its own, and one a mapped or conditional type
   * declares, stand for nothing the reading knows, so a node holding one has
   * no form.
   */
  #writtenForm(
    node: ts.TypeNode,
    bound: BoundTypeParameters | undefined,
    context: GenerationContext,
  ): WrittenForm | undefined {
    const checker = context.typeChecker;
    const bare = unwrapTypeParentheses(node);
    const parameter = typeParameterOfReference(bare, checker);
    if (parameter) {
      const argument = bound?.arguments.get(parameter);
      if (argument?.node) {
        return this.#writtenForm(argument.node, argument.bound, context);
      }
      return argument && `type:${this.#bindingId(argument.type)}`;
    }
    if (!holdsTypeParameter(bare, checker)) {
      const type = context.typeRegistry?.get(bare) ??
        checker.getTypeFromTypeNode(bare);
      return `type:${this.#bindingId(type)}`;
    }
    if (ts.isUnionTypeNode(bare) || ts.isIntersectionTypeNode(bare)) {
      const members = this.#formsOf(bare.types, bound, context);
      return members && {
        op: ts.isUnionTypeNode(bare) ? "|" : "&",
        members,
      };
    }
    if (ts.isTypeReferenceNode(bare)) {
      const symbol = checker.getSymbolAtLocation(bare.typeName);
      const declared = symbol && (symbol.flags & ts.SymbolFlags.Alias)
        ? checker.getAliasedSymbol(symbol)
        : symbol;
      const forms = this.#formsOf(bare.typeArguments ?? [], bound, context);
      return declared && forms &&
        `ref:${this.#bindingId(declared)}<${
          forms.map(writtenFormText).join(",")
        }>`;
    }
    return this.#constructForm(bare, bound, context);
  }

  /**
   * Helper for {@link #writtenForm}: `node`, a type node holding a type
   * parameter, as the construct it writes and its parts' forms, for the
   * constructs whose form holds everything their type depends on: an array, a
   * tuple and its elements, `keyof`, `readonly` and `unique`, and a type
   * literal of properties and index signatures, a property's name kept apart
   * from its modifiers. Any other node has no form, an indexed access or a
   * conditional type over a bound parameter among them, which a reading
   * under bindings reports as not fully read in any case.
   */
  #constructForm(
    node: ts.TypeNode,
    bound: BoundTypeParameters | undefined,
    context: GenerationContext,
  ): string | undefined {
    const construct = (
      label: string,
      parts: readonly (ts.TypeNode | undefined)[],
    ) => {
      const forms = this.#formsOf(parts, bound, context);
      return forms && `${label}(${forms.map(writtenFormText).join(",")})`;
    };
    if (ts.isArrayTypeNode(node)) return construct("array", [node.elementType]);
    if (ts.isTypeOperatorNode(node)) {
      return construct(`operator:${ts.SyntaxKind[node.operator]}`, [node.type]);
    }
    if (ts.isRestTypeNode(node)) return construct("rest", [node.type]);
    if (ts.isOptionalTypeNode(node)) return construct("optional", [node.type]);
    if (ts.isNamedTupleMember(node)) {
      return construct(
        node.dotDotDotToken ? "rest" : node.questionToken ? "optional" : "at",
        [node.type],
      );
    }
    if (ts.isTupleTypeNode(node)) {
      const elements = this.#formsOf(node.elements, bound, context);
      return elements && `tuple(${elements.map(writtenFormText).join(",")})`;
    }
    if (!ts.isTypeLiteralNode(node)) return undefined;
    const members: string[] = [];
    for (const member of node.members) {
      const modifiers = ts.getCombinedModifierFlags(member) &
          ts.ModifierFlags.Readonly
        ? "readonly"
        : "mutable";
      const form = ts.isPropertySignature(member)
        ? construct(
          `property(${propertyKey(member.name)},${
            member.questionToken ? "optional" : "required"
          },${modifiers})`,
          [propertyKey(member.name) === undefined ? undefined : member.type],
        )
        : ts.isIndexSignatureDeclaration(member)
        ? construct(`index(${modifiers})`, [
          ...member.parameters.map((parameter) => parameter.type),
          member.type,
        ])
        : undefined;
      if (form === undefined) return undefined;
      members.push(form);
    }
    return `literal(${members.join(",")})`;
  }

  /**
   * A reference to the definition of `type` read with `context`, a reading in
   * progress that its own schema reaches again, stored under that name once
   * the reading ends: its named key where it has one, as `#formatType()`
   * names it, and a synthetic name otherwise.
   */
  #referToReading(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const checker = context.typeChecker;
    const aliasScope = scopeOfAliasChain(type, checker);
    const key =
      (aliasScope === undefined
        ? getNamedTypeKey(type, context.typeNode)
        : undefined) ?? this.#ensureSyntheticName(type, context);
    context.inProgressNames.add(key);
    context.emittedRefs.add(key);
    return aliasScope === undefined
      ? { "$ref": `#/$defs/${key}` }
      : { "$ref": `#/$defs/${key}`, scope: aliasScope };
  }

  /**
   * The node that spells `type` as `annotation`, a member's annotation, does
   * (`SchemaHint.spelledBy`), or `undefined` where it spells neither. That is
   * the annotation, where it denotes `type`. Where the two differ only by the
   * `undefined` of an optional member's `?`, which a reader may add to the
   * annotation's type or take out of it, it is the members the annotation
   * writes (`readUnionMemberNodes()`) other than `undefined`, beside
   * `undefined` where `type` holds it, so that each member of `type` is read
   * at the node that writes it.
   */
  #spelling(
    type: ts.Type,
    annotation: ts.TypeNode,
    checker: ts.TypeChecker,
  ): ts.TypeNode | undefined {
    const annotated = checker.getTypeFromTypeNode(annotation);
    if (denotesSameType(annotated, type)) return annotation;
    if (!sameBesidesUndefined(annotated, type)) return undefined;
    const holdsUndefined = (type.isUnion() ? type.types : [type]).some(
      (member) => (member.flags & ts.TypeFlags.Undefined) !== 0,
    );
    let spellings = this.#optionalSpellings.get(annotation);
    if (!spellings) {
      spellings = new Map();
      this.#optionalSpellings.set(annotation, spellings);
    }
    if (!spellings.has(holdsUndefined)) {
      const members = readUnionMemberNodes(annotation, checker).filter(
        (member) =>
          (checker.getTypeFromTypeNode(member).flags &
            ts.TypeFlags.Undefined) === 0,
      );
      const spelled = holdsUndefined
        ? [
          ...members,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
        ]
        : members;
      spellings.set(
        holdsUndefined,
        spelled.length < 2
          ? spelled[0]
          : ts.factory.createUnionTypeNode(spelled),
      );
    }
    return spellings.get(holdsUndefined);
  }

  #bindingId(value: object): number {
    let id = this.#bindingIds.get(value);
    if (id === undefined) {
      id = ++this.#bindingIdCounter;
      this.#bindingIds.set(value, id);
    }
    return id;
  }

  /**
   * The bindings `context` reads under, as a key, or `undefined` where it reads
   * under none. A type's schema identity, the definition it is stored as and
   * the reference a recursion makes to it, is its type together with this key.
   */
  #bindingKey(context: GenerationContext): string | undefined {
    const bound = context.boundTypeParameters;
    if (!bound) return undefined;
    // Where the checker's instantiation at the position is known, it says what
    // the arguments denote, so a recursion whose arguments settle reads under
    // the same key however deep their bindings nest; the arguments as written
    // tell apart what their syntax adds, such as a `Default`. A `typeof`
    // reached through an outer binding retains its authored identity too.
    const instantiatedAs = context.instantiatedAs;
    return instantiatedAs
      ? `as:${this.#bindingId(instantiatedAs)}|${
        this.#bindingsKey(bound, false)
      }|queries:${this.#bindingQueries(bound, context.typeChecker).key}`
      : this.#bindingsKey(bound);
  }

  /**
   * Helper for {@link #bindingKey}: the ordered `typeof` bindings
   * each argument reaches through its outer bindings and alias bodies.
   * The checker can give distinct writers the same type, so their authored
   * queries remain part of a recursive definition's identity. Repeated union
   * and intersection members contribute once so their recursion can settle.
   */
  #bindingQueries(
    bound: BoundTypeParameters,
    checker: ts.TypeChecker,
  ): { key: string; hasQuery: boolean } {
    const cached = this.#bindingQueriesCache.get(bound);
    if (cached !== undefined) return cached;

    /** Query origins, grouped where union or intersection repetition can settle. */
    type Queries = number | {
      kind: "sequence" | "union" | "intersection";
      parts: Queries[];
    };

    /** Combines origins, flattening repetitions that do not add another policy. */
    const combine = (
      kind: Exclude<Queries, number>["kind"],
      children: Queries[],
    ): Queries | undefined => {
      const parts = children.flatMap((child) =>
        typeof child !== "number" && child.kind === kind ? child.parts : [child]
      );
      const distinct = kind === "sequence" ? parts : dedupeByValueEqual(parts);
      return distinct.length === 0
        ? undefined
        : distinct.length === 1
        ? distinct[0]
        : { kind, parts: distinct };
    };

    let hasQuery = false;
    const key = [...bound.arguments].map(([parameter, argument]) => {
      const aliases = new Set<ts.TypeAliasDeclaration>();
      const argumentsBeingRead = new Set<BoundTypeArgument>();

      /** Visits an argument in the scope where its node is written. */
      const readArgument = (value: BoundTypeArgument): Queries | undefined => {
        if (!value.node || argumentsBeingRead.has(value)) return undefined;
        argumentsBeingRead.add(value);
        const queries = visit(value.node, value.bound);
        argumentsBeingRead.delete(value);
        return queries;
      };

      /** Collects query nodes in source order, resolving bound parameters. */
      const visit = (
        node: ts.Node,
        under?: BoundTypeParameters,
        parameters?: ReadonlyMap<
          ts.TypeParameterDeclaration,
          Queries | undefined
        >,
      ): Queries | undefined => {
        if (ts.isTypeReferenceNode(node)) {
          const parameter = typeParameterOfReference(node, checker);
          if (parameter && parameters?.has(parameter)) {
            return parameters.get(parameter);
          }
          const value = parameter && under?.arguments.get(parameter);
          if (value) return readArgument(value);

          const declaration = getTypeAliasDeclaration(node, checker);
          if (declaration && !aliases.has(declaration)) {
            // Arguments contribute where the body uses them, under that
            // position's operator. Reading them alongside the body would
            // turn `W | typeof writer` into an ever-growing sequence.
            const boundHere = new Map(parameters);
            for (
              const [index, param] of (declaration.typeParameters ?? [])
                .entries()
            ) {
              const argument = node.typeArguments?.[index];
              boundHere.set(
                param,
                argument
                  ? visit(argument, under, parameters)
                  : param.default
                  ? visit(param.default, under, boundHere)
                  : undefined,
              );
            }
            aliases.add(declaration);
            const queries = visit(declaration.type, under, boundHere);
            aliases.delete(declaration);
            return queries;
          }
        }
        const children: Queries[] = [];
        if (ts.isTypeQueryNode(node)) {
          const binding = ts.isIdentifier(node.exprName)
            ? resolveWriterBinding(node.exprName, checker)
            : undefined;
          children.push(this.#bindingId(binding?.declaration ?? node));
        }
        ts.forEachChild(node, (child) => {
          const queries = visit(child, under, parameters);
          if (queries !== undefined) children.push(queries);
        });
        return combine(
          ts.isUnionTypeNode(node)
            ? "union"
            : ts.isIntersectionTypeNode(node)
            ? "intersection"
            : "sequence",
          children,
        );
      };

      const queries = readArgument(argument);
      hasQuery ||= queries !== undefined;
      return `${this.#bindingId(parameter)}=${JSON.stringify(queries)}`;
    }).sort().join(";");
    const result = { key, hasQuery };
    this.#bindingQueriesCache.set(bound, result);
    return result;
  }

  /**
   * Helper for {@link #bindingKey}: each parameter with its argument, which is
   * its type, its node where it has one, and, unless `deep` is `false`, the
   * bindings that node is read under, since each can change what the argument
   * reads as.
   */
  #bindingsKey(bound: BoundTypeParameters, deep = true): string {
    return [...bound.arguments].map(([parameter, argument]) => {
      const node = argument.node ? `@${this.#bindingId(argument.node)}` : "";
      const under = deep && argument.bound
        ? `(${this.#bindingsKey(argument.bound)})`
        : "";
      return `${this.#bindingId(parameter)}=${
        this.#bindingId(argument.type)
      }${node}${under}`;
    }).sort().join(",");
  }

  #anonymousName(
    type: ts.Type,
    context: GenerationContext,
  ): string | undefined {
    const key = this.#bindingKey(context);
    return key === undefined
      ? this.#anonymousNames.get(type)
      : this.#boundAnonymousNames.get(`${this.#bindingId(type)}|${key}`);
  }

  #ensureSyntheticName(
    type: ts.Type,
    context: GenerationContext,
  ): string {
    const existing = this.#anonymousName(type, context);
    if (existing) return existing;
    const synthetic = `AnonymousType_${++this.#anonymousNameCounter}`;
    const key = this.#bindingKey(context);
    if (key === undefined) this.#anonymousNames.set(type, synthetic);
    else {
      this.#boundAnonymousNames.set(
        `${this.#bindingId(type)}|${key}`,
        synthetic,
      );
    }
    return synthetic;
  }

  /**
   * Binds a reference's parameters, including those of forwarded aliases and
   * inherited interfaces whose declarations supply its members. Each argument
   * retains the bindings of the declaration where it is written.
   */
  #referenceBindings(
    reference: ts.TypeReferenceNode,
    context: GenerationContext,
  ): BoundTypeParameters {
    const checker = context.typeChecker;
    const argumentsHere = new Map<
      ts.TypeParameterDeclaration,
      BoundTypeArgument
    >();
    const seen = new Set<ts.Declaration>();
    const visit = (
      node: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments,
      outer: BoundTypeParameters | undefined,
    ): void => {
      const name = ts.isTypeReferenceNode(node)
        ? node.typeName
        : node.expression;
      let symbol = checker.getSymbolAtLocation(name);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      const declaration = symbol?.declarations?.find((node) =>
        ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)
      );
      if (!declaration || seen.has(declaration)) return;
      seen.add(declaration);
      const local = new Map<ts.TypeParameterDeclaration, BoundTypeArgument>();
      for (
        const [index, parameter] of (declaration.typeParameters ?? []).entries()
      ) {
        const written = node.typeArguments?.[index] ?? parameter.default;
        if (!written) continue;
        const under = node.typeArguments?.[index]
          ? outer
          : { arguments: new Map(local), declaredNode: reference };
        const argument = bindWrittenArgument(
          written,
          under,
          checker,
          (written) =>
            context.typeRegistry?.get(written) ??
              checker.getTypeFromTypeNode(written),
        );
        if (argument) {
          local.set(parameter, argument);
          argumentsHere.set(parameter, argument);
        }
      }
      const bound = { arguments: local, declaredNode: reference };
      if (ts.isTypeAliasDeclaration(declaration)) {
        const body = readAuthoredTypeNode(declaration.type, checker);
        if (ts.isTypeReferenceNode(body)) visit(body, bound);
      } else {
        for (const clause of declaration.heritageClauses ?? []) {
          for (const base of clause.types) visit(base, bound);
        }
      }
    };
    visit(reference, context.boundTypeParameters);
    return {
      arguments: argumentsHere,
      declaredNode: reference,
    };
  }

  /**
   * Keeps authored `typeof` identities when reading a plain generic's members.
   * Other plain generics keep their existing type-based analysis. A readable
   * member keeps its argument's syntax; an operator syntax cannot read keeps
   * its instantiated type.
   */
  #withGenericBindings(
    type: ts.Type,
    context: GenerationContext,
  ): GenerationContext {
    if (
      !context.typeNode ||
      this.#commonFabricFormatter.supportsType(type, context)
    ) return context;
    const checker = context.typeChecker;
    const reference = readAuthoredTypeNode(context.typeNode, checker);
    if (
      !ts.isTypeReferenceNode(reference) ||
      this.#namesLibraryAlias(reference, context)
    ) return context;
    const boundHere = this.#referenceBindings(reference, context);
    if (!this.#bindingQueries(boundHere, checker).hasQuery) return context;
    return {
      ...context,
      boundTypeParameters: boundHere,
      instantiatedAs: context.instantiatedAs ?? type,
    };
  }

  /** Formats a type using the appropriate formatter. */
  #formatType(
    type: ts.Type,
    context: GenerationContext,
    isRootType: boolean = false,
  ): MutableJSONSchema {
    context = this.#withGenericBindings(type, context);
    // Alternatives that share a type remain separate readings. Their type
    // identity cannot name either reading or mark one as a cycle of the other.
    if (context.typeNode && context.inlineUnionMember === context.typeNode) {
      const { inlineUnionMember: _, ...memberContext } = context;
      return this.#commonFabricFormatter.formatType(type, memberContext);
    }
    const collapsed = this.#unionFormatter.formatCollapsedUnion(type, context);
    if (collapsed !== undefined) return collapsed;

    const written = context.typeNode &&
      readAuthoredTypeNode(context.typeNode, context.typeChecker);
    if (
      written && ts.isTypeReferenceNode(written) &&
      this.#namesLibraryAlias(written, context) &&
      (holdsTypeQuery(
        written,
        context.boundTypeParameters,
        context.typeChecker,
      ) ||
        (ts.isIdentifier(written.typeName) &&
          written.typeName.text === "Record" &&
          this.#bindingQueries(
            this.#referenceBindings(written, context),
            context.typeChecker,
          ).hasQuery))
    ) {
      const applied = this.#analyzeLibraryAliasReference(
        written,
        context.typeChecker,
        context,
      );
      if (applied !== undefined) return applied;
    }

    // A scope wrapper reads its payload from the reference's argument, even
    // when its declaration erases to an unbound type parameter, and a
    // `Default` over a bound one reads its value as the parameter's argument
    // (`wrapsBoundParameter()`).
    const wrapsBound = wrapsBoundParameter(context.typeNode, context);
    if (
      (type.flags & ts.TypeFlags.TypeParameter) !== 0 &&
      !resolveScopeWrapperNode(context.typeNode)?.node.typeArguments?.length &&
      !wrapsBound
    ) {
      const checker = context.typeChecker;
      const baseConstraint = checker.getBaseConstraintOfType(type);
      if (baseConstraint && baseConstraint !== type) {
        return this.#formatType(baseConstraint, context, isRootType);
      }
      const defaultConstraint = checker.getDefaultFromTypeParameter?.(type);
      if (defaultConstraint && defaultConstraint !== type) {
        return this.#formatType(defaultConstraint, context, isRootType);
      }
      return {};
    }

    // Handle conditional types that arise from unresolved type parameters.
    // When a generic type like OpaqueCell<T | undefined> is used where T is a
    // type parameter, TypeScript represents this as a conditional type for
    // deferred evaluation. We treat these as "any" schema since the concrete
    // type isn't known at compile time.
    if ((type.flags & ts.TypeFlags.Conditional) !== 0 && !wrapsBound) {
      return {};
    }

    // All-named strategy:
    // Hoist every named type (excluding wrappers and native types filtered
    // by getNamedTypeKey) into definitions and return $ref for non-root uses.
    // Cycle detection still applies via definitionStack.

    // Check if we're in a wrapper context (Default/Cell/Stream/OpaqueCell).
    // Wrapper types erase to their inner type, so we must check typeNode to
    // distinguish wrapper context from inner context.
    // This now handles both direct wrappers and aliases (e.g., type MyDefault<T> = Default<T, T>)
    const wrapperKind = detectWrapperViaNode(
      context.typeNode,
      context.typeChecker,
    );
    const isWrapperContext = wrapperKind !== undefined;

    // A scope wrapper reached through an alias formats inline, as the wrapper
    // itself does, so that its scope stays at the top level of the slot's own
    // schema, the only place the write path reads it. A recursive one is
    // written once under `$defs` without its scope, and each reference to it
    // carries the scope instead.
    const aliasScope = scopeOfAliasChain(type, context.typeChecker);
    const isScopeWrapperAlias = aliasScope !== undefined;
    // One around a cell caps the handle and is itself a wrapper: it is not a
    // cycle's entry, so a cycle through it is found at the cell's value and
    // written there, as for `Cell<T>`, with the capped handle inline at each
    // reference.
    const scopesHandle = isScopeWrapperAlias &&
      scopesCellHandle(type, context.typeChecker);

    let namedKey = isScopeWrapperAlias
      ? undefined
      : getNamedTypeKey(type, context.typeNode);

    if (!namedKey && !isWrapperContext && !isScopeWrapperAlias) {
      // Only use synthetic names if we're not processing a wrapper type
      const synthetic = this.#anonymousName(type, context);
      if (synthetic) namedKey = synthetic;
    }

    // Check if this type is already being built or exists
    if (namedKey) {
      if (
        context.inProgressNames.has(namedKey) || context.definitions[namedKey]
      ) {
        // Already being built or exists: emit a ref
        context.emittedRefs.add(namedKey);
        return { "$ref": `#/$defs/${namedKey}` };
      }
      // Start building this named type; we'll store the result below
      context.inProgressNames.add(namedKey);
    }

    // Cycle detection: if we see the same type again by identity, emit a $ref.
    // A wrapper is not a cycle's entry. TypeScript reuses one type object for
    // every occurrence of an instantiation, so a recursive type holding
    // `Writable<TodoItem[]>` meets the same `Cell<TodoItem[]>` again, and in
    // wrapper context the cycle's definition could not be stored. The cycle is
    // found at the wrapper's value instead, where it can be. A type read under
    // type parameter bindings is that type together with them, as its
    // definition's name is (`#bindingKey()`), so the same declared type read
    // under other bindings inside it is no cycle.
    const bound = context.boundTypeParameters;
    const bindingKey = this.#bindingKey(context);
    const stackKey = bindingKey === undefined
      ? type
      : `${this.#bindingId(type)}|${bindingKey}`;
    // `never` holds no type, so it is never met inside itself and is not a
    // cycle's entry. A wrapper the checker reduces to it, as it reduces
    // `PerUser<never>` (`never & brand` is `never`), has `never` both for its
    // own type and for its payload's, and the payload read inside it is the
    // value it wraps, not its recursion.
    const tracksCycle = !scopesHandle && !isWrapperContext &&
      (type.flags & ts.TypeFlags.Never) === 0;
    // The same type read inside itself with the same arguments written for
    // it, each read under deeper bindings, is either a nesting its author
    // wrote out, `Pair<Pair<string>>`, or a recursion that instantiates it
    // without end, as `Nest<T[]>` inside `Nest<T>` does. As the checker does
    // for a type nested this way, the reading takes it for the second once it
    // is `MAX_BOUND_NESTING` deep; the innermost then accepts any value and is
    // reported as not fully read.
    const shape = bound === undefined
      ? undefined
      : `shape|${this.#bindingId(type)}|${this.#bindingsKey(bound, false)}`;
    let shapeKey: string | undefined;
    for (
      let depth = 0;
      shape !== undefined && shapeKey === undefined &&
      depth < MAX_BOUND_NESTING;
      depth++
    ) {
      const key = `${shape}|${depth}`;
      if (!context.definitionStack.has(key)) shapeKey = key;
    }
    if (
      tracksCycle && shape !== undefined && shapeKey === undefined &&
      !context.definitionStack.has(stackKey)
    ) {
      const unread = context.uninterpretedTypeNodes;
      const node = context.typeNode ?? bound?.declaredNode;
      if (unread && node && !unread.includes(node)) unread.push(node);
      return {};
    }
    if (tracksCycle && context.definitionStack.has(stackKey)) {
      if (namedKey) {
        context.emittedRefs.add(namedKey);
        return { "$ref": `#/$defs/${namedKey}` };
      }
      // Read for its labels alone, a value's recursion adds none to its top,
      // and naming it would name the type for every schema this generator
      // writes afterwards.
      if (context.labelsOnly) return {};
      const syntheticKey = this.#ensureSyntheticName(type, context);
      context.inProgressNames.add(syntheticKey);
      context.emittedRefs.add(syntheticKey);
      return aliasScope === undefined
        ? { "$ref": `#/$defs/${syntheticKey}` }
        : { "$ref": `#/$defs/${syntheticKey}`, scope: aliasScope };
    }

    // Push current type onto the stack
    if (tracksCycle) context.definitionStack.add(stackKey);
    const pushedShape = tracksCycle ? shapeKey : undefined;
    if (pushedShape !== undefined) context.definitionStack.add(pushedShape);
    const pop = () => {
      if (tracksCycle) context.definitionStack.delete(stackKey);
      if (pushedShape !== undefined) {
        context.definitionStack.delete(pushedShape);
      }
    };

    // Try to find a formatter that supports this type
    for (const formatter of this.#formatters) {
      if (formatter.supportsType(type, context)) {
        const result = formatter.formatType(type, context);

        // If this is a named type (all-named policy), store in definitions.
        // We already computed namedKey above with wrapper checks, so reuse it.
        // Only look up synthetic names if namedKey wasn't already set and we're
        // not in a wrapper context (to avoid storing wrapper results).
        const keyForDef = namedKey ??
          (isWrapperContext ? undefined : this.#anonymousName(type, context));
        if (keyForDef) {
          const scopeOnReference = aliasScope !== undefined &&
              isObjectOrArray(result) && result.scope === aliasScope
            ? aliasScope
            : undefined;
          if (scopeOnReference === undefined) {
            context.definitions[keyForDef] = result;
          } else {
            const { scope: _scope, ...payload } = result as Record<
              string,
              unknown
            >;
            context.definitions[keyForDef] = payload as MutableJSONSchema;
          }
          context.inProgressNames.delete(keyForDef);
          pop();
          if (!isRootType) {
            context.emittedRefs.add(keyForDef);
            return scopeOnReference === undefined
              ? { "$ref": `#/$defs/${keyForDef}` }
              : { "$ref": `#/$defs/${keyForDef}`, scope: scopeOnReference };
          }
          // For root, keep inline; buildFinalSchema may promote if we choose
        }
        // Pop after formatting
        pop();
        return result;
      }
    }

    // If no formatter supports this type, this is an error - we should have
    // complete coverage
    pop();

    const typeName = context.typeChecker.typeToString(type);
    const typeFlags = type.flags;
    throw new Error(
      `No formatter found for type: ${typeName} (flags: ${typeFlags}). ` +
        "This indicates incomplete formatter coverage - every TypeScript " +
        "type should be handled by a formatter.",
    );
  }

  /**
   * Build the final schema with definitions if needed
   */
  #buildFinalSchema(
    schema: MutableJSONSchema,
    type: ts.Type,
    context: GenerationContext,
    _typeNode?: ts.TypeNode,
  ): MutableJSONSchema {
    const { definitions, emittedRefs } = context;

    // If no definitions were created or used, return simple schema without $schema
    if (Object.keys(definitions).length === 0 || emittedRefs.size === 0) {
      return schema;
    }

    // Decide if we promote root to a $ref
    const namedKey = getNamedTypeKey(type) ?? this.#anonymousNames.get(type);
    const shouldPromoteRoot = this.#shouldPromoteToRef(namedKey, context);

    let base: MutableJSONSchema;

    if (shouldPromoteRoot && namedKey) {
      // Ensure root is present in definitions
      if (!definitions[namedKey]) {
        definitions[namedKey] = schema;
      }
      base = { $ref: `#/$defs/${namedKey}` };
    } else {
      base = schema;
    }

    // Handle boolean schemas (rare, but supported by JSON Schema)
    if (typeof base === "boolean") {
      return base;
    }

    // Object schema: attach only the definitions actually referenced by the
    // final output
    const filtered = this.#collectReferencedDefinitions(base, definitions);
    const out: Record<string, unknown> = {
      ...(base as Record<string, unknown>),
    };
    if (Object.keys(filtered).length > 0) out.$defs = filtered;
    return out as MutableJSONSchema;
  }

  /**
   * Determine if root schema should be promoted to a $ref
   */
  #shouldPromoteToRef(
    namedKey: string | undefined,
    context: GenerationContext,
  ): boolean {
    if (!namedKey) return false;

    const { definitions, emittedRefs } = context;

    // If the root type already exists in definitions and has been referenced,
    // promote it
    return !!(definitions[namedKey] && emittedRefs.has(namedKey));
  }

  #applyNodeSchemaHints(
    schema: MutableJSONSchema,
    context: GenerationContext,
  ): MutableJSONSchema {
    // A value keeps its labels however little of it is read, and a schema
    // that reaches them already, through its own reference, keeps them as is.
    // A value that may be missing has its labels on its value member, where
    // formatting put the part of them it could read.
    const labels = this.#narrowedFromLabels(context);
    const labelPosition = (position: MutableJSONSchema) => {
      const held = labels && declaredIfcLabels(position, context.definitions);
      return labels && !(held && holdsIfcLabels(held, labels))
        ? withIfcLabels(position, labels)
        : position;
    };
    const member = labels && labeledValueMember(schema, context.definitions);
    const labeled = member && typeof schema !== "boolean" && schema.anyOf
      ? {
        ...schema,
        anyOf: schema.anyOf.map((alternative) =>
          alternative === member ? labelPosition(alternative) : alternative
        ),
      }
      : labelPosition(schema);
    const hint = getUiContractHint(context);
    return hint ? attachUiContract(labeled, hint) : labeled;
  }

  /**
   * The CFC labels of the value the node at this position narrows, where a
   * hint names one (`SchemaHint.narrowedFrom`). A value keeps its labels
   * however little of it is read, and they are the labels its own type
   * attaches where it is formatted, read by that same formatting with its
   * payload left out (`GenerationContext.labelsOnly`).
   */
  #narrowedFromLabels(
    context: GenerationContext,
  ): Record<string, unknown> | undefined {
    const node = context.typeNode ?? context.hintsNode;
    if (!node || !context.schemaHints || context.labelsOnly) return undefined;
    const narrowedFrom = context.schemaHints.get(node)?.narrowedFrom ??
      context.schemaHints.get(unwrapTypeParentheses(node))?.narrowedFrom;
    if (!narrowedFrom) return undefined;
    // The value is read apart from this position, into definitions of its
    // own, and what reading it only for its labels leaves unread is no
    // problem to report.
    const {
      typeNode: _,
      hintsNode: __,
      arrayItemsOverride: ___,
      boundTypeParameters: ____,
      uninterpretedTypeNodes: _____,
      ...rest
    } = context;
    return this.#labelsOf(narrowedFrom.type, narrowedFrom.typeNode, {
      ...rest,
      onDiagnostic: () => {},
      labelsOnly: true,
      definitions: {},
      emittedRefs: new Set(),
      definitionStack: new Set(),
      inProgressNames: new Set(),
    });
  }

  /**
   * Whether `node`, a union member that stands for the member or members of
   * `type`, is read whole, as one alternative for all of them
   * (`pairUnionMemberNodes()`): where it is a CFC alias the CFC formatter
   * reads, whose labels the node alone can spell. A wrapper, such as
   * `Default<T, V>` or a cell, is not, nor is a scope wrapper, since each has
   * rules of its own for its place in a union: §7's for `Default`, and
   * `scope-placement.ts`'s for a scope.
   */
  #readsWhole(
    type: ts.Type,
    node: ts.TypeNode,
    context: GenerationContext,
  ): boolean {
    return this.#commonFabricFormatter.supportsType(type, {
      ...context,
      typeNode: node,
    }) &&
      detectWrapperViaNode(node, context.typeChecker) === undefined &&
      resolveScopeWrapperNode(node) === undefined &&
      scopeOfAliasChain(type, context.typeChecker) === undefined;
  }

  /**
   * Helper for {@link #narrowedFromLabels}, which returns the labels `type`,
   * spelled by `typeNode` where given, attaches at its top in `context`. A
   * value that may be missing, `T | undefined` or `T | null`, has the labels
   * of `T`, which formatting attaches to that member. A node narrowed from
   * any other union stands for any of its members, so it has the labels
   * formatting attaches to the union joined with those of its members
   * (`joinMemberIfcLabels()`). A member is spelled by the node of the union
   * `typeNode` writes, read through parentheses and aliases
   * (`readAuthoredTypeNode()`), that it is read at
   * (`pairUnionMemberNodes()`). A member that several nodes read whole stand
   * for may be under the labels of any of them, even where the checker
   * reduces the whole union to that member.
   */
  #labelsOf(
    type: ts.Type,
    typeNode: ts.TypeNode | undefined,
    context: GenerationContext,
    reading: Map<ts.Type, Set<ts.TypeNode | undefined>> = new Map(),
  ): Record<string, unknown> | undefined {
    // A recursive type, `type Recursive = Cell<Recursive> | null`, reaches the
    // type it is reading again at the same node. The recursion adds nothing to
    // the labels being read, so the read stops there. Only the pairs being
    // read count: a pair read again on another branch is read in full.
    const nodes = reading.get(type) ?? new Set<ts.TypeNode | undefined>();
    if (nodes.has(typeNode)) return undefined;
    nodes.add(typeNode);
    reading.set(type, nodes);
    try {
      return this.#readLabelsOf(type, typeNode, context, reading);
    } finally {
      nodes.delete(typeNode);
    }
  }

  /** Helper for {@link #labelsOf}, which reads `type`'s labels once. */
  #readLabelsOf(
    type: ts.Type,
    typeNode: ts.TypeNode | undefined,
    context: GenerationContext,
    reading: Map<ts.Type, Set<ts.TypeNode | undefined>>,
  ): Record<string, unknown> | undefined {
    const checker = context.typeChecker;
    // A cell's labels are its value's, read at the value's own node.
    const cell = resolveWrapperNode(typeNode, checker);
    const wrapper = cell && cell.kind !== "Default" &&
      getCellWrapperInfo(type, checker);
    const valueType = wrapper &&
      (wrapper.typeRef.typeArguments ??
        checker.getTypeArguments(wrapper.typeRef))[0];
    if (cell && valueType) {
      return this.#labelsOf(
        valueType,
        cell.node.typeArguments?.[0],
        context,
        reading,
      );
    }
    const written = typeNode && readAuthoredTypeNode(typeNode, checker);
    const paired = written && ts.isUnionTypeNode(written)
      ? pairUnionMemberNodes(
        type.isUnion() ? type.types : [type],
        written,
        checker,
        (union, node) => this.#readsWhole(union, node, context),
      )
      : undefined;
    const memberNode = (member: ts.Type) =>
      type.isUnion() ? paired?.ordered[type.types.indexOf(member)] : undefined;
    const nullish = ts.TypeFlags.Undefined | ts.TypeFlags.Null |
      ts.TypeFlags.Void;
    const values = type.isUnion()
      ? type.types.filter((member) => (member.flags & nullish) === 0)
      : [type];
    const wholeNodes = values.length === 1 &&
      paired?.wholeNodes.get(values[0]!);
    if (wholeNodes) {
      return joinMemberIfcLabels(
        {},
        wholeNodes.map(({ type, node }) =>
          this.#labelsOf(type, node, context, reading) ?? {}
        ),
      );
    }
    if (values.length === 1 && values[0] !== type) {
      // An optional property's declaration spells the value alone, since its
      // `?` adds the `undefined`.
      const valueNode = typeNode &&
          checker.getTypeFromTypeNode(typeNode) === values[0]
        ? typeNode
        : memberNode(values[0]!);
      return this.#labelsOf(values[0]!, valueNode, context, reading);
    }
    const whole = this.formatChildType(type, context, typeNode);
    const labels = declaredIfcLabels(whole, context.definitions);
    if (values.length < 2) return labels;
    return joinMemberIfcLabels(
      labels ?? {},
      values.flatMap((member) => {
        const wholeNodes = paired?.wholeNodes.get(member);
        return wholeNodes
          ? wholeNodes.map(({ node, type }) =>
            this.#labelsOf(type, node, context, reading) ?? {}
          )
          : [
            this.#labelsOf(member, memberNode(member), context, reading) ?? {},
          ];
      }),
    );
  }

  /**
   * Detect cycles in the type graph
   */
  #getCycles(
    type: ts.Type,
    checker?: ts.TypeChecker,
  ): { types: Set<ts.Type>; names: Set<string> } {
    // Identity and name-based DFS cycle detection
    const visiting = new Set<ts.Type>();
    const stack: ts.Type[] = [];
    const cycles = new Set<ts.Type>();
    const cycleNames = new Set<string>();

    const visit = (t: ts.Type) => {
      if (visiting.has(t)) {
        // Mark all nodes from the first occurrence of t on the stack to the end
        const idx = stack.lastIndexOf(t);
        if (idx >= 0) {
          for (let i = idx; i < stack.length; i++) {
            const tt = stack[i]!;
            cycles.add(tt);
            const nk = getNamedTypeKey(tt);
            if (nk) cycleNames.add(nk);
          }
        } else {
          cycles.add(t);
          const nk = getNamedTypeKey(t);
          if (nk) cycleNames.add(nk);
        }
        return;
      }
      visiting.add(t);
      stack.push(t);

      const flags = t.flags;
      try {
        if (flags & ts.TypeFlags.Union) {
          const ut = t as ts.UnionType;
          for (const mt of ut.types) {
            visit(mt);
          }
        } else if (flags & ts.TypeFlags.Object) {
          // Traverse properties
          if (checker) {
            for (const prop of checker.getPropertiesOfType(t)) {
              const location: ts.Node = prop.valueDeclaration ??
                (prop.declarations?.[0] as ts.Declaration);
              const pt = safeGetTypeOfSymbolAtLocation(
                checker,
                prop,
                location,
                "cycle detection property",
              );
              if (pt) visit(pt);
            }
            // Traverse numeric index (arrays/tuples)
            const idx = safeGetIndexTypeOfType(
              checker,
              t,
              ts.IndexKind.Number,
              "cycle detection numeric index",
            );
            if (idx) visit(idx);
          }
        }
      } finally {
        stack.pop();
        visiting.delete(t);
      }
    };

    if (checker) visit(type);
    return { types: cycles, names: cycleNames };
  }

  /**
   * Attach a root-level description from JSDoc when the root schema does not
   * already supply one.
   */
  #attachRootDescription(
    schema: MutableJSONSchema,
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    if (typeof schema !== "object") return schema;

    const docInfo = extractDocFromType(type, context.typeChecker);
    if (
      docInfo.firstDoc && isObjectOrArray(schema) && !("description" in schema)
    ) {
      (schema as Record<string, unknown>).description = docInfo.firstDoc;
    }
    if (isObjectOrArray(schema) && typeof schema.description === "string") {
      attachDocTags(schema as Record<string, unknown>, schema.description);
    }
    return schema;
  }

  /**
   * Recursively scan a schema fragment to collect referenced definition names
   * and return the minimal subset of definitions required to resolve them,
   * including transitive dependencies.
   */
  #collectReferencedDefinitions(
    fragment: MutableJSONSchema,
    allDefs: Record<string, MutableJSONSchema>,
  ): Record<string, MutableJSONSchema> {
    const needed = new Set<string>();
    const visited = new Set<string>();

    const enqueueFromRef = (ref: string) => {
      const prefix = "#/$defs/";
      if (typeof ref === "string" && ref.startsWith(prefix)) {
        const name = ref.slice(prefix.length);
        if (name) needed.add(name);
      }
    };

    const scan = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) scan(item);
        return;
      }
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (k === "$ref" && typeof v === "string") enqueueFromRef(v);
        // Skip descending into existing $defs blocks to avoid pulling in
        // already-attached subsets recursively
        if (k === "$defs" || k === "definitions") continue;
        scan(v);
      }
    };

    // Find initial set of needed names from the fragment
    scan(fragment);

    // Compute transitive closure by following refs inside included definitions
    const stack: string[] = Array.from(needed);
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);
      const def = allDefs[name];
      if (!def) continue;
      // Scan definition body for further refs
      scan(def);
      for (const n of Array.from(needed)) {
        if (!visited.has(n)) {
          // Only push newly discovered names
          if (!stack.includes(n)) stack.push(n);
        }
      }
    }

    // Build the subset map
    const subset: Record<string, MutableJSONSchema> = {};
    for (const name of visited) {
      if (allDefs[name]) subset[name] = allDefs[name];
    }
    return subset;
  }

  /**
   * Internal helper to analyze synthetic TypeNode structure.
   * Uses formatChildType for properties to share context properly.
   * Gets typeRegistry from context.typeRegistry if available.
   */
  #analyzeTypeNodeStructure(
    typeNode: ts.TypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): MutableJSONSchema {
    const printed = context.printedFrom?.(typeNode);
    if (printed) {
      return this.formatChildType(
        printed,
        context,
        typeNode,
        context.instantiatedAs,
      );
    }

    const typeRegistry = context.typeRegistry;

    // Handle TypeLiteral nodes (object types)
    if (ts.isTypeLiteralNode(typeNode)) {
      const properties: Record<string, MutableJSONSchema> = {};
      const required: string[] = [];
      let additionalProperties: MutableJSONSchema | undefined;

      for (const member of typeNode.members) {
        if (ts.isPropertySignature(member) && member.name && member.type) {
          const propName = getPropertyNameText(member.name, checker);
          if (!propName) {
            // A computed brand such as `[DEFAULT_MARKER]` can carry metadata
            // that only the resolved type retains. A wrapper with that type
            // must know this node's members were not fully interpreted.
            context.uninterpretedTypeNodes?.push(typeNode);
            continue;
          }

          // Get the property type - check typeRegistry first, then resolve from node
          let propType: ts.Type;
          if (typeRegistry && typeRegistry.has(member.type)) {
            propType = typeRegistry.get(member.type)!;
          } else {
            propType = checker.getTypeFromTypeNode(member.type);
          }

          const instantiatedPropType = instantiatedPropertyType(
            context.instantiatedAs,
            propName,
            checker,
          );
          const callable = classifyCallableProperty(
            instantiatedPropType ?? context.printedFrom?.(member.type) ??
              propType,
            checker,
            context.boundTypeParameters,
          );
          if (callable) {
            if (callable.kind === "wrapper") {
              const uiContract = getUiContractHint(context, member.type);
              properties[propName] = uiContract
                ? attachUiContract(callable.schema, uiContract)
                : callable.schema;
              if (!member.questionToken) required.push(propName);
            }
            continue;
          }

          // Use formatChildType - it will auto-detect whether to use type-based
          // or node-based analysis depending on whether propType is reliable
          const propSchema = this.formatChildType(
            propType,
            context,
            member.type,
            instantiatedPropType,
          );

          properties[propName] = propSchema;

          // Add to required if not optional
          if (!member.questionToken) {
            required.push(propName);
          }
        } else if (ts.isIndexSignatureDeclaration(member) && member.type) {
          // Handle string/number index signatures on synthetic TypeLiteralNodes
          // by emitting them as `additionalProperties` with the value type's
          // schema. Without this branch, synthetic `Record<K, V>` /
          // `{ [k: string]: V }` shapes silently drop their index signature
          // when routed through node-based analysis (e.g. the SchemaInjection
          // lift-revisit path that feeds `any` as the paired Type, see
          // ts-transformers schema-injection.ts ~line 3290).
          //
          // Note: unlike `ObjectFormatter.formatType`'s type-driven path
          // (object-formatter.ts:344-365), this branch does NOT propagate
          // JSDoc from the index signature. Synthetic TypeLiteralNodes have
          // no source-positioned declarations to read JSDoc from, so there
          // is nothing to propagate. If we ever route declaration-bearing
          // nodes through this path, JSDoc propagation should be added.
          let valueType: ts.Type;
          if (typeRegistry && typeRegistry.has(member.type)) {
            valueType = typeRegistry.get(member.type)!;
          } else {
            valueType = checker.getTypeFromTypeNode(member.type);
          }
          const valueSchema = this.formatChildType(
            valueType,
            context,
            member.type,
            instantiatedValueType(context.instantiatedAs, checker),
          );
          // If multiple index signatures are present (e.g. both string and
          // number key), the first non-undefined wins — matching
          // ObjectFormatter's `stringIndex ?? numberIndex` precedence.
          if (additionalProperties === undefined) {
            additionalProperties = valueSchema;
          }
        }
      }

      const schema: MutableJSONSchemaObj = {
        type: "object",
        properties,
      };

      if (required.length > 0) {
        schema.required = required;
      }

      if (additionalProperties !== undefined) {
        (schema as Record<string, unknown>).additionalProperties =
          additionalProperties;
      }

      return schema;
    }

    // A `readonly T[]` node is the operator form the checker prints a
    // ReadonlyArray in, and it is what a synthetic result type built from a
    // cell read looks like (`cell.get()` on a `Cell<T[]>` reads back
    // `readonly T[]`). Readonly-ness is a mutability marker with no JSON
    // Schema counterpart, so the node carries exactly the shape of `T[]`.
    // Without this branch the node fell through to the accept-anything
    // fallback at the end, which turned a read of `unknown[]` — the
    // reference-only declaration — into a schema that walks everything.
    if (
      ts.isTypeOperatorNode(typeNode) &&
      typeNode.operator === ts.SyntaxKind.ReadonlyKeyword
    ) {
      return this.#analyzeTypeNodeStructure(typeNode.type, checker, context);
    }

    // A parenthesized node carries exactly the shape it wraps.
    if (ts.isParenthesizedTypeNode(typeNode)) {
      return this.#analyzeTypeNodeStructure(
        unwrapTypeParentheses(typeNode),
        checker,
        context,
      );
    }

    // A tuple lowers the way the type-based path lowers one: an array whose
    // items accept any of the elements, structure and arity dropped
    // (tuple-emission.test.ts pins that choice). A rest element contributes
    // its array's items; an optional one admits `undefined` as well, so a
    // tuple of `unknown` — reference-only slots — reads as that and not as a
    // request for everything.
    if (ts.isTupleTypeNode(typeNode)) {
      return {
        type: "array",
        items: tupleItems(
          this.#slotsOfTupleNode(
            typeNode,
            checker,
            context,
            new Set(),
            context.instantiatedAs,
          ),
        ),
      };
    }

    // An intersection is settled as the checker settles one and merged the
    // way IntersectionFormatter merges one (`intersectionOf`), each
    // constituent read through its reference.
    if (ts.isIntersectionTypeNode(typeNode)) {
      const unread = context.uninterpretedTypeNodes;
      const unreadBefore = unread?.length ?? 0;
      const schema = intersectionOf(
        typeNode.types.map((member) =>
          this.#analyzeChildNode(member, checker, context)
        ),
        context,
      );
      // An intersection accepting nothing does so whatever a constituent
      // accepts, so a constituent's guess leaves nothing in its schema.
      if (schema === false) unread?.splice(unreadBefore);
      return schema;
    }

    // Handle ArrayTypeNode (e.g., number[], string[])
    if (ts.isArrayTypeNode(typeNode)) {
      const elementType = typeRegistry?.get(typeNode.elementType) ??
        checker.getTypeFromTypeNode(typeNode.elementType);
      const items = this.formatChildType(
        elementType,
        context,
        typeNode.elementType,
        instantiatedElementType(context.instantiatedAs, checker),
      );
      return { type: "array", items };
    }

    // Handle unions in synthetic nodes. Keep all members including undefined
    // to match the type-based UnionFormatter which emits { type: "undefined" }
    // explicitly. Keyword types (string, number, boolean, undefined, null) are
    // resolved directly by the switch below, so they never cause widening.
    if (ts.isUnionTypeNode(typeNode)) {
      // The one member that is neither `null` nor `undefined` is read at the
      // union's instantiation less those; any other member has none.
      const { instantiatedAs, ...unplaced } = context;
      const valued = typeNode.types.filter((member) => {
        const kind = unwrapTypeParentheses(member);
        return kind.kind !== ts.SyntaxKind.UndefinedKeyword &&
          !(ts.isLiteralTypeNode(kind) &&
            kind.literal.kind === ts.SyntaxKind.NullKeyword);
      });
      const soleInstantiated = valued.length === 1 && instantiatedAs
        ? soleNonNullishMember(instantiatedAs)
        : undefined;
      const memberSchemas = typeNode.types.map((member) =>
        this.#analyzeTypeNodeStructure(
          member,
          checker,
          soleInstantiated && member === valued[0]
            ? { ...unplaced, instantiatedAs: soleInstantiated }
            : unplaced,
        )
      );
      if (memberSchemas.some((schema) => schema === true)) {
        return true;
      }
      if (memberSchemas.length === 1) {
        return memberSchemas[0]!;
      }
      // Filter out `false` schemas (from `never` types) — they reject all
      // values and are no-ops inside anyOf.
      const filtered = memberSchemas.filter((s) => s !== false);
      if (filtered.length === 0) return false;
      if (filtered.length === 1) return filtered[0]!;
      return { anyOf: filtered as MutableJSONSchemaObj[] };
    }

    if (ts.isLiteralTypeNode(typeNode)) {
      const literal = typeNode.literal;
      if (ts.isStringLiteral(literal)) {
        return { type: "string", const: literal.text };
      }
      if (ts.isNumericLiteral(literal)) {
        return { type: "number", const: Number(literal.text) };
      }
      if (literal.kind === ts.SyntaxKind.TrueKeyword) {
        return { type: "boolean", const: true };
      }
      if (literal.kind === ts.SyntaxKind.FalseKeyword) {
        return { type: "boolean", const: false };
      }
      if (literal.kind === ts.SyntaxKind.NullKeyword) {
        return { type: "null" };
      }
    }

    // Synthetic TypeReferenceNodes may fail to bind in checker APIs directly.
    // Resolve by name from source scope as a fallback (e.g., PieceEntry in
    // Cell<PieceEntry[]>).
    if (ts.isTypeReferenceNode(typeNode)) {
      if (detectWrapperViaNode(typeNode, checker)) {
        const wrapperType = typeRegistry?.get(typeNode) ??
          checker.getTypeFromTypeNode(typeNode);
        return this.formatChildType(
          wrapperType,
          context,
          typeNode,
          context.instantiatedAs,
        );
      }

      // A scope wrapper naming its payload is read from that argument, which
      // `CommonFabricFormatter` takes from the node, so its name is not
      // resolved: the transformer prints one it builds as
      // `__cfHelpers.PerUser`, which no scope declares, and the declared type
      // of one the module declares leaves its parameter unbound.
      if (resolveScopeWrapperNode(typeNode) && typeNode.typeArguments?.length) {
        return this.formatChildType(
          checker.getUnknownType(),
          context,
          typeNode,
          context.instantiatedAs,
        );
      }

      const applied = this.#analyzeLibraryAliasReference(
        typeNode,
        checker,
        context,
      );
      if (applied !== undefined) return applied;
      // One whose rules do not apply, over a bound parameter, has a type the
      // checker has not instantiated, so it is not read.
      const bound = context.boundTypeParameters;
      if (
        bound && this.#namesLibraryAlias(typeNode, context) &&
        holdsTypeParameter(typeNode, checker, bound.arguments)
      ) {
        context.uninterpretedTypeNodes?.push(typeNode);
        return true;
      }

      const argument = this.#identityAliasArgument(typeNode, checker, context);
      if (argument) {
        return this.#analyzeChildNode(
          argument,
          checker,
          context,
          context.instantiatedAs,
        );
      }

      const resolved = this.#resolveTypeReferenceFromScope(
        typeNode,
        checker,
        context,
      );
      // A name declared as `any` reads as `any` does, accepting any value.
      if (resolved === checker.getAnyType()) return true;
      if (resolved) {
        return this.formatChildType(
          resolved,
          context,
          typeNode,
          context.instantiatedAs,
        );
      }

      if (
        ts.isIdentifier(typeNode.typeName) && typeNode.typeName.text === "Date"
      ) {
        return { type: "string", format: "date-time" };
      }
    }

    // Handle keyword types (string, number, boolean, etc.)
    switch (typeNode.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { type: "string" };
      case ts.SyntaxKind.NumberKeyword:
        return { type: "number" };
      case ts.SyntaxKind.BooleanKeyword:
        return { type: "boolean" };
      case ts.SyntaxKind.NullKeyword:
        return { type: "null" };
      case ts.SyntaxKind.UndefinedKeyword:
        // undefined isn't normally part of JSON Schema, but we include it as a special case
        return { type: "undefined" };
      case ts.SyntaxKind.NeverKeyword:
        // Reject all values (never type can never occur)
        return false;
      case ts.SyntaxKind.UnknownKeyword:
        return { type: "unknown" };
      case ts.SyntaxKind.VoidKeyword:
        return PrimitiveFormatter.getSchemaType(checker.getVoidType(), context);
      case ts.SyntaxKind.AnyKeyword:
        // Accept any value
        return true;
    }

    // For other TypeNode kinds, try to resolve as Type
    const type = checker.getTypeFromTypeNode(typeNode);
    if (!(type.flags & ts.TypeFlags.Any)) {
      // Successfully resolved - use formatChildType to share context
      return this.formatChildType(
        type,
        context,
        typeNode,
        context.instantiatedAs,
      );
    }

    // Fallback: accept any value. This is a guess rather than a reading of the
    // node, so it is recorded for a caller holding a usable type for the
    // position.
    context.uninterpretedTypeNodes?.push(typeNode);
    return true;
  }

  /**
   * Analyze a child node the way the array branch analyzes an element: from
   * its registered Type when the registry has a reliable one, from the node
   * otherwise. `formatChildType` makes that choice.
   */
  #analyzeChildNode(
    node: ts.TypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
    instantiatedAs?: ts.Type,
  ): MutableJSONSchema {
    const type = context.typeRegistry?.get(node) ??
      checker.getTypeFromTypeNode(node);
    return this.formatChildType(type, context, node, instantiatedAs);
  }

  /**
   * The argument `reference` supplies to an alias whose whole body is one of
   * its own type parameters, such as `type Reactive<T> = T`: the reference
   * denotes exactly that argument. `undefined` for any other reference, for
   * one that leaves the argument out, and for a scope wrapper, whose scope
   * `CommonFabricFormatter` reads from the reference's name.
   */
  #identityAliasArgument(
    reference: ts.TypeReferenceNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): ts.TypeNode | undefined {
    if (
      !ts.isIdentifier(reference.typeName) ||
      resolveScopeWrapperNode(reference)
    ) {
      return undefined;
    }
    const declaration = this.#resolveTypeName(
      reference,
      reference.typeName,
      checker,
      context,
    )?.declarations?.find(ts.isTypeAliasDeclaration);
    const body = declaration && unwrapTypeParentheses(declaration.type);
    if (
      !body || !ts.isTypeReferenceNode(body) || body.typeArguments ||
      !ts.isIdentifier(body.typeName)
    ) {
      return undefined;
    }
    const name = body.typeName.text;
    const index =
      declaration.typeParameters?.findIndex((parameter) =>
        parameter.name.text === name
      ) ?? -1;
    return index >= 0 ? reference.typeArguments?.[index] : undefined;
  }

  /**
   * The slots of the tuples `node` denotes, one list per alternative — a
   * union of tuples, spread or wrapped, has several — or `undefined` when
   * `node` denotes no tuple these rules can read: an array, an object, a
   * generic alias. `node` is opened through parentheses, `readonly`, and
   * aliases, and through the default library's `Readonly`, `NonNullable`,
   * `Required`, and `Partial` — `NonNullable` dropping a union's `null` and
   * `undefined` members however they are spelled, the last two applied to
   * the slots they wrap — so the optionality an outer `Required` acts on
   * survives any composition of them. A union is one alternative per
   * member, each read on its own; read as a spread (`TupleReading`), a
   * member that is no tuple is an array, held in a rest slot, so a tuple
   * beside it keeps its slots and the read always has an answer.
   */
  #tupleSlots(
    node: ts.TypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
    opened: OpenedAliases,
    reading: TupleReading,
  ): TupleSlot[][] | undefined {
    const behind = this.#openTypeNode(node, checker, context, opened);
    const target = behind.node;
    if (ts.isUnionTypeNode(target)) {
      const members: (TupleSlot[][] | undefined)[] = [];
      for (const member of target.types) {
        // A member is nullish by what it opens to: `Nil` and `(null)` are
        // `null` as much as the bare keyword is. Dropped, it is no
        // alternative at all, which is not a failed read.
        const opensTo =
          this.#openTypeNode(member, checker, context, behind.opened).node;
        if (reading.nonNullable && isNullishTypeNode(opensTo)) continue;
        members.push(
          this.#tupleSlots(member, checker, context, behind.opened, reading),
        );
      }
      return members.every((member) => member !== undefined)
        ? (members as TupleSlot[][][]).flat()
        : undefined;
    }
    if (ts.isTupleTypeNode(target)) {
      return this.#slotsOfTupleNode(target, checker, context, behind.opened);
    }
    if (
      ts.isTypeReferenceNode(target) && ts.isIdentifier(target.typeName) &&
      target.typeArguments?.length === 1 &&
      this.#isLibraryDeclaredName(target, target.typeName, checker, context)
    ) {
      const wrapped = (nonNullable = reading.nonNullable) =>
        this.#tupleSlots(
          target.typeArguments![0]!,
          checker,
          context,
          behind.opened,
          { ...reading, nonNullable },
        );
      switch (target.typeName.text) {
        case "Readonly":
          return wrapped();
        case "NonNullable":
          return wrapped(true);
        case "Required":
          return wrapped()?.map((slots) => requiredSlots(slots, context));
        case "Partial":
          return wrapped()?.map(partialSlots);
      }
    }
    return reading.spread
      ? unionArms(this.#analyzeChildNode(node, checker, context), context)
        .map((arm) => [restSlot(arm)])
      : undefined;
  }

  /**
   * The slots of a tuple type node, one list per alternative: a spread
   * tuple's slots inlined, each with its own optionality, a spread over a
   * union multiplying the alternatives, one per member; anything else
   * spread being an array, a rest slot holding its items, read through a
   * reference and a union of arrays; then each alternative normalized as
   * the checker normalizes a tuple. `instantiatedAs` is the tuple's
   * instantiation where it is read at a position of its own under bindings
   * (`GenerationContext.instantiatedAs`); a tuple spread into another, or
   * reached through a union or an opened alias, has none.
   */
  #slotsOfTupleNode(
    tuple: ts.TupleTypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
    opened: OpenedAliases,
    instantiatedAs?: ts.Type,
  ): TupleSlot[][] {
    // A tuple without a rest element reads each slot at the same slot of its
    // instantiation.
    const instantiatedSlots = instantiatedAs &&
        checker.isTupleType(instantiatedAs) &&
        !tuple.elements.some((element) =>
          ts.isRestTypeNode(element) ||
          (ts.isNamedTupleMember(element) &&
            element.dotDotDotToken !== undefined)
        )
      ? checker.getTypeArguments(instantiatedAs as ts.TypeReference)
      : undefined;
    let alternatives: TupleSlot[][] = [[]];
    for (const [index, element] of tuple.elements.entries()) {
      const rest = ts.isRestTypeNode(element) ||
        (ts.isNamedTupleMember(element) &&
          element.dotDotDotToken !== undefined);
      const optional = ts.isOptionalTypeNode(element) ||
        (ts.isNamedTupleMember(element) &&
          element.questionToken !== undefined);
      const inner = ts.isNamedTupleMember(element) ||
          ts.isRestTypeNode(element) || ts.isOptionalTypeNode(element)
        ? element.type
        : element;
      // A spread always has slots: what is no tuple is an array.
      const contributions = rest
        ? this.#tupleSlots(inner, checker, context, opened, {
          nonNullable: false,
          spread: true,
        }) as TupleSlot[][]
        : [[{
          kind: optional ? "optional" : "required",
          schema: this.#analyzeChildNode(
            inner,
            checker,
            context,
            instantiatedSlots?.[index],
          ),
        } as TupleSlot]];
      alternatives = alternatives.flatMap((prefix) =>
        contributions.map((slots) => [...prefix, ...slots])
      );
    }
    return alternatives.map(normalizeTuple);
  }

  /**
   * `Required<T>` applied to `node`. The node is read rather than its
   * schema wherever the schema has already lost what `Required` acts on: a
   * tuple's slot optionality, which the positionless items form drops. So
   * a union is viewed member by member, and a tuple's slots are read
   * (`#tupleSlots`) and made required; anything else maps its schema's
   * arms.
   */
  #requiredView(
    node: ts.TypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
    opened: OpenedAliases,
  ): MutableJSONSchema {
    const behind = this.#openTypeNode(node, checker, context, opened);
    if (ts.isUnionTypeNode(behind.node)) {
      return unionOfSchemas(
        behind.node.types.map((member) =>
          this.#requiredView(member, checker, context, behind.opened)
        ),
      );
    }
    const peeled = this.#peelLibraryWrappers(node, checker, context, opened);
    if (peeled.wrappers.length > 0 && ts.isUnionTypeNode(peeled.core)) {
      // The wrappers distribute over the union, `NonNullable` dropping its
      // `null` and `undefined` members; each member is viewed wrapped as
      // the whole was, so a tuple beside an object keeps its slots.
      const dropNullish = peeled.wrappers.some((wrapper) =>
        (wrapper.typeName as ts.Identifier).text === "NonNullable"
      );
      return unionOfSchemas(
        peeled.core.types
          .filter((member) =>
            !(dropNullish &&
              isNullishTypeNode(
                this.#openTypeNode(member, checker, context, peeled.opened)
                  .node,
              ))
          )
          .map((member) =>
            this.#requiredView(
              peeled.wrappers.reduceRight<ts.TypeNode>(
                (inner, wrapper) =>
                  ts.factory.createTypeReferenceNode(wrapper.typeName, [inner]),
                member,
              ),
              checker,
              context,
              peeled.opened,
            )
          ),
      );
    }
    const slots = this.#tupleSlots(node, checker, context, opened, {
      nonNullable: false,
      spread: false,
    });
    if (slots !== undefined) {
      return {
        type: "array",
        items: tupleItems(
          slots.map((alternative) => requiredSlots(alternative, context)),
        ),
      };
    }
    return mapArms(
      this.#analyzeChildNode(node, checker, context),
      context,
      (arm) => requiredArm(arm, context),
    );
  }

  /**
   * `node` with the library's wrappers (`LIBRARY_WRAPPER_NAMES`) peeled off
   * the outside, outermost first, down to the `core` they wrap, aliases
   * opened along the way.
   */
  #peelLibraryWrappers(
    node: ts.TypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
    opened: OpenedAliases,
  ): {
    wrappers: ts.TypeReferenceNode[];
    core: ts.TypeNode;
    opened: OpenedAliases;
  } {
    const wrappers: ts.TypeReferenceNode[] = [];
    let behind = this.#openTypeNode(node, checker, context, opened);
    for (;;) {
      const target = behind.node;
      if (
        !ts.isTypeReferenceNode(target) || !ts.isIdentifier(target.typeName) ||
        target.typeArguments?.length !== 1 ||
        !LIBRARY_WRAPPER_NAMES.has(target.typeName.text) ||
        !this.#isLibraryDeclaredName(target, target.typeName, checker, context)
      ) {
        return { wrappers, core: target, opened: behind.opened };
      }
      wrappers.push(target);
      behind = this.#openTypeNode(
        target.typeArguments[0]!,
        checker,
        context,
        behind.opened,
      );
    }
  }

  /**
   * The type node behind `node`: parentheses and `readonly` stripped, and a
   * reference to a non-generic alias replaced by what the alias declares,
   * followed as far as it goes, so a spread or a union member is read as the
   * checker reads it. `opened` names the aliases already on this path; one
   * met again is left as the reference it is, so a circular alias — an
   * error the checker reports — cannot send this in a loop. A node the
   * rules cannot open (a generic alias, an imported or unresolvable name) is
   * returned as it came.
   */
  #openTypeNode(
    node: ts.TypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
    opened: OpenedAliases,
  ): { node: ts.TypeNode; opened: OpenedAliases } {
    const unwrapped = unwrapTypeNode(node);
    if (
      !ts.isTypeReferenceNode(unwrapped) ||
      !ts.isIdentifier(unwrapped.typeName) ||
      unwrapped.typeArguments !== undefined
    ) {
      return { node: unwrapped, opened };
    }
    const declaration = this.#resolveTypeName(
      unwrapped,
      unwrapped.typeName,
      checker,
      context,
    )?.declarations?.find(ts.isTypeAliasDeclaration);
    if (
      declaration === undefined || declaration.typeParameters !== undefined ||
      opened.has(declaration)
    ) {
      return { node: unwrapped, opened };
    }
    return this.#openTypeNode(
      declaration.type,
      checker,
      context,
      new Set([...opened, declaration]),
    );
  }

  /**
   * The symbol `name` denotes as seen from the reference's scope, an import
   * followed to what it imports: bound through the node when the checker can
   * bind it, else resolved lexically, so an authored or imported declaration
   * of the same name shadows a global's the way it does for the checker.
   */
  #resolveTypeName(
    typeNode: ts.TypeReferenceNode,
    name: ts.Identifier,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): ts.Symbol | undefined {
    let symbol = checker.getSymbolAtLocation(name);
    if (!symbol) {
      const scope = this.#scopeSourceFile(typeNode, checker, context);
      if (!scope) return undefined;
      symbol = checker.resolveName(
        name.text,
        scope,
        ts.SymbolFlags.Type,
        false,
      );
    }
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }

  /**
   * The source file whose scope a synthetic reference resolves in: the
   * generation context's, else the one the node or its context node belongs
   * to. A synthetic node built outside any file has none.
   */
  #scopeSourceFile(
    typeNode: ts.TypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): ts.SourceFile | undefined {
    const checkerWithProgram = checker as ts.TypeChecker & {
      getProgram?: () => ts.Program;
    };
    const sourceFromContext = context.sourceFile ??
      (context.sourceFileName
        ? checkerWithProgram.getProgram?.().getSourceFile(
          context.sourceFileName,
        )
        : undefined);
    return sourceFromContext ??
      context.typeNode?.getSourceFile?.() ??
      typeNode.getSourceFile?.();
  }

  /**
   * Whether `name`, as seen from the reference's scope, is declared by the
   * default library — so an authored type alias of the same name is never
   * mistaken for the library's.
   */
  #isLibraryDeclaredName(
    typeNode: ts.TypeReferenceNode,
    name: ts.Identifier,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): boolean {
    const symbol = this.#resolveTypeName(typeNode, name, checker, context);
    return symbol?.declarations?.some((declaration) =>
      isDefaultLibrarySourceFile(declaration.getSourceFile(), context)
    ) ?? false;
  }

  /**
   * Whether `typeNode`, written in a declaration read under type parameter
   * bindings, is read by its syntax: a node whose type is built from the
   * checker's unbound parameters, which only its written parts can pair with
   * their arguments. An object, an array, a tuple, a union, an intersection,
   * `readonly`, or a default-library alias the node-based analyzer applies
   * (`#namesLibraryAlias()`) holding a bound parameter is read part by part,
   * each part in turn by its syntax where it holds one and by its type where
   * it does not. The checker folds a union member that is itself a union into
   * the whole, so read by type, a CFC alias over a union as a member would lose
   * its boundary and its labels; its written reference keeps both. Any other
   * node is read by its type, a bound parameter in it read as its argument
   * wherever the walk reaches it.
   */
  #readsBySyntax(
    typeNode: ts.TypeNode | undefined,
    context: GenerationContext,
  ): boolean {
    const bound = context.boundTypeParameters;
    if (!bound || !typeNode) return false;
    const written = unwrapTypeParentheses(typeNode);
    const structural = ts.isUnionTypeNode(written) ||
      ts.isIntersectionTypeNode(written) || ts.isTypeLiteralNode(written) ||
      ts.isArrayTypeNode(written) || ts.isTupleTypeNode(written) ||
      (ts.isTypeOperatorNode(written) &&
        written.operator === ts.SyntaxKind.ReadonlyKeyword) ||
      this.#namesLibraryAlias(written, context);
    return structural &&
      holdsTypeParameter(written, context.typeChecker, bound.arguments);
  }

  /**
   * Whether `typeNode` is a reference with arguments to one of the default
   * library's aliases in `LIBRARY_ALIAS_NAMES`, which the node-based analyzer
   * applies structurally (`#analyzeLibraryAliasReference()`). A name the
   * module declares for itself is its own alias.
   */
  #namesLibraryAlias(
    typeNode: ts.TypeNode,
    context: GenerationContext,
  ): boolean {
    return ts.isTypeReferenceNode(typeNode) &&
      ts.isIdentifier(typeNode.typeName) &&
      LIBRARY_ALIAS_NAMES.has(typeNode.typeName.text) &&
      (typeNode.typeArguments?.length ?? 0) > 0 &&
      this.#isLibraryDeclaredName(
        typeNode,
        typeNode.typeName,
        context.typeChecker,
        context,
      );
  }

  /**
   * A reference to one of the default library's generic aliases, with its
   * type arguments applied structurally. The general path resolves such a
   * reference by name to the alias's UNINSTANTIATED declared type — a mapped
   * type over an unbound parameter — which reads as an empty object and drops
   * every member the arguments carried, and a cell read prints its type
   * through `Readonly<{…}>`. Each alias is applied the way the
   * type-based path applies it, to an inline object, to the definition a
   * named type's reference points at (on a copy — the shared definition is
   * left as every other consumer reads it), and to each arm of a union of
   * them; a reference the rules cannot express (a computed key set, an
   * unsupported arity) returns `undefined` and takes the general path.
   */
  #analyzeLibraryAliasReference(
    typeNode: ts.TypeReferenceNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): MutableJSONSchema | undefined {
    if (!ts.isIdentifier(typeNode.typeName)) return undefined;
    const name = typeNode.typeName.text;
    if (!LIBRARY_ALIAS_NAMES.has(name)) return undefined;
    const args = typeNode.typeArguments;
    if (args === undefined || args.length === 0) return undefined;
    if (
      !this.#isLibraryDeclaredName(
        typeNode,
        typeNode.typeName,
        checker,
        context,
      )
    ) {
      return undefined;
    }
    const first = args[0]!;
    const second = args[1];
    // Under bindings, each argument is read at its part of the alias's
    // instantiation (`GenerationContext.instantiatedAs`): an array's element,
    // a record's value, and for the aliases that keep an object's property
    // names, the instantiation itself.
    const instantiatedAs = context.instantiatedAs;
    const analyze = (node: ts.TypeNode, at: ts.Type | undefined = undefined) =>
      this.#analyzeChildNode(node, checker, context, at);
    switch (name) {
      case "Readonly":
        return analyze(first, instantiatedAs);
      case "Array":
      case "ReadonlyArray":
        return {
          type: "array",
          items: analyze(
            first,
            instantiatedElementType(instantiatedAs, checker),
          ),
        };
      case "NonNullable":
        return withoutNullish(analyze(first, instantiatedAs), context);
      case "Partial":
        // An array's elements count as optional, so each admits `undefined`;
        // a tuple's do the same, every element made optional.
        return mapArms(analyze(first, instantiatedAs), context, partialArm);
      case "Required":
        return this.#requiredView(first, checker, context, new Set());
      case "Pick":
      case "Omit": {
        if (second === undefined) return undefined;
        const keys = literalKeys(second);
        if (keys === undefined) return undefined;
        // The picked members are those of whichever arm the labeled value
        // is, so it keeps the labels of every arm, joined.
        const operand = analyze(first, instantiatedAs);
        const labels = armLabels(operand, context);
        const { ifc, ...payload } = isObjectOrArray(operand) &&
            !Array.isArray(operand)
          ? operand as Record<string, unknown>
          : { ifc: undefined };
        const picked = pickedView(
          ifc === undefined ? operand : payload as MutableJSONSchema,
          context,
          name === "Pick" ? { pick: keys } : { omit: keys },
        );
        return picked && labels ? withIfcLabels(picked, labels) : picked;
      }
      case "Record": {
        if (second === undefined) return undefined;
        const value = analyze(
          second,
          instantiatedValueType(instantiatedAs, checker),
        );
        if (
          first.kind === ts.SyntaxKind.StringKeyword ||
          first.kind === ts.SyntaxKind.NumberKeyword
        ) {
          return {
            type: "object",
            properties: {},
            additionalProperties: value,
          };
        }
        const keys = literalKeys(first);
        if (keys === undefined) return undefined;
        return {
          type: "object",
          properties: Object.fromEntries([...keys].map((key) => [key, value])),
          required: [...keys],
        };
      }
    }
    return undefined;
  }

  /**
   * The declared type a reference's name denotes as seen from the reference's
   * scope, which holds what the module declares, exported or not, and what it
   * imports. Returns `undefined` for a qualified name, for a name that
   * resolves to nothing the checker can type, and for a generic declared
   * outside the default library, unless `CommonFabricFormatter` lowers the
   * reference from its own arguments.
   */
  #resolveTypeReferenceFromScope(
    typeNode: ts.TypeReferenceNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): ts.Type | undefined {
    if (!ts.isIdentifier(typeNode.typeName)) {
      return undefined;
    }
    const symbol = this.#resolveTypeName(
      typeNode,
      typeNode.typeName,
      checker,
      context,
    );
    if (!symbol) return undefined;

    // A generic declaration's declared type leaves its parameters unbound, and
    // no reading of an unbound parameter stands in for the argument a
    // reference supplies: its constraint drops the members an argument adds,
    // its default is free to contradict one, and an operator over it (`keyof
    // T`, `T["name"]`) has no schema at all. Such a reference is left unread,
    // for the caller to treat as the guess it would be, unless
    // `CommonFabricFormatter` lowers the reference from its own arguments.
    if (
      declaresTypeParameters(symbol) &&
      !symbol.declarations?.some((declaration) =>
        isDefaultLibrarySourceFile(declaration.getSourceFile(), context)
      ) &&
      !lowersFromReferenceArguments(typeNode, symbol, checker)
    ) {
      return undefined;
    }

    // A declared type that is the checker's intrinsic `any` was declared as
    // `any`; any other type flagged `Any` stands for a name it could not type.
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    return !(declared.flags & ts.TypeFlags.Any) ||
        declared === checker.getAnyType()
      ? declared
      : undefined;
  }

  /**
   * Build final schema for synthetic TypeNode with $schema and $defs
   */
  #buildFinalSchemaForSynthetic(
    schema: MutableJSONSchema,
    context: GenerationContext,
  ): MutableJSONSchema {
    const { definitions, emittedRefs } = context;

    // Handle boolean schemas (rare, but supported by JSON Schema)
    if (typeof schema === "boolean") {
      return schema;
    }

    // If no definitions were created or used, return simple schema
    if (Object.keys(definitions).length === 0 || emittedRefs.size === 0) {
      return schema;
    }

    // Object schema: attach only the definitions actually referenced
    const filtered = this.#collectReferencedDefinitions(schema, definitions);
    const out: Record<string, unknown> = {
      ...(schema as Record<string, unknown>),
    };
    if (Object.keys(filtered).length > 0) out.$defs = filtered;
    return out as MutableJSONSchema;
  }
}
