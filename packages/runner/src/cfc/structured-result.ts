import type { JSONSchema } from "@commonfabric/api";
import {
  isFabricSpecialObject,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { isSubschema } from "@commonfabric/data-model-schema/schema-walk";
import { cfcOpaqueLinkForPath } from "./observation.ts";
import {
  cfcCombinatorObjectSurface,
  cfcObjectSchemaIsClosed,
  isPrimitiveJsonValue,
  resolveSchemaForValidation,
  validateAgainstSchemaForSanitization,
} from "./schema-sanitization.ts";

export interface SchemaOpaqueLinkSanitizationResult {
  value: unknown;
  linkedStringCount: number;

  /**
   * The paths of the positions THIS sanitization sealed, in walk order. A
   * caller-provided opaque link the schema admits is preserved, not sealed,
   * and is not listed — which is what lets a consumer address or replace
   * exactly what was minted without inferring provenance from the handle id.
   */
  sealedPaths: (string | number)[][];
}

const NO_RESERVED_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Property names excused from the unmodeled-key rules at the ROOT of one
 * sanitization: the reserved keys of whatever produced the value, whose
 * spellings are fixed by a framework rather than chosen by the value's author.
 * A reserved key the schema models is measured normally; a reserved key it
 * does not model neither fails validation nor seals the object — it is simply
 * dropped from the sanitized value, because a key the schema never asked for
 * carries nothing the caller can read.
 *
 * The exemption is the root's alone. The framework fixes the spelling of the
 * keys it puts on the value it produced, and of nothing inside that value: a
 * nested object carrying an unmodeled `$NAME` is an object with an unmodeled
 * key, and it seals like any other, because a key nobody modeled is a key
 * whose name may itself be data. Excusing it at depth would drop the name and
 * release the object's modeled siblings — author data leaving on the strength
 * of a spelling the author chose.
 */
export interface StructuredResultReservedKeys {
  reservedKeys?: readonly string[];
}

const reservedKeySet = (
  options: StructuredResultReservedKeys,
): ReadonlySet<string> =>
  options.reservedKeys === undefined || options.reservedKeys.length === 0
    ? NO_RESERVED_KEYS
    : new Set(options.reservedKeys);

export const validateStructuredResultValue = (
  options: {
    schema: JSONSchema;
    value: unknown;
  } & StructuredResultReservedKeys,
): void => {
  const failure = validateAgainstSchemaForSanitization(
    options.schema,
    options.value,
    options.schema,
    reservedKeySet(options),
  );
  if (failure !== undefined) {
    throw new Error(failure);
  }
};

const schemaAllowsRawString = (
  schema: JSONSchema,
  value: string,
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): boolean => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isObjectOrArray(resolved)) {
    return false;
  }
  if (Array.isArray(resolved.enum)) {
    return resolved.enum.some((entry) => entry === value);
  }
  if (
    "const" in resolved && resolved.const === value &&
    isPrimitiveJsonValue(resolved.const)
  ) {
    return true;
  }
  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.some((branch) =>
      schemaAllowsRawString(branch, value, fullSchema, reserved)
    );
  }
  const oneOf = matchingBranch(resolved.oneOf, value, fullSchema, reserved);
  if (oneOf !== undefined) {
    return schemaAllowsRawString(oneOf, value, fullSchema, reserved);
  }
  if (Array.isArray(resolved.anyOf)) {
    return resolved.anyOf.some((branch) =>
      validateAgainstSchemaForSanitization(
          branch,
          value,
          fullSchema,
          reserved,
        ) === undefined &&
      schemaAllowsRawString(branch, value, fullSchema, reserved)
    );
  }
  return false;
};

const schemaDirectlyDeclaresOpaqueLinkObject = (
  schema: Record<string, unknown>,
): boolean =>
  isObjectOrArray(schema.properties) &&
  isObjectOrArray(schema.properties["@link"]) &&
  schema.properties["@link"].type === "string" &&
  Array.isArray(schema.required) &&
  schema.required.includes("@link") &&
  cfcObjectSchemaIsClosed(schema);

const matchingBranches = (
  branches: unknown,
  value: unknown,
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): JSONSchema[] => {
  if (!Array.isArray(branches)) {
    return [];
  }
  return branches
    .filter((branch): branch is JSONSchema =>
      isSubschema(branch) &&
      validateAgainstSchemaForSanitization(
          branch,
          value,
          fullSchema,
          reserved,
        ) === undefined
    )
    .map((branch) => resolveSchemaForValidation(branch, fullSchema));
};

const schemaAcceptsOpaqueLinkObject = (
  schema: JSONSchema,
  value: { "@link": string },
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): boolean => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isObjectOrArray(resolved)) {
    return false;
  }
  if (
    validateAgainstSchemaForSanitization(
      resolved,
      value,
      fullSchema,
      reserved,
    ) !== undefined
  ) {
    return false;
  }
  if (schemaDirectlyDeclaresOpaqueLinkObject(resolved)) {
    return true;
  }
  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.some((branch) =>
      schemaAcceptsOpaqueLinkObject(branch, value, fullSchema, reserved)
    );
  }
  const oneOfBranches = matchingBranches(
    resolved.oneOf,
    value,
    fullSchema,
    reserved,
  );
  if (oneOfBranches.length > 0) {
    return oneOfBranches.some((branch) =>
      schemaAcceptsOpaqueLinkObject(branch, value, fullSchema, reserved)
    );
  }
  return matchingBranches(resolved.anyOf, value, fullSchema, reserved).some((
    branch,
  ) => schemaAcceptsOpaqueLinkObject(branch, value, fullSchema, reserved));
};

const valueIsOpaqueLinkObject = (
  value: unknown,
): value is { "@link": string } =>
  isObjectOrArray(value) &&
  typeof value["@link"] === "string" &&
  Object.keys(value).length === 1;

const matchingBranch = (
  branches: unknown,
  value: unknown,
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): JSONSchema | undefined => {
  if (!Array.isArray(branches)) {
    return undefined;
  }
  const branch = branches.find((branch): branch is JSONSchema =>
    isSubschema(branch) &&
    validateAgainstSchemaForSanitization(
        branch,
        value,
        fullSchema,
        reserved,
      ) === undefined
  );
  return branch === undefined
    ? undefined
    : resolveSchemaForValidation(branch, fullSchema);
};

const isEmptySchemaObject = (schema: JSONSchema): boolean =>
  isObjectOrArray(schema) && Object.keys(schema).length === 0;

const combineAllOf = (schemas: readonly JSONSchema[]): JSONSchema => {
  const constrained = schemas.filter((schema) =>
    schema !== true && !isEmptySchemaObject(schema)
  );
  if (constrained.some((schema) => schema === false)) {
    return false;
  }
  if (constrained.length === 0) {
    return true;
  }
  if (constrained.length === 1) {
    return constrained[0]!;
  }
  return { allOf: constrained };
};

const schemaWithoutBranchKeyword = (
  schema: Record<string, unknown>,
  keyword: "anyOf" | "oneOf",
): JSONSchema => {
  const { [keyword]: _ignored, ...rest } = schema;
  return rest as JSONSchema;
};

/**
 * The constraints one value is measured against: the node itself with each
 * union keyword replaced by the branches this value actually matches. This
 * picks a schema — which sub-schema governs a key, which constants a string
 * may be — rather than describing the schema's surface; the names an object
 * declares are `knownPropertyNames()`'s question, and it asks it of the
 * unnarrowed schema so that its answer is the validator's.
 *
 * Each keyword is narrowed on its own terms:
 *
 * - `oneOf` is exactly one, and the validator refuses a value matching two, so
 *   the first match is the only match.
 * - `anyOf` is one OR MORE, so every matching branch contributes. Combining
 *   them with `allOf` is sound because each was selected by validating this
 *   same value: whatever they all require, it already satisfies. Taking only
 *   the first would hide the later branches' constraints — a string a second
 *   branch names as a constant would go over as an opaque link, and a property
 *   only it declares would be governed by nothing.
 * - `allOf` is unconditional and needs no narrowing: it stays on the node, and
 *   every consumer here descends it whether or not a branch matched.
 */
const schemaForValue = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema,
  reserved: ReadonlySet<string>,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isObjectOrArray(resolved)) {
    return resolved;
  }
  let base: JSONSchema = resolved;
  const branches: JSONSchema[] = [];
  const oneOf = matchingBranch(resolved.oneOf, value, fullSchema, reserved);
  if (oneOf !== undefined) {
    base = schemaWithoutBranchKeyword(base as Record<string, unknown>, "oneOf");
    branches.push(oneOf);
  }
  const anyOf = matchingBranches(resolved.anyOf, value, fullSchema, reserved);
  if (anyOf.length > 0) {
    base = schemaWithoutBranchKeyword(base as Record<string, unknown>, "anyOf");
    branches.push(...anyOf);
  }
  return branches.length === 0 ? resolved : combineAllOf([base, ...branches]);
};

const childSchemaForKey = (
  schema: JSONSchema,
  key: string,
  fullSchema: JSONSchema,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isObjectOrArray(resolved)) {
    return true;
  }
  const childSchemas: JSONSchema[] = [];
  // An array counts as a `properties` map here. `validateAgainstSchema()`
  // enumerates the keyword with `Object.entries()` and asks `Object.hasOwn()`,
  // both of which read an array's indices as property names, so a stored
  // `properties` array declares a property per index as far as validation is
  // concerned. Answering "no declared properties" would route those keys to
  // `additionalProperties` below, which validation does not do.
  if (isObjectOrArray(resolved.properties)) {
    const child = resolved.properties[key];
    if (isSubschema(child)) {
      childSchemas.push(child);
    }
  }
  if (
    !(isObjectOrArray(resolved.properties) && key in resolved.properties) &&
    isSubschema(resolved.additionalProperties)
  ) {
    childSchemas.push(resolved.additionalProperties);
  }
  if (Array.isArray(resolved.allOf)) {
    for (const branch of resolved.allOf) {
      const child = childSchemaForKey(branch, key, fullSchema);
      if (child !== true) {
        childSchemas.push(child);
      }
    }
  }
  return combineAllOf(childSchemas);
};

/**
 * Every property name the schema models for one object: the names on the node
 * itself and the names its `allOf`/`anyOf`/`oneOf` branches declare, merged.
 * This decides which of a value's keys are unmodeled, and an unmodeled key
 * seals the object — so a name this misses costs the caller the whole object.
 *
 * The branch walk is the validator's own, so the two read one answer to "what
 * does this schema declare here?". They must: the validator admits a key any
 * branch names, and a sanitizer that named fewer would seal an object over a
 * key validation had just accepted. What the validator does with the answer is
 * its own business — it consults the names only where nothing left the object
 * open, while an unmodeled key seals here open or not.
 */
const knownPropertyNames = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
): Set<string> => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  if (!isObjectOrArray(resolved)) {
    return new Set<string>();
  }
  const { known } = cfcCombinatorObjectSurface(resolved, fullSchema);
  if (isObjectOrArray(resolved.properties)) {
    for (const key of Object.keys(resolved.properties)) {
      known.add(key);
    }
  }
  return known;
};

const itemSchemaForIndex = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
  index: number,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, fullSchema);
  const itemSchemas: JSONSchema[] = [];
  if (isObjectOrArray(resolved)) {
    // 2020-12 array semantics: a tuple slot governs its exact index; the
    // uniform `items` schema governs only the indices past the slots.
    // Collecting only `items` let tuple elements sanitize against an
    // unconstrained schema, dodging the opaque-link/raw-string gate.
    const prefixItems = Array.isArray(resolved.prefixItems)
      ? resolved.prefixItems
      : undefined;
    if (prefixItems !== undefined && index < prefixItems.length) {
      const slot = prefixItems[index];
      if (isSubschema(slot)) {
        itemSchemas.push(slot);
      }
    } else if (
      isSubschema(resolved.items)
    ) {
      itemSchemas.push(resolved.items);
    }
    if (Array.isArray(resolved.allOf)) {
      for (const branch of resolved.allOf) {
        const item = itemSchemaForIndex(branch, fullSchema, index);
        if (item !== true) {
          itemSchemas.push(item);
        }
      }
    }
  }
  return combineAllOf(itemSchemas);
};

const sanitizeValueWithOpaqueLinks = (
  value: unknown,
  schema: JSONSchema,
  fullSchema: JSONSchema,
  opaqueHandleId: string,
  path: readonly (string | number)[],
  reserved: ReadonlySet<string>,
): SchemaOpaqueLinkSanitizationResult => {
  const effectiveSchema = schemaForValue(schema, value, fullSchema, reserved);
  if (typeof value === "string") {
    if (schemaAllowsRawString(effectiveSchema, value, fullSchema, reserved)) {
      return { value, linkedStringCount: 0, sealedPaths: [] };
    }
    return {
      value: cfcOpaqueLinkForPath(opaqueHandleId, path),
      linkedStringCount: 1,
      sealedPaths: [[...path]],
    };
  }
  if (Array.isArray(value)) {
    let linkedStringCount = 0;
    const sealedPaths: (string | number)[][] = [];
    const items = value.map((item, index) => {
      const sanitized = sanitizeValueWithOpaqueLinks(
        item,
        itemSchemaForIndex(effectiveSchema, fullSchema, index),
        fullSchema,
        opaqueHandleId,
        [...path, index],
        // Reserved names are the root's exemption; an item is not the root.
        NO_RESERVED_KEYS,
      );
      linkedStringCount += sanitized.linkedStringCount;
      // Appended one by one: a spread passes every path as a call argument,
      // and a large sealed subtree overflows the argument limit.
      for (const sealed of sanitized.sealedPaths) {
        sealedPaths.push(sealed);
      }
      return sanitized.value;
    });
    return { value: items, linkedStringCount, sealedPaths };
  }
  if (isFabricSpecialObject(value)) {
    // Sealed, not shown and not walked. A special object holds its state
    // behind no property name, so the record arm below cannot measure it
    // against the schema the way the unmodeled-key policy measures a record --
    // and a value this cannot model is a value whose contents may themselves
    // be data. Sealing is the same answer that policy gives, arrived at for
    // the same reason.
    return {
      value: cfcOpaqueLinkForPath(opaqueHandleId, path),
      linkedStringCount: 0,
      sealedPaths: [[...path]],
    };
  }
  if (isWalkableObjectOrArray(value)) {
    if (
      valueIsOpaqueLinkObject(value) &&
      schemaAcceptsOpaqueLinkObject(schema, value, fullSchema, reserved)
    ) {
      return { value, linkedStringCount: 0, sealedPaths: [] };
    }
    // The unmodeled-key policy: one key the schema does not model seals the
    // whole object, because a key it cannot model is a key whose NAME may
    // itself be data. A RESERVED unmodeled key is the exception — its
    // spelling is the framework's, not the value author's — and it is dropped
    // rather than shown, so nothing about it reaches the reader either way.
    // Which names are modeled is asked of the schema as written, not of the
    // narrowing above: the validator admits a name any branch declares, so
    // measuring against fewer would seal an object over a key it just passed.
    const knownKeys = knownPropertyNames(schema, fullSchema);
    const unmodeled = Object.keys(value).filter((key) => !knownKeys.has(key));
    if (unmodeled.some((key) => !reserved.has(key))) {
      return {
        value: cfcOpaqueLinkForPath(opaqueHandleId, path),
        linkedStringCount: 0,
        sealedPaths: [[...path]],
      };
    }
    const dropped = new Set(unmodeled);
    let linkedStringCount = 0;
    const sealedPaths: (string | number)[][] = [];
    const entries = Object.entries(value).filter(([key]) => !dropped.has(key))
      .map(([key, child]) => {
        const sanitized = sanitizeValueWithOpaqueLinks(
          child,
          childSchemaForKey(effectiveSchema, key, fullSchema),
          fullSchema,
          opaqueHandleId,
          [...path, key],
          // Reserved names are the root's exemption; a property of the root
          // holds whatever its author put there, reserved-looking or not.
          NO_RESERVED_KEYS,
        );
        linkedStringCount += sanitized.linkedStringCount;
        for (const sealed of sanitized.sealedPaths) {
          sealedPaths.push(sealed);
        }
        return [key, sanitized.value] as const;
      });
    return {
      value: Object.fromEntries(entries),
      linkedStringCount,
      sealedPaths,
    };
  }
  return { value, linkedStringCount: 0, sealedPaths: [] };
};

export const validateAndSanitizeSchemaValueWithOpaqueLinks = (
  options: {
    schema: JSONSchema;
    value: unknown;
    opaqueHandleId: string;
  } & StructuredResultReservedKeys,
): SchemaOpaqueLinkSanitizationResult => {
  // The value validated is the value as it arrived. Projecting reserved keys
  // out first would change what the schema is measuring: a value a `oneOf`
  // branch refuses BECAUSE of what it carries under a reserved name would be
  // handed to that branch with the offending key already gone, and accepted.
  validateStructuredResultValue(options);
  return sanitizeValueWithOpaqueLinks(
    options.value,
    options.schema,
    options.schema,
    options.opaqueHandleId,
    [],
    reservedKeySet(options),
  );
};

export const validateAndSanitizeStructuredResultValue =
  validateAndSanitizeSchemaValueWithOpaqueLinks;
