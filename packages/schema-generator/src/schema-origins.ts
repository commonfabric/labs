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
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { GenerationContext } from "./interface.ts";

/**
 * `folded`, the schema a union of `options` folded to, recorded as that union
 * when the fold dropped an option that carried an origin of its own — on a
 * schema of its own, so the record does not make the surviving option stand
 * for the whole. Returned as it came when nothing that mattered was folded.
 */
export function unionFoldedFrom(
  folded: MutableJSONSchema,
  options: MutableJSONSchema[],
  kept: number,
  context: GenerationContext,
): MutableJSONSchema {
  const origins = context.schemaOrigins;
  if (
    origins === undefined || !isObjectOrArray(folded) ||
    kept >= options.length ||
    !options.some((option) => isObjectOrArray(option) && origins.has(option))
  ) {
    return folded;
  }
  const schema: MutableJSONSchemaObj = { ...folded };
  origins.set(schema, { kind: "union", parts: () => options });
  return schema;
}
