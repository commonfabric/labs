/**
 * Value-aligned array position matching (2020-12 semantics): a tuple slot
 * (`prefixItems[i]`) governs exactly index i, and the uniform `items` schema
 * governs only the indices past the slots.
 *
 * Shared by the narrow value matchers (`matchesConcreteValue` in schema.ts,
 * `policySchemaMatchesValue` in cfc/prepare.ts) so the position rule cannot
 * drift between them again — CT-1895 fixed the same prefixItems fall-through
 * in each matcher separately; CT-1899 tracks consolidating the matchers
 * themselves. The `matches` callback owns recursion and ref semantics: the
 * matchers differ exactly there ($defs threading vs fail-closed policy refs).
 */

import { isObjectOrArray } from "@commonfabric/utils/types";
import type { JSONSchema, JSONSchemaObj } from "./builder/types.ts";

export const arrayMatchesPositionally = (
  schema: JSONSchemaObj,
  value: readonly unknown[],
  matches: (childSchema: JSONSchema, childValue: unknown) => boolean,
): boolean => {
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : undefined;
  if (prefixItems !== undefined) {
    const slots = Math.min(prefixItems.length, value.length);
    for (let index = 0; index < slots; index++) {
      if (!matches(prefixItems[index], value[index])) return false;
    }
  }
  if (schema.items === false) {
    // A closed tuple: `items: false` forbids any element past the slots.
    if (value.length > (prefixItems?.length ?? 0)) return false;
  } else if (isObjectOrArray(schema.items)) {
    for (
      let index = prefixItems?.length ?? 0;
      index < value.length;
      index++
    ) {
      if (!matches(schema.items, value[index])) return false;
    }
  }
  return true;
};
