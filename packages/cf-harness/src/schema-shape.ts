/**
 * Reduction of a JSON Schema to the part of it that is STRUCTURE: property
 * names, types, recognized scopes, nesting, required-ness, and composition. The
 * result is what `describe_handle` may disclose about a referent whose schema
 * the harness did not write.
 *
 * The rule is deny-by-default. A reduced schema is REBUILT from an allowlist
 * of structural keywords rather than copied with a few keywords deleted, so a
 * keyword nobody thought about is absent rather than disclosed, and so is
 * every keyword nested inside `properties`, `items`, `$defs`, or a
 * combinator. That matters because a schema is a place a value can hide:
 * `const`, `enum`, `default`, and `examples` carry values outright, and
 * `title`, `description`, `$comment`, and `pattern` carry free text that
 * whoever authored the schema chose. A shape tells a model what code to
 * write; none of the rest is needed to write it.
 *
 * Identifiers get the same treatment wherever they are not needed. A property
 * name crosses, because nothing can be written over data without it. A
 * definition name does not: it names a place in the schema rather than a place
 * in the data, so every `$defs` and `definitions` key is replaced by an opaque
 * `d0`, `d1`, … and every `$ref` that resolves to one is rewritten to match. A
 * `$ref` that resolves to nothing is dropped rather than disclosed, since a
 * dangling pointer is a string its author chose and nothing else.
 *
 * Because property names are the one channel that crosses, they are the one
 * channel that has to be bounded. A name past
 * {@link MAX_PROPERTY_NAME_LENGTH}, and every property past
 * {@link MAX_DISCLOSED_PROPERTIES} of one object, is omitted, and an object
 * that omitted any of its properties reports `additionalProperties: true` so
 * the shortened list is never read as the whole of them.
 */

import type { JSONSchema, JSONSchemaTypes } from "@commonfabric/api";
import { FABRIC_PRIMITIVE_SCHEMA_TYPES } from "@commonfabric/data-model/fabric-primitives";
import { isSchemaScope } from "@commonfabric/runner/scope";
import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * The `type` vocabulary passed through. A closed set, so a `type` cannot be
 * repurposed as a free-text field: an unrecognized one is dropped along with
 * everything else outside the allowlist.
 */
const DISCLOSABLE_TYPES: ReadonlySet<string> = new Set<string>([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
  "null",
  "undefined",
  "unknown",
  ...FABRIC_PRIMITIVE_SCHEMA_TYPES,
]);

/**
 * The `format` vocabulary passed through — the formats the runner's own
 * validator recognizes. Closed for the same reason `type` is: a format is a
 * refinement of a type, and an unrecognized one is free text.
 */
const DISCLOSABLE_FORMATS: ReadonlySet<string> = new Set([
  "email",
  "uri",
  "date",
  "date-time",
]);

/**
 * A local `$ref` pointer, matched against the fragment once it has been
 * percent-decoded: the whole document, or one entry of the root's `$defs` or
 * `definitions`. Any other reference — a URI, a pointer into something this
 * schema does not carry — is dropped rather than reported. Capture 1 is the
 * keyword the pointer goes through, capture 2 the entry it names; both are
 * absent for a pointer at the root itself.
 */
const LOCAL_REF_PATTERN = /^(?:\/(\$defs|definitions)\/([^/]+))?$/;

/**
 * The JSON Pointer that `ref`'s fragment denotes, or `undefined` when `ref` is
 * not a fragment-only reference or does not percent-decode. A `$ref` is a URI,
 * so its fragment is percent-encoded, and decoding it is what turns the URI
 * into the pointer — which is why it happens before the pointer is split on
 * `/`, and why a `%2F` is a separator rather than part of a name.
 */
const refPointer = (ref: string): string | undefined => {
  if (!ref.startsWith("#")) {
    return undefined;
  }
  try {
    return decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
};

/**
 * The name a JSON Pointer reference token denotes, or `undefined` when the
 * token is not a well-formed one. `~1` becomes `/` before `~0` becomes `~`,
 * per RFC 6901: taking them in the other order would decode the token `a~01b`
 * to `a/b` rather than to the name `a~1b` it actually denotes. A `~` that
 * begins neither escape is not a token at all, and fails closed.
 */
const referenceTokenName = (token: string): string | undefined =>
  /~(?![01])/.test(token)
    ? undefined
    : token.replaceAll("~1", "/").replaceAll("~0", "~");

const isSchemaRecord = (
  schema: JSONSchema,
): schema is Exclude<JSONSchema, boolean> => isObjectNotArray(schema);

/** Structural keywords whose value is a single subschema. */
const SUBSCHEMA_KEYS = [
  "items",
  "contains",
  "additionalProperties",
  "not",
] as const;

/** Structural keywords whose value is an array of subschemas. */
const SUBSCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

/**
 * Structural keywords whose value maps a DATA name to a subschema. The names
 * are the point of the disclosure, so they are copied as they stand.
 */
const PROPERTY_MAP_KEYS = ["properties"] as const;

/**
 * Structural keywords whose value maps a SCHEMA name to a subschema. The names
 * are the schema author's own, and nothing needs them, so each is replaced by
 * its ordinal within the map.
 */
const DEFINITION_MAP_KEYS = ["$defs", "definitions"] as const;

type DefinitionMapKey = (typeof DEFINITION_MAP_KEYS)[number];

/**
 * The opaque name disclosed for the `index`-th entry of a definition map.
 * Ordinal rather than derived from the authored name, so no part of that name
 * survives the substitution.
 */
const canonicalDefinitionName = (index: number): string => `d${index}`;

/**
 * The name substitutions for the root's definition maps, keyed by the keyword
 * each map hangs off. Only the root's maps are here because only they can be
 * the target of a `$ref`; a definition nested deeper is renamed too, but no
 * pointer can reach it.
 */
type DefinitionNames = Readonly<
  Record<DefinitionMapKey, ReadonlyMap<string, string>>
>;

const rootDefinitionNames = (schema: JSONSchema): DefinitionNames => {
  const names = {
    $defs: new Map<string, string>(),
    definitions: new Map<string, string>(),
  };
  if (isSchemaRecord(schema)) {
    const source = schema as Record<string, unknown>;
    for (const key of DEFINITION_MAP_KEYS) {
      const map = source[key];
      if (!isSchemaRecord(map as JSONSchema)) {
        continue;
      }
      // Only the entries the walk will actually emit get a name, so a `$ref`
      // into one past the bound resolves to nothing and is dropped rather than
      // left dangling. The slice and the walk take the map in the same order,
      // so the two agree on which entries those are.
      Object.keys(map as Record<string, unknown>)
        .slice(0, MAX_DISCLOSED_PROPERTIES)
        .forEach((name, index) => {
          names[key].set(name, canonicalDefinitionName(index));
        });
    }
  }
  return names;
};

/**
 * The disclosable form of `ref`, or `undefined` when there is none: the
 * reference is not local, or it names a definition the root does not declare.
 * An unresolved reference fails closed, because disclosing it would put the
 * pointer's authored text into the output through the one keyword whose value
 * is a name.
 *
 * The reference is decoded down to the definition name it denotes before that
 * name is looked up, so a definition legitimately named with a `/`, a `~`, or a
 * character its author percent-encoded resolves like any other and keeps its
 * `$ref`. What comes back out needs no encoding of either kind: the canonical
 * names are `d0`, `d1`, … and the keyword is `$defs` or `definitions`, so the
 * emitted reference is the same text under either decoding.
 */
const reduceRef = (
  ref: unknown,
  names: DefinitionNames,
): string | undefined => {
  if (typeof ref !== "string") {
    return undefined;
  }
  const pointer = refPointer(ref);
  if (pointer === undefined) {
    return undefined;
  }
  const match = LOCAL_REF_PATTERN.exec(pointer);
  if (match === null) {
    return undefined;
  }
  const [, keyword, token] = match;
  if (keyword === undefined || token === undefined) {
    return "#";
  }
  const name = referenceTokenName(token);
  if (name === undefined) {
    return undefined;
  }
  const canonical = names[keyword as DefinitionMapKey].get(name);
  return canonical === undefined ? undefined : `#/${keyword}/${canonical}`;
};

const reduceType = (
  type: unknown,
): JSONSchemaTypes | JSONSchemaTypes[] | undefined => {
  if (typeof type === "string" && DISCLOSABLE_TYPES.has(type)) {
    return type as JSONSchemaTypes;
  }
  if (Array.isArray(type)) {
    const kept = type.filter(
      (entry): entry is JSONSchemaTypes =>
        typeof entry === "string" && DISCLOSABLE_TYPES.has(entry),
    );
    return kept.length > 0 ? kept : undefined;
  }
  return undefined;
};

/**
 * How deep the walk goes before it stops describing. Past this, a subschema
 * reduces to `{}` — the same answer a cycle gets — so a schema nested beyond
 * any depth a person writes still yields a valid reduced shape instead of
 * exhausting the stack. The bound is far above the nesting a generated schema
 * reaches and far below what the walk's own recursion costs.
 */
const MAX_SHAPE_DEPTH = 100;

/**
 * How many entries of one `properties`, `$defs`, or `definitions` map are
 * disclosed. Past this the remainder is omitted, and an object that omitted
 * any of its properties reports `additionalProperties: true` — the schema
 * vocabulary's own way of saying there are further properties here this shape
 * does not name. A reader of a truncated shape therefore sees the names it can
 * write code against and an explicit statement that the list is not the whole
 * of them; it never sees a short list presented as complete.
 *
 * 200 is far above what an authored schema declares on a single object — a
 * pattern's result schema and a document's schema run to a handful of fields,
 * a generated one to a few dozen — and far below a count at which one object's
 * property names could crowd out a model's context. This is a
 * denial-of-context guard, not a security boundary: property names are
 * disclosed on purpose, and the bound only stops an unbounded number of them
 * from being disclosed at once. It bounds one map, not the whole shape;
 * nesting still multiplies, to the {@link MAX_SHAPE_DEPTH} levels of it the
 * walk describes.
 */
export const MAX_DISCLOSED_PROPERTIES = 200;

/**
 * How long a single disclosed property name may be, in UTF-16 code units. A
 * longer name is OMITTED rather than truncated, and its omission is reported
 * the way any other omission is, through `additionalProperties: true`. A
 * truncated name is the name of nothing: an agent writing code against it
 * would read a field that does not exist, which is worse than an agent that
 * can see a field is there and unnamed.
 *
 * 128 code units is an order of magnitude beyond the longest field name
 * anything here declares, and short enough that a name cannot be repurposed as
 * the prose channel a shape-only disclosure exists to close.
 */
export const MAX_PROPERTY_NAME_LENGTH = 128;

/**
 * Reduces `schema` to structure, dropping every keyword outside the
 * allowlist at every depth. A boolean schema is structure already and passes
 * through; anything that is not a schema at all reduces to `{}`, the shape
 * that says nothing.
 *
 * The walk terminates on every input. Recursion is guarded by the set of
 * schema objects on the CURRENT path, so a schema that contains itself reduces
 * to `{}` at the point it closes the loop, while a subschema shared between two
 * siblings is reduced once for each; and by {@link MAX_SHAPE_DEPTH}, so a
 * schema nested past that reduces to `{}` there rather than throwing. Neither
 * guard can fail the call: whatever comes in, a valid reduced shape comes out.
 */
export const schemaShapeOnly = (schema: JSONSchema): JSONSchema =>
  reduceSchema(schema, new Set<object>(), rootDefinitionNames(schema), 0);

const reduceSchema = (
  schema: JSONSchema,
  active: Set<object>,
  names: DefinitionNames,
  depth: number,
): JSONSchema => {
  if (depth > MAX_SHAPE_DEPTH) {
    return {};
  }
  if (typeof schema === "boolean") {
    return schema;
  }
  if (!isSchemaRecord(schema)) {
    return {};
  }
  if (active.has(schema)) {
    return {};
  }
  active.add(schema);
  try {
    const source = schema as Record<string, unknown>;
    const shape: Record<string, unknown> = {};

    const type = reduceType(source.type);
    if (type !== undefined) {
      shape.type = type;
    }

    const ref = reduceRef(source.$ref, names);
    if (ref !== undefined) {
      shape.$ref = ref;
    }

    const format = source.format;
    if (typeof format === "string" && DISCLOSABLE_FORMATS.has(format)) {
      shape.format = format;
    }

    if (isSchemaScope(source.scope)) {
      shape.scope = source.scope;
    }

    for (const key of SUBSCHEMA_KEYS) {
      const child = source[key];
      if (child !== undefined) {
        shape[key] = reduceSchema(
          child as JSONSchema,
          active,
          names,
          depth + 1,
        );
      }
    }

    for (const key of SUBSCHEMA_LIST_KEYS) {
      const children = source[key];
      if (Array.isArray(children)) {
        shape[key] = children.map((child) =>
          reduceSchema(child as JSONSchema, active, names, depth + 1)
        );
      }
    }

    for (const key of PROPERTY_MAP_KEYS) {
      const children = source[key];
      if (isSchemaRecord(children as JSONSchema)) {
        const reduced: Record<string, JSONSchema> = {};
        let disclosed = 0;
        let omitted = false;
        for (
          const [name, child] of Object.entries(
            children as Record<string, JSONSchema>,
          )
        ) {
          if (
            disclosed >= MAX_DISCLOSED_PROPERTIES ||
            name.length > MAX_PROPERTY_NAME_LENGTH
          ) {
            omitted = true;
            continue;
          }
          Object.defineProperty(reduced, name, {
            value: reduceSchema(child, active, names, depth + 1),
            writable: true,
            enumerable: true,
            configurable: true,
          });
          disclosed += 1;
        }
        shape[key] = reduced;
        if (omitted) {
          // Written after the `additionalProperties` the subschema pass may
          // have put here, and deliberately over it: what the disclosed shape
          // has to say at this point is that it does not name every property,
          // which is true whatever the source schema said about undeclared
          // ones.
          shape.additionalProperties = true;
        }
      }
    }

    for (const key of DEFINITION_MAP_KEYS) {
      const children = source[key];
      if (isSchemaRecord(children as JSONSchema)) {
        const reduced: Record<string, JSONSchema> = {};
        Object.values(children as Record<string, JSONSchema>)
          .slice(0, MAX_DISCLOSED_PROPERTIES)
          .forEach((child, index) => {
            reduced[canonicalDefinitionName(index)] = reduceSchema(
              child,
              active,
              names,
              depth + 1,
            );
          });
        shape[key] = reduced;
      }
    }

    // `required` is disclosed as required-ness of names already disclosed
    // through `properties`. A name required but never declared is not
    // structure — it is a string whoever wrote the schema chose — so it is
    // dropped, and with no `properties` beside it the whole keyword is.
    const declared = shape.properties as Record<string, JSONSchema> | undefined;
    if (Array.isArray(source.required) && declared !== undefined) {
      const kept = source.required.filter(
        (name): name is string =>
          typeof name === "string" &&
          Object.hasOwn(declared, name),
      );
      if (kept.length > 0) {
        shape.required = kept;
      }
    }

    return shape as JSONSchema;
  } finally {
    active.delete(schema);
  }
};
