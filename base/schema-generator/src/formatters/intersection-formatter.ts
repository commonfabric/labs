import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
  SchemaScope,
} from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";
import ts from "typescript";

import { extractDocFromType } from "../doc-utils.ts";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import {
  type AnyValueBesideUnwritten,
  labelsBesideAnyValue,
} from "../ifc-labels.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { withIndexKeys, withOriginOf } from "../schema-origins.ts";
import { dedupeByValueEqual } from "../value-equality.ts";
import {
  cloneSchemaDefinition,
  getArrayElementInfo,
  getNativeTypeSchema,
  safeGetPropertyType,
} from "../type-utils.ts";
import { isCellType } from "../typescript/cell-brand.ts";
import { isScopeBrandMember } from "../typescript/scope-brand.ts";
import { holdsWriterPolicy } from "../typescript/writer-policy.ts";
import {
  isCfcCarrier,
  scopeOfScopeWrapper,
} from "./common-fabric-formatter.ts";
import { classifyCallableProperty } from "./object-formatter.ts";

const logger = getLogger("schema-generator.intersection");
const DOC_CONFLICT_COMMENT =
  "Conflicting docs across intersection constituents; using first";

/**
 * The error for a property that members of an intersection declare in
 * different scopes, `scopes`: one value is stored in one scope.
 */
export function propertyScopesError(
  key: string,
  scopes: readonly string[],
): Error {
  return new Error(
    `The property \`${key}\` is declared in scope \`${scopes[0]}\` by one ` +
      `member of an intersection and in scope \`${scopes[1]}\` by another. ` +
      `A value is stored in one scope, so declare \`${key}\` in the same ` +
      `scope wherever it is declared.`,
  );
}

/**
 * A part of an intersection that declares a property, its schema there, and
 * whether the part requires it.
 */
type PropertyDeclaration = {
  readonly part: ts.Type;
  readonly schema: MutableJSONSchema;
  readonly required: boolean;
};

/**
 * The JSDoc an intersection's constituents carry: the first doc of each that
 * has one, the names of those, and the names of the rest.
 */
type ConstituentDocs = {
  readonly docTexts: string[];
  readonly documentedSources: string[];
  readonly missingSources: string[];
};

/** The keywords a declaration's JSDoc writes into its property's schema. */
const DOC_KEYWORDS = ["description", "deprecated"] as const;

/** The description a schema carries, if any. */
function descriptionOf(schema: MutableJSONSchema): string | undefined {
  return isObjectOrArray(schema) && typeof schema.description === "string"
    ? schema.description
    : undefined;
}

/**
 * `value` with the documentation `documented` carries in place of its own:
 * the description and the deprecation mark, each where `documented` has one.
 */
function documentedAs(
  value: MutableJSONSchemaObj,
  documented: MutableJSONSchemaObj,
): MutableJSONSchemaObj {
  const schema: Record<string, unknown> = { ...value };
  if (typeof documented.description === "string") {
    schema.description = documented.description;
  }
  if (documented.deprecated !== undefined) {
    schema.deprecated = documented.deprecated;
  }
  return schema as MutableJSONSchemaObj;
}

/**
 * `schema` without the keywords its declaration's JSDoc writes, or `schema`
 * itself where it carries none of them.
 */
export function withoutDocumentation(
  schema: MutableJSONSchema,
): MutableJSONSchema {
  if (
    !isObjectOrArray(schema) ||
    !DOC_KEYWORDS.some((keyword) => keyword in schema)
  ) {
    return schema;
  }
  const { description: _, deprecated: __, ...rest } = schema;
  return rest;
}

/**
 * The schema of `key`, a property several constituents of an intersection
 * declare with the schemas `declared`, in constituent order, given `value`,
 * the schema of the property's type in the intersection — the intersection
 * of the declared types — which may be one of `declared`. The first
 * declaration's documentation replaces the value's own where it has any. A
 * later declaration whose description differs from the first's is noted in
 * a `$comment`, unless the value carries one. A copy made to document the
 * value keeps the origin recorded for it (`withOriginOf()`).
 */
export function sharedPropertySchema(
  key: string,
  value: MutableJSONSchema,
  declared: readonly MutableJSONSchema[],
  context: GenerationContext,
): MutableJSONSchema {
  const [first, ...later] = declared;
  const description = descriptionOf(first!);
  const conflicting = description !== undefined &&
    later.some((schema) => {
      const other = descriptionOf(schema);
      return other !== undefined && other !== description;
    });
  if (conflicting) {
    logger.warn(
      "schema-gen",
      () => `Intersection doc conflict for '${key}'; using first`,
    );
  }
  if (!isObjectOrArray(value)) return value;
  // A first declaration accepting anything or nothing makes the value do the
  // same, so a documented value has a first declaration that is an object.
  const documented = value === first || !isObjectOrArray(first)
    ? value
    : documentedAs(value, first);
  return withOriginOf(
    conflicting && typeof documented.$comment !== "string"
      ? { ...documented, $comment: DOC_CONFLICT_COMMENT }
      : documented,
    value,
    context,
  );
}

/**
 * The schema of an intersection the checker gives `any`, of constituents
 * with these schemas: any value, with the labels kept of them
 * (`labelsBesideAnyValue()`), and the scope they are declared in and the
 * default they agree on (`stated`). `any` keeps nothing of a constituent
 * beside it, so a restriction or a scope stated there would otherwise fail
 * open. A definition met before it is written is checked once generation is
 * done (`anyValuesBesideUnwritten`).
 */
export function anyValueSchema(
  constituents: readonly MutableJSONSchema[],
  stated: {
    readonly scope?: SchemaScope | undefined;
    readonly default?: MutableJSONSchemaObj["default"] | undefined;
  },
  context: GenerationContext,
): MutableJSONSchema {
  const { labels } = labelsKeptBesideAnyValue(constituents, "any", context);
  const schema: MutableJSONSchemaObj = {
    ...(labels !== undefined ? { ifc: labels } : {}),
    ...(stated.scope !== undefined ? { scope: stated.scope } : {}),
    ...(stated.default !== undefined ? { default: stated.default } : {}),
  };
  return Object.keys(schema).length > 0 ? schema : true;
}

/**
 * The schema of an intersection of constituents with these schemas that this
 * generator cannot merge, for `reason`: any object, with the labels kept of
 * the constituents as for an intersection the checker gives `any`
 * (`labelsBesideAnyValue()`). The object may hold a constituent's data
 * anywhere, so a restriction written anywhere in one, as on a member, would
 * otherwise fail open there.
 */
export function unsupportedIntersectionSchema(
  reason: string,
  constituents: readonly MutableJSONSchema[],
  context: GenerationContext,
): MutableJSONSchemaObj {
  const { labels, value } = labelsKeptBesideAnyValue(
    constituents,
    "unsupported",
    context,
  );
  const schema: MutableJSONSchemaObj = {
    type: "object",
    additionalProperties: true,
    $comment: `Unsupported intersection pattern: ${reason}`,
    ...(labels !== undefined ? { ifc: labels } : {}),
  };
  if (value) context.anyValuesBySchema?.set(schema, value);
  return schema;
}

/**
 * The labels kept of `constituents` beside a value that may hold their data
 * anywhere (`labelsBesideAnyValue()`), a value `from` the reading it names,
 * and the value left to be checked once generation is done, where it met a
 * definition before that definition was written (`anyValuesBesideUnwritten`).
 */
function labelsKeptBesideAnyValue(
  constituents: readonly MutableJSONSchema[],
  from: AnyValueBesideUnwritten["from"],
  context: GenerationContext,
): {
  labels: Record<string, unknown> | undefined;
  value: AnyValueBesideUnwritten | undefined;
} {
  const unwritten = new Set<string>();
  const labels = labelsBesideAnyValue(
    constituents,
    context.definitions,
    unwritten,
  );
  if (unwritten.size === 0) return { labels, value: undefined };
  const value: AnyValueBesideUnwritten = {
    from,
    definitions: context.definitions,
    unwritten: [...unwritten],
    kept: labels,
  };
  context.anyValuesBesideUnwritten.push(value);
  return { labels, value };
}

export class IntersectionFormatter implements TypeFormatter {
  #schemaGenerator: SchemaGenerator;

  constructor(schemaGenerator: SchemaGenerator) {
    this.#schemaGenerator = schemaGenerator;
  }

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    // Don't handle cell types - they are intersection types but should be handled by CommonFabricFormatter
    if (isCellType(type, context.typeChecker)) {
      return false;
    }
    return (type.flags & ts.TypeFlags.Intersection) !== 0;
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const checker = context.typeChecker;
    const native = getNativeTypeSchema(type, checker);
    if (native !== undefined) {
      return cloneSchemaDefinition(native);
    }
    // An intersection the checker reduces to nothing, as it reduces one whose
    // parts give a discriminant property different literal types, accepts
    // nothing, though the checker may hand it over unreduced as a union's arm.
    if (checker.isTypeAssignableTo(type, checker.getNeverType())) return false;
    const inter = type as ts.IntersectionType;
    const parts = inter.types ?? [];

    if (parts.length === 0) {
      throw new Error(
        "IntersectionFormatter received empty intersection type",
      );
    }

    // Filter out "brand-only" and empty object parts before validation.
    // These arise from:
    //   1. RequireDefaults<T> applied to non-Default types (e.g. number[] & {})
    //   2. Default<T,V> brand constituents in a union (e.g. boolean & { [DEFAULT_MARKER]: T })
    // Brand-only parts are object types with no string-keyed properties and no
    // index signatures — they carry only symbol-keyed brand markers. A scope
    // wrapper's brand is one even where the checker defers it as a conditional
    // type, around a type parameter. A CFC metadata carrier holds no part of
    // the value either: its labels are the CommonFabricFormatter's to read.
    const effectiveParts = parts.filter(
      (p) =>
        !this.#isBrandOnlyOrEmpty(p, checker) &&
        !isScopeBrandMember(p, checker) && !isCfcCarrier(p),
    );

    // If all parts were brand markers / empty / carriers, as nested CFC
    // policies over `unknown` are nothing but carriers, fall back to the full
    // set, which merges into an object.
    const partsToProcess = effectiveParts.length > 0 ? effectiveParts : parts;

    // If filtering reduced us to a single substantive part, delegate directly.
    if (partsToProcess.length === 1) {
      return this.#schemaGenerator.formatChildType(partsToProcess[0]!, context);
    }

    // An intersection of parts the generator gives an array's schema, as it
    // gives `Record<number, T>` one, is an array of the values each of them
    // holds, whose type the checker gives as the intersection's number index:
    // the intersection of their element types.
    // Its constituents' JSDoc is documented as a merged object's.
    if (
      partsToProcess.every((part) =>
        getArrayElementInfo(part, checker) !== undefined
      )
    ) {
      return this.#applyIntersectionDocs({
        schema: {
          type: "array",
          items: this.#schemaGenerator.formatChildType(
            checker.getIndexTypeOfType(type, ts.IndexKind.Number)!,
            context,
          ),
        },
        ...this.#constituentDocs(partsToProcess, checker),
      });
    }

    const failureReason = this.#validateIntersectionParts(
      partsToProcess,
      checker,
    );
    if (failureReason) {
      const schema = unsupportedIntersectionSchema(
        failureReason,
        partsToProcess.map((part) =>
          this.#schemaGenerator.formatChildType(part, context)
        ),
        context,
      );
      context.schemaOrigins?.set(schema, {
        kind: "intersection",
        parts: () =>
          parts.map((part) =>
            this.#schemaGenerator.formatChildType(part, context)
          ),
      });
      return schema;
    }

    const merged = this.#mergeIntersectionParts(partsToProcess, type, context);
    return this.#applyIntersectionDocs(merged);
  }

  /**
   * Returns true if the type is "brand-only" or an empty object — i.e. it carries
   * no string-keyed data properties and no index signatures.
   *
   * These parts can be safely dropped from an intersection for schema purposes:
   *   - `{}` (empty object) — e.g. the second part of RequireDefaults<number[]>
   *   - `{ readonly [DEFAULT_MARKER]: T }` — the brand object inside Default<T,V>
   */
  #isBrandOnlyOrEmpty(part: ts.Type, checker: ts.TypeChecker): boolean {
    if ((part.flags & ts.TypeFlags.Object) === 0) return false;

    try {
      const stringIndex = checker.getIndexTypeOfType(
        part,
        ts.IndexKind.String,
      );
      const numberIndex = checker.getIndexTypeOfType(
        part,
        ts.IndexKind.Number,
      );
      if (stringIndex || numberIndex) return false;
    } catch {
      return false;
    }

    const properties = checker.getPropertiesOfType(part);
    for (const prop of properties) {
      // TypeScript encodes unique-symbol property names as "__@..." internally.
      // Any property whose escapedName does NOT start with "__@" is a regular
      // string-keyed property — making this a real data type, not a brand.
      // There is no public TypeScript API to distinguish symbol-keyed from
      // string-keyed properties, so we rely on this internal naming convention
      // intentionally.
      const escaped = prop.escapedName as string;
      if (!String(escaped).startsWith("__@")) {
        return false;
      }
    }

    return true;
  }

  #validateIntersectionParts(
    parts: readonly ts.Type[],
    checker: ts.TypeChecker,
  ): string | null {
    let everyKey = false;
    let numericKeys = false;
    for (const part of parts) {
      if ((part.flags & ts.TypeFlags.Object) === 0) {
        return "non-object constituent";
      }

      // A part the generator gives an array's schema, as it gives an array, a
      // tuple, `ArrayLike<T>` or a typed array, has no object schema whose
      // members its items could join. Any other index signature, a numeric
      // one included, merges with the members.
      if (getArrayElementInfo(part, checker) !== undefined) {
        return "index signature on constituent";
      }
      if (checker.getIndexTypeOfType(part, ts.IndexKind.String)) {
        everyKey = true;
      } else if (checker.getIndexTypeOfType(part, ts.IndexKind.Number)) {
        numericKeys = true;
      }
    }

    // An index signature on numeric keys alone beside one on every key would
    // need one `additionalProperties` saying what the first holds under
    // numeric keys and the second under the rest.
    return everyKey && numericKeys
      ? "index signatures on different keys"
      : null;
  }

  #mergeIntersectionParts(
    parts: readonly ts.Type[],
    intersection: ts.Type,
    context: GenerationContext,
  ): { schema: MutableJSONSchemaObj } & ConstituentDocs {
    const checker = context.typeChecker;
    const declarations = new Map<string, PropertyDeclaration[]>();
    const requiredSet = new Set<string>();

    for (const part of parts) {
      const schema = this.#schemaGenerator.formatChildType(part, context);
      const objSchema = this.#resolveObjectSchema(schema, context);
      if (!objSchema) continue;

      if (objSchema.properties) {
        for (const [key, value] of Object.entries(objSchema.properties)) {
          const declaration = {
            part,
            schema: value,
            required: Array.isArray(objSchema.required) &&
              objSchema.required.includes(key),
          };
          const declared = declarations.get(key);
          if (declared) declared.push(declaration);
          else declarations.set(key, [declaration]);
        }
      }

      if (Array.isArray(objSchema.required)) {
        for (const req of objSchema.required) {
          if (typeof req === "string") requiredSet.add(req);
        }
      }
    }

    const mergedProps: Record<string, MutableJSONSchema> = {};
    for (const [key, declared] of declarations) {
      mergedProps[key] = declared.length === 1
        ? declared[0]!.schema
        : this.#sharedPropertySchema(key, declared, intersection, context);
    }

    const result: MutableJSONSchemaObj = {
      type: "object",
      properties: mergedProps,
    };

    // The keys no member names hold the intersection's index type, as one
    // object type declaring all of these members and index signatures would:
    // a member keeps the type its own declarations give it, as the checker
    // reads it. The parts' index signatures are all on every key or all on
    // numeric keys alone (`#validateIntersectionParts()`), and the merged
    // one is recorded as applying to the same.
    const stringIndex = checker.getIndexTypeOfType(
      intersection,
      ts.IndexKind.String,
    );
    const indexType = stringIndex ??
      checker.getIndexTypeOfType(intersection, ts.IndexKind.Number);
    if (indexType) {
      result.additionalProperties = this.#schemaGenerator.formatChildType(
        indexType,
        context,
      );
      withIndexKeys(result, stringIndex ? "string" : "number", context);
    }

    if (requiredSet.size > 0) {
      result.required = Array.from(requiredSet);
    }

    return {
      schema: result,
      ...this.#constituentDocs(parts, context.typeChecker),
    };
  }

  /** The JSDoc `parts`, an intersection's constituents, carry. */
  #constituentDocs(
    parts: readonly ts.Type[],
    checker: ts.TypeChecker,
  ): ConstituentDocs {
    const docs: ConstituentDocs = {
      docTexts: [],
      documentedSources: [],
      missingSources: [],
    };
    for (const part of parts) {
      const docInfo = extractDocFromType(part, checker);
      if (docInfo.firstDoc) {
        docs.docTexts.push(docInfo.firstDoc);
        docs.documentedSources.push(docInfo.typeName);
      } else {
        docs.missingSources.push(docInfo.typeName);
      }
    }
    return docs;
  }

  /**
   * The schema of `key`, a property several parts of `intersection` declare
   * (`declared`, in part order): the schema of the type the checker gives the
   * property, which is the intersection of the declared types, documented as
   * `sharedPropertySchema()` says. Where one declaration's type is that very
   * type, the schema is that declaration's, read through the node it is
   * written with. Any other type is formatted as the property's, so what the
   * checker keeps of each declaration, a scope wrapper's brand and a CFC
   * carrier among it, is read from the type, whichever declaration wrote it.
   * `any` keeps nothing of the declarations beside it, so a property the
   * checker gives `any` keeps what `anyValueSchema()` says of their schemas.
   * Only a `typeof` node names a writer, so a writer policy the property's
   * value holds goes unread there, and every label beside it with it, whether
   * the policy is on the value or on what it holds, its members, index values
   * and elements among them; a property whose value holds one, a cell's link
   * to its own document aside (`holdsWriterPolicy()`), is settled from the
   * declarations' schemas, each read through the node it is written with, as
   * the node-based analysis settles one
   * (`SchemaGenerator.sharedPropertyOfSchemas()`). Declarations in
   * different scopes are refused (`propertyScopesError()`), except where the
   * schema declares no scope.
   */
  #sharedPropertySchema(
    key: string,
    declared: readonly PropertyDeclaration[],
    intersection: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const checker = context.typeChecker;
    const schemas = declared.map(({ schema }) => schema);
    // A property one part declares is a property of the intersection.
    const property = checker.getPropertyOfType(intersection, key)!;
    const type = checker.getTypeOfSymbol(property);
    const types = declared.map(({ part }) =>
      checker.getTypeOfSymbol(checker.getPropertyOfType(part, key)!)
    );
    // A declaration's scope is read from the brand on its type, or from its
    // schema, which alone keeps it where the type is `any`.
    const scopes = context.declaresNoScope ? [] : [
      ...new Set(
        types.flatMap((declaredType, index) => {
          const schema = schemas[index];
          const scope = scopeOfScopeWrapper(declaredType, checker) ??
            (isObjectOrArray(schema)
              ? schema.scope as SchemaScope | undefined
              : undefined);
          return scope ? [scope] : [];
        }),
      ),
    ];
    if (scopes.length > 1) throw propertyScopesError(key, scopes);
    if ((type.flags & ts.TypeFlags.Any) !== 0) {
      const defaults = dedupeByValueEqual(
        schemas.flatMap((schema) =>
          isObjectOrArray(schema) && schema.default !== undefined
            ? [schema.default as FabricValue]
            : []
        ),
      );
      return sharedPropertySchema(
        key,
        anyValueSchema(schemas, {
          scope: scopes[0],
          ...(defaults.length === 1
            ? { default: defaults[0] as MutableJSONSchemaObj["default"] }
            : {}),
        }, context),
        schemas,
        context,
      );
    }
    const own = types.indexOf(type);
    if (own !== -1) {
      return sharedPropertySchema(key, schemas[own]!, schemas, context);
    }
    if (holdsWriterPolicy(type, checker)) {
      return this.#schemaGenerator.sharedPropertyOfSchemas(
        key,
        declared,
        context,
      );
    }

    // Every declaration has a schema, so each is a data property or a
    // callable returning a wrapper, and the intersection's call signatures,
    // if it has any, are those callables'.
    // An optional property's type holds the `undefined` its `?` adds, which
    // the schema leaves to `required` to say. Among several other arms it is
    // dropped here, where the union holds no `null` for the non-nullable
    // type to drop as well.
    const propertyType = safeGetPropertyType(property, intersection, checker);
    const valueType = (property.flags & ts.SymbolFlags.Optional) !== 0 &&
        propertyType.isUnion() &&
        !propertyType.types.some((t) => (t.flags & ts.TypeFlags.Null) !== 0)
      ? checker.getNonNullableType(propertyType)
      : propertyType;
    const callable = classifyCallableProperty(
      valueType,
      checker,
      context.boundTypeParameters,
    );
    return sharedPropertySchema(
      key,
      callable?.kind === "wrapper"
        ? callable.schema
        : this.#schemaGenerator.formatChildType(valueType, context),
      schemas,
      context,
    );
  }

  #isObjectSchema(
    schema: MutableJSONSchema,
  ): schema is MutableJSONSchemaObj & { type: "object" } {
    return (
      isObjectOrArray(schema) &&
      schema.type === "object"
    );
  }

  #resolveObjectSchema(
    schema: MutableJSONSchema,
    context: GenerationContext,
  ): (MutableJSONSchemaObj & { type: "object" }) | undefined {
    if (this.#isObjectSchema(schema)) return schema;
    if (
      isObjectOrArray(schema) &&
      typeof (schema as Record<string, unknown>).$ref === "string"
    ) {
      const ref = (schema as Record<string, unknown>).$ref as string;
      const prefix = "#/$defs/";
      if (ref.startsWith(prefix)) {
        const name = ref.slice(prefix.length);
        const def = context.definitions[name];
        if (def && this.#isObjectSchema(def)) return def;
      }
    }
    return undefined;
  }

  #applyIntersectionDocs(
    data: { schema: MutableJSONSchemaObj } & ConstituentDocs,
  ): MutableJSONSchemaObj {
    const { schema, docTexts, documentedSources, missingSources } = data;
    if (!isObjectOrArray(schema)) return schema;

    const uniqueDocTexts = docTexts.filter((doc, index, arr) =>
      arr.indexOf(doc) === index
    );

    if (
      uniqueDocTexts.length > 0 && typeof schema.description !== "string"
    ) {
      (schema as Record<string, unknown>).description = uniqueDocTexts.join(
        "\n\n",
      );
    }

    const commentParts: string[] = [];
    const existingComment = typeof schema.$comment === "string"
      ? schema.$comment as string
      : undefined;

    const uniqueDocumented = Array.from(new Set(documentedSources)).filter((
      name,
    ) => name);
    const uniqueMissing = Array.from(new Set(missingSources)).filter((name) =>
      name
    );

    if (uniqueDocTexts.length > 0) {
      commentParts.push("Docs inherited from intersection constituents.");
    }
    if (uniqueDocTexts.length > 1 && uniqueDocumented.length > 0) {
      commentParts.push(`Sources: ${uniqueDocumented.join(", ")}.`);
    }
    if (uniqueDocTexts.length > 0 && uniqueMissing.length > 0) {
      commentParts.push(`Missing docs for: ${uniqueMissing.join(", ")}.`);
    }

    if (commentParts.length > 0) {
      const commentMessage = commentParts.join(" ");
      (schema as Record<string, unknown>).$comment = existingComment
        ? `${existingComment} ${commentMessage}`
        : commentMessage;
    }

    return schema;
  }
}
