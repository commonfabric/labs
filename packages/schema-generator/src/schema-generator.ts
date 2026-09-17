import ts from "typescript";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import type {
  GenerationContext,
  SchemaGenerationOptions,
  SchemaHints,
  TypeFormatter,
} from "./interface.ts";
import { attachUiContract, getUiContractHint } from "./ui-contract.ts";
import { PrimitiveFormatter } from "./formatters/primitive-formatter.ts";
import { ObjectFormatter } from "./formatters/object-formatter.ts";
import { ArrayFormatter } from "./formatters/array-formatter.ts";
import { CommonFabricFormatter } from "./formatters/common-fabric-formatter.ts";
import {
  isDefaultLibrarySourceFile,
  NativeTypeFormatter,
} from "./formatters/native-type-formatter.ts";
import { UnionFormatter } from "./formatters/union-formatter.ts";
import { IntersectionFormatter } from "./formatters/intersection-formatter.ts";
import {
  detectWrapperViaNode,
  getNamedTypeKey,
  getPropertyNameText,
  isDefaultTypeRef,
  safeGetIndexTypeOfType,
  safeGetNodeText,
  safeGetTypeOfSymbolAtLocation,
} from "./type-utils.ts";
import { attachDocTags, extractDocFromType } from "./doc-utils.ts";
import { dedupeByValueEqual } from "./value-equality.ts";
import { assertScopeDeclarationsAreReachable } from "./scope-placement.ts";

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
 * `node` with parentheses and `readonly` operators stripped from the outside;
 * neither changes what a type denotes to these rules.
 */
function unwrapTypeNode(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (
    ts.isParenthesizedTypeNode(current) ||
    (ts.isTypeOperatorNode(current) &&
      current.operator === ts.SyntaxKind.ReadonlyKeyword)
  ) {
    current = current.type;
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
 * a `const` or an `enum` makes them finite.
 */
type PrimitiveDomain = { types: string[]; values: unknown[] | undefined };

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
): PrimitiveDomain | undefined {
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
  return primitivesOnly ? { types, values } : undefined;
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
  const exact = parts.find((_part, index) =>
    same(domains[index]!.types, types) && same(domains[index]!.values, values)
  );
  if (exact !== undefined) return exact;
  if (values !== undefined) return { enum: values } as MutableJSONSchema;
  type SchemaType = NonNullable<MutableJSONSchemaObj["type"]>;
  return { type: (types.length === 1 ? types[0]! : types) as SchemaType };
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
 * The schema of an intersection whose constituents have these schemas, none
 * of them a union, reduced the way the checker reduces the types before
 * `IntersectionFormatter` merges them. Nothing comes first: a constituent
 * accepting nothing (`never`) leaves nothing, and so do constituents that
 * reduce to nothing between themselves — `string & number`, `null` beside
 * an object — whatever else is there. Only then does one accepting anything
 * (`any`) make the whole accept anything. The rest reduce in this order:
 * `unknown` is the identity and drops out; an empty object drops out beside anything
 * else and takes `null` and `undefined` with it, `T & {}` being
 * `NonNullable<T>`; primitives are narrowed or found disjoint
 * (`intersectPrimitives`); and `null` or `undefined` beside an object leaves
 * nothing. What remains is one schema, returned as it is, or object schemas
 * whose properties are unioned (the first definition kept on a clash) and
 * whose `required` lists are unioned. A constituent that merge refuses — a
 * non-object, or one with an index signature, which an array is — yields
 * the same unsupported-pattern fallback the type-based path emits.
 */
function mergeIntersection(
  parts: MutableJSONSchema[],
  context: GenerationContext,
): MutableJSONSchema {
  if (parts.some((part) => part === false)) return false;
  const definite = parts.filter((part) => part !== true);
  if (definite.length === parts.length) return mergeDefinite(parts, context);
  // `any` wins only over what is still possible without it.
  return definite.length > 0 && mergeDefinite(definite, context) === false
    ? false
    : true;
}

/**
 * `mergeIntersection` for constituents that are neither `never` nor `any`:
 * every step of its reduction after those two.
 */
function mergeDefinite(
  parts: MutableJSONSchema[],
  context: GenerationContext,
): MutableJSONSchema {
  const isUnknown = (part: MutableJSONSchema) =>
    isObjectOrArray(part) && part.type === "unknown";
  const substantive = dedupeByValueEqual(
    parts.filter((part) => !isUnknown(part)),
  );
  if (substantive.length === 0) return { type: "unknown" };
  const nonEmpty = substantive.filter((part) => !isEmptyObjectSchema(part));
  const remaining = nonEmpty.length > 0 && nonEmpty.length < substantive.length
    ? dedupeByValueEqual(nonEmpty.map((part) => withoutNullish(part, context)))
    : substantive;
  if (remaining.some((part) => part === false)) return false;
  if (remaining.length === 1) return remaining[0]!;
  // No boolean is left: `false` and `true` were answered above.
  const domains = (remaining as MutableJSONSchemaObj[]).map(primitiveDomain);
  if (domains.every((domain) => domain !== undefined)) {
    return intersectPrimitives(remaining, domains as PrimitiveDomain[]);
  }
  const nullishOnly = (domain: PrimitiveDomain | undefined) =>
    domain !== undefined &&
    domain.types.every((type) => type === "null" || type === "undefined");
  if (domains.some(nullishOnly)) return false;
  const unsupported = (reason: string): MutableJSONSchema => ({
    type: "object",
    additionalProperties: true,
    $comment: `Unsupported intersection pattern: ${reason}`,
  });
  const properties: Record<string, MutableJSONSchema> = {};
  const required = new Set<string>();
  for (const part of remaining) {
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
 * and a lone survivor stands alone.
 */
function unionOfSchemas(schemas: MutableJSONSchema[]): MutableJSONSchema {
  const flat = schemas.flatMap((schema) =>
    isObjectOrArray(schema) && Array.isArray(schema.anyOf) &&
      Object.keys(schema).length === 1
      ? schema.anyOf as MutableJSONSchema[]
      : [schema]
  );
  if (flat.some((schema) => schema === true)) return true;
  const unique = dedupeByValueEqual(
    flat.filter((schema) => schema !== false),
  );
  if (unique.length === 0) return false;
  if (unique.length === 1) return unique[0]!;
  return { anyOf: unique as MutableJSONSchemaObj[] };
}

/**
 * Main schema generator that uses a chain of formatters
 */
export class SchemaGenerator {
  #formatters: TypeFormatter[] = [
    new CommonFabricFormatter(this),
    new NativeTypeFormatter(),
    new UnionFormatter(this),
    new IntersectionFormatter(this),
    // Prefer array detection before primitives to avoid Any-flag misrouting
    new ArrayFormatter(this),
    new PrimitiveFormatter(),
    new ObjectFormatter(this),
  ];

  /** Synthetic names for anonymous recursive types */
  #anonymousNames: WeakMap<ts.Type, string> = new WeakMap();

  /** Counter to generate stable synthetic identifiers */
  #anonymousNameCounter: number = 0;

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
  ): MutableJSONSchema {
    // Create unified context with all state
    const cycles = this.#getCycles(type, checker);
    const context: GenerationContext = {
      // Immutable context
      typeChecker: checker,
      cyclicTypes: cycles.types,
      cyclicNames: cycles.names,

      // Accumulating state
      definitions: {},
      emittedRefs: new Set(),

      // Stack state
      definitionStack: new Set(),
      inProgressNames: new Set(),

      // Optional context
      ...(typeNode && { typeNode }),
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
   * AUTO-DETECTS whether to use type-based or node-based analysis.
   */
  public formatChildType(
    type: ts.Type,
    context: GenerationContext,
    typeNode?: ts.TypeNode,
  ): MutableJSONSchema {
    // IMPORTANT: Always create a new context, replacing typeNode (even if undefined).
    // If we pass the parent context as-is when typeNode is undefined, the child will
    // inherit the parent's typeNode which leads to mismatched type/node pairs.
    const { typeNode: _, ...baseContext } = context;
    const childContext = typeNode ? { ...context, typeNode } : baseContext;

    // Auto-detect: Should we use node-based or type-based analysis?
    const useNodeBased = this.#shouldUseNodeBasedAnalysis(
      type,
      typeNode,
      context.typeChecker,
    );
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
      this.#formatType(type, childContext, false),
      childContext,
    );
  }

  /**
   * Create a stack key that distinguishes erased wrapper types from their
   * inner types
   */
  #createStackKey(
    type: ts.Type,
    typeNode?: ts.TypeNode,
    checker?: ts.TypeChecker,
  ): string | ts.Type {
    if (typeNode && ts.isTypeReferenceNode(typeNode)) {
      // Handle Default types (both direct and aliased) with enhanced keys to
      // avoid false cycles
      const isDirectDefault = ts.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === "Default";
      const isAliasedDefault = checker && isDefaultTypeRef(typeNode, checker);

      if (isDirectDefault || isAliasedDefault) {
        // Create a more specific key that includes type argument info to
        // avoid false cycles
        const argTexts = typeNode.typeArguments
          ? typeNode.typeArguments.map((arg) => safeGetNodeText(arg)).join(",")
          : "";
        // Include a source location hash to further distinguish instances
        const locationHash = typeNode.getSourceFile?.()?.fileName || "";
        const position = typeNode.pos || 0;
        return `Default_${type.flags}_${argTexts}_${locationHash}_${position}`;
      }

      // Cell-like wrappers (Cell, Writable, Stream, OpaqueCell) share their
      // ts.Type identity with the same wrapper instantiation at other positions.
      // When a recursive type like TodoItem contains `Writable<TodoItem[]>`,
      // TypeScript reuses the same Cell<TodoItem[]> type object, causing the
      // cycle to be detected in wrapper context where it can't be properly
      // stored. Give each wrapper occurrence a unique stack key so the cycle
      // is instead detected at the inner type level where it can be handled.
      if (checker) {
        const wrapperKind = detectWrapperViaNode(typeNode, checker);
        if (wrapperKind) {
          const argTexts = typeNode.typeArguments
            ? typeNode.typeArguments.map((arg) => safeGetNodeText(arg))
              .join(",")
            : "";
          const locationHash = typeNode.getSourceFile?.()?.fileName || "";
          const position = typeNode.pos || 0;
          return `${wrapperKind}_${type.flags}_${argTexts}_${locationHash}_${position}`;
        }
      }
    }
    return type;
  }

  #ensureSyntheticName(
    type: ts.Type,
  ): string {
    const existing = this.#anonymousNames.get(type);
    if (existing) return existing;
    const synthetic = `AnonymousType_${++this.#anonymousNameCounter}`;
    this.#anonymousNames.set(type, synthetic);
    return synthetic;
  }

  /**
   * Format a type using the appropriate formatter
   */
  #formatType(
    type: ts.Type,
    context: GenerationContext,
    isRootType: boolean = false,
  ): MutableJSONSchema {
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
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
    if ((type.flags & ts.TypeFlags.Conditional) !== 0) {
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

    let namedKey = getNamedTypeKey(type, context.typeNode);

    if (!namedKey && !isWrapperContext) {
      // Only use synthetic names if we're not processing a wrapper type
      const synthetic = this.#anonymousNames.get(type);
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

    // Cycle detection: if we see the same type again by identity, emit a $ref
    const stackKey = this.#createStackKey(
      type,
      context.typeNode,
      context.typeChecker,
    );
    if (context.definitionStack.has(stackKey)) {
      if (namedKey) {
        context.emittedRefs.add(namedKey);
        return { "$ref": `#/$defs/${namedKey}` };
      }
      const syntheticKey = this.#ensureSyntheticName(type);
      context.inProgressNames.add(syntheticKey);
      context.emittedRefs.add(syntheticKey);
      return { "$ref": `#/$defs/${syntheticKey}` };
    }

    // Push current type onto the stack
    context.definitionStack.add(
      this.#createStackKey(type, context.typeNode, context.typeChecker),
    );

    // Try to find a formatter that supports this type
    for (const formatter of this.#formatters) {
      if (formatter.supportsType(type, context)) {
        const result = formatter.formatType(type, context);

        // If this is a named type (all-named policy), store in definitions.
        // We already computed namedKey above with wrapper checks, so reuse it.
        // Only look up synthetic names if namedKey wasn't already set and we're
        // not in a wrapper context (to avoid storing wrapper results).
        const keyForDef = namedKey ??
          (isWrapperContext ? undefined : this.#anonymousNames.get(type));
        if (keyForDef) {
          context.definitions[keyForDef] = result;
          context.inProgressNames.delete(keyForDef);
          context.definitionStack.delete(
            this.#createStackKey(type, context.typeNode, context.typeChecker),
          );
          if (!isRootType) {
            context.emittedRefs.add(keyForDef);
            return { "$ref": `#/$defs/${keyForDef}` };
          }
          // For root, keep inline; buildFinalSchema may promote if we choose
        }
        // Pop after formatting
        context.definitionStack.delete(
          this.#createStackKey(type, context.typeNode, context.typeChecker),
        );
        return result;
      }
    }

    // If no formatter supports this type, this is an error - we should have
    // complete coverage
    context.definitionStack.delete(
      this.#createStackKey(type, context.typeNode, context.typeChecker),
    );

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
    const hint = getUiContractHint(context);
    return hint ? attachUiContract(schema, hint) : schema;
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
            continue;
          }

          // Get the property type - check typeRegistry first, then resolve from node
          let propType: ts.Type;
          if (typeRegistry && typeRegistry.has(member.type)) {
            propType = typeRegistry.get(member.type)!;
          } else {
            propType = checker.getTypeFromTypeNode(member.type);
          }

          // Use formatChildType - it will auto-detect whether to use type-based
          // or node-based analysis depending on whether propType is reliable
          const propSchema = this.formatChildType(
            propType,
            context,
            member.type,
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
      return this.#analyzeTypeNodeStructure(typeNode.type, checker, context);
    }

    // A tuple lowers the way the type-based path lowers one: an array whose
    // items accept any of the elements, structure and arity dropped
    // (tuple-emission.test.ts pins that choice). A rest element contributes
    // its array's items; an optional one admits `undefined` as well. Without
    // this branch a tuple fell through to the
    // accept-anything fallback, so a tuple of `unknown` — reference-only
    // slots — read as a request for everything.
    if (ts.isTupleTypeNode(typeNode)) {
      return {
        type: "array",
        items: tupleItems(
          this.#slotsOfTupleNode(typeNode, checker, context, new Set()),
        ),
      };
    }

    // An intersection merges the way IntersectionFormatter merges one
    // (`mergeIntersection`), each constituent read through its reference.
    // A union constituent distributes, as the checker distributes it
    // before the type-based path ever sees the intersection: every
    // combination of arms is merged on its own.
    if (ts.isIntersectionTypeNode(typeNode)) {
      const combinations = typeNode.types
        .map((member) =>
          unionArms(this.#analyzeChildNode(member, checker, context), context)
        )
        .reduce<MutableJSONSchema[][]>(
          (prefixes, arms) =>
            prefixes.flatMap((prefix) => arms.map((arm) => [...prefix, arm])),
          [[]],
        );
      return unionOfSchemas(
        combinations.map((parts) => mergeIntersection(parts, context)),
      );
    }

    // Handle ArrayTypeNode (e.g., number[], string[])
    if (ts.isArrayTypeNode(typeNode)) {
      const elementType = typeRegistry?.get(typeNode.elementType) ??
        checker.getTypeFromTypeNode(typeNode.elementType);
      const items = this.formatChildType(
        elementType,
        context,
        typeNode.elementType,
      );
      return { type: "array", items };
    }

    // Handle unions in synthetic nodes. Keep all members including undefined
    // to match the type-based UnionFormatter which emits { type: "undefined" }
    // explicitly. Keyword types (string, number, boolean, undefined, null) are
    // resolved directly by the switch below, so they never cause widening.
    if (ts.isUnionTypeNode(typeNode)) {
      const memberSchemas = typeNode.types.map((member) =>
        this.#analyzeTypeNodeStructure(member, checker, context)
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
        return this.formatChildType(wrapperType, context, typeNode);
      }

      const applied = this.#analyzeLibraryAliasReference(
        typeNode,
        checker,
        context,
      );
      if (applied !== undefined) return applied;

      const resolved = this.#resolveTypeReferenceFromScope(
        typeNode,
        checker,
        context,
      );
      if (resolved) {
        return this.formatChildType(resolved, context, typeNode);
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
        // matches anything, but we will not access the cell
        return { asCell: ["opaque"] };
      case ts.SyntaxKind.AnyKeyword:
        // Accept any value
        return true;
    }

    // For other TypeNode kinds, try to resolve as Type
    const type = checker.getTypeFromTypeNode(typeNode);
    if (!(type.flags & ts.TypeFlags.Any)) {
      // Successfully resolved - use formatChildType to share context
      return this.formatChildType(type, context, typeNode);
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
  ): MutableJSONSchema {
    const type = context.typeRegistry?.get(node) ??
      checker.getTypeFromTypeNode(node);
    return this.formatChildType(type, context, node);
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
   * the checker normalizes a tuple.
   */
  #slotsOfTupleNode(
    tuple: ts.TupleTypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
    opened: OpenedAliases,
  ): TupleSlot[][] {
    let alternatives: TupleSlot[][] = [[]];
    for (const element of tuple.elements) {
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
          schema: this.#analyzeChildNode(inner, checker, context),
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
   * (`getSymbolsInScope` lists every visible symbol, globals included, in no
   * order that honors shadowing.)
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
      isDefaultLibrarySourceFile(declaration.getSourceFile(), checker)
    ) ?? false;
  }

  /**
   * A reference to one of the default library's generic aliases, with its
   * type arguments applied structurally. The general path resolves such a
   * reference by name to the alias's UNINSTANTIATED declared type — a mapped
   * type over an unbound parameter — which reads as an empty object and drops
   * every member the arguments carried. A cell read prints its type through
   * `Readonly<{…}>`, so that was the fate of every pattern-scope read of an
   * object type this analyzer was handed. Each alias is applied the way the
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
    const analyze = (node: ts.TypeNode) =>
      this.#analyzeChildNode(node, checker, context);
    switch (name) {
      case "Readonly":
        return analyze(first);
      case "Array":
      case "ReadonlyArray":
        return { type: "array", items: analyze(first) };
      case "NonNullable":
        return withoutNullish(analyze(first), context);
      case "Partial":
        // An array's elements count as optional, so each admits `undefined`;
        // a tuple's do the same, every element made optional.
        return mapArms(analyze(first), context, partialArm);
      case "Required":
        return this.#requiredView(first, checker, context, new Set());
      case "Pick":
      case "Omit": {
        if (second === undefined) return undefined;
        const keys = literalKeys(second);
        if (keys === undefined) return undefined;
        return pickedView(
          analyze(first),
          context,
          name === "Pick" ? { pick: keys } : { omit: keys },
        );
      }
      case "Record": {
        if (second === undefined) return undefined;
        const value = analyze(second);
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

  #resolveTypeReferenceFromScope(
    typeNode: ts.TypeReferenceNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): ts.Type | undefined {
    if (!ts.isIdentifier(typeNode.typeName)) {
      return undefined;
    }
    const typeName = typeNode.typeName.text;
    const symbolAtNode = checker.getSymbolAtLocation(typeNode.typeName);
    if (symbolAtNode) {
      const declared = checker.getDeclaredTypeOfSymbol(symbolAtNode);
      if (declared && !(declared.flags & ts.TypeFlags.Any)) {
        return declared;
      }
    }

    const scopeNode = this.#scopeSourceFile(typeNode, checker, context);
    if (!scopeNode) return undefined;

    const candidates = checker.getSymbolsInScope(
      scopeNode,
      ts.SymbolFlags.Type,
    );
    const symbol = candidates.find((candidate) => candidate.name === typeName);
    if (!symbol) return undefined;
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    if (!declared || (declared.flags & ts.TypeFlags.Any)) {
      return undefined;
    }
    return declared;
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
