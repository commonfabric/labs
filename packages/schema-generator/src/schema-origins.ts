/**
 * What a schema came from, where the schema alone no longer says: the
 * `schemaOrigins` a `GenerationContext` carries while intersections are
 * reduced. Two source types can emit one schema — `void` and `OpaqueCell<any>`
 * both lower to the opaque marker, and every branded primitive lowers to the
 * same unsupported-pattern fallback — so a fold by value keeps one schema for
 * several types, and an intersection that later meets the survivor would read
 * it as the one type it stands for. The record made here keeps the union
 * behind such a survivor.
 */
import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { GenerationContext, IndexKeys } from "./interface.ts";
import { dedupeByValueEqual } from "./value-equality.ts";

/**
 * `folded`, the schema a union of `options` folded to with `kept` arms left,
 * recorded as that union when the fold dropped an option that carried an
 * origin of its own, or one whose index signatures apply to other keys than
 * those of the option kept for it (`withIndexKeysNoted()`) — on a schema of
 * its own, so the record does not make the surviving option stand for the
 * whole. An option accepting nothing is no arm: it is neither counted as
 * folded nor recorded. Returned as it came when nothing that mattered was
 * folded.
 */
export function unionFoldedFrom(
  folded: MutableJSONSchema,
  options: MutableJSONSchema[],
  kept: number,
  context: GenerationContext,
): MutableJSONSchema {
  const origins = context.schemaOrigins;
  const arms = options.filter((option) => option !== false);
  if (
    origins === undefined || !isObjectOrArray(folded) ||
    kept >= arms.length ||
    (!arms.some((arm) => isObjectOrArray(arm) && origins.has(arm)) &&
      dedupeByValueEqual(
          arms.map((arm) => withIndexKeysNoted(arm, context) as FabricValue),
        ).length <= dedupeByValueEqual(arms).length)
  ) {
    return folded;
  }
  const schema: MutableJSONSchemaObj = { ...folded };
  origins.set(schema, { kind: "union", parts: () => arms });
  return schema;
}

/**
 * `copy`, a schema made from `original` by changing keywords that say nothing
 * about its source type, recorded as coming from what `original` came from,
 * its index signature's keys among it (`withIndexKeysOf()`). A copy with no
 * record would read as the one type its schema stands for.
 */
export function withOriginOf(
  copy: MutableJSONSchema,
  original: MutableJSONSchema,
  context: GenerationContext,
): MutableJSONSchema {
  const origin = isObjectOrArray(original)
    ? context.schemaOrigins?.get(original)
    : undefined;
  if (origin && isObjectOrArray(copy) && copy !== original) {
    context.schemaOrigins?.set(copy, origin);
  }
  return withIndexKeysOf(copy, original, context);
}

/**
 * `schema`, whose `additionalProperties` states an index signature applying
 * to `keys`, recorded as such (`GenerationContext.indexKeys`).
 */
export function withIndexKeys(
  schema: MutableJSONSchema,
  keys: IndexKeys,
  context: GenerationContext,
): MutableJSONSchema {
  if (isObjectOrArray(schema)) context.indexKeys?.set(schema, keys);
  return schema;
}

/**
 * `copy`, a schema made from `original` with the same `additionalProperties`,
 * recorded as applying its index signature to the keys `original`'s applies
 * to. Labels added to a whole value say nothing of its keys, so a labeled
 * copy keeps the record too.
 */
export function withIndexKeysOf(
  copy: MutableJSONSchema,
  original: MutableJSONSchema,
  context: GenerationContext,
): MutableJSONSchema {
  const keys = isObjectOrArray(original)
    ? context.indexKeys?.get(original)
    : undefined;
  if (keys && isObjectOrArray(copy) && copy !== original) {
    context.indexKeys?.set(copy, keys);
  }
  return copy;
}

/**
 * `copy`, a schema made from `original` by stating something of its whole
 * value beside it, its labels or its scope, with the records of what the
 * value is: the keys its index signature applies to (`withIndexKeysOf()`),
 * and the union a fold kept behind it, whose arms an intersection reads with
 * what `copy` states (`armsOfUnion()`). An intersection behind it is not
 * recorded, as an enclosing intersection would reopen it into parts stating
 * none of that.
 */
export function withValueRecordsOf(
  copy: MutableJSONSchema,
  original: MutableJSONSchema,
  context: GenerationContext,
): MutableJSONSchema {
  const origin = isObjectOrArray(original)
    ? context.schemaOrigins?.get(original)
    : undefined;
  if (origin?.kind === "union" && isObjectOrArray(copy) && copy !== original) {
    context.schemaOrigins?.set(copy, origin);
  }
  return withIndexKeysOf(copy, original, context);
}

/**
 * The keys the index signature `schema` states as `additionalProperties`
 * applies to, where they are recorded (`GenerationContext.indexKeys`).
 */
export function indexKeysOf(
  schema: MutableJSONSchema,
  context: GenerationContext,
): IndexKeys | undefined {
  return isObjectOrArray(schema) ? context.indexKeys?.get(schema) : undefined;
}

/**
 * `schema` with each schema in it whose index signature's keys are recorded
 * (`GenerationContext.indexKeys`) wrapped with them, for a comparison that
 * tells apart equal schemas whose index signatures apply to different keys,
 * as `Record<string, T>`'s and `Record<number, T>`'s are, wherever in them
 * those signatures sit.
 */
export function withIndexKeysNoted(
  schema: unknown,
  context: GenerationContext,
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => withIndexKeysNoted(item, context));
  }
  if (!isObjectOrArray(schema)) return schema;
  const noted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    noted[key] = withIndexKeysNoted(value, context);
  }
  const keys = context.indexKeys?.get(schema as MutableJSONSchemaObj);
  return keys === undefined ? noted : { indexKeys: keys, schema: noted };
}

/**
 * `schema` with each schema in it that has an origin recorded wrapped with
 * that record's number (`originNumbers`), for a key that tells apart equal
 * schemas from different types, as two branded primitives' fallbacks are,
 * and each whose index signature's keys are recorded wrapped with those too
 * (`withIndexKeysNoted()`). A copy recorded as its original's
 * (`withOriginOf()`) is numbered alike.
 */
export function withOriginsNumbered(
  schema: unknown,
  context: GenerationContext,
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => withOriginsNumbered(item, context));
  }
  if (!isObjectOrArray(schema)) return schema;
  const numbered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    numbered[key] = withOriginsNumbered(value, context);
  }
  const keys = context.indexKeys?.get(schema as MutableJSONSchemaObj);
  const keyed = keys === undefined
    ? numbered
    : { indexKeys: keys, schema: numbered };
  const origin = context.schemaOrigins?.get(schema as MutableJSONSchemaObj);
  const numbers = context.originNumbers;
  if (origin === undefined || numbers === undefined) return keyed;
  if (!numbers.has(origin)) numbers.set(origin, numbers.size);
  return { origin: numbers.get(origin), schema: keyed };
}
