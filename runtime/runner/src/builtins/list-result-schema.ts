import { internSchema } from "@commonfabric/data-model-schema";
import type { JSONSchema } from "../builder/types.ts";

/**
 * Result-container schema for the list builtins (map/filter/flatMap): an
 * array of `itemSchema` items, with the item schema's `$defs` hoisted to the
 * container root so internal `$ref`s keep resolving.
 *
 * This replaces the former flow-precision schema builder. The
 * `ifc.flowPrecisionClaim` annotations it attached were never consumed and
 * are no longer minted: per-element ops run in their own transactions that
 * read only their element, so pointwise label precision is a structural
 * fact of the transaction decomposition rather than a trusted claim.
 * `flowPrecisionClaim` remains a reserved, tolerated key in
 * `cfc/schema-merge.ts` because already-persisted link schemas embed it.
 */
export const listResultSchema = (itemSchema?: JSONSchema): JSONSchema => {
  if (itemSchema === undefined) {
    return internSchema({ type: "array" });
  }
  if (typeof itemSchema === "boolean") {
    return internSchema({ type: "array", items: itemSchema });
  }
  const { $defs, ...itemSchemaWithoutDefs } = itemSchema;
  return internSchema({
    type: "array",
    items: itemSchemaWithoutDefs,
    ...($defs !== undefined && { $defs }),
  });
};
